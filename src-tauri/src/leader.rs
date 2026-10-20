//! Durable local chat delegation. Transcript cache rows are deliberately not
//! the ownership ledger: history scanning may replace or remove those rows.

use crate::db::Db;
use crate::event_sink::Emit;
use parking_lot::Mutex;
use rmcp::schemars;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::Manager;
use tokio::sync::Notify;

const CHANGED: &str = "task://changed";
const MAX_DIRECT_BRANCHES: usize = 128;
const MAX_RESULT_CHARS: usize = 65_536;
const MAX_INPUT_CHARS: usize = 130_000;
const MAX_TOOL_RESPONSE_BYTES: usize = 768 * 1024;
const IDLE_ADVISORY_MS: i64 = 300_000;
const RETIRE_TIMEOUT: Duration = Duration::from_secs(20);
static MANAGER: OnceLock<Arc<LeaderManager>> = OnceLock::new();
mod archive;
mod branch_delete;
mod cost_approval;
mod model_policy;
pub use cost_approval::TaskCostApproval;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LeaderIdentity {
    pub engine: String,
    pub session_id: String,
    pub workspace_path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaderBranch {
    pub id: String,
    pub parent_engine: String,
    pub parent_session_id: String,
    pub workspace_path: String,
    pub engine: String,
    pub session_id: Option<String>,
    pub title: String,
    pub task: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub run_id: Option<String>,
    pub state: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_activity_at: i64,
    pub deadline_at: i64,
    pub expired: bool,
    pub result: String,
    pub result_truncated: bool,
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_approval: Option<TaskCostApproval>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaderSnapshot {
    pub leaders: Vec<LeaderIdentity>,
    pub branches: Vec<LeaderBranch>,
    pub archived_groups: Vec<LeaderArchivedGroup>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LeaderArchivedGroup {
    pub root: LeaderIdentity,
    pub title: String,
    pub archived_at: i64,
    pub members: Vec<LeaderIdentity>,
    pub branch_ids: Vec<String>,
    #[serde(default)]
    pub deletion_started: bool,
}

/// This identity must come from host_chat's authenticated run, never tool input.
#[derive(Clone, Debug)]
pub struct Caller {
    pub run_id: String,
    pub engine: String,
    pub session_id: String,
    pub workspace_path: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SpawnArgs {
    /// Idempotency key you choose (1-128 characters). Reuse it only to retry this exact call.
    pub request_id: String,
    /// "claude", "codex", "agy" or "cursor".
    pub engine: String,
    /// Short label for the child in the sidebar.
    pub title: String,
    /// Everything the child receives: it cannot see this conversation, so include the goal,
    /// relevant paths and facts, constraints, and what its final reply should report.
    pub task: String,
    /// Optional exact model ID. Omit to use the host's default for this engine.
    pub model: Option<String>,
    /// Reasoning effort such as low, medium, high, xhigh or max. Omit to use the user's default.
    pub effort: Option<String>,
    /// Seconds until the branch is flagged for inspection (60-86400).
    /// Default: Claude Code 3600 (60 minutes), Codex/AGY/Cursor 1800 (30 minutes), by child engine.
    /// Expiry only prompts inspection; it never stops, retries, deletes or compresses the child.
    pub ttl_seconds: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SendArgs {
    pub branch_id: String,
    pub request_id: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct BranchArgs {
    pub branch_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct RenewArgs {
    pub branch_id: String,
    pub ttl_seconds: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct WaitArgs {
    /// Direct children to watch. Omit to watch all unreclaimed direct children.
    pub branch_ids: Option<Vec<String>>,
    /// At most 20 (the default).
    pub timeout_seconds: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListArgs {}

pub fn is_method(method: &str) -> bool {
    matches!(
        method,
        "task_spawn"
            | "task_list"
            | "task_wait"
            | "task_send"
            | "task_renew"
            | "task_stop"
    )
}

fn text_limit(value: &str, name: &str, max: usize) -> Result<(), String> {
    if value.trim().is_empty() || value.chars().count() > max || value.contains('\0') {
        return Err(format!(
            "{name} must contain 1..{max} characters and no NUL"
        ));
    }
    Ok(())
}

fn ttl(value: u64) -> Result<u64, String> {
    if !(60..=86_400).contains(&value) {
        return Err("ttl_seconds must be between 60 and 86400".into());
    }
    Ok(value)
}

fn default_ttl(engine: &str) -> u64 {
    if engine == "claude" { 3600 } else { 1800 }
}

fn supported(engine: &str) -> Result<(), String> {
    if !matches!(engine, "claude" | "codex" | "agy" | "cursor") {
        return Err("Task coordination supports local Claude, Codex, AGY and Cursor chats only".into());
    }
    Ok(())
}

fn decode<T: serde::de::DeserializeOwned>(arguments: Value) -> Result<T, String> {
    serde_json::from_value(arguments).map_err(|e| format!("invalid task arguments: {e}"))
}

fn encoded<T: Serialize>(arguments: &T) -> Result<Value, String> {
    serde_json::to_value(arguments).map_err(|e| e.to_string())
}

fn trim_tool_field(value: &mut Value, field: &str, chars: usize) -> bool {
    let Some(text) = value.get(field).and_then(Value::as_str) else {
        return false;
    };
    if text.chars().count() <= chars {
        return false;
    }
    let preview: String = text.chars().take(chars).collect();
    value[field] = Value::String(preview);
    value[format!("{field}Truncated")] = Value::Bool(true);
    true
}

// Unreclaimed durable/UI records retain their content. These previews stay below the
// relay's 1 MiB envelope, even with 128 children or a large native error.
fn tool_branch(branch: &LeaderBranch, budget: usize) -> Result<Value, String> {
    let mut value = encoded(branch)?;
    trim_tool_field(&mut value, "task", 512);
    while serde_json::to_vec(&value).map_err(|e| e.to_string())?.len() > budget {
        let largest = [
            "result",
            "task",
            "error",
            "workspacePath",
            "title",
            "model",
            "effort",
        ]
        .into_iter()
        .filter_map(|field| {
            value
                .get(field)
                .and_then(Value::as_str)
                .map(|text| (field, text.len(), text.chars().count()))
        })
        .filter(|(_, _, chars)| *chars > 0)
        .max_by_key(|(_, bytes, _)| *bytes);
        let Some((field, _, chars)) = largest else {
            return Err("Leader identity metadata exceeds the tool response budget".into());
        };
        trim_tool_field(&mut value, field, chars / 2);
    }
    Ok(value)
}

pub fn validate_arguments(method: &str, arguments: Value) -> Result<Value, String> {
    match method {
        "task_spawn" => {
            let a: SpawnArgs = decode(arguments)?;
            supported(&a.engine)?;
            text_limit(&a.request_id, "request_id", 128)?;
            text_limit(&a.title, "title", 256)?;
            text_limit(&a.task, "task", MAX_INPUT_CHARS)?;
            for (name, value) in [("model", &a.model), ("effort", &a.effort)] {
                if let Some(value) = value {
                    text_limit(value, name, 256)?;
                }
            }
            ttl(a.ttl_seconds.unwrap_or_else(|| default_ttl(&a.engine)))?;
            encoded(&a)
        }
        "task_send" => {
            let a: SendArgs = decode(arguments)?;
            text_limit(&a.branch_id, "branch_id", 128)?;
            text_limit(&a.request_id, "request_id", 128)?;
            text_limit(&a.message, "message", MAX_INPUT_CHARS)?;
            encoded(&a)
        }
        "task_stop" => {
            let a: BranchArgs = decode(arguments)?;
            text_limit(&a.branch_id, "branch_id", 128)?;
            encoded(&a)
        }
        "task_renew" => {
            let a: RenewArgs = decode(arguments)?;
            text_limit(&a.branch_id, "branch_id", 128)?;
            ttl(a.ttl_seconds)?;
            encoded(&a)
        }
        "task_list" => encoded(&decode::<ListArgs>(arguments)?),
        "task_wait" => {
            let a: WaitArgs = decode(arguments)?;
            if a.timeout_seconds.unwrap_or(20) > 20 {
                return Err("timeout_seconds must be at most 20".into());
            }
            if let Some(ids) = &a.branch_ids {
                if ids.len() > MAX_DIRECT_BRANCHES {
                    return Err("too many branch_ids".into());
                }
                for id in ids {
                    text_limit(id, "branch_id", 128)?;
                }
            }
            encoded(&a)
        }
        _ => Err("Unknown task method".into()),
    }
}

type IdentityKey = (String, String, String);
type RequestKey = (IdentityKey, String);
type Delete = dyn Fn(&Db, &str, &str) -> Result<(), String> + Send + Sync;

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Request {
    parent: LeaderIdentity,
    request_id: String,
    method: String,
    arguments: Value,
    #[serde(default)]
    arguments_fingerprint: Option<String>,
    branch_id: String,
    state: String,
    response: Option<Value>,
    error: Option<String>,
}

// serde_json uses preserve_order in this crate. Object order must not change
// request identity; arrays retain their order and numeric types retain Value's
// equality semantics (including equal positive/negative floating-point zero).
fn arguments_fingerprint(arguments: &Value) -> Result<String, String> {
    fn canonical(value: &Value) -> Value {
        match value {
            Value::Object(fields) => {
                let mut keys: Vec<_> = fields.keys().collect();
                keys.sort();
                Value::Object(
                    keys.into_iter()
                        .map(|key| (key.clone(), canonical(&fields[key])))
                        .collect(),
                )
            }
            Value::Array(values) => Value::Array(values.iter().map(canonical).collect()),
            Value::Number(number) if number.is_f64() && number.as_f64() == Some(0.0) => {
                json!(0.0)
            }
            _ => value.clone(),
        }
    }
    let bytes = serde_json::to_vec(&canonical(arguments))
        .map_err(|_| "Unable to fingerprint Leader request arguments".to_string())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

impl Request {
    fn erase_arguments(&mut self) -> Result<(), String> {
        if self.arguments_fingerprint.is_none() {
            self.arguments_fingerprint = Some(arguments_fingerprint(&self.arguments)?);
        }
        self.arguments = Value::Null;
        Ok(())
    }
}

#[derive(Default, Clone)]
struct Output {
    /// Uncommitted streamed assistant text; a following assistant snapshot
    /// replaces this segment instead of appending the same text twice.
    stream_start: Option<usize>,
    stream_prefix_truncated: bool,
    active_tool: Option<String>,
    tool_calls: u32,
}

enum Reservation<T> {
    Replay(Value),
    Start(T),
}

#[derive(Clone)]
struct BranchRecord {
    branch: LeaderBranch,
    permission: String,
    output: Output,
    questions: HashSet<String>,
    plans: HashSet<String>,
    stopping: bool,
    dirty: bool,
}

fn erase_branch_content(record: &mut BranchRecord) {
    record.branch.title.clear();
    record.branch.task.clear();
    record.branch.model = None;
    record.branch.effort = None;
    record.branch.result.clear();
    record.branch.result_truncated = false;
    record.branch.error = None;
    record.branch.cost_approval = None;
    record.output = Output::default();
    record.questions.clear();
    record.plans.clear();
}

fn reclaimed_response(request_id: &str, branch: Option<&LeaderBranch>) -> Result<Value, String> {
    Ok(
        json!({"requestId":request_id,"requestState":"reclaimed","branch":branch
        .map(|branch| tool_branch(branch, MAX_TOOL_RESPONSE_BYTES - 8192)).transpose()?}),
    )
}

fn erase_reclaimed_request(
    request: &mut Request,
    branch: Option<&LeaderBranch>,
) -> Result<(), String> {
    request.erase_arguments()?;
    request.state = "reclaimed".into();
    request.error = None;
    request.response = Some(reclaimed_response(&request.request_id, branch)?);
    Ok(())
}

#[derive(Clone)]
struct Run {
    engine: String,
    session_id: Option<String>,
    workspace_path: String,
    permission: String,
    branch_id: Option<String>,
    // Launch bookkeeping never grants an isolated agent a task capability.
    leader_eligible: bool,
    // A fresh ordinary chat awaits its attested native identity. This flag is
    // transient launch provenance, never a user mode or persistent role.
    root_on_start: bool,
    // First-bound and resumed parent chats may never change native identity.
    root_identity_bound: bool,
    // Captured before this fresh process can write native history. Keep a
    // scanner's newly indexed own row distinct from already saved identities.
    root_saved_baseline: Option<Arc<HashSet<String>>>,
    // Other admitted/reserved native identities seen while this root awaits
    // its first id. Preserve them through ordinary retired-run pruning.
    root_foreign_claims: Option<HashSet<String>>,
    // Keep a resumed identity fenced even if the engine announces another id.
    isolated_resume_session: Option<String>,
    launch_pending: bool,
    retired: bool,
    last_seq: HashMap<String, u64>,
}

/// Native-only continuation of an already admitted ordinary worker. This is
/// carried by the existing authenticated host-chat checkpoint, never by tool
/// arguments or an independently discovered worker manifest.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WorkerTaskRegistration {
    pub(crate) run_id: String,
    pub(crate) engine: String,
    pub(crate) session_id: Option<String>,
    pub(crate) workspace_path: String,
    permission: String,
    root_on_start: bool,
    root_identity_bound: bool,
    root_saved_baseline: Option<HashSet<String>>,
    root_foreign_claims: Option<HashSet<String>>,
    verified_new_root: bool,
}

impl WorkerTaskRegistration {
    pub(crate) fn matches_origin(&self, run_id: &str, engine: &str, workspace: &str, session: Option<&str>) -> bool {
        self.run_id == run_id && self.engine == engine
            && same_workspace(&self.workspace_path, workspace)
            && self.session_id.as_deref() == session
    }
}

#[derive(Default)]
struct Inner {
    leaders: HashMap<IdentityKey, LeaderIdentity>,
    disabled: HashSet<IdentityKey>,
    branches: HashMap<String, BranchRecord>,
    requests: HashMap<RequestKey, Request>,
    runs: HashMap<String, Run>,
    // Successful native first-root binding is exact-workspace provenance for
    // the history scan gap. It is bounded, memory-only, and never reconstructed
    // from durable role flags on restart; worker checkpoints carry their proof.
    verified_new_roots: HashMap<IdentityKey, i64>,
    // run id -> (engine, native session) validated but not yet committed:
    // the reader still has to claim the registry alias. Every fence sees it.
    pending_bindings: HashMap<String, (String, String)>,
    retiring: HashSet<(String, String)>,
    archived_groups: HashMap<IdentityKey, LeaderArchivedGroup>,
    deleting_groups: HashSet<IdentityKey>,
    shutdown: bool,
}

pub struct LeaderManager {
    db: Arc<Db>,
    processes: Arc<crate::engine::ProcessRegistry>,
    emitter: Arc<dyn Emit>,
    inner: Mutex<Inner>,
    changed: Notify,
    stopped: Notify,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    delete: Arc<Delete>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn identity(engine: &str, session: &str, workspace: &str) -> LeaderIdentity {
    LeaderIdentity {
        engine: engine.into(),
        session_id: session.into(),
        workspace_path: workspace.into(),
    }
}

/// Only Windows drive-absolute paths have interchangeable separators. Keep
/// case, dot components and directory boundaries intact; never resolve aliases.
fn workspace_key(path: &str) -> String {
    let bytes = path.as_bytes();
    if cfg!(windows) && bytes.len() >= 3 && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':' && matches!(bytes[2], b'/' | b'\\')
    {
        let mut out = String::with_capacity(path.len());
        let mut prev_slash = false;
        for ch in path.chars() {
            if matches!(ch, '/' | '\\') {
                if !prev_slash {
                    out.push('/');
                    prev_slash = true;
                }
            } else {
                out.push(ch);
                prev_slash = false;
            }
        }
        out
    } else {
        path.to_owned()
    }
}

fn same_workspace(a: &str, b: &str) -> bool {
    workspace_key(a) == workspace_key(b)
}

fn key(parent: &LeaderIdentity) -> IdentityKey {
    (
        parent.engine.clone(),
        parent.session_id.clone(),
        workspace_key(&parent.workspace_path),
    )
}

fn belongs(branch: &LeaderBranch, parent: &LeaderIdentity) -> bool {
    branch.parent_engine == parent.engine
        && branch.parent_session_id == parent.session_id
        && same_workspace(&branch.workspace_path, &parent.workspace_path)
}

fn refresh_parents(inner: &mut Inner) {
    inner.leaders = inner.branches.values()
        .filter(|record| record.branch.state != "reclaimed")
        .map(|record| {
            let b = &record.branch;
            let parent = identity(&b.parent_engine, &b.parent_session_id, &b.workspace_path);
            (key(&parent), parent)
        }).collect();
    inner.disabled.clear();
}

fn delete_role(conn: &rusqlite::Connection, parent: &LeaderIdentity) -> Result<(), String> {
    let mut stmt = conn.prepare("SELECT workspace_path FROM leader_roles WHERE engine=?1 AND session_id=?2")
        .map_err(|e| e.to_string())?;
    let paths = stmt.query_map(params![parent.engine, parent.session_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    drop(stmt);
    for path in paths.into_iter().filter(|path| same_workspace(path, &parent.workspace_path)) {
        conn.execute("DELETE FROM leader_roles WHERE engine=?1 AND session_id=?2 AND workspace_path=?3",
            params![parent.engine, parent.session_id, path]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
fn role_enabled(conn: &rusqlite::Connection, parent: &LeaderIdentity) -> Result<bool, String> {
    let mut stmt = conn.prepare("SELECT workspace_path,enabled FROM leader_roles WHERE engine=?1 AND session_id=?2")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map(params![parent.engine, parent.session_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?)))
        .map_err(|e| e.to_string())?;
    let mut enabled = false;
    for row in rows {
        let (path, value) = row.map_err(|e| e.to_string())?;
        if same_workspace(&path, &parent.workspace_path) {
            if !value { return Ok(false); }
            enabled = true;
        }
    }
    Ok(enabled)
}

#[cfg(test)]
fn write_role(conn: &mut rusqlite::Connection, parent: &LeaderIdentity, enabled: bool) -> Result<(), String> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    delete_role(&tx, parent)?;
    tx.execute("INSERT INTO leader_roles(engine,session_id,workspace_path,enabled) VALUES(?1,?2,?3,?4)",
        params![parent.engine, parent.session_id, parent.workspace_path, enabled]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// A branch view's readiness for `task_wait`, and what has to change for it
/// to count as news: its run, state or attention flag.
fn wait_mark(view: &Value) -> (bool, Value) {
    let ready = view.get("needsAttention") == Some(&Value::Bool(true))
        || view
            .get("state")
            .and_then(Value::as_str)
            .is_some_and(terminal);
    (
        ready,
        json!([
            view.get("runId"),
            view.get("state"),
            view.get("needsAttention")
        ]),
    )
}

/// Branches that became ready since the wait began, and whether any selected
/// branch is still pending. A child already finished or flagged at the start
/// does not end the wait while a sibling runs, so a parent waiting on several
/// children does not spin on an old result.
fn wait_news(start: &HashMap<String, Value>, views: &[Value]) -> (Vec<String>, bool) {
    let mut news = Vec::new();
    let mut pending = false;
    for view in views {
        let (ready, mark) = wait_mark(view);
        let id = view.get("id").and_then(Value::as_str).unwrap_or_default();
        if !ready {
            pending = true;
        } else if start.get(id) != Some(&mark) {
            news.push(id.to_string());
        }
    }
    (news, pending)
}

fn fenced(state: &str) -> bool {
    matches!(state, "reclaiming" | "reclaimed")
}
fn terminal(state: &str) -> bool {
    matches!(
        state,
        "completed" | "failed" | "stopped" | "unknown" | "reclaimed"
    )
}

pub(crate) fn ensure_schema(db: &Db) -> Result<(), String> {
    db.0.lock().execute_batch(
        "CREATE TABLE IF NOT EXISTS leader_roles (
            engine TEXT NOT NULL, session_id TEXT NOT NULL, workspace_path TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY(engine, session_id, workspace_path));
         CREATE TABLE IF NOT EXISTS leader_branches (
            id TEXT PRIMARY KEY, parent_engine TEXT NOT NULL, parent_session_id TEXT NOT NULL,
            workspace_path TEXT NOT NULL, engine TEXT NOT NULL, session_id TEXT,
            state TEXT NOT NULL, record_json TEXT NOT NULL, permission TEXT NOT NULL);
         CREATE INDEX IF NOT EXISTS leader_branches_parent
            ON leader_branches(parent_engine,parent_session_id,workspace_path);
         CREATE INDEX IF NOT EXISTS leader_branches_session ON leader_branches(engine,session_id);
         CREATE TABLE IF NOT EXISTS leader_requests (
            parent_engine TEXT NOT NULL, parent_session_id TEXT NOT NULL, workspace_path TEXT NOT NULL,
            request_id TEXT NOT NULL, record_json TEXT NOT NULL,
            PRIMARY KEY(parent_engine,parent_session_id,workspace_path,request_id));"
    ).map_err(|e| e.to_string())?;
    let conn = db.0.lock();
    archive::ensure_schema(&conn)?;
    let has_enabled = conn
        .prepare("PRAGMA table_info(leader_roles)")
        .map_err(|e| e.to_string())?
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?
        .iter()
        .any(|name| name == "enabled");
    if !has_enabled {
        conn.execute(
            "ALTER TABLE leader_roles ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1",
            [],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn schema_contract_descriptor() -> Value {
    let identity = LeaderIdentity {
        engine: String::new(),
        session_id: String::new(),
        workspace_path: String::new(),
    };
    let branch = LeaderBranch {
        id: String::new(),
        parent_engine: String::new(),
        parent_session_id: String::new(),
        workspace_path: String::new(),
        engine: String::new(),
        session_id: Some(String::new()),
        title: String::new(),
        task: String::new(),
        model: Some(String::new()),
        effort: Some(String::new()),
        run_id: Some(String::new()),
        state: String::new(),
        created_at: 0,
        updated_at: 0,
        last_activity_at: 0,
        deadline_at: 0,
        expired: false,
        result: String::new(),
        result_truncated: false,
        error: Some(String::new()),
        cost_approval: Some(TaskCostApproval {
            request_id: String::new(),
            captured_at: 0,
            cache: Some(crate::history::prompt_cache::CacheWindow {
                ttl_seconds: 0,
                started_at: 0,
                observed_at: 0,
                source: String::new(),
                reference: Some(crate::history::prompt_cache::CacheReference {
                    max_ttl_seconds: 0,
                    cache_read_tokens: 0,
                    prompt_tokens: 0,
                }),
            }),
            model: Some(String::new()),
        }),
    };
    let request = Request {
        parent: identity.clone(),
        request_id: String::new(),
        method: String::new(),
        arguments: Value::Null,
        arguments_fingerprint: Some(String::new()),
        branch_id: String::new(),
        state: String::new(),
        response: Some(Value::Null),
        error: Some(String::new()),
    };
    let archived_group = LeaderArchivedGroup {
        root: identity.clone(),
        title: String::new(),
        archived_at: 0,
        members: vec![identity],
        branch_ids: vec![String::new()],
        deletion_started: false,
    };
    json!({
        "branchRecord": branch,
        "requestRecord": request,
        "requestStates": [
            "starting",
            "awaiting_cost_approval",
            "acknowledged",
            "failed",
            "cancelled",
            "unknown",
            "reclaimed",
        ],
        "archivedGroupRecord": archived_group,
        "branchStates": [
            "starting",
            "running",
            "waiting",
            "awaiting_cost_approval",
            "completed",
            "failed",
            "stopped",
            "unknown",
            "reclaiming",
            "reclaimed",
        ],
    })
}

#[cfg(feature = "test-harness")]
pub fn initialize_worker_fixture_schema(db:&Db) -> Result<(),String> { ensure_schema(db) }

fn write_branch(conn: &rusqlite::Connection, record: &BranchRecord) -> Result<(), String> {
    let b = &record.branch;
    let serialized = serde_json::to_string(b).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO leader_branches(id,parent_engine,parent_session_id,workspace_path,engine,session_id,state,record_json,permission)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(id) DO UPDATE SET
         session_id=excluded.session_id,state=excluded.state,record_json=excluded.record_json,permission=excluded.permission",
        params![b.id,b.parent_engine,b.parent_session_id,b.workspace_path,b.engine,b.session_id,b.state,serialized,record.permission]
    ).map_err(|e| e.to_string())?;
    Ok(())
}

fn write_request(conn: &rusqlite::Connection, request: &Request) -> Result<(), String> {
    conn.execute(
        "INSERT INTO leader_requests(parent_engine,parent_session_id,workspace_path,request_id,record_json)
         VALUES(?1,?2,?3,?4,?5) ON CONFLICT(parent_engine,parent_session_id,workspace_path,request_id)
         DO UPDATE SET record_json=excluded.record_json",
        params![request.parent.engine,request.parent.session_id,request.parent.workspace_path,
            request.request_id,serde_json::to_string(request).map_err(|e| e.to_string())?]
    ).map_err(|e| e.to_string())?;
    Ok(())
}

impl LeaderManager {
    fn new(
        db: Arc<Db>,
        processes: Arc<crate::engine::ProcessRegistry>,
        emitter: Arc<dyn Emit>,
    ) -> Result<Self, String> {
        Self::with_services(
            db,
            processes,
            emitter,
            Arc::new(now_ms),
            Arc::new(crate::history::reader::delete_leader_session_blocking),
        )
    }

    fn with_services(
        db: Arc<Db>,
        processes: Arc<crate::engine::ProcessRegistry>,
        emitter: Arc<dyn Emit>,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
        delete: Arc<Delete>,
    ) -> Result<Self, String> {
        ensure_schema(&db)?;
        let mut inner = Inner::default();
        {
            let mut conn = db.0.lock();
            // Old mode rows are deliberately not loaded. Actual branches and
            // archived membership are the only persistent ownership evidence.
            let mut stmt = conn
                .prepare("SELECT record_json,permission FROM leader_branches")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            drop(stmt);
            for (raw, permission) in rows {
                let mut b: LeaderBranch = serde_json::from_str(&raw)
                    .map_err(|e| format!("invalid Leader branch record: {e}"))?;
                let uncertain = matches!(
                    b.state.as_str(),
                    "starting" | "running" | "waiting" | "reclaiming"
                );
                if uncertain {
                    b.state = "unknown".into();
                    b.error = Some("Application restarted; the previous run's outcome is unknown. Inspect before sending again.".into());
                    b.updated_at = clock();
                }
                b.expired = clock() >= b.deadline_at;
                if let Some(run_id) = &b.run_id {
                    inner.runs.insert(
                        run_id.clone(),
                        Run {
                            engine: b.engine.clone(),
                            session_id: b.session_id.clone(),
                            workspace_path: b.workspace_path.clone(),
                            permission: permission.clone(),
                            branch_id: Some(b.id.clone()),
                            leader_eligible: true,
                            root_on_start: false,
                            root_identity_bound: false,
                            root_saved_baseline: None,
                            root_foreign_claims: None,
                            isolated_resume_session: None,
                            launch_pending: false,
                            retired: true,
                            last_seq: HashMap::new(),
                        },
                    );
                }
                let mut record = BranchRecord {
                    branch: b,
                    permission,
                    output: Output::default(),
                    questions: HashSet::new(),
                    plans: HashSet::new(),
                    stopping: false,
                    dirty: uncertain,
                };
                if record.branch.state == "reclaimed" {
                    record.dirty |= !record.branch.title.is_empty()
                        || !record.branch.task.is_empty()
                        || record.branch.model.is_some()
                        || record.branch.effort.is_some()
                        || !record.branch.result.is_empty()
                        || record.branch.result_truncated
                        || record.branch.error.is_some();
                    erase_branch_content(&mut record);
                }
                inner.branches.insert(record.branch.id.clone(), record);
            }
            let mut stmt = conn
                .prepare("SELECT record_json FROM leader_requests")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            drop(stmt);
            let mut migrated_requests = Vec::new();
            for raw in rows {
                let mut request: Request = serde_json::from_str(&raw)
                    .map_err(|e| format!("invalid Leader request record: {e}"))?;
                let mut changed =
                    request.arguments_fingerprint.is_none() || !request.arguments.is_null();
                // Migrate only durable receipts. Old public method names are
                // rejected; keeping this key and fingerprint prevents replay.
                let method = match request.method.as_str() {
                    "leader_spawn" => Some("task_spawn"),
                    "leader_send" => Some("task_send"),
                    _ => None,
                };
                if let Some(method) = method {
                    request.method = method.into();
                    changed = true;
                }
                request.erase_arguments()?;
                if request.state == "starting" {
                    request.state = "unknown".into();
                    request.error = Some("Application restarted before launch acknowledgement; this request will never be replayed.".into());
                    changed = true;
                }
                let reclaimed_branch = inner
                    .branches
                    .get(&request.branch_id)
                    .filter(|record| record.branch.state == "reclaimed")
                    .map(|record| &record.branch);
                if reclaimed_branch.is_some() || request.state == "reclaimed" {
                    erase_reclaimed_request(&mut request, reclaimed_branch)?;
                    changed = true;
                }
                if changed {
                    migrated_requests.push(request.clone());
                }
                inner
                    .requests
                    .insert((key(&request.parent), request.request_id.clone()), request);
            }
            // Publish no manager until every legacy argument and reclaimed
            // record has been scrubbed durably. A storage failure rolls the
            // whole migration back and is returned to the caller.
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            archive::load_groups(&tx, &mut inner)?;
            for request in &migrated_requests {
                write_request(&tx, request)?;
            }
            for record in inner.branches.values().filter(|r| r.dirty) {
                write_branch(&tx, record)?;
            }
            tx.commit().map_err(|e| e.to_string())?;
            for record in inner.branches.values_mut() {
                record.dirty = false;
            }
            refresh_parents(&mut inner);
        }
        Ok(Self {
            db,
            processes,
            emitter,
            inner: Mutex::new(inner),
            changed: Notify::new(),
            stopped: Notify::new(),
            clock,
            delete,
        })
    }

    fn emit(&self) {
        self.changed.notify_waiters();
        self.emitter.emit_json(CHANGED, "null");
    }

    fn save(&self, record: &mut BranchRecord) -> Result<(), String> {
        write_branch(&self.db.0.lock(), record)?;
        record.dirty = false;
        Ok(())
    }

    fn checkpoint(&self) -> Result<(), String> {
        let now = (self.clock)();
        let mut changed = false;
        {
            let mut inner = self.inner.lock();
            let conn = self.db.0.lock();
            prune_verified_roots(&mut inner, &conn)?;
            for record in inner.branches.values_mut() {
                let expired = now >= record.branch.deadline_at;
                if expired != record.branch.expired {
                    record.branch.expired = expired;
                    record.branch.updated_at = now;
                    record.dirty = true;
                    changed = true;
                }
                if record.dirty {
                    write_branch(&conn, record)?;
                    record.dirty = false;
                    changed = true;
                }
            }
        }
        if changed {
            self.emit();
        }
        Ok(())
    }

    fn snapshot(&self) -> Result<LeaderSnapshot, String> {
        self.checkpoint()?;
        Ok(self.snapshot_memory())
    }

    fn snapshot_memory(&self) -> LeaderSnapshot {
        let mut inner = self.inner.lock();
        refresh_parents(&mut inner);
        let mut leaders: Vec<_> = inner.leaders.values().cloned().collect();
        leaders.sort_by(|a, b| key(a).cmp(&key(b)));
        let mut branches: Vec<_> = inner
            .branches
            .values()
            .filter(|r| r.branch.state != "reclaimed")
            .map(|r| r.branch.clone())
            .collect();
        branches.sort_by(|a, b| (a.created_at, &a.id).cmp(&(b.created_at, &b.id)));
        let mut archived_groups: Vec<_> = inner.archived_groups.values().cloned().collect();
        archived_groups.sort_by(|a, b| {
            b.archived_at
                .cmp(&a.archived_at)
                .then_with(|| key(&a.root).cmp(&key(&b.root)))
        });
        LeaderSnapshot {
            leaders,
            branches,
            archived_groups,
        }
    }

    fn active(&self, inner: &Inner, branch: &LeaderBranch) -> bool {
        branch
            .run_id
            .as_deref()
            .map(|run_id| {
                inner
                    .runs
                    .get(run_id)
                    .map(|r| r.launch_pending && !r.retired)
                    .unwrap_or(false)
                    || self.processes.get(run_id).is_some()
            })
            .unwrap_or(false)
    }

    fn authorize(
        &self,
        inner: &Inner,
        caller: &Caller,
    ) -> Result<(LeaderIdentity, String), String> {
        if inner.shutdown {
            return Err("Leader coordinator is shutting down".into());
        }
        archive::ensure_available(inner, &caller.engine, &caller.session_id, None)?;
        if inner
            .retiring
            .contains(&(caller.engine.clone(), caller.session_id.clone()))
        {
            return Err("Parent chat is being archived or deleted".into());
        }
        let run = inner
            .runs
            .get(&caller.run_id)
            .ok_or("Caller has no trusted local run")?;
        if run.retired
            || !run.leader_eligible
            || run.engine != caller.engine
            || run.session_id.as_deref() != Some(&caller.session_id)
            || !same_workspace(&run.workspace_path, &caller.workspace_path)
            || self.processes.get(&caller.run_id).is_none_or(|entry| {
                entry.killed.load(std::sync::atomic::Ordering::SeqCst)
            })
        {
            return Err("Caller does not match an active trusted local chat".into());
        }
        let parent = identity(&caller.engine, &caller.session_id, &caller.workspace_path);
        if let Some(id) = &run.branch_id {
            let record = inner.branches.get(id).ok_or("Caller branch is missing")?;
            if fenced(&record.branch.state)
                || matches!(
                    record.branch.state.as_str(),
                    "failed" | "unknown" | "stopped"
                )
                || record.stopping
                || record.branch.engine != caller.engine
                || record.branch.session_id.as_deref() != Some(&caller.session_id)
                || !same_workspace(&record.branch.workspace_path, &caller.workspace_path)
            {
                return Err("Caller does not match an available managed branch identity".into());
            }
        }
        Ok((parent, run.permission.clone()))
    }

    fn child<'a>(
        &self,
        inner: &'a Inner,
        parent: &LeaderIdentity,
        id: &str,
    ) -> Result<&'a BranchRecord, String> {
        archive::ensure_available(inner, &parent.engine, &parent.session_id, Some(id))?;
        let record = inner.branches.get(id).ok_or("Unknown child branch")?;
        if !belongs(&record.branch, parent) {
            return Err("Only the direct parent may operate this branch".into());
        }
        if record.branch.state == "reclaimed" {
            return Err("This branch has already been reclaimed".into());
        }
        Ok(record)
    }

    fn replay(
        &self,
        inner: &Inner,
        parent: &LeaderIdentity,
        request_id: &str,
        method: &str,
        arguments: &Value,
    ) -> Result<Option<Value>, String> {
        let Some(request) = inner.requests.get(&(key(parent), request_id.into())) else {
            return Ok(None);
        };
        if request.method != method
            || request.arguments_fingerprint.as_deref()
                != Some(arguments_fingerprint(arguments)?.as_str())
        {
            return Err(
                "request_id was already used with different arguments or a different method".into(),
            );
        }
        if request.state == "reclaimed" {
            return reclaimed_response(
                request_id,
                inner
                    .branches
                    .get(&request.branch_id)
                    .filter(|record| record.branch.state == "reclaimed")
                    .map(|record| &record.branch),
            )
            .map(Some);
        }
        if let Some(response) = &request.response {
            let mut response = response.clone();
            if let Some(record) = inner.branches.get(&request.branch_id) {
                response["branch"] = tool_branch(&record.branch, MAX_TOOL_RESPONSE_BYTES - 8192)?;
            }
            return Ok(Some(response));
        }
        if request.state == "failed" {
            return Err(request
                .error
                .clone()
                .unwrap_or_else(|| "The recorded launch failed".into()));
        }
        let branch = inner
            .branches
            .get(&request.branch_id)
            .map(|r| tool_branch(&r.branch, MAX_TOOL_RESPONSE_BYTES - 8192))
            .transpose()?;
        Ok(Some(
            json!({"requestId":request_id,"requestState":request.state,"branch":branch,
            "error":request.error,"mayHaveStarted":true,"replayed":false}),
        ))
    }

    fn reserve_spawn(
        &self,
        caller: &Caller,
        parent: &LeaderIdentity,
        permission: &str,
        args: &SpawnArgs,
        arguments: Value,
        model: Option<String>,
        effort: Option<String>,
    ) -> Result<Reservation<(String, String)>, String> {
        let mut inner = self.inner.lock();
        self.authorize(&inner, caller)?;
        if let Some(response) =
            self.replay(&inner, parent, &args.request_id, "task_spawn", &arguments)?
        {
            return Ok(Reservation::Replay(response));
        }
        if inner
            .branches
            .values()
            .filter(|r| belongs(&r.branch, parent) && r.branch.state != "reclaimed")
            .count()
            >= MAX_DIRECT_BRANCHES
        {
            return Err(format!("This parent has {MAX_DIRECT_BRANCHES} retained branches; reuse existing direct children or ask the user to start a new task group. Completed branches are retained"));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let run_id = uuid::Uuid::new_v4().to_string();
        let now = (self.clock)();
        let branch = LeaderBranch {
            id: id.clone(),
            parent_engine: parent.engine.clone(),
            parent_session_id: parent.session_id.clone(),
            workspace_path: parent.workspace_path.clone(),
            engine: args.engine.clone(),
            session_id: None,
            title: args.title.clone(),
            task: args.task.clone(),
            model,
            effort,
            run_id: Some(run_id.clone()),
            state: "starting".into(),
            created_at: now,
            updated_at: now,
            last_activity_at: now,
            deadline_at: now + args.ttl_seconds.unwrap_or_else(|| default_ttl(&args.engine)) as i64 * 1000,
            expired: false,
            result: String::new(),
            result_truncated: false,
            error: None,
            cost_approval: None,
        };
        let record = BranchRecord {
            branch,
            permission: permission.into(),
            output: Output::default(),
            questions: HashSet::new(),
            plans: HashSet::new(),
            stopping: false,
            dirty: false,
        };
        let request = Request {
            parent: parent.clone(),
            request_id: args.request_id.clone(),
            method: "task_spawn".into(),
            arguments_fingerprint: Some(arguments_fingerprint(&arguments)?),
            arguments: Value::Null,
            branch_id: id.clone(),
            state: "starting".into(),
            response: None,
            error: None,
        };
        let mut conn = self.db.0.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        write_branch(&tx, &record)?;
        write_request(&tx, &request)?;
        tx.commit().map_err(|e| e.to_string())?;
        inner.runs.insert(
            run_id.clone(),
            Run {
                engine: args.engine.clone(),
                session_id: None,
                workspace_path: parent.workspace_path.clone(),
                permission: permission.into(),
                branch_id: Some(id.clone()),
                leader_eligible: true,
                root_on_start: false,
                root_identity_bound: false,
                root_saved_baseline: None,
                root_foreign_claims: None,
                isolated_resume_session: None,
                launch_pending: true,
                retired: false,
                last_seq: HashMap::new(),
            },
        );
        inner.branches.insert(id.clone(), record);
        refresh_parents(&mut inner);
        inner
            .requests
            .insert((key(parent), args.request_id.clone()), request);
        Ok(Reservation::Start((id, run_id)))
    }

    fn reserve_send(
        &self,
        caller: &Caller,
        parent: &LeaderIdentity,
        permission: &str,
        args: &SendArgs,
        arguments: Value,
    ) -> Result<Reservation<(LeaderBranch, String)>, String> {
        let mut inner = self.inner.lock();
        self.authorize(&inner, caller)?;
        if let Some(response) =
            self.replay(&inner, parent, &args.request_id, "task_send", &arguments)?
        {
            return Ok(Reservation::Replay(response));
        }
        let previous = self.child(&inner, parent, &args.branch_id)?;
        if fenced(&previous.branch.state)
            || previous.stopping
            || self.active(&inner, &previous.branch)
            || previous.branch.cost_approval.is_some()
            || previous.branch.state == "awaiting_cost_approval"
        {
            return Err(
                "Child is still running or being reclaimed; wait or stop it before sending".into(),
            );
        }
        if previous.branch.session_id.is_none() {
            return Err(
                "Child has no native session identity; inspect it in task management".into(),
            );
        }
        let cache = self.send_cache(&previous.branch)?;
        if cost_approval::requires_approval(cache.as_ref(), (self.clock)()) {
            let response = self.hold_send(&mut inner, parent, permission, args, &arguments, cache)?;
            drop(inner);
            self.emit();
            return Ok(Reservation::Replay(response));
        }
        self.start_send(&mut inner, parent, permission, args, arguments)
    }

    fn start_send(
        &self,
        inner: &mut Inner,
        parent: &LeaderIdentity,
        permission: &str,
        args: &SendArgs,
        arguments: Value,
    ) -> Result<Reservation<(LeaderBranch, String)>, String> {
        let previous = self.child(inner, parent, &args.branch_id)?;
        let run_id = uuid::Uuid::new_v4().to_string();
        let mut record = BranchRecord {
            branch: previous.branch.clone(),
            permission: permission.into(),
            output: Output::default(),
            questions: HashSet::new(),
            plans: HashSet::new(),
            stopping: false,
            dirty: false,
        };
        record.branch.run_id = Some(run_id.clone());
        record.branch.cost_approval = None;
        record.branch.task = args.message.clone();
        record.branch.state = "starting".into();
        record.branch.updated_at = (self.clock)();
        record.branch.last_activity_at = record.branch.updated_at;
        record.branch.result.clear();
        record.branch.result_truncated = false;
        record.branch.error = None;
        let request = Request {
            parent: parent.clone(),
            request_id: args.request_id.clone(),
            method: "task_send".into(),
            arguments_fingerprint: Some(arguments_fingerprint(&arguments)?),
            arguments: Value::Null,
            branch_id: args.branch_id.clone(),
            state: "starting".into(),
            response: None,
            error: None,
        };
        let mut conn = self.db.0.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        write_branch(&tx, &record)?;
        write_request(&tx, &request)?;
        tx.commit().map_err(|e| e.to_string())?;
        let branch = record.branch.clone();
        inner.runs.insert(
            run_id.clone(),
            Run {
                engine: branch.engine.clone(),
                session_id: branch.session_id.clone(),
                workspace_path: branch.workspace_path.clone(),
                permission: permission.into(),
                branch_id: Some(branch.id.clone()),
                leader_eligible: true,
                root_on_start: false,
                root_identity_bound: false,
                root_saved_baseline: None,
                root_foreign_claims: None,
                isolated_resume_session: None,
                launch_pending: true,
                retired: false,
                last_seq: HashMap::new(),
            },
        );
        if let Some(session) = branch.session_id.as_deref() {
            record_pending_root_foreign_claim(inner, &run_id, &branch.engine, session);
        }
        inner.branches.insert(branch.id.clone(), record);
        inner
            .requests
            .insert((key(parent), args.request_id.clone()), request);
        Ok(Reservation::Start((branch, run_id)))
    }

    fn acknowledge(
        &self,
        parent: &LeaderIdentity,
        request_id: &str,
        run_id: &str,
        result: Result<crate::engine::SendResult, String>,
    ) -> Result<Value, String> {
        let mut inner = self.inner.lock();
        let request_key = (key(parent), request_id.into());
        let mut request = inner
            .requests
            .get(&request_key)
            .cloned()
            .ok_or("Launch request is missing")?;
        let branch = &inner
            .branches
            .get(&request.branch_id)
            .ok_or("Launch branch is missing")?
            .branch;
        // Reclamation is authoritative even if launch acknowledgement arrives
        // after process retirement/deletion. Never cache its result or error.
        if branch.state == "reclaimed" || request.state == "reclaimed" {
            let response =
                reclaimed_response(request_id, (branch.state == "reclaimed").then_some(branch))?;
            if let Some(run) = inner.runs.get_mut(run_id) {
                run.launch_pending = false;
            }
            return Ok(response);
        }
        let result = match result {
            Ok(sent) => {
                if let Some(session) = &sent.session_id {
                    let already_bound = inner
                        .runs
                        .get(run_id)
                        .and_then(|run| run.branch_id.as_ref())
                        .and_then(|id| inner.branches.get(id))
                        .is_some_and(|record| record.branch.session_id.as_deref() == Some(session));
                    if already_bound {
                        Ok(sent)
                    } else {
                        self.check_binding(
                            &inner,
                            run_id,
                            &inner
                                .runs
                                .get(run_id)
                                .map(|run| run.engine.clone())
                                .unwrap_or_default(),
                            session,
                        )
                        .map(|_| sent)
                    }
                } else {
                    Ok(sent)
                }
            }
            Err(error) => Err(error),
        };
        if let Some(run) = inner.runs.get_mut(run_id) {
            run.launch_pending = false;
        }
        let record = inner
            .branches
            .get_mut(&request.branch_id)
            .ok_or("Launch branch is missing")?;
        match result {
            Ok(sent) => {
                let sent_session = sent.session_id.clone();
                if record.branch.run_id.as_deref() == Some(run_id) && !fenced(&record.branch.state)
                {
                    if record.branch.session_id.is_none() {
                        record.branch.session_id = sent.session_id;
                    }
                    if record.branch.state == "starting" {
                        record.branch.state = "running".into();
                    }
                }
                request.state = "acknowledged".into();
                request.response = Some(
                    json!({"requestId":request_id,"requestState":"acknowledged","branch":tool_branch(&record.branch,MAX_TOOL_RESPONSE_BYTES-8192)?}),
                );
                let response = request.response.clone().unwrap_or(Value::Null);
                let mut conn = self.db.0.lock();
                let tx = conn.transaction().map_err(|e| e.to_string())?;
                write_branch(&tx, record)?;
                write_request(&tx, &request)?;
                tx.commit().map_err(|e| e.to_string())?;
                record.dirty = false;
                inner.requests.insert(request_key, request);
                if let Some(run) = inner.runs.get_mut(run_id) {
                    if run.session_id.is_none() {
                        run.session_id = sent_session;
                    }
                }
                drop(inner);
                self.emit();
                Ok(response)
            }
            Err(error) => {
                if record.branch.run_id.as_deref() == Some(run_id)
                    && !fenced(&record.branch.state)
                    && !matches!(
                        record.branch.state.as_str(),
                        "completed" | "waiting" | "stopped"
                    )
                {
                    record.branch.state = "failed".into();
                    record.branch.error = Some(error.clone());
                    record.branch.updated_at = (self.clock)();
                }
                request.state = "failed".into();
                request.error = Some(error.clone());
                let mut conn = self.db.0.lock();
                let tx = conn.transaction().map_err(|e| e.to_string())?;
                write_branch(&tx, record)?;
                write_request(&tx, &request)?;
                tx.commit().map_err(|e| e.to_string())?;
                record.dirty = false;
                inner.requests.insert(request_key, request);
                if let Some(run) = inner.runs.get_mut(run_id) {
                    run.retired = self.processes.get(run_id).is_none();
                }
                drop(inner);
                self.emit();
                Err(error)
            }
        }
    }
}

pub fn init(app: &tauri::AppHandle) -> Result<(), String> {
    if MANAGER.get().is_some() {
        return Ok(());
    }
    let state = app.state::<crate::AppState>();
    let manager = Arc::new(LeaderManager::new(
        Arc::clone(&state.db),
        Arc::clone(&state.processes),
        state.emitters.clone(),
    )?);
    MANAGER
        .set(Arc::clone(&manager))
        .map_err(|_| "Leader coordinator already initialized".to_string())?;
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            tokio::select! {
                _ = manager.stopped.notified() => break,
                _ = interval.tick() => {
                    if manager.inner.lock().shutdown { break; }
                    // A failed write leaves dirty memory for the next checkpoint;
                    // snapshot/mutations surface persistence errors to callers.
                    let _ = manager.checkpoint();
                }
            }
        }
    });
    Ok(())
}

/// Install a real coordinator over hermetic fixture state. Reclamation reports
/// transcript deletion to `delete` instead of touching history files. The
/// coordinator is process-global: run each caller in its own `--exact` child.
#[cfg(feature = "test-harness")]
#[doc(hidden)]
pub fn install_test_coordinator(
    state: &crate::AppState,
    delete: Arc<dyn Fn(&str, &str) -> Result<(), String> + Send + Sync>,
) -> Result<(), String> {
    let manager = LeaderManager::with_services(
        Arc::clone(&state.db),
        Arc::clone(&state.processes),
        state.emitters.clone(),
        Arc::new(now_ms),
        Arc::new(move |_: &Db, engine: &str, session: &str| delete(engine, session)),
    )?;
    MANAGER
        .set(Arc::new(manager))
        .map_err(|_| "Leader coordinator already initialized".to_string())
}

/// Ledger view for hermetic fixtures: whether the run id is retired.
#[cfg(feature = "test-harness")]
#[doc(hidden)]
pub fn test_run_retired(run_id: &str) -> Option<bool> {
    MANAGER
        .get()?
        .inner
        .lock()
        .runs
        .get(run_id)
        .map(|run| run.retired)
}

/// Exercise a user group action over hermetic coordinator state without a
/// native window. This entry is absent from production builds and MCP tools.
#[cfg(feature = "test-harness")]
#[doc(hidden)]
pub async fn test_group_action(
    state: &crate::AppState,
    root: LeaderIdentity,
    action: &str,
) -> Result<LeaderSnapshot, String> {
    archive::group_action(
        &state.db,
        root.engine,
        root.session_id,
        root.workspace_path,
        action.into(),
    )
    .await
}

fn manager() -> Result<&'static Arc<LeaderManager>, String> {
    MANAGER
        .get()
        .ok_or_else(|| "Leader coordinator is unavailable".into())
}

pub fn shutdown() {
    if let Some(manager) = MANAGER.get() {
        manager.inner.lock().shutdown = true;
        let _ = manager.checkpoint();
        manager.stopped.notify_waiters();
        manager.changed.notify_waiters();
    }
}

fn validate_workspace(db: &Db, workspace: &str) -> Result<(), String> {
    let conn = db.0.lock();
    let mut stmt = conn.prepare("SELECT id,path,meta FROM workspaces").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?)))
        .map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    drop(stmt);
    let matches: Vec<_> = rows.into_iter().filter(|(_, path, _)| same_workspace(path, workspace)).collect();
    if matches.is_empty() { return Err("Workspace is not a registered local workspace".into()); }
    let archived = crate::settings::read_settings()?.archived_workspaces;
    for (id, _, meta) in matches {
        if archived.contains(&id) { return Err("Workspace is archived".into()); }
        if let Some(raw) = meta {
            let meta: Value =
                serde_json::from_str(&raw).map_err(|_| "Workspace metadata is invalid")?;
            if meta.get("wsl").is_some() {
                return Err("Child tasks do not support WSL or remote workspaces".into());
            }
        }
    }
    drop(conn);
    if !std::path::Path::new(workspace).is_dir() {
        return Err("Local workspace directory is unavailable".into());
    }
    Ok(())
}

pub(crate) fn validate_first_root_workspace(
    db: &Db, engine: &str, workspace: &str,
) -> Result<(), String> {
    supported(engine)?;
    validate_workspace(db, workspace)
}

fn validate_parent(db: &Db, parent: &LeaderIdentity, managed: bool) -> Result<(), String> {
    supported(&parent.engine)?;
    text_limit(&parent.session_id, "session_id", 256)?;
    validate_workspace(db, &parent.workspace_path)?;
    let conn = db.0.lock();
    let archived: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM session_archives WHERE engine=?1 AND session_id=?2)",
            params![parent.engine, parent.session_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if archived {
        return Err("Parent chat is archived".into());
    }
    let workspace: Option<String> = conn
        .query_row(
            "SELECT workspace_path FROM sessions WHERE engine=?1 AND session_id=?2",
            params![parent.engine, parent.session_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match workspace {
        Some(path) if same_workspace(&path, &parent.workspace_path) => Ok(()),
        None if managed => Ok(()), // Managed child or verified new root before history scan.
        _ => Err("Parent chat is not a saved chat in this exact workspace".into()),
    }
}

fn require_main(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Task controls are available only in the main local window".into());
    }
    Ok(())
}

fn role(child: bool) -> String {
    let description = if child {
        "Work within the assigned managed task. Return a self-contained report of results, verification and uncertainty to your parent. Questions and approvals wait for the human in this chat."
    } else {
        "Collaboration is available for this task without a separate mode. You retain responsibility for decisions, integration and acceptance. Delegate within the user's task when useful and verify deliverables before reporting completion."
    };
    format!("{description} Each child sees only its task and shares workspace files: specify scope and coordinate edits. Operate only direct children you created. Existing chats contacted with send_message remain independent. Use task_wait when results are needed. TTL expiry prompts inspection, not termination. Completion preserves conversations.")
}

pub(crate) fn unscoped_task_instructions() -> String { role(false) }

pub(crate) fn owned_task_instructions() -> String {
    format!("This chat owns managed child tasks and must retain its CC GUI task controls.\n\n{}", role(false))
}

pub(crate) fn run_owns_tasks(run_id: &str) -> bool {
    MANAGER.get().is_some_and(|manager| {
        let inner = manager.inner.lock();
        let Some(run) = inner.runs.get(run_id).filter(|run| !run.retired && run.leader_eligible) else { return false; };
        run.session_id.as_deref().is_some_and(|session| {
            let parent = identity(&run.engine, session, &run.workspace_path);
            inner.branches.values().any(|record| record.branch.state != "reclaimed" && belongs(&record.branch, &parent))
        })
    })
}

/// Detached workers cannot initialize/migrate the coordinator or quietly resume
/// a managed chat without its Leader integration. All checks here are read-only.
pub(crate) fn validate_worker_session(
    db: &Db,
    engine: &str,
    session_id: Option<&str>,
) -> Result<(), String> {
    if !matches!(engine, "claude" | "codex" | "agy" | "cursor") { return Ok(()); }
    let conn = db.0.lock();
    for sql in [
        "SELECT engine,session_id,workspace_path,enabled FROM leader_roles LIMIT 0",
        "SELECT id,parent_engine,parent_session_id,workspace_path,engine,session_id,state,record_json,permission FROM leader_branches LIMIT 0",
        "SELECT engine,session_id,workspace_path,root_engine,root_session_id,root_workspace_path FROM leader_archived_members LIMIT 0",
    ] {
        conn.prepare(sql).map_err(|_| "Detached worker requires the host's initialized compatible Leader schema".to_string())?;
    }
    if let Some(session) = session_id {
        archive::ensure_not_archived(&conn, engine, session)?;
        let managed: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM leader_branches WHERE engine=?1 AND session_id=?2)",
            params![engine, session], |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        if managed { return Err("Detached worker does not support managed Leader chats".into()); }
    }
    Ok(())
}

#[cfg(test)]
mod worker_schema_tests {
    use super::*;

    #[test]
    fn worker_rejects_legacy_schema_without_migrating_it() {
        let db = Db(parking_lot::Mutex::new(rusqlite::Connection::open_in_memory().unwrap()));
        db.0.lock().execute_batch("CREATE TABLE leader_roles(engine TEXT, session_id TEXT, workspace_path TEXT);").unwrap();
        let schema = || db.0.lock().query_row(
            "SELECT group_concat(sql, ';') FROM sqlite_master WHERE sql IS NOT NULL", [],
            |row| row.get::<_, String>(0),
        ).unwrap();
        let before = schema();
        assert!(validate_worker_session(&db, "claude", Some("session-1")).is_err());
        assert_eq!(schema(), before);
    }

    #[test]
    fn worker_accepts_ordinary_parents_and_legacy_roles_but_not_managed_children() {
        let db = Db(parking_lot::Mutex::new(rusqlite::Connection::open_in_memory().unwrap()));
        ensure_schema(&db).unwrap();
        for engine in ["codex", "agy"] {
            assert!(validate_worker_session(&db, engine, None).is_ok());
            assert!(validate_worker_session(&db, engine, Some("ordinary")).is_ok());
            db.0.lock().execute(
                "INSERT INTO leader_roles(engine,session_id,workspace_path,enabled) VALUES(?1,'leader','fixture',1)", [engine],
            ).unwrap();
            assert!(validate_worker_session(&db, engine, Some("leader")).is_ok());
            db.0.lock().execute("INSERT INTO leader_branches(id,parent_engine,parent_session_id,workspace_path,engine,session_id,state,record_json,permission)
                VALUES(?1,?1,'leader','fixture',?1,'child','completed','{}','manual')", [engine]).unwrap();
            assert!(validate_worker_session(&db, engine, Some("leader")).is_ok());
            assert!(validate_worker_session(&db, engine, Some("child")).unwrap_err().contains("does not support"));
        }
    }
}

pub fn prepare_run(
    db: &Db,
    run_id: &str,
    engine: &str,
    session_id: Option<&str>,
    workspace_path: &str,
    permission: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(manager) = MANAGER.get() else {
        ensure_schema(db)?;
        if let Some(session) = session_id {
            archive::ensure_not_archived(&db.0.lock(), engine, session)?;
        }
        return Ok(None);
    };
    manager.prepare(run_id, engine, session_id, workspace_path, permission)
}

pub(crate) fn prepare_worker_run(
    db: &Db, run_id: &str, engine: &str, session_id: Option<&str>,
    workspace_path: &str, permission: Option<&str>,
) -> Result<(), String> {
    validate_worker_session(db, engine, session_id)?;
    if is_managed_child(run_id) {
        return Err("Managed child launches require the task coordinator's native path".into());
    }
    let Some(manager) = MANAGER.get() else { return Ok(()); };
    let entry = manager.processes.get(run_id).ok_or("Worker has no trusted run reservation")?;
    if entry.pid != 0 || entry.child.is_some() || entry.killed.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("Worker does not own an active new run reservation".into());
    }
    manager.prepare(run_id, engine, session_id, workspace_path,
        permission.filter(|value| !value.trim().is_empty()))?;
    Ok(())
}

pub(crate) fn capture_worker_registration(run_id: &str) -> Option<WorkerTaskRegistration> {
    MANAGER.get()?.capture_worker_registration(run_id)
}

pub(crate) fn restore_worker_registration(registration: &WorkerTaskRegistration) -> Result<(), String> {
    manager()?.restore_worker_registration(registration)
}

impl LeaderManager {
    fn capture_worker_registration(&self, run_id: &str) -> Option<WorkerTaskRegistration> {
        let inner = self.inner.lock();
        let run = inner.runs.get(run_id)?;
        if run.retired || !run.leader_eligible || run.branch_id.is_some() { return None; }
        let entry = self.processes.get(run_id)?;
        if entry.killed.load(std::sync::atomic::Ordering::SeqCst) { return None; }
        Some(WorkerTaskRegistration {
            run_id: run_id.into(), engine: run.engine.clone(), session_id: run.session_id.clone(),
            workspace_path: run.workspace_path.clone(), permission: run.permission.clone(),
            root_on_start: run.root_on_start, root_identity_bound: run.root_identity_bound,
            root_saved_baseline: run.root_saved_baseline.as_deref().cloned(),
            root_foreign_claims: run.root_foreign_claims.clone(),
            verified_new_root: run.session_id.as_deref().is_some_and(|session|
                inner.verified_new_roots.contains_key(&key(&identity(&run.engine, session, &run.workspace_path)))),
        })
    }

    fn restore_worker_registration(&self, saved: &WorkerTaskRegistration) -> Result<(), String> {
        supported(&saved.engine)?;
        text_limit(&saved.run_id, "worker run_id", 128)?;
        text_limit(&saved.workspace_path, "worker workspace", 4096)?;
        if let Some(session) = &saved.session_id { text_limit(session, "worker session_id", 256)?; }
        if !matches!(saved.permission.as_str(), "auto" | "manual" | "plan" | "bypass")
            || saved.root_on_start != saved.session_id.is_none()
            || saved.root_identity_bound != saved.session_id.is_some()
            || saved.root_on_start != saved.root_saved_baseline.is_some()
            || saved.root_on_start != saved.root_foreign_claims.is_some()
            || (saved.verified_new_root && saved.session_id.is_none()) {
            return Err("Invalid worker task registration".into());
        }
        validate_worker_session(&self.db, &saved.engine, saved.session_id.as_deref())?;
        let entry = self.processes.get(&saved.run_id).ok_or("Recovered worker has no live routing proxy")?;
        if entry.run_id != saved.run_id || entry.pid == 0 || entry.killed.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("Recovered worker routing proxy is not active".into());
        }
        let mut inner = self.inner.lock();
        if inner.shutdown { return Err("Task coordinator is shutting down".into()); }
        if let Some(run) = inner.runs.get(&saved.run_id) {
            if run.retired || !run.leader_eligible || run.branch_id.is_some()
                || run.engine != saved.engine || run.session_id != saved.session_id
                || !same_workspace(&run.workspace_path, &saved.workspace_path) || run.permission != saved.permission {
                return Err("Recovered worker conflicts with an existing task registration".into());
            }
            return Ok(());
        }
        if let Some(session) = &saved.session_id {
            archive::ensure_available(&inner, &saved.engine, session, None)?;
            self.ensure_no_isolated_run(&inner, &saved.engine, session)?;
            if saved.verified_new_root {
                inner.verified_new_roots.insert(key(&identity(&saved.engine, session, &saved.workspace_path)), (self.clock)());
            }
        }
        inner.runs.insert(saved.run_id.clone(), Run {
            engine: saved.engine.clone(), session_id: saved.session_id.clone(),
            workspace_path: saved.workspace_path.clone(), permission: saved.permission.clone(),
            branch_id: None, leader_eligible: true, root_on_start: saved.root_on_start,
            root_identity_bound: saved.root_identity_bound,
            root_saved_baseline: saved.root_saved_baseline.clone().map(Arc::new),
            root_foreign_claims: saved.root_foreign_claims.clone(), isolated_resume_session: None,
            launch_pending: false, retired: false, last_seq: HashMap::new(),
        });
        Ok(())
    }
}

/// Whether an admitted run belongs to a managed child chat, launched by its
/// parent or sent from the child's own tab. A run's branch never changes
/// after `prepare_run`.
pub fn is_managed_child(run_id: &str) -> bool {
    MANAGER.get().is_some_and(|manager| {
        manager
            .inner
            .lock()
            .runs
            .get(run_id)
            .is_some_and(|run| run.branch_id.is_some())
    })
}

/// Presentation capability only. Tool dispatch still verifies the active caller.
/// Read after prepare_run so first-turn roots need no saved session identity.
pub(crate) fn run_has_task_capability(run_id: &str) -> bool {
    MANAGER.get().is_some_and(|manager| manager.run_has_task_capability(run_id))
}

impl LeaderManager {
    fn run_has_task_capability(&self, run_id: &str) -> bool {
        let inner = self.inner.lock();
        let Some(run) = inner.runs.get(run_id) else { return false; };
        if inner.shutdown || run.retired || !run.leader_eligible { return false; }
        if let Some(id) = &run.branch_id {
            return inner.branches.get(id).is_some_and(|record| !fenced(&record.branch.state) && !record.stopping);
        }
        self.processes.get(run_id).is_some_and(|entry| !entry.killed.load(std::sync::atomic::Ordering::SeqCst))
    }
}

/// Independent sinks and constrained/remote sends own no Leader capability,
/// but their launch must share the coordinator's retirement and identity fence.
pub fn prepare_isolated_run(
    db: &Db,
    run_id: &str,
    engine: &str,
    session_id: Option<&str>,
    workspace_path: &str,
    launch_marker: &Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), String> {
    if !matches!(engine, "claude" | "codex" | "agy" | "cursor") {
        return Ok(());
    }
    if let Some(manager) = MANAGER.get() {
        return manager.prepare_isolated(run_id, engine, session_id, workspace_path, launch_marker);
    }
    // Fail closed against the durable ledger before the live coordinator is
    // installed (also used by hermetic send-path fixtures).
    ensure_schema(db)?;
    if let Some(session) = session_id {
        let conn = db.0.lock();
        archive::ensure_not_archived(&conn, engine, session)?;
        let managed: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM leader_branches WHERE engine=?1 AND session_id=?2)
             OR EXISTS(SELECT 1 FROM leader_branches WHERE parent_engine=?1 AND parent_session_id=?2 AND state!='reclaimed')",
            params![engine, session], |row| row.get(0),
        ).map_err(|error| error.to_string())?;
        if managed {
            return Err("An isolated agent cannot resume a managed Leader chat".into());
        }
    }
    Ok(())
}

/// A native identity another live run has validated but not yet claimed.
fn pending_claim(inner: &Inner, engine: &str, session: &str, except_run: &str) -> bool {
    inner
        .pending_bindings
        .iter()
        .any(|(run, (e, s))| run != except_run && e == engine && s == session)
}

fn record_pending_root_foreign_claim(inner: &mut Inner, owner: &str, engine: &str, session: &str) {
    for (run_id, run) in &mut inner.runs {
        if run_id != owner && run.root_on_start && !run.retired && run.engine == engine {
            if let Some(claims) = &mut run.root_foreign_claims {
                claims.insert(session.into());
            }
        }
    }
}

impl LeaderManager {
    fn isolated_identity_available(
        &self,
        inner: &Inner,
        run_id: &str,
        engine: &str,
        session: Option<&str>,
    ) -> Result<(), String> {
        if inner.shutdown {
            return Err("Leader coordinator is shutting down".into());
        }
        let Some(session) = session else {
            return Ok(());
        };
        archive::ensure_available(inner, engine, session, None)?;
        if inner.retiring.contains(&(engine.into(), session.into())) {
            return Err("This chat is being archived or deleted".into());
        }
        if pending_claim(inner, engine, session, run_id) {
            return Err("Another run is still binding this native session".into());
        }
        // Native session identity is global to an engine; a workspace alias
        // must not bypass ownership, including reclaimed child tombstones.
        let managed = inner
            .leaders
            .keys()
            .any(|(e, s, _)| e == engine && s == session)
            || inner.branches.values().any(|record| {
                let branch = &record.branch;
                (branch.engine == engine && branch.session_id.as_deref() == Some(session))
                    || (branch.parent_engine == engine
                        && branch.parent_session_id == session
                        && branch.state != "reclaimed")
            });
        if managed {
            return Err("An isolated agent cannot resume a managed Leader chat".into());
        }
        Ok(())
    }

    fn ensure_no_isolated_run(
        &self,
        inner: &Inner,
        engine: &str,
        session: &str,
    ) -> Result<(), String> {
        let pending = inner.pending_bindings.iter().any(|(id, (e, s))| {
            e == engine
                && s == session
                && inner.runs.get(id).is_some_and(|run| !run.leader_eligible)
        });
        if pending
            || inner.runs.iter().any(|(id, run)| {
                !run.leader_eligible
                    && run.engine == engine
                    && (run.session_id.as_deref() == Some(session)
                        || run.isolated_resume_session.as_deref() == Some(session))
                    && !run.retired
                    && (run.launch_pending || self.processes.get(id).is_some())
            })
        {
            return Err(
                "Stop isolated agent runs before enabling or binding a managed Leader chat".into(),
            );
        }
        Ok(())
    }

    fn prepare_isolated(
        &self,
        run_id: &str,
        engine: &str,
        session_id: Option<&str>,
        workspace_path: &str,
        launch_marker: &Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<(), String> {
        let mut inner = self.inner.lock();
        self.isolated_identity_available(&inner, run_id, engine, session_id)?;
        if let Some(entry) = self.processes.get(run_id) {
            if entry.pid != 0 || entry.child.is_some() || !Arc::ptr_eq(&entry.killed, launch_marker)
            {
                return Err("Isolated launch does not own its new run reservation".into());
            }
        }
        if let Some(run) = inner.runs.get(run_id) {
            // Independent clients may retry a completed request id. Preserve
            // that behavior without ever reusing a trusted/managed run id.
            // Registry removal precedes old finish(). Until the ledger says
            // retired, that old finish may still arrive and must not retire a retry.
            if run.leader_eligible || !run.retired {
                return Err(
                    "Run identity was already registered with different details or retired".into(),
                );
            }
        }
        inner.runs.insert(
            run_id.into(),
            Run {
                engine: engine.into(),
                session_id: session_id.map(str::to_string),
                workspace_path: workspace_path.into(),
                permission: "auto".into(),
                branch_id: None,
                leader_eligible: false,
                root_on_start: false,
                root_identity_bound: false,
                root_saved_baseline: None,
                root_foreign_claims: None,
                isolated_resume_session: session_id.map(str::to_string),
                launch_pending: true,
                retired: false,
                last_seq: HashMap::new(),
            },
        );
        if let Some(session) = session_id {
            record_pending_root_foreign_claim(&mut inner, run_id, engine, session);
        }
        if inner.runs.len() > 2048 {
            inner
                .runs
                .retain(|_, run| !run.retired || run.branch_id.is_some());
        }
        Ok(())
    }

    #[cfg(test)]
    fn prepare_first_root(
        &self,
        run_id: &str,
        engine: &str,
        workspace: &str,
        permission: Option<&str>,
        launch_marker: &Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<String, String> {
        supported(engine)?;
        let mut inner = self.inner.lock();
        if inner.shutdown {
            return Err("Leader coordinator is shutting down".into());
        }
        let entry = self.processes.get(run_id)
            .ok_or("First-turn Leader launch has no owned run reservation")?;
        if entry.pid != 0 || entry.child.is_some()
            || !Arc::ptr_eq(&entry.killed, launch_marker)
            || entry.killed.load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err("First-turn Leader launch does not own an active new run reservation".into());
        }
        if inner.runs.contains_key(run_id) {
            return Err("First-turn Leader run identity was already registered".into());
        }
        let permission = permission.unwrap_or("auto");
        if !matches!(permission, "auto" | "manual" | "plan" | "bypass") {
            return Err("Unknown trusted launch permission".into());
        }
        let baseline = {
            let conn = self.db.0.lock();
            let mut query = conn.prepare(
                "SELECT session_id FROM sessions WHERE engine=?1
                 UNION SELECT session_id FROM session_archives WHERE engine=?1",
            ).map_err(|e| e.to_string())?;
            let rows = query.query_map([engine], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<HashSet<_>, _>>().map_err(|e| e.to_string())?
        };
        let foreign_claims = inner.runs.values().filter(|run| run.engine == engine)
            .flat_map(|run| run.session_id.iter().chain(run.isolated_resume_session.iter()))
            .chain(inner.pending_bindings.values().filter(|(e, _)| e == engine).map(|(_, session)| session))
            .cloned().collect();
        inner.runs.insert(run_id.into(), Run {
            engine: engine.into(), session_id: None, workspace_path: workspace.into(),
            permission: permission.into(), branch_id: None, leader_eligible: true,
            root_on_start: true, root_identity_bound: false,
            root_saved_baseline: Some(Arc::new(baseline)),
            root_foreign_claims: Some(foreign_claims), isolated_resume_session: None,
            launch_pending: true, retired: false, last_seq: HashMap::new(),
        });
        if inner.runs.len() > 2048 {
            inner.runs.retain(|_, run| !run.retired || run.branch_id.is_some());
        }
        Ok(role(false))
    }

    fn prepare(
        &self,
        run_id: &str,
        engine: &str,
        session_id: Option<&str>,
        workspace_path: &str,
        permission: Option<&str>,
    ) -> Result<Option<String>, String> {
        if !matches!(engine, "claude" | "codex" | "agy" | "cursor") {
            return Ok(None);
        }
        let mut inner = self.inner.lock();
        if inner.shutdown {
            return Err("Leader coordinator is shutting down".into());
        }
        if let Some(session) = session_id {
            archive::ensure_available(&inner, engine, session, None)?;
        }
        if let Some(branch_id) = inner
            .runs
            .get(run_id)
            .and_then(|run| run.branch_id.as_deref())
        {
            archive::ensure_available(
                &inner,
                engine,
                session_id.unwrap_or_default(),
                Some(branch_id),
            )?;
        }
        if session_id
            .is_some_and(|session| inner.retiring.contains(&(engine.into(), session.into())))
        {
            return Err("This chat is being archived or deleted".into());
        }
        // Until commit, a child's first identity is not yet in its branch:
        // a GUI resume would otherwise slip past the managed-branch lookup.
        if session_id.is_some_and(|session| {
            inner.pending_bindings.iter().any(|(id, (e, s))| {
                id != run_id
                    && e == engine
                    && s == session
                    && inner
                        .runs
                        .get(id)
                        .is_some_and(|run| run.branch_id.is_some() || run.root_on_start)
            })
        }) {
            return Err("A managed chat is still binding this native session".into());
        }
        let registered = inner.runs.get(run_id).and_then(|r| r.branch_id.clone());
        let branch_id = registered.or_else(|| {
            session_id.and_then(|session| {
                inner
                    .branches
                    .values()
                    .find(|r| {
                        r.branch.engine == engine && r.branch.session_id.as_deref() == Some(session)
                    })
                    .map(|r| r.branch.id.clone())
            })
        });
        if let Some(id) = &branch_id {
            let record = inner.branches.get(id).ok_or("Managed branch is missing")?;
            if record.branch.engine != engine
                || !same_workspace(&record.branch.workspace_path, workspace_path)
                || (record.branch.session_id.is_some()
                    && record.branch.session_id.as_deref() != session_id)
            {
                return Err("Managed run identity does not match its branch".into());
            }
            if fenced(&record.branch.state) || record.stopping {
                return Err("This branch is being retired or has been reclaimed".into());
            }
            if record.branch.cost_approval.is_some() || record.branch.state == "awaiting_cost_approval" {
                return Err("This branch is awaiting human cost approval; approve or cancel the pending request first".into());
            }
            if record.branch.run_id.as_deref() != Some(run_id)
                && self.active(&inner, &record.branch)
            {
                return Err("This managed branch already has an active run".into());
            }
        }
        let permission = permission.unwrap_or("auto");
        if !matches!(permission, "auto" | "manual" | "plan" | "bypass") {
            return Err("Unknown trusted launch permission".into());
        }
        if let Some(existing) = inner.runs.get(run_id) {
            if existing.retired
                || !existing.leader_eligible
                || existing.engine != engine
                || !same_workspace(&existing.workspace_path, workspace_path)
                || existing.session_id.as_deref() != session_id
            {
                return Err(
                    "Run identity was already registered with different details or retired".into(),
                );
            }
        }
        let root_on_start = branch_id.is_none() && session_id.is_none();
        let root_identity_bound = inner.runs.get(run_id).is_some_and(|run| run.root_identity_bound)
            || (branch_id.is_none() && session_id.is_some());
        let root_saved_baseline = if root_on_start {
            if let Some(baseline) = inner.runs.get(run_id).and_then(|run| run.root_saved_baseline.clone()) {
                Some(baseline)
            } else {
                let conn = self.db.0.lock();
                let mut query = conn.prepare("SELECT session_id FROM sessions WHERE engine=?1 UNION SELECT session_id FROM session_archives WHERE engine=?1")
                    .map_err(|e| e.to_string())?;
                let ids = query.query_map([engine], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?
                    .collect::<Result<HashSet<_>, _>>().map_err(|e| e.to_string())?;
                Some(Arc::new(ids))
            }
        } else { None };
        let root_foreign_claims = if root_on_start {
            Some(inner.runs.get(run_id).and_then(|run| run.root_foreign_claims.clone()).unwrap_or_else(|| {
                inner.runs.iter().filter(|(id, run)| id.as_str() != run_id && run.engine == engine)
                    .flat_map(|(_, run)| run.session_id.iter().chain(run.isolated_resume_session.iter()))
                    .chain(inner.pending_bindings.iter().filter(|(id, (e, _))| id.as_str() != run_id && e == engine).map(|(_, (_, session))| session))
                    .cloned().collect()
            }))
        } else { None };
        inner.runs.insert(
            run_id.into(),
            Run {
                engine: engine.into(),
                session_id: session_id.map(str::to_string),
                workspace_path: workspace_path.into(),
                permission: permission.into(),
                branch_id: branch_id.clone(),
                leader_eligible: true,
                root_on_start,
                root_identity_bound,
                root_saved_baseline,
                root_foreign_claims,
                isolated_resume_session: None,
                launch_pending: true,
                retired: false,
                last_seq: HashMap::new(),
            },
        );
        if let Some(session) = session_id {
            record_pending_root_foreign_claim(&mut inner, run_id, engine, session);
        }
        if let Some(id) = branch_id {
            let record = inner
                .branches
                .get_mut(&id)
                .ok_or("Managed branch is missing")?;
            if record.branch.run_id.as_deref() != Some(run_id) {
                record.branch.run_id = Some(run_id.into());
                record.branch.result.clear();
                record.branch.result_truncated = false;
                record.branch.error = None;
                record.output = Output::default();
                record.questions.clear();
                record.plans.clear();
            }
            record.permission = permission.into();
            record.branch.state = "starting".into();
            record.branch.updated_at = (self.clock)();
            self.save(record)?;
        }
        // Bound unrelated finished-run identities, while keeping every managed
        // run tombstone to fence late output after reclamation.
        if inner.runs.len() > 2048 {
            inner
                .runs
                .retain(|_, r| !r.retired || r.branch_id.is_some());
        }
        let child = inner.runs.get(run_id).and_then(|r| r.branch_id.as_ref()).is_some();
        let owns_tasks = session_id.is_some_and(|session| {
            let parent = identity(engine, session, workspace_path);
            inner.branches.values().any(|record| record.branch.state != "reclaimed" && belongs(&record.branch, &parent))
        });
        Ok(Some(if child { role(true) } else if owns_tasks { owned_task_instructions() } else { role(false) }))
    }
}

pub fn observe_event(event: &mut Value) {
    if let Some(manager) = MANAGER.get() {
        manager.observe(event);
    }
}

/// How a reader may use a native identity that passed validation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionBinding {
    /// Adopt and announce the identity.
    Adopt,
    /// A child's first identity arrived after its reclamation began. Record it
    /// so the reclaim deletes that transcript, but never adopt or announce it.
    CleanupOnly,
}

const INACTIVE_MANAGED_BINDING: &str =
    "Native session binding does not match an active managed run";

/// Validate and reserve a native identity before the reader claims its
/// registry alias. The reader must follow with commit_session_binding once it
/// owns the alias, or release_session_binding when that claim fails.
pub fn reserve_session_binding(
    run_id: &str,
    engine: &str,
    session_id: &str,
) -> Result<SessionBinding, String> {
    match MANAGER.get() {
        Some(manager) => manager.bind_session(run_id, engine, session_id),
        None => Ok(SessionBinding::Adopt),
    }
}

pub fn commit_session_binding(run_id: &str, engine: &str, session_id: &str) -> Result<(), String> {
    if let Some(manager) = MANAGER.get() {
        return manager.commit_binding(run_id, engine, session_id);
    }
    Ok(())
}

pub fn release_session_binding(run_id: &str, engine: &str, session_id: &str) {
    if let Some(manager) = MANAGER.get() {
        manager.release_binding(run_id, engine, session_id);
    }
}

/// A failed first identity must never be retried by a late engine frame under
/// the original intent. The user may launch a new fresh draft attempt instead.
pub fn reject_first_root_binding(run_id: &str) {
    if let Some(manager) = MANAGER.get() {
        let mut inner = manager.inner.lock();
        if inner.runs.get(run_id).is_some_and(|run| run.root_on_start) {
            inner.pending_bindings.remove(run_id);
            if let Some(run) = inner.runs.get_mut(run_id) {
                run.root_on_start = false;
                run.root_saved_baseline = None;
                run.root_foreign_claims = None;
                run.leader_eligible = false;
                run.retired = true;
                run.launch_pending = false;
            }
        }
    }
}

impl LeaderManager {
    fn bind_session(
        &self,
        run_id: &str,
        engine: &str,
        session: &str,
    ) -> Result<SessionBinding, String> {
        let mut inner = self.inner.lock();
        let binding = self.binding_decision(&inner, run_id, engine, session)?;
        record_pending_root_foreign_claim(&mut inner, run_id, engine, session);
        // Ordinary chats publish identity through observe(). A child's first
        // identity and every isolated identity stay reserved until the reader
        // owns the registry alias, so no fence sees a gap before the commit.
        let reserve = inner.runs.get(run_id).is_some_and(|run| {
            (run.branch_id.is_some() || !run.leader_eligible || run.root_on_start)
                && run.session_id.as_deref() != Some(session)
        });
        if reserve {
            inner
                .pending_bindings
                .insert(run_id.into(), (engine.into(), session.into()));
        }
        Ok(binding)
    }

    fn commit_binding(&self, run_id: &str, engine: &str, session: &str) -> Result<(), String> {
        let mut inner = self.inner.lock();
        let reserved = inner
            .pending_bindings
            .get(run_id)
            .is_some_and(|(e, s)| e == engine && s == session);
        if !reserved {
            if inner.runs.get(run_id).is_some_and(|run| run.root_on_start) {
                return Err("First-turn Leader native identity was not reserved".into());
            }
            return Ok(());
        }
        if inner.runs.get(run_id).is_some_and(|run| run.root_on_start) {
            self.binding_decision(&inner, run_id, engine, session)?;
            let run = inner.runs.get(run_id).ok_or("First-turn Leader run is missing")?;
            let alias = self.processes.get(session)
                .ok_or("First-turn Leader native identity has no owned registry alias")?;
            if alias.run_id != run_id || alias.killed.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("First-turn Leader native identity has no active owned registry alias".into());
            }
            validate_first_root_workspace(&self.db, engine, &run.workspace_path)?;
            let parent = identity(engine, session, &run.workspace_path);
            let conn = self.db.0.lock();
            ensure_first_root_identity(&conn, run, engine, session)?;
            drop(conn);
            inner.pending_bindings.remove(run_id);
            if inner.verified_new_roots.len() >= 2048 {
                if let Some(oldest) = inner.verified_new_roots.iter()
                    .min_by_key(|(_, stamp)| *stamp).map(|(id, _)| id.clone())
                {
                    inner.verified_new_roots.remove(&oldest);
                }
            }
            inner.verified_new_roots.insert(key(&parent), (self.clock)());
            let run = inner.runs.get_mut(run_id).ok_or("First-turn Leader run is missing")?;
            run.session_id = Some(session.into());
            run.root_on_start = false;
            run.root_identity_bound = true;
            run.root_saved_baseline = None;
            run.root_foreign_claims = None;
            drop(inner);
            self.emit();
            return Ok(());
        }
        inner.pending_bindings.remove(run_id);
        let Some(run) = inner.runs.get_mut(run_id) else {
            return Ok(());
        };
        // Isolated sinks never call observe(); this is their identity record.
        run.session_id = Some(session.into());
        let Some(id) = run.branch_id.clone() else {
            return Ok(());
        };
        let now = (self.clock)();
        let mut changed = false;
        if let Some(record) = inner.branches.get_mut(&id) {
            // The run owns this alias now. A concurrent reclaim still records
            // it so cleanup removes the child's transcript; a failed claim never
            // reaches this point, so reclaim cannot delete another run's chat.
            if record.branch.run_id.as_deref() == Some(run_id)
                && record.branch.session_id.is_none()
                && record.branch.state != "reclaimed"
            {
                record.branch.session_id = Some(session.into());
                record.branch.updated_at = now;
                record.dirty = true;
                // A failed write stays dirty for the next checkpoint.
                let _ = self.save(record);
                changed = true;
            }
        }
        drop(inner);
        if changed {
            self.emit();
        }
        Ok(())
    }

    fn release_binding(&self, run_id: &str, engine: &str, session: &str) {
        let mut inner = self.inner.lock();
        if inner
            .pending_bindings
            .get(run_id)
            .is_some_and(|(e, s)| e == engine && s == session)
        {
            inner.pending_bindings.remove(run_id);
        }
    }

    fn check_binding(
        &self,
        inner: &Inner,
        run_id: &str,
        engine: &str,
        session: &str,
    ) -> Result<(), String> {
        match self.binding_decision(inner, run_id, engine, session)? {
            SessionBinding::Adopt => Ok(()),
            SessionBinding::CleanupOnly => Err(INACTIVE_MANAGED_BINDING.into()),
        }
    }

    fn binding_decision(
        &self,
        inner: &Inner,
        run_id: &str,
        engine: &str,
        session: &str,
    ) -> Result<SessionBinding, String> {
        archive::ensure_available(
            inner,
            engine,
            session,
            inner
                .runs
                .get(run_id)
                .and_then(|run| run.branch_id.as_deref()),
        )?;
        let Some(run) = inner.runs.get(run_id) else {
            return self
                .isolated_identity_available(inner, run_id, engine, Some(session))
                .map(|_| SessionBinding::Adopt);
        };
        if run.root_on_start || run.root_identity_bound {
            if inner.shutdown || run.retired || run.engine != engine
                || !run.leader_eligible || run.branch_id.is_some()
            {
                return Err("Native session binding does not match an active first-turn Leader run".into());
            }
            let entry = self.processes.get(run_id)
                .ok_or("First-turn Leader run is no longer active")?;
            if entry.killed.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("First-turn Leader run was stopped before native identity binding".into());
            }
            text_limit(session, "native session_id", 256)?;
            if let Some(expected) = run.session_id.as_deref() {
                return if expected == session {
                    Ok(SessionBinding::Adopt)
                } else {
                    Err("Engine changed this Leader root's native session identity".into())
                };
            }
            if inner.retiring.contains(&(engine.into(), session.into()))
                || inner.verified_new_roots.keys().any(|(e, s, _)| e == engine && s == session)
                || inner.leaders.keys().chain(inner.disabled.iter())
                    .any(|(e, s, _)| e == engine && s == session)
                || inner.branches.values().any(|record| {
                    (record.branch.engine == engine && record.branch.session_id.as_deref() == Some(session))
                        || (record.branch.parent_engine == engine && record.branch.parent_session_id == session)
                })
                || pending_claim(inner, engine, session, run_id)
                || run.root_foreign_claims.as_ref().is_some_and(|claims| claims.contains(session))
                || inner.runs.iter().any(|(id, other)| {
                    id != run_id && other.engine == engine
                        && (other.session_id.as_deref() == Some(session)
                            || other.isolated_resume_session.as_deref() == Some(session))
                })
            {
                return Err("Engine announced a session owned by another chat; Leader root identity was not bound".into());
            }
            self.ensure_no_isolated_run(inner, engine, session)?;
            validate_first_root_workspace(&self.db, engine, &run.workspace_path)?;
            ensure_first_root_identity(&self.db.0.lock(), run, engine, session)?;
            return Ok(SessionBinding::Adopt);
        }
        if !run.leader_eligible {
            if run.retired || run.engine != engine {
                return Err("Native session binding does not match an active isolated run".into());
            }
            return self
                .isolated_identity_available(inner, run_id, engine, Some(session))
                .map(|_| SessionBinding::Adopt);
        }
        let Some(id) = &run.branch_id else {
            return Ok(SessionBinding::Adopt);
        };
        text_limit(session, "native session_id", 256)?;
        let record = inner.branches.get(id).ok_or("Managed branch is missing")?;
        let cleanup = record.branch.state == "reclaiming"
            && record.branch.session_id.is_none()
            && record.branch.run_id.as_deref() == Some(run_id);
        if run.engine != engine
            || record.branch.engine != engine
            || run.retired
            || (fenced(&record.branch.state) && !cleanup)
        {
            return Err(INACTIVE_MANAGED_BINDING.into());
        }
        if let Some(expected) = &record.branch.session_id {
            if expected != session {
                return Err("Engine changed this branch's native session identity".into());
            }
            return Ok(SessionBinding::Adopt);
        }
        let owned = inner
            .leaders
            .keys()
            .chain(inner.disabled.iter())
            .any(|(e, s, _)| e == engine && s == session)
            || inner.verified_new_roots.keys().any(|(e, s, _)| e == engine && s == session)
            || inner.runs.iter().any(|(other_id, other)| other_id != run_id && other.leader_eligible && other.engine == engine
                && (other.session_id.as_deref() == Some(session) || other.isolated_resume_session.as_deref() == Some(session)))
            || inner.branches.values().any(|other| {
                other.branch.id != *id
                    && other.branch.engine == engine
                    && other.branch.session_id.as_deref() == Some(session)
            })
            || inner.branches.values().any(|other| {
                other.branch.parent_engine == engine && other.branch.parent_session_id == session
            })
            || pending_claim(inner, engine, session, run_id);
        if owned {
            return Err(
                "Engine announced a session owned by another chat; child identity was not rebound"
                    .into(),
            );
        }
        self.ensure_no_isolated_run(inner, engine, session)?;
        let conn = self.db.0.lock();
        let known: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sessions WHERE engine=?1 AND session_id=?2)
            OR EXISTS(SELECT 1 FROM session_archives WHERE engine=?1 AND session_id=?2)",
                params![engine, session],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if known {
            return Err("Engine announced an existing saved or archived chat; child identity was not rebound".into());
        }
        Ok(if cleanup {
            SessionBinding::CleanupOnly
        } else {
            SessionBinding::Adopt
        })
    }
}

fn ensure_first_root_identity(conn: &rusqlite::Connection, run: &Run, engine: &str, session: &str) -> Result<(), String> {
    let baseline = run.root_saved_baseline.as_ref()
        .ok_or("First-turn Leader saved-identity baseline is unavailable")?;
    if baseline.contains(session) {
        return Err("Engine announced a chat saved or archived before this launch; Leader root identity was not bound".into());
    }
    let known: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM session_archives WHERE engine=?1 AND session_id=?2)
         OR EXISTS(SELECT 1 FROM leader_branches WHERE engine=?1 AND session_id=?2)
         OR EXISTS(SELECT 1 FROM leader_branches WHERE parent_engine=?1 AND parent_session_id=?2)",
        params![engine, session], |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    if known {
        return Err("Engine announced an existing saved, archived, or owned chat; Leader root identity was not bound".into());
    }
    let indexed_workspace: Option<String> = conn.query_row(
        "SELECT workspace_path FROM sessions WHERE engine=?1 AND session_id=?2",
        params![engine, session], |row| row.get(0),
    ).optional().map_err(|e| e.to_string())?;
    if indexed_workspace.is_some_and(|workspace| !same_workspace(&workspace, &run.workspace_path)) {
        return Err("Engine announced a newly indexed chat in another workspace; Leader root identity was not bound".into());
    }
    Ok(())
}

fn prune_verified_roots(inner: &mut Inner, conn: &rusqlite::Connection) -> Result<(), String> {
    let mut remove = Vec::new();
    for (engine, session, workspace) in inner.verified_new_roots.keys() {
        let indexed_or_forgotten: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE engine=?1 AND session_id=?2)
             OR EXISTS(SELECT 1 FROM session_archives WHERE engine=?1 AND session_id=?2)",
            params![engine, session], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if indexed_or_forgotten {
            remove.push((engine.clone(), session.clone(), workspace.clone()));
        }
    }
    for id in remove {
        inner.verified_new_roots.remove(&id);
    }
    Ok(())
}

fn append_bounded(target: &mut String, text: &str, truncated: &mut bool) {
    let remaining = MAX_RESULT_CHARS.saturating_sub(target.chars().count());
    let mut chars = text.chars();
    target.extend(chars.by_ref().take(remaining));
    if chars.next().is_some() {
        *truncated = true;
    }
}

impl LeaderManager {
    fn observe(&self, event: &mut Value) {
        let Some(run_id) = event
            .get("runId")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return;
        };
        let Some(engine) = event
            .get("engine")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            return;
        };
        let kind = event
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let session = event
            .get("sessionId")
            .and_then(Value::as_str)
            .or_else(|| {
                if kind == "session" {
                    event.get("data").and_then(Value::as_str)
                } else {
                    None
                }
            })
            .map(str::to_string);
        let data = event.get("data").cloned().unwrap_or(Value::Null);
        let seq = event.get("seq").and_then(Value::as_u64);
        let now = (self.clock)();
        let mut inner = self.inner.lock();
        let base = if inner.runs.contains_key(&run_id) {
            run_id.clone()
        } else if let Some((prefix, suffix)) =
            run_id.rsplit_once("-c").filter(|(prefix, suffix)| {
                !suffix.is_empty()
                    && suffix.bytes().all(|b| b.is_ascii_digit())
                    && inner.runs.contains_key(*prefix)
            })
        {
            let _ = suffix;
            prefix.to_string()
        } else {
            let Some(entry) = self.processes.get(&run_id) else {
                return;
            };
            if !inner.runs.contains_key(&entry.run_id) {
                return;
            }
            entry.run_id
        };
        let Some(run) = inner.runs.get(&base) else {
            return;
        };
        if run.engine != engine {
            return;
        }
        let branch_id = run.branch_id.clone();
        let retired = run.retired;
        if let Some(id) = &branch_id {
            let Some(record) = inner.branches.get(id) else {
                return;
            };
            event["leader"] = json!({"branchId":record.branch.id,"workspacePath":record.branch.workspace_path,"title":record.branch.title});
            if fenced(&record.branch.state) {
                event["leader"]["reclaimed"] = Value::Bool(true);
                return;
            }
            if kind == "session" {
                event["leader"]["assignment"] = Value::String(record.branch.task.clone());
            }
            if record.branch.run_id.as_deref() != Some(base.as_str()) || retired {
                return;
            }
        } else if retired {
            return;
        }
        if let Some(session) = &session {
            if let Err(error) = self.check_binding(&inner, &base, &engine, session) {
                if let Some(id) = &branch_id {
                    event["leader"]["identityRejected"] = Value::Bool(true);
                    if let Some(record) = inner.branches.get_mut(id) {
                        record.branch.state = "failed".into();
                        record.branch.error = Some(error);
                        record.branch.updated_at = now;
                        record.dirty = true;
                        let _ = self.save(record);
                    }
                }
                drop(inner);
                self.emit();
                return;
            }
        }
        let Some(run) = inner.runs.get_mut(&base) else {
            return;
        };
        if let Some(seq) = seq {
            if run.last_seq.get(&run_id).is_some_and(|last| seq <= *last) {
                return;
            }
            run.last_seq.insert(run_id.clone(), seq);
        }
        run.launch_pending = false;
        if let Some(session) = &session {
            run.session_id = Some(session.clone());
        }
        if let Some(session) = session.as_deref() {
            record_pending_root_foreign_claim(&mut inner, &base, &engine, session);
        }
        let Some(id) = branch_id else {
            return;
        };
        let Some(record) = inner.branches.get_mut(&id) else {
            return;
        };
        let mut lifecycle = false;
        if let Some(session) = session {
            if record.branch.session_id.as_ref() != Some(&session) {
                if record.branch.session_id.is_some() {
                    record.branch.state = "failed".into();
                    record.branch.error =
                        Some("Engine changed this branch's native session identity".into());
                } else {
                    record.branch.session_id = Some(session);
                }
                lifecycle = true;
            }
        }
        let previous = record.branch.state.clone();
        // Continuation ids identify genuinely new turns on a still-live Claude
        // process. A same-run late tail cannot revive terminal state.
        let continuation = run_id != base;
        if record.branch.state == "starting"
            || (record.branch.state == "completed"
                && continuation
                && matches!(kind.as_str(), "session" | "delta" | "thinking" | "message"))
        {
            record.branch.state = "running".into();
        }
        let can_progress =
            !terminal(&record.branch.state) || continuation && record.branch.state == "running";
        match kind.as_str() {
            "delta" if can_progress => {
                if let Some(text) = data.as_str() {
                    if record.output.stream_start.is_none() {
                        record.output.stream_start = Some(record.branch.result.len());
                        record.output.stream_prefix_truncated = record.branch.result_truncated;
                    }
                    append_bounded(
                        &mut record.branch.result,
                        text,
                        &mut record.branch.result_truncated,
                    );
                }
            }
            "message" if can_progress => {
                if data.get("role").and_then(Value::as_str) == Some("assistant") {
                    record.output.active_tool = None;
                    if let Some(text) = data.get("text").and_then(Value::as_str) {
                        if let Some(start) = record.output.stream_start.take() {
                            // Replace just the stream's trailing suffix. Unicode
                            // byte boundaries come from String::len, never chars.
                            if record.branch.result.is_char_boundary(start) {
                                record.branch.result.truncate(start);
                            }
                            record.branch.result_truncated = record.output.stream_prefix_truncated;
                            append_bounded(
                                &mut record.branch.result,
                                text,
                                &mut record.branch.result_truncated,
                            );
                        } else {
                            append_bounded(
                                &mut record.branch.result,
                                text,
                                &mut record.branch.result_truncated,
                            );
                        }
                    }
                } else {
                    record.output.stream_start = None;
                    if data.get("role").and_then(Value::as_str) == Some("tool") {
                        if data.get("patch").and_then(Value::as_bool) == Some(true)
                            || data.get("result").is_some()
                        {
                            record.output.active_tool = None;
                        } else {
                            record.output.tool_calls = record.output.tool_calls.saturating_add(1);
                            record.output.active_tool = data
                                .get("text")
                                .and_then(Value::as_str)
                                .map(|s| s.chars().take(64).collect());
                        }
                    }
                }
            }
            "question" if can_progress => {
                record.questions.insert(
                    data.get("requestId")
                        .and_then(Value::as_str)
                        .unwrap_or("question")
                        .into(),
                );
                record.branch.state = "waiting".into();
            }
            "question_settled" if can_progress => {
                record.questions.remove(
                    data.get("requestId")
                        .and_then(Value::as_str)
                        .unwrap_or("question"),
                );
            }
            "plan_review" if can_progress => {
                record.plans.insert(
                    data.get("planId")
                        .and_then(Value::as_str)
                        .unwrap_or("plan")
                        .into(),
                );
                record.branch.state = "waiting".into();
            }
            "plan_review_settled" if can_progress => {
                record
                    .plans
                    .remove(data.get("planId").and_then(Value::as_str).unwrap_or("plan"));
            }
            "permission_denied" if can_progress => {
                record.branch.error = data
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            "done" if can_progress => {
                record.output.stream_start = None;
                record.output.active_tool = None;
                record.branch.state = if record.stopping {
                    "stopped"
                } else if !record.questions.is_empty() || !record.plans.is_empty() {
                    "waiting"
                } else {
                    "completed"
                }
                .into();
                lifecycle = true;
            }
            "error" if can_progress => {
                record.output.stream_start = None;
                record.output.active_tool = None;
                record.branch.state = if record.stopping { "stopped" } else { "failed" }.into();
                record.branch.error = data.as_str().map(str::to_string).or_else(|| {
                    data.get("message")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                });
                lifecycle = true;
            }
            _ => {}
        }
        if matches!(kind.as_str(), "question_settled" | "plan_review_settled")
            && record.questions.is_empty()
            && record.plans.is_empty()
            && record.branch.state == "waiting"
        {
            record.branch.state = "running".into();
        }
        record.branch.last_activity_at = now;
        record.branch.updated_at = now;
        record.branch.expired = now >= record.branch.deadline_at;
        record.dirty = true;
        lifecycle |= previous != record.branch.state || kind == "session";
        if lifecycle {
            let _ = self.save(record);
        }
        drop(inner);
        if lifecycle {
            self.emit();
        }
    }

    fn finish(&self, run_id: &str) {
        let mut inner = self.inner.lock();
        inner.pending_bindings.remove(run_id);
        let Some(run) = inner.runs.get_mut(run_id) else {
            return;
        };
        run.retired = true;
        run.launch_pending = false;
        if run.root_on_start {
            run.leader_eligible = false;
        }
        run.root_on_start = false;
        run.root_saved_baseline = None;
        run.root_foreign_claims = None;
        let branch_id = run.branch_id.clone();
        if let Some(id) = branch_id {
            if let Some(record) = inner.branches.get_mut(&id) {
                if record.branch.run_id.as_deref() == Some(run_id) && !fenced(&record.branch.state)
                {
                    if record.stopping {
                        record.branch.state = "stopped".into();
                    } else if matches!(record.branch.state.as_str(), "starting" | "running") {
                        record.branch.state = "unknown".into();
                        record.branch.error=Some("Process retired without a terminal result; inspect the chat before continuing".into());
                    }
                    record.branch.updated_at = (self.clock)();
                    record.dirty = true;
                    let _ = self.save(record);
                }
            }
        }
        drop(inner);
        self.emit();
    }
}

pub fn finish_run(run_id: &str) {
    if let Some(manager) = MANAGER.get() {
        manager.finish(run_id);
    }
}

#[tauri::command]
pub async fn task_group_action(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    engine: String,
    session_id: String,
    workspace_path: String,
    action: String,
) -> Result<LeaderSnapshot, String> {
    require_main(&window)?;
    group_action(&state.db, engine, session_id, workspace_path, action).await
}

/// Shared by the native window and the authenticated web dispatcher.
pub(crate) async fn group_action(db: &Db, engine: String, session_id: String, workspace_path: String, action: String) -> Result<LeaderSnapshot, String> {
    archive::group_action(db, engine, session_id, workspace_path, action).await
}

#[tauri::command]
pub fn task_snapshot(
    window: tauri::WebviewWindow,
    _state: tauri::State<'_, crate::AppState>,
) -> Result<LeaderSnapshot, String> {
    require_main(&window)?;
    snapshot()
}

#[tauri::command]
pub async fn task_resolve_cost_approval(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    parent_engine: String,
    parent_session_id: String,
    workspace_path: String,
    branch_id: String,
    request_id: String,
    approve: bool,
    reviewed_model: Option<String>,
) -> Result<LeaderSnapshot, String> {
    require_main(&window)?;
    let manager = manager()?;
    let parent = identity(&parent_engine, &parent_session_id, &workspace_path);
    if let Some((branch, run_id, permission)) = manager.resolve_cost_approval(
        &parent, &branch_id, &request_id, approve, reviewed_model.as_deref(),
    )? {
        let result = crate::engine::send_message_inner(
            &state, branch.engine, branch.workspace_path, branch.session_id,
            branch.task, None, branch.model, branch.effort, Some(permission),
            None, Some(run_id.clone()), None, None,
        ).await;
        manager.acknowledge(&parent, &request_id, &run_id, result)?;
    }
    manager.snapshot()
}

pub(crate) fn snapshot() -> Result<LeaderSnapshot, String> {
    manager()?.snapshot()
}

/// History archive/delete must call this before touching files or cache rows.
pub fn ensure_unmanaged(db: &Db, engine: &str, session_id: &str) -> Result<(), String> {
    ensure_schema(db)?;
    let conn = db.0.lock();
    ensure_session_archive_delete_allowed(&conn, engine, session_id)?;
    let managed:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM leader_branches WHERE engine=?1 AND session_id=?2 AND state!='reclaimed')",
        params![engine,session_id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if managed {
        return Err("This is a managed child chat; use whole-group archive or deletion in task management".into());
    }
    let children:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM leader_branches WHERE parent_engine=?1 AND parent_session_id=?2 AND state!='reclaimed')",
        params![engine,session_id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if children {
        return Err("This chat owns child tasks; use whole-group archive or deletion in task management".into());
    }
    Ok(())
}

/// Call while holding the connection used for the history mutation.
pub(crate) fn ensure_session_not_group_archived(
    conn: &rusqlite::Connection,
    engine: &str,
    session_id: &str,
) -> Result<(), String> {
    archive::ensure_not_archived(conn, engine, session_id)
}

/// Ordinary archive/delete protects actual task relationships, never an old
/// opt-in flag on a chat that has no children.
/// Keep this check on the same connection as the eventual history mutation.
pub(crate) fn ensure_session_archive_delete_allowed(
    conn: &rusqlite::Connection,
    engine: &str,
    session_id: &str,
) -> Result<(), String> {
    archive::ensure_not_archived(conn, engine, session_id)?;
    let has_branches: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='leader_branches')",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if has_branches && conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM leader_branches WHERE state!='reclaimed' AND
         ((engine=?1 AND session_id=?2) OR (parent_engine=?1 AND parent_session_id=?2)))",
        params![engine,session_id], |r|r.get::<_,bool>(0),
    ).map_err(|e|e.to_string())? {
        return Err("This chat belongs to a managed task group; use whole-group archive or deletion in task management".into());
    }
    Ok(())
}

