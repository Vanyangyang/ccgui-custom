//! Bounded, content-free handoff failure records survive GUI stderr redirection.
//! Deliberately never accept prompts, response bodies, endpoints or credentials.

use crate::engine::side_call::{diagnostics::Failure, SideCallError};
use serde::Serialize;
use std::io::{Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const MAX_LOG_BYTES: u64 = 128 * 1024;
static LOG_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize)]
struct Record<'a> {
    version: u8,
    call_id: &'a str,
    timestamp_ms: u128,
    engine: &'static str,
    kind: &'static str,
    stage: &'static str,
    http_status: Option<u16>,
    elapsed_ms: u128,
}

pub(super) fn format_failure(engine: &str, failure: Failure, elapsed: Duration) -> String {
    let path = crate::paths::app_home().join("logs/handoff-diagnostics.jsonl");
    format_failure_at(engine, failure, elapsed, &path)
}

fn format_failure_at(engine: &str, failure: Failure, elapsed: Duration, path: &Path) -> String {
    let engine = match engine {
        "claude" => "claude",
        "codex" => "codex",
        "pi" => "pi",
        _ => "cursor",
    };
    let (kind, message) = match failure.kind {
        SideCallError::Unavailable => ("unavailable", "handoff provider/model unavailable"),
        SideCallError::Timeout => ("timeout", "handoff summary timed out"),
        SideCallError::BadOutput => ("invalid_output", "returned invalid summary"),
        SideCallError::Failed => ("failed", "handoff summary failed"),
    };
    let stage = failure.stage.unwrap_or("handoff_route");
    let call_id = uuid::Uuid::new_v4().to_string();
    let record = Record {
        version: 1,
        call_id: &call_id,
        timestamp_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        engine,
        kind,
        stage,
        http_status: failure.http_status,
        elapsed_ms: elapsed.as_millis(),
    };
    // Logging failure must never replace the original error or the local draft.
    let saved = append_log(path, &record).is_ok();
    let http_status = failure
        .http_status
        .map(|status| format!("; http_status={status}"))
        .unwrap_or_default();
    format!(
        "{engine} {message} [stage={stage}{http_status}; diagnostic_id={call_id}{}]",
        if saved {
            ""
        } else {
            "; diagnostic_log_unavailable"
        }
    )
}

fn append_log(path: &Path, record: &Record<'_>) -> std::io::Result<()> {
    let _guard = LOG_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let mut line = serde_json::to_vec(record)?;
    line.push(b'\n');
    if line.len() as u64 > MAX_LOG_BYTES {
        return Err(std::io::Error::other("diagnostic record exceeds its limit"));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(path)?;
    if file.metadata()?.len().saturating_add(line.len() as u64) > MAX_LOG_BYTES {
        file.set_len(0)?;
    }
    // Windows append-only handles cannot truncate. The process-local lock
    // serializes both truncation and seeking before writing this bounded log.
    file.seek(SeekFrom::End(0))?;
    file.write_all(&line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ipc_error_keeps_stage_when_the_log_cannot_be_written() {
        let temp =
            std::env::temp_dir().join(format!("ccgui-handoff-log-error-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let message = format_failure_at(
            "codex",
            Failure {
                kind: SideCallError::Failed,
                stage: Some("sse_response_failed"),
                http_status: Some(200),
            },
            Duration::from_millis(20),
            &temp,
        );
        assert!(message.starts_with("codex handoff summary failed"));
        assert!(message.contains("stage=sse_response_failed; http_status=200; diagnostic_id="));
        assert!(message.contains("diagnostic_log_unavailable"));
        std::fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn log_is_bounded_and_contains_only_diagnostic_metadata() {
        let temp = std::env::temp_dir().join(format!(
            "ccgui-handoff-diagnostics-{}",
            uuid::Uuid::new_v4()
        ));
        let path = temp.join("logs/handoff-diagnostics.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, vec![b'x'; MAX_LOG_BYTES as usize]).unwrap();
        let record = Record {
            version: 1,
            call_id: "fixture-call",
            timestamp_ms: 1,
            engine: "codex",
            kind: "invalid_output",
            stage: "final_json",
            http_status: Some(200),
            elapsed_ms: 2,
        };
        append_log(&path, &record).unwrap();
        append_log(&path, &record).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.len() < MAX_LOG_BYTES as usize);
        assert_eq!(text.lines().count(), 2);
        for line in text.lines() {
            let value: serde_json::Value = serde_json::from_str(line).unwrap();
            assert_eq!(value.as_object().unwrap().len(), 8);
            assert_eq!(value["stage"], "final_json");
            assert_eq!(value["call_id"], "fixture-call");
        }
        std::fs::remove_dir_all(temp).unwrap();
    }
}
