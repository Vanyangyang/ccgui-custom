//! Text projection for handoff only. Never mutate history or infer image contents.

use crate::history::Message;
use serde_json::Value;
use std::{borrow::Cow, sync::LazyLock};

const IMAGE_OMITTED: &str = "[image payload omitted from handoff]";

fn visible_text(text: &str) -> Cow<'_, str> {
    // Handle data URLs embedded in prose, Markdown and string-valued tool output.
    // Do not guess whether arbitrary long strings are base64: they may be text.
    static IMAGE_DATA_URL: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(
        r"(?i)data:image/[a-z0-9.+-]+(?:;[a-z0-9._+-]+=[a-z0-9._+-]+)*;base64,[a-z0-9+/_=-]+"
    ).expect("valid image data URL pattern"));
    IMAGE_DATA_URL.replace_all(text, IMAGE_OMITTED)
}

fn image_object(fields: &serde_json::Map<String, Value>) -> bool {
    fields.get("type").and_then(Value::as_str).is_some_and(|kind| {
        matches!(kind, "image" | "input_image" | "inputImage" | "image_url" | "image_generation_call" | "imageGeneration")
            || kind.starts_with("image/")
    }) || ["mimeType", "mime_type", "media_type"].iter().any(|key| {
        fields.get(*key).and_then(Value::as_str).is_some_and(|mime| mime.starts_with("image/"))
    })
}

fn visible_value(value: &Value, image: bool) -> Value {
    match value {
        Value::String(text) => Value::String(visible_text(text).into_owned()),
        Value::Array(values) => Value::Array(values.iter().map(|value| visible_value(value, image)).collect()),
        Value::Object(fields) => {
            let image = image || image_object(fields);
            let native_image = matches!(fields.get("type").and_then(Value::as_str), Some("image_generation_call" | "imageGeneration"));
            Value::Object(fields.iter().map(|(key, value)| {
                let payload = value.is_string() && ((image && matches!(key.as_str(),
                    "data" | "base64" | "b64_json" | "image_base64" | "imageBase64" | "bytesBase64Encoded"))
                    || (native_image && key == "result"));
                let projected = if payload { Value::String(IMAGE_OMITTED.into()) }
                    else { visible_value(value, image && matches!(key.as_str(), "source" | "image")) };
                (key.clone(), projected)
            }).collect())
        }
        _ => value.clone(),
    }
}

pub(super) fn visible_row(message: &Message) -> Option<String> {
    if !matches!(message.role.as_str(), "user" | "assistant" | "tool") { return None; }
    let text = visible_text(&message.text);
    // Retain captions, paths, MIME types and surrounding tool details. Only
    // recognized image encodings are omitted, before byte accounting/chunking.
    Some(serde_json::json!({
        "seq": message.seq, "role": message.role, "text": text,
        "toolName": if message.role == "tool" { Some(&text) } else { None },
        "path": message.path,
        "args": message.args.as_ref().map(|value| visible_value(value, false)),
        "result": message.result.as_ref().map(|value| visible_value(value, false)),
        "images": message.images.iter().map(|image| visible_text(image)).collect::<Vec<_>>(),
    }).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn nested_image_formats_keep_metadata_and_adjacent_text() {
        let original = json!({
            "arbitraryWrapper": {"details": [
                {"type": "text", "text": "E_VALIDATION_PENDING 中文😀"},
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "CLAUDE_BINARY"}, "caption": "background candidate"},
                {"type": "image", "mimeType": "image/jpeg", "data": "MCP_BINARY", "path": "G:\\images\\candidate.jpg"},
                {"type": "input_image", "image_url": "data:image/png;base64,AAAA"},
                {"type": "inputImage", "imageUrl": "data:image/webp;base64,BBBB"},
                {"file": {"type": "image/jpeg", "base64": "FILE_BINARY", "name": "preview.jpg"}},
                {"type": "imageGeneration", "result": "NATIVE_BINARY", "savedPath": "G:\\images\\native.png"}
            ]},
            "data": "ordinary application data", "base64": "ordinary field outside an image",
            "longText": "a".repeat(100_000)
        });
        let projected = visible_value(&original, false);
        let result = projected.to_string();
        for payload in ["CLAUDE_BINARY", "MCP_BINARY", "FILE_BINARY", "NATIVE_BINARY", "data:image/"] {
            assert!(!result.contains(payload), "encoded image leaked: {payload}");
        }
        assert_eq!(projected["arbitraryWrapper"]["details"][0], original["arbitraryWrapper"]["details"][0]);
        assert_eq!(projected["arbitraryWrapper"]["details"][1]["caption"], "background candidate");
        assert_eq!(projected["arbitraryWrapper"]["details"][1]["source"]["media_type"], "image/png");
        assert_eq!(projected["arbitraryWrapper"]["details"][2]["path"], original["arbitraryWrapper"]["details"][2]["path"]);
        assert_eq!(projected["arbitraryWrapper"]["details"][5]["file"]["name"], "preview.jpg");
        assert_eq!(projected["arbitraryWrapper"]["details"][6]["savedPath"], original["arbitraryWrapper"]["details"][6]["savedPath"]);
        for key in ["data", "base64", "longText"] { assert_eq!(projected[key], original[key]); }
        assert_eq!(original["arbitraryWrapper"]["details"][1]["source"]["data"], "CLAUDE_BINARY");
    }

    #[test]
    fn embedded_image_data_urls_preserve_prose_markdown_and_remote_references() {
        let text = "中文😀 ![candidate](data:image/png;base64,QUJDRA==)\nlatest correction: use `G:\\images\\background.png`.\nDATA:image/jpeg;charset=utf-8;base64,YWJj, done.\nhttps://example.test/image.png data:text/plain;base64,YWJj";
        let expected = format!("中文😀 ![candidate]({IMAGE_OMITTED})\nlatest correction: use `G:\\images\\background.png`.\n{IMAGE_OMITTED}, done.\nhttps://example.test/image.png data:text/plain;base64,YWJj");
        assert_eq!(visible_text(text), expected);
        assert_eq!(visible_text(&expected), expected);
        let ordinary = "keep intact: code, paths, emoji 中文😀 and base64 QUJDRA==";
        assert!(matches!(visible_text(ordinary), Cow::Borrowed(_)));
    }
}
