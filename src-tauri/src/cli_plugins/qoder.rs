//! Read-only Qoder / Qoder CN plugin inspection; the caller owns CLI invocation.
//!
//! Evidence (2026-10-31): https://docs.qoder.com/cli/plugins-reference and
//! https://docs.qoder.cn/cli/plugins-reference document projectPath and effective
//! enabled semantics, manifest MCP references, and .mcp.json > mcp.json fallback.
//! They do NOT publish a complete list JSON schema. Array / {plugins: array}
//! envelopes and id/name/version/scope/installPath (or path) are conservative
//! compatibility inputs, fixture-tested, NOT a claim of native CLI verification.
//! No home/config directory assumptions are made for either distribution.

use serde_json::Value;
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

const JSON_LIMIT: usize = 8 * 1024 * 1024;

// Intentionally no Debug/Serialize: raw MCP config may contain credentials.
pub(crate) struct QoderPlugin {
    pub id: Option<String>,
    pub name: Option<String>,
    pub version: Option<String>,
    pub scope: Option<String>,
    pub project_path: Option<String>,
    pub enabled: Option<bool>,
    pub plugin_root: Option<PathBuf>,
    pub mcp_servers: Vec<(String, Value)>,
    pub warnings: Vec<String>,
}

pub(crate) struct QoderInventory {
    pub plugins: Vec<QoderPlugin>,
    /// Includes rejected rows, identified only by zero-based row index.
    pub warnings: Vec<String>,
}

/// `command_cwd` MUST be the actual directory used for plugins list --json.
/// Call separately for each engine; do not reuse one engine's inventory for the
/// other. Unknown scope / missing project attribution disables MCP inspection.
/// Errors and warnings contain fixed labels only, never source JSON or IO errors.
pub(crate) fn parse_list(json: &str, command_cwd: &Path) -> Result<QoderInventory, String> {
    parse_list_inner(json, command_cwd, false)
}

/// CN-only compatibility: .claude-plugin/plugin.json is considered only when
/// the .qoder-plugin directory is absent (CN plugin reference, 2026-10-31).
/// The command_cwd and confidentiality contract is identical to parse_list.
pub(crate) fn parse_list_cn(json: &str, command_cwd: &Path) -> Result<QoderInventory, String> {
    parse_list_inner(json, command_cwd, true)
}

fn parse_list_inner(json: &str, command_cwd: &Path, cn: bool) -> Result<QoderInventory, String> {
    if json.len() > JSON_LIMIT {
        return Err("Qoder inventory exceeds size limit".into());
    }
    let value: Value = serde_json::from_str(json).map_err(|_| "Invalid Qoder inventory JSON")?;
    let rows = value
        .as_array()
        .or_else(|| value.get("plugins").and_then(Value::as_array))
        .ok_or("Unsupported Qoder inventory envelope")?;
    let cwd = local_root(command_cwd).map_err(str::to_owned)?;
    let mut result = QoderInventory {
        plugins: Vec::new(),
        warnings: Vec::new(),
    };
    for (index, row) in rows.iter().enumerate() {
        if !row.is_object() {
            result
                .warnings
                .push(format!("Row {index}: expected plugin object"));
            continue;
        }
        let mut warnings = Vec::new();
        let project_path = string_field(row, "projectPath", false, &mut warnings);
        if let Some(project) = project_path.as_deref() {
            match local_root(Path::new(project)) {
                Ok(project) if project == cwd => {}
                Ok(_) => continue,
                Err(_) => {
                    result.warnings.push(format!(
                        "Row {index}: projectPath cannot be verified; excluded"
                    ));
                    continue;
                }
            }
        } else if row.get("projectPath").is_some_and(|v| !v.is_null()) {
            result
                .warnings
                .push(format!("Row {index}: invalid projectPath; excluded"));
            continue;
        }
        let scope = string_field(row, "scope", true, &mut warnings);
        let attributed = match scope.as_deref() {
            Some("user") => true,
            Some("project" | "local") if project_path.is_some() => true,
            Some("project" | "local") => {
                warnings.push("Project installation lacks projectPath".into());
                false
            }
            _ => {
                warnings.push("Installation scope is unknown".into());
                false
            }
        };
        let id = string_field(row, "id", true, &mut warnings);
        let name = string_field(row, "name", true, &mut warnings);
        let version = string_field(row, "version", false, &mut warnings);
        let enabled = match row.get("enabled") {
            Some(Value::Bool(v)) if attributed => Some(*v),
            Some(Value::Bool(_)) => None,
            _ => {
                warnings.push("Effective enabled state is missing or invalid".into());
                None
            }
        };
        let install = string_field(row, "installPath", false, &mut warnings);
        let path = string_field(row, "path", false, &mut warnings);
        let root_text = if install.is_some() && path.is_some() && install != path {
            warnings.push("Conflicting plugin root fields".into());
            None
        } else {
            install.or(path)
        };
        let plugin_root = root_text.map(PathBuf::from);
        let mut mcp_servers = Vec::new();
        if attributed {
            match plugin_root.as_deref() {
                Some(root) => match read_declarations(root, cn) {
                    Ok(servers) => mcp_servers = servers,
                    Err(message) => warnings.push(message.into()),
                },
                None => warnings.push("Plugin root is missing or invalid".into()),
            }
        }
        result.plugins.push(QoderPlugin {
            id,
            name,
            version,
            scope,
            project_path,
            enabled,
            plugin_root,
            mcp_servers,
            warnings,
        });
    }
    Ok(result)
}

