use super::test_support::{valid_manifest, write_plugin, Scratch};
use super::{fs, reload_at, set_enabled_at, state, RETIRED_SPELLCAST_BRIDGE};

#[test]
fn retired_bridge_is_disabled_persistently_without_removing_files_or_kv() {
    let scratch = Scratch::new();
    let plugins_dir = scratch.path("plugins");
    let state_path = scratch.path("plugins.json");
    let db = crate::db::Db::open_at(&scratch.path("app.db")).unwrap();
    let id = RETIRED_SPELLCAST_BRIDGE;
    write_plugin(&plugins_dir.join(id), &valid_manifest(id));
    let payload = serde_json::json!({"receipt": "preserve-me"});
    db.plugin_kv_set(id, "delivery-ledger-v1", &payload)
        .unwrap();

    let mut legacy = state::PluginsState::default();
    let mut record = state::PluginRecord::fresh("local", 123);
    record.permissions = vec!["network:127.0.0.1:47194".into()];
    legacy.plugins.insert(id.into(), record);
    legacy.plugins.insert(
        "spellcast-other".into(),
        state::PluginRecord::fresh("local", 456),
    );
    // Even an old tombstone must not turn retirement into data deletion.
    legacy.kv_tombstones.insert(id.into(), 1);
    legacy.kv_tombstones.insert("uninstalled-other".into(), 1);
    db.plugin_kv_set("uninstalled-other", "old-data", &payload)
        .unwrap();
    state::write_state(&state_path, &legacy).unwrap();

    // Capabilities are blocked before list-triggered migration runs.
    assert!(state::record_enabled_permissions(&state_path, id)
        .unwrap_err()
        .contains("replaced by built-in"));
    for _ in 0..2 {
        let infos = state::list_plugins(&db, &plugins_dir, &state_path).unwrap();
        assert!(!infos.iter().find(|info| info.id == id).unwrap().enabled);
        assert!(
            infos
                .iter()
                .find(|info| info.id == "spellcast-other")
                .unwrap()
                .enabled
        );
        let saved = state::read_state(&state_path).unwrap();
        assert!(!saved.plugins[id].enabled);
        assert_eq!(saved.plugins[id].installed_at, 123);
        assert_eq!(
            saved.plugins[id].permissions,
            legacy.plugins[id].permissions
        );
        assert_eq!(saved.kv_tombstones[id], 1);
        assert!(!saved.kv_tombstones.contains_key("uninstalled-other"));
        assert_eq!(
            db.plugin_kv_get("uninstalled-other", "old-data").unwrap(),
            None
        );
        assert_eq!(
            db.plugin_kv_get(id, "delivery-ledger-v1").unwrap(),
            Some(payload.clone())
        );
        assert!(plugins_dir.join(id).join("manifest.json").is_file());
    }
    assert!(
        state::record_enabled_permissions(&state_path, "spellcast-other")
            .unwrap()
            .0
    );
}

#[test]
fn retired_bridge_cannot_be_registered_enabled_reloaded_or_installed() {
    let scratch = Scratch::new();
    let plugins_dir = scratch.path("plugins");
    let state_path = scratch.path("plugins.json");
    let source = scratch.path("source");
    let id = RETIRED_SPELLCAST_BRIDGE;
    write_plugin(&source, &valid_manifest(id));
    for source_kind in ["local", "marketplace"] {
        let error =
            fs::install_from(&plugins_dir, &state_path, &source, source_kind, |_| {}).unwrap_err();
        assert!(error.contains("replaced by built-in"));
    }
    assert!(!plugins_dir.exists());
    assert!(set_enabled_at(&plugins_dir, &state_path, id, true)
        .unwrap_err()
        .contains("replaced by built-in"));
    assert!(reload_at(&plugins_dir, &state_path, id)
        .unwrap_err()
        .contains("replaced by built-in"));
    assert!(!state_path.exists());

    // Reinstall must not replace an existing retired bundle or its state.
    write_plugin(&plugins_dir.join(id), &valid_manifest(id));
    state::update_record(&state_path, id, |record| record.enabled = true).unwrap();
    assert!(!state::read_state(&state_path).unwrap().plugins[id].enabled);
    let before = std::fs::read(&state_path).unwrap();
    assert!(fs::install_from(&plugins_dir, &state_path, &source, "local", |_| {}).is_err());
    assert_eq!(std::fs::read(&state_path).unwrap(), before);
    assert!(plugins_dir.join(id).join("manifest.json").is_file());
    assert!(super::plugin_read_file(id.into(), "main.js".into())
        .unwrap_err()
        .contains("replaced by built-in"));

    write_plugin(&source, &valid_manifest("spellcast-other"));
    fs::install_from(&plugins_dir, &state_path, &source, "local", |_| {}).unwrap();
    assert!(
        set_enabled_at(&plugins_dir, &state_path, "spellcast-other", true)
            .unwrap()
            .enabled
    );
}
