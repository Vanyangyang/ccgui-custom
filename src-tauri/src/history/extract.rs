use super::{content_text, parse_ts_ms_str, Message};
use serde_json::Value;
use std::collections::HashMap;
use std::io::BufRead;
use std::path::{Path, PathBuf};

pub struct ParsedSession {
    pub messages: Vec<Message>,
}

/// Parse a native session file into the minimal message list. Bad lines are
/// skipped individually.
pub fn parse_session_file(engine: &str, path: &Path) -> Result<ParsedSession, String> {
    if engine == "agy" {
        return Ok(super::agy::parse_agy_session(path));
    }
    if engine == "opencode" {
        return Ok(parse_opencode_session(path));
    }
    let reader = open_line_reader(engine, path)?;
    collect_session(reader, &extractor_for(engine, ImageMode::Collect, None))
        .map_err(|e| format!("read {}: {e}", path.display()))
}

/// The message view of a Codex rollout, where the prompts this app handed to
/// Codex Desktop (`digests`, see `desktop_prompt_digest`) read back as the
/// user rows they were typed as. Titles, previews and search keep reading
/// the transcript as Codex wrote it.
pub fn parse_session_file_with_handoffs(
    engine: &str,
    path: &Path,
    digests: std::collections::HashSet<String>,
) -> Result<ParsedSession, String> {
    let handed = (engine == "codex" && !digests.is_empty())
        .then(|| codex_rollout_thread(path))
        .flatten()
        .map(|thread| HandedPrompts { thread, digests });
    if handed.is_none() {
        return parse_session_file(engine, path);
    }
    let reader = open_line_reader(engine, path)?;
    collect_session(reader, &extractor_for(engine, ImageMode::Collect, handed))
        .map_err(|e| format!("read {}: {e}", path.display()))
}

/// Everything the sidebar needs from a scan: title/preview/timestamps/count.
/// Derived in one streaming pass without materializing the message list or
/// any image data URLs.
pub struct ScanSummary {
    pub prompt_cache: Option<super::prompt_cache::CacheWindow>,
    pub auxiliary_kind: Option<String>,
    pub title: String,
    pub preview: String,
    pub first_ts: Option<i64>,
    pub last_ts: Option<i64>,
    pub message_count: i64,
}

/// The scan-time parse: same line walk as `parse_session_file`, but folds
/// each row into a bounded accumulator instead of a Vec<Message>. Codex image
/// rows retain empty attachment markers so skipping payloads preserves counts.
pub fn scan_summary_file(engine: &str, path: &Path) -> Result<ScanSummary, String> {
    if engine == "agy" {
        return Ok(super::agy::scan_agy_summary(path));
    }
    if engine == "opencode" {
        return Ok(scan_opencode_summary(path));
    }
    let reader = open_line_reader(engine, path)?;
    let mut acc = ScanAcc { cursor: engine == "cursor", ..ScanAcc::default() };
    let cache = std::cell::RefCell::new(super::prompt_cache::Tracker::new(engine));
    let extract = extractor_for(engine, ImageMode::SkipDataUrls, None);
    let observed: LineExtractor<'_> = Box::new(|value| {
        cache.borrow_mut().observe(value);
        extract(value)
    });
    walk_lines(reader, &observed, |row| {
        acc.accept(row);
    })
    .map_err(|e| format!("read {}: {e}", path.display()))?;
    drop(observed);
    let mut summary = acc.finish();
    summary.prompt_cache = cache.into_inner().finish();
    Ok(summary)
}

/// DSH and compressed Codex sessions use streaming zstd decoding.
fn open_line_reader(engine: &str, path: &Path) -> Result<Box<dyn BufRead>, String> {
    if engine == "codex" {
        return super::codex_rollout::open_reader(path)
            .map_err(|e| format!("open {}: {e}", path.display()));
    }
    let file = std::fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    if engine == "dsh" {
        let decoder = zstd::stream::read::Decoder::new(std::io::BufReader::new(file))
            .map_err(|e| format!("zstd {}: {e}", path.display()))?;
        Ok(Box::new(std::io::BufReader::new(decoder)))
    } else {
        Ok(Box::new(std::io::BufReader::new(file)))
    }
}

/// Image payloads: the reader renders them, the scanner must not build them.
#[derive(Clone, Copy, PartialEq)]
enum ImageMode {
    Collect,
    SkipDataUrls,
}

type LineExtractor<'a> = Box<dyn Fn(&Value) -> LineRows + 'a>;

/// Prompts this app handed to Codex Desktop for the rollout's own thread.
struct HandedPrompts {
    thread: String,
    digests: std::collections::HashSet<String>,
}

#[derive(Default)]
struct CodexHistoryContext {
    model: Option<String>,
    effort: Option<String>,
    turn_id: Option<String>,
    native_start: bool,
    waiting_for_user: bool,
}

fn extractor_for(
    engine: &str,
    images: ImageMode,
    handed: Option<HandedPrompts>,
) -> LineExtractor<'static> {
    if engine == "dsh" {
        Box::new(extract_dsh_line)
    } else if engine == "codex" {
        // Native turn_context is the per-turn model evidence. The session's
        // latest picker choice and thread metadata cannot label older usage.
        let context = std::cell::RefCell::new(CodexHistoryContext::default());
        Box::new(move |value| {
            let mut context = context.borrow_mut();
            let turn_id = value.pointer("/payload/turn_id")
                .and_then(Value::as_str).map(str::to_string);
            if type_str(value) == "event_msg" {
                match value.pointer("/payload/type").and_then(Value::as_str) {
                    Some("task_started") => {
                        if turn_id.is_none() || context.turn_id != turn_id {
                            *context = CodexHistoryContext::default();
                        }
                        context.turn_id = turn_id;
                        context.native_start = true;
                        return vec![LineRow::new("__codex_turn__", String::new(), None)];
                    }
                    Some("task_complete" | "turn_aborted") => {
                        if context.turn_id == turn_id {
                            context.native_start = false;
                            context.waiting_for_user = false;
                        }
                    }
                    _ => {}
                }
            }
            if type_str(value) == "turn_context" {
                let model = value.pointer("/payload/model").and_then(Value::as_str)
                    .map(str::trim).filter(|model| !model.is_empty()).map(str::to_string);
                let effort = value.pointer("/payload/effort")
                    .or_else(|| value.pointer("/payload/reasoning_effort"))
                    .or_else(|| value.pointer("/payload/collaboration_mode/settings/reasoning_effort"))
                    .and_then(Value::as_str).map(str::trim)
                    .filter(|effort| !effort.is_empty()).map(str::to_string);
                if context.turn_id != turn_id { context.native_start = false; }
                context.turn_id = turn_id;
                context.model = model;
                context.effort = effort;
                context.waiting_for_user = true;
                return vec![LineRow::new("__codex_turn__", String::new(), None)];
            }
            let mut rows = extract_codex_line(value, images);
            if let Some(handed) = handed.as_ref() {
                rows.extend(codex_handed_prompt(value, handed));
            }
            let has_user = rows.iter().any(|row| {
                if row.role != "user" { return false; }
                let text = super::clean_user_turn(&row.text);
                !super::is_injected_user_context(&text) && (!text.trim().is_empty() || !row.images.is_empty())
            });
            if has_user {
                // Modern rollouts name the native turn before its user row.
                // Legacy files may put context immediately before that row.
                // A later user without either evidence starts an unknown turn.
                if !context.native_start {
                    if !context.waiting_for_user {
                        context.model = None;
                        context.effort = None;
                    }
                    rows.insert(0, LineRow::new("__codex_turn__", String::new(), None));
                }
                context.waiting_for_user = false;
            }
            if rows.iter().any(|row| matches!(row.role.as_str(), "assistant" | "thinking" | "tool")) {
                context.waiting_for_user = false;
            }
            for row in &mut rows {
                if matches!(row.role.as_str(), "assistant" | "thinking" | "tool" | "__usage__") {
                    row.model = context.model.clone();
                    row.effort = context.effort.clone();
                }
            }
            rows
        })
    } else {
        let engine = engine.to_string();
        Box::new(move |value| extract_line_messages(&engine, value, images))
    }
}

/// Line-loop skeleton shared by the full parse and the scan summary: decode
/// one NDJSON line, extract rows, normalize, hand each to `consume`.
fn walk_lines(
    mut reader: impl BufRead,
    extract: &LineExtractor<'_>,
    mut consume: impl FnMut(LineRow),
) -> std::io::Result<()> {
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        if reader.read_until(b'\n', &mut buffer)? == 0 {
            break;
        }
        // An active writer can leave an incomplete UTF-8 line. Keep skipping
        // malformed payload lines, but propagate actual I/O/decoder failures.
        let Ok(line) = std::str::from_utf8(&buffer) else {
            continue;
        };
        let trimmed = line.trim();
        if trimmed.is_empty() || (!trimmed.contains("\"type\"") && !trimmed.contains("\"role\"")) {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        for row in extract(&value) {
            let Some(row) = normalize_extracted_row(row) else {
                continue;
            };
            consume(row);
        }
    }
    Ok(())
}

fn collect_session(
    reader: impl BufRead,
    extract: &LineExtractor<'_>,
) -> std::io::Result<ParsedSession> {
    let mut rows = Vec::new();
    walk_lines(reader, extract, |row| rows.push(row))?;
    Ok(fold_rows(rows))
}

#[derive(Default)]
struct GeneratedScan {
    failed: bool,
    tool_counted: bool,
    image_counted: bool,
}

/// Native completion records and raw response items can arrive in either
/// order. Reconcile only image-producing calls, keeping their first position,
/// unioning distinct images/text, and letting a terminal failure win.
fn coalesce_generated_rows(rows: Vec<LineRow>) -> Vec<LineRow> {
    if !rows.iter().any(|row| row.generated_key.is_some()) { return rows; }
    #[derive(Default)]
    struct Seen { tool: Option<usize>, image: Option<usize>, failed: bool }
    let mut seen = HashMap::<String, Seen>::new();
    let failures: HashMap<_, _> = rows.iter().filter(|row| row.role == "__generated_failure__")
        .filter_map(|row| Some((row.generated_key.clone()?, (row.text.clone(), row.result.clone()?))))
        .collect();
    let mut out = Vec::<LineRow>::with_capacity(rows.len());
    for mut row in rows {
        if row.role == "__generated_failure__" { continue; }
        let Some(key) = row.generated_key.as_ref() else { out.push(row); continue; };
        if let Some((name, result)) = failures.get(key) {
            row.generated_failed = true;
            if row.role == "tool" {
                row.result = Some(merge_generated_result(result.clone(), row.result.as_ref().unwrap_or(&Value::Null)));
                row.text = name.clone();
            }
        }
        let entry = seen.entry(key.clone()).or_default();
        entry.failed |= row.generated_failed;
        if entry.failed {
            row.images.clear();
            if let Some(index) = entry.image { out[index].images.clear(); }
        }
        if row.role == "tool" {
            if let Some(index) = entry.tool {
                let current = &mut out[index];
                let previous = current.result.take().unwrap_or(Value::Null);
                let incoming = row.result.take().unwrap_or(Value::Null);
                current.result = Some(if row.generated_failed && !current.generated_failed {
                    merge_generated_result(incoming, &previous)
                } else { merge_generated_result(previous, &incoming) });
                current.generated_failed |= row.generated_failed;
                if current.text == "tool_result" { current.text = row.text; }
                continue;
            }
            entry.tool = Some(out.len());
        } else if row.role == "assistant" {
            if let Some(index) = entry.image {
                let current = &mut out[index];
                // A native call produces one image. Prefer its inline history
                // copy so reload still works after the original file is removed.
                if row.generated_native {
                    if current.images.is_empty() || (row.images.iter().any(|image| image.starts_with("data:"))
                        && !current.images.iter().any(|image| image.starts_with("data:"))) {
                        current.images = row.images;
                    }
                } else {
                    if crate::engine::generated_images::append_images(&mut current.images, row.images) {
                        if let Some(tool) = entry.tool {
                            if let Some(result) = out[tool].result.as_mut() {
                                result["imageOmitted"] = Value::from("Combined output exceeds 16 images or 32 MiB");
                            }
                        }
                    }
                }
                continue;
            }
            entry.image = Some(out.len());
        }
        out.push(row);
    }
    out
}

fn merge_generated_result(mut preferred: Value, other: &Value) -> Value {
    fn texts(value: &Value, out: &mut Vec<String>) {
        if matches!(type_str(value), "text" | "input_text" | "inputText") {
            if let Some(text) = value.get("text").and_then(Value::as_str) {
                if !out.iter().any(|old| old == text) { out.push(text.to_string()); }
            }
        }
        if let Some(parts) = value.as_array() {
            for part in parts { texts(part, out); }
        } else {
            for key in ["output", "result", "content", "contentItems", "additionalOutput"] {
                if let Some(child) = value.get(key) { texts(child, out); }
            }
        }
    }
    let mut existing = Vec::new();
    let mut incoming = Vec::new();
    texts(&preferred, &mut existing);
    texts(other, &mut incoming);
    let additions: Vec<_> = incoming.into_iter().filter(|text| !existing.contains(text))
        .map(|text| serde_json::json!({"type":"text","text":text})).collect();
    if !additions.is_empty() {
        if let Some(fields) = preferred.as_object_mut() {
            let extra = fields.entry("additionalOutput").or_insert_with(|| Value::Array(Vec::new()));
            if let Some(parts) = extra.as_array_mut() { parts.extend(additions); }
        }
    }
    preferred
}

/// Shared fold over extracted rows (usage markers, tool-result pairing,
/// durations, seq numbering) — opencode feeds it from its storage-tree walk
/// instead of an NDJSON line reader.
fn fold_rows(rows: Vec<LineRow>) -> ParsedSession {
    let mut messages = Vec::<Message>::new();
    let mut seq = 0i64;
    let mut last_user_ts: Option<i64> = None;
    let mut context_window: Option<Value> = None;
    let mut context_model: Option<String> = None;
    let mut codex_turn_start = 0;
    // tool call id -> index in `messages`. Results arrive in completion order,
    // so pairing them back up by the latest row still missing one mislabels
    // parallel calls; the id is what actually names the call.
    let mut call_rows: HashMap<String, usize> = HashMap::new();
    for row in coalesce_generated_rows(rows) {
        if row.role == "__codex_turn__" {
            // A new turn without output must not relabel an older turn's
            // answer or attach its startup token sample to that answer.
            codex_turn_start = messages.len();
            context_window = None;
            context_model = None;
            continue;
        }
        // Window metadata can precede the latest output row (for example,
        // text with usage followed by a tool). Remember only real capacity
        // reports from model output; an explicit model change invalidates it.
        if matches!(row.role.as_str(), "assistant" | "tool" | "thinking" | "__usage__") {
            if let Some(model) = row.model.as_ref() {
                if context_model.as_ref().is_some_and(|previous| previous != model) {
                    context_window = None;
                }
                context_model = Some(model.clone());
            }
            if let Some(window) = row.usage.as_ref()
                .and_then(|usage| usage.get("model_context_window"))
                .filter(|window| window.as_u64().is_some_and(|tokens| tokens > 0)) {
                context_window = Some(window.clone());
            }
        }
        // Usage-only marker (codex token_count or claude compact_boundary): fold
        // onto the latest model output instead of creating an empty row.
        if row.role == "__usage__" {
            if let Some(last) = messages[codex_turn_start..].iter_mut().rev()
                .find(|m| matches!(m.role.as_str(), "assistant" | "tool" | "thinking")) {
                let mut new_usage = row.usage;
                if let (Some(mcw), Some(next)) = (context_window.as_ref(), new_usage.as_mut()) {
                    if let Some(obj) = next.as_object_mut() {
                        if !obj.contains_key("model_context_window") {
                            obj.insert("model_context_window".to_string(), mcw.clone());
                        }
                    }
                }
                last.usage = new_usage;
                if row.model.is_some() {
                    last.model = row.model;
                }
                if row.effort.is_some() {
                    last.effort = row.effort;
                }
            }
            continue;
        }
        // Tool result marker: fold onto its named call when the transcript
        // carries a call id, else retain the legacy latest-unresolved fallback.
        if row.role == "__tool_result__" {
            if let Some(res) = row.result {
                let named = row
                    .tool_call_id
                    .as_deref()
                    .and_then(|id| call_rows.get(id).copied());
                let index = match named {
                    // A replayed result must not consume another call.
                    Some(index) => messages[index].result.is_none().then_some(index),
                    // An id naming no known call: strict engines (pi) drop it,
                    // while claude keeps the result on the latest open call.
                    None if row.tool_call_id.is_some() && !row.id_fallback => None,
                    None => messages
                        .iter()
                        .rposition(|m| m.role == "tool" && m.result.is_none()),
                };
                if let Some(index) = index {
                    if let Some(todos) = crate::engine::parse_todo_result(&res) {
                        messages[index].todos = Some(todos);
                    }
                    messages[index].result = Some(res);
                }
            }
            continue;
        }
        if row.role != "auto_review" && row.text.trim().is_empty() && row.images.is_empty() {
            continue;
        }
        let parsed_ts = row.ts.as_deref().and_then(super::parse_ts_ms_str);
        if row.role == "user" {
            last_user_ts = parsed_ts;
        }
        let duration_ms = row.duration_ms.or_else(|| {
            if row.role == "assistant" {
                if let (Some(u_ts), Some(a_ts)) = (last_user_ts, parsed_ts) {
                    if a_ts >= u_ts && a_ts - u_ts < 24 * 3600 * 1000 {
                        return Some(a_ts - u_ts);
                    }
                }
            }
            None
        });
        seq += 1;
        let call_id = row.tool_call_id;
        messages.push(Message {
            seq,
            role: row.role,
            text: row.text,
            ts: row.ts,
            path: row.path,
            args: row.args,
            result: row.result,
            todos: row.todos,
            usage: row.usage,
            model: row.model,
            effort: row.effort,
            duration_ms,
            images: row.images,
        });
        if let Some(id) = call_id {
            call_rows.insert(id, messages.len() - 1);
        }
    }
    ParsedSession { messages }
}

