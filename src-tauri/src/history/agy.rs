//! Antigravity (`agy`) conversations are sqlite + protobuf, not NDJSON.
//!
//! User text is taken from `~/.gemini/antigravity-cli/history.jsonl` (the
//! CLI's own prompt log). Assistant / tool text is pulled out of
//! length-delimited UTF-8 strings in each `steps.step_payload` blob.

use super::{Message, ParsedSession, ScanSummary};
use serde::Deserialize;
use std::path::Path;

/// `steps.step_type` values observed on agy 1.2.x.
const STEP_USER: i64 = 14;
const STEP_ASSISTANT: i64 = 15;
const STEP_CHECKPOINT: i64 = 23;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryLine {
    display: Option<String>,
    timestamp: Option<i64>,
    conversation_id: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
struct UserTurn {
    text: String,
    ts_ms: Option<i64>,
    images: Vec<String>,
}

pub(super) fn parse_agy_session(path: &Path) -> ParsedSession {
    parse_agy_session_inner(path, true)
}

fn parse_agy_session_inner(path: &Path, with_usage: bool) -> ParsedSession {
    let id = conversation_id(path);
    let mut users = load_user_turns(path, id.as_deref());
    let mut user_iter = users.drain(..);
    let mut messages = Vec::new();
    let mut seq = 0i64;
    let mut turn_usage = TurnUsage::default();

    if let Some(steps) = load_steps(path) {
        for (step_type, payload) in steps {
            match step_type {
                STEP_USER => {
                    if with_usage { turn_usage.finish(&mut messages); }
                    turn_usage = TurnUsage::new();
                    let hist_turn = user_iter.next();
                    let turn = match (extract_user_step_turn(&payload), hist_turn) {
                        (Some(mut step_turn), Some(hist)) => {
                            if step_turn.ts_ms.is_none() {
                                step_turn.ts_ms = hist.ts_ms;
                            }
                            if step_turn.images.is_empty() && !hist.images.is_empty() {
                                step_turn.images = hist.images;
                            }
                            Some(step_turn)
                        }
                        (Some(step_turn), None) => Some(step_turn),
                        (None, Some(hist)) => Some(hist),
                        (None, None) => None,
                    };
                    if let Some(turn) = turn {
                        seq += 1;
                        messages.push(user_message(seq, turn));
                    }
                }
                STEP_ASSISTANT => {
                    if with_usage { turn_usage.add(&payload); }
                    // Tool payloads live in the same sqlite blobs as replies;
                    // reconstructing them yields protobuf/JSON fragments
                    // ("ommandLine", "WaitMsBeforeAsync"). History only keeps
                    // the visible assistant reply.
                    if let Some(text) = pick_assistant(&proto_strings(&payload)) {
                        seq += 1;
                        let ts_ms = extract_step_timestamp_ms(&payload);
                        messages.push(plain_message(seq, "assistant", text, ts_ms));
                        turn_usage.last_assistant = Some(messages.len() - 1);
                    }
                }
                _ => {}
            }
        }
    }

    if with_usage { turn_usage.finish(&mut messages); }

    // Conversation db unreadable / older than the prompt log: still show users.
    for turn in user_iter {
        seq += 1;
        messages.push(user_message(seq, turn));
    }

    // The session's context gauge reads `usage` off the latest assistant row;
    // without it every reopened AGY session showed "unknown".
    if !with_usage {
        return ParsedSession { messages };
    }
    if let Some(usage) = read_native_context(path).as_ref().and_then(native_context_usage) {
        if let Some(last) = messages.iter_mut().rev().find(|m| m.role == "assistant") {
            let target = last.usage.get_or_insert_with(|| serde_json::json!({}));
            if let (Some(target), Some(context)) = (target.as_object_mut(), usage.as_object()) {
                target.extend(context.iter().map(|(key, value)| (key.clone(), value.clone())));
            }
        }
    }

    ParsedSession { messages }
}

#[derive(Default)]
struct TurnUsage {
    boundary: bool,
    seen: bool,
    input: Option<u64>,
    output: Option<u64>,
    cache: Option<u64>,
    last_assistant: Option<usize>,
}

impl TurnUsage {
    fn new() -> Self {
        Self { boundary: true, input: Some(0), output: Some(0), cache: Some(0), ..Self::default() }
    }

    fn add(&mut self, payload: &[u8]) {
        self.seen = true;
        // StepMetadata.usage attaches the generation counts to the actual step.
        let usage = find_length_delimited_field(payload, 5)
            .and_then(|metadata| find_length_delimited_field(metadata, 9));
        for (sum, field) in [(&mut self.input, 2), (&mut self.output, 3), (&mut self.cache, 5)] {
            *sum = sum.and_then(|sum| usage.and_then(|usage| find_varint_field(usage, field))
                .filter(|value| *value <= 1_000_000_000_000)
                .and_then(|value| sum.checked_add(value)));
        }
    }

    fn finish(&self, messages: &mut [Message]) {
        let Some(message) = self.last_assistant.and_then(|index| messages.get_mut(index)) else { return };
        if !self.seen { return; }
        let complete = self.boundary && self.input.is_some() && self.output.is_some() && self.cache.is_some();
        let mut usage = serde_json::json!({"usage_scope": if complete { "turn" } else { "unknown" }});
        if self.boundary {
            for (name, value) in [("input_tokens", self.input), ("output_tokens", self.output), ("cache_read_input_tokens", self.cache)] {
                if let Some(value) = value { usage[name] = value.into(); }
            }
            // The cache is outside AGY input_tokens; include it exactly once.
            if let Some(total) = self.input.zip(self.output).zip(self.cache)
                .and_then(|((input, output), cache)| input.checked_add(output)?.checked_add(cache)) {
                usage["total_tokens"] = total.into();
            }
        }
        message.usage = Some(usage);
    }
}

/// What AGY recorded about the model request context in `gen_metadata`
/// (written on every model step): the request's own token counts and the
/// `ContextWindowMetadata` (`estimated_tokens_used`, `max_context_tokens`).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct AgyNativeContext {
    pub estimated_tokens: Option<u64>,
    pub max_tokens: Option<u64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_tokens: Option<u64>,
}

/// Newest `gen_metadata` row that says anything about the context. Best
/// effort: a missing table, a busy database or an unknown layout is `None`.
pub(crate) fn read_native_context(path: &Path) -> Option<AgyNativeContext> {
    let conn =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .ok()?;
    let mut stmt = conn
        .prepare("SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 8")
        .ok()?;
    let rows = stmt.query_map([], |r| r.get::<_, Vec<u8>>(0)).ok()?;
    let context = rows.flatten()
        .filter_map(|data| parse_gen_metadata(&data))
        .next();
    apply_compaction_override(&conn, context)
}

