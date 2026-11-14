//! Native CLI plugin inventories. These are distinct from CCGUI extensions.
//! Commands are always invoked with argument vectors; plugin output is never
//! returned or logged verbatim because MCP declarations may contain secrets.

mod agy;
mod claude;
mod codex;
mod codex_toggle;
mod cursor;
mod dsh;
mod grok;
#[cfg(windows)]
mod guarded_windows;
mod kimi;
mod omp;
mod omp_mcp;
mod opencode;
mod pi;
mod qoder;

use crate::event_sink::Emit;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{path::Path, process::Stdio, sync::Arc, time::Duration};

const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
const LIST_TIMEOUT: Duration = Duration::from_secs(20);
const ACTION_TIMEOUT: Duration = Duration::from_secs(120);

#[cfg(unix)]
struct ProcessGroupGuard(Option<u32>);
#[cfg(unix)]
impl Drop for ProcessGroupGuard {
    fn drop(&mut self) {
        if let Some(pid) = self.0 {
            crate::engine::kill_process_group(pid);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CliPluginEntry {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    record_key: Option<String>,
    name: String,
    version: Option<String>,
    scope: String,
    enabled: Option<bool>,
    project_path: Option<String>,
    mcp_servers: Vec<String>,
    mcp_servers_known: bool,
    can_toggle: bool,
    can_uninstall: bool,
    can_update: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CliPluginsInventory {
    engine: String,
    available: bool,
    support: &'static str,
    message: Option<&'static str>,
    entries: Vec<CliPluginEntry>,
    install_scopes: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CliPluginActionRequest {
    engine: String,
    workspace: Option<String>,
    action: String,
    plugin_id: String,
    scope: String,
}

/// Private raw MCP data is kept in the host; the UI receives only server names.
pub(crate) struct DiscoveredPlugin {
    entry: CliPluginEntry,
    source_path: String,
    mcp_servers: Vec<(String, Value)>,
    /// Some CLIs require additional trust in addition to enabled state.
    mcp_enabled: Option<bool>,
}

pub(crate) struct Discovery {
    plugins: Vec<DiscoveredPlugin>,
    warnings: Vec<String>,
}

/// The hook browser needs only plugin provenance, not private MCP contents.
pub(crate) struct HookPluginSource {
    pub id: String,
    pub name: String,
    pub scope: String,
    pub enabled: Option<bool>,
    pub source_path: String,
}

pub(crate) async fn hook_sources(engine: &str, workspace: Option<&str>) -> Result<(Vec<HookPluginSource>, bool), String> {
    let discovery = discover(engine, workspace).await?;
    let partial = !discovery.warnings.is_empty();
    Ok((discovery.plugins.into_iter().map(|plugin| HookPluginSource {
        id: plugin.entry.id,
        name: plugin.entry.name,
        scope: plugin.entry.scope,
        enabled: plugin.entry.enabled,
        source_path: plugin.source_path,
    }).collect(), partial))
}

pub(crate) async fn grok_hook_inventory(workspace: Option<&str>) -> Result<Value, String> {
    let args = ["inspect".to_owned(), "--json".to_owned()];
    let raw = run_cli("grok", &args, workspace, LIST_TIMEOUT).await?;
    serde_json::from_str(&raw).map_err(|_| "Grok hook inventory returned invalid JSON".into())
}

pub(crate) async fn set_codex_hook_enabled(workspace: Option<&str>, id: &str, hash: &str, enabled: bool) -> Result<(), String> {
    let settings = crate::settings::read_settings().unwrap_or_default();
    let bin = crate::engine::engine_bin(&settings, "codex");
    let home = resolve_from_cli_cwd(crate::engine::codex_home(), workspace);
    codex_toggle::set_hook_enabled(&bin, &home, workspace.map(Path::new), id, hash, enabled).await
}

impl Discovery {
    pub(crate) fn into_mcp(
        self,
        engine: &str,
    ) -> (
        Vec<crate::mcp::plugin_sources::PluginMcpDeclaration>,
        Vec<String>,
    ) {
        let mut declarations = Vec::new();
        for plugin in self.plugins {
            for (name, config) in plugin.mcp_servers {
                declarations.push(crate::mcp::plugin_sources::PluginMcpDeclaration {
                    engine: engine.to_string(),
                    plugin_id: plugin.entry.id.clone(),
                    scope: plugin.entry.scope.clone(),
                    source_path: plugin.source_path.clone(),
                    server_name: name,
                    enabled: if engine == "kimi" {
                        config.get("enabled").and_then(Value::as_bool)
                    } else {
                        plugin.mcp_enabled
                    },
                    config,
                });
            }
        }
        (declarations, self.warnings)
    }
}

pub(crate) fn has_native_inventory(engine: &str) -> bool {
    matches!(engine, "kimi" | "pi" | "opencode" | "dsh" | "cursor") || list_args(engine).is_some()
}

fn supported(engine: &str) -> (&'static str, Option<&'static str>, Vec<&'static str>) {
    match engine {
        "claude" => ("managed", None, vec!["user", "project", "local"]),
        "qoder" | "qoder-cn" => (
            "managed",
            Some("cliPlugins.message.unverifiedCli"),
            vec!["user", "project", "local"],
        ),
        "omp" => (
            "managed",
            Some("cliPlugins.message.ompDynamic"),
            vec!["user", "project"],
        ),
        "codex" | "grok" | "agy" => ("managed", None, vec!["user"]),
        "pi" => (
            "managed",
            Some("cliPlugins.message.dynamicMcp"),
            vec!["user", "project"],
        ),
        "kimi" => (
            "read_only",
            Some("cliPlugins.message.kimiInteractive"),
            Vec::new(),
        ),
        "opencode" => (
            "read_only",
            Some("cliPlugins.message.opencodeDynamic"),
            Vec::new(),
        ),
        "dsh" => (
            "managed",
            Some("cliPlugins.message.dshProfiles"),
            Vec::new(),
        ),
        "cursor" => (
            "read_only",
            Some("cliPlugins.message.cursorPartial"),
            Vec::new(),
        ),
        // Do not assert that a CLI lacks plugins merely because this host has
        // not yet implemented its native inspection interface.
        _ => (
            "unknown",
            Some("cliPlugins.message.notIntegrated"),
            Vec::new(),
        ),
    }
}

pub(crate) fn validate_workspace(
    workspace: Option<&str>,
    db: &crate::db::Db,
) -> Result<Option<String>, String> {
    let Some(path) = workspace.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let resolved = crate::files::canonicalize_lenient(Path::new(path))?;
    if !resolved.is_dir() {
        return Err("The selected workspace is not a directory".into());
    }
    let registered: Vec<_> = db
        .workspace_paths()?
        .into_iter()
        .filter(|root| {
            crate::files::canonicalize_lenient(Path::new(root)).is_ok_and(|root| root == resolved)
        })
        .collect();
    if registered.is_empty() {
        return Err("Plugin management requires a registered workspace".into());
    }
    // The WSL lookup is keyed by the stored spelling, not the canonical alias
    // supplied by the caller. Check the matched record before any local CLI.
    if registered
        .iter()
        .any(|root| crate::engine::wsl_transport::transport_for_workspace(db, root).is_some())
    {
        return Err("Remote workspace plugin management is not available on this host".into());
    }
    Ok(Some(resolved.to_string_lossy().into_owned()))
}

fn valid_plugin_input(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 2048
        && !value.starts_with('-')
        // Windows CLI shims can invoke cmd.exe. Reject shell metacharacters
        // rather than treating JSON/shell quoting as an escaping boundary.
        && !value.chars().any(|ch| matches!(ch, '&' | '|' | '<' | '>' | '(' | ')' | '^' | '%' | '!' | '"' | '\'' | '\r' | '\n' | '\0'))
}

fn dsh_profile(scope: &str) -> Option<&str> {
    let name = scope.strip_prefix("profile:")?;
    (!name.is_empty()
        && name.len() <= 80
        && !name.starts_with('-')
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        && name != "."
        && name != "..")
        .then_some(name)
}

fn resolve_from_cli_cwd(path: std::path::PathBuf, workspace: Option<&str>) -> std::path::PathBuf {
    if path.is_absolute() {
        path
    } else {
        workspace
            .map(std::path::PathBuf::from)
            .unwrap_or_else(crate::paths::home_dir)
            .join(path)
    }
}

fn kimi_home_for_cli(
    override_home: Option<&std::ffi::OsStr>,
    development_home: Option<&Path>,
    home: &Path,
    cwd: &Path,
) -> std::path::PathBuf {
    let path = if let Some(development_home) = development_home {
        development_home.join(".kimi-code")
    } else {
        override_home
            .filter(|value| !value.is_empty())
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| home.join(".kimi-code"))
    };
    if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    }
}

fn kimi_registry(workspace: Option<&str>) -> std::path::PathBuf {
    let cwd = workspace
        .map(std::path::PathBuf::from)
        .unwrap_or_else(crate::paths::home_dir);
    kimi_home_for_cli(
        std::env::var_os("KIMI_CODE_HOME").as_deref(),
        crate::development_profile::home().as_deref(),
        &crate::paths::home_dir(),
        &cwd,
    )
    .join("plugins")
    .join("installed.json")
}

/// Package sources may be authenticated URLs. Keep the original in the host
/// for a later explicit remove operation, and expose only a redacted label.
fn display_package_source(source: &str) -> String {
    let source = source.split_once('#').map_or(source, |(head, _)| head);
    let Some(separator) = source.find("://") else {
        return source
            .split_once('?')
            .map_or_else(|| source.to_string(), |(head, _)| format!("{head}?***"));
    };
    let start = source[..separator].rfind(':').map_or(0, |index| index + 1);
    let (prefix, url) = source.split_at(start);
    let scheme_end = url.find("://").unwrap_or(0) + 3;
    let tail = &url[scheme_end..];
    let authority_end = tail.find(['/', '?', '#']).unwrap_or(tail.len());
    let (authority, suffix) = tail.split_at(authority_end);
    let authority = authority
        .rsplit_once('@')
        .map_or_else(|| authority.to_string(), |(_, host)| format!("***@{host}"));
    let safe = format!("{}{}{}", &url[..scheme_end], authority, suffix);
    let safe = safe.split_once('#').map_or(safe.as_str(), |(head, _)| head);
    format!("{prefix}{}", crate::mcp::redact_plugin_url(safe))
}

fn private_record_id(engine: &str, scope: &str, source: &str) -> String {
    let bytes = serde_json::to_vec(&(engine, scope, source)).unwrap_or_default();
    format!("{engine}:{:x}", Sha256::digest(bytes))
}

async fn run_cli(
    engine: &str,
    args: &[String],
    workspace: Option<&str>,
    limit: Duration,
) -> Result<String, String> {
    let settings = crate::settings::read_settings().unwrap_or_default();
    let bin = crate::engine::engine_bin(&settings, engine);
    run_cli_with_bin(engine, &bin, args, workspace, limit).await
}

async fn run_cli_with_bin(
    engine: &str,
    bin: &str,
    args: &[String],
    workspace: Option<&str>,
    limit: Duration,
) -> Result<String, String> {
    #[cfg(windows)]
    let mut command = guarded_windows::prepare(bin, args)?;
    #[cfg(not(windows))]
    let mut command = crate::engine::command_for_binary(bin);
    command.env("PATH", crate::engine::resolve::cli_search_path());
    if engine == "codex" {
        command.env(
            "CODEX_HOME",
            resolve_from_cli_cwd(crate::engine::codex_home(), workspace),
        );
    }
    if engine == "agy" {
        crate::engine::agy::configure_background_command(&mut command);
    }
    #[cfg(not(windows))]
    command.args(args);
    command.current_dir(
        workspace
            .map(std::path::PathBuf::from)
            .unwrap_or_else(crate::paths::home_dir),
    );
    #[cfg(not(windows))]
    command.stdin(Stdio::null());
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    crate::engine::hide_console(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("{engine}: could not start CLI: {error}"))?;
    #[cfg(unix)]
    let _group = ProcessGroupGuard(child.id());
    #[cfg(windows)]
    let job = crate::engine::job::assign_kill_on_close(&child);
    #[cfg(windows)]
    if job.is_none() {
        if let Some(pid) = child.id() {
            crate::engine::kill_process_group(pid);
        }
        let _ = child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
        return Err(format!("{engine}: could not secure CLI process cleanup"));
    }
    #[cfg(windows)]
    guarded_windows::release(&mut child).await?;
    let stdout = child.stdout.take().ok_or("CLI stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("CLI stderr unavailable")?;
    let mut out_task = crate::cli_lifecycle::OutputReader::spawn(
        crate::cli_lifecycle::capture_pipe(stdout, OUTPUT_LIMIT + 1),
    );
    let mut err_task =
        crate::cli_lifecycle::OutputReader::spawn(crate::cli_lifecycle::capture_pipe(stderr, 4097));
    let status = match tokio::time::timeout(limit, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => {
            return Err(format!("{engine}: CLI process failed: {error}"));
        }
        Err(_) => {
            #[cfg(unix)]
            if let Some(pid) = child.id() {
                crate::engine::kill_process_group(pid);
            }
            let _ = child.kill().await;
            return Err(format!("{engine}: CLI request timed out"));
        }
    };
    #[cfg(windows)]
    drop(job);
    let (stdout, stderr) = crate::cli_lifecycle::finish_output_readers(
        &mut out_task,
        &mut err_task,
        Duration::from_secs(3),
    )
    .await
    .map_err(|_| format!("{engine}: could not collect CLI output"))?;
    if stdout.len() > OUTPUT_LIMIT {
        return Err(format!("{engine}: CLI output exceeds the size limit"));
    }
    if !status.success() {
        // Do not expose raw stdout/stderr; native plugin output can include
        // environment values, headers, or installation command payloads.
        if engine == "agy"
            && String::from_utf8_lossy(&stderr)
                .contains("plugins are disabled by your organization")
        {
            return Err("agy_plugins_disabled_by_org".into());
        }
        return Err(format!(
            "{engine}: plugin command failed ({status}); inspect the native CLI for details"
        ));
    }
    String::from_utf8(stdout).map_err(|_| format!("{engine}: CLI returned invalid UTF-8"))
}

fn list_args(engine: &str) -> Option<Vec<String>> {
    let words: &[&str] = match engine {
        "claude" | "codex" | "grok" | "agy" => &["plugin", "list", "--json"],
        "qoder" | "qoder-cn" => &["plugins", "list", "--json"],
        "omp" => &["plugin", "list", "--json"],
        _ => return None,
    };
    Some(words.iter().map(|word| (*word).to_string()).collect())
}

/// A damaged bundle must not hide other installed plugins. Parse each record
/// independently and retain its identity with an explicitly incomplete MCP
/// inventory when its files cannot be inspected.
fn codex_discovery(raw: &str, workspace: Option<&str>) -> Result<Discovery, String> {
    let root: Value = serde_json::from_str(raw).map_err(|_| "Invalid Codex plugin list")?;
    let rows = root
        .get("installed")
        .and_then(Value::as_array)
        .ok_or("Invalid Codex plugin list")?;
    let mut plugins = Vec::new();
    let mut warnings = Vec::new();
    let codex_home = resolve_from_cli_cwd(crate::engine::codex_home(), workspace);
    for (index, row) in rows.iter().enumerate() {
        match row.get("installed").and_then(Value::as_bool) {
            Some(false) => continue,
            Some(true) => {}
            None => {
                warnings.push(format!(
                    "Codex plugin {index}: installation state is unknown"
                ));
                continue;
            }
        }
        let single = serde_json::json!({"installed": [row]});
        match codex::parse_list_at(&single.to_string(), &codex_home) {
            Ok(parsed) => {
                for plugin in parsed {
                    let mcp_servers: Vec<_> = plugin
                        .mcp_servers
                        .into_iter()
                        .map(|mcp| (mcp.name, mcp.config))
                        .collect();
                    let removable = plugin.install_policy.as_deref() == Some("AVAILABLE");
                    plugins.push(DiscoveredPlugin {
                        entry: CliPluginEntry {
                            id: plugin.id,
                            record_key: None,
                            name: plugin.name,
                            version: plugin.version,
                            scope: "user".into(),
                            enabled: Some(plugin.enabled),
                            project_path: None,
                            mcp_servers: mcp_servers.iter().map(|(name, _)| name.clone()).collect(),
                            mcp_servers_known: true,
                            can_toggle: true,
                            can_uninstall: removable,
                            can_update: false,
                        },
                        source_path: plugin.source_path.unwrap_or_default(),
                        mcp_enabled: (!plugin.enabled).then_some(false),
                        mcp_servers,
                    });
                }
            }
            Err(_) => {
                warnings.push(format!(
                    "Codex plugin {index}: bundle could not be inspected"
                ));
                let Some(id) = row
                    .get("pluginId")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                else {
                    continue;
                };
                let name = row.get("name").and_then(Value::as_str).unwrap_or(id);
                let enabled = row.get("enabled").and_then(Value::as_bool);
                plugins.push(DiscoveredPlugin {
                    entry: CliPluginEntry {
                        id: id.into(),
                        record_key: None,
                        name: name.into(),
                        version: row
                            .get("version")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        scope: "user".into(),
                        enabled,
                        project_path: None,
                        mcp_servers: Vec::new(),
                        mcp_servers_known: false,
                        can_toggle: enabled.is_some(),
                        can_uninstall: false,
                        can_update: false,
                    },
                    source_path: String::new(),
                    mcp_enabled: None,
                    mcp_servers: Vec::new(),
                });
            }
        }
    }
    Ok(Discovery { plugins, warnings })
}

fn grok_scope(path: Option<&str>, workspace: Option<&str>) -> &'static str {
    let Some(path) = path.and_then(|path| std::fs::canonicalize(path).ok()) else {
        return "unknown";
    };
    if workspace
        .and_then(|workspace| {
            std::fs::canonicalize(Path::new(workspace).join(".grok").join("plugins")).ok()
        })
        .is_some_and(|root| path.starts_with(root))
    {
        return "project";
    }
    let home = resolve_from_cli_cwd(
        crate::engine::engine_home(Some("GROK_HOME"), ".grok"),
        workspace,
    );
    if std::fs::canonicalize(home).is_ok_and(|root| path.starts_with(root)) {
        return "user";
    }
    "unknown"
}

fn grok_discovery(raw: &str, workspace: Option<&str>) -> Result<Discovery, String> {
    let root: Value = serde_json::from_str(raw).map_err(|_| "Invalid Grok plugin list")?;
    let rows = root.as_array().ok_or("Invalid Grok plugin list")?;
    let mut plugins = Vec::new();
    let mut warnings = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        match grok::parse_list(&serde_json::json!([row]).to_string()) {
            Ok(parsed) => {
                for plugin in parsed {
                    let mcp_servers: Vec<_> = plugin
                        .mcp_servers
                        .into_iter()
                        .map(|mcp| (mcp.name, mcp.config))
                        .collect();
                    let scope = grok_scope(plugin.source_path.as_deref(), workspace);
                    let editable = scope == "user";
                    let mcp_enabled = match (plugin.enabled, plugin.trusted) {
                        (Some(false), _) | (_, Some(false)) => Some(false),
                        (Some(true), Some(true)) => Some(true),
                        _ => None,
                    };
                    plugins.push(DiscoveredPlugin {
                        entry: CliPluginEntry {
                            id: plugin.id,
                            record_key: None,
                            name: plugin.name,
                            version: plugin.version,
                            scope: scope.into(),
                            enabled: plugin.enabled,
                            project_path: (scope == "project")
                                .then(|| workspace.unwrap_or_default().to_string()),
                            mcp_servers: mcp_servers.iter().map(|(name, _)| name.clone()).collect(),
                            mcp_servers_known: true,
                            can_toggle: editable,
                            can_uninstall: editable,
                            can_update: editable,
                        },
                        source_path: plugin.source_path.unwrap_or_default(),
                        mcp_enabled,
                        mcp_servers,
                    });
                }
            }
            Err(_) => {
                warnings.push(format!(
                    "Grok plugin {index}: bundle could not be inspected"
                ));
                let (Some(id), Some(name)) = (
                    row.get("repo_key").and_then(Value::as_str),
                    row.get("name").and_then(Value::as_str),
                ) else {
                    continue;
                };
                plugins.push(DiscoveredPlugin {
                    entry: CliPluginEntry {
                        id: id.into(),
                        record_key: None,
                        name: name.into(),
                        version: row
                            .get("version")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        scope: "unknown".into(),
                        enabled: None,
                        project_path: None,
                        mcp_servers: Vec::new(),
                        mcp_servers_known: false,
                        can_toggle: false,
                        can_uninstall: false,
                        can_update: false,
                    },
                    source_path: String::new(),
                    mcp_enabled: None,
                    mcp_servers: Vec::new(),
                });
            }
        }
    }
    // Grok mutation commands accept names, not registry keys. Ambiguous names
    // cannot be safely targeted even when each row has a unique registry key.
    let mut counts = std::collections::HashMap::new();
    for plugin in &plugins {
        *counts
            .entry(plugin.entry.name.to_lowercase())
            .or_insert(0usize) += 1;
    }
    for plugin in &mut plugins {
        if counts
            .get(&plugin.entry.name.to_lowercase())
            .copied()
            .unwrap_or(0)
            > 1
        {
            plugin.entry.can_toggle = false;
            plugin.entry.can_uninstall = false;
            plugin.entry.can_update = false;
        }
    }
    Ok(Discovery { plugins, warnings })
}

pub(crate) async fn discover(engine: &str, workspace: Option<&str>) -> Result<Discovery, String> {
    if engine == "kimi" {
        let registry = kimi_registry(workspace);
        let home = registry
            .parent()
            .and_then(Path::parent)
            .ok_or("Invalid Kimi registry path")?;
        match std::fs::symlink_metadata(&registry) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Discovery {
                    plugins: Vec::new(),
                    warnings: Vec::new(),
                })
            }
            Err(_) => return Err("Cannot inspect Kimi plugin registry".into()),
        }
        let listed = kimi::read_plugins_at(home)?;
        let mut warnings = Vec::new();
        let plugins = listed
            .into_iter()
            .map(|plugin| {
                let known = plugin.warning.is_none();
                if let Some(error) = plugin.warning {
                    warnings.push(format!("{}: {error}", plugin.name));
                }
                let mcp_servers: Vec<_> = plugin
                    .mcp_servers
                    .into_iter()
                    .map(|server| (server.name, server.config))
                    .collect();
                DiscoveredPlugin {
                    entry: CliPluginEntry {
                        record_key: None,
                        id: plugin.id,
                        name: plugin.name,
                        version: plugin.version,
                        scope: "user".into(),
                        enabled: plugin.enabled,
                        project_path: None,
                        mcp_servers: mcp_servers.iter().map(|(name, _)| name.clone()).collect(),
                        mcp_servers_known: known,
                        can_toggle: false,
                        can_uninstall: false,
                        can_update: false,
                    },
                    source_path: plugin.source_path.unwrap_or_default(),
                    mcp_enabled: plugin.enabled,
                    mcp_servers,
                }
            })
            .collect();
        return Ok(Discovery { plugins, warnings });
    }
    if engine == "pi" {
        let settings = resolve_from_cli_cwd(
            crate::engine::engine_home(Some("PI_CODING_AGENT_DIR"), ".pi/agent"),
            workspace,
        )
        .join("settings.json");
        let plugins = pi::read_plugins(&settings, workspace.map(Path::new))?
            .into_iter()
            .map(|plugin| {
                let project = plugin.scope == "project";
                let key = private_record_id("pi", &plugin.scope, &plugin.id);
                let label = display_package_source(&plugin.id);
                DiscoveredPlugin {
                    entry: CliPluginEntry {
                        id: label.clone(),
                        record_key: Some(key),
                        name: label,
                        version: None,
                        scope: plugin.scope,
                        enabled: plugin.enabled,
                        project_path: project.then(|| workspace.unwrap_or_default().to_string()),
                        mcp_servers: Vec::new(),
                        mcp_servers_known: false,
                        can_toggle: false,
                        can_uninstall: true,
                        can_update: false,
                    },
                    source_path: plugin.id,
                    mcp_enabled: None,
                    mcp_servers: Vec::new(),
                }
            })
            .collect();
        return Ok(Discovery {
            plugins,
            warnings: Vec::new(),
        });
    }
    if engine == "opencode" {
        let home = resolve_from_cli_cwd(
            crate::engine::engine_home(Some("XDG_CONFIG_HOME"), ".config"),
            workspace,
        )
        .join("opencode");
        let result = opencode::scan(
            &home,
            workspace.map(Path::new),
            crate::mcp::parse_jsonc_for_plugins,
        );
        let warnings = result
            .errors
            .into_iter()
            .map(|error| format!("{}: {}", error.path.display(), error.code))
            .collect();
        let plugins = result
            .entries
            .into_iter()
            .map(|plugin| {
                let key = format!(
                    "{}:{}:{}:{}",
                    plugin.scope,
                    plugin.source_path.display(),
                    plugin.source_kind,
                    plugin
                        .declaration_index
                        .map(|value| value.to_string())
                        .unwrap_or_default()
                );
                DiscoveredPlugin {
                    entry: CliPluginEntry {
                        id: display_package_source(&plugin.name),
                        record_key: Some(key),
                        name: display_package_source(&plugin.name),
                        version: None,
                        scope: plugin.scope.into(),
                        enabled: plugin.enabled,
                        project_path: (plugin.scope == "project")
                            .then(|| workspace.unwrap_or_default().to_string()),
                        mcp_servers: Vec::new(),
                        mcp_servers_known: plugin.mcp_servers_known,
                        can_toggle: false,
                        can_uninstall: false,
                        can_update: false,
                    },
                    source_path: plugin.source_path.to_string_lossy().into_owned(),
                    mcp_enabled: None,
                    mcp_servers: Vec::new(),
                }
            })
            .collect();
        return Ok(Discovery { plugins, warnings });
    }
    if engine == "dsh" {
        let home = resolve_from_cli_cwd(
            crate::engine::engine_home(Some("DSH_HOME"), ".dsh"),
            workspace,
        );
        let inventory = dsh::read_plugins(&home)?;
        let mut plugins = Vec::new();
        for profile in inventory.profiles {
            for package in profile.packages {
                let key = format!("package:{}:{}", profile.name, package.name);
                let removable = package.installed_locally
                    && package.name != "@deepseek-ai/dsh-base"
                    && dsh_profile(&format!("profile:{}", profile.name)).is_some();
                plugins.push(DiscoveredPlugin {
                    entry: CliPluginEntry {
                        id: package.name.clone(),
                        record_key: Some(key),
                        name: package.name,
                        version: package.local_version,
                        scope: format!("profile:{}", profile.name),
                        enabled: None,
                        project_path: None,
                        mcp_servers: Vec::new(),
                        mcp_servers_known: false,
                        can_toggle: false,
                        can_uninstall: removable,
                        can_update: false,
                    },
                    source_path: profile.path.to_string_lossy().into_owned(),
                    mcp_enabled: None,
                    mcp_servers: Vec::new(),
                });
            }
            for instance in profile.instances {
                let id = instance.id.unwrap_or_else(|| instance.location.clone());
                plugins.push(DiscoveredPlugin {
                    entry: CliPluginEntry {
                        id: id.clone(),
                        record_key: Some(format!(
                            "instance:{}:{}",
                            profile.name, instance.location
                        )),
                        name: instance.name.unwrap_or(id),
                        version: None,
                        scope: format!("profile:{}", profile.name),
                        enabled: instance.enabled,
                        project_path: None,
                        mcp_servers: Vec::new(),
                        mcp_servers_known: false,
                        can_toggle: false,
                        can_uninstall: false,
                        can_update: false,
                    },
                    source_path: profile.path.to_string_lossy().into_owned(),
                    mcp_enabled: None,
                    mcp_servers: Vec::new(),
                });
            }
        }
        for instance in inventory.home_instances {
            let id = instance.id.unwrap_or_else(|| instance.location.clone());
            plugins.push(DiscoveredPlugin {
                entry: CliPluginEntry {
                    id: id.clone(),
                    record_key: Some(format!("home:{}", instance.location)),
                    name: instance.name.unwrap_or(id),
                    version: None,
                    scope: "user".into(),
                    enabled: instance.enabled,
                    project_path: None,
                    mcp_servers: Vec::new(),
                    mcp_servers_known: false,
                    can_toggle: false,
                    can_uninstall: false,
                    can_update: false,
                },
                source_path: home.to_string_lossy().into_owned(),
                mcp_enabled: None,
                mcp_servers: Vec::new(),
            });
        }
        return Ok(Discovery {
            plugins,
            warnings: Vec::new(),
        });
    }
    if engine == "cursor" {
        let home = resolve_from_cli_cwd(crate::engine::cursor::cursor_home(), workspace);
        let result = cursor::read_plugins_from_cursor_home(&home, workspace.map(Path::new));
        let plugins = result
            .plugins
            .into_iter()
            .map(|plugin| {
                let mcp_servers: Vec<_> = plugin
                    .mcp_servers
                    .into_iter()
                    .map(|server| (server.name, server.config))
                    .collect();
                DiscoveredPlugin {
                    entry: CliPluginEntry {
                        id: plugin.id,
                        record_key: None,
                        name: plugin.name,
                        version: plugin.version,
                        scope: plugin.scope.into(),
                        enabled: plugin.enabled,
                        project_path: plugin.project_path,
                        mcp_servers: mcp_servers.iter().map(|(name, _)| name.clone()).collect(),
                        mcp_servers_known: plugin.mcp_servers_known,
                        can_toggle: false,
                        can_uninstall: false,
                        can_update: false,
                    },
                    source_path: plugin.source_path,
                    mcp_enabled: None,
                    mcp_servers,
                }
            })
            .collect();
        return Ok(Discovery {
            plugins,
            warnings: result.warnings,
        });
    }
    let args = list_args(engine).ok_or("native plugin inventory is not integrated")?;
    let raw = run_cli(engine, &args, workspace, LIST_TIMEOUT).await?;
    let mut warnings = Vec::new();
    let plugins = match engine {
        "claude" => claude::parse_list(&raw, workspace.map(Path::new))?
            .into_iter()
            .map(|plugin| {
                let mcp_servers: Vec<_> = plugin
                    .mcp_servers
                    .into_iter()
                    .map(|mcp| (mcp.name, mcp.config))
                    .collect();
                let editable = matches!(plugin.scope.as_str(), "user" | "project" | "local");
                DiscoveredPlugin {
                    entry: CliPluginEntry {
                        name: plugin
                            .id
                            .split('@')
                            .next()
                            .unwrap_or(&plugin.id)
                            .to_string(),
                        id: plugin.id,
                        record_key: None,
                        version: plugin.version,
                        scope: plugin.scope,
                        enabled: plugin.enabled,
                        project_path: plugin.project_path,
                        mcp_servers: mcp_servers.iter().map(|(name, _)| name.clone()).collect(),
                        mcp_servers_known: true,
                        can_toggle: editable,
                        can_uninstall: editable,
                        can_update: editable,
                    },
                    // An enabled plugin can still have an independently disabled
                    // server, so only a disabled plugin proves server disablement.
                    source_path: plugin.install_path.unwrap_or_default(),
                    mcp_enabled: (plugin.enabled == Some(false)).then_some(false),
                    mcp_servers,
                }
            })
            .collect(),
        "codex" => return codex_discovery(&raw, workspace),
        "grok" => return grok_discovery(&raw, workspace),
        "agy" => agy::parse_list(&raw)?
            .into_iter()
            .map(|plugin| {
                let mcp_servers_known = plugin.mcp_error.is_none();
                if let Some(error) = plugin.mcp_error {
                    warnings.push(format!("{}: {error}", plugin.name));
                }
                let source_path = plugin.path.unwrap_or_default();
                let project = workspace.is_some_and(|workspace| {
                    let root =
                        std::fs::canonicalize(Path::new(workspace).join(".agents").join("plugins"));
                    let plugin = std::fs::canonicalize(&source_path);
                    matches!((root, plugin), (Ok(root), Ok(plugin)) if plugin.starts_with(&root))
                });
                let scope = if project { "project" } else { "user" };
                DiscoveredPlugin {
                    entry: CliPluginEntry {
                        id: plugin.name.clone(),
                        record_key: None,
                        name: plugin.name,
                        version: plugin.version,
                        scope: scope.into(),
                        enabled: Some(plugin.enabled),
                        project_path: project.then(|| workspace.unwrap_or_default().to_string()),
                        mcp_servers: plugin
                            .mcp_servers
                            .iter()
                            .map(|(name, _)| name.clone())
                            .collect(),
                        mcp_servers_known,
                        can_toggle: !project,
                        can_uninstall: !project,
                        can_update: false,
                    },
                    source_path,
                    mcp_enabled: (!plugin.enabled).then_some(false),
                    mcp_servers: plugin.mcp_servers,
                }
            })
            .collect(),
        "qoder" | "qoder-cn" => {
            let cwd = workspace
                .map(std::path::PathBuf::from)
                .unwrap_or_else(crate::paths::home_dir);
            let cwd = dunce::simplified(&cwd);
            let result = if engine == "qoder-cn" {
                qoder::parse_list_cn(&raw, cwd)?
            } else {
                qoder::parse_list(&raw, cwd)?
            };
            warnings.extend(result.warnings);
            result
                .plugins
                .into_iter()
                .enumerate()
                .map(|(index, plugin)| {
                    let known = plugin.warnings.is_empty();
                    warnings.extend(
                        plugin
                            .warnings
                            .into_iter()
                            .map(|warning| format!("plugin {index}: {warning}")),
                    );
                    let id_valid = plugin.id.is_some();
                    let id = plugin
                        .id
                        .or_else(|| plugin.name.clone())
                        .unwrap_or_else(|| format!("unknown-{index}"));
                    let scope = plugin.scope.unwrap_or_else(|| "unknown".into());
                    let editable = id_valid
                        && (scope == "user"
                            || (matches!(scope.as_str(), "project" | "local")
                                && plugin.project_path.is_some()));
                    let mcp_servers = plugin.mcp_servers;
                    DiscoveredPlugin {
                        entry: CliPluginEntry {
                            name: plugin.name.unwrap_or_else(|| id.clone()),
                            id,
                            record_key: None,
                            version: plugin.version,
                            scope,
                            enabled: plugin.enabled,
                            project_path: plugin.project_path,
                            mcp_servers: mcp_servers.iter().map(|(name, _)| name.clone()).collect(),
                            mcp_servers_known: known,
                            can_toggle: editable,
                            can_uninstall: editable,
                            can_update: false,
                        },
                        source_path: plugin
                            .plugin_root
                            .map(|path| path.to_string_lossy().into_owned())
                            .unwrap_or_default(),
                        mcp_enabled: (plugin.enabled == Some(false)).then_some(false),
                        mcp_servers,
                    }
                })
                .collect()
        }
        "omp" => {
            let current = workspace.map(Path::new);
            omp::parse_list(&raw, current, current)?
                .into_iter()
                .map(|plugin| {
                    let known_state = if plugin.shadowed_by.is_some() {
                        None
                    } else {
                        plugin.enabled
                    };
                    let key = format!(
                        "{}:{}:{}:{}",
                        plugin.kind,
                        plugin.scope,
                        plugin.id,
                        plugin.install_path.as_deref().unwrap_or("")
                    );
                    let mcp_servers = match plugin.install_path.as_deref() {
                        Some(path) => match omp_mcp::read(Path::new(path), plugin.kind) {
                            Ok(servers) => servers,
                            Err(error) => {
                                warnings.push(format!("{}: {error}", plugin.name));
                                Vec::new()
                            }
                        },
                        None => Vec::new(),
                    };
                    DiscoveredPlugin {
                        entry: CliPluginEntry {
                            id: plugin.id,
                            record_key: Some(key),
                            name: plugin.name,
                            version: plugin.version,
                            scope: plugin.scope,
                            enabled: known_state,
                            project_path: plugin.project_path,
                            mcp_servers: mcp_servers.iter().map(|(name, _)| name.clone()).collect(),
                            mcp_servers_known: plugin.mcp_servers_known,
                            can_toggle: true,
                            can_uninstall: true,
                            can_update: plugin.kind == "marketplace",
                        },
                        source_path: plugin.install_path.unwrap_or_default(),
                        mcp_enabled: (known_state == Some(false)).then_some(false),
                        mcp_servers,
                    }
                })
                .collect()
        }
        _ => return Err("native plugin inventory is not integrated".into()),
    };
    Ok(Discovery { plugins, warnings })
}

