//! Token-usage ledger and native transcript usage aggregator (ccusage-style).
//!
//! Combines two local sources without double-counting or losing history when
//! old CLI transcript files are pruned:
//! 1. Native CLI transcripts on disk:
//!    - Claude Code (`<claude home>/projects/**/*.jsonl`): deduplicated per API
//!      response (`message.id` / `requestId`) using ccusage's rules so multi-block
//!      streaming assistant lines count input/cache once and take the final output.
//!    - Codex CLI (`$CODEX_HOME/sessions/**/rollout-*.jsonl[.zst]`): per-response
//!      `token_usage_record` events (with fresh input separated from cached input).
//!    Parsed events are persisted in `usage_transcript_events` with their
//!    `session_id` and `event_key`. If the user or a CLI tool later deletes old
//!    transcript files from disk, the already-ingested rows remain in SQLite.
//! 2. `usage_ledger`: live turns recorded by CC GUI. Combined with
//!    `usage_transcript_events` by `(engine, session_id)` / timestamp union so
//!    early ledger rows whose transcript files were deleted before ever being
//!    scanned are still preserved, while sessions present in `usage_transcript_events`
//!    are not double-counted.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::Emitter;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageEntry {
    /// Epoch ms when the turn settled.
    pub ts: i64,
    pub engine: String,
    pub model: Option<String>,
    pub session_id: Option<String>,
    pub workspace_path: Option<String>,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub duration_ms: Option<i64>,
    /// Model responses this turn reported (>= 1): the request count.
    #[serde(default)]
    pub reports: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageRow {
    /// Local day ("YYYY-MM-DD"); computed with the caller's UTC offset.
    pub day: String,
    pub engine: String,
    pub model: String,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    /// Model responses folded into this bucket (one prompt's tool loop counts
    /// each response), i.e. the request total.
    pub requests: i64,
}