fn apply_compaction_override(
    conn: &rusqlite::Connection,
    mut context: Option<AgyNativeContext>,
) -> Option<AgyNativeContext> {
    let Some(summary_tokens) = latest_compaction_summary_tokens(conn) else {
        return context;
    };
    let overhead = read_gen_metadata_overhead(conn).unwrap_or(0);
    let compacted = overhead.saturating_add(summary_tokens).max(1);
    if let Some(ctx) = context.as_mut() {
        if ctx.estimated_tokens.is_some() || ctx.max_tokens.is_some() {
            ctx.estimated_tokens = Some(compacted);
        } else {
            ctx.input_tokens = Some(compacted);
            ctx.output_tokens = Some(0);
            ctx.cache_read_tokens = Some(0);
        }
    } else {
        context = Some(AgyNativeContext {
            input_tokens: Some(compacted),
            output_tokens: Some(0),
            cache_read_tokens: Some(0),
            ..AgyNativeContext::default()
        });
    }
    context
}

fn read_gen_metadata_overhead(conn: &rusqlite::Connection) -> Option<u64> {
    let mut stmt = conn
        .prepare("SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 8")
        .ok()?;
    let rows = stmt.query_map([], |r| r.get::<_, Vec<u8>>(0)).ok()?;
    let overhead = rows
        .flatten()
        .find_map(|data| parse_gen_metadata_overhead(&data));
    overhead
}

/// Sum non-conversation overhead groups (`type != 7`, i.e. System Prompt,
/// Tools, Rules, etc.) from `ContextWindowMetadata.token_breakdown` (`field 3`).
fn parse_gen_metadata_overhead(data: &[u8]) -> Option<u64> {
    let meta = find_length_delimited_field(data, 1)?;
    let window = find_length_delimited_field(meta, 9)
        .and_then(|start| find_length_delimited_field(start, 10))?;
    let breakdown = find_length_delimited_field(window, 3)?;
    let mut i = 0;
    let mut sum = 0u64;
    let mut seen = false;
    while i < breakdown.len() {
        let (tag, i2) = read_varint(breakdown, i)?;
        let field = tag >> 3;
        match (tag & 7) as u32 {
            0 => {
                let (_, n) = read_varint(breakdown, i2)?;
                i = n;
            }
            1 if i2 + 8 <= breakdown.len() => i = i2 + 8,
            5 if i2 + 4 <= breakdown.len() => i = i2 + 4,
            2 => {
                let (len, i3) = read_varint(breakdown, i2)?;
                let end = i3.checked_add(len as usize)?;
                if end > breakdown.len() {
                    return None;
                }
                if field == 1 {
                    let group = &breakdown[i3..end];
                    seen = true;
                    let group_type = find_varint_field(group, 2);
                    let group_name = find_length_delimited_field(group, 1)
                        .and_then(|b| std::str::from_utf8(b).ok());
                    if group_type != Some(7) && group_name != Some("Chat Messages") {
                        if let Some(tokens) =
                            find_varint_field(group, 4).filter(|n| *n <= 1_000_000_000_000)
                        {
                            sum = sum.saturating_add(tokens);
                        }
                    }
                }
                i = end;
            }
            _ => return None,
        }
    }
    seen.then_some(sum)
}

