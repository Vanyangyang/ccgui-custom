use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// User-defined agents (智能体): named role presets the composer `#` picker
/// attaches to an outgoing prompt (ported from desktop-cc-gui's agents.rs,
/// trimmed to the CRUD surface — selection state now lives frontend-side in
/// localStorage, and import/export was dropped). The whole catalog is one
/// JSON file at `~/.ccgui-next/agents.json`; a missing or corrupt file reads
/// as an empty list so the picker degrades instead of erroring.

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    /// Creation time, unix milliseconds; assigned by agent_add.
    #[serde(default)]
    pub created_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AgentStore {
    #[serde(default)]
    agents: Vec<AgentConfig>,
}

const MAX_NAME_CHARS: usize = 64;
const MAX_PROMPT_CHARS: usize = 100_000;

fn agents_file() -> PathBuf {
    crate::paths::app_home().join("agents.json")
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn read_store() -> Result<AgentStore, String> {
    read_store_from(&agents_file())
}

fn read_store_from(path: &Path) -> Result<AgentStore, String> {
    if !path.exists() {
        return Ok(AgentStore::default());
    }
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    if content.trim().is_empty() {
        return Ok(AgentStore::default());
    }
    match serde_json::from_str(&content) {
        Ok(store) => Ok(store),
        Err(e) => {
            eprintln!(
                "[agents] corrupt {}, resetting to empty: {e}",
                path.display()
            );
            Ok(AgentStore::default())
        }
    }
}

fn write_store(store: &AgentStore) -> Result<(), String> {
    write_store_to(&agents_file(), store)
}

fn write_store_to(path: &Path, store: &AgentStore) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    let content = serde_json::to_string_pretty(store)
        .map_err(|e| format!("Failed to serialize agents: {e}"))?;
    std::fs::write(path, content).map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

/// Trimmed name, or a validation error: required, 1–64 chars.
fn validate_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    let len = trimmed.chars().count();
    if len == 0 {
        return Err("Agent name is required".to_string());
    }
    if len > MAX_NAME_CHARS {
        return Err("Agent name must be 1-64 characters".to_string());
    }
    Ok(trimmed.to_string())
}

/// Empty prompts normalize to None; over-limit prompts are rejected.
fn validate_prompt(prompt: Option<String>) -> Result<Option<String>, String> {
    let Some(prompt) = prompt else {
        return Ok(None);
    };
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return Err("Agent prompt must be less than 100,000 characters".to_string());
    }
    let trimmed = prompt.trim().to_string();
    if trimmed.is_empty() {
        Ok(None)
    } else {
        Ok(Some(trimmed))
    }
}

