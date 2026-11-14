use super::*;
use serde_json::json;

fn fixture_source() -> Source {
    Source {
        engine: "codex".into(),
        scope: "user".into(),
        path: Some("fixture/hooks.json".into()),
        plugin_id: None,
        plugin_scope: None,
        plugin_name: None,
        plugin_enabled: None,
        version: None,
        fragment: String::new(),
    }
}

#[test]
fn grouped_hooks_list_event_matcher_and_safe_handler_without_secrets() {
    let value = json!({"hooks":{"PreToolUse":[{"matcher":"mcp__.*","hooks":[
        {"type":"mcp_tool","server":"gate","tool":"check","input":{"token":"private-token"}},
        {"type":"command","command":"python secret-script.py --password private-token","env":{"KEY":"private-token"}}
    ]}]}});
    let mut entries = Vec::new();
    parse_grouped(&value, &fixture_source(), &mut entries);
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].label.as_deref(), Some("gate / check"));
    assert_eq!(entries[1].label.as_deref(), Some("python"));
    assert_eq!(entries[0].matcher.as_deref(), Some("mcp__.*"));
    assert!(!serde_json::to_string(&entries)
        .unwrap()
        .contains("private-token"));
    assert!(!serde_json::to_string(&entries)
        .unwrap()
        .contains("secret-script.py"));
}

#[test]
fn antigravity_named_hooks_preserve_disabled_state_and_events() {
    let value = json!({"guard":{"enabled":false,"PreToolUse":[{"matcher":"run_command","hooks":[{"command":"guard.sh --secret xyz"}]}]},
        "reminder":{"SessionStart":[{"type":"command","command":"node reminder.js"}]}});
    let mut entries = Vec::new();
    parse_accepted_named(&value, &fixture_source(), &mut entries);
    assert_eq!(entries.len(), 2);
    assert_eq!(
        entries
            .iter()
            .find(|e| e.label.as_deref() == Some("guard"))
            .unwrap()
            .enabled,
        Some(false)
    );
    assert_eq!(
        entries
            .iter()
            .find(|e| e.label.as_deref() == Some("reminder"))
            .unwrap()
            .enabled,
        Some(true)
    );
    assert!(!serde_json::to_string(&entries).unwrap().contains("xyz"));
}

#[test]
fn codex_native_status_and_trust_are_distinct() {
    let value = json!({"data":[{"hooks":[{"key":"plugin:pre:0:0","eventName":"preToolUse","handlerType":"command",
        "command":"node --token private-token","source":"plugin","sourcePath":"fixture/hooks.json",
        "pluginId":"sample@market","enabled":true,"isManaged":false,"trustStatus":"untrusted",
        "currentHash":format!("sha256:{}", "a".repeat(64))}]}]});
    let mut entries = Vec::new();
    codex_native(&value, &mut entries).unwrap();
    assert_eq!(entries[0].enabled, Some(true));
    assert_eq!(entries[0].trust.as_deref(), Some("untrusted"));
    assert_eq!(entries[0].plugin_id.as_deref(), Some("sample@market"));
    assert_eq!(entries[0].toggle.as_ref().unwrap().scope, "codex");
    assert!(!serde_json::to_string(&entries)
        .unwrap()
        .contains("private-token"));
    assert!(!serde_json::to_string(&entries)
        .unwrap()
        .contains("plugin:pre:0:0"));
    assert!(codex_native(&json!({"data":[{}]}), &mut Vec::new()).is_err());
}

