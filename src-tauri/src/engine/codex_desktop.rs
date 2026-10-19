//! Hand a Codex turn to the Codex Desktop app that holds its thread.
//!
//! Codex lets one process write a thread at a time. While Codex Desktop has a
//! thread loaded, this app's own app-server cannot resume it and fails with
//! `thread <id> already has an active writer`. With Desktop hand-off enabled,
//! an ordinary chat send gives the message to Desktop over the channel it serves its
//! own `codex_app` tools on, and follows the Desktop turn by polling
//! `read_thread`. Desktop runs the turn with its own model, effort and
//! permissions; this app only reports status and shows what the turn produced.
//!
//! The channel is undocumented. On Windows it is a named pipe
//! `\\.\pipe\codex-browser-use-<uuid>` carrying JSON-RPC 2.0 frames, each a
//! little-endian u32 byte count followed by the JSON. Browser automation
//! shares the prefix, so a `tools/list` handshake picks the pipe that serves
//! the `codex_app` namespace. Each call opens its own connection and closes
//! it: following a long turn never holds one of Desktop's pipe instances.
//! Desktop records a message sent this way as a `send_message_to_thread`
//! output (`<codex_delegation>`), not as a typed user message; history reading
//! turns these deliveries back into user rows (see `history::extract`).

use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::time::timeout;

use super::SendRequest;

/// One frame's size cap in either direction. A busy turn's summary without
/// tool outputs stays far below it.
const MAX_FRAME: usize = 8 * 1024 * 1024;
/// One read, including Desktop's work for it.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// The send is never raced against a stop, so it must answer within the
/// registry's 10 s grace before a stopped run is aborted: past that, the
/// run could no longer report that the message may have been delivered.
const SEND_TIMEOUT: Duration = Duration::from_secs(8);
/// The catalog handshake that tells the app-tools pipe from the browser
/// pipes sharing its prefix; those answer quickly with an empty catalog.
const CATALOG_TIMEOUT: Duration = Duration::from_millis(700);
/// Turns a newest-first `read_thread` page carries: the turn that took the
/// message, plus room for a follow-up Desktop starts right after it.
const TURN_WINDOW: u64 = 3;
/// Pipe that answered last time, tried first.
static LAST_PIPE: Mutex<Option<String>> = Mutex::new(None);

/// Banner codes. The frontend localizes `[codex-desktop:<code>]`; the English
/// text stays for readers without the UI (Leader results, chat relays).
pub(super) mod code {
    pub const DISABLED: &str = "disabled";
    pub const IMAGES: &str = "images";
    pub const SETTINGS: &str = "settings";
    pub const UNAVAILABLE: &str = "unavailable";
    pub const ELSEWHERE: &str = "elsewhere";
    pub const WORKSPACE: &str = "workspace";
    pub const REJECTED: &str = "rejected";
    pub const UNKNOWN: &str = "unknown";
    pub const FAILED: &str = "failed";
    pub const INTERRUPTED: &str = "interrupted";
    pub const STOPPED: &str = "stopped";
    pub const TIMEOUT: &str = "timeout";
    pub const NOT_STARTED: &str = "not_started";
    pub const LOST: &str = "lost";
}

/// The terminal text for a hand-off outcome: `[codex-desktop:<code>] <text>`,
/// then Desktop's own words on the next line when it gave any.
pub(super) fn banner(code: &str, detail: Option<&str>) -> String {
    let text = match code {
        code::DISABLED => "Another execution host is using this thread. Codex Desktop hand-off is disabled in CC GUI, so the message was not handed over. Continue in that host, or close the thread there and retry.",
        code::IMAGES => "This thread is open in Codex Desktop, which can't take messages with images from CC GUI. Send it in Codex Desktop.",
        code::SETTINGS => "This thread is open in Codex Desktop. Plan mode, Manual permission, managed task scope, computer use and tool limits only apply when CC GUI runs the thread itself, so the message was not handed over.",
        code::UNAVAILABLE => "Another Codex client is using this thread, and no running Codex Desktop could take the message. Continue in that client, or close the thread there and retry.",
        code::ELSEWHERE => "This thread is open in another Codex client, not Codex Desktop. Continue there, or close the thread there and retry.",
        code::WORKSPACE => "Codex Desktop has this thread in a different folder from this chat, so the message was not handed over.",
        code::REJECTED => "Codex Desktop did not accept the message.",
        code::UNKNOWN => "CC GUI can't confirm that Codex Desktop received the message. It was not resent, so it won't run twice; check the thread in Codex Desktop.",
        code::FAILED => "The turn failed in Codex Desktop.",
        code::INTERRUPTED => "The turn was stopped in Codex Desktop.",
        code::STOPPED => "Stopped following in CC GUI. CC GUI can't confirm that the turn has finished; it may continue in Codex Desktop. Check the thread there and stop it if needed.",
        code::TIMEOUT => "CC GUI stopped following after 30 minutes and can't confirm that the turn has finished. The original task may continue in Codex Desktop; check the thread there.",
        code::NOT_STARTED => "Codex Desktop received the message but hasn't started on it. Check the thread in Codex Desktop.",
        code::LOST => "Lost the connection to Codex Desktop after it received the message. CC GUI can't confirm that the turn has finished; check the thread in Codex Desktop.",
        _ => "Codex Desktop could not take the message.",
    };
    match detail.map(str::trim).filter(|detail| !detail.is_empty()) {
        Some(detail) => format!("[codex-desktop:{code}] {text}\n{detail}"),
        None => format!("[codex-desktop:{code}] {text}"),
    }
}