fn string_field(
    row: &Value,
    key: &'static str,
    required: bool,
    warnings: &mut Vec<String>,
) -> Option<String> {
    match row.get(key) {
        Some(Value::String(v)) if !v.trim().is_empty() => Some(v.clone()),
        None | Some(Value::Null) if !required => None,
        _ => {
            warnings.push(format!("Missing or invalid {key}"));
            None
        }
    }
}

fn local_root(path: &Path) -> Result<PathBuf, &'static str> {
    let text = path.to_string_lossy();
    if !path.is_absolute()
        || text.starts_with("\\\\")
        || text.starts_with("//")
        || text.contains("://")
    {
        return Err("Expected absolute local directory");
    }
    let root = fs::canonicalize(path).map_err(|_| "Local directory is missing or inaccessible")?;
    // Windows canonical local paths use \\?\C:\; UNC targets remain forbidden.
    let resolved = root.to_string_lossy();
    if resolved.starts_with("\\\\?\\UNC\\") || resolved.starts_with("//") {
        return Err("Network directory is forbidden");
    }
    if !root.is_dir() {
        return Err("Expected directory");
    }
    Ok(root)
}

fn read_declarations(path: &Path, cn: bool) -> Result<Vec<(String, Value)>, &'static str> {
    let root = local_root(path)?;
    // Check directory existence, not manifest existence. A present directory
    // with a missing/invalid manifest must never select the compatibility file.
    // symlink_metadata also keeps dangling links from triggering fallback;
    // read_json performs the link/reparse and containment checks before reads.
    let manifest_path = if cn {
        match fs::symlink_metadata(root.join(".qoder-plugin")) {
            Ok(_) => ".qoder-plugin/plugin.json",
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => ".claude-plugin/plugin.json",
            Err(_) => return Err("Plugin manifest directory is inaccessible"),
        }
    } else {
        ".qoder-plugin/plugin.json"
    };
    if let Some(manifest) = read_json(&root, manifest_path)? {
        if !manifest.is_object() {
            return Err("Plugin manifest must be an object");
        }
        if let Some(declaration) = manifest.get("mcpServers") {
            return match declaration {
                Value::Object(_) => servers(declaration.clone()),
                Value::String(reference) => {
                    let config =
                        read_json(&root, reference)?.ok_or("Explicit MCP reference is missing")?;
                    wrapped_servers(config)
                }
                _ => Err("Manifest mcpServers must be an object or local JSON reference"),
            };
        }
    }
    // Fallback only on absence, never on malformed or inaccessible sources.
    for name in [".mcp.json", "mcp.json"] {
        if let Some(config) = read_json(&root, name)? {
            return wrapped_servers(config);
        }
    }
    Ok(Vec::new())
}

fn wrapped_servers(mut config: Value) -> Result<Vec<(String, Value)>, &'static str> {
    let object = config.as_object_mut().ok_or("MCP file must be an object")?;
    servers(
        object
            .remove("mcpServers")
            .ok_or("MCP file lacks mcpServers")?,
    )
}

