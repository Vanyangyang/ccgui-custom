//! Phase-1 plugin host: local-path install/uninstall/enable/disable, plugin
//! file reads confined to the plugin directory, and per-plugin KV storage
//! (db.rs `plugin_kv`). State lives in `~/.ccgui-next/plugins.json`; the
//! plugins themselves in `~/.ccgui-next/plugins/<id>/`.
//!
//! Uninstall data policy (plan §9.1): `delete_data=false` keeps the KV rows
//! and records a tombstone; `plugin_list` purges rows whose tombstone is
//! older than KV_TOMBSTONE_TTL_SECS.
//!
//! Installs serialize staging/backup swaps and roll back on state-write errors.
//! Bundle and state writes are separate filesystem operations, not a crash-atomic
//! transaction; a stranded backup is recovered on the next same-id install.
//!
//! Layout: manifest.rs = manifest parse + permission whitelist; state.rs =
//! plugins.json records + STATE_LOCK; fs.rs = source-tree walk, the install
//! transaction, and the manifest/record merge.

mod fs;
mod manifest;
pub mod market;
mod state;

pub(crate) use state::plugin_enabled_permissions;
pub use state::{PluginInfo, PluginRecord, PluginsState, KV_TOMBSTONE_TTL_SECS};

use std::path::Path;
use std::sync::Arc;

pub(crate) const RETIRED_SPELLCAST_BRIDGE: &str = "spellcast-canvas-bridge";

pub(crate) fn require_supported_plugin(id: &str) -> Result<(), String> {
    if id == RETIRED_SPELLCAST_BRIDGE {
        Err(format!(
            "{id}: retired; replaced by built-in assistant notices and interactive answers"
        ))
    } else {
        Ok(())
    }
}

/// Invalidation only: frontends read the committed host snapshot. `reload`
/// additionally replaces an active bundle after install or an explicit retry.
pub(crate) fn emit_changed(emitter: &dyn crate::event_sink::Emit, id: Option<&str>, reload: bool) {
    emit_changed_for_request(emitter, id, reload, None);
}

fn emit_changed_for_request(emitter: &dyn crate::event_sink::Emit, id: Option<&str>, reload: bool, request_id: Option<&str>) {
    let mut payload = serde_json::json!({ "id": id, "reload": reload });
    if let Some(request_id) = request_id { payload["requestId"] = request_id.into(); }
    emitter.emit_json(
        "plugins://changed",
        &payload.to_string(),
    );
}

/// An install owns its progress stream even when two devices install at once.
/// Keep the legacy payload when no request id was supplied by an older client.
pub(crate) fn install_sink(
    emitter: Arc<dyn crate::event_sink::Emit>,
    request_id: Option<String>,
) -> Result<Arc<crate::event_sink::EventSink>, String> {
    if let Some(id) = &request_id {
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err("invalid plugin install requestId".into());
        }
    }
    struct InstallEmitter {
        emitter: Arc<dyn crate::event_sink::Emit>,
        request_id: Option<String>,
    }
    impl crate::event_sink::Emit for InstallEmitter {
        fn emit_json(&self, name: &str, raw_json: &str) {
            if name == crate::event_sink::INSTALL_PROGRESS_EVENT {
                if let Some(id) = &self.request_id {
                    if let Ok(mut payload) = serde_json::from_str::<serde_json::Value>(raw_json) {
                        payload["requestId"] = serde_json::Value::String(id.clone());
                        self.emitter.emit_json(name, &payload.to_string());
                        return;
                    }
                }
            }
            self.emitter.emit_json(name, raw_json);
        }
    }
    Ok(crate::event_sink::EventSink::new(Arc::new(
        InstallEmitter {
            emitter,
            request_id,
        },
    )))
}

/// Files a plugin may ask the host to read (plugin_read_file whitelist).
const READABLE_FILES: &[&str] = &["main.js", "styles.css", "manifest.json"];

#[tauri::command]
pub fn plugin_list(db: tauri::State<'_, Arc<crate::db::Db>>) -> Result<Vec<PluginInfo>, String> {
    state::list_plugins(&db, &state::plugins_dir(), &state::state_path())
}

