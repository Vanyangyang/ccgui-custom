//! Read-only parsing of Codex 0.162.1's plugin list and installed bundles.
//! `source.path` is marketplace provenance, not an installed bundle location.
//! No command, network request, variable expansion or plugin code runs here.
use serde_json::Value;
use std::path::{Component, Path, PathBuf};

// Deliberately not Serialize or Debug: MCP configuration can contain credentials.
pub(super) struct CodexPlugin {
    pub id: String,
    pub name: String,
    pub version: Option<String>,
    pub enabled: bool,
    pub install_policy: Option<String>,
    pub source_path: Option<String>,
    pub mcp_servers: Vec<CodexMcpServer>,
}

pub(super) struct CodexMcpServer {
    pub name: String,
    // Internal only. Callers must not serialize this value into UI responses.
    pub config: Value,
}

pub(super) fn parse_list_at(json: &str, home: &Path) -> Result<Vec<CodexPlugin>, String> {
    let list = decode(json, "Codex plugin list")?;
    let installed = list
        .get("installed")
        .and_then(Value::as_array)
        .ok_or_else(|| "Codex plugin list: expected installed array".to_string())?;
    let mut result = Vec::new();
    for entry in installed {
        // Never enumerate `available`, even if it contains installed-looking entries.
        match entry.get("installed").and_then(Value::as_bool) {
            Some(false) => continue,
            Some(true) => (),
            None => return Err("Codex installed entry: missing boolean installed".into()),
        }
        let id = string(entry, "pluginId")?;
        let name = string(entry, "name")?;
        let marketplace = string(entry, "marketplaceName")?;
        let version = optional_string(entry, "version")?;
        let enabled = entry
            .get("enabled")
            .and_then(Value::as_bool)
            .ok_or_else(|| format!("{id}: missing boolean enabled"))?;
        let install_policy = optional_string(entry, "installPolicy")?;
        if id != format!("{name}@{marketplace}") {
            return Err(format!(
                "{id}: plugin identity disagrees with name/marketplace"
            ));
        }
        for part in [&name, &marketplace] {
            safe_segment(part)?;
        }
        let version_ref = version
            .as_deref()
            .ok_or_else(|| format!("{id}: version required to locate installed cache"))?;
        safe_segment(version_ref)?;
        let cache = home.join("plugins/cache");
        let relative = Path::new(&marketplace).join(&name).join(version_ref);
        let root =
            confined(&cache, &relative).map_err(|e| format!("{id}: installed cache: {e}"))?;
        if !root.is_dir() {
            return Err(format!("{id}: installed cache is not a directory"));
        }
        let servers = read_bundle(&root, &name, version_ref).map_err(|e| format!("{id}: {e}"))?;
        result.push(CodexPlugin {
            id,
            name,
            version,
            enabled,
            install_policy,
            // Actual inspected installed root, not source.path's marketplace root.
            source_path: Some(root.to_string_lossy().into_owned()),
            mcp_servers: servers,
        });
    }
    Ok(result)
}

fn string(value: &Value, key: &str) -> Result<String, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("Expected nonempty string {key}"))
}

fn optional_string(value: &Value, key: &str) -> Result<Option<String>, String> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        _ => Err(format!("Expected string or null {key}")),
    }
}

fn safe_segment(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains(['/', '\\', ':'])
        || value.ends_with(['.', ' '])
    {
        return Err("Invalid installed cache path component".into());
    }
    Ok(())
}

fn confined(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    // Reject Windows separators/ADS/URLs even on Unix; no absolute references.
    let text = relative.to_string_lossy();
    if text.contains(':')
        || text.split(['/', '\\']).any(|p| p == "..")
        || relative.is_absolute()
        || relative.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("Path reference must stay inside plugin root".into());
    }
    let root = root
        .canonicalize()
        .map_err(|e| format!("Cannot resolve {}: {e}", root.display()))?;
    let target = root
        .join(relative)
        .canonicalize()
        .map_err(|e| format!("Cannot resolve {}: {e}", root.join(relative).display()))?;
    if !target.starts_with(&root) {
        return Err("Symlink reference escapes plugin root".into());
    }
    Ok(target)
}

