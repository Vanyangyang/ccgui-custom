//! Automatic Google Cloud Billing promotional credits DOM scraper via Tauri WebView.
//!
//! Google Cloud Billing does not expose a REST API for promotional credits
//! (Free Trial / GDP monthly credits) to API keys. When the user triggers a
//! refresh, this module opens the official Google Cloud Billing Credits page
//! in a Tauri `WebviewWindow` sharing the app's persistent WebView profile,
//! extracts the rendered credit rows from the DOM via `initialization_script`
//! + `on_document_title_changed`, persists the snapshot under `app_home()`,
//! and broadcasts `agy-vertex-credits://changed`.

use crate::event_sink::Emit;
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WindowEvent};

pub const BILLING_CREDITS_URL: &str =
    "https://console.cloud.google.com/billing/01E559-FC92E9-D4E9E7/credits/all?authuser=0&organizationId=0";
const WINDOW_LABEL: &str = "agy-vertex-credits-sync";
const TITLE_PREFIX: &str = "__CCGUI_VERTEX_CREDITS__:";
const CACHE_FILE: &str = "agy-vertex-credits.json";

pub const DEFAULT_FREE_TRIAL_CREDIT: &str = "$348.01";
pub const DEFAULT_FREE_TRIAL_ORIGINAL_CREDIT: &str = "$383.45";
pub const DEFAULT_FREE_TRIAL_REMAINING_PERCENT: u8 = 91;
pub const DEFAULT_GDP_MONTHLY_CREDIT: &str = "$51.13";
pub const DEFAULT_GDP_MONTHLY_REMAINING_PERCENT: u8 = 100;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgyVertexCreditsSnapshot {
    pub free_trial_credit: String,
    pub free_trial_original_credit: String,
    pub free_trial_remaining_percent: u8,
    pub gdp_monthly_credit: String,
    pub gdp_monthly_remaining_percent: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collected_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

impl Default for AgyVertexCreditsSnapshot {
    fn default() -> Self {
        Self {
            free_trial_credit: DEFAULT_FREE_TRIAL_CREDIT.to_owned(),
            free_trial_original_credit: DEFAULT_FREE_TRIAL_ORIGINAL_CREDIT.to_owned(),
            free_trial_remaining_percent: DEFAULT_FREE_TRIAL_REMAINING_PERCENT,
            gdp_monthly_credit: DEFAULT_GDP_MONTHLY_CREDIT.to_owned(),
            gdp_monthly_remaining_percent: DEFAULT_GDP_MONTHLY_REMAINING_PERCENT,
            collected_at: None,
            error_code: None,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScrapedCreditsPayload {
    pub status: String,
    pub free_trial_credit: Option<String>,
    pub free_trial_original_credit: Option<String>,
    pub free_trial_remaining_percent: Option<u8>,
    pub gdp_monthly_credit: Option<String>,
    pub gdp_monthly_remaining_percent: Option<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ScrapeSignal {
    LoginRequired,
    Scraped(ScrapedCreditsPayload),
}

const SCRAPE_SCRIPT: &str = r#"
(() => {
  if (window !== window.top) return;
  const PREFIX = "__CCGUI_VERTEX_CREDITS__:";
  const send = (payload) => {
    try {
      document.title = PREFIX + JSON.stringify(payload);
    } catch (_) {}
  };

  const host = (location.hostname || "").toLowerCase();
  const path = location.pathname || "";
  if (
    host === "accounts.google.com" ||
    host.endsWith(".accounts.google.com") ||
    path.startsWith("/signin") ||
    path.startsWith("/ServiceLogin")
  ) {
    send({ status: "login_required" });
    return;
  }

  if (host !== "console.cloud.google.com") return;

  try {
    Object.defineProperty(Document.prototype, "visibilityState", {
      get: () => "visible",
      configurable: true,
    });
    Object.defineProperty(Document.prototype, "hidden", {
      get: () => false,
      configurable: true,
    });
    window.requestAnimationFrame = (cb) =>
      window.setTimeout(() => cb(performance.now()), 16);
  } catch (_) {}

  const CURRENCY_RE = /(?:(?:US|SG|CA|AU|HK|NT|NZ|S)?\$|(?:SGD|USD|EUR|GBP|JPY|CNY)\s*)\s*\d[\d,]*(?:\.\d{1,2})?/gi;
  const PCT_RE = /(\d{1,3}(?:\.\d+)?)\s*%/;

  const normalizeCurrency = (raw) => {
    const num = String(raw).replace(/^[^\d]+/, "").trim();
    return num ? "$" + num : String(raw).trim();
  };

  const parseNumber = (raw) => {
    const val = parseFloat(String(raw).replace(/[^0-9.]/g, ""));
    return Number.isFinite(val) ? val : null;
  };

  const collectRows = (root, out = []) => {
    if (!root || !root.querySelectorAll) return out;
    const rows = root.querySelectorAll("tbody tr, [role='row'], cfc-table-row, mat-row");
    for (const r of rows) out.push(r);
    const all = root.querySelectorAll("*");
    for (const el of all) {
      if (el.shadowRoot) collectRows(el.shadowRoot, out);
    }
    return out;
  };

  const scan = () => {
    const rows = collectRows(document);
    const found = {};
    let matchedAny = false;

    for (const row of rows) {
      if (row.querySelector && row.querySelector("th, [role='columnheader']")) continue;
      const text = String(row.innerText || row.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) continue;
      const rawAmounts = text.match(CURRENCY_RE);
      if (!rawAmounts || rawAmounts.length === 0) continue;
      const amounts = rawAmounts.map(normalizeCurrency);

      const pctMatch = text.match(PCT_RE);
      let pct = pctMatch ? Math.round(parseFloat(pctMatch[1])) : null;
      if (pct === null && amounts.length >= 2) {
        const rem = parseNumber(amounts[0]);
        const orig = parseNumber(amounts[1]);
        if (rem !== null && orig && orig > 0) {
          pct = Math.max(0, Math.min(100, Math.round((rem / orig) * 100)));
        }
      }
      if (pct !== null) {
        pct = Math.max(0, Math.min(100, pct));
      }

      const isFreeTrial = /free\s*trial|freetrial|免费试用|试用赠金/i.test(text);
      const isGdp =
        !isFreeTrial &&
        /\bgdp\b|developer\s*program|开发者|月度|genai|google\s*developer/i.test(text);

      if (isFreeTrial && !found.freeTrialCredit) {
        found.freeTrialCredit = amounts[0];
        if (amounts[1]) found.freeTrialOriginalCredit = amounts[1];
        if (pct !== null) found.freeTrialRemainingPercent = pct;
        matchedAny = true;
      } else if (isGdp && !found.gdpMonthlyCredit) {
        found.gdpMonthlyCredit = amounts[0];
        if (pct !== null) found.gdpMonthlyRemainingPercent = pct;
        matchedAny = true;
      }
    }

    return matchedAny ? found : null;
  };

  let settled = false;
  let settleTimer = null;

  const check = () => {
    if (settled) return;
    const h = (location.hostname || "").toLowerCase();
    if (h === "accounts.google.com" || h.endsWith(".accounts.google.com")) {
      send({ status: "login_required" });
      return;
    }
    const result = scan();
    if (result && !settleTimer) {
      settleTimer = window.setTimeout(() => {
        if (settled) return;
        const finalResult = scan() || result;
        settled = true;
        send({ status: "ok", ...finalResult });
      }, 350);
    }
  };

  const interval = window.setInterval(check, 300);
  window.addEventListener("DOMContentLoaded", () => {
    check();
    try {
      const obs = new MutationObserver(check);
      obs.observe(document.documentElement, { childList: true, subtree: true });
    } catch (_) {}
  });
  window.addEventListener("load", check);
  window.setTimeout(() => window.clearInterval(interval), 180000);
})();
"#;

static CACHE: LazyLock<Mutex<Option<AgyVertexCreditsSnapshot>>> =
    LazyLock::new(|| Mutex::new(None));
static SYNC_LOCK: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn cache_path() -> PathBuf {
    crate::paths::app_home().join(CACHE_FILE)
}

fn valid_currency(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty()
        && trimmed.len() <= 32
        && trimmed.bytes().any(|b| b.is_ascii_digit())
}

fn sanitize_snapshot(mut s: AgyVertexCreditsSnapshot) -> AgyVertexCreditsSnapshot {
    let def = AgyVertexCreditsSnapshot::default();
    if !valid_currency(&s.free_trial_credit) {
        s.free_trial_credit = def.free_trial_credit;
    }
    if !valid_currency(&s.free_trial_original_credit) {
        s.free_trial_original_credit = def.free_trial_original_credit;
    }
    if s.free_trial_remaining_percent > 100 {
        s.free_trial_remaining_percent = def.free_trial_remaining_percent;
    }
    if !valid_currency(&s.gdp_monthly_credit) {
        s.gdp_monthly_credit = def.gdp_monthly_credit;
    }
    if s.gdp_monthly_remaining_percent > 100 {
        s.gdp_monthly_remaining_percent = def.gdp_monthly_remaining_percent;
    }
    s
}

pub fn load_from_path(path: &Path) -> AgyVertexCreditsSnapshot {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<AgyVertexCreditsSnapshot>(&raw).ok())
        .map(sanitize_snapshot)
        .unwrap_or_default()
}

pub fn save_to_path(path: &Path, snapshot: &AgyVertexCreditsSnapshot) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(snapshot).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

pub fn parse_title_signal(title: &str) -> Option<ScrapeSignal> {
    let raw = title.strip_prefix(TITLE_PREFIX)?;
    let payload: ScrapedCreditsPayload = serde_json::from_str(raw).ok()?;
    match payload.status.as_str() {
        "login_required" => Some(ScrapeSignal::LoginRequired),
        "ok" => Some(ScrapeSignal::Scraped(payload)),
        _ => None,
    }
}

pub fn merge_scraped_payload(
    base: &AgyVertexCreditsSnapshot,
    payload: &ScrapedCreditsPayload,
    now: u64,
) -> Option<AgyVertexCreditsSnapshot> {
    let mut next = base.clone();
    let mut updated = false;

    if let Some(ref credit) = payload.free_trial_credit {
        if valid_currency(credit) {
            next.free_trial_credit = credit.trim().to_owned();
            updated = true;
        }
    }
    if let Some(ref orig) = payload.free_trial_original_credit {
        if valid_currency(orig) {
            next.free_trial_original_credit = orig.trim().to_owned();
            updated = true;
        }
    }
    if let Some(pct) = payload.free_trial_remaining_percent {
        if pct <= 100 {
            next.free_trial_remaining_percent = pct;
            updated = true;
        }
    }
    if let Some(ref gdp) = payload.gdp_monthly_credit {
        if valid_currency(gdp) {
            next.gdp_monthly_credit = gdp.trim().to_owned();
            updated = true;
        }
    }
    if let Some(pct) = payload.gdp_monthly_remaining_percent {
        if pct <= 100 {
            next.gdp_monthly_remaining_percent = pct;
            updated = true;
        }
    }

    if !updated {
        return None;
    }
    next.collected_at = Some(now);
    next.error_code = None;
    Some(sanitize_snapshot(next))
}

fn read_cached() -> AgyVertexCreditsSnapshot {
    let mut guard = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(ref cached) = *guard {
        return cached.clone();
    }
    let loaded = load_from_path(&cache_path());
    *guard = Some(loaded.clone());
    loaded
}

fn store_cached(app: &AppHandle, snapshot: &AgyVertexCreditsSnapshot) {
    *CACHE.lock().unwrap_or_else(|p| p.into_inner()) = Some(snapshot.clone());
    let _ = save_to_path(&cache_path(), snapshot);
    if let Some(state) = app.try_state::<crate::AppState>() {
        if let Ok(json) = serde_json::to_string(snapshot) {
            state.emitters.emit_json("agy-vertex-credits://changed", &json);
        }
    }
}

fn is_google_login_url(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    host == "accounts.google.com"
        || host.ends_with(".accounts.google.com")
        || url.path().starts_with("/signin")
        || url.path().starts_with("/ServiceLogin")
}

fn webview_data_dir() -> PathBuf {
    crate::development_profile::webview_dir()
        .unwrap_or_else(|| crate::paths::app_home().join("agy-vertex-webview"))
}

fn cookies_file_has_google_auth(cookies_path: &Path) -> bool {
    let Ok(bytes) = std::fs::read(cookies_path) else {
        return false;
    };
    let has_subslice = |needle: &[u8]| {
        bytes
            .windows(needle.len())
            .any(|window| window == needle)
    };
    has_subslice(b"accounts.google.com") && has_subslice(b"console.cloud.google.com")
}

#[cfg(windows)]
fn windows_unvirtualized_loopback_path(path: &Path) -> Option<PathBuf> {
    let raw = path.to_str()?;
    let bytes = raw.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        let rest = &raw[3..];
        Some(PathBuf::from(format!(r"\\127.0.0.1\{drive}$\{rest}")))
    } else {
        None
    }
}

pub fn seed_webview_profile_from_candidates(
    target_data_dir: &Path,
    candidate_eb_dirs: &[PathBuf],
) -> bool {
    let target_eb = target_data_dir.join("EBWebView");
    let target_cookies = target_eb.join("Default").join("Network").join("Cookies");
    if cookies_file_has_google_auth(&target_cookies) {
        return false;
    }

    let best_source = candidate_eb_dirs
        .iter()
        .filter(|eb_dir| {
            eb_dir.join("Local State").is_file()
                && cookies_file_has_google_auth(
                    &eb_dir.join("Default").join("Network").join("Cookies"),
                )
        })
        .max_by_key(|eb_dir| {
            eb_dir
                .join("Default")
                .join("Network")
                .join("Cookies")
                .metadata()
                .map(|m| m.len())
                .unwrap_or(0)
        });

    let Some(source_eb) = best_source else {
        return false;
    };

    let target_default = target_eb.join("Default");
    let target_network = target_default.join("Network");
    if std::fs::create_dir_all(&target_network).is_err() {
        return false;
    }

    if std::fs::copy(source_eb.join("Local State"), target_eb.join("Local State")).is_err() {
        return false;
    }
    for pref in ["Preferences", "Secure Preferences"] {
        let src = source_eb.join("Default").join(pref);
        if src.is_file() {
            let _ = std::fs::copy(&src, target_default.join(pref));
        }
    }
    for net_file in [
        "Cookies",
        "Device Bound Sessions",
        "TransportSecurity",
        "Network Persistent State",
        "NetworkDataMigrated",
    ] {
        let src = source_eb.join("Default").join("Network").join(net_file);
        if src.is_file() {
            let _ = std::fs::copy(&src, target_network.join(net_file));
        }
    }
    true
}

fn ensure_webview_profile_seeded(app: &AppHandle, target_data_dir: &Path) {
    if crate::development_profile::webview_dir().is_some() {
        return;
    }
    let Ok(local_data_dir) = app.path().app_local_data_dir() else {
        return;
    };
    let mut candidates = Vec::new();
    #[cfg(windows)]
    if let Some(loopback) = windows_unvirtualized_loopback_path(&local_data_dir.join("EBWebView")) {
        candidates.push(loopback);
    }
    candidates.push(local_data_dir.join("EBWebView"));
    #[cfg(windows)]
    if let Some(local_appdata) = local_data_dir.parent() {
        let packages_dir = local_appdata.join("Packages");
        let app_folder_name = local_data_dir
            .file_name()
            .unwrap_or_default()
            .to_os_string();
        if let Ok(entries) = std::fs::read_dir(packages_dir) {
            for entry in entries.flatten() {
                let candidate = entry
                    .path()
                    .join("LocalCache")
                    .join("Local")
                    .join(&app_folder_name)
                    .join("EBWebView");
                if candidate.is_dir() {
                    candidates.push(candidate);
                }
            }
        }
    }
    let _ = seed_webview_profile_from_candidates(target_data_dir, &candidates);
}

async fn sync_via_webview(app: &AppHandle) -> AgyVertexCreditsSnapshot {
    if let Some(existing) = app.get_webview_window(WINDOW_LABEL) {
        let _ = existing.close();
        tokio::time::sleep(Duration::from_millis(150)).await;
    }

    let parsed_url = match Url::parse(BILLING_CREDITS_URL) {
        Ok(u) => u,
        Err(_) => {
            let mut s = read_cached();
            s.error_code = Some("invalid_url".to_owned());
            return s;
        }
    };

    let data_dir = webview_data_dir();
    ensure_webview_profile_seeded(app, &data_dir);

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ScrapeSignal>();
    let tx_title = tx.clone();
    let tx_nav = tx.clone();

    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        WINDOW_LABEL,
        WebviewUrl::External(parsed_url),
    )
    .title("Google Cloud 赠金同步")
    .inner_size(1040.0, 720.0)
    .center()
    .visible(false)
    .initialization_script(SCRAPE_SCRIPT)
    .on_navigation(move |url| {
        if is_google_login_url(url) {
            let _ = tx_nav.send(ScrapeSignal::LoginRequired);
        }
        true
    })
    .on_document_title_changed(move |_webview, title| {
        if let Some(signal) = parse_title_signal(&title) {
            let _ = tx_title.send(signal);
        }
    });

    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.data_directory(data_dir);
    }
    #[cfg(target_os = "macos")]
    {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(data_dir.to_string_lossy().as_bytes());
        builder = builder.data_store_identifier(digest[..16].try_into().unwrap());
    }

    let window = match builder.build() {
        Ok(w) => w,
        Err(_) => {
            let mut s = read_cached();
            s.error_code = Some("webview_create_failed".to_owned());
            return s;
        }
    };

    let destroyed = Arc::new(AtomicBool::new(false));
    let destroyed_flag = Arc::clone(&destroyed);
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            destroyed_flag.store(true, Ordering::SeqCst);
        }
    });

    let base = read_cached();
    let mut shown_for_login = false;
    let start = tokio::time::Instant::now();
    let silent_reveal_deadline = start + Duration::from_secs(6);
    let mut final_deadline = start + Duration::from_secs(25);

    let outcome = loop {
        if destroyed.load(Ordering::SeqCst) {
            let mut s = base.clone();
            s.error_code = Some("sync_cancelled".to_owned());
            break s;
        }
        let now = tokio::time::Instant::now();
        if now >= final_deadline {
            let mut s = base.clone();
            s.error_code = Some(if shown_for_login {
                "login_timeout".to_owned()
            } else {
                "scrape_timeout".to_owned()
            });
            break s;
        }

        if !shown_for_login && now >= silent_reveal_deadline {
            // If hidden WebView2 throttling or an account chooser prevents silent
            // table rendering within 6s, reveal the window so rendering/login can finish.
            shown_for_login = true;
            final_deadline = tokio::time::Instant::now() + Duration::from_secs(120);
            let _ = window.show();
            let _ = window.set_focus();
        }

        match tokio::time::timeout(Duration::from_millis(250), rx.recv()).await {
            Ok(Some(ScrapeSignal::LoginRequired)) => {
                if !shown_for_login {
                    shown_for_login = true;
                    final_deadline = tokio::time::Instant::now() + Duration::from_secs(180);
                    let _ = window.set_title("Google Cloud 赠金同步（请登录 Google 账号）");
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            Ok(Some(ScrapeSignal::Scraped(payload))) => {
                if let Some(merged) = merge_scraped_payload(&base, &payload, now_seconds()) {
                    store_cached(app, &merged);
                    break merged;
                }
            }
            Ok(None) => {
                let mut s = base.clone();
                s.error_code = Some("channel_closed".to_owned());
                break s;
            }
            Err(_) => {}
        }
    };

    if shown_for_login {
        // Give Chromium NetworkService a moment to commit freshly issued auth cookies
        // before tearing down the dedicated WebContext.
        tokio::time::sleep(Duration::from_millis(350)).await;
    }
    let _ = window.close();
    tokio::time::sleep(Duration::from_millis(200)).await;
    outcome
}

#[tauri::command]
pub async fn agy_vertex_credits_read(
    app: AppHandle,
    force: Option<bool>,
) -> Result<AgyVertexCreditsSnapshot, String> {
    if !force.unwrap_or(false) {
        return Ok(read_cached());
    }
    let _guard = SYNC_LOCK.lock().await;
    Ok(sync_via_webview(&app).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_title_signals_and_merges_scraped_free_trial_row() {
        let login = parse_title_signal(
            r#"__CCGUI_VERTEX_CREDITS__:{"status":"login_required"}"#,
        );
        assert_eq!(login, Some(ScrapeSignal::LoginRequired));

        let scraped = parse_title_signal(
            r#"__CCGUI_VERTEX_CREDITS__:{"status":"ok","freeTrialCredit":"$348.01","freeTrialOriginalCredit":"$383.45","freeTrialRemainingPercent":91}"#,
        );
        let Some(ScrapeSignal::Scraped(payload)) = scraped else {
            panic!("expected scraped signal");
        };

        let base = AgyVertexCreditsSnapshot::default();
        let merged = merge_scraped_payload(&base, &payload, 1_900_000_123).expect("merged");
        assert_eq!(merged.free_trial_credit, "$348.01");
        assert_eq!(merged.free_trial_original_credit, "$383.45");
        assert_eq!(merged.free_trial_remaining_percent, 91);
        assert_eq!(merged.gdp_monthly_credit, "$51.13");
        assert_eq!(merged.gdp_monthly_remaining_percent, 100);
        assert_eq!(merged.collected_at, Some(1_900_000_123));
        assert_eq!(merged.error_code, None);
    }

    #[test]
    fn persists_and_reloads_snapshot_round_trip() {
        let path = std::env::temp_dir().join(format!(
            "ccgui-vertex-credits-{}.json",
            uuid::Uuid::new_v4()
        ));
        let custom = AgyVertexCreditsSnapshot {
            free_trial_credit: "$312.50".to_owned(),
            free_trial_original_credit: "$383.45".to_owned(),
            free_trial_remaining_percent: 81,
            gdp_monthly_credit: "$40.00".to_owned(),
            gdp_monthly_remaining_percent: 78,
            collected_at: Some(1_900_000_500),
            error_code: None,
        };
        save_to_path(&path, &custom).unwrap();
        let loaded = load_from_path(&path);
        let _ = std::fs::remove_file(&path);
        assert_eq!(loaded, custom);
    }

    #[test]
    fn seeds_webview_profile_from_authenticated_candidate_and_preserves_existing() {
        let root = std::env::temp_dir().join(format!(
            "ccgui-vertex-webview-seed-{}",
            uuid::Uuid::new_v4()
        ));
        let empty_eb = root.join("virtualized").join("EBWebView");
        std::fs::create_dir_all(empty_eb.join("Default").join("Network")).unwrap();
        std::fs::write(empty_eb.join("Local State"), b"{\"os_crypt\":{\"encrypted_key\":\"empty\"}}").unwrap();
        std::fs::write(
            empty_eb.join("Default").join("Network").join("Cookies"),
            b"sqlite-header-without-google",
        )
        .unwrap();

        let authed_eb = root.join("real").join("EBWebView");
        std::fs::create_dir_all(authed_eb.join("Default").join("Network")).unwrap();
        std::fs::write(
            authed_eb.join("Local State"),
            b"{\"os_crypt\":{\"encrypted_key\":\"real-key\"}}",
        )
        .unwrap();
        std::fs::write(
            authed_eb.join("Default").join("Network").join("Cookies"),
            b"sqlite-cookies-accounts.google.com-and-console.cloud.google.com-session",
        )
        .unwrap();
        std::fs::write(
            authed_eb
                .join("Default")
                .join("Network")
                .join("Device Bound Sessions"),
            b"dbsc-google-session",
        )
        .unwrap();

        let target_dir = root.join("target-webview");
        let candidates = vec![empty_eb, authed_eb];
        assert!(seed_webview_profile_from_candidates(&target_dir, &candidates));

        let seeded_key =
            std::fs::read_to_string(target_dir.join("EBWebView").join("Local State")).unwrap();
        assert!(seeded_key.contains("real-key"));
        assert!(cookies_file_has_google_auth(
            &target_dir
                .join("EBWebView")
                .join("Default")
                .join("Network")
                .join("Cookies")
        ));
        assert_eq!(
            std::fs::read(
                target_dir
                    .join("EBWebView")
                    .join("Default")
                    .join("Network")
                    .join("Device Bound Sessions")
            )
            .unwrap(),
            b"dbsc-google-session"
        );

        // Second run is a no-op once target already has Google auth cookies.
        assert!(!seed_webview_profile_from_candidates(&target_dir, &candidates));
        let _ = std::fs::remove_dir_all(&root);
    }
}
