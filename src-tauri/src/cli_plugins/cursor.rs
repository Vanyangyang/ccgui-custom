//! Read-only Cursor Agent plugin metadata (not VSIX or Cursor Bridge).
//!
//! Evidence: https://cursor.com/docs/reference/plugins and /docs/plugins;
//! locally inspected Agent 2026.10.22-27dcf5f: loadUserLocalPlugins scans only
//! ~/.cursor/plugins/local immediate children. Marketplace activation comes
//! from listEnabledPlugins, NOT plugins/cache or its .cache-complete marker.
//! Claude registry imports are gated by importThirdPartyPlugins. No readable
//! authoritative value for that gate was found; do not infer it from Claude's
//! enabledPlugins. Workspace hooks and remote policy are deliberately not run.
use serde_json::Value;
use std::{
    collections::BTreeSet,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

const LIMIT: u64 = 10 * 1024 * 1024;
const MAX_PLUGINS: usize = 4096;
const MANIFESTS: [&str; 3] = [
    ".cursor-plugin/plugin.json",
    ".claude-plugin/plugin.json",
    "plugin.json",
];

// No Serialize or Debug on any type containing raw MCP configuration.
pub(super) struct CursorDiscovery {
    pub plugins: Vec<CursorPlugin>,
    pub warnings: Vec<String>,
}

pub(super) struct CursorPlugin {
    pub id: String,
    pub name: String,
    pub version: Option<String>,
    /// User scope, discovered through Cursor's user-local loading source.
    pub scope: &'static str,
    pub source_kind: &'static str,
    pub project_path: Option<String>,
    pub source_path: String,
    pub manifest_path: String,
    /// None: policy, marketplace precedence and runtime state are unobserved.
    pub enabled: Option<bool>,
    pub mcp_servers: Vec<CursorMcpServer>,
    /// Describes static declarations only, never runtime activation or trust.
    pub mcp_servers_known: bool,
}

pub(super) struct CursorMcpServer {
    pub name: String,
    pub source_path: String,
    pub config: Value,
}

/// `home` is the user's home, not ~/.cursor. `workspace` is an already validated
/// local workspace supplied by the host. No guessed project plugin directories
/// or arbitrary settings are read. User/project marketplace registrations are
/// remote; a cache scan cannot recover their scope, policy or enabled status.
#[cfg(test)]
fn read_plugins_at(home: &Path, workspace: Option<&Path>) -> CursorDiscovery {
    read_plugins_from_cursor_home(&home.join(".cursor"), workspace)
}

pub(super) fn read_plugins_from_cursor_home(cursor_home: &Path, workspace: Option<&Path>) -> CursorDiscovery {
    let mut result = CursorDiscovery { plugins: Vec::new(), warnings: vec![
        "Cursor: partial read-only inventory; marketplace user/project activation requires the remote enabled-plugin registry. Cache directories are not registrations and are not enumerated.".into(),
        "Cursor: local imports may be blocked by policy or shadowed by marketplace installs; enabled and MCP activation remain unknown. Gated Claude imports and dynamic workspaceOpen plugin paths are not evaluated.".into(),
    ] };
    if workspace.is_some() {
        result.warnings.push("Cursor: project scope cannot be established from local files; no project entries were inferred.".into());
    }
    let local = cursor_home.join("plugins/local");
    let directory = match fs::read_dir(&local) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return result,
        Err(_) => {
            result
                .warnings
                .push("Cursor: local plugin directory is unreadable".into());
            return result;
        }
    };
    let base = match local.canonicalize() {
        Ok(value) => value,
        Err(_) => {
            result
                .warnings
                .push("Cursor: cannot resolve local plugin directory".into());
            return result;
        }
    };
    let mut paths = Vec::new();
    for item in directory.take(MAX_PLUGINS + 1) {
        match item {
            Ok(item) => paths.push(item.path()),
            Err(_) => result
                .warnings
                .push("Cursor: could not read a local plugin directory entry".into()),
        }
    }
    paths.sort();
    if paths.len() > MAX_PLUGINS {
        paths.truncate(MAX_PLUGINS);
        result
            .warnings
            .push("Cursor: local plugin enumeration limit reached".into());
    }
    let mut seen = BTreeSet::new();
    for path in paths {
        let Some(folder) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if folder.starts_with('.') {
            continue;
        }
        let root = match path.canonicalize() {
            Ok(root) if root.starts_with(&base) && root != base => root,
            _ => {
                result.warnings.push(format!(
                    "Cursor: rejected local plugin path {}",
                    path.display()
                ));
                continue;
            }
        };
        if !root.is_dir() || !seen.insert(root.clone()) {
            continue;
        }
        match read_bundle(&root, folder, &path) {
            Ok((plugin, warnings)) => {
                result.plugins.push(plugin);
                result.warnings.extend(warnings);
            }
            Err(error) => result
                .warnings
                .push(format!("Cursor: {}: {error}", path.display())),
        }
    }
    result
}