/// Inspect the same validated local bundle used by the installer, without copying
/// files, changing grants or activating code.
#[tauri::command]
pub async fn plugin_inspect_path(path: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = Path::new(&path);
        if !source.is_absolute() || !source.is_dir() {
            return Err("Plugin source must be an absolute local directory".into());
        }
        let files = fs::collect_files(source)?;
        let candidate = manifest::validate_manifest(source, &files)?;
        Ok(serde_json::json!({
            "id": candidate.id, "name": candidate.name, "version": candidate.version,
            "tier": candidate.tier, "permissions": candidate.permissions,
            "sdkVersion": candidate.sdk_version, "minAppVersion": candidate.min_app_version,
        }))
    }).await.map_err(|error| error.to_string())?
}

fn expected_package<'a>(id: &'a Option<String>, version: &'a Option<String>) -> Result<Option<(&'a str, &'a str)>, String> {
    match (id.as_deref(), version.as_deref()) {
        (None, None) => Ok(None),
        (Some(id), Some(version)) => {
            manifest::require_valid_id(id)?;
            if manifest::semver_triple(version).is_none() { return Err("Invalid expected plugin version".into()); }
            Ok(Some((id, version)))
        }
        _ => Err("expectedId and expectedVersion must be supplied together".into()),
    }
}

#[tauri::command]
pub async fn plugin_install_from_path(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    path: String,
    request_id: Option<String>,
    expected_id: Option<String>,
    expected_version: Option<String>,
    host_request_id: Option<String>,
) -> Result<PluginInfo, String> {
    // spawn_blocking: sync commands execute on Tauri's main thread (see
    // cc_switch.rs), and the recursive copy below must not stall IPC there.
    expected_package(&expected_id, &expected_version)?;
    crate::host_chat::require_live_plugin_request(host_request_id.as_deref())?;
    let sink = install_sink(state.emitters.clone(), request_id.clone())?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::host_chat::require_live_plugin_request(host_request_id.as_deref())?;
        fs::install_from_checked(
            &state::plugins_dir(),
            &state::state_path(),
            Path::new(path.trim()),
            "local",
            expected_package(&expected_id, &expected_version)?,
            |p| sink.emit_install_progress(p),
        )
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|result| result);
    if let Ok(info) = &result {
        crate::plugin_caps::kill_tracked_children(&info.id);
        crate::plugin_windows::dispose_plugin(&app, &info.id);
    }
    // Copy/rename/state writes can fail after changing part of the host state.
    emit_changed_for_request(
        state.emitters.as_ref(),
        result.as_ref().ok().map(|info| info.id.as_str()),
        true,
        request_id.as_deref(),
    );
    result
}

fn uninstall_at(
    db: &crate::db::Db,
    plugins_dir: &Path,
    state_path: &Path,
    id: &str,
    delete_data: bool,
) -> Result<(), String> {
    manifest::require_valid_id(id)?;
    let _lifecycle_guard = fs::LIFECYCLE_LOCK.lock();
    let dir = plugins_dir.join(id);
    {
        // One locked read→mutate→write: the not-installed check, the record
        // removal, and the tombstone write-back must not interleave with a
        // concurrent install/enable of the same id.
        let _guard = state::STATE_LOCK.lock();
        let mut state = state::read_state(state_path)?;
        if !dir.exists() && !state.plugins.contains_key(id) {
            return Err(format!("{id}: plugin not installed"));
        }
        fs::remove_dir_if_exists(&dir)?;
        state.plugins.remove(id);
        if delete_data {
            db.plugin_kv_delete_all(id)?;
            state.kv_tombstones.remove(id);
        } else {
            state
                .kv_tombstones
                .insert(id.to_string(), state::now_secs());
        }
        state::write_state(state_path, &state)?;
    }
    // Services this plugin spawned with lifecycle="plugin" must not outlive
    // the plugin itself.
    crate::plugin_caps::kill_tracked_children(id);
    Ok(())
}

#[tauri::command]
pub fn plugin_uninstall(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    db: tauri::State<'_, Arc<crate::db::Db>>,
    id: String,
    delete_data: bool,
) -> Result<(), String> {
    let result = uninstall_at(
        &db,
        &state::plugins_dir(),
        &state::state_path(),
        &id,
        delete_data,
    );
    crate::plugin_windows::dispose_plugin(&app, &id);
    emit_changed(state.emitters.as_ref(), Some(&id), false);
    result
}