#[tauri::command]
pub(crate) async fn cli_plugins_inventory(
    db: tauri::State<'_, Arc<crate::db::Db>>,
    engine: String,
    workspace: Option<String>,
) -> Result<CliPluginsInventory, String> {
    if !crate::config::ENGINES.contains(&engine.as_str()) {
        return Err("Unknown CLI engine".into());
    }
    let (support, mut message, scopes) = supported(&engine);
    let workspace = validate_workspace(workspace.as_deref(), &db)?;
    let engines = crate::engine::list_engines().await?;
    let available = engines
        .iter()
        .any(|item| item.id == engine && item.available);
    let mut entries = Vec::new();
    if (available
        || matches!(
            engine.as_str(),
            "kimi" | "pi" | "opencode" | "dsh" | "cursor"
        ))
        && matches!(support, "managed" | "read_only")
    {
        let result = discover(&engine, workspace.as_deref()).await?;
        if !result.warnings.is_empty() && engine != "cursor" {
            message = Some("cliPlugins.message.partialMcp");
        }
        entries = result
            .plugins
            .into_iter()
            .map(|plugin| plugin.entry)
            .collect();
        entries.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then_with(|| a.scope.cmp(&b.scope))
        });
    }
    let mut install_scopes: Vec<String> = if workspace.is_some() {
        scopes.into_iter().map(str::to_owned).collect()
    } else {
        scopes
            .into_iter()
            .filter(|scope| *scope == "user")
            .map(str::to_owned)
            .collect()
    };
    if engine == "dsh" && available {
        let home = resolve_from_cli_cwd(
            crate::engine::engine_home(Some("DSH_HOME"), ".dsh"),
            workspace.as_deref(),
        );
        install_scopes = dsh::read_plugins(&home)?
            .profiles
            .into_iter()
            .map(|profile| format!("profile:{}", profile.name))
            .filter(|scope| dsh_profile(scope).is_some())
            .collect();
    }
    Ok(CliPluginsInventory {
        engine,
        available,
        support,
        message,
        entries,
        install_scopes,
    })
}

