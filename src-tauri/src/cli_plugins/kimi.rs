//! Read-only Kimi Code inventory; never invokes a CLI, plugin, hook or MCP.
//!
//! Verified against MoonshotAI/kimi-code commit
//! a2afdbc7d1fa0737d45d5780cc6c2bd38e477b55:
//! packages/agent-core-v2/src/app/plugin/{store,manifest,manager,types}.ts,
//! packages/agent-core-v2/src/mcpCore/config-schema.ts and
//! apps/kimi-code/src/utils/paths.ts. Management uses TUI `/plugins`, not a
//! `kimi plugin` subprocess. No writer: native writeInstalled uses rename but
//! no shared lock/CAS; a hash check followed by rename can lose native updates.

use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

const JSON_LIMIT: u64 = 8 * 1024 * 1024;

// Neither Debug nor Serialize: raw MCP config may contain credentials. Only
// explicitly selected inventory metadata may cross the host/UI boundary.
pub(super) struct KimiPlugin {
    pub id: String,
    pub name: String,
    pub version: Option<String>,
    pub enabled: Option<bool>,
    pub source_path: Option<String>,
    pub mcp_servers: Vec<KimiMcpServer>,
    pub warning: Option<String>,
}

pub(super) struct KimiMcpServer {
    pub name: String,
    /// Declaration, not a launch recipe. `enabled` includes plugin and per-server
    /// capability state. Secrets remain private; never log/serialize this value.
    pub config: Value,
}

pub(super) fn read_plugins_at(home: &Path) -> Result<Vec<KimiPlugin>, String> {
    let Some(value) = read_json(&home.join("plugins/installed.json"))? else {
        return Ok(Vec::new());
    };
    if value.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("Unsupported Kimi installed.json version".into());
    }
    let rows = value
        .get("plugins")
        .and_then(Value::as_array)
        .ok_or("Invalid Kimi installed.json plugins array")?;
    let mut ids = HashSet::new();
    rows.iter()
        .enumerate()
        .map(|(index, row)| {
            let id = row
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| valid_id(id))
                .ok_or_else(|| format!("Invalid Kimi plugin id at row {index}"))?;
            if !ids.insert(id.to_ascii_lowercase()) {
                return Err(format!("Duplicate Kimi plugin id at row {index}"));
            }
            let enabled = row
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or_else(|| format!("Invalid Kimi enabled state at row {index}"))?;
            let root = row
                .get("root")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("Invalid Kimi plugin root at row {index}"))?;
            let mut plugin = KimiPlugin {
                id: id.to_owned(),
                name: id.to_owned(),
                version: None,
                enabled: Some(enabled),
                source_path: None,
                mcp_servers: Vec::new(),
                warning: None,
            };
            // A broken installation remains visible without suppressing healthy ones.
            if let Err(error) = inspect_plugin(&mut plugin, Path::new(root), row) {
                plugin.warning = Some(error);
            }
            Ok(plugin)
        })
        .collect()
}

fn valid_id(id: &str) -> bool {
    let mut parts = id.split('@');
    let base = parts.next().unwrap_or_default();
    let component = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    };
    base.split('.').all(component)
        && parts.next().map(component).unwrap_or(true)
        && parts.next().is_none()
}

