//! Human-only subtree deletion. Never routed through agent tools or remote actions.
use super::*;

impl LeaderManager {
    pub(super) fn validate_branch_deletion(
        &self,
        inner: &Inner,
        parent: &LeaderIdentity,
        ids: &[String],
    ) -> Result<Vec<LeaderIdentity>, String> {
        if inner.retiring.contains(&(parent.engine.clone(), parent.session_id.clone())) {
            return Err("Parent chat is being archived or deleted".into());
        }
        let parent_branch = inner.branches.values().find(|r| {
            r.branch.engine == parent.engine
                && r.branch.session_id.as_deref() == Some(&parent.session_id)
        });
        if parent_branch.is_some_and(|r| {
            fenced(&r.branch.state) || r.stopping
                || !same_workspace(&r.branch.workspace_path, &parent.workspace_path)
        }) {
            return Err("Parent chat is unavailable or belongs to another workspace".into());
        }
        let members = self.subtree_members(inner, parent, ids, false)?;
        self.group_idle(inner, &members, ids).map_err(|_| {
            "The selected task subtree must be idle. Resolve active runs, pending questions, launches, bindings or retirement before deleting".to_string()
        })?;
        let conn = self.db.0.lock();
        archive::ensure_not_archived(&conn, &parent.engine, &parent.session_id)?;
        archive::session_meta(&conn, parent, parent_branch.map(|r| &r.branch))?;
        for id in ids {
            let branch = &inner.branches.get(id).ok_or("Subtree branch is missing")?.branch;
            archive::ensure_available(inner, &branch.engine, branch.session_id.as_deref().unwrap_or_default(), Some(id))?;
            if let Some(session) = &branch.session_id {
                archive::ensure_not_archived(&conn, &branch.engine, session)?;
                archive::session_meta(&conn, &identity(&branch.engine, session, &branch.workspace_path), Some(branch))?;
            }
        }
        Ok(members)
    }

    pub(super) async fn delete_branch_for_user(
        self: &Arc<Self>,
        parent: &LeaderIdentity,
        id: &str,
        expected_branch_ids: &[String],
    ) -> Result<LeaderSnapshot, String> {
        self.reclaim_owned(parent, id, None, Some(expected_branch_ids)).await?;
        Ok(self.snapshot_memory())
    }
}