/// Scan accumulator: small generated-call identities, never image payloads.
#[derive(Default)]
struct ScanAcc {
    generated: HashMap<String, GeneratedScan>,
    cursor: bool,
    auxiliary_kind: Option<String>,
    count: i64,
    first_ts: Option<String>,
    last_ts: Option<String>,
    title: Option<String>,
    first_user_text: Option<String>,
    last_assistant_text: Option<String>,
}

impl ScanAcc {
    fn accept(&mut self, row: LineRow) {
        if let Some(key) = row.generated_key.as_ref() {
            let previous = self.generated.entry(key.clone()).or_default();
            if row.generated_failed && !previous.failed {
                previous.failed = true;
                if previous.image_counted { self.count -= 1; previous.image_counted = false; }
            }
            if row.role == "tool" {
                if previous.tool_counted { return; }
                previous.tool_counted = true;
            } else if row.role == "assistant" {
                if previous.failed || previous.image_counted || row.images.is_empty() { return; }
                previous.image_counted = true;
            }
        }
        if row.role == "__generated_failure__" { return; }
        if row.role == "__usage__" {
            return;
        }
        if row.role != "auto_review" && row.text.trim().is_empty() && row.images.is_empty() {
            return;
        }
        if self.count == 0 {
            self.first_ts = row.ts.clone();
        }
        self.count += 1;
        self.last_ts = row.ts.clone();
        match row.role.as_str() {
            "user" => {
                if self.cursor && self.first_user_text.is_none() {
                    if let Some((kind, task)) = super::cursor_auxiliary::classify(&row.text) {
                        self.auxiliary_kind = Some(kind.to_string());
                        self.title = Some(super::truncate_chars(&super::strip_title_noise(task), 80));
                    }
                }
                // Mirrors strip_title_noise: first non-noise user body wins, the
                // first user row (even noise) is the fallback.
                if self.title.is_none() {
                    let body = super::strip_title_noise(&row.text);
                    if !body.is_empty() {
                        self.title = Some(super::truncate_chars(&body, 80));
                    }
                }
                if self.first_user_text.is_none() {
                    self.first_user_text = Some(row.text);
                }
            }
            "assistant" if !row.text.trim().is_empty() => self.last_assistant_text = Some(row.text),
            _ => {}
        }
    }

    fn finish(self) -> ScanSummary {
        let title = self
            .title
            .or_else(|| self.first_user_text.map(|t| super::truncate_chars(&t, 80)))
            .unwrap_or_default();
        ScanSummary {
            prompt_cache: None,
            auxiliary_kind: self.auxiliary_kind,
            title,
            preview: self
                .last_assistant_text
                .map(|t| super::truncate_chars(&t, 120))
                .unwrap_or_default(),
            first_ts: self.first_ts.as_deref().and_then(parse_ts_ms_str),
            last_ts: self.last_ts.as_deref().and_then(parse_ts_ms_str),
            message_count: self.count,
        }
    }
}

fn extract_dsh_line(value: &Value) -> LineRows {
    let line_type = type_str(value);
    let ts = value
        .get("time")
        .and_then(Value::as_i64)
        .map(|ms| ms.to_string());
    match line_type {
        "user/message" => {
            let text = content_text(value.get("data").and_then(|d| d.get("content")));
            // Skip injected runtime context / system reminders — not user text.
            let trimmed = text.trim();
            if trimmed.starts_with("<system-reminder>")
                || trimmed.starts_with("Current runtime context")
            {
                return Vec::new();
            }
            if trimmed.is_empty() {
                Vec::new()
            } else {
                vec![LineRow::new("user", text, ts)]
            }
        }
        "assistant/message" => {
            let content = value
                .get("data")
                .and_then(|d| d.get("message"))
                .and_then(|m| m.get("content"));
            let text = match content {
                Some(Value::Array(parts)) => text_of_parts(parts, true, ""),
                other => content_text(other),
            };
            if text.trim().is_empty() {
                Vec::new()
            } else {
                vec![LineRow::new("assistant", text, ts)]
            }
        }
        _ => Vec::new(),
    }
}

/// Paths embedded by `kimi_prompt_with_images` after the marker block, one
/// `<image path="...">` tag per attachment.
pub(super) fn kimi_image_paths(block: &str) -> Vec<String> {
    const TAG: &str = "<image path=\"";
    let mut out = Vec::new();
    let mut rest = block;
    while let Some(start) = rest.find(TAG) {
        rest = &rest[start + TAG.len()..];
        match rest.find('"') {
            Some(end) => {
                out.push(rest[..end].to_string());
                rest = &rest[end..];
            }
            None => break,
        }
    }
    out
}

/// Claude image content block -> data URL for direct WebView rendering.
fn claude_image_data_url(block: &Value) -> Option<String> {
    let source = block.get("source")?;
    let data = source.get("data").and_then(Value::as_str)?;
    if data.is_empty() {
        return None;
    }
    let mime = source
        .get("media_type")
        .and_then(Value::as_str)
        .unwrap_or("image/png");
    Some(format!("data:{mime};base64,{data}"))
}

/// pi/omp image content part (`{type:"image", data, mimeType}`) -> data URL.
fn pi_image_part(part: &Value) -> Option<String> {
    if part.get("type").and_then(Value::as_str) != Some("image") {
        return None;
    }
    let data = part.get("data").and_then(Value::as_str)?;
    if data.is_empty() {
        return None;
    }
    let mime = part
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or("image/png");
    Some(format!("data:{mime};base64,{data}"))
}

/// Codex token_count `info` → occupancy + the window the CLI actually used.
/// last_token_usage is this request; total_token_usage is session-billed
/// cumulative and must not fill the context bar. Keep an unknown snapshot
/// when last is unavailable so history cannot reuse an earlier occupancy.
fn usage_from_codex_token_info(info: Option<&Value>) -> Option<Value> {
    let info = info?.as_object()?;
    let mut usage = match info
        .get("last_token_usage")
        .filter(|last| last.is_object())
        .cloned()
    {
        Some(mut last) => {
            // 【Codex历史用量范围】原生历史仅记录最后一次请求占用，标记为 last_request 以避免冒充整轮完整用量。
            if let Some(obj) = last.as_object_mut() {
                obj.insert("usage_scope".to_string(), Value::from("last_request"));
            }
            last
        }
        None => Value::Object(info.clone()),
    };
    if let Some(window) = info.get("model_context_window") {
        if let Some(obj) = usage.as_object_mut() {
            obj.insert("model_context_window".to_string(), window.clone());
        }
    }
    Some(usage)
}

/// Codex `input_image` content part -> its `image_url` (data URL or path).
fn codex_image_part(part: &Value, collect: bool) -> Option<String> {
    if part.get("type").and_then(Value::as_str) != Some("input_image") {
        return None;
    }
    let url = part.get("image_url").and_then(Value::as_str)?;
    if url.is_empty() {
        None
    } else {
        Some(if collect { url.to_string() } else { String::new() })
    }
}

/// `value["type"]` as a string slice, empty when absent.
fn type_str(value: &Value) -> &str {
    value.get("type").and_then(Value::as_str).unwrap_or("")
}

/// First string-valued timestamp among `keys` (engines disagree on the
/// field name; grok alone has used three).
fn ts_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| value.get(k).and_then(Value::as_str))
        .map(str::to_string)
}

/// Join the `text` payloads of content parts; `typed_only` keeps only
/// `type == "text"` parts.
fn text_of_parts(parts: &[Value], typed_only: bool, sep: &str) -> String {
    parts
        .iter()
        .filter(|p| !typed_only || type_str(p) == "text")
        .filter_map(|p| p.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(sep)
}

/// One extracted row from a native session line.
struct LineRow {
    role: String,
    text: String,
    ts: Option<String>,
    path: Option<String>,
    args: Option<Value>,
    tool_call_id: Option<String>,
    /// Result rows only: when `tool_call_id` names no known call, attach to the
    /// latest unresolved one instead of dropping the result.
    id_fallback: bool,
    result: Option<Value>,
    todos: Option<crate::engine::TodosPayload>,
    usage: Option<Value>,
    model: Option<String>,
    effort: Option<String>,
    duration_ms: Option<i64>,
    images: Vec<String>,
    /// Same native call can be persisted both as item_completed and as a raw
    /// response output. Only these generated-image projections are deduplicated.
    generated_key: Option<String>,
    generated_failed: bool,
    generated_native: bool,
}

impl LineRow {
    /// A plain row without usage/model metadata.
    fn new(role: &str, text: String, ts: Option<String>) -> Self {
        Self {
            role: role.to_string(),
            text,
            ts,
            path: None,
            args: None,
            tool_call_id: None,
            id_fallback: false,
            result: None,
            todos: None,
            usage: None,
            model: None,
            effort: None,
            duration_ms: None,
            images: Vec::new(),
            generated_key: None,
            generated_failed: false,
            generated_native: false,
        }
    }
}

type LineRows = Vec<LineRow>;

/// Drop injected context turns and unwrap `<user_query>` so every engine's
/// message list (and therefore titles) share one envelope cleaner.
fn normalize_extracted_row(mut row: LineRow) -> Option<LineRow> {
    if row.role != "user" {
        return Some(row);
    }
    let text = super::clean_user_turn(&row.text);
    if super::is_injected_user_context(&text) {
        return None;
    }
    if text.trim().is_empty() && row.images.is_empty() {
        return None;
    }
    row.text = text;
    Some(row)
}

/// Per-engine NDJSON line -> zero or more (role, text, ts, usage, model) tuples.
fn extract_line_messages(engine: &str, value: &Value, images: ImageMode) -> LineRows {
    match engine {
        "claude" => extract_claude_line(value, images),
        "kimi" => extract_kimi_line(value),
        "grok" => extract_grok_line(value),
        "codex" => extract_codex_line(value, images),
        "pi" | "omp" => extract_pi_family_line(value, images),
        "qoder" | "qoder-cn" => extract_qoder_line(value, images),
        "cursor" => extract_cursor_line(value),
        _ => Vec::new(),
    }
}

/// Strip Cursor's `[REDACTED]` thinking placeholder when it appears as a
/// standalone block or as a leading/trailing paragraph on an assistant turn.
fn strip_cursor_redacted(text: &str) -> String {
    let mut s = text.trim();
    while let Some(before) = s.strip_suffix("[REDACTED]") {
        s = before.trim_end();
    }
    while let Some(after) = s.strip_prefix("[REDACTED]") {
        s = after.trim_start();
    }
    if s.is_empty() {
        String::new()
    } else if s.len() == text.trim().len() {
        text.to_string()
    } else {
        s.to_string()
    }
}

/// Cursor agent-transcripts lines: `{"role","message":{"content":[..]}}`; the
/// trailing `{"type":"turn_ended"}` marker carries no message.
fn extract_cursor_line(value: &Value) -> LineRows {
    let role = match value.get("role").and_then(Value::as_str) {
        Some(role @ ("user" | "assistant")) => role,
        _ => return Vec::new(),
    };
    if role == "user" {
        let text = match value.pointer("/message/content") {
            Some(Value::Array(parts)) => text_of_parts(parts, true, "\n"),
            Some(Value::String(text)) => text.clone(),
            _ => String::new(),
        };
        let (display, images) = match text.find(crate::engine::cursor::CURSOR_IMAGE_MARKER) {
            Some(idx) => (
                text[..idx].trim_end().to_string(),
                kimi_image_paths(&text[idx..]),
            ),
            None => (text, Vec::new()),
        };
        if display.trim().is_empty() && images.is_empty() {
            return Vec::new();
        }
        return vec![LineRow {
            images,
            ..LineRow::new("user", display, None)
        }];
    }

    match value.pointer("/message/content") {
        Some(Value::Array(parts)) => {
            let mut out = Vec::new();
            let mut text_parts: Vec<String> = Vec::new();
            let flush_text = |out: &mut LineRows, text_parts: &mut Vec<String>| {
                if !text_parts.is_empty() {
                    let joined = text_parts.join("\n");
                    text_parts.clear();
                    if !joined.trim().is_empty() {
                        out.push(LineRow::new("assistant", joined, None));
                    }
                }
            };
            for part in parts {
                match type_str(part) {
                    "text" => {
                        if let Some(raw) = part.get("text").and_then(Value::as_str) {
                            let cleaned = strip_cursor_redacted(raw);
                            if !cleaned.trim().is_empty() {
                                text_parts.push(cleaned);
                            }
                        }
                    }
                    "tool_use" => {
                        flush_text(&mut out, &mut text_parts);
                        let name = part
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("tool")
                            .to_string();
                        let input = part.get("input");
                        out.push(LineRow {
                            path: input.and_then(crate::engine::tool_path_arg),
                            args: input.and_then(crate::engine::parse_tool_args_value),
                            todos: input.and_then(crate::engine::parse_todo_args),
                            tool_call_id: part
                                .get("id")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                            ..LineRow::new("tool", name, None)
                        });
                    }
                    _ => {}
                }
            }
            flush_text(&mut out, &mut text_parts);
            out
        }
        Some(Value::String(text)) => {
            let cleaned = strip_cursor_redacted(text);
            if cleaned.trim().is_empty() {
                Vec::new()
            } else {
                vec![LineRow::new("assistant", cleaned, None)]
            }
        }
        _ => Vec::new(),
    }
}

/// Codex rollout lines: {timestamp, type, payload}. Messages are
/// response_item payloads of type "message".
fn extract_codex_line(value: &Value, images: ImageMode) -> LineRows {
    let line_type = type_str(value);
    let ts = ts_string(value, &["timestamp"]);
    match line_type {
        "response_item" => {
            let Some(payload) = value.get("payload") else {
                return Vec::new();
            };
            match type_str(payload) {
                "image_generation_call" => return codex_generated_rows(payload, images, ts, true),
                "function_call_output" | "custom_tool_call_output" => {
                    return codex_generated_rows(payload, images, ts, false);
                }
                _ => {}
            }
            // Reasoning items persist the visible summary; encrypted
            // content is skipped.
            if payload.get("type").and_then(Value::as_str) == Some("reasoning") {
                let text = match payload.get("summary") {
                    Some(Value::Array(parts)) => text_of_parts(parts, false, "\n"),
                    _ => String::new(),
                };
                return if text.trim().is_empty() {
                    Vec::new()
                } else {
                    vec![LineRow::new("thinking", text, ts)]
                };
            }
            if payload.get("type").and_then(Value::as_str) != Some("message") {
                return Vec::new();
            }
            let role = payload
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if role != "user" && role != "assistant" {
                return Vec::new();
            }
            // content blocks: input_text / output_text
            let content = payload.get("content");
            let text = match content {
                Some(Value::Array(parts)) => text_of_parts(parts, false, ""),
                other => content_text(other),
            };
            let collected = match content {
                Some(Value::Array(parts)) => {
                    parts.iter().filter_map(|part| codex_image_part(part, images == ImageMode::Collect)).collect()
                }
                _ => Vec::new(),
            };
            if text.trim().is_empty() && collected.is_empty() {
                Vec::new()
            } else {
                vec![LineRow {
                    images: collected,
                    ..LineRow::new(&role, text, ts)
                }]
            }
        }
        "event_msg" => {
            let Some(payload) = value.get("payload") else {
                return Vec::new();
            };
            if type_str(payload) == "item_completed" {
                if let Some(item) = payload.get("item") {
                    match type_str(item) {
                        "ImageGeneration" | "imageGeneration" => return codex_generated_rows(item, images, ts, true),
                        "McpToolCall" | "mcpToolCall" | "DynamicToolCall" | "dynamicToolCall" => {
                            return codex_generated_rows(item, images, ts, false);
                        }
                        _ => {}
                    }
                }
            }
            if type_str(payload) == "guardian_assessment" {
                return codex_guardian_assessment(payload, ts).into_iter().collect();
            }
            if payload.get("type").and_then(Value::as_str) == Some("token_count") {
                if let Some(usage) = usage_from_codex_token_info(payload.get("info")) {
                    return vec![LineRow {
                        usage: Some(usage),
                        ..LineRow::new("__usage__", String::new(), ts)
                    }];
                }
            }
            Vec::new()
        }
        _ => Vec::new(),
    }
}

fn codex_generated_rows(item: &Value, mode: ImageMode, ts: Option<String>, native: bool) -> LineRows {
    use crate::engine::generated_images;
    let collect = mode == ImageMode::Collect;
    let failed = generated_images::failed(item);
    let images = if native { generated_images::native_history_images(item, collect) }
        else if failed { Vec::new() }
        else { generated_images::output_images(item, collect) };
    let key = item.get("call_id").or_else(|| item.get("id"))
        .and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_string);
    let result = if native {
        // `result` is native base64; only status/path/failure belong in details.
        generated_images::native_display_result(item)
    } else {
        let mut fields = serde_json::Map::new();
        for field in ["output", "result", "contentItems", "status", "success", "error"] {
            if let Some(value) = item.get(field) { fields.insert(field.to_string(), generated_images::display_result(value)); }
        }
        Value::Object(fields)
    };
    let name = if native { "image_generation" }
        else { item.get("tool").or_else(|| item.get("name")).and_then(Value::as_str).unwrap_or("tool_result") };
    if !native && !generated_images::contains_images(item) {
        // A failed item can have no result at all, while its raw response copy
        // still contains an image. Correlate the failure without adding rows
        // for unrelated ordinary failed tools.
        return if failed && key.is_some() { vec![LineRow {
            result: Some(result), generated_key: key, generated_failed: true,
            ..LineRow::new("__generated_failure__", name.to_string(), ts)
        }] } else { Vec::new() };
    }
    let mut rows = vec![LineRow {
        result: Some(result), generated_key: key.clone(), generated_failed: failed, generated_native: native,
        ..LineRow::new("tool", name.to_string(), ts.clone())
    }];
    if !images.is_empty() || failed {
        // A failed completion can have a raw response copy without status.
        // Record its identity too; the empty blocker is never rendered/countable.
        rows.push(LineRow { images, generated_key: key, generated_failed: failed, generated_native: native,
            ..LineRow::new("assistant", String::new(), ts) });
    }
    rows
}

