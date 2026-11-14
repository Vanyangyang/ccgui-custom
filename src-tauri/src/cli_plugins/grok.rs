//! Read-only Grok plugin inventory. No plugin code or MCP process is executed.
//!
//! Manifest conventions follow xai-org/grok-build's
//! crates/codegen/xai-grok-agent/src/plugins/manifest.rs. Inventory `status`
//! describes installation, not runtime enablement or trust.

use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Component, Path};

pub(super) struct GrokPlugin {
    pub id: String,
    pub name: String,
    pub version: Option<String>,
    pub enabled: Option<bool>,
    pub trusted: Option<bool>,
    pub source_path: Option<String>,
    pub mcp_servers: Vec<GrokMcpServer>,
}

// Deliberately neither Serialize nor Debug: declarations can contain secrets.
pub(super) struct GrokMcpServer {
    pub name: String,
    pub config: Value,
}

/// Parse the native `grok plugin list --json` array and inspect local declarations.
/// Missing conventional files are empty inventories; malformed input, unreadable
/// files, missing explicitly referenced files, and unsafe paths are errors.
/// Errors contain only row indices and fixed labels, never configuration values.
pub(super) fn parse_list(json: &str) -> Result<Vec<GrokPlugin>, String> {
    let value: Value = serde_json::from_str(json).map_err(|_| "Invalid Grok list JSON")?;
    let rows = value.as_array().ok_or("Grok list must be an array")?;
    rows.iter()
        .enumerate()
        .map(|(index, row)| parse_plugin(row).map_err(|error| format!("Grok row {index}: {error}")))
        .collect()
}

fn parse_plugin(row: &Value) -> Result<GrokPlugin, String> {
    let row = row.as_object().ok_or("Expected plugin object")?;
    let name = required_string(row.get("name"), "Missing or invalid plugin name")?;
    let id = required_string(row.get("repo_key"), "Missing or invalid repo_key")?;
    let version = optional_string(row.get("version"), "Invalid plugin version")?;
    let source_path = optional_string(row.get("path"), "Invalid plugin path")?;
    let mcp_servers = match source_path.as_deref() {
        Some(path) => read_declarations(Path::new(path))?,
        None => Vec::new(),
    };
    Ok(GrokPlugin {
        id,
        name,
        version,
        // Neither `status`, source, marketplace, nor installation directory
        // establish these states in the verified native list schema.
        enabled: None,
        trusted: None,
        source_path,
        mcp_servers,
    })
}

fn required_string(value: Option<&Value>, error: &str) -> Result<String, String> {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| error.to_owned())
}

fn optional_string(value: Option<&Value>, error: &str) -> Result<Option<String>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        other => required_string(other, error).map(Some),
    }
}

fn read_declarations(path: &Path) -> Result<Vec<GrokMcpServer>, String> {
    // Do not resolve list paths against the host application's working directory
    // or access network shares. Only an explicit local installation is inspected.
    let text = path.to_string_lossy();
    if !path.is_absolute() || text.starts_with("\\\\") || text.starts_with("//") {
        return Err("Plugin root must be an absolute local directory".into());
    }
    let root = fs::canonicalize(path).map_err(|_| "Plugin root is missing or inaccessible")?;
    if !root.is_dir() {
        return Err("Plugin root is not a directory".into());
    }
    let mut manifest = None;
    for name in [
        "plugin.json",
        ".grok-plugin/plugin.json",
        ".claude-plugin/plugin.json",
    ] {
        if let Some(value) = read_json(&root, name)? {
            if !value.is_object() {
                return Err("Plugin manifest must be an object".into());
            }
            manifest = Some(value);
            break;
        }
    }
    let declaration = manifest.as_ref().and_then(|m| m.get("mcpServers"));
    let mut servers = BTreeMap::new();
    match declaration {
        Some(Value::String(file)) => {
            let config = read_json(&root, file)?.ok_or("Referenced MCP file is missing")?;
            add_servers(&mut servers, &config, false)?;
        }
        None | Some(Value::Null) | Some(Value::Object(_)) => {
            if let Some(config) = read_json(&root, ".mcp.json")? {
                add_servers(&mut servers, &config, false)?;
            }
            if let Some(config @ Value::Object(_)) = declaration {
                add_servers(&mut servers, config, true)?;
            }
        }
        Some(_) => return Err("Invalid manifest mcpServers declaration".into()),
    }
    Ok(servers
        .into_iter()
        .map(|(name, config)| GrokMcpServer { name, config })
        .collect())
}