fn latest_compaction_summary_tokens(conn: &rusqlite::Connection) -> Option<u64> {
    let (step_type, payload): (i64, Vec<u8>) = conn
        .query_row(
            "SELECT step_type, step_payload FROM steps WHERE step_type IN (?1, ?2) ORDER BY idx DESC LIMIT 1",
            rusqlite::params![STEP_ASSISTANT, STEP_CHECKPOINT],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok()?;
    if step_type != STEP_CHECKPOINT {
        return None;
    }
    checkpoint_summary_tokens(&payload)
}

fn checkpoint_summary_tokens(payload: &[u8]) -> Option<u64> {
    if let Some(meta) = find_length_delimited_field(payload, 5) {
        let usage = find_length_delimited_field(meta, 9).or_else(|| {
            find_length_delimited_field(meta, 28)
                .and_then(|retry| find_length_delimited_field(retry, 2))
        });
        if let Some(output) = usage
            .and_then(|u| find_varint_field(u, 3))
            .filter(|n| *n > 0 && *n <= 1_000_000_000_000)
        {
            return Some(output);
        }
    }
    let summary = find_length_delimited_field(payload, 30)
        .and_then(|cp| find_length_delimited_field(cp, 5))
        .filter(|b| !b.is_empty())?;
    Some(((summary.len() as u64).div_ceil(4)).max(1))
}

fn parse_gen_metadata(data: &[u8]) -> Option<AgyNativeContext> {
    let meta = find_length_delimited_field(data, 1)?;
    let mut out = AgyNativeContext::default();
    if let Some(step) = find_length_delimited_field(meta, 4) {
        out.input_tokens = find_varint_field(step, 2);
        out.output_tokens = find_varint_field(step, 3);
        out.cache_read_tokens = find_varint_field(step, 5);
    }
    if let Some(window) = find_length_delimited_field(meta, 9)
        .and_then(|start| find_length_delimited_field(start, 10))
    {
        out.estimated_tokens = find_varint_field(window, 1).filter(|n| *n > 0);
        out.max_tokens = find_varint_field(window, 4).filter(|n| *n > 0);
    }
    (out != AgyNativeContext::default()).then_some(out)
}

/// Frontend `usage` shape for a native context read. Occupancy is only claimed
/// (`current_context`) when AGY reported both its estimate and the window;
/// otherwise the latest request's counts are labelled as such.
pub(crate) fn native_context_usage(ctx: &AgyNativeContext) -> Option<serde_json::Value> {
    use serde_json::json;
    let mut usage = match (ctx.estimated_tokens, ctx.max_tokens) {
        (Some(used), Some(_)) => json!({
            "context_usage_kind": "current_context",
            "context_usage": {"input_tokens": used, "output_tokens": 0},
        }),
        _ => match (ctx.input_tokens, ctx.output_tokens) {
            (Some(input), Some(output)) => json!({
                "context_usage_kind": "last_prompt",
                "context_usage": {
                    "input_tokens": input,
                    "output_tokens": output,
                    "cache_read_input_tokens": ctx.cache_read_tokens.unwrap_or(0),
                },
            }),
            _ => json!({}),
        },
    };
    if let Some(max) = ctx.max_tokens {
        usage["model_context_window"] = json!(max);
    }
    usage.as_object().is_some_and(|o| !o.is_empty()).then_some(usage)
}

fn find_varint_field(buf: &[u8], target_field: u64) -> Option<u64> {
    let mut i = 0;
    while i < buf.len() {
        let (tag, i2) = read_varint(buf, i)?;
        let field = tag >> 3;
        match (tag & 7) as u32 {
            0 => {
                let (value, n) = read_varint(buf, i2)?;
                if field == target_field {
                    return Some(value);
                }
                i = n;
            }
            1 if i2 + 8 <= buf.len() => i = i2 + 8,
            5 if i2 + 4 <= buf.len() => i = i2 + 4,
            2 => {
                let (len, i3) = read_varint(buf, i2)?;
                let end = i3.checked_add(len as usize)?;
                if end > buf.len() {
                    return None;
                }
                i = end;
            }
            _ => return None,
        }
    }
    None
}

pub(super) fn scan_agy_summary(path: &Path) -> ScanSummary {
    let parsed = parse_agy_session_inner(path, false);
    let mut first_ts = None;
    let mut last_ts = None;
    let mut title = String::new();
    let mut preview = String::new();
    for msg in &parsed.messages {
        let ts = msg.ts.as_deref().and_then(super::parse_ts_ms_str);
        if first_ts.is_none() {
            first_ts = ts;
        }
        if ts.is_some() {
            last_ts = ts;
        }
        if title.is_empty() && msg.role == "user" && !msg.text.trim().is_empty() {
            title = msg.text.chars().take(80).collect();
        }
        if !msg.text.trim().is_empty() && (msg.role == "assistant" || msg.role == "user") {
            preview = msg.text.chars().take(160).collect();
        }
    }

    if title.is_empty() {
        if let Some((stored, stored_preview, _)) = summary_row(path) {
            title = stored;
            if preview.is_empty() {
                preview = stored_preview;
            }
        }
    }
    if title.trim().is_empty() {
        title = "Antigravity".to_string();
    }

    let message_count = parsed
        .messages
        .iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .count() as i64;

    ScanSummary {
        prompt_cache: read_cache_reference(path),
        auxiliary_kind: None,
        title,
        preview,
        first_ts,
        last_ts,
        message_count,
    }
}

/// The latest completed model step supplies request timing and actual cache
/// reads. Provider ids/field numbers match the installed AGY 1.4.0 descriptors.
/// Later user/tool steps never refresh this clock; a cache miss is retained as
/// evidence and displayed neutrally rather than presumed to create a hot cache.
fn read_cache_reference(path: &Path) -> Option<super::prompt_cache::CacheWindow> {
    let conn = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let mut stmt = conn.prepare("SELECT step_payload FROM steps WHERE step_type=15 ORDER BY idx DESC LIMIT 8").ok()?;
    let rows = stmt.query_map([], |r| r.get::<_, Vec<u8>>(0)).ok()?;
    let bridge = session_home(path).and_then(Path::file_name).is_some_and(|name| name == "antigravity-cli-vertex");
    for payload in rows.flatten() {
        let Some(meta) = find_length_delimited_field(&payload, 5) else { continue };
        if metadata_timestamp_ms(meta, 8).is_none() || find_length_delimited_field(meta, 9).is_none() { continue; }
        // A completed unsupported/missing-policy step invalidates an older hint.
        return cache_reference_from_step(&payload, bridge);
    }
    None
}

fn cache_reference_from_step(payload: &[u8], vertex_bridge: bool) -> Option<super::prompt_cache::CacheWindow> {
    use super::prompt_cache::{CacheReference, CacheWindow};
    let meta = find_length_delimited_field(payload, 5)?;
    let usage = find_length_delimited_field(meta, 9)?;
    let provider = find_varint_field(usage, 6).unwrap_or(0);
    let model = find_varint_field(usage, 1).or_else(|| find_varint_field(meta, 11));
    let (ttl_seconds, max_ttl_seconds, source) = match provider {
        // Anthropic served through AGY's Vertex route: upstream default only,
        // never Claude Code subscription's one-hour policy.
        26 => (300, 300, "agy-anthropic-reference"),
        3 | 24 => (900, 900, "agy-gemini-reference"),
        // CCGUI's dedicated Gemini bridge reports BYOM without api_provider.
        0 if vertex_bridge && model == Some(326) => (900, 1200, "agy-vertex-reference"),
        _ => return None,
    };
    let input = find_varint_field(usage, 2).unwrap_or(0);
    let cache = find_varint_field(usage, 5).unwrap_or(0);
    let prompt = input.checked_add(cache).filter(|n| *n > 0 && *n <= 1_000_000_000_000)?;
    let started_at = metadata_timestamp_ms(meta, 32).or_else(|| metadata_timestamp_ms(meta, 1))?;
    let observed_at = metadata_timestamp_ms(meta, 8)?;
    if observed_at < started_at { return None; }
    Some(CacheWindow {
        ttl_seconds, started_at, observed_at, source: source.into(),
        reference: Some(CacheReference { max_ttl_seconds, cache_read_tokens: cache, prompt_tokens: prompt }),
    })
}

fn metadata_timestamp_ms(meta: &[u8], field: u64) -> Option<i64> {
    let ts = find_length_delimited_field(meta, field)?;
    let seconds = find_varint_field(ts, 1).filter(|n| *n > 0)?;
    let nanos = find_varint_field(ts, 2).unwrap_or(0);
    if nanos >= 1_000_000_000 { return None; }
    i64::try_from(seconds).ok()?.checked_mul(1000)?.checked_add((nanos / 1_000_000) as i64)
}

fn conversation_id(path: &Path) -> Option<String> {
    path.file_stem()
        .and_then(|s| s.to_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn strip_agy_images(raw: &str) -> (String, Vec<String>) {
    let marker = crate::engine::images::AGY_IMAGE_MARKER.trim();
    if let Some((before, after)) = raw.split_once(marker) {
        (
            before.trim().to_string(),
            super::extract::kimi_image_paths(after),
        )
    } else {
        (raw.trim().to_string(), Vec::new())
    }
}

/// Extract the step creation timestamp (`field 5 -> field 1`, `google.protobuf.Timestamp`)
/// in milliseconds since Unix epoch from a `steps.step_payload` protobuf blob.
fn extract_step_timestamp_ms(buf: &[u8]) -> Option<i64> {
    let meta = find_length_delimited_field(buf, 5)?;
    let ts_msg = find_length_delimited_field(meta, 1)?;
    let mut seconds: Option<u64> = None;
    let mut nanos: u64 = 0;
    let mut i = 0;
    while i < ts_msg.len() {
        let (tag, i2) = read_varint(ts_msg, i)?;
        let field = tag >> 3;
        match (tag & 7) as u32 {
            0 => {
                let (v, n) = read_varint(ts_msg, i2)?;
                if field == 1 {
                    seconds = Some(v);
                } else if field == 2 {
                    nanos = v;
                }
                i = n;
            }
            1 if i2 + 8 <= ts_msg.len() => i = i2 + 8,
            5 if i2 + 4 <= ts_msg.len() => i = i2 + 4,
            2 => {
                let (len, i3) = read_varint(ts_msg, i2)?;
                let end = i3.checked_add(len as usize)?;
                if end > ts_msg.len() {
                    return None;
                }
                i = end;
            }
            _ => return None,
        }
    }
    let secs = i64::try_from(seconds?).ok()?;
    if secs <= 0 {
        return None;
    }
    let sub_ms = i64::try_from(nanos / 1_000_000).unwrap_or(0);
    Some(secs.saturating_mul(1000).saturating_add(sub_ms))
}

/// Extract a user prompt from a `STEP_USER` (`step_type = 14`) protobuf payload.
/// `field 19` (`UserStep`) stores the user text in `field 2` (or `field 3 -> field 1`
/// for structured/task prompts).
fn extract_user_step_turn(buf: &[u8]) -> Option<UserTurn> {
    let user_step = find_length_delimited_field(buf, 19)?;
    let raw_bytes = find_length_delimited_field(user_step, 2)
        .filter(|b| !b.is_empty())
        .or_else(|| {
            let sub = find_length_delimited_field(user_step, 3)?;
            find_length_delimited_field(sub, 1).filter(|b| !b.is_empty())
        })?;
    let raw_str = std::str::from_utf8(raw_bytes).ok()?;
    if !is_clean_text(raw_str) {
        return None;
    }
    let (clean_text, images) = strip_agy_images(raw_str);
    if clean_text.is_empty() && images.is_empty() {
        return None;
    }
    Some(UserTurn {
        text: clean_text,
        ts_ms: extract_step_timestamp_ms(buf),
        images,
    })
}

fn find_length_delimited_field(buf: &[u8], target_field: u64) -> Option<&[u8]> {
    let mut i = 0;
    while i < buf.len() {
        let (tag, i2) = read_varint(buf, i)?;
        let field = tag >> 3;
        match (tag & 7) as u32 {
            0 => {
                let (_, n) = read_varint(buf, i2)?;
                i = n;
            }
            1 if i2 + 8 <= buf.len() => i = i2 + 8,
            5 if i2 + 4 <= buf.len() => i = i2 + 4,
            2 => {
                let (len, i3) = read_varint(buf, i2)?;
                let end = i3.checked_add(len as usize)?;
                if end > buf.len() {
                    return None;
                }
                if field == target_field {
                    return Some(&buf[i3..end]);
                }
                i = end;
            }
            _ => return None,
        }
    }
    None
}

fn session_home(path: &Path) -> Option<&Path> {
    let conversations = path.parent()?;
    (conversations.file_name()?.to_str()? == "conversations").then(|| conversations.parent()).flatten()
}

fn load_user_turns(session: &Path, conversation_id: Option<&str>) -> Vec<UserTurn> {
    let Some(id) = conversation_id else {
        return Vec::new();
    };
    let Some(home) = session_home(session) else { return Vec::new() };
    let path = home.join("history.jsonl");
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in text.lines() {
        let Ok(row) = serde_json::from_str::<HistoryLine>(line) else {
            continue;
        };
        if row.conversation_id.as_deref() != Some(id) {
            continue;
        }
        let Some(raw_display) = row.display.as_deref() else {
            continue;
        };
        let (clean_text, images) = strip_agy_images(raw_display);
        if clean_text.is_empty() && images.is_empty() {
            continue;
        }
        out.push(UserTurn {
            text: clean_text,
            ts_ms: row.timestamp,
            images,
        });
    }
    out
}

fn summary_row(path: &Path) -> Option<(String, String, i64)> {
    let id = conversation_id(path)?;
    let db = session_home(path)?.join("conversation_summaries.db");
    let conn =
        rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .ok()?;
    conn.query_row(
        "SELECT title, preview, step_count FROM conversation_summaries WHERE conversation_id = ?1",
        rusqlite::params![id],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        },
    )
    .ok()
}

fn load_steps(path: &Path) -> Option<Vec<(i64, Vec<u8>)>> {
    let conn =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .ok()?;
    let mut stmt = conn
        .prepare("SELECT step_type, step_payload FROM steps ORDER BY idx")
        .ok()?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))
        .ok()?;
    Some(rows.flatten().collect())
}

