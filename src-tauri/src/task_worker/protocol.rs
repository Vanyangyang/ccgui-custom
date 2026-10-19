//! Versioned private loopback protocol. Tokens never occur in command lines.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

pub const PROTOCOL: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
pub const EVENT_CHUNK_BYTES: usize = 256 * 1024;
// A native line is at most 16 MiB. Normalized JSON can expand characters into
// six-byte escapes; this bounds client allocation without increasing wire frames.
pub const MAX_REASSEMBLED_EVENT_BYTES: u64 = (MAX_FRAME_BYTES as u64) * 8;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerConfig {
    pub protocol: u32,
    pub worker_id: String,
    pub run_id: String,
    pub profile: PathBuf,
    pub token: String,
    pub schema_hash: String,
    #[serde(default)]
    pub host_context: Option<crate::host_chat::WorkerHostContext>,
}

/// Persisted only inside the private, profile-bound worker directory.
/// Deliberately does not implement Debug: it contains a bearer credential.
/// The same-account writer of this file is trusted. PID/executable fields detect
/// stale processes; they do not authenticate a manifest against that writer.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkerManifest {
    pub protocol: u32,
    pub worker_id: String,
    pub run_id: String,
    pub profile: PathBuf,
    pub executable: PathBuf,
    pub pid: u32,
    pub process_start_time: u64,
    pub port: u16,
    pub token: String,
    pub schema_hash: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartArgs {
    pub engine: String,
    pub workspace_path: String,
    pub session_id: Option<String>,
    pub prompt: String,
    pub image_paths: Option<Vec<String>>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission: Option<String>,
    pub provider_id: Option<String>,
    pub computer_use: Option<bool>,
    pub claude_ultracode: Option<bool>,
    pub claude_haiku_assist: Option<bool>,
    /// The caller must describe required capabilities, never silently drop them.
    pub require_host_chat: bool,
    pub require_leader: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Start {
        args: StartArgs,
    },
    Interrupt,
    InterruptTurn,
    Followup {
        prompt: String,
        image_paths: Option<Vec<String>>,
    },
    StopTask {
        task_id: String,
    },
    AnswerQuestion {
        question_id: String,
        answers: Option<Value>,
    },
    Plan {
        plan_id: String,
        expected_revision: i64,
        decision: String,
        feedback: Option<String>,
    },
    Status,
    Events {
        stream_id: String,
        after: u64,
        limit: usize,
    },
    EventChunk {
        stream_id: String,
        seq: u64,
        offset: u64,
        limit: usize,
    },
    Receipt {
        request_id: String,
    },
    /// Explicit delivery acknowledgement, accepted only after physical retirement.
    /// It does not delete the event/receipt archive, just retires the live manifest.
    Retire {
        stream_id: String,
        through: u64,
    },
    /// Explicit ordinary desktop quit; planned replacements never send this.
    Shutdown,
}

impl Command {
    pub fn is_mutation(&self) -> bool {
        !matches!(
            self,
            Self::Status | Self::Events { .. } | Self::EventChunk { .. } | Self::Receipt { .. }
        )
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub protocol: u32,
    pub worker_id: String,
    pub token: String,
    pub id: String,
    pub command: Command,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkerError {
    pub code: String,
    pub message: String,
    pub outcome_unknown: bool,
}

impl WorkerError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            outcome_unknown: false,
        }
    }
    pub fn unknown(code: &str, message: impl Into<String>) -> Self {
        Self {
            outcome_unknown: true,
            ..Self::new(code, message)
        }
    }
}

pub type Outcome = Result<Value, WorkerError>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub protocol: u32,
    pub worker_id: String,
    pub id: String,
    pub outcome: Outcome,
}

pub(crate) fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
}

pub(crate) fn token_matches(expected: &str, received: &str) -> bool {
    if expected.len() != received.len() {
        return false;
    }
    expected
        .bytes()
        .zip(received.bytes())
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}
