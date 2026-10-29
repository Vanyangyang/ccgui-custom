//! Keep managed task output out of the ordinary saved-chat consultation queue.
use super::*;

const REPORT_CHANNEL_ERROR: &str = "TASK_REPORT_REQUIRES_TASK_CHANNEL: No consultation was queued. Write progress or completion in normal assistant output during the delegated run; the parent reads it through task_list/task_wait. A later manual continuation does not reopen a completed delegation. Do not wait for a reply to a report. task_send is parent-to-child only. Only an actual question requiring the parent's reply may use send_message with intent=\"question\", under the existing authorization and cost approval rules. A target prefix matching your parent is conservatively treated as the parent; specify exact target selectors when contacting an unrelated chat.";

/// Host-generated routing evidence, never accepted from tool arguments.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ManagedParent {
    pub branch_id: String,
    pub engine: String,
    pub session_id: String,
    pub workspace_path: String,
}

fn child_matches(branch: &LeaderBranch, sender: &LeaderIdentity) -> bool {
    branch.engine == sender.engine
        && branch.session_id.as_deref() == Some(sender.session_id.as_str())
        && same_workspace(&branch.workspace_path, &sender.workspace_path)
}

/// Exact relationship check shared by route creation and later revalidation.
fn matches_parent(branch: &LeaderBranch, sender: &LeaderIdentity, parent: &ManagedParent) -> bool {
    branch.id == parent.branch_id && child_matches(branch, sender)
        && !matches!(branch.state.as_str(), "reclaimed" | "handed_off")
        && branch.parent_engine == parent.engine
        && branch.parent_session_id == parent.session_id
        && same_workspace(branch.parent_workspace(), &parent.workspace_path)
}

impl LeaderManager {
    pub(super) fn managed_parent_message(
        &self, sender: &LeaderIdentity, target_session: &str,
        target_engine: Option<&str>, target_workspace: Option<&str>,
    ) -> Option<ManagedParent> {
        let inner = self.inner.lock();
        // Duplicate durable ownership is ambiguous even if one row was retired.
        let mut children = inner.branches.values().filter(|r| child_matches(&r.branch, sender));
        let branch = &children.next()?.branch;
        if children.next().is_some() { return None; }
        let parent = ManagedParent { branch_id: branch.id.clone(), engine: branch.parent_engine.clone(),
            session_id: branch.parent_session_id.clone(), workspace_path: branch.parent_workspace().into() };
        if !matches_parent(branch, sender, &parent)
            || !(parent.session_id == target_session || target_session.len() >= 8 && parent.session_id.starts_with(target_session))
            || target_engine.is_some_and(|engine| engine != parent.engine)
            || target_workspace.is_some_and(|workspace| !same_workspace(workspace, &parent.workspace_path)) {
            return None;
        }
        // This ledger can prove conflicts, not uniqueness across all saved chats.
        // The recipient must still resolve its full catalog and match this exact identity.
        let conflicts = inner.branches.values().any(|r| {
            let b = &r.branch;
            let candidate = |engine: &str, session: &str, workspace: &str| {
                (session == target_session || target_session.len() >= 8 && session.starts_with(target_session))
                    && target_engine.is_none_or(|wanted| wanted == engine)
                    && target_workspace.is_none_or(|wanted| same_workspace(wanted, workspace))
                    && (engine != parent.engine || session != parent.session_id || !same_workspace(workspace, &parent.workspace_path))
            };
            candidate(&b.parent_engine, &b.parent_session_id, b.parent_workspace())
                || b.session_id.as_deref().is_some_and(|session| candidate(&b.engine, session, &b.workspace_path))
        });
        if conflicts { None } else { Some(parent) }
    }

    pub(super) fn validate_parent_message(
        &self,
        sender: &LeaderIdentity,
        target_session: &str,
        target_engine: Option<&str>,
        target_workspace: Option<&str>,
        question: bool,
    ) -> Result<(), String> {
        if question {
            return Ok(());
        }
        let inner = self.inner.lock();
        // The relay authenticates sender identity. Durable branch identity also
        // covers restored workers and later manual turns after the delegated run
        // has finished; neither a model-supplied title nor run liveness owns it.
        let targets_parent = inner.branches.values().any(|record| {
            let b = &record.branch;
            b.state != "reclaimed"
                && b.engine == sender.engine
                && b.session_id.as_deref() == Some(sender.session_id.as_str())
                && same_workspace(&b.workspace_path, &sender.workspace_path)
                && (b.parent_session_id == target_session
                    || target_session.len() >= 8 && b.parent_session_id.starts_with(target_session))
                && target_engine.is_none_or(|engine| engine == b.parent_engine)
                && target_workspace.is_none_or(|workspace| same_workspace(workspace, b.parent_workspace()))
        });
        if targets_parent { Err(REPORT_CHANNEL_ERROR.into()) } else { Ok(()) }
    }
}

pub(crate) fn managed_parent_message(
    sender: &LeaderIdentity, target_session: &str, target_engine: Option<&str>, target_workspace: Option<&str>,
) -> Option<ManagedParent> {
    MANAGER.get()?.managed_parent_message(sender, target_session, target_engine, target_workspace)
}

pub(crate) fn validate_parent_message(
    sender: &LeaderIdentity,
    target_session: &str,
    target_engine: Option<&str>,
    target_workspace: Option<&str>,
    question: bool,
) -> Result<(), String> {
    if question { return Ok(()); }
    // Host chat may start even when loading the task ledger fails. Missing
    // relationship evidence must not silently enqueue a possible task report.
    let manager = MANAGER.get().ok_or("TASK_RELATIONSHIP_UNAVAILABLE: No consultation was queued because the native task relationship registry is unavailable. Report task progress in normal assistant output; only an actual question may use intent=\"question\" under the existing authorization and cost approval rules.")?;
    manager.validate_parent_message(sender, target_session, target_engine, target_workspace, false)
}