fn user_message(seq: i64, turn: UserTurn) -> Message {
    let mut msg = plain_message(seq, "user", turn.text, turn.ts_ms);
    msg.images = turn.images;
    msg
}

fn plain_message(seq: i64, role: &str, text: String, ts_ms: Option<i64>) -> Message {
    Message {
        seq,
        role: role.to_string(),
        text,
        ts: ts_ms.map(|n| n.to_string()),
        path: None,
        args: None,
        result: None,
        todos: None,
        usage: None,
        model: None,
        effort: None,
        duration_ms: None,
        images: Vec::new(),
    }
}

struct ProtoText {
    depth: u8,
    field: u64,
    text: String,
}

fn pick_assistant(texts: &[ProtoText]) -> Option<String> {
    // Visible reply is depth 1 / field 1 (field 8 is a copy).
    // Field 3 is hidden thinking ("The user wants…", "Investigating…").
    let primary: Vec<&str> = texts
        .iter()
        .filter(|t| t.depth == 1 && t.field == 1)
        .map(|t| t.text.as_str())
        .filter(|t| looks_like_assistant(t))
        .collect();
    longest_prose(&primary).map(|s| sanitize_assistant(&s))
}

fn longest_prose(texts: &[&str]) -> Option<String> {
    let mut best: Option<&str> = None;
    for text in texts {
        best = Some(match best {
            None => text,
            Some(prev) => {
                let t_cjk = has_cjk(text);
                let p_cjk = has_cjk(prev);
                if t_cjk && !p_cjk {
                    text
                } else if t_cjk == p_cjk && text.len() > prev.len() {
                    text
                } else {
                    prev
                }
            }
        });
    }
    best.map(str::to_string)
}

fn looks_like_assistant(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() || t.starts_with('{') || t.starts_with("bot-") || t.starts_with("file://") {
        return false;
    }
    if looks_like_tool_fragment(t) || looks_like_status_ping(t) {
        return false;
    }
    !looks_like_uuid(t) && is_clean_text(t)
}

fn looks_like_tool_fragment(text: &str) -> bool {
    let t = text.trim();
    if t.starts_with("ommandLine\"") {
        return true;
    }
    const MARKERS: &[&str] = &[
        "\"toolAction\"",
        "\"toolSummary\"",
        "\"WaitMsBeforeAsync\"",
        "user_information",
        "command(*)",
    ];
    MARKERS.iter().any(|m| t.contains(m))
}

fn looks_like_status_ping(text: &str) -> bool {
    let t = text.trim();
    let lower = t.to_ascii_lowercase();
    if lower.starts_with("waiting for") || lower.starts_with("i will wait") {
        return true;
    }
    t.starts_with("正在") && (t.contains("请稍候") || t.ends_with("...") || t.ends_with('…'))
}

/// WeCom webhook markdown (`<font color="info">`, `<@Name>`) is what agy
/// pastes back after a group push. History should show the words, not the tags.
fn sanitize_assistant(text: &str) -> String {
    normalize_wecom_mentions(&strip_named_tags(text, "font"))
}

fn strip_named_tags(text: &str, name: &str) -> String {
    let open = format!("<{name}");
    let close = format!("</{name}>");
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while !rest.is_empty() {
        if starts_ignore_ascii(rest, &open) {
            match rest.find('>') {
                Some(i) => rest = &rest[i + 1..],
                None => break,
            }
            continue;
        }
        if starts_ignore_ascii(rest, &close) {
            rest = &rest[close.len()..];
            continue;
        }
        let ch = rest.chars().next().unwrap();
        out.push(ch);
        rest = &rest[ch.len_utf8()..];
    }
    out
}

