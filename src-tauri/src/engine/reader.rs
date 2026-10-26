//! Stdout reader and per-turn streaming state: the capped line reader,
//! event dispatch core, and settle/cleanup path for engine process runs.

use super::codex_usage;
use super::events::{EngineEvent, NativeTask};
#[cfg(test)]
use super::grok;
#[cfg(windows)]
use super::job;
use super::plan_review;
use super::registry::{kill_process_group, ProcessRegistry};
use super::Engine;
use crate::event_sink;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[cfg(test)]
use tokio::process::Command;
use tokio::process::{Child, ChildStderr, ChildStdout};
use tokio::sync::Mutex as TokioMutex;

/// Grace between a Stop kill and force-aborting the reader task. A healthy
/// settle (kill → EOF → wait → terminal event) finishes in milliseconds;
/// the abort only fires when a killed child still won't die and the reader
/// would otherwise park on `wait()` forever.
pub(crate) const READER_SETTLE_GRACE: std::time::Duration = std::time::Duration::from_secs(10);
/// Silence timeout for draining the stdout pipe after the child exits. The
/// bytes the CLI wrote before dying are already buffered by the OS, so a
/// read either completes immediately or never will: a background
/// grandchild that inherited the pipe keeps it open with nothing to say.
/// Bounded by silence rather than EOF, the reader settles the run instead
/// of parking on the grandchild forever (which leaked the run's registry
/// entries — ps shows no process, yet the concurrency gate stays full).
pub(crate) const POST_EXIT_DRAIN: std::time::Duration = std::time::Duration::from_millis(200);
/// Hard cap on one NDJSON line from an engine. Callers should omit or paginate
/// large histories. `BufReader::lines` has no limit, so oversized frames or a
/// runaway engine writing without newlines could exhaust host memory.
pub(crate) const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;
/// How long a claude CLI may take to exit after its turn's Done before the
/// reader treats it as still working (a background subagent) and shows a new
/// running turn. A normal exit, SessionEnd hooks included, fits well inside.
pub(crate) const LINGER_GRACE: std::time::Duration = std::time::Duration::from_secs(4);
/// Stdin payload writer: engines consuming stream-json stdin get the payload,
/// then EOF (drop closes the pipe) — unless `keep_open`, where the handle is
/// returned instead so control responses can follow on the same pipe.
pub(crate) fn spawn_stdin_writer(
    child: &mut Child,
    payload: Option<String>,
    keep_open: bool,
) -> Option<Arc<TokioMutex<Option<tokio::process::ChildStdin>>>> {
    if !keep_open {
        let Some(payload) = payload else {
            return None;
        };
        if let Some(mut stdin) = child.stdin.take() {
            tokio::spawn(async move {
                let _ = stdin.write_all(payload.as_bytes()).await;
                let _ = stdin.write_all(b"\n").await;
                // drop closes stdin -> EOF
            });
        }
        return None;
    }
    let keep = Arc::new(TokioMutex::new(child.stdin.take()));
    if let Some(payload) = payload {
        // Reserve the first frame before publishing stdin to the registry:
        // an immediate interrupt must queue behind the initial user payload,
        // even when its writer task is scheduled before this one.
        let mut guard = Arc::clone(&keep)
            .try_lock_owned()
            .expect("the newly created stdin mutex must be unlocked");
        tokio::spawn(async move {
            if let Some(stdin) = guard.as_mut() {
                let _ = stdin.write_all(payload.as_bytes()).await;
                let _ = stdin.write_all(b"\n").await;
            }
        });
    }
    Some(keep)
}
/// Diagnostics ring: keeps the last 4KB for the error banner.
pub(crate) fn ring_push(buf: &Arc<Mutex<String>>, text: &str) {
    const CAP: usize = 4096;
    let mut guard = match buf.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    guard.push_str(text);
    if guard.len() > CAP {
        // drain panics on a non-char-boundary start — snap forward. The old
        // stderr ring could panic mid-CJK here, silently killing the
        // capture task and starving the error banner of the failure text.
        let mut keep = guard.len() - CAP;
        while !guard.is_char_boundary(keep) {
            keep += 1;
        }
        guard.drain(..keep);
    }
}
/// Stderr capture ring: keeps the last 4KB for the error banner.
pub(crate) fn spawn_stderr_capture(stderr: ChildStderr) -> Arc<Mutex<String>> {
    let buf = Arc::new(Mutex::new(String::new()));
    let target = Arc::clone(&buf);
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => ring_push(&target, &line),
            }
        }
    });
    buf
}
// ==================== stderr redaction ====================

/// Engine stderr can echo the channel credentials from the CLI's own config files; redact credential
/// shapes before the tail is shown to the user in an error banner.
pub(super) fn redact_secrets(text: &str) -> String {
    use std::sync::LazyLock;
    static PATTERNS: LazyLock<Vec<regex::Regex>> = LazyLock::new(|| {
        [
            r"(?i)sk-[A-Za-z0-9_-]+",
            r"(?i)bearer\s+\S+",
            r"(?i)api[_-]?key\s*[=:]\s*\S+",
            r"(?i)token\s*[=:]\s*\S+",
        ]
        .iter()
        .filter_map(|p| regex::Regex::new(p).ok())
        .collect()
    });
    let mut out = text.to_string();
    for pattern in PATTERNS.iter() {
        out = pattern.replace_all(&out, "***").into_owned();
    }
    out
}
/// AGY reports canonical failure metadata on stderr, independently of its
/// stdout result. Keep every field (including retryability and error id), but
/// prefer the structured record over unrelated startup diagnostics.
fn agy_stderr_diagnostic(stderr: &str) -> Option<String> {
    stderr.lines().rev().find_map(|line| {
        let json = line.trim().strip_prefix("AGY_ERROR:")?.trim();
        let mut value: Value = serde_json::from_str(json).ok()?;
        if !value.is_object() {
            return None;
        }
        redact_diagnostic_value(&mut value);
        Some(format!("AGY_ERROR: {value}"))
    })
}

fn redact_diagnostic_value(value: &mut Value) {
    match value {
        Value::String(text) => *text = redact_secrets(text),
        Value::Array(items) => items.iter_mut().for_each(redact_diagnostic_value),
        Value::Object(fields) => {
            for (key, value) in fields {
                if matches!(
                    key.to_ascii_lowercase().as_str(),
                    "api_key" | "apikey" | "token" | "access_token" | "authorization"
                ) {
                    *value = Value::String("***".into());
                } else {
                    redact_diagnostic_value(value);
                }
            }
        }
        _ => {}
    }
}

/// Successful headless runs can still return truncated output or ignore an
/// option. Those explicit warnings must remain visible even with exit code 0.
fn agy_stderr_warnings(stderr: &str) -> Vec<String> {
    let mut warnings = Vec::new();
    for line in stderr.lines().map(str::trim) {
        if line.to_ascii_lowercase().starts_with("warning:") {
            let warning = redact_secrets(line);
            if !warnings.contains(&warning) {
                warnings.push(warning);
            }
        }
    }
    warnings
}
/// Mutable per-run streaming state shared by the reader loop's dispatch.
pub(crate) struct TurnState {
    /// Host timestamp captured before spawning the native request process.
    request_started_at: Option<i64>,
    seq: u64,
    pub(crate) native_session_id: Option<String>,
    pub(crate) saw_done: bool,
    pub(crate) saw_error: bool,
    attempt_error: Option<String>,
    // NOTE: TurnState lives for the whole process (one run_reader per
    // spawn), so once saw_error is set every later event in this process
    // is suppressed. That is correct for the current one-process-per-turn
    // engines (omp --print, codex exec); a future multi-turn-per-process
    // engine must reset this per turn instead.
    saw_any_output: bool,
    pending_terminal: Option<(String, Value)>,
    exit_confirmed: bool,
    /// Start of the model-generation window currently open, if any.
    gen_open_since: Option<Instant>,
    /// The open window was opened by an explicit start marker
    /// (`Generation{active:true}`), so only an explicit end / usage report
    /// may close it — tool rows stream inside such a response.
    gen_explicit: bool,
    /// Generation milliseconds closed but not yet attached to a usage report.
    gen_ms: u64,
    /// Run id of a turn this process started by itself after Done (claude
    /// reporting a background subagent's result). Its events carry this id,
    /// so the UI shows them as a new turn instead of dropping them.
    pub(crate) continuation: Option<String>,
    continuations: u32,
    // Native launch id, distinct from UI continuation turn ids. Provenance is
    // emitted by this host, never read from a CLI's event payload.
    source_run_id: Option<String>,
    /// When the current turn reported Done; arms the linger check.
    done_at: Option<Instant>,
    tasks: Vec<NativeTask>,
    expects_native_settle: bool,
    /// The run has reported native session-state activity at least once.
    /// Sticky (unlike `expects_native_settle`, which Done clears): it tells the
    /// linger check that this process follows the native lifecycle, whose
    /// final Done already guarantees idle with no background work.
    native_lifecycle_seen: bool,
}
impl TurnState {
    pub(crate) fn new(preassigned: Option<String>) -> Self {
        Self {
            request_started_at: None,
            seq: 0,
            native_session_id: preassigned,
            saw_done: false,
            saw_error: false,
            attempt_error: None,
            saw_any_output: false,
            pending_terminal: None,
            exit_confirmed: false,
            gen_open_since: None,
            gen_explicit: false,
            gen_ms: 0,
            continuation: None,
            continuations: 0,
            source_run_id: None,
            done_at: None,
            tasks: Vec::new(),
            expects_native_settle: false,
            native_lifecycle_seen: false,
        }
    }

    fn push(
        &mut self,
        sink: &Arc<event_sink::EventSink>,
        run_id: &str,
        engine_id: &str,
        kind: &str,
        data: Value,
    ) {
        self.push_meta(sink, run_id, engine_id, kind, data, None)
    }

    /// Push a usage/done report carrying the measured generation window.
    fn push_with_gen_ms(
        &mut self,
        sink: &Arc<event_sink::EventSink>,
        run_id: &str,
        engine_id: &str,
        kind: &str,
        data: Value,
        gen_ms: Option<u64>,
    ) {
        self.push_meta(sink, run_id, engine_id, kind, data, gen_ms)
    }

