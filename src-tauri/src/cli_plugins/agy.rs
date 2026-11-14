//! Antigravity CLI plugin inventory. Gemini extensions are a different source.

use serde_json::Value;
use std::path::{Path, PathBuf};

pub(super) struct AgyPlugin {
    pub name: String,
    pub version: Option<String>,
    pub enabled: bool,
    pub path: Option<String>,
    pub mcp_servers: Vec<(String, Value)>,
    pub mcp_error: Option<String>,
}

/// Read only the plugin-owned MCP configuration; do not follow a symlink out
/// of the plugin root or expand any values supplied by the plugin.
fn read_mcp(root: &Path) -> Result<Vec<(String, Value)>, String> {
    if !root.is_dir() {
        return Err("plugin directory is missing or inaccessible".into());
    }
    let candidate = root.join("mcp_config.json");
    match std::fs::symlink_metadata(&candidate) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("cannot inspect plugin MCP configuration".into()),
    }
    let root = std::fs::canonicalize(root).map_err(|_| "cannot resolve plugin directory")?;
    let file =
        std::fs::canonicalize(&candidate).map_err(|_| "cannot resolve plugin MCP configuration")?;
    if !file.starts_with(&root) {
        return Err("plugin MCP configuration escapes plugin directory".into());
    }
    let metadata =
        std::fs::metadata(&file).map_err(|_| "cannot inspect plugin MCP configuration")?;
    if metadata.len() > 1024 * 1024 {
        return Err("plugin MCP configuration exceeds the size limit".into());
    }
    let raw = std::fs::read(&file).map_err(|_| "cannot read plugin MCP configuration")?;
    let config: Value =
        serde_json::from_slice(&raw).map_err(|_| "invalid plugin MCP configuration")?;
    let servers = config
        .get("mcpServers")
        .and_then(Value::as_object)
        .ok_or("plugin MCP configuration has no mcpServers object")?;
    Ok(servers
        .iter()
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect())
}

pub(super) fn parse_list(raw: &str) -> Result<Vec<AgyPlugin>, String> {
    let root: Value = serde_json::from_str(raw).map_err(|_| "invalid Antigravity plugin list")?;
    let list = root.as_array().ok_or("invalid Antigravity plugin list")?;
    list.iter()
        .map(|item| {
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .ok_or("plugin list item has no name")?;
            let enabled = item
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or("plugin list item has no enabled state")?;
            let path = item.get("path").and_then(Value::as_str).map(str::to_owned);
            let result = match path.as_deref() {
                Some(path) if PathBuf::from(path).is_absolute() => read_mcp(Path::new(path)),
                Some(_) => Err("plugin path is not absolute".into()),
                None => Err("plugin installation path is not reported".into()),
            };
            let (mcp_servers, mcp_error) = match result {
                Ok(servers) => (servers, None),
                Err(error) => (Vec::new(), Some(error)),
            };
            Ok(AgyPlugin {
                name: name.to_owned(),
                version: item
                    .get("version")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                enabled,
                path,
                mcp_servers,
                mcp_error,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> PathBuf {
        let root = std::env::temp_dir().join(format!("ccgui-agy-plugins-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        root
    }

    fn cleanup(root: &Path) {
        std::fs::remove_file(root.join("mcp_config.json")).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn parses_plugins_and_their_declared_mcp_without_executing_them() {
        let root = fixture();
        std::fs::write(root.join("mcp_config.json"), r#"{"mcpServers":{"example":{"serverUrl":"https://example.test","headers":{"Authorization":"secret"}}}}"#).unwrap();
        let input = serde_json::json!([{"name":"sample","version":"1","enabled":true,"path":root}]);
        let result = parse_list(&input.to_string()).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "sample");
        assert_eq!(result[0].mcp_servers[0].0, "example");
        assert!(result[0].mcp_error.is_none());
        cleanup(&root);
    }

    #[test]
    fn reports_bad_configuration_and_does_not_guess_enabled() {
        let root = fixture();
        std::fs::write(root.join("mcp_config.json"), "not json").unwrap();
        let input = serde_json::json!([{"name":"sample","enabled":false,"path":root}]);
        let result = parse_list(&input.to_string()).unwrap();
        assert!(result[0].mcp_error.is_some());
        assert!(parse_list(r#"[{"name":"sample"}]"#).is_err());
        cleanup(&root);
    }
}