fn starts_ignore_ascii(text: &str, prefix: &str) -> bool {
    text.as_bytes()
        .get(..prefix.len())
        .is_some_and(|b| b.eq_ignore_ascii_case(prefix.as_bytes()))
}

fn normalize_wecom_mentions(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<@") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        if let Some(end) = after.find('>') {
            let name = after[..end].trim();
            if !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
            {
                out.push('@');
                out.push_str(name);
                rest = &after[end + 1..];
                continue;
            }
        }
        out.push_str("<@");
        rest = after;
    }
    out.push_str(rest);
    out
}

fn looks_like_uuid(text: &str) -> bool {
    let t = text.trim();
    t.len() == 36
        && t.as_bytes().get(8) == Some(&b'-')
        && t.bytes().filter(|b| *b == b'-').count() == 4
}

fn has_cjk(text: &str) -> bool {
    text.chars().any(has_cjk_char)
}

fn has_cjk_char(c: char) -> bool {
    ('\u{4e00}'..='\u{9fff}').contains(&c)
}

fn is_clean_text(text: &str) -> bool {
    text.chars()
        .all(|c| c == '\n' || c == '\r' || c == '\t' || !c.is_control())
}

fn proto_strings(buf: &[u8]) -> Vec<ProtoText> {
    let mut out = Vec::new();
    walk_proto(buf, 0, &mut out);
    out
}

fn is_valid_proto_message(buf: &[u8]) -> bool {
    if buf.is_empty() {
        return false;
    }
    let mut i = 0;
    while i < buf.len() {
        let Some((tag, i2)) = read_varint(buf, i) else {
            return false;
        };
        let field = tag >> 3;
        if field == 0 || field > 100 {
            return false;
        }
        match (tag & 7) as u32 {
            0 => match read_varint(buf, i2) {
                Some((_, n)) => i = n,
                None => return false,
            },
            1 if i2 + 8 <= buf.len() => i = i2 + 8,
            5 if i2 + 4 <= buf.len() => i = i2 + 4,
            2 => {
                let Some((len, i3)) = read_varint(buf, i2) else {
                    return false;
                };
                let Some(end) = i3.checked_add(len as usize) else {
                    return false;
                };
                if end > buf.len() {
                    return false;
                }
                i = end;
            }
            _ => return false,
        }
    }
    true
}

fn walk_proto(buf: &[u8], depth: u8, out: &mut Vec<ProtoText>) {
    if depth > 8 {
        return;
    }
    let mut i = 0;
    while i < buf.len() {
        let Some((tag, i2)) = read_varint(buf, i) else {
            break;
        };
        let field = tag >> 3;
        if field == 0 || field > 100 {
            break;
        }
        match (tag & 7) as u32 {
            0 => match read_varint(buf, i2) {
                Some((_, n)) => i = n,
                None => break,
            },
            1 if i2 + 8 <= buf.len() => i = i2 + 8,
            5 if i2 + 4 <= buf.len() => i = i2 + 4,
            2 => {
                let Some((len, i3)) = read_varint(buf, i2) else {
                    break;
                };
                let Some(end) = i3.checked_add(len as usize) else {
                    break;
                };
                if end > buf.len() {
                    break;
                }
                let chunk = &buf[i3..end];
                if let Ok(s) = std::str::from_utf8(chunk) {
                    if is_clean_text(s) && !s.trim().is_empty() {
                        out.push(ProtoText {
                            depth,
                            field,
                            text: s.to_string(),
                        });
                    }
                }
                if (depth > 0 || field == 20) && is_valid_proto_message(chunk) {
                    walk_proto(chunk, depth + 1, out);
                }
                i = end;
            }
            _ => break,
        }
    }
}

