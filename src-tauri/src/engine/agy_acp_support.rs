//! Native AGY ACP (`agy acp --stdio`) support for:
//! 1. Mid-turn `elicitation/create` (`ask_question` form mode) question cards,
//!    outbound JSON-RPC response delivery, and skip/write-in mapping.
//! 2. Background task tracking (`run_command`, `schedule`, `invoke_subagent`,
//!    `manage_task`), live `.system_generated/tasks/*.log` tailing, and
//!    trajectory `<SYSTEM_MESSAGE>` wakeup detection.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use tokio::sync::{mpsc, oneshot};

use super::WorkerProfileKey;
use crate::engine::events::NativeTask;
use crate::engine::qoder_session::{jsonrpc_id_key, jsonrpc_result_response};
use crate::engine::{parse_tool_args_value, tool_result_patch, EngineEvent, TurnCore, TurnState};

/// Synthetic continuation prompt sent to wake the model after an AGY ACP
/// background task appends its `<SYSTEM_MESSAGE>` completion to the session
/// trajectory while the turn is parked in `Activity("waiting")`.
/// Filtered out when reading saved AGY SQLite/JSONL history so reopened chats
/// never display an artificial user bubble.
pub(crate) const AGY_BG_TASK_WAKEUP_PROMPT: &str = "[ccgui:agy-background-task-wakeup]";

pub(super) const BG_TASK_POLL_INTERVAL: Duration = Duration::from_millis(200);
pub(super) const BG_WAKEUP_COALESCE: Duration = Duration::from_millis(250);
const MAX_TASK_LOG_TAIL_BYTES: u64 = 8 * 1024;
const MAX_PROGRESS_LINES: usize = 12;
const MAX_PROGRESS_CHARS: usize = 1200;

pub(super) type OutboundFrame = (Value, oneshot::Sender<Result<(), String>>);

static OUTBOUND_RUNS: OnceLock<Mutex<HashMap<String, mpsc::UnboundedSender<OutboundFrame>>>> =
    OnceLock::new();

fn outbound_map() -> &'static Mutex<HashMap<String, mpsc::UnboundedSender<OutboundFrame>>> {
    OUTBOUND_RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) struct OutboundRunGuard {
    run_id: String,
}

impl OutboundRunGuard {
    pub(super) fn register(run_id: String) -> (Self, mpsc::UnboundedReceiver<OutboundFrame>) {
        let (tx, rx) = mpsc::unbounded_channel();
        if let Ok(mut guard) = outbound_map().lock() {
            guard.insert(run_id.clone(), tx);
        }
        (Self { run_id }, rx)
    }
}

impl Drop for OutboundRunGuard {
    fn drop(&mut self) {
        if let Ok(mut guard) = outbound_map().lock() {
            guard.remove(&self.run_id);
        }
    }
}

pub(crate) async fn send_run_frame(run_id: &str, frame: Value) -> Result<(), String> {
    let tx = {
        let guard = outbound_map()
            .lock()
            .map_err(|_| "AGY ACP outbound channel state is poisoned".to_string())?;
        guard
            .get(run_id)
            .cloned()
            .ok_or_else(|| "the session is no longer accepting input".to_string())?
    };
    let (ack_tx, ack_rx) = oneshot::channel();
    tx.send((frame, ack_tx))
        .map_err(|_| "the session is no longer accepting input".to_string())?;
    ack_rx
        .await
        .map_err(|_| "the session ended before the answer could be written".to_string())?
}

pub(crate) fn is_internal_wakeup_prompt(text: &str) -> bool {
    text.trim() == AGY_BG_TASK_WAKEUP_PROMPT
}

pub(super) fn client_capabilities() -> Value {
    json!({
        "elicitation": {
            "form": {}
        }
    })
}

pub(super) fn has_parked_questions(core: &TurnCore, state: &TurnState) -> bool {
    for key in [state.native_session_id.as_deref(), Some(core.run_id.as_str())]
        .into_iter()
        .flatten()
    {
        if let Some(entry) = core.registry.get(key) {
            if entry
                .questions
                .lock()
                .ok()
                .is_some_and(|q| !q.is_empty())
            {
                return true;
            }
        }
    }
    false
}

// ==================== Question Elicitation (`elicitation/create`) ====================

fn numeric_q_index(key: &str) -> (u8, usize) {
    if let Some(rest) = key.strip_prefix('q') {
        if let Ok(idx) = rest.parse::<usize>() {
            return (0, idx);
        }
    }
    (1, usize::MAX)
}

fn is_write_in_partner(key: &str, properties: &Map<String, Value>) -> bool {
    key.strip_suffix("_other")
        .is_some_and(|base| !base.is_empty() && properties.contains_key(base))
}

fn extract_raw_choices(field: &Value, multi: bool) -> Option<Vec<(String, String, Option<String>)>> {
    let container = if multi { field.get("items")? } else { field };
    if let Some(items) = container
        .get("oneOf")
        .or_else(|| container.get("anyOf"))
        .and_then(Value::as_array)
        .filter(|arr| !arr.is_empty())
    {
        let mut out = Vec::with_capacity(items.len());
        for choice in items {
            let val = choice
                .get("const")
                .or_else(|| choice.get("value"))
                .and_then(Value::as_str)?
                .to_string();
            let title = choice
                .get("title")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(&val)
                .to_string();
            let desc = choice
                .get("description")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            out.push((val, title, desc));
        }
        return Some(out);
    }
    if let Some(enums) = container
        .get("enum")
        .and_then(Value::as_array)
        .filter(|arr| !arr.is_empty())
    {
        let mut out = Vec::with_capacity(enums.len());
        for item in enums {
            let val = item.as_str()?.to_string();
            out.push((val.clone(), val, None));
        }
        return Some(out);
    }
    None
}

fn is_other_sentinel(raw_const: &str, raw_title: &str, total_choices: usize) -> bool {
    if raw_const == "__other__" {
        return true;
    }
    total_choices > 1
        && raw_const.eq_ignore_ascii_case("other")
        && raw_title.trim().to_ascii_lowercase().starts_with("other")
}

fn derive_header_and_question(
    index: usize,
    key: &str,
    field: &Value,
    prompt_lines: &[&str],
    total_questions: usize,
    raw_message: &str,
) -> (String, String) {
    let title = field
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != key);
    let desc = field
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let default_header = format!("Q{}", index + 1);

    let (header, question) = match (title, desc) {
        (Some(t), Some(d)) if t.chars().count() <= 20 && d != t => {
            (t.to_string(), d.to_string())
        }
        (Some(t), Some(d)) if d.chars().count() > t.chars().count() => {
            (default_header, d.to_string())
        }
        (Some(t), _) => (default_header, t.to_string()),
        (None, Some(d)) => (default_header, d.to_string()),
        (None, None) => {
            if prompt_lines.len() == total_questions {
                (default_header, prompt_lines[index].to_string())
            } else if total_questions == 1 && !raw_message.trim().is_empty() {
                (default_header, raw_message.trim().to_string())
            } else {
                (default_header.clone(), format!("Question {}", index + 1))
            }
        }
    };
    (header, question)
}