    fn push_meta(
        &mut self,
        sink: &Arc<event_sink::EventSink>,
        run_id: &str,
        engine_id: &str,
        kind: &str,
        data: Value,
        gen_ms: Option<u64>,
    ) {
        if !self.exit_confirmed
            && run_id.starts_with("pa-")
            && matches!(engine_id, "pi" | "codex")
            && matches!(kind, "done" | "error")
        {
            self.pending_terminal = Some((kind.to_string(), data));
            return;
        }
        self.seq += 1;
        let mut payload = serde_json::json!({
            "runId": run_id,
            "sessionId": self.native_session_id,
            "engine": engine_id,
            "seq": self.seq,
            "kind": kind,
            "data": data,
            // Emit-side timestamp (Unix ms): plugins compute throughput from
            // consecutive reports; arrival time would add IPC batching jitter.
            "ts": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0),
        });
        if let Some(gen_ms) = gen_ms {
            // Measured generation window (stream open → close, tool execution
            // excluded) for the report that just landed. Absent on every
            // report the host could not time; consumers fall back to
            // consecutive-report timing in that case.
            payload["genMs"] = Value::from(gen_ms);
        }
        if let Some(source_run_id) = &self.source_run_id {
            // The original launch stays the source of continuation events.
            payload["sourceRunId"] = serde_json::json!(source_run_id);
        }
        sink.push(payload);
    }

    /// Mark the model as generating: opens the window when none is open.
    /// `explicit` records an engine-provided start marker (message_start),
    /// which only an explicit end or a usage report may close.
    fn gen_begin(&mut self, explicit: bool) {
        if self.gen_open_since.is_none() {
            self.gen_open_since = Some(Instant::now());
            self.gen_explicit = explicit;
        }
    }

    /// Close the open window, accumulating its span.
    fn gen_end(&mut self) {
        if let Some(since) = self.gen_open_since.take() {
            self.gen_ms += since.elapsed().as_millis() as u64;
        }
        self.gen_explicit = false;
    }

    /// Close the open window and consume the accumulated span as this
    /// report's `genMs`. None when nothing measurable was collected, so the
    /// consumer keeps its report-to-report fallback.
    fn take_gen_ms(&mut self) -> Option<u64> {
        self.gen_end();
        let ms = std::mem::take(&mut self.gen_ms);
        (ms > 0).then_some(ms)
    }

    pub(crate) fn confirm_exit(&mut self, core: &TurnCore) {
        self.exit_confirmed = true;
        if let Some((kind, data)) = self.pending_terminal.take() {
            self.push(&core.sink, &core.run_id, &core.engine_id, &kind, data);
        }
    }
}
/// Event-routing core shared by process runs ([`RunContext`]) and virtual
/// host-stream runs ([`dsh_session::run_host_turn`]): the fields
/// `dispatch_event` needs to route engine events to the UI sink and keep the
/// registry's session aliasing in step.
pub(crate) struct TurnCore {
    pub(crate) sink: Arc<event_sink::EventSink>,
    pub(crate) registry: Arc<ProcessRegistry>,
    pub(crate) engine_id: String,
    pub(crate) run_id: String,
    /// 审批事实源:计划事件到达即落盘(engine/plan_review.rs)。驱动内部与
    /// 测试构造点没有 db 句柄时为 None——那些路径不产生计划事件。
    pub(crate) db: Option<Arc<crate::db::Db>>,
}
/// 停住的计划审批随运行消亡:原生请求不再有效,记录过期并推送
/// PlanReviewSettled,历史 UI 不得假装还能批准(PRD §8 防线 3)。
/// host-transport 驱动(dsh/grok/qoder/codex/omp-acp)在自己的 settle 段
/// 对每个注册键调用一次,语义与 run_reader 的收尾一致。无 db 句柄的
/// 路径不产生计划事件,plans 必然为空。
pub(crate) fn expire_parked_plans(core: &TurnCore, state: &mut TurnState, key: &str) {
    let Some(db) = &core.db else {
        return;
    };
    let parked: Vec<(String, i64)> = core
        .registry
        .take_plans(key)
        .into_iter()
        .map(|(plan_id, revision, _)| (plan_id, revision))
        .collect();
    if let Ok(expired) = plan_review::expire_reviews(db, &parked) {
        for (plan_id, revision, _previous) in expired {
            core.dispatch_event(state, EngineEvent::PlanReviewSettled {
                plan_id,
                revision,
                status: plan_review::PlanStatus::Expired.as_str().to_string(),
            });
        }
    }
}

impl TurnCore {
    fn settle_tasks(&self, state: &mut TurnState, status: &str) {
        let mut changed = false;
        for task in &mut state.tasks {
            if matches!(task.status.as_str(), "running" | "paused") {
                task.status = status.to_string();
                changed = true;
            }
        }
        if changed {
            let run_id = self.current_run_id(state);
            let tasks = serde_json::json!({ "tasks": state.tasks });
            state.push(&self.sink, &run_id, &self.engine_id, "tasks", tasks);
        }
    }
    /// The claude CLI can outlive its turn's Done: with a background subagent
    /// running it stays alive and reports the result in a new turn of the
    /// same process.
    pub(crate) fn continues_after_done(&self) -> bool {
        self.engine_id == "claude"
    }

    /// The run id events are published under: the spawn's, or the current
    /// continuation's. Registry lookups keep using `self.run_id`.
    pub(crate) fn current_run_id(&self, state: &TurnState) -> String {
        state.continuation.clone().unwrap_or_else(|| self.run_id.clone())
    }

    /// Open a new turn on the same process after Done: a fresh run id (the UI
    /// adopts it like a turn another client started), fresh terminal state,
    /// and a registry alias so Stop by that id reaches this process. The alias
    /// clones the spawn entry, so the settle path drains it with the run.
    pub(crate) fn begin_continuation(&self, state: &mut TurnState) {
        state.continuations += 1;
        let id = format!("{}-c{}", self.run_id, state.continuations);
        if let Some(entry) = self.registry.get(&self.run_id) {
            self.registry.insert_alias(id.clone(), entry);
        }
        state.continuation = Some(id.clone());
        state.saw_done = false;
        state.done_at = None;
        state.gen_open_since = None;
        state.gen_explicit = false;
        state.gen_ms = 0;
        if let Some(session) = state.native_session_id.clone() {
            state.push(&self.sink, &id, &self.engine_id, "session", Value::String(session));
        }
    }

    /// Adopt a native session id: reserve it with the Leader coordinator,
    /// claim the registry alias (never overwriting another run's), and only
    /// then commit and remember it for subsequent event payloads.
    fn adopt_session_id(&self, state: &mut TurnState, id: &str, announce: bool) -> bool {
        if super::sidechat::is_side_run_id(&self.run_id) {
            let validation = super::sidechat::run_owner(&self.run_id).and_then(|owner| {
                if !super::sidechat::is_safe_session_id(id) || owner.engine != self.engine_id
                    || owner.parent_session_id.as_deref() == Some(id) {
                    return Err("Engine returned an invalid or parent Sidechat session identity".into());
                }
                self.registry.rekey(&self.run_id, id.to_string())?;
                super::sidechat::register_owned_session(&self.run_id, id, self.db.as_deref())
            });
            if let Err(error) = validation {
                crate::host_chat::revoke_run(&self.run_id);
                self.dispatch_event(state, EngineEvent::Error(error));
                let registry = Arc::clone(&self.registry);
                let run_id = self.run_id.clone();
                tokio::task::spawn_blocking(move || { registry.kill(&run_id); });
                return false;
            }
            state.native_session_id = Some(id.to_string());
            crate::host_chat::adopt_session(&self.run_id, id);
            if announce {
                let run_id = self.current_run_id(state);
                state.push(
                    &self.sink,
                    &run_id,
                    &self.engine_id,
                    "session",
                    Value::String(id.to_string()),
                );
            }
            return true;
        }
        if state.native_session_id.as_deref() == Some(id) {
            return true;
        }
        let reservation = if id.trim().is_empty() {
            Err("Engine returned an empty native session identity".to_string())
        } else {
            crate::leader::reserve_session_binding(&self.run_id, &self.engine_id, id)
        };
        let binding = match reservation {
            Ok(binding) => binding,
            Err(error) => {
                crate::leader::reject_first_root_binding(&self.run_id);
                crate::host_chat::revoke_run(&self.run_id);
                self.dispatch_event(state, EngineEvent::Error(error));
                return false;
            }
        };
        if let Err(error) = self.registry.rekey(&self.run_id, id.to_string()) {
            crate::leader::release_session_binding(&self.run_id, &self.engine_id, id);
            crate::leader::reject_first_root_binding(&self.run_id);
            crate::host_chat::revoke_run(&self.run_id);
            self.dispatch_event(state, EngineEvent::Error(error));
            return false;
        }
        if let Err(error) = crate::leader::commit_session_binding(&self.run_id, &self.engine_id, id) {
            // Claim succeeded, but a root role transaction failed. Release only
            // our own alias; publish no session or caller capability.
            if let Some(entry) = self.registry.get(&self.run_id) {
                self.registry.remove_if_pid(id, entry.pid);
            }
            crate::leader::release_session_binding(&self.run_id, &self.engine_id, id);
            crate::leader::reject_first_root_binding(&self.run_id);
            crate::host_chat::revoke_run(&self.run_id);
            self.dispatch_event(state, EngineEvent::Error(error));
            return false;
        }
        // The alias is ours now; settle must drain it under this key.
        state.native_session_id = Some(id.to_string());
        if binding == crate::leader::SessionBinding::CleanupOnly {
            // Recorded only so reclamation deletes this transcript.
            crate::host_chat::revoke_run(&self.run_id);
            self.dispatch_event(
                state,
                EngineEvent::Error("This managed branch is being reclaimed".into()),
            );
            return false;
        }
        crate::host_chat::adopt_session(&self.run_id, id);
        crate::auto_title::origin::adopt_session(&self.run_id, &self.engine_id, id);
        crate::assistant_notices::completion_outbox::adopt_session(&self.run_id, &self.engine_id, id);
        if let Some(db) = &self.db {
            match crate::throughput_stats::bind_session(db, &self.engine_id, &self.run_id, id) {
                Ok(true) => self.sink.emit_throughput_changed(),
                Ok(false) => {},
                Err(error) => eprintln!("[throughput] bind terminal observations: {error}"),
            }
        }
        if announce {
            let run_id = self.current_run_id(state);
            state.push(
                &self.sink,
                &run_id,
                &self.engine_id,
                "session",
                Value::String(id.to_string()),
            );
        }
        true
    }