fn set_enabled_at(
    plugins_dir: &Path,
    state_path: &Path,
    id: &str,
    enabled: bool,
) -> Result<PluginInfo, String> {
    let _lifecycle_guard = fs::LIFECYCLE_LOCK.lock();
    set_enabled_locked(plugins_dir, state_path, id, enabled)
}

fn set_enabled_locked(plugins_dir: &Path, state_path: &Path, id: &str, enabled: bool) -> Result<PluginInfo, String> {
    manifest::require_valid_id(id)?;
    if enabled {
        require_supported_plugin(id)?;
    }
    let record = state::update_record(state_path, id, |record| {
        record.enabled = enabled;
        if enabled {
            // Re-enabling is the user's explicit "trust it again": clear the
            // quarantine and the error that caused it.
            record.quarantined = false;
            record.last_error = None;
        }
    })?;
    if !enabled {
        // Disabling takes effect immediately for lifecycle="plugin"
        // children too — they belong to the enabled plugin's runtime.
        crate::plugin_caps::kill_tracked_children(id);
    }
    Ok(fs::info_for(plugins_dir, id, &record))
}

#[tauri::command]
pub fn plugin_set_enabled(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    id: String,
    enabled: bool,
) -> Result<PluginInfo, String> {
    let result = set_enabled_at(&state::plugins_dir(), &state::state_path(), &id, enabled);
    if !enabled && result.is_ok() { crate::plugin_windows::dispose_plugin(&app, &id); }
    emit_changed(state.emitters.as_ref(), Some(&id), enabled);
    result
}

#[tauri::command]
pub fn plugin_reload(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    id: String,
    expected_version: Option<String>,
    preserve_enabled: Option<bool>,
    request_id: Option<String>,
    host_request_id: Option<String>,
) -> Result<PluginInfo, String> {
    crate::host_chat::require_live_plugin_request(host_request_id.as_deref())?;
    let result = reload_checked_at(&state::plugins_dir(), &state::state_path(), &id, expected_version.as_deref(), preserve_enabled.unwrap_or(false));
    if result.is_ok() { crate::plugin_windows::dispose_plugin(&app, &id); }
    emit_changed_for_request(state.emitters.as_ref(), Some(&id), true, request_id.as_deref());
    result
}

#[cfg(test)]
fn reload_at(plugins_dir: &Path, state_path: &Path, id: &str) -> Result<PluginInfo, String> {
    reload_checked_at(plugins_dir, state_path, id, None, false)
}

fn reload_checked_at(plugins_dir: &Path, state_path: &Path, id: &str, expected_version: Option<&str>, preserve_enabled: bool) -> Result<PluginInfo, String> {
    manifest::require_valid_id(id)?;
    require_supported_plugin(id)?;
    let _lifecycle_guard = fs::LIFECYCLE_LOCK.lock();
    // A reload must not create a state-only ghost record for an unknown id.
    let snapshot = state::read_state(state_path)?;
    if !plugins_dir.join(id).exists() && !snapshot.plugins.contains_key(id) {
        return Err(format!("{id}: plugin not installed"));
    }
    if expected_version.is_some() || preserve_enabled {
        let record = snapshot.plugins.get(id).ok_or_else(|| format!("{id}: plugin state is missing"))?;
        let installed = fs::info_for(plugins_dir, id, record);
        if expected_version.is_some_and(|expected| expected != installed.version) {
            return Err(format!("{id}: installed version does not match expectedVersion"));
        }
        if preserve_enabled && !record.enabled { return Ok(installed); }
    }
    let info = set_enabled_locked(plugins_dir, state_path, id, true)?;
    crate::plugin_caps::kill_tracked_children(id);
    Ok(info)
}

#[tauri::command]
pub fn plugin_quarantine(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    id: String,
    error: String,
) -> Result<PluginInfo, String> {
    manifest::require_valid_id(&id)?;
    let _lifecycle_guard = fs::LIFECYCLE_LOCK.lock();
    let result = state::update_record(&state::state_path(), &id, |record| {
        record.quarantined = true;
        record.last_error = Some(error.clone());
    });
    // Quarantine takes effect immediately for lifecycle="plugin" children
    // too — they belong to the quarantined plugin's runtime.
    crate::plugin_caps::kill_tracked_children(&id);
    crate::plugin_windows::dispose_plugin(&app, &id);
    emit_changed(state.emitters.as_ref(), Some(&id), false);
    result.map(|record| fs::info_for(&state::plugins_dir(), &id, &record))
}

