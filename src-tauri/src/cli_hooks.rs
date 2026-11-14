//! Read-only inventory of native CLI hook declarations. Hook bodies, arguments,
//! environment variables and input payloads never cross the IPC boundary.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_HOOKS: usize = 2048;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HookEntry {
    id: String,
    event: String,
    matcher: Option<String>,
    handler_type: String,
    label: Option<String>,
    source: String,
    source_path: Option<String>,
    plugin_id: Option<String>,
    plugin_scope: Option<String>,
    enabled: Option<bool>,
    trust: Option<String>,
    managed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    toggle: Option<HookToggle>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HookToggle {
    scope: String,
    name: String,
    version: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HookInventory {
    engine: String,
    workspace: Option<String>,
    coverage: &'static str,
    warnings: Vec<&'static str>,
    entries: Vec<HookEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HookToggleRequest {
    engine: String,
    workspace: Option<String>,
    scope: String,
    name: String,
    version: String,
    enabled: bool,
}

static HOOK_WRITE_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

#[derive(Clone)]
struct Source {
    engine: String,
    scope: String,
    path: Option<String>,
    plugin_id: Option<String>,
    plugin_scope: Option<String>,
    plugin_name: Option<String>,
    plugin_enabled: Option<bool>,
    version: Option<String>,
    fragment: String,
}

fn safe_text(value: Option<&str>, max: usize) -> Option<String> {
    let value = value?.trim();
    if value.is_empty() || value.chars().any(char::is_control) {
        return None;
    }
    Some(value.chars().take(max).collect())
}

/// Only a command's executable name is shown; arguments may contain secrets.
fn command_label(value: Option<&str>) -> Option<String> {
    let first = value?
        .trim()
        .split_whitespace()
        .next()?
        .trim_matches(['\'', '"']);
    let name = first.rsplit(['/', '\\']).next()?;
    if name.is_empty()
        || name.len() > 100
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
    {
        return None;
    }
    Some(name.to_owned())
}

fn handler_label(handler: &Value, kind: &str) -> Option<String> {
    if matches!(kind, "mcp_tool" | "mcpTool") {
        let server = safe_text(handler.get("server").and_then(Value::as_str), 100)?;
        let tool = safe_text(handler.get("tool").and_then(Value::as_str), 100)?;
        return Some(format!("{server} / {tool}"));
    }
    safe_text(handler.get("name").and_then(Value::as_str), 120)
        .or_else(|| command_label(handler.get("command").and_then(Value::as_str)))
}

fn push_entry(
    out: &mut Vec<HookEntry>,
    source: &Source,
    event: &str,
    matcher: Option<&str>,
    handler: &Value,
    index: &str,
    named: Option<&str>,
    configured: Option<bool>,
) {
    if out.len() >= MAX_HOOKS || !handler.is_object() {
        return;
    }
    let Some(event) = safe_text(Some(event), 120) else {
        return;
    };
    let kind = safe_text(handler.get("type").and_then(Value::as_str), 60)
        .unwrap_or_else(|| "command".into());
    let enabled = if source.plugin_enabled == Some(false) {
        Some(false)
    } else {
        configured
    };
    let identity = serde_json::to_vec(&(
        &source.engine,
        &source.scope,
        &source.path,
        &source.plugin_id,
        &source.fragment,
        &event,
        index,
    ))
    .unwrap_or_default();
    out.push(HookEntry {
        id: format!("{:x}", Sha256::digest(identity)),
        event,
        matcher: safe_text(matcher, 240),
        handler_type: kind.clone(),
        label: safe_text(named, 120)
            .or_else(|| handler_label(handler, &kind))
            .or_else(|| source.plugin_name.clone()),
        source: source.scope.clone(),
        source_path: source.path.clone(),
        plugin_id: source.plugin_id.clone(),
        plugin_scope: source.plugin_scope.clone(),
        enabled,
        trust: None,
        managed: false,
        toggle: if source.engine == "agy" && matches!(source.scope.as_str(), "user" | "project") {
            named
                .filter(|name| {
                    !name.is_empty() && name.len() <= 256 && !name.chars().any(char::is_control)
                })
                .zip(source.version.as_deref())
                .map(|(name, version)| HookToggle {
                    scope: source.scope.clone(),
                    name: name.to_owned(),
                    version: version.to_owned(),
                })
        } else {
            None
        },
    });
}

fn parse_grouped(value: &Value, source: &Source, out: &mut Vec<HookEntry>) {
    let events = value.get("hooks").and_then(Value::as_object).or_else(|| {
        (source.scope == "plugin")
            .then(|| value.as_object())
            .flatten()
    });
    let Some(events) = events else {
        return;
    };
    for (event, groups) in events {
        let Some(groups) = groups.as_array() else {
            continue;
        };
        for (i, group) in groups.iter().enumerate() {
            let matcher = group.get("matcher").and_then(Value::as_str);
            if let Some(handlers) = group.get("hooks").and_then(Value::as_array) {
                for (j, handler) in handlers.iter().enumerate() {
                    push_entry(
                        out,
                        source,
                        event,
                        matcher,
                        handler,
                        &format!("{i}:{j}"),
                        None,
                        None,
                    );
                }
            } else {
                push_entry(
                    out,
                    source,
                    event,
                    matcher,
                    group,
                    &format!("{i}"),
                    None,
                    None,
                );
            }
        }
    }
}

fn parse_accepted_named(value: &Value, source: &Source, out: &mut Vec<HookEntry>) {
    let Some(hooks) = value.as_object() else {
        return;
    };
    for (name, definition) in hooks {
        let Some(definition) = definition.as_object() else {
            continue;
        };
        let configured = match definition.get("enabled") {
            None => Some(true),
            Some(Value::Bool(value)) => Some(*value),
            _ => None,
        };
        let mut group_source = source.clone();
        if configured.is_none() {
            group_source.version = None;
        }
        for (event, groups) in definition {
            let Some(groups) = groups.as_array() else {
                continue;
            };
            for (i, group) in groups.iter().enumerate() {
                let matcher = group.get("matcher").and_then(Value::as_str);
                if let Some(handlers) = group.get("hooks").and_then(Value::as_array) {
                    for (j, handler) in handlers.iter().enumerate() {
                        push_entry(
                            out,
                            &group_source,
                            event,
                            matcher,
                            handler,
                            &format!("{name}:{i}:{j}"),
                            Some(name),
                            configured,
                        );
                    }
                } else {
                    push_entry(
                        out,
                        &group_source,
                        event,
                        matcher,
                        group,
                        &format!("{name}:{i}"),
                        Some(name),
                        configured,
                    );
                }
            }
        }
    }
}

fn read_bytes(path: &Path) -> Result<Option<Vec<u8>>, ()> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(());
    }
    Ok(Some(bytes))
}

