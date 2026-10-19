//! Built-in agent catalog (内置智能体目录): the bundled, read-only
//! agency-agents pack (248 agents / 17 divisions, MIT) that backs the
//! settings-page catalog tab and the composer `#` picker alongside the
//! user-defined agents in agents.rs.
//!
//! Ported from desktop-cc-gui's agent_catalog.rs and adapted to this app's
//! seams: no settings cache in AppState — reads go through
//! `settings::read_settings()` and toggles persist through the locked
//! read→modify→write path (`settings_write_lock` + `persist_settings_committed`),
//! then broadcast `settings://changed` so every surface refreshes.
//!
//! The catalog ships as a bundle resource (`agent-catalogs/agency-agents/`,
//! see tauri.conf.json); in dev it resolves from
//! `src-tauri/resources/agent-catalogs/agency-agents`. Loading fails closed:
//! schema version, provider identity, license, counts, id prefixes, prompt
//! paths, and per-prompt SHA256 are all verified before anything is served.

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;

const PROVIDER_ID: &str = "agency-agents";
const CATALOG_DIR: &str = "agent-catalogs";
const SOURCE_URL: &str = "https://github.com/msitarzewski/agency-agents";
const SOURCE_REVISION: &str = "459dce837db3bdfdc4763d3fefd1fd854e73c8f1";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalizedText {
    en: String,
    #[serde(rename = "zh-CN")]
    zh_cn: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogDivision {
    id: String,
    order: usize,
    count: usize,
    icon: Option<String>,
    color: Option<String>,
    label: LocalizedText,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogManifest {
    schema_version: u32,
    provider_id: String,
    display_name: String,
    source_url: String,
    source_revision: String,
    license: String,
    division_count: usize,
    agent_count: usize,
    divisions: Vec<CatalogDivision>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogAgent {
    id: String,
    provider_id: String,
    division_id: String,
    source_revision: String,
    prompt_path: String,
    prompt_hash: String,
    name: LocalizedText,
    description: LocalizedText,
    emoji: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogAgentsDocument {
    schema_version: u32,
    agents: Vec<CatalogAgent>,
}

#[derive(Debug, Clone)]
struct LoadedCatalog {
    root: PathBuf,
    manifest: CatalogManifest,
    agents: Vec<CatalogAgent>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BuiltInAgentProviderView {
    id: String,
    display_name: String,
    source_url: String,
    source_revision: String,
    license: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BuiltInAgentDivisionView {
    id: String,
    order: usize,
    icon: Option<String>,
    color: Option<String>,
    label: String,
    count: usize,
    enabled_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BuiltInAgentView {
    id: String,
    division_id: String,
    name: String,
    description: String,
    /// Agent emoji badge (the catalog has no per-agent lucide name); the
    /// frontend falls back to a generic icon when absent.
    icon: Option<String>,
    enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BuiltInAgentCatalogView {
    provider: BuiltInAgentProviderView,
    divisions: Vec<BuiltInAgentDivisionView>,
    agents: Vec<BuiltInAgentView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BuiltInAgentPrompt {
    id: String,
    prompt: String,
    prompt_hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolvedBuiltInAgent {
    id: String,
    name: String,
    icon: Option<String>,
    prompt: String,
    prompt_hash: String,
}

/// Sorted, deduped, format-checked id list — the only shape ever persisted.
pub(crate) fn normalized_enabled_builtin_agent_ids(ids: &[String]) -> Vec<String> {
    let mut normalized: Vec<String> = ids
        .iter()
        .filter_map(|id| {
            let trimmed = id.trim();
            if validate_agent_id(trimmed).is_ok() {
                Some(trimmed.to_string())
            } else {
                None
            }
        })
        .collect();
    normalized.sort();
    normalized.dedup();
    normalized
}

fn validate_agent_id(id: &str) -> Result<(), String> {
    let Some(path) = id.strip_prefix("agency-agents:") else {
        return Err("built-in agent id must start with `agency-agents:`".to_string());
    };
    validate_safe_relative_path(path, "built-in agent id")
}

fn validate_safe_relative_path(value: &str, label: &str) -> Result<(), String> {
    if value.trim() != value || value.is_empty() || value.contains('\\') || value.contains(':') {
        return Err(format!("unsafe {} `{}`", label, value));
    }
    let path = Path::new(value);
    if path.is_absolute() {
        return Err(format!("unsafe {} `{}`", label, value));
    }
    for component in path.components() {
        if matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_) | Component::CurDir
        ) {
            return Err(format!("unsafe {} `{}`", label, value));
        }
    }
    Ok(())
}

fn app_resource_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok()
}

fn default_catalog_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(CATALOG_DIR)
        .join(PROVIDER_ID)
}

fn catalog_root_candidates(resource_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(root) = resource_dir {
        candidates.push(root.join(CATALOG_DIR).join(PROVIDER_ID));
        candidates.push(root.join("resources").join(CATALOG_DIR).join(PROVIDER_ID));
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(executable_dir) = executable.parent() {
            if cfg!(target_os = "macos") {
                if let Some(contents_dir) = executable_dir.parent() {
                    candidates.push(
                        contents_dir
                            .join("Resources")
                            .join(CATALOG_DIR)
                            .join(PROVIDER_ID),
                    );
                }
            }
            candidates.push(executable_dir.join(CATALOG_DIR).join(PROVIDER_ID));
        }
    }
    candidates.push(default_catalog_root());
    candidates
}

fn resolve_catalog_root(resource_dir: Option<&Path>) -> Result<PathBuf, String> {
    catalog_root_candidates(resource_dir)
        .into_iter()
        .find(|candidate| candidate.join("manifest.json").is_file())
        .ok_or_else(|| "Agency Agents catalog resource is unavailable".to_string())
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path, label: &str) -> Result<T, String> {
    let raw =
        fs::read_to_string(path).map_err(|error| format!("failed to read {}: {}", label, error))?;
    serde_json::from_str(&raw).map_err(|error| format!("invalid {}: {}", label, error))
}

fn load_catalog(resource_dir: Option<&Path>) -> Result<LoadedCatalog, String> {
    load_catalog_from_root(resolve_catalog_root(resource_dir)?)
}

fn load_catalog_from_root(root: PathBuf) -> Result<LoadedCatalog, String> {
    let manifest: CatalogManifest =
        read_json(&root.join("manifest.json"), "agent catalog manifest")?;
    let document: CatalogAgentsDocument =
        read_json(&root.join("agents.json"), "agent catalog entries")?;
    if manifest.schema_version != 1 || document.schema_version != 1 {
        return Err("unsupported agent catalog schema version".to_string());
    }
    if manifest.provider_id != PROVIDER_ID
        || manifest.source_url != SOURCE_URL
        || manifest.source_revision != SOURCE_REVISION
        || manifest.license != "MIT"
    {
        return Err("unsupported agent catalog identity or license".to_string());
    }
    if manifest.division_count != manifest.divisions.len()
        || manifest.agent_count != document.agents.len()
    {
        return Err("agent catalog manifest count mismatch".to_string());
    }

    let division_ids: HashSet<&str> = manifest
        .divisions
        .iter()
        .map(|division| division.id.as_str())
        .collect();
    let mut agent_ids = HashSet::new();
    for agent in &document.agents {
        validate_agent_id(&agent.id)?;
        validate_safe_relative_path(&agent.prompt_path, "agent prompt path")?;
        if agent.provider_id != PROVIDER_ID
            || agent.source_revision != manifest.source_revision
            || !division_ids.contains(agent.division_id.as_str())
            || !agent_ids.insert(agent.id.as_str())
        {
            return Err(format!("invalid agent catalog entry `{}`", agent.id));
        }
    }

    Ok(LoadedCatalog {
        root,
        manifest,
        agents: document.agents,
    })
}

fn use_chinese_catalog(locale: &str) -> bool {
    let normalized = locale.trim().to_ascii_lowercase();
    normalized == "zh" || normalized.starts_with("zh-")
}

fn localized_text<'a>(value: &'a LocalizedText, locale: &str) -> &'a str {
    if use_chinese_catalog(locale) {
        value.zh_cn.as_str()
    } else {
        value.en.as_str()
    }
}

fn build_catalog_view(
    catalog: &LoadedCatalog,
    locale: &str,
    enabled_ids: &[String],
) -> BuiltInAgentCatalogView {
    let enabled: HashSet<&str> = enabled_ids.iter().map(String::as_str).collect();
    let divisions = catalog
        .manifest
        .divisions
        .iter()
        .map(|division| BuiltInAgentDivisionView {
            id: division.id.clone(),
            order: division.order,
            icon: division.icon.clone(),
            color: division.color.clone(),
            label: localized_text(&division.label, locale).to_string(),
            count: division.count,
            enabled_count: catalog
                .agents
                .iter()
                .filter(|agent| {
                    agent.division_id == division.id && enabled.contains(agent.id.as_str())
                })
                .count(),
        })
        .collect();
    let agents = catalog
        .agents
        .iter()
        .map(|agent| BuiltInAgentView {
            id: agent.id.clone(),
            division_id: agent.division_id.clone(),
            name: localized_text(&agent.name, locale).to_string(),
            description: localized_text(&agent.description, locale).to_string(),
            icon: agent.emoji.clone(),
            enabled: enabled.contains(agent.id.as_str()),
        })
        .collect();

    BuiltInAgentCatalogView {
        provider: BuiltInAgentProviderView {
            id: catalog.manifest.provider_id.clone(),
            display_name: catalog.manifest.display_name.clone(),
            source_url: catalog.manifest.source_url.clone(),
            source_revision: catalog.manifest.source_revision.clone(),
            license: catalog.manifest.license.clone(),
        },
        divisions,
        agents,
    }
}

/// Read + hash-verify the agent's prompt body. Fails closed on unknown ids,
/// unreadable/empty prompts, and any drift from the hash pinned in
/// agents.json (a tampered or half-copied resource must never reach a prompt
/// injection).
fn resolve_prompt<'a>(
    catalog: &'a LoadedCatalog,
    agent_id: &str,
) -> Result<(&'a CatalogAgent, String), String> {
    validate_agent_id(agent_id)?;
    let agent = catalog
        .agents
        .iter()
        .find(|entry| entry.id == agent_id)
        .ok_or_else(|| format!("unknown built-in agent id `{}`", agent_id))?;
    let prompt_path = catalog.root.join(&agent.prompt_path);
    let prompt = fs::read_to_string(&prompt_path)
        .map_err(|error| format!("failed to read built-in agent prompt: {}", error))?;
    if prompt.trim().is_empty() {
        return Err(format!("built-in agent prompt `{}` is empty", agent_id));
    }
    let actual_hash = format!("{:x}", Sha256::digest(prompt.as_bytes()));
    if !actual_hash.eq_ignore_ascii_case(&agent.prompt_hash) {
        return Err(format!(
            "built-in agent prompt hash mismatch for `{}`",
            agent_id
        ));
    }
    Ok((agent, prompt))
}

/// Pure enable/disable flip on a normalized id list; the result stays
/// normalized. Unknown-format ids are dropped by the normalization.
fn apply_agent_enabled(ids: &[String], agent_id: &str, enabled: bool) -> Vec<String> {
    let mut next = normalized_enabled_builtin_agent_ids(ids);
    next.retain(|id| id != agent_id);
    if enabled {
        next.push(agent_id.to_string());
        next = normalized_enabled_builtin_agent_ids(&next);
    }
    next
}

/// Pure division-wide flip: enable adds every agent of the division, disable
/// removes exactly the division's ids and leaves the rest untouched.
fn apply_division_enabled(
    ids: &[String],
    division_agent_ids: &HashSet<&str>,
    enabled: bool,
) -> Vec<String> {
    let mut next = normalized_enabled_builtin_agent_ids(ids);
    next.retain(|id| !division_agent_ids.contains(id.as_str()));
    if enabled {
        next.extend(division_agent_ids.iter().map(|id| id.to_string()));
        next = normalized_enabled_builtin_agent_ids(&next);
    }
    next
}

/// Locked read→modify→persist of `enabled_builtin_agent_ids`, mirroring
/// `settings::consume_web_auth_key`. A committed-with-warning outcome (an
/// unrelated field was rejected) is logged, not surfaced: the toggle itself
/// is already on disk.
fn persist_enabled_ids(
    app: &tauri::AppHandle,
    mutate: impl FnOnce(&[String]) -> Vec<String>,
) -> Result<(), String> {
    let warning = {
        let _guard = crate::settings::settings_write_lock();
        let mut settings = crate::settings::read_settings()?;
        settings.enabled_builtin_agent_ids = mutate(&settings.enabled_builtin_agent_ids);
        crate::settings::persist_settings_committed(&mut settings)?
    };
    if let Some(warning) = warning {
        eprintln!("[agent-catalog] settings committed with warning: {warning}");
    }
    // Same announcement the settings command makes, plus every browser
    // attached over the bridge — the `#` picker everywhere re-reads.
    use crate::event_sink::Emit;
    if let Some(state) = app.try_state::<crate::AppState>() {
        state.emitters.emit_json("settings://changed", "null");
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn list_built_in_agents(
    locale: String,
    app: tauri::AppHandle,
) -> Result<BuiltInAgentCatalogView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let catalog = load_catalog(app_resource_dir(&app).as_deref())?;
        let settings = crate::settings::read_settings()?;
        let enabled = normalized_enabled_builtin_agent_ids(&settings.enabled_builtin_agent_ids);
        Ok(build_catalog_view(&catalog, &locale, &enabled))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn set_built_in_agent_enabled(
    agent_id: String,
    enabled: bool,
    app: tauri::AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let agent_id = agent_id.trim().to_string();
        let catalog = load_catalog(app_resource_dir(&app).as_deref())?;
        if !catalog.agents.iter().any(|agent| agent.id == agent_id) {
            return Err(format!("unknown built-in agent id `{}`", agent_id));
        }
        persist_enabled_ids(&app, |ids| apply_agent_enabled(ids, &agent_id, enabled))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn set_built_in_agent_division_enabled(
    division_id: String,
    enabled: bool,
    app: tauri::AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let division_id = division_id.trim().to_string();
        let catalog = load_catalog(app_resource_dir(&app).as_deref())?;
        if !catalog
            .manifest
            .divisions
            .iter()
            .any(|division| division.id == division_id)
        {
            return Err(format!("unknown built-in agent division `{}`", division_id));
        }
        let division_agent_ids: HashSet<&str> = catalog
            .agents
            .iter()
            .filter(|agent| agent.division_id == division_id)
            .map(|agent| agent.id.as_str())
            .collect();
        persist_enabled_ids(&app, |ids| {
            apply_division_enabled(ids, &division_agent_ids, enabled)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub(crate) async fn get_built_in_agent_prompt(
    agent_id: String,
    app: tauri::AppHandle,
) -> Result<BuiltInAgentPrompt, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let catalog = load_catalog(app_resource_dir(&app).as_deref())?;
        let (agent, prompt) = resolve_prompt(&catalog, agent_id.trim())?;
        Ok(BuiltInAgentPrompt {
            id: agent.id.clone(),
            prompt,
            prompt_hash: agent.prompt_hash.clone(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Send-time resolution for the composer `#` picker: only an *enabled*
/// built-in agent resolves, and name/icon follow the app's display language.
#[tauri::command]
pub(crate) async fn resolve_enabled_built_in_agent(
    agent_id: String,
    app: tauri::AppHandle,
) -> Result<ResolvedBuiltInAgent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let agent_id = agent_id.trim().to_string();
        let settings = crate::settings::read_settings()?;
        let enabled = normalized_enabled_builtin_agent_ids(&settings.enabled_builtin_agent_ids);
        if !enabled.iter().any(|id| id == &agent_id) {
            return Err(format!("built-in agent `{}` is disabled", agent_id));
        }
        let catalog = load_catalog(app_resource_dir(&app).as_deref())?;
        let (agent, prompt) = resolve_prompt(&catalog, &agent_id)?;
        Ok(ResolvedBuiltInAgent {
            id: agent.id.clone(),
            name: localized_text(&agent.name, &settings.language).to_string(),
            icon: agent.emoji.clone(),
            prompt,
            prompt_hash: agent.prompt_hash.clone(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    // HOME is process-global and paths::home_dir reads it under cfg(test);
    // serialize through the crate-wide lock shared with every such test.

    struct ScratchHome {
        dir: PathBuf,
        previous: Option<std::ffi::OsString>,
        _guard: parking_lot::MutexGuard<'static, ()>,
    }

    impl ScratchHome {
        fn new(name: &str) -> Self {
            let guard = crate::paths::HOME_ENV_LOCK.lock();
            let dir = std::env::temp_dir()
                .join(format!("ccgui-agent-catalog-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            let previous = std::env::var_os("HOME");
            std::env::set_var("HOME", &dir);
            Self {
                dir,
                previous,
                _guard: guard,
            }
        }
    }

    impl Drop for ScratchHome {
        fn drop(&mut self) {
            match &self.previous {
                Some(value) => std::env::set_var("HOME", value),
                None => std::env::remove_var("HOME"),
            }
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn prompt_fixture(prompt: &str, expected_hash: &str) -> (LoadedCatalog, PathBuf) {
        let bundled = load_catalog_from_root(default_catalog_root()).expect("catalog");
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "ccgui-agent-catalog-{}-{}",
            std::process::id(),
            suffix
        ));
        fs::create_dir_all(&root).expect("fixture dir");
        fs::write(root.join("prompt.md"), prompt).expect("fixture prompt");
        let mut agent = bundled.agents[0].clone();
        agent.prompt_path = "prompt.md".to_string();
        agent.prompt_hash = expected_hash.to_string();
        (
            LoadedCatalog {
                root: root.clone(),
                manifest: bundled.manifest,
                agents: vec![agent],
            },
            root,
        )
    }

    #[test]
    fn normalizes_enabled_ids_deterministically() {
        let ids = vec![
            " agency-agents:engineering/engineering-ai-engineer ".to_string(),
            "invalid".to_string(),
            "agency-agents:engineering/engineering-ai-engineer".to_string(),
            "agency-agents:design/design-ui-designer".to_string(),
        ];
        assert_eq!(
            normalized_enabled_builtin_agent_ids(&ids),
            vec![
                "agency-agents:design/design-ui-designer".to_string(),
                "agency-agents:engineering/engineering-ai-engineer".to_string(),
            ]
        );
    }

    #[test]
    fn bundled_catalog_loads_from_dev_root_with_expected_counts() {
        // Dev-mode resolution: no bundle resource dir, so the walk must land
        // on CARGO_MANIFEST_DIR/resources/agent-catalogs/agency-agents.
        let catalog = load_catalog(None).expect("catalog");
        assert_eq!(catalog.root, default_catalog_root());
        assert_eq!(catalog.manifest.divisions.len(), 17);
        assert_eq!(catalog.agents.len(), 248);
        assert!(catalog.agents.iter().all(|agent| {
            !agent.name.zh_cn.trim().is_empty() && !agent.description.zh_cn.trim().is_empty()
        }));
    }

    #[test]
    fn rejects_tampered_catalog_source_identity() {
        let bundled_root = default_catalog_root();
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "ccgui-agent-catalog-identity-{}-{}",
            std::process::id(),
            suffix
        ));
        fs::create_dir_all(&root).expect("fixture dir");
        let mut manifest: serde_json::Value =
            read_json(&bundled_root.join("manifest.json"), "fixture manifest").expect("manifest");
        manifest["sourceUrl"] = serde_json::Value::String("javascript:alert(1)".to_string());
        fs::write(
            root.join("manifest.json"),
            serde_json::to_vec(&manifest).expect("serialize manifest"),
        )
        .expect("write manifest");
        fs::copy(bundled_root.join("agents.json"), root.join("agents.json")).expect("copy agents");

        assert!(load_catalog_from_root(root.clone())
            .expect_err("tampered source identity must fail")
            .contains("identity"));
        fs::remove_dir_all(root).expect("remove identity fixture");
    }

    #[test]
    fn prompt_resolution_checks_hash() {
        // Every bundled prompt must match its pinned hash — a single drifted
        // file (e.g. CRLF checkout on Windows) breaks only that agent at
        // runtime, so sampling agents[0] is not enough.
        let catalog = load_catalog_from_root(default_catalog_root()).expect("catalog");
        for agent in &catalog.agents {
            let (resolved, prompt) = resolve_prompt(&catalog, &agent.id)
                .unwrap_or_else(|error| panic!("prompt `{}` must resolve: {error}", agent.id));
            assert!(!prompt.trim().is_empty());
            assert_eq!(resolved.prompt_hash.len(), 64);
        }
    }

    #[test]
    fn rejects_unsafe_ids_and_invalid_prompt_bodies() {
        assert!(validate_agent_id("agency-agents:../secret").is_err());
        assert!(validate_safe_relative_path("/absolute/prompt.md", "prompt").is_err());

        let (empty_catalog, empty_root) = prompt_fixture("", &format!("{:x}", Sha256::digest([])));
        let empty_id = empty_catalog.agents[0].id.clone();
        assert!(resolve_prompt(&empty_catalog, &empty_id)
            .expect_err("empty prompt must fail")
            .contains("empty"));
        fs::remove_dir_all(empty_root).expect("remove empty fixture");

        let (mismatch_catalog, mismatch_root) = prompt_fixture("prompt", &"0".repeat(64));
        let mismatch_id = mismatch_catalog.agents[0].id.clone();
        assert!(resolve_prompt(&mismatch_catalog, &mismatch_id)
            .expect_err("hash mismatch must fail")
            .contains("hash mismatch"));
        fs::remove_dir_all(mismatch_root).expect("remove mismatch fixture");
    }

    #[test]
    fn chinese_locale_resolves_for_both_chinese_variants() {
        let value = LocalizedText {
            en: "Engineering".to_string(),
            zh_cn: "工程研发".to_string(),
        };
        assert_eq!(localized_text(&value, "zh"), "工程研发");
        assert_eq!(localized_text(&value, "zh-CN"), "工程研发");
        assert_eq!(localized_text(&value, "zh-TW"), "工程研发");
        assert_eq!(localized_text(&value, "ja"), "Engineering");
        assert_eq!(localized_text(&value, "en"), "Engineering");
    }

    #[test]
    fn catalog_view_marks_enabled_and_counts_per_division() {
        let catalog = load_catalog_from_root(default_catalog_root()).expect("catalog");
        let agent = catalog.agents[0].clone();
        let enabled = vec![agent.id.clone()];
        let view = build_catalog_view(&catalog, "zh", &enabled);
        assert_eq!(view.provider.id, PROVIDER_ID);
        assert_eq!(view.provider.license, "MIT");
        assert_eq!(view.divisions.len(), 17);
        assert_eq!(view.agents.len(), 248);
        let enabled_view = view
            .agents
            .iter()
            .find(|a| a.id == agent.id)
            .expect("agent view");
        assert!(enabled_view.enabled);
        assert_eq!(enabled_view.name, agent.name.zh_cn);
        let division = view
            .divisions
            .iter()
            .find(|d| d.id == agent.division_id)
            .expect("division view");
        assert_eq!(division.enabled_count, 1);
        assert_eq!(
            division.label,
            catalog
                .manifest
                .divisions
                .iter()
                .find(|d| d.id == agent.division_id)
                .expect("division")
                .label
                .zh_cn
        );
    }

    #[test]
    fn apply_helpers_flip_agents_and_divisions() {
        let catalog = load_catalog_from_root(default_catalog_root()).expect("catalog");
        let division_id = catalog.agents[0].division_id.clone();
        let division_agent_ids: HashSet<&str> = catalog
            .agents
            .iter()
            .filter(|agent| agent.division_id == division_id)
            .map(|agent| agent.id.as_str())
            .collect();
        let division_size = division_agent_ids.len();
        assert!(
            division_size > 1,
            "fixture division should hold several agents"
        );

        // Enabling a division enables exactly its agents; disabling one agent
        // inside it leaves the rest; disabling the division clears them all
        // but preserves an unrelated id.
        let all = apply_division_enabled(&[], &division_agent_ids, true);
        assert_eq!(all.len(), division_size);
        let one_off = apply_agent_enabled(&all, &catalog.agents[0].id, false);
        assert_eq!(one_off.len(), division_size - 1);
        let other = "agency-agents:design/design-ui-designer".to_string();
        let with_other = apply_agent_enabled(&all, &other, true);
        let cleared = apply_division_enabled(&with_other, &division_agent_ids, false);
        assert_eq!(cleared, vec![other]);
    }

    #[test]
    fn enabled_ids_round_trip_through_settings_json() {
        let _home = ScratchHome::new("settings-round-trip");
        crate::paths::ensure_dirs().unwrap();

        // Default (missing key) reads back as an empty list.
        let settings = crate::settings::read_settings().expect("default settings");
        assert!(settings.enabled_builtin_agent_ids.is_empty());

        // Persist a toggled set through the same write path the commands use.
        let ids = apply_agent_enabled(
            &[],
            "agency-agents:engineering/engineering-ai-engineer",
            true,
        );
        let warning = {
            let _guard = crate::settings::settings_write_lock();
            let mut settings = crate::settings::read_settings().expect("settings");
            settings.enabled_builtin_agent_ids = ids.clone();
            crate::settings::persist_settings_committed(&mut settings).expect("persist")
        };
        assert!(warning.is_none());

        let reloaded = crate::settings::read_settings().expect("reloaded settings");
        assert_eq!(
            reloaded.enabled_builtin_agent_ids,
            vec!["agency-agents:engineering/engineering-ai-engineer".to_string()]
        );
        // The settings.json key stays camelCase like every other field.
        let raw = fs::read_to_string(crate::paths::settings_path()).expect("settings.json");
        assert!(raw.contains("\"enabledBuiltinAgentIds\""));

        // Disabling removes it again.
        let cleared = apply_agent_enabled(
            &reloaded.enabled_builtin_agent_ids,
            "agency-agents:engineering/engineering-ai-engineer",
            false,
        );
        assert!(cleared.is_empty());
    }
}
