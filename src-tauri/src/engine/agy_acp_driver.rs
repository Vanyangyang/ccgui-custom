use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufRead, AsyncWrite, AsyncWriteExt, BufReader};

use super::context::AgyAcpContext;
use super::support::{
    has_parked_questions, park_elicitation_question, pre_existing_transcript_len,
    settle_running_tasks_stopped, AgyAcpTaskTracker, OutboundFrame, OutboundRunGuard,
    AGY_BG_TASK_WAKEUP_PROMPT, BG_TASK_POLL_INTERVAL,
};
use super::{
    finish_remote_lease, read_ndjson_line, AgyAcpState, HostChatEndpoint, WorkerProfileKey,
};
use crate::engine::agy::{
    effort_flag, model_encodes_effort,
    model_has_no_effort, model_supports_independent_effort,
    read_native_context_usage, validate_resume, HOST_PLUGIN, OWNED_RULES_ROOT,
};
use crate::engine::qoder_session::{
    encode_ndjson, handle_fs_read, handle_fs_write, jsonrpc_error_response, jsonrpc_id_key,
    jsonrpc_notification, jsonrpc_request, jsonrpc_result_response, parse_acp_line,
    session_update_from_notification, AcpLine, QoderSessionUpdate, JSONRPC_INVALID_PARAMS,
    JSONRPC_METHOD_NOT_FOUND, KILL_POLL, SESSION_NEW_TIMEOUT,
    SESSION_RESUME_TIMEOUT,
};
use crate::engine::throughput_common::{
    breakdown_json, compute_breakdown, round_ms, validate_complete_gate, IntervalTracker,
    StreamTokenEstimator, TimeBreakdown, MAX_PLAUSIBLE_TPS, MAX_SAFE_INTEGER,
    MIN_LIVE_ESTIMATE_MS,
};
use crate::engine::{
    cleanup_staged_files, images, parse_compact_prompt, sidechat, tool_call_message,
    tool_result_patch, BuiltCommand, Engine, EngineEvent, LineRead, SendRequest, TurnCore,
    TurnState, VirtualRunGuard, MAX_LINE_BYTES,
};

const CONFIG_TIMEOUT: Duration = Duration::from_secs(15);
const SESSION_CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
const AGY_PROMPT_IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const CANCEL_SETTLE_TIMEOUT: Duration = Duration::from_millis(2500);
const CANCELLED_MARKER: &str = "agy acp turn cancelled";
const NATIVE_REFUSAL_ERROR: &str = "Antigravity refused this turn; no successful completion was confirmed";
const MIN_STARTUP_STRIP_MS: f64 = 20.0;
const TRANSCRIPT_TICK_POLL_INTERVAL: Duration = Duration::from_millis(100);
const MAX_TOOL_INPUT_ESTIMATE_BYTES: usize = 256 * 1024;

#[cfg(test)]
mod idle_timeout_tests {
    use super::*;
    use tokio::io::AsyncBufReadExt;

    const IDLE: Duration = Duration::from_millis(180);

    async fn scripted_call(method: &str, frame: &str, reply: bool, mut router: impl FnMut(&AcpLine) -> Option<Value>) -> (Result<Value, String>, bool) {
        let (client, server) = tokio::io::duplex(4096);
        let (read, mut write) = tokio::io::split(client);
        let mut read = BufReader::new(read);
        let mut line_buf = Vec::new();
        let mut next_id = 1;
        let mut io = AcpIo { reader: &mut read, writer: &mut write, line_buf: &mut line_buf, next_id: &mut next_id, outbound_rx: None, poisoned: false };
        let killed = AtomicBool::new(false);
        let call = io.call(method, json!({}), IDLE, &killed, None, &mut router);
        let peer = async {
            let (read, mut write) = tokio::io::split(server);
            let mut read = BufReader::new(read);
            read.read_line(&mut String::new()).await.unwrap();
            for _ in 0..6 {
                tokio::time::sleep(IDLE / 3).await;
                if write.write_all(frame.as_bytes()).await.is_err() { return; }
            }
            if reply {
                let _ = write.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"stopReason\":\"end_turn\"}}\n").await;
            } else {
                tokio::time::sleep(IDLE * 2).await;
            }
        };
        let (result, ()) = tokio::join!(call, peer);
        (result, io.poisoned)
    }

    const UPDATE: &str = "{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"update\":{\"sessionUpdate\":\"agent_thought_chunk\"}}}\n";

    #[tokio::test]
    async fn prompt_activity_outlives_a_single_idle_window() {
        let mut updates = 0;
        let (result, poisoned) = scripted_call("session/prompt", UPDATE, true, |_| { updates += 1; None }).await;
        assert_eq!(result.unwrap()["stopReason"], "end_turn");
        assert_eq!(updates, 6);
        assert!(!poisoned);
    }

    #[tokio::test]
    async fn prompt_times_out_after_activity_really_stops() {
        let (result, poisoned) = scripted_call("session/prompt", UPDATE, false, |_| None).await;
        assert!(result.unwrap_err().contains("timed out"));
        assert!(poisoned);
    }

    #[tokio::test]
    async fn prompt_noise_does_not_extend_idle_timeout() {
        let (result, poisoned) = scripted_call("session/prompt", "\ninvalid-json\n{}\n", true, |_| None).await;
        assert!(result.unwrap_err().contains("timed out"));
        assert!(poisoned);
    }

    #[tokio::test]
    async fn control_rpc_keeps_fixed_timeout_despite_activity() {
        let (result, poisoned) = scripted_call("session/new", UPDATE, true, |_| None).await;
        assert!(result.unwrap_err().contains("timed out"));
        assert!(poisoned);
    }

    #[tokio::test]
    async fn prompt_permission_wait_and_reply_backpressure_are_not_idle() {
        let (client, server) = tokio::io::duplex(128);
        let (read, mut write) = tokio::io::split(client);
        let mut read = BufReader::new(read);
        let mut line_buf = Vec::new();
        let mut next_id = 1;
        let mut io = AcpIo { reader: &mut read, writer: &mut write, line_buf: &mut line_buf, next_id: &mut next_id, outbound_rx: None, poisoned: false };
        let killed = AtomicBool::new(false);
        let call = io.call("session/prompt", json!({}), IDLE, &killed, None, |line| {
            let AcpLine::AgentRequest { id, method, .. } = line else { panic!("expected permission request") };
            assert_eq!(method, "session/request_permission");
            std::thread::sleep(IDLE * 2);
            Some(jsonrpc_result_response(id, json!({"padding": "x".repeat(1024)})))
        });
        let peer = async {
            let (read, mut write) = tokio::io::split(server);
            let mut read = BufReader::new(read);
            read.read_line(&mut String::new()).await.unwrap();
            write.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":\"permission\",\"method\":\"session/request_permission\"}\n").await.unwrap();
            // Start after the synchronous permission router has returned, then
            // force the outbound reply to remain blocked for another idle window.
            tokio::task::yield_now().await;
            tokio::time::sleep(IDLE * 2).await;
            let mut response = String::new();
            read.read_line(&mut response).await.unwrap();
            assert_eq!(serde_json::from_str::<Value>(&response).unwrap()["id"], "permission");
            write.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n").await.unwrap();
        };
        let (result, ()) = tokio::join!(call, peer);
        assert!(result.is_ok(), "{result:?}");
        assert!(!io.poisoned);
    }
}

pub(super) struct ExtractedLaunch {
    pub profile: WorkerProfileKey,
    pub host_instructions: String,
    pub host_chat: Option<HostChatEndpoint>,
    pub extra_dirs: Vec<String>,
}

struct CleanupGuard(Vec<PathBuf>);

impl Drop for CleanupGuard {
    fn drop(&mut self) {
        if !self.0.is_empty() {
            cleanup_staged_files(&self.0);
        }
    }
}