/// Both lexical and resolved boundaries are checked before opening any file.
/// Reject Windows drive/ADS/UNC syntax even when tested on Unix. No expansion.
fn confined(root: &Path, relative: &str) -> Result<PathBuf, &'static str> {
    if relative.is_empty() || relative.contains(['\\', ':', '\0']) {
        return Err("unsafe plugin reference");
    }
    let path = Path::new(relative);
    if path
        .components()
        .any(|part| !matches!(part, Component::Normal(_) | Component::CurDir))
    {
        return Err("plugin reference must stay inside its root");
    }
    let canonical = root
        .join(path)
        .canonicalize()
        .map_err(|_| "plugin reference is missing or unreadable")?;
    if !canonical.starts_with(root) || canonical == root {
        return Err("plugin reference escapes root");
    }
    Ok(canonical)
}

fn json_file(root: &Path, relative: &str) -> Result<(Value, PathBuf), &'static str> {
    let path = confined(root, relative)?;
    let file = fs::File::open(&path).map_err(|_| "cannot open plugin metadata")?;
    let metadata = file
        .metadata()
        .map_err(|_| "cannot inspect plugin metadata")?;
    if !metadata.is_file() || metadata.len() > LIMIT {
        return Err("plugin metadata is not a bounded regular file");
    }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "cannot read plugin metadata")?;
    if bytes.len() as u64 > LIMIT {
        return Err("plugin metadata size limit exceeded");
    }
    // Never include serde errors or raw document text: either can contain secrets.
    let value = serde_json::from_slice(&bytes).map_err(|_| "invalid plugin JSON")?;
    Ok((value, path))
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 256
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name.as_bytes()[name.len() - 1].is_ascii_alphanumeric()
}

fn read_bundle(
    root: &Path,
    folder: &str,
    source: &Path,
) -> Result<(CursorPlugin, Vec<String>), String> {
    let mut warnings = Vec::new();
    let mut manifest = None;
    for relative in MANIFESTS {
        // symlink_metadata distinguishes absent files from broken links.
        match fs::symlink_metadata(root.join(relative)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("cannot inspect plugin manifest".into()),
            Ok(_) => (),
        }
        // A higher-priority malformed manifest must not silently activate a
        // different format; report uncertainty rather than guessing fallback.
        let (value, path) = json_file(root, relative)?;
        let name = value
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| valid_name(name))
            .ok_or("manifest has no valid plugin name")?;
        if !value.is_object() {
            return Err("manifest must be an object".into());
        }
        manifest = Some((name.to_string(), value, path));
        break;
    }
    let (name, manifest, manifest_path) = manifest.ok_or("no recognized plugin manifest")?;
    let version = match manifest.get("version") {
        None => None,
        Some(Value::String(value)) => Some(value.clone()),
        _ => return Err("invalid manifest version".into()),
    };
    let mut defaults: Vec<CursorMcpServer> = Vec::new();
    // Agent 2026.10.22's Ot loader merges both defaults (first name wins),
    // then applies manifest overrides. This is more specific than the public
    // docs' shorthand "overrides default discovery"; keep provenance per name.
    for relative in [".mcp.json", "mcp.json"] {
        match fs::symlink_metadata(root.join(relative)) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            _ => (),
        }
        match json_file(root, relative).and_then(|(v, p)| parse_servers(&v, &p)) {
            Ok(items) => {
                for item in items {
                    if !defaults.iter().any(|server| server.name == item.name) {
                        defaults.push(item);
                    }
                }
            }
            Err(error) => warnings.push(format!("Cursor: {}: {error}", source.display())),
        }
    }
    let mut servers = Vec::new();
    if let Some(declaration) = manifest.get("mcpServers") {
        let refs: Vec<&Value> = match declaration {
            Value::Array(values) => values.iter().collect(),
            value => vec![value],
        };
        for value in refs {
            let loaded = match value {
                Value::String(reference) => {
                    json_file(root, reference).and_then(|(v, p)| parse_servers(&v, &p))
                }
                Value::Object(_) => parse_servers(value, &manifest_path),
                _ => Err("invalid mcpServers declaration"),
            };
            match loaded {
                Ok(items) => servers.extend(items),
                Err(error) => warnings.push(format!("Cursor: {}: {error}", source.display())),
            }
        }
    }
    let mut names = BTreeSet::new();
    if servers
        .iter()
        .any(|server| !names.insert(server.name.clone()))
    {
        servers.clear();
        warnings.push(format!(
            "Cursor: {}: duplicate MCP names; ambiguous declarations omitted",
            source.display()
        ));
    } else {
        for item in servers {
            defaults.retain(|server| server.name != item.name);
            defaults.push(item);
        }
        servers = defaults;
    }
    // No marketplace fallback, variables lookup, interpolation or MCP launch.
    Ok((
        CursorPlugin {
            id: format!("user-local:{folder}"),
            name,
            version,
            scope: "user",
            source_kind: "user-local",
            project_path: None,
            source_path: source.to_string_lossy().into_owned(),
            manifest_path: manifest_path.to_string_lossy().into_owned(),
            enabled: None,
            mcp_servers: servers,
            mcp_servers_known: warnings.is_empty(),
        },
        warnings,
    ))
}

