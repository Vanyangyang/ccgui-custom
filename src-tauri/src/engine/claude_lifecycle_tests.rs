//! Native-process regression: real stdin, asynchronous background child,
//! notification continuation, a control reply, and the Windows Job guard.
use super::{
    claude::ClaudeEngine,
    reader::*,
    registry::{ChildEntry, ProcessRegistry},
    Engine, SendRequest,
};
use crate::event_sink::{Emit, EventSink};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, Write},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::Mutex as TokioMutex;

/// The pre-fix adapter's result boundary, retained only to demonstrate that
/// the process fixture detects the original loss rather than mirroring a fix.
struct ResultOnlyEngine(ClaudeEngine);
impl Engine for ResultOnlyEngine {
    fn id(&self) -> &'static str {
        "claude"
    }
    fn supports_images(&self) -> bool {
        true
    }
    fn build_command(&self, req: &SendRequest, bin: &str) -> Result<super::BuiltCommand, String> {
        self.0.build_command(req, bin)
    }
    fn parse_line(&self, line: &str, out: &mut Vec<super::EngineEvent>) {
        if serde_json::from_str::<Value>(line)
            .ok()
            .is_some_and(|v| v["type"] == "result")
        {
            out.push(super::EngineEvent::Done {
                session_id: None,
                usage: None,
            });
        } else {
            self.0.parse_line(line, out);
        }
    }
}

#[derive(Default)]
struct Capture(Mutex<Vec<Value>>);
impl Emit for Capture {
    fn emit_json(&self, _: &str, raw: &str) {
        if let Ok(events) = serde_json::from_str::<Vec<Value>>(raw) {
            self.0.lock().unwrap().extend(events);
        }
    }
}
fn emit(value: Value) {
    println!("{value}");
    std::io::stdout().flush().unwrap();
}
fn system(subtype: &str, extra: Value) {
    let mut value = json!({"type":"system","subtype":subtype,"session_id":"native-fixture"});
    value
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    emit(value);
}
fn result(text: &str) {
    result_tokens(text, 1);
}
fn result_tokens(text: &str, tokens: u64) {
    emit(
        json!({"type":"result","subtype":"success","session_id":"native-fixture","result":text,"usage":{"output_tokens":tokens}}),
    );
}
fn delta(text: &str) {
    emit(
        json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":text}}}),
    );
}

/// The user message the live-input modes receive while background work runs,
/// and the text its reply streams back.
const FOLLOW_UP_TEXT: &str = "follow-up 中文 🧪";
const FOLLOW_UP_REPLY: &str = "FOLLOW-UP REPLY 中文 🧪";
const PARTIAL_REPLY: &str = "PARTIAL BEFORE INTERRUPT";

