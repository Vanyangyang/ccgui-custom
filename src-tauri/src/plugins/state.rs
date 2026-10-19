//! plugins.json: the state file, its lock, and the record helpers.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use parking_lot::Mutex;

/// Uninstalled-plugin KV retention window (plan §9.1: 保留 30 天).
pub const KV_TOMBSTONE_TTL_SECS: i64 = 30 * 24 * 3600;

/// Serializes every plugins.json read→mutate→write critical section so
/// concurrent commands (install/uninstall/enable/quarantine/list) can't
/// interleave into a lost update. Take it once per public operation, around
/// the state mutation only — never across install_from's file-copy phase.
/// Pure reads (plugin_enabled_permissions) stay lock-free: they re-read the
/// file fresh on every call, and a read racing a write simply resolves as
/// the pre- or post-write value.
pub(crate) static STATE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// Installed plugin as the frontend sees it. Manifest-derived fields fall
/// back to the state record (or empty) when the plugin directory is gone —
/// builtin entries registered via plugin_set_enabled have no directory.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub tier: String,
    pub source: String,
    pub enabled: bool,
    pub quarantined: bool,
    pub last_error: Option<String>,
    pub permissions: Vec<String>,
    /// Unix seconds, matching kvTombstones in the same state file.
    pub installed_at: i64,
    pub min_app_version: Option<String>,
    /// Market artwork declared by the installed manifest: a square icon and
    /// the detail gallery, as repo-relative paths or absolute https URLs.
    /// Empty when the manifest carries none or the paths were unusable —
    /// the UI then keeps its deterministic letter tile / no gallery.
    pub icon: Option<String>,
    pub screenshots: Vec<String>,
}

