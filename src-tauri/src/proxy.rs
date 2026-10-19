//! Global network proxy (网络代理).
//!
//! Persisted in settings.json (`systemProxyEnabled` / `systemProxyUrl`) and
//! applied to this process's own environment: every child spawned afterwards
//! (engine CLIs, terminals, the dsh host) inherits HTTP(S)_PROXY/ALL_PROXY,
//! and reqwest clients pick env proxies up by default. Applying restores the
//! launch-time environment first, so disabling returns the process to exactly
//! what the user had outside the app.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::LazyLock;

use parking_lot::Mutex;

use crate::settings::AppSettings;

/// 【启动保护】已审核的本机代理。专用入口和正式程序启动门闩都固定使用它。
pub(crate) const APPROVED_LAUNCH_PROXY: &str = "http://127.0.0.1:7897";
/// 【启动保护】在创建 WebView 之前写入，使界面流量走同一代理；进程起来后再改对已创建的界面无效。
pub(crate) const WEBVIEW_PROXY_ARGUMENTS: &str =
    "--proxy-server=http://127.0.0.1:7897 --proxy-bypass-list=localhost;127.0.0.1;[::1] --disable-quic";

const PROXY_ENV_KEYS: [&str; 8] = [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
];
const DEFAULT_NO_PROXY: &str = "localhost,127.0.0.1,::1";
/// Schemes the UI advertises (http(s)/socks5) and the engine CLIs accept.
const ALLOWED_SCHEMES: [&str; 4] = ["http", "https", "socks5", "socks5h"];

type ProxyEnvSnapshot = Vec<(&'static str, Option<String>)>;

/// Launch-time proxy env, captured on first apply; disabling restores it.
static INITIAL_PROXY_ENV: LazyLock<Mutex<Option<ProxyEnvSnapshot>>> =
    LazyLock::new(|| Mutex::new(None));
/// 【启动保护】正式安装程序置位后，后续应用代理不再把启动时带来的 NO_PROXY 绕过合并进来。
static STRICT_LAUNCH_PROXY: AtomicBool = AtomicBool::new(false);

#[cfg(test)]
static PROXY_ENV_TEST_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn lock_proxy_env_state() -> parking_lot::MutexGuard<'static, Option<ProxyEnvSnapshot>> {
    INITIAL_PROXY_ENV.lock()
}

fn snapshot_current_proxy_env() -> ProxyEnvSnapshot {
    PROXY_ENV_KEYS
        .iter()
        .map(|&key| (key, std::env::var(key).ok()))
        .collect()
}

fn initial_proxy_env_snapshot() -> ProxyEnvSnapshot {
    let mut snapshot = lock_proxy_env_state();
    if snapshot.is_none() {
        *snapshot = Some(snapshot_current_proxy_env());
    }
    snapshot.clone().unwrap_or_default()
}

fn clear_proxy_env() {
    for key in PROXY_ENV_KEYS {
        std::env::remove_var(key);
    }
}