/// Internal deletion is admitted only by durable reclamation or an explicitly
/// GUI-owned whole-group delete. This is never a model tool capability.
pub(crate) fn ensure_leader_delete_owned(
    conn: &rusqlite::Connection,
    engine: &str,
    session_id: &str,
) -> Result<(), String> {
    let owned: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM leader_branches WHERE engine=?1 AND session_id=?2 AND state='reclaiming')
          OR EXISTS(SELECT 1 FROM leader_archived_members m JOIN leader_archived_groups g
            ON g.root_engine=m.root_engine AND g.root_session_id=m.root_session_id AND g.workspace_path=m.root_workspace_path
            WHERE m.engine=?1 AND m.session_id=?2 AND g.deleting=1 AND m.engine=g.root_engine AND m.session_id=g.root_session_id)",
        params![engine,session_id], |r|r.get(0),
    ).map_err(|e|e.to_string())?;
    if !owned {
        return Err(
            "Native transcript deletion requires confirmed deletion in the main local window".into(),
        );
    }
    let ownership: Option<(String, String)> = conn.query_row(
        "SELECT s.workspace_path,m.workspace_path FROM sessions s JOIN leader_archived_members m ON m.engine=s.engine AND m.session_id=s.session_id WHERE s.engine=?1 AND s.session_id=?2",
        params![engine,session_id], |r| Ok((r.get(0)?,r.get(1)?)),
    ).optional().map_err(|e|e.to_string())?;
    let mismatch = ownership.is_some_and(|(saved, owned)| !same_workspace(&saved, &owned));
    let branch_ownership: Option<(String, String)> = conn.query_row(
        "SELECT s.workspace_path,b.workspace_path FROM sessions s JOIN leader_branches b ON b.engine=s.engine AND b.session_id=s.session_id WHERE s.engine=?1 AND s.session_id=?2 AND b.state='reclaiming'",
        params![engine,session_id], |r| Ok((r.get(0)?,r.get(1)?)),
    ).optional().map_err(|e|e.to_string())?;
    if mismatch || branch_ownership.is_some_and(|(saved, owned)| !same_workspace(&saved, &owned)) {
        return Err("Native chat deletion refused: saved workspace ownership changed".into());
    }
    Ok(())
}

