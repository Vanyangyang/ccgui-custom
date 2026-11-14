//! Read-only declarations, not OpenCode's effective/runtime plugin inventory.
//! v1: https://opencode.ai/docs/plugins/
//! v2: https://opencode.ai/v2/docs/cli/plugins and /v2/docs/cli/config/.
//! No JS execution, package resolution, or evaluation of enablement rules.
use serde_json::Value;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const CONFIG_LIMIT: u64 = 1024 * 1024;
const DIRECTORY_LIMIT: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Plugin {
    /// Config specifier or local file/directory name; never a resolved npm identity.
    pub name: String,
    pub scope: &'static str,
    pub source_path: PathBuf,
    pub source_kind: &'static str,
    /// Present only for config declarations; preserves duplicate provenance.
    pub declaration_index: Option<usize>,
    pub enabled: Option<bool>,
    pub mcp_servers_known: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ScanError {
    pub path: PathBuf,
    pub code: &'static str,
}

#[derive(Debug, Default)]
pub(crate) struct Inventory {
    pub entries: Vec<Plugin>,
    /// Errors are per-source; an unreadable source never hides other sources.
    pub errors: Vec<ScanError>,
}

fn error(path: &Path, code: &'static str) -> ScanError {
    ScanError {
        path: path.to_owned(),
        code,
    }
}

/// Inspect every component, including the supplied root, without following
/// symlinks/reparse points. Missing paths are an empty source, other failures
/// are explicit. This is best-effort static inspection, not a race-proof sandbox.
fn metadata(path: &Path) -> Result<Option<fs::Metadata>, ScanError> {
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(error(path, "parent_component"));
    }
    let mut cursor = PathBuf::new();
    let mut last = None;
    for component in path.components() {
        cursor.push(component.as_os_str());
        let meta = match fs::symlink_metadata(&cursor) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(error(path, "metadata_failed")),
        };
        if is_link(&meta) {
            return Err(error(path, "symlink_not_scanned"));
        }
        last = Some(meta);
    }
    Ok(last)
}

fn is_link(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}

/// `user_config_dir` is the OpenCode config directory, not the user's home.
/// v2 cli.json is global-only: ~/.config/opencode/cli.json or
/// $XDG_CONFIG_HOME/opencode/cli.json. The caller resolves that config directory.
/// Only the supplied workspace is inspected (no ancestors, env overrides,
/// remote configuration, caches or runtime discovery).
///
/// The caller supplies the shared, strict JSONC parser.
/// Parser diagnostics are deliberately not returned: they may contain secrets.
pub(crate) fn scan<F>(user_config_dir: &Path, workspace: Option<&Path>, parse_jsonc: F) -> Inventory
where
    F: Fn(&str) -> Result<Value, String>,
{
    let mut result = Inventory::default();
    // No project cli.json or cli.jsonc: neither is documented by v2 settings.
    match config_entries(&user_config_dir.join("cli.json"), "user", &parse_jsonc) {
        Ok(entries) => result.entries.extend(entries),
        Err(e) => result.errors.push(e),
    }
    let mut roots = vec![(user_config_dir.to_owned(), "user")];
    if let Some(workspace) = workspace {
        roots.push((workspace.to_owned(), "project"));
    }
    for (root, scope) in &roots {
        for name in ["opencode.json", "opencode.jsonc"] {
            let path = root.join(name);
            match config_entries(&path, scope, &parse_jsonc) {
                Ok(entries) => result.entries.extend(entries),
                Err(e) => result.errors.push(e),
            }
        }
    }
    // OpenCode also accepts config files in the project's .opencode directory.
    if let Some(workspace) = workspace {
        for name in ["opencode.json", "opencode.jsonc"] {
            let path = workspace.join(".opencode").join(name);
            match config_entries(&path, "project", &parse_jsonc) {
                Ok(entries) => result.entries.extend(entries),
                Err(e) => result.errors.push(e),
            }
        }
    }
    for (root, scope) in roots {
        let path = if scope == "project" {
            root.join(".opencode/plugins")
        } else {
            root.join("plugins")
        };
        match local_entries(&path, scope) {
            Ok(mut local) => {
                result.entries.append(&mut local.entries);
                result.errors.append(&mut local.errors);
            }
            Err(e) => result.errors.push(e),
        }
    }
    result
}

