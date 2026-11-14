//! One native owner window per plugin discussion. Detached surfaces dispatch to
//! their owner and cannot claim threads themselves. This is independent of the
//! renderer's JS singleton, which cannot arbitrate two primary windows.
use parking_lot::Mutex;
use std::{collections::HashMap, sync::LazyLock};
use tauri::{AppHandle, Manager, WebviewWindow};
use serde::{Deserialize, Serialize};

type Claims = HashMap<(String, String), String>;
static CLAIMS: LazyLock<Mutex<Claims>> = LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Selection {
    pub(crate) engine: String,
    pub(crate) model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) effort: Option<String>,
    pub(crate) provider_id: String,
}

fn require_conversations(plugin_id: &str) -> Result<(), String> {
    let (enabled, permissions) = crate::plugins::plugin_enabled_permissions(plugin_id)?;
    require_conversations_grant(enabled, &permissions)
}

fn require_conversations_grant(enabled: bool, permissions: &[String]) -> Result<(), String> {
    if !enabled || !permissions.iter().any(|p| p == "host:chat") {
        return Err("An enabled plugin with host:chat is required".into());
    }
    Ok(())
}

fn require_handoff_owner(label: &str) -> Result<(), String> {
    if label != "main" {
        return Err("Only the main desktop plugin owner can summarize handoff".into());
    }
    Ok(())
}

fn prepare_handoff_excerpt(title: Option<&str>, excerpt: &str, children: Option<&str>) -> Result<String, String> {
    if excerpt.trim().is_empty() || excerpt.encode_utf16().count() > 48_000 {
        return Err("Handoff requires non-empty explicit text up to 48000 UTF-16 units".into());
    }
    if title.is_some_and(|value| value.chars().count() > 512) {
        return Err("Handoff title exceeds 512 characters".into());
    }
    if children.is_some_and(|value| value.chars().count() > 6000) {
        return Err("Handoff child context exceeds 6000 characters".into());
    }
    let excerpt = excerpt.trim();
    let budget = crate::app_cache::MAX_EXCERPT_CHARS;
    let length = excerpt.chars().count();
    if length <= budget { return Ok(excerpt.to_owned()); }
    let marker = "[主对话摘录已截断：仅保留最近末尾内容；较早内容需回看原话题。]\n";
    let retained = budget - marker.chars().count();
    Ok(format!("{marker}{}", excerpt.chars().skip(length - retained).collect::<String>()))
}

fn prepare_full_handoff_text(title: Option<&str>, text: &str, children: Option<&str>) -> Result<String, String> {
    if text.trim().is_empty() || text.encode_utf16().count() > 48_000 || text.contains('\0') {
        return Err("Handoff requires non-empty explicit text up to 48000 UTF-16 units".into());
    }
    if title.is_some_and(|value| value.chars().count() > 512) || children.is_some_and(|value| value.chars().count() > 6000) {
        return Err("Handoff metadata exceeds its size limit".into());
    }
    // Full explicit-text mode must preserve the oldest facts as well as the
    // latest corrections. The common compressor splits; this boundary never tails.
    Ok(text.trim().to_owned())
}

/// Explicit text only: plugin identity is a prompt label, never a history key.
#[tauri::command]
pub(crate) async fn plugin_summarize_handoff(
    window: WebviewWindow,
    plugin_id: String,
    title: Option<String>,
    transcript_excerpt: String,
    child_context: Option<String>,
    compression_selection: crate::app_cache::HandoffCompressionSelection,
    full_history: Option<bool>,
    progress: crate::app_cache::OptionalHandoffProgress,
) -> Result<String, String> {
    require_conversations(&plugin_id)?;
    require_handoff_owner(window.label())?;
    if full_history == Some(true) {
        let text = prepare_full_handoff_text(title.as_deref(), &transcript_excerpt, child_context.as_deref())?;
        return Box::pin(crate::app_cache::summarize_full_handoff_text_with_progress("plugin", &plugin_id, title.as_deref(), &text,
            child_context.as_deref(), None, Some(&compression_selection),
            |event| crate::app_cache::send_handoff_progress(progress.as_ref(), event))).await;
    }
    let excerpt = prepare_handoff_excerpt(title.as_deref(), &transcript_excerpt, child_context.as_deref())?;
    Box::pin(crate::app_cache::summarize_handoff_text(
        "plugin", &plugin_id, title.as_deref(), &excerpt, child_context.as_deref(),
        None, Some(&compression_selection),
    )).await
}

