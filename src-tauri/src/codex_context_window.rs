//! Narrow native context settings. Never reads or returns Codex auth material.
use std::path::{Path, PathBuf};
use toml_edit::{value, DocumentMut, Item};

const WINDOW: &str = "model_context_window";
const COMPACT: &str = "model_auto_compact_token_limit";

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexContextWindowSettings {
    pub context_window: Option<u64>,
    pub auto_compact_token_limit: Option<u64>,
    pub block: Option<String>,
}

fn read_optional(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("unavailable".into()),
    }
}

fn parse(text: &str) -> Result<DocumentMut, String> {
    text.parse().map_err(|_| "unavailable".into())
}

fn has_overrides(doc: &DocumentMut) -> bool {
    doc.contains_key(WINDOW) || doc.contains_key(COMPACT)
}

fn number(doc: &DocumentMut, key: &str) -> Result<Option<u64>, String> {
    doc.get(key)
        .map(|item| {
            item.as_integer()
                .and_then(|v| u64::try_from(v).ok())
                .filter(|v| *v > 0)
                .ok_or_else(|| "unavailable".to_string())
        })
        .transpose()
}

fn settings(
    doc: &DocumentMut,
    block: Option<String>,
) -> Result<CodexContextWindowSettings, String> {
    Ok(CodexContextWindowSettings {
        context_window: number(doc, WINDOW)?,
        auto_compact_token_limit: number(doc, COMPACT)?,
        block,
    })
}

// Resolve the channel without resolve_provider: that helper performs legacy
// migration, which may touch auth.json and is outside this command's scope.
fn channel_config(provider_id: Option<&str>) -> Result<Option<String>, String> {
    let config = crate::config::read_config().map_err(|_| "unavailable")?;
    let section = config.section("codex").ok_or("unavailable")?;
    let explicit = provider_id.map(str::trim).filter(|s| !s.is_empty());
    let id = explicit.unwrap_or_else(|| section.current.as_deref().unwrap_or("").trim());
    if id == crate::config::DISABLED_PROVIDER_ID {
        return Err("unavailable".into());
    }
    if id.is_empty()
        || id == crate::config::LOCAL_PROVIDER_ID
        || id == crate::config::LEGACY_LOCAL_CONFIG_TOML_ID
    {
        return Ok(None);
    }
    let provider = crate::config::find_provider(section, id).map_err(|_| "unavailable")?;
    let Some((_, provider)) = provider else {
        return if explicit.is_some() {
            Err("unavailable".into())
        } else {
            Ok(None)
        };
    };
    match provider.pointer("/settingsConfig/config") {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(text)) => Ok(Some(text.clone())),
        _ => Err("unavailable".into()),
    }
}

fn workspace(path: Option<&str>, home: &Path) -> Result<PathBuf, String> {
    let Some(path) = path else {
        return Ok(home.to_path_buf());
    };
    let lower = path.to_lowercase();
    if lower.starts_with("wsl:") || lower.starts_with("ssh:") || lower.starts_with("\\\\wsl") {
        return Err("unsupported_scope".into());
    }
    let path = Path::new(path);
    if !path.is_absolute() || !path.is_dir() {
        return Err("unsupported_scope".into());
    }
    path.canonicalize().map_err(|_| "unsupported_scope".into())
}

fn override_block(
    home: &Path,
    workspace: &Path,
    doc: &DocumentMut,
    channel: Option<&str>,
    scan_projects: bool,
) -> Result<Option<String>, String> {
    if let Some(channel) = channel {
        if has_overrides(&parse(channel)?) {
            return Ok(Some("channel_override".into()));
        }
    }
    if let Some(profile) = doc.get("profile") {
        let name = profile
            .as_str()
            .filter(|name| !name.is_empty())
            .ok_or("unavailable")?;
        // Profile names are names, never arbitrary paths supplied to this reader.
        if name.contains(['/', '\\']) || name == "." || name == ".." {
            return Err("unavailable".into());
        }
        if let Some(table) = doc
            .get("profiles")
            .and_then(Item::as_table_like)
            .and_then(|profiles| profiles.get(name))
        {
            let table = table.as_table_like().ok_or("unavailable")?;
            if table.contains_key(WINDOW) || table.contains_key(COMPACT) {
                return Ok(Some("profile_override".into()));
            }
        }
        if let Some(text) = read_optional(&home.join(format!("{name}.config.toml")))? {
            if has_overrides(&parse(&text)?) {
                return Ok(Some("profile_override".into()));
            }
        }
    }
    // Without a workspace the command edits only global defaults, not a
    // synthetic project rooted in CODEX_HOME or its parent directories.
    if !scan_projects {
        return Ok(None);
    }
    let global = home.join("config.toml");
    for ancestor in workspace.ancestors() {
        let path = ancestor.join(".codex/config.toml");
        if path == global
            || (path.canonicalize().ok().is_some()
                && path.canonicalize().ok() == global.canonicalize().ok())
        {
            continue;
        }
        if let Some(text) = read_optional(&path)? {
            if has_overrides(&parse(&text)?) {
                return Ok(Some("project_override".into()));
            }
        }
    }
    Ok(None)
}