/// Artwork bytes for the installed-plugin UI (the market/installed row icon
/// and the detail gallery), returned as a data URL: the webview needs no
/// filesystem access, `~/.ccgui-next` stays behind the asset protocol's deny
/// list, and only files shipped by that very plugin can be read.
#[tauri::command]
pub fn plugin_read_artwork(id: String, path: String) -> Result<String, String> {
    manifest::require_valid_id(&id)?;
    fs::artwork_data_url(&state::plugins_dir(), &id, &path)
}

#[tauri::command]
pub fn plugin_read_file(id: String, name: String) -> Result<String, String> {
    manifest::require_valid_id(&id)?;
    require_supported_plugin(&id)?;
    if !READABLE_FILES.contains(&name.as_str()) {
        return Err(format!(
            "{name}: not readable (want one of {})",
            READABLE_FILES.join(", ")
        ));
    }
    let path = state::plugins_dir().join(&id).join(&name);
    let size = std::fs::metadata(&path)
        .map_err(|e| format!("stat {}: {e}", path.display()))?
        .len();
    if size > fs::MAX_FILE_BYTES {
        return Err(format!("{name}: exceeds the 16MB limit ({size} bytes)"));
    }
    std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))
}

#[tauri::command]
pub fn plugin_storage_get(
    db: tauri::State<'_, Arc<crate::db::Db>>,
    id: String,
    key: String,
) -> Result<Option<serde_json::Value>, String> {
    manifest::require_valid_id(&id)?;
    db.plugin_kv_get(&id, &key)
}

#[tauri::command]
pub fn plugin_storage_set(
    db: tauri::State<'_, Arc<crate::db::Db>>,
    id: String,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    manifest::require_valid_id(&id)?;
    db.plugin_kv_set(&id, &key, &value)
}

#[tauri::command]
pub fn plugin_storage_delete(
    db: tauri::State<'_, Arc<crate::db::Db>>,
    id: String,
    key: String,
) -> Result<(), String> {
    manifest::require_valid_id(&id)?;
    db.plugin_kv_delete(&id, &key)
}

#[cfg(test)]
mod retirement_tests;

#[cfg(test)]
pub(crate) mod test_support {
    use std::path::{Path, PathBuf};

    pub(crate) struct Scratch(pub PathBuf);
    impl Scratch {
        pub(crate) fn new() -> Self {
            let dir = std::env::temp_dir()
                .join(format!("ccgui-next-plugins-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        pub(crate) fn path(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    pub(crate) fn write_plugin(dir: &Path, manifest: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("manifest.json"), manifest).unwrap();
    }

    pub(crate) fn valid_manifest(id: &str) -> String {
        format!(
            r#"{{"id":"{id}","name":"Test","version":"1.2.3","tier":"declarative",
                "permissions":["storage","ui:panel-tab"]}}"#
        )
    }