const UTF8_BOM: &[u8] = b"\xef\xbb\xbf";

fn parse_json(bytes: &[u8]) -> Result<Value, serde_json::Error> {
    // Keep the original bytes for version hashes and concurrent-write checks.
    serde_json::from_slice(bytes.strip_prefix(UTF8_BOM).unwrap_or(bytes))
}

fn read_json(path: &Path) -> Result<Option<Value>, ()> {
    let Some(bytes) = read_bytes(path)? else {
        return Ok(None);
    };
    parse_json(&bytes).map(Some).map_err(|_| ())
}

fn source(engine: &str, scope: &str, path: &Path) -> Source {
    Source {
        engine: engine.into(),
        scope: scope.into(),
        path: Some(path.to_string_lossy().into_owned()),
        plugin_id: None,
        plugin_scope: None,
        plugin_name: None,
        plugin_enabled: None,
        version: None,
        fragment: String::new(),
    }
}

fn cli_home(path: PathBuf, workspace: Option<&Path>, home: &Path) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        workspace.unwrap_or(home).join(path)
    }
}

fn writable_named_source(path: &Path, scope: &str) -> bool {
    let root = match scope {
        "user" => crate::paths::home_dir(),
        "project" => match path.parent().and_then(Path::parent) { Some(root) => root.to_path_buf(), None => return false },
        _ => return false,
    };
    let Ok(root) = root.canonicalize() else { return false; };
    let Ok(target) = path.canonicalize() else { return false; };
    target.starts_with(root) && std::fs::symlink_metadata(path)
        .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink() && !metadata.permissions().readonly())
}