/// A short memory fence around an ordinary archive/delete. It owns no lock,
/// is Send, and clears on error, cancellation, or success through RAII.
pub struct RetirementGuard {
    manager: Option<Arc<LeaderManager>>,
    identity: (String, String),
}

impl Drop for RetirementGuard {
    fn drop(&mut self) {
        if let Some(manager) = &self.manager {
            manager.inner.lock().retiring.remove(&self.identity);
            manager.changed.notify_waiters();
        }
    }
}

impl LeaderManager {
    fn begin_retirement(
        self: &Arc<Self>,
        engine: &str,
        session_id: &str,
    ) -> Result<RetirementGuard, String> {
        let mut inner = self.inner.lock();
        let identity = (engine.into(), session_id.into());
        if inner.retiring.contains(&identity) {
            return Err("This chat is already being archived or deleted".into());
        }
        ensure_unmanaged(&self.db, engine, session_id)?;
        let pending = inner
            .pending_bindings
            .values()
            .any(|(e, s)| e == engine && s == session_id);
        if pending
            || inner.runs.iter().any(|(id, run)| {
                run.engine == engine
                    && (run.session_id.as_deref() == Some(session_id)
                        || run.isolated_resume_session.as_deref() == Some(session_id))
                    && !run.retired
                    && (run.launch_pending || self.processes.get(id).is_some())
            })
        {
            return Err(
                "Stop this chat and wait for its process to retire before archiving or deleting it"
                    .into(),
            );
        }
        inner.retiring.insert(identity.clone());
        Ok(RetirementGuard {
            manager: Some(Arc::clone(self)),
            identity,
        })
    }
}

