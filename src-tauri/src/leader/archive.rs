//! Whole-tree archive metadata is independent of both transcripts and branch lifecycle.
use super::*;
use crate::history::SessionMeta;
use rusqlite::Connection;

const GROUP_REQUIRED: &str = "This chat belongs to an archived Leader group. Use whole-group restore or deletion in Leader management";

pub(super) fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS leader_archived_groups(
            root_engine TEXT NOT NULL, root_session_id TEXT NOT NULL, workspace_path TEXT NOT NULL,
            record_json TEXT NOT NULL, deleting INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(root_engine,root_session_id,workspace_path));
         CREATE TABLE IF NOT EXISTS leader_archived_members(
            engine TEXT NOT NULL, session_id TEXT NOT NULL, workspace_path TEXT NOT NULL,
            root_engine TEXT NOT NULL, root_session_id TEXT NOT NULL, root_workspace_path TEXT NOT NULL,
            PRIMARY KEY(engine,session_id));
         CREATE INDEX IF NOT EXISTS leader_archived_members_root
            ON leader_archived_members(root_engine,root_session_id,root_workspace_path);",
    ).map_err(|e| e.to_string())
}

pub(super) fn ensure_not_archived(
    conn: &Connection,
    engine: &str,
    session: &str,
) -> Result<(), String> {
    // History-only fixtures and old databases can precede coordinator initialization.
    let table: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='leader_archived_members')",
        [], |r| r.get(0),
    ).map_err(|e| e.to_string())?;
    if table && conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM leader_archived_members WHERE engine=?1 AND session_id=?2)",
        params![engine, session], |r| r.get::<_, bool>(0),
    ).map_err(|e| e.to_string())? {
        return Err(GROUP_REQUIRED.into());
    }
    Ok(())
}

pub(super) fn ensure_available(
    inner: &Inner,
    engine: &str,
    session: &str,
    branch: Option<&str>,
) -> Result<(), String> {
    // A child-rooted record owns the child's own branch through its chat identity.
    let branch_chat = branch
        .and_then(|id| inner.branches.get(id))
        .and_then(|record| Some((record.branch.engine.as_str(), record.branch.session_id.as_deref()?)));
    if inner.archived_groups.values().any(|group| {
        group.members.iter().any(|member| {
            (member.engine == engine && member.session_id == session)
                || branch_chat.is_some_and(|(e, s)| member.engine == e && member.session_id == s)
        }) || branch.is_some_and(|id| group.branch_ids.iter().any(|candidate| candidate == id))
    }) {
        return Err(GROUP_REQUIRED.into());
    }
    Ok(())
}

/// A record whose root is a managed child chat archives only that child's
/// subtree while its parent stays live. The child's own branch is implied by
/// the chat identity rather than listed, so builds that only know whole-group
/// records still load it and fail closed instead of rejecting the ledger.
pub(super) fn child_root_branch<'a>(inner: &'a Inner, root: &LeaderIdentity) -> Option<&'a LeaderBranch> {
    let mut owners = inner.branches.values().map(|record| &record.branch).filter(|branch| {
        branch.engine == root.engine && branch.session_id.as_deref() == Some(root.session_id.as_str())
            && same_workspace(&branch.workspace_path, &root.workspace_path)
    });
    let first = owners.next()?;
    Some(if first.state == "reclaimed" { owners.next().unwrap_or(first) } else { first })
}

/// Branches a record governs, including a child-rooted record's own branch.
pub(super) fn owned_branch_ids(inner: &Inner, group: &LeaderArchivedGroup) -> Vec<String> {
    let mut ids = group.branch_ids.clone();
    if let Some(top) = child_root_branch(inner, &group.root) {
        if !ids.contains(&top.id) {
            ids.push(top.id.clone());
        }
    }
    ids
}

/// Cleanup may retire a successfully finished assignment, or one that ended
/// otherwise once the parent's lease lapsed. Live or pending work never qualifies.
pub(super) fn cleanup_settled(branch: &LeaderBranch, now: i64) -> bool {
    let succeeded = |state: &str, error: &Option<String>| matches!(state, "completed" | "handed_off") && error.is_none();
    let ended = |state: &str| matches!(state, "completed" | "handed_off" | "failed" | "stopped" | "unknown");
    (branch.session_id.is_some() && succeeded(&branch.state, &branch.error)
        && branch.delegation.as_ref().is_none_or(|d| succeeded(&d.state, &d.error)))
        || (branch.deadline_at > 0 && now >= branch.deadline_at && ended(&branch.state)
            && branch.delegation.as_ref().is_none_or(|d| ended(&d.state)))
}