pub(crate) fn validate_selection(selection: &Selection) -> Result<(), String> {
    let supported_effort = match selection.engine.as_str() {
        "agy" => selection.effort.is_none(),
        "claude" | "codex" => matches!(selection.effort.as_deref(), Some("low" | "medium" | "high" | "xhigh" | "max" | "ultra")),
        _ => false,
    };
    if !supported_effort ||
        [&selection.model, &selection.provider_id].iter().any(|value| value.trim().is_empty() || value.len() > 256 || value.chars().any(char::is_control)) {
        return Err("An explicit supported discussion selection is required".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn plugin_conversation_resolve(window: WebviewWindow, plugin_id: String, selection: Selection) -> Result<Selection, String> {
    require_conversations(&plugin_id)?;
    if window.label().starts_with("plugin-window-") { return Err("Detached windows cannot resolve conversations".into()); }
    resolve_selection(selection)
}

/** Resolve only launch metadata. The caller must enforce its own capability. */
pub(crate) fn resolve_selection(mut selection: Selection) -> Result<Selection, String> {
    validate_selection(&selection)?;
    selection.model = crate::engine::resolve_discussion_model(&selection.engine, &selection.model, &selection.provider_id)?;
    if selection.engine == "claude" && selection.effort.as_deref() == Some("ultra") { selection.effort = Some("max".into()); }
    Ok(selection)
}

fn claim(claims: &mut Claims, plugin: &str, thread: &str, window: &str, alive: impl Fn(&str) -> bool) -> Result<(), String> {
    if window.starts_with("plugin-window-") || window.is_empty() {
        return Err("Detached windows cannot own conversations".into());
    }
    if thread.is_empty() || thread.len() > 128 || !thread.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.')) {
        return Err("Invalid conversation thread identity".into());
    }
    let key = (plugin.to_owned(), thread.to_owned());
    if let Some(owner) = claims.get(&key) {
        if owner != window && alive(owner) {
            return Err("This conversation is owned by another open window".into());
        }
    }
    claims.insert(key, window.to_owned());
    Ok(())
}

#[tauri::command]
pub(crate) fn plugin_conversation_claim(app: AppHandle, window: WebviewWindow, plugin_id: String, thread_id: String) -> Result<(), String> {
    require_conversations(&plugin_id)?;
    claim(&mut CLAIMS.lock(), &plugin_id, &thread_id, window.label(), |label| app.get_webview_window(label).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn full_handoff_explicit_text_keeps_old_facts_and_latest_corrections() {
        let text = format!("EARLY_REQUIRED_PATH src/critical.rs\n{}\nLATEST_ERROR E_BUSY_42", "中🌏".repeat(8000));
        let retained = prepare_full_handoff_text(None, &text, None).unwrap();
        assert_eq!(retained, text);
        assert!(retained.starts_with("EARLY_REQUIRED_PATH"));
        assert!(retained.ends_with("LATEST_ERROR E_BUSY_42"));
        assert!(prepare_full_handoff_text(None, &"x".repeat(48001), None).is_err());
        assert!(prepare_full_handoff_text(None, "bad\0input", None).is_err());
    }
    #[test]
    fn handoff_requires_enabled_chat_permission_and_main_desktop_owner() {
        assert!(require_conversations_grant(true, &["host:chat".into()]).is_ok());
        assert!(require_conversations_grant(false, &["host:chat".into()]).is_err());
        assert!(require_conversations_grant(true, &["host:tasks".into()]).is_err());
        assert!(require_conversations_grant(true, &[]).is_err());
        assert!(require_handoff_owner("main").is_ok());
        for label in ["", "plugin-window-one", "remote", "secondary"] {
            assert!(require_handoff_owner(label).is_err());
        }
    }

    #[test]
    fn handoff_text_is_explicit_bounded_and_keeps_latest_unicode_tail() {
        for value in ["", " \n\t"] { assert!(prepare_handoff_excerpt(None, value, None).is_err()); }
        assert!(prepare_handoff_excerpt(None, &"x".repeat(48_001), None).is_err());
        assert!(prepare_handoff_excerpt(None, &"🌏".repeat(24_001), None).is_err());
        assert!(prepare_handoff_excerpt(Some(&"题".repeat(513)), "text", None).is_err());
        assert!(prepare_handoff_excerpt(None, "text", Some(&"子".repeat(6001))).is_err());
        assert_eq!(prepare_handoff_excerpt(Some(&"题".repeat(512)), " text🌏 ", Some(&"子".repeat(6000))).unwrap(), "text🌏");
        let text = format!("旧前提{}最新修正🌏", "甲🌏".repeat(8000));
        let excerpt = prepare_handoff_excerpt(None, &text, None).unwrap();
        assert_eq!(excerpt.chars().count(), crate::app_cache::MAX_EXCERPT_CHARS);
        assert!(excerpt.starts_with("[主对话摘录已截断"));
        assert!(excerpt.ends_with("最新修正🌏"));
        assert!(!excerpt.contains("旧前提"));
    }

    #[tokio::test]
    async fn handoff_shared_core_rejects_invalid_route_without_model_or_history_call() {
        let selection = serde_json::from_value(serde_json::json!({"engine":"unsupported", "model":"chosen"})).unwrap();
        let error = crate::app_cache::summarize_handoff_text("plugin", "owned-plugin", None,
            "explicit source", None, None, Some(&selection)).await.unwrap_err();
        assert_eq!(error, "unsupported handoff compression engine");
        let selection = serde_json::from_value(serde_json::json!({"engine":"codex", "model":"chosen"})).unwrap();
        assert_eq!(crate::app_cache::summarize_handoff_text("plugin", "owned-plugin", None,
            "", None, None, Some(&selection)).await.unwrap_err(), "empty session excerpt");
    }

    #[test]
    fn selection_requires_explicit_supported_values() {
        let valid = Selection { engine: "claude".into(), model: "explicit-model".into(), effort: Some("high".into()), provider_id: "channel".into() };
        assert!(validate_selection(&valid).is_ok());
        assert!(validate_selection(&Selection { engine: "agy".into(), ..valid.clone() }).is_err());
        assert!(validate_selection(&Selection { model: "".into(), ..valid.clone() }).is_err());
        assert!(validate_selection(&Selection { effort: Some("default".into()), ..valid }).is_err());
    }
    #[test]
    fn agy_selection_omits_independent_effort_and_requires_safe_explicit_route() {
        let valid: Selection = serde_json::from_value(serde_json::json!({
            "engine": "agy", "model": "gemini-explicit-high", "providerId": "channel"
        })).unwrap();
        assert_eq!(valid.effort, None);
        assert!(validate_selection(&valid).is_ok());
        assert!(serde_json::to_value(&valid).unwrap().get("effort").is_none());
        for effort in ["", "high", "low", "default", "\n"] {
            assert!(validate_selection(&Selection { effort: Some(effort.into()), ..valid.clone() }).is_err());
        }
        for value in ["".to_owned(), " ".to_owned(), "bad\nroute".to_owned(), "x".repeat(257)] {
            assert!(validate_selection(&Selection { model: value.clone(), ..valid.clone() }).is_err());
            assert!(validate_selection(&Selection { provider_id: value, ..valid.clone() }).is_err());
        }
        for field in ["model", "providerId"] {
            let mut value = serde_json::to_value(&valid).unwrap();
            value.as_object_mut().unwrap().remove(field);
            assert!(serde_json::from_value::<Selection>(value).is_err());
        }
    }
    #[test]
    fn other_engines_still_require_supported_effort() {
        for engine in ["claude", "codex"] {
            let mut selection = Selection { engine: engine.into(), model: "explicit-model".into(), effort: None, provider_id: "channel".into() };
            assert!(validate_selection(&selection).is_err());
            for effort in ["low", "medium", "high", "xhigh", "max", "ultra"] {
                selection.effort = Some(effort.into());
                assert!(validate_selection(&selection).is_ok());
            }
            for effort in ["", "auto", "default", "HIGH", "high\n"] {
                selection.effort = Some(effort.into());
                assert!(validate_selection(&selection).is_err());
            }
            selection.engine = "cursor".into();
            selection.effort = Some("high".into());
            assert!(validate_selection(&selection).is_err());
        }
    }
    #[test]
    fn rejects_a_second_live_owner_and_allows_the_same_owner() {
        let mut claims = Claims::new();
        claim(&mut claims, "plugin", "topic", "main", |_| true).unwrap();
        claim(&mut claims, "plugin", "topic", "main", |_| true).unwrap();
        assert!(claim(&mut claims, "plugin", "topic", "second", |_| true).is_err());
        assert_eq!(claims.get(&("plugin".into(), "topic".into())).unwrap(), "main");
        claim(&mut claims, "plugin", "topic", "second", |_| false).unwrap();
    }
    #[test]
    fn detached_windows_and_invalid_ids_never_take_ownership() {
        let mut claims = Claims::new();
        assert!(claim(&mut claims, "plugin", "topic", "plugin-window-a", |_| false).is_err());
        assert!(claim(&mut claims, "plugin", "../topic", "main", |_| false).is_err());
        assert!(claims.is_empty());
    }
}
