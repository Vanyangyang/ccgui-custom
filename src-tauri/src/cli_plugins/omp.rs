//! Pure parsers for `omp plugin list --json`; no CLI, plugin or MCP execution.
//!
//! Contract verified against can1357/oh-my-pi commit
//! c29f7c56f5530d805bb2887ade964aa55970d8e1:
//! - packages/coding-agent/src/cli/plugin-cli.ts: handleList
//! - src/extensibility/plugins/{types,manager}.ts: InstalledPlugin, list, resolvePlugin
//! - src/extensibility/plugins/marketplace/{types,manager}.ts: InstalledPluginSummary
//! - src/discovery/{omp-plugins,claude-plugins}.ts: loadMCPServers
//! (The last three paths are relative to packages/coding-agent.)
//! See also docs/{marketplace,plugin-manager-installer-plumbing}.md.
//!
//! npm includes npm/git/link installs from the user plugin root, with project
//! overrides already applied to enabled. Marketplace summaries contain entries,
//! not flattened installs, and have no projectPath. Cache paths do NOT identify
//! the owning workspace. The caller must retain the exact list invocation cwd.
//! This module does not discover project anchors, validate files or prove loading.

use serde_json::{Map, Value};
use std::path::{Component, Path};

pub(crate) struct OmpPlugin {
    pub id: String,
    pub name: String,
    pub kind: &'static str,
    pub scope: String,
    pub version: Option<String>,
    pub install_path: Option<String>,
    /// Invocation workspace, not the registry anchor (which is absent in JSON).
    pub project_path: Option<String>,
    /// Reported configured enablement, not runtime activation or MCP health.
    pub enabled: Option<bool>,
    /// CLI reports an installed record; disk existence has NOT been checked.
    pub installed: bool,
    pub shadowed_by: Option<String>,
    /// Always false: list JSON cannot enumerate dynamic extension MCP servers.
    pub mcp_servers_known: bool,
}

const INVALID: &str = "Invalid OMP plugin list JSON";

fn object(value: &Value) -> Result<&Map<String, Value>, String> {
    value.as_object().ok_or_else(|| INVALID.to_owned())
}

fn required_string(row: &Map<String, Value>, key: &str) -> Result<String, String> {
    row.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| INVALID.to_owned())
}

fn optional_string(row: &Map<String, Value>, key: &str) -> Result<Option<String>, String> {
    match row.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if !s.trim().is_empty() => Ok(Some(s.clone())),
        _ => Err(INVALID.to_owned()),
    }
}

fn optional_bool(row: &Map<String, Value>, key: &str) -> Result<Option<bool>, String> {
    match row.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        _ => Err(INVALID.to_owned()),
    }
}

fn comparable(path: &Path) -> bool {
    path.is_absolute() && !path.components().any(|c| matches!(c, Component::ParentDir))
}