#[test]
#[ignore = "subprocess fixture, invoked by lifecycle regressions"]
fn background_child_fixture() {
    let Some(dir) = std::env::var_os("CCGUI_NATIVE_LIFECYCLE_FIXTURE") else {
        return;
    };
    let dir = std::path::PathBuf::from(dir);
    let mode = std::env::var("CCGUI_NATIVE_LIFECYCLE_MODE").unwrap();
    if matches!(mode.as_str(), "followup" | "interrupt") {
        // Held until the CLI fixture has answered the user's message, so that
        // answer provably happens while this task is still alive. Never
        // released (a failed test) means never completed.
        let release = dir.join("background-release");
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while !release.exists() {
            if std::time::Instant::now() >= deadline {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    } else {
        let ms = if matches!(mode.as_str(), "continue" | "clean") {
            500
        } else {
            30_000
        };
        std::thread::sleep(Duration::from_millis(ms));
    }
    std::fs::write(dir.join("background-completed"), b"completed").unwrap();
}

/// The CLI side of the live-input modes. The first reply ended and the CLI is
/// idle with its background child alive; the user's message then arrives on
/// the SAME stdin, as the native CLI accepts it, and is answered (`followup`)
/// or interrupted mid-reply (`interrupt`) while the child keeps running. The
/// child's completion notification comes afterwards and ends the run.
fn live_input_fixture(
    mode: &str,
    dir: &std::path::Path,
    rx: &std::sync::mpsc::Receiver<Option<String>>,
    background: &mut std::process::Child,
) {
    let line = rx
        .recv_timeout(Duration::from_secs(10))
        .expect("the follow-up message never arrived")
        .expect("stdin must stay open for a message while background work runs");
    let message: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(message["type"], "user");
    assert_eq!(message["message"]["content"][0]["text"], FOLLOW_UP_TEXT);
    assert!(
        background.try_wait().unwrap().is_none(),
        "the background child must still be alive when the message is handled"
    );
    system("session_state_changed", json!({"state":"running"}));
    if mode == "interrupt" {
        delta(PARTIAL_REPLY);
        let frame = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("the interrupt never arrived")
            .expect("stdin must stay open for the interrupt");
        let request: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(request["type"], "control_request");
        assert_eq!(request["request"]["subtype"], "interrupt");
        let id = request["request_id"].as_str().unwrap();
        // Order verified against Claude Code 2.1.287: acknowledgement, the
        // aborted reply's result (error, empty text), then idle.
        emit(json!({"type":"control_response","response":{"subtype":"success","request_id":id}}));
        emit(
            json!({"type":"result","subtype":"error_during_execution","is_error":true,"session_id":"native-fixture","result":"","usage":{"output_tokens":2}}),
        );
    } else {
        delta(FOLLOW_UP_REPLY);
        result_tokens("FOLLOW-UP", 2);
    }
    system("session_state_changed", json!({"state":"idle"}));
    // Neither answering nor interrupting ends the run: stdin stays open and
    // the background child is untouched.
    assert!(
        matches!(
            rx.recv_timeout(Duration::from_millis(300)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ),
        "stdin was closed or written to while background work still runs"
    );
    assert!(background.try_wait().unwrap().is_none());
    std::fs::write(dir.join("background-release"), b"release").unwrap();
    assert!(background.wait().unwrap().success());
    system("background_tasks_changed", json!({"tasks":[]}));
    system(
        "task_notification",
        json!({"task_id":"bg","status":"completed","summary":"timer completed"}),
    );
    system("session_state_changed", json!({"state":"running"}));
    delta("COMPLETE");
    result_tokens("COMPLETE", 3);
    system("session_state_changed", json!({"state":"idle"}));
    assert!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap().is_none(),
        "only the fully drained native run may receive EOF"
    );
}

#[test]
#[ignore = "subprocess fixture, invoked by lifecycle regressions"]
fn native_cli_fixture() {
    let Some(dir) = std::env::var_os("CCGUI_NATIVE_LIFECYCLE_FIXTURE") else {
        return;
    };
    let dir = std::path::PathBuf::from(dir);
    let mode = std::env::var("CCGUI_NATIVE_LIFECYCLE_MODE").unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else {
                break;
            };
            let _ = tx.send(Some(line));
        }
        let _ = tx.send(None);
    });
    // The parent assigns its Job before writing the initial user message.
    assert!(rx.recv_timeout(Duration::from_secs(5)).unwrap().is_some());
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "engine::claude_lifecycle_tests::background_child_fixture",
            "--ignored",
            "--nocapture",
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut background = command.spawn().unwrap();
    std::fs::write(dir.join("background-pid"), background.id().to_string()).unwrap();
    system("session_state_changed", json!({"state":"running"}));
    if mode == "crash-run" {
        // A native run is open but no task is tracked: only the run-level
        // banner can describe this failure.
        std::process::exit(43);
    }
    system(
        "background_tasks_changed",
        json!({"tasks":[{"task_id":"bg","task_type":"local_bash","description":"Native background test"}]}),
    );
    if mode == "task-stop" {
        system("task_started", json!({"task_id":"kept", "task_type":"local_bash", "is_backgrounded":true, "description":"Keep this task"}));
        system("background_tasks_changed", json!({"tasks":[
            {"task_id":"bg", "task_type":"local_bash"},
            {"task_id":"kept", "task_type":"local_bash"},
        ]}));
    }
    result("PENDING");
    system("session_state_changed", json!({"state":"idle"}));
    if matches!(mode.as_str(), "task-stop" | "task-stop-rejected") {
        let frame = rx.recv_timeout(Duration::from_secs(5)).unwrap()
            .expect("the live task must keep stdin open for stop_task");
        let frame: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(frame["request"], json!({"subtype":"stop_task", "task_id":"bg"}));
        assert!(frame["request_id"].as_str().unwrap().starts_with(super::native_task_control::STOP_TASK_REQUEST_PREFIX));
        if mode == "task-stop-rejected" {
            emit(json!({"type":"control_response", "response":{
                "subtype":"error", "request_id":frame["request_id"], "error":"Native task cannot be stopped",
            }}));
            std::thread::sleep(Duration::from_secs(30));
            return;
        }
        emit(json!({"type":"control_response", "response":{
            "subtype":"success", "request_id":frame["request_id"],
        }}));
        std::thread::sleep(Duration::from_millis(50));
        assert!(background.try_wait().unwrap().is_none());
        background.kill().unwrap();
        background.wait().unwrap();
        // Native can suppress task_notification for an explicit stop. The
        // task_updated/killed frame alone must settle the selected row.
        system("task_updated", json!({"task_id":"bg", "patch":{"status":"killed"}}));
        system("background_tasks_changed", json!({"tasks":[{"task_id":"kept", "task_type":"local_bash"}]}));
        assert!(rx.recv_timeout(Duration::from_millis(150)).is_err(), "another live task must retain the session");
        system("task_updated", json!({"task_id":"kept", "patch":{"status":"completed"}}));
        system("background_tasks_changed", json!({"tasks":[]}));
        system("session_state_changed", json!({"state":"idle"}));
        assert!(rx.recv_timeout(Duration::from_secs(5)).unwrap().is_none());
        return;
    }
    if matches!(mode.as_str(), "followup" | "interrupt") {
        live_input_fixture(&mode, &dir, &rx, &mut background);
        return;
    }
    // Old reader closes stdin here: fail immediately, before background work
    // can finish. Its Windows Job then kills that child too.
    if let Ok(None) = rx.recv_timeout(Duration::from_millis(150)) {
        std::process::exit(41);
    }
    if mode == "crash" {
        std::process::exit(42);
    }
    if mode == "stop" {
        std::thread::sleep(Duration::from_secs(30));
        return;
    }
    assert!(background.wait().unwrap().success());
    system("background_tasks_changed", json!({"tasks":[]}));
    system(
        "task_notification",
        json!({"task_id":"bg","status":"completed","summary":"timer completed"}),
    );
    system("session_state_changed", json!({"state":"running"}));
    if mode == "clean" {
        emit(
            json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial notification reply"}}}),
        );
        std::process::exit(0);
    }
    emit(
        json!({"type":"control_request","request_id":"late-question","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","tool_use_id":"question-tool","input":{"questions":[{"question":"Continue?","header":"Next","options":[{"label":"Yes","description":"Continue"}]}]}}}),
    );
    system("session_state_changed", json!({"state":"requires_action"}));
    let reply = rx
        .recv_timeout(Duration::from_secs(10))
        .unwrap()
        .expect("stdin must survive for the late control reply");
    let reply: Value = serde_json::from_str(&reply).unwrap();
    assert_eq!(reply["type"], "control_response");
    assert_eq!(reply["response"]["request_id"], "late-question");
    system("session_state_changed", json!({"state":"running"}));
    emit(
        json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"COMPLETE 中文 🧪"}}}),
    );
    result("COMPLETE");
    system("session_state_changed", json!({"state":"idle"}));
    assert!(
        rx.recv_timeout(Duration::from_secs(5)).unwrap().is_none(),
        "the fully drained native run must receive EOF"
    );
}

/// Poll the captured events until `ready`, failing fast if the run already
/// ended: a message the frontend would deliver live must find the run open.
async fn wait_for_events(
    sink: &Arc<EventSink>,
    capture: &Arc<Capture>,
    what: &str,
    ready: impl Fn(&[Value]) -> bool,
) {
    poll_events(sink, capture, Duration::from_secs(12), what, ready)
        .await
        .unwrap_or_else(|failure| panic!("{failure}"));
}