    /// validate_manifest with the file list install_from would have walked.
    pub(crate) fn validate(dir: &Path) -> Result<super::manifest::PluginManifest, String> {
        let files = super::fs::collect_files(dir)?;
        super::manifest::validate_manifest(dir, &files)
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{valid_manifest, write_plugin, Scratch};
    use super::{emit_changed, fs, install_sink, reload_at, set_enabled_at, uninstall_at};

    #[test]
    fn concurrent_install_sinks_keep_request_ids_and_legacy_payloads_separate() {
        struct Recorder(std::sync::Mutex<Vec<serde_json::Value>>);
        impl crate::event_sink::Emit for Recorder {
            fn emit_json(&self, name: &str, raw_json: &str) {
                assert_eq!(name, crate::event_sink::INSTALL_PROGRESS_EVENT);
                self.0
                    .lock()
                    .unwrap()
                    .push(serde_json::from_str(raw_json).unwrap());
            }
        }
        let recorder = std::sync::Arc::new(Recorder(std::sync::Mutex::new(Vec::new())));
        let first = install_sink(recorder.clone(), Some("first-request".into())).unwrap();
        let second = install_sink(recorder.clone(), Some("second-request".into())).unwrap();
        let legacy = install_sink(recorder.clone(), None).unwrap();
        first.emit_install_progress(crate::event_sink::InstallProgress {
            done: 10,
            total: 100,
            finished: false,
        });
        second.emit_install_progress(crate::event_sink::InstallProgress {
            done: 90,
            total: 100,
            finished: false,
        });
        legacy.emit_install_progress(crate::event_sink::InstallProgress {
            done: 50,
            total: 100,
            finished: true,
        });
        let events = recorder.0.lock().unwrap();
        assert_eq!(events[0]["requestId"], "first-request");
        assert_eq!(events[0]["done"], 10);
        assert_eq!(events[1]["requestId"], "second-request");
        assert_eq!(events[1]["done"], 90);
        assert!(events[2].get("requestId").is_none());
        for invalid in ["", "a/b", "a b", "🚫"] {
            assert!(install_sink(recorder.clone(), Some(invalid.into())).is_err());
        }
        assert!(install_sink(recorder.clone(), Some("x".repeat(129))).is_err());
    }

    #[test]
    fn change_events_carry_only_snapshot_invalidation_and_bundle_reload_intent() {
        struct Recorder(std::sync::Mutex<Vec<(String, serde_json::Value)>>);
        impl crate::event_sink::Emit for Recorder {
            fn emit_json(&self, name: &str, raw_json: &str) {
                self.0
                    .lock()
                    .unwrap()
                    .push((name.to_string(), serde_json::from_str(raw_json).unwrap()));
            }
        }
        let recorder = Recorder(std::sync::Mutex::new(Vec::new()));
        emit_changed(&recorder, Some("demo"), true);
        emit_changed(&recorder, Some("demo"), false);
        emit_changed(&recorder, None, true);
        assert_eq!(
            *recorder.0.lock().unwrap(),
            vec![
                (
                    "plugins://changed".into(),
                    serde_json::json!({"id":"demo","reload":true})
                ),
                (
                    "plugins://changed".into(),
                    serde_json::json!({"id":"demo","reload":false})
                ),
                (
                    "plugins://changed".into(),
                    serde_json::json!({"id":null,"reload":true})
                ),
            ]
        );
    }

    #[test]
    fn reload_rejects_unknown_plugins_and_clears_the_installed_plugins_quarantine() {
        let scratch = Scratch::new();
        let plugins_dir = scratch.path("plugins");
        let state_path = scratch.path("plugins.json");
        assert!(reload_at(&plugins_dir, &state_path, "missing")
            .unwrap_err()
            .contains("not installed"));
        assert!(!state_path.exists());
        let source = scratch.path("src-reload");
        write_plugin(&source, &valid_manifest("reload-plugin"));
        fs::install_from(&plugins_dir, &state_path, &source, "local", |_| {}).unwrap();
        super::state::update_record(&state_path, "reload-plugin", |record| {
            record.quarantined = true;
            record.last_error = Some("old failure".into());
        })
        .unwrap();
        let info = reload_at(&plugins_dir, &state_path, "reload-plugin").unwrap();
        assert!(info.enabled);
        assert!(!info.quarantined);
        assert!(info.last_error.is_none());
    }

    #[test]
    fn managed_reload_checks_version_before_mutation_and_preserves_disabled_state() {
        let scratch = Scratch::new();
        let plugins_dir = scratch.path("plugins");
        let state_path = scratch.path("plugins.json");
        let source = scratch.path("source");
        write_plugin(&source, &valid_manifest("managed-plugin"));
        fs::install_from(&plugins_dir, &state_path, &source, "local", |_| {}).unwrap();
        super::state::update_record(&state_path, "managed-plugin", |record| {
            record.enabled = false;
            record.quarantined = true;
            record.last_error = Some("retained".into());
        }).unwrap();
        let before = std::fs::read(&state_path).unwrap();
        assert!(super::reload_checked_at(&plugins_dir, &state_path, "managed-plugin", Some("9.9.9"), true).is_err());
        let info = super::reload_checked_at(&plugins_dir, &state_path, "managed-plugin", Some("1.2.3"), true).unwrap();
        assert!(!info.enabled && info.quarantined);
        assert_eq!(info.last_error.as_deref(), Some("retained"));
        assert_eq!(std::fs::read(&state_path).unwrap(), before);
    }

    #[test]
    fn checked_package_requires_both_identity_fields() {
        assert!(super::expected_package(&Some("valid-id".into()), &None).is_err());
        assert!(super::expected_package(&None, &Some("1.0.0".into())).is_err());
        assert!(super::expected_package(&Some("../bad".into()), &Some("1.0.0".into())).is_err());
        assert!(super::expected_package(&Some("valid-id".into()), &Some("bad".into())).is_err());
        assert!(super::expected_package(&None, &None).unwrap().is_none());
    }

    #[test]
    fn managed_reload_waits_for_concurrent_lifecycle_commit_before_checking_enabled() {
        let scratch = Scratch::new();
        let plugins_dir = scratch.path("plugins");
        let state_path = scratch.path("plugins.json");
        let source = scratch.path("source");
        write_plugin(&source, &valid_manifest("locked-plugin"));
        fs::install_from(&plugins_dir, &state_path, &source, "local", |_| {}).unwrap();
        let lifecycle = fs::LIFECYCLE_LOCK.lock();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (result_tx, result_rx) = std::sync::mpsc::channel();
        let thread_plugins = plugins_dir.clone();
        let thread_state = state_path.clone();
        let worker = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            let result = super::reload_checked_at(&thread_plugins, &thread_state, "locked-plugin", Some("1.2.3"), true);
            result_tx.send(result).unwrap();
        });
        started_rx.recv().unwrap();
        assert!(result_rx.recv_timeout(std::time::Duration::from_millis(50)).is_err());
        // Simulate the disable that owns the lifecycle section, before reload
        // can inspect enabled/version. The old unlocked check raced this write.
        super::set_enabled_locked(&plugins_dir, &state_path, "locked-plugin", false).unwrap();
        drop(lifecycle);
        assert!(!result_rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap().unwrap().enabled);
        worker.join().unwrap();
    }