fn restore_proxy_env_snapshot(snapshot: &[(&'static str, Option<String>)]) {
    clear_proxy_env();
    for (key, value) in snapshot {
        if let Some(value) = value {
            std::env::set_var(key, value);
        }
    }
}

fn append_no_proxy_values(values: &mut Vec<String>, raw: &str) {
    for item in raw.split(',') {
        let candidate = item.trim();
        if candidate.is_empty() {
            continue;
        }
        if values
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(candidate))
        {
            continue;
        }
        values.push(candidate.to_string());
    }
}

/// User's launch-time NO_PROXY plus the loopback defaults: dsh host probing
/// and any local service must never be routed through the proxy.
fn merged_no_proxy_value(snapshot: &[(&'static str, Option<String>)]) -> String {
    let mut values = Vec::new();
    for key in ["NO_PROXY", "no_proxy"] {
        if let Some(existing) = snapshot
            .iter()
            .find_map(|(snapshot_key, value)| (*snapshot_key == key).then_some(value.as_deref()))
            .flatten()
        {
            append_no_proxy_values(&mut values, existing);
        }
    }
    append_no_proxy_values(&mut values, DEFAULT_NO_PROXY);
    values.join(",")
}

fn normalized_proxy_url(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

pub(crate) fn validate_proxy_settings(settings: &AppSettings) -> Result<(), String> {
    if strict_launch_proxy()
        && (!settings.system_proxy_enabled
            || normalized_proxy_url(settings.system_proxy_url.as_deref()).as_deref() != Some(APPROVED_LAUNCH_PROXY))
    {
        let catalog: serde_json::Value = serde_json::from_str(include_str!("../../src/i18n/native-startup.json"))
            .expect("valid bundled startup translations");
        let language = if settings.language.starts_with("en") { "en" } else { "zh" };
        return Err(catalog[language]["proxy_not_approved"].as_str().expect("proxy protection message").to_string());
    }
    if !settings.system_proxy_enabled {
        return Ok(());
    }
    let proxy_url = normalized_proxy_url(settings.system_proxy_url.as_deref())
        .ok_or_else(|| "Proxy URL is required when network proxy is enabled.".to_string())?;
    let parsed =
        reqwest::Url::parse(&proxy_url).map_err(|error| format!("Invalid proxy URL: {error}"))?;
    if !ALLOWED_SCHEMES.contains(&parsed.scheme()) {
        return Err(format!(
            "Invalid proxy URL: unsupported scheme \"{}\" (expected http, https or socks5).",
            parsed.scheme()
        ));
    }
    if parsed.host_str().unwrap_or_default().is_empty() {
        return Err("Invalid proxy URL: missing host.".to_string());
    }
    Ok(())
}

/// Point this process's proxy env at the configured URL (or restore the
/// launch-time env when disabled). Errors leave the current env untouched.
pub(crate) fn apply_app_proxy_settings(settings: &AppSettings) -> Result<(), String> {
    validate_proxy_settings(settings)?;
    let inherited_env = initial_proxy_env_snapshot();
    // Strict reapplication must not briefly restore inherited bypasses such as NO_PROXY=*.
    // Ordinary unprotected processes retain their existing restore behavior.
    if !strict_launch_proxy() {
        restore_proxy_env_snapshot(&inherited_env);
    }
    if !settings.system_proxy_enabled {
        return Ok(());
    }

    let proxy_url = normalized_proxy_url(settings.system_proxy_url.as_deref())
        .ok_or_else(|| "Proxy URL is required when network proxy is enabled.".to_string())?;

    for key in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        std::env::set_var(key, &proxy_url);
    }

    // 【启动保护】已安装正式程序只保留回环绕过，避免外部 NO_PROXY=* 把流量放出代理。
    let no_proxy = if strict_launch_proxy() {
        DEFAULT_NO_PROXY.to_string()
    } else {
        merged_no_proxy_value(&inherited_env)
    };
    std::env::set_var("NO_PROXY", &no_proxy);
    std::env::set_var("no_proxy", &no_proxy);
    Ok(())
}

fn strict_launch_proxy() -> bool {
    STRICT_LAUNCH_PROXY.load(Ordering::Acquire)
}

fn force_approved_proxy_env() {
    for key in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        std::env::set_var(key, APPROVED_LAUNCH_PROXY);
    }
    std::env::set_var("NO_PROXY", DEFAULT_NO_PROXY);
    std::env::set_var("no_proxy", DEFAULT_NO_PROXY);
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        WEBVIEW_PROXY_ARGUMENTS,
    );
}

/// 【启动保护】先记下进程原有代理环境，再强制已审核代理。
/// 保护进程拒绝关闭或改动代理，且重用设置时不会恢复外部绕过。
pub(crate) fn begin_strict_launch_proxy() {
    let _ = initial_proxy_env_snapshot();
    STRICT_LAUNCH_PROXY.store(true, Ordering::Release);
    force_approved_proxy_env();
}


fn is_socks_proxy_url(raw: &str) -> bool {
    raw.trim()
        .split_once("://")
        .is_some_and(|(scheme, _)| scheme.eq_ignore_ascii_case("socks5") || scheme.eq_ignore_ascii_case("socks5h"))
}

/// Cursor CLI's Node HTTP/2 proxy client rejects `socks5://` in `HTTP_PROXY` /
/// `HTTPS_PROXY` with `Unsupported proxy protocol for HTTPS_PROXY: socks5:`.
/// Strip those four env vars from the child command when they carry a SOCKS5
/// scheme while keeping `ALL_PROXY` / `NO_PROXY` intact.
pub(crate) fn configure_cursor_command_proxy(cmd: &mut tokio::process::Command) {
    for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
        if std::env::var(key).ok().is_some_and(|val| is_socks_proxy_url(&val)) {
            cmd.env_remove(key);
        }
    }
}

