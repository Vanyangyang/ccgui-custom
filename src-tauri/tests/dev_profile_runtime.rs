//! One binary/one process profile. All data and the only executable CLI are
//! owned by TestHarness; its special context is suspended for product checks.
use ccgui_next_lib::{
    paths,
    settings::AppSettings,
    test_harness::{profile_runtime_support as runtime, TestHarness},
};

#[tokio::test]
async fn relay_protocol_preflight_is_default_closed_and_preserves_legacy_behavior() {
    use std::cell::Cell;
    let probes = Cell::new(0);
    let probe = || async {
        probes.set(probes.get() + 1);
        Ok(serde_json::json!({"protocol":"legacy", "profilePrefix":"/.ccgui-dev/"}))
    };
    let target = "https://dev.fixture";
    runtime::relay_gate(false, None, "legacy-address", probe).await.unwrap();
    assert_eq!(
        probes.get(),
        0,
        "stable route must not acquire a new negotiation dependency"
    );
    for protocol in [None, Some("unknown"), Some("legacy"), Some("ccgui-profile-v1")] {
        assert!(runtime::relay_gate(true, protocol, target, probe)
            .await
            .unwrap_err()
            .contains("protocol-required"));
    }
    assert_eq!(
        probes.get(),
        0,
        "undeclared/unknown development protocol must not even probe"
    );
    for invalid in ["https://dev.fixture/path", "https://dev.fixture/?token=synthetic", "https://synthetic@dev.fixture", "https://dev.fixture/#fragment"] {
        assert!(runtime::relay_gate(true, Some("ccgui-profile-v2"), invalid, probe).await.is_err());
    }
    assert_eq!(probes.get(), 0, "invalid targets must fail before capability I/O");
    assert!(runtime::relay_gate(true, Some("ccgui-profile-v2"), target, probe)
        .await
        .unwrap_err()
        .contains("unsupported-worker"));
    assert_eq!(probes.get(), 1);
    let capabilities = serde_json::json!({"protocol":"ccgui-profile-v2", "profilePrefix":"/.ccgui-dev/",
        "independentCredentials":true, "independentOrigin":true,
        "stableOrigin":"https://stable.fixture", "developmentOrigin":target});
    for (field, invalid) in [
        ("protocol", serde_json::json!("ccgui-profile-v1")),
        ("protocol", serde_json::json!("unknown")),
        ("profilePrefix", serde_json::json!("/agent")),
        ("independentCredentials", serde_json::json!(false)),
        ("independentOrigin", serde_json::json!(false)),
        ("independentOrigin", serde_json::Value::Null),
        ("stableOrigin", serde_json::Value::Null),
        ("stableOrigin", serde_json::json!(target)),
        ("stableOrigin", serde_json::json!("https://DEV.fixture:443/")),
        ("stableOrigin", serde_json::json!("https://stable.fixture/path")),
        ("developmentOrigin", serde_json::Value::Null),
        ("developmentOrigin", serde_json::json!("https://other.fixture")),
    ] {
        let mut invalid_capabilities = capabilities.clone();
        invalid_capabilities[field] = invalid;
        assert!(runtime::relay_gate(true, Some("ccgui-profile-v2"), target, || async {
            Ok(invalid_capabilities)
        }).await.is_err(), "must reject invalid {field}");
    }
    // Stable origin cannot start a development bridge even with valid metadata.
    assert!(runtime::relay_gate(true, Some("ccgui-profile-v2"), "https://stable.fixture", || async {
        Ok(capabilities.clone())
    }).await.is_err());
    // Origin comparison uses scheme/host/effective port, never pathname.
    for stable_origin in ["https://dev.fixture:8443", "http://dev.fixture:80"] {
        let mut separate_origin = capabilities.clone();
        separate_origin["stableOrigin"] = serde_json::json!(stable_origin);
        separate_origin["developmentOrigin"] = serde_json::json!("https://DEV.fixture:443/");
        runtime::relay_gate(true, Some("ccgui-profile-v2"), target, || async {
            Ok(separate_origin)
        }).await.unwrap();
    }
    runtime::relay_gate(true, Some("ccgui-profile-v2"), "wss://dev.fixture:443/", || async {
        Ok(capabilities)
    }).await.unwrap();
    let settings = AppSettings::default();
    assert!(settings.web_relay_profile_protocol.is_none());
    assert!(serde_json::to_value(settings)
        .unwrap()
        .get("webRelayProfileProtocol")
        .is_none());
}