    #[test]
    fn managed_change_event_correlates_reload_without_changing_legacy_events() {
        struct Recorder(std::sync::Mutex<serde_json::Value>);
        impl crate::event_sink::Emit for Recorder {
            fn emit_json(&self, _: &str, raw_json: &str) {
                *self.0.lock().unwrap() = serde_json::from_str(raw_json).unwrap();
            }
        }
        let recorder = Recorder(std::sync::Mutex::new(serde_json::Value::Null));
        super::emit_changed_for_request(&recorder, Some("managed-plugin"), true, Some("request-123"));
        assert_eq!(recorder.0.lock().unwrap()["requestId"], "request-123");
    }

    #[tokio::test]
    async fn disable_and_uninstall_kill_lifecycle_plugin_children() {
        let scratch = Scratch::new();
        let plugins_dir = scratch.path("plugins");
        let state_path = scratch.path("plugins.json");

        let source = scratch.path("src-life");
        write_plugin(&source, &valid_manifest("life-plugin"));
        fs::install_from(&plugins_dir, &state_path, &source, "local", |_| {}).unwrap();
        // Freshly installed plugins start disabled; enable first.
        set_enabled_at(&plugins_dir, &state_path, "life-plugin", true).unwrap();

        crate::plugin_caps::register_tracked_child(
            "life-plugin",
            crate::plugin_caps::spawn_test_sleeper(),
        ).unwrap();
        set_enabled_at(&plugins_dir, &state_path, "life-plugin", false).unwrap();
        // The disable hook already drained and killed the tracked child.
        assert_eq!(crate::plugin_caps::kill_tracked_children("life-plugin"), 0);

        set_enabled_at(&plugins_dir, &state_path, "life-plugin", true).unwrap();
        crate::plugin_caps::register_tracked_child(
            "life-plugin",
            crate::plugin_caps::spawn_test_sleeper(),
        ).unwrap();
        let db = crate::db::Db::open_at(&scratch.path("app.db")).unwrap();
        uninstall_at(&db, &plugins_dir, &state_path, "life-plugin", false).unwrap();
        // Same for uninstall: nothing left for a later kill to find.
        assert_eq!(crate::plugin_caps::kill_tracked_children("life-plugin"), 0);
    }
}