pub(crate) async fn run_acp_turn(
    core: TurnCore,
    req: SendRequest,
    bin: String,
    built: BuiltCommand,
    service: Arc<AgyAcpState>,
    killed: Arc<AtomicBool>,
    virtual_pid: u32,
) {
    let mut state = TurnState::new(req.session_id.clone());
    let preassigned_session_id = req.session_id.clone();
    let _registry_guard =
        VirtualRunGuard::new(Arc::clone(&core.registry), core.run_id.clone(), virtual_pid);
    let (_outbound_guard, mut outbound_rx) = OutboundRunGuard::register(core.run_id.clone());

    let extracted = match extract_launch(&core.run_id, &req, &bin, built) {
        Ok(spec) => spec,
        Err(err) => {
            if !killed.load(Ordering::SeqCst) {
                core.dispatch_event(&mut state, EngineEvent::Error(err));
            }
            finish_registry(&core, &state, preassigned_session_id, virtual_pid);
            return;
        }
    };

    let mut telemetry = AgyAcpTelemetry::new(Instant::now());
    let mut last_usage: Option<Value> = None;
    let mut telemetry_usage: Option<Value> = None;
    let mut context_usage = AgyAcpContext::default();

    let outcome = execute_leased_turn(
        &core,
        &mut state,
        &req,
        &extracted,
        &service,
        &killed,
        &mut outbound_rx,
        &mut telemetry,
        &mut last_usage,
        &mut telemetry_usage,
        &mut context_usage,
    )
    .await;

    let interrupted = killed.load(Ordering::SeqCst);
    let cancelled = interrupted || outcome.as_ref().is_err_and(|e| e == CANCELLED_MARKER);
    // Settle parked questions and plan reviews BEFORE terminal Error/Done so
    // `TurnState`'s saw_done/saw_error guard does not swallow cleanup events.
    let settled_session_id = state.native_session_id.clone();
    settle_parked(
        &core,
        &mut state,
        [
            settled_session_id,
            Some(core.run_id.clone()),
            preassigned_session_id.clone(),
        ],
    );
    if cancelled {
        settle_running_tasks_stopped(&core, &mut state);
    }

    match outcome {
        Ok(()) => {
            if let Some(sample) =
                telemetry.finish(interrupted, telemetry_usage.as_ref(), Instant::now())
            {
                core.dispatch_event(&mut state, EngineEvent::Throughput(sample));
            }
            if !interrupted {
                if let Some(ref usage) = last_usage {
                    core.dispatch_event(&mut state, EngineEvent::Usage(usage.clone()));
                }
            }
        }
        Err(error) => {
            if let Some(native) = context_usage.current()
                .or_else(|| read_native_context_usage(state.native_session_id.as_deref()))
            {
                core.dispatch_event(&mut state, EngineEvent::Usage(native));
            }
            if let Some(sample) = telemetry.finish(true, None, Instant::now()) {
                core.dispatch_event(&mut state, EngineEvent::Throughput(sample));
            }
            if !interrupted && error != CANCELLED_MARKER {
                core.dispatch_event(&mut state, EngineEvent::Error(error));
            }
        }
    }

    if !state.saw_done && !state.saw_error {
        let usage = if cancelled { None } else { last_usage };
        let session_id = state.native_session_id.clone();
        core.dispatch_event(&mut state, EngineEvent::Done { session_id, usage });
    }
    finish_registry(&core, &state, preassigned_session_id, virtual_pid);
}

fn settle_parked(core: &TurnCore, state: &mut TurnState, keys: [Option<String>; 3]) {
    for key in keys.into_iter().flatten() {
        for request_id in core.registry.take_questions(&key) {
            core.dispatch_event(state, EngineEvent::QuestionSettled { request_id });
        }
        crate::engine::reader::expire_parked_plans(core, state, &key);
    }
}

fn finish_registry(
    core: &TurnCore,
    state: &TurnState,
    preassigned_session_id: Option<String>,
    virtual_pid: u32,
) {
    core.registry.remove_if_pid(&core.run_id, virtual_pid);
    if let Some(session_id) = state.native_session_id.clone() {
        core.registry.remove_if_pid(&session_id, virtual_pid);
    }
    if let Some(session_id) = preassigned_session_id {
        core.registry.remove_if_pid(&session_id, virtual_pid);
    }
    core.sink.flush();
}