fn inspect(
    home: &Path,
    workspace_path: Option<&str>,
    channel: Option<&str>,
) -> Result<CodexContextWindowSettings, String> {
    let doc = parse(
        read_optional(&home.join("config.toml"))?
            .as_deref()
            .unwrap_or(""),
    )?;
    let block = match workspace(workspace_path, home) {
        Ok(workspace) => override_block(home, &workspace, &doc, channel, workspace_path.is_some())?,
        Err(block) => Some(block),
    };
    settings(&doc, block)
}

fn validate(window: Option<u64>, compact: Option<u64>) -> Result<(), String> {
    if [window, compact]
        .into_iter()
        .flatten()
        .any(|v| !(100_000..=1_000_000).contains(&v))
    {
        return Err("invalid_range".into());
    }
    if matches!((window, compact), (Some(w), Some(c)) if c > w) {
        return Err("invalid_threshold".into());
    }
    Ok(())
}

fn patch(doc: &mut DocumentMut, key: &str, number: Option<u64>) {
    match number {
        None => {
            // Preserve comments even when their associated setting is removed.
            // Keep them as standalone trailing comments rather than attaching
            // them to an unrelated setting or table.
            let prefix = doc
                .as_table()
                .key(key)
                .and_then(|key| key.leaf_decor().prefix())
                .and_then(|text| text.as_str())
                .unwrap_or("")
                .to_owned();
            let suffix = doc
                .get(key)
                .and_then(Item::as_value)
                .and_then(|value| value.decor().suffix())
                .and_then(|text| text.as_str())
                .unwrap_or("")
                .to_owned();
            doc.remove(key);
            let comments: String = [prefix, suffix]
                .into_iter()
                .filter(|text| text.contains('#'))
                .map(|text| format!("{}\n", text.trim_end()))
                .collect();
            if !comments.is_empty() {
                doc.set_trailing(format!(
                    "{}{}",
                    doc.trailing().as_str().unwrap_or(""),
                    comments
                ));
            }
        }
        Some(number) => {
            let decor = doc
                .get(key)
                .and_then(Item::as_value)
                .map(|value| value.decor().clone());
            let mut replacement = value(number as i64);
            if let (Some(decor), Some(value)) = (decor, replacement.as_value_mut()) {
                *value.decor_mut() = decor;
            }
            doc[key] = replacement;
        }
    }
}

fn write_inner(
    home: &Path,
    workspace_path: Option<&str>,
    channel: Option<&str>,
    window: Option<u64>,
    compact: Option<u64>,
    before_commit: impl FnOnce(),
) -> Result<CodexContextWindowSettings, String> {
    validate(window, compact)?;
    let workspace = workspace(workspace_path, home)?;
    let path = home.join("config.toml");
    let original = read_optional(&path)?;
    let mut doc = parse(original.as_deref().unwrap_or(""))?;
    if let Some(block) = override_block(home, &workspace, &doc, channel, workspace_path.is_some())?
    {
        return Err(block);
    }
    patch(&mut doc, WINDOW, window);
    patch(&mut doc, COMPACT, compact);
    before_commit();
    // Recheck the complete content immediately before replacement; native
    // writers share ConfigStore, external editors do not.
    if read_optional(&path)? != original {
        return Err("config_changed".into());
    }
    if let Some(block) = override_block(home, &workspace, &doc, channel, workspace_path.is_some())?
    {
        return Err(block);
    }
    std::fs::create_dir_all(home).map_err(|_| "unavailable")?;
    crate::settings::atomic_write(&path, &doc.to_string()).map_err(|_| "unavailable")?;
    inspect(home, workspace_path, channel)
}

#[tauri::command]
pub fn codex_context_window_read(
    provider_id: Option<String>,
    workspace_path: Option<String>,
) -> Result<CodexContextWindowSettings, String> {
    let result = channel_config(provider_id.as_deref()).and_then(|channel| {
        inspect(
            &crate::engine::codex_home(),
            workspace_path.as_deref(),
            channel.as_deref(),
        )
    });
    Ok(result.unwrap_or_else(|_| CodexContextWindowSettings {
        block: Some("unavailable".into()),
        ..Default::default()
    }))
}

#[tauri::command]
pub fn codex_context_window_write(
    store: tauri::State<'_, crate::config::ConfigStore>,
    provider_id: Option<String>,
    workspace_path: Option<String>,
    context_window: serde_json::Value,
    auto_compact_token_limit: serde_json::Value,
) -> Result<CodexContextWindowSettings, String> {
    let _guard = store.0.lock().map_err(|_| "unavailable")?;
    let context_window = nullable_tokens(context_window)?;
    let auto_compact_token_limit = nullable_tokens(auto_compact_token_limit)?;
    let channel = channel_config(provider_id.as_deref())?;
    write_inner(
        &crate::engine::codex_home(),
        workspace_path.as_deref(),
        channel.as_deref(),
        context_window,
        auto_compact_token_limit,
        || {},
    )
}

