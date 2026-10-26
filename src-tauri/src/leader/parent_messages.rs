//! Keep managed task output out of the ordinary saved-chat consultation queue.
use super::*;

const REPORT_CHANNEL_ERROR: &str = "TASK_REPORT_REQUIRES_TASK_CHANNEL: No consultation was queued. Write progress or completion in normal assistant output during the delegated run; the parent reads it through task_list/task_wait. A later manual continuation does not reopen a completed delegation. Do not wait for a reply to a report. task_send is parent-to-child only. Only an actual question requiring the parent's reply may use send_message with intent=\"question\", under the existing authorization and cost approval rules. A target prefix matching your parent is conservatively treated as the parent; specify exact target selectors when contacting an unrelated chat.";

impl LeaderManager {
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