pub fn begin_retirement(
    db: &Db,
    engine: &str,
    session_id: &str,
) -> Result<RetirementGuard, String> {
    if let Some(manager) = MANAGER
        .get()
        .filter(|manager| std::ptr::eq(db, manager.db.as_ref()))
    {
        manager.begin_retirement(engine, session_id)
    } else {
        ensure_unmanaged(db, engine, session_id)?;
        Ok(RetirementGuard {
            manager: None,
            identity: (engine.into(), session_id.into()),
        })
    }
}

/// Call only after an ordinary session deletion has succeeded.
pub fn forget_session(db: &Db, engine: &str, session_id: &str) -> Result<(), String> {
    ensure_unmanaged(db, engine, session_id)?;
    db.0.lock()
        .execute(
            "DELETE FROM leader_roles WHERE engine=?1 AND session_id=?2",
            params![engine, session_id],
        )
        .map_err(|e| e.to_string())?;
    if let Some(manager) = MANAGER.get() {
        let mut inner = manager.inner.lock();
        inner
            .leaders
            .retain(|_, p| p.engine != engine || p.session_id != session_id);
        inner
            .disabled
            .retain(|(e, s, _)| e != engine || s != session_id);
        inner.verified_new_roots.retain(|(e, s, _), _| e != engine || s != session_id);
        drop(inner);
        manager.emit();
    }
    Ok(())
}