fn parse_elicitation_form(params: &Value) -> Result<(Vec<Value>, Vec<Value>), String> {
    if params.get("mode").and_then(Value::as_str) != Some("form") {
        return Err("Unsupported AGY elicitation mode".into());
    }
    let schema = params
        .get("requestedSchema")
        .ok_or("AGY elicitation missing requestedSchema")?;
    let properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .ok_or("AGY elicitation form has no properties")?;

    let mut ordered_keys: Vec<String> = Vec::new();
    let mut seen_keys: HashSet<String> = HashSet::new();
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for req_key in required.iter().filter_map(Value::as_str) {
            if properties.contains_key(req_key)
                && !is_write_in_partner(req_key, properties)
                && seen_keys.insert(req_key.to_string())
            {
                ordered_keys.push(req_key.to_string());
            }
        }
    }
    let mut extra_keys: Vec<&String> = properties
        .keys()
        .filter(|k| !is_write_in_partner(k, properties) && !seen_keys.contains(*k))
        .collect();
    extra_keys.sort_by(|a, b| numeric_q_index(a).cmp(&numeric_q_index(b)).then_with(|| a.cmp(b)));
    for k in extra_keys {
        ordered_keys.push(k.clone());
    }
    if ordered_keys.is_empty() {
        return Err("AGY elicitation form has no question fields".into());
    }

    let raw_message = params
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let prompt_lines: Vec<&str> = raw_message
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();

    let mut ui_questions = Vec::with_capacity(ordered_keys.len());
    let mut field_specs = Vec::with_capacity(ordered_keys.len());
    let mut seen_questions: HashSet<String> = HashSet::new();

    for (index, key) in ordered_keys.iter().enumerate() {
        let field = properties.get(key).ok_or("Missing AGY elicitation field")?;
        let write_in_key = format!("{key}_other");
        let has_write_in = properties.get(&write_in_key).is_some_and(|w| {
            w.get("type").and_then(Value::as_str) == Some("string")
        });
        let multi = field.get("type").and_then(Value::as_str) == Some("array");
        let raw_choices = extract_raw_choices(field, multi)
            .ok_or("Unsupported AGY elicitation field choices")?;

        let total_choices = raw_choices.len();
        let mut other_sentinel: Option<String> = None;
        let mut ui_options = Vec::with_capacity(total_choices);
        let mut spec_options = Vec::with_capacity(total_choices);
        let mut seen_labels: HashSet<String> = HashSet::new();

        for (raw_const, raw_title, raw_desc) in raw_choices {
            if has_write_in
                && other_sentinel.is_none()
                && is_other_sentinel(&raw_const, &raw_title, total_choices)
            {
                other_sentinel = Some(raw_const);
                continue;
            }
            let (mut label, desc) = if let Some(rest) = raw_title
                .strip_prefix("(Recommended)")
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                let merged_desc = match raw_desc.as_deref() {
                    Some(d) if !d.is_empty() => format!("Recommended · {d}"),
                    _ => "Recommended".to_string(),
                };
                (rest.to_string(), Some(merged_desc))
            } else {
                (raw_title, raw_desc)
            };
            if !seen_labels.insert(label.clone()) {
                label = raw_const.clone();
                seen_labels.insert(label.clone());
            }
            let mut ui_opt = Map::new();
            ui_opt.insert("label".into(), Value::String(label.clone()));
            if let Some(d) = desc {
                ui_opt.insert("description".into(), Value::String(d));
            }
            ui_options.push(Value::Object(ui_opt));
            spec_options.push(json!({
                "label": label,
                "value": raw_const,
            }));
        }
        if ui_options.is_empty() {
            return Err("AGY elicitation question has no selectable options".into());
        }

        let (header, mut question) = derive_header_and_question(
            index,
            key,
            field,
            &prompt_lines,
            ordered_keys.len(),
            raw_message,
        );
        if !seen_questions.insert(question.clone()) {
            question = format!("Q{} · {question}", index + 1);
            seen_questions.insert(question.clone());
        }
        let allow_other = !multi && has_write_in;
        ui_questions.push(json!({
            "question": question,
            "header": header,
            "multiSelect": multi,
            "allowOther": allow_other,
            "options": ui_options,
        }));
        field_specs.push(json!({
            "key": key,
            "question": question,
            "multiSelect": multi,
            "writeInKey": has_write_in.then_some(write_in_key),
            "otherSentinel": other_sentinel,
            "options": spec_options,
        }));
    }

    Ok((ui_questions, field_specs))
}

pub(super) fn park_elicitation_question(
    core: &TurnCore,
    state: &mut TurnState,
    id: &Value,
    params: &Value,
) -> Option<Value> {
    let (ui_questions, field_specs) = match parse_elicitation_form(params) {
        Ok(parsed) => parsed,
        Err(_) => return Some(jsonrpc_result_response(id, json!({ "action": "cancel" }))),
    };
    let request_id = jsonrpc_id_key(id).unwrap_or_else(|| id.to_string());
    let tool_use_id = params
        .get("toolCallId")
        .or_else(|| params.get("tool_call_id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    core.dispatch_event(state, EngineEvent::Activity("requires_action"));
    core.dispatch_event(
        state,
        EngineEvent::ApprovalQuestion {
            request_id,
            tool_use_id,
            input: json!({ "questions": ui_questions }),
            context: json!({
                "agyAcp": {
                    "rpcId": id,
                    "fields": field_specs,
                }
            }),
        },
    );
    None
}

pub(crate) fn answer_frame(context: &Value, answers: Option<&Value>) -> Result<Value, String> {
    let id = context
        .get("rpcId")
        .filter(|id| id.is_string() || id.is_number())
        .ok_or("Missing AGY ACP question request id")?;
    let Some(answers) = answers else {
        return Ok(jsonrpc_result_response(id, json!({ "action": "cancel" })));
    };
    let answers = answers
        .as_object()
        .ok_or("AGY question answers must be an object")?;
    let fields = context
        .get("fields")
        .and_then(Value::as_array)
        .ok_or("Missing AGY question field metadata")?;

    let mut content = Map::new();
    for field in fields {
        let key = field
            .get("key")
            .and_then(Value::as_str)
            .ok_or("Missing AGY field key")?;
        let question = field
            .get("question")
            .and_then(Value::as_str)
            .ok_or("Missing AGY question prompt")?;
        let answer = answers
            .get(question)
            .ok_or("Answer every question before submitting")?;
        let options = field
            .get("options")
            .and_then(Value::as_array)
            .ok_or("Missing AGY question choices")?;
        let multi = field.get("multiSelect").and_then(Value::as_bool) == Some(true);

        if multi {
            let picked = answer
                .as_array()
                .filter(|arr| !arr.is_empty())
                .ok_or("Select at least one option")?;
            let mut mapped = Vec::with_capacity(picked.len());
            for item in picked {
                let label = item.as_str().ok_or("Invalid multi-select option")?;
                let raw_val = options
                    .iter()
                    .find(|opt| opt.get("label").and_then(Value::as_str) == Some(label))
                    .and_then(|opt| opt.get("value").and_then(Value::as_str))
                    .ok_or("AGY multi-select only accepts declared choices")?;
                mapped.push(Value::String(raw_val.to_string()));
            }
            content.insert(key.to_string(), Value::Array(mapped));
        } else {
            let text = answer
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("Answer cannot be empty")?;
            if let Some(raw_val) = options
                .iter()
                .find(|opt| opt.get("label").and_then(Value::as_str) == Some(text))
                .and_then(|opt| opt.get("value").and_then(Value::as_str))
            {
                content.insert(key.to_string(), Value::String(raw_val.to_string()));
            } else if let Some(write_in_key) = field.get("writeInKey").and_then(Value::as_str) {
                content.insert(write_in_key.to_string(), Value::String(text.to_string()));
                if let Some(sentinel) = field.get("otherSentinel").and_then(Value::as_str) {
                    content.insert(key.to_string(), Value::String(sentinel.to_string()));
                }
            } else {
                return Err("This question only accepts one of the declared choices".into());
            }
        }
    }

    Ok(jsonrpc_result_response(
        id,
        json!({
            "action": "accept",
            "content": content,
        }),
    ))
}

// ==================== Background Task Tracking & Wakeup ====================

fn is_safe_id_token(raw: &str) -> bool {
    !raw.is_empty()
        && raw.len() <= 128
        && raw
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn lookup_profile_env<'a>(profile: &'a WorkerProfileKey, name: &str) -> Option<&'a str> {
    profile
        .env_pairs
        .iter()
        .rev()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.trim())
        .filter(|v| !v.is_empty())
}

pub(super) fn resolve_session_brain_dir(
    profile: &WorkerProfileKey,
    session_id: &str,
) -> Option<PathBuf> {
    let sid = session_id.trim();
    if !is_safe_id_token(sid) {
        return None;
    }
    let app_home = if let Some(dir) = lookup_profile_env(profile, "ANTIGRAVITY_APP_DATA_DIR")
        .or_else(|| lookup_profile_env(profile, "ANTIGRAVITY_HOME"))
    {
        PathBuf::from(dir)
    } else if let Some(user_home) = lookup_profile_env(profile, "USERPROFILE")
        .or_else(|| lookup_profile_env(profile, "HOME"))
    {
        PathBuf::from(user_home).join(".gemini/antigravity-cli")
    } else {
        crate::engine::agy::agy_home()
    };
    Some(app_home.join("brain").join(sid))
}