fn add_servers(
    servers: &mut BTreeMap<String, Value>,
    config: &Value,
    inline: bool,
) -> Result<(), String> {
    let object = config.as_object().ok_or("MCP config must be an object")?;
    let entries = match object.get("mcpServers") {
        Some(value) => value
            .as_object()
            .ok_or("MCP mcpServers must be an object")?,
        None if inline => object,
        None => return Err("MCP config is missing mcpServers".into()),
    };
    for (name, value) in entries {
        if name.trim().is_empty() || !value.is_object() {
            return Err("Invalid MCP server declaration".into());
        }
        // Do not invent precedence between two conflicting declarations.
        if let Some(previous) = servers.get(name) {
            if previous != value {
                return Err("Conflicting duplicate MCP server declarations".into());
            }
        } else {
            servers.insert(name.clone(), value.clone());
        }
    }
    Ok(())
}

/// Check each existing component before opening anything. This also rejects
/// directory symlinks/junctions which leave the root, including missing leaves.
fn read_json(root: &Path, relative: &str) -> Result<Option<Value>, String> {
    // Treat both separator styles consistently, even on Unix. Reject schemes,
    // drive-relative paths and NTFS alternate streams, rather than interpreting them.
    if relative.is_empty() || relative.contains(':') || relative.starts_with(['/', '\\']) {
        return Err("Unsafe plugin configuration path".into());
    }
    let normalized = relative.replace('\\', "/");
    let relative = Path::new(&normalized);
    if relative
        .components()
        .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err("Unsafe plugin configuration path".into());
    }
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(_) => {
                current = fs::canonicalize(&current).map_err(|_| "Invalid configuration link")?;
                if !current.starts_with(root) {
                    return Err("Plugin configuration path escapes root".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("Cannot inspect plugin configuration file".into()),
        }
    }
    if !current.is_file() {
        return Err("Plugin configuration path is not a file".into());
    }
    const MAX_BYTES: u64 = 8 * 1024 * 1024;
    let file = fs::File::open(current).map_err(|_| "Cannot open plugin configuration file")?;
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read plugin configuration file")?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("Plugin configuration file exceeds size limit".into());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "Invalid plugin configuration JSON".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("ccgui-grok-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn write(&self, path: &str, contents: &str) {
            let path = self.0.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }
        fn list(&self, status: &str) -> String {
            json!([{"status":status,"name":"example","repo_key":"example-123",
                "version":"1.2.3","path":self.0,"source":"local","marketplace":null}])
            .to_string()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn native_shape_does_not_imply_runtime_state() {
        let fixture = Fixture::new();
        for status in [
            "installed",
            "disabled",
            "enabled",
            "trusted",
            "available",
            "unknown",
        ] {
            let plugins = parse_list(&fixture.list(status)).unwrap();
            let plugin = &plugins[0];
            assert_eq!(plugin.id, "example-123");
            assert_eq!(plugin.name, "example");
            assert_eq!(plugin.version.as_deref(), Some("1.2.3"));
            assert_eq!(plugin.enabled, None);
            assert_eq!(plugin.trusted, None);
            assert_eq!(plugin.source_path.as_deref(), fixture.0.to_str());
            assert!(plugin.mcp_servers.is_empty());
        }
    }

    #[test]
    fn absent_path_is_not_current_directory() {
        let plugins = parse_list(r#"[{"name":"x","repo_key":"key","path":null}]"#).unwrap();
        assert!(plugins[0].mcp_servers.is_empty());
        assert!(parse_list(r#"[{"name":"x","repo_key":"key","path":"."}]"#).is_err());
    }

    #[test]
    fn unverified_state_fields_do_not_override_unknown_state() {
        let plugins = parse_list(
            r#"[{"name":"x","repo_key":"key","enabled":false,"trusted":true,"status":"disabled"}]"#,
        )
        .unwrap();
        assert_eq!(plugins[0].enabled, None);
        assert_eq!(plugins[0].trusted, None);
    }

    #[test]
    fn reads_conventional_mcp_without_expanding_or_executing_values() {
        let fixture = Fixture::new();
        fixture.write(".mcp.json", r#"{"mcpServers":{"demo":{"command":"never-run","args":["secret"],"env":{"TOKEN":"!never-run"},"headers":{"Authorization":"secret"}}}}"#);
        let plugins = parse_list(&fixture.list("installed")).unwrap();
        let server = &plugins[0].mcp_servers[0];
        assert_eq!(server.name, "demo");
        assert_eq!(server.config["env"]["TOKEN"], "!never-run");
        assert_eq!(server.config["args"][0], "secret");
    }

    #[test]
    fn manifest_paths_are_relative_to_root_and_override_default_file() {
        let fixture = Fixture::new();
        fixture.write(
            ".grok-plugin/plugin.json",
            r#"{"name":"example","mcpServers":"config/mcp.json"}"#,
        );
        fixture.write(
            "config/mcp.json",
            r#"{"mcpServers":{"remote":{"url":"https://example.invalid/mcp"}}}"#,
        );
        fixture.write(".mcp.json", "invalid but overridden");
        let plugins = parse_list(&fixture.list("installed")).unwrap();
        assert_eq!(plugins[0].mcp_servers[0].name, "remote");
    }

    #[test]
    fn inline_and_manifest_search_order() {
        let fixture = Fixture::new();
        fixture.write(
            ".claude-plugin/plugin.json",
            r#"{"mcpServers":{"inline":{"command":"unused"}}}"#,
        );
        assert_eq!(
            parse_list(&fixture.list("installed")).unwrap()[0].mcp_servers[0].name,
            "inline"
        );
        fixture.write(
            "plugin.json",
            r#"{"mcpServers":{"mcpServers":{"wrapped":{"command":"unused"}}}}"#,
        );
        assert_eq!(
            parse_list(&fixture.list("installed")).unwrap()[0].mcp_servers[0].name,
            "wrapped"
        );
    }

    #[test]
    fn unsafe_references_are_rejected_even_when_missing() {
        let fixture = Fixture::new();
        for path in [
            "../outside.json",
            "..\\outside.json",
            "https://example.invalid/config",
            "file:///etc/config",
            "/outside.json",
            "C:\\outside.json",
            "config:stream",
        ] {
            fixture.write("plugin.json", &json!({"mcpServers":path}).to_string());
            assert!(
                parse_list(&fixture.list("installed")).is_err(),
                "unsafe reference accepted"
            );
        }
    }

    #[test]
    fn missing_and_corrupt_files_are_distinct() {
        let fixture = Fixture::new();
        assert!(parse_list(&fixture.list("installed")).is_ok());
        fixture.write("plugin.json", r#"{"mcpServers":"missing.json"}"#);
        assert!(parse_list(&fixture.list("installed"))
            .err()
            .unwrap()
            .contains("missing"));
        fixture.write("plugin.json", "broken secret-value");
        let error = parse_list(&fixture.list("installed")).err().unwrap();
        assert!(error.contains("JSON"));
        assert!(!error.contains("secret-value"));
    }

    #[test]
    fn invalid_list_and_mcp_shapes_fail_closed() {
        for input in [
            "invalid secret",
            "{}",
            "[null]",
            r#"[{"name":"x"}]"#,
            r#"[{"name":"x","repo_key":"k","version":3}]"#,
        ] {
            assert!(parse_list(input).is_err());
        }
        let fixture = Fixture::new();
        for config in [
            "not json",
            "[]",
            "{}",
            r#"{"mcpServers":[]}"#,
            r#"{"mcpServers":{"x":"secret"}}"#,
        ] {
            fixture.write(".mcp.json", config);
            assert!(parse_list(&fixture.list("installed")).is_err());
        }
    }

    #[test]
    fn conflicting_inline_and_file_servers_are_not_guessed() {
        let fixture = Fixture::new();
        fixture.write("plugin.json", r#"{"mcpServers":{"x":{"command":"one"}}}"#);
        fixture.write(".mcp.json", r#"{"mcpServers":{"x":{"command":"two"}}}"#);
        assert!(parse_list(&fixture.list("installed"))
            .err()
            .unwrap()
            .contains("Conflicting"));
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn symlink_escape_is_rejected() {
        let fixture = Fixture::new();
        let outside = Fixture::new();
        outside.write("mcp.json", r#"{"mcpServers":{}}"#);
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside.0, fixture.0.join("linked")).unwrap();
        #[cfg(windows)]
        {
            // Junctions exercise canonical containment without requiring the
            // Windows symbolic-link privilege. Only temporary fixture paths
            // are passed, through environment variables rather than shell code.
            let status = std::process::Command::new("powershell.exe")
                .args([
                    "-NoProfile", "-NonInteractive", "-Command",
                    "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:CCGUI_GROK_TEST_LINK -Target $env:CCGUI_GROK_TEST_TARGET | Out-Null",
                ])
                .env("CCGUI_GROK_TEST_LINK", fixture.0.join("linked"))
                .env("CCGUI_GROK_TEST_TARGET", &outside.0)
                .status().unwrap();
            assert!(status.success(), "cannot create junction fixture");
        }
        fixture.write("plugin.json", r#"{"mcpServers":"linked/mcp.json"}"#);
        assert!(parse_list(&fixture.list("installed")).is_err());
        fixture.write("plugin.json", r#"{"mcpServers":"linked/missing.json"}"#);
        assert!(parse_list(&fixture.list("installed")).is_err());
        // Remove the link itself before the fixture's recursive cleanup.
        #[cfg(unix)]
        fs::remove_file(fixture.0.join("linked")).unwrap();
        #[cfg(windows)]
        fs::remove_dir(fixture.0.join("linked")).unwrap();
    }
}
