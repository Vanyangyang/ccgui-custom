//! Request-bound MCP access to presentation-only saved-chat organization.
use crate::session_sidebar::{AssignArgs, SidebarSession};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[tauri::command]
pub(crate) fn host_get_session_sidebar_workspaces(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    request_id: String,
) -> Result<Vec<SidebarSession>, String> {
    crate::host_chat::with_workspace_request(window.label(), &request_id, "get_session_sidebar_workspaces", |_, _| {
        crate::session_sidebar::list(&state.db)
    })
}

#[tauri::command]
pub(crate) fn host_assign_session_sidebar_workspaces(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    request_id: String,
) -> Result<Value, String> {
    let result = crate::host_chat::with_workspace_request(window.label(), &request_id, "assign_session_sidebar_workspaces", |scope, arguments| {
        let args: AssignArgs = serde_json::from_value(arguments.clone()).map_err(|_| "Invalid sidebar assignment arguments")?;
        // Receipt keys belong to the authenticated originating saved chat, not
        // a caller-supplied identity. GUI request keys remain a separate space.
        let payload = serde_json::to_vec(&(scope, &args.request_id)).map_err(|e| e.to_string())?;
        let key = format!("host:{:x}", Sha256::digest(payload));
        let mut result = match crate::session_sidebar::assign(&state.db, key, args.assignments) {
            Ok(result) => result,
            Err(error) => return assignment_failure(error),
        };
        result.request_id = args.request_id;
        serde_json::to_value(result).map_err(|e| e.to_string())
    })?;
    if result.get("assignmentFailure").is_none() && result["replayed"] == false {
        state.sink.emit_sessions_changed();
    }
    Ok(result)
}

/// Batch conflicts can exceed the relay's small error-string budget. Keep the
/// complete structured report on its bounded result channel; MCP marks it as
/// an error for the caller. Unexpected/internal failures remain ordinary errors.
pub(crate) fn assignment_failure(error: String) -> Result<Value, String> {
    match serde_json::from_str::<Value>(&error) {
        Ok(value) if value["code"] == "SESSION_SIDEBAR_ASSIGNMENT_CONFLICT"
            && value["conflicts"].is_array() => Ok(serde_json::json!({"assignmentFailure": value})),
        _ => Err(error),
    }
}