fn add_json(
    path: PathBuf,
    engine: &str,
    scope: &str,
    named: bool,
    out: &mut Vec<HookEntry>,
    warnings: &mut Vec<&'static str>,
) {
    match read_bytes(&path) {
        Ok(Some(bytes)) => {
            let Ok(value) = parse_json(&bytes) else {
                warnings.push("config_unreadable");
                return;
            };
            let mut origin = source(engine, scope, &path);
            if named && engine == "agy" && writable_named_source(&path, scope) {
                origin.version = Some(format!("{:x}", Sha256::digest(&bytes)));
            }
            if named {
                parse_accepted_named(&value, &origin, out);
            } else {
                parse_grouped(&value, &origin, out);
            }
        }
        Ok(None) => {}
        Err(_) => warnings.push("config_unreadable"),
    }
}

fn add_toml(
    path: PathBuf,
    engine: &str,
    scope: &str,
    flat: bool,
    out: &mut Vec<HookEntry>,
    warnings: &mut Vec<&'static str>,
) {
    let bytes = match read_bytes(&path) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return,
        Err(_) => {
            warnings.push("config_unreadable");
            return;
        }
    };
    let parsed = std::str::from_utf8(&bytes)
        .ok()
        .and_then(|text| toml::from_str::<toml::Value>(text).ok())
        .and_then(|value| serde_json::to_value(value).ok());
    let Some(value) = parsed else {
        warnings.push("config_unreadable");
        return;
    };
    let source = source(engine, scope, &path);
    if flat {
        if let Some(hooks) = value.get("hooks").and_then(Value::as_array) {
            for (index, hook) in hooks.iter().enumerate() {
                if let Some(event) = hook.get("event").and_then(Value::as_str) {
                    push_entry(
                        out,
                        &source,
                        event,
                        hook.get("matcher").and_then(Value::as_str),
                        hook,
                        &index.to_string(),
                        None,
                        None,
                    );
                }
            }
        }
    } else {
        parse_grouped(&value, &source, out);
    }
}

fn codex_native(value: &Value, out: &mut Vec<HookEntry>) -> Result<(), ()> {
    let data = value.get("data").and_then(Value::as_array).ok_or(())?;
    for item in data {
        let hooks = item.get("hooks").and_then(Value::as_array).ok_or(())?;
        for hook in hooks {
            if out.len() >= MAX_HOOKS {
                break;
            }
            let key = hook.get("key").and_then(Value::as_str).ok_or(())?;
            let event = safe_text(hook.get("eventName").and_then(Value::as_str), 120).ok_or(())?;
            let kind = safe_text(hook.get("handlerType").and_then(Value::as_str), 60)
                .unwrap_or_else(|| "unknown".into());
            let id = format!("{:x}", Sha256::digest(key.as_bytes()));
            let managed_state = hook.get("isManaged").and_then(Value::as_bool);
            let managed = managed_state == Some(true);
            let enabled = hook.get("enabled").and_then(Value::as_bool);
            let hash = hook
                .get("currentHash")
                .and_then(Value::as_str)
                .filter(|hash| {
                    hash.len() == 71
                        && hash.starts_with("sha256:")
                        && hash[7..]
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                });
            let toggle = if managed_state == Some(false) && enabled.is_some() {
                hash.map(|hash| HookToggle {
                    scope: "codex".into(),
                    name: id.clone(),
                    version: hash.into(),
                })
            } else {
                None
            };
            out.push(HookEntry {
                id,
                event,
                matcher: safe_text(hook.get("matcher").and_then(Value::as_str), 240),
                handler_type: kind.clone(),
                label: handler_label(hook, &kind),
                source: safe_text(hook.get("source").and_then(Value::as_str), 60)
                    .unwrap_or_else(|| "unknown".into()),
                source_path: safe_text(hook.get("sourcePath").and_then(Value::as_str), 2048),
                plugin_id: safe_text(hook.get("pluginId").and_then(Value::as_str), 256),
                plugin_scope: None,
                enabled,
                trust: safe_text(hook.get("trustStatus").and_then(Value::as_str), 60),
                managed,
                toggle,
            });
        }
    }
    Ok(())
}