fn parse_servers(value: &Value, path: &Path) -> Result<Vec<CursorMcpServer>, &'static str> {
    let object = value
        .as_object()
        .ok_or("MCP configuration must be an object")?;
    let servers = match object.get("mcpServers") {
        Some(value) => value.as_object().ok_or("mcpServers must be an object")?,
        None => object,
    };
    let mut result = Vec::new();
    for (name, config) in servers {
        if name == "$schema" {
            continue;
        }
        if name.is_empty()
            || name.chars().any(char::is_control)
            || !config.is_object()
            || !(config.get("command").is_some_and(Value::is_string)
                || config.get("url").is_some_and(Value::is_string))
        {
            return Err("invalid MCP server declaration");
        }
        result.push(CursorMcpServer {
            name: name.clone(),
            source_path: path.to_string_lossy().into_owned(),
            config: config.clone(),
        });
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("ccgui-cursor-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn write(&self, relative: &str, text: &str) {
            let path = self.0.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
        fn bundle(&self, text: &str) {
            self.write(
                ".cursor/plugins/local/demo/.cursor-plugin/plugin.json",
                text,
            );
        }
        fn read(&self) -> CursorDiscovery {
            read_plugins_at(&self.0, None)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn cache_and_guessed_project_directories_are_not_registrations() {
        let f = Fixture::new();
        f.write(
            ".cursor/plugins/cache/store/demo/v1/.cursor-plugin/plugin.json",
            r#"{"name":"demo"}"#,
        );
        f.write(
            ".cursor/plugins/project/demo/plugin.json",
            r#"{"name":"demo"}"#,
        );
        let result = read_plugins_at(&f.0, Some(&f.0));
        assert!(result.plugins.is_empty());
        assert!(!result.warnings.is_empty());
    }
    #[test]
    fn local_mcp_has_unknown_activation_and_keeps_raw_config_internal() {
        let f = Fixture::new();
        f.bundle(r#"{"name":"demo","version":"1","mcpServers":{"service":{"command":"never-run","env":{"TOKEN":"private-value"}}}}"#);
        let result = f.read();
        let p = &result.plugins[0];
        assert_eq!(p.enabled, None);
        assert_eq!(p.scope, "user");
        assert_eq!(p.source_kind, "user-local");
        assert!(p.project_path.is_none());
        assert!(p.mcp_servers_known);
        assert_eq!(p.mcp_servers[0].config["env"]["TOKEN"], "private-value");
        assert!(!result.warnings.join(" ").contains("private-value"));
    }
    #[test]
    fn explicit_array_overrides_default_and_records_each_source() {
        let f = Fixture::new();
        f.bundle(r#"{"name":"demo","mcpServers":["config/a.json",{"b":{"url":"https://example.invalid"}}]}"#);
        f.write(
            ".cursor/plugins/local/demo/config/a.json",
            r#"{"mcpServers":{"a":{"command":"never-run"}}}"#,
        );
        f.write(
            ".cursor/plugins/local/demo/mcp.json",
            r#"{"mcpServers":{"a":{"command":"overridden"},"c":{"command":"second-default"},"d":{"command":"retained"}}}"#,
        );
        f.write(
            ".cursor/plugins/local/demo/.mcp.json",
            r#"{"mcpServers":{"c":{"command":"first-default"}}}"#,
        );
        let result = f.read();
        let p = &result.plugins[0];
        assert!(p.mcp_servers_known);
        assert_eq!(p.mcp_servers.len(), 4);
        let a = p.mcp_servers.iter().find(|s| s.name == "a").unwrap();
        assert!(a.source_path.ends_with("a.json"));
        assert_eq!(a.config["command"], "never-run");
        let b = p.mcp_servers.iter().find(|s| s.name == "b").unwrap();
        assert_eq!(b.source_path, p.manifest_path);
        let c = p.mcp_servers.iter().find(|s| s.name == "c").unwrap();
        assert_eq!(c.config["command"], "first-default");
    }
    #[test]
    fn unsafe_references_do_not_expose_outside_contents() {
        for reference in [
            "../outside.json",
            "/outside.json",
            "C:/outside.json",
            "a:stream",
            "a\\b.json",
        ] {
            let f = Fixture::new();
            f.bundle(&serde_json::json!({"name":"demo", "mcpServers":reference}).to_string());
            let result = f.read();
            assert!(result.plugins[0].mcp_servers.is_empty());
            assert!(!result.plugins[0].mcp_servers_known);
        }
    }
    #[test]
    fn malformed_json_and_duplicate_names_are_unknown() {
        let f = Fixture::new();
        f.bundle(
            r#"{"name":"demo","mcpServers":[{"s":{"command":"one"}},{"s":{"command":"two"}}]}"#,
        );
        let result = f.read();
        assert!(result.plugins[0].mcp_servers.is_empty());
        assert!(!result.plugins[0].mcp_servers_known);
        f.bundle("{private-token invalid json");
        let result = f.read();
        assert!(result.plugins.is_empty());
        assert!(!result.warnings.join(" ").contains("private-token"));
    }
    #[test]
    fn defaults_manifest_priority_and_empty_override() {
        let f = Fixture::new();
        f.bundle(r#"{"name":"demo","mcpServers":{}}"#);
        f.write(
            ".cursor/plugins/local/demo/plugin.json",
            r#"{"name":"other"}"#,
        );
        f.write(
            ".cursor/plugins/local/demo/mcp.json",
            r#"{"mcpServers":{"fallback":{"command":"never"}}}"#,
        );
        let result = f.read();
        assert_eq!(result.plugins[0].name, "demo");
        assert_eq!(result.plugins[0].mcp_servers[0].name, "fallback");
        f.bundle(r#"{"name":"demo"}"#);
        let result = f.read();
        assert_eq!(result.plugins[0].mcp_servers[0].name, "fallback");
    }
    #[test]
    fn excessive_file_is_rejected() {
        let f = Fixture::new();
        f.bundle(r#"{"name":"demo"}"#);
        let file = fs::File::create(f.0.join(".cursor/plugins/local/demo/mcp.json")).unwrap();
        file.set_len(LIMIT + 1).unwrap();
        assert!(!f.read().plugins[0].mcp_servers_known);
    }
    #[test]
    fn symlink_escape_is_rejected() {
        let f = Fixture::new();
        f.bundle(r#"{"name":"demo","mcpServers":"escape/mcp.json"}"#);
        f.write(
            "outside/mcp.json",
            r#"{"mcpServers":{"secret":{"command":"never"}}}"#,
        );
        let target = f.0.join("outside");
        let link = f.0.join(".cursor/plugins/local/demo/escape");
        directory_link(&target, &link);
        let result = f.read();
        assert!(result.plugins[0].mcp_servers.is_empty());
        assert!(!result.plugins[0].mcp_servers_known);
        let link = f.0.join(".cursor/plugins/local/external");
        directory_link(&target, &link);
        assert_eq!(f.read().plugins.len(), 1);
    }

    fn directory_link(target: &Path, link: &Path) {
        // Windows junctions exercise canonical-path escapes without requiring
        // SeCreateSymbolicLinkPrivilege. Only test-owned UUID paths are used;
        // values pass through environment variables, never shell interpolation.
        #[cfg(windows)]
        {
            let status = std::process::Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-Command",
                    "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:CCGUI_CURSOR_TEST_LINK -Target $env:CCGUI_CURSOR_TEST_TARGET | Out-Null"])
                .env("CCGUI_CURSOR_TEST_LINK", link)
                .env("CCGUI_CURSOR_TEST_TARGET", target)
                .status().unwrap();
            assert!(status.success());
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
    }
}