impl LeaderManager {
    fn views(
        &self,
        inner: &Inner,
        parent: &LeaderIdentity,
        ids: Option<&[String]>,
    ) -> Result<Vec<Value>, String> {
        self.views_with_budget(inner, parent, ids, MAX_TOOL_RESPONSE_BYTES - 8192)
    }

    fn list_response(
        &self,
        inner: &Inner,
        parent: &LeaderIdentity,
    ) -> Result<Value, String> {
        Ok(json!({"branches":self.views(inner,parent,None)?}))
    }

    fn views_with_budget(
        &self,
        inner: &Inner,
        parent: &LeaderIdentity,
        ids: Option<&[String]>,
        response_budget: usize,
    ) -> Result<Vec<Value>, String> {
        let mut records: Vec<&BranchRecord> = match ids {
            Some(ids) => ids
                .iter()
                .map(|id| self.child(inner, parent, id))
                .collect::<Result<_, _>>()?,
            None => inner
                .branches
                .values()
                .filter(|r| belongs(&r.branch, parent) && r.branch.state != "reclaimed")
                .collect(),
        };
        records.sort_by(|a, b| {
            (a.branch.created_at, &a.branch.id).cmp(&(b.branch.created_at, &b.branch.id))
        });
        let budget = response_budget / records.len().max(1);
        let now = (self.clock)();
        let cache_windows = crate::history::prompt_cache::load_all(&self.db.0.lock()).map_err(|e| e.to_string())?;
        records
            .into_iter()
            .map(|r| {
                let mut view = tool_branch(&r.branch, budget.saturating_sub(256))?;
                let alive = self.active(inner, &r.branch);
                let idle_ms = (now - r.branch.last_activity_at).max(0);
                let idle_secs = (idle_ms / 1000) as u64;
                let ttl_remaining_secs = ((r.branch.deadline_at - now).max(0) / 1000) as u64;
                let cache_window = r.branch.session_id.as_ref().and_then(|id| cache_windows.get(&format!("{}:{id}", r.branch.engine)));
                let cache_warmth = cache_window.map_or("unknown", |w| w.heat(now));
                view["processAlive"] = Value::Bool(alive);
                view["needsAttention"] = Value::Bool(
                    r.branch.expired
                        || r.branch.state == "waiting"
                        || r.branch.state == "awaiting_cost_approval"
                        || r.branch.state == "unknown"
                        || r.branch.state == "failed",
                );
                view["idleProgressAdvisory"] = Value::Bool(
                    alive
                        && r.branch.state != "waiting"
                        && idle_ms >= IDLE_ADVISORY_MS,
                );
                view["idleSeconds"] = Value::from(idle_secs);
                view["ttlRemainingSeconds"] = Value::from(ttl_remaining_secs);
                view["cacheWarmth"] = Value::String(cache_warmth.into());
                if let Some(window) = cache_window {
                    view["cacheRetentionSeconds"] = Value::from(window.ttl_seconds);
                    view["cacheEvidence"] = Value::String(window.source.clone());
                    if let Some(reference) = &window.reference {
                        view["cacheReference"] = Value::Bool(true);
                        view["cacheRetentionMaxSeconds"] = Value::from(reference.max_ttl_seconds);
                        view["lastCacheReadTokens"] = Value::from(reference.cache_read_tokens);
                    }
                }
                view["activeTool"] = r
                    .output
                    .active_tool
                    .as_ref()
                    .map(|t| Value::String(t.clone()))
                    .unwrap_or(Value::Null);
                view["toolCalls"] = Value::from(r.output.tool_calls);
                Ok(view)
            })
            .collect()
    }

