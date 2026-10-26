//! Codex **app-server** transport (`codex app-server`), the codex path that can
//! actually ask the user a question mid-turn.
//!
//! The exec transport (`codex.rs`) launches the same CLI one-shot: it resolves
//! its own `requestUserInput` prompts from the defaults baked into the run, so a
//! question never reaches the app's card UI. The app-server is a resident
//! JSON-RPC peer instead — it *asks* by sending a server→client request and
//! parks the turn until an answer arrives on stdin. This module owns that
//! channel: the pump that reads stdout, the projection of the protocol's items
//! onto the app's event kinds, and `answer_frame`, the response the shared
//! answer command writes when the user picks an option.
//!
//! Wire (verified against the installed CLI, whose shipped JSON schema is the
//! source of truth here): `initialize {clientInfo}` → `thread/start
//! {cwd, sandbox, approvalPolicy}` (or `thread/resume {threadId}` for a session
//! the app already holds) → `turn/start {threadId, input}`, which acknowledges
//! immediately with `{turn:{id}}`; the work then streams as `item/*` and
//! `item/agentMessage/delta` notifications and only `turn/completed` ends the
//! turn. Two schema facts shape the code below: `turn/completed` carries no
//! usage (it arrives earlier via `thread/tokenUsage/updated`), and there is no
//! `turn/failed` notification — a failed turn is a `turn/completed` whose
//! `turn.status` is `failed` with an explanatory `turn.error.message`. Both
//! shapes are terminal. Active turns have no total time limit; RPC setup and
//! interruption still have bounded deadlines.
//!
//! Auto selects Codex's own Auto-review with the workspace sandbox. Its
//! effective policy, reviewer and feature are verified before a turn starts.
//! Requests delegated back to the client become explicit human approvals;
//! no renderer or protocol notification can itself grant access.
//!
//! Plan approval (next_turn): a `permission == "plan"` run starts its turn
//! with `collaborationMode {mode:"plan"}` (EXPERIMENTAL in the 0.154.0
//! schema, so the client opts into `experimentalApi` at initialize). The plan
//! streams as `item/plan/delta` previews — drafts only, the schema warns the
//! concatenation need not match the final text — and the authoritative body
//! is the completed `type:"plan"` item, which becomes a next_turn PlanReview.
//! The plan turn then just ENDS (`turn/completed`): the thread idles while
//! the user reviews, and [`run_plan_decision`] later re-attaches, re-fetches
//! the final plan item to prove it is unchanged, and atomically starts one
//! execution (`mode:"default"`) or follow-up planning turn.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::OptionalExtension;

use serde_json::{json, Map, Value};
use tokio::io::{AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex as TokioMutex;
use tokio::time::{timeout, Instant};

use super::codex_desktop;
use super::codex_auto_review;
use super::codex_read_only;
use super::codex_throughput::CodexThroughput;
use super::images;
use super::generated_images;
use super::qoder_session::{
    encode_ndjson, jsonrpc_id_key, jsonrpc_request, jsonrpc_result_response, teardown, KILL_POLL,
    PROMPT_TIMEOUT, RPC_HANDSHAKE_TIMEOUT,
};
use super::plan_review::{self, PlanDecision, PlanReview, PlanReviewKind};
use super::{
    assistant_message, read_line_capped, spawn_stderr_capture, tool_call_message,
    tool_result_patch, BuiltCommand, ChildEntry, Engine, EngineEvent, LineRead, SendRequest,
    TurnCore, TurnState, VirtualRunGuard, MAX_LINE_BYTES,
};

/// Terminal marker for a kill-interrupted turn. The driver swallows it (the
/// killed flag already said why) and lets the turn settle as an interruption,
/// the same contract as the sibling drivers.
const CANCELLED: &str = "codex turn cancelled";

#[path = "sidechat_codex.rs"]
mod sidechat_codex;

/// `thread/start` builds the thread's context before it can answer — on a large
/// workspace that is the expensive call of the whole turn, so it gets far more
/// headroom than a plain RPC.
const THREAD_TIMEOUT: Duration = Duration::from_secs(90);
/// `thread/resume` only re-attaches an existing thread.
const RESUME_TIMEOUT: Duration = Duration::from_secs(30);
/// Grace for the CLI to react to `turn/interrupt` with its own terminal
/// notification before the process tree is killed anyway.
const INTERRUPT_SETTLE_TIMEOUT: Duration = Duration::from_secs(2);

/// What a pump call is waiting for.
enum Expect<'a> {
    /// The reply to the request whose id key is carried here.
    Reply(&'a str),
    /// No reply — the turn's own terminal notification ends this pump.
    Turn,
}

/// How the pump should treat one decoded line.
enum Handled {
    /// Nothing for the turn; keep reading.
    Ignore,
    /// Answer this server→client request now.
    Answer(Value),
    /// The request was parked for the user: do not answer it here, the answer
    /// command writes the response on the shared stdin later.
    Parked,
    /// The turn is over.
    Ended,
}

/// Per-run projection state: what streamed, and what to report at settle time.
#[derive(Default)]
struct TurnView {
    /// Item id whose text already streamed as deltas. A completed
    /// `agentMessage` repeats that text in full, and a `message` row appends as
    /// a settled snapshot (the UI collapses the live row first), so replaying
    /// it would print the answer twice. Same for reasoning.
    streamed_message: Option<String>,
    streamed_reasoning: Option<String>,
    /// Current turn from its own RPC reply. Child and stale
    /// turn notifications must never replace this identity.
    turn_id: Option<String>,
    /// Last `thread/tokenUsage/updated` payload, folded into this turn's Done:
    /// the terminal notification itself carries no usage.
    last_usage: Option<Value>,
    /// 【Codex整轮吞吐】仅当终态 throughput 样本完整可信时记录，与 last 请求占用分离附在 Done 用量中。
    turn_throughput: Option<Value>,
    /// Independent diagnostics; never changes content or billing projection.
    throughput: CodexThroughput,
    /// Bound to the native account/config before this process starts.
    quota_binding: Option<crate::codex_quota::Binding>,
    exit_unconfirmed: bool,
    isolated_home: Option<std::path::PathBuf>,
    /// This run is a human-approved planning turn (`permission == "plan"`):
    /// only then do plan deltas/items feed the approval backbone — a plan
    /// item in an ordinary turn must never become an approvable review.
    plan_mode: bool,
    /// Workspace snapshot for the review record (the turn handlers have no
    /// access to the request, so the driver seeds it here).
    workspace: String,
    /// An ordinary chat send: if Codex Desktop holds the thread, the turn
    /// may be handed to it when the user enables it (see `codex_desktop`).
    desktop_handoff: bool,
    auto_review: bool,
    /// Set only after this run's turn/start reply; cleared at settlement.
    /// Also gates content and terminal notifications, not just approvals.
    accepting_approvals: bool,
    /// `thread/compact/start` replies `{}` with no turn id; the compact turn's
    /// id is adopted from the first same-thread turn notification that follows.
    awaiting_compact_turn: bool,
    auto_reviews: codex_auto_review::Reviews,
    file_changes: HashMap<String, Value>,
    completed_image_tools: HashSet<String>,
}

/// A turn's JSON-RPC channel to one `codex app-server` child.
struct AppServer {
    /// Shared with the registry: the answer command writes a parked question's
    /// response on this same pipe, so the lock is the only serialization point
    /// between the two writers.
    stdin: Arc<TokioMutex<Option<ChildStdin>>>,
    stdout: BufReader<ChildStdout>,
    line_buf: Vec<u8>,
    next_id: u64,
    control: Arc<super::codex_control::CodexControl>,
}

struct PumpControlGuard(Arc<super::codex_control::CodexControl>);
impl Drop for PumpControlGuard {
    fn drop(&mut self) { self.0.close(); }
}

impl AppServer {
    fn new(stdin: Arc<TokioMutex<Option<ChildStdin>>>, stdout: ChildStdout) -> Self {
        Self {
            stdin,
            stdout: BufReader::new(stdout),
            line_buf: Vec::new(),
            next_id: 1,
            control: Default::default(),
        }
    }

    async fn write(&self, value: &Value) -> Result<(), String> {
        let bytes = encode_ndjson(value)?;
        let mut guard = self.stdin.lock().await;
        let Some(stdin) = guard.as_mut() else {
            return Err("codex stdin is already closed".to_string());
        };
        stdin
            .write_all(&bytes)
            .await
            .map_err(|error| format!("codex stdin write failed: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("codex stdin flush failed: {error}"))
    }

    /// Send a request and return the id key its reply will carry.
    async fn request(&mut self, method: &str, params: Value) -> Result<String, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.write(&jsonrpc_request(id, method, params)).await?;
        Ok(id.to_string())
    }

    /// Read until this pump's expectation is met.
    ///
    /// `Ok(Some(result))` is the awaited reply; `Ok(None)` means the turn ended
    /// first — a fast turn can finish before its `turn/start` reply is read, and
    /// the turn pump ends on `turn/completed` rather than on any reply. Lines
    /// are classified locally (method+id is a server→client request, method
    /// alone a notification, id alone a reply) because codex speaks plain
    /// JSON-RPC, unlike the ACP framing the sibling drivers parse.
    async fn pump(
        &mut self,
        label: &str,
        expect: Expect<'_>,
        deadline: Option<Instant>,
        killed: &AtomicBool,
        interrupt: Option<(&str, &str)>,
        // `Send` is required: the driver runs inside a spawned task, and a
        // bare trait object would make the whole turn future non-Send.
        on_message: &mut (dyn FnMut(&Value) -> Handled + Send),
    ) -> Result<Option<Value>, String> {
        // EOF, protocol errors, timeout and cancellation all retire the
        // active handle before teardown can wait on the child process.
        let _control_guard = PumpControlGuard(Arc::clone(&self.control));
        let mut interrupted = false;
        let mut deadline = deadline;
        loop {
            if killed.load(Ordering::SeqCst) {
                self.control.close();
                match interrupt {
                    // Ask the CLI to stop the turn itself: its `interrupted`
                    // completion is what lets it persist the rollout before the
                    // tree dies, so it gets a bounded window to do that instead
                    // of a pipe yanked out from under it. This must carry an id
                    // — measured against this CLI, a bare notification is
                    // ignored and the turn runs on to completion — and its own
                    // reply is dropped by the pump, which is waiting on the
                    // completion, not on the acknowledgement.
                    Some((thread_id, turn_id)) if !interrupted => {
                        interrupted = true;
                        let stop_deadline = Instant::now() + INTERRUPT_SETTLE_TIMEOUT;
                        deadline = Some(deadline.map_or(stop_deadline, |at| at.min(stop_deadline)));
                        self.request(
                            "turn/interrupt",
                            json!({ "threadId": thread_id, "turnId": turn_id }),
                        )
                        .await?;
                    }
                    // Already asked: read on until the window closes.
                    Some(_) => {}
                    // Nothing to interrupt, so there is no turn left to settle.
                    // The answer command still needs the registry entry, so
                    // this returns rather than tearing the child down here.
                    None => return Err(CANCELLED.to_string()),
                }
            }
            // Poll in short slices instead of blocking on the socket, so a kill
            // is honored within KILL_POLL rather than at the next line.
            let remaining = deadline
                .map(|at| at.saturating_duration_since(Instant::now()))
                .unwrap_or(KILL_POLL);
            if remaining.is_zero() {
                return Err(if interrupted {
                    CANCELLED.to_string()
                } else {
                    format!("{label} timed out")
                });
            }
            let line = match timeout(
                remaining.min(KILL_POLL),
                read_line_capped(&mut self.stdout, &mut self.line_buf),
            )
            .await
            {
                // Idle tick with no complete line yet.
                Err(_) => continue,
                Ok(Err(error)) => return Err(format!("{label}: reading codex stdout: {error}")),
                Ok(Ok(LineRead::Eof)) => {
                    return Err(format!("{label}: the codex app-server closed stdout"))
                }
                Ok(Ok(LineRead::TooLong)) => {
                    // A valid history response can also exceed the frame cap.
                    // Keep the memory bound and identify the RPC being read;
                    // size alone is not evidence of a stuck or malformed CLI.
                    return Err(format!(
                        "ENGINE_PROTOCOL_FRAME_TOO_LARGE: {label}: codex protocol line exceeded the {} MiB limit; run terminated",
                        MAX_LINE_BYTES / (1024 * 1024),
                    ));
                }
                Ok(Ok(LineRead::Line(line))) => line,
            };
            let text = String::from_utf8_lossy(&line);
            let trimmed = text.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                // Not JSON-RPC at all (a stray banner): nothing to answer, and
                // no peer is blocked on it.
                continue;
            };
            let id = value.get("id").filter(|id| !id.is_null());
            if self.control.dispatch_reply(&value) {
                continue;
            }
            if value.get("method").is_none() {
                // A reply. Anything we are not waiting for is dropped: a resume
                // can deliver a leftover frame for an earlier request.
                let Expect::Reply(key) = expect else {
                    continue;
                };
                if jsonrpc_id_key(id.unwrap_or(&Value::Null)).as_deref() != Some(key) {
                    continue;
                }
                if let Some(error) = value.get("error") {
                    // Label-free so `terminal_message` surfaces the CLI's own
                    // words instead of this driver's.
                    return Err(format!(
                        "rpc:{}:{}",
                        error.get("code").and_then(Value::as_i64).unwrap_or(0),
                        error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("codex reported an error"),
                    ));
                }
                return Ok(Some(value.get("result").cloned().unwrap_or(Value::Null)));
            }
            match on_message(&value) {
                Handled::Ended => {
                    self.control.close();
                    return Ok(None);
                }
                // Only a request (method + id) expects a response; a
                // notification that routed to an answer has no peer waiting.
                Handled::Answer(frame) if id.is_some() => self.write(&frame).await?,
                // Parked (the user answers later) or nothing to do.
                _ => {}
            }
        }
    }
}

impl Drop for AppServer {
    fn drop(&mut self) {
        self.control.close();
    }
}

/// Classify and project one decoded frame.
fn route(core: &TurnCore, state: &mut TurnState, view: &mut TurnView, value: &Value) -> Handled {
    let Some(method) = value.get("method").and_then(Value::as_str) else {
        return Handled::Ignore;
    };
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    if value.get("id").is_none_or(Value::is_null) {
        if let Some(binding) = view.quota_binding.as_ref() {
            if matches!(method, "account/rateLimits/updated" | "account/updated") {
                crate::codex_quota::ingest_notification(binding, method, &params, &core.sink);
            }
        }
        if method == "account/updated" && crate::codex_quota::account_notification_invalidates(&params) {
            // A process bound to the previous identity must never attach late
            // windows to a newer identity verified by a concurrent refresh.
            view.quota_binding = None;
        }
        // Restored same-thread usage may seed throughput before turn/start,
        // but a child thread must not replace that baseline during resume.
        if belongs_to_thread(state, &params) {
            if let Some(payload) = view.throughput.observe(method, &params) {
                // 【Codex整轮吞吐】仅在终态样本为 complete 且无排除原因时保存可信本轮输出与耗时。
                if payload.get("status").and_then(Value::as_str) == Some("complete")
                    && payload.get("turnReason").is_none_or(Value::is_null)
                {
                    if let (Some(output_tokens), Some(elapsed_ms)) = (
                        payload.get("outputTokens").and_then(Value::as_u64),
                        payload.get("elapsedMs").and_then(Value::as_u64).filter(|ms| *ms > 0),
                    ) {
                        view.turn_throughput = Some(json!({
                            "output_tokens": output_tokens,
                            "elapsed_ms": elapsed_ms,
                        }));
                    }
                } else if payload.get("status").and_then(Value::as_str) == Some("partial") {
                    view.turn_throughput = None;
                }
                core.dispatch_event(state, EngineEvent::Throughput(payload));
            }
        }
    }
    match value.get("id").filter(|id| !id.is_null()) {
        Some(id) => handle_server_request(core, state, view, method, id, &params),
        None => handle_notification(core, state, view, method, &params),
    }
}

/// A server→client request: the CLI is blocked until this is answered.
fn handle_server_request(
    core: &TurnCore,
    state: &mut TurnState,
    view: &mut TurnView,
    method: &str,
    id: &Value,
    params: &Value,
) -> Handled {
    match method {
        // The reason this transport exists: the model's own multiple-choice
        // question becomes an app card and the turn stays parked until the user
        // picks. `answer_frame` writes the response later, on this same pipe.
        "item/tool/requestUserInput" => {
            if super::sidechat::is_side_run_id(&core.run_id)
                || !notification_belongs_to_turn(state, view, params) {
                // Do not park a child's or stale turn's question on the parent.
                // It still needs a reply so the server cannot wait forever.
                return Handled::Answer(jsonrpc_result_response(id, json!({ "answers": {} })));
            }
            let (cards, ids) = question_cards(params);
            if cards.is_empty() {
                // A question the card UI cannot render must not wedge the turn:
                // an empty answer reads as "no answer" and lets the model go on.
                return Handled::Answer(jsonrpc_result_response(id, json!({ "answers": {} })));
            }
            park_question(core, state, id, params, cards, ids);
            Handled::Parked
        }
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval"
        | "item/permissions/requestApproval" | "mcpServer/elicitation/request" => {
            if view.auto_review && view.accepting_approvals && belongs_to_turn(state, view, params) {
                let changes = params.get("itemId").and_then(Value::as_str)
                    .and_then(|id| view.file_changes.get(id));
                if let Some(card) = codex_auto_review::approval_card(method, params, changes) {
                    park_approval(core, state, id, method, params, card);
                    return Handled::Parked;
                }
                core.dispatch_event(state, EngineEvent::Warn(
                    "CODEX_APPROVAL_UNSUPPORTED: This Codex request needs an interactive form or user verification that CCGUI cannot render; it was declined.".into(),
                ));
            }
            let denied = match method {
                "item/permissions/requestApproval" => json!({"permissions":{},"scope":"turn"}),
                "mcpServer/elicitation/request" => json!({"action":"decline","content":null,"_meta":null}),
                _ => json!({"decision":"decline"}),
            };
            Handled::Answer(jsonrpc_result_response(id, denied))
        }
        // Unknown ask: only the peer knows the shape. An empty result still
        // settles its request — silence is what would deadlock the turn.
        _ => Handled::Answer(jsonrpc_result_response(id, json!({}))),
    }
}

/// A notification: no reply is expected, so anything unknown is ignorable.
fn handle_notification(
    core: &TurnCore,
    state: &mut TurnState,
    view: &mut TurnView,
    method: &str,
    params: &Value,
) -> Handled {
    // One app-server connection also carries subagent notifications. Only the
    // requested turn may project content/usage or end the pump. Account-wide
    // events are handled independently in route; request resolution has its
    // own thread + parked-request identity check below.
    if view.awaiting_compact_turn && belongs_to_thread(state, params) {
        if let Some(id) = notification_turn_id(params).filter(|id| !id.is_empty()) {
            view.turn_id = Some(id.to_string());
            view.awaiting_compact_turn = false;
            view.throughput.acknowledge(Some(id));
        }
    }
    if method == "turn/started" {
        // Only the start RPC reply can distinguish our new turn from a late
        // same-thread notification belonging to a previous turn.
        return Handled::Ignore;
    }
    if (method.starts_with("item/") || method.starts_with("turn/")
        || matches!(method, "thread/tokenUsage/updated" | "error"))
        && !notification_belongs_to_turn(state, view, params)
    {
        return Handled::Ignore;
    }
    match method {
        "item/autoApprovalReview/started" | "item/autoApprovalReview/completed" => {
            if view.auto_review && view.accepting_approvals && belongs_to_turn(state, view, params) {
                if let Some(review) = view.auto_reviews.observe(params) {
                    core.dispatch_event(state, EngineEvent::AutoReview(review));
                }
            }
        }
        "serverRequest/resolved" => {
            if params.get("threadId").and_then(Value::as_str) == state.native_session_id.as_deref() {
                if let Some(id) = params.get("requestId").filter(|id| id.is_string() || id.is_number()) {
                    let request_id = id.to_string();
                    let is_approval = core.registry.get(&core.run_id).is_some_and(|entry| {
                        entry.questions.lock().is_ok_and(|questions| {
                            questions.get(&request_id).is_some_and(|input| input.get("codexApproval").is_some())
                        })
                    });
                    // Ordinary requestUserInput owns its existing answer/skip
                    // receipt path. It has no approval decision marker, so an
                    // early resolved notification must not cancel a successful
                    // ordinary answer before its IPC receipt reaches the UI.
                    if is_approval {
                        core.dispatch_event(state, EngineEvent::QuestionSettled { request_id });
                    }
                }
            }
        }
        "item/agentMessage/delta" => {
            if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                if !delta.is_empty() {
                    // The text streams as deltas and the completed item is then
                    // skipped by the de-dup below, because a `message` row is a
                    // settled snapshot the UI appends on top of the live one.
                    if let Some(item_id) = params.get("itemId").and_then(Value::as_str) {
                        view.streamed_message = Some(item_id.to_string());
                    }
                    core.dispatch_event(state, EngineEvent::Delta(delta.to_string()));
                }
            }
        }
        "item/reasoning/textDelta" | "item/reasoning/summaryTextDelta" => {
            if let Some(delta) = params.get("delta").and_then(Value::as_str) {
                if !delta.is_empty() {
                    if let Some(item_id) = params.get("itemId").and_then(Value::as_str) {
                        view.streamed_reasoning = Some(item_id.to_string());
                    }
                    core.dispatch_event(state, EngineEvent::Thinking(delta.to_string()));
                }
            }
        }
        "item/started" | "item/completed" => {
            if let Some(item) = params.get("item") {
                let thread_id = params.get("threadId").and_then(Value::as_str);
                handle_item(core, state, view, item, method == "item/completed", thread_id);
            }
        }
        // Plan body streaming (EXPERIMENTAL): draft preview only. The schema
        // warns the concatenated deltas need not match the completed plan
        // item, so the review text below comes from the item, never from
        // accumulating these.
        "item/plan/delta" => {
            if view.plan_mode {
                if let (Some(thread_id), Some(delta)) = (
                    params.get("threadId").and_then(Value::as_str),
                    params.get("delta").and_then(Value::as_str),
                ) {
                    if !delta.is_empty() {
                        core.dispatch_event(
                            state,
                            EngineEvent::PlanDraft {
                                plan_id: plan_id_for(thread_id),
                                text: delta.to_string(),
                                replace: false,
                            },
                        );
                    }
                }
            }
        }
        // `turn/plan/updated` is the update_plan tool's task checklist (step
        // statuses), not the proposed plan body: it must never trigger a
        // review, and it has no timeline row of its own.
        "thread/tokenUsage/updated" => {
            if let Some(usage) = params.get("tokenUsage") {
                if let Some(payload) = usage_payload(
                    usage,
                    params
                        .get("modelContextWindow")
                        .or_else(|| usage.get("modelContextWindow")),
                ) {
                    view.last_usage = Some(payload);
                }
            }
        }
        "thread/started" => {
            // The matching thread/start, thread/resume or thread/fork RPC reply
            // adopts the session. This notification can announce a child.
        }
        // Terminal. A failed turn arrives here as a completion whose status is
        // `failed` with an explanatory message, so both shapes are read the
        // same; `turn/failed` is handled defensively in case a newer CLI emits
        // a notification this schema does not know.
        "turn/completed" | "turn/failed" => {
            abort_reviews(core, state, view);
            let turn = params.get("turn");
            let failed = method == "turn/failed" || turn
                .and_then(|turn| turn.get("status"))
                .and_then(Value::as_str)
                == Some("failed");
            let message = turn
                .and_then(|turn| turn.pointer("/error/message"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if failed || !message.is_empty() {
                core.dispatch_event(
                    state,
                    EngineEvent::Error(if message.is_empty() {
                        "codex reported a failed turn".to_string()
                    } else {
                        message.to_string()
                    }),
                );
            }
            return Handled::Ended;
        }
        // Non-terminal by contract (`willRetry`): the CLI is retrying an
        // upstream call, so the turn keeps running and the UI shows a notice.
        "error" => {
            let message = params
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("codex reported an error");
            core.dispatch_event(state, EngineEvent::Warn(message.to_string()));
        }
        _ => {}
    }
    Handled::Ignore
}

/// Project one item lifecycle event. Tool work opens a row on start (the
/// app-server reports the command up front, unlike exec) and the same row is
/// patched with its result on completion; assistant and reasoning text comes
/// from deltas, with the completed item as the fallback for a CLI that streams
/// none.
fn handle_item(
    core: &TurnCore,
    state: &mut TurnState,
    view: &mut TurnView,
    item: &Value,
    completed: bool,
    thread_id: Option<&str>,
) {
    let Some(kind) = item.get("type").and_then(Value::as_str) else {
        return;
    };
    let item_id = item.get("id").and_then(Value::as_str);
    if completed && matches!(kind, "imageGeneration" | "mcpToolCall" | "dynamicToolCall") {
        if let Some(id) = item_id.filter(|id| !id.is_empty()) {
            if !view.completed_image_tools.insert(id.to_string()) { return; }
        }
    }
    match kind {
        "agentMessage" => {
            if !completed || view.streamed_message.as_deref() == item_id {
                return;
            }
            let text = item.get("text").and_then(Value::as_str).unwrap_or("");
            if !text.trim().is_empty() {
                core.dispatch_event(state, assistant_message(text.to_string()));
            }
        }
        // The completed plan item is the AUTHORITATIVE plan body (the schema
        // says so verbatim) — it replaces, never extends, the streamed
        // deltas. In a plan run it becomes the review the user approves; the
        // turn then ends normally and the thread idles until the decision.
        "plan" => {
            if !completed || !view.plan_mode {
                return;
            }
            let (Some(plan_item_id), Some(text)) = (
                item.get("id").and_then(Value::as_str),
                item.get("text").and_then(Value::as_str),
            ) else {
                return;
            };
            if text.trim().is_empty() {
                return;
            }
            // No stable thread id, no approvable identity: fail closed.
            let Some(thread_id) = thread_id
                .map(str::to_string)
                .or_else(|| state.native_session_id.clone())
            else {
                return;
            };
            let record = PlanReview {
                plan_id: plan_id_for(&thread_id),
                engine: core.engine_id.clone(),
                session_id: thread_id.clone(),
                workspace_path: view.workspace.clone(),
                run_id: Some(core.run_id.clone()),
                // Assigned by record_review on dispatch.
                revision: 0,
                title: plan_title(text),
                content: text.to_string(),
                content_hash: plan_review::content_hash(text),
                complete: true,
                review_kind: PlanReviewKind::NextTurn,
                native_plan_id: Some(plan_item_id.to_string()),
                // The execution turn inherits the thread's sandbox, which the
                // plan run derived exactly like an "auto" run (workspace-write).
                exec_permission: "auto".to_string(),
                status: plan_review::PlanStatus::AwaitingReview,
                execution: plan_review::PlanExecution::NotStarted,
                decision: None,
                decision_intent_at: None,
                applied_at: None,
                created_at: 0,
                updated_at: 0,
                superseded_by: None,
            };
            // next_turn does not park: the plan turn ended on its own, and
            // approval means starting a fresh execution turn. The context is
            // Null — the backbone only parks native_request reviews.
            core.dispatch_event(
                state,
                EngineEvent::PlanReviewReady {
                    record: Box::new(record),
                    context: Value::Null,
                },
            );
        }
        "reasoning" => {
            if !completed || view.streamed_reasoning.as_deref() == item_id {
                return;
            }
            // Both arrays are optional, and often only one is populated: the
            // summary is the model's rendering, the content the raw trace.
            let mut parts: Vec<String> = Vec::new();
            for key in ["summary", "content"] {
                if let Some(entries) = item.get(key).and_then(Value::as_array) {
                    parts.extend(
                        entries
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .filter(|part| !part.trim().is_empty()),
                    );
                }
            }
            let text = parts.join("\n");
            if !text.is_empty() {
                core.dispatch_event(state, EngineEvent::Thinking(text));
            }
        }
        "commandExecution" => {
            let command = item.get("command").and_then(Value::as_str).unwrap_or("");
            let name = row_name(command);
            if completed {
                core.dispatch_event(
                    state,
                    tool_result_patch(name, Some(&pick(item, &["aggregatedOutput", "exitCode"]))),
                );
            } else {
                core.dispatch_event(
                    state,
                    tool_call_message(name, Some(&pick(item, &["command", "cwd"]))),
                );
            }
        }
        "fileChange" => {
            if let Some(id) = item_id {
                if completed { view.file_changes.remove(id); }
                else if let Some(changes) = item.get("changes").filter(|changes| changes.is_array()) {
                    view.file_changes.insert(id.to_string(), changes.clone());
                }
            }
            if completed {
                // The per-file rows were opened on start; the completion only
                // carries the item's own status.
                core.dispatch_event(
                    state,
                    tool_result_patch("apply_patch", Some(&pick(item, &["status"]))),
                );
            } else if let Some(changes) = item.get("changes").and_then(Value::as_array) {
                // One row per file: the UI resolves `path` out of the args for
                // its file chip, and the diff gets an expandable panel.
                for change in changes {
                    core.dispatch_event(
                        state,
                        tool_call_message(
                            "apply_patch",
                            Some(&pick(change, &["path", "kind", "diff"])),
                        ),
                    );
                }
            }
        }
        "mcpToolCall" => {
            let name = item
                .get("tool")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| "mcp".to_string());
            if completed {
                core.dispatch_event(
                    state,
                    tool_result_patch(name, Some(&generated_images::display_result(&pick(item, &["result", "error", "status"])))),
                );
                emit_tool_images(core, state, item);
            } else {
                core.dispatch_event(
                    state,
                    tool_call_message(name, Some(&pick(item, &["server", "tool", "arguments"]))),
                );
            }
        }
        "dynamicToolCall" => {
            let name = item
                .get("tool")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| "tool".to_string());
            if completed {
                core.dispatch_event(
                    state,
                    tool_result_patch(name, Some(&generated_images::display_result(&pick(item, &["success", "status", "contentItems"])))),
                );
                emit_tool_images(core, state, item);
            } else {
                core.dispatch_event(
                    state,
                    tool_call_message(name, Some(&pick(item, &["namespace", "tool", "arguments"]))),
                );
            }
        }
        "webSearch" => {
            if completed {
                core.dispatch_event(
                    state,
                    tool_result_patch("web_search", Some(&pick(item, &["results"]))),
                );
            } else {
                core.dispatch_event(
                    state,
                    tool_call_message("web_search", Some(&pick(item, &["query", "action"]))),
                );
            }
        }
        "imageGeneration" => {
            if completed {
                core.dispatch_event(
                    state,
                    tool_result_patch(
                        "image_generation",
                        Some(&generated_images::native_display_result(item)),
                    ),
                );
                let images = generated_images::native_images(item, true);
                if !images.is_empty() { core.dispatch_event(state, EngineEvent::AssistantImages(images)); }
            } else {
                core.dispatch_event(
                    state,
                    tool_call_message("image_generation", Some(&pick(item, &["revisedPrompt"]))),
                );
            }
        }
        // Plans, sub-agent activity, review mode and compaction have no row of
        // their own in this client's timeline; what they contain is outside
        // what the app renders, not lost by a missing arm.
        "contextCompaction" => {
            core.dispatch_event(
                state,
                EngineEvent::Compaction {
                    active: !completed,
                    reason: None,
                },
            );
        }
        _ => {}
    }
}

