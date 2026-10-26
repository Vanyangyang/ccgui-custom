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
pub(crate) struct Selection { engine: String, model: String, effort: String, provider_id: String }

fn require_conversations(plugin_id: &str) -> Result<(), String> {
    let (enabled, permissions) = crate::plugins::plugin_enabled_permissions(plugin_id)?;
    if !enabled || !permissions.iter().any(|p| p == "host:chat") {
        return Err("An enabled plugin with host:chat is required".into());
    }
    Ok(())
}

fn validate_selection(selection: &Selection) -> Result<(), String> {
    if !matches!(selection.engine.as_str(), "claude" | "codex") ||
        [&selection.model, &selection.effort, &selection.provider_id].iter().any(|value| value.trim().is_empty() || value.len() > 256 || value.chars().any(char::is_control)) ||
        !matches!(selection.effort.as_str(), "low" | "medium" | "high" | "xhigh" | "max" | "ultra") {
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
    if selection.engine == "claude" && selection.effort == "ultra" { selection.effort = "max".into(); }
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
    fn selection_requires_explicit_supported_values() {
        let valid = Selection { engine: "claude".into(), model: "explicit-model".into(), effort: "high".into(), provider_id: "channel".into() };
        assert!(validate_selection(&valid).is_ok());
        assert!(validate_selection(&Selection { engine: "agy".into(), ..valid.clone() }).is_err());
        assert!(validate_selection(&Selection { model: "".into(), ..valid.clone() }).is_err());
        assert!(validate_selection(&Selection { effort: "default".into(), ..valid }).is_err());
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