pub(super) fn pre_existing_transcript_len(
    profile: &WorkerProfileKey,
    session_id: Option<&str>,
) -> Option<u64> {
    let sid = session_id?;
    let brain = resolve_session_brain_dir(profile, sid)?;
    let transcript = brain
        .join(".system_generated")
        .join("logs")
        .join("transcript.jsonl");
    std::fs::metadata(transcript).ok().map(|m| m.len())
}

pub(super) fn resolve_session_db_path(profile: &WorkerProfileKey, session_id: &str) -> Option<PathBuf> {
    let brain = resolve_session_brain_dir(profile, session_id)?;
    let app_home = brain.parent()?.parent()?;
    Some(app_home.join("conversations").join(format!("{}.db", session_id.trim())))
}

#[derive(Clone, Debug)]
struct PendingBgCandidate {
    tool_id: String,
    tool_name: String,
    kind: String,
    description: String,
    has_explicit_label: bool,
    summary: Option<String>,
    ambient: bool,
    patched_timeline: bool,
}

#[derive(Clone, Debug)]
struct PendingSubagent {
    tool_id: String,
    description: String,
    summary: Option<String>,
}

#[derive(Clone, Debug)]
enum KillTarget {
    TaskIds(Vec<String>),
    AllSubagents,
}

#[derive(Clone, Debug)]
struct PendingKill {
    tool_id: String,
    target: KillTarget,
}

#[derive(Clone, Debug)]
struct TrackedTask {
    id: String,
    raw_id: String,
    kind: String,
    description: String,
    has_explicit_label: bool,
    status: String,
    tool_use_id: Option<String>,
    summary: Option<String>,
    progress: Option<String>,
    ambient: bool,
    log_path: Option<PathBuf>,
    last_log_len: Option<u64>,
}

impl TrackedTask {
    fn matches_id(&self, candidate: &str) -> bool {
        let trimmed = candidate.trim();
        if trimmed.is_empty() {
            return false;
        }
        let short = short_task_id(trimmed);
        self.id == trimmed || self.raw_id == trimmed || self.id == short
    }

    fn to_native_task(&self) -> NativeTask {
        NativeTask {
            id: self.id.clone(),
            kind: self.kind.clone(),
            description: self.description.clone(),
            status: self.status.clone(),
            tool_use_id: self.tool_use_id.clone(),
            summary: self.summary.clone(),
            progress: self.progress.clone(),
            background: Some(true),
            ambient: self.ambient.then_some(true),
        }
    }
}

pub(super) struct AgyAcpTaskTracker {
    session_id: String,
    brain_dir: Option<PathBuf>,
    transcript_offset: u64,
    pending_candidates: VecDeque<PendingBgCandidate>,
    pending_subagents: Vec<PendingSubagent>,
    pending_kills: Vec<PendingKill>,
    tasks: Vec<TrackedTask>,
    last_emitted: Vec<NativeTask>,
    pending_wakeup: bool,
    wakeup_since: Option<Instant>,
    seen_planner_steps: HashSet<u64>,
    seen_planner_tool_steps: HashSet<u64>,
    last_poll_at: Option<Instant>,
}

impl AgyAcpTaskTracker {
    pub(super) fn new(
        profile: &WorkerProfileKey,
        session_id: &str,
        initial_offset: Option<u64>,
    ) -> Self {
        let trimmed_sid = session_id.trim().to_string();
        Self {
            brain_dir: resolve_session_brain_dir(profile, &trimmed_sid),
            session_id: trimmed_sid,
            transcript_offset: initial_offset.unwrap_or(0),
            pending_candidates: VecDeque::new(),
            pending_subagents: Vec::new(),
            pending_kills: Vec::new(),
            tasks: Vec::new(),
            last_emitted: Vec::new(),
            pending_wakeup: false,
            wakeup_since: None,
            seen_planner_steps: HashSet::new(),
            seen_planner_tool_steps: HashSet::new(),
            last_poll_at: None,
        }
    }

    pub(super) fn has_running_non_ambient(&self) -> bool {
        self.tasks
            .iter()
            .any(|t| matches!(t.status.as_str(), "running" | "paused") && !t.ambient)
    }

    pub(super) fn has_pending_wakeup(&self) -> bool {
        self.pending_wakeup
    }

    pub(super) fn ready_to_wake(&self, now: Instant) -> bool {
        if !self.pending_wakeup {
            return false;
        }
        if !self.has_running_non_ambient() {
            return true;
        }
        self.wakeup_since
            .is_some_and(|since| now.saturating_duration_since(since) >= BG_WAKEUP_COALESCE)
    }

    pub(super) fn consume_wakeup(&mut self) {
        self.pending_wakeup = false;
        self.wakeup_since = None;
    }