fn emit_tool_images(core: &TurnCore, state: &mut TurnState, item: &Value) {
    if generated_images::failed(item) { return; }
    let images = generated_images::output_images(item, true);
    if !images.is_empty() { core.dispatch_event(state, EngineEvent::AssistantImages(images)); }
}

fn belongs_to_thread(state: &TurnState, params: &Value) -> bool {
    state.native_session_id.as_deref().is_some_and(|expected| {
        params.get("threadId").and_then(Value::as_str) == Some(expected)
    })
}

fn notification_belongs_to_turn(state: &TurnState, view: &TurnView, params: &Value) -> bool {
    if !view.accepting_approvals || !belongs_to_thread(state, params) {
        return false;
    }
    view.turn_id.as_deref().is_some_and(|expected| notification_turn_id(params) == Some(expected))
}

fn notification_turn_id(params: &Value) -> Option<&str> {
    params.get("turnId").and_then(Value::as_str)
        .or_else(|| params.pointer("/turn/id").and_then(Value::as_str))
}

fn belongs_to_turn(state: &TurnState, view: &TurnView, params: &Value) -> bool {
    if !belongs_to_thread(state, params) {
        return false;
    }
    match (view.turn_id.as_deref(), params.get("turnId").and_then(Value::as_str)) {
        (Some(expected), Some(actual)) => expected == actual,
        // MCP elicitation can be correlated only to its thread. Never accept
        // it during initialize/resume or after the active turn has settled.
        (Some(_), None) => params.get("serverName").is_some() && params.get("mode").is_some(),
        _ => false,
    }
}

fn abort_reviews(core: &TurnCore, state: &mut TurnState, view: &mut TurnView) {
    view.accepting_approvals = false;
    for review in view.auto_reviews.abort_pending() {
        core.dispatch_event(state, EngineEvent::AutoReview(review));
    }
}

fn park_approval(core: &TurnCore, state: &mut TurnState, id: &Value, method: &str, params: &Value, card: Value) {
    let request_id = id.to_string();
    if let Some(entry) = core.registry.get(&core.run_id) {
        if entry.questions.lock().is_ok_and(|questions| questions.contains_key(&request_id)) {
            return;
        }
    }
    core.dispatch_event(state, EngineEvent::ApprovalQuestion {
        request_id: request_id.clone(),
        tool_use_id: params.get("itemId").and_then(Value::as_str).map(str::to_string),
        input: json!({
            "questions":[{"question":"Codex permission approval","header":"Codex","options":[],"allowOther":false}],
            "codexApproval":card,
        }),
        context: json!({"codexApproval":{
            "rpcId":id,"method":method,"params":params,"card":card,
        }}),
    });
}

/// Write a human fallback decision exactly once across desktop/Web callers.
/// All aliases share this stdin lock. Read the parked context after taking
/// it, so a second click or a request that settled meanwhile cannot grant.
pub(super) async fn answer_approval(
    registry: &Arc<super::ProcessRegistry>,
    run_id: &str,
    request_id: &str,
    answers: Option<&Value>,
) -> Result<(), String> {
    let entry = registry.get(run_id).ok_or("Codex approval is no longer pending")?;
    let writer = entry.stdin.as_ref().ok_or("Codex approval channel is closed")?;
    let mut writer = writer.lock().await;
    let stdin = writer.as_mut().ok_or("Codex approval channel is closed")?;
    if entry.killed.load(Ordering::SeqCst) { return Err("Codex approval was cancelled".into()); }
    let frame = {
        let mut questions = entry.questions.lock().map_err(|_| "Codex approval state is poisoned")?;
        let context = questions.get_mut(request_id)
            .and_then(|value| value.get_mut("codexApproval"))
            .ok_or("Codex approval is no longer pending")?;
        if context.get("answered").is_some() { return Err("Codex approval was already answered".into()); }
        let result = codex_auto_review::answer_result(context, answers)?;
        let rpc_id = context.get("rpcId").ok_or("Codex approval lost its RPC identity")?.clone();
        let frame = jsonrpc_result_response(&rpc_id, result);
        let bytes = encode_ndjson(&frame)?;
        // Record the user decision before writing: serverRequest/resolved may
        // arrive on the reader as soon as the final byte reaches the CLI.
        context["answered"] = answers.cloned().unwrap_or_else(|| json!({"decision":"decline"}));
        bytes
    };
    if let Err(error) = async {
        stdin.write_all(&frame).await?;
        stdin.flush().await
    }.await {
        if let Ok(mut questions) = entry.questions.lock() {
            if let Some(context) = questions.get_mut(request_id).and_then(|value| value.get_mut("codexApproval")).and_then(Value::as_object_mut) {
                context.remove("answered");
            }
        }
        // Partial writes have an uncertain outcome. End this run, never
        // replay an approval frame against it after a failed flush.
        entry.killed.store(true, Ordering::SeqCst);
        return Err(format!("Codex approval delivery failed; the run is stopping to avoid replay: {error}"));
    }
    // Keep the context until native serverRequest/resolved so every attached
    // client receives the same decision through the normal event sequence.
    Ok(())
}

/// Park a user-input request: publish the card, then remember how to answer it.
fn park_question(
    core: &TurnCore,
    state: &mut TurnState,
    id: &Value,
    params: &Value,
    cards: Vec<Value>,
    ids: Value,
) {
    // The registry key is the string form of the rpc id — the same key
    // `QuestionSettled` removes and the run's question map is keyed by.
    let request_id = id.to_string();
    let tool_use_id = params
        .get("itemId")
        .and_then(Value::as_str)
        .map(str::to_string);
    core.dispatch_event(
        state,
        EngineEvent::Question {
            request_id: request_id.clone(),
            tool_use_id,
            input: json!({ "questions": cards }),
        },
    );
    // `dispatch_event` parked the raw event input; replace it with the context
    // the answer command needs — the rpc id to answer plus the question-text →
    // question-id map its response is keyed by. The cards themselves are
    // already in the UI's hands, so only the protocol half is kept here.
    if let Some(entry) = core.registry.get(&core.run_id) {
        entry.questions.lock().unwrap().insert(
            request_id,
            json!({ "codexApp": { "rpcId": id, "ids": ids } }),
        );
    }
}

/// Build the CLI's response to a parked question.
///
/// `parked` is the context stored by `park_question`; `answers` is the raw
/// frontend map (question text → chosen label, or a list of labels for a
/// multi-select). `None` means the user dismissed the card — that must settle
/// the CLI's request with an empty answer so the model can carry on, never an
/// error. A mismatch between what the frontend answered and what the server
/// asked is an error instead: it means the card and the request drifted, and
/// silently dropping the answer would park the turn forever.
pub(super) fn answer_frame(parked: &Value, answers: Option<&Value>) -> Result<Value, String> {
    let id = parked
        .get("rpcId")
        .ok_or_else(|| "parked question lost its rpc id".to_string())?;
    let ids = parked.get("ids").and_then(Value::as_object);
    let mut out = Map::new();
    if let Some(answers) = answers {
        let answers = answers
            .as_object()
            .ok_or_else(|| "codex answers must be an object".to_string())?;
        for (text, choice) in answers {
            let Some(question_id) = ids.and_then(|ids| ids.get(text)).and_then(Value::as_str)
            else {
                return Err(format!("codex did not ask a question titled {text:?}"));
            };
            // A single-select arrives as a bare label; the wire only has the
            // list form, so both are normalized into it.
            let labels = match choice {
                Value::String(label) => vec![Value::String(label.clone())],
                Value::Array(labels) => labels.clone(),
                Value::Null => Vec::new(),
                other => return Err(format!("unsupported codex answer for {text:?}: {other}")),
            };
            out.insert(question_id.to_string(), json!({ "answers": labels }));
        }
    }
    Ok(jsonrpc_result_response(id, json!({ "answers": out })))
}

/// Project the protocol's `questions` onto the app's card spec, building the
/// question-text → question-id map in the same pass so the two cannot drift:
/// the card the user picks is keyed by its text, while the response the CLI
/// needs is keyed by the server's own id.
fn question_cards(params: &Value) -> (Vec<Value>, Value) {
    let mut cards = Vec::new();
    let mut ids = Map::new();
    let Some(questions) = params.get("questions").and_then(Value::as_array) else {
        return (cards, Value::Object(ids));
    };
    for (index, question) in questions.iter().enumerate() {
        let (Some(id), Some(text)) = (
            question.get("id").and_then(Value::as_str),
            question.get("question").and_then(Value::as_str),
        ) else {
            continue;
        };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        // The card's header is a short chip and the protocol's is optional, so
        // a missing one falls back to the question's position.
        let header = question
            .get("header")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|header| !header.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("Q{}", index + 1));
        let options: Vec<Value> = question
            .get("options")
            .and_then(Value::as_array)
            .map(|options| {
                options
                    .iter()
                    .filter_map(|option| {
                        let label = option.get("label").and_then(Value::as_str)?;
                        let mut card = Map::new();
                        card.insert("label".to_string(), json!(label));
                        if let Some(description) = option
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|description| !description.is_empty())
                        {
                            card.insert("description".to_string(), json!(description));
                        }
                        Some(Value::Object(card))
                    })
                    .collect()
            })
            .unwrap_or_default();
        // `multiSelect` is omitted: codex questions are single-choice, and an
        // absent flag is what the card already reads as. `isOther`/`isSecret`
        // have no place in the card spec.
        cards.push(json!({ "question": text, "header": header, "options": options }));
        ids.insert(text.to_string(), json!(id));
    }
    (cards, Value::Object(ids))
}

/// Sandbox mode for the run's permission. Mirrors `codex.rs`, whose `_` arm is
/// also what `resolve_permission`'s first-supported fallback lands on, so an
/// unsupported mode here behaves exactly like it does on the exec path.
fn sandbox_for(permission: Option<&str>) -> &'static str {
    match permission {
        Some("bypass") => "danger-full-access",
        Some("manual") => "read-only",
        Some(codex_read_only::PERMISSION) => "read-only",
        _ => "workspace-write",
    }
}

/// The turn's input blocks: the prompt, then one local-image block per
/// attachment. `localImage` (not `image`, which wants a URL) makes the CLI read
/// the file from disk; the path is absolutized against the workspace exactly as
/// the exec transport's `-i` argument is.
fn turn_input(req: &SendRequest) -> Vec<Value> {
    user_input(&req.prompt, &req.images, &req.workspace)
}

fn user_input(prompt: &str, image_paths: &[String], workspace: &Path) -> Vec<Value> {
    let mut input = vec![json!({ "type": "text", "text": prompt })];
    for raw in image_paths {
        if let Some(path) = images::absolutize_image_path(raw, workspace) {
            input.push(json!({ "type": "localImage", "path": path.to_string_lossy() }));
        }
    }
    input
}

pub(super) async fn send_steer(
    registry: &super::ProcessRegistry, key: &str, workspace: &Path,
    prompt: &str, image_paths: &[String],
) -> Result<bool, String> {
    let Some(entry) = registry.get(key) else { return Ok(false); };
    let Some(control) = entry.codex_control.as_ref() else { return Ok(false); };
    if prompt.trim().is_empty() && image_paths.is_empty() {
        return Err("the follow-up message is empty".into());
    }
    if image_paths.iter().any(|raw| images::absolutize_image_path(raw, workspace).is_none()) {
        return Err("Codex steering requires a local image file path for every attachment".into());
    }
    control.steer(&entry, user_input(prompt, image_paths, workspace)).await
}