fn inspect_plugin(plugin: &mut KimiPlugin, root: &Path, row: &Value) -> Result<(), String> {
    let text = root.to_string_lossy();
    if !root.is_absolute() || text.starts_with("\\\\") || text.starts_with("//") {
        return Err("Kimi plugin root must be an absolute local directory".into());
    }
    let root = fs::canonicalize(root).map_err(|_| "Kimi plugin root is inaccessible")?;
    if !root.is_dir() {
        return Err("Kimi plugin root is not a directory".into());
    }
    let mut manifest = None;
    for relative in ["./kimi.plugin.json", "./.kimi-plugin/plugin.json"] {
        let path = confined_path(&root, relative)?;
        if let Some(value) = read_json(&path)? {
            plugin.source_path = Some(path.to_string_lossy().into_owned());
            manifest = Some(value);
            break;
        }
    }
    let manifest = manifest.ok_or("Kimi plugin manifest is missing")?;
    let name = manifest
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| valid_id(name))
        .ok_or("Invalid Kimi manifest name")?;
    if !name.eq_ignore_ascii_case(&plugin.id) {
        return Err("Kimi manifest id mismatch".into());
    }
    plugin.name =
        string_field(&manifest["interface"], "displayName").unwrap_or_else(|| plugin.id.clone());
    plugin.version = string_field(&manifest, "version");
    // These references are inspected for containment only, never opened or run.
    for field in ["skills", "agents", "commands", "systemPromptPath"] {
        if let Some(value) = manifest.get(field) {
            match value {
                Value::String(value) => {
                    confined_path(&root, value)?;
                }
                Value::Array(values) if field != "systemPromptPath" => {
                    for value in values {
                        confined_path(&root, value.as_str().ok_or("Invalid Kimi manifest path")?)?;
                    }
                }
                _ => return Err("Invalid Kimi manifest path field".into()),
            }
        }
    }
    let Some(servers) = manifest.get("mcpServers") else {
        return Ok(());
    };
    let servers = servers
        .as_object()
        .ok_or("Kimi mcpServers must be an inline object")?;
    let mut names = HashSet::new();
    for (name, config) in servers {
        let name = name.trim();
        if name.is_empty() || !names.insert(name.to_owned()) {
            plugin.warning = Some("Invalid or duplicate Kimi MCP server name".into());
            continue;
        }
        match normalize_mcp(&root, name, config, row) {
            Ok(config) => plugin.mcp_servers.push(KimiMcpServer {
                name: name.into(),
                config,
            }),
            Err(error) => plugin.warning = Some(error),
        }
    }
    Ok(())
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// Reject traversal, device/ADS paths and cross-platform separator tricks.
/// Canonicalize the nearest existing ancestor to also reject symlink/junction
/// escapes when the final referenced file has not been installed yet.
fn confined_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let invalid = || "Unsafe Kimi manifest relative path".to_owned();
    if !relative.starts_with("./") || relative.contains(['\\', ':', '\0']) {
        return Err(invalid());
    }
    let path = Path::new(relative);
    if path
        .components()
        .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return Err(invalid());
    }
    let candidate = root.join(path);
    let mut existing = candidate.as_path();
    loop {
        match fs::symlink_metadata(existing) {
            Ok(_) => {
                let real = fs::canonicalize(existing).map_err(|_| invalid())?;
                if !real.starts_with(root) {
                    return Err(invalid());
                }
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                existing = existing.parent().ok_or_else(invalid)?;
            }
            Err(_) => return Err(invalid()),
        }
    }
    Ok(candidate)
}

fn normalize_mcp(root: &Path, name: &str, value: &Value, row: &Value) -> Result<Value, String> {
    let invalid = || "Invalid Kimi MCP declaration".to_owned();
    let mut config = value.as_object().cloned().ok_or_else(invalid)?;
    if let Some(capabilities) = row.get("capabilities") {
        let capabilities = capabilities.as_object().ok_or_else(invalid)?;
        if capabilities
            .get("mcpServers")
            .is_some_and(|v| !v.is_object())
        {
            return Err(invalid());
        }
    }
    for key in ["enabled", "deferred"] {
        if config.get(key).is_some_and(|v| !v.is_boolean()) {
            return Err(invalid());
        }
    }
    for key in ["args", "enabledTools", "disabledTools"] {
        if let Some(value) = config.get(key) {
            if !value
                .as_array()
                .is_some_and(|a| a.iter().all(Value::is_string))
            {
                return Err(invalid());
            }
        }
    }
    for key in ["env", "headers"] {
        if let Some(value) = config.get(key) {
            if !value
                .as_object()
                .is_some_and(|a| a.values().all(Value::is_string))
            {
                return Err(invalid());
            }
        }
    }
    for key in ["startupTimeoutMs", "toolTimeoutMs"] {
        if let Some(value) = config.get(key) {
            if !value
                .as_u64()
                .is_some_and(|n| (1..=2_147_483_647).contains(&n))
            {
                return Err(invalid());
            }
        }
    }
    let transport = match config.get("transport") {
        Some(value) => value.as_str().ok_or_else(invalid)?,
        None if config.get("command").is_some_and(Value::is_string) => "stdio",
        None if config.get("url").is_some_and(Value::is_string) => "http",
        _ => return Err(invalid()),
    }
    .to_owned();
    match transport.as_str() {
        "stdio" => {
            let command = config
                .get("command")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or_else(invalid)?;
            if command.starts_with("./") {
                let path = confined_path(root, command)?;
                config.insert(
                    "command".into(),
                    Value::String(path.to_string_lossy().into_owned()),
                );
            } else if command.contains(['/', '\\', ':', '\0']) {
                return Err(invalid());
            }
            if let Some(cwd) = config.get("cwd") {
                let path = confined_path(root, cwd.as_str().ok_or_else(invalid)?)?;
                config.insert(
                    "cwd".into(),
                    Value::String(path.to_string_lossy().into_owned()),
                );
            }
        }
        "http" | "sse" => {
            // Inventory only: do not expand environment variables or connect.
            let url = config
                .get("url")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?;
            if !url.contains(":") || url.chars().any(char::is_whitespace) {
                return Err(invalid());
            }
        }
        _ => return Err(invalid()),
    }
    let state = row
        .get("capabilities")
        .and_then(|v| v.get("mcpServers"))
        .and_then(|v| v.get(name));
    let server_enabled = match state {
        Some(state) => state
            .get("enabled")
            .and_then(Value::as_bool)
            .ok_or_else(invalid)?,
        None => config
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
    };
    let enabled = row.get("enabled").and_then(Value::as_bool) == Some(true) && server_enabled;
    config.insert("enabled".into(), Value::Bool(enabled));
    config.insert("transport".into(), Value::String(transport));
    Ok(Value::Object(config))
}

