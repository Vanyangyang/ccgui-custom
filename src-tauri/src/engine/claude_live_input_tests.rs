//! send_follow_up / interrupt_turn against a real child process: the frames
//! must reach the CLI's stdin as exactly one well-formed NDJSON line each,
//! and every "nothing live" state must answer Ok(false) instead of writing
//! into a foreign, closed or dying pipe.
use super::{
    interrupt_turn_inner, interrupt_turn_within,
    reader::spawn_stdin_writer,
    registry::{ChildEntry, ProcessRegistry},
    send_follow_up_inner,
};
use base64::Engine as _;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, Write},
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc, Mutex},
    time::Duration,
};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex as TokioMutex;

// 1x1 red PNG (same fixture as images.rs).
const PNG_B64: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type SharedStdin = Arc<TokioMutex<Option<tokio::process::ChildStdin>>>;

/// Stand-in for the native CLI: appends every stdin line to the sink file,
/// then exits at EOF. `delay` models a CLI that is busy and not reading yet;
/// `exit-now` models one that already died.
#[test]
#[ignore = "subprocess fixture, invoked by the live-input regressions"]
fn stdin_sink_fixture() {
    let Some(sink) = std::env::var_os("CCGUI_LIVE_INPUT_SINK") else {
        return;
    };
    if std::env::var("CCGUI_LIVE_INPUT_MODE").as_deref() == Ok("exit-now") {
        return;
    }
    if let Some(ms) = std::env::var("CCGUI_LIVE_INPUT_DELAY_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
    {
        std::thread::sleep(Duration::from_millis(ms));
    }
    let mut out = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(sink)
        .unwrap();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else {
            break;
        };
        writeln!(out, "{line}").unwrap();
        out.flush().unwrap();
    }
}

struct Harness {
    registry: ProcessRegistry,
    child: Arc<TokioMutex<tokio::process::Child>>,
    stdin: SharedStdin,
    killed: Arc<std::sync::atomic::AtomicBool>,
    dir: PathBuf,
    sink: PathBuf,
}

impl Harness {
    /// Registers the fixture under its run id ("run-1") and a session alias
    /// ("session-1"), like a real claude run (both keys share one stdin).
    fn spawn(mode: &str, delay_ms: u64) -> Self {
        Self::spawn_with_payload(mode, delay_ms, None)
    }

    fn spawn_with_payload(mode: &str, delay_ms: u64, payload: Option<String>) -> Self {
        let dir = std::env::temp_dir().join(format!("ccgui-live-input-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let sink = dir.join("stdin-sink.ndjson");
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "engine::claude_live_input_tests::stdin_sink_fixture",
                "--ignored",
                "--nocapture",
            ])
            .env("CCGUI_LIVE_INPUT_SINK", &sink)
            .env("CCGUI_LIVE_INPUT_MODE", mode)
            .env("CCGUI_LIVE_INPUT_DELAY_MS", delay_ms.to_string())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let mut child = command.spawn().unwrap();
        let pid = child.id().unwrap();
        let stdin = spawn_stdin_writer(&mut child, payload, true)
            .expect("the interactive fixture must retain its stdin");
        let child = Arc::new(TokioMutex::new(child));
        let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let registry = ProcessRegistry::default();
        let entry = ChildEntry {
            child: Some(Arc::clone(&child)),
            pid,
            run_id: "run-1".into(),
            killed: Arc::clone(&killed),
            reader_abort: Arc::new(std::sync::OnceLock::new()),
            stdin: Some(Arc::clone(&stdin)),
            questions: Arc::new(Mutex::new(HashMap::new())),
            plans: Arc::new(Mutex::new(HashMap::new())),
            native_tasks: Default::default(),
            codex_control: None,
        };
        registry.insert("run-1".into(), entry.clone());
        registry.insert_alias("session-1".into(), entry);
        Self {
            registry,
            child,
            stdin,
            killed,
            dir,
            sink,
        }
    }

    /// EOF the CLI, wait for it, and return every line it received.
    async fn finish(&self) -> Vec<String> {
        *self.stdin.lock().await = None;
        tokio::time::timeout(Duration::from_secs(20), async {
            self.child.lock().await.wait().await.unwrap();
        })
        .await
        .expect("the fixture must exit at stdin EOF");
        match std::fs::read_to_string(&self.sink) {
            Ok(text) => text.lines().map(str::to_string).collect(),
            Err(_) => Vec::new(),
        }
    }

    async fn wait_for_exit(&self) {
        tokio::time::timeout(Duration::from_secs(20), async {
            self.child.lock().await.wait().await.unwrap();
        })
        .await
        .expect("the fixture must exit by itself");
    }