/// Only terminal, schema-valid assessments are historical rows. Start events
/// deliberately stay out of history so a review is not displayed twice.
fn codex_guardian_assessment(payload: &Value, ts: Option<String>) -> Option<LineRow> {
    let status = match payload.get("status")?.as_str()? {
        "approved" => "approved",
        "denied" => "denied",
        "timed_out" => "timedOut",
        "aborted" => "aborted",
        _ => return None,
    };
    let id = payload.get("id")?.as_str()?;
    if id.is_empty() {
        return None;
    }
    let turn_id = match payload.get("turn_id") {
        None => "",
        Some(value) => value.as_str()?,
    };
    let started = match payload.get("started_at_ms") {
        None => 0,
        Some(value) => value.as_i64()?,
    };
    let optional_string = |key: &str| -> Option<Value> {
        match payload.get(key) {
            None | Some(Value::Null) => Some(Value::Null),
            Some(Value::String(value)) => Some(Value::String(value.clone())),
            _ => None,
        }
    };
    let risk = optional_string("risk_level")?;
    if !risk.is_null() && !matches!(risk.as_str(), Some("low" | "medium" | "high" | "critical")) {
        return None;
    }
    let authorization = optional_string("user_authorization")?;
    if !authorization.is_null()
        && !matches!(
            authorization.as_str(),
            Some("unknown" | "low" | "medium" | "high")
        )
    {
        return None;
    }
    let mut args = serde_json::json!({
        "reviewId": id,
        "turnId": turn_id,
        "targetItemId": optional_string("target_item_id")?,
        "startedAtMs": started,
        "review": { "status": status, "riskLevel": risk,
            "userAuthorization": authorization, "rationale": optional_string("rationale")? },
        "action": codex_guardian_action(payload.get("action")?)?,
    });
    if let Some(completed) = payload
        .get("completed_at_ms")
        .filter(|value| !value.is_null())
    {
        args["completedAtMs"] = Value::from(completed.as_i64()?);
    }
    Some(LineRow {
        args: Some(args),
        ..LineRow::new("auto_review", String::new(), ts)
    })
}

/// Map the native protocol's snake_case action to the app-server v2 shape.
fn codex_guardian_action(action: &Value) -> Option<Value> {
    let kind = action.get("type")?.as_str()?;
    let (mapped, strings, arrays, nullable): (&str, &[(&str, &str)], &[&str], &[(&str, &str)]) =
        match kind {
            "command" => (
                "command",
                &[("command", "command"), ("cwd", "cwd")],
                &[],
                &[],
            ),
            "execve" => (
                "execve",
                &[("program", "program"), ("cwd", "cwd")],
                &["argv"],
                &[],
            ),
            "write_stdin" => (
                "writeStdin",
                &[
                    ("approval_id", "approvalId"),
                    ("process_id", "processId"),
                    ("stdin", "stdin"),
                    ("cwd", "cwd"),
                ],
                &[],
                &[],
            ),
            "apply_patch" => ("applyPatch", &[("cwd", "cwd")], &["files"], &[]),
            "network_access" => (
                "networkAccess",
                &[("target", "target"), ("host", "host")],
                &[],
                &[],
            ),
            "mcp_tool_call" => (
                "mcpToolCall",
                &[("server", "server"), ("tool_name", "toolName")],
                &[],
                &[
                    ("connector_id", "connectorId"),
                    ("connector_name", "connectorName"),
                    ("tool_title", "toolTitle"),
                ],
            ),
            "request_permissions" => ("requestPermissions", &[], &[], &[("reason", "reason")]),
            _ => return None,
        };
    let mut out = serde_json::json!({ "type": mapped });
    for &(native, app) in strings {
        out[app] = Value::String(action.get(native)?.as_str()?.to_string());
    }
    for &key in arrays {
        let values = action.get(key)?.as_array()?;
        if !values.iter().all(Value::is_string) {
            return None;
        }
        out[key] = Value::Array(values.clone());
    }
    for &(native, app) in nullable {
        let value = action.get(native).unwrap_or(&Value::Null);
        if !value.is_null() && !value.is_string() {
            return None;
        }
        out[app] = value.clone();
    }
    if matches!(kind, "command" | "execve") {
        out["source"] = Value::from(match action.get("source")?.as_str()? {
            "shell" => "shell",
            "unified_exec" => "unifiedExec",
            _ => return None,
        });
    }
    if kind == "network_access" {
        out["protocol"] = Value::from(match action.get("protocol")?.as_str()? {
            "http" => "http",
            "https" | "https_connect" | "http-connect" => "https",
            "socks5_tcp" => "socks5Tcp",
            "socks5_udp" => "socks5Udp",
            _ => return None,
        });
        let port = action.get("port")?.as_u64()?;
        if port > u16::MAX as u64 {
            return None;
        }
        out["port"] = Value::from(port);
    }
    if kind == "request_permissions" {
        let permissions = action.get("permissions")?.as_object()?;
        let mut mapped = serde_json::json!({"network": null, "fileSystem": null});
        for (native, app) in [("network", "network"), ("file_system", "fileSystem")] {
            if let Some(value) = permissions.get(native).filter(|value| !value.is_null()) {
                let mut value = value.as_object()?.clone();
                if native == "network" {
                    if value
                        .get("enabled")
                        .is_some_and(|v| !v.is_null() && !v.is_boolean())
                    {
                        return None;
                    }
                    value.entry("enabled").or_insert(Value::Null);
                } else {
                    for key in ["read", "write"] {
                        if let Some(v) = value.get(key).filter(|v| !v.is_null()) {
                            if !v.as_array()?.iter().all(Value::is_string) {
                                return None;
                            }
                        }
                        value.entry(key).or_insert(Value::Null);
                    }
                    if value
                        .get("glob_scan_max_depth")
                        .is_some_and(|v| v.as_u64().is_none())
                    {
                        return None;
                    }
                    if let Some(entries) = value.get("entries") {
                        for entry in entries.as_array()? {
                            entry.get("path")?.as_object()?;
                            entry.get("access")?.as_str()?;
                        }
                    }
                }
                if let Some(depth) = value.remove("glob_scan_max_depth") {
                    value.insert("globScanMaxDepth".into(), depth);
                }
                mapped[app] = Value::Object(value);
            }
        }
        out["permissions"] = mapped;
    }
    Some(out)
}

/// The thread a rollout belongs to: `rollout-<timestamp>-<thread id>.jsonl`.
fn codex_rollout_thread(path: &Path) -> Option<String> {
    let plain = super::codex_rollout::plain_path(path);
    let stem = plain.file_stem()?.to_str()?;
    let id = stem.get(stem.len().checked_sub(36)?..)?;
    uuid::Uuid::parse_str(id).ok().map(|_| id.to_string())
}

/// A prompt this app handed to Codex Desktop for a thread it holds. Desktop
/// records it as a `send_message_to_thread` tool output wrapping the prompt
/// in `<codex_delegation>`, sent by the thread to itself, not as a user
/// message. Other tools (Spellcast) deliver in the same shape with generated
/// text, so only prompts whose digest this app recorded read back as the
/// user row they were typed as; everything else stays hidden, as before.
fn codex_handed_prompt(value: &Value, handed: &HandedPrompts) -> Option<LineRow> {
    if type_str(value) != "response_item" {
        return None;
    }
    let payload = value.get("payload")?;
    if type_str(payload) != "function_call_output"
        || payload.get("name").and_then(Value::as_str) != Some("send_message_to_thread")
        || payload.get("namespace").and_then(Value::as_str) != Some("codex_app")
    {
        return None;
    }
    let body = payload
        .get("output")?
        .as_str()?
        .trim()
        .strip_prefix("<codex_delegation>")?
        .strip_suffix("</codex_delegation>")?;
    let source = body
        .split_once("<source_thread_id>")?
        .1
        .split_once("</source_thread_id>")?
        .0;
    if !source.trim().eq_ignore_ascii_case(&handed.thread) {
        return None;
    }
    // XML-escaped, so the closing tag cannot occur inside the prompt.
    let start = body.find("<input>")? + "<input>".len();
    let text = body.get(start..body.rfind("</input>")?)?;
    let text = text
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&");
    if !handed.digests.contains(&super::desktop_prompt_digest(&text)) {
        return None;
    }
    Some(LineRow::new("user", text, ts_string(value, &["timestamp"])))
}

/// Flush buffered assistant text ahead of a toolCall/thinking part so the
/// timeline keeps calls where they actually happened.
fn pi_flush_text(out: &mut LineRows, text: &mut String, ts: &Option<String>, role: &str) {
    if !text.trim().is_empty() {
        out.push(LineRow::new(role, std::mem::take(text), ts.clone()));
    }
}

/// One pi/omp assistant content part -> rows appended to `out`, with plain
/// text accumulating into `text`.
fn pi_assistant_part(part: &Value, out: &mut LineRows, text: &mut String, ts: &Option<String>) {
    match part.get("type").and_then(Value::as_str) {
        Some("text") => {
            if let Some(t) = part.get("text").and_then(Value::as_str) {
                text.push_str(t);
            }
        }
        Some("toolCall") => {
            pi_flush_text(out, text, ts, "assistant");
            let name = part.get("name").and_then(Value::as_str).unwrap_or("tool");
            let intent = part.get("intent").and_then(Value::as_str);
            let arguments = part.get("arguments");
            out.push(LineRow {
                path: arguments.and_then(crate::engine::tool_path_arg),
                args: arguments.and_then(crate::engine::parse_tool_args_value),
                tool_call_id: part.get("id").and_then(Value::as_str).map(str::to_string),
                // Session files store `arguments` as an already-parsed object.
                todos: arguments.and_then(crate::engine::parse_todo_args),
                ..LineRow::new(
                    "tool",
                    crate::engine::pi_family::tool_label(name, intent),
                    ts.clone(),
                )
            });
        }
        Some("thinking") => {
            pi_flush_text(out, text, ts, "assistant");
            if let Some(t) = part.get("thinking").and_then(Value::as_str) {
                out.push(LineRow::new("thinking", t.to_string(), ts.clone()));
            }
        }
        _ => {}
    }
}

/// pi/omp session lines: {type:"message", timestamp, message:{role, content, usage?}}
fn extract_pi_family_line(value: &Value, images: ImageMode) -> LineRows {
    if value.get("type").and_then(Value::as_str) == Some("compaction") {
        if let Some(usage) = crate::engine::pi_family::pi_compaction_usage(value) {
            return vec![LineRow {
                usage: Some(usage),
                ..LineRow::new("__usage__", String::new(), ts_string(value, &["timestamp"]))
            }];
        }
        return Vec::new();
    }
    if value.get("type").and_then(Value::as_str) != Some("message") {
        return Vec::new();
    }
    let ts = ts_string(value, &["timestamp"]);
    let Some(message) = value.get("message") else {
        return Vec::new();
    };
    let role = message.get("role").and_then(Value::as_str).unwrap_or("");
    let usage = message.get("usage").cloned();
    let model = message
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string);
    let effort = value
        .get("effort")
        .or_else(|| message.get("effort"))
        .or_else(|| message.get("thinking_effort"))
        .and_then(Value::as_str)
        .map(str::to_string);
    match role {
        "user" => {
            let content = message.get("content");
            let text = match content {
                Some(Value::Array(parts)) => text_of_parts(parts, true, ""),
                other => content_text(other),
            };
            let collected = match (images, content) {
                (ImageMode::Collect, Some(Value::Array(parts))) => {
                    parts.iter().filter_map(pi_image_part).collect()
                }
                _ => Vec::new(),
            };
            if text.trim().is_empty() && collected.is_empty() {
                Vec::new()
            } else {
                vec![LineRow {
                    usage,
                    images: collected,
                    ..LineRow::new("user", text, ts)
                }]
            }
        }
        // Assistant content interleaves text and toolCall parts; walk it in
        // order so the timeline shows tool calls where they actually happened.
        "assistant" => match message.get("content") {
            Some(Value::Array(parts)) => {
                let mut out: LineRows = Vec::new();
                let mut text = String::new();
                for part in parts {
                    pi_assistant_part(part, &mut out, &mut text, &ts);
                }
                if !text.trim().is_empty() {
                    out.push(LineRow {
                        usage,
                        model,
                        effort,
                        ..LineRow::new("assistant", text, ts)
                    });
                }
                out
            }
            other => {
                let text = content_text(other);
                if text.trim().is_empty() {
                    Vec::new()
                } else {
                    vec![LineRow {
                        usage,
                        model,
                        effort,
                        ..LineRow::new("assistant", text, ts)
                    }]
                }
            }
        },
        "toolResult" => {
            let content = message.get("content").cloned();
            let text = match content.as_ref() {
                Some(Value::Array(parts)) => text_of_parts(parts, false, "\n"),
                other => content_text(other),
            };
            let details = message.get("details").cloned();
            let result = match details {
                Some(details) if !details.is_null() => Some(serde_json::json!({
                    "text": text,
                    "details": details,
                })),
                _ => Some(Value::String(text)),
            };
            vec![LineRow {
                tool_call_id: message
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                result,
                ..LineRow::new("__tool_result__", String::new(), ts)
            }]
        }
        _ => Vec::new(),
    }
}

/// Flush buffered claude text as a row carrying the line's usage/model/effort.
fn claude_flush_text(
    out: &mut LineRows,
    text: &mut String,
    role: &str,
    ts: &Option<String>,
    usage: &Option<Value>,
    model: &Option<String>,
    effort: &Option<String>,
) {
    if !text.trim().is_empty() {
        out.push(LineRow {
            usage: usage.clone(),
            model: model.clone(),
            effort: effort.clone(),
            ..LineRow::new(role, std::mem::take(text), ts.clone())
        });
    }
}