/// The resume failure that means another process holds the thread's single
/// writer slot, as the app-server driver reports it:
/// `rpc:<code>:thread <id> already has an active writer`.
pub(super) fn held_elsewhere(error: &str, thread_id: &str) -> bool {
    error
        .strip_prefix("rpc:")
        .and_then(|rest| rest.split_once(':'))
        .is_some_and(|(_, message)| {
            message.trim() == format!("thread {thread_id} already has an active writer")
        })
}

/// What only this app's own launch can honor. Desktop takes a prompt and
/// keeps its own settings, so these fail closed instead of being dropped.
pub(super) fn unsupported(req: &SendRequest) -> Option<&'static str> {
    if !req.images.is_empty() {
        return Some(code::IMAGES);
    }
    // Desktop owns its instructions. Only known optional host hints can be
    // omitted; real managed-task scopes and custom guidance cannot be handed off.
    let restricted = matches!(req.permission.as_deref(), Some("manual" | "plan"))
        || super::parse_compact_prompt(&req.prompt).is_some()
        // Desktop keeps its own permissions, which this bridge cannot prove
        // are Auto-review. An automatic handoff must not turn a sandboxed
        // auto run into a full-access run behind the user's selection.
        || super::codex_auto_review::enabled(req.permission.as_deref())
        || super::codex_read_only::requested(req)
        || super::host_instructions::requires_local_host(req.host_instructions.as_deref())
        || req.allowed_tools.is_some()
        || req.computer_use == Some(true);
    restricted.then_some(code::SETTINGS)
}

/// Whether Desktop's working directory for the thread is this chat's folder.
pub(super) fn same_folder(desktop: &str, workspace: &Path) -> bool {
    if let (Ok(a), Ok(b)) = (std::fs::canonicalize(desktop), std::fs::canonicalize(workspace)) {
        return a == b;
    }
    let normalize = |path: &str| {
        let path = path.replace('/', "\\");
        let path = path.trim_end_matches('\\').to_string();
        if cfg!(windows) { path.to_lowercase() } else { path }
    };
    normalize(desktop) == normalize(&workspace.to_string_lossy())
}

/// The model and effort Desktop last ran this thread with, from the newest
/// `turn_context` in its rollout. The hand-off carries no override, so
/// Desktop keeps them unless its composer changed since that turn, and the
/// rows can be labelled with what actually ran. The newest context sits near
/// the end: only a long final turn pushes it out of the scanned tail, and
/// then the whole file is read. Compressed cold rollouts are streamed because
/// their compressed byte offsets cannot be used to seek to JSONL records.
pub(super) fn recorded_settings(rollout: &Path) -> (Option<String>, Option<String>) {
    use std::io::{BufRead, Seek, SeekFrom};
    const TAIL: u64 = 4 * 1024 * 1024;
    let rollout = crate::history::codex_rollout::resolve_path(rollout);
    let read_stream = || {
        crate::history::codex_rollout::open_reader(&rollout)
            .map(newest_turn_context)
            .unwrap_or((None, None))
    };
    if crate::history::codex_rollout::is_compressed(&rollout) {
        return read_stream();
    }
    let mut file = match std::fs::File::open(&rollout) {
        Ok(file) => file,
        // The compressor may publish .zst between resolution and open.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return read_stream(),
        Err(_) => return (None, None),
    };
    let length = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    if length > TAIL && file.seek(SeekFrom::Start(length - TAIL)).is_ok() {
        let mut tail = std::io::BufReader::new(&mut file);
        // The seek lands mid-line; that fragment is not a record.
        let _ = tail.read_until(b'\n', &mut Vec::new());
        let found = newest_turn_context(tail);
        if found.0.is_some() {
            return found;
        }
    }
    if file.seek(SeekFrom::Start(0)).is_err() {
        return (None, None);
    }
    newest_turn_context(std::io::BufReader::new(file))
}

fn newest_turn_context(reader: impl std::io::BufRead) -> (Option<String>, Option<String>) {
    let mut found = (None, None);
    for line in reader.lines() {
        let Ok(line) = line else {
            return (None, None);
        };
        if !line.contains("\"turn_context\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value["type"] != "turn_context" {
            continue;
        }
        let payload = &value["payload"];
        if let Some(model) = payload["model"].as_str() {
            let effort = payload["effort"]
                .as_str()
                .or_else(|| payload.pointer("/collaboration_mode/settings/reasoning_effort")?.as_str());
            found = (Some(model.to_string()), effort.map(str::to_string));
        }
    }
    found
}

// ==================== thread snapshots ====================

/// One `read_thread` reading: the thread's state and its newest turns.
#[derive(Debug, Clone, Default)]
pub(super) struct Snapshot {
    /// `idle` | `active` | `notLoaded` | …; anything but `notLoaded` means
    /// Desktop has the thread loaded, which makes it the writer.
    pub status: String,
    /// `activeFlags` of an active thread (`waitingOnApproval`, …).
    pub flags: Vec<String>,
    pub cwd: String,
    /// Newest first, as `read_thread` pages them.
    pub turns: Vec<Turn>,
}

#[derive(Debug, Clone)]
pub(super) struct Turn {
    pub id: String,
    pub status: String,
    pub error: Option<String>,
    pub items: Vec<Value>,
}