    fn workspace(&self) -> &Path {
        &self.dir
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn parse(line: &str) -> Value {
    serde_json::from_str(line).unwrap_or_else(|e| panic!("not one intact JSON frame ({e}): {line:.200}"))
}

fn stoppable_task() -> super::events::NativeTask {
    super::events::NativeTask {
        id: "bg".into(), kind: "local_bash".into(), description: "Test scan".into(),
        status: "running".into(), tool_use_id: None, summary: None,
        progress: None, background: Some(true), ambient: None,
    }
}

#[tokio::test]
async fn native_task_stop_timeout_does_not_kill_the_run_or_claim_success() {
    let h = Harness::spawn("sink", 0);
    h.registry.get("run-1").unwrap().native_tasks.observe(&[stoppable_task()]);
    let result = super::native_task_control::stop_native_task_within(
        &h.registry, "run-1", "bg", Duration::from_millis(200),
    ).await;
    assert!(result.unwrap_err().contains("Timed out"));
    assert!(!h.killed.load(Ordering::SeqCst));
    assert!(h.child.lock().await.try_wait().unwrap().is_none());
    let lines = h.finish().await;
    assert_eq!(lines.len(), 1);
    let frame = parse(&lines[0]);
    assert_eq!(frame["type"], "control_request");
    assert_eq!(frame["request"], json!({"subtype":"stop_task", "task_id":"bg"}));
}

#[tokio::test]
async fn native_task_stop_rejects_foreign_tasks_and_stale_run_routes_without_writing() {
    let h = Harness::spawn("sink", 0);
    h.registry.get("run-1").unwrap().native_tasks.observe(&[stoppable_task()]);
    for (run_id, task_id) in [("other-run", "bg"), ("session-1", "bg"), ("run-1", "foreign"), ("run-1", "")] {
        assert!(super::native_task_control::stop_native_task_inner(&h.registry, run_id, task_id).await.is_err());
    }
    assert!(!h.killed.load(Ordering::SeqCst));
    assert!(h.finish().await.is_empty());
}

#[tokio::test]
async fn native_task_stop_closed_stdin_is_a_failure_not_a_whole_session_kill() {
    let h = Harness::spawn("sink", 0);
    h.registry.get("run-1").unwrap().native_tasks.observe(&[stoppable_task()]);
    *h.stdin.lock().await = None;
    let result = super::native_task_control::stop_native_task_inner(&h.registry, "run-1", "bg").await;
    assert!(result.unwrap_err().contains("stdin"));
    assert!(!h.killed.load(Ordering::SeqCst));
    assert!(h.finish().await.is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn the_initial_user_payload_precedes_an_immediate_native_interrupt() {
    let user = json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": "initial prompt 中文 🧪" }] },
    });
    let h = Harness::spawn_with_payload("sink", 0, Some(user.to_string()));
    // Acquire the published mutex before any newly spawned task is polled,
    // modeling an interrupt reaching a just-registered run immediately.
    {
        let mut guard = h.stdin.lock().await;
        let stdin = guard.as_mut().expect("stdin must still be open");
        let frame = format!("{}\n", super::interrupt_frame());
        stdin.write_all(frame.as_bytes()).await.unwrap();
        stdin.flush().await.unwrap();
    }
    // Let the scheduled initial writer run before asking the sink for EOF.
    tokio::task::yield_now().await;
    assert!(!h.killed.load(Ordering::SeqCst));
    assert!(h.child.lock().await.try_wait().unwrap().is_none());
    let lines = h.finish().await;
    assert_eq!(lines.len(), 2, "both intact frames must reach the live process");
    assert_eq!(parse(&lines[0]), user, "the launch prompt must be the first frame");
    assert_eq!(parse(&lines[1])["request"], json!({ "subtype": "interrupt" }));
}

#[tokio::test]
async fn follow_up_writes_exactly_one_user_message_line() {
    let h = Harness::spawn("sink", 0);
    // A newline inside the prompt must stay JSON-escaped: the frame is one line.
    let prompt = "第一行 🧪\n第二行 \"quoted\"";
    for (key, text) in [("run-1", prompt), ("session-1", "via the session id")] {
        let wrote = send_follow_up_inner(&h.registry, key, "claude", h.workspace(), text, &[])
            .await
            .unwrap();
        assert!(wrote, "{key}: a live claude run must take the message");
    }
    let lines = h.finish().await;
    assert_eq!(lines.len(), 2, "{lines:?}");
    let first = parse(&lines[0]);
    assert_eq!(first["type"], "user");
    assert_eq!(first["message"]["role"], "user");
    assert_eq!(
        first["message"]["content"],
        json!([{ "type": "text", "text": prompt }])
    );
    assert_eq!(
        parse(&lines[1])["message"]["content"][0]["text"],
        "via the session id"
    );
    assert!(
        !h.killed.load(Ordering::SeqCst),
        "a follow-up must not mark the run killed"
    );
}

#[tokio::test]
async fn follow_up_with_an_image_carries_the_image_block_before_the_text() {
    let h = Harness::spawn("sink", 0);
    let png = base64::engine::general_purpose::STANDARD
        .decode(PNG_B64)
        .unwrap();
    std::fs::write(h.workspace().join("shot.png"), &png).unwrap();
    let wrote = send_follow_up_inner(
        &h.registry,
        "run-1",
        "claude",
        h.workspace(),
        "look at this",
        &["shot.png".to_string()],
    )
    .await
    .unwrap();
    assert!(wrote);
    let lines = h.finish().await;
    assert_eq!(lines.len(), 1, "{lines:?}");
    let content = parse(&lines[0])["message"]["content"].clone();
    assert_eq!(content[0]["type"], "image");
    assert_eq!(content[0]["source"]["type"], "base64");
    assert_eq!(content[0]["source"]["media_type"], "image/png");
    assert_eq!(content[0]["source"]["data"], PNG_B64);
    assert_eq!(content[1], json!({ "type": "text", "text": "look at this" }));
}

#[tokio::test]
async fn follow_up_failures_surface_and_write_nothing() {
    let h = Harness::spawn("sink", 0);
    // A missing image file is a real failure the user must see.
    let missing = send_follow_up_inner(
        &h.registry,
        "run-1",
        "claude",
        h.workspace(),
        "see attached",
        &["no-such-image.png".to_string()],
    )
    .await;
    assert!(missing.is_err(), "missing image must be Err: {missing:?}");
    // An image outside the workspace/pasted-images sandbox is refused too.
    let outside_dir = std::env::temp_dir().join(format!("ccgui-live-outside-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&outside_dir).unwrap();
    let outside = outside_dir.join("x.png");
    std::fs::write(
        &outside,
        base64::engine::general_purpose::STANDARD
            .decode(PNG_B64)
            .unwrap(),
    )
    .unwrap();
    let refused = send_follow_up_inner(
        &h.registry,
        "run-1",
        "claude",
        h.workspace(),
        "see attached",
        &[outside.to_string_lossy().to_string()],
    )
    .await;
    let _ = std::fs::remove_dir_all(&outside_dir);
    assert!(refused.is_err(), "outside image must be Err: {refused:?}");
    // Nothing to send is a caller error, not a silent success.
    let empty = send_follow_up_inner(&h.registry, "run-1", "claude", h.workspace(), "  ", &[]).await;
    assert!(empty.is_err(), "empty message must be Err: {empty:?}");
    let lines = h.finish().await;
    assert!(lines.is_empty(), "failed sends must write nothing: {lines:?}");
}

#[tokio::test]
async fn follow_up_answers_false_whenever_nothing_live_can_take_it() {
    let h = Harness::spawn("sink", 0);
    // Unknown run.
    assert!(!send_follow_up_inner(&h.registry, "no-such-run", "claude", h.workspace(), "hi", &[])
        .await
        .unwrap());
    // Not a claude run: the claude user-message frame must never reach
    // another engine's stdin.
    for engine in ["codex", "grok", "pi", ""] {
        assert!(
            !send_follow_up_inner(&h.registry, "run-1", engine, h.workspace(), "hi", &[])
                .await
                .unwrap(),
            "{engine:?} must not take a claude frame"
        );
    }
    // A virtual (host-stream) run keeps its own protocol on its stdin.
    let virtual_stdin: SharedStdin = Arc::new(TokioMutex::new(None));
    h.registry.insert(
        "virtual-run".into(),
        ChildEntry {
            child: None,
            pid: 4242,
            run_id: "virtual-run".into(),
            killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            reader_abort: Arc::new(std::sync::OnceLock::new()),
            stdin: Some(virtual_stdin),
            questions: Arc::new(Mutex::new(HashMap::new())),
            plans: Arc::new(Mutex::new(HashMap::new())),
            native_tasks: Default::default(),
            codex_control: None,
        },
    );
    assert!(
        !send_follow_up_inner(&h.registry, "virtual-run", "claude", h.workspace(), "hi", &[])
            .await
            .unwrap()
    );
    // A run the user already stopped is dying: the message would vanish.
    h.killed.store(true, Ordering::SeqCst);
    assert!(!send_follow_up_inner(&h.registry, "run-1", "claude", h.workspace(), "hi", &[])
        .await
        .unwrap());
    h.killed.store(false, Ordering::SeqCst);
    // Final Done already closed stdin.
    *h.stdin.lock().await = None;
    assert!(!send_follow_up_inner(&h.registry, "run-1", "claude", h.workspace(), "hi", &[])
        .await
        .unwrap());
    assert!(h.finish().await.is_empty());
}

#[tokio::test]
async fn follow_up_and_interrupt_answer_false_after_the_cli_hung_up() {
    let h = Harness::spawn("exit-now", 0);
    h.wait_for_exit().await;
    // The pipe still sits in the registry but nobody reads it: a broken pipe
    // is "nothing live" (fall back), not a user-visible write failure.
    let followed =
        send_follow_up_inner(&h.registry, "run-1", "claude", h.workspace(), "anyone?", &[]).await;
    assert_eq!(followed, Ok(false), "{followed:?}");
    let interrupted = interrupt_turn_inner(&h.registry, "run-1").await;
    assert_eq!(interrupted, Ok(false), "{interrupted:?}");
}

#[tokio::test]
async fn interrupt_writes_one_control_request_and_leaves_the_run_alive() {
    let h = Harness::spawn("sink", 0);
    assert!(interrupt_turn_inner(&h.registry, "run-1").await.unwrap());
    assert!(interrupt_turn_inner(&h.registry, "session-1").await.unwrap());
    // Unlike interrupt_session, the process and its tasks keep running.
    assert!(
        !h.killed.load(Ordering::SeqCst),
        "the native interrupt must not mark the run killed"
    );
    assert!(h.child.lock().await.try_wait().unwrap().is_none());
    let lines = h.finish().await;
    assert_eq!(lines.len(), 2, "{lines:?}");
    let frames: Vec<Value> = lines.iter().map(|l| parse(l)).collect();
    for frame in &frames {
        assert_eq!(frame["type"], "control_request");
        assert_eq!(frame["request"], json!({ "subtype": "interrupt" }));
        assert!(
            frame["request_id"]
                .as_str()
                .is_some_and(|id| id.starts_with(super::INTERRUPT_REQUEST_ID_PREFIX)),
            "{frame}"
        );
    }
    assert_ne!(
        frames[0]["request_id"], frames[1]["request_id"],
        "each interrupt needs its own request id to be acknowledged separately"
    );
}

#[tokio::test]
async fn interrupt_answers_false_when_nothing_live() {
    let h = Harness::spawn("sink", 0);
    assert!(!interrupt_turn_inner(&h.registry, "no-such-run").await.unwrap());
    h.killed.store(true, Ordering::SeqCst);
    assert!(!interrupt_turn_inner(&h.registry, "run-1").await.unwrap());
    h.killed.store(false, Ordering::SeqCst);
    *h.stdin.lock().await = None;
    assert!(!interrupt_turn_inner(&h.registry, "run-1").await.unwrap());
    assert!(h.finish().await.is_empty());
}

#[cfg(windows)]
#[tokio::test]
async fn interrupt_write_failure_surfaces_and_leaves_the_run_alive() {
    use std::os::windows::io::OwnedHandle;

    let h = Harness::spawn("sink", 0);
    let denied_path = h.workspace().join("read-only-input");
    std::fs::write(&denied_path, "fixture").unwrap();
    // A valid read-only handle produces an actual non-broken-pipe write
    // error. Keep the CLI's real stdin open so its process remains alive.
    let denied_handle: OwnedHandle = std::fs::File::open(&denied_path).unwrap().into();
    let denied_stdin = tokio::process::ChildStdin::from_std(denied_handle.into()).unwrap();
    let original_stdin = h.stdin.lock().await.replace(denied_stdin);
    let interrupted = interrupt_turn_inner(&h.registry, "run-1").await;
    assert!(
        matches!(&interrupted, Err(error) if error.contains("write to the session's stdin")),
        "a live process write failure must remain an error: {interrupted:?}"
    );
    assert!(!h.killed.load(Ordering::SeqCst));
    assert!(h.child.lock().await.try_wait().unwrap().is_none());
    *h.stdin.lock().await = original_stdin;
    assert!(interrupt_turn_inner(&h.registry, "run-1").await.unwrap());
    let lines = h.finish().await;
    assert_eq!(lines.len(), 1, "the retry must deliver one native interrupt");
    assert_eq!(parse(&lines[0])["request"], json!({ "subtype": "interrupt" }));
}

/// A follow-up, a question answer and an interrupt racing on one stdin must
/// each arrive as its own intact line: the writer mutex spans the whole
/// frame, so a multi-chunk message cannot be interleaved with a small one.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_frames_never_interleave() {
    let h = Harness::spawn("sink", 0);
    let big = "字🧪".repeat(150_000);
    let answer = json!({
        "type": "control_response",
        "response": { "subtype": "success", "request_id": "q-1", "response": { "behavior": "allow" } },
    })
    .to_string();
    const ROUNDS: usize = 8;
    for _ in 0..ROUNDS {
        let (a, b, c, d) = tokio::join!(
            send_follow_up_inner(&h.registry, "run-1", "claude", h.workspace(), &big, &[]),
            h.registry.write_line("session-1", answer.clone()),
            interrupt_turn_inner(&h.registry, "run-1"),
            send_follow_up_inner(&h.registry, "session-1", "claude", h.workspace(), "small", &[]),
        );
        assert_eq!(a, Ok(true));
        assert_eq!(b, Ok(()));
        assert_eq!(c, Ok(true));
        assert_eq!(d, Ok(true));
    }
    let lines = h.finish().await;
    assert_eq!(lines.len(), ROUNDS * 4);
    let (mut bigs, mut smalls, mut answers, mut interrupts) = (0, 0, 0, 0);
    for line in &lines {
        let frame = parse(line);
        match frame["type"].as_str().unwrap() {
            "user" if frame["message"]["content"][0]["text"] == big.as_str() => bigs += 1,
            "user" if frame["message"]["content"][0]["text"] == "small" => smalls += 1,
            "control_response" => answers += 1,
            "control_request" => interrupts += 1,
            other => panic!("unexpected frame {other}: {line:.200}"),
        }
    }
    assert_eq!((bigs, smalls, answers, interrupts), (ROUNDS, ROUNDS, ROUNDS, ROUNDS));
}

/// Stop must not hang behind a stalled pipe: a CLI that stopped reading while
/// a multi-MB follow-up still blocks the writer reports a retryable error.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn interrupt_does_not_wait_forever_behind_a_stalled_pipe() {
    let h = Harness::spawn("sink", 2500);
    let big = "x".repeat(6 * 1024 * 1024);
    let in_flight = tokio::time::timeout(
        Duration::from_millis(150),
        send_follow_up_inner(&h.registry, "run-1", "claude", h.workspace(), &big, &[]),
    )
    .await;
    assert!(in_flight.is_err(), "the follow-up must still be blocked in the pipe");
    let started = std::time::Instant::now();
    let interrupted = interrupt_turn_within(&h.registry, "run-1", Duration::from_millis(300)).await;
    assert!(
        matches!(&interrupted, Err(error) if error.contains("timed out") && error.contains("stdin")),
        "a stalled live process must remain an error: {interrupted:?}"
    );
    assert!(
        started.elapsed() < Duration::from_millis(1800),
        "Stop waited {:?} behind the stalled pipe",
        started.elapsed()
    );
    assert!(!h.killed.load(Ordering::SeqCst), "a timeout must not kill the CLI");
    assert!(h.child.lock().await.try_wait().unwrap().is_none());
    // The CLI recovers: the follow-up arrives whole (nothing was torn).
    let lines = h.finish().await;
    assert_eq!(parse(&lines[0])["message"]["content"][0]["text"], big.as_str());
}

/// A caller dropped mid-write (HTTP client gone, window closed) must not
/// leave half a JSON line in the pipe: the next frame would be glued onto it
/// and both would be lost. The CLI is busy (not reading) so the multi-MB
/// write is certainly still in flight when the caller is dropped.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_dropped_caller_does_not_leave_a_torn_frame_behind() {
    let h = Harness::spawn("sink", 600);
    let big = "x".repeat(6 * 1024 * 1024);
    let in_flight = tokio::time::timeout(
        Duration::from_millis(150),
        send_follow_up_inner(&h.registry, "run-1", "claude", h.workspace(), &big, &[]),
    )
    .await;
    assert!(
        in_flight.is_err(),
        "the write must still be in flight when the caller is dropped"
    );
    assert!(interrupt_turn_inner(&h.registry, "run-1").await.unwrap());
    let lines = h.finish().await;
    assert_eq!(lines.len(), 2, "torn frame glued to the next one: {} lines", lines.len());
    let first = parse(&lines[0]);
    assert_eq!(first["type"], "user");
    assert_eq!(first["message"]["content"][0]["text"], big.as_str());
    assert_eq!(parse(&lines[1])["type"], "control_request");
}