/// Archives already inside a tree being archived are folded into it, so every
/// branch and chat keeps exactly one owner for restore and deletion.
fn nested_archives(inner: &Inner, root: &LeaderIdentity, ids: &[String], members: &[LeaderIdentity])
    -> Result<Vec<LeaderArchivedGroup>, String> {
    let member_keys: HashSet<_> = members.iter().map(key).collect();
    let mut nested = Vec::new();
    for group in inner.archived_groups.values().filter(|group| key(&group.root) != key(root)) {
        let owned = owned_branch_ids(inner, group);
        let inside = member_keys.contains(&key(&group.root));
        if !inside && !owned.iter().any(|id| ids.contains(id))
            && !group.members.iter().any(|member| member_keys.contains(&key(member))) {
            continue;
        }
        if !inside || owned.iter().any(|id| !ids.contains(id))
            || group.members.iter().any(|member| !member_keys.contains(&key(member))) {
            return Err("Archived task ownership overlaps this tree inconsistently".into());
        }
        if group.deletion_started || inner.deleting_groups.contains(&key(&group.root)) {
            return Err("A task inside this tree is being deleted. Retry that deletion before archiving".into());
        }
        nested.push(group.clone());
    }
    Ok(nested)
}

fn write_members(conn: &Connection, group: &LeaderArchivedGroup) -> Result<(), String> {
    for member in &group.members {
        let owner: Option<(String, String, String)> = conn.query_row(
            "SELECT root_engine,root_session_id,root_workspace_path FROM leader_archived_members WHERE engine=?1 AND session_id=?2",
            params![member.engine, member.session_id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)),
        ).optional().map_err(|e| e.to_string())?;
        if owner.is_some_and(|owner| key(&identity(&owner.0, &owner.1, &owner.2)) != key(&group.root)) {
            return Err("Native identity belongs to another archived Leader group".into());
        }
        conn.execute(
            "INSERT INTO leader_archived_members(engine,session_id,workspace_path,root_engine,root_session_id,root_workspace_path)
             VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(engine,session_id) DO UPDATE SET workspace_path=excluded.workspace_path",
            params![member.engine,member.session_id,member.workspace_path,group.root.engine,group.root.session_id,group.root.workspace_path],
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// A group may span workspaces, but every edge must retain its exact parent
/// identity. Do not replace this with a project-membership or cwd-only check.
fn validate_lineage(inner: &Inner, root: &LeaderIdentity, ids: &[String]) -> Result<(), String> {
    let mut parents = vec![root.clone()];
    let mut reached = HashSet::new();
    let mut cursor = 0;
    while cursor < parents.len() {
        let parent = parents[cursor].clone();
        cursor += 1;
        for id in ids {
            let branch = &inner.branches.get(id).ok_or("Leader group branch is missing")?.branch;
            if !reached.contains(id) && belongs(branch, &parent) {
                reached.insert(id.clone());
                if let Some(session) = &branch.session_id {
                    parents.push(identity(&branch.engine, session, &branch.workspace_path));
                }
            }
        }
    }
    if reached.len() != ids.len() {
        return Err("Leader group crosses workspace ownership or has invalid parent lineage".into());
    }
    Ok(())
}

pub(super) fn load_groups(conn: &Connection, inner: &mut Inner) -> Result<(), String> {
    let mut stmt = conn.prepare("SELECT root_engine,root_session_id,workspace_path,record_json,deleting FROM leader_archived_groups")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, bool>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);
    for (engine, session, workspace, raw, deleting) in rows {
        let mut group: LeaderArchivedGroup = serde_json::from_str(&raw)
            .map_err(|e| format!("Invalid archived Leader group: {e}"))?;
        if key(&group.root) != key(&identity(&engine, &session, &workspace))
            || !group.members.contains(&group.root)
            || group
                .branch_ids
                .iter()
                .any(|id| !inner.branches.contains_key(id))
        {
            return Err("Archived Leader group ownership metadata is inconsistent".into());
        }
        validate_lineage(inner, &group.root, &group.branch_ids)?;
        let mut expected = vec![group.root.clone()];
        for id in &group.branch_ids {
            let branch = &inner.branches[id].branch;
            if let Some(session) = &branch.session_id {
                expected.push(identity(&branch.engine, session, &branch.workspace_path));
            }
        }
        if expected.len() != group.members.len()
            || expected.iter().any(|member| !group.members.iter().any(|saved| key(saved) == key(member)))
        {
            return Err("Archived Leader group member workspace metadata is inconsistent".into());
        }
        write_members(conn, &group)?;
        group.deletion_started = deleting;
        if deleting {
            inner.deleting_groups.insert(key(&group.root));
        }
        inner.archived_groups.insert(key(&group.root), group);
    }
    Ok(())
}

pub(super) fn session_meta(
    conn: &Connection,
    member: &LeaderIdentity,
    fallback: Option<&LeaderBranch>,
) -> Result<SessionMeta, String> {
    let saved: Option<SessionMeta> = conn.query_row(
        &format!("SELECT s.workspace_path,s.file_path,s.file_size,s.file_mtime_ms,COALESCE(at.title,s.title),s.preview,s.created_at,s.updated_at,s.message_count,s.pinned,s.custom_title,
          m.model,e.effort,p.provider_id,c.ultracode,aux.value FROM sessions s
          LEFT JOIN session_auto_titles at ON at.engine=s.engine AND at.session_id=s.session_id
          LEFT JOIN session_models m ON m.engine=s.engine AND m.session_id=s.session_id
          LEFT JOIN session_efforts e ON e.engine=s.engine AND e.session_id=s.session_id
          LEFT JOIN session_providers p ON p.engine=s.engine AND p.session_id=s.session_id
          LEFT JOIN session_claude_options c ON s.engine='claude' AND c.session_id=s.session_id
          LEFT JOIN plugin_kv aux ON aux.plugin_id='{namespace}' AND aux.key=s.engine || ':' || s.session_id
          WHERE s.engine=?1 AND s.session_id=?2", namespace=crate::db::session_auxiliary::NAMESPACE),
        params![member.engine,member.session_id], |r| Ok(SessionMeta {
            sidebar_workspace_path: None,
            prompt_cache: None,
            auxiliary_kind: crate::db::session_auxiliary::decode(r.get(15)?)?,
            engine: member.engine.clone(), session_id: member.session_id.clone(), workspace_path:r.get(0)?,
            file_path:r.get(1)?,file_size:r.get(2)?,file_mtime_ms:r.get(3)?,title:r.get(4)?,preview:r.get(5)?,
            created_at:r.get(6)?,updated_at:r.get(7)?,message_count:r.get(8)?,pinned:r.get(9)?,custom_title:r.get(10)?,
            model:r.get(11)?,effort:r.get(12)?,provider:r.get(13)?,claude_ultracode:r.get(14)?,remote:None,remote_path:None,
        }),
    ).optional().map_err(|e|e.to_string())?;
    if let Some(saved) = saved {
        if !same_workspace(&saved.workspace_path, &member.workspace_path) {
            return Err("Saved native chat belongs to another workspace".into());
        }
        return Ok(saved);
    }
    let archived: Option<String> = conn
        .query_row(
            "SELECT snapshot_json FROM session_archives WHERE engine=?1 AND session_id=?2",
            params![member.engine, member.session_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(raw) = archived {
        let archived: SessionMeta = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        if archived.engine != member.engine
            || archived.session_id != member.session_id
            || !same_workspace(&archived.workspace_path, &member.workspace_path)
            || archived.remote == Some(true)
        {
            return Err("Archived native chat ownership does not match this Leader group".into());
        }
        return Ok(archived);
    }
    // A managed native identity can predate the history scan. Never invent an id.
    let branch = fallback.ok_or("Leader root is not a saved chat in this exact workspace")?;
    Ok(SessionMeta {
        sidebar_workspace_path: None,
        prompt_cache: None,
        auxiliary_kind: None,
        engine: member.engine.clone(),
        session_id: member.session_id.clone(),
        workspace_path: member.workspace_path.clone(),
        file_path: String::new(),
        file_size: 0,
        file_mtime_ms: 0,
        title: branch.title.clone(),
        preview: String::new(),
        created_at: Some(branch.created_at),
        updated_at: Some(branch.updated_at),
        message_count: 0,
        pinned: false,
        custom_title: None,
        model: branch.model.clone(),
        effort: branch.effort.clone(),
        provider: None,
        claude_ultracode: if member.engine == "claude" {
            conn.query_row("SELECT ultracode FROM session_claude_options WHERE session_id=?1",
                [&member.session_id], |r| r.get(0)).optional().map_err(|e| e.to_string())?
        } else { None },
        remote: None,
        remote_path: None,
    })
}

#[cfg(test)]
mod auxiliary_tests {
    use super::*;

    #[test]
    fn auxiliary_kind_is_preserved_in_leader_archive_metadata() {
        let db = crate::db::Db::open_in_memory().unwrap();
        let conn = db.0.lock();
        conn.execute(
            "INSERT INTO sessions(engine,session_id,workspace_path,file_path,file_size,file_mtime_ms)
             VALUES('cursor','aux','/ws','/missing.jsonl',0,0)", [],
        ).unwrap();
        crate::db::session_auxiliary::set(&conn, "cursor", "aux", Some("cursor_cce")).unwrap();
        let member = identity("cursor", "aux", "/ws");
        let saved = session_meta(&conn, &member, None).unwrap();
        assert_eq!(saved.auxiliary_kind.as_deref(), Some("cursor_cce"));
        // Leader's archive fallback must also preserve the serialized field.
        conn.execute(
            "INSERT INTO session_archives(engine,session_id,workspace_path,snapshot_json,archived_at)
             VALUES('cursor','aux','/ws',?1,1)", [serde_json::to_string(&saved).unwrap()],
        ).unwrap();
        conn.execute("DELETE FROM sessions WHERE engine='cursor' AND session_id='aux'", []).unwrap();
        assert_eq!(session_meta(&conn, &member, None).unwrap().auxiliary_kind.as_deref(), Some("cursor_cce"));
    }
}

impl LeaderManager {
    fn group_branches(&self, inner: &Inner, root: &LeaderIdentity) -> Result<Vec<String>, String> {
        if inner.branches.values().any(|record| {
            record.branch.engine == root.engine
                && record.branch.session_id.as_deref() == Some(&root.session_id)
        }) {
            return Err(
                "Whole-group actions require the topmost Leader root, not a child chat".into(),
            );
        }
        if !inner.leaders.contains_key(&key(root))
            && !inner.disabled.contains(&key(root))
            && !inner.archived_groups.contains_key(&key(root))
            && !inner
                .branches
                .values()
                .any(|r| belongs(&r.branch, root) && r.branch.state != "reclaimed")
        {
            return Err("This chat is not a Leader root in this exact workspace".into());
        }
        let mut direct: Vec<_> = inner
            .branches
            .values()
            .filter(|r| belongs(&r.branch, root) && r.branch.state != "reclaimed")
            .map(|r| r.branch.id.clone())
            .collect();
        direct.sort();
        let mut ids = Vec::new();
        let mut visiting = HashSet::new();
        for id in direct {
            Self::subtree(inner, &id, &mut visiting, &mut ids)?;
        }
        Ok(ids)
    }

    fn group_members(
        &self,
        inner: &Inner,
        root: &LeaderIdentity,
        ids: &[String],
    ) -> Result<Vec<LeaderIdentity>, String> {
        self.subtree_members(inner, root, ids, true)
    }

    pub(super) fn subtree_members(
        &self,
        inner: &Inner,
        root: &LeaderIdentity,
        ids: &[String],
        include_root: bool,
    ) -> Result<Vec<LeaderIdentity>, String> {
        let mut members = Vec::new();
        let mut seen = HashSet::new();
        if include_root {
            members.push(root.clone());
            seen.insert((root.engine.clone(), root.session_id.clone()));
        }
        for id in ids {
            let branch = &inner
                .branches
                .get(id)
                .ok_or("Leader group branch is missing")?
                .branch;
            if let Some(session) = &branch.session_id {
                if !seen.insert((branch.engine.clone(), session.clone())) {
                    return Err("Leader ledger contains duplicate native chat ownership".into());
                }
                members.push(identity(&branch.engine, session, &branch.workspace_path));
            }
        }
        validate_lineage(inner, root, ids)?;
        let id_set: HashSet<_> = ids.iter().collect();
        if inner.branches.values().any(|record| {
            let branch = &record.branch;
            !id_set.contains(&branch.id)
                && (branch
                    .session_id
                    .as_ref()
                    .is_some_and(|s| seen.contains(&(branch.engine.clone(), s.clone())))
                    || (branch.state != "reclaimed"
                        && seen.contains(&(
                            branch.parent_engine.clone(),
                            branch.parent_session_id.clone(),
                        ))))
        }) || inner
            .leaders
            .keys()
            .chain(inner.disabled.iter())
            .any(|(e, s, w)| members.iter().any(|member| member.engine == *e && member.session_id == *s
                && !same_workspace(w, &member.workspace_path)))
        {
            return Err("Leader ledger contains a conflicting native identity or workspace".into());
        }
        members[usize::from(include_root)..].sort_by_key(key);
        Ok(members)
    }

    pub(super) fn group_idle(
        &self,
        inner: &Inner,
        members: &[LeaderIdentity],
        ids: &[String],
    ) -> Result<(), String> {
        if inner.shutdown {
            return Err("Leader coordinator is shutting down".into());
        }
        let member = |engine: &str, session: &str| {
            members
                .iter()
                .any(|m| m.engine == engine && m.session_id == session)
        };
        if members.iter().any(|m| {
            inner
                .retiring
                .contains(&(m.engine.clone(), m.session_id.clone()))
                || self.processes.get(&m.session_id).is_some()
        }) || inner.pending_bindings.iter().any(|(id, (e, s))| {
            member(e, s)
                || inner
                    .runs
                    .get(id)
                    .and_then(|r| r.branch_id.as_ref())
                    .is_some_and(|id| ids.contains(id))
        }) || inner.runs.iter().any(|(id, run)| {
            let belongs = run.branch_id.as_ref().is_some_and(|id| ids.contains(id))
                || run
                    .session_id
                    .as_ref()
                    .is_some_and(|s| member(&run.engine, s))
                || run
                    .isolated_resume_session
                    .as_ref()
                    .is_some_and(|s| member(&run.engine, s));
            belongs && ((!run.retired && run.launch_pending) || self.processes.get(id).is_some())
        }) || ids.iter().any(|id| {
            inner.branches.get(id).is_some_and(|record| {
                record.stopping
                    || matches!(
                        record.branch.state.as_str(),
                        "starting" | "running" | "waiting" | "awaiting_cost_approval" | "reclaiming" | "stopping"
                    )
                    || self.active(inner, &record.branch)
            })
        }) {
            return Err("Leader group must be idle. Stop active chats and resolve pending questions or launches before using whole-group actions".into());
        }
        Ok(())
    }

    pub(super) fn archive_group(
        &self,
        root: &LeaderIdentity,
    ) -> Result<LeaderArchivedGroup, String> {
        self.archive_group_checked(root, None)
    }

    pub(super) fn archive_group_checked(
        &self,
        root: &LeaderIdentity,
        expected: Option<&GroupCleanupExpectation>,
    ) -> Result<LeaderArchivedGroup, String> {
        let mut inner = self.inner.lock();
        let ids = self.group_branches(&inner, root)?;
        if let Some(group) = inner.archived_groups.get(&key(root)) {
            if expected.is_some() {
                return Err("CLEANUP_GROUP_CHANGED: Task group was already archived; refresh the cleanup list".into());
            }
            self.group_idle(&inner, &group.members, &group.branch_ids)?;
            return Ok(group.clone());
        }
        let members = self.group_members(&inner, root, &ids)?;
        self.group_idle(&inner, &members, &ids)?;
        if let Some(expected) = expected {
            self.check_cleanup_expectation(&inner, &ids, &members, expected)?;
        }
        let group = self.commit_archive(&mut inner, root, ids, members, expected)?;
        drop(inner);
        self.emit();
        self.emitter
            .emit_json(crate::event_sink::SESSIONS_CHANGED_EVENT, "null");
        Ok(group)
    }

    /// Archive one expired, settled child subtree while its parent stays live.
    pub(super) fn archive_subtree_checked(
        &self,
        parent: &LeaderIdentity,
        branch_id: &str,
        expected: &GroupCleanupExpectation,
    ) -> Result<LeaderArchivedGroup, String> {
        const CHANGED: &str = "CLEANUP_GROUP_CHANGED: Child task changed; review it again before archiving";
        let mut inner = self.inner.lock();
        let branch = inner.branches.get(branch_id).map(|record| record.branch.clone()).ok_or(CHANGED)?;
        let session = branch.session_id.clone().ok_or(CHANGED)?;
        let root = identity(&branch.engine, &session, &branch.workspace_path);
        // A lapsed lease separates history from a child the parent may still
        // continue; an archived parent already owns the whole subtree.
        if !belongs(&branch, parent)
            || branch.state == "reclaimed"
            || inner.archived_groups.contains_key(&key(&root))
            || ensure_available(&inner, &parent.engine, &parent.session_id, Some(branch_id)).is_err()
            || branch.deadline_at <= 0
            || (self.clock)() < branch.deadline_at
            || child_root_branch(&inner, &root).map(|top| top.id.as_str()) != Some(branch_id)
        {
            return Err(CHANGED.into());
        }
        let mut ids = Vec::new();
        Self::subtree(&inner, branch_id, &mut HashSet::new(), &mut ids)?;
        let mut members = self.subtree_members(&inner, parent, &ids, false)?;
        let at = members.iter().position(|member| key(member) == key(&root)).ok_or(CHANGED)?;
        let root_member = members.remove(at);
        members.insert(0, root_member);
        self.group_idle(&inner, &members, &ids)?;
        self.check_cleanup_expectation(&inner, &ids, &members, expected)?;
        ids.retain(|id| id != branch_id);
        let group = self.commit_archive(&mut inner, &root, ids, members, Some(expected))?;
        drop(inner);
        self.emit();
        self.emitter
            .emit_json(crate::event_sink::SESSIONS_CHANGED_EVENT, "null");
        Ok(group)
    }

    /// `ids` lists every governed branch, including a child root's own branch.
    fn check_cleanup_expectation(
        &self,
        inner: &Inner,
        ids: &[String],
        members: &[LeaderIdentity],
        expected: &GroupCleanupExpectation,
    ) -> Result<(), String> {
        let expected_ids: HashSet<_> = expected.branch_ids.iter().collect();
        let actual_ids: HashSet<_> = ids.iter().collect();
        let expected_members: HashSet<_> = expected.members.iter().map(key).collect();
        let actual_members: HashSet<_> = members.iter().map(key).collect();
        if expected.last_activity_at <= 0 || ids.is_empty()
            || expected_ids.len() != expected.branch_ids.len() || expected_ids != actual_ids
            || expected_members.len() != expected.members.len() || expected_members != actual_members
        {
            return Err("CLEANUP_GROUP_CHANGED: Task group membership changed; review it again before archiving".into());
        }
        let now = (self.clock)();
        for id in ids {
            let branch = &inner.branches.get(id).ok_or("Leader group branch is missing")?.branch;
            let delegation_changed = branch.delegation.as_ref().is_some_and(|delegation|
                delegation.updated_at <= 0 || delegation.updated_at > expected.last_activity_at);
            if !cleanup_settled(branch, now) || branch.updated_at <= 0 || branch.last_activity_at <= 0
                || branch.updated_at > expected.last_activity_at || branch.last_activity_at > expected.last_activity_at
                || delegation_changed
            {
                return Err("CLEANUP_GROUP_CHANGED: Task group activity or status changed; review it again before archiving".into());
            }
        }
        Ok(())
    }

    /// One transaction commits the record, its chats' archive markers and any
    /// nested archives it absorbs. Chats frozen by a nested archive skip the
    /// cleanup activity check: they cannot have run since they were archived.
    fn commit_archive(
        &self,
        inner: &mut Inner,
        root: &LeaderIdentity,
        ids: Vec<String>,
        members: Vec<LeaderIdentity>,
        expected: Option<&GroupCleanupExpectation>,
    ) -> Result<LeaderArchivedGroup, String> {
        let top = child_root_branch(inner, root).cloned();
        let mut governed = ids.clone();
        governed.extend(top.as_ref().map(|top| top.id.clone()));
        let nested = nested_archives(inner, root, &governed, &members)?;
        let frozen: HashSet<_> = nested.iter().flat_map(|group| group.members.iter().map(key)).collect();
        let fallback = |member: &LeaderIdentity| inner.branches.values().find(|r| r.branch.engine == member.engine
            && r.branch.session_id.as_deref() == Some(&member.session_id)).map(|r| &r.branch);
        let mut conn = self.db.0.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let root_meta = session_meta(&tx, root, top.as_ref())?;
        if let Some(expected) = expected {
            for member in members.iter().filter(|member| !frozen.contains(&key(member))) {
                let meta = session_meta(&tx, member, fallback(member))?;
                if meta.pinned || meta.remote == Some(true)
                    || !meta.updated_at.is_some_and(|updated| updated > 0 && updated <= expected.last_activity_at)
                {
                    return Err("CLEANUP_GROUP_CHANGED: Task group chat activity or pin changed; review it again before archiving".into());
                }
            }
        }
        let group = LeaderArchivedGroup {
            root: root.clone(),
            title: root_meta
                .custom_title
                .clone()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(root_meta.title.clone()),
            archived_at: (self.clock)(),
            members,
            branch_ids: ids,
            deletion_started: false,
        };
        for id in &governed {
            write_branch(
                &tx,
                inner
                    .branches
                    .get(id)
                    .ok_or("Leader group branch is missing")?,
            )?;
        }
        for absorbed in &nested {
            clear_group(&tx, &absorbed.root)?;
        }
        for member in &group.members {
            ensure_not_archived(&tx, &member.engine, &member.session_id)?;
            let meta = session_meta(&tx, member, fallback(member))?;
            tx.execute("INSERT INTO session_archives(engine,session_id,workspace_path,snapshot_json,archived_at) VALUES(?1,?2,?3,?4,?5)
                ON CONFLICT(engine,session_id) DO UPDATE SET workspace_path=excluded.workspace_path,snapshot_json=excluded.snapshot_json,archived_at=excluded.archived_at",
                params![member.engine,member.session_id,member.workspace_path,serde_json::to_string(&meta).map_err(|e|e.to_string())?,group.archived_at]).map_err(|e|e.to_string())?;
        }
        tx.execute("INSERT INTO leader_archived_groups(root_engine,root_session_id,workspace_path,record_json) VALUES(?1,?2,?3,?4)",
            params![root.engine,root.session_id,root.workspace_path,serde_json::to_string(&group).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        write_members(&tx, &group)?;
        tx.commit().map_err(|e| e.to_string())?;
        drop(conn);
        for id in &governed {
            // Presence was checked before commit and inner remained locked.
            if let Some(record) = inner.branches.get_mut(id) {
                record.dirty = false;
            }
        }
        for absorbed in &nested {
            inner.archived_groups.remove(&key(&absorbed.root));
        }
        inner.archived_groups.insert(key(root), group.clone());
        Ok(group)
    }

    pub(super) fn archive_group_for_user(&self, root: &LeaderIdentity) -> Result<(), String> {
        if self.archive_group(root)?.deletion_started {
            return Err(
                "Deletion incomplete; retry whole-group deletion in Leader management".into(),
            );
        }
        Ok(())
    }

    pub(super) fn restore_group(&self, root: &LeaderIdentity) -> Result<(), String> {
        let mut inner = self.inner.lock();
        let archived = inner.archived_groups.get(&key(root)).cloned();
        let top = archived.as_ref().and_then(|_| child_root_branch(&inner, root)).cloned();
        if let Some(top) = &top {
            // A child archive returns beneath its parent, which must still be live.
            ensure_available(&inner, &top.parent_engine, &top.parent_session_id, None)?;
            if inner.retiring.contains(&(top.parent_engine.clone(), top.parent_session_id.clone())) {
                return Err("Parent chat is being archived or deleted".into());
            }
        } else {
            self.group_branches(&inner, root)?;
        }
        let group = archived.ok_or("Leader group is not archived")?;
        let root = &group.root;
        if inner.deleting_groups.contains(&key(root)) {
            return Err("This Leader group was partially deleted. Retry whole-group deletion in Leader management".into());
        }
        let governed = owned_branch_ids(&inner, &group);
        self.group_idle(&inner, &group.members, &governed)?;
        let mut conn = self.db.0.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        // Recheck exact persisted ownership inside the restore transaction.
        session_meta(&tx, root, top.as_ref())?;
        for id in &governed {
            write_branch(
                &tx,
                inner
                    .branches
                    .get(id)
                    .ok_or("Leader group branch is missing")?,
            )?;
        }
        for member in &group.members {
            let fallback = inner
                .branches
                .values()
                .find(|r| {
                    r.branch.engine == member.engine
                        && r.branch.session_id.as_deref() == Some(&member.session_id)
                })
                .map(|r| &r.branch);
            session_meta(&tx, member, fallback)?;
            crate::history::reader::restore_claude_options_from_archive(
                &tx, &member.engine, &member.session_id,
            )?;
            tx.execute("DELETE FROM session_archives WHERE engine=?1 AND session_id=?2 AND workspace_path=?3",
                params![member.engine,member.session_id,member.workspace_path]).map_err(|e|e.to_string())?;
        }
        clear_group(&tx, root)?;
        tx.commit().map_err(|e| e.to_string())?;
        for id in &governed {
            if let Some(record) = inner.branches.get_mut(id) {
                record.dirty = false;
            }
        }
        inner.archived_groups.remove(&key(root));
        drop(conn);
        drop(inner);
        self.emit();
        self.emitter
            .emit_json(crate::event_sink::SESSIONS_CHANGED_EVENT, "null");
        Ok(())
    }

    pub(super) fn begin_group_delete(
        self: &Arc<Self>,
        expected: &LeaderArchivedGroup,
    ) -> Result<Vec<RetirementGuard>, String> {
        let root = &expected.root;
        let mut inner = self.inner.lock();
        if inner.archived_groups.get(&key(root)) != Some(expected) {
            return Err("Leader group changed before deletion began. Retry whole-group deletion in Leader management".into());
        }
        self.group_idle(&inner, &expected.members, &owned_branch_ids(&inner, expected))?;
        let conn = self.db.0.lock();
        let changed = conn.execute("UPDATE leader_archived_groups SET deleting=1 WHERE root_engine=?1 AND root_session_id=?2 AND workspace_path=?3",
            params![root.engine,root.session_id,root.workspace_path]).map_err(|e|e.to_string())?;
        if changed != 1 {
            return Err("Archived Leader group disappeared before deletion began; no transcript was deleted".into());
        }
        inner.deleting_groups.insert(key(root));
        if let Some(group) = inner.archived_groups.get_mut(&key(root)) {
            group.deletion_started = true;
        }
        let guards = expected
            .members
            .iter()
            .map(|member| {
                let identity = (member.engine.clone(), member.session_id.clone());
                inner.retiring.insert(identity.clone());
                RetirementGuard {
                    manager: Some(self.clone()),
                    identity,
                }
            })
            .collect();
        drop(conn);
        drop(inner);
        self.emit();
        Ok(guards)
    }

    pub(super) async fn delete_group(
        self: &Arc<Self>,
        root: &LeaderIdentity,
    ) -> Result<(), String> {
        let child_archive = {
            let inner = self.inner.lock();
            inner.archived_groups.get(&key(root)).cloned()
                .and_then(|group| Some((group, child_root_branch(&inner, root)?.clone())))
        };
        if let Some((group, top)) = child_archive {
            return self.delete_child_archive(group, top).await;
        }
        let group = self.archive_group(root)?;
        let root = &group.root;
        let guards = self.begin_group_delete(&group)?;
        // Reuse postorder reclamation and its durable per-branch checkpoints.
        let mut direct: Vec<_> = self
            .inner
            .lock()
            .branches
            .values()
            .filter(|r| belongs(&r.branch, root) && r.branch.state != "reclaimed")
            .map(|r| r.branch.id.clone())
            .collect();
        direct.sort();
        for id in direct {
            self.reclaim_owned(root, &id, Some(root), None).await?;
        }
        let db = self.db.clone();
        let delete = self.delete.clone();
        let engine = root.engine.clone();
        let session = root.session_id.clone();
        tauri::async_runtime::spawn_blocking(move || delete(&db, &engine, &session))
            .await
            .map_err(|e| format!("Leader root deletion worker failed: {e}"))??;
        {
            let mut inner = self.inner.lock();
            let mut conn = self.db.0.lock();
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            delete_role(&tx, root)?;
            clear_group(&tx, root)?;
            tx.commit().map_err(|e| e.to_string())?;
            inner.leaders.remove(&key(root));
            inner.disabled.remove(&key(root));
            inner.archived_groups.remove(&key(root));
            inner.deleting_groups.remove(&key(root));
        }
        drop(guards);
        self.emit();
        self.emitter
            .emit_json(crate::event_sink::SESSIONS_CHANGED_EVENT, "null");
        Ok(())
    }

    /// Permanently delete an archived child subtree; its parent is untouched.
    async fn delete_child_archive(
        self: &Arc<Self>,
        group: LeaderArchivedGroup,
        top: LeaderBranch,
    ) -> Result<(), String> {
        let root = &group.root;
        let guards = self.begin_group_delete(&group)?;
        let reclaimed = self.inner.lock().branches.get(&top.id).is_none_or(|r| r.branch.state == "reclaimed");
        if !reclaimed {
            // Postorder reclamation checkpoints each branch and removes the
            // child's own transcript and role last, exactly like branch deletion.
            let parent = identity(&top.parent_engine, &top.parent_session_id, top.parent_workspace());
            self.reclaim_owned(&parent, &top.id, Some(root), None).await?;
        }
        {
            let mut inner = self.inner.lock();
            let mut conn = self.db.0.lock();
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            clear_group(&tx, root)?;
            tx.commit().map_err(|e| e.to_string())?;
            inner.archived_groups.remove(&key(root));
            inner.deleting_groups.remove(&key(root));
        }
        drop(guards);
        self.emit();
        self.emitter
            .emit_json(crate::event_sink::SESSIONS_CHANGED_EVENT, "null");
        Ok(())
    }
}

fn clear_group(conn: &Connection, root: &LeaderIdentity) -> Result<(), String> {
    conn.execute("DELETE FROM leader_archived_members WHERE root_engine=?1 AND root_session_id=?2 AND root_workspace_path=?3",
        params![root.engine,root.session_id,root.workspace_path]).map_err(|e|e.to_string())?;
    conn.execute("DELETE FROM leader_archived_groups WHERE root_engine=?1 AND root_session_id=?2 AND workspace_path=?3",
        params![root.engine,root.session_id,root.workspace_path]).map_err(|e|e.to_string())?;
    Ok(())
}

pub(super) async fn group_action(
    db: &Db,
    engine: String,
    session_id: String,
    workspace_path: String,
    action: String,
) -> Result<LeaderSnapshot, String> {
    supported(&engine)?;
    text_limit(&session_id, "session_id", 256)?;
    validate_workspace(db, &workspace_path)?;
    let root = identity(&engine, &session_id, &workspace_path);
    let manager = manager()?;
    match action.as_str() {
        "archive" => {
            manager.archive_group_for_user(&root)?;
        }
        "restore" => manager.restore_group(&root)?,
        "delete" => manager.delete_group(&root).await?,
        _ => return Err("Unknown Leader group action".into()),
    }
    Ok(manager.snapshot_memory())
}

pub(super) async fn group_archive_checked(
    db: &Db,
    engine: String,
    session_id: String,
    workspace_path: String,
    expected: GroupCleanupExpectation,
) -> Result<LeaderSnapshot, String> {
    supported(&engine)?;
    text_limit(&session_id, "session_id", 256)?;
    validate_workspace(db, &workspace_path)?;
    let root = identity(&engine, &session_id, &workspace_path);
    let manager = manager()?;
    manager.archive_group_checked(&root, Some(&expected))?;
    Ok(manager.snapshot_memory())
}

pub(super) async fn subtree_archive_checked(
    db: &Db,
    parent_engine: String,
    parent_session_id: String,
    workspace_path: String,
    branch_id: String,
    expected: GroupCleanupExpectation,
) -> Result<LeaderSnapshot, String> {
    supported(&parent_engine)?;
    text_limit(&parent_session_id, "parent_session_id", 256)?;
    text_limit(&branch_id, "branch_id", 256)?;
    validate_workspace(db, &workspace_path)?;
    let parent = identity(&parent_engine, &parent_session_id, &workspace_path);
    let manager = manager()?;
    manager.archive_subtree_checked(&parent, &branch_id, &expected)?;
    Ok(manager.snapshot_memory())
}