    /// Inspect raw ACP `session/update` notifications so late `rawInput` on
    /// `tool_call_update` (`in_progress`) or display titles (`"RunCommand"` /
    /// `"Terminal"` with `kind: "execute"`) still capture `toolSummary` and
    /// `IsDaemon` metadata.
    pub(super) fn observe_session_update(&mut self, update: &Value) {
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !matches!(kind, "tool_call" | "tool_call_update") {
            return;
        }
        let tool_id = update
            .get("toolCallId")
            .or_else(|| update.get("id"))
            .or_else(|| update.get("tool_call_id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        if tool_id.is_empty() {
            return;
        }
        let names: Vec<&str> = ["name", "toolName", "title", "kind"]
            .into_iter()
            .filter_map(|k| update.get(k).and_then(Value::as_str))
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        let raw_input = update
            .get("rawInput")
            .or_else(|| update.get("input"))
            .or_else(|| update.get("arguments"))
            .filter(|v| !v.as_object().is_some_and(Map::is_empty));
        self.record_tool_invocation(tool_id, &names, raw_input);
    }

    pub(super) fn on_tool_started(&mut self, tool_id: &str, tool_name: &str, input: Option<&Value>) {
        self.record_tool_invocation(tool_id, &[tool_name], input);
    }

    fn record_tool_invocation(&mut self, tool_id: &str, names: &[&str], input: Option<&Value>) {
        let parsed = normalize_tool_args(input);
        let Some(classified) = classify_tracked_tool(names, parsed.as_ref()) else {
            return;
        };
        let display_tool_name = names
            .iter()
            .copied()
            .map(str::trim)
            .find(|s| !s.is_empty())
            .unwrap_or(classified);
        match classified {
            "run_command" => {
                let cmd = arg_str(parsed.as_ref(), &["CommandLine", "command", "cmd"]);
                let summary_label = arg_str(parsed.as_ref(), &["toolSummary", "description"]);
                let has_explicit_label = summary_label.is_some();
                let description = summary_label
                    .or_else(|| cmd.as_deref().map(summarize_bare_command))
                    .unwrap_or_else(|| "Background command".to_string());
                let summary = cmd.map(|c| truncate_chars(&c, 500));
                let ambient = arg_bool(parsed.as_ref(), &["IsDaemon"]).unwrap_or(false);
                self.upsert_bg_candidate(PendingBgCandidate {
                    tool_id: tool_id.to_string(),
                    tool_name: display_tool_name.to_string(),
                    kind: "command".to_string(),
                    description,
                    has_explicit_label,
                    summary,
                    ambient,
                    patched_timeline: false,
                });
            }
            "schedule" => {
                let prompt = arg_str(parsed.as_ref(), &["Prompt", "prompt"]);
                let cron = arg_str(parsed.as_ref(), &["CronExpression", "cron"]);
                let dur = arg_u64(parsed.as_ref(), &["DurationSeconds", "durationSeconds"]);
                let has_explicit_label = prompt.is_some() || cron.is_some();
                let description = prompt
                    .as_deref()
                    .map(|p| truncate_one_line(p, 96))
                    .or_else(|| cron.clone())
                    .unwrap_or_else(|| "Scheduled task".to_string());
                let summary = match (cron, dur, prompt) {
                    (Some(c), _, Some(p)) => Some(truncate_chars(&format!("{c} · {p}"), 500)),
                    (_, Some(s), Some(p)) => Some(truncate_chars(&format!("{s}s · {p}"), 500)),
                    (_, _, Some(p)) => Some(truncate_chars(&p, 500)),
                    (Some(c), _, None) => Some(c),
                    (_, Some(s), None) => Some(format!("{s}s")),
                    (None, None, None) => None,
                };
                let ambient = arg_bool(parsed.as_ref(), &["IsDaemon"]).unwrap_or(false);
                self.upsert_bg_candidate(PendingBgCandidate {
                    tool_id: tool_id.to_string(),
                    tool_name: display_tool_name.to_string(),
                    kind: "monitor".to_string(),
                    description,
                    has_explicit_label,
                    summary,
                    ambient,
                    patched_timeline: false,
                });
            }
            "invoke_subagent" => {
                let role = arg_str(parsed.as_ref(), &["Role", "role", "TypeName", "typeName"])
                    .unwrap_or_else(|| "Subagent".to_string());
                let summary = arg_str(parsed.as_ref(), &["Prompt", "prompt"])
                    .map(|p| truncate_chars(&p, 500));
                self.upsert_subagent_candidate(PendingSubagent {
                    tool_id: tool_id.to_string(),
                    description: truncate_one_line(&role, 96),
                    summary,
                });
            }
            "manage_task" => {
                let action = arg_str(parsed.as_ref(), &["Action", "action"]).unwrap_or_default();
                if action.eq_ignore_ascii_case("kill") {
                    if let Some(target) = arg_str(parsed.as_ref(), &["TaskId", "taskId"]) {
                        self.upsert_kill_candidate(PendingKill {
                            tool_id: tool_id.to_string(),
                            target: KillTarget::TaskIds(vec![target]),
                        });
                    }
                }
            }
            "manage_subagents" => {
                let action = arg_str(parsed.as_ref(), &["Action", "action"]).unwrap_or_default();
                if action.eq_ignore_ascii_case("kill_all") {
                    self.upsert_kill_candidate(PendingKill {
                        tool_id: tool_id.to_string(),
                        target: KillTarget::AllSubagents,
                    });
                } else if action.eq_ignore_ascii_case("kill") {
                    let ids =
                        arg_str_vec(parsed.as_ref(), &["ConversationIds", "conversationIds"]);
                    if !ids.is_empty() {
                        self.upsert_kill_candidate(PendingKill {
                            tool_id: tool_id.to_string(),
                            target: KillTarget::TaskIds(ids),
                        });
                    }
                }
            }
            _ => {}
        }
    }

    fn upsert_bg_candidate(&mut self, incoming: PendingBgCandidate) {
        if let Some(existing_task) = self.tasks.iter_mut().find(|task| {
            (!incoming.tool_id.is_empty() && task.tool_use_id.as_deref() == Some(&incoming.tool_id))
                || (task.kind == incoming.kind
                    && !task.has_explicit_label
                    && summaries_compatible(task.summary.as_deref(), incoming.summary.as_deref()))
        }) {
            if !matches!(
                existing_task.status.as_str(),
                "completed" | "failed" | "stopped"
            ) {
                if incoming.has_explicit_label || !existing_task.has_explicit_label {
                    existing_task.description = incoming.description;
                    existing_task.has_explicit_label |= incoming.has_explicit_label;
                }
                if existing_task.summary.is_none() {
                    existing_task.summary = incoming.summary;
                }
                if existing_task.tool_use_id.is_none() && !incoming.tool_id.is_empty() {
                    existing_task.tool_use_id = Some(incoming.tool_id);
                }
                existing_task.ambient |= incoming.ambient;
            }
            return;
        }

        let match_idx = if !incoming.tool_id.is_empty() {
            self.pending_candidates
                .iter()
                .position(|c| c.tool_id == incoming.tool_id)
                .or_else(|| {
                    self.pending_candidates.iter().position(|c| {
                        c.tool_id.is_empty()
                            && c.kind == incoming.kind
                            && (summaries_compatible(c.summary.as_deref(), incoming.summary.as_deref())
                                || incoming.summary.is_none())
                    })
                })
        } else {
            self.pending_candidates.iter().position(|c| {
                if c.kind != incoming.kind {
                    return false;
                }
                if c.tool_id.is_empty() {
                    return c.description == incoming.description && c.summary == incoming.summary;
                }
                summaries_compatible(c.summary.as_deref(), incoming.summary.as_deref())
                    || (!c.has_explicit_label && c.summary.is_none() && incoming.summary.is_some())
            })
        };

        if let Some(idx) = match_idx {
            let existing = &mut self.pending_candidates[idx];
            if existing.tool_id.is_empty() && !incoming.tool_id.is_empty() {
                existing.tool_id = incoming.tool_id;
            }
            if incoming.has_explicit_label || !existing.has_explicit_label {
                existing.description = incoming.description;
                existing.has_explicit_label |= incoming.has_explicit_label;
            }
            if incoming.summary.is_some() {
                existing.summary = incoming.summary;
            }
            existing.ambient |= incoming.ambient;
            return;
        }

        self.pending_candidates.push_back(incoming);
    }

    fn upsert_subagent_candidate(&mut self, incoming: PendingSubagent) {
        if !incoming.tool_id.is_empty() {
            if let Some(existing) = self
                .pending_subagents
                .iter_mut()
                .find(|s| s.tool_id == incoming.tool_id || s.tool_id.is_empty())
            {
                if existing.tool_id.is_empty() {
                    existing.tool_id = incoming.tool_id;
                }
                existing.description = incoming.description;
                if incoming.summary.is_some() {
                    existing.summary = incoming.summary;
                }
                return;
            }
        } else if self.pending_subagents.iter().any(|s| {
            s.description == incoming.description && s.summary == incoming.summary
        }) {
            return;
        }
        self.pending_subagents.push(incoming);
    }

    fn upsert_kill_candidate(&mut self, incoming: PendingKill) {
        if !incoming.tool_id.is_empty() {
            if let Some(existing) = self
                .pending_kills
                .iter_mut()
                .find(|k| k.tool_id == incoming.tool_id)
            {
                existing.target = incoming.target;
                return;
            }
        }
        self.pending_kills.push(incoming);
    }

    fn apply_kill_target(&mut self, target: &KillTarget) {
        for task in &mut self.tasks {
            if !matches!(task.status.as_str(), "running" | "paused") {
                continue;
            }
            let matched = match target {
                KillTarget::AllSubagents => task.kind == "subagent",
                KillTarget::TaskIds(ids) => ids.iter().any(|id| task.matches_id(id)),
            };
            if matched {
                task.status = "stopped".to_string();
                task.last_log_len = None;
            }
        }
    }

    pub(super) fn on_tool_completed(
        &mut self,
        core: &TurnCore,
        state: &mut TurnState,
        tool_id: &str,
        output: Option<&Value>,
        is_error: bool,
    ) {
        let out_text = output.map(extract_value_text).unwrap_or_default();

        if let Some(pos) = self
            .pending_candidates
            .iter()
            .position(|c| c.tool_id == tool_id)
        {
            let mut candidate = self.pending_candidates.remove(pos).unwrap();
            candidate.patched_timeline = true;
            if !is_error && extract_owned_bg_task_id(&out_text, &self.session_id).is_some() {
                self.adopt_running_task_from_text(core, state, &out_text, Some(candidate));
                self.emit_if_changed(core, state);
                return;
            }
            // Completed synchronously within `WaitMsBeforeAsync`; not a background task.
        } else if !is_error && extract_owned_bg_task_id(&out_text, &self.session_id).is_some() {
            self.adopt_running_task_from_text(core, state, &out_text, None);
            self.emit_if_changed(core, state);
            return;
        }

        if let Some(pos) = self
            .pending_subagents
            .iter()
            .position(|s| s.tool_id == tool_id)
        {
            let sub = self.pending_subagents.remove(pos);
            if !is_error {
                if let Some(conv_id) = extract_subagent_conversation_id(output, &out_text) {
                    self.upsert_task(TrackedTask {
                        id: conv_id.clone(),
                        raw_id: conv_id,
                        kind: "subagent".to_string(),
                        description: sub.description,
                        has_explicit_label: true,
                        status: "running".to_string(),
                        tool_use_id: Some(sub.tool_id),
                        summary: sub.summary,
                        progress: None,
                        ambient: false,
                        log_path: None,
                        last_log_len: None,
                    });
                    self.emit_if_changed(core, state);
                }
            }
        }

        if let Some(pos) = self.pending_kills.iter().position(|k| k.tool_id == tool_id) {
            let kill = self.pending_kills.remove(pos);
            if !is_error {
                self.apply_kill_target(&kill.target);
                self.emit_if_changed(core, state);
            }
        }
    }

    pub(super) fn poll(&mut self, core: &TurnCore, state: &mut TurnState) -> Vec<u64> {
        self.last_poll_at = Some(Instant::now());
        let Some(brain_dir) = self.brain_dir.clone() else {
            return Vec::new();
        };
        let transcript_path = brain_dir
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl");
        let lines = read_new_jsonl_lines(&transcript_path, &mut self.transcript_offset);
        let mut committed_output_tokens = Vec::new();
        for line in lines {
            let Ok(step) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            self.process_transcript_step(core, state, &step, &mut committed_output_tokens);
        }
        self.refresh_task_logs();
        self.emit_if_changed(core, state);
        committed_output_tokens
    }

    pub(super) fn poll_throttled(
        &mut self,
        core: &TurnCore,
        state: &mut TurnState,
        now: Instant,
        min_interval: Duration,
    ) -> Vec<u64> {
        if self
            .last_poll_at
            .is_some_and(|prev| now.saturating_duration_since(prev) < min_interval)
        {
            return Vec::new();
        }
        self.poll(core, state)
    }

    pub(super) fn mark_running_stopped(&mut self, core: &TurnCore, state: &mut TurnState) {
        for task in &mut self.tasks {
            if matches!(task.status.as_str(), "running" | "paused") {
                task.status = "stopped".to_string();
            }
        }
        self.pending_wakeup = false;
        self.wakeup_since = None;
        self.emit_if_changed(core, state);
    }

    fn process_transcript_step(
        &mut self,
        core: &TurnCore,
        state: &mut TurnState,
        step: &Value,
        committed_output_tokens: &mut Vec<u64>,
    ) {
        let step_type = step.get("type").and_then(Value::as_str).unwrap_or("");
        let source = step.get("source").and_then(Value::as_str).unwrap_or("");
        let status = step.get("status").and_then(Value::as_str).unwrap_or("");
        let content = step.get("content").and_then(Value::as_str).unwrap_or("");

        if step_type == "PLANNER_RESPONSE" {
            // The planner step has consumed all preceding `<SYSTEM_MESSAGE>` entries
            // in the trajectory; clear any earlier wakeup latch.
            self.pending_wakeup = false;
            self.wakeup_since = None;

            let should_ingest_tools = match step.get("step_index").and_then(Value::as_u64) {
                Some(idx) => {
                    !self.seen_planner_tool_steps.contains(&idx)
                        && self.seen_planner_tool_steps.len() < 4096
                        && self.seen_planner_tool_steps.insert(idx)
                }
                None => true,
            };
            if should_ingest_tools {
                if let Some(tool_calls) = step
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .filter(|calls| !calls.is_empty())
                {
                    self.pending_candidates.retain(|c| !c.tool_id.is_empty());
                    self.pending_subagents.retain(|s| !s.tool_id.is_empty());
                    self.pending_kills.retain(|k| !k.tool_id.is_empty());
                    for call in tool_calls {
                        let call_id = call
                            .get("id")
                            .or_else(|| call.get("toolCallId"))
                            .and_then(Value::as_str)
                            .unwrap_or("");
                        let name = call.get("name").and_then(Value::as_str).unwrap_or("");
                        let args = call
                            .get("args")
                            .or_else(|| call.get("arguments"))
                            .or_else(|| call.get("input"));
                        self.record_tool_invocation(call_id, &[name], args);
                    }
                }
            }

            if status == "DONE" && (source.is_empty() || source == "MODEL") {
                if let Some(tokens) = step
                    .get("output_tokens")
                    .and_then(Value::as_u64)
                    .filter(|&n| n <= crate::engine::throughput_common::MAX_SAFE_INTEGER)
                {
                    let should_record = match step.get("step_index").and_then(Value::as_u64) {
                        Some(idx) => {
                            !self.seen_planner_steps.contains(&idx)
                                && self.seen_planner_steps.len() < 4096
                                && self.seen_planner_steps.insert(idx)
                        }
                        None => true,
                    };
                    if should_record {
                        committed_output_tokens.push(tokens);
                    }
                }
            }
            return;
        }

        if matches!(step_type, "CHECKPOINT" | "USER_INPUT") {
            return;
        }

        if step_type != "SYSTEM_MESSAGE"
            && (status == "RUNNING" || status.is_empty())
            && extract_owned_bg_task_id(content, &self.session_id).is_some()
        {
            self.adopt_running_task_from_text(core, state, content, None);
            return;
        }

        if step_type != "SYSTEM_MESSAGE" && status == "DONE" {
            if self.pending_subagents.iter().any(|s| s.tool_id.is_empty()) {
                if let Some(conv_id) = extract_subagent_conversation_id(None, content) {
                    if !self.tasks.iter().any(|t| t.id == conv_id) {
                        if let Some(pos) =
                            self.pending_subagents.iter().position(|s| s.tool_id.is_empty())
                        {
                            let sub = self.pending_subagents.remove(pos);
                            self.upsert_task(TrackedTask {
                                id: conv_id.clone(),
                                raw_id: conv_id,
                                kind: "subagent".to_string(),
                                description: sub.description,
                                has_explicit_label: true,
                                status: "running".to_string(),
                                tool_use_id: None,
                                summary: sub.summary,
                                progress: None,
                                ambient: false,
                                log_path: None,
                                last_log_len: None,
                            });
                        }
                    }
                }
            }
            let matched_kill_positions: Vec<usize> = self
                .pending_kills
                .iter()
                .enumerate()
                .filter(|(_, k)| k.tool_id.is_empty() && kill_output_matches(&k.target, content))
                .map(|(idx, _)| idx)
                .collect();
            for pos in matched_kill_positions.into_iter().rev() {
                let kill = self.pending_kills.remove(pos);
                self.apply_kill_target(&kill.target);
            }
        }

        if step_type == "SYSTEM_MESSAGE" || source == "SYSTEM" {
            self.process_system_message(content);
        }
    }

    fn adopt_running_task_from_text(
        &mut self,
        core: &TurnCore,
        state: &mut TurnState,
        content: &str,
        explicit_candidate: Option<PendingBgCandidate>,
    ) {
        let Some((raw_id, short_id)) = extract_owned_bg_task_id(content, &self.session_id) else {
            return;
        };

        let task_desc_in_log = extract_task_description_block(content);

        // ACP results and the transcript describe the same task. A replay must
        // not consume another tool's candidate or overwrite an explicit label,
        // while a late transcript-derived explicit label may upgrade an unnamed row.
        if explicit_candidate.is_none() {
            if let Some(existing) = self.tasks.iter().find(|t| t.id == short_id) {
                if existing.has_explicit_label {
                    return;
                }
                let upgrade_idx = self.pending_candidates.iter().position(|c| {
                    c.has_explicit_label
                        && c.kind == existing.kind
                        && summaries_compatible(
                            c.summary.as_deref(),
                            task_desc_in_log.as_deref().or(existing.summary.as_deref()),
                        )
                });
                let Some(idx) = upgrade_idx else {
                    return;
                };
                let cand = self.pending_candidates.remove(idx).unwrap();
                self.adopt_with_candidate(core, state, raw_id, short_id, Some(cand), task_desc_in_log);
                return;
            }
        }

        let candidate = explicit_candidate.or_else(|| {
            if let Some(ref desc) = task_desc_in_log {
                let trimmed_desc = desc.trim();
                let first_line = trimmed_desc.lines().next().unwrap_or("").trim();
                if let Some(pos) = self.pending_candidates.iter().position(|c| {
                    summaries_compatible(c.summary.as_deref(), Some(trimmed_desc))
                        || (!first_line.is_empty()
                            && summaries_compatible(c.summary.as_deref(), Some(first_line)))
                }) {
                    return self.pending_candidates.remove(pos);
                }
                if self
                    .pending_candidates
                    .front()
                    .is_some_and(|c| c.summary.is_none())
                {
                    return self.pending_candidates.pop_front();
                }
                return None;
            }
            self.pending_candidates.pop_front()
        });

        self.adopt_with_candidate(core, state, raw_id, short_id, candidate, task_desc_in_log);
    }

    fn adopt_with_candidate(
        &mut self,
        core: &TurnCore,
        state: &mut TurnState,
        raw_id: String,
        short_id: String,
        candidate: Option<PendingBgCandidate>,
        task_desc_in_log: Option<String>,
    ) {
        let (kind, description, has_explicit_label, summary, ambient, tool_use_id) = match candidate
        {
            Some(mut cand) => {
                if !cand.patched_timeline && !cand.tool_name.is_empty() {
                    cand.patched_timeline = true;
                    let patch = json!({
                        "status": "running_in_background",
                        "taskId": short_id,
                    });
                    core.dispatch_event(state, tool_result_patch(cand.tool_name, Some(&patch)));
                }
                (
                    cand.kind,
                    cand.description,
                    cand.has_explicit_label,
                    cand.summary,
                    cand.ambient,
                    (!cand.tool_id.is_empty()).then_some(cand.tool_id),
                )
            }
            None => {
                let fallback_desc = task_desc_in_log
                    .as_deref()
                    .map(summarize_bare_command)
                    .filter(|d| !d.is_empty())
                    .unwrap_or_else(|| short_id.clone());
                let fallback_sum = task_desc_in_log.map(|d| truncate_chars(&d, 500));
                (
                    "command".to_string(),
                    fallback_desc,
                    false,
                    fallback_sum,
                    false,
                    None,
                )
            }
        };

        let log_path = self
            .brain_dir
            .as_ref()
            .map(|brain| resolve_confined_task_log(brain, &short_id));

        self.upsert_task(TrackedTask {
            id: short_id,
            raw_id,
            kind,
            description,
            has_explicit_label,
            status: "running".to_string(),
            tool_use_id,
            summary,
            progress: None,
            ambient,
            log_path,
            last_log_len: None,
        });
    }

    fn process_system_message(&mut self, content: &str) {
        let sender = extract_token_after(content, "sender=");
        let quoted_task = extract_quoted_after(content, "Task id \"");
        let matched_idx = self.tasks.iter().position(|t| {
            sender.as_deref().is_some_and(|s| t.matches_id(s))
                || quoted_task.as_deref().is_some_and(|q| t.matches_id(q))
        });

        let Some(idx) = matched_idx else {
            if is_global_tasks_stopped_notice(content, sender.as_deref()) {
                for task in &mut self.tasks {
                    if matches!(task.status.as_str(), "running" | "paused" | "unknown") {
                        task.status = "stopped".to_string();
                        task.last_log_len = None;
                    }
                }
                self.pending_wakeup = false;
                self.wakeup_since = None;
            }
            return;
        };

        let new_status = classify_system_message_status(content, &self.tasks[idx]);
        let ambient = self.tasks[idx].ambient;
        if let Some(status) = new_status {
            if matches!(self.tasks[idx].status.as_str(), "running" | "paused" | "unknown") {
                self.tasks[idx].status = status.to_string();
            }
        }
        // Force a final log read on completion even if metadata cached the old length.
        self.tasks[idx].last_log_len = None;

        if !ambient {
            self.pending_wakeup = true;
            if self.wakeup_since.is_none() {
                self.wakeup_since = Some(Instant::now());
            }
        }
    }

    fn refresh_task_logs(&mut self) {
        for task in &mut self.tasks {
            let Some(ref path) = task.log_path else {
                continue;
            };
            let Ok(meta) = std::fs::metadata(path) else {
                continue;
            };
            let len = meta.len();
            if task.last_log_len == Some(len) {
                continue;
            }
            task.last_log_len = Some(len);
            if let Some(tail) = read_clean_log_tail(path, len) {
                task.progress = Some(tail);
            }
        }
    }

    fn upsert_task(&mut self, incoming: TrackedTask) {
        if let Some(existing) = self.tasks.iter_mut().find(|t| t.id == incoming.id) {
            if matches!(existing.status.as_str(), "completed" | "failed" | "stopped") {
                return;
            }
            existing.raw_id = incoming.raw_id;
            existing.kind = incoming.kind;
            if incoming.has_explicit_label || !existing.has_explicit_label {
                existing.description = incoming.description;
                existing.has_explicit_label |= incoming.has_explicit_label;
            }
            existing.summary = incoming.summary.or_else(|| existing.summary.take());
            existing.tool_use_id = incoming.tool_use_id.or_else(|| existing.tool_use_id.take());
            existing.ambient |= incoming.ambient;
            if existing.log_path.is_none() {
                existing.log_path = incoming.log_path;
            }
            return;
        }
        self.tasks.push(incoming);
    }

    fn emit_if_changed(&mut self, core: &TurnCore, state: &mut TurnState) {
        if self.tasks.is_empty() {
            return;
        }
        let snapshot: Vec<NativeTask> = self.tasks.iter().map(TrackedTask::to_native_task).collect();
        if snapshot != self.last_emitted {
            self.last_emitted = snapshot.clone();
            core.dispatch_event(state, EngineEvent::Tasks(snapshot));
        }
    }
}

pub(super) fn settle_running_tasks_stopped(core: &TurnCore, state: &mut TurnState) {
    let mut updated = state.tasks.clone();
    let mut changed = false;
    for task in &mut updated {
        if matches!(task.status.as_str(), "running" | "paused") {
            task.status = "stopped".to_string();
            changed = true;
        }
    }
    if changed {
        core.dispatch_event(state, EngineEvent::Tasks(updated));
    }
}

// ==================== Parsing Helpers ====================

fn canonical_tool_key(raw: &str) -> String {
    let trimmed = raw.trim();
    let tail = trimmed
        .rsplit_once("__")
        .map(|(_, name)| name)
        .or_else(|| trimmed.rsplit_once('.').map(|(_, name)| name))
        .unwrap_or(trimmed);
    tail.chars()
        .filter(|c| !matches!(c, '_' | '-') && !c.is_whitespace())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

fn normalize_tool_args(raw: Option<&Value>) -> Option<Value> {
    let mut val = raw.and_then(parse_tool_args_value)?;
    if let Value::Object(ref mut map) = val {
        for value in map.values_mut() {
            if let Value::String(s) = value {
                let trimmed = s.trim();
                if (trimmed.starts_with('"') && trimmed.ends_with('"'))
                    || (trimmed.starts_with('[') && trimmed.ends_with(']'))
                    || (trimmed.starts_with('{') && trimmed.ends_with('}'))
                {
                    if let Ok(decoded) = serde_json::from_str::<Value>(trimmed) {
                        *value = decoded;
                    }
                }
            }
        }
    }
    Some(val)
}

fn classify_tracked_tool(names: &[&str], parsed_args: Option<&Value>) -> Option<&'static str> {
    for raw_name in names {
        match canonical_tool_key(raw_name).as_str() {
            "runcommand" => return Some("run_command"),
            "schedule" => return Some("schedule"),
            "invokesubagent" => return Some("invoke_subagent"),
            "managetask" => return Some("manage_task"),
            "managesubagents" => return Some("manage_subagents"),
            _ => {}
        }
    }
    let obj = parsed_args.and_then(Value::as_object)?;
    if obj.contains_key("CommandLine")
        || ((obj.contains_key("command") || obj.contains_key("cmd"))
            && (obj.contains_key("WaitMsBeforeAsync")
                || obj.contains_key("IsDaemon")
                || names.iter().any(|n| n.trim().eq_ignore_ascii_case("execute"))))
    {
        return Some("run_command");
    }
    if (obj.contains_key("CronExpression") || obj.contains_key("DurationSeconds"))
        && obj.contains_key("Prompt")
    {
        return Some("schedule");
    }
    if obj.contains_key("TypeName") && (obj.contains_key("Role") || obj.contains_key("Prompt")) {
        return Some("invoke_subagent");
    }
    if obj.contains_key("Action") && obj.contains_key("TaskId") {
        return Some("manage_task");
    }
    if obj.contains_key("Action")
        && (obj.contains_key("ConversationIds")
            || arg_str(parsed_args, &["Action", "action"])
                .is_some_and(|a| a.eq_ignore_ascii_case("kill_all")))
    {
        return Some("manage_subagents");
    }
    None
}

fn summaries_compatible(a: Option<&str>, b: Option<&str>) -> bool {
    let (Some(sa), Some(sb)) = (a.map(str::trim).filter(|s| !s.is_empty()), b.map(str::trim).filter(|s| !s.is_empty())) else {
        return false;
    };
    if sa == sb {
        return true;
    }
    let prefix_a = sa.trim_end_matches('…');
    let prefix_b = sb.trim_end_matches('…');
    if (sa.ends_with('…') && sb.starts_with(prefix_a))
        || (sb.ends_with('…') && sa.starts_with(prefix_b))
    {
        return true;
    }
    let line_a = sa.lines().next().unwrap_or("").trim();
    let line_b = sb.lines().next().unwrap_or("").trim();
    !line_a.is_empty() && !line_b.is_empty() && (sa.contains(line_b) || sb.contains(line_a))
}

fn summarize_bare_command(raw: &str) -> String {
    let non_empty: Vec<&str> = raw
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if non_empty.is_empty() {
        return String::new();
    }
    if non_empty.len() == 1 && non_empty[0].chars().count() <= 48 {
        return non_empty[0].to_string();
    }

    let mut target_line = non_empty[0];
    if target_line.starts_with("@'") || target_line.starts_with("@\"") {
        if let Some(piped) = non_empty
            .iter()
            .find_map(|line| {
                let rest = line
                    .strip_prefix("'@")
                    .or_else(|| line.strip_prefix("\"@"))?
                    .trim_start();
                rest.strip_prefix('|').map(str::trim).filter(|s| !s.is_empty())
            })
        {
            target_line = piped;
        } else if let Some(next_line) = non_empty
            .iter()
            .copied()
            .find(|l| !l.starts_with("@'") && !l.starts_with("@\"") && *l != "'@" && *l != "\"@")
        {
            target_line = next_line;
        }
    }

    if let Some(short) = compact_command_head(target_line) {
        return short;
    }
    truncate_chars(target_line, 48)
}

fn compact_command_head(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let (raw_exe, mut rest) = if let Some(q @ ('"' | '\'')) = trimmed.chars().next() {
        let after = &trimmed[1..];
        let end = after.find(q)?;
        (&after[..end], after[end + 1..].trim_start())
    } else {
        let mut split = trimmed.splitn(2, char::is_whitespace);
        (split.next()?, split.next().unwrap_or("").trim_start())
    };
    let base = raw_exe
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(raw_exe);
    let mut exe = base.to_string();
    for ext in [".exe", ".cmd", ".bat", ".ps1"] {
        if exe.len() > ext.len() && exe[exe.len() - ext.len()..].eq_ignore_ascii_case(ext) {
            exe.truncate(exe.len() - ext.len());
            break;
        }
    }
    if exe.is_empty() || exe.chars().count() > 32 {
        return None;
    }

    let mut parts = vec![exe];
    let mut skip_next = false;
    while !rest.is_empty() && parts.len() < 3 {
        if rest.starts_with([';', '|', '&', '>', '<', '"', '\'', '$', '(']) {
            break;
        }
        let mut split = rest.splitn(2, char::is_whitespace);
        let tok = split.next().unwrap_or("");
        rest = split.next().unwrap_or("").trim_start();
        if tok.is_empty() {
            break;
        }
        if skip_next {
            skip_next = false;
            continue;
        }
        if tok.contains(';') || tok.contains('|') || tok.contains('&') {
            let head = tok.split([';', '|', '&']).next().unwrap_or("");
            if !head.is_empty() {
                parts.push(truncate_chars(head, 24));
            }
            break;
        }
        if matches!(tok, "--prefix" | "-C" | "--cwd" | "--manifest-path" | "--dir") {
            skip_next = true;
            continue;
        }
        if matches!(tok, "-c" | "-e")
            || tok.eq_ignore_ascii_case("-Command")
            || tok.eq_ignore_ascii_case("-EncodedCommand")
            || tok.eq_ignore_ascii_case("-File")
        {
            parts.push(tok.to_string());
            break;
        }
        if tok.starts_with('-') && tok.contains('=') {
            continue;
        }
        parts.push(truncate_chars(tok, 24));
    }
    Some(parts.join(" "))
}

fn extract_owned_bg_task_id(content: &str, session_id: &str) -> Option<(String, String)> {
    const MARKER: &str = "Tool is running as a background task with task id:";
    let expected_sid = session_id.trim();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("Created At: ") {
            continue;
        }
        if trimmed.starts_with("Completed At: ") {
            return None;
        }
        let rest = trimmed.strip_prefix(MARKER)?;
        let raw_id = rest.trim();
        if raw_id.is_empty()
            || raw_id.chars().any(|c| {
                c.is_whitespace()
                    || matches!(c, '"' | '\'' | ',' | ';' | '(' | ')' | '[' | ']' | '{' | '}' | '`')
            })
        {
            return None;
        }
        if let Some((owner_sid, short_id)) = raw_id.split_once('/') {
            if !expected_sid.is_empty() && owner_sid != expected_sid {
                return None;
            }
            if !is_safe_id_token(owner_sid) || !is_safe_id_token(short_id) {
                return None;
            }
            return Some((raw_id.to_string(), short_id.to_string()));
        }
        if !is_safe_id_token(raw_id) {
            return None;
        }
        return Some((raw_id.to_string(), raw_id.to_string()));
    }
    None
}