fn read_json(path: &Path) -> Result<Option<Value>, String> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Kimi JSON file is inaccessible".into()),
    };
    if !file
        .metadata()
        .map_err(|_| "Cannot inspect Kimi JSON file")?
        .is_file()
    {
        return Err("Kimi JSON path is not a regular file".into());
    }
    let mut bytes = Vec::new();
    file.take(JSON_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read Kimi JSON file")?;
    if bytes.len() as u64 > JSON_LIMIT {
        return Err("Kimi JSON file exceeds size limit".into());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "Invalid Kimi JSON file".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("ccgui-kimi-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(path.join("plugins")).unwrap();
            Self(path)
        }
        fn write(&self, path: &str, value: Value) {
            let path = self.0.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
        }
        fn install(&self, enabled: bool, manifest: Value) {
            self.write("example/kimi.plugin.json", manifest);
            self.write(
                "plugins/installed.json",
                json!({"version":1,"plugins":[{
                    "id":"example", "root":self.0.join("example"), "enabled":enabled,
                    "source":"local-path", "installedAt":"2026-10-31T00:00:00Z"
                }]}),
            );
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn missing_inventory_is_empty_without_creating_files() {
        let f = Fixture::new();
        assert!(read_plugins_at(&f.0).unwrap().is_empty());
        assert!(!f.0.join("plugins/installed.json").exists());
    }

    #[test]
    fn inventory_metadata_disable_and_private_config() {
        let f = Fixture::new();
        f.install(
            false,
            json!({"name":"Example", "version":"1.2", "interface":{"displayName":"Example UI"},
            "mcpServers":{"svc":{"command":"node", "env":{"TOKEN":"private-value"}}}}),
        );
        let plugins = read_plugins_at(&f.0).unwrap();
        let p = &plugins[0];
        assert_eq!(p.name, "Example UI");
        assert_eq!(p.version.as_deref(), Some("1.2"));
        assert_eq!(p.enabled, Some(false));
        assert!(p
            .source_path
            .as_ref()
            .unwrap()
            .ends_with("kimi.plugin.json"));
        assert!(p.warning.is_none());
        assert_eq!(p.mcp_servers[0].name, "svc");
        assert_eq!(p.mcp_servers[0].config["enabled"], false);
        assert_eq!(p.mcp_servers[0].config["env"]["TOKEN"], "private-value");
    }

    #[test]
    fn capability_override_and_manifest_precedence() {
        let f = Fixture::new();
        f.install(
            true,
            json!({"name":"example", "mcpServers":{
            "a":{"url":"https://example.test", "enabled":false},
            "b":{"command":"node"}}}),
        );
        f.write("example/.kimi-plugin/plugin.json", json!({"name":"wrong"}));
        let path = f.0.join("plugins/installed.json");
        let mut value = read_json(&path).unwrap().unwrap();
        value["plugins"][0]["capabilities"] =
            json!({"mcpServers":{"a":{"enabled":true}, "b":{"enabled":false}}});
        f.write("plugins/installed.json", value);
        let plugins = read_plugins_at(&f.0).unwrap();
        assert!(plugins[0].warning.is_none());
        let servers = &plugins[0].mcp_servers;
        assert_eq!(
            servers.iter().find(|s| s.name == "a").unwrap().config["enabled"],
            true
        );
        assert_eq!(
            servers.iter().find(|s| s.name == "b").unwrap().config["enabled"],
            false
        );
        fs::remove_file(f.0.join("example/kimi.plugin.json")).unwrap();
        f.write(
            "example/.kimi-plugin/plugin.json",
            json!({"name":"example","version":"fallback"}),
        );
        assert_eq!(
            read_plugins_at(&f.0).unwrap()[0].version.as_deref(),
            Some("fallback")
        );
    }

    #[test]
    fn rejects_external_file_forms_and_path_traversal_without_leaking_values() {
        let f = Fixture::new();
        for reference in [
            "../private-value",
            "./../private-value",
            "./a/../../private-value",
            "C:/private-value",
            "./a\\..\\private-value",
            "./a:private-value",
        ] {
            f.install(
                true,
                json!({"name":"example", "mcpServers":{"bad":{"command":reference}}}),
            );
            let plugins = read_plugins_at(&f.0).unwrap();
            assert!(plugins[0].mcp_servers.is_empty());
            assert!(!plugins[0]
                .warning
                .as_ref()
                .unwrap()
                .contains("private-value"));
        }
        f.install(
            true,
            json!({"name":"example", "mcpServers":"./private-value.json"}),
        );
        assert!(read_plugins_at(&f.0).unwrap()[0].warning.is_some());
        f.install(
            true,
            json!({"name":"example", "systemPromptPath":"./../private-value"}),
        );
        assert!(read_plugins_at(&f.0).unwrap()[0].warning.is_some());
    }

    #[test]
    fn safe_relative_commands_are_resolved_without_execution() {
        let f = Fixture::new();
        f.install(true, json!({"name":"example", "mcpServers":{"svc":{"command":"./bin/server", "cwd":"./work"}}}));
        let plugins = read_plugins_at(&f.0).unwrap();
        assert!(plugins[0].warning.is_none());
        assert!(Path::new(
            plugins[0].mcp_servers[0].config["command"]
                .as_str()
                .unwrap()
        )
        .is_absolute());
        assert!(!f.0.join("example/bin/server").exists());
    }

    #[test]
    fn corrupt_inventory_and_unsupported_version_are_not_empty_successes() {
        let f = Fixture::new();
        for value in [
            json!([]),
            json!({"version":2,"plugins":[]}),
            json!({"version":1,"plugins":[{"id":"example","enabled":"yes"}]}),
        ] {
            f.write("plugins/installed.json", value);
            assert!(read_plugins_at(&f.0).is_err());
        }
        fs::write(
            f.0.join("plugins/installed.json"),
            "{\"secret\":private-value",
        )
        .unwrap();
        assert_eq!(
            read_plugins_at(&f.0).err().unwrap(),
            "Invalid Kimi JSON file"
        );
    }

    #[test]
    fn broken_manifest_keeps_inventory_entry() {
        let f = Fixture::new();
        f.install(true, json!({"name":"example"}));
        fs::remove_file(f.0.join("example/kimi.plugin.json")).unwrap();
        let plugins = read_plugins_at(&f.0).unwrap();
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].enabled, Some(true));
        assert!(plugins[0].warning.is_some());
        assert!(plugins[0].mcp_servers.is_empty());
    }

    #[test]
    fn symlink_escape_is_rejected_including_missing_leaf() {
        let f = Fixture::new();
        let outside = Fixture::new();
        f.install(true, json!({"name":"example"}));
        let link = f.0.join("example").join("escape");
        // Junctions exercise Windows reparse-point containment without requiring
        // the developer-mode/symlink privilege. This is test setup only.
        #[cfg(windows)]
        {
            let output = std::process::Command::new("cmd")
                .args(["/d", "/c", "mklink", "/J"])
                .arg(&link)
                .arg(&outside.0)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "junction setup: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside.0, &link).unwrap();
        let root = fs::canonicalize(f.0.join("example")).unwrap();
        assert!(confined_path(&root, "./escape/missing.json").is_err());
        // Remove the link before fixture cleanup; never recursively clean a target.
        #[cfg(windows)]
        fs::remove_dir(link).unwrap();
        #[cfg(unix)]
        fs::remove_file(link).unwrap();
    }
}