    pub(crate) fn dispatch_event(&self, state: &mut TurnState, event: EngineEvent) {
        state.source_run_id = Some(self.run_id.clone());
        // Terminal state is monotonic, even if a CLI or its usage tail emits
        // more data before exiting: no late retry/content/warn event may
        // revive a settled run. The one exception is SessionId — a done that
        // raced the CLI's session announcement must still rekey/announce, or
        // the conversation strands under its provisional key.
        if (state.saw_done || state.saw_error) && !matches!(event, EngineEvent::SessionId(_) | EngineEvent::Tasks(_) | EngineEvent::NativeTaskStopResponse { .. }) {
            // The exception is a claude process that starts another turn by
            // itself (a background subagent finished): that output is a new
            // turn, published under its own run id, never a revival.
            let continues = state.saw_done
                && !state.saw_error
                && self.continues_after_done()
                && opens_turn(&event);
            if !continues {
                return;
            }
            self.begin_continuation(state);
        }
        let run_id = self.current_run_id(state);
        match event {
            EngineEvent::Throughput(sample) => {
                // The host writes terminal observations once, independently of
                // UI delivery. Running reports never acquire the database lock.
                if matches!(sample.get("status").and_then(Value::as_str), Some("complete" | "partial")) {
                    if let Some(db) = &self.db {
                        match crate::throughput_stats::record_terminal(
                            db, &self.engine_id, &self.run_id, &run_id, state.seq + 1,
                            state.native_session_id.as_deref(), &sample,
                        ) {
                            Ok(true) => self.sink.emit_throughput_changed(),
                            Ok(false) => {},
                            Err(error) => eprintln!("[throughput] persist terminal observation: {error}"),
                        }
                    }
                }
                state.push(&self.sink, &run_id, &self.engine_id, "throughput", sample);
            }
            EngineEvent::Delta(text) => {
                state.gen_begin(false);
                state.push(
                    &self.sink,
                    &run_id,
                    &self.engine_id,
                    "delta",
                    Value::String(text),
                )
            }
            EngineEvent::Thinking(text) => {
                state.gen_begin(false);
                state.push(
                    &self.sink,
                    &run_id,
                    &self.engine_id,
                    "thinking",
                    Value::String(text),
                )
            }
            EngineEvent::Generation { active } => {
                // Internal marker: never streamed, only folded into genMs.
                if active {
                    state.gen_begin(true);
                } else {
                    state.gen_end();
                }
            }
            EngineEvent::AssistantImages(images) => {
                if !images.is_empty() {
                    if !state.gen_explicit { state.gen_end(); }
                    state.push(&self.sink, &run_id, &self.engine_id, "message",
                        serde_json::json!({"role":"assistant", "text":"", "images":images}));
                }
            }
            EngineEvent::Message {
                role,
                text,
                path,
                todos,
                args,
                result,
                patch,
            } => {
                // A tool row opening (or its arg patch), or a completed
                // assistant snapshot (codex/kimi report whole messages), ends
                // the response stream that preceded it. Windows opened by an
                // explicit start marker keep running: claude streams tool
                // arguments inside the same response and closes it at
                // message_stop.
                let response_end = role == "assistant"
                    || (role == "tool" && result.is_none());
                if response_end && !state.gen_explicit {
                    state.gen_end();
                }
                let mut payload = serde_json::json!({ "role": role, "text": text });
                if let Some(path) = path {
                    payload["path"] = Value::String(path);
                }
                if let Some(todos) = todos {
                    if let Ok(value) = serde_json::to_value(todos) {
                        payload["todos"] = value;
                    }
                }
                if let Some(args) = args {
                    payload["args"] = args;
                }
                if let Some(result) = result {
                    payload["result"] = result;
                }
                if patch {
                    payload["patch"] = Value::Bool(true);
                }
                state.push(
                    &self.sink,
                    &run_id,
                    &self.engine_id,
                    "message",
                    payload,
                )
            }
            EngineEvent::AttemptEnd { error } => state.attempt_error = error,
            EngineEvent::SessionId(id) => { self.adopt_session_id(state, &id, true); }
            EngineEvent::Usage(usage) => {
                let gen_ms = state.take_gen_ms();
                state.push_with_gen_ms(
                    &self.sink,
                    &run_id,
                    &self.engine_id,
                    "usage",
                    usage,
                    gen_ms,
                )
            }
            EngineEvent::Error(error) => {
                crate::leader::reject_first_root_binding(&self.run_id);
                self.settle_tasks(state, "unknown");
                state.gen_end();
                state.saw_error = true;
                crate::mcp::mark_run_ended(&self.run_id);
                state.push(
                    &self.sink,
                    &run_id,
                    &self.engine_id,
                    "error",
                    Value::String(error),
                );
                // The turn failed terminally: the frontend settles (send
                // button back to idle) on this event, so a still-running
                // CLI process would keep burning tokens invisibly while the
                // UI claims the session ended. Kill the process tree now —
                // the killed flag makes the runner's EOF path a no-op
                // (saw_error already settled the turn) and the registry
                // entry drains as usual.
                //
                // Off the reader thread: the kill blocks on the Windows tree
                // walk, and stalling this task would also stall the stdout
                // drain it owns. saw_error already settled the turn, so
                // nothing here depends on the kill completing first.
                let registry = Arc::clone(&self.registry);
                let run_id = self.run_id.clone();
                tokio::task::spawn_blocking(move || registry.kill(&run_id));
            }
            EngineEvent::Compaction { active, reason } => {
                // Not terminal: compaction is a mid-turn pause while the CLI
                // summarizes; the UI swaps its status label until the end
                // event (or turn settle) clears it.
                state.gen_end();
                state.push(
                    &self.sink,
                    &run_id,
                    &self.engine_id,
                    "compaction",
                    serde_json::json!({ "active": active, "reason": reason }),
                );
            }
            EngineEvent::AutoReview(review) => {
                state.gen_end();
                state.push(&self.sink, &run_id, &self.engine_id, "auto_review", review);
            }
            EngineEvent::Handoff { stage, model, effort } => {
                // Not terminal: Codex Desktop runs the turn; the UI shows the
                // stage until the turn settles.
                state.gen_end();
                state.push(
                    &self.sink,
                    &run_id,
                    &self.engine_id,
                    "handoff",
                    serde_json::json!({
                        "host": "codex-desktop",
                        "stage": stage,
                        "model": model,
                        "effort": effort,
                    }),
                );
            }
            EngineEvent::Warn(error) => {
                // Not terminal: no saw_error — EOF settle still decides the
                // turn's fate if the CLI gives up after this notice.
                state.gen_end();
                state.push(
                    &self.sink,
                    &run_id,
                    &self.engine_id,
                    "warn",
                    Value::String(error),
                );
            }
            EngineEvent::Retry {
                attempt,
                max,
                message,
            } => {
                // Not terminal: the CLI is backing off and will re-issue the
                // request. The frontend renders it as live progress in the
                // run status line (not as an error banner) and clears it on
                // the next content event.
                state.gen_end();
                state.push(
                    &self.sink,
                    &run_id,
                    &self.engine_id,
                    "retry",
                    serde_json::json!({ "attempt": attempt, "max": max, "message": message }),
                );
            }
            EngineEvent::PermissionDenied {
                tool,
                path,
                message,
            } => {
                // Not terminal either: the CLI works around the denial and
                // the turn continues — the UI offers the grant alongside.
                state.gen_end();
                state.push(
                    &self.sink,
                    &run_id,
                    &self.engine_id,
                    "permission_denied",
                    serde_json::json!({ "tool": tool, "path": path, "message": message }),
                );
            }
            EngineEvent::ApprovalQuestion { request_id, tool_use_id, input, context } => {
                state.gen_end();
                if let Some(entry) = self.registry.get(&self.run_id) {
                    if let Ok(mut questions) = entry.questions.lock() {
                        questions.insert(request_id.clone(), context);
                    }
                }
                state.push(&self.sink, &run_id, &self.engine_id, "question",
                    serde_json::json!({"requestId":request_id,"toolUseId":tool_use_id,"input":input}));
            }
            EngineEvent::Question {
                request_id,
                tool_use_id,
                input,
            } => {
                // Park the ask: the answer command rebuilds updatedInput from
                // this exact input (the control protocol wants the full tool
                // input back, with the answers merged in).
                state.gen_end();
                if let Some(entry) = self.registry.get(&self.run_id) {
                    if let Ok(mut questions) = entry.questions.lock() {
                        questions.insert(request_id.clone(), input.clone());
                    }
                }
                state.push(
                    &self.sink,
                    &run_id,
                    &self.engine_id,
                    "question",
                    serde_json::json!({
                        "requestId": request_id,
                        "toolUseId": tool_use_id,
                        "input": input,
                    }),
                );
            }
            EngineEvent::PlanDraft {
                plan_id,
                text,
                replace,
            } => {
                // 草稿只是预览:不落盘为可审批版本,UI 不得据此激活批准。
                state.push(
                    &self.sink,
                    &run_id,
                    &self.engine_id,
                    "plan_draft",
                    serde_json::json!({
                        "planId": plan_id,
                        "text": text,
                        "replace": replace,
                    }),
                );
            }
            EngineEvent::PlanReviewReady { record, context } => {
                state.gen_end();
                // 完整正文 + 等待点确认后才落盘/下发 awaiting_review;原生
                // 回复上下文只停在后端注册表,事件载荷永不含它。
                let mut record = *record;
                if let Some(db) = &self.db {
                    match plan_review::record_review(db, &record) {
                        Ok(revision) => record.revision = revision,
                        Err(error) => {
                            // 审批事实源写不进去就不能假装可审批:按错误
                            // 落定,原生上下文不停车,等待点随运行结束消亡。
                            self.dispatch_event(
                                state,
                                EngineEvent::Error(format!(
                                    "plan review could not be persisted: {error}"
                                )),
                            );
                            return;
                        }
                    }
                }
                // next_turn(Codex)没有活的原生请求:计划轮次已正常结束,
                // 批准=另起一次执行 turn;审批元数据在记录本体(session_id=
                // 线程、native_plan_id=item、content_hash),不停车——否则
                // 运行一结束就被 expire,用户永远批不了。native_request 才
                // 停车,形状与 respond_plan_review 的读取约定一致:
                // {revision, route, frames, ...} 顶层平铺——context 是适配器
                // 产出的对象,revision 由后端注入,适配器不得占用该键。
                if record.review_kind == plan_review::PlanReviewKind::NativeRequest {
                if let Some(entry) = self.registry.get(&self.run_id) {
                    if let Ok(mut plans) = entry.plans.lock() {
                        let mut parked = context;
                        if let Some(map) = parked.as_object_mut() {
                            map.insert(
                                "revision".to_string(),
                                serde_json::Value::from(record.revision),
                            );
                        } else {
                            parked = serde_json::json!({
                                "revision": record.revision,
                                "opaque": parked,
                            });
                        }
                        plans.insert(record.plan_id.clone(), parked);
                    }
                }
                }
                let payload = serde_json::to_value(&record)
                    .unwrap_or_else(|_| serde_json::json!({ "planId": record.plan_id }));
                state.push(&self.sink, &run_id, &self.engine_id, "plan_review", payload);
            }
            EngineEvent::PlanReviewSettled {
                plan_id,
                revision,
                status,
            } => {
                if let Some(entry) = self.registry.get(&self.run_id) {
                    if let Ok(mut plans) = entry.plans.lock() {
                        plans.remove(&plan_id);
                    }
                }
                state.push(
                    &self.sink,
                    &run_id,
                    &self.engine_id,
                    "plan_review_settled",
                    serde_json::json!({
                        "planId": plan_id,
                        "revision": revision,
                        "status": status,
                    }),
                );
            }
            EngineEvent::AgentSettled => {
                // 等价一次性模式的 EOF 收尾(见下方 finalize):未恢复的尝试
                // 错误按 Error 落定,否则正常 Done。Done 分支会关掉 stdin,
                // rpc 进程随之 drain 退出,EOF 收尾看到 saw_done 自然空转。
                let event = match state.attempt_error.take() {
                    Some(error) => EngineEvent::Error(error),
                    None => EngineEvent::Done {
                        session_id: None,
                        usage: None,
                    },
                };
                self.dispatch_event(state, event);
            }
            EngineEvent::QuestionSettled { request_id } => {
                let mut answers = None;
                if let Some(entry) = self.registry.get(&self.run_id) {
                    if let Ok(mut questions) = entry.questions.lock() {
                        answers = questions.remove(&request_id).and_then(|input| {
                            input.pointer("/codexApproval/answered").cloned()
                        });
                    }
                }
                let mut data = serde_json::json!({ "requestId": request_id });
                if let Some(answers) = answers { data["answers"] = answers; }
                state.push(
                    &self.sink,
                    &run_id,
                    &self.engine_id,
                    "question_settled",
                    data,
                );
            }
            EngineEvent::ControlPermissionDeny {
                request_id,
                tool_name,
            } => {
                // No approval UI in this client: deny in place so the CLI is
                // not left parked until its deadline. Net behavior matches
                // the pre-control-protocol headless run (ask -> denial, the
                // model works around it). Best effort: if the pipe is gone
                // the CLI is already dead and its own deadline settles.
                let registry = Arc::clone(&self.registry);
                let run_id = self.run_id.clone();
                let line = serde_json::json!({
                    "type": "control_response",
                    "response": {
                        "subtype": "success",
                        "request_id": request_id,
                        "response": {
                            "behavior": "deny",
                            "message": format!(
                                "This client cannot show tool-permission prompts; the {tool_name} call was denied. Work around it, or tell the user what you would have run so they can approve it another way."
                            ),
                        },
                    },
                })
                .to_string();
                tokio::spawn(async move {
                    let _ = registry.write_line(&run_id, line).await;
                });
            }
            EngineEvent::Model(model) => {
                state.push(
                    &self.sink,
                    &run_id,
                    &self.engine_id,
                    "model",
                    Value::String(model),
                );
            }
            EngineEvent::Effort(effort) => {
                state.push(
                    &self.sink,
                    &run_id,
                    &self.engine_id,
                    "effort",
                    Value::String(effort),
                );
            }
            EngineEvent::McpServers { servers, tools } => {
                // Not a chat event: the MCP settings page reads this snapshot
                // (workspace-scoped, timestamped) instead of the stream.
                crate::mcp::record_from_run(
                    &self.run_id,
                    state.native_session_id.as_deref(),
                    servers,
                    tools,
                );
            }
            EngineEvent::Tasks(tasks) => {
                state.tasks = tasks;
                let data = serde_json::json!({ "tasks": state.tasks });
                state.push(&self.sink, &run_id, &self.engine_id, "tasks", data);
                if self.engine_id == "claude" {
                    if let Some(entry) = self.registry.get(&self.run_id) {
                        entry.native_tasks.observe(&state.tasks);
                    }
                }
            }
            EngineEvent::NativeTaskStopResponse { request_id, error } => {
                if self.engine_id == "claude" {
                    if let Some(entry) = self.registry.get(&self.run_id) {
                        entry.native_tasks.response(&request_id, error.as_deref());
                    }
                }
            }
            EngineEvent::Activity(activity) => {
                state.expects_native_settle = true;
                state.native_lifecycle_seen = true;
                state.push(&self.sink, &run_id, &self.engine_id, "activity", serde_json::json!({ "state": activity }));
            }
            EngineEvent::TurnComplete { usage, interrupted } => {
                if let (Some(db), Some(sid)) = (&self.db, state.native_session_id.as_deref()) {
                    crate::history::reader::refresh_session_prompt_cache(db, &self.engine_id, sid);
                }
                let gen_ms = state.take_gen_ms();
                let mut data = serde_json::json!({ "usage": usage });
                // Present only when true, so ordinary payloads keep their shape.
                if interrupted {
                    data["interrupted"] = Value::Bool(true);
                }
                state.push_with_gen_ms(&self.sink, &run_id, &self.engine_id, "turn_complete", data, gen_ms);
            }
            EngineEvent::Done { session_id, usage } => {
                // A final result can be the first identity announcement. A
                // rejected identity must remain an error, never a successful
                // Done that suppresses its own validation failure.
                if let Some(id) = session_id {
                    if !self.adopt_session_id(state, &id, false) { return; }
                }
                if let (Some(db), Some(sid)) = (&self.db, state.native_session_id.as_deref()) {
                    if self.engine_id == "cursor" {
                        let killed = self.registry.get(&self.run_id)
                            .is_some_and(|entry| entry.killed.load(std::sync::atomic::Ordering::SeqCst));
                        let observed_at = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
                        if let Some(started_at) = state.request_started_at
                            .filter(|start| !killed && *start > 0 && observed_at >= *start)
                        {
                            let window = crate::history::prompt_cache::CacheWindow {
                                ttl_seconds: 300, started_at, observed_at,
                                source: "cursor-policy".into(), reference: None,
                            };
                            match crate::history::prompt_cache::set(&db.0.lock(), "cursor", sid, Some(&window)) {
                                Ok(()) => self.sink.emit_sessions_changed(),
                                Err(error) => eprintln!("[prompt-cache] persist Cursor policy: {error}"),
                            }
                        }
                    } else {
                        crate::history::reader::refresh_session_prompt_cache(db, &self.engine_id, sid);
                    }
                }
                self.settle_tasks(state, "unknown");
                // Done is the native run's settle: only an Activity seen after
                // it can make a later exit unsettled. Left set, a CLI that
                // outlives LINGER_GRACE (continuation resets saw_done) would
                // turn a fully successful run into a false error at EOF.
                state.expects_native_settle = false;
                let gen_ms = state.take_gen_ms();
                state.saw_done = true;
                state.done_at = Some(Instant::now());
                crate::mcp::mark_run_ended(&self.run_id);
                // The turn is over: EOF the interactive stdin so the CLI
                // exits instead of waiting for a next message forever.
                self.registry.close_stdin(&self.run_id);
                state.push_with_gen_ms(
                    &self.sink,
                    &run_id,
                    &self.engine_id,
                    "done",
                    serde_json::json!({ "usage": usage }),
                    gen_ms,
                );
            }
        }
    }
}
/// Events only a model turn produces. After Done, one of these from the same
/// process means the CLI began another turn by itself.
fn opens_turn(event: &EngineEvent) -> bool {
    matches!(
        event,
        EngineEvent::Delta(_)
            | EngineEvent::Thinking(_)
            | EngineEvent::Message { .. }
            | EngineEvent::AssistantImages(_)
            | EngineEvent::Generation { active: true }
            | EngineEvent::Compaction { active: true, .. }
            | EngineEvent::Retry { .. }
            | EngineEvent::PermissionDenied { .. }
            | EngineEvent::Question { .. }
            | EngineEvent::ApprovalQuestion { .. }
            | EngineEvent::PlanDraft { .. }
            | EngineEvent::PlanReviewReady { .. }
    )
}
/// Everything the stdout reader task needs (moved in at spawn).
pub(crate) struct RunContext {
    pub(crate) request_started_at: Option<i64>,
    pub(crate) core: TurnCore,
    pub(crate) engine_impl: Box<dyn Engine>,
    pub(crate) pid: u32,
    /// Session id fixed before spawn (grok `-s`); seeds TurnState.
    pub(crate) preassigned_session_id: Option<String>,
    pub(crate) initial_model: Option<String>,
    pub(crate) initial_effort: Option<String>,
    pub(crate) child: Arc<TokioMutex<Child>>,
    pub(crate) killed: Arc<std::sync::atomic::AtomicBool>,
    pub(crate) cleanup_files: Vec<PathBuf>,
    /// omp computer-use workspace injection; restored with the same
    /// lifetime as cleanup_files (every exit path funnels through here).
    pub(crate) mcp_restore: Option<crate::computer_use::McpRestore>,
    pub(crate) stderr_buf: Arc<Mutex<String>>,
    /// Off-protocol stdout lines (plain text from CLI startup failures,
    /// wrapper errors, node crashes): parse_line drops non-JSON lines, so
    /// without this ring a failed run with empty stderr surfaces as a bare
    /// "exited with status" banner.
    pub(crate) stdout_plain_buf: Arc<Mutex<String>>,
    /// Kill-on-close job guard: drops with this context at settle, sweeping
    /// any grandchild the CLI orphaned (Windows pwsh.exe/conhost.exe).
    #[cfg(windows)]
    pub(crate) _tree_guard: Option<Arc<job::KillOnCloseJob>>,
}
impl Drop for RunContext {
    fn drop(&mut self) {
        super::sidechat::abort_run(&self.core.run_id);
        // Also runs when the reader is aborted during interrupt or shutdown.
        cleanup_staged_files(&self.cleanup_files);
        if let Some(restore) = &self.mcp_restore {
            restore.restore();
        }
        // Last line of defence for the run's concurrency slot. The settle
        // path removes keys by name and `kill`'s abort backstop drains them
        // by run id, but a reader that dies any other way (a panic inside
        // dispatch, a task dropped without either path running) never
        // reaches those — and nothing sweeps dead pids, so the slot would
        // stay pinned until app exit and sending would eventually wedge on
        // "too many concurrent runs". Idempotent: on a healthy settle the
        // keys are already gone and this finds nothing.
        self.core
            .registry
            .remove_run_if_pid(&self.core.run_id, self.pid);
        // Wake queued host messages only after the process alias is removed.
        // A Done can precede a background continuation and is not retirement.
        crate::host_chat::finish_run(&self.core.run_id);
    }
}
impl RunContext {
    fn dispatch_event(&self, state: &mut TurnState, event: EngineEvent) {
        dispatch_child_event(self.engine_impl.as_ref(), &self.core, state, event);
    }
}
fn finish_child_telemetry(engine: &dyn Engine, core: &TurnCore, state: &mut TurnState, interrupted: bool) {
    let mut events = Vec::new();
    engine.finish_telemetry(interrupted, &mut events);
    for event in events {
        core.dispatch_event(state, event);
    }
}
fn dispatch_child_event(engine: &dyn Engine, core: &TurnCore, state: &mut TurnState, event: EngineEvent) {
    // Host protocol failures must settle the observer before terminal dispatch
    // starts rejecting late telemetry. Native errors already settled it.
    if matches!(event, EngineEvent::Error(_)) {
        finish_child_telemetry(engine, core, state, true);
    }
    core.dispatch_event(state, event);
}
/// Abort-safe registry cleanup for virtual (host-stream) runs, which own no
/// [`RunContext`]: their settle code sits at the end of the transport task,
/// so an abort (`kill`'s force-abort, shutdown) or a panic inside the turn
/// would strand their keys and pin a concurrency slot until app exit. Held
/// by the task for its whole life; idempotent on a healthy settle.
pub(crate) struct VirtualRunGuard {
    registry: Arc<ProcessRegistry>,
    run_id: String,
    virtual_pid: u32,
}