    fn renew(
        &self,
        parent: &LeaderIdentity,
        id: &str,
        seconds: Option<u64>,
    ) -> Result<LeaderBranch, String> {
        if let Some(seconds) = seconds {
            ttl(seconds)?;
        }
        let mut inner = self.inner.lock();
        let record = self.child(&inner, parent, id)?;
        if fenced(&record.branch.state) || record.stopping {
            return Err("Child is being stopped or reclaimed".into());
        }
        let seconds = seconds.unwrap_or_else(|| default_ttl(&record.branch.engine));
        let record = inner.branches.get_mut(id).ok_or("Unknown branch")?;
        record.branch.deadline_at = (self.clock)() + seconds as i64 * 1000;
        record.branch.expired = false;
        record.branch.updated_at = (self.clock)();
        self.save(record)?;
        let result = record.branch.clone();
        drop(inner);
        self.emit();
        Ok(result)
    }

    async fn wait_retired(&self, ids: &[String]) -> Result<(), String> {
        let deadline = tokio::time::Instant::now() + RETIRE_TIMEOUT;
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let inner = self.inner.lock();
                if ids.iter().all(|id| {
                    inner
                        .branches
                        .get(id)
                        .map(|r| !self.active(&inner, &r.branch))
                        .unwrap_or(true)
                }) {
                    return Ok(());
                }
                if inner.shutdown {
                    return Err("Coordinator shut down before retirement could be verified".into());
                }
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(
                    "Child process retirement could not be verified; no transcript was deleted"
                        .into(),
                );
            }
            // The registry's abort backstop may remove an entry without an
            // event. A coarse 250ms check supplements lifecycle notifications.
            tokio::select! {_=notified=>{},_=tokio::time::sleep_until(deadline)=>{},_=tokio::time::sleep(Duration::from_millis(250))=>{}}
        }
    }

    fn stop_runs(&self, ids: &[String]) {
        let runs: Vec<_> = {
            let inner = self.inner.lock();
            ids.iter()
                .filter_map(|id| inner.branches.get(id).and_then(|r| r.branch.run_id.clone()))
                .collect()
        };
        for run in runs {
            self.processes.kill(&run);
        }
    }

    async fn stop(&self, parent: &LeaderIdentity, id: &str) -> Result<LeaderBranch, String> {
        {
            let mut inner = self.inner.lock();
            let record = self.child(&inner, parent, id)?;
            if fenced(&record.branch.state) || record.stopping {
                return Err("Child is already being stopped or reclaimed".into());
            }
            if record.branch.cost_approval.is_some() {
                let branch = self.cancel_held_send(&mut inner, parent, id)?;
                drop(inner);
                self.emit();
                return Ok(branch);
            }
            inner.branches.get_mut(id).ok_or("Unknown branch")?.stopping = true;
        }
        self.stop_runs(&[id.into()]);
        if let Err(error) = self.wait_retired(&[id.into()]).await {
            let mut inner = self.inner.lock();
            let record = inner.branches.get_mut(id).ok_or("Unknown branch")?;
            record.branch.state = "unknown".into();
            record.branch.error = Some(error.clone());
            record.stopping = false;
            record.dirty = true;
            self.save(record)?;
            drop(inner);
            self.emit();
            return Err(error);
        }
        let mut inner = self.inner.lock();
        let record = inner.branches.get_mut(id).ok_or("Unknown branch")?;
        record.branch.state = "stopped".into();
        record.branch.updated_at = (self.clock)();
        record.stopping = false;
        self.save(record)?;
        let result = record.branch.clone();
        drop(inner);
        self.emit();
        Ok(result)
    }

    fn subtree(
        inner: &Inner,
        id: &str,
        visiting: &mut HashSet<String>,
        out: &mut Vec<String>,
    ) -> Result<(), String> {
        // An explicit stack supports deep valid delegation without imposing
        // an arbitrary product depth limit or risking Rust stack overflow.
        let mut stack = vec![(id.to_string(), false)];
        while let Some((id, exit)) = stack.pop() {
            if exit {
                out.push(id);
                continue;
            }
            if !visiting.insert(id.clone()) {
                return Err("Ownership ledger contains a cycle; reclamation refused".into());
            }
            let branch = &inner
                .branches
                .get(&id)
                .ok_or("Unknown subtree branch")?
                .branch;
            stack.push((id, true));
            if let Some(session) = &branch.session_id {
                let parent = identity(&branch.engine, session, &branch.workspace_path);
                let mut children: Vec<_> = inner
                    .branches
                    .values()
                    .filter(|r| belongs(&r.branch, &parent) && r.branch.state != "reclaimed")
                    .map(|r| r.branch.id.clone())
                    .collect();
                children.sort();
                for child in children.into_iter().rev() {
                    stack.push((child, false));
                }
            }
        }
        Ok(())
    }

    fn reclaim_failed(&self, ids: &[String], error: &str) -> Result<(), String> {
        let mut inner = self.inner.lock();
        for id in ids {
            if let Some(record) = inner.branches.get_mut(id) {
                if record.branch.state != "reclaimed" {
                    record.branch.state = "unknown".into();
                    record.branch.error = Some(error.into());
                    record.stopping = false;
                    record.branch.updated_at = (self.clock)();
                    record.dirty = true;
                }
            }
        }
        let mut persistence_error = None;
        for id in ids {
            if let Some(record) = inner.branches.get_mut(id) {
                if record.dirty {
                    if let Err(error) = self.save(record) {
                        persistence_error.get_or_insert(error);
                    }
                }
            }
        }
        drop(inner);
        self.emit();
        if let Some(error) = persistence_error {
            Err(format!("{error}; retirement fences were cleared in memory"))
        } else {
            Ok(())
        }
    }

    fn mark_reclaimed(&self, id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock();
        let mut record = inner
            .branches
            .get(id)
            .ok_or("Subtree branch is missing")?
            .clone();
        record.branch.state = "reclaimed".into();
        record.branch.updated_at = (self.clock)();
        record.stopping = false;
        record.dirty = false;
        erase_branch_content(&mut record);
        let removed_identity = record.branch.session_id.as_ref().map(|session| {
            identity(
                &record.branch.engine,
                session,
                &record.branch.workspace_path,
            )
        });
        let mut conn = self.db.0.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        write_branch(&tx, &record)?;
        let mut requests = Vec::new();
        for (request_key, request) in &inner.requests {
            if request.branch_id == id {
                let mut request = request.clone();
                erase_reclaimed_request(&mut request, Some(&record.branch))?;
                write_request(&tx, &request)?;
                requests.push((request_key.clone(), request));
            }
        }
        if let Some(parent) = &removed_identity {
            delete_role(&tx, parent)?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        inner.branches.insert(id.into(), record);
        for (request_key, request) in requests {
            inner.requests.insert(request_key, request);
        }
        if let Some(parent) = removed_identity {
            inner.leaders.remove(&key(&parent));
            inner.disabled.remove(&key(&parent));
            inner.verified_new_roots.remove(&key(&parent));
        }
        refresh_parents(&mut inner);
        Ok(())
    }

    #[cfg(test)]
    async fn reclaim(
        self: &Arc<Self>,
        parent: &LeaderIdentity,
        id: &str,
    ) -> Result<LeaderBranch, String> {
        self.reclaim_owned(parent, id, None, None).await
    }

    async fn reclaim_owned(
        self: &Arc<Self>,
        parent: &LeaderIdentity,
        id: &str,
        group_root: Option<&LeaderIdentity>,
        expected_branch_ids: Option<&[String]>,
    ) -> Result<LeaderBranch, String> {
        let idle_only = expected_branch_ids.is_some();
        let (ids, _retirement_guards) = {
            let mut inner = self.inner.lock();
            let record = if let Some(root) = group_root {
                let group = inner
                    .archived_groups
                    .get(&key(root))
                    .ok_or("Archived Leader group is missing")?;
                if !inner.deleting_groups.contains(&key(root))
                    || !group.branch_ids.iter().any(|candidate| candidate == id)
                {
                    return Err("Branch deletion is not owned by this whole-group action".into());
                }
                let record = inner.branches.get(id).ok_or("Unknown group branch")?;
                if !belongs(&record.branch, parent) || record.branch.state == "reclaimed" {
                    return Err("Branch deletion does not match its direct parent".into());
                }
                record
            } else {
                self.child(&inner, parent, id)?
            };
            if record.branch.state == "reclaiming" {
                return Err("Child reclamation is already in progress".into());
            }
            let mut ids = Vec::new();
            Self::subtree(&inner, id, &mut HashSet::new(), &mut ids)?;
            if let Some(root) = group_root {
                let group = inner
                    .archived_groups
                    .get(&key(root))
                    .ok_or("Archived Leader group is missing")?;
                if ids.iter().any(|id| !group.branch_ids.contains(id)) {
                    return Err("Descendant deletion escapes this archived Leader group".into());
                }
            }
            if ids.iter().any(|id| {
                inner
                    .branches
                    .get(id)
                    .is_some_and(|r| r.branch.state == "reclaiming" || r.stopping)
            }) {
                return Err("A descendant is already being stopped or reclaimed".into());
            }
            // The human-only path admits and fences the entire affected subtree
            // under this same lock. It never stops an active run as a side effect.
            let members = if idle_only {
                let expected = expected_branch_ids.unwrap();
                let expected_set: HashSet<_> = expected.iter().collect();
                if expected.len() != expected_set.len()
                    || expected_set != ids.iter().collect::<HashSet<_>>()
                {
                    return Err("Task subtree changed after confirmation. Review and confirm deletion again".into());
                }
                self.validate_branch_deletion(&inner, parent, &ids)?
            } else {
                Vec::new()
            };
            let mut staged = Vec::new();
            for id in &ids {
                let mut record = inner
                    .branches
                    .get(id)
                    .ok_or("Subtree branch is missing")?
                    .clone();
                record.branch.state = "reclaiming".into();
                record.branch.updated_at = (self.clock)();
                record.stopping = true;
                record.dirty = false;
                staged.push(record);
            }
            let mut conn = self.db.0.lock();
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            for record in &staged {
                write_branch(&tx, record)?;
            }
            tx.commit().map_err(|e| e.to_string())?;
            for record in staged {
                inner.branches.insert(record.branch.id.clone(), record);
            }
            let guards = members.into_iter().map(|member| {
                let identity = (member.engine, member.session_id);
                inner.retiring.insert(identity.clone());
                RetirementGuard { manager: Some(self.clone()), identity }
            }).collect::<Vec<_>>();
            if idle_only {
                for run in inner.runs.values_mut() {
                    if run.branch_id.as_ref().is_some_and(|id| ids.contains(id)) {
                        run.retired = true;
                        run.launch_pending = false;
                    }
                }
            }
            (ids, guards)
        };
        self.emit();
        if !idle_only {
            self.stop_runs(&ids);
            if let Err(error) = self.wait_retired(&ids).await {
                self.reclaim_failed(&ids, &error)?;
                return Err(error);
            }
        }
        for branch_id in &ids {
            let branch = {
                self.inner
                    .lock()
                    .branches
                    .get(branch_id)
                    .ok_or("Subtree branch is missing")?
                    .branch
                    .clone()
            };
            if let Some(session) = &branch.session_id {
                let db = Arc::clone(&self.db);
                let delete = Arc::clone(&self.delete);
                let engine = branch.engine.clone();
                let session = session.clone();
                let result =
                    tauri::async_runtime::spawn_blocking(move || delete(&db, &engine, &session))
                        .await
                        .map_err(|e| format!("Transcript deletion worker failed: {e}"));
                let outcome = result.and_then(|result| result);
                if let Err(error) = outcome {
                    self.reclaim_failed(&ids, &format!("Reclamation failed: {error}"))?;
                    return Err(error);
                }
            }
            if let Err(error) = self.mark_reclaimed(branch_id) {
                let message=format!("Reclamation checkpoint failed; the transcript may already have been removed: {error}");
                self.reclaim_failed(&ids, &message)?;
                return Err(message);
            }
        }
        self.emit();
        self.emitter
            .emit_json(crate::event_sink::SESSIONS_CHANGED_EVENT, "null");
        let result = self.inner
            .lock()
            .branches
            .get(id)
            .map(|r| r.branch.clone())
            .ok_or_else(|| "Reclaimed branch is missing".into());
        // Drop the lookup lock before retirement guards reacquire it on exit.
        result
    }
}