fn read_varint(buf: &[u8], mut i: usize) -> Option<(u64, usize)> {
    let mut x = 0u64;
    let mut shift = 0;
    while i < buf.len() {
        let b = buf[i];
        i += 1;
        x |= u64::from(b & 0x7f) << shift;
        if b < 0x80 {
            return Some((x, i));
        }
        shift += 7;
        if shift > 63 {
            return None;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_and_summary_are_loaded_from_the_session_own_home() {
        let root = std::env::temp_dir().join(format!("agy-history-{}", uuid::Uuid::new_v4()));
        for (name, text) in [("native", "subscription prompt"), ("vertex", "Vertex prompt 中文 😀")] {
            let home = root.join(name);
            std::fs::create_dir_all(home.join("conversations")).unwrap();
            let session = home.join("conversations/shared.db");
            std::fs::write(home.join("history.jsonl"), serde_json::json!({"display":text,"conversationId":"shared","timestamp":123}).to_string()).unwrap();
            let conn = rusqlite::Connection::open(home.join("conversation_summaries.db")).unwrap();
            conn.execute_batch("CREATE TABLE conversation_summaries (conversation_id TEXT, title TEXT, preview TEXT, step_count INTEGER)").unwrap();
            conn.execute("INSERT INTO conversation_summaries VALUES ('shared', ?1, ?1, 1)", [text]).unwrap();
            assert_eq!(load_user_turns(&session, Some("shared"))[0].text, text);
            assert_eq!(summary_row(&session).unwrap().0, text);
            let parsed = parse_agy_session_inner(&session, false);
            assert_eq!(parsed.messages[0].text, text);
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    fn encode_string_field(field: u64, text: &str) -> Vec<u8> {
        let mut out = Vec::new();
        let tag = (field << 3) | 2;
        write_varint(&mut out, tag);
        write_varint(&mut out, text.len() as u64);
        out.extend_from_slice(text.as_bytes());
        out
    }

    fn write_varint(out: &mut Vec<u8>, mut value: u64) {
        loop {
            let mut b = (value & 0x7f) as u8;
            value >>= 7;
            if value != 0 {
                b |= 0x80;
            }
            out.push(b);
            if value == 0 {
                break;
            }
        }
    }

    #[test]
    fn proto_walk_finds_nested_utf8() {
        // field 20 { field 1 = "你好世界 assistant reply here" }
        let inner = encode_string_field(1, "你好世界 assistant reply here");
        let outer = {
            let mut out = Vec::new();
            write_varint(&mut out, (20 << 3) | 2);
            write_varint(&mut out, inner.len() as u64);
            out.extend(inner);
            out
        };
        let texts = proto_strings(&outer);
        assert!(
            texts.iter().any(|t| t.text.contains("你好世界")),
            "{:?}",
            texts.iter().map(|t| &t.text).collect::<Vec<_>>()
        );
        assert_eq!(
            pick_assistant(&texts).as_deref(),
            Some("你好世界 assistant reply here")
        );
    }

    fn proto(depth: u8, field: u64, text: &str) -> ProtoText {
        ProtoText {
            depth,
            field,
            text: text.to_string(),
        }
    }

    #[test]
    fn assistant_prefers_depth1_field1_and_cjk() {
        let texts = vec![
            proto(1, 3, "The user asked about storage plans in general terms."),
            proto(1, 1, "拥有 5TB 空间说明您使用的是高阶方案。"),
            proto(3, 1, r#"ommandLine":"for f in /tmp/feishu_*.json; do jq"#),
        ];
        assert_eq!(
            pick_assistant(&texts).as_deref(),
            Some("拥有 5TB 空间说明您使用的是高阶方案。")
        );
    }

    #[test]
    fn strips_wecom_font_and_mentions() {
        assert_eq!(
            sanitize_assistant("[<font color=\"info\">完成</font>] 九思 <@Yyming>"),
            "[完成] 九思 @Yyming"
        );
        assert_eq!(
            sanitize_assistant("<font color=\"warning\">逾期</font>"),
            "逾期"
        );
    }

    #[test]
    fn rejects_progress_status() {
        assert!(looks_like_status_ping(
            "正在拉取相关仓库的最新提交记录以查找对应成员在周五（2026-09-11）的代码与 PR 记录，请稍候..."
        ));
        assert!(looks_like_status_ping(
            "I will wait for the background fetch to complete and analyze the commits."
        ));
        assert!(looks_like_status_ping("Waiting for notification."));
        assert!(!looks_like_status_ping(
            "已按照您的要求全部调整完毕，并已推送到企微群。"
        ));
    }

    #[test]
    fn ignores_thinking_field3() {
        let texts = vec![proto(
            1,
            3,
            "Investigating Enterprise WeChat webhook markdown support for @mentions.",
        )];
        assert!(pick_assistant(&texts).is_none());
    }

    #[test]
    fn rejects_tool_json_fragments() {
        assert!(looks_like_tool_fragment(
            r#"ommandLine":"curl -s -X POST https://project.feishu.cn/mcp"#
        ));
        assert!(looks_like_tool_fragment(
            r#"jects/fx/fx-data-server","WaitMsBeforeAsync":30000,"toolAction":"Search""#
        ));
        assert!(!looks_like_assistant(
            r#"ommandLine":"for f in /tmp/feishu_*.json; do jq -r '.try'"#
        ));
    }

    #[test]
    fn parses_live_agy_conversation_if_present() {
        let path = crate::engine::agy::agy_home()
            .join("conversations")
            .join("55541c2b-d633-420a-b1ff-39cbaf07a231.db");
        if !path.is_file() {
            return;
        }
        let parsed = parse_agy_session(&path);
        assert!(
            parsed
                .messages
                .iter()
                .any(|m| m.role == "user" && m.text.contains("飞书")),
            "users: {:?}",
            parsed
                .messages
                .iter()
                .filter(|m| m.role == "user")
                .map(|m| &m.text)
                .collect::<Vec<_>>()
        );
        assert!(
            parsed.messages.iter().all(|m| m.role != "tool"),
            "history must not dump reconstructed tool rows"
        );
        assert!(
            parsed
                .messages
                .iter()
                .all(|m| !m.text.contains("ommandLine") && !m.text.contains("WaitMsBeforeAsync")),
            "junk: {:?}",
            parsed
                .messages
                .iter()
                .map(|m| m.text.chars().take(60).collect::<String>())
                .collect::<Vec<_>>()
        );
        assert!(
            parsed
                .messages
                .iter()
                .any(|m| m.role == "assistant" && m.text.contains("飞书")),
            "roles: {:?}",
            parsed
                .messages
                .iter()
                .map(|m| (&m.role, m.text.chars().take(40).collect::<String>()))
                .collect::<Vec<_>>()
        );
        assert!(
            parsed
                .messages
                .iter()
                .all(|m| !m.text.contains("<font") && !m.text.contains("</font>")),
            "wecom tags leaked"
        );
        assert!(
            parsed.messages.iter().all(|m| {
                let t = m.text.as_str();
                !t.starts_with("The user")
                    && !t.starts_with("Initial assessment")
                    && !t.starts_with("Investigating ")
                    && !t.starts_with("The request involves")
                    && !t.starts_with("正在")
                    && !t.starts_with("Waiting for")
                    && !t.starts_with("I will wait")
            }),
            "thinking leaked: {:?}",
            parsed
                .messages
                .iter()
                .filter(|m| m.role == "assistant")
                .map(|m| m.text.chars().take(50).collect::<String>())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn tool_json_is_not_treated_as_assistant() {
        let json =
            r#"{"DirectoryPath":"/tmp","toolAction":"Checking","toolSummary":"Check config"}"#;
        assert!(pick_assistant(&[proto(1, 1, json)]).is_none());
    }

    #[test]
    fn strips_agy_image_marker_and_recovers_paths() {
        let ws = std::path::Path::new("/tmp/ws");
        let imgs = vec![
            "/Users/me/.ccgui-next/pasted-images/a.png".to_string(),
            "rel/b.jpg".to_string(),
        ];
        let prompt = crate::engine::images::agy_prompt_with_images("请看这张图", &imgs, ws);
        let (text, parsed_imgs) = strip_agy_images(&prompt);
        assert_eq!(text, "请看这张图");
        assert_eq!(parsed_imgs.len(), 2);
        assert_eq!(parsed_imgs[0], "/Users/me/.ccgui-next/pasted-images/a.png");
        assert!(parsed_imgs[1].ends_with("b.jpg"));

        // Image-only user turn (empty text prompt)
        let empty_prompt = crate::engine::images::agy_prompt_with_images("", &imgs[..1], ws);
        let (empty_text, empty_imgs) = strip_agy_images(empty_prompt.trim());
        assert_eq!(empty_text, "");
        assert_eq!(
            empty_imgs,
            vec!["/Users/me/.ccgui-next/pasted-images/a.png".to_string()]
        );
    }

    fn encode_bytes_field(field: u64, bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        write_varint(&mut out, (field << 3) | 2);
        write_varint(&mut out, bytes.len() as u64);
        out.extend_from_slice(bytes);
        out
    }

    fn encode_varint_field(field: u64, value: u64) -> Vec<u8> {
        let mut out = Vec::new();
        write_varint(&mut out, field << 3);
        write_varint(&mut out, value);
        out
    }

    fn assistant_with_usage(text: &str, input: u64, output: u64, cache: Option<u64>) -> Vec<u8> {
        let mut usage = encode_varint_field(2, input);
        usage.extend(encode_varint_field(3, output));
        if let Some(cache) = cache { usage.extend(encode_varint_field(5, cache)); }
        let mut payload = encode_bytes_field(5, &encode_bytes_field(9, &usage));
        payload.extend(encode_bytes_field(20, &encode_string_field(1, text)));
        payload
    }

    fn cache_step(provider: u64, model: u64, cache: u64, start: u64) -> Vec<u8> {
        let mut usage = encode_varint_field(1, model);
        usage.extend(encode_varint_field(2, 100));
        usage.extend(encode_varint_field(5, cache));
        usage.extend(encode_varint_field(6, provider));
        let mut meta = encode_bytes_field(9, &usage);
        meta.extend(encode_bytes_field(32, &encode_varint_field(1, start)));
        meta.extend(encode_bytes_field(8, &encode_varint_field(1, start + 10)));
        encode_bytes_field(5, &meta)
    }

    #[test]
    fn prompt_cache_agy_references_are_provider_scoped_and_require_request_evidence() {
        let start = 1_800_000_000;
        for (provider, model, bridge, ttl, max, source) in [
            (24, 1417, false, 900, 900, "agy-gemini-reference"),
            (26, 1404, false, 300, 300, "agy-anthropic-reference"),
            (0, 326, true, 900, 1200, "agy-vertex-reference"),
        ] {
            let w = cache_reference_from_step(&cache_step(provider, model, 900, start), bridge).unwrap();
            assert_eq!((w.ttl_seconds, w.max_ttl_seconds()), (ttl, max));
            assert_eq!(w.source, source);
            assert_eq!(w.reference.as_ref().unwrap().prompt_tokens, 1000);
            assert_eq!(w.heat((start as i64 + 60) * 1000), "hot");
            assert_eq!(w.heat((start as i64 + max + 10) * 1000), "cold");
            let missed = cache_reference_from_step(&cache_step(provider, model, 0, start), bridge).unwrap();
            assert_eq!(missed.heat((start as i64 + 60) * 1000), "unknown");
        }
        assert!(cache_reference_from_step(&cache_step(0, 326, 900, start), false).is_none());
        assert!(cache_reference_from_step(&cache_step(31, 1417, 900, start), false).is_none());
        assert!(cache_reference_from_step(&assistant_with_usage("reply", 100, 10, Some(900)), true).is_none());
        let w = cache_reference_from_step(&cache_step(0, 326, 900, start), true).unwrap();
        assert_eq!(w.heat((start as i64 + 17*60) * 1000), "unknown");
    }

    #[test]
    fn prompt_cache_agy_summary_uses_last_completed_model_step_not_late_activity() {
        let root = std::env::temp_dir().join(format!("agy-cache-{}", uuid::Uuid::new_v4()));
        let dir = root.join("antigravity-cli-vertex/conversations");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)").unwrap();
        conn.execute("INSERT INTO steps VALUES(0,15,?1)", [cache_step(0,326,900,1_800_000_000)]).unwrap();
        // A later user/tool activity, and an unfinished assistant response,
        // do not reset the preceding model request's reference clock.
        conn.execute("INSERT INTO steps VALUES(1,14,?1)", [encode_bytes_field(5, &encode_bytes_field(1, &encode_varint_field(1, 1_800_010_000)))]).unwrap();
        conn.execute("INSERT INTO steps VALUES(2,15,?1)", [encode_bytes_field(5, &encode_bytes_field(1, &encode_varint_field(1, 1_800_010_001)))]).unwrap();
        let w = scan_agy_summary(&path).prompt_cache.unwrap();
        assert_eq!(w.started_at, 1_800_000_000_000);
        assert_eq!(w.observed_at, 1_800_000_010_000);
        conn.execute("INSERT INTO steps VALUES(3,15,?1)", [cache_step(31,326,900,1_800_010_002)]).unwrap();
        assert!(read_cache_reference(&path).is_none());
        drop(conn);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn history_turn_billing_accumulates_steps_and_context_never_overwrites_it() {
        let root = std::env::temp_dir().join(format!("agy-billing-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("conversations")).unwrap();
        let path = root.join("conversations/session.db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB); CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB)").unwrap();
        for (idx, kind, data) in [
            (0, STEP_USER, encode_bytes_field(19, &encode_string_field(2, "first"))),
            (1, STEP_ASSISTANT, assistant_with_usage("first draft", 10, 2, Some(5))),
            (2, STEP_ASSISTANT, assistant_with_usage("first final", 20, 3, Some(7))),
            (3, STEP_USER, encode_bytes_field(19, &encode_string_field(2, "second"))),
            (4, STEP_ASSISTANT, assistant_with_usage("second final", 100, 9, Some(50))),
        ] {
            conn.execute("INSERT INTO steps VALUES (?1,?2,?3)", rusqlite::params![idx, kind, data]).unwrap();
        }
        let mut counts = encode_varint_field(2, 999);
        counts.extend(encode_varint_field(3, 888));
        let mut window = encode_varint_field(1, 1234);
        window.extend(encode_varint_field(4, 10000));
        let mut meta = encode_bytes_field(4, &counts);
        meta.extend(encode_bytes_field(9, &encode_bytes_field(10, &window)));
        conn.execute("INSERT INTO gen_metadata VALUES (0,?1)", [encode_bytes_field(1, &meta)]).unwrap();
        drop(conn);
        let parsed = parse_agy_session(&path);
        assert_eq!(parsed.messages.len(), 5);
        assert!(parsed.messages[1].usage.is_none());
        let first = parsed.messages[2].usage.as_ref().unwrap();
        assert_eq!(first["usage_scope"], "turn");
        assert_eq!(first["input_tokens"], 30);
        assert_eq!(first["output_tokens"], 5);
        assert_eq!(first["cache_read_input_tokens"], 12);
        assert_eq!(first["total_tokens"], 47);
        assert!(first.get("cached_input_tokens").is_none());
        let second = parsed.messages[4].usage.as_ref().unwrap();
        assert_eq!(second["input_tokens"], 100);
        assert_eq!(second["output_tokens"], 9);
        assert_eq!(second["total_tokens"], 159);
        assert_eq!(second["context_usage"]["input_tokens"], 1234);
        assert_eq!(second["model_context_window"], 10000);
        assert!(parsed.messages.iter().all(|m| m.duration_ms.is_none()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_billing_fields_and_missing_user_boundary_remain_unknown() {
        let mut turn = TurnUsage::new();
        turn.add(&assistant_with_usage("reply", 10, 2, None));
        turn.last_assistant = Some(0);
        let mut messages = vec![plain_message(1, "assistant", "reply".into(), None)];
        turn.finish(&mut messages);
        let usage = messages[0].usage.as_ref().unwrap();
        assert_eq!(usage["usage_scope"], "unknown");
        assert_eq!(usage["input_tokens"], 10);
        assert!(usage.get("cache_read_input_tokens").is_none());
        assert!(usage.get("total_tokens").is_none());
        let mut orphan = TurnUsage::default();
        orphan.add(&assistant_with_usage("orphan", 10, 2, Some(0)));
        orphan.last_assistant = Some(0);
        orphan.finish(&mut messages);
        assert_eq!(messages[0].usage.as_ref().unwrap(), &serde_json::json!({"usage_scope":"unknown"}));
    }

    #[test]
    fn user_step_payload_extracts_prompt_images_and_timestamp() {
        let ws = std::path::Path::new("/tmp/ws");
        let imgs = vec!["/Users/me/.ccgui-next/pasted-images/a.png".to_string()];
        let prompt = crate::engine::images::agy_prompt_with_images("全面审计项目", &imgs, ws);

        // field 5 { field 1 { field 1 = 1791911580, field 2 = 229000000 } }
        let mut ts_msg = encode_varint_field(1, 1_791_911_580);
        ts_msg.extend(encode_varint_field(2, 229_000_000));
        let meta = encode_bytes_field(1, &ts_msg);
        let mut payload = encode_bytes_field(5, &meta);
        // field 19 { field 2 = prompt }
        let user_step = encode_string_field(2, &prompt);
        payload.extend(encode_bytes_field(19, &user_step));

        let turn = extract_user_step_turn(&payload).expect("user step turn");
        assert_eq!(turn.text, "全面审计项目");
        assert_eq!(turn.ts_ms, Some(1_791_911_580_229));
        assert_eq!(
            turn.images,
            vec!["/Users/me/.ccgui-next/pasted-images/a.png".to_string()]
        );

        // Fallback to field 19 -> field 3 -> field 1
        let fallback_inner = encode_string_field(1, "structured task prompt");
        let fallback_step = encode_bytes_field(3, &fallback_inner);
        let fallback_payload = encode_bytes_field(19, &fallback_step);
        let fb_turn = extract_user_step_turn(&fallback_payload).expect("fallback user step");
        assert_eq!(fb_turn.text, "structured task prompt");
    }

    #[test]
    fn assistant_preserves_markdown_tables_code_blocks_and_short_replies() {
        let table_reply = "## 审计结论\n\n| 维度 | 状态 | 说明 |\n|---|---|---|\n| C# 静态与编译 | PASS | 0 Error |\n| PlayMode 回归 | PASS | 全部通过 |";
        let payload = encode_bytes_field(20, &encode_string_field(1, table_reply));
        assert_eq!(
            pick_assistant(&proto_strings(&payload)).as_deref(),
            Some(table_reply)
        );

        let code_reply = "配置示例如下：\n```json\n{\"CommandLine\": \"cargo test\", \"DirectoryPath\": \"/app\"}\n```";
        let payload2 = encode_bytes_field(20, &encode_string_field(1, code_reply));
        assert_eq!(
            pick_assistant(&proto_strings(&payload2)).as_deref(),
            Some(code_reply)
        );

        for short in ["OK", "已记住。", "42|KESTREL-7391", "__vp_keep_aaaa__"] {
            let p = encode_bytes_field(20, &encode_string_field(1, short));
            assert_eq!(pick_assistant(&proto_strings(&p)).as_deref(), Some(short));
        }
    }

    #[test]
    fn gen_metadata_yields_window_occupancy_and_request_counts() {
        let mut step = encode_varint_field(2, 3_856);
        step.extend(encode_varint_field(3, 1_205));
        step.extend(encode_varint_field(5, 51_047));
        let mut window = encode_varint_field(1, 99_350);
        window.extend(encode_varint_field(4, 256_000));
        let start = encode_bytes_field(10, &window);
        let mut meta = encode_bytes_field(4, &step);
        meta.extend(encode_bytes_field(9, &start));
        let data = encode_bytes_field(1, &meta);

        let ctx = parse_gen_metadata(&data).expect("context");
        assert_eq!(ctx.max_tokens, Some(256_000));
        assert_eq!(ctx.estimated_tokens, Some(99_350));
        assert_eq!(ctx.cache_read_tokens, Some(51_047));
        let usage = native_context_usage(&ctx).unwrap();
        assert_eq!(usage["context_usage_kind"], "current_context");
        assert_eq!(usage["context_usage"]["input_tokens"], 99_350);
        assert_eq!(usage["model_context_window"], 256_000);

        // Without a window estimate only the latest request is labelled.
        let only_step = encode_bytes_field(1, &encode_bytes_field(4, &step));
        let usage = native_context_usage(&parse_gen_metadata(&only_step).unwrap()).unwrap();
        assert_eq!(usage["context_usage_kind"], "last_prompt");
        assert_eq!(usage["context_usage"]["cache_read_input_tokens"], 51_047);
        assert!(usage.get("model_context_window").is_none());
        assert!(parse_gen_metadata(&[]).is_none());
    }

    #[test]
    fn checkpoint_step_replaces_chat_messages_in_native_context_until_next_assistant_turn() {
        let root = std::env::temp_dir().join(format!("agy-compact-ctx-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("session.db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB);
             CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY, data BLOB);",
        )
        .unwrap();

        let group = |name: &str, kind: u64, tokens: u64| {
            let mut g = encode_string_field(1, name);
            g.extend(encode_varint_field(2, kind));
            g.extend(encode_varint_field(4, tokens));
            encode_bytes_field(1, &g)
        };
        let mut breakdown = group("System Prompt", 1, 7_467);
        breakdown.extend(group("Tools", 2, 11_760));
        breakdown.extend(group("Chat Messages", 7, 150_000));
        let mut window = encode_varint_field(1, 169_227);
        window.extend(encode_bytes_field(3, &breakdown));
        window.extend(encode_varint_field(4, 200_000));
        let meta = encode_bytes_field(9, &encode_bytes_field(10, &window));
        conn.execute(
            "INSERT INTO gen_metadata VALUES (0, ?1)",
            [encode_bytes_field(1, &meta)],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO steps VALUES (0, ?1, ?2)",
            rusqlite::params![STEP_ASSISTANT, assistant_with_usage("reply", 100, 20, Some(0))],
        )
        .unwrap();

        let before = read_native_context(&path).unwrap();
        assert_eq!(before.estimated_tokens, Some(169_227));
        assert_eq!(before.max_tokens, Some(200_000));

        let mut checkpoint_usage = encode_varint_field(2, 150_000);
        checkpoint_usage.extend(encode_varint_field(3, 350));
        let retry_info = encode_bytes_field(2, &checkpoint_usage);
        let step_meta = encode_bytes_field(28, &retry_info);
        let mut checkpoint_payload = encode_bytes_field(5, &step_meta);
        checkpoint_payload.extend(encode_bytes_field(
            30,
            &encode_string_field(5, "<summary>compacted</summary>"),
        ));
        conn.execute(
            "INSERT INTO steps VALUES (1, ?1, ?2)",
            rusqlite::params![STEP_CHECKPOINT, checkpoint_payload],
        )
        .unwrap();

        let compacted = read_native_context(&path).unwrap();
        assert_eq!(compacted.estimated_tokens, Some(7_467 + 11_760 + 350));
        assert_eq!(compacted.max_tokens, Some(200_000));

        conn.execute(
            "INSERT INTO steps VALUES (2, ?1, ?2)",
            rusqlite::params![STEP_ASSISTANT, assistant_with_usage("next", 50, 10, Some(0))],
        )
        .unwrap();
        let after_next = read_native_context(&path).unwrap();
        assert_eq!(after_next.estimated_tokens, Some(169_227));

        drop(conn);
        std::fs::remove_dir_all(root).unwrap();
    }

}