#[test]
fn disabled_plugin_hooks_are_visible_and_cannot_escape_the_plugin_root() {
    let root = std::env::temp_dir().join(format!("ccgui-hook-fixture-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join("hooks")).unwrap();
    std::fs::write(
        root.join("hooks/hooks.json"),
        r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node test.js"}]}]}}"#,
    )
    .unwrap();
    let plugin = crate::cli_plugins::HookPluginSource {
        id: "disabled@market".into(),
        name: "disabled".into(),
        scope: "user".into(),
        enabled: Some(false),
        source_path: root.to_string_lossy().into_owned(),
    };
    let mut entries = Vec::new();
    let mut warnings = Vec::new();
    plugin_hooks("codex", plugin, &mut entries, &mut warnings);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].enabled, Some(false));
    assert_eq!(entries[0].plugin_id.as_deref(), Some("disabled@market"));
    assert!(confined(&root, "../outside.json").is_err());
    assert!(confined(&root, "C:\\outside.json").is_err());
    std::fs::remove_file(root.join("hooks/hooks.json")).unwrap();
    std::fs::remove_dir(root.join("hooks")).unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[test]
fn codex_hook_state_is_not_mistaken_for_a_hook() {
    let value = json!({"hooks":{"state":{"old":{"trusted_hash":"not-a-hook"}},
        "Stop":[{"hooks":[{"type":"command","command":"check --secret value"}]}]}});
    let mut entries = Vec::new();
    parse_grouped(&value, &fixture_source(), &mut entries);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].event, "Stop");
}

#[test]
fn inline_plugin_hook_specs_have_distinct_row_ids() {
    let mut source = fixture_source();
    source.scope = "plugin".into();
    let spec = json!([{"hooks":{"Stop":[{"hooks":[{"command":"first"}]}]}},
        {"hooks":{"Stop":[{"hooks":[{"command":"second"}]}]}}]);
    let mut entries = Vec::new();
    let mut warnings = Vec::new();
    plugin_spec(
        &spec,
        Path::new("."),
        &source,
        false,
        &mut entries,
        &mut warnings,
    );
    assert_eq!(entries.len(), 2);
    assert_ne!(entries[0].id, entries[1].id);
}

