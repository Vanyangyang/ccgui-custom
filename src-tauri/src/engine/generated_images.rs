//! Projection of structured image outputs only. Never infer attachments from
//! tool prose, and never write or delete the engine's original image files.
use base64::Engine as _;
use serde_json::{json, Value};
use std::path::Path;

const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMAGES: usize = 16;
const MAX_TOTAL_BYTES: usize = 32 * 1024 * 1024;

fn mime_supported(mime: &str) -> bool {
    matches!(mime, "image/png" | "image/jpeg" | "image/gif" | "image/webp")
}

// Validate without allocating a decoded image, including in history scans.
fn base64_size(data: &str) -> Option<usize> {
    let bytes = data.as_bytes();
    if bytes.is_empty() || bytes.len() % 4 != 0 || bytes.len() > (MAX_IMAGE_BYTES + 2) / 3 * 4 {
        return None;
    }
    let padding = bytes.iter().rev().take_while(|&&b| b == b'=').count();
    if padding > 2 || !bytes[..bytes.len() - padding].iter()
        .all(|b| b.is_ascii_alphanumeric() || *b == b'+' || *b == b'/') {
        return None;
    }
    // The decoder also checks the unused bits of the final base64 quartet.
    base64::engine::general_purpose::STANDARD.decode(&bytes[bytes.len() - 4..]).ok()?;
    let size = bytes.len() / 4 * 3 - padding;
    (size > 0 && size <= MAX_IMAGE_BYTES).then_some(size)
}

fn data_ref(raw: &str, collect: bool) -> Option<(String, usize)> {
    let (mime, data) = raw.strip_prefix("data:")?.split_once(";base64,")?;
    if !mime_supported(mime) { return None; }
    let size = base64_size(data)?;
    Some((if collect { raw.to_string() } else { String::new() }, size))
}

