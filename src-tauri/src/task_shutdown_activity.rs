//! Read-only native barriers for a user-armed shutdown plan.
//! An empty process registry alone does not cover queued parent continuations.
pub(crate) async fn blockers(state: &crate::AppState) -> Result<Vec<String>, String> {
    let mut reasons = Vec::new();
    {
        let runs = state
            .processes
            .0
            .lock()
            .map_err(|_| "Native activity registry unavailable".to_string())?;
        let ids: std::collections::HashSet<_> = runs.values().map(|run| &run.run_id).collect();
        if !ids.is_empty() {
            reasons.push("native-runs".into());
        }
    }
    reasons.extend(crate::leader::shutdown_activity()?);
    reasons.extend(crate::host_chat::shutdown_activity());
    reasons.extend(crate::worker_host::shutdown_activity().await);
    if !crate::worker_host::enabled() {
        reasons.push("native-coordinator-unavailable".into());
    }
    if crate::worker_host::paused() {
        reasons.push("runtime-updating".into());
    }
    reasons.extend(crate::handoff::shutdown_activity()?);
    if state.agy_acp.has_active_turns()
        || state
            .worktree_creations
            .snapshot()
            .iter()
            .any(|creation| creation.active)
        || crate::auto_title::has_pending()
        || crate::plugin_memory::has_active_work()
    {
        reasons.push("background-work".into());
    }
    reasons.sort();
    reasons.dedup();
    Ok(reasons)
}