#[test]
fn named_hook_toggle_checks_version_and_preserves_other_configuration() {
    let root = std::env::temp_dir().join(format!("ccgui-hook-toggle-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("hooks.json");
    let raw = br#"{"guard":{"PreToolUse":[{"type":"command","command":"check"}],"other":"keep"},"other":{"Stop":[]}}"#;
    std::fs::write(&path, raw).unwrap();
    let version = format!("{:x}", Sha256::digest(raw));
    set_named_enabled(&path, &root, "guard", &version, false).unwrap();
    let changed: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(changed["guard"]["enabled"], false);
    assert_eq!(changed["guard"]["other"], "keep");
    assert!(changed["other"]["Stop"].is_array());
    assert!(set_named_enabled(&path, &root, "guard", &version, true).is_err());
    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(&path).unwrap()).unwrap()["guard"]
            ["enabled"],
        false
    );
    let other_root = root.join("other-scope");
    std::fs::create_dir(&other_root).unwrap();
    let current = format!("{:x}", Sha256::digest(std::fs::read(&path).unwrap()));
    assert!(set_named_enabled(&path, &other_root, "guard", &current, true).is_err());
    std::fs::remove_dir(other_root).unwrap();
    std::fs::remove_file(path).unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[test]
fn named_hook_bom_inventory_and_toggles_preserve_commands_and_raw_versions() {
    let root = std::env::temp_dir().join(format!("ccgui-hook-bom-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(root.join(".agents")).unwrap();
    let path = root.join(".agents/hooks.json");
    let command = r#"type "C:\my dir\deny.json""#;
    let expected = json!({"guard": {
        "enabled": true,
        "PreToolUse": [{"type": "command", "command": command}],
        "unknown": {"keep": "原文"}
    }, "unknown": {"nested": [1, true]}});
    for with_bom in [false, true] {
        let mut raw = if with_bom { UTF8_BOM.to_vec() } else { Vec::new() };
        raw.extend(serde_json::to_vec(&expected).unwrap());
        std::fs::write(&path, &raw).unwrap();
        assert_eq!(read_json(&path).unwrap(), Some(expected.clone()));
        let mut entries = Vec::new();
        let mut warnings = Vec::new();
        add_json(path.clone(), "agy", "project", true, &mut entries, &mut warnings);
        assert!(warnings.is_empty());
        assert_eq!(entries.len(), 1);
        let initial_version = format!("{:x}", Sha256::digest(&raw));
        assert_eq!(entries[0].toggle.as_ref().unwrap().version, initial_version);
        if with_bom {
            let normalized_version = format!("{:x}", Sha256::digest(&raw[UTF8_BOM.len()..]));
            assert!(set_named_enabled(&path, &root, "guard", &normalized_version, false).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), raw);
        }
        for enabled in [false, true] {
            let version = format!("{:x}", Sha256::digest(std::fs::read(&path).unwrap()));
            set_named_enabled(&path, &root, "guard", &version, enabled).unwrap();
            let changed = std::fs::read(&path).unwrap();
            assert_eq!(changed.starts_with(UTF8_BOM), with_bom);
            let value = read_json(&path).unwrap().unwrap();
            let mut expected = expected.clone();
            expected["guard"]["enabled"] = json!(enabled);
            assert_eq!(value, expected);
            assert_eq!(value["guard"]["PreToolUse"][0]["command"], command);
            assert!(set_named_enabled(&path, &root, "guard", &initial_version, !enabled).is_err());
            assert_eq!(std::fs::read(&path).unwrap(), changed);
        }
    }
    std::fs::remove_file(path).unwrap();
    std::fs::remove_dir(root.join(".agents")).unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[test]
fn invalid_hook_json_is_rejected_without_changing_bytes() {
    let root = std::env::temp_dir().join(format!("ccgui-hook-invalid-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("hooks.json");
    for raw in [
        b"\xef\xbb\xbf{\"guard\":".as_slice(),
        b"\xef\xbb\xbf{\"guard\":\"\xff\"}".as_slice(),
        b"\xff\xfe{\0}\0".as_slice(),
    ] {
        std::fs::write(&path, raw).unwrap();
        assert!(read_json(&path).is_err());
        let mut entries = Vec::new();
        let mut warnings = Vec::new();
        add_json(path.clone(), "agy", "project", true, &mut entries, &mut warnings);
        assert!(entries.is_empty());
        assert_eq!(warnings, vec!["config_unreadable"]);
        let version = format!("{:x}", Sha256::digest(raw));
        assert_eq!(
            set_named_enabled(&path, &root, "guard", &version, false).unwrap_err(),
            "Invalid hook configuration"
        );
        assert_eq!(std::fs::read(&path).unwrap(), raw);
    }
    std::fs::remove_file(path).unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[tokio::test]
#[ignore = "explicit read-only inspection of the installed Codex CLI and its plugin declarations"]
async fn live_codex_inventory_includes_disabled_plugin_declarations() {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let native = crate::engine::codex_app::read_hook_inventory(workspace)
        .await
        .unwrap();
    let mut entries = Vec::new();
    codex_native(&native, &mut entries).unwrap();
    let (plugins, _) = crate::cli_plugins::hook_sources("codex", workspace.to_str())
        .await
        .unwrap();
    let requested = std::env::var("CCGUI_TEST_DISABLED_HOOK_PLUGIN").ok();
    let mut saw_requested = false;
    let mut warnings = Vec::new();
    for plugin in plugins {
        if requested.as_deref() == Some(plugin.id.as_str()) {
            assert_eq!(plugin.enabled, Some(false));
            saw_requested = true;
            plugin_hooks("codex", plugin, &mut entries, &mut warnings);
        }
    }
    if let Some(requested) = requested {
        assert!(saw_requested, "requested disabled plugin was not found");
        let found: Vec<_> = entries.iter()
            .filter(|entry| entry.plugin_id.as_deref() == Some(requested.as_str())).collect();
        assert!(!found.is_empty());
        assert!(found.iter().all(|entry| entry.enabled == Some(false)));
        println!("Native Codex hook inventory verified, including {} disabled plugin declarations", found.len());
    } else {
        println!("Native Codex hook inventory verified");
    }
}
