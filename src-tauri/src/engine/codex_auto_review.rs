//! Codex's native reviewer owns decisions. This module selects and verifies
//! that mode and represents the rare requests it delegates to a human.
//! No local model, broad approval, or silent full-access fallback is used.

use serde_json::{json, Map, Value};
use std::collections::HashMap;
use tokio::process::Command;

pub(super) const UNAVAILABLE: &str = "CODEX_AUTO_REVIEW_UNAVAILABLE:";

pub(super) fn enabled(permission: Option<&str>) -> bool {
    !matches!(
        permission,
        Some("manual" | "bypass" | "plan" | super::codex_read_only::PERMISSION)
    )
}

pub(super) fn configure(command: &mut Command) {
    command.args(["--enable", "guardian_approval"]);
    for setting in [
        "approval_policy=\"on-request\"",
        "approvals_reviewer=\"auto_review\"",
        "sandbox_mode=\"workspace-write\"",
    ] {
        command.arg("-c").arg(setting);
    }
}

pub(super) fn configure_thread(params: &mut Value) {
    // The current app-server permission profile is authoritative, including
    // on Windows. Do not combine it with the mutually exclusive legacy
    // sandbox request (which can silently become read-only on Windows).
    params["permissions"] = json!(":workspace");
    params["approvalPolicy"] = json!("on-request");
    params["approvalsReviewer"] = json!("auto_review");
}

pub(super) fn validate_thread(response: &Value) -> Result<(), String> {
    for (field, expected) in [
        ("approvalPolicy", "on-request"),
        ("approvalsReviewer", "auto_review"),
    ] {
        if response.get(field).and_then(Value::as_str) != Some(expected) {
            return Err(format!("{UNAVAILABLE} Codex did not activate {field}={expected}. Update the CLI or check managed permission requirements."));
        }
    }
    if response.pointer("/sandbox/type").and_then(Value::as_str) != Some("workspaceWrite") {
        return Err(format!("{UNAVAILABLE} Codex did not activate the workspace-write sandbox. Check the CLI sandbox setup and managed permission requirements."));
    }
    Ok(())
}

/// Only this feature's resolved value proves that the reviewer can run. The
/// thread response echoes auto_review even when guardian_approval is disabled.
pub(super) fn feature_enabled(page: &Value) -> Option<bool> {
    page.get("data")?
        .as_array()?
        .iter()
        .find(|item| item.get("name").and_then(Value::as_str) == Some("guardian_approval"))
        .map(|item| item.get("enabled").and_then(Value::as_bool) == Some(true))
}

#[derive(Default)]
pub(super) struct Reviews {
    // One target item can have several distinct reviews. A network review has
    // no target item at all, so reviewId is the sole lifecycle identity.
    records: HashMap<String, Value>,
}

impl Reviews {
    pub(super) fn observe(&mut self, params: &Value) -> Option<Value> {
        let id = params.get("reviewId")?.as_str()?.trim();
        if id.is_empty() {
            return None;
        }
        let status = params.pointer("/review/status")?.as_str()?;
        if !matches!(
            status,
            "inProgress" | "approved" | "denied" | "timedOut" | "aborted"
        ) {
            return None;
        }
        if let Some(previous) = self.records.get(id) {
            if previous.pointer("/review/status").and_then(Value::as_str) != Some("inProgress")
                || previous == params
            {
                return None;
            }
        }
        self.records.insert(id.to_string(), params.clone());
        Some(params.clone())
    }

    pub(super) fn abort_pending(&mut self) -> Vec<Value> {
        self.records
            .values_mut()
            .filter_map(|record| {
                if record.pointer("/review/status").and_then(Value::as_str) != Some("inProgress") {
                    return None;
                }
                record["review"]["status"] = json!("aborted");
                // Keep the native rationale if one exists. A stopped review must
                // never acquire a fabricated approval or risk assessment.
                Some(record.clone())
            })
            .collect()
    }
}

fn select(value: &Value, keys: &[&str]) -> Value {
    let mut out = Map::new();
    for key in keys {
        if let Some(value) = value.get(*key).filter(|value| !value.is_null()) {
            out.insert((*key).to_string(), value.clone());
        }
    }
    Value::Object(out)
}

fn command_can_accept(params: &Value) -> bool {
    match params
        .get("availableDecisions")
        .filter(|value| !value.is_null())
    {
        None => true,
        Some(Value::Array(decisions)) => decisions
            .iter()
            .any(|decision| decision.as_str() == Some("accept")),
        Some(_) => false,
    }
}