fn decode(text: &str, label: &str) -> Result<Value, String> {
    // Never include the input or serde's possibly value-bearing error message.
    serde_json::from_str(text).map_err(|e| {
        format!(
            "{label}: invalid JSON at line {}, column {} ({:?})",
            e.line(),
            e.column(),
            e.classify()
        )
    })
}

fn read_json(root: &Path, relative: &Path) -> Result<Value, String> {
    let path = confined(root, relative)?;
    let file =
        std::fs::File::open(&path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    use std::io::Read;
    let mut text = String::new();
    file.take(4 * 1024 * 1024 + 1)
        .read_to_string(&mut text)
        .map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    if text.len() > 4 * 1024 * 1024 {
        return Err(format!("{} exceeds 4 MiB", path.display()));
    }
    decode(&text, &path.display().to_string())
}

fn exists(root: &Path, relative: &str) -> Result<bool, String> {
    match std::fs::symlink_metadata(root.join(relative)) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("Cannot inspect {relative}: {e}")),
    }
}

fn read_bundle(root: &Path, name: &str, version: &str) -> Result<Vec<CodexMcpServer>, String> {
    let portable = if exists(root, "plugin.json")? {
        Some(read_json(root, Path::new("plugin.json"))?)
    } else {
        None
    };
    let extension = portable
        .as_ref()
        .and_then(|p| p.get("extensions"))
        .and_then(|e| e.get("com.openai"));
    let legacy = if extension.is_none() && exists(root, ".codex-plugin/plugin.json")? {
        Some(read_json(root, Path::new(".codex-plugin/plugin.json"))?)
    } else {
        None
    };
    let identity = portable
        .as_ref()
        .or(legacy.as_ref())
        .ok_or("No supported plugin manifest in installed cache")?;
    if string(identity, "name")? != name {
        return Err("Installed manifest name mismatch".into());
    }
    if let Some(v) = optional_string(identity, "version")? {
        if v != version {
            return Err("Installed manifest version mismatch".into());
        }
    }
    let selected = extension.or(legacy.as_ref()).unwrap_or(identity);
    if !selected.is_object() {
        return Err("Plugin manifest configuration must be an object".into());
    }
    let mut servers = Vec::new();
    if let Some(reference) = selected.get("mcpServers") {
        read_mcp_spec(root, reference, &mut servers)?;
    } else if exists(root, "mcp.json")? {
        add_servers(&read_json(root, Path::new("mcp.json"))?, &mut servers)?;
    } else if exists(root, ".mcp.json")? {
        add_servers(&read_json(root, Path::new(".mcp.json"))?, &mut servers)?;
    }
    Ok(servers)
}

fn read_mcp_spec(
    root: &Path,
    spec: &Value,
    servers: &mut Vec<CodexMcpServer>,
) -> Result<(), String> {
    match spec {
        Value::String(path) => add_servers(&read_json(root, Path::new(path))?, servers),
        Value::Object(_) => add_servers(spec, servers),
        Value::Array(items) => {
            for item in items {
                if item.is_array() {
                    return Err("Nested MCP reference array is unsupported".into());
                }
                read_mcp_spec(root, item, servers)?;
            }
            Ok(())
        }
        _ => Err("mcpServers must be a path, object or array".into()),
    }
}