#[cfg(test)]
pub(crate) fn reset_initial_proxy_env_for_tests() {
    *lock_proxy_env_state() = None;
    STRICT_LAUNCH_PROXY.store(false, Ordering::Release);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proxy_settings(enabled: bool, url: Option<&str>) -> AppSettings {
        let mut settings = AppSettings::default();
        settings.system_proxy_enabled = enabled;
        settings.system_proxy_url = url.map(str::to_string);
        settings
    }

    #[test]
    fn validate_rejects_empty_url_when_enabled() {
        let _guard = PROXY_ENV_TEST_LOCK.lock();
        assert!(validate_proxy_settings(&proxy_settings(true, None)).is_err());
        assert!(validate_proxy_settings(&proxy_settings(true, Some("  "))).is_err());
        assert!(validate_proxy_settings(&proxy_settings(false, None)).is_ok());
    }

    #[test]
    fn validate_checks_scheme_and_host() {
        let _guard = PROXY_ENV_TEST_LOCK.lock();
        assert!(
            validate_proxy_settings(&proxy_settings(true, Some("http://127.0.0.1:7890"))).is_ok()
        );
        assert!(
            validate_proxy_settings(&proxy_settings(true, Some("socks5://127.0.0.1:1080"))).is_ok()
        );
        assert!(
            validate_proxy_settings(&proxy_settings(true, Some("ftp://127.0.0.1:21"))).is_err()
        );
        assert!(validate_proxy_settings(&proxy_settings(true, Some("not a url"))).is_err());
    }

    #[test]
    fn apply_sets_and_restores_env() {
        let _guard = PROXY_ENV_TEST_LOCK.lock();
        let original_env = snapshot_current_proxy_env();
        clear_proxy_env();
        reset_initial_proxy_env_for_tests();

        apply_app_proxy_settings(&proxy_settings(true, Some("http://127.0.0.1:7890")))
            .expect("apply proxy");
        assert_eq!(
            std::env::var("HTTP_PROXY").ok().as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(
            std::env::var("ALL_PROXY").ok().as_deref(),
            Some("http://127.0.0.1:7890")
        );
        let no_proxy = std::env::var("NO_PROXY").unwrap_or_default();
        assert!(no_proxy.contains("127.0.0.1"));

        apply_app_proxy_settings(&proxy_settings(false, None)).expect("disable proxy");
        assert!(std::env::var("HTTP_PROXY").is_err());
        assert!(std::env::var("NO_PROXY").is_err());

        restore_proxy_env_snapshot(&original_env);
        reset_initial_proxy_env_for_tests();
    }

    #[test]
    fn disable_restores_inherited_env() {
        let _guard = PROXY_ENV_TEST_LOCK.lock();
        let original_env = snapshot_current_proxy_env();
        clear_proxy_env();
        std::env::set_var("HTTP_PROXY", "http://corp-gateway:8080");
        std::env::set_var("NO_PROXY", "corp.local,internal.example");
        reset_initial_proxy_env_for_tests();

        apply_app_proxy_settings(&proxy_settings(true, Some("http://127.0.0.1:7890")))
            .expect("enable proxy");
        assert_eq!(
            std::env::var("HTTP_PROXY").ok().as_deref(),
            Some("http://127.0.0.1:7890")
        );
        // Inherited NO_PROXY entries survive the override.
        let merged = std::env::var("NO_PROXY").unwrap_or_default();
        assert!(merged.contains("corp.local"));
        assert!(merged.contains("127.0.0.1"));

        apply_app_proxy_settings(&proxy_settings(false, None)).expect("disable proxy");
        assert_eq!(
            std::env::var("HTTP_PROXY").ok().as_deref(),
            Some("http://corp-gateway:8080")
        );
        assert_eq!(
            std::env::var("NO_PROXY").ok().as_deref(),
            Some("corp.local,internal.example")
        );

        restore_proxy_env_snapshot(&original_env);
        reset_initial_proxy_env_for_tests();
    }

    #[test]
    fn strict_launch_rejects_proxy_changes_without_restoring_inherited_bypass() {
        let _guard = PROXY_ENV_TEST_LOCK.lock();
        let original_env = snapshot_current_proxy_env();
        let original_webview = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").ok();
        clear_proxy_env();
        std::env::set_var("NO_PROXY", "*");
        std::env::set_var("no_proxy", "*");
        reset_initial_proxy_env_for_tests();

        begin_strict_launch_proxy();
        assert_eq!(
            std::env::var("HTTP_PROXY").ok().as_deref(),
            Some(APPROVED_LAUNCH_PROXY)
        );
        assert_eq!(
            std::env::var("NO_PROXY").ok().as_deref(),
            Some(DEFAULT_NO_PROXY)
        );
        assert_eq!(
            std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").ok().as_deref(),
            Some(WEBVIEW_PROXY_ARGUMENTS)
        );

        apply_app_proxy_settings(&proxy_settings(true, Some(APPROVED_LAUNCH_PROXY)))
            .expect("reapply approved proxy");
        assert_eq!(
            std::env::var("NO_PROXY").ok().as_deref(),
            Some(DEFAULT_NO_PROXY)
        );
        assert!(!std::env::var("NO_PROXY").unwrap_or_default().contains('*'));

        for settings in [proxy_settings(false, None), proxy_settings(true, Some("http://127.0.0.1:7890"))] {
            let before = snapshot_current_proxy_env();
            assert!(validate_proxy_settings(&settings).is_err());
            assert!(apply_app_proxy_settings(&settings).is_err());
            assert_eq!(snapshot_current_proxy_env(), before);
        }
        assert_eq!(std::env::var("NO_PROXY").ok().as_deref(), Some(DEFAULT_NO_PROXY));

        restore_proxy_env_snapshot(&original_env);
        match original_webview {
            Some(value) => std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", value),
            None => std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"),
        }
        reset_initial_proxy_env_for_tests();
    }

    #[test]
    fn cursor_command_proxy_strips_socks5_from_http_https_proxy() {
        let _guard = PROXY_ENV_TEST_LOCK.lock();
        let original_env = snapshot_current_proxy_env();
        clear_proxy_env();
        reset_initial_proxy_env_for_tests();

        apply_app_proxy_settings(&proxy_settings(true, Some("socks5://127.0.0.1:1080")))
            .expect("enable socks5 proxy");
        let mut cmd = tokio::process::Command::new("cursor-agent");
        configure_cursor_command_proxy(&mut cmd);
        let envs: Vec<_> = cmd.as_std().get_envs().collect();
        for key in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"] {
            assert!(
                envs.iter().any(|(k, v)| k.eq_ignore_ascii_case(key) && v.is_none()),
                "expected {key} to be removed for cursor-agent under socks5 proxy"
            );
        }

        restore_proxy_env_snapshot(&original_env);
        reset_initial_proxy_env_for_tests();
    }
}