fn action_args(
    engine: &str,
    action: &str,
    plugin_id: &str,
    scope: &str,
    kind: Option<&str>,
) -> Result<Vec<String>, String> {
    if !valid_plugin_input(plugin_id) {
        return Err("Invalid plugin identifier or source".into());
    }
    let args = match (engine, action) {
        ("claude", "install" | "enable" | "disable" | "uninstall" | "update")
            if matches!(scope, "user" | "project" | "local") =>
        {
            let mut args = vec!["plugin", action, plugin_id, "--scope", scope, "--json"];
            if action == "uninstall" {
                args.push("--keep-data");
            }
            args
        }
        ("codex", "install") if scope == "user" => vec!["plugin", "add", plugin_id, "--json"],
        ("codex", "uninstall") if scope == "user" => vec!["plugin", "remove", plugin_id, "--json"],
        // Config changes use Codex's native app-server RPC, not a fabricated
        // `codex plugin enable` shell command.
        ("codex", "enable" | "disable") if scope == "user" => Vec::new(),
        ("grok", "install" | "enable" | "disable" | "uninstall" | "update") if scope == "user" => {
            let mut args = vec!["plugin", action, plugin_id];
            if action == "uninstall" {
                args.push("--keep-data");
            }
            args
        }
        ("agy", "install" | "enable" | "disable" | "uninstall") if scope == "user" => {
            vec!["plugin", action, plugin_id]
        }
        ("qoder" | "qoder-cn", "install" | "enable" | "disable" | "uninstall")
            if matches!(scope, "user" | "project" | "local") =>
        {
            let mut args = vec!["plugins", action, plugin_id, "--scope", scope];
            if action == "uninstall" {
                args.push("--keep-data");
            }
            args
        }
        ("pi", "install" | "uninstall") if matches!(scope, "user" | "project") => {
            let action = if action == "uninstall" {
                "remove"
            } else {
                "install"
            };
            let mut args = vec![action, plugin_id];
            if scope == "project" {
                args.push("--local");
            }
            args
        }
        ("omp", "install" | "enable" | "disable" | "uninstall" | "update")
            if matches!(scope, "user" | "project") =>
        {
            if kind == Some("npm") && scope != "user" {
                return Err("OMP npm plugins use user scope".into());
            }
            let verb = if action == "update" {
                "upgrade"
            } else {
                action
            };
            let mut args = vec!["plugin", verb, plugin_id];
            if kind == Some("marketplace") || scope == "project" {
                args.extend(["--scope", scope]);
            }
            args
        }
        ("dsh", "install" | "uninstall") if dsh_profile(scope).is_some() => {
            let profile = dsh_profile(scope).ok_or("Invalid DSh profile")?;
            vec![
                "plugin",
                "--profile",
                profile,
                if action == "install" { "add" } else { "remove" },
                plugin_id,
            ]
        }
        _ => return Err("This plugin operation is not available for the selected scope".into()),
    };
    Ok(args.into_iter().map(str::to_owned).collect())
}