/// The tool_use id a `tool_result` block answers (qoder also spells it camelCase).
fn tool_result_call_id(block: &Value) -> Option<String> {
    block
        .get("tool_use_id")
        .or_else(|| block.get("toolUseId"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// One claude content block; text accumulates, thinking/tool_use flush it.
fn claude_block_rows(
    block: &Value,
    images: ImageMode,
    out: &mut LineRows,
    text: &mut String,
    collected_images: &mut Vec<String>,
    role: &str,
    ts: &Option<String>,
    usage: &Option<Value>,
    model: &Option<String>,
    effort: &Option<String>,
) {
    match block.get("type").and_then(Value::as_str) {
        Some("thinking") => {
            claude_flush_text(out, text, role, ts, usage, model, effort);
            if let Some(t) = block.get("thinking").and_then(Value::as_str) {
                out.push(LineRow::new("thinking", t.to_string(), ts.clone()));
            }
        }
        Some("tool_use") => {
            claude_flush_text(out, text, role, ts, usage, model, effort);
            let name = block
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string();
            let input = block.get("input");
            out.push(LineRow {
                path: input.and_then(crate::engine::tool_path_arg),
                args: input.and_then(crate::engine::parse_tool_args_value),
                // Claude writes tool_result lines in completion order, so the
                // call id is the only reliable key for pairing parallel calls.
                tool_call_id: block.get("id").and_then(Value::as_str).map(str::to_string),
                todos: input.and_then(crate::engine::parse_todo_args),
                ..LineRow::new("tool", name, ts.clone())
            });
        }
        Some("tool_result") => {
            let res = block.get("content").cloned();
            out.push(LineRow {
                tool_call_id: tool_result_call_id(block),
                // Truncated or compacted transcripts can lack the matching
                // tool_use; keep the result on the latest open call as before.
                id_fallback: true,
                result: res,
                ..LineRow::new("__tool_result__", String::new(), ts.clone())
            });
        }
        Some("image") => {
            if images == ImageMode::Collect {
                if let Some(url) = claude_image_data_url(block) {
                    collected_images.push(url);
                }
            }
        }
        _ => {
            if let Some(t) = block.get("text").and_then(Value::as_str) {
                text.push_str(t);
            }
        }
    }
}

/// Text the CLI logs as a user turn when Stop interrupts a reply or a tool
/// call without killing the process. It records the abort, not typed input.
const CLAUDE_INTERRUPT_MARKERS: [&str; 2] = [
    "[Request interrupted by user]",
    "[Request interrupted by user for tool use]",
];

/// Model name Claude Code stamps on replies it generates without an API
/// call (rate-limit and other API error notices).
pub(crate) const CLAUDE_SYNTHETIC_MODEL: &str = "<synthetic>";

fn is_claude_interrupt_text(text: &str) -> bool {
    CLAUDE_INTERRUPT_MARKERS.contains(&text.trim())
}

/// True when the whole turn is an interrupt marker, as a plain string or as
/// text blocks only. A typed message that merely mentions the phrase, or that
/// carries an image or other block next to it, has more than the marker and
/// stays.
fn is_claude_interrupt_marker(content: Option<&Value>) -> bool {
    match content {
        Some(Value::String(text)) => is_claude_interrupt_text(text),
        Some(Value::Array(blocks)) => {
            blocks.iter().all(|block| type_str(block) == "text")
                && is_claude_interrupt_text(&text_of_parts(blocks, true, ""))
        }
        _ => false,
    }
}

fn extract_claude_line(value: &Value, images: ImageMode) -> LineRows {
    let line_type = type_str(value);
    if line_type == "system" {
        if value.get("subtype").and_then(Value::as_str) == Some("compact_boundary") {
            let post_tokens = value
                .get("compactMetadata")
                .and_then(|m| m.get("postTokens").or_else(|| m.get("post_tokens")))
                .and_then(Value::as_i64);
            if let Some(tokens) = post_tokens {
                let ts = ts_string(value, &["timestamp"]);
                let usage = serde_json::json!({
                    "input_tokens": tokens,
                    "total_tokens": tokens,
                });
                return vec![LineRow {
                    usage: Some(usage),
                    ..LineRow::new("__usage__", String::new(), ts)
                }];
            }
        }
        return Vec::new();
    }
    if line_type != "user" && line_type != "assistant" {
        return Vec::new();
    }
    // Slash-command expansions and other CLI-internal turns are logged with
    // `isMeta`; Claude Code itself never renders them in the transcript.
    if value.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return Vec::new();
    }
    let Some(message) = value.get("message") else {
        return Vec::new();
    };
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or(line_type)
        .to_string();
    // An interrupt-only Stop leaves the CLI alive and appends this record; the
    // live stream never shows it, so the reopened history must not either.
    if role == "user" && is_claude_interrupt_marker(message.get("content")) {
        return Vec::new();
    }
    let ts = ts_string(value, &["timestamp"]);
    // Claude Code logs replies it generated locally (an API error such as a
    // hit usage limit) under the `<synthetic>` model with all-zero usage. No
    // request reached a model, so neither field describes the session: the
    // zero snapshot superseded the real occupancy and a reopened session's
    // context gauge fell back to "unknown". The text itself still shows.
    let synthetic = message.get("model").and_then(Value::as_str) == Some(CLAUDE_SYNTHETIC_MODEL);
    let usage = if synthetic { None } else {
        message.get("usage").cloned().map(|mut usage| {
            // Transcript assistant usage covers one model request. The row's
            // timestamp-derived duration can include earlier tools/requests.
            if let Some(obj) = usage.as_object_mut() {
                obj.insert("usage_scope".to_string(), Value::from("last_request"));
            }
            usage
        })
    };
    let model = if synthetic {
        None
    } else {
        message
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let effort = value
        .get("effort")
        .or_else(|| message.get("effort"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let content = message.get("content");
    let mut out = Vec::new();
    match content {
        Some(Value::Array(blocks)) => {
            // Walk content blocks in order so thinking and tool calls land
            // where they actually happened relative to the text.
            let mut text = String::new();
            let mut collected: Vec<String> = Vec::new();
            for block in blocks {
                claude_block_rows(
                    block,
                    images,
                    &mut out,
                    &mut text,
                    &mut collected,
                    &role,
                    &ts,
                    &usage,
                    &model,
                    &effort,
                );
            }
            if !text.trim().is_empty() {
                out.push(LineRow {
                    usage: usage.clone(),
                    model: model.clone(),
                    effort: effort.clone(),
                    images: collected,
                    ..LineRow::new(&role, text, ts.clone())
                });
            } else if !collected.is_empty() {
                out.push(LineRow {
                    images: collected,
                    ..LineRow::new(&role, String::new(), ts.clone())
                });
            }
        }
        _ => {
            let text = content_text(content);
            if !text.trim().is_empty() {
                out.push(LineRow {
                    usage: usage.clone(),
                    model: model.clone(),
                    effort: effort.clone(),
                    ..LineRow::new(&role, text, ts.clone())
                });
            }
        }
    }
    if role == "assistant" && !out.iter().any(|row| row.role == "assistant" && !row.text.trim().is_empty()) {
        // A response's snapshot belongs to one existing output row, even if
        // Claude only thought or invoked tools. Do not duplicate billing for
        // every block or invent an assistant text message for metadata.
        if let Some(last) = out.iter_mut().rev().find(|row| {
            matches!(row.role.as_str(), "assistant" | "tool" | "thinking")
                && (!row.text.trim().is_empty() || !row.images.is_empty())
        }) {
            last.usage = usage;
            last.model = model;
            last.effort = effort;
        } else if usage.is_some() {
            // Empty response bodies still supersede older snapshots. The
            // existing sentinel fold updates a prior output when one exists;
            // a transcript with no output stays empty, rather than fabricating a row.
            out.push(LineRow {
                usage,
                model,
                effort,
                ..LineRow::new("__usage__", String::new(), ts)
            });
        }
    }
    out
}

fn extract_kimi_line(value: &Value) -> LineRows {
    let line_type = type_str(value);
    let ts = value
        .get("time")
        .and_then(Value::as_i64)
        .map(|ms| ms.to_string());
    match line_type {
        "turn.prompt" => {
            let text = content_text(value.get("input"));
            // Strip our image-injection marker block.
            let (display, images) = match text.find(crate::engine::images::KIMI_IMAGE_MARKER) {
                Some(idx) => (
                    text[..idx].trim_end().to_string(),
                    kimi_image_paths(&text[idx..]),
                ),
                None => (text, Vec::new()),
            };
            if display.trim().is_empty() && images.is_empty() {
                Vec::new()
            } else {
                vec![LineRow {
                    images,
                    ..LineRow::new("user", display, ts)
                }]
            }
        }
        "context.append_loop_event" => {
            let Some(event) = value.get("event") else {
                return Vec::new();
            };
            if event.get("type").and_then(Value::as_str) != Some("content.part") {
                return Vec::new();
            }
            let Some(part) = event.get("part") else {
                return Vec::new();
            };
            match part.get("type").and_then(Value::as_str) {
                Some("text") => {
                    let text = part
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    if text.trim().is_empty() {
                        Vec::new()
                    } else {
                        vec![LineRow::new("assistant", text, ts)]
                    }
                }
                Some("tool_call") => {
                    let name = part
                        .get("name")
                        .or_else(|| part.get("tool_name"))
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_string();
                    let args = part
                        .get("arguments")
                        .or_else(|| part.get("input"))
                        .or_else(|| part.get("args"));
                    vec![LineRow {
                        path: args.and_then(crate::engine::tool_path_arg),
                        args: args.and_then(crate::engine::parse_tool_args_value),
                        todos: args.and_then(crate::engine::parse_todo_args),
                        ..LineRow::new("tool", name, ts)
                    }]
                }
                _ => Vec::new(),
            }
        }
        _ => Vec::new(),
    }
}

fn extract_grok_line(value: &Value) -> LineRows {
    let line_type = type_str(value);
    let ts = ts_string(value, &["timestamp", "created_at", "createdAt"]);
    match line_type {
        "user" => {
            // Envelope stripping (`<user_info>` / `<user_query>`) lives in
            // `normalize_extracted_row` so it is shared across engines.
            if value.get("synthetic_reason").is_some() {
                return Vec::new();
            }
            let text = content_text(value.get("content"));
            if text.trim().is_empty() {
                Vec::new()
            } else {
                vec![LineRow::new("user", text, ts)]
            }
        }
        "reasoning" => {
            let text = match value.get("summary") {
                Some(Value::Array(parts)) => text_of_parts(parts, false, "\n"),
                Some(Value::String(s)) => s.clone(),
                _ => String::new(),
            };
            if text.trim().is_empty() {
                Vec::new()
            } else {
                vec![LineRow::new("thinking", text, ts)]
            }
        }
        "assistant" => {
            let mut out = Vec::new();
            let text = content_text(value.get("content"));
            if !text.trim().is_empty() {
                let usage = value.get("usage").cloned();
                out.push(LineRow {
                    usage,
                    ..LineRow::new("assistant", text, ts.clone())
                });
            }
            if let Some(calls) = value.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    let function = call.get("function");
                    let name = function
                        .and_then(|f| f.get("name"))
                        .or_else(|| call.get("name"))
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_string();
                    let args = function
                        .and_then(|f| f.get("arguments"))
                        .or_else(|| call.get("arguments"))
                        .or_else(|| call.get("input"));
                    out.push(LineRow {
                        path: args.and_then(crate::engine::tool_path_arg),
                        args: args.and_then(crate::engine::parse_tool_args_value),
                        todos: args.and_then(crate::engine::parse_todo_args),
                        ..LineRow::new("tool", name, ts.clone())
                    });
                }
            }
            out
        }
        _ => Vec::new(),
    }
}

// ==================== Qoder ====================

/// Qoder jsonl records are Claude-shaped (`type`, `message.content`, `uuid`,
/// `timestamp`) with three extras (reference engine/qoder_history.rs):
/// `isSidechain` marks subagent transcripts, `toolUseResult` envelopes carry
/// tool output, and the typed prompt is mirrored under `humanInput.text`.
fn qoder_is_sidechain(value: &Value) -> bool {
    match value.get("isSidechain") {
        Some(Value::Bool(true)) => true,
        Some(Value::String(s)) => s.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

/// A `toolUseResult` user record: forward its tool_result blocks, keeping the
/// call id so results pair with their call instead of arrival order.
fn qoder_tool_result_rows(value: &Value, ts: &Option<String>) -> LineRows {
    let mut out = Vec::new();
    let Some(blocks) = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return out;
    };
    for block in blocks {
        if block.get("type").and_then(Value::as_str) != Some("tool_result") {
            continue;
        }
        out.push(LineRow {
            tool_call_id: tool_result_call_id(block),
            result: block.get("content").cloned(),
            ..LineRow::new("__tool_result__", String::new(), ts.clone())
        });
    }
    out
}

fn extract_qoder_line(value: &Value, images: ImageMode) -> LineRows {
    if qoder_is_sidechain(value) {
        return Vec::new();
    }
    let line_type = type_str(value);
    if line_type != "user" && line_type != "assistant" {
        return Vec::new();
    }
    let ts = ts_string(value, &["timestamp"]);
    if line_type == "user" && value.get("toolUseResult").is_some() {
        return qoder_tool_result_rows(value, &ts);
    }
    // The claude walk already stamps tool rows with their tool_use block ids,
    // so qoder's id-keyed toolUseResult envelopes pair by id, not arrival order.
    let rows = extract_claude_line(value, images);
    if !rows.is_empty() || line_type != "user" {
        return rows;
    }
    // The typed prompt also lives under humanInput.text; use it when the
    // claude-shaped message.content carried nothing.
    match value
        .get("humanInput")
        .and_then(|input| input.get("text"))
        .and_then(Value::as_str)
        .map(str::trim)
    {
        Some(text) if !text.is_empty() && !is_claude_interrupt_text(text) => {
            vec![LineRow::new("user", text.to_string(), ts)]
        }
        _ => Vec::new(),
    }
}

// ==================== OpenCode ====================

/// OpenCode stores one session as a JSON tree under `<data>/storage/`:
/// `session/<projectId>/<sessionId>.json` (metadata: id, directory, title,
/// time), `message/<sessionId>/<messageId>.json` (role, time, model), and
/// `part/<messageId>/<partId>.json` (text / reasoning / tool / step-finish).
/// Shapes verified against ~/.local/share/opencode/storage (opencode 1.1.16)
/// and the reference delete path (commands_opencode_catalog.rs removes
/// `storage/<parent>/<id>[.json]`). The db row points at the session
/// metadata file; everything else hangs off it.
fn opencode_storage_root(session_meta: &Path) -> Option<PathBuf> {
    let project_dir = session_meta.parent()?;
    let session_dir = project_dir.parent()?;
    if session_dir.file_name()?.to_str()? != "session" {
        return None;
    }
    Some(session_dir.parent()?.to_path_buf())
}

// Tree-walk budgets: a real session is tens of messages; the caps keep a
// corrupt/huge tree from turning one sidebar refresh into a disk crawl.
const MAX_OPENCODE_MESSAGES: usize = 4096;
const MAX_OPENCODE_PARTS_PER_MESSAGE: usize = 512;
/// Scan-mode cap on one part file — tool outputs run to MB and the scanner
/// only keeps title/preview/count.
const SCAN_OPENCODE_PART_BYTES: u64 = 256 * 1024;

/// Read one small JSON file; `byte_cap` bounds the read (truncated JSON
/// fails to parse and is skipped).
fn read_json_file(path: &Path, byte_cap: Option<u64>) -> Option<Value> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = String::new();
    match byte_cap {
        Some(cap) => {
            file.take(cap).read_to_string(&mut buf).ok()?;
        }
        None => {
            file.read_to_string(&mut buf).ok()?;
        }
    }
    serde_json::from_str(&buf).ok()
}

/// Sorted `.json` entries of `dir`, capped.
fn opencode_list_json(dir: &Path, cap: usize) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                paths.push(path);
            }
        }
    }
    // msg_/prt_ ids are timestamp-prefixed, so name order is chronological.
    paths.sort();
    paths.truncate(cap);
    paths
}

/// Epoch-millis field as the string form `LineRow.ts` carries.
fn opencode_ts(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| value.get(k).and_then(Value::as_i64))
        .map(|ms| ms.to_string())
}

