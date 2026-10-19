//! 【cursor上下文】从 Cursor CLI 的本地会话库读取当前上下文占用。
//!
//! `result.usage` 把这一轮里每次模型调用的 token 加总，长对话会超过所选窗口，
//! 不能当成上下文占用。交互界面用的是会话状态里的 `token_details`
//! （`used_tokens` / `max_tokens` 和分类），这里按同样的字段读取。

use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

const MAX_STATE_BYTES: usize = 4 * 1024 * 1024;
const MAX_DETAILS_BYTES: usize = 256 * 1024;
const MAX_CATEGORIES: usize = 32;

/// 读当前会话的上下文占用。库不存在、被占用或字段不可信时返回 `None`。
pub(crate) fn read_cursor_context_usage(session_id: &str) -> Option<Value> {
    read_cursor_context_usage_in(&super::cursor::cursor_home(), session_id)
}

pub(crate) fn read_cursor_context_usage_in(home: &Path, session_id: &str) -> Option<Value> {
    let dir = super::sidechat::find_cursor_chat_dir(home, session_id)?;
    let conn = rusqlite::Connection::open_with_flags(
        dir.join("store.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .ok()?;
    // 【cursor上下文】解析线程不能等锁。读不到就保持上一份占用，刷新可以再试。
    conn.busy_timeout(Duration::from_millis(150)).ok()?;
    let raw_hex: String = conn
        .query_row("SELECT value FROM meta WHERE key = '0'", [], |row| row.get(0))
        .ok()?;
    let meta = decode_meta(&raw_hex)?;
    let root = meta.get("latestRootBlobId").and_then(Value::as_str)?;
    if meta.get("agentId").and_then(Value::as_str) != Some(session_id.trim()) {
        return None;
    }
    let blob: Vec<u8> = conn
        .query_row("SELECT data FROM blobs WHERE id = ?1", [root], |row| row.get(0))
        .ok()?;
    if blob.len() > MAX_STATE_BYTES {
        return None;
    }
    let details = protobuf_field(&blob, 5)?;
    if details.len() > MAX_DETAILS_BYTES {
        return None;
    }
    context_usage_json(&details)
}

/// 把上下文读数并进已有用量。计费字段保持原样，占用放在 `context_usage`。
pub(crate) fn merge_context_usage(usage: Option<Value>, context: Value) -> Value {
    let mut merged = match usage {
        Some(Value::Object(map)) => Value::Object(map),
        _ => json!({}),
    };
    let Some(target) = merged.as_object_mut() else {
        return context;
    };
    let Some(source) = context.as_object() else {
        return merged;
    };
    for (key, value) in source {
        target.insert(key.clone(), value.clone());
    }
    merged
}

fn decode_meta(raw: &str) -> Option<Value> {
    let bytes = super::sidechat::hex_decode(raw.trim())?;
    serde_json::from_slice(&bytes).ok()
}

fn context_usage_json(details: &[u8]) -> Option<Value> {
    let used = protobuf_varint(details, 1)?;
    let max = protobuf_varint(details, 2)?;
    if used > u64::from(u32::MAX) || max == 0 || max > 10_000_000 || used > max.saturating_mul(105) / 100 {
        return None;
    }
    let mut categories = Vec::new();
    if let Some(breakdown) = protobuf_field(details, 3) {
        for category in protobuf_fields(&breakdown, 3) {
            let Some(id) = protobuf_string(&category, 1) else {
                continue;
            };
            if !valid_category_id(&id) {
                continue;
            }
            let tokens = protobuf_varint(&category, 3).unwrap_or(0);
            if tokens == 0 || tokens > used {
                continue;
            }
            categories.push(json!({ "id": id, "tokens": tokens }));
            if categories.len() == MAX_CATEGORIES {
                break;
            }
        }
    }
    Some(json!({
        "context_usage_kind": "current_context",
        "context_usage": {
            "used_tokens": used,
            "model_context_window": max,
            "categories": categories,
        }
    }))
}

fn valid_category_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 40
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

fn protobuf_varint(data: &[u8], field: u32) -> Option<u64> {
    let mut found = None;
    for (number, wire, value) in protobuf_items(data)? {
        if number == field && wire == 0 {
            found = value.as_varint();
        }
    }
    found
}

fn protobuf_string(data: &[u8], field: u32) -> Option<String> {
    let bytes = protobuf_field(data, field)?;
    let text = std::str::from_utf8(&bytes).ok()?;
    text.chars().all(|ch| !ch.is_control()).then(|| text.to_string())
}

fn protobuf_field(data: &[u8], field: u32) -> Option<Vec<u8>> {
    protobuf_fields(data, field).into_iter().next_back()
}

fn protobuf_fields(data: &[u8], field: u32) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    let Some(items) = protobuf_items(data) else {
        return out;
    };
    for (number, wire, value) in items {
        if number == field && wire == 2 {
            if let ProtoValue::Bytes(bytes) = value {
                out.push(bytes);
            }
        }
    }
    out
}

enum ProtoValue {
    Varint(u64),
    Bytes(Vec<u8>),
}

impl ProtoValue {
    fn as_varint(&self) -> Option<u64> {
        match self {
            Self::Varint(value) => Some(*value),
            Self::Bytes(_) => None,
        }
    }
}

/// 只扫描顶层字段。长度不合法就整段放弃，避免把哈希或密文当成占用。
fn protobuf_items(data: &[u8]) -> Option<Vec<(u32, u8, ProtoValue)>> {
    let mut index = 0;
    let mut out = Vec::new();
    while index < data.len() {
        let (key, next) = read_varint(data, index)?;
        let field = u32::try_from(key >> 3).ok()?;
        let wire = (key & 7) as u8;
        index = next;
        if field == 0 || field > 200 {
            return None;
        }
        match wire {
            0 => {
                let (value, next) = read_varint(data, index)?;
                index = next;
                out.push((field, wire, ProtoValue::Varint(value)));
            }
            1 => {
                index = index.checked_add(8)?;
                if index > data.len() {
                    return None;
                }
            }
            2 => {
                let (len, next) = read_varint(data, index)?;
                let len = usize::try_from(len).ok()?;
                index = next.checked_add(len)?;
                if index > data.len() {
                    return None;
                }
                out.push((field, wire, ProtoValue::Bytes(data[next..index].to_vec())));
            }
            5 => {
                index = index.checked_add(4)?;
                if index > data.len() {
                    return None;
                }
            }
            _ => return None,
        }
    }
    Some(out)
}

fn read_varint(data: &[u8], mut index: usize) -> Option<(u64, usize)> {
    let mut value = 0u64;
    let mut shift = 0;
    while index < data.len() && shift <= 63 {
        let byte = data[index];
        index += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte < 0x80 {
            return Some((value, index));
        }
        shift += 7;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn varint(mut value: u64) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value != 0 {
                byte |= 0x80;
            }
            out.push(byte);
            if value == 0 {
                break;
            }
        }
        out
    }

    fn key(field: u32, wire: u8) -> Vec<u8> {
        varint((u64::from(field) << 3) | u64::from(wire))
    }

    fn field_varint(field: u32, value: u64) -> Vec<u8> {
        let mut out = key(field, 0);
        out.extend(varint(value));
        out
    }

    fn field_bytes(field: u32, bytes: &[u8]) -> Vec<u8> {
        let mut out = key(field, 2);
        out.extend(varint(bytes.len() as u64));
        out.extend(bytes);
        out
    }

    fn category(id: &str, tokens: u64) -> Vec<u8> {
        let mut out = field_bytes(1, id.as_bytes());
        out.extend(field_bytes(2, id.as_bytes()));
        out.extend(field_varint(3, tokens));
        out
    }

    fn token_details(used: u64, max: u64) -> Vec<u8> {
        let mut breakdown = field_varint(1, used);
        breakdown.extend(field_varint(2, max));
        breakdown.extend(field_bytes(3, &category("conversation", used - 100)));
        breakdown.extend(field_bytes(3, &category("rules", 100)));
        let mut details = field_varint(1, used);
        details.extend(field_varint(2, max));
        details.extend(field_bytes(3, &breakdown));
        details
    }

    #[test]
    fn reads_current_context_from_the_conversation_state() {
        let home = std::env::temp_dir().join(format!("ccgui-cursor-context-{}", uuid::Uuid::new_v4()));
        let session_id = "11111111-2222-4333-8444-555555555555";
        let dir = home.join("chats").join("workspace").join(session_id);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = rusqlite::Connection::open(dir.join("store.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);",
        )
        .unwrap();
        let mut state = field_bytes(1, &[9u8; 32]);
        state.extend(field_bytes(5, &token_details(143_356, 256_000)));
        let root = "abc123";
        let meta = serde_json::json!({
            "agentId": session_id,
            "latestRootBlobId": root,
        });
        let encoded = super::super::sidechat::hex_encode(&serde_json::to_vec(&meta).unwrap());
        conn.execute("INSERT INTO meta VALUES ('0', ?1)", [encoded]).unwrap();
        conn.execute("INSERT INTO blobs VALUES (?1, ?2)", rusqlite::params![root, state])
            .unwrap();
        drop(conn);

        let usage = read_cursor_context_usage_in(&home, session_id).unwrap();
        assert_eq!(usage["context_usage_kind"], "current_context");
        assert_eq!(usage["context_usage"]["used_tokens"], 143_356);
        assert_eq!(usage["context_usage"]["model_context_window"], 256_000);
        assert_eq!(usage["context_usage"]["categories"][0]["id"], "conversation");
        assert_eq!(usage["context_usage"]["categories"][0]["tokens"], 143_256);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn rejects_a_sum_that_does_not_fit_the_reported_window() {
        let details = token_details(2_000_000, 256_000);
        assert!(context_usage_json(&details).is_none());
    }

    #[test]
    fn keeps_billing_fields_when_context_is_attached() {
        let billing = serde_json::json!({ "input_tokens": 20, "output_tokens": 3 });
        let context = serde_json::json!({
            "context_usage_kind": "current_context",
            "context_usage": { "used_tokens": 100 }
        });
        let merged = merge_context_usage(Some(billing), context);
        assert_eq!(merged["input_tokens"], 20);
        assert_eq!(merged["context_usage"]["used_tokens"], 100);
    }
}