fn is_global_tasks_stopped_notice(content: &str, sender: Option<&str>) -> bool {
    if sender.is_some_and(|s| !s.eq_ignore_ascii_case("system")) {
        return false;
    }
    let lower = content.to_ascii_lowercase();
    lower.contains("all your subagents and background tasks have been stopped")
        || (lower.contains("background tasks")
            && lower.contains("have been stopped")
            && (lower.contains("server restart") || lower.contains("all your")))
}

fn kill_output_matches(target: &KillTarget, content: &str) -> bool {
    let lower = content.to_ascii_lowercase();
    match target {
        KillTarget::AllSubagents => {
            lower.contains("subagent")
                || lower.contains("killed")
                || lower.contains("stopped")
                || lower.contains("terminated")
        }
        KillTarget::TaskIds(ids) => {
            lower.contains("cancelled")
                || lower.contains("canceled")
                || lower.contains("killed")
                || ids
                    .iter()
                    .any(|id| content.contains(id.trim()) || content.contains(&short_task_id(id)))
        }
    }
}

fn arg_str(args: Option<&Value>, keys: &[&str]) -> Option<String> {
    let obj = args?.as_object()?;
    for key in keys {
        if let Some(val) = obj.get(*key).and_then(Value::as_str) {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn arg_str_vec(args: Option<&Value>, keys: &[&str]) -> Vec<String> {
    let Some(obj) = args.and_then(Value::as_object) else {
        return Vec::new();
    };
    for key in keys {
        let Some(val) = obj.get(*key) else {
            continue;
        };
        let items: Option<Vec<Value>> = if let Some(arr) = val.as_array() {
            Some(arr.clone())
        } else if let Some(s) = val.as_str() {
            serde_json::from_str::<Value>(s.trim())
                .ok()
                .and_then(|v| v.as_array().cloned())
        } else {
            None
        };
        if let Some(arr) = items {
            let out: Vec<String> = arr
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect();
            if !out.is_empty() {
                return out;
            }
        }
    }
    Vec::new()
}

fn arg_bool(args: Option<&Value>, keys: &[&str]) -> Option<bool> {
    let obj = args?.as_object()?;
    for key in keys {
        if let Some(val) = obj.get(*key) {
            if let Some(b) = val.as_bool() {
                return Some(b);
            }
            if let Some(s) = val.as_str() {
                if s.eq_ignore_ascii_case("true") {
                    return Some(true);
                }
                if s.eq_ignore_ascii_case("false") {
                    return Some(false);
                }
            }
        }
    }
    None
}

fn arg_u64(args: Option<&Value>, keys: &[&str]) -> Option<u64> {
    let obj = args?.as_object()?;
    for key in keys {
        if let Some(val) = obj.get(*key) {
            if let Some(n) = val.as_u64() {
                return Some(n);
            }
            if let Some(s) = val.as_str().and_then(|s| s.trim().parse::<u64>().ok()) {
                return Some(s);
            }
        }
    }
    None
}

fn truncate_one_line(raw: &str, max_chars: usize) -> String {
    let first = raw
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    truncate_chars(first, max_chars)
}

fn truncate_chars(raw: &str, max_chars: usize) -> String {
    let trimmed = raw.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max_chars.saturating_sub(1)).collect();
    out.push('…');
    out
}

fn short_task_id(raw_id: &str) -> String {
    raw_id
        .trim()
        .rsplit('/')
        .next()
        .unwrap_or(raw_id.trim())
        .to_string()
}

fn resolve_confined_task_log(brain_dir: &Path, short_id: &str) -> PathBuf {
    brain_dir
        .join(".system_generated")
        .join("tasks")
        .join(format!("{short_id}.log"))
}

fn extract_value_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(extract_value_text)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(map) => {
            if let Some(text) = map.get("text").and_then(Value::as_str) {
                return text.to_string();
            }
            if let Some(content) = map.get("content") {
                let inner = extract_value_text(content);
                if !inner.is_empty() {
                    return inner;
                }
            }
            serde_json::to_string(value).unwrap_or_default()
        }
        other => other.to_string(),
    }
}