/// `step-finish` tokens → the claude-shaped usage object the context bar reads.
fn opencode_usage(part: &Value) -> Option<Value> {
    let tokens = part.get("tokens")?;
    let input = tokens.get("input").and_then(Value::as_i64).unwrap_or(0);
    let output = tokens.get("output").and_then(Value::as_i64).unwrap_or(0);
    let reasoning = tokens.get("reasoning").and_then(Value::as_i64).unwrap_or(0);
    let cache_read = tokens
        .get("cache")
        .and_then(|c| c.get("read"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let cache_write = tokens
        .get("cache")
        .and_then(|c| c.get("write"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    Some(serde_json::json!({
        "input_tokens": input,
        "output_tokens": output,
        "cache_read_input_tokens": cache_read,
        "cache_creation_input_tokens": cache_write,
        "total_tokens": input + output + reasoning,
    }))
}

/// Walk the storage tree behind one session-metadata file into extracted
/// rows. `part_byte_cap` bounds per-part reads (scan mode); None reads fully
/// (reader mode).
fn opencode_rows(session_meta: &Path, images: ImageMode, part_byte_cap: Option<u64>) -> LineRows {
    let mut out = Vec::new();
    let Some(storage) = opencode_storage_root(session_meta) else {
        return out;
    };
    let Some(session_id) = session_meta.file_stem().and_then(|s| s.to_str()) else {
        return out;
    };
    let message_dir = storage.join("message").join(session_id);
    // Sort by time.created (name order only works while ids stay
    // timestamp-prefixed); stable fallback is the filename.
    let mut messages: Vec<(i64, PathBuf, Value)> =
        opencode_list_json(&message_dir, MAX_OPENCODE_MESSAGES)
            .into_iter()
            .filter_map(|path| {
                let value = read_json_file(&path, None)?;
                let created = value
                    .get("time")
                    .and_then(|t| t.get("created"))
                    .and_then(Value::as_i64)
                    .unwrap_or(i64::MAX);
                Some((created, path, value))
            })
            .collect();
    messages.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    for (_, _, message) in messages {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        if role != "user" && role != "assistant" {
            continue;
        }
        let Some(message_id) = message.get("id").and_then(Value::as_str) else {
            continue;
        };
        let time = message.get("time");
        let created_ms = time.and_then(|t| t.get("created")).and_then(Value::as_i64);
        let created = created_ms.map(|ms| ms.to_string());
        let duration_ms = time
            .and_then(|t| t.get("completed"))
            .and_then(Value::as_i64)
            .zip(created_ms)
            .and_then(|(completed, created)| (completed >= created).then_some(completed - created));
        let model = message
            .get("model")
            .and_then(|m| m.get("modelID"))
            .and_then(Value::as_str)
            .map(str::to_string);
        // Parts carry the content. Text accumulates per message so several
        // text parts land as one row; reasoning/tool parts flush it first,
        // keeping calls where they happened.
        let mut text = String::new();
        let mut collected_images: Vec<String> = Vec::new();
        let mut message_rows: Vec<LineRow> = Vec::new();
        // step-finish usage lands after the message's own text row exists;
        // buffered here and attached below (a mid-loop __usage__ row would
        // fold onto the *previous* message's assistant row).
        let mut pending_usage: Option<Value> = None;
        let part_dir = storage.join("part").join(message_id);
        for part_path in opencode_list_json(&part_dir, MAX_OPENCODE_PARTS_PER_MESSAGE) {
            let Some(part) = read_json_file(&part_path, part_byte_cap) else {
                continue;
            };
            let part_ts = part
                .get("time")
                .and_then(|t| opencode_ts(t, &["start"]))
                .or_else(|| created.clone());
            match part.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(t) = part.get("text").and_then(Value::as_str) {
                        text.push_str(t);
                    }
                }
                Some("reasoning") => {
                    pi_flush_text(&mut message_rows, &mut text, &part_ts, role);
                    if let Some(t) = part.get("text").and_then(Value::as_str) {
                        if !t.trim().is_empty() {
                            message_rows.push(LineRow::new("thinking", t.to_string(), part_ts));
                        }
                    }
                }
                Some("tool") => {
                    pi_flush_text(&mut message_rows, &mut text, &part_ts, role);
                    let name = part
                        .get("tool")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_string();
                    let state = part.get("state");
                    let input = state.and_then(|s| s.get("input"));
                    let output = state
                        .and_then(|s| s.get("output"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    message_rows.push(LineRow {
                        path: input.and_then(crate::engine::tool_path_arg),
                        args: input.and_then(crate::engine::parse_tool_args_value),
                        todos: input.and_then(crate::engine::parse_todo_args),
                        tool_call_id: part
                            .get("callID")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        result: if output.trim().is_empty() {
                            None
                        } else {
                            Some(Value::String(output.to_string()))
                        },
                        ..LineRow::new("tool", name, part_ts)
                    });
                }
                Some("step-finish") => {
                    if let Some(usage) = opencode_usage(&part) {
                        pending_usage = Some(usage);
                    }
                }
                // [INFERENCE] shape from upstream opencode: image attachments
                // arrive as `{type:"file", mime, url}` with a data URL.
                Some("file") if images == ImageMode::Collect => {
                    let is_image = part
                        .get("mime")
                        .and_then(Value::as_str)
                        .is_some_and(|mime| mime.starts_with("image/"));
                    if is_image {
                        if let Some(url) = part.get("url").and_then(Value::as_str) {
                            collected_images.push(url.to_string());
                        }
                    }
                }
                _ => {}
            }
        }
        if !text.trim().is_empty() || !collected_images.is_empty() {
            message_rows.push(LineRow {
                model,
                duration_ms,
                images: collected_images,
                ..LineRow::new(role, text, created)
            });
        }
        if let Some(usage) = pending_usage {
            // Attach to this message's own last content row (the flushed text
            // when present); fall back to the shared __usage__ fold.
            match message_rows
                .iter_mut()
                .rev()
                .find(|row| row.role == role || row.role == "thinking")
            {
                Some(row) => row.usage = Some(usage),
                None => message_rows.push(LineRow {
                    usage: Some(usage),
                    ..LineRow::new("__usage__", String::new(), None)
                }),
            }
        }
        for row in message_rows {
            let Some(row) = normalize_extracted_row(row) else {
                continue;
            };
            out.push(row);
        }
    }
    out
}

fn parse_opencode_session(path: &Path) -> ParsedSession {
    fold_rows(opencode_rows(path, ImageMode::Collect, None))
}

fn scan_opencode_summary(path: &Path) -> ScanSummary {
    let mut acc = ScanAcc::default();
    for row in opencode_rows(
        path,
        ImageMode::SkipDataUrls,
        Some(SCAN_OPENCODE_PART_BYTES),
    ) {
        acc.accept(row);
    }
    acc.finish()
}

#[cfg(test)]
#[path = "extract_guardian_tests.rs"]
mod guardian_tests;

#[cfg(test)]
mod tests {
    mod codex_model_tests { include!("extract_codex_model_tests.rs"); }

    #[test]
    fn generated_images_history_recovers_structured_outputs_and_deduplicates_native_copies() {
        let image = "data:image/png;base64,AA==";
        let event = serde_json::json!({"type":"event_msg","payload":{"type":"item_completed",
            "item":{"id":"call-1","type":"McpToolCall","tool":"imagegen","status":"completed",
                "result":{"content":[{"type":"text","text":"retain before"},{"type":"image","mimeType":"image/png","data":"AA=="},{"type":"text","text":"retain after"}]}}}});
        let raw = serde_json::json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"call-1",
            "output":[{"type":"input_text","text":"retain before"},{"type":"input_image","image_url":image},{"type":"input_text","text":"retain after"}]}});
        let independent = serde_json::json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call-2",
            "output":[{"type":"input_image","image_url":image}]}});
        let text = format!("{event}\n{raw}\n{raw}\n{independent}\n");
        for input in [&text, &format!("{raw}\n{event}\n{independent}\n")] {
            let parsed = collect_session(std::io::Cursor::new(input.as_bytes()), &extractor_for("codex", ImageMode::Collect, None)).unwrap();
            assert_eq!(parsed.messages.len(), 4);
            assert_eq!(parsed.messages.iter().map(|m| m.role.as_str()).collect::<Vec<_>>(), ["tool","assistant","tool","assistant"]);
            assert_eq!(parsed.messages[1].images, [image]);
            assert_eq!(parsed.messages[3].images, [image]);
            let result = parsed.messages[0].result.as_ref().unwrap().to_string();
            assert!(result.contains("retain before") && result.contains("retain after"));
            assert!(!result.contains("base64") && !result.contains("AA=="));
            let mut acc = ScanAcc::default();
            walk_lines(std::io::Cursor::new(input.as_bytes()), &extractor_for("codex", ImageMode::SkipDataUrls, None), |row| {
                assert!(row.images.iter().all(String::is_empty));
                acc.accept(row);
            }).unwrap();
            assert_eq!(acc.finish().message_count, parsed.messages.len() as i64);
        }
    }

    #[test]
    fn generated_images_history_native_result_and_failure_do_not_create_false_success() {
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let native = serde_json::json!({"type":"response_item","payload":{"type":"image_generation_call","id":"native","status":"completed","result":png}});
        let failed = serde_json::json!({"type":"event_msg","payload":{"type":"item_completed","item":{"type":"ImageGeneration","id":"bad","status":"failed","result":png,"failure":{"type":"usageLimitExceeded"}}}});
        let failed_copy = serde_json::json!({"type":"response_item","payload":{"type":"image_generation_call","id":"bad","status":"completed","result":png}});
        for text in [format!("{native}\n{native}\n{failed}\n{failed_copy}\n"), format!("{native}\n{failed_copy}\n{failed}\n")] {
            let parsed = collect_session(std::io::Cursor::new(text.as_bytes()), &extractor_for("codex", ImageMode::Collect, None)).unwrap();
            assert_eq!(parsed.messages.len(), 3);
            assert_eq!(parsed.messages[1].images, [format!("data:image/png;base64,{png}")]);
            assert_eq!(parsed.messages[2].result.as_ref().unwrap()["status"], "failed");
            assert!(parsed.messages[2].images.is_empty());
            assert!(!parsed.messages[0].result.as_ref().unwrap().to_string().contains(png));
            let mut acc = ScanAcc::default();
            walk_lines(std::io::Cursor::new(text.as_bytes()), &extractor_for("codex", ImageMode::SkipDataUrls, None), |row| acc.accept(row)).unwrap();
            assert_eq!(acc.finish().message_count, 3);
        }
    }

    #[test]
    fn generated_images_history_merges_additional_output_and_preserves_rejection_diagnostics() {
        let line = |output: Value| serde_json::json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"call","output":output}});
        let first = line(serde_json::json!([{"type":"input_text","text":"first text"},{"type":"input_image","image_url":"data:image/png;base64,AA=="}]));
        let second = line(serde_json::json!([{"type":"input_text","text":"first text"},{"type":"input_text","text":"additional text"},
            {"type":"input_image","image_url":"data:image/png;base64,AA=="},{"type":"input_image","image_url":"data:image/png;base64,AQ=="}]));
        let invalid = serde_json::json!({"type":"response_item","payload":{"type":"custom_tool_call_output","call_id":"invalid",
            "output":[{"type":"input_image","image_url":"javascript:bad"},{"type":"input_text","text":"retained despite invalid image"}]}});
        let text = format!("{first}\n{second}\n{second}\n{invalid}\n");
        let parsed = collect_session(std::io::Cursor::new(text.as_bytes()), &extractor_for("codex", ImageMode::Collect, None)).unwrap();
        assert_eq!(parsed.messages.len(), 3);
        assert_eq!(parsed.messages[1].images.len(), 2);
        let result = parsed.messages[0].result.as_ref().unwrap().to_string();
        assert_eq!(result.matches("first text").count(), 1);
        assert_eq!(result.matches("additional text").count(), 1);
        let rejected = parsed.messages[2].result.as_ref().unwrap().to_string();
        assert!(rejected.contains("invalid or unsupported") && rejected.contains("retained despite invalid image"));
        let mut acc = ScanAcc::default();
        walk_lines(std::io::Cursor::new(text.as_bytes()), &extractor_for("codex", ImageMode::SkipDataUrls, None), |row| acc.accept(row)).unwrap();
        assert_eq!(acc.finish().message_count, 3);
    }

    #[test]
    fn generated_images_history_empty_failed_mcp_result_wins_in_either_order() {
        let raw = serde_json::json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"call",
            "output":[{"type":"input_text","text":"preserve tool text"},{"type":"input_image","image_url":"data:image/png;base64,AA=="}]}});
        let failure = |id: &str| serde_json::json!({"type":"event_msg","payload":{"type":"item_completed",
            "item":{"type":"McpToolCall","id":id,"tool":"imagegen","status":"failed","result":null,"error":{"message":"generation failed"}}}});
        let failed = failure("call");
        let unrelated = failure("unrelated");
        for text in [format!("{raw}\n{failed}\n{unrelated}\n"), format!("{failed}\n{raw}\n{unrelated}\n")] {
            let parsed = collect_session(std::io::Cursor::new(text.as_bytes()), &extractor_for("codex", ImageMode::Collect, None)).unwrap();
            assert_eq!(parsed.messages.len(), 1);
            assert_eq!(parsed.messages[0].text, "imagegen");
            let result = parsed.messages[0].result.as_ref().unwrap();
            assert_eq!(result["status"], "failed");
            assert!(result.to_string().contains("preserve tool text"));
            assert!(parsed.messages[0].images.is_empty());
            let mut acc = ScanAcc::default();
            walk_lines(std::io::Cursor::new(text.as_bytes()), &extractor_for("codex", ImageMode::SkipDataUrls, None), |row| acc.accept(row)).unwrap();
            assert_eq!(acc.finish().message_count, 1);
        }
    }

    #[test]
    fn generated_images_history_prefers_inline_native_copy_when_original_is_missing() {
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let path = std::env::temp_dir().join(format!("missing-generated-{}.png", uuid::Uuid::new_v4()));
        assert!(!path.exists());
        let event = serde_json::json!({"type":"event_msg","payload":{"type":"item_completed","item":{
            "type":"ImageGeneration","id":"native","status":"completed","savedPath":path}}});
        let raw = serde_json::json!({"type":"response_item","payload":{"type":"image_generation_call","id":"native","status":"completed","result":png}});
        let mut both = event.clone();
        both["payload"]["item"]["result"] = Value::from(png);
        for text in [format!("{event}\n{raw}\n"), format!("{raw}\n{event}\n"), format!("{both}\n")] {
            let parsed = collect_session(std::io::Cursor::new(text.as_bytes()), &extractor_for("codex", ImageMode::Collect, None)).unwrap();
            assert_eq!(parsed.messages.len(), 2);
            assert_eq!(parsed.messages[1].images, [format!("data:image/png;base64,{png}")]);
            let mut acc = ScanAcc::default();
            walk_lines(std::io::Cursor::new(text.as_bytes()), &extractor_for("codex", ImageMode::SkipDataUrls, None), |row| acc.accept(row)).unwrap();
            assert_eq!(acc.finish().message_count, 2);
        }
    }

    #[test]
    fn generated_images_scan_keeps_readable_preview_after_images_replays_and_failure() {
        let message = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"assistant",
            "content":[{"type":"output_text","text":"Readable preview 中文🙂"}]}});
        let image = serde_json::json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"call",
            "output":[{"type":"input_image","image_url":"data:image/png;base64,AA=="}]}});
        let failure = serde_json::json!({"type":"event_msg","payload":{"type":"item_completed","item":{
            "type":"McpToolCall","id":"call","tool":"imagegen","status":"failed","result":null}}});
        for (text, count) in [(format!("{message}\n{image}\n{image}\n"), 3),
            (format!("{message}\n{image}\n{failure}\n{image}\n"), 2)] {
            let mut acc = ScanAcc::default();
            walk_lines(std::io::Cursor::new(text.as_bytes()), &extractor_for("codex", ImageMode::SkipDataUrls, None), |row| acc.accept(row)).unwrap();
            let summary = acc.finish();
            assert_eq!(summary.preview, "Readable preview 中文🙂");
            assert_eq!(summary.message_count, count);
        }
    }

    #[test]
    fn compressed_rollout_parse_preserves_messages_and_reports_corruption() {
        let dir = std::env::temp_dir().join(format!("ccgui-compressed-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let thread = "12345678-1234-1234-1234-123456789abc";
        let plain = dir.join(format!("rollout-2026-10-18-{thread}.jsonl"));
        let compressed = plain.with_extension("jsonl.zst");
        let text = "原消息🙂\n第二行";
        let image = "data:image/png;base64,AA==";
        let row = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":text},{"type":"input_image","image_url":image}]}});
        let content = format!("bad JSON\n{row}\n");
        std::fs::write(&compressed, zstd::encode_all(content.as_bytes(), 1).unwrap()).unwrap();
        for path in [&plain, &compressed] {
            let parsed = parse_session_file("codex", path).unwrap();
            assert_eq!(parsed.messages.len(), 1);
            assert_eq!(parsed.messages[0].text, text);
            assert_eq!(parsed.messages[0].images, vec![image.to_string()]);
            assert_eq!(scan_summary_file("codex", path).unwrap().message_count, 1);
            assert_eq!(codex_rollout_thread(path).as_deref(), Some(thread));
        }
        std::fs::write(&compressed, b"not a zstd frame").unwrap();
        assert!(parse_session_file("codex", &plain).is_err());
        assert!(scan_summary_file("codex", &compressed).is_err());
        let mut truncated = zstd::encode_all(content.as_bytes(), 1).unwrap();
        truncated.pop();
        std::fs::write(&compressed, truncated).unwrap();
        assert!(parse_session_file("codex", &plain).is_err());
        assert!(scan_summary_file("codex", &compressed).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn plain_and_compressed_rollouts_still_skip_malformed_utf8_lines() {
        let dir = std::env::temp_dir().join(format!("ccgui-rollout-utf8-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let raw = dir.join("rollout.jsonl");
        let compressed = raw.with_extension("jsonl.zst");
        let row = serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"保留完整消息🙂"}]}});
        let mut content = format!("{row}\n").into_bytes();
        content.extend_from_slice(b"\xff\n{bad JSON}\n");
        content.extend_from_slice(format!("{row}\n").as_bytes());
        // The last character has only its first UTF-8 byte on disk so far.
        content.extend_from_slice(b"\xe4");
        std::fs::write(&raw, &content).unwrap();
        let parsed = parse_session_file("codex", &raw).unwrap();
        assert_eq!(parsed.messages.len(), 2);
        std::fs::write(&compressed, zstd::encode_all(content.as_slice(), 1).unwrap()).unwrap();
        std::fs::remove_file(&raw).unwrap();
        let parsed = parse_session_file("codex", &raw).unwrap();
        assert_eq!(parsed.messages.len(), 2);
        assert_eq!(parsed.messages[1].text, "保留完整消息🙂");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn cursor_auxiliary_classification_is_first_user_only_and_preserves_text() {
        let task = "查找历史扫描入口 🧭\n说明中文与 emoji 🚀";
        for kind in ["cursor_cce", "cursor_do"] {
            let prompt = super::super::cursor_auxiliary::fixture(kind, task);
            let input = serde_json::json!({"role":"user","message":{"content":prompt}}).to_string();
            let parsed = collect_session(std::io::Cursor::new(&input), &extractor_for("cursor", ImageMode::Collect, None)).unwrap();
            assert_eq!(parsed.messages[0].text, prompt);
            let mut acc = ScanAcc { cursor: true, ..ScanAcc::default() };
            walk_lines(std::io::Cursor::new(&input), &extractor_for("cursor", ImageMode::SkipDataUrls, None), |row| acc.accept(row)).unwrap();
            let summary = acc.finish();
            assert_eq!(summary.auxiliary_kind.as_deref(), Some(kind));
            assert_eq!(summary.title, super::super::truncate_chars(&super::super::strip_title_noise(task), 80));

            let mut acc = ScanAcc { cursor: true, ..ScanAcc::default() };
            acc.accept(LineRow::new("user", "普通首轮".into(), None));
            acc.accept(LineRow::new("user", prompt.clone(), None));
            let summary = acc.finish();
            assert_eq!(summary.auxiliary_kind, None);
            assert_eq!(summary.title, "普通首轮");
            let mut other_engine = ScanAcc::default();
            other_engine.accept(LineRow::new("user", prompt, None));
            assert_eq!(other_engine.finish().auxiliary_kind, None);
        }
    }
    use super::*;

    #[test]
    fn pi_family_line_extracts_thinking_in_order() {
        let line: Value = serde_json::json!({
            "type": "message",
            "timestamp": "2026-09-05T11:12:16.469Z",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "first thought", "thinkingSignature": "sig"},
                    {"type": "text", "text": "answer one"},
                    {"type": "toolCall", "name": "read", "intent": "Listing root", "arguments": {"path": "src/main.rs"}},
                    {"type": "text", "text": "answer two"}
                ]
            }
        });
        let rows = extract_pi_family_line(&line, ImageMode::Collect);
        let roles: Vec<&str> = rows.iter().map(|r| r.role.as_str()).collect();
        assert_eq!(roles, ["thinking", "assistant", "tool", "assistant"]);
        assert_eq!(rows[0].text, "first thought");
        assert_eq!(rows[1].text, "answer one");
        assert_eq!(rows[2].text, "read · Listing root");
        assert_eq!(rows[2].path.as_deref(), Some("src/main.rs"));
        assert_eq!(
            rows[2].args,
            Some(serde_json::json!({"path": "src/main.rs"}))
        );
        assert_eq!(rows[3].text, "answer two");
        assert_eq!(rows[3].path, None);
    }

    /// Results pair with their call by id, not by arrival order: parallel tool
    /// calls finish in whatever order they finish, and the fallback (attach to
    /// the latest row still without a result) mislabels them when they do.
    /// The `details` payload is what the subagent panel reads for job status.
    #[test]
    fn pi_tool_results_pair_with_their_call_ids() {
        let call = |id: &str| {
            serde_json::json!({
                "type": "message",
                "message": {"role": "assistant", "content": [{
                    "type": "toolCall",
                    "id": id,
                    "name": "hub",
                    "intent": "Waiting for workers",
                    "arguments": {"op": "wait"}
                }]}
            })
        };
        let result = |id: &str, text: &str, status: &str| {
            serde_json::json!({
                "type": "message",
                "message": {
                    "role": "toolResult",
                    "toolCallId": id,
                    "content": [{"type": "text", "text": text}],
                    "details": {"jobs": [{"id": id, "status": status}]}
                }
            })
        };
        let lines = vec![
            call("call_a"),
            call("call_b"),
            // Out of order: `a` answers first even though `b` was called later.
            result("call_a", "## Still Running (1)", "running"),
            // Replayed or unmatched results must not consume another call.
            result("call_a", "duplicate", "failed"),
            result("unknown_call", "unmatched", "failed"),
            result("call_b", "done", "completed"),
        ];
        let input = lines
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        let extractor: LineExtractor<'_> =
            Box::new(|value: &Value| extract_pi_family_line(value, ImageMode::Collect));
        let parsed = collect_session(std::io::Cursor::new(input), &extractor).unwrap();

        let (first, second) = (&parsed.messages[0], &parsed.messages[1]);
        assert_eq!(
            first.result.as_ref().unwrap()["details"]["jobs"][0]["status"],
            "running"
        );
        assert_eq!(
            second.result.as_ref().unwrap()["details"]["jobs"][0]["status"],
            "completed"
        );
    }

    #[test]
    fn pi_tool_results_populate_todos_from_details_phases() {
        let call = serde_json::json!({
            "type": "message",
            "message": {"role": "assistant", "content": [{
                "type": "toolCall",
                "id": "todo_call_1",
                "name": "todo",
                "intent": "Initialize todos",
                "arguments": {"op": "init", "list": [{"phase": "P1", "items": ["Task 1"]}]}
            }]}
        });
        let result = serde_json::json!({
            "type": "message",
            "message": {
                "role": "toolResult",
                "toolCallId": "todo_call_1",
                "content": [{"type": "text", "text": "Done"}],
                "details": {
                    "phases": [
                        {
                            "name": "P1",
                            "tasks": [{"content": "Task 1", "status": "completed"}]
                        }
                    ]
                }
            }
        });
        let input = format!("{}\n{}", call, result);
        let extractor: LineExtractor<'_> =
            Box::new(|value: &Value| extract_pi_family_line(value, ImageMode::Collect));
        let parsed = collect_session(std::io::Cursor::new(input), &extractor).unwrap();
        assert_eq!(parsed.messages.len(), 1);
        let todos = parsed.messages[0].todos.as_ref().expect("todos must be populated");
        assert_eq!(todos.items.len(), 1);
        assert_eq!(todos.items[0].content, "Task 1");
        assert_eq!(todos.items[0].status, "complete");
    }

    #[test]
    fn claude_line_extracts_thinking_and_tool_in_order() {
        let line: Value = serde_json::json!({
            "type": "assistant",
            "timestamp": "2026-09-05T11:12:16.469Z",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "ponder", "signature": "sig"},
                    {"type": "text", "text": "reply"},
                    {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}}
                ]
            }
        });
        let rows = extract_claude_line(&line, ImageMode::Collect);
        let roles: Vec<&str> = rows.iter().map(|r| r.role.as_str()).collect();
        assert_eq!(roles, ["thinking", "assistant", "tool"]);
        assert_eq!(rows[0].text, "ponder");
        assert_eq!(rows[1].text, "reply");
        assert_eq!(rows[2].text, "Bash");
        assert_eq!(rows[2].args, Some(serde_json::json!({"command": "ls"})));
    }

    #[test]
    fn pi_toolcall_row_carries_todo_patch() {
        let line: Value = serde_json::json!({
            "type": "message",
            "timestamp": "2026-09-05T11:12:16.469Z",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "toolCall", "name": "todo", "arguments": {"op": "done", "task": "scan files"}}
                ]
            }
        });
        let rows = extract_pi_family_line(&line, ImageMode::Collect);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].role, "tool");
        let todos = rows[0].todos.as_ref().expect("todos payload");
        assert!(!todos.replace);
        assert_eq!(todos.items.len(), 1);
        assert_eq!(todos.items[0].content, "scan files");
        assert_eq!(todos.items[0].status, "complete");
    }

    #[test]
    fn claude_tool_use_row_carries_todowrite_snapshot() {
        let line: Value = serde_json::json!({
            "type": "assistant",
            "timestamp": "2026-09-05T11:12:16.469Z",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "tool_use", "name": "TodoWrite", "input": {"todos": [
                        {"content": "scan files", "status": "completed"},
                        {"content": "write code", "status": "in_progress"},
                        {"content": "run tests", "status": "pending"},
                        {"content": "deploy", "status": "blocked"}
                    ]}}
                ]
            }
        });
        let rows = extract_claude_line(&line, ImageMode::Collect);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].role, "tool");
        let todos = rows[0].todos.as_ref().expect("todos payload");
        assert!(todos.replace);
        let statuses: Vec<&str> = todos.items.iter().map(|i| i.status.as_str()).collect();
        assert_eq!(statuses, ["complete", "active", "pending", "blocked"]);
        assert_eq!(todos.items[1].content, "write code");
    }

    #[test]
    fn claude_line_drops_is_meta_command_expansion() {
        let expansion: Value = serde_json::json!({
            "type": "user",
            "isMeta": true,
            "timestamp": "2026-09-08T10:00:00.000Z",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "# 代码审查\n对未提交更改进行全面的安全和质量审查"}]
            }
        });
        assert!(extract_claude_line(&expansion, ImageMode::Collect).is_empty());
    }

    #[test]
    fn codex_reasoning_item_becomes_thinking_row() {
        let line: Value = serde_json::json!({
            "type": "response_item",
            "timestamp": "2026-09-05T11:12:16.469Z",
            "payload": {
                "type": "reasoning",
                "summary": [
                    {"type": "summary_text", "text": "plan step one"},
                    {"type": "summary_text", "text": "plan step two"}
                ]
            }
        });
        let rows = extract_codex_line(&line, ImageMode::Collect);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].role, "thinking");
        assert_eq!(rows[0].text, "plan step one\nplan step two");

        // Encrypted reasoning carries no visible summary -> no row.
        let encrypted: Value = serde_json::json!({
            "type": "response_item",
            "timestamp": "2026-09-05T11:12:16.469Z",
            "payload": {"type": "reasoning", "summary": [], "content": [{"type": "reasoning_text", "text": "hidden"}]}
        });
        assert!(extract_codex_line(&encrypted, ImageMode::Collect).is_empty());
    }
    #[test]
    fn prompts_handed_to_codex_desktop_read_back_as_user_rows() {
        const THREAD: &str = "01a100bc-fdfa-7dd1-b02a-cf2a51383059";
        let delegation = |source: &str, input: &str| {
            serde_json::json!({
                "type": "response_item",
                "timestamp": "2026-10-03T08:01:02.000Z",
                "payload": {
                    "type": "function_call_output",
                    "name": "send_message_to_thread",
                    "namespace": "codex_app",
                    "output": format!("<codex_delegation>\n  <source_thread_id>{source}</source_thread_id>\n  <input>{input}</input>\n</codex_delegation>"),
                }
            })
        };
        let dir = std::env::temp_dir().join(format!("ccgui-extract-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let rollout = dir.join(format!("rollout-2026-10-03T15-49-08-{THREAD}.jsonl"));
        let answer = serde_json::json!({"type": "response_item", "timestamp": "2026-10-03T08:01:09.000Z",
            "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "done"}]}});
        let lines = [
            delegation(THREAD, "好的 &lt;b&gt; &amp;amp; 🧭\n"),
            // Another tool's delivery to the thread itself, another thread's
            // delivery and a malformed wrapper all stay hidden.
            delegation(THREAD, "The user sent a request from Spellcast Canvas. Source: &quot;x&quot;."),
            delegation("01a100af-7c19-7ed0-89db-7751484da4db", "好的 &lt;b&gt; &amp;amp; 🧭"),
            serde_json::json!({"type": "response_item", "payload": {"type": "function_call_output",
                "name": "send_message_to_thread", "namespace": "codex_app", "output": "<input>loose</input>"}}),
            answer,
        ];
        std::fs::write(&rollout, lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
        let handed = std::collections::HashSet::from([crate::history::desktop_prompt_digest("好的 <b> &amp; 🧭")]);
        let rows = |parsed: ParsedSession| {
            parsed.messages.iter().map(|m| (m.role.clone(), m.text.clone())).collect::<Vec<_>>()
        };
        assert_eq!(
            rows(parse_session_file_with_handoffs("codex", &rollout, handed.clone()).unwrap()),
            [("user".to_string(), "好的 <b> &amp; 🧭".to_string()), ("assistant".into(), "done".into())]
        );
        // Titles, previews and search read the transcript as Codex wrote it.
        assert!(rows(parse_session_file("codex", &rollout).unwrap()).iter().all(|(role, _)| role != "user"));
        assert_eq!(scan_summary_file("codex", &rollout).unwrap().message_count, 1);
        // Without the rollout's own thread id nothing claims to be the user.
        let renamed = dir.join("copied.jsonl");
        std::fs::copy(&rollout, &renamed).unwrap();
        let parsed = parse_session_file_with_handoffs("codex", &renamed, handed).unwrap();
        assert!(rows(parsed).iter().all(|(role, _)| role != "user"));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn kimi_prompt_row_recovers_image_paths() {
        let prompt = crate::engine::images::kimi_prompt_with_images(
            "what is this",
            &["/tmp/a.png".to_string(), "b.jpg".to_string()],
            Path::new("/tmp"),
        );
        let line: Value = serde_json::json!({
            "type": "turn.prompt",
            "time": 1757493136000i64,
            "input": prompt,
        });
        let rows = extract_kimi_line(&line);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].role, "user");
        assert_eq!(rows[0].text, "what is this");
        // `PathBuf::join` normalizes "/"-rooted refs per platform ("/tmp/a.png"
        // stays verbatim, "b.jpg" joins with the platform separator), so
        // compare Path equality instead of string equality.
        let got: Vec<std::path::PathBuf> = rows[0]
            .images
            .iter()
            .map(std::path::PathBuf::from)
            .collect();
        assert_eq!(
            got,
            vec![
                std::path::PathBuf::from("/tmp/a.png"),
                std::path::Path::new("/tmp").join("b.jpg"),
            ]
        );
    }

    #[test]
    fn claude_user_image_block_becomes_data_url() {
        let line: Value = serde_json::json!({
            "type": "user",
            "timestamp": "2026-09-05T11:12:16.469Z",
            "message": {
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "aGk="}},
                    {"type": "text", "text": "这是什么?"}
                ]
            }
        });
        let rows = extract_claude_line(&line, ImageMode::Collect);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].text, "这是什么?");
        assert_eq!(rows[0].images, ["data:image/png;base64,aGk="]);

        // Image-only message still yields a row.
        let image_only: Value = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "eGk="}}
                ]
            }
        });
        let rows = extract_claude_line(&image_only, ImageMode::Collect);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].images, ["data:image/jpeg;base64,eGk="]);
    }

    #[test]
    fn pi_user_image_part_becomes_data_url() {
        let line: Value = serde_json::json!({
            "type": "message",
            "timestamp": "2026-09-05T11:12:16.469Z",
            "message": {
                "role": "user",
                "content": [
                    {"type": "image", "data": "aGk=", "mimeType": "image/webp"},
                    {"type": "text", "text": "look"}
                ]
            }
        });
        let rows = extract_pi_family_line(&line, ImageMode::Collect);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].text, "look");
        assert_eq!(rows[0].images, ["data:image/webp;base64,aGk="]);
    }

    #[test]
    fn codex_input_image_part_is_collected() {
        let line: Value = serde_json::json!({
            "type": "response_item",
            "timestamp": "2026-09-05T11:12:16.469Z",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_image", "image_url": "data:image/png;base64,aGk="},
                    {"type": "input_text", "text": "see this"}
                ]
            }
        });
        let rows = extract_codex_line(&line, ImageMode::Collect);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].text, "see this");
        assert_eq!(rows[0].images, ["data:image/png;base64,aGk="]);
    }

    #[test]
    fn codex_token_count_uses_last_turn_not_session_total() {
        let line: Value = serde_json::json!({
            "type": "event_msg",
            "timestamp": "2026-09-10T04:54:08.090Z",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": {
                        "input_tokens": 2741100,
                        "output_tokens": 11900,
                        "total_tokens": 2753000
                    },
                    "last_token_usage": {
                        "input_tokens": 34660,
                        "cached_input_tokens": 27520,
                        "output_tokens": 85,
                        "total_tokens": 34745
                    },
                    "model_context_window": 475000
                }
            }
        });
        let rows = extract_codex_line(&line, ImageMode::Collect);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].role, "__usage__");
        assert_eq!(rows[0].usage.as_ref().unwrap()["usage_scope"], "last_request");
        assert_eq!(rows[0].usage.as_ref().unwrap()["input_tokens"], 34660);
        assert_eq!(rows[0].usage.as_ref().unwrap()["total_tokens"], 34745);
        assert_eq!(
            rows[0].usage.as_ref().unwrap()["model_context_window"],
            475000
        );
    }

    fn codex_unknown_token_infos() -> Vec<Value> {
        let total = serde_json::json!({
            "input_tokens": 9_000_000, "output_tokens": 100_000, "total_tokens": 9_100_000
        });
        let mut infos = vec![
            serde_json::json!({"total_token_usage": total}),
            serde_json::json!({"total_token_usage": total, "model_context_window": 200_000}),
            serde_json::json!({"model_context_window": 200_000}),
            serde_json::json!({}),
        ];
        for last in [Value::Null, serde_json::json!("invalid"), serde_json::json!(42),
            serde_json::json!(false), serde_json::json!([])] {
            infos.push(serde_json::json!({
                "last_token_usage": last, "total_token_usage": total, "model_context_window": 200_000
            }));
        }
        infos
    }

    #[test]
    fn codex_token_count_without_last_keeps_unknown_snapshot() {
        for info in codex_unknown_token_infos() {
            let line = serde_json::json!({
                "type": "event_msg", "payload": {"type": "token_count", "info": info}
            });
            let rows = extract_codex_line(&line, ImageMode::Collect);
            assert_eq!(rows.len(), 1, "unknown occupancy must still produce a newer snapshot: {info}");
            assert_eq!(rows[0].role, "__usage__");
            let usage = rows[0].usage.as_ref().unwrap();
            assert_eq!(usage, &info, "preserve nested cumulative metadata without flattening it");
            assert!(usage.get("input_tokens").is_none());
            assert!(usage.get("total_tokens").is_none());
        }
    }

    #[test]
    fn codex_token_count_missing_or_nonobject_info_is_not_usage() {
        assert!(usage_from_codex_token_info(None).is_none());
        for info in [Value::Null, serde_json::json!(false), serde_json::json!(42),
            serde_json::json!("invalid"), serde_json::json!([])] {
            assert!(usage_from_codex_token_info(Some(&info)).is_none());
        }
        let line = serde_json::json!({"type": "event_msg", "payload": {"type": "token_count"}});
        assert!(extract_codex_line(&line, ImageMode::Collect).is_empty());
    }

    #[test]
    fn codex_history_latest_unknown_snapshot_replaces_earlier_high_occupancy() {
        let transcript = std::env::temp_dir().join(format!("ccgui-codex-usage-{}.jsonl", uuid::Uuid::new_v4()));
        for info in codex_unknown_token_infos() {
            for new_reply in [false, true] {
                let assistant = |text| serde_json::json!({
                    "type": "response_item", "payload": {"type": "message", "role": "assistant",
                        "content": [{"type": "output_text", "text": text}]}
                });
                let mut lines = vec![assistant("earlier reply"), serde_json::json!({
                    "type": "event_msg", "payload": {"type": "token_count", "info": {
                        "last_token_usage": {"input_tokens": 150_000, "total_tokens": 151_000},
                        "model_context_window": 200_000
                    }}
                })];
                if new_reply {
                    lines.push(assistant("latest reply"));
                }
                lines.push(serde_json::json!({
                    "type": "event_msg", "payload": {"type": "token_count", "info": info}
                }));
                std::fs::write(&transcript, lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
                // This is the reader's real local-file parse entry; the UI selects
                // the newest raw usage, even when its occupancy is unknown.
                let parsed = parse_session_file_with_handoffs("codex", &transcript, Default::default()).unwrap();
                assert_eq!(parsed.messages.len(), if new_reply { 2 } else { 1 });
                let latest = parsed.messages.iter().rev().find_map(|message| message.usage.as_ref())
                    .expect("the latest unknown usage must not be discarded");
                let mut expected = info.clone();
                if expected.get("model_context_window").is_none() {
                    expected["model_context_window"] = serde_json::json!(200_000);
                }
                assert_eq!(latest, &expected, "earlier 75% occupancy must not be selected: {info}");
                assert!(latest.get("input_tokens").is_none());
                assert!(latest.get("total_tokens").is_none());
                if new_reply {
                    assert_eq!(parsed.messages[0].usage.as_ref().unwrap()["input_tokens"], 150_000,
                        "preserve the earlier message's accurate historical usage");
                }
            }
        }
        std::fs::remove_file(&transcript).unwrap();
    }

    #[test]
    fn grok_skips_synthetic_reason_and_leaves_envelope_to_normalize() {
        let reminder: Value = serde_json::json!({
            "type": "user",
            "synthetic_reason": "system_reminder",
            "content": [{"type": "text", "text": "<system-reminder>skills</system-reminder>"}]
        });
        assert!(extract_grok_line(&reminder).is_empty());

        let context: Value = serde_json::json!({
            "type": "user",
            "content": [{"type": "text", "text": "<user_info>\nOS Version: macos\n</user_info>"}]
        });
        let context_rows = extract_grok_line(&context);
        assert_eq!(context_rows.len(), 1);
        assert!(normalize_extracted_row(context_rows.into_iter().next().unwrap()).is_none());

        let query: Value = serde_json::json!({
            "type": "user",
            "prompt_index": 0,
            "content": [{
                "type": "text",
                "text": "<image_files>\n1. /tmp/a.png\n</image_files>\n\n<user_query>Grok CLI 的历史记录怎么没出现？</user_query>"
            }]
        });
        let rows = extract_grok_line(&query);
        assert_eq!(rows.len(), 1);
        let normalized = normalize_extracted_row(rows.into_iter().next().unwrap()).unwrap();
        assert_eq!(normalized.role, "user");
        assert_eq!(normalized.text, "Grok CLI 的历史记录怎么没出现？");

        let mentioned = LineRow::new(
            "user",
            "please look at <user_info> in grok logs, not the typed <user_query>".into(),
            None,
        );
        let kept = normalize_extracted_row(mentioned).unwrap();
        assert_eq!(
            kept.text,
            "please look at <user_info> in grok logs, not the typed <user_query>"
        );
    }

    #[test]
    fn grok_reasoning_summary_becomes_thinking() {
        let line: Value = serde_json::json!({
            "type": "reasoning",
            "summary": [
                {"type": "summary_text", "text": "first thought"},
                {"type": "summary_text", "text": "second thought"}
            ]
        });
        let rows = extract_grok_line(&line);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].role, "thinking");
        assert_eq!(rows[0].text, "first thought\nsecond thought");
    }

    #[test]
    fn codex_token_count_prefers_last_usage_and_attaches_context_window() {
        let line: Value = serde_json::json!({
            "type": "event_msg",
            "timestamp": "2026-09-05T11:12:16.469Z",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": {
                        "input_tokens": 200000,
                        "output_tokens": 5000,
                        "total_tokens": 205000
                    },
                    "last_token_usage": {
                        "input_tokens": 30000,
                        "cached_input_tokens": 15000,
                        "output_tokens": 500,
                        "total_tokens": 30500
                    },
                    "model_context_window": 1000000
                }
            }
        });
        let rows = extract_codex_line(&line, ImageMode::Collect);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].role, "__usage__");
        let usage = rows[0].usage.as_ref().expect("usage object");
        assert_eq!(
            usage.get("usage_scope").and_then(Value::as_str),
            Some("last_request")
        );
        assert_eq!(
            usage.get("input_tokens").and_then(Value::as_i64),
            Some(30000)
        );
        assert_eq!(
            usage.get("cached_input_tokens").and_then(Value::as_i64),
            Some(15000)
        );
        assert_eq!(
            usage.get("total_tokens").and_then(Value::as_i64),
            Some(30500)
        );
        assert_eq!(
            usage.get("model_context_window").and_then(Value::as_i64),
            Some(1000000)
        );
    }

    #[test]
    fn claude_compact_boundary_extracts_post_tokens_into_usage() {
        let line: Value = serde_json::json!({
            "type": "system",
            "subtype": "compact_boundary",
            "timestamp": "2026-09-10T05:55:55.956Z",
            "compactMetadata": {
                "preTokens": 30190,
                "postTokens": 8038,
                "durationMs": 4207
            }
        });
        let rows = extract_claude_line(&line, ImageMode::Collect);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].role, "__usage__");
        let usage = rows[0].usage.as_ref().expect("usage object");
        assert_eq!(
            usage.get("input_tokens").and_then(Value::as_i64),
            Some(8038)
        );
        assert_eq!(
            usage.get("total_tokens").and_then(Value::as_i64),
            Some(8038)
        );
    }

    #[test]
    fn cursor_transcript_lines_unwrap_the_timestamp_and_query_envelope() {
        let user = serde_json::json!({"role":"user","message":{"content":[{"type":"text","text":"<image_files>\n1. /tmp/a.png\n</image_files>\n<timestamp>Wednesday, Oct 14, 2026, 4:07 PM (UTC+8)</timestamp>\n<user_query>\nReply with exactly: PONG! 100%\n</user_query>"}]}});
        let rows = extract_cursor_line(&user);
        assert_eq!(rows.len(), 1);
        let row = normalize_extracted_row(rows.into_iter().next().unwrap()).unwrap();
        assert_eq!((row.role.as_str(), row.text.as_str()), ("user", "Reply with exactly: PONG! 100%"));
        let reply = serde_json::json!({"role":"assistant","message":{"content":[{"type":"text","text":"PONG! 100%"}]}});
        assert_eq!(extract_cursor_line(&reply)[0].text, "PONG! 100%");
        assert!(extract_cursor_line(&serde_json::json!({"type":"turn_ended","status":"success"})).is_empty());

        // Redacted thinking blocks, tool_use blocks, injected git_status, and plain-string content lines:
        let lines = [
            serde_json::json!({"role":"user","message":{"content":[{"type":"text","text":"<git_status>\nclean\n</git_status>"}]}}),
            serde_json::json!({"role":"user","message":{"content":"<timestamp>t</timestamp>\n<user_query>\nCheck files\n</user_query>"}}),
            serde_json::json!({"role":"assistant","message":{"content":[{"type":"text","text":"[REDACTED]"},{"type":"tool_use","id":"call_1","name":"Grep","input":{"path":"src/main.rs","pattern":"fn main"}}]}}),
            serde_json::json!({"role":"assistant","message":{"content":[{"type":"text","text":"Found it.\n\n[REDACTED]"}]}}),
        ];
        let input = lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        let parsed = collect_session(
            std::io::Cursor::new(input),
            &extractor_for("cursor", ImageMode::Collect, None),
        ).unwrap();
        let summary: Vec<(&str, &str)> = parsed
            .messages
            .iter()
            .map(|m| (m.role.as_str(), m.text.as_str()))
            .collect();
        assert_eq!(
            summary,
            [
                ("user", "Check files"),
                ("tool", "Grep"),
                ("assistant", "Found it."),
            ]
        );
        assert_eq!(parsed.messages[1].path.as_deref(), Some("src/main.rs"));
    }

    #[test]
    fn qoder_line_skips_sidechains_and_reads_user_prompt() {
        let sidechain = serde_json::json!({
            "type": "user", "uuid": "hidden", "isSidechain": true,
            "humanInput": {"text": "hidden prompt"},
            "message": {"content": "hidden prompt"}
        });
        assert!(extract_qoder_line(&sidechain, ImageMode::Collect).is_empty());
        let sidechain_str = serde_json::json!({
            "type": "assistant", "isSidechain": "true",
            "message": {"content": "hidden answer"}
        });
        assert!(extract_qoder_line(&sidechain_str, ImageMode::Collect).is_empty());

        let user = serde_json::json!({
            "type": "user", "uuid": "user-1", "timestamp": "2026-08-22T00:00:00Z",
            "humanInput": {"text": "first prompt"},
            "message": {"content": "first prompt"}
        });
        let rows = extract_qoder_line(&user, ImageMode::Collect);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].role, "user");
        assert_eq!(rows[0].text, "first prompt");
    }

    #[test]
    fn qoder_human_input_is_user_text_fallback() {
        let line = serde_json::json!({
            "type": "user", "uuid": "u1", "timestamp": "2026-08-22T00:00:00Z",
            "humanInput": {"text": "typed body"}
        });
        let rows = extract_qoder_line(&line, ImageMode::Collect);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].role, "user");
        assert_eq!(rows[0].text, "typed body");
    }

    fn parse_claude_lines(lines: &[Value]) -> ParsedSession {
        let input = lines
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        let extractor: LineExtractor<'_> =
            Box::new(|value: &Value| extract_claude_line(value, ImageMode::Collect));
        collect_session(std::io::Cursor::new(input), &extractor).unwrap()
    }

    fn claude_usage_line(content: Value, input_tokens: u64, model: &str) -> Value {
        serde_json::json!({
            "type": "assistant", "timestamp": "2026-10-04T00:00:00Z", "effort": "high",
            "message": {"role": "assistant", "content": content, "model": model,
                "usage": {"input_tokens": input_tokens, "output_tokens": 100, "model_context_window": 200_000}}
        })
    }

    #[test]
    fn claude_history_request_usage_is_not_whole_turn_accounting() {
        let mut tool = claude_usage_line(serde_json::json!([
            {"type": "tool_use", "id": "read-1", "name": "Read", "input": {"file_path": "a.rs"}}
        ]), 1000, "claude-model");
        tool["timestamp"] = serde_json::json!("2026-10-04T00:00:10Z");
        tool["message"]["usage"]["output_tokens"] = serde_json::json!(5910);
        let mut answer = claude_usage_line(
            serde_json::json!([{"type": "text", "text": "完成 中文🙂"}]), 2000, "claude-model");
        answer["timestamp"] = serde_json::json!("2026-10-04T00:05:00Z");
        answer["message"]["usage"]["output_tokens"] = serde_json::json!(90);
        let parsed = parse_claude_lines(&[
            serde_json::json!({"type":"user","timestamp":"2026-10-04T00:00:00Z",
                "message":{"role":"user","content":[{"type":"text","text":"task"}]}}),
            tool,
            serde_json::json!({"type":"user","timestamp":"2026-10-04T00:00:20Z",
                "message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"read-1","content":"ok"}]}}),
            answer,
        ]);
        let reply = parsed.messages.iter().rev().find(|m| m.role == "assistant").unwrap();
        assert_eq!(reply.text, "完成 中文🙂");
        assert_eq!(reply.duration_ms, Some(300_000));
        let usage = reply.usage.as_ref().unwrap();
        assert_eq!(usage["input_tokens"], 2000);
        assert_eq!(usage["output_tokens"], 90);
        assert_eq!(usage["usage_scope"], "last_request");
        assert!(usage.get("turn_throughput").is_none());
        assert!(parsed.messages.iter().filter_map(|m| m.usage.as_ref())
            .all(|usage| usage["usage_scope"] == "last_request"));
    }

    #[test]
    fn claude_nontext_history_retains_latest_snapshot_once() {
        let transcript = std::env::temp_dir().join(format!("ccgui-claude-usage-{}.jsonl", uuid::Uuid::new_v4()));
        for (content, output_role) in [
            (serde_json::json!([
                {"type": "tool_use", "id": "first", "name": "Read", "input": {"file_path": "first.rs"}},
                {"type": "tool_use", "id": "last", "name": "Read", "input": {"file_path": "last.rs"}}
            ]), "tool"),
            (serde_json::json!([
                {"type": "thinking", "thinking": "first thought"},
                {"type": "thinking", "thinking": "latest thought"}
            ]), "thinking"),
        ] {
            for (old_tokens, new_tokens) in [(150_000, 10_000), (10_000, 150_000)] {
                let older = claude_usage_line(serde_json::json!([{"type": "text", "text": "older reply"}]), old_tokens, "older-model");
                let latest = claude_usage_line(content.clone(), new_tokens, "latest-model");
                std::fs::write(&transcript, format!("{older}\n{latest}\n")).unwrap();
                let parsed = parse_session_file_with_handoffs("claude", &transcript, Default::default()).unwrap();
                assert_eq!(parsed.messages.len(), 3, "metadata must not create a visible message");
                assert_eq!(parsed.messages[1].role, output_role);
                assert_eq!(parsed.messages[2].role, output_role);
                assert!(parsed.messages[1].usage.is_none(), "one snapshot, not one billed usage per block");
                assert!(parsed.messages[1].model.is_none());
                let latest_usage = parsed.messages.iter().rev().find_map(|message| message.usage.as_ref()).unwrap();
                assert_eq!(latest_usage["input_tokens"], new_tokens);
                assert_eq!(parsed.messages[2].model.as_deref(), Some("latest-model"));
                assert_eq!(parsed.messages[2].effort.as_deref(), Some("high"));
                assert_eq!(parsed.messages[0].usage.as_ref().unwrap()["input_tokens"], old_tokens);
                let isolated = parse_claude_lines(&[latest]);
                assert_eq!(isolated.messages.len(), 2);
                assert_eq!(isolated.messages.iter().filter(|row| row.usage.is_some()).count(), 1);
                assert_eq!(isolated.messages[1].usage.as_ref().unwrap()["input_tokens"], new_tokens);
            }
        }
        std::fs::remove_file(&transcript).unwrap();
    }

    #[test]
    fn claude_empty_usage_updates_latest_output_without_fabricating_a_message() {
        for content in [serde_json::json!([]), serde_json::json!(""), Value::Null] {
            let latest = claude_usage_line(content, 150_000, "latest-model");
            let extracted = extract_claude_line(&latest, ImageMode::Collect);
            assert_eq!(extracted.len(), 1);
            assert_eq!(extracted[0].role, "__usage__");
            let mut expected_usage = latest["message"]["usage"].clone();
            expected_usage["usage_scope"] = serde_json::json!("last_request");
            assert_eq!(extracted[0].usage, Some(expected_usage));
            assert!(parse_claude_lines(&[latest.clone()]).messages.is_empty(),
                "a usage-only transcript has no visible output to attach metadata to");
            for earlier_content in [
                serde_json::json!([{"type": "text", "text": "earlier reply"}]),
                serde_json::json!([{"type": "tool_use", "id": "one", "name": "Read", "input": {}}]),
                serde_json::json!([{"type": "thinking", "thinking": "earlier thought"}]),
            ] {
                let earlier = claude_usage_line(earlier_content, 10_000, "older-model");
                let parsed = parse_claude_lines(&[earlier.clone(), latest.clone()]);
                assert_eq!(parsed.messages.len(), 1);
                assert_eq!(parsed.messages[0].usage.as_ref().unwrap()["input_tokens"], 150_000);
                assert_eq!(parsed.messages[0].model.as_deref(), Some("latest-model"));
                let mut absent_usage = latest.clone();
                absent_usage["message"].as_object_mut().unwrap().remove("usage");
                let unchanged = parse_claude_lines(&[earlier, absent_usage]);
                assert_eq!(unchanged.messages[0].usage.as_ref().unwrap()["input_tokens"], 10_000);
            }
        }
        let mut missing_content = claude_usage_line(Value::Null, 150_000, "latest-model");
        missing_content["message"].as_object_mut().unwrap().remove("content");
        assert_eq!(extract_claude_line(&missing_content, ImageMode::Collect)[0].role, "__usage__");
    }

    #[test]
    fn claude_text_usage_stays_on_text_and_image_only_usage_is_retained() {
        let line = claude_usage_line(serde_json::json!([
            {"type": "thinking", "thinking": "thought"},
            {"type": "tool_use", "id": "one", "name": "Read", "input": {}},
            {"type": "text", "text": "answer"}
        ]), 10_000, "latest-model");
        let parsed = parse_claude_lines(&[line]);
        assert_eq!(parsed.messages.len(), 3);
        assert!(parsed.messages[..2].iter().all(|row| row.usage.is_none() && row.model.is_none()));
        assert_eq!(parsed.messages[2].role, "assistant");
        assert_eq!(parsed.messages[2].usage.as_ref().unwrap()["input_tokens"], 10_000);
        let image = claude_usage_line(serde_json::json!([
            {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "aGk="}}
        ]), 10_000, "latest-model");
        let parsed = parse_claude_lines(&[image]);
        assert_eq!(parsed.messages.len(), 1);
        assert_eq!(parsed.messages[0].images.len(), 1);
        assert_eq!(parsed.messages[0].usage.as_ref().unwrap()["input_tokens"], 10_000);
    }

    #[test]
    fn claude_synthetic_error_reply_keeps_text_but_not_zero_usage_or_model() {
        // Shape of the CLI's local rate-limit notice: no API call happened.
        let real = claude_usage_line(serde_json::json!([{"type": "text", "text": "real reply"}]), 430_000, "claude-opus-5-5");
        let synthetic = serde_json::json!({
            "type": "assistant", "timestamp": "2026-10-04T00:00:01Z",
            "isApiErrorMessage": true, "apiErrorStatus": 429,
            "message": {"role": "assistant", "model": "<synthetic>",
                "content": [{"type": "text", "text": "You've hit your session limit"}],
                "usage": {"input_tokens": 0, "output_tokens": 0,
                    "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}}
        });
        let parsed = parse_claude_lines(&[real, synthetic]);
        assert_eq!(parsed.messages.len(), 2);
        assert_eq!(parsed.messages[1].text, "You've hit your session limit");
        assert!(parsed.messages[1].usage.is_none(), "zero snapshot must not supersede occupancy");
        assert!(parsed.messages[1].model.is_none(), "<synthetic> is not a model the session ran");
        let latest = parsed.messages.iter().rev().find_map(|m| m.usage.as_ref()).unwrap();
        assert_eq!(latest["input_tokens"], 430_000);
        assert_eq!(latest["model_context_window"], 200_000);
    }

    #[test]
    fn shared_usage_sentinel_updates_latest_model_output_and_preserves_window() {
        for role in ["tool", "thinking"] {
            let previous_usage = serde_json::json!({"input_tokens": 150_000, "model_context_window": 200_000});
            let parsed = fold_rows(vec![
                LineRow { usage: Some(previous_usage.clone()), ..LineRow::new("assistant", "older text".into(), None) },
                LineRow { usage: Some(previous_usage), model: Some("same-model".into()),
                    ..LineRow::new(role, "latest output".into(), None) },
                LineRow { usage: Some(serde_json::json!({"input_tokens": 10_000})),
                    ..LineRow::new("__usage__", String::new(), None) },
            ]);
            assert_eq!(parsed.messages.len(), 2);
            assert_eq!(parsed.messages[0].usage.as_ref().unwrap()["input_tokens"], 150_000);
            assert_eq!(parsed.messages[1].usage.as_ref().unwrap()["input_tokens"], 10_000);
            assert_eq!(parsed.messages[1].usage.as_ref().unwrap()["model_context_window"], 200_000);
            assert_eq!(parsed.messages[1].model.as_deref(), Some("same-model"));
        }
    }

    #[test]
    fn claude_mixed_output_compact_inherits_reported_window_without_old_tokens() {
        let mixed = claude_usage_line(serde_json::json!([
            {"type": "text", "text": "before the tool"},
            {"type": "tool_use", "id": "one", "name": "Read", "input": {}}
        ]), 150_000, "same-model");
        let compact = serde_json::json!({"type": "system", "subtype": "compact_boundary",
            "compactMetadata": {"postTokens": 100_000}});
        let parsed = parse_claude_lines(&[mixed, compact]);
        assert_eq!(parsed.messages.len(), 2);
        assert_eq!(parsed.messages[0].usage.as_ref().unwrap()["input_tokens"], 150_000);
        assert_eq!(parsed.messages[1].role, "tool");
        let usage = parsed.messages[1].usage.as_ref().unwrap();
        assert_eq!(usage["input_tokens"], 100_000);
        assert_eq!(usage["total_tokens"], 100_000);
        assert_eq!(usage["model_context_window"], 200_000);
        assert!(usage.get("output_tokens").is_none(), "only capacity, not earlier billing, is inherited");
    }

    #[test]
    fn usage_window_cache_ignores_user_and_invalid_reports_and_respects_models() {
        let row = |role, window: Value, model: Option<&str>| LineRow {
            usage: Some(serde_json::json!({"input_tokens": 150_000, "model_context_window": window})),
            model: model.map(str::to_string),
            ..LineRow::new(role, "output".into(), None)
        };
        let sentinel = |window: Option<u64>| LineRow {
            usage: Some(match window {
                Some(window) => serde_json::json!({"input_tokens": 100_000, "model_context_window": window}),
                None => serde_json::json!({"input_tokens": 100_000}),
            }),
            ..LineRow::new("__usage__", String::new(), None)
        };
        for invalid in [Value::Null, serde_json::json!(-1), serde_json::json!(0),
            serde_json::json!({"tokens": 200_000}), serde_json::json!("unknown")] {
            let parsed = fold_rows(vec![row("assistant", invalid, Some("model")),
                LineRow::new("tool", "Read".into(), None), sentinel(None)]);
            assert!(parsed.messages[1].usage.as_ref().unwrap().get("model_context_window").is_none());
        }
        let parsed = fold_rows(vec![row("user", serde_json::json!(750_000), None),
            LineRow::new("tool", "Read".into(), None), sentinel(None)]);
        assert!(parsed.messages[1].usage.as_ref().unwrap().get("model_context_window").is_none());
        let parsed = fold_rows(vec![row("assistant", serde_json::json!(200_000), Some("old-model")),
            LineRow { model: Some("new-model".into()), ..LineRow::new("tool", "Read".into(), None) }, sentinel(None)]);
        assert!(parsed.messages[1].usage.as_ref().unwrap().get("model_context_window").is_none());
        let parsed = fold_rows(vec![row("assistant", serde_json::json!(200_000), Some("old-model")),
            row("thinking", serde_json::json!(400_000), Some("new-model")),
            LineRow::new("tool", "Read".into(), None), sentinel(None)]);
        assert_eq!(parsed.messages[2].usage.as_ref().unwrap()["model_context_window"], 400_000);
        let parsed = fold_rows(vec![row("assistant", serde_json::json!(200_000), Some("model")),
            LineRow::new("tool", "Read".into(), None), sentinel(Some(400_000))]);
        assert_eq!(parsed.messages[1].usage.as_ref().unwrap()["model_context_window"], 400_000);
    }

    fn claude_tool_use_line(blocks: Vec<Value>) -> Value {
        serde_json::json!({
            "type": "assistant", "timestamp": "2026-10-01T00:00:00Z",
            "message": {"role": "assistant", "content": blocks}
        })
    }

    fn claude_tool_result_line(blocks: Vec<Value>) -> Value {
        serde_json::json!({
            "type": "user", "timestamp": "2026-10-01T00:00:05Z",
            "message": {"role": "user", "content": blocks}
        })
    }

    /// Claude writes tool_result lines in completion order: a background Agent's
    /// launch receipt lands immediately while a synchronous sibling's report
    /// arrives later. Pairing on "latest unresolved" swaps them, so the real
    /// async launch looks finished; the tool_use id must name the owner.
    #[test]
    fn claude_parallel_agent_results_pair_by_tool_use_id() {
        let calls = claude_tool_use_line(vec![
            serde_json::json!({"type": "tool_use", "id": "toolu_A", "name": "Agent",
                "input": {"description": "background", "prompt": "p", "run_in_background": true}}),
            serde_json::json!({"type": "tool_use", "id": "toolu_B", "name": "Agent",
                "input": {"description": "sync", "prompt": "p"}}),
        ]);
        let receipt = serde_json::json!(
            "Async agent launched successfully. The agent is working in the background."
        );
        let report = serde_json::json!("Final report from the synchronous agent.");
        let result = |id: &str, body: &Value| {
            claude_tool_result_line(vec![
                serde_json::json!({"type": "tool_result", "tool_use_id": id, "content": body}),
            ])
        };

        // A's receipt is written first, B's report later (the real-world order).
        let parsed = parse_claude_lines(&[
            calls.clone(),
            result("toolu_A", &receipt),
            result("toolu_B", &report),
        ]);
        assert_eq!(parsed.messages.len(), 2);
        assert_eq!(
            parsed.messages[0].args.as_ref().unwrap()["run_in_background"],
            true
        );
        assert_eq!(parsed.messages[0].result.as_ref(), Some(&receipt));
        assert_eq!(parsed.messages[1].result.as_ref(), Some(&report));

        // Opposite completion order pairs the same way.
        let parsed = parse_claude_lines(&[
            calls,
            result("toolu_B", &report),
            result("toolu_A", &receipt),
        ]);
        assert_eq!(parsed.messages[0].result.as_ref(), Some(&receipt));
        assert_eq!(parsed.messages[1].result.as_ref(), Some(&report));
    }

    /// Results whose id is missing or names no known call must still land
    /// (latest unresolved, as before), while a replayed result for an already
    /// answered call must not steal another call's slot.
    #[test]
    fn claude_unmatched_tool_results_fall_back_to_latest_unresolved() {
        let calls = claude_tool_use_line(vec![
            serde_json::json!({"type": "tool_use", "id": "toolu_A", "name": "Bash",
                "input": {"command": "a"}}),
            serde_json::json!({"type": "tool_use", "id": "toolu_B", "name": "Bash",
                "input": {"command": "b"}}),
            // A tool_use without an id can only ever be reached by the fallback.
            serde_json::json!({"type": "tool_use", "name": "Bash", "input": {"command": "c"}}),
        ]);
        let result = |id: Option<&str>, body: &str| {
            let mut block = serde_json::json!({"type": "tool_result", "content": body});
            if let Some(id) = id {
                block["tool_use_id"] = serde_json::json!(id);
            }
            claude_tool_result_line(vec![block])
        };
        let parsed = parse_claude_lines(&[
            calls,
            result(Some("toolu_B"), "body b"),
            // Replay of an answered call: ignored, not moved onto A or C.
            result(Some("toolu_B"), "replayed b"),
            // Unknown id: falls back to the latest unresolved call (the id-less one).
            result(Some("toolu_ghost"), "ghost body"),
            // No id at all: falls back to the remaining unresolved call.
            result(None, "anonymous body"),
        ]);
        let results: Vec<_> = parsed.messages.iter().map(|m| m.result.clone()).collect();
        assert_eq!(
            results,
            [
                Some(serde_json::json!("anonymous body")),
                Some(serde_json::json!("body b")),
                Some(serde_json::json!("ghost body")),
            ]
        );
    }

    /// Record shape the CLI (2.1.28x) appends when an interrupt-only Stop
    /// leaves the process alive, copied from real transcripts: one text block,
    /// no `isMeta`, with `promptId`/`interruptedMessageId` siblings.
    fn claude_interrupt_record(content: Value, ts: &str) -> Value {
        serde_json::json!({
            "parentUuid": "6c1cbfe5-ad5d-47c0-ab4c-b7be26ad4c40",
            "isSidechain": false,
            "promptId": "d86b9f76-f231-4885-ae09-239687ac534e",
            "type": "user",
            "message": {"role": "user", "content": content},
            "uuid": "85756518-f919-412f-89e7-0a57e226fb74",
            "timestamp": ts,
            "interruptedMessageId": "msg_011CfXc8dpZqGqDCjepMYd6U",
            "userType": "external",
            "entrypoint": "cli",
            "version": "2.1.284"
        })
    }

    #[test]
    fn claude_line_drops_interrupt_markers() {
        for marker in [
            "[Request interrupted by user]",
            "[Request interrupted by user for tool use]",
        ] {
            let blocks = serde_json::json!([{"type": "text", "text": marker}]);
            let line = claude_interrupt_record(blocks, "2026-09-29T10:54:02.340Z");
            assert!(extract_claude_line(&line, ImageMode::Collect).is_empty(), "{marker}");

            // Plain-string content and stray whitespace are the same abort record.
            let padded = format!("\n{marker} ");
            for content in [serde_json::json!(marker), serde_json::json!(padded)] {
                let line = claude_interrupt_record(content, "2026-09-29T10:54:02.340Z");
                assert!(extract_claude_line(&line, ImageMode::Collect).is_empty(), "{marker}");
            }

            // qoder reuses the claude walk and its humanInput fallback must
            // not bring the marker back as a typed prompt.
            let mut mirrored = claude_interrupt_record(
                serde_json::json!([{"type": "text", "text": marker}]),
                "2026-09-29T10:54:02.340Z",
            );
            mirrored["humanInput"] = serde_json::json!({"text": marker});
            assert!(extract_qoder_line(&mirrored, ImageMode::Collect).is_empty(), "{marker}");
        }
    }

    /// Only the whole turn being the marker makes it a CLI record; anything a
    /// person typed around or next to the phrase is real history.
    #[test]
    fn claude_line_keeps_user_turns_that_only_mention_interrupt_marker() {
        let mention = "why does it log [Request interrupted by user] after Stop?";
        for content in [
            serde_json::json!(mention),
            serde_json::json!([{"type": "text", "text": mention}]),
            serde_json::json!([
                {"type": "text", "text": "[Request interrupted by user]"},
                {"type": "text", "text": "and then continue"}
            ]),
            serde_json::json!("[Request interrupted by user] please retry"),
            serde_json::json!("[Request interrupted by user] [Request interrupted by user]"),
        ] {
            let line = claude_interrupt_record(content.clone(), "2026-09-29T10:54:02.340Z");
            let rows = extract_claude_line(&line, ImageMode::Collect);
            assert_eq!(rows.len(), 1, "{content}");
            assert_eq!(rows[0].role, "user");
        }

        // A pasted image next to the marker text is still the user's message.
        let with_image = claude_interrupt_record(
            serde_json::json!([
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "aGk="}},
                {"type": "text", "text": "[Request interrupted by user]"}
            ]),
            "2026-09-29T10:54:02.340Z",
        );
        let rows = extract_claude_line(&with_image, ImageMode::Collect);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].images, ["data:image/png;base64,aGk="]);

        // The marker is a user-turn artifact; assistant text is never dropped.
        let assistant = serde_json::json!({
            "type": "assistant", "timestamp": "2026-09-29T10:54:02.340Z",
            "message": {"role": "assistant", "content": [{"type": "text", "text": "[Request interrupted by user]"}]}
        });
        assert_eq!(extract_claude_line(&assistant, ImageMode::Collect).len(), 1);
    }

    /// Reopening a session whose Stop interrupted a reply (and a tool call)
    /// must read back the typed turns only: no phantom user row, the aborted
    /// tool keeps its result, and the next prompt still pairs with its reply.
    #[test]
    fn claude_history_hides_interrupt_markers_and_keeps_pairing() {
        let user = |text: &str, ts: &str| {
            serde_json::json!({
                "type": "user", "timestamp": ts,
                "message": {"role": "user", "content": text}
            })
        };
        let assistant = |blocks: Value, ts: &str| {
            serde_json::json!({
                "type": "assistant", "timestamp": ts,
                "message": {"role": "assistant", "content": blocks}
            })
        };
        let marker = |text: &str, ts: &str| {
            claude_interrupt_record(serde_json::json!([{"type": "text", "text": text}]), ts)
        };
        let lines = [
            user("first question", "2026-10-01T00:00:00.000Z"),
            assistant(
                serde_json::json!([
                    {"type": "text", "text": "running it"},
                    {"type": "tool_use", "id": "toolu_A", "name": "Bash", "input": {"command": "sleep 99"}}
                ]),
                "2026-10-01T00:00:02.000Z",
            ),
            claude_tool_result_line(vec![serde_json::json!({
                "type": "tool_result", "tool_use_id": "toolu_A", "is_error": true,
                "content": "The user doesn't want to proceed with this tool use."
            })]),
            marker("[Request interrupted by user for tool use]", "2026-10-01T00:00:05.000Z"),
            user("second question", "2026-10-01T00:01:00.000Z"),
            assistant(serde_json::json!([{"type": "text", "text": "partial answer"}]), "2026-10-01T00:01:03.000Z"),
            marker("[Request interrupted by user]", "2026-10-01T00:01:04.000Z"),
            user("third question", "2026-10-01T00:02:00.000Z"),
            assistant(serde_json::json!([{"type": "text", "text": "full answer"}]), "2026-10-01T00:02:09.000Z"),
        ];
        let dir = std::env::temp_dir().join(format!("ccgui-extract-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let transcript = dir.join("session.jsonl");
        std::fs::write(
            &transcript,
            lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n"),
        )
        .unwrap();

        let parsed = parse_session_file("claude", &transcript).unwrap();
        let rows: Vec<(&str, &str)> = parsed
            .messages
            .iter()
            .map(|m| (m.role.as_str(), m.text.as_str()))
            .collect();
        assert_eq!(
            rows,
            [
                ("user", "first question"),
                ("assistant", "running it"),
                ("tool", "Bash"),
                ("user", "second question"),
                ("assistant", "partial answer"),
                ("user", "third question"),
                ("assistant", "full answer"),
            ]
        );
        assert_eq!(
            parsed.messages[2].result,
            Some(serde_json::json!("The user doesn't want to proceed with this tool use."))
        );
        // Each reply is timed from the prompt it answers.
        assert_eq!(parsed.messages[4].duration_ms, Some(3_000));
        assert_eq!(parsed.messages[6].duration_ms, Some(9_000));
        let seqs: Vec<i64> = parsed.messages.iter().map(|m| m.seq).collect();
        assert_eq!(seqs, [1, 2, 3, 4, 5, 6, 7]);

        // The sidebar count, title and last-activity time ignore the markers too.
        let summary = scan_summary_file("claude", &transcript).unwrap();
        assert_eq!(summary.message_count, 7);
        assert_eq!(summary.title, "first question");
        assert_eq!(summary.preview, "full answer");
        assert_eq!(summary.last_ts, parse_ts_ms_str("2026-10-01T00:02:09.000Z"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// qoder's toolUseResult envelope pairs with its tool_use call by id —
    /// parallel calls finishing out of order must not cross-label.
    #[test]
    fn qoder_tool_result_pairs_with_call_id() {
        let call = |id: &str| {
            serde_json::json!({
                "type": "assistant", "uuid": id, "timestamp": "2026-08-22T00:00:01Z",
                "message": {"content": [
                    {"type": "tool_use", "id": id, "name": "Read", "input": {"path": "README.md"}}
                ]}
            })
        };
        let result = |id: &str, body: &str| {
            serde_json::json!({
                "type": "user", "timestamp": "2026-08-22T00:00:02Z",
                "toolUseResult": {"ok": true},
                "message": {"content": [
                    {"type": "tool_result", "tool_use_id": id, "content": body}
                ]}
            })
        };
        let lines = vec![
            call("tool-a"),
            call("tool-b"),
            result("tool-b", "body b"),
            result("tool-a", "body a"),
        ];
        let input = lines
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        let extractor: LineExtractor<'_> =
            Box::new(|value: &Value| extract_qoder_line(value, ImageMode::Collect));
        let parsed = collect_session(std::io::Cursor::new(input), &extractor).unwrap();
        assert_eq!(parsed.messages.len(), 2);
        assert_eq!(parsed.messages[0].result, Some(serde_json::json!("body a")));
        assert_eq!(parsed.messages[1].result, Some(serde_json::json!("body b")));
    }

    /// OpenCode fixture tree: storage/session + message + part jsons, shaped
    /// like opencode 1.1.16 on disk.
    fn opencode_fixture() -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("ccgui-extract-{}", uuid::Uuid::new_v4()));
        let storage = dir.join("storage");
        let meta = storage.join("session").join("proj1").join("ses_x.json");
        std::fs::create_dir_all(meta.parent().unwrap()).unwrap();
        std::fs::write(
            &meta,
            serde_json::json!({
                "id": "ses_x", "projectID": "proj1", "directory": "/ws",
                "title": "t", "time": {"created": 1_700_000_000_000i64, "updated": 1_700_000_004_000i64}
            })
            .to_string(),
        )
        .unwrap();
        let write = |path: PathBuf, value: Value| {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, value.to_string()).unwrap();
        };
        write(
            storage.join("message/ses_x/msg_1000.json"),
            serde_json::json!({"id": "msg_1000", "sessionID": "ses_x", "role": "user",
                "time": {"created": 1_700_000_000_000i64}}),
        );
        write(
            storage.join("part/msg_1000/prt_01.json"),
            serde_json::json!({"id": "prt_01", "sessionID": "ses_x", "messageID": "msg_1000",
                "type": "text", "text": "hello opencode"}),
        );
        write(
            storage.join("message/ses_x/msg_2000.json"),
            serde_json::json!({"id": "msg_2000", "sessionID": "ses_x", "role": "assistant",
                "time": {"created": 1_700_000_001_000i64, "completed": 1_700_000_002_000i64},
                "model": {"providerID": "anthropic", "modelID": "claude-sonnet-4-5"}}),
        );
        write(
            storage.join("part/msg_2000/prt_01.json"),
            serde_json::json!({"id": "prt_01", "sessionID": "ses_x", "messageID": "msg_2000",
                "type": "reasoning", "text": "ponder"}),
        );
        write(
            storage.join("part/msg_2000/prt_02.json"),
            serde_json::json!({"id": "prt_02", "sessionID": "ses_x", "messageID": "msg_2000",
                "type": "tool", "callID": "c1", "tool": "read",
                "state": {"status": "completed", "input": {"path": "src/main.rs"}, "output": "file body"}}),
        );
        write(
            storage.join("part/msg_2000/prt_03.json"),
            serde_json::json!({"id": "prt_03", "sessionID": "ses_x", "messageID": "msg_2000",
                "type": "text", "text": "done", "time": {"start": 1_700_000_001_900i64}}),
        );
        write(
            storage.join("part/msg_2000/prt_04.json"),
            serde_json::json!({"id": "prt_04", "sessionID": "ses_x", "messageID": "msg_2000",
                "type": "step-finish",
                "tokens": {"input": 10, "output": 5, "reasoning": 0, "cache": {"read": 1, "write": 2}}}),
        );
        (dir, meta)
    }

    #[test]
    fn opencode_parse_reads_storage_tree() {
        let (dir, meta) = opencode_fixture();
        let parsed = parse_session_file("opencode", &meta).unwrap();
        let roles: Vec<&str> = parsed.messages.iter().map(|m| m.role.as_str()).collect();
        assert_eq!(roles, ["user", "thinking", "tool", "assistant"]);
        assert_eq!(parsed.messages[0].text, "hello opencode");
        assert_eq!(parsed.messages[2].text, "read");
        assert_eq!(parsed.messages[2].path.as_deref(), Some("src/main.rs"));
        assert_eq!(
            parsed.messages[2].result,
            Some(serde_json::json!("file body"))
        );
        let answer = &parsed.messages[3];
        assert_eq!(answer.text, "done");
        assert_eq!(answer.model.as_deref(), Some("claude-sonnet-4-5"));
        assert_eq!(answer.duration_ms, Some(1000));
        // step-finish tokens fold onto the last assistant message.
        let usage = answer.usage.as_ref().expect("usage folded");
        assert_eq!(usage.get("input_tokens").and_then(Value::as_i64), Some(10));
        assert_eq!(
            usage.get("cache_read_input_tokens").and_then(Value::as_i64),
            Some(1)
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn opencode_scan_summary_from_storage_tree() {
        let (dir, meta) = opencode_fixture();
        let summary = scan_summary_file("opencode", &meta).unwrap();
        assert_eq!(summary.title, "hello opencode");
        assert_eq!(summary.preview, "done");
        assert_eq!(summary.first_ts, Some(1_700_000_000_000));
        assert_eq!(summary.last_ts, Some(1_700_000_001_000));
        assert_eq!(summary.message_count, 4);
        let rows = extract_pi_family_line(
            &serde_json::json!({
                "type": "compaction",
                "timestamp": "2026-10-17T10:00:00Z",
                "summary": "Compacted summary text",
                "tokensBefore": 64_000,
                "usage": { "input": 64_000, "output": 1_850 },
            }),
            ImageMode::SkipDataUrls,
        );
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].role, "__usage__");
        assert_eq!(
            rows[0].usage.as_ref().and_then(|u| u.get("input_tokens")).and_then(Value::as_i64),
            Some(1_850)
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