#[tauri::command]
pub(crate) async fn cli_plugins_action(
    state: tauri::State<'_, crate::AppState>,
    request: CliPluginActionRequest,
) -> Result<(), String> {
    if !crate::config::ENGINES.contains(&request.engine.as_str()) {
        return Err("Unknown CLI engine".into());
    }
    let workspace = validate_workspace(request.workspace.as_deref(), &state.db)?;
    if matches!(request.scope.as_str(), "project" | "local") && workspace.is_none() {
        return Err("A workspace is required for this plugin scope".into());
    }
    let mut action_id = request.plugin_id.clone();
    if action_id.len() > 4096 || action_id.chars().any(char::is_control) {
        return Err("Invalid plugin selection".into());
    }
    if request.engine == "dsh" && request.action == "install" {
        let profile = dsh_profile(&request.scope).ok_or("Invalid DSh profile")?;
        let home = resolve_from_cli_cwd(
            crate::engine::engine_home(Some("DSH_HOME"), ".dsh"),
            workspace.as_deref(),
        );
        if !dsh::read_plugins(&home)?
            .profiles
            .iter()
            .any(|item| item.name == profile)
        {
            return Err("DSh profile no longer exists; refresh the list".into());
        }
    }
    let mut kind = None;
    if request.action != "install" {
        let current = discover(&request.engine, workspace.as_deref()).await?;
        let entry = current
            .plugins
            .iter()
            .find(|plugin| {
                plugin.entry.record_key.as_deref().map_or_else(
                    || plugin.entry.id == request.plugin_id,
                    |key| key == request.plugin_id,
                ) && plugin.entry.scope == request.scope
            })
            .ok_or("Plugin no longer exists in this scope; refresh the list")?;
        let allowed = match request.action.as_str() {
            "enable" | "disable" => entry.entry.can_toggle,
            "uninstall" => entry.entry.can_uninstall,
            "update" => entry.entry.can_update,
            _ => false,
        };
        if !allowed {
            return Err("This plugin operation is not available".into());
        }
        action_id = entry.entry.id.clone();
        // Grok's stable registry key identifies the row, but its CLI's
        // mutation commands accept the plugin name, not that registry key.
        if request.engine == "grok" {
            action_id = entry.entry.name.clone();
        }
        if request.engine == "pi" {
            action_id = entry.source_path.clone();
        }
        if request.engine == "omp" {
            kind = entry
                .entry
                .record_key
                .as_deref()
                .and_then(|key| key.split(':').next())
                .map(str::to_owned);
        }
    }
    let args = action_args(
        &request.engine,
        &request.action,
        &action_id,
        &request.scope,
        kind.as_deref(),
    )?;
    let result =
        if request.engine == "codex" && matches!(request.action.as_str(), "enable" | "disable") {
            let settings = crate::settings::read_settings().unwrap_or_default();
            let bin = crate::engine::engine_bin(&settings, "codex");
            let home = resolve_from_cli_cwd(crate::engine::codex_home(), workspace.as_deref());
            codex_toggle::set_enabled(
                &bin,
                &home,
                workspace.as_deref().map(Path::new),
                &action_id,
                request.action == "enable",
            )
            .await
        } else {
            run_cli(&request.engine, &args, workspace.as_deref(), ACTION_TIMEOUT)
                .await
                .map(|_| ())
        };
    // A failed CLI operation can still have changed its native configuration.
    state.emitters.emit_json("cli-plugins://changed", "null");
    state.emitters.emit_json("mcp://changed", "null");
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn fake_plugin_cli(engine: &str, stderr: &str, exit_code: u8) -> Result<String, String> {
        #[cfg(windows)]
        let (bin, args) = (
            "powershell.exe",
            vec![
                "-NoLogo".into(), "-NoProfile".into(), "-NonInteractive".into(), "-Command".into(),
                format!("[Console]::Out.Write('fake-output-key'); [Console]::Error.Write('{stderr}'); exit {exit_code}"),
            ],
        );
        #[cfg(not(windows))]
        let (bin, args) = (
            "/bin/sh",
            vec![
                "-c".into(),
                format!("printf fake-output-key; printf '{stderr}' >&2; exit {exit_code}"),
            ],
        );
        run_cli_with_bin(engine, bin, &args, None, Duration::from_secs(20)).await
    }

    #[tokio::test]
    async fn agy_plugin_org_policy_error_is_safe_and_specific() {
        let diagnostic = "plugins are disabled by your organization; fake-api-key https://secret.test/?token=fake-token";
        let error = fake_plugin_cli("agy", diagnostic, 1).await.unwrap_err();
        assert_eq!(error, "agy_plugins_disabled_by_org");
    }

    #[tokio::test]
    async fn plugin_other_failures_remain_generic_and_private() {
        for (engine, diagnostic) in [
            (
                "claude",
                "plugins are disabled by your organization; fake-api-key",
            ),
            ("agy", "unknown failure fake-api-key"),
        ] {
            let error = fake_plugin_cli(engine, diagnostic, 1).await.unwrap_err();
            assert!(
                error.starts_with(&format!("{engine}: plugin command failed (")),
                "{error}"
            );
            assert!(error.ends_with("inspect the native CLI for details"));
            assert!(!error.contains("fake-"));
        }
    }

    #[tokio::test]
    async fn agy_plugin_success_does_not_classify_stderr() {
        assert_eq!(
            fake_plugin_cli("agy", "plugins are disabled by your organization", 0)
                .await
                .unwrap(),
            "fake-output-key"
        );
    }

    #[test]
    fn kimi_inventory_is_read_only_and_rejects_mutations() {
        let (support, _, scopes) = supported("kimi");
        assert_eq!(support, "read_only");
        assert!(scopes.is_empty());
        for action in ["install", "enable", "disable", "uninstall", "update"] {
            assert!(action_args("kimi", action, "example", "user", None).is_err());
        }
    }

    #[test]
    fn action_arguments_reject_shell_metacharacters_and_unrecognised_scopes() {
        for input in ["-x", "foo & calc", "foo%PATH%", "a\nother", "a|b"] {
            assert!(action_args("claude", "install", input, "user", None).is_err());
        }
        assert!(action_args("claude", "install", "example@market", "managed", None).is_err());
        assert!(action_args("codex", "enable", "example@market", "project", None).is_err());
        assert!(
            action_args("codex", "enable", "example@market", "user", None)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            action_args("dsh", "install", "example", "profile:web", None).unwrap(),
            ["plugin", "--profile", "web", "add", "example"]
        );
        assert!(action_args("dsh", "install", "example", "profile:../bad", None).is_err());
        assert_eq!(
            action_args("claude", "uninstall", "example@market", "project", None).unwrap(),
            [
                "plugin",
                "uninstall",
                "example@market",
                "--scope",
                "project",
                "--json",
                "--keep-data"
            ]
        );
    }

    #[test]
    fn relative_cli_home_is_resolved_against_workspace() {
        let workspace = std::env::temp_dir();
        let result = resolve_from_cli_cwd("relative-home".into(), workspace.to_str());
        assert_eq!(result, workspace.join("relative-home"));
    }

    #[test]
    fn file_grants_do_not_authorize_plugin_workspace_actions() {
        let scratch = crate::plugins::test_support::Scratch::new();
        let db = crate::db::Db::open_in_memory().unwrap();
        let path = scratch.0.to_string_lossy().into_owned();
        db.add_granted_root(&path).unwrap();
        assert!(validate_workspace(Some(&path), &db).is_err());
        db.0.lock()
            .execute(
                "INSERT INTO workspaces(id,path,name) VALUES('workspace',?1,'workspace')",
                [&path],
            )
            .unwrap();
        assert!(validate_workspace(Some(&path), &db).is_ok());
        let child = scratch.0.join("not-registered");
        std::fs::create_dir(&child).unwrap();
        assert!(validate_workspace(child.to_str(), &db).is_err());
        let meta = r#"{"wsl":{"host":"example.test","user":"tester","distro":"Ubuntu"}}"#;
        db.0.lock()
            .execute("UPDATE workspaces SET meta=?1 WHERE id='workspace'", [meta])
            .unwrap();
        let alias = scratch.0.join(".");
        assert!(validate_workspace(alias.to_str(), &db).is_err());
    }

    #[test]
    fn kimi_home_keeps_native_literal_override_and_dev_isolation() {
        use std::ffi::OsStr;
        let base = std::env::temp_dir();
        let home = base.join("home");
        let cwd = base.join("workspace");
        let dev = base.join("dev");
        assert_eq!(
            kimi_home_for_cli(Some(OsStr::new("~/literal")), None, &home, &cwd),
            cwd.join("~/literal")
        );
        assert_eq!(
            kimi_home_for_cli(Some(OsStr::new("other")), Some(&dev), &home, &cwd),
            dev.join(".kimi-code")
        );
        assert_eq!(
            kimi_home_for_cli(None, None, &home, &cwd),
            home.join(".kimi-code")
        );
    }

    #[test]
    fn package_urls_are_redacted_and_private_ids_are_stable() {
        let source = "git:https://alice:secret@example.test/repo?token=private&x=1#ref";
        let label = display_package_source(source);
        assert!(!label.contains("alice"));
        assert!(!label.contains("secret"));
        assert!(!label.contains("private"));
        assert!(!label.contains("#ref"));
        assert!(!display_package_source("git:example/repo#private-fragment")
            .contains("private-fragment"));
        let id = private_record_id("pi", "user", source);
        assert!(!id.contains("secret"));
        assert_ne!(id, private_record_id("pi", "project", source));
    }

    #[test]
    fn broken_grok_bundle_does_not_hide_its_plugin_record_or_leak_config() {
        let raw = serde_json::json!([{"name":"demo","repo_key":"demo-key","path":"relative/private-secret"}]);
        let discovery = grok_discovery(&raw.to_string(), None).unwrap();
        assert_eq!(discovery.plugins.len(), 1);
        assert_eq!(discovery.plugins[0].entry.id, "demo-key");
        assert!(!discovery.plugins[0].entry.mcp_servers_known);
        assert!(!discovery.warnings.join(" ").contains("private-secret"));
    }

    #[test]
    fn codex_does_not_invent_installed_state_or_hide_a_broken_bundle() {
        let raw = serde_json::json!({"installed": [
            {"pluginId":"broken@market","name":"broken","installed":true,"enabled":true,"version":"../bad"},
            {"pluginId":"unknown@market","name":"unknown"}
        ]});
        let discovery = codex_discovery(&raw.to_string(), None).unwrap();
        assert_eq!(discovery.plugins.len(), 1);
        assert_eq!(discovery.plugins[0].entry.id, "broken@market");
        assert!(!discovery.plugins[0].entry.mcp_servers_known);
        assert_eq!(discovery.warnings.len(), 2);
    }

    #[tokio::test]
    #[ignore = "explicit read-only smoke test requires installed native CLIs and a workspace"]
    async fn native_readonly_inventory_smoke() {
        let workspace = std::env::var("CCGUI_NATIVE_PLUGIN_TEST_WORKSPACE")
            .expect("explicit workspace required");
        for engine in ["claude", "codex", "grok", "agy"] {
            let result = discover(engine, Some(&workspace)).await;
            assert!(result.is_ok(), "{engine} inventory failed");
            let discovery = result.unwrap();
            assert!(discovery
                .plugins
                .iter()
                .all(|plugin| !plugin.entry.id.is_empty()));
            if engine == "claude" {
                if let Ok(expected) = std::env::var("CCGUI_NATIVE_PLUGIN_EXPECTED_CLAUDE") {
                    let plugin = discovery
                        .plugins
                        .iter()
                        .find(|plugin| plugin.entry.id == expected)
                        .expect("expected Claude plugin missing from native inventory");
                    if let Ok(expected_mcp) = std::env::var("CCGUI_NATIVE_PLUGIN_EXPECTED_MCP") {
                        assert!(
                            plugin
                                .entry
                                .mcp_servers
                                .iter()
                                .any(|server| server == &expected_mcp),
                            "expected Claude plugin MCP declaration missing"
                        );
                    }
                }
            }
        }
    }
}