fn nullable_tokens(value: serde_json::Value) -> Result<Option<u64>, String> {
    if value.is_null() {
        Ok(None)
    } else {
        value
            .as_u64()
            .map(Some)
            .ok_or_else(|| "invalid_range".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codex_context_window_only_accepts_explicit_null_or_integer_tokens() {
        assert_eq!(nullable_tokens(serde_json::json!(null)).unwrap(), None);
        assert_eq!(
            nullable_tokens(serde_json::json!(500000)).unwrap(),
            Some(500000)
        );
        for value in [
            serde_json::json!(-1),
            serde_json::json!(500000.5),
            serde_json::json!("500000"),
            serde_json::json!({}),
        ] {
            assert_eq!(nullable_tokens(value).unwrap_err(), "invalid_range");
        }
    }
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "ccgui-context-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn seed(&self, text: &str) {
            std::fs::write(self.0.join("config.toml"), text).unwrap();
        }
        fn text(&self) -> String {
            std::fs::read_to_string(self.0.join("config.toml")).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn codex_context_window_preserves_comments_and_unrelated_content() {
        let f = Fixture::new();
        f.seed("# header\nmodel_context_window = 200000 # keep inline\nmodel = 'test'\n[mcp_servers.test]\ncommand = 'fixture'\n");
        // A directory at auth.json makes any attempted read/write fail.
        std::fs::create_dir(f.0.join("auth.json")).unwrap();
        let state = write_inner(&f.0, None, None, Some(500000), Some(400000), || {}).unwrap();
        assert_eq!(state.context_window, Some(500000));
        let text = f.text();
        for expected in [
            "# header",
            "# keep inline",
            "model = 'test'",
            "[mcp_servers.test]",
            "command = 'fixture'",
        ] {
            assert!(text.contains(expected), "{expected}");
        }
        write_inner(&f.0, None, None, None, None, || {}).unwrap();
        assert!(f.text().contains("# header"));
        let doc = parse(&f.text()).unwrap();
        assert!(!doc.contains_key(WINDOW));
        assert!(!doc.contains_key(COMPACT));
        assert!(f.0.join("auth.json").is_dir());
    }

    #[test]
    fn codex_context_window_rejects_invalid_values_and_changed_files() {
        for pair in [
            (Some(99999), None),
            (None, Some(1000001)),
            (Some(100000), Some(200000)),
        ] {
            assert!(validate(pair.0, pair.1).is_err());
        }
        assert!(validate(Some(100000), Some(100000)).is_ok());
        assert!(validate(Some(1000000), None).is_ok());
        let f = Fixture::new();
        f.seed("model = 'original'\n");
        let result = write_inner(&f.0, None, None, Some(500000), None, || {
            f.seed("model = 'external'\n")
        });
        assert_eq!(result.unwrap_err(), "config_changed");
        assert!(f.text().contains("external"));
        f.seed("[invalid");
        assert!(write_inner(&f.0, None, None, None, None, || {}).is_err());
        assert_eq!(f.text(), "[invalid");
    }

    #[test]
    fn codex_context_window_blocks_overrides_without_writing() {
        let f = Fixture::new();
        f.seed("model = 'test'\n");
        assert_eq!(
            write_inner(
                &f.0,
                None,
                Some("model_context_window=300000"),
                None,
                None,
                || {}
            )
            .unwrap_err(),
            "channel_override"
        );
        f.seed("profile='selected'\n[profiles.selected]\nmodel_auto_compact_token_limit=300000\n");
        assert_eq!(
            inspect(&f.0, None, None).unwrap().block.as_deref(),
            Some("profile_override")
        );
        f.seed("profile='selected'\n");
        std::fs::write(
            f.0.join("selected.config.toml"),
            "model_context_window=300000",
        )
        .unwrap();
        assert_eq!(
            inspect(&f.0, None, None).unwrap().block.as_deref(),
            Some("profile_override")
        );
        f.seed("model='test'\n");
        std::fs::create_dir(f.0.join(".codex")).unwrap();
        std::fs::write(
            f.0.join(".codex/config.toml"),
            "model_context_window=300000",
        )
        .unwrap();
        assert_eq!(
            write_inner(&f.0, f.0.to_str(), None, None, None, || {}).unwrap_err(),
            "project_override"
        );
        assert_eq!(f.text(), "model='test'\n");
        assert_eq!(
            inspect(&f.0, Some("ssh:fixture"), None)
                .unwrap()
                .block
                .as_deref(),
            Some("unsupported_scope")
        );
    }
}