impl VirtualRunGuard {
    pub(crate) fn new(registry: Arc<ProcessRegistry>, run_id: String, virtual_pid: u32) -> Self {
        Self {
            registry,
            run_id,
            virtual_pid,
        }
    }
}

impl Drop for VirtualRunGuard {
    fn drop(&mut self) {
        super::sidechat::abort_run(&self.run_id);
        self.registry
            .remove_run_if_pid(&self.run_id, self.virtual_pid);
        crate::host_chat::finish_run(&self.run_id);
    }
}

/// Remove leftover channel staging dirs (`claude-staging`/`grok-staging`
/// under app_home) from a crashed run: they hold per-send credentials and
/// must not linger on disk. Live runs recreate them per send, so sweeping
/// at startup is safe. Only these two known names are touched.
pub fn sweep_staging_dirs() {
    let home = crate::paths::app_home();
    for name in [
        "claude-staging",
        "grok-staging",
        "codex-plan-staging",
        "agy-host-staging",
        "cursor-host-staging",
        super::host_instructions::STAGING_DIRECTORY,
    ] {
        let dir = home.join(name);
        if dir.exists() {
            if let Err(error) = std::fs::remove_dir_all(&dir) {
                eprintln!(
                    "[engine] failed to sweep staging dir {}: {error}",
                    dir.display()
                );
            }
        }
    }
}
pub(crate) fn cleanup_staged_files(paths: &[PathBuf]) {
    for path in paths {
        let result = if path.is_dir() {
            std::fs::remove_dir_all(path)
        } else {
            std::fs::remove_file(path)
        };
        if let Err(error) = result {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!(
                    "[engine] failed to remove staging path {}: {error}",
                    path.display()
                );
            }
        }
    }
}
/// One line read from the engine's stdout, size-capped.
pub(crate) enum LineRead {
    /// A complete line, newline terminator stripped (may be empty).
    Line(Vec<u8>),
    /// Clean EOF.
    Eof,
    /// A line exceeds MAX_LINE_BYTES (even valid JSON): tear down the run.
    TooLong,
}
/// Cancellation-safe replacement for `BufReader::lines().next_line()` with a
/// hard byte cap: partial bytes live in the caller-owned `line`, and the
/// only await is `fill_buf`, so a `tokio::select!` tick landing mid-line
/// consumes and drops nothing — the property the old code relied on
/// `next_line` for (a cancelled `read_line` would lose the partial bytes).
/// Resuming the buffer is the whole point: a `line.clear()` here wiped the
/// bytes a cancelled call had already consumed from the reader, so a tick
/// landing mid-line truncated that line (a long `item.completed` parsed as
/// broken JSON and was dropped). The caller hands back the same buffer every
/// call, and `mem::take` empties it on a complete line while Eof/TooLong end
/// the run, so this only ever appends.
pub(crate) async fn read_line_capped(
    reader: &mut BufReader<ChildStdout>,
    line: &mut Vec<u8>,
) -> std::io::Result<LineRead> {
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(if line.is_empty() {
                LineRead::Eof
            } else {
                // EOF mid-line: deliver the partial line, like next_line.
                LineRead::Line(std::mem::take(line))
            });
        }
        let end = available
            .iter()
            .position(|b| *b == b'\n')
            .unwrap_or(available.len());
        if line.len() + end > MAX_LINE_BYTES {
            return Ok(LineRead::TooLong);
        }
        line.extend_from_slice(&available[..end]);
        let has_newline = end < available.len();
        // Consume the newline too when present. No await between extend and
        // consume, so cancellation cannot split the pair.
        reader.consume(end + usize::from(has_newline));
        if has_newline {
            return Ok(LineRead::Line(std::mem::take(line)));
        }
    }
}
/// Read NDJSON stdout until EOF, dispatch events, then settle the turn:
/// registry cleanup, temp-file cleanup, and the terminal done/error event.
pub(crate) async fn run_reader(stdout: ChildStdout, ctx: RunContext) {
    let mut state = TurnState::new(ctx.preassigned_session_id.clone());
    state.request_started_at = ctx.request_started_at;
    if let Some(model) = ctx.initial_model.clone() {
        ctx.dispatch_event(&mut state, EngineEvent::Model(model));
    }
    if let Some(effort) = ctx.initial_effort.clone() {
        ctx.dispatch_event(&mut state, EngineEvent::Effort(effort));
    }
    // codex reports usage into its own session log instead of the stdout
    // stream (the stream only carries it with `turn.completed`), so a long
    // turn would otherwise show nothing until it ended. Poll that log
    // alongside the stream once the thread id is known. `read_line_capped`
    // is what makes the select safe: partial bytes stay in the caller-owned
    // buffer across polls, so a tick landing mid-line consumes and drops
    // nothing, and one runaway line can't grow without bound.
    let mut reader = BufReader::new(stdout);
    let mut line_buf = Vec::new();
    let is_codex = ctx.core.engine_id == "codex";
    let mut usage_tail: Option<codex_usage::UsageTail> = None;
    // Only the stream's own thread id (thread.started) may open the log: a
    // resumed run's preassigned id can name a thread the CLI is no longer
    // writing to, and tailing that file would miss this run's reports.
    let mut stream_session_id = false;
    // The CLI writes the rollout at thread start, so the open normally
    // succeeds on the first tick. Bound the retries anyway: each one walks
    // the whole `sessions/**` tree, and a run whose home is not the one being
    // written would walk it every tick for the length of the turn.
    let mut tail_attempts = 0u32;
    let mut poll = tokio::time::interval(std::time::Duration::from_millis(500));
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Pipe EOF alone cannot settle a run: a background grandchild that
    // inherited stdout keeps the pipe open after the CLI's death and parked
    // this loop forever — wait()/registry cleanup never ran and the run's
    // slots leaked. Watch the child directly; once it exits, reads are
    // bounded by POST_EXIT_DRAIN silence and the settle path below runs as
    // usual (its process-group sweep also kills the pipe-holding grandchild).
    // The watcher reaps the child early, so the post-loop wait() returns the
    // cached status; kill()/kill_all() signal the process group directly
    // when try_lock finds this waiter holding the child lock.
    let (exit_tx, mut exit_rx) = tokio::sync::oneshot::channel::<()>();
    {
        let child = Arc::clone(&ctx.child);
        tokio::spawn(async move {
            let mut guard = child.lock().await;
            let _ = guard.wait().await;
            let _ = exit_tx.send(());
        });
    }
    let mut child_exited = false;
    let continues = ctx.core.continues_after_done();
    loop {
        // Evaluated even while the branch is disabled; never polled then.
        let linger_deadline = tokio::time::Instant::from_std(
            state.done_at.unwrap_or_else(Instant::now) + LINGER_GRACE,
        );
        let read = tokio::select! {
            line = read_line_capped(&mut reader, &mut line_buf) => line,
            _ = tokio::time::sleep_until(linger_deadline),
                if continues
                    && !state.native_lifecycle_seen
                    && state.done_at.is_some()
                    && !state.saw_error
                    && !child_exited => {
                // Done arrived, yet the CLI outlived a normal exit: it is
                // finishing background work and will report in a new turn.
                // Show that turn as running now, so the UI queues the next
                // message instead of resuming this session in a second
                // process, and Stop reaches this one.
                // Legacy runs only: a native run's final Done already means
                // idle with no background work and stdin is closed, so a
                // process still alive here is just shutting down. Guessing a
                // continuation would make the UI adopt a phantom `-c1` run
                // (clearing the task catalog); a response the CLI really
                // starts later still opens one via dispatch_event.
                ctx.core.begin_continuation(&mut state);
                continue;
            }
            _ = &mut exit_rx, if !child_exited => {
                child_exited = true;
                continue;
            }
            _ = poll.tick(), if is_codex && !state.saw_done && !state.saw_error => {
                if let Some(tail) = usage_tail.as_mut() {
                    for usage in tail.poll() {
                        ctx.dispatch_event(&mut state, EngineEvent::Usage(usage));
                    }
                } else if stream_session_id && tail_attempts < 20 {
                    // The CLI creates the log a moment after the thread
                    // id arrives. Attempt every tick rather than backing
                    // off: the tail starts at the file's end, so any wait
                    // here is a window in which a record lands unread.
                    tail_attempts += 1;
                    usage_tail = state
                        .native_session_id
                        .as_deref()
                        .and_then(codex_usage::UsageTail::open);
                }
                continue;
            }
            _ = tokio::time::sleep(POST_EXIT_DRAIN), if child_exited => break,
        };
        let line = match read {
            Ok(LineRead::Line(bytes)) => bytes,
            Ok(LineRead::Eof) => break,
            Ok(LineRead::TooLong) => {
                // Size alone does not prove malformed output. Settle as a
                // bounded transport error; dispatch also kills the process
                // tree off-thread instead of allocating an unbounded frame.
                ctx.dispatch_event(
                    &mut state,
                    EngineEvent::Error(format!(
                        "ENGINE_PROTOCOL_FRAME_TOO_LARGE: {} protocol line exceeded the {} MiB limit; run terminated",
                        ctx.core.engine_id,
                        MAX_LINE_BYTES / (1024 * 1024),
                    )),
                );
                break;
            }
            Err(_) => break,
        };
        let text = String::from_utf8_lossy(&line);
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        state.saw_any_output = true;
        if serde_json::from_str::<Value>(trimmed).is_err() {
            // Every engine protocol here is NDJSON: a non-JSON line is
            // off-protocol diagnostics (clap usage errors, shell wrapper
            // complaints, node crashes) that no parse_line would keep.
            ring_push(&ctx.stdout_plain_buf, &format!("{trimmed}\n"));
        }
        let mut events = Vec::new();
        ctx.engine_impl.parse_line(trimmed, &mut events);
        stream_session_id |= events
            .iter()
            .any(|event| matches!(event, EngineEvent::SessionId(_)));
        for mut event in events {
            // Flush the final rollout records BEFORE done/error. Sending them
            // afterwards made observers adopt the already-finished run again.
            if matches!(event, EngineEvent::Done { .. } | EngineEvent::Error(_))
                && !state.saw_done
                && !state.saw_error
            {
                if let Some(tail) = usage_tail.as_mut() {
                    for usage in tail.poll() {
                        ctx.dispatch_event(&mut state, EngineEvent::Usage(usage));
                    }
                    if let EngineEvent::Done {
                        usage: Some(usage), ..
                    } = &mut event
                    {
                        *usage = tail.with_window(usage);
                    }
                }
            }
            ctx.dispatch_event(&mut state, event);
        }
    }

    // Last look at the session log: the final response's record may have
    // landed after the last poll tick.
    if let Some(tail) = usage_tail.as_mut() {
        for usage in tail.poll() {
            ctx.dispatch_event(&mut state, EngineEvent::Usage(usage));
        }
    }

    // Wait for exit
    let status = {
        let mut guard = ctx.child.lock().await;
        guard.wait().await.ok()
    };
    // Unix mirror of the Windows kill-on-close job guard: grandchildren the
    // CLI orphaned (background shells that outlived the turn) are still in
    // the run's process group — sweep them so a settled turn leaks nothing.
    // Clean exit → empty group → ESRCH no-op; a pid-reuse hit would need a
    // fresh process to take the just-reaped pid AND lead a new group within
    // microseconds. pid 0 is never signalled: kill(0, …) targets OUR group.
    #[cfg(unix)]
    if ctx.pid != 0 {
        kill_process_group(ctx.pid);
    }
    for path in &ctx.cleanup_files {
        let _ = std::fs::remove_file(path);
    }
    // Pending questions die with the run: settle their cards so the UI never
    // leaves an answerable question pointing at a dead process.
    for key in [
        state.native_session_id.clone(),
        Some(ctx.core.run_id.clone()),
    ]
    .into_iter()
    .flatten()
    {
        for request_id in ctx.core.registry.take_questions(&key) {
            ctx.dispatch_event(&mut state, EngineEvent::QuestionSettled { request_id });
        }
        expire_parked_plans(&ctx.core, &mut state, &key);
    }
    // Drain this run's registry entries: under the native session id after
    // rekey, and under the run id when the session id never arrived.
    if let Some(key) = state.native_session_id.clone() {
        ctx.core.registry.remove_if_pid(&key, ctx.pid);
    }
    ctx.core.registry.remove_if_pid(&ctx.core.run_id, ctx.pid);
    // Also clean up the preassigned session id alias if one was registered
    // at spawn (grok/codex resume): a resumed session was keyed under
    // ctx.preassigned_session_id, so we must remove that alias even if the
    // native id differs or never arrived.
    if let Some(key) = ctx.preassigned_session_id.as_deref() {
        ctx.core.registry.remove_if_pid(key, ctx.pid);
    }
    // omp writes some failures (upstream 403/5xx, quota exhaustion) to
    // stderr and then exits — sometimes cleanly, after a normal turn_end.
    // A non-empty stderr on a failed exit must reach the user even when a
    // done/error event already settled the turn; dropping it hides exactly
    // the errors the user cannot otherwise see.
    let stderr_text = ctx
        .stderr_buf
        .lock()
        .map(|g| g.trim().to_string())
        .unwrap_or_default();
    let mut stderr_tail = redact_secrets(&stderr_text);
    let failed = status.map(|s| !s.success()).unwrap_or(true);
    let killed = ctx.killed.load(std::sync::atomic::Ordering::SeqCst);
    finish_child_telemetry(ctx.engine_impl.as_ref(), &ctx.core, &mut state, killed || failed);
    let unfinished_tasks = state.tasks.iter().any(|task| matches!(task.status.as_str(), "running" | "paused") && task.ambient != Some(true));
    ctx.core.settle_tasks(&mut state, if killed { "stopped" } else { "unknown" });
    let run_id = ctx.core.current_run_id(&state);
    if ctx.core.engine_id == "agy" && (!killed || state.saw_error) {
        for warning in agy_stderr_warnings(&stderr_text) {
            state.push(
                &ctx.core.sink,
                &run_id,
                &ctx.core.engine_id,
                "warn",
                Value::String(warning),
            );
        }
        if let Some(diagnostic) = agy_stderr_diagnostic(&stderr_text) {
            stderr_tail = diagnostic;
            // stdout may already have explained the failure. Attach the
            // canonical metadata without emitting a second terminal event.
            if state.saw_error || !failed {
                state.push(
                    &ctx.core.sink,
                    &run_id,
                    &ctx.core.engine_id,
                    "warn",
                    Value::String(stderr_tail.clone()),
                );
            }
        }
    }
    if failed && !state.saw_error && !stderr_tail.is_empty()
        && !(ctx.core.engine_id == "agy" && killed)
    {
        state.push(
            &ctx.core.sink,
            &run_id,
            &ctx.core.engine_id,
            "warn",
            Value::String(format!("engine stderr: {stderr_tail}")),
        );
    }

    if !state.saw_done && !state.saw_error {
        let killed = ctx.killed.load(std::sync::atomic::Ordering::SeqCst);
        if killed {
            // User-initiated stop: commit whatever streamed so far as a
            // normal turn end — a SIGKILL'd child is not a failure.
            state.push(
                &ctx.core.sink,
                &run_id,
                &ctx.core.engine_id,
                "done",
                serde_json::json!({ "usage": null, "interrupted": true }),
            );
        } else if failed || !state.saw_any_output || state.attempt_error.is_some() || unfinished_tasks || state.expects_native_settle {
            let mut message = state.attempt_error.take().unwrap_or_else(|| {
                let status_text = status
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| "unknown".to_string());
                // A failed exit must keep its status even when the native
                // lifecycle explains what was left unfinished; a clean exit
                // has none worth reporting.
                let with_status = if failed {
                    format!(" with status {status_text}")
                } else {
                    String::new()
                };
                if unfinished_tasks {
                    format!("{} exited{with_status} before its native tasks settled", ctx.core.engine_id)
                } else if state.expects_native_settle {
                    format!("{} exited{with_status} before its native run settled", ctx.core.engine_id)
                } else { format!(
                    "{} exited with status {status_text}",
                    ctx.core.engine_id
                ) }
            });
            if !stderr_tail.is_empty() {
                message.push_str(&format!(": {stderr_tail}"));
            } else {
                // Startup failures of old/odd CLIs often land on stdout as
                // plain text instead of stderr; without this fallback the
                // banner is a bare exit code.
                let stdout_tail = ctx
                    .stdout_plain_buf
                    .lock()
                    .map(|g| redact_secrets(g.trim()))
                    .unwrap_or_default();
                if !stdout_tail.is_empty() {
                    message.push_str(&format!(": {stdout_tail}"));
                }
            }
            state.push(
                &ctx.core.sink,
                &run_id,
                &ctx.core.engine_id,
                "error",
                Value::String(message),
            );
        } else {
            // Clean EOF without an explicit done line (kimi).
            state.push(
                &ctx.core.sink,
                &run_id,
                &ctx.core.engine_id,
                "done",
                serde_json::json!({ "usage": null }),
            );
        }
    }
    if status.is_some() {
        state.confirm_exit(&ctx.core);
    }
    if super::sidechat::is_ephemeral_run_id(&ctx.core.run_id) {
        super::sidechat::spawn_ephemeral_cleanup(
            ctx.core.db.clone(),
            ctx.core.engine_id.clone(),
            state.native_session_id.clone(),
        );
    }
    super::sidechat::finish_run(&ctx.core.run_id);
    ctx.core.sink.flush();
}
#[cfg(test)]
mod staging_tests {
    use super::*;
    use crate::engine::ChildEntry;
    use std::collections::HashMap;