fn config_entries<F>(
    path: &Path,
    scope: &'static str,
    parse_jsonc: &F,
) -> Result<Vec<Plugin>, ScanError>
where
    F: Fn(&str) -> Result<Value, String>,
{
    let Some(meta) = metadata(path)? else {
        return Ok(Vec::new());
    };
    if !meta.is_file() {
        return Err(error(path, "not_regular_file"));
    }
    if meta.len() > CONFIG_LIMIT {
        return Err(error(path, "config_size_limit"));
    }
    let file = fs::File::open(path).map_err(|_| error(path, "read_failed"))?;
    let mut bytes = Vec::new();
    file.take(CONFIG_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| error(path, "read_failed"))?;
    if bytes.len() as u64 > CONFIG_LIMIT {
        return Err(error(path, "config_size_limit"));
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| error(path, "invalid_utf8"))?;
    let cli = path.file_name().is_some_and(|name| name == "cli.json");
    let root: Value = if cli || path.extension().is_some_and(|ext| ext == "jsonc") {
        parse_jsonc(text).map_err(|_| error(path, "invalid_jsonc"))?
    } else {
        serde_json::from_str(text).map_err(|_| error(path, "invalid_json"))?
    };
    let object = root
        .as_object()
        .ok_or_else(|| error(path, "config_not_object"))?;
    let Some(plugins) = object.get(if cli { "plugins" } else { "plugin" }) else {
        return Ok(Vec::new());
    };
    let plugins = plugins.as_array().ok_or_else(|| {
        error(
            path,
            if cli {
                "plugins_not_array"
            } else {
                "plugin_not_array"
            },
        )
    })?;
    if plugins.len() > DIRECTORY_LIMIT {
        return Err(error(path, "declaration_count_limit"));
    }
    let mut entries = Vec::new();
    for (index, value) in plugins.iter().enumerate() {
        // Only the package field crosses the discovery boundary. Never
        // serialize options (which can contain credentials), or follow a
        // declared path/URL, including ../, absolute and file: specifiers.
        let specifier = if cli && value.is_object() {
            if value
                .get("options")
                .is_some_and(|options| !options.is_object())
            {
                return Err(error(path, "invalid_plugin_options"));
            }
            value.get("package").unwrap_or(&Value::Null)
        } else {
            value
        };
        let name = specifier
            .as_str()
            .filter(|name| !name.trim().is_empty())
            .ok_or_else(|| error(path, "invalid_plugin_specifier"))?;
        // These are ordered selection rules, not installed plugins. Do not
        // infer effective state: the server may supply a different inventory.
        if cli && (name.trim_start().starts_with('-') || name.contains('*')) {
            continue;
        }
        entries.push(Plugin {
            name: name.to_owned(),
            scope,
            source_path: path.to_owned(),
            source_kind: if cli { "cli_config" } else { "config" },
            declaration_index: Some(index),
            enabled: None,
            mcp_servers_known: false,
        });
    }
    Ok(entries)
}