pub(super) fn extract_launch(
    run_id: &str,
    req: &SendRequest,
    bin: &str,
    built: BuiltCommand,
) -> Result<ExtractedLaunch, String> {
    let BuiltCommand {
        command,
        cleanup_files,
        ..
    } = built;
    let _cleanup = CleanupGuard(cleanup_files);

    let mut owned_root: Option<PathBuf> = None;
    let mut leader_child = false;
    let mut completion_owner = false;
    let mut env_pairs = Vec::new();

    for (key, val) in command.as_std().get_envs() {
        let Some(val) = val else {
            continue;
        };
        if key == OsStr::new(OWNED_RULES_ROOT) {
            if !val.is_empty() {
                let candidate = PathBuf::from(val);
                if _cleanup.0.contains(&candidate) {
                    owned_root = Some(candidate);
                }
            }
        } else if key == OsStr::new("CCGUI_LEADER_MANAGED_CHILD") {
            leader_child = val == OsStr::new("1");
        } else if key == OsStr::new("CCGUI_SPELLCAST_COMPLETION_OWNER") {
            completion_owner = val == OsStr::new("1");
        } else if key != OsStr::new("AGY_CLI_DISABLE_AUTO_UPDATE") {
            env_pairs.push((
                key.to_string_lossy().into_owned(),
                val.to_string_lossy().into_owned(),
            ));
        }
    }
    env_pairs.sort();

    let mut host_chat = None;
    let mut staged_rules = None;
    if let Some(ref root) = owned_root {
        let mcp_path = root.join(HOST_PLUGIN).join("mcp_config.json");
        if mcp_path.is_file() {
            let bytes = std::fs::read(&mcp_path)
                .map_err(|e| format!("read staged AGY mcp_config.json: {e}"))?;
            let cfg: Value = serde_json::from_slice(&bytes)
                .map_err(|e| format!("parse staged AGY mcp_config.json: {e}"))?;
            let server = &cfg["mcpServers"][crate::host_chat::MCP_SERVER_NAME];
            if server.is_object() {
                let cmd = server["command"]
                    .as_str()
                    .ok_or("staged AGY MCP server missing command")?
                    .to_string();
                let args = server["args"]
                    .as_array()
                    .map(|arr| {
                        arr.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                let url = server["env"]["CCGUI_HOST_CHAT_URL"]
                    .as_str()
                    .ok_or("staged AGY MCP server missing URL")?
                    .to_string();
                let token = server["env"]["CCGUI_HOST_CHAT_TOKEN"]
                    .as_str()
                    .ok_or("staged AGY MCP server missing token")?
                    .to_string();
                host_chat = Some(HostChatEndpoint {
                    command: cmd,
                    args,
                    url,
                    token,
                });
            }
        }
        let rules_path = root.join(HOST_PLUGIN).join("rules/AGENTS.md");
        if rules_path.is_file() {
            if let Ok(text) = std::fs::read_to_string(&rules_path) {
                if !text.is_empty() {
                    staged_rules = Some(text);
                }
            }
        }
    }

    let host_instructions = req
        .host_instructions
        .clone()
        .or(staged_rules)
        .unwrap_or_default();

    let mut seen_dirs = HashSet::new();
    let mut extra_dirs = Vec::new();
    let ws_str = req.workspace.to_string_lossy().trim().to_string();
    if !ws_str.is_empty() {
        seen_dirs.insert(ws_str);
    }
    for dir in &req.additional_dirs {
        let trimmed = dir.trim();
        if !trimmed.is_empty() && seen_dirs.insert(trimmed.to_string()) {
            extra_dirs.push(trimmed.to_string());
        }
    }
    let pasted_dir = images::pasted_images_dir();
    let uses_pasted = req
        .images
        .iter()
        .filter_map(|raw| images::absolutize_image_path(raw, &req.workspace))
        .any(|p| p.starts_with(&pasted_dir));
    if uses_pasted {
        let dir_str = pasted_dir.to_string_lossy().to_string();
        if !dir_str.is_empty() && seen_dirs.insert(dir_str.clone()) {
            extra_dirs.push(dir_str);
        }
    }

    let ws_allows_self_update =
        crate::host_chat::workspace_allows_self_update(&req.workspace.to_string_lossy());
    let normalized_workspace = dunce::canonicalize(&req.workspace)
        .unwrap_or_else(|_| req.workspace.clone())
        .to_string_lossy()
        .to_string();
    let profile = WorkerProfileKey {
        bin: bin.to_string(),
        workspace: normalized_workspace,
        has_host_chat: host_chat.is_some(),
        self_update_only: sidechat::is_side_run_id(run_id),
        allows_self_update: ws_allows_self_update,
        leader_child,
        completion_owner,
        env_pairs,
    };

    Ok(ExtractedLaunch {
        profile,
        host_instructions,
        host_chat,
        extra_dirs,
    })
}

#[allow(clippy::too_many_arguments)]
async fn execute_leased_turn(
    core: &TurnCore,
    state: &mut TurnState,
    req: &SendRequest,
    extracted: &ExtractedLaunch,
    service: &Arc<AgyAcpState>,
    killed: &AtomicBool,
    outbound_rx: &mut tokio::sync::mpsc::UnboundedReceiver<OutboundFrame>,
    telemetry: &mut AgyAcpTelemetry,
    last_usage: &mut Option<Value>,
    telemetry_usage: &mut Option<Value>,
    context_usage: &mut AgyAcpContext,
) -> Result<(), String> {
    let is_compact = parse_compact_prompt(&req.prompt).is_some();
    let requested_session = req
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if is_compact && requested_session.is_none() {
        return Err("当前会话尚未建立，无法压缩上下文".into());
    }
    if let Some(sid) = requested_session {
        validate_resume(sid, false)?;
    }
    let blocks = build_prompt_blocks(&req.prompt, &req.images, &req.workspace, is_compact)?;

    if let Some((stream, initial_buf, plugin_root, mcp_servers, _cold_ms, supports_resume)) = service
        .try_connect_remote_broker(
            &extracted.profile,
            &extracted.host_instructions,
            extracted.host_chat.as_ref(),
        )
        .await?
    {
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut line_buf = initial_buf;
        let mut next_id = 10_000u64;
        let mut io = AcpIo {
            reader: &mut reader,
            writer: &mut write_half,
            line_buf: &mut line_buf,
            next_id: &mut next_id,
            outbound_rx: Some(outbound_rx),
            poisoned: false,
        };
        let res = drive_session_turn(
            &mut io,
            core,
            state,
            req,
            &extracted.profile,
            requested_session,
            is_compact,
            &blocks,
            &extracted.extra_dirs,
            &extracted.host_instructions,
            &plugin_root,
            &mcp_servers,
            supports_resume,
            killed,
            telemetry,
            last_usage,
            telemetry_usage,
            context_usage,
        )
        .await;
        let poisoned = io.poisoned;
        if !poisoned {
            let _ = finish_remote_lease(&mut reader, &mut line_buf, &mut write_half).await;
        }
        return res;
    }

    let (mut worker, _active_guard, plugin_root, mcp_servers, _cold_ms) = service
        .checkout_local(
            &extracted.profile,
            &extracted.host_instructions,
            extracted.host_chat.as_ref(),
        )
        .await?;
    let stderr_arc = Arc::clone(&worker.stderr_buf);
    let supports_resume = worker.supports_session_resume;
    let (res, healthy) = {
        let mut io = AcpIo {
            reader: &mut worker.reader,
            writer: &mut worker.stdin,
            line_buf: &mut worker.line_buf,
            next_id: &mut worker.next_id,
            outbound_rx: Some(outbound_rx),
            poisoned: false,
        };
        let res = drive_session_turn(
            &mut io,
            core,
            state,
            req,
            &extracted.profile,
            requested_session,
            is_compact,
            &blocks,
            &extracted.extra_dirs,
            &extracted.host_instructions,
            &plugin_root,
            &mcp_servers,
            supports_resume,
            killed,
            telemetry,
            last_usage,
            telemetry_usage,
            context_usage,
        )
        .await;
        (res, !io.poisoned)
    };
    service.release_local(worker, healthy).await;
    res.map_err(|raw| {
        if super::outcome::is_public_failure_message(&raw) || raw == NATIVE_REFUSAL_ERROR {
            raw
        } else {
            enrich_error_with_stderr(raw, &stderr_arc)
        }
    })
}

async fn recv_outbound(
    rx: &mut Option<&mut tokio::sync::mpsc::UnboundedReceiver<OutboundFrame>>,
) -> OutboundFrame {
    match rx.as_deref_mut() {
        Some(rx) => match rx.recv().await {
            Some(item) => item,
            None => std::future::pending().await,
        },
        None => std::future::pending().await,
    }
}

struct AcpIo<'a, R, W> {
    reader: &'a mut R,
    writer: &'a mut W,
    line_buf: &'a mut Vec<u8>,
    next_id: &'a mut u64,
    outbound_rx: Option<&'a mut tokio::sync::mpsc::UnboundedReceiver<OutboundFrame>>,
    poisoned: bool,
}

enum InteractiveEvent<'a> {
    Tick,
    OutboundSent(Option<String>),
    Line(&'a AcpLine),
}

enum InteractiveOutcome {
    Idle,
    WaitingOnHuman,
    Reply(Value),
}

impl<'a, R, W> AcpIo<'a, R, W>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    async fn send_frame(&mut self, value: &Value) -> Result<(), String> {
        let bytes = encode_ndjson(value)?;
        if let Err(err) = self.writer.write_all(&bytes).await {
            self.poisoned = true;
            return Err(format!("failed to write AGY ACP frame: {err}"));
        }
        if let Err(err) = self.writer.flush().await {
            self.poisoned = true;
            return Err(format!("failed to flush AGY ACP frame: {err}"));
        }
        Ok(())
    }

    async fn call<F>(
        &mut self,
        method: &str,
        params: Value,
        timeout_dur: Duration,
        killed: &AtomicBool,
        cancel_session_id: Option<&str>,
        mut router: F,
    ) -> Result<Value, String>
    where
        F: FnMut(&AcpLine) -> Option<Value>,
    {
        self.call_interactive(
            method,
            params,
            timeout_dur,
            killed,
            cancel_session_id,
            |ev| match ev {
                InteractiveEvent::Line(line) => match router(line) {
                    Some(reply) => InteractiveOutcome::Reply(reply),
                    None => InteractiveOutcome::Idle,
                },
                _ => InteractiveOutcome::Idle,
            },
        )
        .await
    }

    async fn call_interactive<F>(
        &mut self,
        method: &str,
        params: Value,
        timeout_dur: Duration,
        killed: &AtomicBool,
        cancel_session_id: Option<&str>,
        mut handler: F,
    ) -> Result<Value, String>
    where
        F: FnMut(InteractiveEvent<'_>) -> InteractiveOutcome,
    {
        let id = *self.next_id;
        *self.next_id += 1;
        let expected_key = id.to_string();
        self.send_frame(&jsonrpc_request(id, method, params)).await?;

        // Control RPCs keep their fixed deadlines. Prompt execution may run for
        // hours as long as ACP frames keep arriving; human approval/question is not idle.
        let idle_timeout = method == "session/prompt";
        let mut deadline = Instant::now() + timeout_dur;
        let mut cancel_sent_at: Option<Instant> = None;

        enum LoopStep {
            Line(Result<LineRead, std::io::Error>),
            Outbound(OutboundFrame),
            Tick,
        }

        loop {
            if killed.load(Ordering::SeqCst) {
                match (cancel_sent_at, cancel_session_id) {
                    (None, Some(sid)) => {
                        let _ = self
                            .send_frame(&jsonrpc_notification(
                                "session/cancel",
                                json!({
                                    "sessionId": sid,
                                    "killBackgroundTasks": true,
                                }),
                            ))
                            .await;
                        cancel_sent_at = Some(Instant::now());
                    }
                    (None, None) => {
                        self.poisoned = true;
                        return Err(CANCELLED_MARKER.to_string());
                    }
                    (Some(sent), _) if sent.elapsed() > CANCEL_SETTLE_TIMEOUT => {
                        self.poisoned = true;
                        return Err(CANCELLED_MARKER.to_string());
                    }
                    (Some(_), _) => {}
                }
            }

            if idle_timeout
                && matches!(
                    handler(InteractiveEvent::Tick),
                    InteractiveOutcome::WaitingOnHuman
                )
            {
                deadline = Instant::now() + timeout_dur;
            }

            let rem = deadline.saturating_duration_since(Instant::now());
            if rem.is_zero() {
                self.poisoned = true;
                return Err(format!("AGY ACP `{method}` timed out"));
            }
            let wait = rem.min(KILL_POLL);
            let step = tokio::select! {
                res = read_ndjson_line(self.reader, self.line_buf) => LoopStep::Line(res),
                item = recv_outbound(&mut self.outbound_rx) => LoopStep::Outbound(item),
                _ = tokio::time::sleep(wait) => LoopStep::Tick,
            };

            let bytes = match step {
                LoopStep::Outbound((frame, ack)) => {
                    let send_res = self.send_frame(&frame).await;
                    let write_err = send_res.as_ref().err().cloned();
                    let _ = ack.send(send_res);
                    if let Some(err) = write_err {
                        return Err(err);
                    }
                    if idle_timeout {
                        deadline = Instant::now() + timeout_dur;
                    }
                    let rpc_id = frame.get("id").and_then(jsonrpc_id_key);
                    let _ = handler(InteractiveEvent::OutboundSent(rpc_id));
                    continue;
                }
                LoopStep::Tick => continue,
                LoopStep::Line(Ok(LineRead::Line(b))) => b,
                LoopStep::Line(Ok(LineRead::Eof)) => {
                    self.poisoned = true;
                    return Err(format!("AGY ACP `{method}` ended: daemon closed stdout"));
                }
                LoopStep::Line(Ok(LineRead::TooLong)) => {
                    self.poisoned = true;
                    return Err(format!(
                        "AGY ACP `{method}` emitted a frame over {} MiB",
                        MAX_LINE_BYTES / (1024 * 1024)
                    ));
                }
                LoopStep::Line(Err(err)) => {
                    self.poisoned = true;
                    return Err(format!("AGY ACP `{method}` read error: {err}"));
                }
            };

            let text = String::from_utf8_lossy(&bytes);
            let trimmed = text.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            let parsed = parse_acp_line(&value);
            let activity = !matches!(parsed, AcpLine::Other);
            if idle_timeout && activity {
                deadline = Instant::now() + timeout_dur;
            }
            match parsed {
                AcpLine::Response {
                    id: resp_id,
                    result,
                    error,
                } => {
                    if jsonrpc_id_key(&resp_id).as_deref() != Some(expected_key.as_str()) {
                        continue;
                    }
                    if let Some(err) = error {
                        return Err(format!("rpc:{}:{method}: {}", err.code, err.message));
                    }
                    return Ok(result.unwrap_or(Value::Null));
                }
                other => {
                    if let InteractiveOutcome::Reply(reply) =
                        handler(InteractiveEvent::Line(&other))
                    {
                        self.send_frame(&reply).await?;
                    }
                    // The router can block on permission approval, and writing
                    // its reply can itself wait on the peer. Start fresh after both.
                    if idle_timeout && activity {
                        deadline = Instant::now() + timeout_dur;
                    }
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn wait_for_background_wakeup<R, W>(
    io: &mut AcpIo<'_, R, W>,
    core: &TurnCore,
    state: &mut TurnState,
    session_id: &str,
    workspace: &Path,
    permission: &str,
    tool_names: &mut HashMap<String, String>,
    telemetry: &mut AgyAcpTelemetry,
    context_usage: &mut AgyAcpContext,
    tracker: &mut AgyAcpTaskTracker,
    killed: &AtomicBool,
) -> Result<bool, String>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    enum WaitStep {
        Line(Result<LineRead, std::io::Error>),
        Outbound(OutboundFrame),
        Tick,
    }

    loop {
        if killed.load(Ordering::SeqCst) {
            let _ = io
                .send_frame(&jsonrpc_notification(
                    "session/cancel",
                    json!({
                        "sessionId": session_id,
                        "killBackgroundTasks": true,
                    }),
                ))
                .await;
            tracker.mark_running_stopped(core, state);
            return Err(CANCELLED_MARKER.to_string());
        }

        let _ = tracker.poll(core, state);
        if tracker.ready_to_wake(Instant::now()) {
            return Ok(true);
        }
        if !tracker.has_running_non_ambient() && !tracker.has_pending_wakeup() {
            return Ok(false);
        }

        let step = tokio::select! {
            res = read_ndjson_line(io.reader, io.line_buf) => WaitStep::Line(res),
            item = recv_outbound(&mut io.outbound_rx) => WaitStep::Outbound(item),
            _ = tokio::time::sleep(BG_TASK_POLL_INTERVAL) => WaitStep::Tick,
        };

        match step {
            WaitStep::Tick => continue,
            WaitStep::Outbound((frame, ack)) => {
                let send_res = io.send_frame(&frame).await;
                let write_err = send_res.as_ref().err().cloned();
                let _ = ack.send(send_res);
                if let Some(err) = write_err {
                    return Err(err);
                }
            }
            WaitStep::Line(Ok(LineRead::Line(bytes))) => {
                let text = String::from_utf8_lossy(&bytes);
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
                let parsed = parse_acp_line(&value);
                if let Some(reply) = handle_prompt_line(
                    &parsed,
                    core,
                    state,
                    workspace,
                    permission,
                    tool_names,
                    telemetry,
                    context_usage,
                    Some(tracker),
                ) {
                    io.send_frame(&reply).await?;
                }
            }
            WaitStep::Line(Ok(LineRead::Eof)) => {
                io.poisoned = true;
                return Err(
                    "AGY ACP session ended while waiting for background tasks: daemon closed stdout"
                        .to_string(),
                );
            }
            WaitStep::Line(Ok(LineRead::TooLong)) => {
                io.poisoned = true;
                return Err(format!(
                    "AGY ACP emitted a frame over {} MiB",
                    MAX_LINE_BYTES / (1024 * 1024)
                ));
            }
            WaitStep::Line(Err(err)) => {
                io.poisoned = true;
                return Err(format!(
                    "AGY ACP read error while waiting for background tasks: {err}"
                ));
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn drive_session_turn<R, W>(
    io: &mut AcpIo<'_, R, W>,
    core: &TurnCore,
    state: &mut TurnState,
    req: &SendRequest,
    profile: &WorkerProfileKey,
    requested_session: Option<&str>,
    is_compact: bool,
    blocks: &[Value],
    extra_dirs: &[String],
    host_instructions: &str,
    plugin_root: &str,
    mcp_servers: &[Value],
    supports_resume: bool,
    killed: &AtomicBool,
    telemetry: &mut AgyAcpTelemetry,
    last_usage: &mut Option<Value>,
    telemetry_usage: &mut Option<Value>,
    context_usage: &mut AgyAcpContext,
) -> Result<(), String>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut additional_dirs = Vec::with_capacity(extra_dirs.len() + 1);
    if (!host_instructions.is_empty() || !mcp_servers.is_empty()) && !plugin_root.is_empty() {
        additional_dirs.push(plugin_root.to_string());
    }
    for d in extra_dirs {
        if !additional_dirs.contains(d) {
            additional_dirs.push(d.clone());
        }
    }

    let cwd = req.workspace.to_string_lossy().to_string();
    let permission = crate::engine::agy::AgyEngine::new()
        .resolve_permission(req.permission.as_deref())
        .to_string();

    // Snapshot transcript length before `session/load` so resumed turns never
    // mistake historical background tasks for newly spawned ones.
    let pre_turn_offset = pre_existing_transcript_len(profile, requested_session);
    let mut attached_result: Option<Value> = None;
    if let Some(sid) = requested_session {
        // Resume avoids history replay while preserving the per-turn close and
        // fresh lease rules/MCP binding. Legacy agents still use load.
        let params = json!({
            "sessionId": sid, "cwd": cwd,
            "additionalDirectories": additional_dirs, "mcpServers": mcp_servers,
        });
        let method = if supports_resume { "session/resume" } else { "session/load" };
        let mut load_res = io
            .call(
                method,
                params.clone(),
                SESSION_RESUME_TIMEOUT,
                killed,
                None,
                |line| { context_usage.observe(line); None },
            )
            .await;
        if supports_resume && !io.poisoned && !killed.load(Ordering::SeqCst)
            && load_res.as_ref().is_err_and(|err| err.starts_with("rpc:-32601:session/resume: "))
        {
            load_res = io.call("session/load", params, SESSION_RESUME_TIMEOUT, killed, None,
                |line| { context_usage.observe(line); None }).await;
        }
        match load_res {
            Ok(res) => attached_result = Some(res),
            Err(err) => {
                // Do not silently replace a requested conversation or return a
                // partially attached agent to the pool after a failed restore.
                io.poisoned = true;
                return Err(err);
            }
        }
    }

    let initial_transcript_offset = if attached_result.is_some() {
        pre_turn_offset
    } else {
        Some(0)
    };

    let session_handshake = match attached_result {
        Some(res) => res,
        None => {
            io.call(
                "session/new",
                json!({
                    "cwd": cwd,
                    "additionalDirectories": additional_dirs,
                    "mcpServers": mcp_servers,
                }),
                SESSION_NEW_TIMEOUT,
                killed,
                None,
                |line| { context_usage.observe(line); None },
            )
            .await?
        }
    };

    let session_id = extract_session_id(&session_handshake)
        .or_else(|| requested_session.map(str::to_string))
        .ok_or_else(|| "AGY ACP session handshake returned no sessionId".to_string())?;
    if !sidechat::is_side_run_id(&core.run_id) && !cwd.trim().is_empty() {
        if let Some(db) = &core.db {
            let _ = db.remember_agy_session_workspace(&session_id, &cwd);
        }
    }
    core.dispatch_event(state, EngineEvent::SessionId(session_id.clone()));
    if let Some(usage) = context_usage.bind(&session_id) {
        core.dispatch_event(state, EngineEvent::Usage(usage));
    }

    let turn_res = configure_and_prompt(
        io,
        core,
        state,
        req,
        profile,
        &session_id,
        initial_transcript_offset,
        &session_handshake,
        &permission,
        is_compact,
        blocks,
        killed,
        telemetry,
        last_usage,
        telemetry_usage,
        context_usage,
    )
    .await;

    // Always close the session cleanly before terminal dispatch so SQLite WAL/file
    // locks on `<sid>.db` release before post-turn context reads or `/btw` cleanup.
    if !io.poisoned {
        let never_kill = AtomicBool::new(false);
        if io
            .call(
                "session/close",
                json!({ "sessionId": session_id }),
                SESSION_CLOSE_TIMEOUT,
                &never_kill,
                None,
                |line| { context_usage.dispatch(line, core, state); None },
            )
            .await.is_err()
        {
            // An RPC rejection is as uncertain as a timeout: this worker must
            // not reuse a session that failed to close under a new lease.
            io.poisoned = true;
        }
    }

    *last_usage = context_usage.enrich(last_usage.take(), &session_id);

    turn_res
}

#[allow(clippy::too_many_arguments)]
async fn configure_and_prompt<R, W>(
    io: &mut AcpIo<'_, R, W>,
    core: &TurnCore,
    state: &mut TurnState,
    req: &SendRequest,
    profile: &WorkerProfileKey,
    session_id: &str,
    initial_transcript_offset: Option<u64>,
    handshake: &Value,
    permission: &str,
    is_compact: bool,
    blocks: &[Value],
    killed: &AtomicBool,
    telemetry: &mut AgyAcpTelemetry,
    last_usage: &mut Option<Value>,
    telemetry_usage: &mut Option<Value>,
    context_usage: &mut AgyAcpContext,
) -> Result<(), String>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut snapshot = parse_config_snapshot(handshake);
    let target_mode = match permission {
        "plan" => "plan",
        _ => "accept-edits",
    };
    if snapshot.current_mode.as_deref() != Some(target_mode) {
        if !snapshot.mode_values.is_empty() && !snapshot.mode_values.contains(target_mode) {
            return Err(format!("AGY ACP does not offer the requested mode: {target_mode}"));
        }
        set_session_config(io, session_id, "mode", target_mode, &mut snapshot, killed,
            |line| context_usage.dispatch(line, core, state)).await?;
        if snapshot.current_mode.as_deref() != Some(target_mode) {
            return Err("AGY ACP did not confirm the requested mode; prompt was not sent".into());
        }
    }

    let (target_model, mut target_thought) =
        split_agy_model_and_effort(req.model.as_deref(), req.effort.as_deref(), &snapshot);

    if let Some(ref model_val) = target_model {
        if snapshot.current_model.as_deref() != Some(model_val.as_str()) {
            set_session_config(io, session_id, "model", model_val, &mut snapshot, killed,
                |line| context_usage.dispatch(line, core, state)).await?;
            if snapshot.current_model.as_deref() != Some(model_val.as_str()) {
                return Err("AGY ACP did not confirm the requested model; prompt was not sent".into());
            }
        }
    }

    // A model change can advertise new thinking levels (e.g. Carbon ->
    // Hydrogen adds xhigh) or omit `thought_level` altogether. Resolve
    // independent effort against that final capability set; an effort encoded
    // in the model ID remains authoritative.
    if !req.model.as_deref().is_some_and(|model| model_encodes_effort(model) || model_has_no_effort(model)) {
        target_thought = if snapshot.has_full_config_options && !snapshot.has_thought_option {
            None
        } else {
            req.effort.as_deref().map(str::trim).filter(|s| !s.is_empty())
                .map(|raw| normalize_thought_level(raw, &snapshot))
        };
    }

    if let Some(ref thought_val) = target_thought {
        if snapshot.has_full_config_options && !snapshot.has_thought_option {
            return Err(format!("AGY ACP does not offer the requested thinking level: {thought_val}"));
        }
        if snapshot.current_thought.as_deref() != Some(thought_val.as_str()) {
            if !snapshot.thought_values.is_empty() && !snapshot.thought_values.contains(thought_val.as_str()) {
                return Err(format!("AGY ACP does not offer the requested thinking level: {thought_val}"));
            }
            set_session_config(io, session_id, "thought_level", thought_val, &mut snapshot, killed,
                |line| context_usage.dispatch(line, core, state)).await?;
            if snapshot.current_thought.as_deref() != Some(thought_val.as_str()) {
                return Err("AGY ACP did not confirm the requested thinking level; prompt was not sent".into());
            }
        }
    }

    // A later config operation can reset an earlier option. Check the final
    // combined state rather than trusting three individually successful writes.
    if snapshot.current_mode.as_deref() != Some(target_mode)
        || target_model.as_deref().is_some_and(|value| snapshot.current_model.as_deref() != Some(value))
        || target_thought.as_deref().is_some_and(|value| snapshot.current_thought.as_deref() != Some(value))
    {
        return Err("AGY ACP configuration changed before prompt submission; prompt was not sent".into());
    }

    if let Some(display_model) = effective_display_model(&snapshot, target_model.as_deref()) {
        if !snapshot.has_full_config_options || snapshot.has_thought_option {
            if let Some(eff) = effort_flag(req.effort.as_deref(), &display_model) {
                core.dispatch_event(state, EngineEvent::Effort(eff.to_string()));
            }
        }
        core.dispatch_event(state, EngineEvent::Model(display_model));
    }

    if is_compact {
        core.dispatch_event(
            state,
            EngineEvent::Compaction {
                active: true,
                reason: Some("manual".to_string()),
            },
        );
    }

    let mut tool_names: HashMap<String, String> = HashMap::new();
    let workspace = req.workspace.clone();
    let prompt_offset = pre_existing_transcript_len(profile, Some(session_id))
        .into_iter()
        .chain(initial_transcript_offset)
        .max();
    let mut tracker = AgyAcpTaskTracker::new(profile, session_id, prompt_offset);
    let mut emitted_turn_complete = false;
    let mut current_blocks: Vec<Value> = blocks.to_vec();
    telemetry.mark_prompt_sent(Instant::now());

    loop {
        // The native agent can return end_turn after an upstream failure. Only
        // inspect new steps for this prompt, and release the read connection
        // before session/close and lease cleanup.
        let outcome_watch = super::support::resolve_session_db_path(profile, session_id)
            .and_then(|path| super::outcome::checkpoint(&path));
        let prompt_res = io
            .call_interactive(
                "session/prompt",
                json!({
                    "sessionId": session_id,
                    "prompt": current_blocks,
                }),
                AGY_PROMPT_IDLE_TIMEOUT,
                killed,
                Some(session_id),
                |ev| match ev {
                    InteractiveEvent::Tick => {
                        let now = Instant::now();
                        let committed =
                            tracker.poll_throttled(core, state, now, TRANSCRIPT_TICK_POLL_INTERVAL);
                        if let Some(sample) = telemetry.on_authoritative_steps(&committed, now) {
                            core.dispatch_event(state, EngineEvent::Throughput(sample));
                        }
                        if has_parked_questions(core, state) {
                            InteractiveOutcome::WaitingOnHuman
                        } else {
                            InteractiveOutcome::Idle
                        }
                    }
                    InteractiveEvent::OutboundSent(rpc_id) => {
                        let all_settled = !has_parked_questions(core, state);
                        telemetry.on_question_wait_end(
                            rpc_id.as_deref(),
                            all_settled,
                            Instant::now(),
                        );
                        core.dispatch_event(state, EngineEvent::Activity("running"));
                        InteractiveOutcome::Idle
                    }
                    InteractiveEvent::Line(line) => match handle_prompt_line(
                        line,
                        core,
                        state,
                        &workspace,
                        permission,
                        &mut tool_names,
                        telemetry,
                        context_usage,
                        Some(&mut tracker),
                    ) {
                        Some(reply) => InteractiveOutcome::Reply(reply),
                        None => InteractiveOutcome::Idle,
                    },
                },
            )
            .await;
        let native_failure = outcome_watch.as_ref().and_then(super::outcome::PromptOutcomeWatch::failure);
        drop(outcome_watch);

        if is_compact {
            core.dispatch_event(
                state,
                EngineEvent::Compaction {
                    active: false,
                    reason: None,
                },
            );
        }

        let result = prompt_res?;
        let prompt_done_at = Instant::now();
        telemetry.mark_prompt_finished(prompt_done_at);
        let committed = tracker.poll(core, state);
        let _ = telemetry.on_authoritative_steps(&committed, prompt_done_at);
        let stop_reason = result
            .get("stopReason")
            .and_then(Value::as_str)
            .unwrap_or("");
        if stop_reason == "cancelled" {
            tracker.mark_running_stopped(core, state);
            return Err(CANCELLED_MARKER.to_string());
        }
        if let Some(failure) = native_failure {
            return Err(failure.to_string());
        }
        if stop_reason == "refusal" {
            return Err(NATIVE_REFUSAL_ERROR.into());
        }

        let step_usage = normalize_acp_prompt_usage(&result);
        let needs_bg_wait = !is_compact
            && (tracker.has_running_non_ambient() || tracker.has_pending_wakeup());

        if needs_bg_wait {
            emitted_turn_complete = true;
            *last_usage = None;
            *telemetry_usage = None;
            if let Some(sample) = telemetry.finish(false, step_usage.as_ref(), prompt_done_at) {
                core.dispatch_event(state, EngineEvent::Throughput(sample));
            }
            let enriched = context_usage.enrich(step_usage, session_id);
            core.dispatch_event(
                state,
                EngineEvent::TurnComplete {
                    usage: enriched,
                    interrupted: false,
                },
            );
            core.dispatch_event(state, EngineEvent::Activity("waiting"));

            let should_wake = wait_for_background_wakeup(
                io,
                core,
                state,
                session_id,
                &workspace,
                permission,
                &mut tool_names,
                telemetry,
                context_usage,
                &mut tracker,
                killed,
            )
            .await?;

            if should_wake {
                tracker.consume_wakeup();
                telemetry.begin_continuation(Instant::now());
                core.dispatch_event(state, EngineEvent::Activity("running"));
                current_blocks = vec![json!({ "type": "text", "text": AGY_BG_TASK_WAKEUP_PROMPT })];
                continue;
            }
            break;
        }

        if emitted_turn_complete {
            *last_usage = None;
            *telemetry_usage = None;
            if let Some(sample) = telemetry.finish(false, step_usage.as_ref(), prompt_done_at) {
                core.dispatch_event(state, EngineEvent::Throughput(sample));
            }
            let enriched = context_usage.enrich(step_usage, session_id);
            core.dispatch_event(
                state,
                EngineEvent::TurnComplete {
                    usage: enriched,
                    interrupted: false,
                },
            );
        } else {
            *last_usage = step_usage;
            *telemetry_usage = last_usage.clone();
        }
        break;
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn handle_prompt_line(
    line: &AcpLine,
    core: &TurnCore,
    state: &mut TurnState,
    workspace: &Path,
    permission: &str,
    tool_names: &mut HashMap<String, String>,
    telemetry: &mut AgyAcpTelemetry,
    context_usage: &mut AgyAcpContext,
    mut tracker: Option<&mut AgyAcpTaskTracker>,
) -> Option<Value> {
    match line {
        AcpLine::Notification { method, params } if method == "session/update" => {
            context_usage.dispatch(line, core, state);
            if let Some(t) = tracker.as_deref_mut() {
                t.observe_session_update(params.get("update").unwrap_or(params));
            }
            let now = Instant::now();
            match session_update_from_notification(params) {
                QoderSessionUpdate::AgentThoughtChunk { text } => {
                    telemetry.on_model_delta(&text, now);
                    core.dispatch_event(state, EngineEvent::Thinking(text));
                    if let Some(sample) = telemetry.live_sample(now) {
                        core.dispatch_event(state, EngineEvent::Throughput(sample));
                    }
                }
                QoderSessionUpdate::AgentMessageChunk { text } => {
                    if let Some((attempt, message)) = parse_agy_retry_chunk(&text) {
                        telemetry.on_retry_wait_start(now);
                        core.dispatch_event(
                            state,
                            EngineEvent::Retry {
                                attempt,
                                max: 0,
                                message,
                            },
                        );
                    } else {
                        telemetry.on_model_delta(&text, now);
                        core.dispatch_event(state, EngineEvent::Delta(text));
                        if let Some(sample) = telemetry.live_sample(now) {
                            core.dispatch_event(state, EngineEvent::Throughput(sample));
                        }
                    }
                }
                QoderSessionUpdate::ToolStarted {
                    tool_id,
                    tool_name,
                    input,
                } => {
                    if let Some(t) = tracker.as_deref_mut() {
                        let committed = t.poll(core, state);
                        if let Some(sample) = telemetry.on_authoritative_steps(&committed, now) {
                            core.dispatch_event(state, EngineEvent::Throughput(sample));
                        }
                        t.on_tool_started(&tool_id, &tool_name, input.as_ref());
                    }
                    telemetry.on_tool_start(&tool_id, &tool_name, input.as_ref(), now);
                    tool_names.insert(tool_id, tool_name.clone());
                    core.dispatch_event(state, tool_call_message(tool_name, input.as_ref()));
                }
                QoderSessionUpdate::ToolCompleted {
                    tool_id,
                    tool_name,
                    output,
                    error,
                } => {
                    telemetry.on_tool_end(&tool_id, now);
                    let name = tool_name
                        .or_else(|| tool_names.get(&tool_id).cloned())
                        .unwrap_or_else(|| "tool".to_string());
                    let is_err = error.is_some();
                    let result = match (output, error) {
                        (Some(out), _) => out,
                        (None, Some(err)) => json!({ "error": err, "isError": true }),
                        (None, None) => Value::Null,
                    };
                    core.dispatch_event(state, tool_result_patch(name, Some(&result)));
                    if let Some(t) = tracker.as_deref_mut() {
                        t.on_tool_completed(core, state, &tool_id, Some(&result), is_err);
                        let committed = t.poll(core, state);
                        if let Some(sample) = telemetry.on_authoritative_steps(&committed, now) {
                            core.dispatch_event(state, EngineEvent::Throughput(sample));
                        }
                    }
                }
                QoderSessionUpdate::Ignore => {}
            }
            None
        }
        AcpLine::AgentRequest { id, method, params } => {
            if method == "elicitation/create" {
                let reply = park_elicitation_question(core, state, id, params);
                if reply.is_none() {
                    let req_id = jsonrpc_id_key(id).unwrap_or_else(|| id.to_string());
                    telemetry.on_question_wait_start(&req_id, Instant::now());
                }
                reply
            } else {
                Some(answer_agy_agent_request(
                    core, state, workspace, permission, id, method, params,
                ))
            }
        }
        _ => None,
    }
}

fn answer_agy_agent_request(
    core: &TurnCore,
    state: &mut TurnState,
    workspace: &Path,
    permission: &str,
    id: &Value,
    method: &str,
    params: &Value,
) -> Value {
    match method {
        "session/request_permission" => {
            if permission == "bypass" {
                if let Some(option_id) = select_permission_option(params, true) {
                    return jsonrpc_result_response(
                        id,
                        json!({
                            "outcome": { "outcome": "selected", "optionId": option_id }
                        }),
                    );
                }
            }
            let tool = params
                .get("toolCall")
                .and_then(|tc| tc.get("title").or_else(|| tc.get("name")))
                .and_then(Value::as_str)
                .map(str::to_string);
            let label = tool.clone().unwrap_or_else(|| "tool".to_string());
            core.dispatch_event(
                state,
                EngineEvent::PermissionDenied {
                    tool,
                    path: None,
                    message: format!("agy denied action in {permission} mode: {label}"),
                },
            );
            if let Some(reject_id) = select_permission_option(params, false) {
                jsonrpc_result_response(
                    id,
                    json!({
                        "outcome": { "outcome": "selected", "optionId": reject_id }
                    }),
                )
            } else {
                jsonrpc_result_response(id, json!({ "outcome": { "outcome": "cancelled" } }))
            }
        }
        "fs/read_text_file" => match handle_fs_read(workspace, params) {
            Ok(res) => jsonrpc_result_response(id, res),
            Err(msg) => jsonrpc_error_response(id, JSONRPC_INVALID_PARAMS, &msg),
        },
        "fs/write_text_file" => {
            if permission == "plan" {
                return jsonrpc_error_response(
                    id,
                    JSONRPC_INVALID_PARAMS,
                    "File writes are disabled in plan mode",
                );
            }
            match handle_fs_write(workspace, params) {
                Ok(res) => jsonrpc_result_response(id, res),
                Err(msg) => jsonrpc_error_response(id, JSONRPC_INVALID_PARAMS, &msg),
            }
        }
        _ => jsonrpc_error_response(id, JSONRPC_METHOD_NOT_FOUND, "Method not found"),
    }
}

fn select_permission_option(params: &Value, allow: bool) -> Option<String> {
    let options = params.get("options")?.as_array()?;
    let id_of = |opt: &Value| {
        opt.get("optionId")
            .or_else(|| opt.get("option_id"))
            .or_else(|| opt.get("id"))
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let kind_of = |opt: &Value| {
        opt.get("kind")
            .or_else(|| opt.get("optionId"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase()
    };
    if allow {
        // Prefer per-call `allow_once` over `allow_always` so headless bypass
        // never mutates persistent user approval files on disk.
        options
            .iter()
            .find(|opt| kind_of(opt).contains("allow_once"))
            .or_else(|| options.iter().find(|opt| kind_of(opt).starts_with("allow")))
            .and_then(id_of)
    } else {
        options
            .iter()
            .find(|opt| kind_of(opt).contains("reject_once"))
            .or_else(|| options.iter().find(|opt| kind_of(opt).starts_with("reject")))
            .and_then(id_of)
    }
}

pub(super) fn build_prompt_blocks(
    prompt: &str,
    image_paths: &[String],
    workspace: &Path,
    is_compact: bool,
) -> Result<Vec<Value>, String> {
    if is_compact {
        return Ok(vec![json!({ "type": "text", "text": "/compact" })]);
    }
    let mut blocks = vec![json!({ "type": "text", "text": prompt })];
    for raw in image_paths {
        let (mime, b64) = images::load_image(raw, workspace)?;
        blocks.push(json!({
            "type": "image",
            "mimeType": mime,
            "data": b64,
        }));
    }
    Ok(blocks)
}

#[derive(Default, Debug, Clone)]
pub(super) struct ConfigSnapshot {
    pub has_full_config_options: bool,
    pub current_mode: Option<String>,
    pub mode_values: HashSet<String>,
    pub current_model: Option<String>,
    pub model_values: HashSet<String>,
    pub current_thought: Option<String>,
    pub has_thought_option: bool,
    pub thought_values: HashSet<String>,
}

async fn set_session_config<R, W>(
    io: &mut AcpIo<'_, R, W>,
    session_id: &str,
    option: &str,
    value: &str,
    snapshot: &mut ConfigSnapshot,
    killed: &AtomicBool,
    mut on_update: impl FnMut(&AcpLine),
) -> Result<(), String>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut updates = Vec::new();
    let mut overflow = false;
    let result = io.call(
        "session/set_config_option",
        json!({"sessionId":session_id,"configId":option,"value":value}),
        CONFIG_TIMEOUT, killed, None,
        |line| {
            on_update(line);
            if let AcpLine::Notification { method, params } = line {
                if method == "session/update" && params.get("sessionId").and_then(Value::as_str) == Some(session_id) {
                    let update = params.get("update").unwrap_or(params);
                    let normalized = match update.get("sessionUpdate").and_then(Value::as_str) {
                        Some("config_option_update") => Some(update.clone()),
                        Some("current_mode_update") => Some(json!({"modes":{"currentModeId":update.get("currentModeId")}})),
                        _ => None,
                    };
                    if let Some(update) = normalized {
                        if updates.len() < 32 { updates.push(update); } else { overflow = true; }
                    }
                }
            }
            None
        },
    ).await?;
    if overflow { return Err("AGY ACP sent too many configuration updates; prompt was not sent".into()); }
    // Fold notifications received before the RPC reply first, then the RPC
    // reply itself, preserving wire arrival order so trailing updates from an
    // earlier `set_config_option` cannot overwrite a later reply.
    for update in updates { snapshot.merge_from(&update); }
    snapshot.merge_from(&result);
    Ok(())
}

impl ConfigSnapshot {
    pub(super) fn merge_from(&mut self, value: &Value) {
        let next = parse_config_snapshot(value);
        if next.has_full_config_options {
            self.has_full_config_options = true;
        }
        let has_option = |name: &str| value.get("configOptions").and_then(Value::as_array)
            .is_some_and(|options| options.iter().any(|option|
                option.get("id").or_else(|| option.get("configId")).and_then(Value::as_str) == Some(name)));
        // Some agents reply with only the changed option. Do not erase the
        // other confirmed values and trigger needless configuration RPCs, while
        // still clearing stale thinking state when a full snapshot omits it.
        if has_option("mode") || value.get("modes").is_some() {
            self.current_mode = next.current_mode;
            if has_option("mode") {
                self.mode_values = next.mode_values;
            }
        }
        if has_option("model") || value.get("models").is_some() {
            self.current_model = next.current_model;
            if has_option("model") {
                self.model_values = next.model_values;
            }
        }
        if has_option("thought_level") {
            self.current_thought = next.current_thought;
            self.thought_values = next.thought_values;
            self.has_thought_option = next.has_thought_option;
        } else if next.has_full_config_options {
            self.current_thought = None;
            self.thought_values.clear();
            self.has_thought_option = false;
        }
    }
}

pub(super) fn parse_config_snapshot(value: &Value) -> ConfigSnapshot {
    let mut snap = ConfigSnapshot::default();
    if let Some(mode) = value
        .get("modes")
        .and_then(|m| m.get("currentModeId"))
        .and_then(Value::as_str)
    {
        snap.current_mode = Some(mode.to_string());
    }
    if let Some(model) = value
        .get("models")
        .and_then(|m| m.get("currentModelId"))
        .and_then(Value::as_str)
    {
        snap.current_model = Some(model.to_string());
    }
    let Some(options) = value.get("configOptions").and_then(Value::as_array) else {
        return snap;
    };
    let mut saw_mode_option = false;
    let mut saw_model_option = false;
    for opt in options {
        let id = opt
            .get("id")
            .or_else(|| opt.get("configId"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let current = opt
            .get("currentValue")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let mut values = HashSet::new();
        if let Some(arr) = opt.get("options").and_then(Value::as_array) {
            collect_option_values(arr, &mut values);
        }
        match id {
            "mode" => {
                saw_mode_option = true;
                if current.is_some() {
                    snap.current_mode = current;
                }
                snap.mode_values = values;
            }
            "model" => {
                saw_model_option = true;
                if current.is_some() {
                    snap.current_model = current;
                }
                snap.model_values = values;
            }
            "thought_level" => {
                snap.has_thought_option = true;
                snap.current_thought = current;
                snap.thought_values = values;
            }
            _ => {}
        }
    }
    snap.has_full_config_options = saw_mode_option && saw_model_option;
    snap
}

fn collect_option_values(entries: &[Value], out: &mut HashSet<String>) {
    for entry in entries {
        if let Some(val) = entry.get("value").and_then(Value::as_str) {
            if !val.trim().is_empty() {
                out.insert(val.trim().to_string());
            }
        }
        if let Some(nested) = entry.get("options").and_then(Value::as_array) {
            collect_option_values(nested, out);
        }
    }
}

pub(super) fn split_agy_model_and_effort(
    raw_model: Option<&str>,
    raw_effort: Option<&str>,
    snapshot: &ConfigSnapshot,
) -> (Option<String>, Option<String>) {
    let model = raw_model.map(str::trim).filter(|s| !s.is_empty());
    let effort = raw_effort
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|raw| normalize_thought_level(raw, snapshot));

    let Some(model) = model else {
        return (None, effort);
    };
    if model_has_no_effort(model) {
        return (Some(model.to_string()), None);
    }
    if model_encodes_effort(model) {
        if snapshot.model_values.contains(model) {
            return (Some(model.to_string()), None);
        }
        let lower = model.to_ascii_lowercase();
        for suffix in ["-low", "-medium", "-high", "-xhigh"] {
            if lower.ends_with(suffix) && model.len() > suffix.len() {
                let base = &model[..model.len() - suffix.len()];
                let tier = &lower[lower.len() - suffix.len() + 1..];
                return (Some(base.to_string()), Some(tier.to_string()));
            }
        }
    }
    (Some(model.to_string()), effort)
}

fn normalize_thought_level(raw: &str, snapshot: &ConfigSnapshot) -> String {
    let normalized = raw.trim().to_ascii_lowercase();
    if snapshot.thought_values.contains(&normalized) {
        return normalized;
    }
    match normalized.as_str() {
        "low" | "minimal" => "low".to_string(),
        "medium" => "medium".to_string(),
        "high" | "xhigh" | "max" | "ultra" => "high".to_string(),
        other => other.to_string(),
    }
}

pub(super) fn effective_display_model(
    snapshot: &ConfigSnapshot,
    fallback_model: Option<&str>,
) -> Option<String> {
    let base = snapshot
        .current_model
        .as_deref()
        .or(fallback_model)
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    if !model_supports_independent_effort(base) {
        return Some(base.to_string());
    }
    if snapshot.has_thought_option {
        if let Some(ref tier) = snapshot.current_thought {
            return Some(format!("{base}-{tier}"));
        }
    }
    Some(base.to_string())
}

pub(super) fn parse_agy_retry_chunk(text: &str) -> Option<(u64, String)> {
    let trimmed = text.trim();
    let rest = trimmed.strip_prefix('⚠')?.trim_start();
    let rest = rest.strip_prefix("API error (attempt ")?;
    let (num_str, tail) = rest.split_once("):")?;
    let attempt = num_str.trim().parse::<u64>().ok()?;
    let message = tail.trim();
    if message.is_empty() {
        return None;
    }
    Some((attempt, message.to_string()))
}

pub(super) fn normalize_acp_prompt_usage(result: &Value) -> Option<Value> {
    let raw = result
        .get("usage")
        .or_else(|| result.get("_meta"))
        .filter(|v| v.is_object())?;
    let input = raw.get("inputTokens").and_then(Value::as_u64)?;
    let output = raw.get("outputTokens").and_then(Value::as_u64)?;
    let cache_read = raw
        .get("cachedReadTokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let thought = raw.get("thoughtTokens").and_then(Value::as_u64);

    if input > MAX_SAFE_INTEGER || output > MAX_SAFE_INTEGER || cache_read > MAX_SAFE_INTEGER {
        return None;
    }
    let total = raw
        .get("totalTokens")
        .and_then(Value::as_u64)
        .filter(|&n| n <= MAX_SAFE_INTEGER)
        .or_else(|| input.checked_add(output)?.checked_add(cache_read))?;

    let mut map = Map::new();
    map.insert("usage_scope".into(), json!("turn"));
    map.insert("input_tokens".into(), json!(input));
    map.insert("output_tokens".into(), json!(output));
    map.insert("cached_input_tokens".into(), json!(cache_read));
    map.insert("cache_read_input_tokens".into(), json!(cache_read));
    map.insert("total_tokens".into(), json!(total));
    if let Some(t) = thought.filter(|&n| n > 0 && n <= MAX_SAFE_INTEGER) {
        map.insert("thinking_tokens".into(), json!(t));
        map.insert("reasoning_output_tokens".into(), json!(t));
    }
    let step_snapshot = Value::Object(map.clone());
    map.insert("context_usage_kind".into(), json!("last_prompt"));
    map.insert("context_usage".into(), step_snapshot);
    Some(Value::Object(map))
}

fn extract_session_id(value: &Value) -> Option<String> {
    value
        .get("sessionId")
        .or_else(|| value.get("session_id"))
        .or_else(|| value.get("id"))
        .or_else(|| value.get("_meta").and_then(|m| m.get("sessionId")))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn enrich_error_with_stderr(raw: String, stderr_buf: &Arc<std::sync::Mutex<String>>) -> String {
    if raw == CANCELLED_MARKER {
        return raw;
    }
    if let Some(bare) = raw
        .strip_prefix("rpc:")
        .and_then(|rest| rest.split_once(':'))
        .map(|(_, msg)| msg.trim())
        .filter(|msg| !msg.is_empty())
    {
        return bare.to_string();
    }
    let stderr_tail = stderr_buf
        .lock()
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if !stderr_tail.is_empty() {
        return format!("{raw}: {stderr_tail}");
    }
    raw
}

fn push_bounded_estimate(
    estimator: &mut StreamTokenEstimator,
    text: &str,
    remaining_bytes: &mut usize,
) {
    if *remaining_bytes == 0 || text.is_empty() {
        return;
    }
    if text.len() <= *remaining_bytes {
        *remaining_bytes -= text.len();
        estimator.push_delta(text);
        return;
    }
    let mut end = *remaining_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    *remaining_bytes = 0;
    if end > 0 {
        estimator.push_delta(&text[..end]);
    }
}

fn push_value_estimate(
    estimator: &mut StreamTokenEstimator,
    value: &Value,
    remaining_bytes: &mut usize,
) {
    if *remaining_bytes == 0 {
        return;
    }
    match value {
        Value::Null => push_bounded_estimate(estimator, "null", remaining_bytes),
        Value::Bool(b) => {
            push_bounded_estimate(estimator, if *b { "true" } else { "false" }, remaining_bytes)
        }
        Value::Number(n) => push_bounded_estimate(estimator, &n.to_string(), remaining_bytes),
        Value::String(s) => {
            push_bounded_estimate(estimator, "\"", remaining_bytes);
            push_bounded_estimate(estimator, s, remaining_bytes);
            push_bounded_estimate(estimator, "\"", remaining_bytes);
        }
        Value::Array(items) => {
            push_bounded_estimate(estimator, "[", remaining_bytes);
            for (idx, item) in items.iter().enumerate() {
                if *remaining_bytes == 0 {
                    break;
                }
                if idx > 0 {
                    push_bounded_estimate(estimator, ",", remaining_bytes);
                }
                push_value_estimate(estimator, item, remaining_bytes);
            }
            push_bounded_estimate(estimator, "]", remaining_bytes);
        }
        Value::Object(map) => {
            push_bounded_estimate(estimator, "{", remaining_bytes);
            for (idx, (k, v)) in map.iter().enumerate() {
                if *remaining_bytes == 0 {
                    break;
                }
                if idx > 0 {
                    push_bounded_estimate(estimator, ",", remaining_bytes);
                }
                push_bounded_estimate(estimator, "\"", remaining_bytes);
                push_bounded_estimate(estimator, k, remaining_bytes);
                push_bounded_estimate(estimator, "\":", remaining_bytes);
                push_value_estimate(estimator, v, remaining_bytes);
            }
            push_bounded_estimate(estimator, "}", remaining_bytes);
        }
    }
}

pub(super) struct AgyAcpTelemetry {
    started: Instant,
    ready_offset_ms: Option<f64>,
    prompt_finished_at: Option<Instant>,
    ended: bool,
    tools: IntervalTracker,
    waits: IntervalTracker,
    open_elicitations: Vec<String>,
    estimator: StreamTokenEstimator,
    authoritative_steps_tokens: u64,
    step_committed_since_delta: bool,
    last_live_emit: Option<Instant>,
}

impl AgyAcpTelemetry {
    pub(super) fn new(started: Instant) -> Self {
        Self {
            started,
            ready_offset_ms: None,
            prompt_finished_at: None,
            ended: false,
            tools: IntervalTracker::default(),
            waits: IntervalTracker::default(),
            open_elicitations: Vec::new(),
            estimator: StreamTokenEstimator::default(),
            authoritative_steps_tokens: 0,
            step_committed_since_delta: false,
            last_live_emit: None,
        }
    }

    pub(super) fn begin_continuation(&mut self, now: Instant) {
        self.started = now;
        self.ready_offset_ms = Some(0.0);
        self.prompt_finished_at = None;
        self.ended = false;
        self.tools = IntervalTracker::default();
        self.waits = IntervalTracker::default();
        self.open_elicitations.clear();
        self.estimator = StreamTokenEstimator::default();
        self.authoritative_steps_tokens = 0;
        self.step_committed_since_delta = false;
        self.last_live_emit = None;
    }

    fn offset_ms(&self, now: Instant) -> f64 {
        now.saturating_duration_since(self.started).as_secs_f64() * 1000.0
    }

    fn startup_offset(&self) -> f64 {
        self.ready_offset_ms
            .filter(|ms| ms.is_finite() && *ms >= MIN_STARTUP_STRIP_MS)
            .unwrap_or(0.0)
    }

    pub(super) fn mark_prompt_sent(&mut self, now: Instant) {
        self.ready_offset_ms = Some(self.offset_ms(now));
    }

    pub(super) fn mark_prompt_finished(&mut self, now: Instant) {
        let at_ms = self.offset_ms(now);
        self.waits.close_all(at_ms);
        self.open_elicitations.clear();
        self.prompt_finished_at = Some(now);
    }

    pub(super) fn on_tool_start(
        &mut self,
        tool_id: &str,
        tool_name: &str,
        input: Option<&Value>,
        now: Instant,
    ) {
        let at_ms = self.offset_ms(now);
        self.waits.close("retry", at_ms);
        if !self.step_committed_since_delta {
            let mut remaining = MAX_TOOL_INPUT_ESTIMATE_BYTES;
            push_bounded_estimate(&mut self.estimator, tool_name, &mut remaining);
            if let Some(val) = input {
                push_bounded_estimate(&mut self.estimator, " ", &mut remaining);
                push_value_estimate(&mut self.estimator, val, &mut remaining);
            }
        }
        self.tools.open(format!("tool:{tool_id}"), at_ms);
    }

    pub(super) fn on_tool_end(&mut self, tool_id: &str, now: Instant) {
        self.tools
            .close(&format!("tool:{tool_id}"), self.offset_ms(now));
        if !self.tools.has_open() {
            self.step_committed_since_delta = false;
        }
    }

    pub(super) fn on_question_wait_start(&mut self, request_id: &str, now: Instant) {
        let key = format!("elicitation:{request_id}");
        if !self.open_elicitations.contains(&key) && self.open_elicitations.len() < 256 {
            self.open_elicitations.push(key.clone());
        }
        self.waits.open(key, self.offset_ms(now));
    }

    pub(super) fn on_question_wait_end(
        &mut self,
        rpc_id: Option<&str>,
        all_settled: bool,
        now: Instant,
    ) {
        let at_ms = self.offset_ms(now);
        if let Some(id) = rpc_id {
            let key = format!("elicitation:{id}");
            self.waits.close(&key, at_ms);
            self.open_elicitations.retain(|k| k != &key);
        }
        if all_settled {
            for key in self.open_elicitations.drain(..) {
                self.waits.close(&key, at_ms);
            }
        }
    }

    pub(super) fn on_retry_wait_start(&mut self, now: Instant) {
        self.estimator.clear_inflight();
        self.step_committed_since_delta = false;
        self.waits.open("retry", self.offset_ms(now));
    }

    pub(super) fn on_model_delta(&mut self, delta: &str, now: Instant) {
        let at_ms = self.offset_ms(now);
        if self.tools.has_open() {
            self.tools.close_all(at_ms);
        }
        if self.waits.has_open() {
            self.waits.close_all(at_ms);
            self.open_elicitations.clear();
        }
        self.step_committed_since_delta = false;
        self.estimator.push_delta(delta);
    }

    pub(super) fn on_authoritative_steps(
        &mut self,
        step_tokens: &[u64],
        now: Instant,
    ) -> Option<Value> {
        if step_tokens.is_empty() {
            return None;
        }
        self.waits.close("retry", self.offset_ms(now));
        for &tok in step_tokens {
            self.estimator.commit_authoritative_step(tok);
            self.authoritative_steps_tokens = self
                .authoritative_steps_tokens
                .saturating_add(tok)
                .min(MAX_SAFE_INTEGER);
        }
        self.step_committed_since_delta = true;
        self.running_sample(now)
    }

    fn running_breakdown(&self, now: Instant) -> TimeBreakdown {
        let wall_ms = self.offset_ms(now);
        let tool_segs = self.tools.segments_at(wall_ms);
        let wait_segs = self.waits.segments_at(wall_ms);
        compute_breakdown(wall_ms, self.startup_offset(), &tool_segs, &wait_segs)
    }

    pub(super) fn live_sample(&mut self, now: Instant) -> Option<Value> {
        if self.ended
            || self.ready_offset_ms.is_none()
            || self.tools.has_open()
            || self.waits.has_open()
        {
            return None;
        }
        if self
            .last_live_emit
            .is_some_and(|prev| now.saturating_duration_since(prev) < Duration::from_secs(1))
        {
            return None;
        }
        let breakdown = self.running_breakdown(now);
        let live = self.estimator.live_estimate_json(breakdown.model_ms)?;
        self.last_live_emit = Some(now);
        let mut sample = json!({
            "version": 1,
            "source": "agy",
            "status": "running",
            "outputTokens": null,
            "elapsedMs": null,
            "generation": null,
            "generationReason": "unavailable_timing",
            "turnReason": null,
            "liveEstimate": live,
        });
        if let Some(b) = breakdown_json(breakdown) {
            sample["breakdown"] = b;
        }
        Some(sample)
    }

    pub(super) fn running_sample(&mut self, now: Instant) -> Option<Value> {
        if self.ended || self.ready_offset_ms.is_none() || self.authoritative_steps_tokens == 0 {
            return None;
        }
        let breakdown = self.running_breakdown(now);
        if !breakdown.model_ms.is_finite() || breakdown.model_ms < MIN_LIVE_ESTIMATE_MS {
            return None;
        }
        let tps = (self.authoritative_steps_tokens as f64) * 1000.0 / breakdown.model_ms;
        if !tps.is_finite() || tps > MAX_PLAUSIBLE_TPS {
            return None;
        }
        self.last_live_emit = Some(now);
        let mut sample = json!({
            "version": 1,
            "source": "agy",
            "status": "running",
            "outputTokens": self.authoritative_steps_tokens,
            "elapsedMs": round_ms(breakdown.model_ms),
            "generation": null,
            "generationReason": "unavailable_timing",
            "turnReason": null,
        });
        if let Some(b) = breakdown_json(breakdown) {
            sample["breakdown"] = b;
        }
        if let Some(live) = self.estimator.live_estimate_json(breakdown.model_ms) {
            sample["liveEstimate"] = live;
        }
        Some(sample)
    }

    pub(super) fn finish(
        &mut self,
        partial: bool,
        usage: Option<&Value>,
        now: Instant,
    ) -> Option<Value> {
        if self.ended {
            return None;
        }
        self.ended = true;
        let end_at = if partial {
            now
        } else {
            self.prompt_finished_at.unwrap_or(now)
        };
        let wall_ms = self.offset_ms(end_at);
        if partial {
            self.tools.close_all(wall_ms);
        }
        self.waits.close_all(wall_ms);
        self.open_elicitations.clear();
        let output = usage
            .and_then(|u| u.get("output_tokens"))
            .and_then(Value::as_u64)
            .or_else(|| {
                (!partial && self.authoritative_steps_tokens > 0)
                    .then_some(self.authoritative_steps_tokens)
            });
        let breakdown = compute_breakdown(
            wall_ms,
            self.startup_offset(),
            self.tools.closed_segments(),
            self.waits.closed_segments(),
        );
        let elapsed =
            (breakdown.model_ms > 0.0 && breakdown.model_ms.is_finite()).then_some(breakdown.model_ms);
        let reason = if partial {
            Some("interrupted")
        } else if self.ready_offset_ms.is_none() {
            Some("missing_boundary")
        } else {
            validate_complete_gate(output, elapsed)
        };
        let mut sample = json!({
            "version": 1,
            "source": "agy",
            "status": if partial { "partial" } else { "complete" },
            "outputTokens": output,
            "elapsedMs": elapsed,
            "generation": null,
            "generationReason": "unavailable_timing",
            "turnReason": reason,
        });
        if let Some(b) = breakdown_json(breakdown) {
            sample["breakdown"] = b;
        }
        Some(sample)
    }
}
