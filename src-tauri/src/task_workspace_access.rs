//! Final launch checks for managed tasks. Workspace registration and launch
//! reservations remain authoritative; legacy workspace grants are no longer read.
use rusqlite::params;

/// Revalidate the durable reservation immediately before process creation or
/// a native model-turn submission, after asynchronous launch preparation.
pub(crate) fn recheck_launch(
    db: &crate::db::Db,
    run_id: &str,
    engine: &str,
    workspace: &str,
) -> Result<(), String> {
    if !crate::leader::is_managed_child(run_id) {
        return Ok(());
    }
    recheck_managed_launch(db, run_id, engine, workspace)
}

pub(crate) fn recheck_managed_launch(
    db: &crate::db::Db,
    run_id: &str,
    engine: &str,
    workspace: &str,
) -> Result<(), String> {
    let archived = crate::settings::read_settings()?.archived_workspaces;
    let conn = db.0.lock();
    let mut query = conn.prepare("SELECT record_json FROM leader_branches WHERE engine=?1 AND json_extract(record_json,'$.runId')=?2")
        .map_err(|e| e.to_string())?;
    let rows = query
        .query_map(params![engine, run_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if rows.len() != 1 {
        return Err("Managed task launch reservation is unavailable".into());
    }
    let branch: crate::leader::LeaderBranch =
        serde_json::from_str(&rows[0]).map_err(|_| "Invalid managed task launch reservation")?;
    if branch.engine != engine
        || branch.run_id.as_deref() != Some(run_id)
        || !crate::leader::same_workspace(&branch.workspace_path, workspace)
        || !matches!(branch.state.as_str(), "starting" | "running" | "waiting")
        || branch.cost_approval.is_some()
    {
        return Err("Managed task launch reservation changed".into());
    }
    crate::leader::authorize_task_workspace(&conn, &archived, branch.parent_workspace(), workspace)
}

#[cfg(test)]
mod tests;