#[tauri::command]
pub async fn task_branch_action(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    parent_engine: String,
    parent_session_id: String,
    workspace_path: String,
    branch_id: String,
    action: String,
    ttl_seconds: Option<u64>,
) -> Result<LeaderBranch, String> {
    require_main(&window)?;
    branch_action(&state.db, parent_engine, parent_session_id, workspace_path, branch_id, action, ttl_seconds).await
}

pub(crate) async fn branch_action(db: &Db, parent_engine: String, parent_session_id: String, workspace_path: String, branch_id: String, action: String, ttl_seconds: Option<u64>) -> Result<LeaderBranch, String> {
    if action == "reclaim" {
        return Err("Shared branch actions cannot delete conversations. Use the deletion confirmation controls in the main local window".into());
    }
    let manager = manager()?;
    let parent = identity(&parent_engine, &parent_session_id, &workspace_path);
    let managed = manager.inner.lock().branches.values().any(|r| {
        r.branch.engine == parent_engine
            && r.branch.session_id.as_deref() == Some(&parent_session_id)
            && same_workspace(&r.branch.workspace_path, &workspace_path)
            && !fenced(&r.branch.state)
    });
    validate_parent(db, &parent, managed)?;
    {
        let inner = manager.inner.lock();
        manager.child(&inner, &parent, &branch_id)?;
    }
    match action.as_str() {
        "renew" => manager.renew(&parent, &branch_id, ttl_seconds),
        "stop" => manager.stop(&parent, &branch_id).await,
        "reclaim" => Err("Shared branch actions cannot delete conversations. Use the deletion confirmation controls in the main local window".into()),
        _ => Err("Unknown task branch action".into()),
    }
}