fn confined(root: &Path, relative: &str) -> Result<PathBuf, ()> {
    let rel = Path::new(relative);
    if rel.is_absolute()
        || relative.contains(':')
        || relative.split(['/', '\\']).any(|part| part == "..")
        || rel.components().any(|part| {
            matches!(
                part,
                Component::Prefix(_) | Component::RootDir | Component::ParentDir
            )
        })
    {
        return Err(());
    }
    let root = root.canonicalize().map_err(|_| ())?;
    let target = root.join(rel).canonicalize().map_err(|_| ())?;
    if !target.starts_with(&root) {
        return Err(());
    }
    Ok(target)
}

fn plugin_spec(
    spec: &Value,
    root: &Path,
    source: &Source,
    named: bool,
    out: &mut Vec<HookEntry>,
    warnings: &mut Vec<&'static str>,
) {
    match spec {
        Value::String(relative) => match confined(root, relative)
            .and_then(|path| read_json(&path).map(|value| (path, value)))
        {
            Ok((path, Some(value))) => {
                let mut nested = source.clone();
                nested.path = Some(path.to_string_lossy().into_owned());
                if named {
                    parse_accepted_named(&value, &nested, out);
                } else {
                    parse_grouped(&value, &nested, out);
                }
            }
            _ => warnings.push("plugin_partial"),
        },
        Value::Object(_) => {
            if named {
                parse_accepted_named(spec, source, out);
            } else {
                parse_grouped(spec, source, out);
            }
        }
        Value::Array(values) if values.len() <= 32 => {
            for (index, value) in values.iter().enumerate() {
                if value.is_array() {
                    warnings.push("plugin_partial");
                } else {
                    let mut nested = source.clone();
                    nested.fragment.push_str(&format!(":{index}"));
                    plugin_spec(value, root, &nested, named, out, warnings);
                }
            }
        }
        _ => warnings.push("plugin_partial"),
    }
}

fn plugin_hooks(
    engine: &str,
    plugin: crate::cli_plugins::HookPluginSource,
    out: &mut Vec<HookEntry>,
    warnings: &mut Vec<&'static str>,
) {
    let root = PathBuf::from(&plugin.source_path);
    if !root.is_absolute() || !root.is_dir() {
        warnings.push("plugin_partial");
        return;
    }
    let source = Source {
        engine: engine.into(),
        scope: "plugin".into(),
        path: Some(plugin.source_path.clone()),
        plugin_id: Some(plugin.id),
        plugin_scope: Some(plugin.scope),
        plugin_name: Some(plugin.name),
        plugin_enabled: plugin.enabled,
        version: None,
        fragment: String::new(),
    };
    let named = engine == "agy";
    if named {
        let candidate = root.join("hooks.json");
        if candidate.exists() {
            plugin_spec(
                &Value::String("hooks.json".into()),
                &root,
                &source,
                true,
                out,
                warnings,
            );
        }
        return;
    }
    let manifest = match engine {
        "codex" => ["plugin.json", ".codex-plugin/plugin.json"],
        "claude" => [".claude-plugin/plugin.json", "plugin.json"],
        "cursor" => [".cursor-plugin/plugin.json", "plugin.json"],
        "qoder" | "qoder-cn" => [".qoder-plugin/plugin.json", "plugin.json"],
        _ => return,
    };
    let mut spec = None;
    for name in manifest {
        if let Ok(path) = confined(&root, name) {
            if let Ok(Some(value)) = read_json(&path) {
                let selected = if engine == "codex" {
                    value
                        .get("extensions")
                        .and_then(|v| v.get("com.openai"))
                        .unwrap_or(&value)
                } else {
                    &value
                };
                spec = selected.get("hooks").cloned();
                break;
            }
        }
    }
    if let Some(spec) = spec {
        plugin_spec(&spec, &root, &source, false, out, warnings);
    } else if root.join("hooks/hooks.json").exists() {
        plugin_spec(
            &Value::String("hooks/hooks.json".into()),
            &root,
            &source,
            false,
            out,
            warnings,
        );
    }
}