/// Empty icons normalize to None.
fn sanitize_icon(icon: Option<String>) -> Option<String> {
    icon.map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn sorted_agents(store: &AgentStore) -> Vec<AgentConfig> {
    let mut agents = store.agents.clone();
    // Newest first, matching the legacy app's ordering.
    agents.sort_by(|a, b| b.created_at.unwrap_or(0).cmp(&a.created_at.unwrap_or(0)));
    agents
}

fn agent_list_blocking() -> Result<Vec<AgentConfig>, String> {
    let store = read_store()?;
    Ok(sorted_agents(&store))
}

fn agent_add_blocking(
    name: String,
    prompt: Option<String>,
    icon: Option<String>,
) -> Result<AgentConfig, String> {
    let mut store = read_store()?;
    let agent = AgentConfig {
        id: uuid::Uuid::new_v4().to_string(),
        name: validate_name(&name)?,
        prompt: validate_prompt(prompt)?,
        icon: sanitize_icon(icon),
        created_at: Some(now_millis()),
    };
    store.agents.push(agent.clone());
    write_store(&store)?;
    Ok(agent)
}

fn agent_update_blocking(
    id: String,
    name: Option<String>,
    prompt: Option<String>,
    icon: Option<String>,
) -> Result<bool, String> {
    let mut store = read_store()?;
    let Some(agent) = store.agents.iter_mut().find(|agent| agent.id == id) else {
        return Ok(false);
    };
    if let Some(name) = name {
        agent.name = validate_name(&name)?;
    }
    if let Some(prompt) = prompt {
        // Some("") clears the prompt via the empty→None normalization.
        agent.prompt = validate_prompt(Some(prompt))?;
    }
    if let Some(icon) = icon {
        agent.icon = sanitize_icon(Some(icon));
    }
    write_store(&store)?;
    Ok(true)
}

fn agent_delete_blocking(id: String) -> Result<bool, String> {
    let mut store = read_store()?;
    let before = store.agents.len();
    store.agents.retain(|agent| agent.id != id);
    if store.agents.len() == before {
        return Ok(false);
    }
    write_store(&store)?;
    Ok(true)
}

#[tauri::command]
pub async fn agent_list() -> Result<Vec<AgentConfig>, String> {
    tauri::async_runtime::spawn_blocking(agent_list_blocking)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn agent_add(
    name: String,
    prompt: Option<String>,
    icon: Option<String>,
) -> Result<AgentConfig, String> {
    tauri::async_runtime::spawn_blocking(move || agent_add_blocking(name, prompt, icon))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn agent_update(
    id: String,
    name: Option<String>,
    prompt: Option<String>,
    icon: Option<String>,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || agent_update_blocking(id, name, prompt, icon))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn agent_delete(id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || agent_delete_blocking(id))
        .await
        .map_err(|e| e.to_string())?
}

// ---- Legacy import -------------------------------------------------------

/// Legacy desktop-cc-gui agent (`~/.ccgui/agent.json`): same fields modulo
/// the store shape — the legacy file is a HashMap keyed by id (plus a
/// `selectedAgentId` the new app keeps frontend-side in localStorage, so it
/// is dropped here), and `createdAt` is a signed timestamp.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyAgent {
    #[serde(default)]
    id: String,
    name: String,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    created_at: Option<i64>,
}

#[derive(Deserialize)]
struct LegacyAgentFile {
    #[serde(default)]
    agents: std::collections::HashMap<String, LegacyAgent>,
}

/// Legacy icons came from a preset SVG set (`agent-robot-06`, …) that does
/// not exist here — the new icon is free text inlined into the outgoing
/// agent block, so an ASCII preset id would leak into prompts. Only
/// emoji-style (non-ASCII) icons survive the move.
fn migrate_icon(icon: Option<String>) -> Option<String> {
    sanitize_icon(icon).filter(|value| !value.is_ascii())
}

/// One-time import of the legacy agent catalog (`~/.ccgui/agent.json`): old
/// users open the upgrade and find their agents intact. Merge semantics — an
/// id already present in the new store is never overwritten — guarded by a
/// meta flag so an agent deleted in the new app is not resurrected on the
/// next launch. Invalid entries are skipped, not fatal.
pub fn import_legacy_agents_once(db: &crate::db::Db) -> Result<(), String> {
    import_legacy_agents_from(db, &crate::paths::legacy_agents_path(), &agents_file())
}

fn import_legacy_agents_from(
    db: &crate::db::Db,
    legacy_path: &Path,
    dest_path: &Path,
) -> Result<(), String> {
    const FLAG: &str = "legacy_agents_import_v1";
    {
        let conn = db.0.lock();
        let done = conn
            .query_row("SELECT value FROM meta WHERE key=?1", [FLAG], |r| {
                r.get::<_, String>(0)
            })
            .ok();
        if done.is_some() {
            return Ok(());
        }
    }

    if legacy_path.is_file() {
        let content = std::fs::read_to_string(legacy_path)
            .map_err(|e| format!("read {}: {e}", legacy_path.display()))?;
        let legacy: LegacyAgentFile = serde_json::from_str(&content)
            .map_err(|e| format!("parse {}: {e}", legacy_path.display()))?;
        let mut imported: Vec<AgentConfig> = Vec::new();
        for (key, agent) in legacy.agents {
            // The map key is the authoritative id in the legacy app; fall
            // back to it when the entry's own id is blank.
            let id = if agent.id.trim().is_empty() {
                key
            } else {
                agent.id
            };
            let (Ok(name), Ok(prompt)) =
                (validate_name(&agent.name), validate_prompt(agent.prompt))
            else {
                eprintln!("[agents] skipping invalid legacy agent {id}");
                continue;
            };
            imported.push(AgentConfig {
                id,
                name,
                prompt,
                icon: migrate_icon(agent.icon),
                created_at: agent.created_at.and_then(|v| u64::try_from(v).ok()),
            });
        }
        if !imported.is_empty() {
            let mut store = read_store_from(dest_path)?;
            let existing: std::collections::HashSet<String> =
                store.agents.iter().map(|a| a.id.clone()).collect();
            let before = store.agents.len();
            store
                .agents
                .extend(imported.into_iter().filter(|a| !existing.contains(&a.id)));
            if store.agents.len() != before {
                write_store_to(dest_path, &store)?;
            }
        }
    }

    // Flag set even without a legacy file (fresh machine): never re-probe.
    let conn = db.0.lock();
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES(?1, '1')",
        [FLAG],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // Tests steer paths::home_dir through HOME (its cfg(test) branch), which
    // is process-global — every HOME-mutating test shares the crate-wide lock.

    struct ScratchHome {
        dir: PathBuf,
        previous: Option<std::ffi::OsString>,
        _guard: parking_lot::MutexGuard<'static, ()>,
    }

    impl ScratchHome {
        fn new(name: &str) -> Self {
            let guard = crate::paths::HOME_ENV_LOCK.lock();
            let dir =
                std::env::temp_dir().join(format!("ccgui-agents-{name}-{}", std::process::id()));
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

    #[test]
    fn empty_store_reads_as_empty_list() {
        let _home = ScratchHome::new("empty");
        assert!(agent_list_blocking().unwrap().is_empty());
        // A corrupt file also degrades to empty instead of erroring.
        crate::paths::ensure_dirs().unwrap();
        fs::write(crate::paths::app_home().join("agents.json"), "{not json").unwrap();
        assert!(agent_list_blocking().unwrap().is_empty());
    }

    #[test]
    fn add_list_update_delete_round_trip() {
        let _home = ScratchHome::new("roundtrip");
        let agent = agent_add_blocking(
            "  代码审查  ".to_string(),
            Some("审查 diff".to_string()),
            Some("bot".to_string()),
        )
        .unwrap();
        assert!(!agent.id.is_empty());
        assert_eq!(agent.name, "代码审查");
        assert!(agent.created_at.is_some());

        let list = agent_list_blocking().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, agent.id);
        assert_eq!(list[0].prompt.as_deref(), Some("审查 diff"));

        // Partial update: name only, prompt/icon untouched.
        assert!(
            agent_update_blocking(agent.id.clone(), Some("评审".to_string()), None, None).unwrap()
        );
        let list = agent_list_blocking().unwrap();
        assert_eq!(list[0].name, "评审");
        assert_eq!(list[0].prompt.as_deref(), Some("审查 diff"));
        assert_eq!(list[0].icon.as_deref(), Some("bot"));

        // Some("") clears optional fields.
        assert!(agent_update_blocking(
            agent.id.clone(),
            None,
            Some("".to_string()),
            Some("".to_string())
        )
        .unwrap());
        let list = agent_list_blocking().unwrap();
        assert_eq!(list[0].prompt, None);
        assert_eq!(list[0].icon, None);

        // Unknown ids are a false, not an error.
        assert!(
            !agent_update_blocking("missing".to_string(), Some("x".to_string()), None, None)
                .unwrap()
        );
        assert!(!agent_delete_blocking("missing".to_string()).unwrap());

        assert!(agent_delete_blocking(agent.id.clone()).unwrap());
        assert!(agent_list_blocking().unwrap().is_empty());
    }

    #[test]
    fn name_validation() {
        let _home = ScratchHome::new("validate");
        assert!(agent_add_blocking("   ".to_string(), None, None).is_err());
        let long = "a".repeat(MAX_NAME_CHARS + 1);
        assert!(agent_add_blocking(long, None, None).is_err());
        let prompt = "p".repeat(MAX_PROMPT_CHARS + 1);
        assert!(agent_add_blocking("ok".to_string(), Some(prompt), None).is_err());
        // Blank prompt is not an error — it normalizes to None.
        let agent = agent_add_blocking("ok".to_string(), Some("   ".to_string()), None).unwrap();
        assert_eq!(agent.prompt, None);
    }

    // Migration tests take explicit legacy/dest paths, so no HOME steering —
    // just a scratch dir for the db and files.
    struct ScratchDir(PathBuf);
    impl ScratchDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "ccgui-agents-migrate-{name}-{}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }
    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn legacy_import_converts_shape_and_merges() {
        let scratch = ScratchDir::new("merge");
        let db = crate::db::Db::open_at(&scratch.path("app.db")).unwrap();
        let legacy = scratch.path("agent.json");
        fs::write(
            &legacy,
            r#"{
                "selectedAgentId": "a1",
                "agents": {
                    "a0": {"id": "a0", "name": "旧名字"},
                    "a1": {"id": "a1", "name": "审查", "prompt": "看 diff", "createdAt": 1789652018569, "icon": "agent-robot-06"},
                    "a2": {"id": "", "name": "emoji", "icon": "🤖", "createdAt": 2},
                    "a3": {"id": "a3", "name": "   "}
                }
            }"#,
        )
        .unwrap();
        // An agent already created in the new app keeps its own data.
        let dest = scratch.path("agents.json");
        fs::write(
            &dest,
            r#"{"agents": [{"id": "a0", "name": "已有", "prompt": null, "icon": null, "createdAt": 9}]}"#,
        )
        .unwrap();

        import_legacy_agents_from(&db, &legacy, &dest).unwrap();
        let store = read_store_from(&dest).unwrap();
        assert_eq!(
            store.agents.len(),
            3,
            "a0 kept, a1/a2 imported, blank-name a3 skipped"
        );

        let a0 = store.agents.iter().find(|a| a.id == "a0").unwrap();
        assert_eq!(a0.name, "已有", "an existing id is never overwritten");

        let a1 = store.agents.iter().find(|a| a.id == "a1").unwrap();
        assert_eq!(a1.prompt.as_deref(), Some("看 diff"));
        assert_eq!(a1.created_at, Some(1789652018569));
        assert_eq!(a1.icon, None, "legacy preset icon ids are dropped");

        let a2 = store.agents.iter().find(|a| a.id == "a2").unwrap();
        assert_eq!(a2.id, "a2", "a blank entry id falls back to the map key");
        assert_eq!(a2.icon.as_deref(), Some("🤖"), "emoji icons survive");
        assert_eq!(a2.created_at, Some(2));
    }

    #[test]
    fn legacy_import_runs_once() {
        let scratch = ScratchDir::new("once");
        let db = crate::db::Db::open_at(&scratch.path("app.db")).unwrap();
        let legacy = scratch.path("agent.json");
        fs::write(&legacy, r#"{"agents": {"a1": {"id": "a1", "name": "一"}}}"#).unwrap();
        let dest = scratch.path("agents.json");
        import_legacy_agents_from(&db, &legacy, &dest).unwrap();
        assert_eq!(read_store_from(&dest).unwrap().agents.len(), 1);

        // A deletion in the new app is not resurrected, and legacy entries
        // appearing later are ignored.
        let mut store = read_store_from(&dest).unwrap();
        store.agents.clear();
        write_store_to(&dest, &store).unwrap();
        fs::write(&legacy, r#"{"agents": {"a9": {"id": "a9", "name": "九"}}}"#).unwrap();
        import_legacy_agents_from(&db, &legacy, &dest).unwrap();
        assert!(read_store_from(&dest).unwrap().agents.is_empty());
    }

    #[test]
    fn legacy_import_without_file_only_sets_flag() {
        let scratch = ScratchDir::new("missing");
        let db = crate::db::Db::open_at(&scratch.path("app.db")).unwrap();
        import_legacy_agents_from(
            &db,
            &scratch.path("nope.json"),
            &scratch.path("agents.json"),
        )
        .unwrap();
        assert!(!scratch.path("agents.json").exists());
        let conn = db.0.lock();
        let flag: String = conn
            .query_row(
                "SELECT value FROM meta WHERE key='legacy_agents_import_v1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(flag, "1");
    }
}