#[test]
fn ordinary_profile_isolates_homes_environment_history_and_automatic_actions() {
    let mut fixture = TestHarness::new().unwrap();
    let original = fixture.root().join(".codex");
    let sentinel = original.join("config.toml");
    std::fs::write(&sentinel, b"original-fixture-sentinel").unwrap();
    let other_profile = fixture.root().join("other-profile");
    std::fs::create_dir(&other_profile).unwrap();
    std::fs::write(other_profile.join("sentinel"), b"other-profile-sentinel").unwrap();
    let profile = dunce::simplified(fixture.root()).join("ordinary-dev");
    #[cfg(windows)]
    let fake = fixture.root().join("bin/environment.cmd");
    #[cfg(windows)]
    std::fs::write(&fake, b"@echo off\r\necho HOME=%HOME%\r\necho CODEX_HOME=%CODEX_HOME%\r\necho CLAUDE_CONFIG_DIR=%CLAUDE_CONFIG_DIR%\r\nif defined CCGUI_SYNTHETIC_SECRET echo SECRET_LEAK\r\nif defined NODE_OPTIONS echo HOOK_LEAK\r\nif defined HTTP_PROXY echo PROXY_LEAK\r\n").unwrap();
    #[cfg(unix)]
    let fake = fixture.root().join("bin/environment");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(&fake, b"#!/bin/sh\nprintf 'HOME=%s\\nCODEX_HOME=%s\\nCLAUDE_CONFIG_DIR=%s\\n' \"$HOME\" \"$CODEX_HOME\" \"$CLAUDE_CONFIG_DIR\"\n[ -z \"$CCGUI_SYNTHETIC_SECRET\" ] || echo SECRET_LEAK\n[ -z \"$NODE_OPTIONS\" ] || echo HOOK_LEAK\n[ -z \"$HTTP_PROXY\" ] || echo PROXY_LEAK\nexit 0\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    fixture.register_cli("environment", &fake).unwrap();
    fixture.set_fixture_env("CCGUI_SYNTHETIC_SECRET", Some("fixture-marker-only".into()));
    fixture.set_fixture_env("NODE_OPTIONS", Some("fixture-hook-only".into()));
    fixture.set_fixture_env("HTTP_PROXY", Some("fixture-proxy-only".into()));
    // Stable/default behavior before activation: existing fixture route wins.
    assert_eq!(runtime::codex_home(), original);
    let (bind, advertised) = runtime::bridge_binding(|| Some("198.18.0.1".into()));
    assert_eq!(bind, "0.0.0.0:0".parse().unwrap());
    assert_eq!(advertised, "198.18.0.1");
    let mut count = 0;
    runtime::automatic(|| count += 1);
    assert_eq!(count, 1);
    fixture
        .with_ordinary_profile(&profile, "environment", |binary| {
            let home = profile.join("engine-home");
            assert_eq!(paths::app_home(), profile);
            let mut lan_probes = 0;
            let (bind, advertised) = runtime::bridge_binding(|| {
                lan_probes += 1;
                Some("198.18.0.1".into())
            });
            assert_eq!(bind, "127.0.0.1:0".parse().unwrap());
            assert_eq!(advertised, "127.0.0.1");
            assert_eq!(lan_probes, 0, "ordinary dev profile must never probe/advertise LAN");
            paths::ensure_dirs().unwrap();
            assert_eq!(
                runtime::engine_home(Some("CLAUDE_CONFIG_DIR"), ".claude"),
                home.join(".claude")
            );
            assert_eq!(runtime::codex_home(), home.join(".codex"));
            let mut settings = AppSettings::default();
            settings.codex_home = Some(original.to_string_lossy().into());
            runtime::apply_codex_home(&settings);
            assert_eq!(runtime::codex_home(), home.join(".codex"));
            assert_eq!(
                std::env::var_os("CODEX_HOME"),
                Some(original.clone().into_os_string())
            );
            assert!(runtime::quota_account_stamp().is_none());
            assert_eq!(
                runtime::history_roots(&fixture.root().join("ws")),
                vec![home.join(".local/share/opencode")]
            );
            assert_eq!(runtime::webview_dir(), Some(profile.join("webview-data")));
            runtime::automatic(|| count += 100);
            assert_eq!(count, 1);
            assert!(runtime::relay_scope().unwrap().starts_with("dev-"));
            // No fixture resolver/env cleaner is active here. The actual command
            // builder only runs the absolute, previously allowlisted fake script.
            let mut command = runtime::command(binary.to_str().unwrap());
            command.env("CODEX_HOME", &original); // provider attempts to escape
            runtime::enforce_homes(&mut command);
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(runtime::login_environment(&mut command));
            let output = command.as_std_mut().output().unwrap();
            assert!(output.status.success());
            let output = String::from_utf8(output.stdout).unwrap();
            assert!(output.contains(&format!("HOME={}", home.display())));
            assert!(output.contains(&format!("CODEX_HOME={}", home.join(".codex").display())));
            assert!(output.contains(&format!(
                "CLAUDE_CONFIG_DIR={}",
                home.join(".claude").display()
            )));
            assert!(!output.contains("LEAK"));
            std::fs::write(paths::config_path(), b"development-only").unwrap();
            assert_eq!(
                std::fs::read(&sentinel).unwrap(),
                b"original-fixture-sentinel"
            );
            assert_eq!(
                std::fs::read(other_profile.join("sentinel")).unwrap(),
                b"other-profile-sentinel"
            );
            assert!(!other_profile.join("config.json").exists());
        })
        .unwrap();
}