/// `listed_workspace` is the trusted cwd used for the CLI invocation, never a
/// field read from the payload; `workspace` is the requested current workspace.
/// Pass normalized absolute paths. Different/unknown contexts omit project rows
/// and clear npm enablement (it already incorporates the other project's overrides).
/// Even (None, None) is unknown: a home-directory invocation can have overrides.
/// Exact path comparison is deliberately conservative; no filesystem access or
/// heuristic ancestor matching occurs. Re-run list in the requested workspace
/// rather than reuse a snapshot from another directory, even within one project.
pub(crate) fn parse_list(
    raw: &str,
    listed_workspace: Option<&Path>,
    workspace: Option<&Path>,
) -> Result<Vec<OmpPlugin>, String> {
    let value: Value = serde_json::from_str(raw).map_err(|_| INVALID.to_owned())?;
    let root = object(&value)?;
    let npm = root.get("npm").and_then(Value::as_array).ok_or(INVALID)?;
    let marketplace = root
        .get("marketplace")
        .and_then(Value::as_array)
        .ok_or(INVALID)?;
    let same_context = match (listed_workspace, workspace) {
        (Some(a), Some(b)) => comparable(a) && comparable(b) && a == b,
        _ => false,
    };
    let mut plugins = Vec::new();
    for item in npm {
        let row = object(item)?;
        let name = required_string(row, "name")?;
        let enabled = optional_bool(row, "enabled")?;
        plugins.push(OmpPlugin {
            id: name.clone(),
            name,
            kind: "npm",
            scope: "user".into(),
            version: optional_string(row, "version")?,
            install_path: optional_string(row, "path")?,
            project_path: None,
            enabled: if same_context { enabled } else { None },
            installed: true,
            shadowed_by: None,
            mcp_servers_known: false,
        });
    }
    for item in marketplace {
        let row = object(item)?;
        let id = required_string(row, "id")?;
        let scope = required_string(row, "scope")?;
        if !matches!(scope.as_str(), "user" | "project") {
            return Err(INVALID.into());
        }
        let entries = row
            .get("entries")
            .and_then(Value::as_array)
            .ok_or(INVALID)?;
        let shadowed_by = optional_string(row, "shadowedBy")?;
        if shadowed_by.as_deref().is_some_and(|s| s != "project") {
            return Err(INVALID.into());
        }
        if scope == "project" && !same_context {
            continue;
        }
        for item in entries {
            let entry = object(item)?;
            // Summary scope identifies the registry; do not trust a conflicting
            // entry scope to turn a foreign/project record into a global one.
            if optional_string(entry, "scope")?.is_some_and(|s| s != scope) {
                return Err(INVALID.into());
            }
            plugins.push(OmpPlugin {
                name: id
                    .rsplit_once('@')
                    .map_or(id.as_str(), |(name, _)| name)
                    .into(),
                id: id.clone(),
                kind: "marketplace",
                scope: scope.clone(),
                version: optional_string(entry, "version")?,
                install_path: optional_string(entry, "installPath")?,
                project_path: if scope == "project" {
                    workspace.map(|p| p.to_string_lossy().into_owned())
                } else {
                    None
                },
                // OMP runtime treats absent legacy enabled as enabled. Inventory
                // conservatively preserves absence/null instead of claiming state.
                enabled: optional_bool(entry, "enabled")?,
                installed: true,
                shadowed_by: if same_context {
                    shadowed_by.clone()
                } else {
                    None
                },
                mcp_servers_known: false,
            });
        }
    }
    Ok(plugins)
}

/// Caller-selected, verified static source. This parser neither discovers nor
/// reads paths. In particular, package.json omp/pi manifests are NOT MCP maps.
pub(crate) enum StaticMcpFormat {
    /// OMP extension root .mcp.json or mcp.json: {mcpServers:{name:config}}.
    OmpExtensionFile,
    /// Marketplace .mcp.json / manifest-referenced file: nested or flat map.
    MarketplaceFile,
    /// The mcpServers object of .omp-plugin/plugin.json (preferred) or
    /// .claude-plugin/plugin.json. Pass only that field, not the whole manifest.
    MarketplaceInline,
}