/// Frontend receives a display-only subset; original params and RPC id stay
/// in the backend registry and are never reconstructed from client input.
pub(super) fn approval_card(
    method: &str,
    params: &Value,
    file_changes: Option<&Value>,
) -> Option<Value> {
    let (kind, can_approve, scope, details) = match method {
        "item/commandExecution/requestApproval" => (
            "command",
            command_can_accept(params),
            "once",
            select(
                params,
                &[
                    "kind",
                    "command",
                    "cwd",
                    "environmentId",
                    "networkApprovalContext",
                    "additionalPermissions",
                ],
            ),
        ),
        "item/fileChange/requestApproval" => {
            let mut details = select(params, &["grantRoot"]);
            if let Some(changes) = file_changes {
                details["changes"] = changes.clone();
            }
            // A file approval with no visible change details must not solicit
            // a blind grant. Decline remains available.
            (
                "file",
                file_changes
                    .and_then(Value::as_array)
                    .is_some_and(|files| !files.is_empty()),
                "once",
                details,
            )
        }
        "item/permissions/requestApproval" => (
            "permissions",
            requested_permissions(params).is_some(),
            "turn",
            select(params, &["cwd", "environmentId", "permissions"]),
        ),
        "mcpServer/elicitation/request" if is_mcp_approval(params) => {
            let mut details = select(params, &["serverName", "message"]);
            details["tool"] = params["_meta"]["tool_name"].clone();
            details["arguments"] = params
                .pointer("/_meta/tool_params")
                .cloned()
                .unwrap_or_else(|| json!({}));
            ("mcp", true, "once", details)
        }
        _ => return None,
    };
    Some(
        json!({"kind":kind,"canApprove":can_approve,"grantScope":scope,
        "reason":params.get("reason").or_else(|| params.get("message")),"details":details}),
    )
}

fn requested_permissions(params: &Value) -> Option<Value> {
    let profile = params.get("permissions")?.as_object()?;
    // Unknown profile fields cannot be granted under a UI that cannot
    // describe them. Null entries are omitted in GrantedPermissionProfile.
    if profile
        .keys()
        .any(|key| !matches!(key.as_str(), "network" | "fileSystem"))
    {
        return None;
    }
    let mut granted = Map::new();
    for key in ["network", "fileSystem"] {
        if let Some(value) = profile.get(key).filter(|value| !value.is_null()) {
            if !value.is_object() {
                return None;
            }
            granted.insert(key.to_string(), value.clone());
        }
    }
    if granted.is_empty() {
        return None;
    }
    Some(Value::Object(granted))
}

fn is_mcp_approval(params: &Value) -> bool {
    // Official metadata from protocol/src/mcp_approval_meta.rs (0.159.2).
    // Arbitrary forms, login URLs and verification are not yes/no grants.
    params.get("mode").and_then(Value::as_str) == Some("form")
        && params
            .pointer("/requestedSchema/properties")
            .and_then(Value::as_object)
            .is_some_and(|properties| properties.is_empty())
        && params
            .pointer("/_meta/codex_request_type")
            .and_then(Value::as_str)
            == Some("approval_request")
        && params
            .pointer("/_meta/codex_approval_kind")
            .and_then(Value::as_str)
            == Some("mcp_tool_call")
        && params
            .pointer("/_meta/codex_requires_user_input")
            .and_then(Value::as_bool)
            != Some(true)
        && params
            .pointer("/_meta/tool_name")
            .and_then(Value::as_str)
            .is_some_and(|name| !name.trim().is_empty())
        && params
            .pointer("/_meta/tool_params")
            .is_none_or(Value::is_object)
}

pub(super) fn answer_result(context: &Value, answers: Option<&Value>) -> Result<Value, String> {
    let decision = match answers {
        None => "decline",
        Some(Value::Object(answers)) if answers.len() == 1 => answers
            .get("decision")
            .and_then(Value::as_str)
            .ok_or("Invalid Codex approval decision")?,
        _ => return Err("Invalid Codex approval decision".into()),
    };
    if !matches!(decision, "allow_once" | "decline") {
        return Err("Invalid Codex approval decision".into());
    }
    let allow = decision == "allow_once";
    if allow && context.pointer("/card/canApprove").and_then(Value::as_bool) != Some(true) {
        return Err("This Codex request does not permit a one-time approval".into());
    }
    let params = context
        .get("params")
        .ok_or("Codex approval context is missing")?;
    match context.get("method").and_then(Value::as_str) {
        Some("item/commandExecution/requestApproval" | "item/fileChange/requestApproval") => {
            Ok(json!({"decision":if allow { "accept" } else { "decline" }}))
        }
        Some("item/permissions/requestApproval") => Ok(json!({
            "permissions":if allow { requested_permissions(params).ok_or("Invalid Codex requested permission profile")? } else { json!({}) },
            "scope":"turn",
        })),
        Some("mcpServer/elicitation/request") if is_mcp_approval(params) => Ok(
            json!({"action":if allow { "accept" } else { "decline" },"content":if allow { json!({}) } else { Value::Null },"_meta":null}),
        ),
        _ => Err("Unsupported Codex approval request".into()),
    }
}

#[cfg(test)]
#[path = "codex_auto_review_tests.rs"]
mod tests;