fn extract_subagent_conversation_id(output: Option<&Value>, out_text: &str) -> Option<String> {
    if let Some(val) = output {
        if let Some(id) = val
            .get("conversationId")
            .or_else(|| val.get("conversation_id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| is_safe_id_token(s))
        {
            return Some(id.to_string());
        }
    }
    if let Ok(parsed) = serde_json::from_str::<Value>(out_text.trim()) {
        if let Some(id) = parsed
            .get("conversationId")
            .or_else(|| parsed.get("conversation_id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| is_safe_id_token(s))
        {
            return Some(id.to_string());
        }
    }
    for prefix in ["conversationId:", "conversationId=", "conversation_id:"] {
        if let Some(tok) = extract_after_prefix(out_text, prefix) {
            let clean = tok.trim_matches(|c: char| matches!(c, '"' | '\'' | ',' | '.'));
            if is_safe_id_token(clean) {
                return Some(clean.to_string());
            }
        }
    }
    None
}

fn extract_after_prefix(text: &str, prefix: &str) -> Option<String> {
    let (_, rest) = text.split_once(prefix)?;
    let token = rest
        .trim_start()
        .split(|c: char| c.is_whitespace() || matches!(c, '"' | '\''))
        .find(|s| !s.is_empty())?;
    Some(token.to_string())
}

fn extract_token_after(text: &str, key: &str) -> Option<String> {
    let (_, rest) = text.split_once(key)?;
    let token = rest
        .split(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '>' | ']'))
        .next()?
        .trim();
    (!token.is_empty()).then(|| token.to_string())
}

fn extract_quoted_after(text: &str, prefix: &str) -> Option<String> {
    let (_, rest) = text.split_once(prefix)?;
    let (inside, _) = rest.split_once('"')?;
    let trimmed = inside.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn extract_task_description_block(content: &str) -> Option<String> {
    let (_, rest) = content.split_once("Task Description:")?;
    let body = if let Some((before_logs, _)) = rest.split_once("\nTask logs are available at:") {
        before_logs
    } else if let Some((before_action, _)) = rest.split_once("\nYOU MUST TAKE ONE OF") {
        before_action
    } else {
        rest.lines().next().unwrap_or("")
    };
    let trimmed = body.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn classify_system_message_status(content: &str, task: &TrackedTask) -> Option<&'static str> {
    if let Some(code) = extract_exit_code(content) {
        return Some(if code == 0 { "completed" } else { "failed" });
    }
    let lower = content.to_ascii_lowercase();
    if lower.contains("was killed")
        || lower.contains("task killed")
        || lower.contains("cancelled")
        || lower.contains("canceled")
        || lower.contains("terminated by user")
    {
        return Some("stopped");
    }
    if lower.contains("failed with error") || lower.contains("timed out") {
        return Some("failed");
    }
    if task.ambient && task.kind == "monitor" {
        // Standing daemon cron jobs stay running across individual trigger ticks.
        return None;
    }
    Some("completed")
}

fn extract_exit_code(content: &str) -> Option<i32> {
    for marker in [
        "Command exited with code ",
        "exited with code ",
        "exited with status ",
        "Exit code: ",
    ] {
        if let Some((_, rest)) = content.split_once(marker) {
            let digits: String = rest
                .trim_start()
                .chars()
                .take_while(|c| *c == '-' || c.is_ascii_digit())
                .collect();
            if let Ok(code) = digits.parse::<i32>() {
                return Some(code);
            }
        }
    }
    None
}

fn read_new_jsonl_lines(path: &Path, offset: &mut u64) -> Vec<String> {
    let Ok(mut file) = File::open(path) else {
        return Vec::new();
    };
    let Ok(meta) = file.metadata() else {
        return Vec::new();
    };
    let len = meta.len();
    if len < *offset {
        *offset = 0;
    }
    if len == *offset {
        return Vec::new();
    }
    if file.seek(SeekFrom::Start(*offset)).is_err() {
        return Vec::new();
    }
    let to_read = (len - *offset).min(2 * 1024 * 1024) as usize;
    let mut buf = vec![0u8; to_read];
    let Ok(n) = file.read(&mut buf) else {
        return Vec::new();
    };
    buf.truncate(n);
    let Some(last_nl) = buf.iter().rposition(|&b| b == b'\n') else {
        // Wait until the writer finishes the line.
        return Vec::new();
    };
    *offset += (last_nl + 1) as u64;
    let slice = &buf[..=last_nl];
    String::from_utf8_lossy(slice)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

fn strip_ansi_codes(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
                continue;
            }
        }
        if ch != '\r' {
            out.push(ch);
        }
    }
    out
}

fn read_clean_log_tail(path: &Path, file_len: u64) -> Option<String> {
    if file_len == 0 {
        return None;
    }
    let mut file = File::open(path).ok()?;
    let start = file_len.saturating_sub(MAX_TASK_LOG_TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity((file_len - start) as usize);
    file.take(MAX_TASK_LOG_TAIL_BYTES).read_to_end(&mut buf).ok()?;
    let decoded = String::from_utf8_lossy(&buf);
    let clean = strip_ansi_codes(&decoded);
    let mut lines: Vec<&str> = clean.lines().collect();
    if start > 0 && !lines.is_empty() {
        // Drop partial leading line when seeking into the middle of the file.
        lines.remove(0);
    }
    let filtered: Vec<&str> = lines
        .into_iter()
        .map(str::trim_end)
        .filter(|l| {
            let t = l.trim();
            !t.is_empty()
                && !t.starts_with("Created At: ")
                && !t.starts_with("Completed At: ")
                && !t.starts_with("Showing lines ")
        })
        .collect();
    if filtered.is_empty() {
        return None;
    }
    let tail_start = filtered.len().saturating_sub(MAX_PROGRESS_LINES);
    let joined = filtered[tail_start..].join("\n");
    Some(truncate_chars(&joined, MAX_PROGRESS_CHARS))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elicitation_maps_declared_choices_write_ins_and_cancel() {
        let (questions, fields) = parse_elicitation_form(&json!({
            "mode":"form", "requestedSchema": {"properties": {
                "q0": {"type":"string", "title":"Strategy", "oneOf":[
                    {"const":"unified", "title":"(Recommended) Unified"},
                    {"const":"__other__", "title":"Other"}
                ]},
                "q0_other":{"type":"string"},
                "q1":{"type":"array", "title":"Targets", "items":{"enum":["rust","ts"]}}
            }}
        })).unwrap();
        assert_eq!(questions[0]["allowOther"], true);
        assert_eq!(questions[0]["options"].as_array().unwrap().len(), 1);
        let context = json!({"rpcId":27,"fields":fields});
        let selected = answer_frame(&context, Some(&json!({"Strategy":"Unified","Targets":["rust"]}))).unwrap();
        assert_eq!(selected["result"]["content"], json!({"q0":"unified","q1":["rust"]}));
        let custom = answer_frame(&context, Some(&json!({"Strategy":"My plan","Targets":["rust","ts"]}))).unwrap();
        assert_eq!(custom["result"]["content"], json!({"q0":"__other__","q0_other":"My plan","q1":["rust","ts"]}));
        assert_eq!(answer_frame(&context, None).unwrap()["result"], json!({"action":"cancel"}));
        assert!(answer_frame(&context, Some(&json!({"Strategy":"Unified","Targets":["unknown"]}))).is_err());
    }

    #[test]
    fn transcript_tail_keeps_incomplete_utf8_json_until_newline() {
        let root = std::env::temp_dir().join(format!("agy-transcript-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("transcript.jsonl");
        let row = format!("{}\n", json!({"content":"完成🙂"}));
        let split = row.find('🙂').unwrap() + 2;
        std::fs::write(&path, &row.as_bytes()[..split]).unwrap();
        let mut offset = 0;
        assert!(read_new_jsonl_lines(&path, &mut offset).is_empty());
        assert_eq!(offset, 0);
        std::fs::write(&path, &row).unwrap();
        assert_eq!(read_new_jsonl_lines(&path, &mut offset), vec![row.trim()]);
        assert!(read_new_jsonl_lines(&path, &mut offset).is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}