fn servers(config: Value) -> Result<Vec<(String, Value)>, &'static str> {
    let object = config
        .as_object()
        .ok_or("MCP declaration must be an object")?;
    if object
        .iter()
        .any(|(name, config)| name.trim().is_empty() || !config.is_object())
    {
        return Err("Invalid MCP server declaration");
    }
    // No interpolation, process execution, remote requests, or logging.
    Ok(object
        .iter()
        .map(|(name, config)| (name.clone(), config.clone()))
        .collect())
}

fn read_json(root: &Path, reference: &str) -> Result<Option<Value>, &'static str> {
    // Reject URI schemes, Windows drive/ADS syntax, UNC, traversal on either OS,
    // and variable expansion. References are plugin-root-relative, never manifest-relative.
    if reference.is_empty()
        || reference.contains([':', '\\', '$', '\0'])
        || Path::new(reference).is_absolute()
        || Path::new(reference)
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
        || Path::new(reference).extension().and_then(|v| v.to_str()) != Some("json")
    {
        return Err("Unsafe MCP or manifest reference");
    }
    let mut target = root.to_path_buf();
    for component in Path::new(reference).components() {
        target.push(component);
        match fs::symlink_metadata(&target) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err("Linked plugin declarations are forbidden");
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x400 != 0 {
                        return Err("Reparse plugin declarations are forbidden");
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("Plugin declaration is inaccessible"),
        }
    }
    let resolved =
        fs::canonicalize(&target).map_err(|_| "Plugin declaration cannot be resolved")?;
    if !resolved.starts_with(root) {
        return Err("Plugin declaration escapes root");
    }
    let file = fs::File::open(&resolved).map_err(|_| "Plugin declaration cannot be opened")?;
    if !file
        .metadata()
        .map_err(|_| "Plugin declaration metadata unavailable")?
        .is_file()
    {
        return Err("Plugin declaration is not a regular file");
    }
    let mut bytes = Vec::new();
    file.take((JSON_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "Plugin declaration cannot be read")?;
    if bytes.len() > JSON_LIMIT {
        return Err("Plugin declaration exceeds size limit");
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "Malformed plugin declaration JSON")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("ccgui-qoder-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(path.join(".qoder-plugin")).unwrap();
            Self(path)
        }
        fn write(&self, name: &str, value: Value) {
            fs::write(self.0.join(name), serde_json::to_vec(&value).unwrap()).unwrap();
        }
        fn row(&self) -> Value {
            json!({"id":"sample@local","name":"sample","version":"1.0.0","scope":"user", "enabled":true,"installPath":self.0})
        }
        fn parse(&self, rows: Value) -> QoderInventory {
            parse_list(&rows.to_string(), &self.0).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn scopes_filter_other_projects_and_keep_distinct_installations() {
        let f = Fixture::new();
        let other = Fixture::new();
        let user = f.row();
        let mut project = f.row();
        project["scope"] = json!("project");
        project["projectPath"] = json!(f.0);
        project["enabled"] = json!(false);
        let mut local = project.clone();
        local["scope"] = json!("local");
        let mut excluded = project.clone();
        excluded["projectPath"] = json!(other.0);
        let got = f.parse(json!([user, project, local, excluded]));
        assert_eq!(got.plugins.len(), 3);
        assert_eq!(got.plugins[0].enabled, Some(true));
        assert_eq!(got.plugins[1].enabled, Some(false));
        assert_eq!(got.plugins[2].scope.as_deref(), Some("local"));
        assert_eq!(got.plugins[1].project_path.as_deref(), f.0.to_str());
        assert!(got.plugins.iter().all(|p| p.warnings.is_empty()));
    }

    #[test]
    fn missing_fields_do_not_invent_metadata_or_state() {
        let f = Fixture::new();
        let got = f.parse(json!({"plugins":[{}, 7]}));
        let p = &got.plugins[0];
        assert!(p.id.is_none() && p.name.is_none() && p.version.is_none());
        assert!(p.scope.is_none() && p.enabled.is_none() && p.plugin_root.is_none());
        assert!(!p.warnings.is_empty());
        assert_eq!(got.warnings.len(), 1);
        let mut row = f.row();
        row["scope"] = json!("project");
        f.write(".mcp.json", json!({"mcpServers":{"server":{}}}));
        let got = f.parse(json!([row]));
        assert!(got.plugins[0].enabled.is_none());
        assert!(got.plugins[0].mcp_servers.is_empty());
    }

    #[test]
    fn manifest_inline_and_reference_override_conventions() {
        let f = Fixture::new();
        f.write(".mcp.json", json!({"mcpServers":{"dot":{}}}));
        f.write("mcp.json", json!({"mcpServers":{"plain":{}}}));
        f.write(
            "custom.json",
            json!({"mcpServers":{"reference":{"env":{"TOKEN":"fixture-secret"}}}}),
        );
        f.write(
            ".qoder-plugin/plugin.json",
            json!({"name":"sample","mcpServers":"./custom.json"}),
        );
        let got = f.parse(json!([f.row()]));
        assert_eq!(got.plugins[0].mcp_servers[0].0, "reference");
        assert_eq!(
            got.plugins[0].mcp_servers[0].1["env"]["TOKEN"],
            "fixture-secret"
        );
        f.write(
            ".qoder-plugin/plugin.json",
            json!({"mcpServers":{"inline":{}}}),
        );
        assert_eq!(
            f.parse(json!([f.row()])).plugins[0].mcp_servers[0].0,
            "inline"
        );
        f.write(".qoder-plugin/plugin.json", json!({"mcpServers":{}}));
        assert!(f.parse(json!([f.row()])).plugins[0].mcp_servers.is_empty());
    }

    #[test]
    fn fallback_is_only_for_absent_sources() {
        let f = Fixture::new();
        f.write("mcp.json", json!({"mcpServers":{"plain":{}}}));
        assert_eq!(
            f.parse(json!([f.row()])).plugins[0].mcp_servers[0].0,
            "plain"
        );
        f.write(".mcp.json", json!({"mcpServers":{"dot":{}}}));
        assert_eq!(f.parse(json!([f.row()])).plugins[0].mcp_servers[0].0, "dot");
        fs::write(f.0.join(".mcp.json"), "malformed fixture-secret").unwrap();
        let got = f.parse(json!([f.row()]));
        assert!(got.plugins[0].mcp_servers.is_empty());
        assert_eq!(
            got.plugins[0].warnings,
            ["Malformed plugin declaration JSON"]
        );
        f.write(
            ".qoder-plugin/plugin.json",
            json!({"mcpServers":"missing.json"}),
        );
        assert_eq!(
            f.parse(json!([f.row()])).plugins[0].warnings,
            ["Explicit MCP reference is missing"]
        );
        fs::write(f.0.join(".qoder-plugin/plugin.json"), "broken").unwrap();
        assert_eq!(
            f.parse(json!([f.row()])).plugins[0].warnings,
            ["Malformed plugin declaration JSON"]
        );
    }

    #[test]
    fn traversal_urls_absolute_paths_and_executable_references_are_rejected() {
        let f = Fixture::new();
        for reference in [
            "../outside.json",
            "https://example.invalid/secret.json",
            "file:///secret.json",
            "/tmp/secret.json",
            "C:\\secret.json",
            "..\\secret.json",
            "${HOME}/secret.json",
            "run.js",
        ] {
            f.write(".qoder-plugin/plugin.json", json!({"mcpServers":reference}));
            let got = f.parse(json!([f.row()]));
            assert!(got.plugins[0].mcp_servers.is_empty());
            assert_eq!(
                got.plugins[0].warnings,
                ["Unsafe MCP or manifest reference"]
            );
        }
    }

    #[test]
    fn malformed_types_and_envelopes_are_not_empty_success() {
        let f = Fixture::new();
        assert!(parse_list("{}", &f.0).is_err());
        assert!(parse_list("broken fixture-secret", &f.0).is_err());
        for declaration in [json!(null), json!([]), json!({"bad":"fixture-secret"})] {
            f.write(
                ".qoder-plugin/plugin.json",
                json!({"mcpServers":declaration}),
            );
            let got = f.parse(json!([f.row()]));
            assert!(!got.plugins[0].warnings.is_empty());
            assert!(!got.plugins[0].warnings.join(" ").contains("fixture-secret"));
        }
    }

    #[test]
    fn cn_compatibility_manifest_only_when_native_directory_absent() {
        let f = Fixture::new();
        fs::create_dir(f.0.join(".claude-plugin")).unwrap();
        f.write(
            ".claude-plugin/plugin.json",
            json!({"mcpServers":"compat.json"}),
        );
        f.write("compat.json", json!({"mcpServers":{"compat":{}}}));
        f.write(".mcp.json", json!({"mcpServers":{"conventional":{}}}));
        let input = json!([f.row()]).to_string();
        // Existing but empty native directory prevents compatibility fallback.
        assert_eq!(
            parse_list_cn(&input, &f.0).unwrap().plugins[0].mcp_servers[0].0,
            "conventional"
        );
        fs::remove_dir(f.0.join(".qoder-plugin")).unwrap();
        assert_eq!(
            parse_list_cn(&input, &f.0).unwrap().plugins[0].mcp_servers[0].0,
            "compat"
        );
        // Do not assume the CN-only convention applies to international Qoder.
        assert_eq!(
            parse_list(&input, &f.0).unwrap().plugins[0].mcp_servers[0].0,
            "conventional"
        );
    }

    #[test]
    fn cn_native_manifest_wins_and_damage_never_selects_compatibility() {
        let f = Fixture::new();
        fs::create_dir(f.0.join(".claude-plugin")).unwrap();
        f.write(
            ".claude-plugin/plugin.json",
            json!({"mcpServers":{"compat":{}}}),
        );
        f.write(
            ".qoder-plugin/plugin.json",
            json!({"mcpServers":{"native":{}}}),
        );
        let input = json!([f.row()]).to_string();
        assert_eq!(
            parse_list_cn(&input, &f.0).unwrap().plugins[0].mcp_servers[0].0,
            "native"
        );
        fs::write(f.0.join(".qoder-plugin/plugin.json"), "broken").unwrap();
        let got = parse_list_cn(&input, &f.0).unwrap();
        assert!(got.plugins[0].mcp_servers.is_empty());
        assert_eq!(
            got.plugins[0].warnings,
            ["Malformed plugin declaration JSON"]
        );
    }

    #[test]
    fn cn_compatibility_manifest_keeps_validation_and_no_error_fallback() {
        let f = Fixture::new();
        fs::remove_dir(f.0.join(".qoder-plugin")).unwrap();
        fs::create_dir(f.0.join(".claude-plugin")).unwrap();
        f.write(".mcp.json", json!({"mcpServers":{"conventional":{}}}));
        let input = json!([f.row()]).to_string();
        for (declaration, warning) in [
            ("../outside.json", "Unsafe MCP or manifest reference"),
            ("missing.json", "Explicit MCP reference is missing"),
        ] {
            f.write(
                ".claude-plugin/plugin.json",
                json!({"mcpServers":declaration}),
            );
            let got = parse_list_cn(&input, &f.0).unwrap();
            assert!(got.plugins[0].mcp_servers.is_empty());
            assert_eq!(got.plugins[0].warnings, [warning]);
        }
        fs::write(f.0.join(".claude-plugin/plugin.json"), "broken").unwrap();
        assert_eq!(
            parse_list_cn(&input, &f.0).unwrap().plugins[0].warnings,
            ["Malformed plugin declaration JSON"]
        );
        f.write(".claude-plugin/plugin.json", json!({"name":"compat"}));
        assert_eq!(
            parse_list_cn(&input, &f.0).unwrap().plugins[0].mcp_servers[0].0,
            "conventional"
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_rejected() {
        let f = Fixture::new();
        let outside = Fixture::new();
        outside.write("outside.json", json!({"mcpServers":{"secret":{}}}));
        std::os::unix::fs::symlink(outside.0.join("outside.json"), f.0.join(".mcp.json")).unwrap();
        assert_eq!(
            f.parse(json!([f.row()])).plugins[0].warnings,
            ["Linked plugin declarations are forbidden"]
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_link_escape_is_rejected() {
        let f = Fixture::new();
        let outside = Fixture::new();
        outside.write("outside.json", json!({"mcpServers":{"secret":{}}}));
        // Junction fixture creation does not require SeCreateSymbolicLinkPrivilege.
        // This command exists only in tests; production parsing executes nothing.
        let status = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(f.0.join("linked"))
            .arg(&outside.0)
            .output()
            .unwrap()
            .status;
        assert!(status.success(), "Could not create junction fixture");
        f.write(
            ".qoder-plugin/plugin.json",
            json!({"mcpServers":"linked/outside.json"}),
        );
        let got = f.parse(json!([f.row()]));
        assert!(got.plugins[0].mcp_servers.is_empty());
        assert!(got.plugins[0]
            .warnings
            .iter()
            .any(|w| w == "Linked plugin declarations are forbidden"
                || w == "Reparse plugin declarations are forbidden"));
    }
}