    #[test]
    fn agy_structured_stderr_keeps_failure_metadata_and_redacts_secrets() {
        let stderr = "startup notice\nAGY_ERROR: {\"status\":\"RESOURCE_EXHAUSTED\",\"code\":429,\"retryable\":false,\"error_id\":\"quota-1\",\"message\":\"bearer private-token\"}\n";
        let diagnostic = agy_stderr_diagnostic(stderr).unwrap();
        let value: Value =
            serde_json::from_str(diagnostic.strip_prefix("AGY_ERROR: ").unwrap()).unwrap();
        assert_eq!(value["code"], 429);
        assert_eq!(value["retryable"], false);
        assert_eq!(value["error_id"], "quota-1");
        assert!(!diagnostic.contains("private-token"));
        assert!(!diagnostic.contains("startup notice"));
        assert!(agy_stderr_diagnostic("AGY_ERROR: {truncated").is_none());
    }

    #[test]
    fn agy_success_warnings_preserve_partial_output_notice_without_startup_noise() {
        assert_eq!(agy_stderr_warnings("Fetching models...\nwarning: output may be truncated\nwarning: output may be truncated\n"), vec!["warning: output may be truncated"]);
        assert!(agy_stderr_warnings("ordinary startup notice").is_empty());
    }

    /// The ring truncates by byte count: a naive drain start can land
    /// mid-CJK and panic (killing the stderr capture task silently).
    #[test]
    fn ring_push_snaps_truncation_to_char_boundary() {
        let buf = Arc::new(Mutex::new(String::new()));
        ring_push(&buf, &"引擎错误".repeat(1000));
        // std Mutex stays: ring buffers are deliberately poison-tolerant
        // (a panicked capture task must not take down error reporting).
        let kept = buf.lock().unwrap_or_else(|p| p.into_inner());
        assert!(kept.len() <= 4096);
        assert!(kept.ends_with("引擎错误"));
    }

