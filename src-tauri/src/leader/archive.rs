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
    if inner.archived_groups.values().any(|group| {
        group
            .members
            .iter()
            .any(|member| member.engine == engine && member.session_id == session)
            || branch.is_some_and(|id| group.branch_ids.iter().any(|candidate| candidate == id))
    }) {
        return Err(GROUP_REQUIRED.into());
    }
    Ok(())
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
                .members
                .iter()
                .any(|member| !same_workspace(&member.workspace_path, &group.root.workspace_path))
            || group
                .branch_ids
                .iter()
                .any(|id| !inner.branches.contains_key(id))
        {
            return Err("Archived Leader group ownership metadata is inconsistent".into());
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
            if !same_workspace(&branch.workspace_path, &root.workspace_path) {
                return Err("Leader group crosses workspace ownership".into());
            }
            if let Some(session) = &branch.session_id {
                if !seen.insert((branch.engine.clone(), session.clone())) {
                    return Err("Leader ledger contains duplicate native chat ownership".into());
                }
                members.push(identity(&branch.engine, session, &branch.workspace_path));
            }
        }
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
            .any(|(e, s, w)| seen.contains(&(e.clone(), s.clone())) && !same_workspace(w, &root.workspace_path))
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
                        "starting" | "running" | "waiting" | "reclaiming" | "stopping"
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
        let mut inner = self.inner.lock();
        let ids = self.group_branches(&inner, root)?;
        if let Some(group) = inner.archived_groups.get(&key(root)) {
            self.group_idle(&inner, &group.members, &group.branch_ids)?;
            return Ok(group.clone());
        }
        let members = self.group_members(&inner, root, &ids)?;
        self.group_idle(&inner, &members, &ids)?;
        let mut conn = self.db.0.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let root_meta = session_meta(&tx, root, None)?;
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
        for id in &group.branch_ids {
            write_branch(
                &tx,
                inner
                    .branches
                    .get(id)
                    .ok_or("Leader group branch is missing")?,
            )?;
        }
        for member in &group.members {
            ensure_not_archived(&tx, &member.engine, &member.session_id)?;
            let fallback = inner
                .branches
                .values()
                .find(|r| {
                    r.branch.engine == member.engine
                        && r.branch.session_id.as_deref() == Some(&member.session_id)
                })
                .map(|r| &r.branch);
            let meta = session_meta(&tx, member, fallback)?;
            tx.execute("INSERT INTO session_archives(engine,session_id,workspace_path,snapshot_json,archived_at) VALUES(?1,?2,?3,?4,?5)
                ON CONFLICT(engine,session_id) DO UPDATE SET workspace_path=excluded.workspace_path,snapshot_json=excluded.snapshot_json,archived_at=excluded.archived_at",
                params![member.engine,member.session_id,member.workspace_path,serde_json::to_string(&meta).map_err(|e|e.to_string())?,group.archived_at]).map_err(|e|e.to_string())?;
        }
        tx.execute("INSERT INTO leader_archived_groups(root_engine,root_session_id,workspace_path,record_json) VALUES(?1,?2,?3,?4)",
            params![root.engine,root.session_id,root.workspace_path,serde_json::to_string(&group).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        write_members(&tx, &group)?;
        tx.commit().map_err(|e| e.to_string())?;
        for id in &group.branch_ids {
            // Presence was checked before commit and inner remained locked.
            if let Some(record) = inner.branches.get_mut(id) {
                record.dirty = false;
            }
        }
        inner.archived_groups.insert(key(root), group.clone());
        drop(conn);
        drop(inner);
        self.emit();
        self.emitter
            .emit_json(crate::event_sink::SESSIONS_CHANGED_EVENT, "null");
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
        self.group_branches(&inner, root)?;
        let group = inner
            .archived_groups
            .get(&key(root))
            .ok_or("Leader group is not archived")?
            .clone();
        let root = &group.root;
        if inner.deleting_groups.contains(&key(root)) {
            return Err("This Leader group was partially deleted. Retry whole-group deletion in Leader management".into());
        }
        self.group_idle(&inner, &group.members, &group.branch_ids)?;
        let mut conn = self.db.0.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        // Recheck exact persisted ownership inside the restore transaction.
        session_meta(&tx, root, None)?;
        for id in &group.branch_ids {
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
        for id in &group.branch_ids {
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
        self.group_idle(&inner, &expected.members, &expected.branch_ids)?;
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
