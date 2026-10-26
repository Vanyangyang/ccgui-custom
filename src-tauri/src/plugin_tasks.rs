//! Plugin task routing (`host:tasks`): one isolated, tool-less planner call
//! that maps a goal onto plugin-supplied candidate projects.
//!
//! The planner never executes anything. Its structured answer is data: every
//! step must name a candidate project id, write paths are normalized into that
//! project's directory, and nothing it returns is run as a command or path
//! lookup here. Candidates must be registered, local, non-archived workspaces.
//! Session creation and delivery live in the frontend task bridge
//! (src/features/plugins/runtime/task-bridge.ts), which owns the GUI timeline.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::engine::side_call::{self, SideCallError};

const PLAN_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_GOAL_CHARS: usize = 20_000;
const MAX_CONTEXT_CHARS: usize = 20_000;
const MAX_PROJECTS: usize = 16;
const MAX_STEPS: usize = 12;
const MAX_REFS: usize = 32;
const MAX_WRITE_PATHS: usize = 64;
const MAX_INSTRUCTION_CHARS: usize = 20_000;
const MAX_CONCURRENT_PLANS: usize = 4;

const SYSTEM_PROMPT: &str = "You route one user goal onto execution projects for a desktop coding assistant. \
You never execute anything and never answer the goal itself.\n\
Each step becomes one turn in a coding-agent conversation whose working directory is the step's project workspacePath. \
That agent can read other candidate paths by absolute path but should only write inside its own project.\n\
Rules:\n\
- projectId must be one of the candidate ids.\n\
- Prefer the fewest steps. Use one step when one project can deliver the goal. Split only when deliverables live in different projects \
or a later step truly needs an earlier step's result (list those earlier ids in dependsOn).\n\
- If it is unclear which project must change, or missing information would change the routing, return status needs_clarification \
with one concise question in the goal's language and an empty steps array. Otherwise return status ready with an empty question.\n\
- instruction must be self-contained: the agent sees only it, not this routing request. Keep the user's intent and constraints; do not invent requirements.\n\
- writePaths: paths relative to the step's project that the step is expected to modify; [] for read-only analysis. When unsure, list the containing directory.\n\
- contextRefs: only identifiers or paths that appear in the goal or context and that the agent should consult. Never invent references.\n\
- Write titles and instructions in the goal's language.";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlanProject {
    pub id: String,
    pub label: String,
    pub workspace_path: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlannerSelection {
    pub engine: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub provider_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlanRequest {
    pub request_id: String,
    pub goal: String,
    pub projects: Vec<PlanProject>,
    #[serde(default)]
    pub context: Option<String>,
    pub planner: PlannerSelection,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanStep {
    pub id: String,
    pub title: String,
    pub project_id: String,
    pub instruction: String,
    pub depends_on: Vec<String>,
    pub context_refs: Vec<String>,
    pub write_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlannerUsed {
    pub engine: String,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanResult {
    pub request_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    pub steps: Vec<PlanStep>,
    pub planner: PlannerUsed,
    pub created_at: u64,
}

/// In-flight plans keyed by (plugin, request). Completed answers are cached by
/// the frontend bridge; this registry exists for cancellation and to refuse an
/// overlapping duplicate.
static RUNNING: LazyLock<Mutex<HashMap<(String, String), tokio::task::AbortHandle>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn err(code: &str, message: impl AsRef<str>) -> String {
    format!("{code}: {}", message.as_ref())
}

fn require_tasks_grant(plugin_id: &str) -> Result<(), String> {
    let (enabled, permissions) = crate::plugins::plugin_enabled_permissions(plugin_id)?;
    if !enabled {
        return Err(format!("{plugin_id}: plugin is disabled"));
    }
    if !permissions.iter().any(|p| p == "host:tasks") {
        return Err(format!("{plugin_id}: missing permission host:tasks"));
    }
    Ok(())
}

/// Task launches and discussions share the native channel/model resolver, but
/// each command enforces its own permission. Detached views never own launches.
#[tauri::command]
pub(crate) fn plugin_task_resolve(
    window: tauri::WebviewWindow,
    plugin_id: String,
    selection: crate::plugin_conversations::Selection,
) -> Result<crate::plugin_conversations::Selection, String> {
    require_tasks_grant(&plugin_id)?;
    if window.label() != "main" {
        return Err("Only the main plugin owner can resolve task launches".into());
    }
    crate::plugin_conversations::resolve_selection(selection)
}

fn valid_request_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

fn plain_text(value: &str, max: usize) -> bool {
    !value.trim().is_empty()
        && value.chars().count() <= max
        && !value.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
}

/// Case/separator-insensitive on Windows drive paths, exact elsewhere.
fn path_key(path: &str) -> String {
    let trimmed = path.trim_end_matches(['/', '\\']);
    let bytes = trimmed.as_bytes();
    if cfg!(windows) && bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        trimmed.replace('\\', "/").to_lowercase()
    } else {
        trimmed.to_string()
    }
}

/// Registered, local, non-archived workspace whose directory exists.
fn validate_workspace(db: &crate::db::Db, workspace: &str) -> Result<(), String> {
    let rows: Vec<(String, String, Option<String>)> = {
        let conn = db.0.lock();
        let mut stmt = conn
            .prepare("SELECT id,path,meta FROM workspaces")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    let key = path_key(workspace);
    let matches: Vec<_> = rows.into_iter().filter(|(_, path, _)| path_key(path) == key).collect();
    if matches.is_empty() {
        return Err(err("invalid_request", format!("{workspace} is not a registered local workspace")));
    }
    let archived = crate::settings::read_settings()?.archived_workspaces;
    for (id, _, meta) in matches {
        if archived.contains(&id) {
            return Err(err("invalid_request", format!("{workspace} is archived")));
        }
        let remote = meta
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .is_some_and(|meta| meta.get("wsl").is_some());
        if remote {
            return Err(err("invalid_request", format!("{workspace} is a remote workspace")));
        }
    }
    if !std::path::Path::new(workspace).is_dir() {
        return Err(err("invalid_request", format!("{workspace} is unavailable")));
    }
    Ok(())
}

fn valid_selector(value: &str) -> bool {
    value.len() <= 512 && !value.starts_with('-') && !value.chars().any(|c| c.is_control() || c.is_whitespace())
}

fn validate_request(request: &PlanRequest) -> Result<(), String> {
    if !valid_request_id(&request.request_id) {
        return Err(err("invalid_request", "requestId must match [A-Za-z0-9._:-]{1,128}"));
    }
    if !plain_text(&request.goal, MAX_GOAL_CHARS) {
        return Err(err("invalid_request", "goal must be non-empty text up to 20000 characters"));
    }
    if let Some(context) = &request.context {
        if context.chars().count() > MAX_CONTEXT_CHARS {
            return Err(err("invalid_request", "context exceeds 20000 characters"));
        }
    }
    if request.projects.is_empty() || request.projects.len() > MAX_PROJECTS {
        return Err(err("invalid_request", "projects must contain 1-16 candidates"));
    }
    let mut ids = HashSet::new();
    for project in &request.projects {
        if !valid_request_id(&project.id) || !ids.insert(project.id.as_str()) {
            return Err(err("invalid_request", "project ids must be unique and match [A-Za-z0-9._:-]{1,128}"));
        }
        if !plain_text(&project.label, 200) {
            return Err(err("invalid_request", "project label must be non-empty text up to 200 characters"));
        }
        if project.description.as_deref().is_some_and(|d| d.chars().count() > 2000) {
            return Err(err("invalid_request", "project description exceeds 2000 characters"));
        }
        if project.workspace_path.trim() != project.workspace_path || project.workspace_path.is_empty() {
            return Err(err("invalid_request", "project workspacePath must be an exact registered path"));
        }
    }
    let planner = &request.planner;
    if !matches!(planner.engine.as_str(), "claude" | "codex" | "pi") {
        return Err(err(
            "planner_unavailable",
            format!("engine {:?} has no isolated planner; use claude, codex or pi", planner.engine),
        ));
    }
    if !valid_selector(&planner.model) {
        return Err(err("invalid_request", "invalid planner model"));
    }
    if planner.provider_id.as_deref().is_some_and(|id| id.is_empty() || id.len() > 512 || id.trim() != id || id.chars().any(char::is_control)) {
        return Err(err("invalid_request", "invalid planner provider"));
    }
    if planner.effort.as_deref().is_some_and(|effort| !matches!(effort,
        "none" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra")) {
        return Err(err("invalid_request", "invalid planner effort"));
    }
    Ok(())
}

fn plan_schema(project_ids: &[String]) -> Value {
    let strings = json!({ "type": "array", "items": { "type": "string" } });
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["status", "question", "steps"],
        "properties": {
            "status": { "type": "string", "enum": ["ready", "needs_clarification"] },
            "question": { "type": "string" },
            "steps": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["id", "title", "projectId", "instruction", "dependsOn", "contextRefs", "writePaths"],
                    "properties": {
                        "id": { "type": "string" },
                        "title": { "type": "string" },
                        "projectId": { "type": "string", "enum": project_ids },
                        "instruction": { "type": "string" },
                        "dependsOn": strings,
                        "contextRefs": strings,
                        "writePaths": strings
                    }
                }
            }
        }
    })
}

fn plan_input(request: &PlanRequest) -> String {
    let projects: Vec<Value> = request
        .projects
        .iter()
        .map(|p| json!({
            "id": p.id, "label": p.label, "workspacePath": p.workspace_path,
            "description": p.description.clone().unwrap_or_default(),
        }))
        .collect();
    json!({
        "goal": request.goal,
        "context": request.context.clone().unwrap_or_default(),
        "candidateProjects": projects,
    })
    .to_string()
}

fn bad(message: impl AsRef<str>) -> String {
    err("bad_output", message)
}

fn string_list(value: &Value, field: &str, max_items: usize) -> Result<Vec<String>, String> {
    let items = value
        .get(field)
        .and_then(Value::as_array)
        .ok_or_else(|| bad(format!("step {field} must be an array")))?;
    if items.len() > max_items {
        return Err(bad(format!("step {field} has more than {max_items} entries")));
    }
    items
        .iter()
        .map(|item| {
            item.as_str()
                .filter(|s| plain_text(s, 1024) && !s.contains(['\n', '\r']))
                .map(|s| s.trim().to_string())
                .ok_or_else(|| bad(format!("step {field} entries must be single-line text")))
        })
        .collect()
}

/// Project-relative, forward-slash form. Absolute paths are accepted only
/// inside the step's own project; `..` never escapes it.
pub(crate) fn normalize_write_path(raw: &str, root: &str) -> Result<String, String> {
    let unified = raw.trim().replace('\\', "/");
    let root_unified = root.replace('\\', "/").trim_end_matches('/').to_string();
    let is_absolute = unified.starts_with('/') || (unified.len() >= 2 && unified.as_bytes()[1] == b':');
    let relative = if is_absolute {
        let candidate = path_key(&unified);
        let base = path_key(&root_unified);
        if candidate == base {
            String::new()
        } else if candidate.starts_with(&format!("{base}/")) {
            unified
                .get(root_unified.len() + 1..)
                .ok_or_else(|| bad(format!("write path {raw:?} is outside its project")))?
                .to_string()
        } else {
            return Err(bad(format!("write path {raw:?} is outside its project")));
        }
    } else {
        unified
    };
    let mut parts = Vec::new();
    for segment in relative.split('/') {
        match segment {
            "" | "." => {}
            ".." => return Err(bad(format!("write path {raw:?} escapes its project"))),
            other => parts.push(other),
        }
    }
    Ok(if parts.is_empty() { ".".into() } else { parts.join("/") })
}

pub(crate) fn validate_plan(
    request: &PlanRequest,
    structured: &Value,
    planner: PlannerUsed,
    created_at: u64,
) -> Result<PlanResult, String> {
    let status = structured.get("status").and_then(Value::as_str).ok_or_else(|| bad("missing status"))?;
    let question = structured.get("question").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let raw_steps = structured.get("steps").and_then(Value::as_array).ok_or_else(|| bad("missing steps"))?;
    let roots: HashMap<&str, &str> = request
        .projects
        .iter()
        .map(|p| (p.id.as_str(), p.workspace_path.as_str()))
        .collect();
    match status {
        "needs_clarification" => {
            if !plain_text(&question, 2000) {
                return Err(bad("needs_clarification requires a question"));
            }
            if !raw_steps.is_empty() {
                return Err(bad("needs_clarification must not carry steps"));
            }
            return Ok(PlanResult {
                request_id: request.request_id.clone(),
                status: status.into(),
                question: Some(question),
                steps: Vec::new(),
                planner,
                created_at,
            });
        }
        "ready" => {}
        other => return Err(bad(format!("unknown status {other:?}"))),
    }
    if raw_steps.is_empty() || raw_steps.len() > MAX_STEPS {
        return Err(bad("ready plans need 1-12 steps"));
    }
    let mut seen = HashSet::new();
    let mut steps = Vec::with_capacity(raw_steps.len());
    for raw in raw_steps {
        let text = |field: &str, max: usize| {
            raw.get(field)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| plain_text(s, max))
                .map(str::to_string)
                .ok_or_else(|| bad(format!("step {field} must be non-empty text")))
        };
        let id = text("id", 64)?;
        if !id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')) {
            return Err(bad("step id must match [A-Za-z0-9._-]{1,64}"));
        }
        let title = text("title", 200)?;
        let instruction = text("instruction", MAX_INSTRUCTION_CHARS)?;
        let project_id = raw
            .get("projectId")
            .and_then(Value::as_str)
            .ok_or_else(|| bad("step projectId is missing"))?
            .to_string();
        let root = *roots
            .get(project_id.as_str())
            .ok_or_else(|| bad(format!("step projectId {project_id:?} is not a candidate")))?;
        let depends_on = string_list(raw, "dependsOn", MAX_STEPS)?;
        if let Some(missing) = depends_on.iter().find(|dep| !seen.contains(dep.as_str())) {
            return Err(bad(format!("step {id} depends on {missing:?}, which is not an earlier step")));
        }
        let context_refs = string_list(raw, "contextRefs", MAX_REFS)?;
        let mut write_paths = Vec::new();
        for path in string_list(raw, "writePaths", MAX_WRITE_PATHS)? {
            let normalized = normalize_write_path(&path, root)?;
            if !write_paths.contains(&normalized) {
                write_paths.push(normalized);
            }
        }
        if !seen.insert(id.clone()) {
            return Err(bad(format!("duplicate step id {id:?}")));
        }
        steps.push(PlanStep { id, title, project_id, instruction, depends_on, context_refs, write_paths });
    }
    Ok(PlanResult {
        request_id: request.request_id.clone(),
        status: "ready".into(),
        question: None,
        steps,
        planner,
        created_at,
    })
}

