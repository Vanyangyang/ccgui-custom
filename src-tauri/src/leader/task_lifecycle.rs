//! Read-only lifecycle evidence for retained plugin coordinators. Neither a
//! visible timeline nor an old turn's terminal event is current liveness proof.
use super::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskSessionLifecycle {
    engine: String,
    session_id: String,
    workspace_path: String,
    pub(super) archived: bool,
    pub(super) idle: bool,
}

impl LeaderManager {
    pub(super) fn session_lifecycle(
        &self,
        root: &LeaderIdentity,
    ) -> Result<TaskSessionLifecycle, String> {
        if !matches!(root.engine.as_str(), "claude" | "codex" | "agy" | "cursor")
            || root.session_id.is_empty()
            || root.session_id.len() > 256
            || root.workspace_path.trim().is_empty()
            || root.workspace_path.len() > 32768
            || [&root.engine, &root.session_id, &root.workspace_path]
                .iter()
                .any(|s| s.contains('\0'))
        {
            return Err("Invalid task lifecycle identity".into());
        }
        // The same lock fences prepare/bind, retirement and child ownership.
        // Keep DB identity and all liveness checks within this observation.
        let inner = self.inner.lock();
        if inner.shutdown {
            return Err("Task lifecycle owner is shutting down".into());
        }
        if inner.deleting_groups.contains(&key(root))
            || inner
                .archived_groups
                .get(&key(root))
                .is_some_and(|g| g.deletion_started)
        {
            return Err("Task lifecycle source is being deleted".into());
        }
        let conn = self.db.0.lock();
        let mut query = conn
            .prepare("SELECT path,meta FROM workspaces")
            .map_err(|e| e.to_string())?;
        let workspaces = query
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        let matches: Vec<_> = workspaces
            .iter()
            .filter(|(path, _)| same_workspace(path, &root.workspace_path))
            .collect();
        if matches.len() != 1 {
            return Err("Task lifecycle workspace is missing or ambiguous".into());
        }
        if let Some(raw) = &matches[0].1 {
            let meta: Value =
                serde_json::from_str(raw).map_err(|_| "Invalid workspace metadata")?;
            if !meta.is_object() || meta.get("wsl").is_some() || meta.get("remote").is_some() {
                return Err("Task lifecycle requires a local workspace".into());
            }
        }
        let saved: Option<String> = conn
            .query_row(
                "SELECT workspace_path FROM sessions WHERE engine=?1 AND session_id=?2",
                params![root.engine, root.session_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let archived: Option<(String, String)> = conn.query_row(
            "SELECT workspace_path,snapshot_json FROM session_archives WHERE engine=?1 AND session_id=?2",
            params![root.engine, root.session_id], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(|e| e.to_string())?;
        if saved.is_none() && archived.is_none() {
            return Err("Task lifecycle source identity is unavailable".into());
        }
        if saved
            .as_ref()
            .is_some_and(|path| !same_workspace(path, &root.workspace_path))
        {
            return Err("Task lifecycle source workspace does not match".into());
        }
        if let Some((path, raw)) = &archived {
            let meta: Value =
                serde_json::from_str(raw).map_err(|_| "Invalid archived source identity")?;
            if !same_workspace(path, &root.workspace_path)
                || meta.get("engine").and_then(Value::as_str) != Some(&root.engine)
                || meta.get("sessionId").and_then(Value::as_str) != Some(&root.session_id)
                || !meta
                    .get("workspacePath")
                    .and_then(Value::as_str)
                    .is_some_and(|p| same_workspace(p, &root.workspace_path))
                || !matches!(
                    meta.get("remote"),
                    None | Some(Value::Null) | Some(Value::Bool(false))
                )
            {
                return Err("Archived task lifecycle identity is remote or conflicting".into());
            }
        }
        let mut ids = Vec::new();
        let mut visiting = HashSet::new();
        for record in inner
            .branches
            .values()
            .filter(|r| belongs(&r.branch, root) && r.branch.state != "reclaimed")
        {
            Self::subtree(&inner, &record.branch.id, &mut visiting, &mut ids)?;
        }
        let members = self.subtree_members(&inner, root, &ids, true)?;
        let children_terminal = ids.iter().all(|id| {
            inner.branches.get(id).is_some_and(|r| {
                matches!(
                    r.branch.state.as_str(),
                    "completed" | "failed" | "stopped" | "handed_off" | "reclaimed"
                )
            })
        });
        // Reuse the full group guard: pending bindings, isolated resumes,
        // retiring identities, pid-0 reservations and managed child launches.
        let guarded_idle = self.group_idle(&inner, &members, &ids).is_ok();
        // Registry get() intentionally tolerates poisoning for other callers;
        // a negative lifecycle proof must fail closed and recheck presence.
        let processes = self
            .processes
            .0
            .lock()
            .map_err(|_| "Process registry unavailable")?;
        let active_member = members
            .iter()
            .any(|m| processes.contains_key(&m.session_id))
            || inner.runs.iter().any(|(id, run)| {
                processes.contains_key(id)
                    && (run.branch_id.as_ref().is_some_and(|id| ids.contains(id))
                        || members.iter().any(|m| {
                            m.engine == run.engine
                                && (run.session_id.as_deref() == Some(&m.session_id)
                                    || run.isolated_resume_session.as_deref()
                                        == Some(&m.session_id))
                        }))
            });
        Ok(TaskSessionLifecycle {
            engine: root.engine.clone(),
            session_id: root.session_id.clone(),
            workspace_path: root.workspace_path.clone(),
            archived: archived.is_some(),
            idle: guarded_idle && children_terminal && !active_member,
        })
    }
}

#[tauri::command]
pub(crate) async fn task_session_lifecycle(
    window: tauri::WebviewWindow,
    engine: String,
    session_id: String,
    workspace_path: String,
) -> Result<TaskSessionLifecycle, String> {
    require_main(&window)?;
    let manager = MANAGER
        .get()
        .cloned()
        .ok_or("Task lifecycle owner is unavailable")?;
    tokio::task::spawn_blocking(move || {
        manager.session_lifecycle(&identity(&engine, &session_id, &workspace_path))
    })
    .await
    .map_err(|_| "Task lifecycle observation failed".to_string())?
}