fn path_ref(raw: &str) -> Option<&str> {
    let local = raw.strip_prefix("file://").unwrap_or(raw);
    let local = if raw.starts_with("file://") && local.starts_with('/')
        && local.as_bytes().get(2) == Some(&b':') { &local[1..] } else { local };
    // A file URI must name a local absolute path, never a host/share. Plain
    // workspace-relative image paths are resolved by the existing renderer.
    let drive = local.as_bytes().get(1) == Some(&b':')
        && local.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
        && matches!(local.as_bytes().get(2), Some(b'/' | b'\\'));
    if local.is_empty() || local.len() > 8192 || local.chars().any(char::is_control)
        || local.starts_with("//") || local.starts_with("\\\\")
        || local.starts_with('\\') || (local.contains(':') && !drive)
        || (raw.starts_with("file://") && !local.starts_with('/') && !drive) {
        return None;
    }
    Path::new(local).extension().and_then(|v| v.to_str())
        .filter(|ext| matches!(ext.to_ascii_lowercase().as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp"))
        .map(|_| local)
}

fn url_ref(raw: &str, collect: bool) -> Option<(String, usize)> {
    if raw.starts_with("data:") { return data_ref(raw, collect); }
    let path = path_ref(raw)?;
    Some((if collect { path.to_string() } else { String::new() }, 0))
}

fn image_block(value: &Value, collect: bool) -> Option<(String, usize)> {
    match value.get("type").and_then(Value::as_str)? {
        // MCP ContentBlock; verified in native rollout item_completed records.
        "image" => {
            let mime = value.get("mimeType")?.as_str()?;
            if !mime_supported(mime) { return None; }
            let data = value.get("data")?.as_str()?;
            let size = base64_size(data)?;
            Some((if collect { format!("data:{mime};base64,{data}") } else { String::new() }, size))
        }
        // Raw response items and app-server DynamicToolCallOutputContentItem.
        "input_image" => url_ref(value.get("image_url")?.as_str()?, collect),
        "inputImage" => url_ref(value.get("imageUrl")?.as_str()?, collect),
        _ => None,
    }
}

fn is_image_block(value: &Value) -> bool {
    matches!(value.get("type").and_then(Value::as_str), Some("image" | "input_image" | "inputImage"))
}

pub(crate) fn contains_images(value: &Value) -> bool {
    is_image_block(value) || match value {
        Value::Array(parts) => parts.iter().any(contains_images),
        Value::Object(_) => ["content", "contentItems", "output", "result"].iter()
            .any(|key| value.get(key).is_some_and(contains_images)),
        _ => false,
    }
}

/// Merge repeated representations of one call without multiplying its output
/// budget. The caller retains a diagnostic if a later copy adds too much.
pub(crate) fn append_images(target: &mut Vec<String>, incoming: Vec<String>) -> bool {
    let mut total: usize = target.iter().filter_map(|image| url_ref(image, false).map(|v| v.1)).sum();
    let mut omitted = false;
    for image in incoming {
        if target.contains(&image) { continue; }
        let size = url_ref(&image, false).map(|v| v.1).unwrap_or(0);
        if target.len() >= MAX_IMAGES || total + size > MAX_TOTAL_BYTES { omitted = true; continue; }
        total += size;
        target.push(image);
    }
    omitted
}

/// `collect=false` retains one empty marker per image for scanner row counts,
/// without constructing data URLs or decoding/copying multi-MB image payloads.
pub(crate) fn output_images(value: &Value, collect: bool) -> Vec<String> {
    fn walk(value: &Value, collect: bool, depth: usize, out: &mut Vec<String>, bytes: &mut usize) {
        if depth > 8 || out.len() >= MAX_IMAGES { return; }
        if is_image_block(value) {
            if let Some((image, size)) = image_block(value, collect) {
                if *bytes + size <= MAX_TOTAL_BYTES {
                    *bytes += size;
                    out.push(image);
                }
            }
        } else if let Some(parts) = value.as_array() {
            for part in parts { walk(part, collect, depth + 1, out, bytes); }
        } else {
            // Deliberately do not walk arbitrary objects or parse text as JSON.
            for key in ["content", "contentItems", "output", "result"] {
                if let Some(child) = value.get(key) { walk(child, collect, depth + 1, out, bytes); }
            }
        }
    }
    let mut out = Vec::new();
    walk(value, collect, 0, &mut out, &mut 0);
    out
}

/// Display copy only: even rejected/oversized image blocks must not expand into
/// megabytes of base64 in the tool details. Preserve all non-image tool text.
pub(crate) fn display_result(value: &Value) -> Value {
    fn walk(value: &Value, depth: usize, count: &mut usize, total: &mut usize) -> Value {
        if is_image_block(value) {
            let reason = if depth > 8 { "Image omitted: output nesting exceeds 8 levels" } else { match image_block(value, false) {
                Some((_, _)) if *count >= MAX_IMAGES => "Image omitted: output exceeds 16 images",
                Some((_, bytes)) if *total + bytes > MAX_TOTAL_BYTES => "Image omitted: output exceeds 32 MiB",
                Some((_, bytes)) => {
                    *count += 1;
                    *total += bytes;
                    "Image payload omitted from tool details; displayed separately on successful completion"
                }
                None => "Image omitted: invalid or unsupported image, or image exceeds 8 MiB",
            }};
            return json!({"type":"image", "dataOmitted":true, "reason":reason});
        }
        match value {
            Value::Array(parts) => Value::Array(parts.iter().map(|part| walk(part, depth + 1, count, total)).collect()),
            Value::Object(fields) => Value::Object(fields.iter().map(|(key, value)| {
                let value = if matches!(key.as_str(), "content" | "contentItems" | "output" | "result") {
                    walk(value, depth + 1, count, total)
                } else { value.clone() };
                (key.clone(), value)
            }).collect()),
            _ => value.clone(),
        }
    }
    walk(value, 0, &mut 0, &mut 0)
}

pub(crate) fn failed(value: &Value) -> bool {
    value.get("success").and_then(Value::as_bool) == Some(false)
        || value.get("isError").and_then(Value::as_bool) == Some(true)
        || value.get("failure").is_some_and(|v| !v.is_null())
        || value.get("error").is_some_and(|v| !v.is_null())
        || matches!(value.get("status").and_then(Value::as_str), Some("failed" | "error" | "cancelled" | "canceled" | "inProgress" | "in_progress"))
        || value.get("result").is_some_and(|v| v.get("isError").and_then(Value::as_bool) == Some(true))
}

/// Native imageGeneration prefers its engine-managed savedPath. Raw rollout
/// image_generation_call carries only base64 result; sniff its raster header.
pub(crate) fn native_images(item: &Value, collect: bool) -> Vec<String> {
    if failed(item) { return Vec::new(); }
    if let Some(path) = item.get("savedPath").and_then(Value::as_str).and_then(path_ref) {
        return vec![if collect { path.to_string() } else { String::new() }];
    }
    native_result_images(item, collect)
}

/// History can outlive the saved file. Prefer a recoverable inline copy when
/// both representations survived in the rollout; realtime still uses the path.
pub(crate) fn native_history_images(item: &Value, collect: bool) -> Vec<String> {
    if failed(item) { return Vec::new(); }
    let embedded = native_result_images(item, collect);
    if !embedded.is_empty() { embedded } else { native_images(item, collect) }
}

fn native_result_images(item: &Value, collect: bool) -> Vec<String> {
    let Some(data) = item.get("result").and_then(Value::as_str) else { return Vec::new(); };
    if data.starts_with("data:") {
        return data_ref(data, collect).map(|(image, _)| vec![image]).unwrap_or_default();
    }
    if base64_size(data).is_none() { return Vec::new(); }
    let prefix = base64::engine::general_purpose::STANDARD.decode(&data.as_bytes()[..data.len().min(16)]).unwrap_or_default();
    let mime = if prefix.starts_with(b"\x89PNG\r\n\x1a\n") { "image/png" }
        else if prefix.starts_with(b"\xff\xd8\xff") { "image/jpeg" }
        else if prefix.starts_with(b"GIF87a") || prefix.starts_with(b"GIF89a") { "image/gif" }
        else if prefix.starts_with(b"RIFF") && prefix.get(8..12) == Some(b"WEBP") { "image/webp" }
        else { return Vec::new(); };
    vec![if collect { format!("data:{mime};base64,{data}") } else { String::new() }]
}

pub(crate) fn native_display_result(item: &Value) -> Value {
    let mut fields = serde_json::Map::new();
    for field in ["status", "savedPath", "failure"] {
        if let Some(value) = item.get(field) { fields.insert(field.to_string(), value.clone()); }
    }
    if !failed(item) && native_images(item, false).is_empty() {
        fields.insert("imageOmitted".into(), json!("No supported local image path or valid raster payload within 8 MiB"));
    }
    Value::Object(fields)
}

#[cfg(test)]
mod tests {
    use super::*;
    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    #[test]
    fn generated_images_structured_formats_and_display_text() {
        let data = format!("data:image/png;base64,{PNG}");
        let value = json!({"result":{"content":[{"type":"text","text":"before"},
            {"type":"image","data":PNG,"mimeType":"image/png"},
            {"type":"input_image","image_url":data}, {"type":"inputImage","imageUrl":data},
            {"type":"text","text":"after"}]}});
        assert_eq!(output_images(&value, true), vec![data; 3]);
        assert_eq!(output_images(&value, false), vec![""; 3]);
        let display = display_result(&value).to_string();
        assert!(display.contains("before") && display.contains("after"));
        assert!(!display.contains(PNG));
        assert!(output_images(&json!({"text":"C:/fake.png", "args":{"type":"input_image","image_url":"https://example.com/image.png"}}), true).is_empty());
    }

    #[test]
    fn generated_images_limits_failure_and_native_fallback() {
        for data in ["", "!!!!", "a===", "AB==", "AA=A"] { assert!(base64_size(data).is_none()); }
        assert!(base64_size(&"A".repeat((MAX_IMAGE_BYTES + 3) / 3 * 4)).is_none());
        let value = json!({"type":"image_generation_call","status":"completed","result":PNG});
        assert_eq!(native_images(&value, true), vec![format!("data:image/png;base64,{PNG}")]);
        assert_eq!(native_images(&value, false), vec![""]);
        assert!(native_images(&json!({"status":"failed","result":PNG}), true).is_empty());
        assert!(native_images(&json!({"status":"completed","failure":{"type":"usageLimitExceeded"},"result":PNG}), true).is_empty());
        let parts = vec![json!({"type":"image","data":PNG,"mimeType":"image/png"}); 20];
        assert_eq!(output_images(&json!(parts), true).len(), MAX_IMAGES);
        assert!(display_result(&json!(parts))[16]["reason"].as_str().unwrap().contains("16 images"));
        assert!(display_result(&json!({"type":"image","data":"bad","mimeType":"image/png"}))["reason"].as_str().unwrap().contains("invalid"));
        assert!(output_images(&json!({"type":"input_image","image_url":"javascript:alert(1)"}), true).is_empty());
    }

    #[test]
    fn generated_images_local_references_are_normalized_and_remote_paths_rejected() {
        for (raw, expected) in [("output/image.png", "output/image.png"), ("C:/images/pic.png", "C:/images/pic.png"),
            ("file://C:/images/pic.png", "C:/images/pic.png"), ("file:///C:/images/pic.png", "C:/images/pic.png"),
            ("file:///tmp/image.png", "/tmp/image.png")] {
            assert_eq!(url_ref(raw, true).map(|v| v.0).as_deref(), Some(expected));
            assert_eq!(native_images(&json!({"status":"completed","savedPath":raw}), true), [expected]);
        }
        for raw in ["https://host/image.png", "file://host/image.png", "//host/image.png", "\\\\host\\image.png", "javascript:image.png", "file://relative.png"] {
            assert!(url_ref(raw, true).is_none(), "{raw}");
            assert!(native_images(&json!({"status":"completed","savedPath":raw}), true).is_empty());
        }
    }

    #[test]
    fn generated_images_aggregate_limit_is_visible_without_decoding_payloads() {
        let data = "A".repeat(MAX_IMAGE_BYTES / 3 * 4);
        let parts = vec![json!({"type":"image","mimeType":"image/png","data":data}); 5];
        let value = json!(parts);
        assert_eq!(output_images(&value, false).len(), 4);
        assert!(display_result(&value)[4]["reason"].as_str().unwrap().contains("32 MiB"));
    }

    #[test]
    fn generated_images_deep_tool_text_is_unchanged_while_image_payload_is_omitted() {
        let mut ordinary = json!({"type":"text","text":"retain every ordinary field","other":{"data":[1,2,3]}});
        let mut mixed = json!({"content":[{"type":"text","text":"retain deep mixed text"},
            {"type":"image","mimeType":"image/png","data":PNG}]});
        for _ in 0..12 {
            ordinary = json!({"content":[ordinary]});
            mixed = json!({"content":[mixed]});
        }
        assert_eq!(display_result(&ordinary), ordinary);
        let display = display_result(&mixed).to_string();
        assert!(display.contains("retain deep mixed text"));
        assert!(display.contains("nesting exceeds 8 levels"));
        assert!(!display.contains(PNG));
        assert!(output_images(&mixed, true).is_empty());
    }
}