fn side_call_error(error: SideCallError) -> String {
    match error {
        SideCallError::Unavailable => err("planner_unavailable", "the planner engine, model or channel is unavailable"),
        SideCallError::Timeout => err("timeout", "the planner did not answer in time"),
        SideCallError::BadOutput => err("bad_output", "the planner returned no usable structured answer"),
        SideCallError::Failed => err("failed", "the planner call failed"),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

struct RunningGuard(String, String);
impl Drop for RunningGuard {
    fn drop(&mut self) {
        RUNNING.lock().remove(&(self.0.clone(), self.1.clone()));
    }
}

#[tauri::command]
pub(crate) async fn plugin_task_plan(
    state: tauri::State<'_, crate::AppState>,
    plugin_id: String,
    request: PlanRequest,
) -> Result<PlanResult, String> {
    require_tasks_grant(&plugin_id)?;
    validate_request(&request)?;
    for project in &request.projects {
        validate_workspace(&state.db, &project.workspace_path)?;
    }
    let request = Arc::new(request);
    let task_request = Arc::clone(&request);
    let task = tokio::spawn(async move {
        let request = task_request;
        let ids: Vec<String> = request.projects.iter().map(|p| p.id.clone()).collect();
        let schema = plan_schema(&ids);
        let input = plan_input(&request);
        let planner = &request.planner;
        let call = side_call::StructuredCall {
            system_prompt: SYSTEM_PROMPT,
            input: &input,
            json_schema: &schema,
            model: &planner.model,
            provider_id: planner.provider_id.as_deref(),
            effort: planner.effort.as_deref().unwrap_or("medium"),
            timeout: PLAN_TIMEOUT,
        };
        side_call::structured(&planner.engine, call).await
    });
    let key = (plugin_id.clone(), request.request_id.clone());
    {
        let mut running = RUNNING.lock();
        if running.contains_key(&key) {
            task.abort();
            return Err(err("invalid_request", "a plan with this requestId is already running"));
        }
        if running.keys().filter(|(owner, _)| owner == &plugin_id).count() >= MAX_CONCURRENT_PLANS {
            task.abort();
            return Err(err("planner_unavailable", "too many plans are already running for this plugin"));
        }
        running.insert(key.clone(), task.abort_handle());
    }
    let _guard = RunningGuard(key.0, key.1);
    let output = match task.await {
        Ok(result) => result.map_err(side_call_error)?,
        Err(join) if join.is_cancelled() => return Err(err("cancelled", "the plan was cancelled")),
        Err(_) => return Err(err("failed", "the planner task stopped unexpectedly")),
    };
    let planner = PlannerUsed {
        engine: request.planner.engine.clone(),
        model: (!request.planner.model.is_empty()).then(|| request.planner.model.clone()),
    };
    validate_plan(&request, &output.structured, planner, now_ms())
}

#[tauri::command]
pub(crate) fn plugin_task_plan_cancel(plugin_id: String, request_id: String) -> Result<bool, String> {
    require_tasks_grant(&plugin_id)?;
    let handle = RUNNING.lock().remove(&(plugin_id, request_id));
    Ok(handle.map(|h| h.abort()).is_some())
}

/// Read only lock metadata, including owners which are now disabled or removed.
/// Their unfinished runs cannot disappear from scheduling merely because their
/// plugin bundle was not loaded in this renderer. No prompts or output escape.
fn pending_claims(db: &crate::db::Db) -> Result<Vec<Value>, String> {
    let rows: Vec<(String, String)> = {
        let conn = db.0.lock();
        let mut stmt = conn.prepare("SELECT plugin_id,value FROM plugin_kv WHERE key = ?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map(["__host_tasks_v1:index"], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        rows
    };
    let mut claims = Vec::new();
    for (owner, body) in rows {
        let invalid = || err("invalid_task_ledger", format!("Cannot restore task write claims for {owner}"));
        let ledger: Value = serde_json::from_str(&body).map_err(|_| invalid())?;
        if ledger.get("version").and_then(Value::as_u64) != Some(1) { return Err(invalid()); }
        let entries = ledger.get("entries").and_then(Value::as_array).ok_or_else(invalid)?;
        if entries.len() > 512 { return Err(invalid()); }
        for entry in entries {
            let receipt = entry.get("receipt").ok_or_else(invalid)?;
            let status = receipt.get("status").and_then(Value::as_str).ok_or_else(invalid)?;
            let conversation_holding = match entry.get("conversationHolding") {
                None => false,
                Some(Value::Bool(holding)) => *holding,
                _ => return Err(invalid()),
            };
            if !matches!(status, "queued" | "starting" | "executing" | "awaiting_permission" | "unknown" | "completed" | "failed" | "cancelled") { return Err(invalid()); }
            if !conversation_holding && matches!(status, "queued" | "completed" | "failed" | "cancelled") { continue; }
            let request_id = receipt.get("requestId").and_then(Value::as_str).filter(|id| valid_request_id(id)).ok_or_else(invalid)?;
            let workspace = receipt.get("workspacePath").and_then(Value::as_str).filter(|path| plain_text(path, 4096)).ok_or_else(invalid)?;
            let writes = entry.get("writePaths").cloned().unwrap_or(Value::Null);
            if !writes.is_null() && !writes.as_array().is_some_and(|paths| paths.len() <= 64 && paths.iter().all(|path| path.as_str().is_some_and(|text| plain_text(text, 1024)))) {
                return Err(invalid());
            }
            claims.push(json!({
                "pluginId": owner, "requestId": request_id, "workspacePath": workspace,
                // The initial run may already have settled while continuation
                // input or managed children still own this coordination scope.
                // Its old terminal proof must not release the restored hold.
                "writePaths": writes, "runId": if conversation_holding { "" } else { receipt.get("runId").and_then(Value::as_str).unwrap_or("") },
                "session": receipt.get("session").cloned().unwrap_or(Value::Null), "status": "unknown",
                "sessionProven": entry.get("sessionProven").and_then(Value::as_bool).unwrap_or(false),
                "identityMismatch": entry.get("identityMismatch").and_then(Value::as_bool).unwrap_or(false),
                "cancelRequested": !conversation_holding && entry.get("cancelRequested").and_then(Value::as_bool).unwrap_or(false)
            }));
        }
    }
    Ok(claims)
}

#[tauri::command]
pub(crate) fn plugin_task_pending_claims(
    state: tauri::State<'_, crate::AppState>, plugin_id: String,
) -> Result<Vec<Value>, String> {
    require_tasks_grant(&plugin_id)?;
    pending_claims(&state.db)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cold_restart_retains_disabled_owner_claims_without_exposing_prompt_or_output() {
        let db = crate::db::Db::open_in_memory().unwrap();
        let ledger = json!({ "version": 1, "entries": [
            { "receipt": { "requestId": "active", "workspacePath": "G:/repo", "status": "executing", "runId": "native-run", "session": null, "text": "private output" }, "prompt": "private prompt", "writePaths": ["src"] },
            { "receipt": { "requestId": "done", "status": "completed" }, "prompt": "private prompt" }
        ] });
        db.0.lock().execute("INSERT INTO plugin_kv(plugin_id,key,value) VALUES(?1,?2,?3)",
            rusqlite::params!["disabled-or-removed-owner", "__host_tasks_v1:index", ledger.to_string()]).unwrap();
        let claims = pending_claims(&db).unwrap();
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0]["pluginId"], "disabled-or-removed-owner");
        assert_eq!(claims[0]["status"], "unknown");
        assert_eq!(claims[0]["writePaths"], json!(["src"]));
        assert!(!serde_json::to_string(&claims).unwrap().contains("private"));
        db.0.lock().execute("UPDATE plugin_kv SET value = ?1", ["{\"version\":2,\"entries\":[]}"]).unwrap();
        assert!(pending_claims(&db).is_err());
    }

    #[test]
    fn cold_restart_keeps_continuous_owner_after_initial_turn_ends() {
        let db = crate::db::Db::open_in_memory().unwrap();
        let ledger = json!({ "version": 1, "entries": [
            { "receipt": { "requestId": "coordinator-root", "workspacePath": "G:/repo", "status": "completed", "runId": "old-finished-run",
                "session": { "engine": "codex", "sessionId": "coordinator-session", "workspacePath": "G:/repo" } },
              "conversationHolding": true, "sessionProven": true, "cancelRequested": true,
              "writePaths": ["src"], "prompt": "private coordinator prompt" },
            { "receipt": { "requestId": "actually-done", "status": "completed" }, "conversationHolding": false }
        ] });
        db.0.lock().execute("INSERT INTO plugin_kv(plugin_id,key,value) VALUES(?1,?2,?3)",
            rusqlite::params!["disabled-owner", "__host_tasks_v1:index", ledger.to_string()]).unwrap();
        let claims = pending_claims(&db).unwrap();
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0]["requestId"], "coordinator-root");
        assert_eq!(claims[0]["status"], "unknown");
        assert_eq!(claims[0]["runId"], "");
        assert_eq!(claims[0]["cancelRequested"], false);
        assert_eq!(claims[0]["session"]["sessionId"], "coordinator-session");
        assert!(!serde_json::to_string(&claims).unwrap().contains("private"));

        let malformed = json!({ "version": 1, "entries": [
            { "receipt": { "requestId": "bad", "status": "completed" }, "conversationHolding": "true" }
        ] });
        db.0.lock().execute("UPDATE plugin_kv SET value = ?1", [malformed.to_string()]).unwrap();
        assert!(pending_claims(&db).is_err());
    }

    fn request(paths: &[(&str, &str)]) -> PlanRequest {
        PlanRequest {
            request_id: "plan-1".into(),
            goal: "fix it".into(),
            projects: paths
                .iter()
                .map(|(id, path)| PlanProject { id: (*id).into(), label: (*id).into(), workspace_path: (*path).into(), description: None })
                .collect(),
            context: None,
            planner: PlannerSelection { engine: "claude".into(), model: "opus".into(), effort: None, provider_id: None },
        }
    }

    fn used() -> PlannerUsed {
        PlannerUsed { engine: "claude".into(), model: Some("opus".into()) }
    }

    fn step(id: &str, project: &str, deps: &[&str], writes: &[&str]) -> Value {
        json!({"id": id, "title": "T", "projectId": project, "instruction": "do", "dependsOn": deps,
            "contextRefs": [], "writePaths": writes})
    }

    #[test]
    fn ready_plan_keeps_candidate_steps_and_normalizes_writes() {
        let req = request(&[("game", "G:/work/game"), ("tool", "G:/work/tool")]);
        let answer = json!({"status": "ready", "question": "", "steps": [
            step("a", "game", &[], &["src\\x.cs", "./src/x.cs", "G:/work/game/tests"]),
            step("b", "tool", &["a"], &[]),
        ]});
        let plan = validate_plan(&req, &answer, used(), 7).unwrap();
        assert_eq!(plan.status, "ready");
        assert_eq!(plan.steps[0].write_paths, vec!["src/x.cs", "tests"]);
        assert_eq!(plan.steps[1].depends_on, vec!["a"]);
        assert!(plan.steps[1].write_paths.is_empty());
    }

    #[test]
    fn rejects_non_candidates_escapes_and_forward_dependencies() {
        let req = request(&[("game", "G:/work/game")]);
        for steps in [
            json!([step("a", "other", &[], &[])]),
            json!([step("a", "game", &[], &["../tool/x"])]),
            json!([step("a", "game", &[], &["G:/work/tool/x"])]),
            json!([step("a", "game", &["b"], &[]), step("b", "game", &[], &[])]),
            json!([step("a", "game", &[], &[]), step("a", "game", &[], &[])]),
            json!([]),
        ] {
            let answer = json!({"status": "ready", "question": "", "steps": steps});
            let error = validate_plan(&req, &answer, used(), 0).unwrap_err();
            assert!(error.starts_with("bad_output:"), "{error}");
        }
    }

    #[test]
    fn clarification_needs_a_question_and_no_steps() {
        let req = request(&[("game", "G:/work/game")]);
        let ok = validate_plan(&req, &json!({"status": "needs_clarification", "question": "Which one?", "steps": []}), used(), 0).unwrap();
        assert_eq!(ok.question.as_deref(), Some("Which one?"));
        assert!(validate_plan(&req, &json!({"status": "needs_clarification", "question": " ", "steps": []}), used(), 0).is_err());
        assert!(validate_plan(&req, &json!({"status": "needs_clarification", "question": "Q", "steps": [step("a", "game", &[], &[])]}), used(), 0).is_err());
    }

    #[test]
    fn request_validation_rejects_bad_shapes_and_unsupported_planners() {
        let mut req = request(&[("game", "G:/work/game")]);
        assert!(validate_request(&req).is_ok());
        req.planner.engine = "agy".into();
        assert!(validate_request(&req).unwrap_err().starts_with("planner_unavailable:"));
        let mut req = request(&[("game", "G:/work/game"), ("game", "G:/work/other")]);
        assert!(validate_request(&req).is_err());
        req.projects.pop();
        req.request_id = "bad id".into();
        assert!(validate_request(&req).is_err());
        let mut req = request(&[("game", "G:/work/game")]);
        req.planner.model = "--dangerous".into();
        assert!(validate_request(&req).is_err());
    }

    #[test]
    fn schema_pins_project_ids() {
        let schema = plan_schema(&["a".into(), "b".into()]);
        assert_eq!(schema["properties"]["steps"]["items"]["properties"]["projectId"]["enum"], json!(["a", "b"]));
    }
}