pub async fn dispatch(
    state: &crate::AppState,
    caller: Caller,
    method: &str,
    arguments: Value,
) -> Result<Value, String> {
    let arguments = validate_arguments(method, arguments)?;
    let manager = manager()?;
    let (parent, permission) = {
        let inner = manager.inner.lock();
        manager.authorize(&inner, &caller)?
    };
    let managed = {
        let mut inner = manager.inner.lock();
        prune_verified_roots(&mut inner, &state.db.0.lock())?;
        inner.runs.get(&caller.run_id).is_some_and(|run| {
            run.branch_id.is_some() || inner.verified_new_roots.contains_key(&key(&parent))
        })
    };
    validate_parent(&state.db, &parent, managed)?;
    match method {
        "task_spawn" => {
            let args: SpawnArgs = decode(arguments.clone())?;
            {
                let inner = manager.inner.lock();
                if let Some(response) =
                    manager.replay(&inner, &parent, &args.request_id, method, &arguments)?
                {
                    return Ok(response);
                }
            }
            let available = crate::engine::list_engines()
                .await?
                .into_iter()
                .any(|engine| engine.id == args.engine && engine.available && engine.enabled);
            if !available {
                return Err("Target engine is disabled or its local CLI is not installed".into());
            }
            let settings = crate::settings::read_settings()?;
            let model = model_policy::resolve(&settings, &args.engine, args.model.as_deref())?;
            let effort = args.effort.clone().or_else(|| {
                settings
                    .default_efforts
                    .get(&args.engine)
                    .filter(|s| !s.trim().is_empty())
                    .cloned()
            }).filter(|e| {
                args.engine != "agy"
                    || crate::engine::agy::effort_flag(Some(e), model.as_deref().unwrap_or(""))
                        .is_some()
            });
            // Revalidate after detection's await and atomically recheck the key
            // with reservation, so concurrent duplicate calls launch once.
            let (id, run_id) = {
                let inner = manager.inner.lock();
                manager.authorize(&inner, &caller)?;
                if let Some(response) =
                    manager.replay(&inner, &parent, &args.request_id, method, &arguments)?
                {
                    return Ok(response);
                }
                drop(inner);
                match manager.reserve_spawn(
                    &caller,
                    &parent,
                    &permission,
                    &args,
                    arguments,
                    model.clone(),
                    effort.clone(),
                )? {
                    Reservation::Replay(response) => return Ok(response),
                    Reservation::Start(start) => start,
                }
            };
            manager.emit();
            let result = crate::engine::send_message_inner(
                state,
                args.engine,
                parent.workspace_path.clone(),
                None,
                args.task,
                None,
                model,
                effort,
                Some(permission),
                None,
                Some(run_id.clone()),
                None,
                None,
            )
            .await;
            // `id` stays in the durable ledger even when launch fails.
            let _ = id;
            manager.acknowledge(&parent, &args.request_id, &run_id, result)
        }
        "task_send" => {
            let args: SendArgs = decode(arguments.clone())?;
            let (branch, run_id) = {
                let inner = manager.inner.lock();
                manager.authorize(&inner, &caller)?;
                if let Some(response) =
                    manager.replay(&inner, &parent, &args.request_id, method, &arguments)?
                {
                    return Ok(response);
                }
                drop(inner);
                match manager.reserve_send(&caller, &parent, &permission, &args, arguments)? {
                    Reservation::Replay(response) => return Ok(response),
                    Reservation::Start(start) => start,
                }
            };
            manager.emit();
            let result = crate::engine::send_message_inner(
                state,
                branch.engine,
                branch.workspace_path,
                branch.session_id,
                args.message,
                None,
                branch.model,
                branch.effort,
                Some(permission),
                None,
                Some(run_id.clone()),
                None,
                None,
            )
            .await;
            manager.acknowledge(&parent, &args.request_id, &run_id, result)
        }
        "task_list" => {
            manager.checkpoint()?;
            let inner = manager.inner.lock();
            manager.authorize(&inner, &caller)?;
            manager.list_response(&inner, &parent)
        }
        "task_wait" => {
            let args: WaitArgs = decode(arguments)?;
            let deadline = tokio::time::Instant::now()
                + Duration::from_secs(args.timeout_seconds.unwrap_or(20));
            let mut start: Option<HashMap<String, Value>> = None;
            loop {
                let notified = manager.changed.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                manager.checkpoint()?;
                let (views, news, pending) = {
                    let inner = manager.inner.lock();
                    manager.authorize(&inner, &caller)?;
                    let views = manager.views(&inner, &parent, args.branch_ids.as_deref())?;
                    let start = start.get_or_insert_with(|| {
                        views
                            .iter()
                            .map(|v| {
                                let id = v.get("id").and_then(Value::as_str).unwrap_or_default();
                                (id.to_string(), wait_mark(v).1)
                            })
                            .collect()
                    });
                    let (news, pending) = wait_news(start, &views);
                    (views, news, pending)
                };
                if !news.is_empty() || !pending || tokio::time::Instant::now() >= deadline {
                    let timed_out = news.is_empty() && pending;
                    return Ok(
                        json!({"branches":views,"changedBranchIds":news,"timedOut":timed_out}),
                    );
                }
                tokio::select! {_=notified=>{},_=tokio::time::sleep_until(deadline)=>{}}
            }
        }
        "task_renew" => {
            let args: RenewArgs = decode(arguments)?;
            tool_branch(
                &manager.renew(&parent, &args.branch_id, Some(args.ttl_seconds))?,
                MAX_TOOL_RESPONSE_BYTES - 8192,
            )
        }
        "task_stop" => {
            let args: BranchArgs = decode(arguments)?;
            tool_branch(
                &manager.stop(&parent, &args.branch_id).await?,
                MAX_TOOL_RESPONSE_BYTES - 8192,
            )
        }
        _ => Err("Unknown task method".into()),
    }
}

#[cfg(test)]
mod tests;

#[tauri::command]
pub async fn task_delete_branch(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    parent_engine: String,
    parent_session_id: String,
    workspace_path: String,
    branch_id: String,
    expected_branch_ids: Vec<String>,
) -> Result<LeaderSnapshot, String> {
    require_main(&window)?;
    supported(&parent_engine)?;
    text_limit(&parent_session_id, "parent_session_id", 256)?;
    text_limit(&branch_id, "branch_id", 256)?;
    validate_workspace(&state.db, &workspace_path)?;
    manager()?.delete_branch_for_user(
        &identity(&parent_engine, &parent_session_id, &workspace_path),
        &branch_id,
        &expected_branch_ids,
    ).await
}