/// Returns declared names only; discards command/args/env/url/headers/auth and
/// does not expand placeholders or evaluate !command values. Caller must apply
/// source precedence and root confinement before supplying file contents.
/// Marketplace runtime may namespace these names with the plugin name. These
/// are declaration names, not proof of runtime registration or completeness.
pub(crate) fn parse_static_mcp_names(
    raw: &str,
    format: StaticMcpFormat,
) -> Result<Vec<String>, String> {
    const ERROR: &str = "Invalid OMP static MCP JSON";
    let value: Value = serde_json::from_str(raw).map_err(|_| ERROR.to_owned())?;
    let root = value.as_object().ok_or(ERROR)?;
    let servers = match format {
        StaticMcpFormat::MarketplaceInline => root,
        StaticMcpFormat::OmpExtensionFile => match root.get("mcpServers") {
            None => return Ok(Vec::new()),
            Some(value) => value.as_object().ok_or(ERROR)?,
        },
        StaticMcpFormat::MarketplaceFile => match root.get("mcpServers") {
            None => root,
            Some(value) => value.as_object().ok_or(ERROR)?,
        },
    };
    let mut names: Vec<_> = servers
        .iter()
        .filter_map(|(name, config)| {
            let config = config.as_object()?;
            (config.get("command").is_some_and(Value::is_string)
                || config.get("url").is_some_and(Value::is_string))
            .then(|| name.clone())
        })
        .collect();
    names.sort();
    Ok(names)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{fs, path::PathBuf};

    // Synthetic fixtures from the upstream contracts above, NOT live OMP output.
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("ccgui-omp-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(path.join("project")).unwrap();
            fs::create_dir_all(path.join("other")).unwrap();
            Self(path)
        }
        fn project(&self) -> PathBuf {
            self.0.join("project")
        }
        fn other(&self) -> PathBuf {
            self.0.join("other")
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn fixture() -> String {
        json!({"npm":[{"name":"@example/tools","version":"1.0","path":"/user/plugins/node_modules/@example/tools",
            "manifest":{"extensions":["index.js"],"settings":{"secret":{"default":"SENSITIVE"}}},
            "enabledFeatures":null,"enabled":false}],
            "marketplace":[
                {"id":"demo@market","scope":"project","entries":[{"scope":"project","installPath":"/shared/cache/demo","version":"2","enabled":true}]},
                {"id":"demo@market","scope":"user","shadowedBy":"project","entries":[{"scope":"user","installPath":"/shared/cache/demo","version":"1"}]}
            ]}).to_string()
    }
    #[test]
    fn parses_real_contract_and_keeps_unknowns() {
        let f = Fixture::new();
        let rows = parse_list(&fixture(), Some(&f.project()), Some(&f.project())).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].id, "@example/tools");
        assert_eq!(rows[0].kind, "npm");
        assert_eq!(rows[0].scope, "user");
        assert_eq!(rows[0].enabled, Some(false));
        assert_eq!(rows[1].name, "demo");
        assert_eq!(rows[1].version.as_deref(), Some("2"));
        assert_eq!(rows[1].install_path.as_deref(), Some("/shared/cache/demo"));
        assert_eq!(
            rows[1].project_path,
            Some(f.project().to_string_lossy().into_owned())
        );
        assert_eq!(rows[2].enabled, None);
        assert_eq!(rows[2].shadowed_by.as_deref(), Some("project"));
        assert!(rows.iter().all(|r| r.installed && !r.mcp_servers_known));
    }
    #[test]
    fn filters_foreign_project_and_discards_foreign_effective_state() {
        let f = Fixture::new();
        for (listed, current) in [
            (Some(f.project()), Some(f.other())),
            (None, Some(f.project())),
            (Some(f.project()), None),
            (None, None),
        ] {
            let rows = parse_list(&fixture(), listed.as_deref(), current.as_deref()).unwrap();
            assert_eq!(rows.len(), 2);
            assert!(rows
                .iter()
                .all(|r| r.scope == "user" && r.project_path.is_none()));
            assert_eq!(rows[0].enabled, None);
            assert_eq!(rows[1].shadowed_by, None);
        }
    }
    #[test]
    fn empty_entries_are_not_installed_and_null_is_not_disabled() {
        let f = Fixture::new();
        let raw = r#"{"npm":[{"name":"linked","enabled":null}],"marketplace":[{"id":"a@b","scope":"user","entries":[]}]}"#;
        let rows = parse_list(raw, Some(&f.project()), Some(&f.project())).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].enabled, None);
        assert_eq!(rows[0].install_path, None);
    }
    #[test]
    fn malformed_json_is_rejected_without_leaking_payload() {
        for raw in [
            "SENSITIVE",
            "[]",
            "{}",
            r#"{"npm":{},"marketplace":[]}"#,
            r#"{"npm":[{"name":"x","enabled":"SENSITIVE"}],"marketplace":[]}"#,
            r#"{"npm":[],"marketplace":[{"id":"x@y","scope":"user","entries":[{"scope":"project"}]}]}"#,
        ] {
            assert_eq!(parse_list(raw, None, None).err().as_deref(), Some(INVALID));
        }
    }
    #[test]
    fn static_mcp_only_returns_names_and_respects_format() {
        let nested = r#"{"mcpServers":{"ok":{"command":"!do-not-run","env":{"TOKEN":"SENSITIVE"}},"http":{"url":"https://SENSITIVE"},"invalid":{"args":[]},"bad":false}}"#;
        assert_eq!(
            parse_static_mcp_names(nested, StaticMcpFormat::OmpExtensionFile).unwrap(),
            vec!["http", "ok"]
        );
        let flat = r#"{"only":{"command":"do-not-run"}}"#;
        assert!(
            parse_static_mcp_names(flat, StaticMcpFormat::OmpExtensionFile)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            parse_static_mcp_names(flat, StaticMcpFormat::MarketplaceFile).unwrap(),
            vec!["only"]
        );
        assert_eq!(
            parse_static_mcp_names(flat, StaticMcpFormat::MarketplaceInline).unwrap(),
            vec!["only"]
        );
        assert!(
            parse_static_mcp_names(r#"{"mcpServers":null}"#, StaticMcpFormat::MarketplaceFile)
                .is_err()
        );
    }
    #[test]
    fn paths_are_not_inferred_from_cache_or_relative_context() {
        let path = Path::new("relative");
        assert_eq!(
            parse_list(&fixture(), Some(path), Some(path))
                .unwrap()
                .len(),
            2
        );
    }
}