fn parse_snapshot(value: &Value, thread_id: &str) -> Result<Snapshot, String> {
    let thread = &value["thread"];
    if thread["id"].as_str() != Some(thread_id) {
        return Err("Codex Desktop answered for a different thread".into());
    }
    let turns = value["turns"]
        .as_array()
        .map(|turns| {
            turns
                .iter()
                .filter_map(|turn| {
                    Some(Turn {
                        id: turn["id"].as_str()?.to_string(),
                        status: turn["status"].as_str().unwrap_or_default().to_string(),
                        error: turn["error"]
                            .as_str()
                            .or_else(|| turn.pointer("/error/message")?.as_str())
                            .map(str::to_string),
                        items: turn["items"].as_array().cloned().unwrap_or_default(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(Snapshot {
        status: thread
            .pointer("/status/type")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        flags: thread
            .pointer("/status/activeFlags")
            .and_then(Value::as_array)
            .map(|flags| flags.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default(),
        cwd: thread["cwd"].as_str().unwrap_or_default().to_string(),
        turns,
    })
}

fn terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "interrupted")
}

/// Item kinds rendered as tool rows: opened when first seen, closed with
/// their result once finished.
const TOOL_ITEMS: [&str; 6] = [
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "dynamicToolCall",
    "webSearch",
    "imageGeneration",
];

/// Where a followed Desktop turn stands, as the tail indicator shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Stage {
    Delivering,
    Waiting,
    Running,
    Approval,
    Input,
}

impl Stage {
    pub(super) fn as_str(self) -> &'static str {
        match self {
            Stage::Delivering => "delivering",
            Stage::Waiting => "waiting",
            Stage::Running => "running",
            Stage::Approval => "approval",
            Stage::Input => "input",
        }
    }
}

/// One projection step for an item the Desktop turn produced, in the shape
/// the app-server driver's item handler already renders.
#[derive(Debug)]
pub(super) enum Step {
    Open(Value),
    Close(Value),
}

#[derive(Debug, PartialEq)]
pub(super) enum Settled {
    Completed,
    Failed(Option<String>),
    Interrupted,
}

/// How Desktop records a delivered message in the turn that takes it.
fn delivery_item(item: &Value) -> bool {
    item["type"] == "functionCallOutput" && item["name"] == "send_message_to_thread"
}

/// Follows the Desktop turn that takes a delivered message, reading by
/// reading. Desktop records the delivery as a new `send_message_to_thread`
/// output: at the start of a new turn when the thread was idle or the message
/// waited in Desktop's queue, or inside the running turn when it was folded
/// in. That turn is ours, and only what follows the delivery in it is
/// projected: each item once, text only when it can no longer grow. Turns
/// Desktop runs for anything else are left alone.
pub(super) struct Follow {
    /// Turns and items that existed at delivery.
    known_turns: HashSet<String>,
    handled: HashSet<String>,
    /// The thread was idle at delivery, so a new turn that is not someone
    /// typing in Desktop is ours even without a visible delivery item.
    idle: bool,
    ours: Option<String>,
    open: HashSet<String>,
}

impl Follow {
    pub(super) fn new(at_delivery: &Snapshot) -> Self {
        Self {
            known_turns: at_delivery.turns.iter().map(|turn| turn.id.clone()).collect(),
            handled: at_delivery
                .turns
                .iter()
                .flat_map(|turn| &turn.items)
                .filter_map(|item| item["id"].as_str().map(str::to_string))
                .collect(),
            idle: at_delivery.status != "active",
            ours: None,
            open: HashSet::new(),
        }
    }

    /// Desktop took the message: its turn was found.
    pub(super) fn started(&self) -> bool {
        self.ours.is_some()
    }

    fn find_ours(&mut self, now: &Snapshot) {
        let oldest_first = || now.turns.iter().rev();
        let new_item = |item: &Value| item["id"].as_str().is_some_and(|id| !self.handled.contains(id));
        let found = oldest_first().find_map(|turn| {
            let at = turn.items.iter().position(|item| delivery_item(item) && new_item(item))?;
            Some((turn, at + 1))
        });
        let found = found.or_else(|| {
            let fresh = oldest_first().find(|turn| !self.known_turns.contains(&turn.id))?;
            let typed = fresh.items.iter().any(|item| item["type"] == "userMessage");
            (self.idle && !typed).then_some((fresh, 0))
        });
        if let Some((turn, skip)) = found {
            // What ran before the delivery belongs to earlier work.
            let earlier = turn.items[..skip].iter().filter_map(|item| item["id"].as_str());
            self.handled.extend(earlier.map(str::to_string));
            self.ours = Some(turn.id.clone());
        }
    }

    pub(super) fn advance(&mut self, now: &Snapshot) -> (Vec<Step>, Stage, Option<Settled>) {
        if self.ours.is_none() {
            self.find_ours(now);
        }
        let mut steps = Vec::new();
        let turn = self.ours.as_ref().and_then(|id| now.turns.iter().find(|turn| turn.id == *id));
        if let Some(turn) = turn {
            let ended = terminal(&turn.status);
            for (index, item) in turn.items.iter().enumerate() {
                let Some(id) = item["id"].as_str() else {
                    continue;
                };
                if self.handled.contains(id) {
                    continue;
                }
                let later = index + 1 < turn.items.len();
                match item["type"].as_str().unwrap_or_default() {
                    "agentMessage" | "reasoning" => {
                        if ended || later {
                            steps.push(Step::Close(item.clone()));
                            self.handled.insert(id.to_string());
                        }
                    }
                    kind if TOOL_ITEMS.contains(&kind) => {
                        if self.open.insert(id.to_string()) {
                            steps.push(Step::Open(item.clone()));
                        }
                        let finished = match item["status"].as_str() {
                            Some("inProgress" | "pending") => ended,
                            Some(_) => true,
                            None => ended || later,
                        };
                        if finished {
                            steps.push(Step::Close(item.clone()));
                            self.open.remove(id);
                            self.handled.insert(id.to_string());
                        }
                    }
                    // Inputs (other deliveries, typed messages) and kinds
                    // this app does not render.
                    _ => {
                        self.handled.insert(id.to_string());
                    }
                }
            }
        }
        let active = now.status == "active";
        let flagged = |flag: &str| active && now.flags.iter().any(|f| f == flag);
        // Approval or input owed on an earlier turn holds the message too.
        let stage = if flagged("waitingOnApproval") {
            Stage::Approval
        } else if flagged("waitingOnUserInput") {
            Stage::Input
        } else if self.started() {
            Stage::Running
        } else {
            Stage::Waiting
        };
        let settled = turn.filter(|turn| terminal(&turn.status)).map(|turn| match turn.status.as_str() {
            "completed" => Settled::Completed,
            "failed" => Settled::Failed(turn.error.clone()),
            _ => Settled::Interrupted,
        });
        (steps, stage, settled)
    }
}

// ==================== transport ====================

pub(super) trait Duplex: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Duplex for T {}

/// A transport or protocol failure. `uncertain` once a write may have
/// reached Desktop: an absent answer then is no permission to resend.
#[derive(Debug)]
pub(super) struct LinkError {
    pub message: String,
    pub uncertain: bool,
    /// Desktop said it has no such thread, before touching any.
    pub missing_thread: bool,
}

impl LinkError {
    fn new(message: impl Into<String>, uncertain: bool) -> Self {
        Self { message: message.into(), uncertain, missing_thread: false }
    }
}

struct Client {
    stream: Box<dyn Duplex>,
    next_id: u64,
    thread_id: String,
}

impl Client {
    async fn request(&mut self, method: &str, params: Value, writing: bool) -> Result<Value, LinkError> {
        self.next_id += 1;
        let id = self.next_id;
        let frame = serde_json::to_vec(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))
            .map_err(|error| LinkError::new(format!("encode {method}: {error}"), false))?;
        if frame.len() > MAX_FRAME {
            return Err(LinkError::new("the message is larger than Codex Desktop accepts", false));
        }
        let stream = &mut self.stream;
        let exchange = async {
            let failed = |error: std::io::Error| LinkError::new(format!("Codex Desktop connection: {error}"), writing);
            stream.write_all(&(frame.len() as u32).to_le_bytes()).await.map_err(failed)?;
            stream.write_all(&frame).await.map_err(failed)?;
            stream.flush().await.map_err(failed)?;
            loop {
                let length = stream.read_u32_le().await.map_err(failed)? as usize;
                if length > MAX_FRAME {
                    return Err(LinkError::new("Codex Desktop answered beyond the frame limit", writing));
                }
                let mut body = vec![0; length];
                stream.read_exact(&mut body).await.map_err(failed)?;
                let value: Value = serde_json::from_slice(&body)
                    .map_err(|_| LinkError::new("Codex Desktop answered with unreadable data", writing))?;
                if value["id"].as_u64() != Some(id) {
                    continue;
                }
                if let Some(error) = value.get("error") {
                    // Malformed or unknown requests are refused before anything runs.
                    let refused = matches!(error["code"].as_i64(), Some(-32602..=-32600));
                    let message = error["message"].as_str().unwrap_or("Codex Desktop refused the request");
                    return Err(LinkError::new(message.chars().take(500).collect::<String>(), writing && !refused));
                }
                return value
                    .get("result")
                    .cloned()
                    .ok_or_else(|| LinkError::new("Codex Desktop returned no result", writing));
            }
        };
        timeout(if writing { SEND_TIMEOUT } else { REQUEST_TIMEOUT }, exchange)
            .await
            .unwrap_or_else(|_| Err(LinkError::new(format!("Codex Desktop did not answer {method} in time"), writing)))
    }

    async fn catalog_serves_app_tools(&mut self) -> bool {
        let Ok(Ok(catalog)) = timeout(
            CATALOG_TIMEOUT,
            self.request("tools/list", json!({"threadStartKind": "all"}), false),
        )
        .await
        else {
            return false;
        };
        let tools = catalog["tools"].as_array();
        ["read_thread", "send_message_to_thread"].iter().all(|name| {
            tools.is_some_and(|tools| {
                tools.iter().any(|tool| tool["namespace"] == "codex_app" && tool["name"] == *name)
            })
        })
    }

    async fn tool(&mut self, name: &str, arguments: Value, writing: bool) -> Result<Value, LinkError> {
        let call = format!("ccgui-{}", uuid::Uuid::new_v4());
        let result = self
            .request(
                "tools/call",
                json!({
                    "namespace": "codex_app",
                    "tool": name,
                    "callerSource": "codex",
                    // Desktop requires an existing caller thread. The target is
                    // the only one this app can name; Spellcast does the same.
                    "threadId": self.thread_id,
                    "turnId": call,
                    "callId": call,
                    "arguments": arguments,
                }),
                writing,
            )
            .await?;
        let text = result["contentItems"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["type"] == "inputText"))
            .and_then(|item| item["text"].as_str())
            .unwrap_or_default();
        if result["success"] != true {
            // Desktop answers this before it touches any thread.
            let missing = text.starts_with(&format!("No Codex thread found for threadId: {}.", self.thread_id));
            let message = if text.is_empty() { "Codex Desktop did not accept the request" } else { text };
            return Err(LinkError {
                message: message.chars().take(500).collect(),
                uncertain: writing && !missing,
                missing_thread: missing,
            });
        }
        serde_json::from_str(text).map_err(|_| LinkError::new("Codex Desktop returned an unreadable result", writing))
    }

    async fn read(&mut self) -> Result<Snapshot, LinkError> {
        let thread_id = self.thread_id.clone();
        let value = self
            .tool(
                "read_thread",
                json!({"threadId": thread_id, "hostId": "local", "turnLimit": TURN_WINDOW,
                    "includeOutputs": false, "maxOutputCharsPerItem": 0}),
                false,
            )
            .await?;
        parse_snapshot(&value, &thread_id).map_err(|message| LinkError::new(message, false))
    }

    async fn send(&mut self, prompt: &str) -> Result<(), LinkError> {
        let thread_id = self.thread_id.clone();
        // No model or effort: Desktop keeps the thread's own settings.
        let result = self
            .tool(
                "send_message_to_thread",
                json!({"threadId": thread_id, "hostId": "local", "prompt": prompt}),
                true,
            )
            .await?;
        if result["threadId"].as_str() != Some(thread_id.as_str()) {
            return Err(LinkError::new("Codex Desktop confirmed a different thread", true));
        }
        Ok(())
    }
}

/// Pipes that may serve Desktop's app tools, the last one that did first.
/// Test builds never reach the user's real Desktop: fixtures see only the
/// fakes they registered, and unit tests see none.
fn candidates() -> Vec<String> {
    #[cfg(feature = "test-harness")]
    {
        crate::test_harness::codex_desktop_pipes().unwrap_or_default()
    }
    #[cfg(not(feature = "test-harness"))]
    {
        if cfg!(test) {
            Vec::new()
        } else {
            discover()
        }
    }
}

#[cfg_attr(feature = "test-harness", allow(dead_code))]
fn discover() -> Vec<String> {
    #[allow(unused_mut)]
    let mut pipes: Vec<String> = Vec::new();
    #[cfg(windows)]
    if let Ok(entries) = std::fs::read_dir(r"\\.\pipe\") {
        pipes = entries
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| {
                name.strip_prefix("codex-browser-use-")
                    .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
            })
            .map(|name| format!(r"\\.\pipe\{name}"))
            .collect();
        pipes.sort();
    }
    if let Some(last) = LAST_PIPE.lock().unwrap_or_else(|error| error.into_inner()).clone() {
        if let Some(index) = pipes.iter().position(|pipe| *pipe == last) {
            pipes.remove(index);
            pipes.insert(0, last);
        }
    }
    pipes
}

#[cfg(windows)]
fn open(path: &str) -> Option<Box<dyn Duplex>> {
    tokio::net::windows::named_pipe::ClientOptions::new()
        .open(path)
        .ok()
        .map(|pipe| Box::new(pipe) as Box<dyn Duplex>)
}

#[cfg(not(windows))]
fn open(_path: &str) -> Option<Box<dyn Duplex>> {
    None
}

/// Why Desktop could not be reached for the thread.
#[derive(Debug)]
pub(super) enum Unreachable {
    /// No running Desktop answered as the app-tools channel.
    NoDesktop(Option<String>),
    /// Desktop answered but does not know this thread.
    UnknownThread,
}

/// The Desktop channel that answered for one thread.
pub(super) struct Desktop {
    path: String,
    thread_id: String,
}

impl Desktop {
    /// Find the pipe that serves `codex_app` and knows the thread, and read
    /// the thread there.
    pub(super) async fn find(thread_id: &str) -> Result<(Self, Snapshot), Unreachable> {
        let mut last = None;
        let mut unknown = false;
        for path in candidates() {
            let Some(stream) = open(&path) else { continue };
            let mut client = Client { stream, next_id: 0, thread_id: thread_id.to_string() };
            if !client.catalog_serves_app_tools().await {
                continue;
            }
            match client.read().await {
                Ok(snapshot) => {
                    *LAST_PIPE.lock().unwrap_or_else(|error| error.into_inner()) = Some(path.clone());
                    return Ok((Self { path, thread_id: thread_id.to_string() }, snapshot));
                }
                Err(error) if error.missing_thread => unknown = true,
                Err(error) => last = Some(error.message),
            }
        }
        Err(if unknown { Unreachable::UnknownThread } else { Unreachable::NoDesktop(last) })
    }

    fn connect(&self) -> Result<Client, LinkError> {
        let stream = open(&self.path).ok_or_else(|| LinkError::new("Codex Desktop's channel is gone", false))?;
        Ok(Client { stream, next_id: 0, thread_id: self.thread_id.clone() })
    }

    pub(super) async fn read(&self) -> Result<Snapshot, LinkError> {
        self.connect()?.read().await
    }

    pub(super) async fn send(&self, prompt: &str) -> Result<(), LinkError> {
        self.connect()?.send(prompt).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const THREAD: &str = "01a100bc-fdfa-7dd1-b02a-cf2a51383059";

    fn snapshot(status: &str, flags: &[&str], turns: Value) -> Snapshot {
        parse_snapshot(
            &json!({"thread": {"id": THREAD, "cwd": "G:\\Work", "status": {"type": status, "activeFlags": flags}}, "turns": turns}),
            THREAD,
        )
        .unwrap()
    }

    fn texts(steps: &[Step]) -> Vec<String> {
        steps
            .iter()
            .map(|step| match step {
                Step::Open(item) => format!("open {}", item["id"].as_str().unwrap()),
                Step::Close(item) => format!("close {}", item["id"].as_str().unwrap()),
            })
            .collect()
    }

    #[test]
    fn only_the_exact_writer_conflict_for_this_thread_hands_off() {
        let error = format!("rpc:-32600:thread {THREAD} already has an active writer");
        assert!(held_elsewhere(&error, THREAD));
        assert!(!held_elsewhere(&error, "01a100af-7c19-7ed0-89db-7751484da4db"));
        assert!(!held_elsewhere(&format!("thread {THREAD} already has an active writer"), THREAD));
        assert!(!held_elsewhere("rpc:-32600:thread not found", THREAD));
    }

    #[test]
    fn banners_carry_their_code_and_keep_desktop_detail_on_its_own_line() {
        assert!(banner(code::STOPPED, None).starts_with("[codex-desktop:stopped] Stopped following"));
        assert_eq!(banner(code::FAILED, Some("  upstream 502 ")).lines().nth(1), Some("upstream 502"));
        assert_eq!(banner(code::FAILED, Some(" ")).lines().count(), 1);
    }

    #[test]
    fn settings_only_this_app_can_honor_are_refused() {
        let base = SendRequest {
            claude_ultracode: None,
            host_instructions: None,
            session_id: Some(THREAD.into()),
            workspace: "G:/Work".into(),
            prompt: "好的".into(),
            images: Vec::new(),
            model: None,
            effort: None,
            service_tier: None,
            permission: Some("bypass".into()),
            additional_dirs: Vec::new(),
            provider_id: None,
            computer_use: None,
            allowed_tools: None,
        };
        assert_eq!(unsupported(&base), None);
        assert_eq!(unsupported(&SendRequest { host_instructions: Some(String::new()), ..base.clone() }), None);
        assert_eq!(unsupported(&SendRequest { host_instructions: crate::engine::host_instructions::with_chat_presentation("codex", true, None), ..base.clone() }), None);
        assert_eq!(unsupported(&SendRequest { host_instructions: crate::engine::host_instructions::with_chat_presentation("codex", true, Some(crate::leader::unscoped_task_instructions())), ..base.clone() }), None);
        assert_eq!(unsupported(&SendRequest { images: vec!["shot.png".into()], ..base.clone() }), Some(code::IMAGES));
        for req in [
            SendRequest { permission: Some("auto".into()), ..base.clone() },
            SendRequest { permission: None, ..base.clone() },
            SendRequest { permission: Some("manual".into()), ..base.clone() },
            SendRequest { permission: Some("plan".into()), ..base.clone() },
            SendRequest { permission: Some(super::super::codex_read_only::PERMISSION.into()), ..base.clone() },
            SendRequest { host_instructions: Some("You are this chat's Leader.".into()), ..base.clone() },
            SendRequest { host_instructions: Some(crate::leader::owned_task_instructions()), ..base.clone() },
            SendRequest { allowed_tools: Some(Vec::new()), ..base.clone() },
            SendRequest { computer_use: Some(true), ..base.clone() },
        ] {
            assert_eq!(unsupported(&req), Some(code::SETTINGS));
        }
    }

    #[test]
    fn a_snapshot_for_another_thread_is_rejected() {
        let value = json!({"thread": {"id": "other", "status": {"type": "idle"}}, "turns": []});
        assert!(parse_snapshot(&value, THREAD).is_err());
        let failed = snapshot("idle", &[], json!([{"id": "t1", "status": "failed", "error": {"message": "upstream 502"}, "items": []}]));
        assert_eq!(failed.turns[0].error.as_deref(), Some("upstream 502"));
    }

    fn delivery(id: &str) -> Value {
        json!({"type": "functionCallOutput", "id": id, "name": "send_message_to_thread", "namespace": "codex_app"})
    }

    #[test]
    fn an_idle_thread_projects_only_the_new_turn_once_and_settles_on_it() {
        // Two finished turns in the window: neither counts as Desktop starting.
        let before = snapshot("idle", &[], json!([
            {"id": "t0", "status": "completed", "items": [
                {"type": "userMessage", "id": "u0"}, {"type": "agentMessage", "id": "a0", "text": "old"}]},
            {"id": "t-1", "status": "completed", "items": [{"type": "agentMessage", "id": "a-1", "text": "older"}]}]));
        let mut follow = Follow::new(&before);
        let (steps, stage, settled) = follow.advance(&before);
        assert!(steps.is_empty());
        assert_eq!((stage, settled), (Stage::Waiting, None));
        assert!(!follow.started());

        let running = snapshot("active", &[], json!([
            {"id": "t1", "status": "inProgress", "items": [
                delivery("f1"),
                {"type": "agentMessage", "id": "a1", "text": "looking"},
                {"type": "commandExecution", "id": "c1", "command": "git status", "status": "inProgress"},
                {"type": "agentMessage", "id": "a2", "text": "still grow"}]},
            {"id": "t0", "status": "completed", "items": [{"type": "agentMessage", "id": "a0", "text": "old"}]}]));
        let (steps, stage, settled) = follow.advance(&running);
        assert_eq!(texts(&steps), ["close a1", "open c1"]);
        assert_eq!((stage, settled), (Stage::Running, None));

        let done = snapshot("idle", &[], json!([
            {"id": "t1", "status": "completed", "items": [
                delivery("f1"),
                {"type": "agentMessage", "id": "a1", "text": "looking"},
                {"type": "commandExecution", "id": "c1", "command": "git status", "status": "completed", "exitCode": 0},
                {"type": "agentMessage", "id": "a2", "text": "done"}]},
            {"id": "t0", "status": "completed", "items": []}]));
        let (steps, _, settled) = follow.advance(&done);
        assert_eq!(texts(&steps), ["close c1", "close a2"]);
        assert_eq!(settled, Some(Settled::Completed));
        assert!(follow.advance(&done).0.is_empty(), "items project once");
    }

    #[test]
    fn a_message_queued_behind_a_busy_turn_settles_on_its_own_turn() {
        let busy = snapshot("active", &[], json!([{"id": "t0", "status": "inProgress", "items": [
            {"type": "agentMessage", "id": "a0", "text": "earlier work"}]}]));
        let mut follow = Follow::new(&busy);
        assert!(!follow.started());
        // The earlier turn ends and Desktop takes its time to start ours:
        // neither its leftovers nor any number of quiet readings settle it.
        let quiet = snapshot("idle", &[], json!([{"id": "t0", "status": "completed", "items": [
            {"type": "agentMessage", "id": "a0", "text": "earlier work"},
            {"type": "agentMessage", "id": "a1", "text": "earlier answer"}]}]));
        for _ in 0..3 {
            let (steps, stage, settled) = follow.advance(&quiet);
            assert!(steps.is_empty());
            assert_eq!((stage, settled), (Stage::Waiting, None));
        }
        // Desktop's own queued follow-up runs first; it is not ours.
        let typed = snapshot("active", &[], json!([
            {"id": "t1", "status": "inProgress", "items": [
                {"type": "userMessage", "id": "u1"}, {"type": "agentMessage", "id": "a2", "text": "their reply"}]},
            {"id": "t0", "status": "completed", "items": []}]));
        let (steps, stage, settled) = follow.advance(&typed);
        assert!(steps.is_empty());
        assert_eq!((stage, settled), (Stage::Waiting, None));
        let typed_done = snapshot("idle", &[], json!([
            {"id": "t1", "status": "completed", "items": [{"type": "userMessage", "id": "u1"}]},
            {"id": "t0", "status": "completed", "items": []}]));
        assert_eq!(follow.advance(&typed_done).2, None);
        let ours = snapshot("idle", &[], json!([
            {"id": "t2", "status": "completed", "items": [delivery("f2"), {"type": "agentMessage", "id": "a3", "text": "answer"}]},
            {"id": "t1", "status": "completed", "items": []},
            {"id": "t0", "status": "completed", "items": []}]));
        let (steps, _, settled) = follow.advance(&ours);
        assert_eq!(texts(&steps), ["close a3"]);
        assert_eq!(settled, Some(Settled::Completed));
    }

    #[test]
    fn a_message_folded_into_the_running_turn_projects_only_what_follows_it() {
        let busy = snapshot("active", &[], json!([{"id": "t0", "status": "inProgress", "items": [
            {"type": "agentMessage", "id": "a0", "text": "earlier work"}]}]));
        let mut follow = Follow::new(&busy);
        let steered = snapshot("active", &[], json!([{"id": "t0", "status": "inProgress", "items": [
            {"type": "agentMessage", "id": "a0", "text": "earlier work"},
            {"type": "agentMessage", "id": "a1", "text": "before the message arrived"},
            delivery("f1"),
            {"type": "agentMessage", "id": "a2", "text": "taking it into account"},
            {"type": "commandExecution", "id": "c1", "command": "cargo test", "status": "inProgress"}]}]));
        let (steps, stage, settled) = follow.advance(&steered);
        assert_eq!(texts(&steps), ["close a2", "open c1"]);
        assert_eq!((stage, settled), (Stage::Running, None));
        let finished = snapshot("idle", &[], json!([{"id": "t0", "status": "completed", "items": [
            delivery("f1"),
            {"type": "commandExecution", "id": "c1", "command": "cargo test", "status": "failed", "exitCode": 1},
            {"type": "agentMessage", "id": "a3", "text": "done"}]}]));
        let (steps, _, settled) = follow.advance(&finished);
        assert_eq!(texts(&steps), ["close c1", "close a3"]);
        assert_eq!(settled, Some(Settled::Completed));
    }

    #[test]
    fn attention_flags_and_failed_or_interrupted_turns_are_reported() {
        let before = snapshot("idle", &[], json!([{"id": "t0", "status": "completed", "items": []}]));
        let mut follow = Follow::new(&before);
        // Approval owed on another turn holds the message as well.
        let held = snapshot("active", &["waitingOnApproval"], json!([{"id": "t0", "status": "inProgress", "items": []}]));
        assert_eq!(follow.advance(&held).1, Stage::Approval);
        assert!(!follow.started());
        // A new turn nobody typed in Desktop is ours even without a visible delivery item.
        let input = snapshot("active", &["waitingOnUserInput"], json!([{"id": "t1", "status": "inProgress", "items": []}]));
        assert_eq!(follow.advance(&input).1, Stage::Input);
        assert!(follow.started());
        let failed = snapshot("idle", &[], json!([{"id": "t1", "status": "failed", "error": "quota", "items": []}]));
        assert_eq!(follow.advance(&failed).2, Some(Settled::Failed(Some("quota".into()))));
        let mut follow = Follow::new(&before);
        let interrupted = snapshot("notLoaded", &[], json!([{"id": "t1", "status": "interrupted", "items": [delivery("f1")]}]));
        assert_eq!(follow.advance(&interrupted).2, Some(Settled::Interrupted));
    }

    #[test]
    fn a_long_rollout_is_read_from_its_tail_and_whole_when_the_tail_lacks_a_context() {
        let dir = std::env::temp_dir().join(format!("ccgui-desktop-tail-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let context = |model: &str| json!({"type": "turn_context", "payload": {"model": model, "effort": "high"}}).to_string();
        let filler = json!({"type": "event_msg", "payload": {"type": "agent_message", "message": "x".repeat(1024 * 1024)}}).to_string();
        let tail_hit = dir.join("tail.jsonl");
        std::fs::write(&tail_hit, [context("old"), filler.clone(), filler.clone(), filler.clone(), filler.clone(), context("new")].join("\n")).unwrap();
        assert_eq!(recorded_settings(&tail_hit).0.as_deref(), Some("new"));
        let head_only = dir.join("head.jsonl");
        std::fs::write(&head_only, [context("only"), filler.clone(), filler.clone(), filler.clone(), filler.clone(), filler].join("\n")).unwrap();
        assert_eq!(recorded_settings(&head_only).0.as_deref(), Some("only"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_newest_turn_context_names_desktop_settings() {
        let dir = std::env::temp_dir().join(format!("ccgui-desktop-settings-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let rollout = dir.join("rollout.jsonl");
        std::fs::write(&rollout, [
            json!({"type": "turn_context", "payload": {"model": "gpt-6-sol", "effort": "low"}}).to_string(),
            json!({"type": "event_msg", "payload": {"type": "agent_message", "message": "\"turn_context\""}}).to_string(),
            json!({"type": "turn_context", "payload": {"model": "gpt-6.1-sol", "collaboration_mode": {"settings": {"reasoning_effort": "high"}}}}).to_string(),
        ].join("\n")).unwrap();
        assert_eq!(recorded_settings(&rollout), (Some("gpt-6.1-sol".into()), Some("high".into())));
        assert_eq!(recorded_settings(&dir.join("missing.jsonl")), (None, None));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn compressed_rollout_settings_follow_the_current_representation() {
        let dir = std::env::temp_dir().join(format!("ccgui-desktop-zstd-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let raw = dir.join("rollout.jsonl");
        let compressed = dir.join("rollout.jsonl.zst");
        let context = |model: &str, effort: &str| {
            json!({"type": "turn_context", "payload": {"model": model, "effort": effort}}).to_string()
        };
        let input = [context("old", "low"), context("compressed", "high")].join("\n") + "\n";
        let encoded = zstd::stream::encode_all(input.as_bytes(), 1).unwrap();
        std::fs::write(&compressed, &encoded).unwrap();
        let expected = (Some("compressed".into()), Some("high".into()));
        assert_eq!(recorded_settings(&raw), expected);
        assert_eq!(recorded_settings(&compressed), expected);

        std::fs::write(&raw, context("resumed", "medium") + "\n").unwrap();
        assert_eq!(recorded_settings(&compressed), (Some("resumed".into()), Some("medium".into())));
        std::fs::remove_file(&raw).unwrap();
        std::fs::write(&compressed, &encoded[..encoded.len() - 1]).unwrap();
        assert_eq!(recorded_settings(&raw), (None, None));
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Answer one framed request from the test's side of a duplex pipe.
    async fn answer(peer: &mut tokio::io::DuplexStream, reply: impl FnOnce(&Value) -> Value) -> Value {
        let length = peer.read_u32_le().await.unwrap() as usize;
        let mut body = vec![0; length];
        peer.read_exact(&mut body).await.unwrap();
        let request: Value = serde_json::from_slice(&body).unwrap();
        let mut response = reply(&request);
        response["jsonrpc"] = json!("2.0");
        response["id"] = request["id"].clone();
        let bytes = serde_json::to_vec(&response).unwrap();
        peer.write_u32_le(bytes.len() as u32).await.unwrap();
        peer.write_all(&bytes).await.unwrap();
        request
    }

    fn client(stream: tokio::io::DuplexStream) -> Client {
        Client { stream: Box::new(stream), next_id: 0, thread_id: THREAD.into() }
    }

    fn tool_result(success: bool, text: &str) -> Value {
        json!({"result": {"success": success, "contentItems": [{"type": "inputText", "text": text}]}})
    }

    #[tokio::test]
    async fn a_send_carries_only_the_prompt_and_needs_a_matching_receipt() {
        let (stream, mut peer) = tokio::io::duplex(64 * 1024);
        let server = tokio::spawn(async move {
            let request = answer(&mut peer, |_| tool_result(true, &json!({"threadId": THREAD}).to_string())).await;
            let mismatch = answer(&mut peer, |_| tool_result(true, r#"{"threadId":"other"}"#)).await;
            (request, mismatch)
        });
        let mut client = client(stream);
        client.send("好的 🧭").await.unwrap();
        let error = client.send("again").await.unwrap_err();
        assert!(error.uncertain);
        let (request, _) = server.await.unwrap();
        assert_eq!(request["method"], "tools/call");
        assert_eq!(request["params"]["namespace"], "codex_app");
        assert_eq!(request["params"]["tool"], "send_message_to_thread");
        assert_eq!(request["params"]["threadId"], THREAD);
        assert_eq!(request["params"]["arguments"], json!({"threadId": THREAD, "hostId": "local", "prompt": "好的 🧭"}));
    }

    #[tokio::test]
    async fn refusals_before_delivery_stay_certain_and_lost_receipts_do_not() {
        let missing = format!("No Codex thread found for threadId: {THREAD}. Hosts without a readable match: local");
        for (reply, uncertain, missing_thread) in [
            (json!({"error": {"code": -32602, "message": "invalid params"}}), false, false),
            (json!({"error": {"code": -32000, "message": "Codex app tool request failed"}}), true, false),
            (tool_result(false, &missing), false, true),
            (tool_result(false, "Connection lost after delivery"), true, false),
        ] {
            let (stream, mut peer) = tokio::io::duplex(64 * 1024);
            let server = tokio::spawn(async move { answer(&mut peer, |_| reply).await });
            let error = client(stream).send("x").await.unwrap_err();
            server.await.unwrap();
            assert_eq!((error.uncertain, error.missing_thread), (uncertain, missing_thread), "{}", error.message);
        }
        let (stream, mut peer) = tokio::io::duplex(64 * 1024);
        let server = tokio::spawn(async move {
            let length = peer.read_u32_le().await.unwrap() as usize;
            let mut body = vec![0; length];
            peer.read_exact(&mut body).await.unwrap();
        });
        let error = client(stream).send("x").await.unwrap_err();
        server.await.unwrap();
        assert!(error.uncertain, "a send whose answer never came may have been delivered");
    }

    #[tokio::test]
    async fn the_catalog_handshake_needs_both_app_tools() {
        for (tools, serves) in [
            (json!([{"namespace": "codex_app", "name": "read_thread"}, {"namespace": "codex_app", "name": "send_message_to_thread"}]), true),
            (json!([{"namespace": "codex_app", "name": "read_thread"}]), false),
            (json!([]), false),
        ] {
            let (stream, mut peer) = tokio::io::duplex(64 * 1024);
            let server = tokio::spawn(async move { answer(&mut peer, |_| json!({"result": {"tools": tools}})).await });
            assert_eq!(client(stream).catalog_serves_app_tools().await, serves);
            server.await.unwrap();
        }
    }

    #[test]
    fn unit_tests_never_discover_real_desktop_pipes() {
        assert!(candidates().is_empty());
    }
}