    struct Noop;
    impl event_sink::Emit for Noop {
        fn emit_json(&self, _: &str, _: &str) {}
    }

    #[tokio::test]
    async fn reader_context_cleans_private_configs_on_completion_and_abort() {
        for abort in [false, true] {
            let directory =
                std::env::temp_dir().join(format!("ccgui-reader-cleanup-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(directory.join("config.toml"), "temporary credential").unwrap();
            let mut command = Command::new(if cfg!(windows) { "cmd.exe" } else { "sh" });
            command.args(if cfg!(windows) {
                ["/c", "exit 0"]
            } else {
                ["-c", "exit 0"]
            });
            let mut child = command.spawn().unwrap();
            child.wait().await.unwrap();
            let ctx = RunContext {
                request_started_at: None,
                core: TurnCore {
                    sink: event_sink::EventSink::new(Arc::new(Noop)),
                    registry: Arc::new(ProcessRegistry::default()),
                    engine_id: "grok".into(),
                    run_id: "test".into(),
                    db: None,
                },
                engine_impl: Box::new(grok::GrokEngine),
                pid: 0,
                preassigned_session_id: None,
                initial_model: None,
                initial_effort: None,
                child: Arc::new(TokioMutex::new(child)),
                killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                cleanup_files: vec![directory.clone()],
                mcp_restore: None,
                stderr_buf: Arc::new(Mutex::new(String::new())),
                stdout_plain_buf: Arc::new(Mutex::new(String::new())),
                // Upstream's own constructor omits this Windows-only guard
                // field (E0063 on Windows); a plain test child owns no job.
                #[cfg(windows)]
                _tree_guard: None,
            };
            let task = tokio::spawn(async move {
                if abort {
                    std::future::pending::<()>().await;
                }
                drop(ctx);
            });
            if abort {
                task.abort();
            }
            let result = task.await;
            assert_eq!(result.is_err(), abort);
            assert!(!directory.exists());
        }
    }

    /// Slot accounting must survive a reader that dies without reaching
    /// either settle path (abort here; a panic inside dispatch is the same
    /// shape). Nothing sweeps dead pids, so a stranded key pins a
    /// concurrency slot until app exit and sending eventually wedges on
    /// "too many concurrent runs".
    #[tokio::test]
    async fn dropping_a_run_context_frees_the_runs_concurrency_slot() {
        let mut command = Command::new(if cfg!(windows) { "cmd.exe" } else { "sh" });
        command.args(if cfg!(windows) {
            ["/c", "exit 0"]
        } else {
            ["-c", "exit 0"]
        });
        let mut child = command.spawn().unwrap();
        child.wait().await.unwrap();
        let registry = Arc::new(ProcessRegistry::default());
        let entry = ChildEntry {
            child: None,
            pid: 4242,
            run_id: "run-abort".into(),
            killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            reader_abort: Arc::new(std::sync::OnceLock::new()),
            stdin: None,
            questions: Arc::new(Mutex::new(HashMap::new())),
            plans: Arc::new(Mutex::new(HashMap::new())),
            native_tasks: Default::default(),
            codex_control: None,
        };
        registry.insert("run-abort".into(), entry.clone());
        registry.insert_alias("session-abort".into(), entry);
        let ctx = RunContext {
            request_started_at: None,
            core: TurnCore {
                sink: event_sink::EventSink::new(Arc::new(Noop)),
                registry: Arc::clone(&registry),
                engine_id: "grok".into(),
                run_id: "run-abort".into(),
                db: None,
            },
            engine_impl: Box::new(grok::GrokEngine),
            pid: 4242,
            preassigned_session_id: None,
            initial_model: None,
            initial_effort: None,
            child: Arc::new(TokioMutex::new(child)),
            killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            cleanup_files: Vec::new(),
            mcp_restore: None,
            stderr_buf: Arc::new(Mutex::new(String::new())),
            stdout_plain_buf: Arc::new(Mutex::new(String::new())),
            #[cfg(windows)]
            _tree_guard: None,
        };
        let task = tokio::spawn(async move {
            let _held = ctx;
            std::future::pending::<()>().await;
        });
        task.abort();
        assert!(task.await.is_err());

        assert!(
            registry.get("run-abort").is_none(),
            "run-id key survived the abort"
        );
        assert!(
            registry.get("session-abort").is_none(),
            "session alias survived the abort"
        );
    }

    /// Virtual (host-stream) runs own no RunContext: the guard is what frees
    /// their keys when the transport task is aborted instead of settling.
    #[tokio::test]
    async fn dropping_a_virtual_run_guard_frees_every_key_of_that_run() {
        let registry = Arc::new(ProcessRegistry::default());
        let entry = ChildEntry {
            child: None,
            pid: 5150,
            run_id: "run-v".into(),
            killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            reader_abort: Arc::new(std::sync::OnceLock::new()),
            stdin: None,
            questions: Arc::new(Mutex::new(HashMap::new())),
            plans: Arc::new(Mutex::new(HashMap::new())),
            native_tasks: Default::default(),
            codex_control: None,
        };
        registry.insert("run-v".into(), entry.clone());
        registry.insert_alias("session-v".into(), entry);
        // Another run's entry must be left alone.
        registry.insert(
            "run-other".into(),
            ChildEntry {
                child: None,
                pid: 5151,
                run_id: "run-other".into(),
                killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                reader_abort: Arc::new(std::sync::OnceLock::new()),
                stdin: None,
                questions: Arc::new(Mutex::new(HashMap::new())),
                plans: Arc::new(Mutex::new(HashMap::new())),
                native_tasks: Default::default(),
                codex_control: None,
            },
        );

        {
            let _guard = VirtualRunGuard::new(Arc::clone(&registry), "run-v".into(), 5150);
            assert!(registry.get("run-v").is_some());
        }

        assert!(registry.get("run-v").is_none());
        assert!(registry.get("session-v").is_none());
        assert!(
            registry.get("run-other").is_some(),
            "unrelated run was swept"
        );
    }
}
#[cfg(test)]
mod terminal_event_tests {
    use super::*;
    use crate::engine::ChildEntry;
    use std::collections::HashMap;

    #[tokio::test]
    async fn cursor_prompt_cache_records_only_successful_native_completion() {
        for outcome in ["success", "error", "killed", "missing-start"] {
            let db = Arc::new(crate::db::Db::open_at(std::path::Path::new(":memory:")).unwrap());
            let collector = Arc::new(Collector::default());
            let registry = Arc::new(ProcessRegistry::default());
            registry.insert("cursor-cache-run".into(), ChildEntry {
                child: None, pid: 0, run_id: "cursor-cache-run".into(),
                killed: Arc::new(std::sync::atomic::AtomicBool::new(outcome == "killed")),
                reader_abort: Arc::new(std::sync::OnceLock::new()), stdin: None,
                questions: Arc::new(Mutex::new(HashMap::new())),
                plans: Arc::new(Mutex::new(HashMap::new())),
                native_tasks: Default::default(), codex_control: None,
            });
            let core = TurnCore {
                sink: event_sink::EventSink::new(collector.clone()), registry,
                engine_id: "cursor".into(), run_id: "cursor-cache-run".into(), db: Some(db.clone()),
            };
            let mut state = TurnState::new(Some("cursor-cache-session".into()));
            let started_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64 - 60_000;
            if outcome != "missing-start" { state.request_started_at = Some(started_at); }
            if outcome == "error" { core.dispatch_event(&mut state, EngineEvent::Error("failed".into())); }
            core.dispatch_event(&mut state, EngineEvent::Done { session_id: None, usage: None });
            let before = crate::history::prompt_cache::load_all(&db.0.lock()).unwrap();
            if outcome == "success" {
                let window = &before["cursor:cursor-cache-session"];
                assert_eq!(window.ttl_seconds, 300);
                assert_eq!(window.started_at, started_at);
                assert!(window.observed_at >= started_at + 60_000);
                assert_eq!(window.source, "cursor-policy");
                assert!(collector.1.lock().unwrap().iter().any(|name| name == event_sink::SESSIONS_CHANGED_EVENT));
                assert_eq!(window.heat(started_at + 299_999), "hot");
                assert_eq!(window.heat(window.observed_at + 300_000), "cold");
            } else { assert!(before.is_empty(), "{outcome}"); }
            state.request_started_at = Some(started_at + 1);
            core.dispatch_event(&mut state, EngineEvent::Done { session_id: None, usage: None });
            assert_eq!(crate::history::prompt_cache::load_all(&db.0.lock()).unwrap(), before);
        }
    }

    #[derive(Default)]
    struct Collector(Mutex<Vec<Value>>, Mutex<Vec<String>>);
    impl event_sink::Emit for Collector {
        fn emit_json(&self, name: &str, raw: &str) {
            if matches!(name, event_sink::ENGINE_EVENT_NAME | event_sink::PLUGIN_AGENT_EVENT_NAME) {
                self.0.lock().unwrap().extend(serde_json::from_str::<Vec<Value>>(raw).unwrap());
            } else {
                assert_eq!(raw, "null");
                self.1.lock().unwrap().push(name.to_owned());
            }
        }
    }

    #[tokio::test]
    async fn agy_reader_preserves_error_cleanup_metadata_and_success_warnings() {
        let diagnostic = r#"AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","retryable":false,"error_id":"quota-fixture"}"#;
        let cases = [
            (r#"{"event":"result","result":{"status":"ERROR","error":"quota exhausted"}}"#, diagnostic, 3, true, true, false, true),
            (r#"{"event":"result","result":{"status":"SUCCESS"}}"#, "warning: output may be truncated", 0, false, false, true, false),
            ("", diagnostic, 3, true, false, false, false),
        ];
        for (line, stderr, exit_code, killed, has_diagnostic, has_warning, has_error) in cases {
            // A real bounded child supplies stdout; the stderr ring is seeded
            // so the test is independent of the two pipes' scheduling order.
            let mut command = Command::new(if cfg!(windows) { "powershell.exe" } else { "sh" });
            if cfg!(windows) {
                command.args(["-NoProfile", "-NonInteractive", "-Command", &format!("[Console]::Out.WriteLine('{line}'); exit {exit_code}")]);
            } else {
                command.args(["-c", &format!("printf '%s\\n' '{line}'; exit {exit_code}")]);
            }
            command.stdout(std::process::Stdio::piped());
            let mut child = command.spawn().unwrap();
            let stdout = child.stdout.take().unwrap();
            assert_eq!(child.wait().await.unwrap().code(), Some(exit_code));
            let collector = Arc::new(Collector::default());
            let ctx = RunContext {
                request_started_at: None,
                core: TurnCore {
                    sink: event_sink::EventSink::new(collector.clone()),
                    registry: Arc::new(ProcessRegistry::default()),
                    engine_id: "agy".into(),
                    run_id: "agy-stderr-fixture".into(),
                    db: None,
                },
                engine_impl: Box::new(crate::engine::agy::AgyEngine::new()),
                pid: 0,
                preassigned_session_id: None,
                initial_model: None,
                initial_effort: None,
                child: Arc::new(TokioMutex::new(child)),
                killed: Arc::new(std::sync::atomic::AtomicBool::new(killed)),
                cleanup_files: Vec::new(),
                mcp_restore: None,
                stderr_buf: Arc::new(Mutex::new(stderr.into())),
                stdout_plain_buf: Arc::new(Mutex::new(String::new())),
                #[cfg(windows)]
                _tree_guard: None,
            };
            run_reader(stdout, ctx).await;
            let events = collector.0.lock().unwrap();
            assert_eq!(events.iter().any(|e| e["kind"] == "warn" && e["data"].as_str().is_some_and(|text| text.contains("quota-fixture"))), has_diagnostic);
            assert_eq!(events.iter().any(|e| e["kind"] == "warn" && e["data"] == "warning: output may be truncated"), has_warning);
            assert_eq!(events.iter().any(|e| e["kind"] == "error"), has_error);
            if has_error { assert!(!events.iter().any(|e| e["kind"] == "done")); }
        }
    }

    #[tokio::test]
    async fn a_rejected_final_identity_is_an_error_and_never_a_successful_done() {
        for engine in ["claude", "codex"] {
            let collector = Arc::new(Collector::default());
            let core = TurnCore {
                sink: event_sink::EventSink::new(collector.clone()),
                registry: Arc::new(ProcessRegistry::default()),
                engine_id: engine.into(), run_id: format!("identity-final-{engine}"), db: None,
            };
            let mut state = TurnState::new(None);
            core.dispatch_event(&mut state, EngineEvent::Done {
                session_id: Some("  ".into()), usage: None,
            });
            core.sink.flush();
            assert!(state.saw_error);
            assert!(!state.saw_done);
            assert!(state.native_session_id.is_none());
            let events = collector.0.lock().unwrap();
            assert_eq!(events.len(), 1);
            assert_eq!(events[0]["kind"], "error");
            assert!(events[0]["sessionId"].is_null());
        }
    }

    #[tokio::test]
    async fn plugin_pi_and_codex_terminals_wait_for_confirmed_exit() {
        for engine in ["pi", "codex"] {
            for fail in [false, true] {
                let collector = Arc::new(Collector::default());
                let core = TurnCore {
                    sink: event_sink::EventSink::with_name(
                        collector.clone(),
                        event_sink::PLUGIN_AGENT_EVENT_NAME,
                    ),
                    registry: Arc::new(ProcessRegistry::default()),
                    engine_id: engine.into(),
                    run_id: "pa-relay-test".into(),
                    db: None,
                };
                let mut state = TurnState::new(None);
                core.dispatch_event(
                    &mut state,
                    if fail {
                        EngineEvent::Error("failed".into())
                    } else {
                        EngineEvent::Done {
                            session_id: None,
                            usage: None,
                        }
                    },
                );
                core.sink.flush();
                assert!(collector.0.lock().unwrap().is_empty());
                state.confirm_exit(&core);
                state.confirm_exit(&core);
                core.sink.flush();
                let events = collector.0.lock().unwrap();
                assert_eq!(events.len(), 1);
                assert_eq!(events[0]["kind"], if fail { "error" } else { "done" });
            }
        }
    }

    #[tokio::test]
    async fn agy_host_protocol_error_records_one_excluded_observation() {
        let db = Arc::new(crate::db::Db::open_at(std::path::Path::new(":memory:")).unwrap());
        let collector = Arc::new(Collector::default());
        let core = TurnCore {
            sink: event_sink::EventSink::new(collector.clone()),
            registry: Arc::new(ProcessRegistry::default()), engine_id: "agy".into(),
            run_id: "agy-host-error-test".into(), db: Some(Arc::clone(&db)),
        };
        let engine = crate::engine::agy::AgyEngine::new();
        let mut state = TurnState::new(None);
        for line in [
            serde_json::json!({"event":"init","conversation_id":"root","init":{}}),
            serde_json::json!({"event":"step_update","step_update":{"conversation_id":"root","step_type":"user_input","state":"DONE","step_index":0}}),
            serde_json::json!({"event":"step_update","step_update":{"conversation_id":"root","step_type":"agent_response","state":"DONE","step_index":1,"usage":{"input_tokens":100,"output_tokens":20,"total_tokens":120}}}),
        ] {
            let mut events = Vec::new();
            engine.parse_line(&line.to_string(), &mut events);
            for event in events { dispatch_child_event(&engine, &core, &mut state, event); }
        }
        dispatch_child_event(&engine, &core, &mut state, EngineEvent::Error("protocol line too long".into()));
        finish_child_telemetry(&engine, &core, &mut state, true);
        let totals = crate::throughput_stats::read(&db, Some("agy"), Some("root")).unwrap();
        assert_eq!(totals.session.completed_turns, 0);
        assert_eq!(totals.session.excluded_turns, 1);
        assert_eq!(totals.session.output_tokens, 0);
        core.sink.flush();
        let events = collector.0.lock().unwrap();
        let kinds: Vec<_> = events.iter().map(|e| e["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["session", "throughput", "error"]);
        assert_eq!(events[1]["data"]["status"], "partial");
        assert!(state.saw_error);
        assert_eq!(state.continuations, 0);
    }

    #[tokio::test]
    async fn throughput_is_passive_and_cannot_reopen_a_completed_turn() {
        let collector = Arc::new(Collector::default());
        let core = TurnCore {
            sink: event_sink::EventSink::new(collector.clone()),
            registry: Arc::new(ProcessRegistry::default()),
            engine_id: "claude".into(),
            run_id: "throughput-passive-test".into(),
            db: None,
        };
        let mut state = TurnState::new(Some("session".into()));
        let sample = serde_json::json!({
            "version": 1, "source": "claude", "status": "running",
            "outputTokens": 20, "elapsedMs": 1000, "generation": null,
            "generationReason": "missing_usage"
        });
        core.dispatch_event(&mut state, EngineEvent::Throughput(sample.clone()));
        assert!(state.gen_open_since.is_none());
        assert_eq!(state.gen_ms, 0);
        assert!(!state.native_lifecycle_seen);
        core.dispatch_event(&mut state, EngineEvent::Delta("完整输出 🐎".into()));
        let opened = state.gen_open_since;
        core.dispatch_event(&mut state, EngineEvent::Throughput(sample.clone()));
        assert_eq!(state.gen_open_since, opened, "telemetry must not consume generation timing");
        core.dispatch_event(&mut state, EngineEvent::Done { session_id: None, usage: None });
        core.dispatch_event(&mut state, EngineEvent::Throughput(sample.clone()));
        assert!(state.saw_done);
        assert_eq!(state.continuations, 0, "telemetry is not new model activity");
        core.sink.flush();
        let events = collector.0.lock().unwrap();
        let kinds: Vec<_> = events.iter().map(|event| event["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["throughput", "delta", "throughput", "done"]);
        assert_eq!(events[0]["data"], sample);
        assert_eq!(events[1]["data"], "完整输出 🐎");
        assert_eq!(events[2]["seq"].as_u64().unwrap(), events[1]["seq"].as_u64().unwrap() + 1);
    }

    #[tokio::test]
    async fn throughput_ledger_keeps_continuations_and_adopts_late_session_ids() {
        let db = Arc::new(crate::db::Db::open_at(std::path::Path::new(":memory:")).unwrap());
        // No GUI/global notifier exists here, just as in a task worker.
        let collector = Arc::new(Collector::default());
        let core = TurnCore {
            sink: event_sink::EventSink::new(collector.clone()),
            registry: Arc::new(ProcessRegistry::default()), engine_id: "claude".into(),
            run_id: "throughput-ledger-test".into(), db: Some(Arc::clone(&db)),
        };
        let mut state = TurnState::new(None);
        let sample = serde_json::json!({"version":1,"source":"claude","status":"complete","outputTokens":20,"elapsedMs":1000});
        core.dispatch_event(&mut state, EngineEvent::Throughput(sample.clone()));
        core.dispatch_event(&mut state, EngineEvent::Done { session_id: None, usage: None });
        core.dispatch_event(&mut state, EngineEvent::Throughput(sample.clone()));
        assert_eq!(crate::throughput_stats::read(&db, None, None).unwrap().global.completed_turns, 1);
        assert_eq!(*collector.1.lock().unwrap(), ["throughput://changed"]);
        core.dispatch_event(&mut state, EngineEvent::SessionId("throughput-native".into()));
        assert_eq!(crate::throughput_stats::read(&db, Some("claude"), Some("throughput-native")).unwrap().session.completed_turns, 1);
        assert_eq!(collector.1.lock().unwrap().len(), 2, "late binding must invalidate session totals");
        core.dispatch_event(&mut state, EngineEvent::Delta("another reply".into()));
        assert_eq!(state.continuations, 1);
        core.dispatch_event(&mut state, EngineEvent::Throughput(sample));
        core.dispatch_event(&mut state, EngineEvent::Done { session_id: None, usage: None });
        let totals = crate::throughput_stats::read(&db, Some("claude"), Some("throughput-native")).unwrap();
        assert_eq!(totals.session.completed_turns, 2);
        assert_eq!(totals.session.output_tokens, 40);
        assert_eq!(totals.session.elapsed_ms, 2000.0);
        assert_eq!(*collector.1.lock().unwrap(), ["throughput://changed"; 3]);
        assert_eq!(crate::throughput_stats::read(&db, Some("claude"), Some("other-session")).unwrap().session.completed_turns, 0);
    }

    #[tokio::test]
    async fn usage_reports_carry_the_measured_generation_window() {
        let collector = Arc::new(Collector::default());
        let core = TurnCore {
            sink: event_sink::EventSink::new(collector.clone()),
            registry: Arc::new(ProcessRegistry::default()),
            engine_id: "pi".into(),
            run_id: "gen-ms-test".into(),
            db: None,
        };
        let mut state = TurnState::new(Some("session".into()));
        let tool_start = || EngineEvent::Message {
            role: "tool".into(),
            text: "read".into(),
            path: None,
            todos: None,
            args: None,
            result: None,
            patch: false,
        };

        // Explicit window: a mid-response tool row (claude streams tool args
        // inside the same message) must not close it.
        core.dispatch_event(&mut state, EngineEvent::Generation { active: true });
        core.dispatch_event(&mut state, EngineEvent::Delta("hi".into()));
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        core.dispatch_event(&mut state, tool_start());
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        core.dispatch_event(
            &mut state,
            EngineEvent::Usage(serde_json::json!({"output_tokens": 3})),
        );

        // Implicit (delta-opened) window: the tool row closes it, so the
        // next usage report only measures what ran before the tool.
        core.dispatch_event(&mut state, EngineEvent::Delta("mid".into()));
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        core.dispatch_event(&mut state, tool_start());
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        core.dispatch_event(
            &mut state,
            EngineEvent::Usage(serde_json::json!({"output_tokens": 3})),
        );

        core.sink.flush();
        let events = collector.0.lock().unwrap();
        let usages: Vec<u64> = events
            .iter()
            .filter(|event| event["kind"] == "usage")
            .filter_map(|event| event.get("genMs").and_then(Value::as_u64))
            .collect();
        assert_eq!(usages.len(), 2, "both usage reports carry genMs");
        assert!(usages[0] >= 200, "explicit window ignored the tool row: {usages:?}");
        assert!(usages[1] < 200, "implicit window closed at the tool row: {usages:?}");
    }

    #[tokio::test]
    async fn terminal_runs_do_not_emit_late_usage_text_or_duplicate_completion() {
        for fail in [false, true] {
            let collector = Arc::new(Collector::default());
            let core = TurnCore {
                sink: event_sink::EventSink::new(collector.clone()),
                registry: Arc::new(ProcessRegistry::default()),
                engine_id: "codex".into(),
                run_id: "terminal-test".into(),
                db: None,
            };
            let mut state = TurnState::new(Some("session".into()));
            core.dispatch_event(&mut state, EngineEvent::Delta("完成中文与 emoji 🐎".into()));
            core.dispatch_event(
                &mut state,
                EngineEvent::Usage(
                    serde_json::json!({"input_tokens": 90000, "model_context_window":1000000}),
                ),
            );
            core.dispatch_event(
                &mut state,
                if fail {
                    EngineEvent::Error("failed".into())
                } else {
                    EngineEvent::Done {
                        session_id: None,
                        usage: None,
                    }
                },
            );
            core.dispatch_event(
                &mut state,
                EngineEvent::Usage(serde_json::json!({"input_tokens":90000})),
            );
            core.dispatch_event(&mut state, EngineEvent::Delta("late".into()));
            core.dispatch_event(
                &mut state,
                EngineEvent::Done {
                    session_id: None,
                    usage: None,
                },
            );
            core.sink.flush();
            let events = collector.0.lock().unwrap();
            let kinds: Vec<_> = events
                .iter()
                .map(|event| event["kind"].as_str().unwrap())
                .collect();
            assert_eq!(
                kinds,
                ["delta", "usage", if fail { "error" } else { "done" }]
            );
            assert_eq!(events[0]["data"], "完成中文与 emoji 🐎");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn plugin_pi_interrupt_emits_terminal_only_after_child_exit() {
        for early_done in [false, true] {
            let mut command = Command::new("sh");
            let delta = r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"ready"}}"#;
            let done = if early_done {
                r#"printf '%s\n' '{"type":"agent_end","messages":[{"role":"assistant","stopReason":"stop"}]}';"#
            } else {
                ""
            };
            command.args([
                "-c",
                &format!("printf '%s\\n' '{delta}'; {done} exec sleep 30"),
            ]);
            command
                .stdout(std::process::Stdio::piped())
                .process_group(0)
                .kill_on_drop(true);
            let mut child = command.spawn().unwrap();
            let pid = child.id().unwrap();
            let stdout = child.stdout.take().unwrap();
            let child = Arc::new(TokioMutex::new(child));
            let collector = Arc::new(Collector::default());
            let sink = event_sink::EventSink::with_name(
                collector.clone(),
                event_sink::PLUGIN_AGENT_EVENT_NAME,
            );
            let registry = Arc::new(ProcessRegistry::default());
            let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let run_id = "pa-relay-interrupt";
            registry.insert(
                run_id.into(),
                crate::engine::ChildEntry {
                    child: Some(child.clone()),
                    pid,
                    run_id: run_id.into(),
                    killed: killed.clone(),
                    reader_abort: Arc::new(std::sync::OnceLock::new()),
                    stdin: None,
                    questions: Arc::new(Mutex::new(std::collections::HashMap::new())),
                    plans: Arc::new(Mutex::new(std::collections::HashMap::new())),
                    native_tasks: Default::default(),
                    codex_control: None,
                },
            );
            let context = RunContext {
                request_started_at: None,
                core: TurnCore {
                    sink: sink.clone(),
                    registry: registry.clone(),
                    engine_id: "pi".into(),
                    run_id: run_id.into(),
                    db: None,
                },
                engine_impl: Box::new(crate::engine::pi_family::pi()),
                pid,
                preassigned_session_id: None,
                initial_model: None,
                initial_effort: None,
                child: child.clone(),
                killed,
                cleanup_files: vec![],
                mcp_restore: None,
                stderr_buf: Arc::new(Mutex::new(String::new())),
                stdout_plain_buf: Arc::new(Mutex::new(String::new())),
            };
            let reader = tokio::spawn(run_reader(stdout, context));
            tokio::time::timeout(std::time::Duration::from_secs(3), async {
                loop {
                    sink.flush();
                    if !collector.0.lock().unwrap().is_empty() {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            sink.flush();
            assert!(!collector
                .0
                .lock()
                .unwrap()
                .iter()
                .any(|event| matches!(event["kind"].as_str(), Some("done" | "error"))));
            assert!(registry.kill(run_id));
            tokio::time::timeout(std::time::Duration::from_secs(3), reader)
                .await
                .unwrap()
                .unwrap();
            assert!(child.lock().await.try_wait().unwrap().is_some());
            assert_eq!(registry.active_run_count(), 0);
            let events = collector.0.lock().unwrap();
            assert_eq!(
                events
                    .iter()
                    .filter(|event| matches!(event["kind"].as_str(), Some("done" | "error")))
                    .count(),
                1
            );
            assert_eq!(events.last().unwrap()["kind"], "done");
        }
    }
}
#[cfg(test)]
mod plan_dispatch_tests {
    //! PlanReviewReady 的 dispatch 契约:落盘赋 revision、停车上下文顶层
    //! 平铺 {revision, route, frames, ...}(respond_plan_review 按此读取)、
    //! 事件载荷不含原生上下文;审批事实源写失败则转 Error 落定、不停车。
    use super::*;
    use crate::engine::ChildEntry;
    use std::collections::HashMap;

    #[derive(Default)]
    struct Collector(Mutex<Vec<Value>>);
    impl event_sink::Emit for Collector {
        fn emit_json(&self, _: &str, raw: &str) {
            self.0
                .lock()
                .unwrap()
                .extend(serde_json::from_str::<Vec<Value>>(raw).unwrap());
        }
    }

    fn ready_core(
        tag: &str,
        drop_table: bool,
    ) -> (TurnCore, Arc<Collector>, Arc<crate::db::Db>) {
        let dir = std::env::temp_dir().join(format!(
            "ccgui-plan-dispatch-{tag}-{}-{}",
            std::process::id(),
            plan_review::now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Arc::new(crate::db::Db::open_at(&dir.join("app.db")).unwrap());
        if drop_table {
            db.0.lock()
                .execute("DROP TABLE plan_reviews", [])
                .unwrap();
        }
        let collector = Arc::new(Collector::default());
        let core = TurnCore {
            sink: event_sink::EventSink::new(collector.clone()),
            registry: Arc::new(ProcessRegistry::default()),
            engine_id: "dsh".into(),
            run_id: "run-plan".into(),
            db: Some(Arc::clone(&db)),
        };
        core.registry.insert(
            "run-plan".into(),
            ChildEntry {
                child: None,
                pid: 4242,
                run_id: "run-plan".into(),
                killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                reader_abort: Arc::new(std::sync::OnceLock::new()),
                stdin: None,
                questions: Arc::new(Mutex::new(HashMap::new())),
                plans: Arc::new(Mutex::new(HashMap::new())),
                native_tasks: Default::default(),
                codex_control: None,
            },
        );
        (core, collector, db)
    }

    fn review(plan_id: &str) -> plan_review::PlanReview {
        plan_review::PlanReview {
            plan_id: plan_id.into(),
            engine: "dsh".into(),
            session_id: "sess-plan".into(),
            workspace_path: "/tmp/ccgui-plan-dispatch-ws".into(),
            run_id: Some("run-plan".into()),
            revision: 0,
            title: "Dispatch plan".into(),
            content: "# Plan\n\nbody".into(),
            content_hash: plan_review::content_hash("# Plan\n\nbody"),
            complete: true,
            review_kind: plan_review::PlanReviewKind::NativeRequest,
            native_plan_id: Some("native-1".into()),
            exec_permission: "auto".into(),
            status: plan_review::PlanStatus::AwaitingReview,
            execution: plan_review::PlanExecution::NotStarted,
            decision: None,
            decision_intent_at: None,
            applied_at: None,
            created_at: 0,
            updated_at: 0,
            superseded_by: None,
        }
    }

    #[tokio::test]
    async fn plan_review_ready_persists_parks_flat_and_emits_without_context() {
        let (core, collector, db) = ready_core("ok", false);
        let mut state = TurnState::new(Some("sess-plan".into()));
        core.dispatch_event(
            &mut state,
            EngineEvent::PlanReviewReady {
                record: Box::new(review("plan-x")),
                context: serde_json::json!({
                    "route": "stdin",
                    "frames": {"approve": {"ok": true}},
                }),
            },
        );
        core.sink.flush();

        // 落盘:revision 由后端赋值。
        let stored = plan_review::get_review(&db, "plan-x", 1)
            .unwrap()
            .expect("record persisted");
        assert_eq!(stored.revision, 1);
        assert_eq!(stored.status, plan_review::PlanStatus::AwaitingReview);

        // 停车:context 顶层平铺 + 后端注入的 revision,供 respond 直接读。
        let entry = core.registry.get("run-plan").unwrap();
        let parked = entry.plans.lock().unwrap().get("plan-x").cloned().unwrap();
        assert_eq!(parked["revision"], 1);
        assert_eq!(parked["route"], "stdin");
        assert!(parked["frames"]["approve"]["ok"].as_bool().unwrap());

        // 事件:camelCase record,永不含原生回复上下文。
        let events = collector.0.lock().unwrap();
        let payload = events
            .iter()
            .find(|event| event["kind"].as_str() == Some("plan_review"))
            .expect("plan_review event emitted");
        assert_eq!(payload["data"]["planId"], "plan-x");
        assert_eq!(payload["data"]["revision"], 1);
        assert_eq!(payload["sessionId"], "sess-plan");
        assert!(payload["data"].get("context").is_none(), "{payload}");
        assert!(payload["data"].get("frames").is_none(), "{payload}");
    }

    #[tokio::test]
    async fn a_persistence_failure_settles_as_error_without_parking() {
        let (core, collector, _db) = ready_core("fail", true);
        let mut state = TurnState::new(Some("sess-plan".into()));
        core.dispatch_event(
            &mut state,
            EngineEvent::PlanReviewReady {
                record: Box::new(review("plan-y")),
                context: serde_json::json!({"route": "stdin"}),
            },
        );
        core.sink.flush();

        // 审批事实源写不进去:不停车、不推 plan_review,按 Error 落定——
        // 绝不假装这个计划可以审批。
        let entry = core.registry.get("run-plan").unwrap();
        assert!(entry.plans.lock().unwrap().is_empty());
        let events = collector.0.lock().unwrap();
        assert!(
            events
                .iter()
                .all(|event| event["kind"].as_str() != Some("plan_review")),
            "{events:?}"
        );
        let error = events
            .iter()
            .find(|event| event["kind"].as_str() == Some("error"))
            .expect("persistence failure surfaces as error");
        assert!(
            error["data"]
                .as_str()
                .unwrap()
                .contains("could not be persisted"),
            "{error}"
        );
    }
}
