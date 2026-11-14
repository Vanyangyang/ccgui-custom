//! Google Cloud Billing connection. No bundled account or balance.
//! The first connection is user-initiated in a visible dedicated WebView where the
//! user signs in and chooses their account. Later refreshes reuse that WebView's
//! persistent Google session off-screen and only surface the window when Google
//! needs the user (sign-in, organization choice); stale balances refresh silently.
//! Only credit rows from that account's official Credits page are saved locally.
//! This login does not grant Vertex API access; API calls use the user's local key.

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

pub const BILLING_ACCOUNTS_URL: &str = "https://console.cloud.google.com/billing";
/// "My projects" lists each project next to its billing account ID, so the
/// project from the user's key file leads to the right account without a choice.
pub const BILLING_PROJECTS_URL: &str = "https://console.cloud.google.com/billing/projects";
const WINDOW_LABEL: &str = "agy-vertex-credits-sync";
const TITLE_PREFIX: &str = "__CCGUI_VERTEX_CREDITS__:";
// Do not read legacy, accountless snapshots or import another WebView's cookies.
const CACHE_FILE: &str = "agy-vertex-credits-v2.json";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgyVertexCreditsSnapshot {
    pub billing_account_id: Option<String>,
    pub free_trial_credit: Option<String>,
    pub free_trial_original_credit: Option<String>,
    pub free_trial_remaining_percent: Option<u8>,
    pub gdp_monthly_credit: Option<String>,
    pub gdp_monthly_remaining_percent: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collected_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    /// Why the last silent refresh could not update an otherwise valid balance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_error: Option<String>,
}