/// Append one finished turn. A turn with no tokens (interrupted before the
/// engine reported) is not a ledger row — it would only add noise.
#[tauri::command]
pub fn usage_record(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    entry: UsageEntry,
) -> Result<(), String> {
    if entry.input + entry.output + entry.cache_read + entry.cache_write == 0 {
        return Ok(());
    }
    {
        let conn = state.db.0.lock();
        conn.execute(
            "INSERT INTO usage_ledger
               (ts, engine, model, session_id, workspace_path,
                input_tokens, output_tokens, cache_read, cache_write, duration_ms, reports)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            rusqlite::params![
                entry.ts,
                entry.engine,
                entry.model.unwrap_or_default(),
                entry.session_id,
                entry.workspace_path,
                entry.input,
                entry.output,
                entry.cache_read,
                entry.cache_write,
                entry.duration_ms,
                entry.reports.max(1),
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    let _ = app.emit("usage://changed", ());
    Ok(())
}

/// Per-(day, engine, model) totals. `days` is the local-day window; `0` means
/// the whole ledger (the 总和 range), and any other value keeps the last
/// `days` calendar days. `tz_offset_minutes` is the caller's UTC offset so
/// buckets match the calendar the user is looking at.
#[tauri::command]
pub fn usage_summary(
    state: tauri::State<'_, crate::AppState>,
    days: u32,
    tz_offset_minutes: i32,
) -> Result<Vec<UsageRow>, String> {
    let cutoff_ms = if days == 0 {
        None
    } else {
        let now_ms = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        Some(now_ms.saturating_sub((days.min(36_500) as i64 + 2) * 86_400_000))
    };
    let conn = state.db.0.lock();
    let _ = sync_native_transcripts(&conn, cutoff_ms);
    summarize(&conn, days, tz_offset_minutes).map_err(|e| e.to_string())
}

// ==================== Native Transcript Scanner (ccusage-style) ====================

#[derive(Debug, Clone)]
struct TranscriptCandidate {
    path_key: String,
    path: PathBuf,
    engine: &'static str,
    fallback_session_id: String,
    size: i64,
    mtime_ms: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct ExtractedTranscriptEvent {
    pub event_key: String,
    pub session_id: String,
    pub ts: i64,
    pub engine: &'static str,
    pub model: String,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
}

fn ensure_transcript_tables(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS usage_transcript_files(
            file_path TEXT PRIMARY KEY NOT NULL,
            engine TEXT NOT NULL,
            size INTEGER NOT NULL,
            mtime_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS usage_transcript_events(
            event_key TEXT PRIMARY KEY NOT NULL,
            file_path TEXT NOT NULL,
            session_id TEXT NOT NULL DEFAULT '',
            ts INTEGER NOT NULL,
            engine TEXT NOT NULL,
            model TEXT NOT NULL DEFAULT '',
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read INTEGER NOT NULL DEFAULT 0,
            cache_write INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_usage_transcript_events_ts ON usage_transcript_events(ts);
        CREATE INDEX IF NOT EXISTS idx_usage_transcript_events_file ON usage_transcript_events(file_path);",
    )?;
    // Upgrade older tables that lacked `session_id` before creating the session index.
    let has_session_col = conn
        .prepare("PRAGMA table_info(usage_transcript_events)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .flatten()
        .any(|name| name == "session_id");
    if !has_session_col {
        let _ = conn.execute(
            "ALTER TABLE usage_transcript_events ADD COLUMN session_id TEXT NOT NULL DEFAULT ''",
            [],
        );
        // Reset file fingerprints once so existing files populate `session_id`.
        let _ = conn.execute("DELETE FROM usage_transcript_files", []);
    }
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_usage_transcript_events_session
         ON usage_transcript_events(engine, session_id);",
    )?;
    Ok(())
}

fn codex_rollout_thread_id(path: &Path) -> String {
    let plain = crate::history::codex_rollout::plain_path(path);
    let Some(stem) = plain.file_stem().and_then(|s| s.to_str()) else {
        return String::new();
    };
    if let Some(id) = stem.get(stem.len().saturating_sub(36)..) {
        if uuid::Uuid::parse_str(id).is_ok() {
            return id.to_string();
        }
    }
    stem.to_string()
}

fn collect_claude_transcript_candidates(cutoff_ms: Option<i64>) -> Vec<TranscriptCandidate> {
    let root = crate::engine::engine_home(Some("CLAUDE_CONFIG_DIR"), ".claude").join("projects");
    let mut out = Vec::new();
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            let full = entry.path();
            if ft.is_dir() {
                stack.push(full);
            } else if ft.is_file() && full.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                let stem = full
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default()
                    .to_string();
                if stem.is_empty() || stem == "history" {
                    continue;
                }
                let Ok(meta) = fs::metadata(&full) else {
                    continue;
                };
                let size = meta.len() as i64;
                if size <= 0 {
                    continue;
                }
                let mtime_ms = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                if cutoff_ms.is_some_and(|cut| mtime_ms < cut) {
                    continue;
                }
                out.push(TranscriptCandidate {
                    path_key: full.to_string_lossy().into_owned(),
                    path: full,
                    engine: "claude",
                    fallback_session_id: stem,
                    size,
                    mtime_ms,
                });
            }
        }
    }
    out
}

fn collect_codex_transcript_candidates(cutoff_ms: Option<i64>) -> Vec<TranscriptCandidate> {
    let mut out = Vec::new();
    for path in crate::history::discovery::codex_candidates() {
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        let size = meta.len() as i64;
        if size <= 0 {
            continue;
        }
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        if cutoff_ms.is_some_and(|cut| mtime_ms < cut) {
            continue;
        }
        let plain_key = crate::history::codex_rollout::plain_path(&path)
            .to_string_lossy()
            .into_owned();
        let fallback_session_id = codex_rollout_thread_id(&path);
        out.push(TranscriptCandidate {
            path_key: plain_key,
            path,
            engine: "codex",
            fallback_session_id,
            size,
            mtime_ms,
        });
    }
    out
}

/// Extract deduplicated Claude Code usage events from one `.jsonl` transcript
/// following ccusage's deduplication rules:
/// - Only `type == "assistant"` lines with a real `message.model` (ignoring `<synthetic>`)
///   and `message.usage` object.
/// - Grouped by `message.id` (falling back to `requestId`, `uuid`, or line ordinal)
///   so multi-block streaming rows for one API call are folded into one entry
///   taking the maximum `output_tokens`.
pub(crate) fn parse_claude_transcript_reader<R: BufRead>(
    reader: R,
    file_key: &str,
    fallback_session_id: &str,
    fallback_ts_ms: i64,
) -> Vec<ExtractedTranscriptEvent> {
    let mut by_key: HashMap<String, ExtractedTranscriptEvent> = HashMap::new();
    let mut order: Vec<String> = Vec::new();

    for (line_idx, line_res) in reader.lines().enumerate() {
        let Ok(line) = line_res else {
            continue;
        };
        if !line.contains("\"usage\"") || !line.contains("\"assistant\"") {
            continue;
        }
        let Ok(val) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if val.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        if val.get("isMeta").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let Some(msg) = val.get("message") else {
            continue;
        };
        let model = msg
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if model.is_empty() || model == "<synthetic>" {
            continue;
        }
        let Some(usage) = msg.get("usage") else {
            continue;
        };
        let input = usage
            .get("input_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(0);
        let output = usage
            .get("output_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(0);
        let cache_read = usage
            .get("cache_read_input_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(0);
        let cache_write = usage
            .get("cache_creation_input_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(0);
        if input + output + cache_read + cache_write == 0 {
            continue;
        }
        let ts = val
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(crate::history::parse_ts_ms_str)
            .unwrap_or(fallback_ts_ms);
        let session_id = val
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(fallback_session_id)
            .to_string();
        let raw_id = msg
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                val.get("requestId")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
            })
            .or_else(|| {
                val.get("uuid")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
            });
        let event_key = match raw_id {
            Some(id) => format!("claude:{id}"),
            None => format!("claude:{file_key}:{line_idx}"),
        };

        if let Some(existing) = by_key.get_mut(&event_key) {
            existing.input = existing.input.max(input);
            existing.output = existing.output.max(output);
            existing.cache_read = existing.cache_read.max(cache_read);
            existing.cache_write = existing.cache_write.max(cache_write);
            if ts > existing.ts {
                existing.ts = ts;
            }
        } else {
            order.push(event_key.clone());
            by_key.insert(
                event_key.clone(),
                ExtractedTranscriptEvent {
                    event_key,
                    session_id,
                    ts,
                    engine: "claude",
                    model: model.to_string(),
                    input,
                    output,
                    cache_read,
                    cache_write,
                },
            );
        }
    }

    order
        .into_iter()
        .filter_map(|k| by_key.remove(&k))
        .collect()
}

/// Extract per-response Codex usage events (`token_usage_record`) from a rollout.
pub(crate) fn parse_codex_transcript_reader<R: BufRead>(
    reader: R,
    file_key: &str,
    fallback_session_id: &str,
    fallback_ts_ms: i64,
) -> Vec<ExtractedTranscriptEvent> {
    let mut by_key: HashMap<String, ExtractedTranscriptEvent> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut current_model = String::from("gpt-6-astra");
    let mut current_session_id = fallback_session_id.to_string();

    for (line_idx, line_res) in reader.lines().enumerate() {
        let Ok(line) = line_res else {
            continue;
        };
        if line.contains("\"turn_context\"") || line.contains("\"session_meta\"") {
            if let Ok(val) = serde_json::from_str::<Value>(&line) {
                if let Some(payload) = val.get("payload") {
                    if let Some(m) = payload
                        .get("model")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        current_model = m.to_string();
                    }
                    if let Some(sid) = payload
                        .get("id")
                        .or_else(|| payload.get("session_id"))
                        .or_else(|| payload.get("thread_id"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        current_session_id = sid.to_string();
                    }
                }
            }
            continue;
        }
        if !line.contains("\"token_usage_record\"") {
            continue;
        }
        let Ok(val) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if val.get("type").and_then(Value::as_str) != Some("token_usage_record") {
            continue;
        }
        let Some(payload) = val.get("payload") else {
            continue;
        };
        let Some(usage) = payload.get("usage") else {
            continue;
        };
        let reported_input = usage
            .get("input_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(0);
        let cache_read = usage
            .get("cached_input_tokens")
            .or_else(|| usage.get("cache_read_input_tokens"))
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(0);
        let cache_write = usage
            .get("cache_write_input_tokens")
            .or_else(|| usage.get("cache_creation_input_tokens"))
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(0);
        // Codex reports cached_input_tokens inside input_tokens; separate them
        // so fresh input and cache_read never overlap.
        let input = (reported_input - cache_read - cache_write).max(0);
        let output = usage
            .get("output_tokens")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(0);
        if input + output + cache_read + cache_write == 0 {
            continue;
        }
        let ts = val
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(crate::history::parse_ts_ms_str)
            .unwrap_or(fallback_ts_ms);
        let session_id = payload
            .get("thread_id")
            .or_else(|| payload.get("session_id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&current_session_id)
            .to_string();
        let resp_id = payload
            .get("response_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        let event_key = match resp_id {
            Some(id) => format!("codex:{id}"),
            None => format!("codex:{file_key}:{line_idx}"),
        };
        if !by_key.contains_key(&event_key) {
            order.push(event_key.clone());
            by_key.insert(
                event_key.clone(),
                ExtractedTranscriptEvent {
                    event_key,
                    session_id,
                    ts,
                    engine: "codex",
                    model: current_model.clone(),
                    input,
                    output,
                    cache_read,
                    cache_write,
                },
            );
        }
    }

    order
        .into_iter()
        .filter_map(|k| by_key.remove(&k))
        .collect()
}

fn sync_native_transcripts(
    conn: &rusqlite::Connection,
    cutoff_ms: Option<i64>,
) -> rusqlite::Result<()> {
    ensure_transcript_tables(conn)?;

    let mut candidates = collect_claude_transcript_candidates(cutoff_ms);
    candidates.extend(collect_codex_transcript_candidates(cutoff_ms));
    if candidates.is_empty() {
        return Ok(());
    }

    let mut known: HashMap<String, (i64, i64)> = HashMap::new();
    {
        let mut stmt =
            conn.prepare("SELECT file_path, size, mtime_ms FROM usage_transcript_files")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?),
            ))
        })?;
        for row in rows.flatten() {
            known.insert(row.0, row.1);
        }
    }

    let changed: Vec<TranscriptCandidate> = candidates
        .into_iter()
        .filter(|c| known.get(&c.path_key) != Some(&(c.size, c.mtime_ms)))
        .collect();
    if changed.is_empty() {
        return Ok(());
    }

    let tx = conn.unchecked_transaction()?;
    {
        let mut del_events =
            tx.prepare("DELETE FROM usage_transcript_events WHERE file_path = ?1")?;
        let mut ins_event = tx.prepare(
            "INSERT OR REPLACE INTO usage_transcript_events
               (event_key, file_path, session_id, ts, engine, model, input_tokens, output_tokens, cache_read, cache_write)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )?;
        let mut upsert_file = tx.prepare(
            "INSERT OR REPLACE INTO usage_transcript_files (file_path, engine, size, mtime_ms)
             VALUES (?1, ?2, ?3, ?4)",
        )?;

        for cand in changed {
            let events = if cand.engine == "claude" {
                let Ok(file) = fs::File::open(&cand.path) else {
                    continue;
                };
                parse_claude_transcript_reader(
                    std::io::BufReader::new(file),
                    &cand.path_key,
                    &cand.fallback_session_id,
                    cand.mtime_ms,
                )
            } else {
                let Ok(reader) = crate::history::codex_rollout::open_reader(&cand.path) else {
                    continue;
                };
                parse_codex_transcript_reader(
                    reader,
                    &cand.path_key,
                    &cand.fallback_session_id,
                    cand.mtime_ms,
                )
            };

            // Only replace the events of this file while it is still present on disk.
            // Files later deleted from disk are never purged here, so historical
            // snapshots survive CLI session cleanup.
            del_events.execute(rusqlite::params![&cand.path_key])?;
            for ev in events {
                ins_event.execute(rusqlite::params![
                    ev.event_key,
                    &cand.path_key,
                    ev.session_id,
                    ev.ts,
                    ev.engine,
                    ev.model,
                    ev.input,
                    ev.output,
                    ev.cache_read,
                    ev.cache_write,
                ])?;
            }
            upsert_file.execute(rusqlite::params![
                &cand.path_key,
                cand.engine,
                cand.size,
                cand.mtime_ms,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Union of persisted transcript events (`usage_transcript_events`) and
/// `usage_ledger` rows whose `(engine, session_id)` is not already covered by
/// transcript events (and whose timestamp is not after the latest transcript
/// event of that session). This guarantees:
/// 1. Same session run inside CC GUI is not double-counted when its transcript
///    is also scanned.
/// 2. Earlier `usage_ledger` sessions whose native CLI transcript files were
///    deleted before ever being scanned are still preserved in the totals.
/// 3. Previously scanned transcript files remain in `usage_transcript_events`
///    even if the user later deletes `~/.claude/projects` or `~/.codex/sessions` files.
fn summarize(
    conn: &rusqlite::Connection,
    days: u32,
    tz_offset_minutes: i32,
) -> rusqlite::Result<Vec<UsageRow>> {
    ensure_transcript_tables(conn)?;
    let shift_ms = i64::from(tz_offset_minutes) * 60_000;
    let day_filter = if days == 0 {
        String::new()
    } else {
        " WHERE day >= date('now', ?2)".to_string()
    };

    let sql = format!(
        "WITH combined AS (
            SELECT ts, engine, model, input_tokens, output_tokens, cache_read, cache_write, 1 AS reports
            FROM usage_transcript_events
            UNION ALL
            SELECT l.ts, l.engine, l.model, l.input_tokens, l.output_tokens, l.cache_read, l.cache_write, l.reports
            FROM usage_ledger l
            WHERE l.session_id IS NULL
               OR l.session_id = ''
               OR NOT EXISTS (
                   SELECT 1 FROM usage_transcript_events e
                   WHERE e.engine = l.engine
                     AND e.session_id = l.session_id
                     AND e.ts >= l.ts - 300000
               )
        ),
        bucketed AS (
            SELECT date((ts + ?1) / 1000, 'unixepoch') AS day,
                   engine,
                   model,
                   input_tokens,
                   output_tokens,
                   cache_read,
                   cache_write,
                   reports
            FROM combined
        )
        SELECT day,
               engine,
               model,
               SUM(input_tokens),
               SUM(output_tokens),
               SUM(cache_read),
               SUM(cache_write),
               SUM(reports)
        FROM bucketed{day_filter}
        GROUP BY day, engine, model
        ORDER BY day, engine, model"
    );

    let map_row = |r: &rusqlite::Row| {
        Ok(UsageRow {
            day: r.get(0)?,
            engine: r.get(1)?,
            model: r.get::<_, String>(2).unwrap_or_default(),
            input: r.get(3)?,
            output: r.get(4)?,
            cache_read: r.get(5)?,
            cache_write: r.get(6)?,
            requests: r.get(7)?,
        })
    };

    let mut stmt = conn.prepare(&sql)?;
    if days == 0 {
        let rows = stmt.query_map(rusqlite::params![shift_ms], map_row)?.collect();
        return rows;
    }
    let days = days.min(36_500) as i64;
    let range_param = format!("-{} days", days - 1);
    let rows = stmt
        .query_map(rusqlite::params![shift_ms, range_param], map_row)?
        .collect();
    rows
}

/// Drop the local ledger and cached transcript rows.
#[tauri::command]
pub fn usage_clear(state: tauri::State<'_, crate::AppState>) -> Result<(), String> {
    let conn = state.db.0.lock();
    let _ = ensure_transcript_tables(&conn);
    conn.execute_batch(
        "DELETE FROM usage_ledger;
         DELETE FROM usage_transcript_files;
         DELETE FROM usage_transcript_events;",
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindowSpan {
    pub id: String,
    pub since_ms: i64,
    pub until_ms: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindowRow {
    pub window_id: String,
    pub engine: String,
    pub model: String,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub requests: i64,
}

/// Exact timestamp-window totals for quota reverse-inference (e.g. rolling 5h
/// and 7d windows bounded by `resetsAt - duration .. now`).
#[tauri::command]
pub fn usage_window_totals(
    state: tauri::State<'_, crate::AppState>,
    windows: Vec<UsageWindowSpan>,
) -> Result<Vec<UsageWindowRow>, String> {
    let min_since = windows.iter().map(|w| w.since_ms).min();
    let conn = state.db.0.lock();
    let _ = sync_native_transcripts(&conn, min_since.map(|ms| ms.saturating_sub(86_400_000)));
    summarize_windows(&conn, &windows).map_err(|e| e.to_string())
}

fn summarize_windows(
    conn: &rusqlite::Connection,
    windows: &[UsageWindowSpan],
) -> rusqlite::Result<Vec<UsageWindowRow>> {
    ensure_transcript_tables(conn)?;
    let mut out = Vec::new();
    let mut stmt = conn.prepare(
        "WITH combined AS (
            SELECT ts, engine, model, input_tokens, output_tokens, cache_read, cache_write, 1 AS reports
            FROM usage_transcript_events
            WHERE ts >= ?1 AND ts <= ?2
            UNION ALL
            SELECT l.ts, l.engine, l.model, l.input_tokens, l.output_tokens, l.cache_read, l.cache_write, l.reports
            FROM usage_ledger l
            WHERE l.ts >= ?1 AND l.ts <= ?2
              AND (
                  l.session_id IS NULL
                  OR l.session_id = ''
                  OR NOT EXISTS (
                      SELECT 1 FROM usage_transcript_events e
                      WHERE e.engine = l.engine
                        AND e.session_id = l.session_id
                        AND e.ts >= l.ts - 300000
                  )
              )
        )
        SELECT engine,
               model,
               SUM(input_tokens),
               SUM(output_tokens),
               SUM(cache_read),
               SUM(cache_write),
               SUM(reports)
        FROM combined
        GROUP BY engine, model
        ORDER BY engine, model",
    )?;
    for w in windows.iter().take(32) {
        if w.until_ms < w.since_ms {
            continue;
        }
        let rows = stmt.query_map(rusqlite::params![w.since_ms, w.until_ms], |r| {
            Ok(UsageWindowRow {
                window_id: w.id.clone(),
                engine: r.get(0)?,
                model: r.get::<_, String>(1).unwrap_or_default(),
                input: r.get(2)?,
                output: r.get(3)?,
                cache_read: r.get(4)?,
                cache_write: r.get(5)?,
                requests: r.get(6)?,
            })
        })?;
        for row in rows {
            out.push(row?);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::io::Cursor;

    fn ledger() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE usage_ledger(
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                engine TEXT NOT NULL,
                model TEXT NOT NULL DEFAULT '',
                session_id TEXT,
                workspace_path TEXT,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cache_read INTEGER NOT NULL DEFAULT 0,
                cache_write INTEGER NOT NULL DEFAULT 0,
                duration_ms INTEGER,
                reports INTEGER NOT NULL DEFAULT 1
            );",
        )
        .unwrap();
        ensure_transcript_tables(&conn).unwrap();
        conn
    }

    fn insert(conn: &Connection, ts_ms: i64, input: i64) {
        conn.execute(
            "INSERT INTO usage_ledger(ts, engine, model, input_tokens, reports)
             VALUES(?1, 'omp', 'm', ?2, 1)",
            rusqlite::params![ts_ms, input],
        )
        .unwrap();
    }

    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }

    const DAY_MS: i64 = 86_400_000;

    #[test]
    fn all_history_includes_rows_a_finite_window_drops() {
        let conn = ledger();
        let now = now_ms();
        insert(&conn, now, 100);
        insert(&conn, now - 730 * DAY_MS, 50);

        let recent = summarize(&conn, 30, 0).unwrap();
        assert_eq!(recent.len(), 1, "old turn is outside the 30-day window");
        assert_eq!(recent[0].input, 100);

        let all = summarize(&conn, 0, 0).unwrap();
        let total: i64 = all.iter().map(|r| r.input).sum();
        assert_eq!(total, 150, "总和 spans the whole ledger");
    }

    #[test]
    fn a_year_window_reaches_past_the_old_365_day_cap() {
        let conn = ledger();
        let now = now_ms();
        insert(&conn, now - 400 * DAY_MS, 7);
        insert(&conn, now, 3);

        assert_eq!(
            summarize(&conn, 365, 0)
                .unwrap()
                .iter()
                .map(|r| r.input)
                .sum::<i64>(),
            3,
            "the 400-day-old turn is past a 365-day window",
        );
        assert_eq!(
            summarize(&conn, 500, 0)
                .unwrap()
                .iter()
                .map(|r| r.input)
                .sum::<i64>(),
            10,
            "a wider window is no longer clamped to 365 days",
        );
    }

    #[test]
    fn summarize_windows_filters_exact_millisecond_bounds() {
        let conn = ledger();
        conn.execute(
            "INSERT INTO usage_ledger(ts, engine, model, input_tokens, output_tokens, cache_read, cache_write, reports)
             VALUES(1000, 'claude', 'opus', 100, 20, 500, 50, 1),
                   (5000, 'claude', 'opus', 200, 40, 800, 0, 2),
                   (9000, 'codex', 'gpt-6-astra', 300, 60, 1200, 0, 1)",
            [],
        )
        .unwrap();

        let spans = vec![
            UsageWindowSpan {
                id: "5h".into(),
                since_ms: 4000,
                until_ms: 8000,
            },
            UsageWindowSpan {
                id: "7d".into(),
                since_ms: 1000,
                until_ms: 9000,
            },
        ];
        let rows = summarize_windows(&conn, &spans).unwrap();
        assert_eq!(
            rows,
            vec![
                UsageWindowRow {
                    window_id: "5h".into(),
                    engine: "claude".into(),
                    model: "opus".into(),
                    input: 200,
                    output: 40,
                    cache_read: 800,
                    cache_write: 0,
                    requests: 2,
                },
                UsageWindowRow {
                    window_id: "7d".into(),
                    engine: "claude".into(),
                    model: "opus".into(),
                    input: 300,
                    output: 60,
                    cache_read: 1300,
                    cache_write: 50,
                    requests: 3,
                },
                UsageWindowRow {
                    window_id: "7d".into(),
                    engine: "codex".into(),
                    model: "gpt-6-astra".into(),
                    input: 300,
                    output: 60,
                    cache_read: 1200,
                    cache_write: 0,
                    requests: 1,
                },
            ]
        );
    }

    #[test]
    fn ccusage_claude_transcript_deduplicates_multi_block_messages_by_id() {
        let jsonl = r#"{"type":"assistant","timestamp":"2026-10-22T01:00:00Z","sessionId":"sid-c1","requestId":"req_1","message":{"id":"msg_1","model":"claude-opus-4-6","usage":{"input_tokens":10,"output_tokens":40,"cache_read_input_tokens":5000,"cache_creation_input_tokens":200}}}
{"type":"assistant","timestamp":"2026-10-22T01:00:02Z","sessionId":"sid-c1","requestId":"req_1","message":{"id":"msg_1","model":"claude-opus-4-6","usage":{"input_tokens":10,"output_tokens":125,"cache_read_input_tokens":5000,"cache_creation_input_tokens":200}}}
{"type":"assistant","timestamp":"2026-10-22T01:00:05Z","sessionId":"sid-c1","message":{"id":"msg_syn","model":"<synthetic>","usage":{"input_tokens":0,"output_tokens":0}}}"#;

        let events = parse_claude_transcript_reader(Cursor::new(jsonl), "f1", "sid-fallback", 0);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session_id, "sid-c1");
        assert_eq!(events[0].model, "claude-opus-4-6");
        assert_eq!(events[0].input, 10);
        assert_eq!(events[0].output, 125);
        assert_eq!(events[0].cache_read, 5000);
        assert_eq!(events[0].cache_write, 200);
    }

    #[test]
    fn ccusage_codex_transcript_extracts_non_overlapping_input_and_cache() {
        let jsonl = r#"{"timestamp":"2026-10-22T02:00:00Z","type":"turn_context","payload":{"model":"gpt-6-astra"}}
{"timestamp":"2026-10-22T02:00:05Z","type":"token_usage_record","payload":{"thread_id":"tid-x1","response_id":"resp_1","usage":{"input_tokens":10000,"cached_input_tokens":8000,"cache_write_input_tokens":0,"output_tokens":500}}}"#;

        let events = parse_codex_transcript_reader(Cursor::new(jsonl), "r1", "tid-fallback", 0);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session_id, "tid-x1");
        assert_eq!(events[0].model, "gpt-6-astra");
        assert_eq!(events[0].input, 2000);
        assert_eq!(events[0].cache_read, 8000);
        assert_eq!(events[0].output, 500);
    }

    #[test]
    fn ledger_sessions_without_transcript_files_survive_when_newer_transcripts_exist() {
        let conn = ledger();
        let now = now_ms();
        // Old session in usage_ledger whose CLI transcript file was pruned before scanning.
        conn.execute(
            "INSERT INTO usage_ledger(ts, engine, model, session_id, input_tokens, output_tokens, cache_read, cache_write, reports)
             VALUES(?1, 'claude', 'opus', 'old-pruned-session', 400, 100, 2000, 0, 2)",
            rusqlite::params![now - 3600_000],
        )
        .unwrap();
        // Newer session present in both usage_ledger and usage_transcript_events (should not double count).
        conn.execute(
            "INSERT INTO usage_ledger(ts, engine, model, session_id, input_tokens, output_tokens, cache_read, cache_write, reports)
             VALUES(?1, 'claude', 'opus', 'active-session', 300, 50, 1000, 0, 1)",
            rusqlite::params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO usage_transcript_events(event_key, file_path, session_id, ts, engine, model, input_tokens, output_tokens, cache_read, cache_write)
             VALUES('claude:msg_new', '/tmp/active.jsonl', 'active-session', ?1, 'claude', 'opus', 300, 50, 1000, 0)",
            rusqlite::params![now],
        )
        .unwrap();

        let rows = summarize(&conn, 7, 0).unwrap();
        assert_eq!(rows.len(), 1);
        // 400 (old pruned ledger session) + 300 (active session from transcript, deduplicated against ledger) = 700
        assert_eq!(rows[0].input, 700);
        assert_eq!(rows[0].output, 150);
        assert_eq!(rows[0].cache_read, 3000);
        assert_eq!(rows[0].requests, 3);
    }
}