/// `wait_for_events` with its own bound and a returned failure, so a real-CLI
/// caller can stop the process before reporting it.
async fn poll_events(
    sink: &Arc<EventSink>,
    capture: &Arc<Capture>,
    limit: Duration,
    what: &str,
    ready: impl Fn(&[Value]) -> bool,
) -> Result<(), String> {
    tokio::time::timeout(limit, async {
        loop {
            sink.flush();
            let events = capture.0.lock().unwrap().clone();
            if events
                .iter()
                .any(|e| e["kind"] == "done" || e["kind"] == "error")
            {
                return Err(format!("native run ended before {what}: {events:#?}"));
            }
            if ready(&events) {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        Err(format!(
            "timed out waiting for {what}: {:#?}",
            capture.0.lock().unwrap()
        ))
    })
}

/// The newest `tasks` snapshot among `events`.
fn last_tasks(events: &[Value]) -> Vec<Value> {
    events
        .iter()
        .rev()
        .find(|e| e["kind"] == "tasks")
        .and_then(|e| e["data"]["tasks"].as_array().cloned())
        .unwrap_or_default()
}

const REAL_BACKGROUND_PROMPT: &str = "This is an isolated native CLI lifecycle regression. Launch exactly one Bash command with run_in_background=true: node -e \"setTimeout(()=>console.log('BG_DONE'),40000)\". Immediately finish your first reply with STARTED. Do not poll, wait, read its output, edit files or call other tools. Later user messages may arrive while it runs: answer each exactly as asked. When its completion notification arrives, reply with one short sentence.";
/// A background subagent that stays busy with model calls and reads for a good
/// while, and first trips a tool-permission denial (the GUI cannot show permission
/// prompts, so each one flips the CLI to requires_action and back to running).
const REAL_BUSY_AGENT_PROMPT: &str = "This is an isolated native CLI lifecycle regression. Launch exactly one Agent (general-purpose) with run_in_background=true. Its prompt: \"Step 1: call the Bash tool with the command whoami exactly once (it may be denied; that is expected, just continue). Step 2: use the Read tool on a.txt, b.txt, c.txt, d.txt, e.txt, f.txt, g.txt and h.txt in that order, strictly ONE file per tool call (never in parallel), and write one sentence of commentary after each file before the next call. Step 3: summarize all files in two sentences.\" Immediately finish your own first reply with STARTED. Do not poll, wait, read output or call any other tool yourself. When the agent finishes and you are notified, reply with the single word FINISHED.";
const REAL_PONG_PROMPT: &str = "Reply with exactly the single word PONG. Do not use any tools.";
const REAL_COUNT_PROMPT: &str = "Count from 1 to 400, one number per line with a short comment after each number. Do not use any tools.";

/// What the frontend does against the real CLI once its first reply idles with
/// the background task still running: the user's message (and, for the
/// interrupt mode, Stop) goes through the production functions the
/// `send_follow_up` / `interrupt_turn` commands wrap. Every wait polls the
/// captured events within a bound; the caller stops the CLI on failure.
async fn drive_real_live_input(
    mode: &str,
    registry: &ProcessRegistry,
    sink: &Arc<EventSink>,
    capture: &Arc<Capture>,
    workspace: &std::path::Path,
) -> Result<(), String> {
    let interrupt = mode == "native-interrupt";
    poll_events(
        sink,
        capture,
        Duration::from_secs(60),
        "the idle wait with a running background task",
        |events| {
            events
                .iter()
                .any(|e| e["kind"] == "activity" && e["data"]["state"] == "waiting")
                && last_tasks(events).iter().any(|t| t["status"] == "running")
        },
    )
    .await?;
    if mode == "native-task-stop" {
        let task_id = last_tasks(&capture.0.lock().unwrap()).into_iter()
            .find(|task| task["status"] == "running" && task["ambient"] != true)
            .and_then(|task| task["id"].as_str().map(str::to_string))
            .ok_or("no running native task to stop")?;
        let entry = registry.get_live("native-run").ok_or("native run already exited")?;
        super::native_task_control::stop_native_task_inner(registry, "native-run", &task_id).await?;
        if entry.killed.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("stop_task killed the whole native session".into());
        }
        return Ok(());
    }
    if mode == "native-busy-followup" {
        // The subagent now trips its denied tool call and keeps reading: the
        // CLI reports requires_action / running for it and never idles. None of
        // that is the main loop replying, so the run must stay "waiting".
        // Wait until the subagent is demonstrably busy (several progress
        // updates after the first reply) and still running.
        poll_events(
            sink,
            capture,
            Duration::from_secs(40),
            "the background subagent to make progress",
            |events| {
                let Some(first) = events.iter().position(|e| e["kind"] == "turn_complete") else {
                    return false;
                };
                events
                    .iter()
                    .skip(first)
                    .filter(|e| e["kind"] == "tasks")
                    .count()
                    >= 3
                    && last_tasks(events).iter().all(|t| !terminal_task(t))
            },
        )
        .await?;
        sink.flush();
        let events = capture.0.lock().unwrap().clone();
        let first = events
            .iter()
            .position(|e| e["kind"] == "turn_complete")
            .ok_or("the first reply never ended before the busy wait")?;
        let states: Vec<&str> = events
            .iter()
            .skip(first)
            .filter(|e| e["kind"] == "activity")
            .filter_map(|e| e["data"]["state"].as_str())
            .collect();
        if states.iter().any(|state| *state != "waiting") {
            let timeline: Vec<String> = events
                .iter()
                .skip(first)
                .map(|e| match e["kind"].as_str().unwrap_or("?") {
                    "activity" => format!("activity:{}", e["data"]["state"].as_str().unwrap_or("?")),
                    "tasks" => format!(
                        "tasks:{}",
                        e["data"]["tasks"]
                            .as_array()
                            .map(|rows| rows
                                .iter()
                                .map(|t| t["status"].as_str().unwrap_or("?"))
                                .collect::<Vec<_>>()
                                .join("/"))
                            .unwrap_or_default()
                    ),
                    kind => kind.to_string(),
                })
                .collect();
            return Err(format!(
                "subagent activity leaked into the run's activity: {states:?}; timeline after the first reply: {timeline:?}"
            ));
        }
    }
    let prompt = if interrupt {
        REAL_COUNT_PROMPT
    } else {
        REAL_PONG_PROMPT
    };
    let wrote =
        super::send_follow_up_inner(registry, "native-run", "claude", workspace, prompt, &[])
            .await
            .map_err(|e| format!("send_follow_up_inner failed: {e}"))?;
    if !wrote {
        return Err("send_follow_up_inner reported no live run for the follow-up".into());
    }
    if !interrupt {
        return Ok(());
    }
    // The follow-up's own reply is streaming: its running activity comes after
    // the first reply's end, a few deltas follow, and it has not ended yet.
    poll_events(
        sink,
        capture,
        Duration::from_secs(60),
        "the follow-up reply to start streaming",
        |events| {
            let Some(first) = events.iter().position(|e| e["kind"] == "turn_complete") else {
                return false;
            };
            let Some(running) = events
                .iter()
                .skip(first)
                .position(|e| e["kind"] == "activity" && e["data"]["state"] == "running")
            else {
                return false;
            };
            events
                .iter()
                .skip(first + running)
                .filter(|e| e["kind"] == "delta")
                .count()
                >= 3
                && events
                    .iter()
                    .filter(|e| e["kind"] == "turn_complete")
                    .count()
                    == 1
        },
    )
    .await?;
    if !super::interrupt_turn_inner(registry, "native-run")
        .await
        .map_err(|e| format!("interrupt_turn_inner failed: {e}"))?
    {
        return Err("interrupt_turn_inner reported no live run to interrupt".into());
    }
    poll_events(
        sink,
        capture,
        Duration::from_secs(30),
        "the interrupted reply to end",
        |events| {
            events
                .iter()
                .any(|e| e["kind"] == "turn_complete" && e["data"]["interrupted"] == true)
        },
    )
    .await
}

async fn exercise(mode: &str) -> Vec<Value> {
    let real_native = matches!(
        mode,
        "native" | "native-agent" | "native-followup" | "native-interrupt" | "native-busy-followup" | "native-task-stop"
    );
    let dir = std::env::temp_dir().join(format!("ccgui-native-lifecycle-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let engine = ClaudeEngine::new();
    let (mut command, payload) = if real_native {
        let bin = std::env::var("CCGUI_NATIVE_CLAUDE_SMOKE_BIN").expect(
            "set an explicitly authorized authenticated Claude binary for this opt-in test",
        );
        let mut req = SendRequest {
            claude_ultracode: None,
            host_instructions: None, session_id: None, workspace: dir.clone(), images: vec![],
            model: None, effort: None, service_tier: None, permission: Some("auto".into()),
            additional_dirs: vec![], provider_id: None, computer_use: None, allowed_tools: None,
            prompt: "This is an isolated native CLI lifecycle regression. Launch exactly two Bash commands with run_in_background=true: (1) node -e \"setTimeout(()=>{console.log('NATIVE_FAILURE');process.exit(7)},8000)\" and (2) node -e \"setTimeout(()=>console.log('NATIVE_SUCCESS'),12000)\". Immediately finish your first reply with PENDING. Do not poll, read output, wait, edit files or call other tools. When native completion notifications arrive, acknowledge their actual outcomes. Finish with COMPLETE after both are done.".into(),
        };
        if mode == "native-agent" {
            req.prompt = "This is an isolated native CLI lifecycle regression. Launch exactly one Agent (general-purpose) with run_in_background=true. Its prompt: Run exactly one Bash command: node -e \"setTimeout(()=>console.log('AGENT_COMPLETE'),12000)\". Then reply AGENT_COMPLETE. Do not edit files, read other files, contact services, or delegate. As the parent, immediately finish your first reply with PENDING after launching the Agent. Do not poll, wait, or call other tools. When the native Agent completion notification arrives, reply COMPLETE.".into();
        }
        if matches!(mode, "native-followup" | "native-interrupt" | "native-task-stop") {
            req.prompt = REAL_BACKGROUND_PROMPT.into();
        }
        if mode == "native-busy-followup" {
            req.prompt = REAL_BUSY_AGENT_PROMPT.into();
            for x in ["a", "b", "c", "d", "e", "f", "g", "h"] {
                std::fs::write(dir.join(format!("{x}.txt")), format!("{x} one
{x} two
")).unwrap();
            }
        }
        let mut built = engine.build_command(&req, &bin).unwrap();
        built.command.args([
            "--safe-mode",
            "--no-session-persistence",
            "--strict-mcp-config",
            "--mcp-config",
            "{\"mcpServers\":{}}",
            "--tools",
            "Bash,Agent,Read",
            "--allowedTools",
            "Bash(node *)",
            "Read",
            "Agent",
        ]);
        (built.command, built.stdin_payload)
    } else {
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command.args([
            "--exact",
            "engine::claude_lifecycle_tests::native_cli_fixture",
            "--ignored",
            "--nocapture",
        ]);
        (command, Some(json!({"type":"user"}).to_string()))
    };
    command
        .current_dir(&dir)
        .env("CCGUI_NATIVE_LIFECYCLE_FIXTURE", &dir)
        .env(
            "CCGUI_NATIVE_LIFECYCLE_MODE",
            if mode == "old" { "continue" } else { mode },
        )
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().unwrap();
    #[cfg(windows)]
    let tree_guard = super::job::assign_kill_on_close(&child)
        .expect("regression requires the production Job guard");
    let pid = child.id().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = spawn_stderr_capture(child.stderr.take().unwrap());
    let stdin = spawn_stdin_writer(&mut child, payload, true);
    let child = Arc::new(TokioMutex::new(child));
    let registry = Arc::new(ProcessRegistry::default());
    let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    registry.insert(
        "native-run".into(),
        ChildEntry {
            child: Some(child.clone()),
            pid,
            run_id: "native-run".into(),
            killed: killed.clone(),
            reader_abort: Arc::new(std::sync::OnceLock::new()),
            stdin,
            questions: Arc::new(Mutex::new(HashMap::new())),
            plans: Arc::new(Mutex::new(HashMap::new())),
            native_tasks: Default::default(),
            codex_control: None,
        },
    );
    let capture = Arc::new(Capture::default());
    let sink = EventSink::new(capture.clone());
    let ctx = RunContext {
        request_started_at: None,
        core: TurnCore {
            sink: sink.clone(),
            registry: registry.clone(),
            engine_id: "claude".into(),
            run_id: "native-run".into(),
            db: None,
        },
        engine_impl: if mode == "old" {
            Box::new(ResultOnlyEngine(engine))
        } else {
            Box::new(engine)
        },
        pid,
        preassigned_session_id: None,
        initial_model: None,
        initial_effort: None,
        child,
        killed,
        cleanup_files: vec![],
        mcp_restore: None,
        stderr_buf: stderr,
        stdout_plain_buf: Arc::new(Mutex::new(String::new())),
        #[cfg(windows)]
        _tree_guard: Some(tree_guard),
    };
    let mut reader = tokio::spawn(run_reader(stdout, ctx));
    if matches!(mode, "task-stop" | "task-stop-rejected") {
        wait_for_events(&sink, &capture, "the native task to stop", |events| {
            events.iter().any(|e| e["kind"] == "turn_complete")
        }).await;
        let entry = registry.get_live("native-run").unwrap();
        let result = super::native_task_control::stop_native_task_inner(&registry, "native-run", "bg").await;
        assert!(!entry.killed.load(std::sync::atomic::Ordering::SeqCst), "stop_task must not kill the whole run");
        if mode == "task-stop-rejected" {
            assert_eq!(result, Err("Native task cannot be stopped".into()));
            sink.flush();
            assert!(!capture.0.lock().unwrap().iter().any(|e| e["kind"] == "done" || e["kind"] == "error"));
            registry.kill("native-run");
        } else {
            assert_eq!(result, Ok(super::NativeTaskStopResult { task_id: "bg".into(), status: "stopped".into() }));
        }
    }
    if matches!(mode, "native-followup" | "native-interrupt" | "native-busy-followup" | "native-task-stop") {
        if let Err(failure) = drive_real_live_input(mode, &registry, &sink, &capture, &dir).await {
            registry.kill("native-run");
            let _ = tokio::time::timeout(Duration::from_secs(12), &mut reader).await;
            sink.flush();
            let _ = std::fs::remove_dir_all(&dir);
            panic!("{failure}");
        }
    }
    if matches!(mode, "followup" | "interrupt") {
        // What the frontend does once the run idles with tasks alive: the
        // user's message goes to the live CLI through the registry's write
        // path (the one send_follow_up / interrupt_turn use).
        wait_for_events(&sink, &capture, "the idle wait with a live background task", |events| {
            events
                .iter()
                .filter(|e| e["kind"] == "activity" && e["data"]["state"] == "waiting")
                .count()
                >= 2
        })
        .await;
        let line = super::images::claude_stdin_message(FOLLOW_UP_TEXT, &[], &dir).unwrap();
        registry.write_line("native-run", line).await.unwrap();
        if mode == "interrupt" {
            wait_for_events(&sink, &capture, "the partial reply to interrupt", |events| {
                events
                    .iter()
                    .any(|e| e["kind"] == "delta" && e["data"] == PARTIAL_REPLY)
            })
            .await;
            registry
                .write_line("native-run", super::interrupt_frame())
                .await
                .unwrap();
        }
    }
    if matches!(mode, "stop" | "continue") {
        tokio::time::timeout(Duration::from_secs(12), async {
            loop {
                sink.flush();
                let events = capture.0.lock().unwrap().clone();
                assert!(
                    !events
                        .iter()
                        .any(|e| e["kind"] == "done" || e["kind"] == "error"),
                    "native background prematurely ended: {events:#?}"
                );
                let ready = if mode == "stop" {
                    events.iter().any(|e| e["kind"] == "turn_complete")
                } else {
                    events.iter().any(|e| e["kind"] == "question")
                };
                if ready {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("native background/continuation arrived");
        if mode == "stop" {
            registry.kill("native-run");
        } else {
            registry.write_line("native-run", json!({"type":"control_response","response":{"subtype":"success","request_id":"late-question","response":{"behavior":"allow","updatedInput":{"answers":{"Continue?":"Yes"}}}}}).to_string()).await.unwrap();
        }
    }
    match tokio::time::timeout(
        Duration::from_secs(match mode {
            "native-task-stop" => 15,
            "native-followup" | "native-interrupt" | "native-busy-followup" => 150,
            _ if real_native => 120,
            _ => 12,
        }),
        &mut reader,
    )
    .await
    {
        Ok(result) => result.expect("native reader must not panic"),
        Err(_) => {
            registry.kill("native-run");
            let _ = tokio::time::timeout(Duration::from_secs(12), &mut reader).await;
            panic!(
                "native reader did not settle; events: {:?}",
                capture.0.lock().unwrap()
            );
        }
    }
    sink.flush();
    let events = capture.0.lock().unwrap().clone();
    assert_eq!(
        registry.active_run_count(),
        0,
        "no leaked process/concurrency slots"
    );
    if matches!(mode, "continue" | "followup" | "interrupt") {
        assert!(
            dir.join("background-completed").exists(),
            "background child actually completed"
        );
    }
    if mode == "old" {
        assert!(
            !dir.join("background-completed").exists(),
            "old result boundary must reproduce the premature termination"
        );
    }
    #[cfg(windows)]
    if !real_native {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
        let pid: u32 = std::fs::read_to_string(dir.join("background-pid"))
            .unwrap()
            .parse()
            .unwrap();
        let mut system = System::new();
        for _ in 0..50 {
            system.refresh_processes_specifics(
                ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
                true,
                ProcessRefreshKind::nothing(),
            );
            if system.process(Pid::from_u32(pid)).is_none() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            system.process(Pid::from_u32(pid)).is_none(),
            "Job cleanup left a background child alive"
        );
    }
    // This exact UUID directory was created above, never a computed parent.
    std::fs::remove_dir_all(&dir).unwrap();
    events
}

#[tokio::test]
#[ignore = "opt-in authenticated native Claude task-stop smoke test; makes model requests"]
async fn real_native_claude_task_stop_smoke() {
    let events = exercise("native-task-stop").await;
    assert!(last_tasks(&events).iter().any(|task| task["status"] == "stopped"));
    assert_eq!(events.iter().filter(|e| e["kind"] == "done").count(), 1);
    assert!(!events.iter().any(|e| e["kind"] == "error"));
}

#[tokio::test]
#[ignore = "opt-in authenticated native Claude CLI smoke test; makes model requests"]
async fn real_native_claude_background_smoke() {
    let events = exercise("native").await;
    for event in &events {
        if matches!(
            event["kind"].as_str(),
            Some("tasks" | "activity" | "turn_complete" | "done" | "error")
        ) {
            eprintln!("native lifecycle {}: {}", event["kind"], event["data"]);
        }
    }
    assert!(
        !events.iter().any(|e| e["kind"] == "error"),
        "native CLI reported an error"
    );
    // The model decides whether to launch background work; say what it did so
    // a run that never backgrounded anything is not mistaken for a lifecycle bug.
    let reply = events
        .iter()
        .filter(|e| e["kind"] == "delta")
        .filter_map(|e| e["data"].as_str())
        .collect::<String>();
    assert!(
        events
            .iter()
            .any(|e| e["kind"] == "activity" && e["data"]["state"] == "waiting"),
        "native CLI never entered the background wait; model reply: {reply}"
    );
    let tasks = events.iter().rev().find(|e| e["kind"] == "tasks").unwrap()["data"]["tasks"]
        .as_array()
        .unwrap()
        .clone();
    assert!(
        tasks.iter().any(|t| t["status"] == "failed"),
        "native failing background command outcome survives: {tasks:?}"
    );
    assert!(
        tasks.iter().any(|t| t["status"] == "completed"),
        "native successful background command finishes: {tasks:?}"
    );
    assert!(
        events
            .iter()
            .filter(|e| e["kind"] == "turn_complete")
            .count()
            >= 2,
        "notification continuation is delivered"
    );
    assert_eq!(events.iter().filter(|e| e["kind"] == "done").count(), 1);
    let text = events
        .iter()
        .filter(|e| e["kind"] == "delta")
        .filter_map(|e| e["data"].as_str())
        .collect::<String>();
    assert!(
        text.contains("PENDING") && text.contains("COMPLETE"),
        "both original reply and native followup survive: {text}"
    );
}

#[tokio::test]
#[ignore = "opt-in authenticated native Claude CLI smoke test; makes model requests"]
async fn real_native_claude_background_agent_smoke() {
    let events = exercise("native-agent").await;
    for event in &events {
        if matches!(
            event["kind"].as_str(),
            Some("tasks" | "activity" | "turn_complete" | "done" | "error")
        ) {
            eprintln!("native agent lifecycle {}: {}", event["kind"], event["data"]);
        }
    }
    assert!(
        !events.iter().any(|e| e["kind"] == "error"),
        "native CLI reported an error"
    );
    // The model decides whether to launch background work; say what it did so
    // a run that never backgrounded anything is not mistaken for a lifecycle bug.
    let reply = events
        .iter()
        .filter(|e| e["kind"] == "delta")
        .filter_map(|e| e["data"].as_str())
        .collect::<String>();
    assert!(
        events
            .iter()
            .any(|e| e["kind"] == "activity" && e["data"]["state"] == "waiting"),
        "native CLI never entered the background wait; model reply: {reply}"
    );
    let tasks = events.iter().rev().find(|e| e["kind"] == "tasks").unwrap()["data"]["tasks"]
        .as_array()
        .unwrap()
        .clone();
    assert!(
        tasks
            .iter()
            .any(|t| t["kind"] == "local_agent" && t["status"] == "completed"),
        "native background Agent reaches a real terminal outcome: {tasks:?}"
    );
    assert!(
        events
            .iter()
            .filter(|e| e["kind"] == "turn_complete")
            .count()
            >= 2,
        "Agent completion notification triggers a native continuation"
    );
    assert_eq!(events.iter().filter(|e| e["kind"] == "done").count(), 1);
    let text = events
        .iter()
        .filter(|e| e["kind"] == "delta")
        .filter_map(|e| e["data"].as_str())
        .collect::<String>();
    assert!(
        text.contains("PENDING") && text.contains("COMPLETE"),
        "both original reply and native followup survive: {text}"
    );
}

fn terminal_task(task: &Value) -> bool {
    matches!(
        task["status"].as_str(),
        Some("completed" | "failed" | "stopped")
    )
}
fn find_from(events: &[Value], from: usize, hit: impl Fn(&Value) -> bool) -> Option<usize> {
    events
        .iter()
        .enumerate()
        .skip(from)
        .find(|(_, e)| hit(e))
        .map(|(i, _)| i)
}
fn real_live_report(label: &str, events: &[Value]) -> String {
    for event in events {
        if matches!(
            event["kind"].as_str(),
            Some("tasks" | "activity" | "turn_complete" | "done" | "error")
        ) {
            eprintln!("{label} {}: {}", event["kind"], event["data"]);
        }
    }
    let reply = events
        .iter()
        .filter(|e| e["kind"] == "delta")
        .filter_map(|e| e["data"].as_str())
        .collect::<String>();
    eprintln!("{label} reply text: {reply}");
    reply
}
fn assert_no_error(events: &[Value], reply: &str) {
    assert!(
        !events.iter().any(|e| e["kind"] == "error"),
        "native CLI reported an error; model reply: {reply}"
    );
}
/// What both live-input smokes share once the run has ended: the model really
/// went idle with a running background task, the task later completed on its
/// own, and the run ended exactly once, after it, with no error. Returns the
/// terminal task event's index and the done event's index.
fn assert_real_run_outcome(events: &[Value], reply: &str) -> (usize, usize) {
    assert!(
        events
            .iter()
            .any(|e| e["kind"] == "activity" && e["data"]["state"] == "waiting"),
        "native CLI never entered the background wait; model reply: {reply}"
    );
    let terminal = find_from(events, 0, |e| {
        e["kind"] == "tasks"
            && e["data"]["tasks"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(terminal_task))
    })
    .unwrap_or_else(|| panic!("the background task never completed; model reply: {reply}"));
    assert!(
        last_tasks(events)
            .iter()
            .any(|t| t["status"] == "completed")
            && !last_tasks(events).iter().any(|t| t["status"] == "running"),
        "the background task must end completed: {:?}",
        last_tasks(events)
    );
    let done: Vec<usize> = events
        .iter()
        .enumerate()
        .filter(|(_, e)| e["kind"] == "done")
        .map(|(i, _)| i)
        .collect();
    assert_eq!(done.len(), 1, "exactly one done; model reply: {reply}");
    assert!(
        done[0] > terminal,
        "the run ended before its background task finished; model reply: {reply}"
    );
    assert!(
        events[done[0]..]
            .iter()
            .all(|e| e["kind"] != "delta" && e["kind"] != "turn_complete"),
        "the CLI kept replying after done: stdin was closed before the run was drained; model reply: {reply}"
    );
    (terminal, done[0])
}

#[tokio::test]
#[ignore = "opt-in authenticated native Claude CLI smoke test; makes model requests"]
async fn real_native_claude_followup_smoke() {
    let events = exercise("native-followup").await;
    let reply = real_live_report("native follow-up", &events);
    assert_no_error(&events, &reply);
    let first_turn = find_from(&events, 0, |e| e["kind"] == "turn_complete")
        .unwrap_or_else(|| panic!("native CLI never ended its first reply; model reply: {reply}"));
    // The PONG answer must come after the first reply, never be part of it.
    let pong = find_from(&events, first_turn, |e| {
        e["kind"] == "delta" && e["data"].as_str().is_some_and(|t| t.contains("PONG"))
    })
    .unwrap_or_else(|| panic!("the live follow-up was never answered; model reply: {reply}"));
    let pong_turn = find_from(&events, pong, |e| e["kind"] == "turn_complete")
        .unwrap_or_else(|| panic!("the follow-up's reply never ended; model reply: {reply}"));
    let (terminal, done) = assert_real_run_outcome(&events, &reply);
    assert!(
        pong_turn < terminal,
        "the follow-up was answered only after the task ended, not live; model reply: {reply}"
    );
    let live = last_tasks(&events[..pong_turn]);
    assert!(
        live.iter().any(|t| t["status"] == "running") && !live.iter().any(terminal_task),
        "the task was not running when the follow-up's reply ended: {live:?}"
    );
    let continuation = find_from(&events, terminal, |e| e["kind"] == "turn_complete")
        .unwrap_or_else(|| panic!("no notification continuation; model reply: {reply}"));
    assert!(
        continuation > pong_turn && continuation < done,
        "the continuation must be its own reply before done; model reply: {reply}"
    );
}

/// The real-world background investigation: a model-busy subagent keeps the CLI
/// "running" (it never reports idle) while the main loop is free. The run must
/// stay in the waiting state and a follow-up must be answered live, in parallel
/// with the subagent, exactly as the native CLI does.
#[tokio::test]
#[ignore = "opt-in authenticated native Claude CLI smoke test; makes model requests"]
async fn real_native_claude_busy_agent_followup_smoke() {
    let events = exercise("native-busy-followup").await;
    let reply = real_live_report("native busy-agent follow-up", &events);
    assert_no_error(&events, &reply);
    let first_turn = find_from(&events, 0, |e| e["kind"] == "turn_complete")
        .unwrap_or_else(|| panic!("native CLI never ended its first reply; model reply: {reply}"));
    let pong = find_from(&events, first_turn, |e| {
        e["kind"] == "delta" && e["data"].as_str().is_some_and(|t| t.contains("PONG"))
    })
    .unwrap_or_else(|| panic!("the live follow-up was never answered; model reply: {reply}"));
    let pong_turn = find_from(&events, pong, |e| e["kind"] == "turn_complete")
        .unwrap_or_else(|| panic!("the follow-up's reply never ended; model reply: {reply}"));
    let (terminal, done) = assert_real_run_outcome(&events, &reply);
    assert!(
        pong_turn < terminal,
        "the follow-up was answered only after the subagent ended, not alongside it; model reply: {reply}"
    );
    let continuation = find_from(&events, terminal, |e| e["kind"] == "turn_complete")
        .unwrap_or_else(|| panic!("no notification continuation; model reply: {reply}"));
    assert!(
        continuation > pong_turn && continuation < done,
        "the continuation must be its own reply before done; model reply: {reply}"
    );
}

#[tokio::test]
#[ignore = "opt-in authenticated native Claude CLI smoke test; makes model requests"]
async fn real_native_claude_interrupt_smoke() {
    let events = exercise("native-interrupt").await;
    let reply = real_live_report("native interrupt", &events);
    assert_no_error(&events, &reply);
    let interrupted = find_from(&events, 0, |e| {
        e["kind"] == "turn_complete" && e["data"]["interrupted"] == true
    })
    .unwrap_or_else(|| panic!("no interrupted turn_complete; model reply: {reply}"));
    let first_turn = find_from(&events, 0, |e| e["kind"] == "turn_complete").unwrap();
    assert!(
        first_turn < interrupted,
        "the interrupt must end the follow-up's reply, not the first one; model reply: {reply}"
    );
    assert!(
        events[..interrupted].iter().all(|e| e["kind"] != "done"),
        "the interrupt must not end the run; model reply: {reply}"
    );
    let live = last_tasks(&events[..interrupted]);
    assert!(
        live.iter().any(|t| t["status"] == "running") && !live.iter().any(terminal_task),
        "the interrupt must leave the background task running: {live:?}"
    );
    let (terminal, done) = assert_real_run_outcome(&events, &reply);
    assert!(
        interrupted < terminal && interrupted < done,
        "the interrupted reply ended after the task or the run; model reply: {reply}"
    );
}

#[tokio::test]
async fn native_background_and_late_question_survive_response_completion() {
    let events = exercise("continue").await;
    assert_eq!(
        events
            .iter()
            .filter(|e| e["kind"] == "turn_complete")
            .count(),
        2
    );
    assert_eq!(events.iter().filter(|e| e["kind"] == "done").count(), 1);
    assert!(events
        .iter()
        .any(|e| e["kind"] == "delta" && e["data"] == "COMPLETE 中文 🧪"));
    assert!(events.iter().all(|e| e["runId"] == "native-run"));
    assert!(!events.iter().any(|e| e["kind"] == "error"));
}

#[tokio::test]
async fn original_result_only_boundary_loses_background_completion() {
    let events = exercise("old").await;
    assert_eq!(events.iter().filter(|e| e["kind"] == "done").count(), 1);
    assert!(!events
        .iter()
        .any(|e| e["kind"] == "question"
            || (e["kind"] == "delta" && e["data"] == "COMPLETE 中文 🧪")));
}

#[tokio::test]
async fn stop_cleans_native_background_and_reports_stopped() {
    let events = exercise("stop").await;
    assert!(events
        .iter()
        .any(|e| e["kind"] == "tasks" && e["data"]["tasks"][0]["status"] == "stopped"));
    assert_eq!(events.iter().filter(|e| e["kind"] == "done").count(), 1);
    assert!(!events.iter().any(|e| e["kind"] == "error"));
}

#[tokio::test]
async fn native_stop_task_stops_only_the_selected_child_without_a_notification() {
    let events = exercise("task-stop").await;
    assert!(events.iter().any(|e| e["kind"] == "tasks" &&
        e["data"]["tasks"].as_array().is_some_and(|tasks|
            tasks.iter().any(|t| t["id"] == "bg" && t["status"] == "stopped") &&
            tasks.iter().any(|t| t["id"] == "kept" && t["status"] == "running"))));
    assert_eq!(events.iter().filter(|e| e["kind"] == "done").count(), 1);
    assert!(!events.iter().any(|e| e["kind"] == "error"));
}

#[tokio::test]
async fn native_stop_task_rejection_returns_to_the_caller_without_ending_the_run() {
    let events = exercise("task-stop-rejected").await;
    assert_eq!(events.iter().filter(|e| e["kind"] == "done").count(), 1);
    assert!(!events.iter().any(|e| e["kind"] == "error"));
}

#[tokio::test]
async fn unexpected_exit_does_not_claim_native_background_success() {
    let events = exercise("crash").await;
    assert!(events
        .iter()
        .any(|e| e["kind"] == "tasks" && e["data"]["tasks"][0]["status"] == "unknown"));
    assert_eq!(events.iter().filter(|e| e["kind"] == "error").count(), 1);
    assert!(!events.iter().any(|e| e["kind"] == "done"));
}

#[tokio::test]
async fn clean_exit_during_notification_response_does_not_claim_complete_success() {
    let events = exercise("clean").await;
    assert!(events
        .iter()
        .any(|e| e["kind"] == "tasks" && e["data"]["tasks"][0]["status"] == "completed"));
    assert!(events.iter().any(|e| e["kind"] == "error"
        && e["data"]
            .as_str()
            .unwrap_or("")
            .contains("native run settled")));
    assert!(!events.iter().any(|e| e["kind"] == "done"));
    // A zero exit has no status to report: the wording stays as it was.
    let message = events.iter().find(|e| e["kind"] == "error").unwrap()["data"]
        .as_str()
        .unwrap();
    assert!(
        message.starts_with("claude exited before its native run settled"),
        "{message}"
    );
}

#[tokio::test]
async fn failed_exit_keeps_its_status_in_the_native_settle_banners() {
    for (mode, code, settled) in [
        ("crash", "42", "native tasks settled"),
        ("crash-run", "43", "native run settled"),
    ] {
        let events = exercise(mode).await;
        let errors: Vec<_> = events.iter().filter(|e| e["kind"] == "error").collect();
        assert_eq!(errors.len(), 1, "{mode}: {events:#?}");
        let message = errors[0]["data"].as_str().unwrap();
        assert!(
            message.starts_with("claude exited with status ")
                && message.contains(code)
                && message.contains(settled),
            "{mode}: {message}"
        );
        assert!(!events.iter().any(|e| e["kind"] == "done"), "{mode}");
    }
}

/// The response/activity skeleton of a run: consecutive duplicates collapse
/// (one reply cycle reports `waiting` after its result and again after idle).
fn flow(events: &[Value]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for e in events {
        let label = match e["kind"].as_str() {
            Some("activity") => format!("activity:{}", e["data"]["state"].as_str().unwrap_or("")),
            Some("turn_complete") if e["data"]["interrupted"] == true => {
                "turn_complete:interrupted".to_string()
            }
            Some("turn_complete") => "turn_complete".to_string(),
            Some("delta") => format!("delta:{}", e["data"].as_str().unwrap_or("")),
            Some("done") => "done".to_string(),
            Some("error") => "error".to_string(),
            _ => continue,
        };
        if out.last() != Some(&label) {
            out.push(label);
        }
    }
    out
}
fn turn_tokens(events: &[Value]) -> Vec<u64> {
    events
        .iter()
        .filter(|e| e["kind"] == "turn_complete")
        .map(|e| e["data"]["usage"]["output_tokens"].as_u64().unwrap())
        .collect()
}

#[tokio::test]
async fn follow_up_is_answered_live_while_background_work_runs_and_the_run_ends_once() {
    let events = exercise("followup").await;
    assert_eq!(
        flow(&events),
        [
            "activity:running",
            "turn_complete",
            "activity:waiting",
            // The user's message, written through registry.write_line while
            // the child still runs: answered as its own reply cycle.
            "activity:running",
            "delta:FOLLOW-UP REPLY 中文 🧪",
            "turn_complete",
            "activity:waiting",
            // Then the child's completion notification continues the run.
            "activity:running",
            "delta:COMPLETE",
            "turn_complete",
            "done",
        ]
    );
    assert_eq!(turn_tokens(&events), [1, 2, 3], "each reply keeps its own usage");
    assert_eq!(events.iter().filter(|e| e["kind"] == "done").count(), 1);
    assert!(
        events.iter().all(|e| e["kind"] != "error" && e["kind"] != "warn"),
        "{events:#?}"
    );
    assert!(events.iter().all(|e| e["runId"] == "native-run"));
    assert!(
        events
            .iter()
            .filter(|e| e["kind"] == "turn_complete")
            .all(|e| e["data"].get("interrupted").is_none()),
        "ordinary replies keep their payload shape"
    );
    let tasks = events.iter().rev().find(|e| e["kind"] == "tasks").unwrap();
    assert_eq!(tasks["data"]["tasks"][0]["status"], "completed");
}

#[tokio::test]
async fn interrupt_ends_only_the_reply_and_background_work_still_finishes_the_run() {
    let events = exercise("interrupt").await;
    assert!(
        !events.iter().any(|e| e["kind"] == "error"),
        "an acknowledged interrupt is never an error: {events:#?}"
    );
    assert_eq!(
        flow(&events),
        [
            "activity:running",
            "turn_complete",
            "activity:waiting",
            "activity:running",
            "delta:PARTIAL BEFORE INTERRUPT",
            // No done here: the CLI idles, the child lives on.
            "turn_complete:interrupted",
            "activity:waiting",
            "activity:running",
            "delta:COMPLETE",
            "turn_complete",
            "done",
        ]
    );
    let interrupted = events
        .iter()
        .find(|e| e["kind"] == "turn_complete" && e["data"]["interrupted"] == true)
        .unwrap();
    assert_eq!(interrupted["data"]["usage"]["output_tokens"], 2);
    assert_eq!(turn_tokens(&events), [1, 2, 3]);
    assert_eq!(events.iter().filter(|e| e["kind"] == "done").count(), 1);
    assert!(events.iter().all(|e| e["kind"] != "warn"), "{events:#?}");
    // The aborted reply's text stays; the interrupt never rewrites it.
    assert!(events
        .iter()
        .any(|e| e["kind"] == "delta" && e["data"] == PARTIAL_REPLY));
    let tasks = events.iter().rev().find(|e| e["kind"] == "tasks").unwrap();
    assert_eq!(tasks["data"]["tasks"][0]["status"], "completed");
}