fn add_servers(document: &Value, servers: &mut Vec<CodexMcpServer>) -> Result<(), String> {
    let map = document
        .get("mcpServers")
        .unwrap_or(document)
        .as_object()
        .ok_or("MCP definitions must be an object")?;
    for (name, config) in map {
        if name == "$schema" {
            continue;
        }
        if name.is_empty() || !config.is_object() {
            return Err("MCP server must have a name and object configuration".into());
        }
        if servers.iter().any(|s| s.name == *name) {
            return Err(format!("Duplicate MCP server {name}"));
        }
        servers.push(CodexMcpServer {
            name: name.clone(),
            config: config.clone(),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("ccgui-codex-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(dir.join("plugins/cache/test/demo/1/.codex-plugin")).unwrap();
            Self(dir)
        }
        fn root(&self) -> PathBuf {
            self.0.join("plugins/cache/test/demo/1")
        }
        fn write(&self, path: &str, value: Value) {
            std::fs::write(self.root().join(path), value.to_string()).unwrap();
        }
        fn list(&self) -> Value {
            json!({"installed":[{"pluginId":"demo@test","name":"demo","marketplaceName":"test","version":"1","installed":true,"enabled":false,"installPolicy":"INSTALLED_BY_DEFAULT","source":{"source":"local","path":"https://not-an-installed-directory"}}],"available":[{"installed":true}]})
        }
        fn parse(&self) -> Result<Vec<CodexPlugin>, String> {
            parse_list_at(&self.list().to_string(), &self.0)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn disabled_installed_plugin_and_internal_mcp() {
        let f = Fixture::new();
        f.write(
            ".codex-plugin/plugin.json",
            json!({"name":"demo","version":"1","mcpServers":"./.mcp.json"}),
        );
        f.write(
            ".mcp.json",
            json!({"mcpServers":{"docs":{"command":"never-execute","env":{"SECRET":"internal"}}}}),
        );
        let list = f.parse().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "demo@test");
        assert_eq!(list[0].name, "demo");
        assert_eq!(list[0].version.as_deref(), Some("1"));
        assert!(!list[0].enabled);
        assert_eq!(
            list[0].install_policy.as_deref(),
            Some("INSTALLED_BY_DEFAULT")
        );
        assert!(list[0].source_path.as_ref().unwrap().contains("cache"));
        assert_eq!(list[0].mcp_servers[0].name, "docs");
        assert_eq!(list[0].mcp_servers[0].config["command"], "never-execute");
    }

    #[test]
    fn portable_root_mcp_and_openai_override() {
        let f = Fixture::new();
        f.write("plugin.json", json!({"name":"demo","version":"1"}));
        f.write(
            "mcp.json",
            json!({"mcpServers":{"docs":{"url":"https://example.test"}}}),
        );
        assert_eq!(f.parse().unwrap()[0].mcp_servers[0].name, "docs");
        f.write("plugin.json", json!({"name":"demo","extensions":{"com.openai":{"mcpServers":{"override":{"command":"noop"}}}}}));
        f.write(
            ".codex-plugin/plugin.json",
            json!({"name":"demo","mcpServers":"missing.json"}),
        );
        assert_eq!(f.parse().unwrap()[0].mcp_servers[0].name, "override");
    }

    #[test]
    fn rejects_paths_missing_files_and_manifest_mismatch() {
        let f = Fixture::new();
        for path in [
            "../outside.json",
            "..\\outside.json",
            "https://example.test/mcp.json",
            "/tmp/mcp.json",
            "C:\\mcp.json",
            "missing.json",
        ] {
            f.write(
                ".codex-plugin/plugin.json",
                json!({"name":"demo","mcpServers":path}),
            );
            assert!(f.parse().is_err(), "{path}");
        }
        f.write(".codex-plugin/plugin.json", json!({"name":"other"}));
        assert!(f.parse().err().unwrap().contains("name mismatch"));
    }

    #[test]
    fn rejects_bad_json_without_leaking_input_and_ignores_available() {
        let f = Fixture::new();
        assert!(parse_list_at("{secret-token", &f.0)
            .err()
            .unwrap()
            .contains("invalid JSON"));
        assert!(parse_list_at("{}", &f.0).is_err());
        assert!(
            parse_list_at(r#"{"installed":[],"available":[{"installed":true}]}"#, &f.0)
                .unwrap()
                .is_empty()
        );
        f.write(
            ".codex-plugin/plugin.json",
            json!({"name":"demo","mcpServers":"./.mcp.json"}),
        );
        std::fs::write(f.root().join(".mcp.json"), "{secret-token").unwrap();
        let error = f.parse().err().unwrap();
        assert!(error.contains("invalid JSON"));
        assert!(!error.contains("secret-token"));
    }

    #[test]
    fn rejects_cache_path_injection_and_missing_cache() {
        let f = Fixture::new();
        let mut list = f.list();
        list["installed"][0]["version"] = json!("../escape");
        assert!(parse_list_at(&list.to_string(), &f.0).is_err());
        list["installed"][0]["version"] = json!("missing");
        assert!(parse_list_at(&list.to_string(), &f.0)
            .err()
            .unwrap()
            .contains("installed cache"));
    }

    #[test]
    fn references_arrays_validate_shape_and_duplicates() {
        let f = Fixture::new();
        f.write(
            ".codex-plugin/plugin.json",
            json!({"name":"demo","mcpServers":["./mcp.json", {"second":{"command":"noop"}}]}),
        );
        f.write(
            "mcp.json",
            json!({"mcpServers":{"first":{"command":"noop"}}}),
        );
        assert_eq!(f.parse().unwrap()[0].mcp_servers.len(), 2);
        f.write(
            "mcp.json",
            json!({"mcpServers":{"second":{"command":"noop"}}}),
        );
        assert!(f.parse().err().unwrap().contains("Duplicate MCP"));
        f.write("mcp.json", json!({"mcpServers":{"first":false}}));
        assert!(f.parse().is_err());
        let mut list = f.list();
        list["installed"][0]["installed"] = json!(false);
        assert!(parse_list_at(&list.to_string(), &f.0).unwrap().is_empty());
    }

    #[test]
    fn legacy_manifest_can_discover_root_mcp() {
        let f = Fixture::new();
        f.write(".codex-plugin/plugin.json", json!({"name":"demo"}));
        f.write(
            "mcp.json",
            json!({"mcpServers":{"docs":{"command":"noop"}}}),
        );
        assert_eq!(f.parse().unwrap()[0].mcp_servers.len(), 1);
    }

    #[test]
    fn rejects_symlink_escape() {
        let f = Fixture::new();
        let outside = f.0.join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(outside.join("mcp.json"), "{}").unwrap();
        let link = f.root().join("linked-directory");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            // Junction creation requires no symlink privilege. Both paths belong
            // to this UUID-named fixture; never interpolate plugin input here.
            let output = std::process::Command::new("cmd.exe")
                .args(["/D", "/C", "mklink", "/J"])
                // mklink treats forward slashes as switches, unlike Rust's
                // Windows filesystem APIs, which accept either separator.
                .arg(link.to_string_lossy().replace('/', "\\"))
                .arg(outside.to_string_lossy().replace('/', "\\"))
                .creation_flags(0x08000000) // CREATE_NO_WINDOW
                .output()
                .expect("create test directory junction");
            assert!(
                output.status.success(),
                "junction creation failed: {:?}",
                output
            );
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert_eq!(
            link.join("mcp.json").canonicalize().unwrap(),
            outside.join("mcp.json").canonicalize().unwrap(),
            "fixture must actually resolve outside the plugin root"
        );
        f.write(
            ".codex-plugin/plugin.json",
            json!({"name":"demo","mcpServers":"linked-directory/mcp.json"}),
        );
        let error = f.parse().err().expect("outside MCP file must be rejected");
        #[cfg(windows)]
        std::fs::remove_dir(&link).expect("remove junction itself, not its target");
        #[cfg(unix)]
        std::fs::remove_file(&link).unwrap();
        assert!(outside.join("mcp.json").is_file());
        assert!(error.contains("escapes plugin root"), "{error}");
    }
}