/// Project token usage onto the shape the app's usage panel parses. `last` is
/// the most recent response's occupancy — what the context meter shows — while
/// `total` is the billed-session cumulative. Returns None when the report
/// carries nothing usable, so a bare Done keeps its previous numbers.
fn usage_payload(usage: &Value, context_window: Option<&Value>) -> Option<Value> {
    let last = usage.get("last")?;
    let mut out = Map::new();
    for (from, to) in [
        ("inputTokens", "input_tokens"),
        ("cachedInputTokens", "cached_input_tokens"),
        ("cacheWriteInputTokens", "cache_write_input_tokens"),
        ("outputTokens", "output_tokens"),
        ("reasoningOutputTokens", "reasoning_output_tokens"),
        ("totalTokens", "total_tokens"),
    ] {
        if let Some(field) = last.get(from).filter(|field| !field.is_null()) {
            out.insert(to.to_string(), field.clone());
        }
    }
    if let Some(window) = context_window.filter(|window| !window.is_null()) {
        out.insert("model_context_window".to_string(), window.clone());
    }
    if out.is_empty() {
        return None;
    }
    // 【Codex用量范围】last 仅代表最近一次请求占用，明确标记为 last_request，不能冒充整轮完整用量。
    out.insert("usage_scope".to_string(), json!("last_request"));
    Some(Value::Object(out))
}

/// 【Codex回合结算】保持 last 请求占用与回合吞吐统计分离；仅在拥有可信终态样本时附加 turn_throughput。
fn settled_turn_usage(last_usage: Option<Value>, turn_throughput: Option<&Value>) -> Option<Value> {
    let Some(tt) = turn_throughput else {
        return last_usage;
    };
    let mut out = match last_usage {
        Some(Value::Object(map)) => map,
        _ => {
            let mut map = Map::new();
            map.insert("usage_scope".to_string(), json!("last_request"));
            map
        }
    };
    out.insert("turn_throughput".to_string(), tt.clone());
    Some(Value::Object(out))
}

/// Tool rows are keyed by name — a result patch updates the newest row with the
/// same name — so both halves of one execution must derive it identically. The
/// command string is the only stable handle the protocol gives a command.
fn row_name(command: &str) -> String {
    let name = command.trim();
    if name.is_empty() {
        return "tool".to_string();
    }
    name.chars().take(120).collect()
}

/// Copy the named keys of `value` into a fresh object, dropping absent and null
/// ones so a tool row's args or result panel never shows empty slots.
fn pick(value: &Value, keys: &[&str]) -> Value {
    let mut out = Map::new();
    for key in keys {
        if let Some(field) = value.get(*key).filter(|field| !field.is_null()) {
            out.insert((*key).to_string(), field.clone());
        }
    }
    Value::Object(out)
}

// ==================== plan review (next_turn) ====================

/// The fixed execution instruction carried by an approval: the decision
/// itself transports no user text, so everything the model needs to start
/// executing lives in this one constant — any user text on the approve path
/// would blur what exactly was approved.
const EXECUTE_PLAN_PROMPT: &str = "The plan has been reviewed and approved. Leave plan mode and implement it exactly as approved: do not rewrite the plan, start executing now.";

/// Card title when the plan body carries no markdown heading.
const DEFAULT_PLAN_TITLE: &str = "Codex plan";

/// Staleness marker on verification errors: the plan item changed or vanished
/// while awaiting review, so the claimed revision must be expired (not just
/// reverted to awaiting_review — it may not keep waiting with a stale body).
const PLAN_STALE_PREFIX: &str = "codex plan is stale:";

/// Stable review identity: one thread has at most one plan awaiting review at
/// a time, so thread id + a fixed suffix suffices; a revised plan lands as the
/// next revision of the same planId (record_review supersedes the old one).
fn plan_id_for(thread_id: &str) -> String {
    format!("{thread_id}/plan")
}

/// Review card title: the first ATX heading of the plan body, else a fixed
/// default. A `#` not followed by whitespace is not a heading.
fn plan_title(content: &str) -> String {
    for line in content.lines() {
        let line = line.trim_start();
        let hashes = line.chars().take_while(|c| *c == '#').count();
        if hashes == 0 || hashes > 6 {
            continue;
        }
        let rest = &line[hashes..];
        if !rest.starts_with(' ') && !rest.starts_with('\t') {
            continue;
        }
        let title = rest.trim();
        if !title.is_empty() {
            return title.chars().take(80).collect();
        }
    }
    DEFAULT_PLAN_TITLE.to_string()
}

/// `collaborationMode` params (0.154.0 schema, EXPERIMENTAL): `settings.model`
/// is a REQUIRED field, `reasoning_effort` rides along only when it has a
/// value. The caller fails closed when it cannot name a model — sending a
/// settings object without its required field would be an invalid request,
/// not a negotiation.
fn collaboration_mode(mode: &str, model: &str, effort: Option<&str>) -> Value {
    let mut settings = Map::new();
    settings.insert("model".to_string(), json!(model));
    if let Some(effort) = effort.map(str::trim).filter(|e| !e.is_empty()) {
        settings.insert("reasoning_effort".to_string(), json!(effort));
    }
    json!({ "mode": mode, "settings": Value::Object(settings) })
}

/// collaborationMode for the initial planning turn: the request's explicit
/// model wins, else the thread's reported model; neither is fail-closed.
fn plan_collaboration(
    req_model: Option<&str>,
    thread_model: Option<&str>,
    effort: Option<&str>,
) -> Result<Value, String> {
    let model = req_model
        .filter(|m| !m.trim().is_empty())
        .or_else(|| thread_model.filter(|m| !m.trim().is_empty()))
        .ok_or_else(|| {
            "codex plan mode needs a model for collaborationMode.settings, but neither the request nor the thread reported one".to_string()
        })?;
    Ok(collaboration_mode("plan", model, effort))
}

/// collaborationMode for a decision turn: the thread metadata carries no
/// mode field, so the client must restate it explicitly (P0: "模式状态需客户
/// 端重新断言"); settings inherit the thread's current model/effort as
/// reported by thread/resume.
fn decision_collaboration(
    mode: &'static str,
    thread_model: Option<&str>,
    thread_effort: Option<&str>,
) -> Result<Value, String> {
    let model = thread_model
        .filter(|m| !m.trim().is_empty())
        .ok_or_else(|| {
            "thread/resume reported no model; cannot restate collaborationMode settings"
                .to_string()
        })?;
    Ok(collaboration_mode(mode, model, thread_effort))
}

/// What a user decision becomes: the new turn's collaboration mode, input
/// text and permission, plus the native item id to verify against. Every
/// check runs before the transport is touched, so the failure paths need no
/// process at all.
struct DecisionSpec {
    mode: &'static str,
    prompt: String,
    permission: String,
    native_plan_id: String,
}

fn decision_spec(
    review: &PlanReview,
    decision: PlanDecision,
    feedback: Option<&str>,
) -> Result<DecisionSpec, String> {
    if review.review_kind != PlanReviewKind::NextTurn {
        return Err("codex only executes next_turn plan decisions".to_string());
    }
    if review.session_id.trim().is_empty() {
        return Err("the plan review lost its codex thread id".to_string());
    }
    let native_plan_id = review
        .native_plan_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "the plan review lost its native plan item id".to_string())?
        .to_string();
    let (mode, prompt, permission) = match decision {
        PlanDecision::Approve => {
            let permission = review.exec_permission.trim();
            if permission.is_empty() {
                return Err(
                    "the plan review lost its execution permission snapshot".to_string()
                );
            }
            ("default", EXECUTE_PLAN_PROMPT.to_string(), permission.to_string())
        }
        PlanDecision::RequestChanges => {
            let feedback = feedback
                .map(str::trim)
                .filter(|f| !f.is_empty())
                .ok_or_else(|| "request_changes requires non-empty feedback".to_string())?;
            ("plan", feedback.to_string(), "plan".to_string())
        }
        PlanDecision::Defer => {
            return Err("defer is settled locally; it never starts a codex turn".to_string())
        }
    };
    Ok(DecisionSpec {
        mode,
        prompt,
        permission,
        native_plan_id,
    })
}

/// Find the reviewed final plan item inside one `thread/turns/list`
/// (itemsView=full) page and compare bodies: id AND text hash must match the
/// record. A mismatch or a missing item is staleness (PLAN_STALE_PREFIX —
/// the version gets expired); a malformed page is a plain error (the claim
/// reverts, the version stays open for a retry).
fn check_plan_item(page: &Value, native_plan_id: &str, expected_hash: &str) -> Result<(), String> {
    let turns = page
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| "thread/turns/list returned no turn page".to_string())?;
    for turn in turns {
        let Some(items) = turn.get("items").and_then(Value::as_array) else {
            continue;
        };
        for item in items {
            let is_plan = item.get("type").and_then(Value::as_str) == Some("plan");
            let matches = item.get("id").and_then(Value::as_str) == Some(native_plan_id);
            if !is_plan || !matches {
                continue;
            }
            let Some(text) = item.get("text").and_then(Value::as_str) else {
                return Err(format!(
                    "{PLAN_STALE_PREFIX} the thread's plan item carries no text"
                ));
            };
            return if plan_review::content_hash(text) == expected_hash {
                Ok(())
            } else {
                Err(format!(
                    "{PLAN_STALE_PREFIX} plan content changed while awaiting review"
                ))
            };
        }
    }
    Err(format!(
        "{PLAN_STALE_PREFIX} the reviewed plan item is no longer in the thread"
    ))
}