fn grok_native(value: &Value, out: &mut Vec<HookEntry>) -> Result<(), ()> {
    let hooks = value.get("hooks").and_then(Value::as_array).ok_or(())?;
    for (index, hook) in hooks.iter().enumerate() {
        let Some(event) = hook.get("event").and_then(Value::as_str) else {
            continue;
        };
        let origin = hook.get("source").unwrap_or(&Value::Null);
        let source = Source {
            engine: "grok".into(),
            scope: safe_text(origin.get("type").and_then(Value::as_str), 60)
                .unwrap_or_else(|| "unknown".into()),
            path: safe_text(origin.get("path").and_then(Value::as_str), 2048),
            plugin_id: None,
            plugin_scope: None,
            plugin_name: None,
            plugin_enabled: None,
            version: None,
            fragment: String::new(),
        };
        let kind = hook
            .get("hookType")
            .and_then(Value::as_str)
            .unwrap_or("command");
        let synthetic = serde_json::json!({"type":kind,"command":hook.get("target")});
        push_entry(
            out,
            &source,
            event,
            hook.get("matcher").and_then(Value::as_str),
            &synthetic,
            &index.to_string(),
            None,
            None,
        );
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn cli_hooks_inventory(
    db: tauri::State<'_, Arc<crate::db::Db>>,
    engine: String,
    workspace: Option<String>,
) -> Result<HookInventory, String> {
    if !crate::config::ENGINES.contains(&engine.as_str()) {
        return Err("Unknown CLI engine".into());
    }
    let workspace = crate::cli_plugins::validate_workspace(workspace.as_deref(), &db)?;
    let project = workspace.as_deref().map(Path::new);
    let home = crate::paths::home_dir();
    let mut entries = Vec::new();
    let mut warnings = Vec::new();
    let mut codex_native_ok = false;
    let coverage = match engine.as_str() {
        "codex" => {
            let cwd = project.unwrap_or(&home);
            let mut native_entries = Vec::new();
            match crate::engine::codex_app::read_hook_inventory(cwd).await {
                Ok(value) if codex_native(&value, &mut native_entries).is_ok() => {
                    entries.extend(native_entries);
                    codex_native_ok = true;
                }
                _ => warnings.push("native_unavailable"),
            }
            if !codex_native_ok {
                let codex = cli_home(crate::engine::codex_home(), project, &home);
                add_json(
                    codex.join("hooks.json"),
                    &engine,
                    "user",
                    false,
                    &mut entries,
                    &mut warnings,
                );
                add_toml(
                    codex.join("config.toml"),
                    &engine,
                    "user",
                    false,
                    &mut entries,
                    &mut warnings,
                );
                if let Some(project) = project {
                    add_json(
                        project.join(".codex/hooks.json"),
                        &engine,
                        "project",
                        false,
                        &mut entries,
                        &mut warnings,
                    );
                    add_toml(
                        project.join(".codex/config.toml"),
                        &engine,
                        "project",
                        false,
                        &mut entries,
                        &mut warnings,
                    );
                }
            }
            "partial"
        }
        "claude" | "qoder" | "qoder-cn" => {
            let dir = match engine.as_str() {
                "claude" => ".claude",
                "qoder-cn" => ".qoder-cn",
                _ => ".qoder",
            };
            let global = if engine == "claude" {
                cli_home(
                    crate::engine::engine_home(Some("CLAUDE_CONFIG_DIR"), ".claude"),
                    project,
                    &home,
                )
            } else {
                home.join(dir)
            };
            add_json(
                global.join("settings.json"),
                &engine,
                "user",
                false,
                &mut entries,
                &mut warnings,
            );
            if let Some(project) = project {
                add_json(
                    project.join(dir).join("settings.json"),
                    &engine,
                    "project",
                    false,
                    &mut entries,
                    &mut warnings,
                );
                add_json(
                    project.join(dir).join("settings.local.json"),
                    &engine,
                    "local",
                    false,
                    &mut entries,
                    &mut warnings,
                );
            }
            "partial"
        }
        "cursor" => {
            add_json(
                cli_home(crate::engine::cursor::cursor_home(), project, &home).join("hooks.json"),
                &engine,
                "user",
                false,
                &mut entries,
                &mut warnings,
            );
            if let Some(project) = project {
                add_json(
                    project.join(".cursor/hooks.json"),
                    &engine,
                    "project",
                    false,
                    &mut entries,
                    &mut warnings,
                );
            }
            warnings.push("third_party_unknown");
            "partial"
        }
        "agy" => {
            add_json(
                home.join(".gemini/config/hooks.json"),
                &engine,
                "user",
                true,
                &mut entries,
                &mut warnings,
            );
            if let Some(project) = project {
                add_json(
                    project.join(".agents/hooks.json"),
                    &engine,
                    "project",
                    true,
                    &mut entries,
                    &mut warnings,
                );
            }
            "partial"
        }
        "kimi" => {
            let kimi = cli_home(
                crate::engine::engine_home(Some("KIMI_CODE_HOME"), ".kimi-code"),
                project,
                &home,
            );
            add_toml(
                kimi.join("config.toml"),
                &engine,
                "user",
                true,
                &mut entries,
                &mut warnings,
            );
            "partial"
        }
        "grok" => {
            match crate::cli_plugins::grok_hook_inventory(workspace.as_deref()).await {
                Ok(value) if grok_native(&value, &mut entries).is_ok() => {}
                _ => warnings.push("native_unavailable"),
            }
            "partial"
        }
        _ => "unknown",
    };
    if matches!(
        engine.as_str(),
        "codex" | "claude" | "cursor" | "agy" | "qoder" | "qoder-cn"
    ) {
        match crate::cli_plugins::hook_sources(&engine, workspace.as_deref()).await {
            Ok((plugins, partial)) => {
                if partial {
                    warnings.push("plugin_partial");
                }
                for plugin in plugins {
                    for entry in entries
                        .iter_mut()
                        .filter(|entry| entry.plugin_id.as_deref() == Some(plugin.id.as_str()))
                    {
                        entry.plugin_scope = Some(plugin.scope.clone());
                    }
                    if engine == "codex" && codex_native_ok && plugin.enabled != Some(false) {
                        continue;
                    }
                    plugin_hooks(&engine, plugin, &mut entries, &mut warnings);
                }
            }
            Err(_) => warnings.push("plugin_unavailable"),
        }
    }
    if entries.len() >= MAX_HOOKS {
        warnings.push("truncated");
    }
    warnings.sort_unstable();
    warnings.dedup();
    entries.sort_by(|a, b| {
        a.source
            .cmp(&b.source)
            .then_with(|| a.plugin_id.cmp(&b.plugin_id))
            .then_with(|| a.event.cmp(&b.event))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(HookInventory {
        engine,
        workspace,
        coverage,
        warnings,
        entries,
    })
}

fn set_named_enabled(
    path: &Path,
    allowed_root: &Path,
    name: &str,
    version: &str,
    enabled: bool,
) -> Result<(), String> {
    use std::io::Write;
    if name.is_empty()
        || name.len() > 256
        || name.chars().any(char::is_control)
        || version.len() != 64
        || !version
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Invalid hook selection".into());
    }
    let _lock = HOOK_WRITE_LOCK.lock();
    let root = allowed_root
        .canonicalize()
        .map_err(|_| "Cannot resolve hook scope")?;
    let original = path
        .canonicalize()
        .map_err(|_| "Hook configuration is unavailable")?;
    if !original.starts_with(&root)
        || std::fs::symlink_metadata(path)
            .map_err(|_| "Cannot inspect hook configuration")?
            .file_type()
            .is_symlink()
    {
        return Err("Hook configuration is outside the selected scope".into());
    }
    let bytes = read_bytes(&original)
        .map_err(|_| "Cannot read hook configuration")?
        .ok_or("Hook configuration is unavailable")?;
    if format!("{:x}", Sha256::digest(&bytes)) != version {
        return Err("Hook configuration changed; refresh and retry".into());
    }
    let mut value = parse_json(&bytes).map_err(|_| "Invalid hook configuration")?;
    let group = value
        .as_object_mut()
        .and_then(|root| root.get_mut(name))
        .and_then(Value::as_object_mut)
        .ok_or("Hook no longer exists; refresh and retry")?;
    if group
        .get("enabled")
        .is_some_and(|value| !value.is_boolean())
        || !group
            .iter()
            .any(|(key, value)| key != "enabled" && value.is_array())
    {
        return Err("Hook cannot be safely changed".into());
    }
    group.insert("enabled".into(), Value::Bool(enabled));
    let mut output = if bytes.starts_with(UTF8_BOM) {
        UTF8_BOM.to_vec()
    } else {
        Vec::new()
    };
    serde_json::to_writer_pretty(&mut output, &value)
        .map_err(|_| "Cannot encode hook configuration")?;
    output.push(b'\n');
    let parent = original.parent().ok_or("Invalid hook configuration path")?;
    let temporary = parent.join(format!(".ccgui-hooks-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "Cannot write hook configuration")?;
        #[cfg(unix)]
        std::fs::set_permissions(
            &temporary,
            std::fs::metadata(&original)
                .map_err(|_| "Cannot inspect hook permissions")?
                .permissions(),
        )
        .map_err(|_| "Cannot preserve hook permissions")?;
        file.write_all(&output)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Cannot write hook configuration")?;
        drop(file);
        if path.canonicalize().ok().as_deref() != Some(original.as_path())
            || read_bytes(&original).ok().flatten().as_deref() != Some(bytes.as_slice())
        {
            return Err("Hook configuration changed; refresh and retry".into());
        }
        std::fs::rename(&temporary, &original).map_err(|_| "Cannot replace hook configuration")?;
        if read_bytes(&original).ok().flatten().as_deref() != Some(output.as_slice()) {
            return Err("Hook change could not be verified; refresh before retrying".into());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[tauri::command]
pub(crate) async fn cli_hooks_set_enabled(
    state: tauri::State<'_, crate::AppState>,
    request: HookToggleRequest,
) -> Result<(), String> {
    use crate::event_sink::Emit;
    let workspace =
        crate::cli_plugins::validate_workspace(request.workspace.as_deref(), &state.db)?;
    if request.engine == "codex" && request.scope == "codex" {
        let result = crate::cli_plugins::set_codex_hook_enabled(
            workspace.as_deref(),
            &request.name,
            &request.version,
            request.enabled,
        )
        .await;
        state.emitters.emit_json("cli-hooks://changed", "null");
        return result;
    }
    if request.engine != "agy" {
        return Err("This hook source cannot be changed".into());
    }
    let (path, root) = match request.scope.as_str() {
        "user" => {
            let home = crate::paths::home_dir();
            (home.join(".gemini/config/hooks.json"), home)
        }
        "project" => {
            let root = PathBuf::from(workspace.ok_or("A workspace is required")?);
            (root.join(".agents/hooks.json"), root)
        }
        _ => return Err("This hook source cannot be changed".into()),
    };
    let result = set_named_enabled(
        &path,
        &root,
        &request.name,
        &request.version,
        request.enabled,
    );
    state.emitters.emit_json("cli-hooks://changed", "null");
    result
}

#[cfg(test)]
#[path = "cli_hooks_tests.rs"]
mod tests;