impl Default for AgyVertexCreditsSnapshot {
    fn default() -> Self {
        Self {
            billing_account_id: None,
            free_trial_credit: None,
            free_trial_original_credit: None,
            free_trial_remaining_percent: None,
            gdp_monthly_credit: None,
            gdp_monthly_remaining_percent: None,
            collected_at: None,
            error_code: Some("not_connected".into()),
            refresh_error: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgyVertexConfigSnapshot {
    pub configured: bool,
    pub project_id: Option<String>,
    pub location: String,
    pub model: String,
    pub key_file_hint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[tauri::command]
pub fn agy_vertex_config_read() -> AgyVertexConfigSnapshot {
    let metadata = crate::engine::agy_vertex::target_metadata();
    let configured = metadata.is_some();
    let (project, location, model) = metadata.map(|(p, l, m)| (Some(p), l, m)).unwrap_or((
        None,
        "global".into(),
        "gemini-4-argon".into(),
    ));
    AgyVertexConfigSnapshot {
        configured,
        project_id: project,
        location,
        model,
        key_file_hint: ".gemini/vertex-gemini-4-argon.txt".into(),
        error_code: (!configured).then(|| "vertex_config_missing_or_invalid".into()),
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScrapedCreditsPayload {
    pub status: String,
    pub billing_account_id: Option<String>,
    pub free_trial_credit: Option<String>,
    pub free_trial_original_credit: Option<String>,
    pub free_trial_remaining_percent: Option<u8>,
    pub gdp_monthly_credit: Option<String>,
    pub gdp_monthly_remaining_percent: Option<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ScrapeSignal {
    LoginRequired,
    PermissionDenied,
    NoCredits,
    /// Navigated to a non-sign-in page; clears a pending sign-in.
    LoginCleared,
    Scraped(ScrapedCreditsPayload),
}

const SCRAPE_SCRIPT: &str = r#"
(() => {
  if (window !== window.top || location.protocol !== "https:") return;
  const send = (payload) => { document.title = "__CCGUI_VERTEX_CREDITS__:" + JSON.stringify(payload); };
  // Project id from the user's own key file, or null; substituted by the host.
  const wantedProject = __CCGUI_VERTEX_PROJECT__;
  const zh = /^zh/i.test(String((typeof navigator !== "undefined" && navigator.language) || ""));
  const msg = {
    login: zh
      ? "CCGUI：请登录开通 Vertex 的 Google 账号，登录后会自动查找结算账号。"
      : "CCGUI: Sign in with the Google account that owns your Vertex project; the billing account is found automatically afterwards.",
    find: (project) => zh
      ? "CCGUI：正在「您的项目」中查找 " + project + "，找到后自动打开它的结算账号；也可点击该行的「结算账号」链接。列表里没有？在上方「选择一个组织」切换到项目所在组织（个人账号选「无组织」）。不要点「创建账号」。"
      : "CCGUI: Looking for " + project + " under 'My projects'; its billing account opens automatically, or click the billing account link in that row. Not listed? Switch 'Select an organization' above to the project's organization (personal accounts: 'No organization'). Do not click 'Create account'.",
    findAny: zh
      ? "CCGUI：在「您的项目」中找到你调用 Vertex 的项目，点击该行的「结算账号」链接。列表为空就在上方「选择一个组织」切换（个人账号选「无组织」）。不要点「创建账号」。"
      : "CCGUI: Under 'My projects', find the project you use for Vertex and click the billing account link in its row. Empty list? Switch 'Select an organization' above (personal accounts: 'No organization'). Do not click 'Create account'.",
    unlinked: (project) => zh
      ? "CCGUI：项目 " + project + " 还没有关联结算账号，请先在该行「操作」中关联结算账号。"
      : "CCGUI: Project " + project + " has no billing account yet; link one from the Actions menu in its row first.",
    setup: zh
      ? "CCGUI：这是 Google 新建结算账号或补全资料的页面。已有结算账号请返回「结算账号管理 → 您的项目」；确实需要新建，请先在此完成设置。"
      : "CCGUI: This is Google's create or complete-billing-profile page. If you already have a billing account, go back to 'Manage billing accounts → My projects'; if you need a new one, finish the setup here first.",
    reading: zh
      ? "CCGUI：正在读取该结算账号的赠金，完成后窗口会自动关闭。"
      : "CCGUI: Reading this billing account's credits; the window closes when done.",
  };
  // Pointer-transparent status line; Google's page stays fully usable.
  const hint = (message) => {
    if (typeof document.createElement !== "function" || !document.body) return;
    let box = document.getElementById("ccgui-vertex-hint");
    if (!box) {
      box = document.createElement("div");
      box.id = "ccgui-vertex-hint";
      box.setAttribute("role", "status");
      box.style.cssText = "position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483647;max-width:760px;margin:0 auto;padding:10px 14px;border-radius:10px;background:#1f2937;color:#fff;font:13px/1.5 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25);pointer-events:none";
      document.body.appendChild(box);
    }
    if (box.textContent !== message) box.textContent = message;
  };
  if (location.hostname === "accounts.google.com") {
    send({ status: "login_required" });
    const showLogin = () => hint(msg.login);
    showLogin();
    window.addEventListener("DOMContentLoaded", showLogin);
    return;
  }
  if (location.hostname !== "console.cloud.google.com") return;
  const accountFromPath = () => {
    const match = location.pathname.match(/^\/billing\/([A-Fa-f0-9]{6}-[A-Fa-f0-9]{6}-[A-Fa-f0-9]{6})(?:\/|$)/);
    return match ? match[1] : null;
  };
  const isCreditsPage = () => /^\/billing\/[^/]+\/credits(?:\/|$)/.test(location.pathname);
  // Only an account's landing page is steered to Credits. Setup, payment and
  // creation flows belong to the user; Google redirects them back otherwise.
  const isLandingPage = () => /^\/billing\/[^/]+(?:\/overview)?\/?$/.test(location.pathname);
  const isSetupPage = () => /^\/billing\/(?:create(?:\/|$)|[^/]+\/setupbillingprofile)/.test(location.pathname);
  const ACCOUNT_RE = /\b([A-Fa-f0-9]{6}-[A-Fa-f0-9]{6}-[A-Fa-f0-9]{6})\b/;
  const CURRENCY_RE = /(?:(?:US|SG|CA|AU|HK|NT|NZ|S)?\$|(?:SGD|USD|EUR|GBP|JPY|CNY)\s*)\s*\d[\d,]*(?:\.\d{1,2})?/gi;
  const PCT_RE = /(\d{1,3}(?:\.\d+)?)\s*%/;
  const parseNumber = (raw) => {
    const value = parseFloat(String(raw).replace(/[^0-9.]/g, ""));
    return Number.isFinite(value) ? value : null;
  };
  const collectRows = (root, out = []) => {
    if (!root || !root.querySelectorAll) return out;
    for (const row of root.querySelectorAll("tbody tr, [role='row'], cfc-table-row, mat-row")) out.push(row);
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) collectRows(element.shadowRoot, out);
    }
    return out;
  };
  const scan = () => {
    const found = {};
    for (const row of collectRows(document)) {
      if (row.querySelector && row.querySelector("th, [role='columnheader']")) continue;
      const text = String(row.innerText || row.textContent || "").replace(/\s+/g, " ").trim();
      const amounts = text.match(CURRENCY_RE);
      if (!amounts) continue;
      const pctMatch = text.match(PCT_RE);
      let pct = pctMatch ? Math.round(parseFloat(pctMatch[1])) : null;
      if (pct === null && amounts.length >= 2) {
        const remaining = parseNumber(amounts[0]);
        const original = parseNumber(amounts[1]);
        if (remaining !== null && original > 0) pct = Math.round(remaining / original * 100);
      }
      if (pct !== null) pct = Math.max(0, Math.min(100, pct));
      const freeTrial = /free\s*trial|freetrial|免费试用|试用赠金/i.test(text);
      const monthly = !freeTrial && /\bgdp\b|developer\s*program|开发者|月度|genai|google\s*developer/i.test(text);
      if (freeTrial && !found.freeTrialCredit) {
        found.freeTrialCredit = amounts[0].trim();
        if (amounts[1]) found.freeTrialOriginalCredit = amounts[1].trim();
        if (pct !== null) found.freeTrialRemainingPercent = pct;
      } else if (monthly && !found.gdpMonthlyCredit) {
        found.gdpMonthlyCredit = amounts[0].trim();
        if (pct !== null) found.gdpMonthlyRemainingPercent = pct;
      }
    }
    return Object.keys(found).length ? found : null;
  };
  // "My projects" lists each project with its billing account ID in the same row.
  const linkedAccount = (project) => {
    const token = new RegExp("(?:^|[^A-Za-z0-9._-])" + project.replace(/[.]/g, "\\.") + "(?:$|[^A-Za-z0-9._-])");
    for (const row of collectRows(document)) {
      const text = String(row.innerText || row.textContent || "").replace(/\s+/g, " ").trim();
      if (!token.test(text)) continue;
      const match = text.match(ACCOUNT_RE);
      return { found: true, account: match ? match[1] : null };
    }
    return { found: false, account: null };
  };
  // Redirect once per account per window: if Google sends the user back (for
  // example an account that still needs setup), do not fight its redirect.
  const openCredits = (account) => {
    const key = "__ccgui_vertex_credits_redirect:" + account;
    let redirected = false;
    try {
      redirected = sessionStorage.getItem(key) === "1";
      sessionStorage.setItem(key, "1");
    } catch {}
    if (redirected) return false;
    // Preserve Google's current account and organization; never force authuser=0.
    const current = new URL(location.href);
    const target = new URL("/billing/" + account + "/credits/all", location.origin);
    for (const name of ["authuser", "organizationId"]) {
      const value = current.searchParams.get(name);
      if (value !== null) target.searchParams.set(name, value);
    }
    location.replace(target.href);
    return true;
  };
  let settled = false;
  let settleTimer = null;
  let currentAccount = null;
  let accountChangedAt = 0;
  const check = () => {
    if (settled || location.hostname !== "console.cloud.google.com") return;
    const find = wantedProject ? msg.find(wantedProject) : msg.findAny;
    if (isSetupPage()) {
      hint(msg.setup);
      return;
    }
    const account = accountFromPath();
    if (!account) {
      if (wantedProject && /^\/billing\/projects\/?$/.test(location.pathname)) {
        const linked = linkedAccount(wantedProject);
        if (linked.account && openCredits(linked.account)) return;
        hint(linked.found && !linked.account ? msg.unlinked(wantedProject) : find);
        return;
      }
      hint(find);
      return;
    }
    const text = String(document.body?.innerText || "");
    if (/billing\.accounts\.get[\s\S]{0,80}(?:missing|缺少)|you (?:need additional access|do not have permission)|您需要额外访问权限|你需要额外访问权限|您需要拥有.*更多权限/i.test(text)) {
      settled = true;
      send({ status: "permission_denied", billingAccountId: account });
      return;
    }
    if (!isCreditsPage()) {
      if (isLandingPage() && openCredits(account)) return;
      hint(find);
      return;
    }
    hint(msg.reading);
    if (account !== currentAccount) {
      currentAccount = account;
      accountChangedAt = Date.now();
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = null;
    }
    if (Date.now() - accountChangedAt < 1000 || document.querySelector('[role="progressbar"]')) return;
    const result = scan();
    if (result && !settleTimer) {
      settleTimer = setTimeout(() => {
        settleTimer = null;
        if (settled || currentAccount !== accountFromPath() || !isCreditsPage()) return;
        const latest = scan();
        if (!latest) return;
        settled = true;
        send({ status: "ok", billingAccountId: currentAccount, ...latest });
      }, 700);
    } else if (!result && /no (?:promotional )?credits (?:found|available)|暂无赠金|没有可用赠金/i.test(text)) {
      settled = true;
      send({ status: "no_credits", billingAccountId: account });
    }
  };
  const interval = setInterval(check, 300);
  window.addEventListener("DOMContentLoaded", check);
  window.addEventListener("load", check);
  window.addEventListener("pagehide", () => {
    clearInterval(interval);
    if (settleTimer) clearTimeout(settleTimer);
  });
  setTimeout(() => clearInterval(interval), 300000);
  check();
})();
"#;

static CACHE: LazyLock<Mutex<Option<AgyVertexCreditsSnapshot>>> =
    LazyLock::new(|| Mutex::new(None));
static SYNC_LOCK: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn cache_path() -> PathBuf {
    crate::paths::app_home().join(CACHE_FILE)
}

fn valid_account(value: &str) -> bool {
    value.len() == 20
        && value.bytes().enumerate().all(|(i, b)| {
            if i == 6 || i == 13 {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}

fn account_from_url(url: &Url, require_credits: bool) -> Option<&str> {
    if url.scheme() != "https" || url.host_str() != Some("console.cloud.google.com") {
        return None;
    }
    let mut segments = url.path_segments()?;
    if segments.next()? != "billing" {
        return None;
    }
    let account = segments.next()?;
    if !valid_account(account) || (require_credits && segments.next() != Some("credits")) {
        return None;
    }
    Some(account)
}

fn valid_currency(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 32
        && value.bytes().any(|b| b.is_ascii_digit())
        && !value.contains(['<', '>', '\n', '\r'])
}

fn sanitize_snapshot(mut value: AgyVertexCreditsSnapshot) -> AgyVertexCreditsSnapshot {
    if !value
        .billing_account_id
        .as_deref()
        .is_some_and(valid_account)
        || value.collected_at.is_none()
        || value.error_code.is_some()
    {
        return AgyVertexCreditsSnapshot::default();
    }
    for amount in [
        &mut value.free_trial_credit,
        &mut value.free_trial_original_credit,
        &mut value.gdp_monthly_credit,
    ] {
        *amount = amount
            .take()
            .filter(|s| valid_currency(s))
            .map(|s| s.trim().to_owned());
    }
    value.free_trial_remaining_percent = value.free_trial_remaining_percent.filter(|n| *n <= 100);
    value.gdp_monthly_remaining_percent = value.gdp_monthly_remaining_percent.filter(|n| *n <= 100);
    value.refresh_error = value
        .refresh_error
        .filter(|code| matches!(code.as_str(), "login_required" | "scrape_timeout"));
    value
}

pub fn load_from_path(path: &Path) -> AgyVertexCreditsSnapshot {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .map(sanitize_snapshot)
        .unwrap_or_default()
}

pub fn save_to_path(path: &Path, value: &AgyVertexCreditsSnapshot) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    crate::settings::atomic_write(
        path,
        &serde_json::to_string_pretty(value).map_err(|e| e.to_string())?,
    )
}

fn parse_title_signal(url: &Url, title: &str) -> Option<ScrapeSignal> {
    if title.len() > 4096 {
        return None;
    }
    let payload: ScrapedCreditsPayload =
        serde_json::from_str(title.strip_prefix(TITLE_PREFIX)?).ok()?;
    if payload.status == "login_required" {
        return is_google_login_url(url).then_some(ScrapeSignal::LoginRequired);
    }
    let account = account_from_url(
        url,
        payload.status == "ok" || payload.status == "no_credits",
    )?;
    if payload.billing_account_id.as_deref()? != account {
        return None;
    }
    match payload.status.as_str() {
        "ok" => Some(ScrapeSignal::Scraped(payload)),
        "permission_denied" => Some(ScrapeSignal::PermissionDenied),
        "no_credits" => Some(ScrapeSignal::NoCredits),
        _ => None,
    }
}

fn snapshot_from_payload(
    payload: &ScrapedCreditsPayload,
    now: u64,
) -> Option<AgyVertexCreditsSnapshot> {
    let account = payload
        .billing_account_id
        .as_deref()
        .filter(|id| valid_account(id))?;
    // Start empty: missing rows must never inherit another account's balance.
    let value = sanitize_snapshot(AgyVertexCreditsSnapshot {
        billing_account_id: Some(account.into()),
        free_trial_credit: payload.free_trial_credit.clone(),
        free_trial_original_credit: payload.free_trial_original_credit.clone(),
        free_trial_remaining_percent: payload.free_trial_remaining_percent,
        gdp_monthly_credit: payload.gdp_monthly_credit.clone(),
        gdp_monthly_remaining_percent: payload.gdp_monthly_remaining_percent,
        collected_at: Some(now),
        error_code: None,
        refresh_error: None,
    });
    (value.free_trial_credit.is_some() || value.gdp_monthly_credit.is_some()).then_some(value)
}

fn read_cached() -> AgyVertexCreditsSnapshot {
    let mut cache = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    cache
        .get_or_insert_with(|| load_from_path(&cache_path()))
        .clone()
}

fn store_cached(app: &AppHandle, snapshot: &AgyVertexCreditsSnapshot) -> Result<(), String> {
    let persisted =
        save_to_path(&cache_path(), snapshot).map_err(|_| "vertex_cache_write_failed".to_owned());
    let snapshot = if persisted.is_ok() {
        snapshot.clone()
    } else {
        failed("vertex_cache_write_failed")
    };
    *CACHE.lock().unwrap_or_else(|p| p.into_inner()) = Some(snapshot.clone());
    if let Some(state) = app.try_state::<crate::AppState>() {
        if let Ok(json) = serde_json::to_string(&snapshot) {
            state
                .emitters
                .emit_json("agy-vertex-credits://changed", &json);
        }
    }
    persisted
}

fn is_google_login_url(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str() == Some("accounts.google.com")
}

fn webview_data_dir() -> PathBuf {
    crate::development_profile::webview_dir()
        .map(|directory| directory.join("vertex-billing-v2"))
        .unwrap_or_else(|| crate::paths::app_home().join("agy-vertex-webview-v2"))
}

/// Key-file project ids are already limited to `[A-Za-z0-9._-]`; JSON encoding
/// keeps the substitution a plain string literal regardless.
fn scrape_script(project: Option<&str>) -> String {
    let literal = serde_json::to_string(&project).unwrap_or_else(|_| "null".into());
    SCRAPE_SCRIPT.replace("__CCGUI_VERTEX_PROJECT__", &literal)
}

fn failed(code: &str) -> AgyVertexCreditsSnapshot {
    AgyVertexCreditsSnapshot {
        error_code: Some(code.into()),
        ..Default::default()
    }
}

/// A credits page of a known account; opened first so a valid Google session
/// needs no clicks at all.
fn start_credits_url(account: &str) -> String {
    format!("https://console.cloud.google.com/billing/{account}/credits/all")
}

const FULL_DEADLINE: Duration = Duration::from_secs(300);
/// Balances older than this refresh silently; the backoff bounds retries.
const AUTO_MAX_AGE: u64 = 6 * 3600;
const AUTO_BACKOFF: Duration = Duration::from_secs(3600);
/// Passing through accounts.google.com is normal Google session plumbing; only a
/// sign-in page that stays up means the user must act.
const LOGIN_GRACE: Duration = Duration::from_secs(8);
/// Physical coordinate of a silent attempt's window, outside any monitor.
const OFFSCREEN: i32 = -32000;

static LAST_AUTO: LazyLock<Mutex<Option<std::time::Instant>>> =
    LazyLock::new(|| Mutex::new(None));
static AUTO_ACTIVE: AtomicBool = AtomicBool::new(false);

/// How one WebView attempt runs. The window starts off-screen when it targets a
/// known account and is brought forward only if Google needs the user.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Plan {
    account: Option<String>,
    hidden: bool,
    /// Auto refreshes never interrupt the user: they give up instead of revealing.
    can_reveal: bool,
    reveal_after: Duration,
    deadline: Duration,
}

impl Plan {
    fn auto(account: String) -> Self {
        Self {
            account: Some(account),
            hidden: true,
            can_reveal: false,
            reveal_after: Duration::MAX,
            deadline: Duration::from_secs(45),
        }
    }
    fn manual_targeted(account: String) -> Self {
        Self {
            account: Some(account),
            hidden: true,
            can_reveal: true,
            reveal_after: Duration::from_secs(20),
            deadline: Duration::from_secs(40),
        }
    }
    fn manual_projects() -> Self {
        Self {
            account: None,
            hidden: false,
            can_reveal: true,
            reveal_after: Duration::ZERO,
            deadline: FULL_DEADLINE,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Step {
    Wait,
    Reveal,
    LoginRequired,
    Timeout,
}

/// `login_pending` is how long a Google sign-in page has been showing.
fn next_step(
    plan: &Plan,
    elapsed: Duration,
    login_pending: Option<Duration>,
    login_seen: bool,
    revealed: bool,
) -> Step {
    let login_stuck = login_pending.is_some_and(|waited| waited >= LOGIN_GRACE);
    if login_stuck && !plan.can_reveal {
        return Step::LoginRequired;
    }
    // A sign-in the user is working through gets the full window.
    let limit = if login_seen && plan.can_reveal {
        FULL_DEADLINE
    } else {
        plan.deadline
    };
    if elapsed >= limit {
        return Step::Timeout;
    }
    if plan.hidden && !revealed && plan.can_reveal && (login_stuck || elapsed >= plan.reveal_after)
    {
        return Step::Reveal;
    }
    Step::Wait
}

fn reveal(app: &AppHandle, window: &tauri::WebviewWindow) {
    let _ = window.set_skip_taskbar(false);
    let target = app.primary_monitor().ok().flatten().and_then(|monitor| {
        let size = window.outer_size().ok()?;
        let origin = monitor.position();
        let free = monitor.size();
        Some(tauri::PhysicalPosition::new(
            origin.x + (free.width as i32 - size.width as i32).max(0) / 2,
            origin.y + (free.height as i32 - size.height as i32).max(0) / 2,
        ))
    });
    let _ = window.set_position(target.unwrap_or(tauri::PhysicalPosition::new(100, 100)));
    let _ = window.set_focus();
}

async fn sync_via_webview(app: &AppHandle, plan: &Plan) -> AgyVertexCreditsSnapshot {
    if let Some(existing) = app.get_webview_window(WINDOW_LABEL) {
        let _ = existing.close();
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<ScrapeSignal>();
    let tx_title = tx.clone();
    let tx_nav = tx.clone();
    let start_url = plan
        .account
        .as_deref()
        .map(start_credits_url)
        .unwrap_or_else(|| BILLING_PROJECTS_URL.to_owned());
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        WINDOW_LABEL,
        WebviewUrl::External(Url::parse(&start_url).expect("static Google URL")),
    )
    .title("Google Cloud Billing — CCGUI credits sync")
    .inner_size(1040.0, 720.0)
    .visible(!plan.hidden)
    .initialization_script(scrape_script(
        crate::engine::agy_vertex::target_metadata()
            .map(|(project, _, _)| project)
            .as_deref(),
    ))
    .on_navigation(move |url| {
        let _ = tx_nav.send(if is_google_login_url(url) {
            ScrapeSignal::LoginRequired
        } else {
            ScrapeSignal::LoginCleared
        });
        url.scheme() == "https"
            && url
                .host_str()
                .is_some_and(|host| host == "google.com" || host.ends_with(".google.com"))
    })
    .on_document_title_changed(move |webview, title| {
        if let Ok(url) = webview.url() {
            if let Some(signal) = parse_title_signal(&url, &title) {
                let _ = tx_title.send(signal);
            }
        }
    });
    // Off-screen rather than hidden: a hidden WebView2 reports the page as not
    // visible and Google's console may stop rendering the credits table. The
    // window is created invisible and moved after creation, because tao replaces
    // a creation position outside every monitor with the default on-screen spot.
    builder = if plan.hidden {
        builder.skip_taskbar(true).focused(false)
    } else {
        builder.center()
    };
    let data_dir = webview_data_dir();
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
        Err(_) => return failed("webview_create_failed"),
    };
    if plan.hidden {
        // Never show a window that is not off-screen: that is the pop-up this avoids.
        if window
            .set_position(tauri::PhysicalPosition::new(OFFSCREEN, OFFSCREEN))
            .is_err()
        {
            let _ = window.close();
            return failed("webview_create_failed");
        }
        // Shown without activation (`focused(false)`), so it takes no focus.
        let _ = window.show();
    } else {
        let _ = window.set_focus();
    }
    let destroyed = Arc::new(AtomicBool::new(false));
    let destroyed_flag = Arc::clone(&destroyed);
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            destroyed_flag.store(true, Ordering::SeqCst);
        }
    });
    let started = tokio::time::Instant::now();
    let mut login_since: Option<tokio::time::Instant> = None;
    let mut login_seen = false;
    let mut revealed = !plan.hidden;
    let result = loop {
        if destroyed.load(Ordering::SeqCst) {
            break failed("sync_cancelled");
        }
        match next_step(
            plan,
            started.elapsed(),
            login_since.map(|since| since.elapsed()),
            login_seen,
            revealed,
        ) {
            Step::Timeout => {
                break failed(if login_seen {
                    "login_timeout"
                } else {
                    "scrape_timeout"
                })
            }
            Step::LoginRequired => break failed("login_required"),
            Step::Reveal => {
                reveal(app, &window);
                revealed = true;
            }
            Step::Wait => {}
        }
        match tokio::time::timeout(Duration::from_millis(250), rx.recv()).await {
            Ok(Some(ScrapeSignal::LoginRequired)) => {
                login_seen = true;
                login_since.get_or_insert_with(tokio::time::Instant::now);
            }
            Ok(Some(ScrapeSignal::LoginCleared)) => login_since = None,
            Ok(Some(ScrapeSignal::PermissionDenied)) => break failed("permission_denied"),
            Ok(Some(ScrapeSignal::NoCredits)) => break failed("no_credits"),
            Ok(Some(ScrapeSignal::Scraped(payload))) => {
                if let Some(snapshot) = snapshot_from_payload(&payload, now_seconds()) {
                    break snapshot;
                }
            }
            Ok(None) => break failed("channel_closed"),
            Err(_) => {}
        }
    };
    let _ = window.close();
    result
}

/// Pure so the schedule is testable: refresh only a connected, healthy balance
/// that is old, and at most once per backoff period.
fn auto_due(
    cached: &AgyVertexCreditsSnapshot,
    now: u64,
    since_last_attempt: Option<Duration>,
) -> bool {
    cached.error_code.is_none()
        && cached
            .billing_account_id
            .as_deref()
            .is_some_and(valid_account)
        && cached
            .collected_at
            .is_some_and(|at| now.saturating_sub(at) >= AUTO_MAX_AGE)
        && since_last_attempt.is_none_or(|elapsed| elapsed >= AUTO_BACKOFF)
}

struct AutoActive;
impl AutoActive {
    fn begin() -> Self {
        AUTO_ACTIVE.store(true, Ordering::SeqCst);
        Self
    }
}
impl Drop for AutoActive {
    fn drop(&mut self) {
        AUTO_ACTIVE.store(false, Ordering::SeqCst);
    }
}

async fn auto_refresh(app: &AppHandle) -> Result<AgyVertexCreditsSnapshot, String> {
    let cached = read_cached();
    let since_last = LAST_AUTO
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .map(|at| at.elapsed());
    if !auto_due(&cached, now_seconds(), since_last) {
        return Ok(cached);
    }
    let Ok(_guard) = SYNC_LOCK.try_lock() else {
        return Ok(cached);
    };
    *LAST_AUTO.lock().unwrap_or_else(|p| p.into_inner()) = Some(std::time::Instant::now());
    let account = cached.billing_account_id.clone().unwrap_or_default();
    let _active = AutoActive::begin();
    let result = sync_via_webview(app, &Plan::auto(account)).await;
    match result.error_code.as_deref() {
        None => {
            store_cached(app, &result)?;
            Ok(result)
        }
        // The user took over with a manual sync; it owns the result.
        Some("sync_cancelled") => Ok(read_cached()),
        // The account itself lost access or credits: show that truth.
        Some("permission_denied" | "no_credits") => {
            store_cached(app, &result)?;
            Ok(result)
        }
        // Anything else leaves the last good balance visible and says why it is old.
        Some(code) => {
            let mut kept = cached;
            kept.refresh_error = Some(if code == "login_required" {
                "login_required".into()
            } else {
                "scrape_timeout".into()
            });
            store_cached(app, &kept)?;
            Ok(kept)
        }
    }
}

async fn manual_sync_lock(
    app: &AppHandle,
) -> Result<tokio::sync::MutexGuard<'static, ()>, String> {
    if let Ok(guard) = SYNC_LOCK.try_lock() {
        return Ok(guard);
    }
    // A silent refresh is the only attempt the user did not start: yield to them.
    if AUTO_ACTIVE.load(Ordering::SeqCst) {
        if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
            let _ = window.close();
        }
        if let Ok(guard) = tokio::time::timeout(Duration::from_secs(5), SYNC_LOCK.lock()).await {
            return Ok(guard);
        }
    }
    // Do not queue a second login window behind an already active connection flow.
    Err("vertex_sync_in_progress".into())
}

#[tauri::command]
pub async fn agy_vertex_credits_read(
    app: AppHandle,
    force: Option<bool>,
    silent: Option<bool>,
) -> Result<AgyVertexCreditsSnapshot, String> {
    if !force.unwrap_or(false) {
        if silent.unwrap_or(false) {
            return auto_refresh(&app).await;
        }
        return Ok(read_cached());
    }
    let _guard = manual_sync_lock(&app).await?;
    // The known account lets a valid Google session refresh without any clicks.
    let known = read_cached()
        .billing_account_id
        .filter(|account| valid_account(account));
    // If invalidation cannot be persisted, do not start an account switch.
    store_cached(&app, &failed("syncing"))?;
    let snapshot = match known {
        Some(account) => {
            let first = sync_via_webview(&app, &Plan::manual_targeted(account)).await;
            // The remembered account may be gone or inaccessible: let the user choose.
            if matches!(
                first.error_code.as_deref(),
                Some("permission_denied" | "scrape_timeout")
            ) {
                sync_via_webview(&app, &Plan::manual_projects()).await
            } else {
                first
            }
        }
        None => sync_via_webview(&app, &Plan::manual_projects()).await,
    };
    store_cached(&app, &snapshot)?;
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    const ACCOUNT: &str = "ABCDEF-123456-789ABC";
    fn credits_url(account: &str) -> Url {
        Url::parse(&format!(
            "https://console.cloud.google.com/billing/{account}/credits/all?authuser=2"
        ))
        .unwrap()
    }
    #[test]
    fn no_default_account_or_amount_and_accountless_cache_is_ignored() {
        let empty = AgyVertexCreditsSnapshot::default();
        assert!(empty.billing_account_id.is_none());
        assert!(empty.free_trial_credit.is_none());
        assert!(empty.gdp_monthly_credit.is_none());
        let legacy: AgyVertexCreditsSnapshot = serde_json::from_str(r#"{"freeTrialCredit":"$100.00","freeTrialOriginalCredit":"$200.00","freeTrialRemainingPercent":50,"gdpMonthlyCredit":"$10.00","gdpMonthlyRemainingPercent":100,"collectedAt":123}"#).unwrap();
        assert_eq!(sanitize_snapshot(legacy), empty);
        assert_eq!(
            BILLING_ACCOUNTS_URL,
            "https://console.cloud.google.com/billing"
        );
        assert!(!SCRAPE_SCRIPT.contains("organizationId="));
        assert_eq!(
            BILLING_PROJECTS_URL,
            "https://console.cloud.google.com/billing/projects"
        );
        assert!(scrape_script(None).contains("const wantedProject = null;"));
        assert!(scrape_script(Some("my-proj.1")).contains(r#"const wantedProject = "my-proj.1";"#));
        assert!(!scrape_script(Some("p")).contains("__CCGUI_VERTEX_PROJECT__"));
    }
    #[test]
    fn payload_is_bound_to_official_https_credits_page_and_exact_selected_account() {
        let title = format!(
            r#"{TITLE_PREFIX}{{"status":"ok","billingAccountId":"{ACCOUNT}","freeTrialCredit":"SG$100.00","freeTrialRemainingPercent":50}}"#
        );
        assert!(matches!(
            parse_title_signal(&credits_url(ACCOUNT), &title),
            Some(ScrapeSignal::Scraped(_))
        ));
        for wrong in [
            format!("http://console.cloud.google.com/billing/{ACCOUNT}/credits/all"),
            format!("https://console.cloud.google.com.evil.example/billing/{ACCOUNT}/credits/all"),
            format!("https://accounts.google.com/billing/{ACCOUNT}/credits/all"),
            format!("https://console.cloud.google.com/billing/{ACCOUNT}/overview"),
            "https://console.cloud.google.com/billing/111111-222222-333333/credits/all".into(),
        ] {
            assert!(
                parse_title_signal(&Url::parse(&wrong).unwrap(), &title).is_none(),
                "{wrong}"
            );
        }
        let accountless = format!(r#"{TITLE_PREFIX}{{"status":"ok","freeTrialCredit":"$100.00"}}"#);
        assert!(parse_title_signal(&credits_url(ACCOUNT), &accountless).is_none());
        assert!(parse_title_signal(&credits_url(ACCOUNT), &"x".repeat(5000)).is_none());
    }
    #[test]
    fn login_and_permission_signals_are_origin_checked() {
        let login = format!(r#"{TITLE_PREFIX}{{"status":"login_required"}}"#);
        assert_eq!(
            parse_title_signal(
                &Url::parse("https://accounts.google.com/signin").unwrap(),
                &login
            ),
            Some(ScrapeSignal::LoginRequired)
        );
        assert!(parse_title_signal(&credits_url(ACCOUNT), &login).is_none());
        let denied = format!(
            r#"{TITLE_PREFIX}{{"status":"permission_denied","billingAccountId":"{ACCOUNT}"}}"#
        );
        assert_eq!(
            parse_title_signal(&credits_url(ACCOUNT), &denied),
            Some(ScrapeSignal::PermissionDenied)
        );
        assert!(parse_title_signal(&Url::parse("https://example.com").unwrap(), &denied).is_none());
    }
    #[test]
    fn missing_rows_never_inherit_values_and_actual_currency_is_preserved() {
        let payload = ScrapedCreditsPayload {
            status: "ok".into(),
            billing_account_id: Some(ACCOUNT.into()),
            free_trial_credit: Some(" SG$100.00 ".into()),
            free_trial_remaining_percent: Some(50),
            ..Default::default()
        };
        let value = snapshot_from_payload(&payload, 123).unwrap();
        assert_eq!(value.free_trial_credit.as_deref(), Some("SG$100.00"));
        assert_eq!(value.free_trial_original_credit, None);
        assert_eq!(value.gdp_monthly_credit, None);
        assert_eq!(value.gdp_monthly_remaining_percent, None);
        assert_eq!(value.billing_account_id.as_deref(), Some(ACCOUNT));
        assert_eq!(value.collected_at, Some(123));
        assert!(snapshot_from_payload(
            &ScrapedCreditsPayload {
                billing_account_id: Some(ACCOUNT.into()),
                ..Default::default()
            },
            123
        )
        .is_none());
    }
    #[test]
    fn account_cache_round_trip_and_failed_sync_clears_it() {
        let path = std::env::temp_dir().join(format!(
            "ccgui-vertex-credits-{}.json",
            uuid::Uuid::new_v4()
        ));
        let payload = ScrapedCreditsPayload {
            status: "ok".into(),
            billing_account_id: Some(ACCOUNT.into()),
            gdp_monthly_credit: Some("EUR 20.00".into()),
            ..Default::default()
        };
        let value = snapshot_from_payload(&payload, 123).unwrap();
        save_to_path(&path, &value).unwrap();
        assert_eq!(load_from_path(&path), value);
        for code in [
            "syncing",
            "sync_cancelled",
            "permission_denied",
            "login_timeout",
            "scrape_timeout",
        ] {
            let empty = failed(code);
            assert!(empty.billing_account_id.is_none());
            assert!(empty.free_trial_credit.is_none());
            save_to_path(&path, &empty).unwrap();
            assert_eq!(load_from_path(&path), AgyVertexCreditsSnapshot::default());
        }
        std::fs::remove_file(&path).unwrap();
    }
    #[test]
    fn silent_refresh_runs_only_for_old_healthy_connected_balances_and_backs_off() {
        let healthy = |collected_at| {
            sanitize_snapshot(AgyVertexCreditsSnapshot {
                billing_account_id: Some(ACCOUNT.into()),
                gdp_monthly_credit: Some("$1.00".into()),
                collected_at: Some(collected_at),
                error_code: None,
                ..Default::default()
            })
        };
        let now = 10 * AUTO_MAX_AGE;
        assert!(auto_due(&healthy(now - AUTO_MAX_AGE), now, None));
        assert!(!auto_due(&healthy(now - AUTO_MAX_AGE + 1), now, None));
        assert!(!auto_due(&healthy(0), now, Some(AUTO_BACKOFF - Duration::from_secs(1))));
        assert!(auto_due(&healthy(0), now, Some(AUTO_BACKOFF)));
        // Never connect on the user's behalf, and never retry over a recorded failure.
        assert!(!auto_due(&AgyVertexCreditsSnapshot::default(), now, None));
        assert!(!auto_due(&failed("permission_denied"), now, None));
        // A clock set before the sample must not look infinitely old.
        assert!(!auto_due(&healthy(now + 5), now, None));
    }
    #[test]
    fn silent_refresh_never_reveals_but_manual_reveals_when_google_needs_the_user() {
        let auto = Plan::auto(ACCOUNT.into());
        let secs = Duration::from_secs;
        assert_eq!(next_step(&auto, secs(10), None, false, false), Step::Wait);
        // Brief pass-through of accounts.google.com is session plumbing, not a login.
        assert_eq!(next_step(&auto, secs(10), Some(secs(2)), true, false), Step::Wait);
        assert_eq!(
            next_step(&auto, secs(10), Some(LOGIN_GRACE), true, false),
            Step::LoginRequired
        );
        assert_eq!(next_step(&auto, secs(45), None, false, false), Step::Timeout);

        let manual = Plan::manual_targeted(ACCOUNT.into());
        assert_eq!(next_step(&manual, secs(5), None, false, false), Step::Wait);
        assert_eq!(next_step(&manual, secs(20), None, false, false), Step::Reveal);
        assert_eq!(
            next_step(&manual, secs(3), Some(LOGIN_GRACE), true, false),
            Step::Reveal
        );
        assert_eq!(next_step(&manual, secs(25), None, false, true), Step::Wait);
        assert_eq!(next_step(&manual, secs(40), None, false, true), Step::Timeout);
        // A sign-in in progress is not cut off at the short deadline.
        assert_eq!(
            next_step(&manual, secs(100), Some(secs(90)), true, true),
            Step::Wait
        );
        assert_eq!(next_step(&manual, secs(300), None, true, true), Step::Timeout);

        let projects = Plan::manual_projects();
        assert!(!projects.hidden);
        assert_eq!(next_step(&projects, secs(299), None, false, true), Step::Wait);
        assert_eq!(next_step(&projects, secs(300), None, false, true), Step::Timeout);
    }
    #[test]
    fn known_account_starts_on_its_credits_page_and_refresh_error_is_bounded() {
        assert_eq!(
            Url::parse(&start_credits_url(ACCOUNT)).unwrap().host_str(),
            Some("console.cloud.google.com")
        );
        assert!(account_from_url(&Url::parse(&start_credits_url(ACCOUNT)).unwrap(), true).is_some());
        let mut kept = snapshot_from_payload(
            &ScrapedCreditsPayload {
                status: "ok".into(),
                billing_account_id: Some(ACCOUNT.into()),
                gdp_monthly_credit: Some("$5.00".into()),
                ..Default::default()
            },
            123,
        )
        .unwrap();
        kept.refresh_error = Some("login_required".into());
        assert_eq!(sanitize_snapshot(kept.clone()).refresh_error.as_deref(), Some("login_required"));
        kept.refresh_error = Some("<script>".into());
        assert_eq!(sanitize_snapshot(kept).refresh_error, None);
    }
    #[test]
    fn invalid_amounts_and_percentages_do_not_become_credits() {
        let payload = ScrapedCreditsPayload {
            status: "ok".into(),
            billing_account_id: Some(ACCOUNT.into()),
            free_trial_credit: Some("<script>100</script>".into()),
            free_trial_remaining_percent: Some(255),
            ..Default::default()
        };
        assert!(snapshot_from_payload(&payload, 123).is_none());
        for id in [
            "",
            "project-example",
            "ABCDEF-123456-789ABZ",
            "ABCDEF-123456-789ABC/credits",
        ] {
            assert!(!valid_account(id));
        }
    }
}