/// The channel the planning session ran on (recorded per session by the
/// frontend's session memory): the decision turn must re-attach with the same
/// credentials, or thread/resume would land on the default backend.
fn session_provider_id(db: &crate::db::Db, session_id: &str) -> Option<String> {
    let conn = db.0.lock();
    conn.query_row(
        "SELECT provider_id FROM session_providers WHERE engine='codex' AND session_id=?1",
        rusqlite::params![session_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

struct SpawnedCodex {
    child: Child,
    server: AppServer,
    stderr_buf: Arc<Mutex<String>>,
    /// Kill-on-close job guard (Windows): drops after teardown, sweeping any
    /// grandchild the CLI orphaned before `taskkill /T` could see a tree.
    #[cfg(windows)]
    _tree_guard: Option<Arc<super::job::KillOnCloseJob>>,
}

/// Spawn the prepared app-server command as this driver's own child: piped
/// stdio, own process group (so teardown sweeps the tree) and a drop backstop,
/// because a dropped driver future must never orphan the CLI. Unlike the ACP
/// spawn the reader is kept in the struct: this transport answers server
/// requests on the same pipe while it reads, so both ends stay live.
fn spawn_app_server(command: &mut Command, workspace: &Path) -> Result<SpawnedCodex, String> {
    command
        .current_dir(workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    super::hide_console(command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to spawn codex app-server: {error}"))?;
    #[cfg(windows)]
    let tree_guard = super::job::assign_kill_on_close(&child);
    let (stdin, stdout, stderr) =
        match (child.stdin.take(), child.stdout.take(), child.stderr.take()) {
            (Some(stdin), Some(stdout), Some(stderr)) => (stdin, stdout, stderr),
            _ => {
                let _ = child.start_kill();
                return Err("missing stdio pipe after spawn".to_string());
            }
        };
    Ok(SpawnedCodex {
        child,
        server: AppServer::new(Arc::new(TokioMutex::new(Some(stdin))), stdout),
        stderr_buf: spawn_stderr_capture(stderr),
        #[cfg(windows)]
        _tree_guard: tree_guard,
    })
}

/// A bounded, prompt-free account query using the same owned transport as chat.
/// No thread, tools, user conversation, or registry entry is created.
pub(crate) async fn read_account_quota(
    binding: &crate::codex_quota::Binding,
) -> Result<crate::codex_quota::QueryResult, &'static str> {
    let settings = crate::settings::read_settings().map_err(|_| "cli_unavailable")?;
    let bin = super::engine_bin(&settings, "codex");
    let mut command = super::command_for_binary(&bin);
    command.arg("app-server");
    for config in ["mcp_servers={}", "features.hooks=false", "features.apps=false",
        "features.plugins=false", "features.remote_plugin=false", "features.memories=false",
        "features.goals=false", "cloud.skills.enabled=false", "notify=[]"] {
        command.args(["-c", config]);
    }
    command.env("CODEX_HOME", &binding.home).env("PATH", super::resolve::cli_search_path());
    crate::development_profile::enforce_homes(&mut command);
    let mut spawned = spawn_app_server(&mut command, &binding.workspace).map_err(|_| "cli_unavailable")?;
    let killed = AtomicBool::new(false);
    let result = async {
        let server = &mut spawned.server;
        let deadline = Instant::now() + Duration::from_secs(22);
        // Never echo CLI error strings or raw responses across IPC: they may
        // contain provider configuration. The UI gets stable error codes only.
        let key = server.request("initialize", json!({"clientInfo": {
            "name":"ccgui_quota", "version":env!("CARGO_PKG_VERSION")
        }})).await.map_err(|_| "query_failed")?;
        let mut reject_request = |value: &Value| {
            if value.get("method").is_some() {
                if let Some(id) = value.get("id").filter(|v| !v.is_null()) {
                    return Handled::Answer(json!({"id":id,"error":{"code":-32601,"message":"Account query does not execute tools"}}));
                }
            }
            Handled::Ignore
        };
        server.pump("quota initialize", Expect::Reply(&key), Some(deadline), &killed, None, &mut reject_request)
            .await.map_err(|_| "query_failed")?.ok_or("query_failed")?;
        server.write(&json!({"method":"initialized","params":{}})).await.map_err(|_| "query_failed")?;
        let key = server.request("config/read", json!({"cwd":binding.workspace,"includeLayers":false}))
            .await.map_err(|_| "query_failed")?;
        let config = server.pump("quota config", Expect::Reply(&key), Some(deadline), &killed, None, &mut reject_request)
            .await.map_err(|_| "query_failed")?.ok_or("query_failed")?;
        if !config.get("config").is_some_and(crate::codex_quota::official_config) {
            return Err("provider_auth_unavailable");
        }
        let key = server.request("account/read", json!({"refreshToken":false})).await.map_err(|_| "query_failed")?;
        let account = server.pump("quota account", Expect::Reply(&key), Some(deadline), &killed, None, &mut reject_request)
            .await.map_err(|_| "query_failed")?.ok_or("query_failed")?;
        let account = crate::codex_quota::parse_account(&account)?;
        let key = server.request("account/rateLimits/read", json!({})).await.map_err(|_| "query_failed")?;
        let limits = server.pump("quota limits", Expect::Reply(&key), Some(deadline), &killed, None, &mut reject_request)
            .await.map_err(|_| "query_failed")?.ok_or("query_failed")?;
        if !binding.current() { return Err("auth_changed"); }
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        let windows = crate::codex_quota::parse_limits(&limits, now).ok_or("quota_not_available")?;
        let (credits, reset_credits) = crate::codex_quota::parse_credits(&limits, now);
        Ok(crate::codex_quota::QueryResult { account, windows, credits, reset_credits })
    }.await;
    teardown(&mut spawned.child).await;
    result
}

// ==================== turn driver ====================

/// Run one app-server turn and settle it exactly like the sibling drivers: a
/// question left parked by an interrupted run is resolved first, then the turn
/// reports either the engine's error or its own Done. `chat` marks a send from
/// an ordinary chat tab, the only kind that may continue in Codex Desktop.
pub(super) async fn run_app_server_turn(
    core: TurnCore,
    req: SendRequest,
    built: BuiltCommand,
    killed: Arc<AtomicBool>,
    virtual_pid: u32,
    chat: bool,
) {
    let mut state = TurnState::new(req.session_id.clone());
    let mut view = TurnView::default();
    view.plan_mode = req.permission.as_deref() == Some("plan");
    view.workspace = req.workspace.to_string_lossy().into_owned();
    view.desktop_handoff = chat;
    let preassigned_session_id = req.session_id.clone();
    // Abort-safe backstop: the by-name removals below only run when the task
    // finishes normally. An abort or a panic would otherwise leave this run's
    // keys pinning a concurrency slot until app exit.
    let _registry_guard =
        VirtualRunGuard::new(Arc::clone(&core.registry), core.run_id.clone(), virtual_pid);
    let result = turn_inner(&core, &mut state, &mut view, &req, built, &killed, None).await;
    settle(
        &core,
        &mut state,
        &mut view,
        result,
        &killed,
        virtual_pid,
        preassigned_session_id,
    )
    .await;
}

/// Shared settle for every virtual app-server run (ordinary turns and plan
/// decision turns): parked questions die with the turn, parked plan reviews
/// expire with it (a no-op for codex — next_turn never parks — kept as the
/// host-driver contract the sibling drivers follow), then the turn reports
/// either the engine's error or its own Done.
async fn settle(
    core: &TurnCore,
    state: &mut TurnState,
    view: &mut TurnView,
    result: Result<(), String>,
    killed: &Arc<AtomicBool>,
    virtual_pid: u32,
    preassigned_session_id: Option<String>,
) {
    abort_reviews(core, state, view);
    // Flush before an error/done makes dispatch terminal. Native completion
    // already flushed in route; transport failure/cancel has partial data only.
    if let Some(payload) = view.throughput.finish(true) {
        view.turn_throughput = None;
        core.dispatch_event(state, EngineEvent::Throughput(payload));
    }
    // Pending questions die with the turn: settle their cards BEFORE any
    // terminal dispatch, or the monotonic saw_done/saw_error guard in
    // dispatch_event would drop these and leave answerable cards pointing at a
    // settled turn.
    for key in [
        state.native_session_id.clone(),
        Some(core.run_id.clone()),
        preassigned_session_id.clone(),
    ]
    .into_iter()
    .flatten()
    {
        let pending = core.registry.get(&key).and_then(|entry| {
            entry.questions.lock().ok().map(|questions| questions.keys().cloned().collect::<Vec<_>>())
        }).unwrap_or_default();
        for request_id in pending {
            core.dispatch_event(state, EngineEvent::QuestionSettled { request_id });
        }
        super::reader::expire_parked_plans(core, state, &key);
    }
    // A killed turn is not an error: it was interrupted on purpose, and the
    // marker below only exists to end this pump.
    if let Err(error) = result {
        if !killed.load(Ordering::SeqCst) {
            core.dispatch_event(state, EngineEvent::Error(error));
        }
    }
    // An interrupted run commits its partial output as a normal turn end — the
    // same contract as the SIGKILL'd process path.
    if !state.saw_done && !state.saw_error {
        let usage = if killed.load(Ordering::SeqCst) {
            None
        } else {
            settled_turn_usage(view.last_usage.clone(), view.turn_throughput.as_ref())
        };
        let session_id = state.native_session_id.clone();
        core.dispatch_event(state, EngineEvent::Done { session_id, usage });
    }
    core.registry.remove_if_pid(&core.run_id, virtual_pid);
    // Clean up both the native session id (if the CLI reported one) and the
    // preassigned session id (if we resumed an existing conversation). A
    // resumed session was keyed at spawn under req.session_id, so that alias
    // must go even if the native id differs or never arrived.
    if let Some(session_id) = state.native_session_id.clone() {
        core.registry.remove_if_pid(&session_id, virtual_pid);
    }
    if let Some(session_id) = preassigned_session_id {
        core.registry.remove_if_pid(&session_id, virtual_pid);
    }
    if !view.exit_unconfirmed {
        state.confirm_exit(core);
    }
    super::sidechat::finish_run(&core.run_id);
    if super::sidechat::is_ephemeral_run_id(&core.run_id) {
        super::sidechat::spawn_ephemeral_cleanup(
            core.db.clone(),
            core.engine_id.clone(),
            state.native_session_id.clone(),
        );
    }
    core.sink.flush();
}

async fn turn_inner(
    core: &TurnCore,
    state: &mut TurnState,
    view: &mut TurnView,
    req: &SendRequest,
    built: BuiltCommand,
    killed: &Arc<AtomicBool>,
    decision: Option<&DecisionCheck>,
) -> Result<(), String> {
    let BuiltCommand {
        mut command,
        cleanup_files,
        ..
    } = built;
    let _staging_guard = codex_read_only::StagedHomeGuard(cleanup_files);
    let outcome = drive(&mut command, core, state, view, req, killed, decision).await;
    // Staged prompt files go on every exit path, including a spawn that never
    // got off the ground.
    outcome
}

/// Spawn, handshake, prompt, then tear the tree down: the app-server is
/// resident and would otherwise outlive the run.
async fn drive(
    command: &mut Command,
    core: &TurnCore,
    state: &mut TurnState,
    view: &mut TurnView,
    req: &SendRequest,
    killed: &Arc<AtomicBool>,
    decision: Option<&DecisionCheck>,
) -> Result<(), String> {
    if super::sidechat::is_read_only_run(&core.run_id) {
        sidechat_codex::configure(command);
        // No thread/model operation during discovery. CLI overrides merge
        // maps, so mcp_servers={} cannot disable inherited servers.
        let mut probe = spawn_app_server(command, &req.workspace)?;
        let configuration = sidechat_config_probe(&mut probe.server, req, killed).await;
        teardown(&mut probe.child).await;
        if !matches!(probe.child.try_wait(), Ok(Some(_))) {
            return Err("Codex Sidechat configuration probe did not exit".into());
        }
        sidechat_codex::disable_mcp(command, &configuration?)?;
        super::sidechat::run_owner(&core.run_id)?;
    }
    if codex_read_only::requested(req) {
        view.quota_binding = None;
        view.isolated_home = Some(
            std::fs::canonicalize(codex_read_only::isolated_home(command)?)
                .map_err(|_| "Cannot verify isolated Codex home")?,
        );
    }
    if !codex_read_only::requested(req) {
        view.quota_binding = crate::codex_quota::binding(req.provider_id.as_deref(), Some(&req.workspace)).ok();
    }
    let mut spawned = spawn_app_server(command, &req.workspace)?;
    view.exit_unconfirmed = true;
    // The answer command writes a parked question's response on this same pipe,
    // so the registry gets the writer from the first frame on.
    core.registry
        .set_stdin(&core.run_id, Arc::clone(&spawned.server.stdin));
    core.registry.set_codex_control(&core.run_id, Arc::clone(&spawned.server.control));
    let result =
        handshake_and_turn(&mut spawned.server, core, state, view, req, killed, decision).await;
    teardown(&mut spawned.child).await;
    view.exit_unconfirmed = !matches!(spawned.child.try_wait(), Ok(Some(_)));
    route_resume_result(
        result,
        req,
        view.desktop_handoff,
        decision.is_some(),
        &spawned.stderr_buf,
        || crate::settings::read_settings().map(|settings| settings.codex_desktop_handoff_enabled),
        || continue_in_desktop(core, state, view, req, killed),
    )
    .await
}

async fn sidechat_config_probe(
    server: &mut AppServer,
    req: &SendRequest,
    killed: &AtomicBool,
) -> Result<Value, String> {
    let mut configuration = None;
    for (method, params) in [
        ("initialize", json!({"clientInfo":{"name":"ccgui-sidechat-preflight","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}})),
        ("config/read", json!({"cwd":req.workspace.to_string_lossy(),"includeLayers":false})),
    ] {
        let key = server.request(method, params).await?;
        let result = server.pump(method, Expect::Reply(&key), Some(Instant::now() + RPC_HANDSHAKE_TIMEOUT),
            killed, None, &mut |_| Handled::Ignore).await?
            .ok_or("Codex Sidechat configuration probe ended without a response")?;
        if method == "config/read" { configuration = Some(result); }
    }
    configuration.ok_or_else(|| "Codex Sidechat configuration probe returned no configuration".into())
}

/// Keep the settings read and Desktop execution lazy: a native success or an
/// unrelated failure must never discover Desktop or hand it a message.
async fn route_resume_result<S, F, Fut>(
    result: Result<(), String>,
    req: &SendRequest,
    ordinary_chat: bool,
    decision: bool,
    stderr_buf: &Mutex<String>,
    settings: S,
    handoff: F,
) -> Result<(), String>
where
    S: FnOnce() -> Result<bool, String>,
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    match result {
        Ok(()) => Ok(()),
        // The resume failed before any turn existed, so nothing ran here.
        Err(error)
            if ordinary_chat
                && !decision
                && req
                    .session_id
                    .as_deref()
                    .is_some_and(|thread| codex_desktop::held_elsewhere(&error, thread)) =>
        {
            if !settings().unwrap_or(false) {
                return Err(codex_desktop::banner(codex_desktop::code::DISABLED, None));
            }
            handoff().await
        }
        Err(error) => Err(terminal_message(error, stderr_buf)),
    }
}

// ==================== Codex Desktop hand-off ====================

/// How often a followed Desktop turn is read.
const DESKTOP_POLL: Duration = Duration::from_millis(1500);
/// A delivered message Desktop has not started on by then is reported
/// instead of waited on.
const DESKTOP_START_TIMEOUT: Duration = Duration::from_secs(120);
/// Unreadable this long after delivery: the result is Desktop's to show.
const DESKTOP_LOST_AFTER: Duration = Duration::from_secs(30);

/// Codex Desktop holds this thread, so it runs the turn: hand it the prompt
/// and follow its turn until it settles. Desktop keeps its own model, effort
/// and permissions; this run reports status and projects the turn's items
/// through the same handler as a streamed turn.
async fn continue_in_desktop(
    core: &TurnCore,
    state: &mut TurnState,
    view: &mut TurnView,
    req: &SendRequest,
    killed: &AtomicBool,
) -> Result<(), String> {
    continue_in_desktop_using(core, state, view, req, killed, |thread_id| async move {
        codex_desktop::Desktop::find(&thread_id).await
    })
    .await
}

/// The execution boundary is injectable for tests; production always uses the
/// real Desktop channel. No mock needs to discover or write a local pipe.
trait DesktopChannel: Send + Sync {
    fn read(
        &self,
    ) -> impl std::future::Future<Output = Result<codex_desktop::Snapshot, codex_desktop::LinkError>>
           + Send;
    fn send(
        &self,
        prompt: &str,
    ) -> impl std::future::Future<Output = Result<(), codex_desktop::LinkError>> + Send;
}

impl DesktopChannel for codex_desktop::Desktop {
    async fn read(&self) -> Result<codex_desktop::Snapshot, codex_desktop::LinkError> {
        self.read().await
    }

    async fn send(&self, prompt: &str) -> Result<(), codex_desktop::LinkError> {
        self.send(prompt).await
    }
}

async fn continue_in_desktop_using<F, Fut, D>(
    core: &TurnCore,
    state: &mut TurnState,
    view: &mut TurnView,
    req: &SendRequest,
    killed: &AtomicBool,
    mut find: F,
) -> Result<(), String>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<
        Output = Result<(D, codex_desktop::Snapshot), codex_desktop::Unreachable>,
    >,
    D: DesktopChannel,
{
    use codex_desktop::{banner, code, Follow, Settled, Stage, Step, Unreachable};
    let thread_id = req
        .session_id
        .as_deref()
        .ok_or("codex hand-off needs the thread id")?;
    if let Some(reason) = codex_desktop::unsupported(req) {
        return Err(banner(reason, None));
    }
    let rollout = core.db.as_deref().and_then(|db| {
        crate::history::reader::find_session_file_path(db, "codex", thread_id)
            .ok()
            .flatten()
    });
    let (model, effort) = match rollout {
        Some(path) => {
            let read = tokio::task::spawn_blocking(move || codex_desktop::recorded_settings(&path));
            // A stop before delivery leaves nothing behind in Desktop.
            let Some(read) = unless_killed(read, killed).await else {
                return Ok(());
            };
            read.unwrap_or_default()
        }
        None => (None, None),
    };
    let report = |state: &mut TurnState, stage: Stage| {
        core.dispatch_event(
            state,
            EngineEvent::Handoff {
                stage: stage.as_str(),
                model: model.clone(),
                effort: effort.clone(),
            },
        );
    };
    report(state, Stage::Delivering);
    let Some(found) = unless_killed(find(thread_id.to_string()), killed).await else {
        return Ok(());
    };
    let (mut desktop, at_delivery) = match found {
        Ok(found) => found,
        Err(Unreachable::UnknownThread) => return Err(banner(code::ELSEWHERE, None)),
        Err(Unreachable::NoDesktop(detail)) => {
            return Err(banner(code::UNAVAILABLE, detail.as_deref()))
        }
    };
    // Loaded in Desktop means Desktop is the writer; otherwise another
    // client holds the thread and Desktop could not run it either.
    if at_delivery.status == "notLoaded" {
        return Err(banner(code::ELSEWHERE, None));
    }
    if !codex_desktop::same_folder(&at_delivery.cwd, &req.workspace) {
        return Err(banner(code::WORKSPACE, None));
    }
    core.dispatch_event(state, EngineEvent::SessionId(thread_id.to_string()));
    if killed.load(Ordering::SeqCst) {
        return Ok(());
    }
    // Recorded before the send, so the delivery can never reach the
    // transcript ahead of the record that lets history show it as the
    // user's own row. A failed record only costs that row.
    if let Some(db) = core.db.as_deref() {
        let digest = crate::history::desktop_prompt_digest(&req.prompt);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis() as i64);
        if let Err(error) = db.remember_codex_desktop_prompt(thread_id, &digest, now) {
            eprintln!("[codex-desktop] could not record the hand-off: {error}");
        }
    }
    let outcome = async {
        // Not raced against a stop: once written, its outcome must be known.
        match desktop.send(&req.prompt).await {
            Ok(()) => {}
            Err(error) if error.uncertain => return Err(banner(code::UNKNOWN, None)),
            Err(error) => return Err(banner(code::REJECTED, Some(&error.message))),
        }
        let mut follow = Follow::new(&at_delivery);
        let mut stage = Stage::Waiting;
        report(state, stage);
        let delivered = Instant::now();
        // Desktop busy with earlier work keeps the message waiting; only an
        // idle Desktop that never takes it counts toward the start timeout.
        let mut idle_since = delivered;
        let mut unreadable_since: Option<Instant> = None;
        loop {
            // A stop cannot reach Desktop's turn: it only ends the following.
            if pause_unless_killed(DESKTOP_POLL, killed).await {
                return Err(banner(code::STOPPED, None));
            }
            if delivered.elapsed() >= PROMPT_TIMEOUT {
                return Err(banner(code::TIMEOUT, None));
            }
            let Some(read) = unless_killed(desktop.read(), killed).await else {
                return Err(banner(code::STOPPED, None));
            };
            let snapshot = match read {
                Ok(snapshot) => {
                    unreadable_since = None;
                    snapshot
                }
                Err(_) => {
                    let since = *unreadable_since.get_or_insert_with(Instant::now);
                    if since.elapsed() >= DESKTOP_LOST_AFTER {
                        return Err(banner(code::LOST, None));
                    }
                    // Desktop may have restarted its channel under a new name.
                    if let Some(Ok((found, _))) =
                        unless_killed(find(thread_id.to_string()), killed).await
                    {
                        desktop = found;
                    }
                    continue;
                }
            };
            let (steps, next, settled) = follow.advance(&snapshot);
            for step in steps {
                match step {
                    Step::Open(item) => handle_item(core, state, view, &item, false, Some(thread_id)),
                    Step::Close(item) => handle_item(core, state, view, &item, true, Some(thread_id)),
                }
            }
            if next != stage {
                stage = next;
                report(state, stage);
            }
            match settled {
                Some(Settled::Completed) => return Ok(()),
                Some(Settled::Failed(detail)) => {
                    return Err(banner(code::FAILED, detail.as_deref()))
                }
                Some(Settled::Interrupted) => return Err(banner(code::INTERRUPTED, None)),
                None => {}
            }
            if snapshot.status == "active" {
                idle_since = Instant::now();
            }
            if !follow.started() && idle_since.elapsed() >= DESKTOP_START_TIMEOUT {
                return Err(banner(code::NOT_STARTED, None));
            }
        }
    }
    .await;
    // Settle drops a stopped run's error. Once Desktop has, or may have, the
    // message, how this run ended still has to reach the user.
    match outcome {
        Err(notice) if killed.load(Ordering::SeqCst) => {
            core.dispatch_event(state, EngineEvent::Error(notice));
            Ok(())
        }
        outcome => outcome,
    }
}

/// Sleep `total` in kill-poll slices; true once the run was stopped.
async fn pause_unless_killed(total: Duration, killed: &AtomicBool) -> bool {
    let until = Instant::now() + total;
    while !killed.load(Ordering::SeqCst) {
        let left = until.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return false;
        }
        tokio::time::sleep(left.min(KILL_POLL)).await;
    }
    true
}

/// `work`'s output, or None once the run is stopped first.
async fn unless_killed<T>(
    work: impl std::future::Future<Output = T>,
    killed: &AtomicBool,
) -> Option<T> {
    tokio::pin!(work);
    loop {
        if killed.load(Ordering::SeqCst) {
            return None;
        }
        if let Ok(value) = timeout(KILL_POLL, &mut work).await {
            return Some(value);
        }
    }
}

/// `initialize` → thread → turn, projecting everything through `route`.
async fn verify_auto_review_feature(
    server: &mut AppServer,
    core: &TurnCore,
    state: &mut TurnState,
    view: &mut TurnView,
    thread_id: &str,
    killed: &AtomicBool,
) -> Result<(), String> {
    let mut cursor: Option<String> = None;
    let deadline = Instant::now() + RPC_HANDSHAKE_TIMEOUT;
    // Respect pagination without allowing a broken peer to loop forever.
    for _ in 0..16 {
        let key = server.request("experimentalFeature/list", json!({
            "threadId":thread_id,"limit":1000,"cursor":cursor,
        })).await.map_err(|error| format!("{} {error}", codex_auto_review::UNAVAILABLE))?;
        let page = server.pump("Codex Auto-review capability check", Expect::Reply(&key), Some(deadline), killed, None,
            &mut |value| route(core, state, view, value)).await
            .map_err(|error| format!("{} {error}", codex_auto_review::UNAVAILABLE))?
            .ok_or_else(|| format!("{} Codex ended before the reviewer capability was verified", codex_auto_review::UNAVAILABLE))?;
        match codex_auto_review::feature_enabled(&page) {
            Some(true) => return Ok(()),
            Some(false) => return Err(format!("{} guardian_approval is disabled for this thread", codex_auto_review::UNAVAILABLE)),
            None => {}
        }
        let next = page.get("nextCursor").and_then(Value::as_str).filter(|value| !value.is_empty());
        if next.is_none() || next == cursor.as_deref() { break; }
        cursor = next.map(str::to_string);
    }
    Err(format!("{} This CLI did not report the guardian_approval capability. Update the Codex CLI.", codex_auto_review::UNAVAILABLE))
}

async fn handshake_and_turn(
    server: &mut AppServer,
    core: &TurnCore,
    state: &mut TurnState,
    view: &mut TurnView,
    req: &SendRequest,
    killed: &Arc<AtomicBool>,
    decision: Option<&DecisionCheck>,
) -> Result<(), String> {
    let Some(started) = handshake_and_start(
        server,
        core,
        state,
        view,
        req,
        killed,
        decision,
        PROMPT_TIMEOUT,
    )
    .await?
    else {
        return Ok(());
    };
    pump_turn_to_end(server, core, state, view, &started, killed).await
}

/// A turn whose `turn/start` the server has acknowledged.
struct TurnStarted {
    thread_id: String,
    /// None when the ack carried no id (defensive; interrupt then has no
    /// handle and a kill falls back to ending the pump).
    turn_id: Option<String>,
}

fn append_host_instructions(configured: Option<&str>, role: &str) -> String {
    match (configured.filter(|text| !text.is_empty()), role.is_empty()) {
        (Some(text), true) => text.to_string(),
        (Some(text), false) => format!("{text}\n\n{role}"),
        (None, _) => role.to_string(),
    }
}

/// `initialize` → thread → [plan-item verification] → `turn/start`, up to the
/// turn's acknowledgement. `decision` marks a plan-decision turn: the reviewed
/// plan item is re-fetched and compared first, and the turn starts in the
/// decision's collaboration mode instead of the request's plain model/effort.
/// `Ok(None)` means the turn already ended inside the ack window.
async fn handshake_and_start(
    server: &mut AppServer,
    core: &TurnCore,
    state: &mut TurnState,
    view: &mut TurnView,
    req: &SendRequest,
    killed: &Arc<AtomicBool>,
    decision: Option<&DecisionCheck>,
    ack_timeout: Duration,
) -> Result<Option<TurnStarted>, String> {
    if super::parse_compact_prompt(&req.prompt).is_some()
        && req
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_none()
    {
        return Err("当前会话尚未建立，无法压缩上下文".into());
    }
    let deadline = Instant::now() + RPC_HANDSHAKE_TIMEOUT;
    // collaborationMode and the plan items are EXPERIMENTAL in the 0.154.0
    // schema: the client must opt into the experimental API to negotiate
    // them. If the server then refuses the fields, the rpc error fails the
    // turn — there is no degraded fallback.
    view.auto_review = codex_auto_review::enabled(req.permission.as_deref());
    let side_run = super::sidechat::is_side_run_id(&core.run_id);
    let side_read_only = super::sidechat::is_read_only_run(&core.run_id);
    let experimental = side_run || view.auto_review || codex_read_only::requested(req)
        || decision.is_some()
        || req.permission.as_deref() == Some("plan");
    let key = server
        .request(
            "initialize",
            json!({ "clientInfo": {
                "name": "ccgui",
                "version": env!("CARGO_PKG_VERSION"),
            }, "capabilities": {"experimentalApi": experimental}}),
        )
        .await?;
    let initialized = server
        .pump(
            "initialize",
            Expect::Reply(&key),
            Some(deadline),
            killed,
            None,
            &mut |value| route(core, state, view, value),
        )
        .await?
        .ok_or_else(|| "the codex app-server ended before initialize was answered".to_string())?;
    if codex_read_only::requested(req) {
        codex_read_only::validate_version(&initialized)?;
        for (method, params) in [
            ("configRequirements/read", json!({})),
            (
                "config/read",
                json!({"cwd":req.workspace.to_string_lossy(),"includeLayers":true}),
            ),
        ] {
            let key = server.request(method, params).await?;
            let response = server
                .pump(
                    method,
                    Expect::Reply(&key),
                    Some(Instant::now() + RPC_HANDSHAKE_TIMEOUT),
                    killed,
                    None,
                    &mut |value| route(core, state, view, value),
                )
                .await?
                .ok_or("Codex isolation preflight ended without a response")?;
            if method == "configRequirements/read" {
                if response.get("requirements") != Some(&Value::Null) {
                    return Err(
                        "Codex read-only planning does not support managed requirements".into(),
                    );
                }
            } else {
                codex_read_only::validate_config(
                    &response,
                    view.isolated_home
                        .as_deref()
                        .ok_or("Missing isolated Codex planning home")?,
                )?;
            }
        }
    }
    if side_read_only {
        let key = server.request("config/read", json!({"cwd":req.workspace.to_string_lossy(),"includeLayers":false})).await?;
        let response = server.pump("config/read", Expect::Reply(&key), Some(Instant::now() + RPC_HANDSHAKE_TIMEOUT),
            killed, None, &mut |value| route(core, state, view, value)).await?
            .ok_or("Codex Sidechat configuration verification ended without a response")?;
        sidechat_codex::validate_config(&response)?;
    }
    // Read the effective configuration only for managed role turns. Append to
    // the user's own developer instructions; never replace them with our role
    // guidance or write it to config.toml. Empty guidance clears a disabled role.
    let developer_instructions = if let Some(role) = req.host_instructions.as_deref() {
        let key = server.request("config/read", json!({
            "cwd": req.workspace.to_string_lossy(), "includeLayers": false,
        })).await?;
        let config = server.pump(
            "config/read", Expect::Reply(&key), Some(Instant::now() + RPC_HANDSHAKE_TIMEOUT),
            killed, None, &mut |value| route(core, state, view, value),
        ).await?.ok_or("Codex role configuration read ended without a response")?;
        Some(append_host_instructions(config.pointer("/config/developer_instructions").and_then(Value::as_str), role))
    } else { None };
    // Reapply the selected permission on both new and resumed threads. A
    // saved full-access thread must not silently survive switching to Auto.
    let deadline = Instant::now()
        + if req.session_id.is_some() {
            RESUME_TIMEOUT
        } else {
            THREAD_TIMEOUT
        };
    let (method, mut params) = match req.session_id.as_deref() {
        // History is loaded independently by the GUI. Hydrating all prior
        // turns in this one RPC reply can exceed MAX_LINE_BYTES even when
        // each original event is small. Keep thread/model/live-state metadata.
        Some(thread_id) => ("thread/resume", json!({ "threadId": thread_id, "excludeTurns": true })),
        None => ("thread/start", json!({})),
    };
    let (method, deadline) = match super::sidechat::codex_spec(&core.run_id) {
        Some(spec) => {
            if let Some(parent_id) = spec.fork_from {
                params = sidechat_codex::fork_params(&parent_id, spec.ephemeral);
                ("thread/fork", Instant::now() + RESUME_TIMEOUT)
            } else {
                if spec.ephemeral {
                    params["ephemeral"] = json!(true);
                }
                (method, deadline)
            }
        }
        None => (method, deadline),
    };
    params["cwd"] = json!(req.workspace.to_string_lossy());
    if view.auto_review {
        codex_auto_review::configure_thread(&mut params);
    } else {
        params["sandbox"] = json!(sandbox_for(req.permission.as_deref()));
        params["approvalPolicy"] = json!("never");
    }
    if let Some(instructions) = developer_instructions {
        params["developerInstructions"] = json!(instructions);
    }
    if side_read_only {
        sidechat_codex::apply_thread_read_only(&mut params);
    }
    if codex_read_only::requested(req) {
        params["ephemeral"] = json!(true);
        params["dynamicTools"] = json!([]);
        params["selectedCapabilityRoots"] = json!([]);
        params["environments"] =
            json!([{"environmentId":"local","cwd":req.workspace.to_string_lossy()}]);
    }
    if let Some(model) = req.model.as_deref() {
        params["model"] = json!(model);
    }
    if !codex_read_only::requested(req) {
        for (key, value) in [
            ("model_reasoning_effort", req.effort.as_deref()),
            ("service_tier", req.service_tier.as_deref()),
        ] {
            if let Some(value) = value {
                if let Some(obj) = params.as_object_mut() {
                    if !obj.contains_key("config") || obj["config"].is_null() {
                        obj.insert("config".to_string(), json!({}));
                    }
                    if let Some(config) = obj.get_mut("config").and_then(Value::as_object_mut) {
                        config.insert(key.to_string(), json!(value));
                    }
                }
            }
        }
    }
    let key = server.request(method, params).await?;
    let result = server
        .pump(
            method,
            Expect::Reply(&key),
            Some(deadline),
            killed,
            None,
            &mut |value| route(core, state, view, value),
        )
        .await?
        .ok_or_else(|| format!("the codex app-server ended before {method} was answered"))?;
    if codex_read_only::requested(req) {
        codex_read_only::validate_thread(&result)?;
    }
    if view.auto_review {
        codex_auto_review::validate_thread(&result)?;
    }
    let thread_id = result
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| req.session_id.clone())
        .ok_or_else(|| format!("{method} returned no thread id"))?;
    if view.auto_review {
        verify_auto_review_feature(server, core, state, view, &thread_id, killed).await?;
    }
    core.dispatch_event(state, EngineEvent::SessionId(thread_id.clone()));
    // Identity adoption includes the first-root role transaction. A rejected
    // id must stop before the first model task; the reader's tree kill is
    // asynchronous and cannot serve as this authorization boundary.
    if state.saw_error || killed.load(Ordering::SeqCst) {
        return Err("Codex native session identity was rejected or the launch was stopped".into());
    }
    // Adopt the newly created branch before a capability failure so its
    // transcript remains owned/hidden and can be reclaimed on every exit.
    let side_needs_goal_clear = if side_run {
        if side_read_only { sidechat_codex::validate_thread(&result)?; }
        sidechat_codex::requires_goal_clear(&result, super::sidechat::is_ephemeral_run_id(&core.run_id))?
    } else { false };
    if side_needs_goal_clear {
        // Only the owned branch is touched; inherited goals must not continue
        // the main task automatically after answering a side question.
        // Ephemeral threads cannot have goals: native goal RPCs reject them.
        for (method, params) in [
            ("thread/goal/clear", json!({"threadId":&thread_id,"origin":"user"})),
            ("thread/goal/get", json!({"threadId":&thread_id})),
        ] {
            let key = server.request(method, params).await?;
            let response = server.pump(method, Expect::Reply(&key), Some(Instant::now() + RPC_HANDSHAKE_TIMEOUT),
                killed, None, &mut |value| route(core, state, view, value)).await?
                .ok_or("Codex Sidechat goal isolation ended without a response")?;
            if method == "thread/goal/clear" && !response.get("cleared").is_some_and(Value::is_boolean) {
                return Err("Codex Sidechat could not verify inherited goal removal".into());
            }
            if method == "thread/goal/get" && response.get("goal") != Some(&Value::Null) {
                return Err("Codex Sidechat still has an inherited goal".into());
            }
        }
    }
    let thread_model = result.get("model").and_then(Value::as_str).map(str::to_string);
    if let Some(model) = thread_model.as_deref() {
        core.dispatch_event(state, EngineEvent::Model(model.to_string()));
    }
    let reported_effort = result
        .get("reasoningEffort")
        .or_else(|| result.pointer("/thread/reasoningEffort"))
        .and_then(Value::as_str)
        .map(str::to_string);
    if let Some(effort) = req.effort.as_deref().or(reported_effort.as_deref()) {
        core.dispatch_event(state, EngineEvent::Effort(effort.to_string()));
    }
    // A decision turn may only start once the reviewed plan is proven live and
    // unchanged: re-fetch the final plan item from the thread and compare id +
    // body hash against the record. Changed or gone → the whole decision fails
    // here, before any turn exists.
    if let Some(check) = decision {
        verify_plan_item(server, core, state, view, &thread_id, check, killed).await?;
    }
    let mut turn_params = json!({ "threadId": thread_id, "input": turn_input(req) });
    if codex_read_only::requested(req) || side_read_only {
        sidechat_codex::apply_turn_read_only(&mut turn_params);
    }
    if let Some(check) = decision {
        // Approve → one execution turn (mode "default"); RequestChanges → a
        // fresh planning turn carrying the feedback. The thread metadata has
        // no mode field, so the mode is restated explicitly and the settings
        // inherit the thread's current model/effort.
        turn_params["collaborationMode"] = decision_collaboration(
            check.mode,
            thread_model.as_deref(),
            reported_effort.as_deref(),
        )?;
    } else if req.permission.as_deref() == Some("plan") {
        // Planning turn (EXPERIMENTAL): collaborationMode takes precedence
        // over the top-level model/effort fields, so only one of the two
        // shapes is sent. A missing model is schema-invalid — fail closed.
        turn_params["collaborationMode"] =
            plan_collaboration(req.model.as_deref(), thread_model.as_deref(), req.effort.as_deref())?;
    } else {
        if let Some(effort) = req.effort.as_deref() {
            turn_params["effort"] = json!(effort);
        }
        if let Some(model) = req.model.as_deref() {
            turn_params["model"] = json!(model);
        }
    }
    if killed.load(Ordering::SeqCst) {
        return Err("Codex launch was stopped before turn/start".into());
    }
    view.turn_throughput = None;
    view.throughput.begin(&thread_id, req.session_id.is_none());
    if super::parse_compact_prompt(&req.prompt).is_some() {
        return start_compact_turn(server, core, state, view, &thread_id, ack_timeout, killed).await;
    }
    start_requested_turn(server, core, state, view, turn_params, ack_timeout, killed).await
}

/// Start a manual context compaction turn via `thread/compact/start`.
/// Unlike `turn/start`, `thread/compact/start` replies `{}` and announces the
/// non-steerable compact turn's id via `turn/started` (and subsequent turn
/// notifications) on the same thread.
async fn start_compact_turn(
    server: &mut AppServer,
    core: &TurnCore,
    state: &mut TurnState,
    view: &mut TurnView,
    thread_id: &str,
    ack_timeout: Duration,
    killed: &AtomicBool,
) -> Result<Option<TurnStarted>, String> {
    let mut early = Vec::new();
    let mut early_bytes = 0usize;
    let mut overflow = false;
    let key = server
        .request("thread/compact/start", json!({ "threadId": thread_id }))
        .await?;
    let result = server
        .pump(
            "thread/compact/start",
            Expect::Reply(&key),
            Some(Instant::now() + ack_timeout),
            killed,
            None,
            &mut |value| {
                if value.pointer("/params/threadId").and_then(Value::as_str) == Some(thread_id) {
                    early_bytes = early_bytes.saturating_add(value.to_string().len());
                    if early_bytes > MAX_LINE_BYTES {
                        overflow = true;
                        return Handled::Ended;
                    }
                    early.push(value.clone());
                    Handled::Ignore
                } else {
                    route(core, state, view, value)
                }
            },
        )
        .await?;
    if overflow {
        return Err("codex emitted too much data before acknowledging thread/compact/start".into());
    }
    let result = result
        .ok_or("the codex app-server ended before thread/compact/start was answered")?;
    let reply_turn_id = result
        .pointer("/turn/id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_string);
    let started_idx = early.iter().position(|value| {
        let method = value.get("method").and_then(Value::as_str).unwrap_or("");
        matches!(
            method,
            "turn/started"
                | "item/started"
                | "item/completed"
                | "thread/compacted"
                | "turn/completed"
                | "turn/failed"
        ) || reply_turn_id
            .as_deref()
            .is_some_and(|id| notification_turn_id(&value["params"]) == Some(id))
    });
    for value in early.iter().take(started_idx.unwrap_or(early.len())) {
        if value["method"] == "thread/tokenUsage/updated" && value.get("id").is_none_or(Value::is_null) {
            view.throughput.observe("thread/tokenUsage/updated", &value["params"]);
        }
    }
    let turn_id = reply_turn_id.or_else(|| {
        started_idx.and_then(|idx| {
            notification_turn_id(&early[idx]["params"])
                .filter(|id| !id.is_empty())
                .map(str::to_string)
        })
    });
    view.turn_id = turn_id;
    view.awaiting_compact_turn = view.turn_id.is_none();
    view.accepting_approvals = true;
    if let Some(id) = view.turn_id.as_deref() {
        view.throughput.acknowledge(Some(id));
    }
    core.dispatch_event(
        state,
        EngineEvent::Compaction {
            active: true,
            reason: Some("manual".to_string()),
        },
    );
    let replay_from = started_idx.unwrap_or_else(|| {
        if view.turn_id.is_some() { 0 } else { early.len() }
    });
    for value in early.into_iter().skip(replay_from) {
        match route(core, state, view, &value) {
            Handled::Ended => {
                server.control.close();
                return Ok(None);
            }
            Handled::Answer(frame) => server.write(&frame).await?,
            _ => {}
        }
    }
    Ok(Some(TurnStarted {
        thread_id: thread_id.to_string(),
        turn_id: view.turn_id.clone(),
    }))
}

/// Notifications can precede turn/start's reply, including late notifications
/// from an old turn on a resumed thread. Wait for the request's own identity
/// before projecting any of them; a child completion cannot swallow this ack.
async fn start_requested_turn(
    server: &mut AppServer,
    core: &TurnCore,
    state: &mut TurnState,
    view: &mut TurnView,
    turn_params: Value,
    ack_timeout: Duration,
    killed: &AtomicBool,
) -> Result<Option<TurnStarted>, String> {
    let thread_id = turn_params.get("threadId").and_then(Value::as_str)
        .ok_or("turn/start requires a thread id")?.to_string();
    let mut early = Vec::new();
    let mut early_bytes = 0usize;
    let mut overflow = false;
    let key = server.request("turn/start", turn_params).await?;
    let result = server
        .pump(
            "turn/start",
            Expect::Reply(&key),
            Some(Instant::now() + ack_timeout),
            killed,
            None,
            &mut |value| {
                if value.pointer("/params/threadId").and_then(Value::as_str) == Some(thread_id.as_str()) {
                    // The acknowledgement deadline bounds waiting; this cap
                    // also bounds memory if a peer floods events before it.
                    early_bytes = early_bytes.saturating_add(value.to_string().len());
                    if early_bytes > MAX_LINE_BYTES {
                        overflow = true;
                        return Handled::Ended;
                    }
                    early.push(value.clone());
                    Handled::Ignore
                } else {
                    // Account events are independent; foreign thread events
                    // remain ignored and requests still get a bounded reply.
                    route(core, state, view, value)
                }
            },
        )
        .await?;
    if overflow {
        return Err("codex emitted too much data before acknowledging turn/start".into());
    }
    let result = result.ok_or("the codex app-server ended before turn/start was answered")?;
    let turn_id = result
        .pointer("/turn/id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or("turn/start returned no turn id")?
        .to_string();
    // Resume may replay the previous usage after the thread/resume reply.
    // Keep it only as the baseline before this exact new turn first appears.
    for value in &early {
        let params = &value["params"];
        if notification_turn_id(params) == Some(turn_id.as_str()) { break; }
        if value["method"] == "thread/tokenUsage/updated" && value.get("id").is_none_or(Value::is_null) {
            view.throughput.observe("thread/tokenUsage/updated", params);
        }
    }
    view.turn_id = Some(turn_id.clone());
    view.accepting_approvals = true;
    view.throughput.acknowledge(Some(&turn_id));
    server.control.activate(&thread_id, &turn_id);
    for value in early {
        match route(core, state, view, &value) {
            Handled::Ended => {
                server.control.close();
                return Ok(None);
            }
            Handled::Answer(frame) => server.write(&frame).await?,
            _ => {}
        }
    }
    Ok(Some(TurnStarted { thread_id, turn_id: Some(turn_id) }))
}

/// Everything after the `turn/start` ack: stream the turn to its terminal
/// notification, without a total time limit. A kill first asks the CLI to
/// interrupt (so it can persist the rollout), exactly like the ordinary turn path.
async fn pump_turn_to_end(
    server: &mut AppServer,
    core: &TurnCore,
    state: &mut TurnState,
    view: &mut TurnView,
    started: &TurnStarted,
    killed: &Arc<AtomicBool>,
) -> Result<(), String> {
    // The turn id is needed to interrupt a cancelled turn, so it must be known
    // before the turn pump starts.
    view.turn_id = started.turn_id.clone();
    let interrupt = started
        .turn_id
        .clone()
        .map(|turn_id| (started.thread_id.clone(), turn_id));
    server
        .pump(
            "turn",
            Expect::Turn,
            None,
            killed,
            interrupt
                .as_ref()
                .map(|(thread_id, turn_id)| (thread_id.as_str(), turn_id.as_str())),
            &mut |value| route(core, state, view, value),
        )
        .await?;
    Ok(())
}

/// Verification handle for a plan-decision turn.
struct DecisionCheck {
    /// "default" (approve → execute) | "plan" (request changes → keep planning).
    mode: &'static str,
    /// The completed plan item id recorded at review time.
    native_plan_id: String,
    /// Hash of the reviewed body; the re-fetched item must match it.
    content_hash: String,
}

/// `thread/turns/list` (itemsView=full) → [`check_plan_item`]: the reviewed
/// final plan item must still be in the thread with an identical body.
async fn verify_plan_item(
    server: &mut AppServer,
    core: &TurnCore,
    state: &mut TurnState,
    view: &mut TurnView,
    thread_id: &str,
    check: &DecisionCheck,
    killed: &Arc<AtomicBool>,
) -> Result<(), String> {
    let key = server
        .request(
            "thread/turns/list",
            json!({
                "threadId": thread_id,
                "itemsView": "full",
                // The plan turn is the latest one; a small newest-first page
                // covers it without walking history.
                "limit": 16,
                "sortDirection": "desc",
            }),
        )
        .await?;
    let page = server
        .pump(
            "thread/turns/list",
            Expect::Reply(&key),
            Some(Instant::now() + RESUME_TIMEOUT),
            killed,
            None,
            &mut |value| route(core, state, view, value),
        )
        .await?
        .ok_or_else(|| "the codex app-server ended before thread/turns/list was answered".to_string())?;
    check_plan_item(&page, &check.native_plan_id, &check.content_hash)
}

/// Codex next_turn plan approval executor — the backbone's respond_plan_review
/// NextTurn branch calls this AFTER the CAS claimed the submission.
///
/// Semantics: re-attach to the review's thread, prove the reviewed final plan
/// item is still there with an identical body (thread/resume +
/// thread/turns/list itemsView=full), then atomically start ONE new turn —
/// Approve: collaborationMode "default" with the fixed execution instruction;
/// RequestChanges: collaborationMode "plan" with the feedback text. `Ok(())`
/// means the server acknowledged the new turn (its streaming finishes in a
/// detached task, registered as a new run under the same session id). Any
/// `Err` means no turn was created: a stale plan expires the claimed revision
/// here (it may not keep waiting with a stale body); every other failure is
/// the backbone's revert_submission case, decision intent preserved.
pub(crate) async fn run_plan_decision(
    state: &crate::AppState,
    review: &PlanReview,
    decision: PlanDecision,
    feedback: Option<&str>,
) -> Result<(), String> {
    let spec = decision_spec(review, decision, feedback)?;
    let thread_id = review.session_id.trim().to_string();
    let check = DecisionCheck {
        mode: spec.mode,
        native_plan_id: spec.native_plan_id,
        content_hash: review.content_hash.clone(),
    };

    // Rebuild the launch exactly like a send on this session would: same
    // binary, same channel (the decision turn re-attaches to the thread, and
    // the thread's backend only answers with the planning session's
    // credentials), same service tier.
    crate::config::ensure_engine_enabled("codex")?;
    let settings = crate::settings::read_settings().unwrap_or_default();
    let bin = super::engine_bin(&settings, "codex");
    let provider_id = session_provider_id(&state.db, &thread_id);
    let provider = crate::config::resolve_provider("codex", provider_id.as_deref())?;
    let channel_env = provider
        .as_ref()
        .map(|provider| crate::provider_files::channel_env("codex", provider))
        .transpose()?
        .unwrap_or_default();
    let mut req = SendRequest {
        claude_ultracode: None,
        host_instructions: None,
        session_id: Some(thread_id.clone()),
        workspace: PathBuf::from(&review.workspace_path),
        prompt: spec.prompt,
        images: Vec::new(),
        // Settings inherit the thread's reported model/effort instead.
        model: None,
        effort: None,
        service_tier: settings.codex_service_tier.clone(),
        permission: Some(spec.permission),
        additional_dirs: state.db.granted_roots().unwrap_or_default(),
        provider_id,
        computer_use: None,
        allowed_tools: None,
    };
    let mut built = super::codex::CodexEngine.host_command(&req, &bin)?;
    built.command.current_dir(&req.workspace);
    for (key, value) in &channel_env {
        built.command.env(key, value);
    }
    if let Some(provider) = provider.as_ref() {
        super::codex::apply_channel(&mut built.command, provider, &channel_env, &req)?;
    }
    super::codex_provider_env::apply(&mut built.command).await;

    // Register like send_host_stream does: the entry routes interrupts and
    // question answers for the new run; the session alias lets the frontend
    // stop it by conversation id. Registration precedes the spawn so a Stop
    // landing inside the start window still settles the turn.
    let run_id = uuid::Uuid::new_v4().to_string();
    let killed = Arc::new(AtomicBool::new(false));
    let reader_abort = Arc::new(std::sync::OnceLock::new());
    let pid = super::next_virtual_pid();
    let entry = ChildEntry {
        child: None,
        pid,
        run_id: run_id.clone(),
        killed: Arc::clone(&killed),
        reader_abort: Arc::clone(&reader_abort),
        stdin: None,
        questions: Arc::new(Mutex::new(HashMap::new())),
        plans: Arc::new(Mutex::new(HashMap::new())),
        native_tasks: Default::default(),
        codex_control: None,
    };
    {
        let mut map = state.processes.0.lock().map_err(|e| e.to_string())?;
        if super::registry::active_run_count(&map) >= super::MAX_CONCURRENT_RUNS {
            return Err(format!(
                "too many concurrent runs ({}); wait for one to finish",
                super::MAX_CONCURRENT_RUNS
            ));
        }
        map.insert(run_id.clone(), entry.clone());
    }
    state.processes.insert_alias(thread_id.clone(), entry);

    // An approved plan resumes the same managed chat through a separate
    // launch path. Preserve its role, per-run tool capability and child
    // marker here too.
    let role_setup = (|| -> Result<(), String> {
        let server = crate::host_chat::server_for_run(
            &run_id, "codex", Some(&thread_id), &review.workspace_path,
        )?;
        super::codex::apply_host_chat(&mut built.command, server.as_ref())?;
        req.host_instructions = crate::leader::prepare_run(
            &state.db, &run_id, "codex", Some(&thread_id), &review.workspace_path,
            req.permission.as_deref(),
        )?;
        super::mark_leader_child(&mut built.command, &run_id);
        super::codex::apply_child_service_tier(&mut built.command, &mut req, &run_id);
        let local=crate::auto_title::origin::local_workspace(&state.db,&review.workspace_path);
        super::mark_native_completion(&mut built.command,&run_id,"codex",&req,local,&killed);
        Ok(())
    })();
    if let Err(error) = role_setup {
        state.processes.remove_run_if_pid(&run_id, pid);
        crate::host_chat::finish_run(&run_id);
        return Err(error);
    }

    let core = TurnCore {
        sink: Arc::clone(&state.sink),
        registry: Arc::clone(&state.processes),
        engine_id: "codex".to_string(),
        run_id: run_id.clone(),
        db: Some(Arc::clone(&state.db)),
    };
    let mut turn_state = TurnState::new(Some(thread_id.clone()));
    let mut view = TurnView::default();
    // A RequestChanges turn plans again: its new plan item becomes the next
    // revision of the same planId. An execution turn must never produce one.
    view.plan_mode = decision == PlanDecision::RequestChanges;
    view.workspace = review.workspace_path.clone();

    // Phase A (synchronous): spawn → initialize → resume → verify → one
    // atomic turn/start. Only a server-acknowledged turn returns Ok.
    let spawned = match start_decision_turn(
        &core,
        &mut turn_state,
        &mut view,
        &req,
        built,
        &killed,
        pid,
        &check,
    )
    .await
    {
        Ok(spawned) => spawned,
        Err(error) => {
            if error.starts_with(PLAN_STALE_PREFIX) {
                // The reviewed body is gone or changed: the claimed revision
                // may not survive this. Expire it here — the backbone's
                // revert_submission then no-ops on the non-submitting status.
                let _ = plan_review::expire_reviews(
                    &state.db,
                    &[(review.plan_id.clone(), review.revision)],
                );
            }
            crate::host_chat::finish_run(&run_id);
            return Err(error);
        }
    };

    // Phase B (detached): the turn exists — stream it to its end and settle
    // like any other app-server run.
    let task = tokio::spawn(finish_decision_turn(
        core,
        req.session_id.clone(),
        killed,
        pid,
        spawned.0,
        spawned.1,
        turn_state,
        view,
    ));
    let _ = reader_abort.set(task.abort_handle());
    Ok(())
}

/// Decision turn, phase A: everything up to and including the `turn/start`
/// acknowledgement. On error the process tree is torn down, the run is
/// settled (so its events end honestly) and the registry keys are gone.
#[allow(clippy::too_many_arguments)]
async fn start_decision_turn(
    core: &TurnCore,
    state: &mut TurnState,
    view: &mut TurnView,
    req: &SendRequest,
    built: BuiltCommand,
    killed: &Arc<AtomicBool>,
    virtual_pid: u32,
    check: &DecisionCheck,
) -> Result<(SpawnedCodex, Option<TurnStarted>), String> {
    let BuiltCommand {
        mut command,
        cleanup_files,
        ..
    } = built;
    let _staging_guard = codex_read_only::StagedHomeGuard(cleanup_files);
    let mut spawned = match spawn_app_server(&mut command, &req.workspace) {
        Ok(spawned) => spawned,
        Err(error) => {
            // Nothing was ever emitted for this run, so there is nothing to
            // settle — just drop the registrations made above.
            core.registry.remove_if_pid(&core.run_id, virtual_pid);
            if let Some(session_id) = req.session_id.as_deref() {
                core.registry.remove_if_pid(session_id, virtual_pid);
            }
            return Err(error);
        }
    };
    view.exit_unconfirmed = true;
    core.registry
        .set_stdin(&core.run_id, Arc::clone(&spawned.server.stdin));
    core.registry.set_codex_control(&core.run_id, Arc::clone(&spawned.server.control));
    // The ack is immediate by protocol; bound it like a resume, not like a
    // turn — the caller (an IPC handler) is waiting on this phase.
    let started = handshake_and_start(
        &mut spawned.server,
        core,
        state,
        view,
        req,
        killed,
        Some(check),
        RESUME_TIMEOUT,
    )
    .await;
    let started = match started {
        Ok(started) => started,
        Err(error) => {
            let error = terminal_message(error, &spawned.stderr_buf);
            teardown(&mut spawned.child).await;
            view.exit_unconfirmed = !matches!(spawned.child.try_wait(), Ok(Some(_)));
            settle(
                core,
                state,
                view,
                Err(error.clone()),
                killed,
                virtual_pid,
                req.session_id.clone(),
            )
            .await;
            return Err(error);
        }
    };
    Ok((spawned, started))
}

/// Decision turn, phase B: the turn was created — stream it to its terminal
/// notification, tear the tree down and settle exactly like an ordinary run.
#[allow(clippy::too_many_arguments)]
async fn finish_decision_turn(
    core: TurnCore,
    preassigned_session_id: Option<String>,
    killed: Arc<AtomicBool>,
    virtual_pid: u32,
    mut spawned: SpawnedCodex,
    started: Option<TurnStarted>,
    mut state: TurnState,
    mut view: TurnView,
) {
    let _registry_guard =
        VirtualRunGuard::new(Arc::clone(&core.registry), core.run_id.clone(), virtual_pid);
    let result = match started {
        Some(started) => {
            pump_turn_to_end(
                &mut spawned.server,
                &core,
                &mut state,
                &mut view,
                &started,
                &killed,
            )
            .await
        }
        // The turn ended inside its own ack window.
        None => Ok(()),
    };
    teardown(&mut spawned.child).await;
    view.exit_unconfirmed = !matches!(spawned.child.try_wait(), Ok(Some(_)));
    let result = result.map_err(|error| terminal_message(error, &spawned.stderr_buf));
    settle(
        &core,
        &mut state,
        &mut view,
        result,
        &killed,
        virtual_pid,
        preassigned_session_id,
    )
    .await;
}

/// Reduce a failure to what the user should read: the CLI's own rpc message,
/// else its stderr tail (a crash or a rejected launch speaks there), else the
/// driver's own words.
fn terminal_message(raw: String, stderr_buf: &Mutex<String>) -> String {
    if let Some(rest) = raw.strip_prefix("rpc:") {
        if let Some((_, message)) = rest.split_once(':') {
            if !message.trim().is_empty() {
                return message.to_string();
            }
        }
    }
    let stderr = stderr_buf.lock().map(|buf| buf.clone()).unwrap_or_default();
    let stderr = stderr.trim();
    if stderr.is_empty() {
        return raw;
    }
    format!("{raw}\n{stderr}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::registry::ChildEntry;
    use crate::engine::ProcessRegistry;
    use crate::event_sink::{Emit, EventSink};
    use std::collections::HashMap;
    include!("codex_app_auto_review_tests.rs");
    include!("codex_app_timeout_tests.rs");
    include!("codex_app_isolation_tests.rs");
    include!("codex_app_history_tests.rs");

    #[cfg(windows)]
    #[tokio::test]
    async fn codex_resume_reply_then_usage_replay_keeps_terminal_throughput() {
        let (core, _registry, emitter) = test_core();
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-Command", r#"
            [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
            [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
            $resume = [Console]::ReadLine() | ConvertFrom-Json
            @{id=$resume.id;result=@{thread=@{id='thread'}}} | ConvertTo-Json -Compress -Depth 10
            '{"method":"thread/tokenUsage/updated","params":{"threadId":"thread","turnId":"old-turn","tokenUsage":{"total":{"outputTokens":100},"last":{"outputTokens":40}}}}'
            $start = [Console]::ReadLine() | ConvertFrom-Json
            '{"method":"turn/started","params":{"threadId":"thread","turn":{"id":"turn"}}}'
            @{id=$start.id;result=@{turn=@{id='turn'}}} | ConvertTo-Json -Compress -Depth 10
            '{"method":"thread/tokenUsage/updated","params":{"threadId":"thread","turnId":"turn","tokenUsage":{"total":{"outputTokens":130},"last":{"outputTokens":30}}}}'
            '{"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":"completed","durationMs":1000}}}'
        "#]);
        let mut spawned = spawn_app_server(&mut command, &std::env::temp_dir()).unwrap();
        let killed = AtomicBool::new(false);
        let mut state = TurnState::new(Some("thread".into()));
        let mut view = TurnView::default();
        let key = spawned.server.request("thread/resume", json!({"threadId":"thread"})).await.unwrap();
        let reply = spawned.server.pump("resume fixture", Expect::Reply(&key),
            Some(Instant::now() + Duration::from_secs(10)), &killed, None,
            &mut |value| route(&core, &mut state, &mut view, value)).await.unwrap().unwrap();
        assert_eq!(reply["thread"]["id"], "thread");
        view.throughput.begin("thread", false);
        let key = spawned.server.request("turn/start", json!({"threadId":"thread","input":[]})).await.unwrap();
        view.accepting_approvals = true;
        let reply = spawned.server.pump("start fixture", Expect::Reply(&key),
            Some(Instant::now() + Duration::from_secs(10)), &killed, None,
            &mut |value| route(&core, &mut state, &mut view, value)).await.unwrap().unwrap();
        view.turn_id = reply.pointer("/turn/id").and_then(Value::as_str).map(str::to_string);
        view.throughput.acknowledge(reply.pointer("/turn/id").and_then(Value::as_str));
        spawned.server.pump("finish fixture", Expect::Turn,
            Some(Instant::now() + Duration::from_secs(10)), &killed, None,
            &mut |value| route(&core, &mut state, &mut view, value)).await.unwrap();
        teardown(&mut spawned.child).await;
        let terminal = flushed(&core, &emitter).into_iter()
            .filter(|(kind, _)| kind == "throughput")
            .map(|(_, payload)| payload)
            .find(|payload| payload["status"] == "complete")
            .expect("resumed turn must publish complete native throughput");
        assert_eq!(terminal["outputTokens"], 30);
        assert_eq!(terminal["elapsedMs"], 1000);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn steer_pump_dispatches_ack_and_keeps_notifications() {
        let (_core, registry, _emitter) = test_core();
        let workspace = std::env::temp_dir();
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-Command", r#"
            [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
            [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
            $request = [Console]::ReadLine() | ConvertFrom-Json
            @{jsonrpc='2.0';id=$request.id;result=@{turnId=$request.params.expectedTurnId}} | ConvertTo-Json -Compress -Depth 10
            @{method='inputObserved';params=$request.params} | ConvertTo-Json -Compress -Depth 10
            '{"method":"turn/completed","params":{}}'
        "#]);
        let mut spawned = spawn_app_server(&mut command, &workspace).unwrap();
        registry.set_stdin("test-run", Arc::clone(&spawned.server.stdin));
        registry.set_codex_control("test-run", Arc::clone(&spawned.server.control));
        spawned.server.control.activate("backend-thread", "backend-turn");
        let killed = AtomicBool::new(false);
        let mut observed = None;
        let image_paths = vec!["image.png".into()];
        let mut on_message = |value: &Value| {
            if value["method"] == "turn/completed" { Handled::Ended }
            else {
                observed = Some(value["params"].clone());
                Handled::Ignore
            }
        };
        let (sent, pumped) = tokio::join!(
            send_steer(&registry, "test-run", &workspace, "调整🙂", &image_paths),
            spawned.server.pump("fixture", Expect::Turn, Some(Instant::now() + Duration::from_secs(10)), &killed, None, &mut on_message),
        );
        assert_eq!(sent.unwrap(), true);
        assert!(pumped.unwrap().is_none());
        let observed = observed.unwrap();
        assert_eq!(observed["threadId"], "backend-thread");
        assert_eq!(observed["expectedTurnId"], "backend-turn");
        assert_eq!(observed["input"], json!(user_input("调整🙂", &["image.png".into()], &workspace)));
        assert!(!send_steer(&registry, "test-run", &workspace, "late", &[]).await.unwrap());
        teardown(&mut spawned.child).await;
    }

    #[tokio::test]
    async fn steer_unavailable_and_pipe_failure_never_report_success() {
        let (_core, registry, _emitter) = test_core();
        let workspace = Path::new(".");
        assert!(!send_steer(&registry, "missing", workspace, "text", &[]).await.unwrap());
        assert!(!send_steer(&registry, "test-run", workspace, "text", &[]).await.unwrap());
        let control = Arc::new(super::super::codex_control::CodexControl::default());
        registry.set_codex_control("test-run", Arc::clone(&control));
        assert!(!send_steer(&registry, "test-run", workspace, "text", &[]).await.unwrap());
        control.activate("thread", "turn");
        assert!(send_steer(&registry, "test-run", workspace, "text", &["data:image/png;base64,AA==".into()]).await.unwrap_err().contains("local image"));
        assert!(send_steer(&registry, "test-run", workspace, "text", &[]).await.is_err());
        registry.close_stdin("test-run");
        assert!(!send_steer(&registry, "test-run", workspace, "text", &[]).await.unwrap());
    }

    #[test]
    fn leader_guidance_preserves_configured_instructions_and_can_be_removed() {
        let configured = "遵循项目规则 🧭\nDo not replace this text.";
        let role = "Coordinate work using your judgment.";
        assert_eq!(append_host_instructions(Some(configured), role), format!("{configured}\n\n{role}"));
        assert_eq!(append_host_instructions(Some(configured), ""), configured);
        assert_eq!(append_host_instructions(None, ""), "");
        assert_eq!(append_host_instructions(None, role), role);
    }

    /// Test emitter collecting flushed event JSON for assertions.
    struct CollectingEmitter(Mutex<Vec<String>>);

    impl Emit for CollectingEmitter {
        fn emit_json(&self, _name: &str, raw_json: &str) {
            self.0.lock().unwrap().push(raw_json.to_string());
        }
    }

    /// A TurnCore with a registry entry under its run id (so question parking
    /// has somewhere to land) plus the collected flushes for assertions.
    fn test_core() -> (TurnCore, Arc<ProcessRegistry>, Arc<CollectingEmitter>) {
        let emitter = Arc::new(CollectingEmitter(Mutex::new(Vec::new())));
        let registry = Arc::new(ProcessRegistry::default());
        registry.insert(
            "test-run".to_string(),
            ChildEntry {
                child: None,
                pid: 4_000_000_099,
                run_id: "test-run".to_string(),
                killed: Arc::new(AtomicBool::new(false)),
                reader_abort: Arc::new(std::sync::OnceLock::new()),
                stdin: None,
                questions: Arc::new(Mutex::new(HashMap::new())),
                plans: Arc::new(Mutex::new(HashMap::new())),
                native_tasks: Default::default(),
                codex_control: None,
            },
        );
        let core = TurnCore {
            sink: EventSink::new(emitter.clone()),
            registry: Arc::clone(&registry),
            engine_id: "codex".to_string(),
            run_id: "test-run".to_string(),
            db: None,
        };
        (core, registry, emitter)
    }

    /// Flush the sink and return `(kind, data)` for every event emitted.
    fn flushed(core: &TurnCore, emitter: &Arc<CollectingEmitter>) -> Vec<(String, Value)> {
        core.sink.flush();
        let mut out = Vec::new();
        for raw in emitter.0.lock().unwrap().iter() {
            let parsed: Value = serde_json::from_str(raw).expect("flushed batch must be JSON");
            let batch = parsed.as_array().cloned().unwrap_or_else(|| vec![parsed]);
            for value in batch {
                out.push((
                    value
                        .get("kind")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    value.get("data").cloned().unwrap_or(Value::Null),
                ));
            }
        }
        out
    }

    fn parked(rpc_id: Value, ids: Value) -> Value {
        json!({ "rpcId": rpc_id, "ids": ids })
    }

    fn desktop_request() -> SendRequest {
        SendRequest {
            claude_ultracode: None,
            host_instructions: None,
            session_id: Some("desktop-thread".into()),
            workspace: "G:/Work".into(),
            prompt: "继续 🧭".into(),
            images: Vec::new(),
            model: None,
            effort: None,
            service_tier: None,
            permission: Some("bypass".into()),
            additional_dirs: Vec::new(),
            provider_id: None,
            computer_use: None,
            allowed_tools: None,
        }
    }

    fn writer_conflict() -> Result<(), String> {
        Err("rpc:-32600:thread desktop-thread already has an active writer".into())
    }

    #[tokio::test]
    async fn desktop_route_fails_closed_without_executing_handoff() {
        for settings in [Ok(false), Err("unreadable settings".into())] {
            let calls = std::sync::atomic::AtomicUsize::new(0);
            let result = route_resume_result(
                writer_conflict(),
                &desktop_request(),
                true,
                false,
                &Mutex::new(String::new()),
                || settings,
                || {
                    calls.fetch_add(1, Ordering::SeqCst);
                    async { Ok(()) }
                },
            )
            .await;
            assert!(result.unwrap_err().starts_with("[codex-desktop:disabled]"));
            assert_eq!(calls.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn desktop_route_only_executes_for_an_enabled_exact_ordinary_writer_conflict() {
        for (result, ordinary, decision, session, expected_calls) in [
            (writer_conflict(), true, false, Some("desktop-thread"), 1),
            (writer_conflict(), false, false, Some("desktop-thread"), 0),
            (writer_conflict(), true, true, Some("desktop-thread"), 0),
            (writer_conflict(), true, false, Some("other-thread"), 0),
            (writer_conflict(), true, false, None, 0),
            (
                Err("rpc:-32600:thread not found".into()),
                true,
                false,
                Some("desktop-thread"),
                0,
            ),
            (Ok(()), true, false, Some("desktop-thread"), 0),
        ] {
            let request = SendRequest {
                session_id: session.map(str::to_string),
                ..desktop_request()
            };
            let settings_reads = std::sync::atomic::AtomicUsize::new(0);
            let calls = std::sync::atomic::AtomicUsize::new(0);
            let native_succeeded = result.is_ok();
            let result = route_resume_result(
                result,
                &request,
                ordinary,
                decision,
                &Mutex::new(String::new()),
                || {
                    settings_reads.fetch_add(1, Ordering::SeqCst);
                    Ok(true)
                },
                || {
                    calls.fetch_add(1, Ordering::SeqCst);
                    async { Err("mock handoff outcome".into()) }
                },
            )
            .await;
            assert_eq!(calls.load(Ordering::SeqCst), expected_calls);
            assert_eq!(settings_reads.load(Ordering::SeqCst), expected_calls);
            if expected_calls == 1 {
                assert_eq!(result, Err("mock handoff outcome".into()));
            } else if native_succeeded {
                assert_eq!(result, Ok(()));
            } else {
                assert!(!result.unwrap_err().contains("[codex-desktop:"));
            }
        }
    }

    #[derive(Clone)]
    struct MockDesktop {
        sends: Arc<std::sync::atomic::AtomicUsize>,
        reads: Arc<std::sync::atomic::AtomicUsize>,
        snapshot: codex_desktop::Snapshot,
        stop_after_send: Option<Arc<AtomicBool>>,
    }

    impl DesktopChannel for MockDesktop {
        async fn read(&self) -> Result<codex_desktop::Snapshot, codex_desktop::LinkError> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            Ok(self.snapshot.clone())
        }

        async fn send(&self, prompt: &str) -> Result<(), codex_desktop::LinkError> {
            assert_eq!(prompt, "继续 🧭");
            self.sends.fetch_add(1, Ordering::SeqCst);
            if let Some(killed) = &self.stop_after_send {
                killed.store(true, Ordering::SeqCst);
            }
            Ok(())
        }
    }

    fn mock_desktop(turn_status: &str) -> MockDesktop {
        MockDesktop {
            sends: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            reads: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            stop_after_send: None,
            snapshot: codex_desktop::Snapshot {
                status: if turn_status == "inProgress" {
                    "active"
                } else {
                    "idle"
                }
                .into(),
                cwd: "G:/Work".into(),
                turns: vec![codex_desktop::Turn {
                    id: "delivered-turn".into(),
                    status: turn_status.into(),
                    error: None,
                    items: vec![
                        json!({"type": "functionCallOutput", "id": "delivery", "name": "send_message_to_thread"}),
                    ],
                }],
                ..Default::default()
            },
        }
    }

    #[tokio::test(start_paused = true)]
    async fn desktop_opt_in_keeps_safety_restrictions_before_sending() {
        for (request, status, cwd, expected_code, expected_finds) in [
            (
                SendRequest {
                    images: vec!["shot.png".into()],
                    ..desktop_request()
                },
                "idle",
                "G:/Work",
                "images",
                0,
            ),
            (
                SendRequest {
                    permission: Some("manual".into()),
                    ..desktop_request()
                },
                "idle",
                "G:/Work",
                "settings",
                0,
            ),
            (desktop_request(), "notLoaded", "G:/Work", "elsewhere", 1),
            (desktop_request(), "idle", "G:/Elsewhere", "workspace", 1),
        ] {
            let (core, _, _) = test_core();
            let mut state = TurnState::new(request.session_id.clone());
            let mut view = TurnView::default();
            let killed = Arc::new(AtomicBool::new(false));
            let desktop = mock_desktop("completed");
            let finds = std::sync::atomic::AtomicUsize::new(0);
            let result = route_resume_result(
                writer_conflict(),
                &request,
                true,
                false,
                &Mutex::new(String::new()),
                || Ok(true),
                || {
                    continue_in_desktop_using(
                        &core,
                        &mut state,
                        &mut view,
                        &request,
                        &killed,
                        |_| {
                            finds.fetch_add(1, Ordering::SeqCst);
                            let found = desktop.clone();
                            async move {
                                Ok((
                                    found,
                                    codex_desktop::Snapshot {
                                        status: status.into(),
                                        cwd: cwd.into(),
                                        ..Default::default()
                                    },
                                ))
                            }
                        },
                    )
                },
            )
            .await;
            assert!(result
                .unwrap_err()
                .starts_with(&format!("[codex-desktop:{expected_code}]")));
            assert_eq!(finds.load(Ordering::SeqCst), expected_finds);
            assert_eq!(desktop.sends.load(Ordering::SeqCst), 0);
            assert_eq!(desktop.reads.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn desktop_follow_timeout_settles_as_error_without_done_or_resend() {
        let request = desktop_request();
        let (core, registry, emitter) = test_core();
        let mut state = TurnState::new(request.session_id.clone());
        let mut view = TurnView::default();
        let entry = registry.get("test-run").unwrap();
        assert!(entry.child.is_none(), "following must remain a virtual run");
        let killed = entry.killed;
        let desktop = mock_desktop("inProgress");
        let started = Instant::now();
        let result = route_resume_result(
            writer_conflict(),
            &request,
            true,
            false,
            &Mutex::new(String::new()),
            || Ok(true),
            || {
                continue_in_desktop_using(&core, &mut state, &mut view, &request, &killed, |_| {
                    let found = desktop.clone();
                    async move {
                        Ok((
                            found,
                            codex_desktop::Snapshot {
                                status: "idle".into(),
                                cwd: "G:/Work".into(),
                                ..Default::default()
                            },
                        ))
                    }
                })
            },
        )
        .await;
        let notice = result.as_ref().unwrap_err();
        assert!(notice.starts_with("[codex-desktop:timeout]"));
        assert!(notice.contains("can't confirm") && notice.contains("may continue"));
        assert!(started.elapsed() >= PROMPT_TIMEOUT);
        assert_eq!(desktop.sends.load(Ordering::SeqCst), 1);
        assert!(desktop.reads.load(Ordering::SeqCst) > 0);
        settle(
            &core,
            &mut state,
            &mut view,
            result,
            &killed,
            4_000_000_099,
            request.session_id,
        )
        .await;
        let events = flushed(&core, &emitter);
        assert_eq!(events.iter().filter(|(kind, _)| kind == "error").count(), 1);
        assert!(!events.iter().any(|(kind, _)| kind == "done"));
        assert!(registry.get("test-run").is_none());
    }

    #[tokio::test(start_paused = true)]
    async fn desktop_stop_only_settles_the_virtual_follow_run() {
        let request = desktop_request();
        let (core, registry, emitter) = test_core();
        let mut state = TurnState::new(request.session_id.clone());
        let mut view = TurnView::default();
        let entry = registry.get("test-run").unwrap();
        assert!(entry.child.is_none());
        let killed = entry.killed.clone();
        let mut unrelated = entry;
        unrelated.pid += 1;
        unrelated.run_id = "unrelated-run".into();
        unrelated.killed = Arc::new(AtomicBool::new(false));
        registry.insert("unrelated-run".into(), unrelated);
        let mut desktop = mock_desktop("inProgress");
        desktop.stop_after_send = Some(killed.clone());
        let result =
            continue_in_desktop_using(&core, &mut state, &mut view, &request, &killed, |_| {
                let found = desktop.clone();
                async move {
                    Ok((
                        found,
                        codex_desktop::Snapshot {
                            status: "idle".into(),
                            cwd: "G:/Work".into(),
                            ..Default::default()
                        },
                    ))
                }
            })
            .await;
        assert_eq!(
            result,
            Ok(()),
            "the stop notice was dispatched before settle"
        );
        settle(
            &core,
            &mut state,
            &mut view,
            result,
            &killed,
            4_000_000_099,
            request.session_id,
        )
        .await;
        let events = flushed(&core, &emitter);
        let errors: Vec<_> = events.iter().filter(|(kind, _)| kind == "error").collect();
        assert_eq!(errors.len(), 1);
        assert!(errors[0]
            .1
            .as_str()
            .unwrap()
            .starts_with("[codex-desktop:stopped]"));
        assert!(!events.iter().any(|(kind, _)| kind == "done"));
        assert_eq!(desktop.sends.load(Ordering::SeqCst), 1);
        assert_eq!(desktop.reads.load(Ordering::SeqCst), 0);
        assert!(registry.get("test-run").is_none());
        assert!(!registry
            .get("unrelated-run")
            .unwrap()
            .killed
            .load(Ordering::SeqCst));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "requires CCGUI_CODEX_READ_ONLY_TEST_BIN pointing to audited Codex 0.154.0 on macOS; no model calls"]
    async fn installed_codex_isolated_planner_blocks_writes_and_external_tools() {
        use crate::engine::Engine;
        let bin = std::env::var("CCGUI_CODEX_READ_ONLY_TEST_BIN").unwrap();
        let root =
            std::env::temp_dir().join(format!("ccgui-codex-isolation-{}", uuid::Uuid::new_v4()));
        let _root_guard = codex_read_only::StagedHomeGuard(vec![root.clone()]);
        let native = root.join("native");
        let workspace = root.join("workspace");
        std::fs::create_dir_all(&native).unwrap();
        std::fs::create_dir_all(workspace.join(".codex")).unwrap();
        let marker = root.join("MCP_STARTED");
        let malicious = format!(
            "[mcp_servers.fixture]\ncommand=\"/bin/sh\"\nargs=[\"-c\",\"touch {}\"]\n",
            marker.display()
        );
        std::fs::write(native.join("config.toml"),format!("model=\"probe\"\nmodel_provider=\"probe\"\nnotify=[\"/bin/sh\",\"-c\",\"touch {}\"]\n[model_providers.probe]\nname=\"probe\"\nbase_url=\"http://127.0.0.1:9/v1\"\nwire_api=\"responses\"\n{malicious}",marker.display())).unwrap();
        std::fs::write(workspace.join(".codex/config.toml"), &malicious).unwrap();
        let request = SendRequest {
            claude_ultracode: None,
            host_instructions: None,
            session_id: None,
            workspace: workspace.clone(),
            prompt: "not sent".into(),
            images: vec![],
            model: Some("probe".into()),
            effort: None,
            service_tier: None,
            permission: Some(codex_read_only::PERMISSION.into()),
            additional_dirs: vec![],
            provider_id: None,
            computer_use: None,
            allowed_tools: None,
        };
        assert!(crate::engine::codex::CodexEngine
            .build_command(&request, &bin)
            .is_err());
        let mut built = crate::engine::codex::CodexEngine
            .host_command(&request, &bin)
            .unwrap();
        codex_read_only::stage(&request, &mut built, &native, &root.join("staging")).unwrap();
        let home =
            std::fs::canonicalize(codex_read_only::isolated_home(&built.command).unwrap()).unwrap();
        assert!(!std::fs::read_to_string(home.join("config.toml"))
            .unwrap()
            .contains("mcp_servers"));
        let mut spawned = spawn_app_server(&mut built.command, &workspace).unwrap();
        let killed = AtomicBool::new(false);
        let result: Result<(),String> = async {
            for (method,params) in [
                ("initialize",json!({"clientInfo":{"name":"ccgui_probe","version":"1"},"capabilities":{"experimentalApi":true}})),
                ("configRequirements/read",json!({})),
                ("config/read",json!({"cwd":workspace,"includeLayers":true})),
                ("thread/start",json!({"cwd":workspace,"model":"probe","sandbox":"read-only","approvalPolicy":"never","ephemeral":true,"dynamicTools":[],"selectedCapabilityRoots":[],"environments":[{"environmentId":"local","cwd":workspace}]})),
                ("command/exec",json!({"command":["/bin/sh","-c","cat .codex/config.toml"],"cwd":workspace,"sandboxPolicy":{"type":"readOnly","networkAccess":false},"timeoutMs":3000})),
                ("command/exec",json!({"command":["/bin/sh","-c","touch DENIED_WRITE"],"cwd":workspace,"sandboxPolicy":{"type":"readOnly","networkAccess":false},"timeoutMs":3000})),
            ] {
                let writing=params.pointer("/command/2")==Some(&json!("touch DENIED_WRITE"));
                let key=spawned.server.request(method,params).await?;
                let response=spawned.server.pump(method,Expect::Reply(&key),Some(Instant::now()+Duration::from_secs(10)),&killed,None,&mut |_| Handled::Ignore).await?
                    .ok_or("Probe ended without a response")?;
                match method {
                    "initialize"=>codex_read_only::validate_version(&response).map_err(|error| format!("{error}; reported user agent: {}",response["userAgent"]))?,
                    "configRequirements/read"=>assert_eq!(response["requirements"],Value::Null),
                    "config/read"=>codex_read_only::validate_config(&response,&home)?,
                    "thread/start"=>codex_read_only::validate_thread(&response)?,
                    "command/exec" if writing=>assert_ne!(response["exitCode"],json!(0)),
                    "command/exec"=>assert_eq!(response["exitCode"],json!(0)),
                    _=>unreachable!(),
                }
            }
            Ok(())
        }.await;
        teardown(&mut spawned.child).await;
        result.unwrap();
        assert!(!marker.exists());
        assert!(!workspace.join("DENIED_WRITE").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn plugin_codex_interrupt_during_handshake_waits_for_process_exit() {
        let (mut core, registry, emitter) = test_core();
        let mut entry = registry.get("test-run").unwrap();
        registry.remove_if_pid("test-run", entry.pid);
        core.run_id = "pa-relay-codex-interrupt".into();
        entry.run_id = core.run_id.clone();
        let killed = entry.killed.clone();
        let virtual_pid = entry.pid;
        registry.insert(core.run_id.clone(), entry);
        let directory =
            std::env::temp_dir().join(format!("ccgui-codex-interrupt-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let pid_file = directory.join("pid");
        let mut command = Command::new("sh");
        command.args([
            "-c",
            &format!(
                "echo $$ > '{}'; read ignored; exec sleep 30",
                pid_file.display()
            ),
        ]);
        let request = SendRequest {
            claude_ultracode: None,
            host_instructions: None,
            session_id: None,
            workspace: directory.clone(),
            prompt: "hi".into(),
            images: vec![],
            model: None,
            effort: None,
            service_tier: None,
            permission: None,
            additional_dirs: vec![],
            provider_id: None,
            computer_use: None,
            allowed_tools: None,
        };
        let built = BuiltCommand {
            command,
            stdin_payload: None,
            keep_stdin_open: true,
            cleanup_files: vec![],
            mcp_restore: None,
            preassigned_session_id: None,
        };
        let run_id = core.run_id.clone();
        let sink = core.sink.clone();
        let task = tokio::spawn(run_app_server_turn(
            core,
            request,
            built,
            killed,
            virtual_pid,
        ));
        timeout(Duration::from_secs(3), async {
            while !pid_file.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let child_pid: i32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(registry.kill(&run_id));
        timeout(Duration::from_secs(3), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(unsafe { libc::kill(child_pid, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
        assert_eq!(registry.active_run_count(), 0);
        sink.flush();
        let events: Vec<Value> = emitter
            .0
            .lock()
            .unwrap()
            .iter()
            .flat_map(|raw| serde_json::from_str::<Vec<Value>>(raw).unwrap())
            .collect();
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event["kind"].as_str(), Some("done" | "error")))
                .count(),
            1
        );
        assert_eq!(events.last().unwrap()["kind"], "done");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn answer_frame_keys_a_single_choice_by_the_servers_question_id() {
        let frame = answer_frame(
            &parked(json!(7), json!({ "Which one?": "q1" })),
            Some(&json!({ "Which one?": "Alpha" })),
        )
        .unwrap();
        assert_eq!(frame["jsonrpc"], json!("2.0"));
        assert_eq!(frame["id"], json!(7));
        assert_eq!(
            frame["result"],
            json!({ "answers": { "q1": { "answers": ["Alpha"] } } })
        );
    }

    #[test]
    fn answer_frame_keeps_every_label_of_a_multi_select() {
        let frame = answer_frame(
            &parked(json!("rpc-9"), json!({ "Layers?": "q9" })),
            Some(&json!({ "Layers?": ["ui", "engine"] })),
        )
        .unwrap();
        // The id is echoed verbatim: the CLI correlates on its own token, which
        // may be a string or a number.
        assert_eq!(frame["id"], json!("rpc-9"));
        assert_eq!(
            frame["result"]["answers"]["q9"]["answers"],
            json!(["ui", "engine"])
        );
    }

    #[test]
    fn answer_frame_rejects_an_answer_to_a_question_that_was_never_asked() {
        let error = answer_frame(
            &parked(json!(1), json!({ "Which one?": "q1" })),
            Some(&json!({ "Something else?": "Alpha" })),
        )
        .unwrap_err();
        assert!(error.contains("Something else?"), "{error}");
    }

    #[test]
    fn answer_frame_rejects_a_non_object_answer_map() {
        let error =
            answer_frame(&parked(json!(1), json!({})), Some(&json!(["Alpha"]))).unwrap_err();
        assert!(error.contains("object"), "{error}");
    }

    #[test]
    fn answer_frame_settles_a_dismissed_card_with_an_empty_answer() {
        // A dismissal is not an error: the model must be able to move on, and
        // an empty answer map is the protocol's way of saying "nothing chosen".
        let frame = answer_frame(&parked(json!(3), json!({ "Which one?": "q1" })), None).unwrap();
        assert_eq!(frame["id"], json!(3));
        assert_eq!(frame["result"], json!({ "answers": {} }));
    }

    #[test]
    fn answer_frame_reports_a_single_question_answered_with_null_as_empty() {
        let frame = answer_frame(
            &parked(json!(3), json!({ "Which one?": "q1" })),
            Some(&json!({ "Which one?": null })),
        )
        .unwrap();
        assert_eq!(frame["result"]["answers"]["q1"], json!({ "answers": [] }));
    }

    #[test]
    fn question_cards_synthesise_missing_headers_and_options() {
        let params = json!({
            "itemId": "item-1",
            "questions": [
                {
                    "id": "q1",
                    "question": "Which one?",
                    "options": [
                        { "label": "Alpha" },
                        { "label": "Beta", "description": "the second one" },
                    ],
                },
                { "id": "q2", "question": "  And then?  " },
            ],
        });
        let (cards, ids) = question_cards(&params);
        assert_eq!(cards.len(), 2);
        assert_eq!(cards[0]["question"], json!("Which one?"));
        assert_eq!(cards[0]["header"], json!("Q1"));
        assert_eq!(cards[0]["options"][0], json!({ "label": "Alpha" }));
        assert_eq!(
            cards[0]["options"][1],
            json!({ "label": "Beta", "description": "the second one" })
        );
        // Codex asks single-choice questions: an absent flag is what the card
        // already reads as, so it must not be synthesised.
        assert!(cards[0].get("multiSelect").is_none());
        assert_eq!(cards[1]["question"], json!("And then?"));
        assert_eq!(cards[1]["header"], json!("Q2"));
        assert_eq!(cards[1]["options"], json!([]));
        assert_eq!(ids, json!({ "Which one?": "q1", "And then?": "q2" }));
    }

    #[test]
    fn question_cards_skip_questions_the_card_cannot_ask() {
        let params = json!({
            "questions": [
                { "id": "q1", "question": "   " },
                { "question": "no id" },
                { "id": "q3", "question": "Real?" },
            ],
        });
        let (cards, ids) = question_cards(&params);
        assert_eq!(cards.len(), 1);
        // The header stays tied to the question's position in the request, so a
        // skipped one still shifts the numbering the protocol implies.
        assert_eq!(cards[0]["header"], json!("Q3"));
        assert_eq!(ids, json!({ "Real?": "q3" }));
    }

    #[test]
    fn sandbox_for_mirrors_the_exec_permission_mapping() {
        assert_eq!(sandbox_for(Some("bypass")), "danger-full-access");
        assert_eq!(sandbox_for(Some("manual")), "read-only");
        assert_eq!(sandbox_for(Some("auto")), "workspace-write");
        // Anything the exec path's fallback would land on resolves to the same
        // default here.
        assert_eq!(sandbox_for(Some("plan")), "workspace-write");
        assert_eq!(sandbox_for(None), "workspace-write");
    }

    #[test]
    fn usage_payload_projects_the_protocol_fields_onto_snake_case() {
        let usage = json!({
            "last": {
                "inputTokens": 120,
                "cachedInputTokens": 100,
                "cacheWriteInputTokens": 5,
                "outputTokens": 30,
                "reasoningOutputTokens": 7,
                "totalTokens": 150,
            },
            "total": { "inputTokens": 1, "outputTokens": 2, "totalTokens": 3 },
        });
        let payload = usage_payload(&usage, Some(&json!(128_000))).unwrap();
        assert_eq!(payload["input_tokens"], json!(120));
        assert_eq!(payload["cached_input_tokens"], json!(100));
        assert_eq!(payload["cache_write_input_tokens"], json!(5));
        assert_eq!(payload["output_tokens"], json!(30));
        assert_eq!(payload["reasoning_output_tokens"], json!(7));
        assert_eq!(payload["total_tokens"], json!(150));
        assert_eq!(payload["model_context_window"], json!(128_000));
        assert_eq!(payload["usage_scope"], json!("last_request"));
    }

    #[test]
    fn usage_payload_omits_what_the_report_does_not_carry() {
        assert!(usage_payload(&json!({ "total": { "totalTokens": 3 } }), None).is_none());
        assert!(usage_payload(&json!({ "last": {} }), None).is_none());
        let payload = usage_payload(&json!({ "last": { "totalTokens": 3 } }), None).unwrap();
        assert_eq!(payload, json!({ "total_tokens": 3, "usage_scope": "last_request" }));
    }

    // Every test below drives the router, so each needs a runtime: the sink
    // schedules its batch flush with `tokio::spawn`, and an error dispatch
    // kills the run through `spawn_blocking`.

    fn active_test_turn() -> (TurnState, TurnView) {
        (TurnState::new(Some("t1".into())), TurnView {
            turn_id: Some("turn-1".into()),
            accepting_approvals: true,
            ..TurnView::default()
        })
    }

    #[test]
    fn sidechat_questions_do_not_park_an_invisible_interactive_card() {
        let (mut core, _, _) = test_core();
        core.run_id = "sidechat-question-test".into();
        let mut state = TurnState::new(None);
        let mut view = TurnView::default();
        let handled = handle_server_request(&core, &mut state, &mut view,
            "item/tool/requestUserInput", &json!(1), &json!({"questions":[{"id":"q","question":"Choose","options":[]}]}));
        let Handled::Answer(answer) = handled else { panic!("side question must be answered without parking"); };
        assert_eq!(answer["result"]["answers"], json!({}));
    }

    #[tokio::test]
    async fn route_parks_a_question_and_the_answer_frame_reads_what_it_parked() {
        let (core, registry, emitter) = test_core();
        let (mut state, mut view) = active_test_turn();
        let handled = route(
            &core,
            &mut state,
            &mut view,
            &json!({
                "jsonrpc": "2.0",
                "id": 12,
                "method": "item/tool/requestUserInput",
                "params": {
                    "threadId": "t1",
                    "turnId": "turn-1",
                    "itemId": "item-1",
                    "questions": [{
                        "id": "q1",
                        "question": "Which one?",
                        "options": [{ "label": "Alpha" }],
                    }],
                },
            }),
        );
        // Parked, not answered: the card waits for the user and the rpc id is
        // what the answer command writes back on.
        assert!(matches!(handled, Handled::Parked));
        let events = flushed(&core, &emitter);
        let question = events
            .iter()
            .find(|(kind, _)| kind == "question")
            .expect("the card must reach the UI");
        assert_eq!(question.1["requestId"], json!("12"));
        assert_eq!(question.1["toolUseId"], json!("item-1"));
        assert_eq!(question.1["input"]["questions"][0]["header"], json!("Q1"));
        let entry = registry.get("test-run").expect("registry entry");
        let parked = entry
            .questions
            .lock()
            .unwrap()
            .get("12")
            .cloned()
            .expect("the answer context must be parked under the rpc id");
        // The two halves of the round trip must agree: what `route` parked is
        // exactly what `answer_frame` (called by the answer command) consumes.
        let frame = answer_frame(
            parked.get("codexApp").expect("codexApp context"),
            Some(&json!({ "Which one?": "Alpha" })),
        )
        .unwrap();
        assert_eq!(frame["id"], json!(12));
        assert_eq!(
            frame["result"],
            json!({ "answers": { "q1": { "answers": ["Alpha"] } } })
        );
    }

    #[tokio::test]
    async fn route_answers_an_unrenderable_question_instead_of_wedging_the_turn() {
        let (core, registry, _emitter) = test_core();
        let (mut state, mut view) = active_test_turn();
        let handled = route(
            &core,
            &mut state,
            &mut view,
            &json!({
                "jsonrpc": "2.0",
                "id": 8,
                "method": "item/tool/requestUserInput",
                "params": { "threadId":"t1", "turnId":"turn-1", "questions": [] },
            }),
        );
        let Handled::Answer(frame) = handled else {
            panic!("a question the card cannot show must still be answered");
        };
        assert_eq!(frame["id"], json!(8));
        assert_eq!(frame["result"], json!({ "answers": {} }));
        let entry = registry.get("test-run").expect("registry entry");
        assert!(
            entry.questions.lock().unwrap().is_empty(),
            "nothing may be left waiting for an answer"
        );
    }

    #[tokio::test]
    async fn route_declines_an_approval_that_was_never_going_to_be_granted() {
        let (core, _registry, _emitter) = test_core();
        let mut state = TurnState::new(None);
        let mut view = TurnView::default();
        let handled = route(
            &core,
            &mut state,
            &mut view,
            &json!({
                "jsonrpc": "2.0",
                "id": 4,
                "method": "item/commandExecution/requestApproval",
                "params": { "command": "rm -rf build" },
            }),
        );
        let Handled::Answer(frame) = handled else {
            panic!("an approval request must always be answered");
        };
        assert_eq!(frame["id"], json!(4));
        assert_eq!(frame["result"], json!({ "decision": "decline" }));
    }

    #[tokio::test]
    async fn generated_images_emit_in_order_without_base64_tool_details_or_replays() {
        let (core, _registry, emitter) = test_core();
        let (mut state, mut view) = active_test_turn();
        let image = "data:image/png;base64,AA==";
        route(&core, &mut state, &mut view, &json!({"method":"item/agentMessage/delta",
            "params":{"threadId":"t1","turnId":"turn-1","itemId":"before","delta":"before"}}));
        let completed = json!({"method":"item/completed","params":{"threadId":"t1","turnId":"turn-1",
            "item":{"id":"image-tool","type":"dynamicToolCall","tool":"imagegen","success":true,
                "contentItems":[{"type":"inputText","text":"retained text"},{"type":"inputImage","imageUrl":image}]}}});
        route(&core, &mut state, &mut view, &completed);
        route(&core, &mut state, &mut view, &completed);
        route(&core, &mut state, &mut view, &json!({"method":"item/agentMessage/delta",
            "params":{"threadId":"t1","turnId":"turn-1","itemId":"after","delta":"after"}}));
        let events = flushed(&core, &emitter);
        assert_eq!(events.iter().map(|(kind, _)| kind.as_str()).collect::<Vec<_>>(), ["delta","message","message","delta"]);
        assert_eq!(events[2].1["images"], json!([image]));
        assert_eq!(events[2].1["text"], "");
        assert!(events[1].1["result"].to_string().contains("retained text"));
        assert!(!events[1].1.to_string().contains("base64"));
        // Existing turn gate must reject a late completion after settlement.
        view.accepting_approvals = false;
        let mut late = completed;
        late["params"]["item"]["id"] = json!("late-image");
        route(&core, &mut state, &mut view, &late);
        assert_eq!(flushed(&core, &emitter).len(), events.len());
    }

    #[tokio::test]
    async fn generated_images_native_saved_path_and_failed_mcp_results() {
        let (core, _registry, emitter) = test_core();
        let (mut state, mut view) = active_test_turn();
        let path = std::env::temp_dir().join("generated-image.png").to_string_lossy().to_string();
        for item in [
            json!({"id":"native","type":"imageGeneration","status":"completed","savedPath":path}),
            json!({"id":"failed","type":"mcpToolCall","tool":"imagegen","status":"failed",
                "error":{"message":"failed"},"result":{"content":[{"type":"image","mimeType":"image/png","data":"AA=="}]}}),
            json!({"id":"mcp","type":"mcpToolCall","tool":"imagegen","status":"completed",
                "result":{"content":[{"type":"image","mimeType":"image/png","data":"AA=="}]}}),
        ] {
            route(&core, &mut state, &mut view, &json!({"method":"item/completed",
                "params":{"threadId":"t1","turnId":"turn-1","item":item}}));
        }
        let events = flushed(&core, &emitter);
        let attachments: Vec<_> = events.iter().filter(|(_, payload)| payload.get("images").is_some()).collect();
        assert_eq!(attachments.len(), 2);
        assert_eq!(attachments[0].1["images"], json!([path]));
        assert_eq!(attachments[1].1["images"], json!(["data:image/png;base64,AA=="]));
        assert!(events.iter().any(|(_, payload)| payload.pointer("/result/error/message") == Some(&json!("failed"))));
    }

    #[tokio::test]
    async fn a_streamed_message_is_not_repeated_by_its_completed_item() {
        let (core, _registry, emitter) = test_core();
        let (mut state, mut view) = active_test_turn();
        route(
            &core,
            &mut state,
            &mut view,
            &json!({
                "method": "item/agentMessage/delta",
                "params": { "threadId":"t1", "turnId":"turn-1", "itemId": "m1", "delta": "Hel" },
            }),
        );
        route(
            &core,
            &mut state,
            &mut view,
            &json!({
                "method": "item/completed",
                "params": { "threadId":"t1", "turnId":"turn-1", "item": { "id": "m1", "type": "agentMessage", "text": "Hello" } },
            }),
        );
        let events = flushed(&core, &emitter);
        assert_eq!(
            events
                .iter()
                .map(|(kind, _)| kind.as_str())
                .collect::<Vec<_>>(),
            ["delta"]
        );
        assert_eq!(events[0].1, json!("Hel"));
    }

    #[tokio::test]
    async fn an_unstreamed_message_still_arrives_from_its_completed_item() {
        let (core, _registry, emitter) = test_core();
        let (mut state, mut view) = active_test_turn();
        route(
            &core,
            &mut state,
            &mut view,
            &json!({
                "method": "item/completed",
                "params": { "threadId":"t1", "turnId":"turn-1", "item": { "id": "m2", "type": "agentMessage", "text": "Hello" } },
            }),
        );
        let events = flushed(&core, &emitter);
        assert_eq!(events.len(), 1, "{events:?}");
        assert_eq!(events[0].0, "message");
        assert_eq!(events[0].1["role"], json!("assistant"));
        assert_eq!(events[0].1["text"], json!("Hello"));
    }

    #[tokio::test]
    async fn a_token_usage_notification_is_held_for_the_turn_end() {
        let (core, _registry, emitter) = test_core();
        let (mut state, mut view) = active_test_turn();
        route(
            &core,
            &mut state,
            &mut view,
            &json!({
                "method": "thread/tokenUsage/updated",
                "params": {
                    "threadId": "t1",
                    "turnId": "turn-1",
                    "tokenUsage": { "last": { "totalTokens": 42 } },
                    "modelContextWindow": 1000,
                },
            }),
        );
        assert_eq!(
            view.last_usage,
            Some(json!({ "total_tokens": 42, "model_context_window": 1000, "usage_scope": "last_request" }))
        );
        // The run reports usage once, with its Done: a mid-turn frame would
        // make the UI's context meter jump between turns.
        assert!(flushed(&core, &emitter).is_empty());
    }

    #[tokio::test]
    async fn a_failed_turn_settles_the_run_with_the_engines_own_message() {
        let (core, _registry, emitter) = test_core();
        let (mut state, mut view) = active_test_turn();
        let handled = route(
            &core,
            &mut state,
            &mut view,
            &json!({
                "method": "turn/completed",
                "params": {
                    "threadId": "t1",
                    "turn": {
                        "id": "turn-1",
                        "status": "failed",
                        "error": { "message": "stream disconnected" },
                    },
                },
            }),
        );
        assert!(matches!(handled, Handled::Ended));
        let events = flushed(&core, &emitter);
        assert_eq!(events.len(), 1, "{events:?}");
        assert_eq!(events[0].0, "error");
        assert_eq!(events[0].1, json!("stream disconnected"));
    }

    #[tokio::test]
    async fn a_clean_turn_ends_without_erroring() {
        let (core, _registry, emitter) = test_core();
        let (mut state, mut view) = active_test_turn();
        let handled = route(
            &core,
            &mut state,
            &mut view,
            &json!({
                "method": "turn/completed",
                "params": { "threadId": "t1", "turn": { "id": "turn-1", "status": "completed" } },
            }),
        );
        assert!(matches!(handled, Handled::Ended));
        // The driver settles the turn itself; a mid-turn error here would make
        // a perfectly good run look failed.
        assert!(flushed(&core, &emitter).is_empty());
    }

    // ==================== plan approval (next_turn) ====================

    fn plan_view() -> TurnView {
        TurnView {
            plan_mode: true,
            accepting_approvals: true,
            turn_id: Some("turn-1".into()),
            workspace: "/tmp/ws".to_string(),
            ..TurnView::default()
        }
    }

    fn next_turn_review() -> PlanReview {
        PlanReview {
            plan_id: "thread-1/plan".into(),
            engine: "codex".into(),
            session_id: "thread-1".into(),
            workspace_path: "/tmp/ws".into(),
            run_id: Some("run-1".into()),
            revision: 1,
            title: "Plan".into(),
            content: "# Plan\n- a".into(),
            content_hash: plan_review::content_hash("# Plan\n- a"),
            complete: true,
            review_kind: PlanReviewKind::NextTurn,
            native_plan_id: Some("item-9".into()),
            exec_permission: "auto".into(),
            status: plan_review::PlanStatus::Submitting,
            execution: plan_review::PlanExecution::NotStarted,
            decision: None,
            decision_intent_at: None,
            applied_at: None,
            created_at: 0,
            updated_at: 0,
            superseded_by: None,
        }
    }

    #[test]
    fn collaboration_mode_carries_only_the_fields_that_have_values() {
        assert_eq!(
            collaboration_mode("plan", "gpt-5", Some("high")),
            json!({"mode": "plan", "settings": {"model": "gpt-5", "reasoning_effort": "high"}})
        );
        // 没有 effort:settings 只带 schema 必填的 model。
        assert_eq!(
            collaboration_mode("default", "gpt-5", None),
            json!({"mode": "default", "settings": {"model": "gpt-5"}})
        );
        // 空白 effort 等同于没有。
        assert_eq!(
            collaboration_mode("plan", "gpt-5", Some("  ")),
            json!({"mode": "plan", "settings": {"model": "gpt-5"}})
        );
    }

    #[test]
    fn plan_collaboration_prefers_the_request_and_fails_closed_without_a_model() {
        // 显式模型优先于线程报告值;effort 仅在有值时携带。
        assert_eq!(
            plan_collaboration(Some("gpt-5"), Some("thread-model"), Some("low")).unwrap(),
            json!({"mode": "plan", "settings": {"model": "gpt-5", "reasoning_effort": "low"}})
        );
        // 请求没选模型:沿用线程当前模型。
        assert_eq!(
            plan_collaboration(None, Some("thread-model"), None).unwrap(),
            json!({"mode": "plan", "settings": {"model": "thread-model"}})
        );
        // 两者都没有:settings.model 是必填,缺了就是 schema 级非法参数。
        let error = plan_collaboration(None, None, None).unwrap_err();
        assert!(error.contains("model"), "{error}");
        let error = plan_collaboration(Some("  "), Some(" "), None).unwrap_err();
        assert!(error.contains("model"), "{error}");
    }

    #[test]
    fn decision_collaboration_restates_mode_and_inherits_thread_settings() {
        assert_eq!(
            decision_collaboration("default", Some("thread-model"), Some("high")).unwrap(),
            json!({"mode": "default", "settings": {"model": "thread-model", "reasoning_effort": "high"}})
        );
        assert_eq!(
            decision_collaboration("plan", Some("thread-model"), None).unwrap(),
            json!({"mode": "plan", "settings": {"model": "thread-model"}})
        );
        // 线程模型未知就不能重建 settings——恢复后必须显式断言模式。
        assert!(decision_collaboration("default", None, None).is_err());
    }

    #[tokio::test]
    async fn plan_deltas_stream_as_drafts_only_in_a_plan_run() {
        let (core, _registry, emitter) = test_core();
        let mut state = TurnState::new(Some("thread-1".into()));
        let mut view = plan_view();
        for delta in ["# Dra", "ft"] {
            route(
                &core,
                &mut state,
                &mut view,
                &json!({
                    "method": "item/plan/delta",
                    "params": {"threadId": "thread-1", "turnId": "turn-1", "itemId": "item-9", "delta": delta},
                }),
            );
        }
        let events = flushed(&core, &emitter);
        assert_eq!(
            events,
            vec![
                ("plan_draft".to_string(), json!({"planId": "thread-1/plan", "text": "# Dra", "replace": false})),
                ("plan_draft".to_string(), json!({"planId": "thread-1/plan", "text": "ft", "replace": false})),
            ]
        );
        // 非计划轮:同样的 delta 一律忽略,永不进入审批主干。
        let (core, _registry, emitter) = test_core();
        let mut state = TurnState::new(Some("thread-1".into()));
        let mut view = plan_view();
        view.plan_mode = false;
        route(
            &core,
            &mut state,
            &mut view,
            &json!({
                "method": "item/plan/delta",
                "params": {"threadId": "thread-1", "turnId": "turn-1", "itemId": "item-9", "delta": "# Dra"},
            }),
        );
        assert!(flushed(&core, &emitter).is_empty());
    }

    #[tokio::test]
    async fn the_completed_plan_item_is_the_authoritative_review_content() {
        let (core, _registry, emitter) = test_core();
        let mut state = TurnState::new(Some("thread-1".into()));
        let mut view = plan_view();
        route(
            &core,
            &mut state,
            &mut view,
            &json!({
                "method": "item/plan/delta",
                "params": {"threadId": "thread-1", "turnId": "turn-1", "itemId": "item-9", "delta": "# Draft that does not match"},
            }),
        );
        route(
            &core,
            &mut state,
            &mut view,
            &json!({
                "method": "item/completed",
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "completedAtMs": 1,
                    "item": {"id": "item-9", "type": "plan", "text": "# Final plan\n- step one"},
                },
            }),
        );
        let events = flushed(&core, &emitter);
        let kinds: Vec<&str> = events.iter().map(|(kind, _)| kind.as_str()).collect();
        assert_eq!(kinds, ["plan_draft", "plan_review"]);
        let review = &events[1].1;
        // 最终 item 权威替换:正文不是 delta 拼接,而是 completed item 的全文。
        assert_eq!(review["content"], json!("# Final plan\n- step one"));
        assert_eq!(
            review["contentHash"],
            json!(plan_review::content_hash("# Final plan\n- step one"))
        );
        assert_eq!(review["complete"], json!(true));
        assert_eq!(review["reviewKind"], json!("next_turn"));
        assert_eq!(review["planId"], json!("thread-1/plan"));
        assert_eq!(review["sessionId"], json!("thread-1"));
        assert_eq!(review["nativePlanId"], json!("item-9"));
        assert_eq!(review["title"], json!("Final plan"));
        assert_eq!(review["status"], json!("awaiting_review"));
        assert_eq!(review["execPermission"], json!("auto"));
        assert_eq!(review["workspacePath"], json!("/tmp/ws"));
        assert_eq!(review["engine"], json!("codex"));
        assert_eq!(review["runId"], json!("test-run"));
    }

    #[tokio::test]
    async fn a_plan_item_outside_a_plan_run_never_becomes_a_review() {
        let (core, _registry, emitter) = test_core();
        let mut state = TurnState::new(Some("thread-1".into()));
        let mut view = plan_view();
        view.plan_mode = false;
        route(
            &core,
            &mut state,
            &mut view,
            &json!({
                "method": "item/completed",
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "completedAtMs": 1,
                    "item": {"id": "item-9", "type": "plan", "text": "# Plan"},
                },
            }),
        );
        assert!(flushed(&core, &emitter).is_empty());
    }

    #[tokio::test]
    async fn non_plan_items_and_the_task_checklist_never_trigger_a_review() {
        let (core, _registry, emitter) = test_core();
        let mut state = TurnState::new(Some("thread-1".into()));
        let mut view = plan_view();
        // turn/plan/updated:update_plan 工具的任务清单(步骤状态),不是方案正文。
        route(
            &core,
            &mut state,
            &mut view,
            &json!({
                "method": "turn/plan/updated",
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "plan": [{"step": "do a", "status": "inProgress"}],
                },
            }),
        );
        // 普通 agentMessage 完成项:走消息投影,与审批无关。
        route(
            &core,
            &mut state,
            &mut view,
            &json!({
                "method": "item/completed",
                "params": {
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "completedAtMs": 1,
                    "item": {"id": "m1", "type": "agentMessage", "text": "working on it"},
                },
            }),
        );
        let events = flushed(&core, &emitter);
        assert_eq!(events.len(), 1, "{events:?}");
        assert_eq!(events[0].0, "message");
        assert_eq!(events[0].1["text"], json!("working on it"));
    }

    #[tokio::test]
    async fn an_empty_or_idless_plan_item_is_not_a_review() {
        let (core, _registry, emitter) = test_core();
        let mut state = TurnState::new(Some("thread-1".into()));
        let mut view = plan_view();
        for item in [
            json!({"id": "item-9", "type": "plan", "text": "   "}),
            json!({"type": "plan", "text": "# Plan"}),
        ] {
            route(
                &core,
                &mut state,
                &mut view,
                &json!({
                    "method": "item/completed",
                    "params": {"threadId": "thread-1", "turnId": "turn-1", "completedAtMs": 1, "item": item},
                }),
            );
        }
        assert!(flushed(&core, &emitter).is_empty());
    }

    #[test]
    fn check_plan_item_accepts_only_the_unchanged_final_item() {
        let page = json!({"data": [
            {"id": "turn-1", "itemsView": "full", "status": "completed", "items": [
                {"id": "m1", "type": "agentMessage", "text": "done"},
                {"id": "item-9", "type": "plan", "text": "# Plan\n- a"},
            ]},
        ], "nextCursor": null});
        let hash = plan_review::content_hash("# Plan\n- a");
        assert!(check_plan_item(&page, "item-9", &hash).is_ok());
        // 正文变了:staleness,版本必须 expire。
        let error = check_plan_item(&page, "item-9", "0123456789abcdef").unwrap_err();
        assert!(error.starts_with(PLAN_STALE_PREFIX), "{error}");
        // item 没了:同上。
        let error = check_plan_item(&page, "item-404", &hash).unwrap_err();
        assert!(error.starts_with(PLAN_STALE_PREFIX), "{error}");
        // 空页找不到 item 也是 staleness。
        let error = check_plan_item(&json!({"data": []}), "item-9", &hash).unwrap_err();
        assert!(error.starts_with(PLAN_STALE_PREFIX), "{error}");
        // 畸形响应不是 staleness:普通错误,提交回退、版本保留。
        let error = check_plan_item(&json!({}), "item-9", &hash).unwrap_err();
        assert!(!error.starts_with(PLAN_STALE_PREFIX), "{error}");
    }

    #[test]
    fn plan_title_takes_the_first_atx_heading() {
        assert_eq!(plan_title("# 实施方案\n- a"), "实施方案");
        assert_eq!(plan_title("intro\n## Steps\n- a"), "Steps");
        // `#` 后不跟空白不是标题。
        assert_eq!(plan_title("#tag\nbody"), DEFAULT_PLAN_TITLE);
        assert_eq!(plan_title("no heading here"), DEFAULT_PLAN_TITLE);
        assert_eq!(plan_title(""), DEFAULT_PLAN_TITLE);
    }

    #[test]
    fn decision_spec_builds_the_turn_from_the_record() {
        let review = next_turn_review();
        let spec = decision_spec(&review, PlanDecision::Approve, None).unwrap();
        assert_eq!(spec.mode, "default");
        assert_eq!(spec.prompt, EXECUTE_PLAN_PROMPT);
        assert_eq!(spec.permission, "auto");
        assert_eq!(spec.native_plan_id, "item-9");

        let spec =
            decision_spec(&review, PlanDecision::RequestChanges, Some("  收紧范围 ")).unwrap();
        assert_eq!(spec.mode, "plan");
        assert_eq!(spec.prompt, "收紧范围");
        assert_eq!(spec.permission, "plan");
    }

    #[test]
    fn decision_spec_rejects_before_touching_the_transport() {
        let review = next_turn_review();
        // 修改必须带非空反馈(CAS 已保证,这里是传输层之前的最后一道)。
        assert!(decision_spec(&review, PlanDecision::RequestChanges, None).is_err());
        assert!(decision_spec(&review, PlanDecision::RequestChanges, Some("  ")).is_err());
        // Defer 是本地落定,从不创建 turn。
        assert!(decision_spec(&review, PlanDecision::Defer, None).is_err());
        // 非 next_turn 记录不该走到这里。
        let mut wrong_kind = next_turn_review();
        wrong_kind.review_kind = PlanReviewKind::NativeRequest;
        assert!(decision_spec(&wrong_kind, PlanDecision::Approve, None).is_err());
        // 缺原生 item id / 执行权限快照:没法核对、没法沿用,拒绝。
        let mut no_item = next_turn_review();
        no_item.native_plan_id = None;
        assert!(decision_spec(&no_item, PlanDecision::Approve, None).is_err());
        let mut no_permission = next_turn_review();
        no_permission.exec_permission = "  ".into();
        assert!(decision_spec(&no_permission, PlanDecision::Approve, None).is_err());
        // 批准携带的固定执行指令不含任何用户文本。
        let spec = decision_spec(&review, PlanDecision::Approve, Some("ignored")).unwrap();
        assert_eq!(spec.prompt, EXECUTE_PLAN_PROMPT);
    }

    #[tokio::test]
    async fn a_retryable_error_does_not_settle_the_turn() {
        let (core, _registry, emitter) = test_core();
        let (mut state, mut view) = active_test_turn();
        assert!(matches!(
            route(
                &core,
                &mut state,
                &mut view,
                &json!({
                    "method": "error",
                    "params": { "threadId":"t1", "turnId":"turn-1", "error": { "message": "upstream 502" }, "willRetry": true },
                }),
            ),
            Handled::Ignore
        ));
        let events = flushed(&core, &emitter);
        assert_eq!(events.len(), 1, "{events:?}");
        assert_eq!(events[0].0, "warn");
        assert_eq!(events[0].1, json!("upstream 502"));
        assert!(!state.saw_error, "a retry must not settle the run");
    }

    #[tokio::test]
    async fn compact_turn_adopts_turn_id_from_notifications_and_tracks_compaction_and_usage() {
        let (core, _registry, emitter) = test_core();
        let mut state = TurnState::new(Some("t1".into()));
        let mut view = TurnView {
            accepting_approvals: true,
            awaiting_compact_turn: true,
            ..TurnView::default()
        };
        assert!(matches!(
            route(
                &core,
                &mut state,
                &mut view,
                &json!({
                    "method": "turn/started",
                    "params": { "threadId": "t1", "turn": { "id": "turn-compact-1", "status": "inProgress" } },
                }),
            ),
            Handled::Ignore
        ));
        assert_eq!(view.turn_id.as_deref(), Some("turn-compact-1"));
        assert!(!view.awaiting_compact_turn);

        route(
            &core,
            &mut state,
            &mut view,
            &json!({
                "method": "item/started",
                "params": {
                    "threadId": "t1",
                    "turnId": "turn-compact-1",
                    "item": { "id": "c1", "type": "contextCompaction" },
                },
            }),
        );
        route(
            &core,
            &mut state,
            &mut view,
            &json!({
                "method": "thread/tokenUsage/updated",
                "params": {
                    "threadId": "t1",
                    "turnId": "turn-compact-1",
                    "tokenUsage": {
                        "last": { "inputTokens": 0, "outputTokens": 0, "totalTokens": 19_974 },
                        "modelContextWindow": 1_000_000,
                    },
                },
            }),
        );
        route(
            &core,
            &mut state,
            &mut view,
            &json!({
                "method": "item/completed",
                "params": {
                    "threadId": "t1",
                    "turnId": "turn-compact-1",
                    "item": { "id": "c1", "type": "contextCompaction" },
                },
            }),
        );
        let ended = route(
            &core,
            &mut state,
            &mut view,
            &json!({
                "method": "turn/completed",
                "params": { "threadId": "t1", "turn": { "id": "turn-compact-1", "status": "completed" } },
            }),
        );
        assert!(matches!(ended, Handled::Ended));
        assert_eq!(
            view.last_usage,
            Some(json!({
                "input_tokens": 0,
                "output_tokens": 0,
                "total_tokens": 19_974,
                "model_context_window": 1_000_000,
                "usage_scope": "last_request",
            }))
        );
        let events = flushed(&core, &emitter);
        assert_eq!(events.len(), 2, "{events:?}");
        assert_eq!(events[0].0, "compaction");
        assert_eq!(events[0].1["active"], json!(true));
        assert_eq!(events[1].0, "compaction");
        assert_eq!(events[1].1["active"], json!(false));
    }

    #[test]
    fn parse_compact_prompt_extracts_optional_instructions() {
        use crate::engine::parse_compact_prompt;
        assert_eq!(parse_compact_prompt("/compact"), Some(None));
        assert_eq!(parse_compact_prompt("  /compact  "), Some(None));
        assert_eq!(
            parse_compact_prompt("/compact 保留改动摘要"),
            Some(Some("保留改动摘要"))
        );
        assert_eq!(parse_compact_prompt("/compactor"), None);
        assert_eq!(parse_compact_prompt("hello /compact"), None);
    }
}