/// plugins.json — tolerant reads: a missing/empty file means "no plugins".
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PluginsState {
    pub plugins: HashMap<String, PluginRecord>,
    pub kv_tombstones: HashMap<String, i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRecord {
    pub version: String,
    pub enabled: bool,
    pub source: String,
    pub permissions: Vec<String>,
    pub quarantined: bool,
    pub last_error: Option<String>,
    pub installed_at: i64,
}

impl PluginRecord {
    /// Default record for a freshly-seen plugin id: enabled, clean slate,
    /// stamped with the current time.
    pub(crate) fn fresh(source: &str, now: i64) -> Self {
        Self {
            version: String::new(),
            enabled: true,
            source: source.to_string(),
            permissions: Vec::new(),
            quarantined: false,
            last_error: None,
            installed_at: now,
        }
    }
}

pub(crate) fn state_path() -> PathBuf {
    crate::paths::app_home().join("plugins.json")
}

pub(crate) fn plugins_dir() -> PathBuf {
    crate::paths::app_home().join("plugins")
}

pub(crate) fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Same tolerance as settings::read_settings: missing/empty → default.
pub(crate) fn read_state(path: &Path) -> Result<PluginsState, String> {
    if !path.exists() {
        return Ok(PluginsState::default());
    }
    let content =
        std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if content.trim().is_empty() {
        return Ok(PluginsState::default());
    }
    serde_json::from_str(&content).map_err(|e| format!("parse {}: {e}", path.display()))
}

pub(crate) fn write_state(path: &Path, state: &PluginsState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let content = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    crate::settings::atomic_write(path, &content)
}

/// Mutate (or create) a record in an already-loaded state; the caller holds
/// STATE_LOCK and writes the state back. Returns the updated record clone.
pub(crate) fn mutate_record(
    state: &mut PluginsState,
    id: &str,
    fresh_source: &str,
    mutate: impl FnOnce(&mut PluginRecord),
) -> PluginRecord {
    let record = state
        .plugins
        .entry(id.to_string())
        .or_insert_with(|| PluginRecord::fresh(fresh_source, now_secs()));
    mutate(record);
    if id == super::RETIRED_SPELLCAST_BRIDGE {
        record.enabled = false;
    }
    record.clone()
}

/// Upsert helper shared by enable/quarantine: one locked
/// read→mutate→write, returning the updated record so callers don't re-read
/// the state file.
pub(crate) fn update_record(
    state_path: &Path,
    id: &str,
    mutate: impl FnOnce(&mut PluginRecord),
) -> Result<PluginRecord, String> {
    let _guard = STATE_LOCK.lock();
    let mut state = read_state(state_path)?;
    let record = mutate_record(&mut state, id, "builtin", mutate);
    write_state(state_path, &state)?;
    Ok(record)
}

/// (enabled, permissions) lookup for the plugin_caps capability commands.
/// Server-side enforcement reads the state file fresh on every call, so a
/// disable/uninstall takes effect immediately.
pub(crate) fn plugin_enabled_permissions(id: &str) -> Result<(bool, Vec<String>), String> {
    record_enabled_permissions(&state_path(), id)
}

pub(crate) fn record_enabled_permissions(
    path: &Path,
    id: &str,
) -> Result<(bool, Vec<String>), String> {
    super::require_supported_plugin(id)?;
    let state = read_state(path)?;
    let record = state
        .plugins
        .get(id)
        .ok_or_else(|| format!("{id}: plugin is not installed"))?;
    Ok((record.enabled, record.permissions.clone()))
}

pub(crate) fn list_plugins(
    db: &crate::db::Db,
    plugins_dir: &Path,
    state_path: &Path,
) -> Result<Vec<PluginInfo>, String> {
    // The tombstone purge is a read→mutate→write section: hold STATE_LOCK so
    // a concurrent install/enable/uninstall can't lose it (or be lost to it).
    let state = {
        let _guard = STATE_LOCK.lock();
        let mut state = read_state(state_path)?;

        // Retire the external bridge without uninstalling its files or data.
        let mut changed = false;
        if let Some(record) = state.plugins.get_mut(super::RETIRED_SPELLCAST_BRIDGE) {
            changed = record.enabled;
            record.enabled = false;
        }

        // Retention sweep: tombstoned KV older than the window is gone for good.
        let now = now_secs();
        let expired: Vec<String> = state
            .kv_tombstones
            .iter()
            .filter(|(id, ts)| {
                id.as_str() != super::RETIRED_SPELLCAST_BRIDGE
                    && now.saturating_sub(**ts) > KV_TOMBSTONE_TTL_SECS
            })
            .map(|(id, _)| id.clone())
            .collect();
        if !expired.is_empty() {
            for id in &expired {
                db.plugin_kv_delete_all(id)?;
                state.kv_tombstones.remove(id);
            }
            changed = true;
        }
        if changed {
            write_state(state_path, &state)?;
        }
        state
    };

    // The manifest merge is pure reads of the plugin directories: off-lock.
    let mut infos: Vec<PluginInfo> = state
        .plugins
        .iter()
        .map(|(id, record)| super::fs::info_for(plugins_dir, id, record))
        .collect();
    infos.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(infos)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::test_support::Scratch;

    #[test]
    fn state_read_tolerates_missing_and_empty_files() {
        let scratch = Scratch::new();
        let path = scratch.path("plugins.json");
        assert!(read_state(&path).unwrap().plugins.is_empty());
        std::fs::write(&path, "  \n").unwrap();
        assert!(read_state(&path).unwrap().plugins.is_empty());
    }

    #[test]
    fn quarantine_then_enable_clears_error() {
        let scratch = Scratch::new();
        let state_path = scratch.path("plugins.json");

        // Builtin plugin: no directory on disk, set_enabled still upserts.
        update_record(&state_path, "builtin-thing", |r| {
            r.quarantined = true;
            r.last_error = Some("boom".to_string());
        })
        .unwrap();
        update_record(&state_path, "builtin-thing", |r| {
            r.enabled = true;
            r.quarantined = false;
            r.last_error = None;
        })
        .unwrap();
        let state = read_state(&state_path).unwrap();
        let record = &state.plugins["builtin-thing"];
        assert_eq!(record.source, "builtin");
        assert!(!record.quarantined);
        assert_eq!(record.last_error, None);
    }

    #[test]
    fn record_enabled_permissions_reports_missing_and_disabled() {
        let scratch = Scratch::new();
        let state_path = scratch.path("plugins.json");

        // Missing record → error naming the plugin.
        let error = record_enabled_permissions(&state_path, "ghost-plugin").unwrap_err();
        assert!(error.contains("ghost-plugin"), "{error}");

        // Disabled record → enabled=false, permissions intact.
        update_record(&state_path, "usage-stats", |r| {
            r.enabled = false;
            r.permissions = vec!["network:127.0.0.1:7680-7690".to_string()];
        })
        .unwrap();
        let (enabled, permissions) =
            record_enabled_permissions(&state_path, "usage-stats").unwrap();
        assert!(!enabled);
        assert_eq!(permissions, vec!["network:127.0.0.1:7680-7690"]);
    }
}