fn local_entries(path: &Path, scope: &'static str) -> Result<Inventory, ScanError> {
    let Some(meta) = metadata(path)? else {
        return Ok(Inventory::default());
    };
    if !meta.is_dir() {
        return Err(error(path, "not_directory"));
    }
    let directory = fs::read_dir(path).map_err(|_| error(path, "directory_read_failed"))?;
    let mut paths = Vec::new();
    for (index, entry) in directory.enumerate() {
        // Count all children, not just JS/TS matches. Directory plugins only
        // probe two fixed entrypoint names; never recursively enumerate them.
        if index >= DIRECTORY_LIMIT {
            return Err(error(path, "directory_entry_limit"));
        }
        paths.push(
            entry
                .map_err(|_| error(path, "directory_read_failed"))?
                .path(),
        );
    }
    paths.sort();
    let mut result = Inventory::default();
    for child in paths {
        let meta = match metadata(&child) {
            Ok(Some(meta)) => meta,
            Ok(None) => {
                result.errors.push(error(&child, "entry_disappeared"));
                continue;
            }
            Err(e) => {
                result.errors.push(e);
                continue;
            }
        };
        if meta.is_dir() {
            let mut found = false;
            for entrypoint in ["index.ts", "tui.ts"] {
                let entry = child.join(entrypoint);
                match metadata(&entry) {
                    Ok(Some(meta)) if meta.is_file() => found = true,
                    Ok(Some(_)) => result.errors.push(error(&entry, "not_regular_file")),
                    Ok(None) => {}
                    Err(e) => result.errors.push(e),
                }
            }
            if found {
                if let Some(name) = child.file_name().and_then(|name| name.to_str()) {
                    result.entries.push(Plugin {
                        name: name.to_owned(),
                        scope,
                        source_path: child,
                        source_kind: "local_directory",
                        declaration_index: None,
                        enabled: None,
                        mcp_servers_known: false,
                    });
                } else {
                    result
                        .errors
                        .push(error(&child, "invalid_filename_encoding"));
                }
            }
            continue;
        }
        if !meta.is_file()
            || !child
                .extension()
                .is_some_and(|ext| ext == "js" || ext == "ts")
        {
            continue;
        }
        let Some(name) = child.file_name().and_then(|name| name.to_str()) else {
            result
                .errors
                .push(error(&child, "invalid_filename_encoding"));
            continue;
        };
        result.entries.push(Plugin {
            name: name.to_owned(),
            scope,
            source_path: child,
            source_kind: "local_file",
            declaration_index: None,
            enabled: None,
            mcp_servers_known: false,
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
            let root =
                std::env::temp_dir().join(format!("ccgui-opencode-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn write(&self, name: &str, text: &str) {
            let path = self.0.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }
        fn scan(&self) -> Inventory {
            scan(
                &self.0.join("user"),
                Some(&self.0.join("project")),
                |text| serde_json::from_str(text).map_err(|e| e.to_string()),
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn absent_sources_are_empty() {
        let result = Fixture::new().scan();
        assert!(result.entries.is_empty());
        assert!(result.errors.is_empty());
    }

    #[test]
    fn sources_duplicates_and_unknown_state_are_preserved() {
        let f = Fixture::new();
        f.write(
            "user/opencode.json",
            r#"{"plugin":["@org/plugin@1", "@org/plugin@1"]}"#,
        );
        f.write(
            "project/opencode.json",
            r#"{"plugin":["file:///plugin.ts"]}"#,
        );
        f.write("user/plugins/a.js", "throw new Error('must not execute')");
        f.write(
            "project/.opencode/plugins/b.ts",
            "invalid JavaScript is not parsed",
        );
        f.write("project/.opencode/plugins/nested/hidden.ts", "");
        f.write("user/plugins/readme.md", "");
        let result = f.scan();
        assert!(result.errors.is_empty());
        assert_eq!(result.entries.len(), 5);
        assert_eq!(result.entries[1].declaration_index, Some(1));
        assert_eq!(result.entries[2].scope, "project");
        assert_eq!(result.entries[4].source_kind, "local_file");
        assert!(result
            .entries
            .iter()
            .all(|p| p.enabled.is_none() && !p.mcp_servers_known));
    }

    #[test]
    fn malformed_source_does_not_hide_valid_sources() {
        for (text, code) in [
            ("{", "invalid_json"),
            ("[]", "config_not_object"),
            (r#"{"plugin":null}"#, "plugin_not_array"),
            (r#"{"plugin":["ok",5]}"#, "invalid_plugin_specifier"),
        ] {
            let f = Fixture::new();
            f.write("user/opencode.json", text);
            f.write("project/.opencode/plugins/valid.ts", "");
            let result = f.scan();
            assert_eq!(result.errors[0].code, code);
            assert_eq!(result.entries.len(), 1);
        }
    }

    #[test]
    fn jsonc_is_delegated_and_errors_are_redacted() {
        let f = Fixture::new();
        f.write("user/opencode.jsonc", "// parser input");
        let result = scan(&f.0.join("user"), None, |text| {
            assert_eq!(text, "// parser input");
            Ok(serde_json::json!({"plugin": ["from-jsonc"]}))
        });
        assert_eq!(result.entries[0].name, "from-jsonc");
        let failed = scan(&f.0.join("user"), None, |_| Err("SECRET".into()));
        assert_eq!(failed.errors[0].code, "invalid_jsonc");
        assert!(!format!("{failed:?}").contains("SECRET"));
    }

    #[test]
    fn bounded_inputs_and_invalid_utf8() {
        let f = Fixture::new();
        f.write("user/opencode.json", &" ".repeat(CONFIG_LIMIT as usize + 1));
        assert_eq!(f.scan().errors[0].code, "config_size_limit");
        fs::write(f.0.join("user/opencode.json"), [0xff]).unwrap();
        assert_eq!(f.scan().errors[0].code, "invalid_utf8");
        fs::remove_file(f.0.join("user/opencode.json")).unwrap();
        for i in 0..=DIRECTORY_LIMIT {
            f.write(&format!("user/plugins/{i}.txt"), "");
        }
        assert_eq!(f.scan().errors[0].code, "directory_entry_limit");
    }

    #[test]
    fn cli_is_global_only_and_rules_are_not_plugins() {
        let f = Fixture::new();
        f.write(
            "user/cli.json",
            r#"{"plugins":["*","-team.*","-disabled",
            "@org/tui@1",{"package":"@org/tui@1","options":{"token":"SECRET"}},
            "../outside","file:///outside"],"plugin":["wrong-field"]}"#,
        );
        for name in [
            "project/cli.json",
            "project/.opencode/cli.json",
            "user/cli.jsonc",
        ] {
            f.write(name, r#"{"plugins":["wrong-location"]}"#);
        }
        let result = f.scan();
        assert!(result.errors.is_empty());
        assert_eq!(
            result
                .entries
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>(),
            ["@org/tui@1", "@org/tui@1", "../outside", "file:///outside"]
        );
        assert_eq!(
            result
                .entries
                .iter()
                .map(|p| p.declaration_index)
                .collect::<Vec<_>>(),
            [Some(3), Some(4), Some(5), Some(6)]
        );
        assert!(result.entries.iter().all(|p| p.scope == "user"
            && p.source_kind == "cli_config"
            && p.source_path == f.0.join("user/cli.json")
            && p.enabled.is_none()
            && !p.mcp_servers_known));
        assert!(!format!("{result:?}").contains("SECRET"));
    }

    #[test]
    fn cli_parser_is_injected_and_failures_are_source_local() {
        let f = Fixture::new();
        f.write("user/cli.json", "// injected JSONC parser input");
        let parsed = scan(&f.0.join("user"), None, |text| {
            assert_eq!(text, "// injected JSONC parser input");
            Ok(serde_json::json!({"plugins": [{"package": "cli-plugin"}]}))
        });
        assert_eq!(parsed.entries[0].name, "cli-plugin");
        let failed = scan(&f.0.join("user"), None, |_| Err("SECRET".into()));
        assert_eq!(failed.errors[0].code, "invalid_jsonc");
        assert!(!format!("{failed:?}").contains("SECRET"));
        for (text, code) in [
            ("{", "invalid_jsonc"),
            ("[]", "config_not_object"),
            (r#"{"plugins":null}"#, "plugins_not_array"),
            (
                r#"{"plugins":[{"options":{"token":"SECRET"}}]}"#,
                "invalid_plugin_specifier",
            ),
            (
                r#"{"plugins":[{"package":42}]}"#,
                "invalid_plugin_specifier",
            ),
            (
                r#"{"plugins":[{"package":"p","options":"SECRET"}]}"#,
                "invalid_plugin_options",
            ),
        ] {
            f.write("user/cli.json", text);
            f.write("user/opencode.json", r#"{"plugin":["v1"]}"#);
            let result = f.scan();
            assert_eq!(result.errors.len(), 1);
            assert_eq!(result.errors[0].code, code);
            assert_eq!(result.entries[0].name, "v1");
            assert!(!format!("{result:?}").contains("SECRET"));
        }
    }

    #[test]
    fn directory_plugins_are_bounded_metadata_only_and_not_duplicated() {
        let f = Fixture::new();
        for name in [
            "user/plugins/both/index.ts",
            "user/plugins/both/tui.ts",
            "user/plugins/server/index.ts",
            "project/.opencode/plugins/terminal/tui.ts",
        ] {
            f.write(name, "throw new Error('never execute or parse')");
        }
        f.write("user/plugins/ignored/nested/index.ts", "");
        f.write("user/plugins/ignored/index.js", "");
        f.write("user/plugins/broken/index.ts/child", "");
        f.write("user/plugins/broken/tui.ts", "");
        let result = f.scan();
        assert_eq!(result.entries.len(), 4);
        assert_eq!(
            result
                .entries
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>(),
            ["both", "broken", "server", "terminal"]
        );
        assert!(result
            .entries
            .iter()
            .all(|p| p.source_kind == "local_directory"
                && p.enabled.is_none()
                && !p.mcp_servers_known));
        assert_eq!(
            result.errors,
            [error(
                &f.0.join("user/plugins/broken/index.ts"),
                "not_regular_file"
            )]
        );
    }

    #[test]
    fn cli_limits_and_parent_components_are_rejected() {
        let f = Fixture::new();
        f.write("user/cli.json", &" ".repeat(CONFIG_LIMIT as usize + 1));
        assert_eq!(f.scan().errors[0].code, "config_size_limit");
        f.write(
            "user/cli.json",
            &serde_json::json!({"plugins": vec!["-rule"; DIRECTORY_LIMIT + 1]}).to_string(),
        );
        assert_eq!(f.scan().errors[0].code, "declaration_count_limit");
        let result = scan(&f.0.join("missing/../user"), None, |_| {
            panic!("must not read")
        });
        assert!(result.entries.is_empty());
        assert!(result.errors.iter().all(|e| e.code == "parent_component"));
        assert!(!result.errors.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn v2_directory_and_entrypoint_junctions_are_rejected() {
        let f = Fixture::new();
        f.write("target/index.ts", "");
        fs::create_dir_all(f.0.join("user/plugins/entry")).unwrap();
        for link in ["user/plugins/linked", "user/plugins/entry/tui.ts"] {
            let status = std::process::Command::new("cmd.exe")
                .args(["/D", "/C", "mklink", "/J"])
                .arg(f.0.join(link.replace('/', "\\")))
                .arg(f.0.join("target"))
                .stdout(std::process::Stdio::null())
                .status()
                .unwrap();
            assert!(status.success());
        }
        let result = f.scan();
        assert!(result.entries.is_empty());
        assert_eq!(result.errors.len(), 2);
        assert!(result
            .errors
            .iter()
            .all(|e| e.code == "symlink_not_scanned"));
    }

    #[cfg(unix)]
    #[test]
    fn v2_config_directory_and_entrypoint_symlinks_are_rejected() {
        let f = Fixture::new();
        f.write("target/index.ts", "");
        f.write("target/cli.json", r#"{"plugins":["hidden"]}"#);
        fs::create_dir_all(f.0.join("user/plugins/entry")).unwrap();
        for (target, link) in [
            ("target/cli.json", "user/cli.json"),
            ("target", "user/plugins/linked"),
            ("target/index.ts", "user/plugins/entry/tui.ts"),
        ] {
            std::os::unix::fs::symlink(f.0.join(target), f.0.join(link)).unwrap();
        }
        let result = f.scan();
        assert!(result.entries.is_empty());
        assert_eq!(result.errors.len(), 3);
        assert!(result
            .errors
            .iter()
            .all(|e| e.code == "symlink_not_scanned"));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_file_and_directory_are_rejected() {
        use std::os::unix::fs::{symlink as symlink_file, symlink as symlink_dir};
        let f = Fixture::new();
        f.write("target/opencode.json", "{}");
        fs::create_dir(f.0.join("user")).unwrap();
        symlink_file(
            f.0.join("target/opencode.json"),
            f.0.join("user/opencode.json"),
        )
        .unwrap();
        symlink_dir(f.0.join("target"), f.0.join("project")).unwrap();
        let result = f.scan();
        assert!(result.entries.is_empty());
        assert!(result
            .errors
            .iter()
            .all(|e| e.code == "symlink_not_scanned"));
        assert_eq!(result.errors.len(), 6);
    }

    #[cfg(windows)]
    #[test]
    fn directory_junction_is_rejected() {
        // Junctions exercise reparse-point rejection without symlink privilege.
        let f = Fixture::new();
        f.write("target/opencode.json", r#"{"plugin":["hidden"]}"#);
        let status = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(f.0.join("project"))
            .arg(f.0.join("target"))
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        let result = f.scan();
        assert!(result.entries.is_empty());
        assert_eq!(result.errors.len(), 5);
        assert!(result
            .errors
            .iter()
            .all(|e| e.code == "symlink_not_scanned"));
    }
}
