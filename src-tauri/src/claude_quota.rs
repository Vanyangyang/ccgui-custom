//! Conversation quota cache. Usage windows come from the official CLI stream.
//! This module does not spawn a quota process or read credential contents.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncReadExt};
use tokio::process::Command;

const MAX_OUTPUT: usize = 256 * 1024;
const COOLDOWN: Duration = Duration::from_secs(120);
#[cfg(test)]
const MAX_CACHE_AGE: u64 = 3600;
const MAX_PERSISTED_BYTES: usize = 16 * 1024;
const CACHE_SCHEMA_VERSION: u32 = 1;
const PROXY: &str = "http://127.0.0.1:7897";
const NO_PROXY: &str = "localhost,127.0.0.1,::1";

// 额度子进程已停用。下面的环境只留在测试里，用来固定「如果再组装这个命令，
// 也不能把订阅流量开关和遥测关掉」。生产路径不再启动它。
const QUOTA_WORKER_ENV: &[(&str, &str)] = &[
    ("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", ""),
    ("DISABLE_TELEMETRY", "1"),
    ("DISABLE_ERROR_REPORTING", "1"),
    ("DISABLE_AUTOUPDATER", "1"),
    ("CLAUDE_CODE_ENABLE_TELEMETRY", ""),
    ("OTEL_SDK_DISABLED", "true"),
];

fn configure_quota_worker(command: &mut Command) {
    // CLI settings take precedence over the inherited user settings.env. The
    // override lives in argv/environment, never in the user's settings file.
    let env: std::collections::HashMap<_, _> = QUOTA_WORKER_ENV.iter().copied().collect();
    command
        .envs(QUOTA_WORKER_ENV.iter().copied())
        .args([
            "--safe-mode",
            "--disable-slash-commands",
            "--tools",
            "",
            "--settings",
        ])
        .arg(serde_json::json!({"env": env}).to_string());
}

#[derive(Clone, Debug, serde::Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub used_percentage: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<u64>,
}
#[derive(Clone, Debug, Default, serde::Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindows {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub five_hour: Option<QuotaWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seven_day: Option<QuotaWindow>,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuotaAccount {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    pub plan: String,
}
// A separate disk schema deliberately excludes status/errors, auth metadata,
// credential contents and raw protocol output. Unknown fields fail closed.
#[derive(Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedQuota {
    version: u32,
    account_fingerprint: String,
    account: Option<PersistedAccount>,
    windows: PersistedWindows,
    collected_at: Option<u64>,
    source: Option<PersistedSource>,
}
#[derive(Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedAccount {
    email: Option<String>,
    plan: String,
}
#[derive(Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedWindows {
    five_hour: Option<PersistedWindow>,
    seven_day: Option<PersistedWindow>,
}
#[derive(Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersistedWindow {
    used_percentage: f64,
    resets_at: Option<u64>,
}
#[derive(Clone, Copy, Deserialize, Serialize, PartialEq)]
enum PersistedSource {
    #[serde(rename = "native_control")]
    Control,
    #[serde(rename = "native_stream")]
    Stream,
}
fn account_fingerprint(stamp: &str) -> String {
    format!("{:x}", Sha256::digest(stamp.as_bytes()))
}
impl PersistedQuota {
    fn from_snapshot(stamp: &str, snapshot: &ClaudeQuotaSnapshot) -> Option<Self> {
        let window = |w: &QuotaWindow| PersistedWindow {
            used_percentage: w.used_percentage,
            resets_at: w.resets_at,
        };
        Some(Self {
            version: CACHE_SCHEMA_VERSION,
            account_fingerprint: account_fingerprint(stamp),
            account: snapshot.account.as_ref().map(|a| PersistedAccount {
                email: a.email.clone(),
                plan: a.plan.clone(),
            }),
            windows: PersistedWindows {
                five_hour: snapshot.windows.five_hour.as_ref().map(window),
                seven_day: snapshot.windows.seven_day.as_ref().map(window),
            },
            collected_at: snapshot.collected_at,
            source: match snapshot.source {
                Some("native_control") => Some(PersistedSource::Control),
                Some("native_stream") => Some(PersistedSource::Stream),
                None => None,
                _ => return None,
            },
        })
    }
    fn snapshot(&self, stamp: &str, now: u64) -> Option<ClaudeQuotaSnapshot> {
        if self.version != CACHE_SCHEMA_VERSION
            || self.account_fingerprint != account_fingerprint(stamp)
            || self.collected_at.is_some_and(|at| at > now)
        {
            return None;
        }
        let valid_display = |text: &str, max| {
            !text.trim().is_empty() && text.len() <= max && !text.chars().any(char::is_control)
        };
        if self.account.as_ref().is_some_and(|account| {
            !valid_display(&account.plan, 128)
                || account.plan == "Claude API"
                || account.email.as_ref().is_some_and(|email| !valid_display(email, 320))
        }) {
            return None;
        }
        let mut windows = QuotaWindows::default();
        for (stored, target) in [
            (&self.windows.five_hour, &mut windows.five_hour),
            (&self.windows.seven_day, &mut windows.seven_day),
        ] {
            if let Some(w) = stored {
                if !w.used_percentage.is_finite()
                    || !(0.0..=100.0).contains(&w.used_percentage)
                    || w.resets_at.is_some_and(|at| at > 253_402_300_799)
                    || self.collected_at.is_none()
                    || self.source.is_none()
                {
                    return None;
                }
                *target = Some(QuotaWindow {
                    used_percentage: w.used_percentage,
                    resets_at: w.resets_at,
                });
            }
        }
        let mut snapshot = ClaudeQuotaSnapshot {
            status: "ready",
            windows,
            account: self.account.as_ref().map(|a| QuotaAccount {
                email: a.email.clone(),
                plan: a.plan.clone(),
            }),
            collected_at: self.collected_at,
            source: self.source.map(|source| match source {
                PersistedSource::Control => "native_control",
                PersistedSource::Stream => "native_stream",
            }),
            error_code: None,
        };
        snapshot.expire(now);
        Some(snapshot)
    }
}
fn read_persisted(path: &std::path::Path) -> Option<PersistedQuota> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take((MAX_PERSISTED_BYTES + 1) as u64).read_to_end(&mut bytes).ok()?;
    if bytes.len() > MAX_PERSISTED_BYTES {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}
fn write_persisted(path: &std::path::Path, content: &str) -> Result<(), ()> {
    use std::io::Write;
    let parent = path.parent().ok_or(())?;
    std::fs::create_dir_all(parent).map_err(|_| ())?;
    // Unlike settings' shared .tmp path, independent app processes must each
    // own their temporary file. Rename publishes a complete record atomically.
    let temporary = parent.join(format!(".claude-quota-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(|_| ())?;
    let result = file.write_all(content.as_bytes()).and_then(|_| file.sync_all());
    drop(file);
    let result = result.and_then(|_| std::fs::rename(&temporary, path));
    if result.is_err() { let _ = std::fs::remove_file(&temporary); }
    result.map_err(|_| ())
}
struct QuotaQueryResult {
    account: Option<QuotaAccount>,
    windows: Result<QuotaWindows, &'static str>,
}
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeQuotaSnapshot {
    pub status: &'static str,
    pub windows: QuotaWindows,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<QuotaAccount>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collected_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<&'static str>,
}
impl ClaudeQuotaSnapshot {
    fn unavailable(code: &'static str) -> Self {
        Self {
            status: "unavailable",
            windows: QuotaWindows::default(),
            account: None,
            collected_at: None,
            source: None,
            error_code: Some(code),
        }
    }
    fn expire(&mut self, now: u64) {
        // 【对话额度】上次窗口一直留到下一次对话额度替换它。超过一小时或重置时间到了也不清空。
        if self.windows == QuotaWindows::default() {
            self.status = "unavailable";
            self.error_code.get_or_insert("quota_not_available");
        } else if self.status == "ready"
            && self
                .collected_at
                .is_some_and(|at| now.saturating_sub(at) > COOLDOWN.as_secs())
        {
            self.status = "stale";
        }
    }
}
#[derive(Default)]
struct Cache {
    stamp: Option<String>,
    snapshot: Option<ClaudeQuotaSnapshot>,
    last_attempt: Option<Instant>,
    revision: u64,
    persistence_loaded: bool,
    // Remember content, not just second-resolution collected_at: another worker
    // can publish a different observation in the same second. An unchanged disk
    // record must never undo a newer in-memory observation after a write failure.
    last_persisted: Option<PersistedQuota>,
}
impl Cache {
    fn bind(&mut self, stamp: &str) {
        if self.stamp.as_deref() != Some(stamp) {
            *self = Self {
                stamp: Some(stamp.to_owned()),
                revision: self.revision.wrapping_add(1),
                ..Self::default()
            };
        }
    }
    fn failure(&mut self, code: &'static str, now: u64) -> ClaudeQuotaSnapshot {
        let mut result = self
            .snapshot
            .clone()
            .unwrap_or_else(|| ClaudeQuotaSnapshot::unavailable(code));
        result.expire(now);
        if result.windows != QuotaWindows::default() {
            result.status = "stale";
        }
        result.error_code = Some(code);
        self.snapshot = Some(result.clone());
        result
    }
}
#[derive(Default)]
pub struct ClaudeQuotaState {
    cache: Mutex<Cache>,
    query: tokio::sync::Mutex<()>,
    changed: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
    persistence_path: Option<std::path::PathBuf>,
    persistence_warned: std::sync::atomic::AtomicBool,
}

fn profile_persistence_path() -> Option<std::path::PathBuf> {
    if crate::paths::is_dev_profile() || dirs::home_dir().is_some() {
        Some(crate::paths::app_home().join("claude-quota-cache.json"))
    } else {
        None
    }
}
pub static STATE: LazyLock<Arc<ClaudeQuotaState>> =
    LazyLock::new(|| Arc::new(ClaudeQuotaState {
        persistence_path: if cfg!(any(test, feature = "test-harness")) {
            None
        } else {
            profile_persistence_path()
        },
        ..ClaudeQuotaState::default()
    }));

/// Never emit quota values or account metadata on the global event channel.
/// Every consumer re-reads through the account/project-validated cache command.
pub(crate) fn install_events(emitters: Arc<crate::event_sink::BroadcastEmit>) {
    STATE.install_events(emitters);
}
fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Read routing configuration only. Explicit custom, disabled, missing and stale
/// provider ids fail closed; unlike send resolution this has no migration writes.
pub(crate) fn native_provider(provider: Option<&str>) -> bool {
    let Ok(config) = crate::config::read_config() else {
        return false;
    };
    let Some(section) = config.section("claude") else {
        return false;
    };
    let id = provider
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| section.current.as_deref().unwrap_or("").trim());
    matches!(
        id,
        "" | crate::config::LOCAL_PROVIDER_ID | crate::config::LEGACY_LOCAL_CONFIG_TOML_ID
    )
}
/// Metadata only: changes to the native auth/config channel invalidate snapshots.
/// No credential bytes, account names or tokens are read or returned.
pub(crate) fn account_stamp() -> Option<String> {
    // The native protected quota worker belongs to the user's stable auth
    // channel. An independent dev profile must never consult or launch it.
    if crate::paths::is_dev_profile() { return None; }
    let home = std::env::var_os("USERPROFILE").map(std::path::PathBuf::from)?;
    if !default_auth_environment() || !settings_auth_is_default(&home.join(".claude/settings.json"))
    {
        return None;
    }
    let mut stamp = home.to_string_lossy().into_owned();
    for path in [
        home.join(".claude/.credentials.json"),
        home.join(".claude/settings.json"),
    ] {
        match std::fs::metadata(path) {
            Ok(meta) => {
                stamp.push_str(&format!("|{}:{:?}", meta.len(), meta.modified().ok()));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                stamp.push_str("|missing")
            }
            Err(_) => return None,
        }
    }
    Some(stamp)
}

const AUTH_OVERRIDES: &[&str] = &[
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
];

fn default_auth_environment() -> bool {
    AUTH_OVERRIDES
        .iter()
        .all(|key| std::env::var_os(key).is_none_or(|value| value.is_empty()))
}

fn env_override_present(skip_oauth_token: bool) -> bool {
    AUTH_OVERRIDES.iter().any(|key| {
        if skip_oauth_token && *key == "CLAUDE_CODE_OAUTH_TOKEN" {
            return false;
        }
        std::env::var_os(key).is_some_and(|value| !value.is_empty())
    })
}

/// 【对话额度】setup-token 只留下哈希。标记和缓存都不保存令牌原文。
fn oauth_quota_stamp(token: &str) -> Option<String> {
    let token = token.trim();
    if token.is_empty() {
        return None;
    }
    Some(format!("oauth:{:x}", Sha256::digest(token.as_bytes())))
}

/// 原生 Claude 渠道的对话额度标记。浏览器登录沿用认证文件摘要；
/// 只有 `CLAUDE_CODE_OAUTH_TOKEN` 挡住默认登录时，改用令牌哈希。
/// 自定义渠道、云厂商和 API key 不进入这份订阅缓存。
pub(crate) fn conversation_stamp() -> Option<String> {
    if crate::paths::is_dev_profile() {
        return None;
    }
    let home = std::env::var_os("USERPROFILE").map(std::path::PathBuf::from)?;
    if !settings_auth_is_default(&home.join(".claude/settings.json")) {
        return None;
    }
    if let Some(stamp) = std::env::var("CLAUDE_CODE_OAUTH_TOKEN")
        .ok()
        .as_deref()
        .and_then(oauth_quota_stamp)
    {
        if env_override_present(true) {
            return None;
        }
        return Some(stamp);
    }
    account_stamp()
}

fn auth_env_is_default(env: Option<&Value>) -> bool {
    env.and_then(Value::as_object).is_none_or(|env| {
        env.iter().all(|(key, value)| {
            !AUTH_OVERRIDES
                .iter()
                .any(|name| name.eq_ignore_ascii_case(key))
                || value.is_null()
                || value.as_str() == Some("")
        })
    })
}

fn settings_auth_is_default(path: &std::path::Path) -> bool {
    match std::fs::read(path) {
        Ok(bytes) if bytes.len() <= MAX_OUTPUT => serde_json::from_slice::<Value>(&bytes)
            .ok()
            .is_some_and(|settings| auth_env_is_default(settings.get("env"))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        _ => false,
    }
}

pub(crate) fn local_workspace_auth_is_default(workspace: &std::path::Path) -> bool {
    let name = workspace.to_string_lossy().to_ascii_lowercase();
    if name.starts_with("wsl:") || name.starts_with("ssh:") || name.starts_with("\\\\wsl") {
        return false;
    }
    let mut directory = Some(workspace);
    while let Some(path) = directory {
        if !settings_auth_is_default(&path.join(".claude/settings.json"))
            || !settings_auth_is_default(&path.join(".claude/settings.local.json"))
        {
            return false;
        }
        directory = path.parent();
    }
    true
}
pub(crate) fn ingest_stream(stamp: &str, value: &Value) {
    // 【对话额度】用本次对话记下的标记核对。setup-token 的哈希也算同一条原生渠道。
    if conversation_stamp().as_deref() != Some(stamp) {
        return;
    }
    let Some(windows) = parse_stream(value, now_seconds()) else {
        return;
    };
    if windows == QuotaWindows::default() {
        return;
    }
    STATE.ingest_bound_checked(stamp, windows, || conversation_stamp().as_deref() == Some(stamp));
}
fn window(value: &Value, fraction: bool, now: u64) -> Option<QuotaWindow> {
    let utilization = value.get("utilization")?.as_f64()?;
    if !utilization.is_finite()
        || utilization < 0.0
        || utilization > if fraction { 1.0 } else { 100.0 }
    {
        return None;
    }
    let reset = value.get(if fraction { "resetsAt" } else { "resets_at" });
    let resets_at = match reset {
        None | Some(Value::Null) => None,
        Some(value) if fraction => Some(value.as_u64()?),
        Some(value) => Some(parse_iso8601(value.as_str()?)?),
    };
    if resets_at.is_some_and(|at| at <= now) {
        return None;
    }
    Some(QuotaWindow {
        used_percentage: utilization * if fraction { 100.0 } else { 1.0 },
        resets_at,
    })
}
pub(crate) fn parse_stream(value: &Value, now: u64) -> Option<QuotaWindows> {
    if value.get("type")?.as_str()? != "rate_limit_event" {
        return None;
    }
    // 【对话额度】优先沿用流里的 unifiedWindows。字段在场时即使比例无效也返回空窗口，
    // 避免把 0–1 以外的利用率误当成百分比，或落到状态行字段。没有这份字段时，
    // 改读 CLI 从响应头填给状态行的 rate_limits（used_percentage + Unix resets_at）。
    if let Some(windows) = value.pointer("/rate_limit_info/unifiedWindows").and_then(Value::as_object) {
        return Some(QuotaWindows {
            five_hour: windows.get("five_hour").and_then(|v| window(v, true, now)),
            seven_day: windows.get("seven_day").and_then(|v| window(v, true, now)),
        });
    }
    value
        .get("rate_limits")
        .or_else(|| value.pointer("/rate_limit_info/rate_limits"))
        .and_then(|limits| statusline_windows(limits, now))
}

/// ccstatusline 与本机 statusline-command.sh 使用的窗口：百分比 0–100，重置时间是 Unix 秒。
fn statusline_windows(limits: &Value, now: u64) -> Option<QuotaWindows> {
    let limits = limits.as_object()?;
    let parsed = QuotaWindows {
        five_hour: limits.get("five_hour").and_then(|v| statusline_window(v, now)),
        seven_day: limits.get("seven_day").and_then(|v| statusline_window(v, now)),
    };
    (parsed != QuotaWindows::default()).then_some(parsed)
}

fn statusline_window(value: &Value, now: u64) -> Option<QuotaWindow> {
    let used = value.get("used_percentage").and_then(Value::as_f64)?;
    if !used.is_finite() || !(0.0..=100.0).contains(&used) {
        return None;
    }
    let resets_at = match value.get("resets_at") {
        None | Some(Value::Null) => None,
        Some(value) => Some(value.as_u64().or_else(|| value.as_f64().map(|n| n as u64))?),
    };
    if resets_at.is_some_and(|at| at <= now) {
        return None;
    }
    Some(QuotaWindow {
        used_percentage: used,
        resets_at,
    })
}
fn parse_control(data: &Value, now: u64) -> Result<QuotaWindows, &'static str> {
    match data.get("rate_limits_available").and_then(Value::as_bool) {
        Some(true) => {}
        Some(false) => return Err("quota_not_available"),
        None => return Err("unsupported_response"),
    }
    let limits = match data.get("rate_limits") {
        Some(Value::Null) => return Ok(QuotaWindows::default()),
        Some(Value::Object(limits)) => limits,
        _ => return Err("unsupported_response"),
    };
    Ok(QuotaWindows {
        five_hour: limits.get("five_hour").and_then(|v| window(v, false, now)),
        seven_day: limits.get("seven_day").and_then(|v| window(v, false, now)),
    })
}
// initialize.account is the same cached metadata exposed by SDK accountInfo().
// It supplies an email and a subscription display label, not a personal nickname.
// Copy only these display fields; never forward auth-source details or raw data.
fn parse_account(data: &Value) -> Option<QuotaAccount> {
    let account = data.get("account")?;
    if account.get("apiProvider").and_then(Value::as_str) != Some("firstParty") {
        return None;
    }
    for key in ["tokenSource", "apiKeySource"] {
        if !matches!(account.get(key), None | Some(Value::Null))
            && account.get(key).and_then(Value::as_str) != Some("")
        {
            return None;
        }
    }
    let display_field = |key: &str, max: usize| {
        let text = account.get(key)?.as_str()?.trim();
        (!text.is_empty() && text.len() <= max && !text.chars().any(char::is_control))
            .then(|| text.to_owned())
    };
    let plan = display_field("subscriptionType", 128)?;
    // The CLI uses this fallback for an unknown/API subscription. It is not a plan.
    if plan == "Claude API" {
        return None;
    }
    Some(QuotaAccount {
        email: display_field("email", 320),
        plan,
    })
}
// Strict RFC3339 calendar/time parser (UTC or explicit offset), no dependency or
// locale conversion. Reject impossible dates instead of normalizing silently.
fn parse_iso8601(input: &str) -> Option<u64> {
    let bytes = input.as_bytes();
    if bytes.len() < 20
        || !input.is_ascii()
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let number = |a: usize, b: usize| {
        let text = &input[a..b];
        if text.bytes().all(|byte| byte.is_ascii_digit()) {
            text.parse::<i64>().ok()
        } else {
            None
        }
    };
    let (year, month, day, hour, minute, second) = (
        number(0, 4)?,
        number(5, 7)?,
        number(8, 10)?,
        number(11, 13)?,
        number(14, 16)?,
        number(17, 19)?,
    );
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        _ => return None,
    };
    if !(1970..=9999).contains(&year)
        || !(1..=days).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let mut tail = &input[19..];
    if let Some(fraction) = tail.strip_prefix('.') {
        let len = fraction.bytes().take_while(u8::is_ascii_digit).count();
        if len == 0 {
            return None;
        }
        tail = &fraction[len..];
    }
    let offset = if tail == "Z" {
        0
    } else {
        let b = tail.as_bytes();
        if b.len() != 6 || !matches!(b[0], b'+' | b'-') || b[3] != b':' {
            return None;
        }
        if !b[1..3].iter().chain(b[4..6].iter()).all(u8::is_ascii_digit) {
            return None;
        }
        let h = tail[1..3].parse::<i64>().ok()?;
        let m = tail[4..6].parse::<i64>().ok()?;
        if h > 23 || m > 59 {
            return None;
        }
        (h * 3600 + m * 60) * if b[0] == b'+' { 1 } else { -1 }
    };
    let y = year - i64::from(month <= 2);
    let era = y / 400;
    let yoe = y - era * 400;
    let mp = month + if month > 2 { -3 } else { 9 };
    let doy = (153 * mp + 2) / 5 + day - 1;
    let days = era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
    u64::try_from(days * 86400 + hour * 3600 + minute * 60 + second - offset).ok()
}
fn fixed_environment(command: &mut Command) {
    for key in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
    ] {
        command.env(key, PROXY);
    }
    for key in ["NO_PROXY", "no_proxy"] {
        command.env(key, NO_PROXY);
    }
    // Alternate auth/config contexts are rejected before this point; do not
    // silently switch an existing login by stripping its environment.
    #[cfg(windows)]
    command.creation_flags(0x08000000);
}
fn guard_ready(success: bool, output: &[u8]) -> bool {
    success
        && output.len() <= MAX_OUTPUT
        && serde_json::from_slice::<Value>(output)
            .ok()
            .and_then(|v| v.get("ready").and_then(Value::as_bool))
            == Some(true)
}
#[cfg(windows)]
struct OwnedWorker {
    child: tokio::process::Child,
    _job: Arc<crate::engine::job::KillOnCloseJob>,
}
#[cfg(windows)]
impl OwnedWorker {
    fn spawn(mut command: Command) -> Result<Self, &'static str> {
        command
            .kill_on_drop(true)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        fixed_environment(&mut command);
        let child = command.spawn().map_err(|_| "worker_spawn_failed")?;
        let job =
            crate::engine::job::assign_kill_on_close(&child).ok_or("protection_unavailable")?;
        Ok(Self { child, _job: job })
    }
    async fn finish(&mut self) {
        drop(self.child.stdin.take());
        // Keep the root alive until it is killed; the job sweeps descendants.
        let _ = self.child.start_kill();
        let _ = tokio::time::timeout(Duration::from_millis(500), self.child.wait()).await;
    }
}
#[cfg(windows)]
async fn run_guard(command: Command) -> Result<(), &'static str> {
    let mut worker = OwnedWorker::spawn(command)?;
    drop(worker.child.stdin.take());
    let mut stdout = worker.child.stdout.take().ok_or("protection_unavailable")?;
    let mut output = Vec::new();
    let result = tokio::time::timeout(Duration::from_secs(30), async {
        (&mut stdout)
            .take((MAX_OUTPUT + 1) as u64)
            .read_to_end(&mut output)
            .await
            .map_err(|_| "protection_unavailable")?;
        if output.len() > MAX_OUTPUT {
            return Err("protection_unavailable");
        }
        let exit = worker
            .child
            .wait()
            .await
            .map_err(|_| "protection_unavailable")?;
        if guard_ready(exit.success(), &output) {
            Ok(())
        } else {
            Err("protection_unavailable")
        }
    })
    .await
    .unwrap_or(Err("protection_timeout"));
    worker.finish().await;
    result
}
async fn matching_response<R: tokio::io::AsyncBufRead + Unpin>(
    reader: &mut R,
    id: &str,
    budget: &mut usize,
) -> Result<Value, &'static str> {
    loop {
        if *budget == 0 {
            return Err("output_limit");
        }
        let mut line = Vec::new();
        let len = (&mut *reader)
            .take((*budget + 1) as u64)
            .read_until(b'\n', &mut line)
            .await
            .map_err(|_| "unsupported_response")?;
        if len == 0 {
            return Err("unexpected_eof");
        }
        if len > *budget {
            return Err("output_limit");
        }
        *budget -= len;
        let frame: Value = serde_json::from_slice(&line).map_err(|_| "unsupported_response")?;
        // Unexpected inference output means the CLI violated the no-prompt contract.
        if matches!(
            frame.get("type").and_then(Value::as_str),
            Some("assistant" | "user" | "stream_event")
        ) {
            return Err("unexpected_inference");
        }
        if frame.get("type").and_then(Value::as_str) != Some("control_response") {
            continue;
        }
        let response = frame.get("response").ok_or("unsupported_response")?;
        if response.get("request_id").and_then(Value::as_str) != Some(id) {
            continue;
        }
        if response.get("subtype").and_then(Value::as_str) != Some("success") {
            return Err("unsupported_control");
        }
        return Ok(response.get("response").cloned().unwrap_or(Value::Null));
    }
}
impl ClaudeQuotaState {
    // Called with the cache mutex held: restore/write cannot race a newer update
    // in this process. Binding changes reset both cooldown and lazy-load state.
    fn bind_cache(&self, cache: &mut Cache, stamp: &str) {
        cache.bind(stamp);
        if !cache.persistence_loaded {
            cache.persistence_loaded = true;
            self.refresh_persisted(cache, stamp);
        }
    }
    fn refresh_persisted(&self, cache: &mut Cache, stamp: &str) {
        let Some(record) = self.persistence_path.as_deref().and_then(read_persisted) else {
            return;
        };
        let Some(snapshot) = record.snapshot(stamp, now_seconds()) else { return; };
        if cache.last_persisted.as_ref() == Some(&record) { return; }
        // Account-validated new disk content is authoritative for equal-second
        // observations, but a late writer must not move collection time backwards.
        if cache.snapshot.as_ref().is_none_or(|current| snapshot.collected_at >= current.collected_at) {
            cache.snapshot = Some(snapshot);
            cache.revision = cache.revision.wrapping_add(1);
        }
        cache.last_persisted = Some(record);
    }
    fn persist_cache(&self, cache: &mut Cache, identity_validated: bool) -> Result<(), ()> {
        let Some(path) = self.persistence_path.as_deref() else { return Ok(()); };
        let (Some(stamp), Some(snapshot)) = (cache.stamp.as_deref(), cache.snapshot.as_ref()) else {
            return Ok(());
        };
        let mut record = PersistedQuota::from_snapshot(stamp, snapshot).ok_or(())?;
        let now = now_seconds();
        record.snapshot(stamp, now).ok_or(())?;
        // Best effort across independent processes: do not replace an already
        // newer observation for this account. Equal-second writers can still
        // race; the cache mutex guarantees ordering within this process only.
        if let Some(mut disk) = read_persisted(path).filter(|disk| disk.snapshot(stamp, now).is_some()) {
            if disk.collected_at > record.collected_at {
                if !identity_validated { return Ok(()); }
                // Usage and initialize identity are independently validated.
                // Keep another process's newer usage while applying this
                // initialize reply, including an intentional missing identity.
                disk.account = record.account;
                record = disk;
            }
        }
        let content = serde_json::to_string(&record).map_err(|_| ())?;
        if content.len() > MAX_PERSISTED_BYTES { return Err(()); }
        write_persisted(path, &content)?;
        // A validated identity write may preserve another process's newer
        // usage. It has not reached our memory yet; leave it unseen so the
        // next cache read imports it rather than suppressing that update.
        if record.collected_at == snapshot.collected_at {
            cache.last_persisted = Some(record);
        }
        Ok(())
    }
    fn persist_or_warn(&self, cache: &mut Cache, identity_validated: bool) {
        if self.persist_cache(cache, identity_validated).is_err()
            && !self.persistence_warned.swap(true, std::sync::atomic::Ordering::Relaxed)
        {
            eprintln!("[claude-quota] cache persistence failed; using in-memory cache");
        }
    }
    fn set_notifier(&self, notifier: impl Fn() + Send + Sync + 'static) {
        *self.changed.lock().unwrap_or_else(|p| p.into_inner()) = Some(Box::new(notifier));
    }
    pub(crate) fn install_events(&self, emitters: Arc<crate::event_sink::BroadcastEmit>) {
        use crate::event_sink::Emit;
        let emitters = Arc::downgrade(&emitters);
        self.set_notifier(move || {
            if let Some(emitters) = emitters.upgrade() {
                emitters.emit_json("claude-quota://changed", "null");
            }
        });
    }
    fn notify_changed(&self) {
        if let Some(notify) = self
            .changed
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
        {
            notify();
        }
    }
    #[cfg(test)]
    pub(crate) fn ingest_bound(&self, stamp: &str, windows: QuotaWindows) {
        self.ingest_bound_checked(stamp, windows, || true);
    }
    fn ingest_bound_checked(&self, stamp: &str, windows: QuotaWindows, channel_unchanged: impl Fn() -> bool) {
        if windows == QuotaWindows::default() {
            return;
        }
        if !channel_unchanged() { return; }
        {
            let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
            self.bind_cache(&mut cache, stamp);
            if !channel_unchanged() { return; }
            // Another app process may have independently initialized identity
            // since our first (empty) binding. Passive packets contain no
            // identity fields and must not erase that matching disk identity.
            // Active initialize replies still explicitly replace/clear it.
            let account = cache.snapshot.as_ref().and_then(|s| s.account.clone()).or_else(|| {
                self.persistence_path.as_deref().and_then(read_persisted)
                    .and_then(|record| record.snapshot(stamp, now_seconds()))
                    .and_then(|snapshot| snapshot.account)
            });
            if !channel_unchanged() { return; }
            cache.snapshot = Some(ClaudeQuotaSnapshot {
                status: "ready",
                windows,
                account,
                collected_at: Some(now_seconds()),
                source: Some("native_stream"),
                error_code: None,
            });
            // Passive usage must not postpone a manual identity read. Only
            // active query attempts consume the shared 120-second cooldown.
            cache.revision = cache.revision.wrapping_add(1);
            // A disk failure must not discard a valid live observation. The
            // IPC result makes no durability claim; never log account data.
            self.persist_or_warn(&mut cache, false);
        }
        self.notify_changed();
    }
    fn cached_bound(
        &self,
        stamp: &str,
        channel_unchanged: impl Fn() -> bool,
    ) -> ClaudeQuotaSnapshot {
        if !channel_unchanged() {
            return ClaudeQuotaSnapshot::unavailable("auth_changed");
        }
        let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
        self.bind_cache(&mut cache, stamp);
        // Normal conversations run in independent workers. Their invalidation
        // event (or the periodic/focus fallback) must read their latest disk
        // observation rather than this host's first-loaded memory snapshot.
        self.refresh_persisted(&mut cache, stamp);
        let mut result = cache
            .snapshot
            .clone()
            .unwrap_or_else(|| ClaudeQuotaSnapshot::unavailable("not_loaded"));
        result.expire(now_seconds());
        if !channel_unchanged() {
            return ClaudeQuotaSnapshot::unavailable("auth_changed");
        }
        result
    }
    async fn read(
        &self,
        provider: Option<&str>,
        cache_only: bool,
        workspace: Option<&std::path::Path>,
    ) -> ClaudeQuotaSnapshot {
        if !native_provider(provider) {
            return ClaudeQuotaSnapshot::unavailable("custom_channel");
        }
        let Some(stamp) = conversation_stamp() else {
            return ClaudeQuotaSnapshot::unavailable("auth_metadata_unavailable");
        };
        let channel_unchanged = || {
            native_provider(provider)
                && conversation_stamp().as_deref() == Some(stamp.as_str())
                && workspace.is_none_or(local_workspace_auth_is_default)
        };
        // 【对话额度】不再启动 get_usage 子进程。手动刷新和定时检查都只读
        // 正常对话 rate_limit_event 写入的缓存。主对话代理仍由应用环境继承。
        let _ = cache_only;
        self.cached_bound(&stamp, channel_unchanged)
    }
    async fn read_bound(
        &self,
        stamp: &str,
        query: impl std::future::Future<Output = Result<QuotaQueryResult, &'static str>>,
        channel_unchanged: impl Fn() -> bool,
    ) -> ClaudeQuotaSnapshot {
        let _query = self.query.lock().await;
        if !channel_unchanged() {
            return ClaudeQuotaSnapshot::unavailable("auth_changed");
        }
        let query_revision = {
            let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
            self.bind_cache(&mut cache, stamp);
            if cache.last_attempt.is_some_and(|at| at.elapsed() < COOLDOWN) {
                let mut result = cache
                    .snapshot
                    .clone()
                    .unwrap_or_else(|| ClaudeQuotaSnapshot::unavailable("refresh_cooldown"));
                result.expire(now_seconds());
                if !channel_unchanged() {
                    return ClaudeQuotaSnapshot::unavailable("auth_changed");
                }
                return result;
            }
            cache.last_attempt = Some(Instant::now());
            cache.revision
        };
        let result = tokio::time::timeout(Duration::from_secs(27), query)
            .await
            .unwrap_or(Err("query_timeout"));
        let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
        if !channel_unchanged() {
            return ClaudeQuotaSnapshot::unavailable("auth_changed");
        }
        self.bind_cache(&mut cache, stamp);
        // A normal response can arrive during a manual query. It is newer than
        // that query's initial state and must not be overwritten or made stale.
        if cache.revision != query_revision {
            let mut latest = cache
                .snapshot
                .clone()
                .unwrap_or_else(|| ClaudeQuotaSnapshot::unavailable("not_loaded"));
            // Conversation reports do not carry account labels. A validated
            // initialize reply can fill those without replacing newer usage.
            let mut identity_changed = false;
            if let Ok(query) = result {
                let changed = latest.account != query.account;
                latest.account = query.account;
                cache.snapshot = Some(latest.clone());
                if changed {
                    cache.revision = cache.revision.wrapping_add(1);
                    identity_changed = true;
                }
                self.persist_or_warn(&mut cache, true);
            }
            drop(cache);
            if identity_changed { self.notify_changed(); }
            latest.expire(now_seconds());
            if !channel_unchanged() { return ClaudeQuotaSnapshot::unavailable("auth_changed"); }
            return latest;
        }
        let identity_validated = result.is_ok();
        let (result, account) = match result {
            Ok(query) => (query.windows, query.account),
            Err(code) => (
                Err(code),
                cache.snapshot.as_ref().and_then(|s| s.account.clone()),
            ),
        };
        let mut snapshot = match result {
            Ok(windows) if windows == QuotaWindows::default() => {
                cache.failure("quota_not_available", now_seconds())
            }
            Ok(windows) => {
                let mut result = ClaudeQuotaSnapshot {
                    status: "ready",
                    windows,
                    account: None,
                    collected_at: Some(now_seconds()),
                    source: Some("native_control"),
                    error_code: None,
                };
                result.expire(now_seconds());
                result
            }
            Err(code) => cache.failure(code, now_seconds()),
        };
        snapshot.account = account;
        cache.snapshot = Some(snapshot.clone());
        cache.revision = cache.revision.wrapping_add(1);
        self.persist_or_warn(&mut cache, identity_validated);
        drop(cache);
        self.notify_changed();
        if !channel_unchanged() { return ClaudeQuotaSnapshot::unavailable("auth_changed"); }
        snapshot
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn known_window() -> QuotaWindows {
        QuotaWindows {
            five_hour: Some(QuotaWindow {
                used_percentage: 80.0,
                resets_at: Some(now_seconds() + 3600),
            }),
            seven_day: None,
        }
    }
    fn known_account() -> QuotaAccount {
        QuotaAccount {
            email: Some("reader@example.com".to_owned()),
            plan: "Claude Team".to_owned(),
        }
    }
    fn known_query() -> QuotaQueryResult {
        QuotaQueryResult {
            account: Some(known_account()),
            windows: Ok(known_window()),
        }
    }
    struct QuotaScratch(std::path::PathBuf);
    impl QuotaScratch {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("ccgui-quota-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> std::path::PathBuf { self.0.join("claude-quota-cache.json") }
        fn state(&self) -> ClaudeQuotaState {
            ClaudeQuotaState {
                persistence_path: Some(self.path()),
                ..ClaudeQuotaState::default()
            }
        }
        fn write(&self, record: &Value) {
            std::fs::write(self.path(), serde_json::to_vec(record).unwrap()).unwrap();
        }
    }
    impl Drop for QuotaScratch {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
    }
    fn persisted_fixture() -> Value {
        serde_json::to_value(PersistedQuota::from_snapshot("account-a", &ClaudeQuotaSnapshot {
            status: "ready",
            windows: known_window(),
            account: Some(known_account()),
            collected_at: Some(now_seconds()),
            source: Some("native_control"),
            error_code: None,
        }).unwrap()).unwrap()
    }
    #[tokio::test]
    async fn restart_restores_validated_account_and_quota_without_query_or_cooldown() {
        let scratch = QuotaScratch::new();
        let state = scratch.state();
        let original = state.read_bound("account-a", async { Ok(known_query()) }, || true).await;
        let record: Value = serde_json::from_slice(&std::fs::read(scratch.path()).unwrap()).unwrap();
        assert_eq!(record["accountFingerprint"], account_fingerprint("account-a"));
        assert!(!record.to_string().contains("account-a"));
        assert_eq!(record.as_object().unwrap().len(), 6);
        assert!(record.get("status").is_none());
        assert!(record.get("errorCode").is_none());
        let restarted = scratch.state();
        let _query_lock = restarted.query.try_lock().unwrap();
        assert_eq!(restarted.cached_bound("account-a", || true), original);
        assert_eq!(restarted.cache.lock().unwrap().last_attempt, None);
        assert!(ClaudeQuotaState::default().persistence_path.is_none());
        assert!(STATE.persistence_path.is_none());
    }

    #[cfg(feature = "test-harness")]
    #[tokio::test]
    async fn development_profile_quota_cache_persists_only_in_selected_fixture_root() {
        let fixture = crate::test_harness::TestHarness::new().unwrap();
        let production = fixture.root().join(".ccgui-next/claude-quota-cache.json");
        std::fs::write(&production, b"production-fixture-sentinel").unwrap();
        let profile = dunce::simplified(fixture.root()).join("quota-development");
        fixture.use_profile(&profile).unwrap();
        crate::paths::ensure_dirs().unwrap();
        let state = ClaudeQuotaState {
            persistence_path: profile_persistence_path(),
            ..ClaudeQuotaState::default()
        };
        assert_eq!(state.persistence_path.as_deref(), Some(profile.join("claude-quota-cache.json").as_path()));
        let original = state.read_bound("fake-account", async { Ok(known_query()) }, || true).await;
        assert!(profile.join("claude-quota-cache.json").is_file());
        let restarted = ClaudeQuotaState {
            persistence_path: profile_persistence_path(),
            ..ClaudeQuotaState::default()
        };
        assert_eq!(restarted.cached_bound("fake-account", || true), original);
        assert_eq!(std::fs::read(&production).unwrap(), b"production-fixture-sentinel");
        assert!(STATE.persistence_path.is_none(), "global test quota state must stay non-persistent");
    }
    #[test]
    fn restart_expires_numbers_but_keeps_identity_and_original_collection_time() {
        let scratch = QuotaScratch::new();
        let mut record = persisted_fixture();
        let old = now_seconds() - MAX_CACHE_AGE;
        record["collectedAt"] = json!(old);
        scratch.write(&record);
        let reply = scratch.state().cached_bound("account-a", || true);
        assert_eq!(reply.status, "stale");
        assert_eq!(reply.account, Some(known_account()));
        assert!(reply.windows.five_hour.is_some());
        assert_eq!(reply.collected_at, Some(old));
        assert_eq!(reply.error_code, None);
        record["collectedAt"] = json!(now_seconds() - COOLDOWN.as_secs() - 1);
        scratch.write(&record);
        let stale = scratch.state().cached_bound("account-a", || true);
        assert_eq!(stale.status, "stale");
        assert!(stale.windows.five_hour.is_some());
        record["windows"]["fiveHour"]["resetsAt"] = json!(now_seconds());
        scratch.write(&record);
        let reset = scratch.state().cached_bound("account-a", || true);
        assert!(reset.windows.five_hour.is_some());
        assert_eq!(reset.account, Some(known_account()));
    }
    #[test]
    fn running_host_observes_worker_quota_without_restart() {
        let scratch = QuotaScratch::new();
        let host = scratch.state();
        let worker = scratch.state();
        assert_eq!(host.cached_bound("account-a", || true).error_code, Some("not_loaded"));
        let windows = known_window();
        worker.ingest_bound("account-a", windows.clone());
        assert_eq!(host.cached_bound("account-a", || true).windows, windows);
    }
    #[test]
    fn running_host_observes_changed_disk_quota_even_in_same_second() {
        let scratch = QuotaScratch::new();
        let mut record = persisted_fixture();
        scratch.write(&record);
        let host = scratch.state();
        let original = host.cached_bound("account-a", || true);
        record["windows"]["fiveHour"]["usedPercentage"] = json!(42.0);
        scratch.write(&record);
        let updated = host.cached_bound("account-a", || true);
        assert_eq!(updated.windows.five_hour.unwrap().used_percentage, 42.0);
        assert_eq!(updated.collected_at, original.collected_at);
    }
    #[test]
    fn persistence_refresh_rechecks_auth_and_resets_observation_on_binding_change() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let scratch = QuotaScratch::new();
        let state = scratch.state();
        assert_eq!(state.cached_bound("account-a", || true).error_code, Some("not_loaded"));
        scratch.write(&persisted_fixture());
        assert_eq!(state.cached_bound("account-a", || true).account, Some(known_account()));
        assert_eq!(state.cached_bound("account-b", || true).account, None);
        assert_eq!(state.cached_bound("account-a", || true).account, Some(known_account()));
        let checks = AtomicUsize::new(0);
        let denied = scratch.state().cached_bound("account-a", || checks.fetch_add(1, Ordering::SeqCst) == 0);
        assert_eq!(denied.error_code, Some("auth_changed"));
        assert_eq!(denied.account, None);
        assert_eq!(denied.windows, QuotaWindows::default());
        let rejected = scratch.state();
        assert_eq!(rejected.cached_bound("account-a", || false).account, None);
        assert!(!rejected.cache.lock().unwrap().persistence_loaded);
    }
    #[test]
    fn persistence_refresh_rejects_older_invalid_and_other_account_records() {
        let scratch = QuotaScratch::new();
        let original = persisted_fixture();
        scratch.write(&original);
        let host = scratch.state();
        let expected = host.cached_bound("account-a", || true);
        for (key, value) in [
            ("collectedAt", json!(original["collectedAt"].as_u64().unwrap() - 1)),
            ("collectedAt", json!(now_seconds() + 3600)),
            ("accountFingerprint", json!(account_fingerprint("account-b"))),
        ] {
            let mut record = original.clone();
            record[key] = value;
            record["windows"]["fiveHour"]["usedPercentage"] = json!(1.0);
            scratch.write(&record);
            assert_eq!(host.cached_bound("account-a", || true), expected);
        }
        for bytes in [b"{malformed".to_vec(), vec![b' '; MAX_PERSISTED_BYTES + 1]] {
            std::fs::write(scratch.path(), bytes).unwrap();
            assert_eq!(host.cached_bound("account-a", || true), expected);
        }
        std::fs::remove_file(scratch.path()).unwrap();
        assert_eq!(host.cached_bound("account-a", || true), expected);
    }
    #[test]
    fn unchanged_disk_cannot_undo_live_usage_after_failed_persistence() {
        let scratch = QuotaScratch::new();
        let original = persisted_fixture();
        scratch.write(&original);
        let state = scratch.state();
        state.cached_bound("account-a", || true);
        let mut intermediate = known_window();
        intermediate.five_hour.as_mut().unwrap().used_percentage = 30.0;
        state.ingest_bound("account-a", intermediate);
        let original: Value = serde_json::from_slice(&std::fs::read(scratch.path()).unwrap()).unwrap();
        std::fs::remove_file(scratch.path()).unwrap();
        std::fs::create_dir(scratch.path()).unwrap(); // Force the atomic publish to fail.
        let mut fresh = known_window();
        fresh.five_hour.as_mut().unwrap().used_percentage = 42.0;
        state.ingest_bound("account-a", fresh.clone());
        // Force the equal-second case even if this test crosses a clock tick.
        state.cache.lock().unwrap().snapshot.as_mut().unwrap().collected_at = original["collectedAt"].as_u64();
        std::fs::remove_dir(scratch.path()).unwrap();
        scratch.write(&original);
        for _ in 0..2 {
            assert_eq!(state.cached_bound("account-a", || true).windows, fresh);
        }
    }
    #[test]
    fn persisted_schema_rejects_invalid_future_and_oversized_records() {
        let scratch = QuotaScratch::new();
        let valid = persisted_fixture();
        let mut invalid = Vec::new();
        for (key, value) in [
            ("version", json!(2)),
            ("collectedAt", json!(now_seconds() + 3600)),
            ("collectedAt", json!("123")),
            ("collectedAt", Value::Null),
            ("source", json!("unknown")),
            ("source", Value::Null),
            ("accountFingerprint", account_fingerprint("account-b").into()),
            ("credentials", json!("forbidden")),
        ] {
            let mut altered = valid.clone();
            altered[key] = value;
            invalid.push(altered);
        }
        for value in [json!(-1), json!(101), json!("80"), Value::Null] {
            let mut altered = valid.clone();
            altered["windows"]["fiveHour"]["usedPercentage"] = value;
            invalid.push(altered);
        }
        for (field, value) in [("resetsAt", json!(u64::MAX)), ("resetsAt", json!(-1)), ("raw", json!(true))] {
            let mut altered = valid.clone();
            altered["windows"]["fiveHour"][field] = value;
            invalid.push(altered);
        }
        for (field, value) in [("plan", json!("Claude API")), ("plan", json!("x".repeat(129))), ("email", json!("a\nb")), ("token", json!("forbidden"))] {
            let mut altered = valid.clone();
            altered["account"][field] = value;
            invalid.push(altered);
        }
        for record in invalid {
            scratch.write(&record);
            let reply = scratch.state().cached_bound("account-a", || true);
            assert_eq!(reply.account, None, "{record}");
            assert_eq!(reply.windows, QuotaWindows::default(), "{record}");
        }
        for bytes in [b"{malformed".to_vec(), vec![b' '; MAX_PERSISTED_BYTES + 1]] {
            std::fs::write(scratch.path(), bytes).unwrap();
            assert_eq!(scratch.state().cached_bound("account-a", || true).account, None);
        }
        let mut zero = valid;
        zero["windows"]["fiveHour"]["usedPercentage"] = json!(0);
        scratch.write(&zero);
        assert_eq!(scratch.state().cached_bound("account-a", || true).windows.five_hour.unwrap().used_percentage, 0.0);
    }
    #[tokio::test]
    async fn identity_only_initialization_survives_restart_and_passive_usage() {
        let scratch = QuotaScratch::new();
        let state = scratch.state();
        state.read_bound("account-a", async {
            Ok(QuotaQueryResult { account: Some(known_account()), windows: Err("quota_not_available") })
        }, || true).await;
        let restarted = scratch.state();
        let account = restarted.cached_bound("account-a", || true);
        assert_eq!(account.account, Some(known_account()));
        assert_eq!(account.windows, QuotaWindows::default());
        assert_eq!(account.collected_at, None);
        restarted.ingest_bound("account-a", known_window());
        assert_eq!(scratch.state().cached_bound("account-a", || true).account, Some(known_account()));
    }
    #[tokio::test]
    async fn independent_passive_process_keeps_identity_initialized_after_its_empty_binding() {
        let scratch = QuotaScratch::new();
        let identity_process = scratch.state();
        let passive_process = scratch.state();
        assert_eq!(identity_process.cached_bound("account-a", || true).account, None);
        assert_eq!(passive_process.cached_bound("account-a", || true).account, None);
        identity_process.read_bound("account-a", async { Ok(known_query()) }, || true).await;
        let fresh = QuotaWindows {
            five_hour: Some(QuotaWindow { used_percentage: 0.0, resets_at: None }),
            seven_day: None,
        };
        passive_process.ingest_bound("account-a", fresh.clone());
        let restored = scratch.state().cached_bound("account-a", || true);
        assert_eq!(restored.account, Some(known_account()));
        assert_eq!(restored.windows, fresh);
        assert_eq!(restored.source, Some("native_stream"));
    }
    #[tokio::test]
    async fn identity_only_query_merges_with_newer_usage_from_another_process() {
        let scratch = QuotaScratch::new();
        let identity_process = scratch.state();
        let passive_process = scratch.state();
        identity_process.cached_bound("account-a", || true);
        let fresh = QuotaWindows {
            five_hour: Some(QuotaWindow { used_percentage: 0.0, resets_at: None }),
            seven_day: None,
        };
        let reply = identity_process.read_bound("account-a", async {
            passive_process.ingest_bound("account-a", fresh.clone());
            Ok(QuotaQueryResult { account: Some(known_account()), windows: Err("quota_not_available") })
        }, || true).await;
        assert_eq!(reply.account, Some(known_account()));
        assert_eq!(reply.collected_at, None);
        let restored = scratch.state().cached_bound("account-a", || true);
        assert_eq!(restored.account, Some(known_account()));
        assert_eq!(restored.windows, fresh);
        assert_eq!(restored.source, Some("native_stream"));
    }
    #[tokio::test]
    async fn validated_identity_change_merges_with_another_process_newer_usage() {
        let mut changed_account = known_account();
        changed_account.plan = "Claude Enterprise".to_owned();
        for account in [None, Some(changed_account)] {
            let scratch = QuotaScratch::new();
            let mut old = persisted_fixture();
            old["collectedAt"] = json!(now_seconds() - 1);
            scratch.write(&old);
            let identity_process = scratch.state();
            assert_eq!(identity_process.cached_bound("account-a", || true).account, Some(known_account()));
            let fresh = QuotaWindows {
                five_hour: Some(QuotaWindow { used_percentage: 0.0, resets_at: None }),
                seven_day: None,
            };
            scratch.state().ingest_bound("account-a", fresh.clone());
            identity_process.read_bound("account-a", async {
                Ok(QuotaQueryResult { account: account.clone(), windows: Err("quota_not_available") })
            }, || true).await;
            let live = identity_process.cached_bound("account-a", || true);
            assert_eq!(live.windows, fresh);
            assert_eq!(live.account, account);
            let restored = scratch.state().cached_bound("account-a", || true);
            assert_eq!(restored.account, account);
            assert_eq!(restored.windows, fresh);
            assert_eq!(restored.source, Some("native_stream"));
            assert_ne!(restored.collected_at, old["collectedAt"].as_u64());
        }
    }
    #[tokio::test]
    async fn validated_missing_identity_clears_disk_identity_after_concurrent_passive_update() {
        let scratch = QuotaScratch::new();
        let state = scratch.state();
        state.read_bound("account-a", async { Ok(known_query()) }, || true).await;
        state.cache.lock().unwrap().last_attempt = None;
        let fresh = QuotaWindows {
            five_hour: Some(QuotaWindow { used_percentage: 0.0, resets_at: None }),
            seven_day: None,
        };
        state.read_bound("account-a", async {
            state.ingest_bound("account-a", fresh.clone());
            Ok(QuotaQueryResult { account: None, windows: Ok(known_window()) })
        }, || true).await;
        let restarted = scratch.state();
        assert_eq!(restarted.cached_bound("account-a", || true).account, None);
        restarted.ingest_bound("account-a", fresh.clone());
        let restored = scratch.state().cached_bound("account-a", || true);
        assert_eq!(restored.account, None);
        assert_eq!(restored.windows, fresh);
    }
    #[tokio::test]
    async fn auth_changes_cannot_overwrite_or_expose_persisted_identity() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let scratch = QuotaScratch::new();
        let original = persisted_fixture();
        scratch.write(&original);
        let state = scratch.state();
        let allowed = AtomicBool::new(true);
        let reply = state.read_bound("account-a", async {
            allowed.store(false, Ordering::SeqCst);
            Ok(known_query())
        }, || allowed.load(Ordering::SeqCst)).await;
        assert_eq!(reply.error_code, Some("auth_changed"));
        assert_eq!(reply.account, None);
        let checks = AtomicUsize::new(0);
        state.ingest_bound_checked("account-a", known_window(), || checks.fetch_add(1, Ordering::SeqCst) < 2);
        let unchanged: Value = serde_json::from_slice(&std::fs::read(scratch.path()).unwrap()).unwrap();
        assert_eq!(unchanged, original);
    }
    #[tokio::test]
    async fn persistence_preserves_new_passive_usage_when_manual_query_finishes_late() {
        for query_result in [Ok(known_query()), Err("query_timeout")] {
            let scratch = QuotaScratch::new();
            let state = scratch.state();
            let fresh = QuotaWindows {
                five_hour: Some(QuotaWindow { used_percentage: 0.0, resets_at: None }),
                seven_day: None,
            };
            let expected_account = query_result.as_ref().ok().and_then(|q| q.account.clone());
            state.read_bound("account-a", async {
                tokio::task::yield_now().await;
                state.ingest_bound("account-a", fresh.clone());
                query_result
            }, || true).await;
            let persisted = scratch.state().cached_bound("account-a", || true);
            assert_eq!(persisted.windows, fresh);
            assert_eq!(persisted.source, Some("native_stream"));
            assert_eq!(persisted.account, expected_account);
        }
    }
    #[tokio::test]
    async fn failed_persistence_keeps_live_account_and_usage_and_cleans_temporary_files() {
        let scratch = QuotaScratch::new();
        std::fs::create_dir(scratch.path()).unwrap(); // Rename over a directory must fail.
        let state = scratch.state();
        let loaded = state.read_bound("account-a", async { Ok(known_query()) }, || true).await;
        assert_eq!(loaded.account, Some(known_account()));
        assert_eq!(loaded.status, "ready");
        assert_eq!(state.cached_bound("account-a", || true), loaded);
        assert!(state.persist_cache(&mut state.cache.lock().unwrap(), false).is_err());
        assert_eq!(std::fs::read_dir(&scratch.0).unwrap().count(), 1);
        state.ingest_bound("account-a", known_window());
        assert_eq!(state.cached_bound("account-a", || true).account, loaded.account);
        assert_eq!(state.cached_bound("account-a", || true).source, Some("native_stream"));
    }
    #[test]
    fn older_live_observation_does_not_reverse_newer_persisted_observation() {
        let scratch = QuotaScratch::new();
        let latest = persisted_fixture();
        scratch.write(&latest);
        let state = scratch.state();
        let mut cache = state.cache.lock().unwrap();
        state.bind_cache(&mut cache, "account-a");
        let snapshot = cache.snapshot.as_mut().unwrap();
        snapshot.collected_at = Some(now_seconds() - 1);
        snapshot.windows.five_hour.as_mut().unwrap().used_percentage = 10.0;
        assert!(state.persist_cache(&mut cache, false).is_ok());
        let unchanged: Value = serde_json::from_slice(&std::fs::read(scratch.path()).unwrap()).unwrap();
        assert_eq!(unchanged, latest);
    }
    #[test]
    fn initialize_copies_only_native_subscription_display_fields() {
        let account = json!({
            "apiProvider": "firstParty", "email": "  reader@example.com  ",
            "subscriptionType": "Claude Team", "organization": "Workspace",
            "accessToken": "must-not-cross-ipc", "accountUuid": "private-id"
        });
        let parsed = parse_account(&json!({"account": account})).unwrap();
        assert_eq!(parsed, known_account());
        assert_eq!(serde_json::to_value(parsed).unwrap(), json!({
            "email": "reader@example.com", "plan": "Claude Team"
        }));
        for (field, value) in [
            ("apiProvider", json!("bedrock")),
            ("tokenSource", json!("none")),
            ("tokenSource", json!("CLAUDE_CODE_OAUTH_TOKEN")),
            ("apiKeySource", json!("/login managed key")),
            ("apiKeySource", json!(false)),
            ("subscriptionType", json!("Claude API")),
            ("subscriptionType", Value::Null),
            ("subscriptionType", json!(" ")),
            ("subscriptionType", json!("Claude Team\nspoof")),
            ("subscriptionType", json!("x".repeat(129))),
        ] {
            let mut altered = account.clone();
            altered[field] = value;
            assert!(parse_account(&json!({"account": altered})).is_none(), "{field}");
        }
        for email in [Value::Null, json!(""), json!("x".repeat(321)), json!("a\nb")] {
            let mut altered = account.clone();
            altered["email"] = email;
            let parsed = parse_account(&json!({"account": altered})).unwrap();
            assert_eq!(parsed.email, None);
            assert_eq!(parsed.plan, "Claude Team");
        }
        assert!(parse_account(&json!({})).is_none());
    }
    #[test]
    fn passive_updates_notify_and_cache_reads_never_wait_for_active_query() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let state = ClaudeQuotaState::default();
        let notifications = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&notifications);
        state.set_notifier(move || {
            count.fetch_add(1, Ordering::SeqCst);
        });
        state.ingest_bound("account-a", QuotaWindows::default());
        assert_eq!(notifications.load(Ordering::SeqCst), 0);
        state.ingest_bound("account-a", known_window());
        assert_eq!(notifications.load(Ordering::SeqCst), 1);
        let _active_query = state.query.try_lock().unwrap();
        let cached = state.cached_bound("account-a", || true);
        assert_eq!(cached.status, "ready");
        assert_eq!(cached.source, Some("native_stream"));
        assert_eq!(cached.windows, known_window());
        assert_eq!(notifications.load(Ordering::SeqCst), 1);
        let other = state.cached_bound("account-b", || true);
        assert_eq!(other.windows, QuotaWindows::default());
        assert_eq!(other.collected_at, None);
    }
    #[test]
    fn cache_only_reply_rechecks_auth_and_workspace_and_ages_without_network() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let state = ClaudeQuotaState::default();
        state.ingest_bound("account-a", known_window());
        let checks = AtomicUsize::new(0);
        let changed =
            state.cached_bound("account-a", || checks.fetch_add(1, Ordering::SeqCst) == 0);
        assert_eq!(changed.error_code, Some("auth_changed"));
        assert_eq!(changed.windows, QuotaWindows::default());
        let mut aged = state.cached_bound("account-a", || true);
        let at = aged.collected_at.unwrap();
        aged.expire(at + COOLDOWN.as_secs() + 1);
        assert_eq!(aged.status, "stale");
        assert!(aged.windows.five_hour.is_some());
        aged.expire(at + 601);
        assert_eq!(aged.status, "stale");
        assert!(aged.windows.five_hour.is_some());
        aged.expire(at + MAX_CACHE_AGE);
        assert_eq!(aged.status, "stale");
        assert!(aged.windows.five_hour.is_some());
        assert_eq!(aged.error_code, None);
    }

    #[test]
    fn explicit_quota_worker_does_not_inherit_the_essential_only_gate_or_enable_customizations() {
        let mut command = Command::new("not-executed");
        command.env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1");
        configure_quota_worker(&mut command);
        fixed_environment(&mut command);
        let env: std::collections::HashMap<_, _> = command.as_std().get_envs().collect();
        let lookup = |key: &str| {
            env.iter().find(|(name, _)| name.to_string_lossy().eq_ignore_ascii_case(key))
                .and_then(|(_, value)| *value).map(|value| value.to_string_lossy())
        };
        assert_eq!(lookup("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC").as_deref(), Some(""));
        for key in ["DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING", "DISABLE_AUTOUPDATER"] {
            assert_eq!(lookup(key).as_deref(), Some("1"));
        }
        assert_eq!(lookup("HTTPS_PROXY").as_deref(), Some(PROXY));
        assert_eq!(lookup("NO_PROXY").as_deref(), Some(NO_PROXY));
        let args: Vec<_> = command.as_std().get_args().map(|value| value.to_string_lossy()).collect();
        assert!(args.iter().any(|arg| arg == "--safe-mode"));
        assert!(args.iter().any(|arg| arg == "--disable-slash-commands"));
        assert!(args.windows(2).any(|pair| pair[0] == "--tools" && pair[1].is_empty()));
        let settings = args.windows(2).find(|pair| pair[0] == "--settings").unwrap();
        let settings: Value = serde_json::from_str(&settings[1]).unwrap();
        assert_eq!(settings["env"]["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"], "");
        assert_eq!(settings["env"]["DISABLE_TELEMETRY"], "1");
        assert!(settings["env"].as_object().unwrap().keys().all(|key| !AUTH_OVERRIDES.contains(&key.as_str())));
    }
    #[tokio::test]
    async fn older_manual_success_or_failure_cannot_overwrite_new_conversation_quota() {
        for query_result in [Ok(known_query()), Err("query_timeout")] {
            let expected_account = query_result.as_ref().ok().and_then(|query| query.account.clone());
            let state = ClaudeQuotaState::default();
            let fresh = QuotaWindows {
                five_hour: Some(QuotaWindow {
                    used_percentage: 0.0,
                    resets_at: None,
                }),
                seven_day: None,
            };
            let query = async {
                tokio::task::yield_now().await;
                state.ingest_bound("account-a", fresh.clone());
                query_result
            };
            let reply = state.read_bound("account-a", query, || true).await;
            assert_eq!(reply.windows, fresh);
            assert_eq!(reply.status, "ready");
            assert_eq!(reply.source, Some("native_stream"));
            assert_eq!(reply.error_code, None);
            assert_eq!(reply.account, expected_account);
            assert_eq!(state.cached_bound("account-a", || true).account, expected_account);
        }
    }
    #[tokio::test]
    async fn passive_reports_retain_account_and_allow_the_first_manual_identity_read() {
        let state = ClaudeQuotaState::default();
        state.ingest_bound("account-a", known_window());
        assert_eq!(state.cached_bound("account-a", || true).account, None);
        let loaded = state.read_bound("account-a", async { Ok(known_query()) }, || true).await;
        assert_eq!(loaded.account, Some(known_account()));
        state.ingest_bound("account-a", known_window());
        assert_eq!(state.cached_bound("account-a", || true).account, Some(known_account()));
        let cached = state.read_bound("account-a", async { panic!("active queries still obey cooldown") }, || true).await;
        assert_eq!(cached.account, Some(known_account()));
        assert_eq!(state.cached_bound("account-b", || true).account, None);
        state.ingest_bound("account-b", known_window());
        assert_eq!(state.cached_bound("account-b", || true).account, None);
    }
    #[tokio::test]
    async fn missing_identity_notifies_after_a_concurrent_usage_update_without_reverting_usage() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let state = ClaudeQuotaState::default();
        let notifications = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&notifications);
        state.set_notifier(move || { count.fetch_add(1, Ordering::SeqCst); });
        state.read_bound("account-a", async { Ok(known_query()) }, || true).await;
        state.cache.lock().unwrap().last_attempt = None;
        let fresh = QuotaWindows {
            five_hour: Some(QuotaWindow { used_percentage: 0.0, resets_at: None }),
            seven_day: None,
        };
        let latest = state.read_bound("account-a", async {
            state.ingest_bound("account-a", fresh.clone());
            Ok(QuotaQueryResult { account: None, windows: Ok(known_window()) })
        }, || true).await;
        assert_eq!(latest.windows, fresh);
        assert_eq!(latest.source, Some("native_stream"));
        assert_eq!(latest.account, None);
        assert_eq!(state.cached_bound("account-a", || true).account, None);
        assert_eq!(notifications.load(Ordering::SeqCst), 3);
    }
    #[tokio::test]
    async fn identity_and_usage_fail_independently_without_inventing_either() {
        let state = ClaudeQuotaState::default();
        let known = state.read_bound("account-a", async {
            Ok(QuotaQueryResult { account: Some(known_account()), windows: Err("quota_not_available") })
        }, || true).await;
        assert_eq!(known.status, "unavailable");
        assert_eq!(known.windows, QuotaWindows::default());
        assert_eq!(known.account, Some(known_account()));
        state.cache.lock().unwrap().last_attempt = None;
        let missing = state.read_bound("account-a", async {
            Ok(QuotaQueryResult { account: None, windows: Ok(known_window()) })
        }, || true).await;
        assert_eq!(missing.status, "ready");
        assert_eq!(missing.account, None);
        assert!(missing.windows.five_hour.is_some());
    }
    #[tokio::test]
    async fn auth_change_during_manual_query_discards_all_quota_data() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let state = ClaudeQuotaState::default();
        let allowed = AtomicBool::new(true);
        let reply = state
            .read_bound(
                "account-a",
                async {
                    allowed.store(false, Ordering::SeqCst);
                    Ok(known_query())
                },
                || allowed.load(Ordering::SeqCst),
            )
            .await;
        assert_eq!(reply.error_code, Some("auth_changed"));
        assert_eq!(reply.windows, QuotaWindows::default());
        assert_eq!(reply.account, None);
    }
    #[tokio::test]
    async fn manual_cache_change_notifies_other_composers_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let state = ClaudeQuotaState::default();
        let notifications = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&notifications);
        state.set_notifier(move || {
            count.fetch_add(1, Ordering::SeqCst);
        });
        state
            .read_bound("account-a", async { Ok(known_query()) }, || true)
            .await;
        assert_eq!(notifications.load(Ordering::SeqCst), 1);
        state
            .read_bound(
                "account-a",
                async { panic!("cooldown cannot query") },
                || true,
            )
            .await;
        assert_eq!(notifications.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn control_percent_and_stream_fraction_are_distinct() {
        let stream = |n| json!({"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{"five_hour":{"utilization":n,"resetsAt":2000000000}}}});
        assert_eq!(
            parse_stream(&stream(0.8), 0)
                .unwrap()
                .five_hour
                .unwrap()
                .used_percentage,
            80.0
        );
        assert!(parse_stream(&stream(80.0), 0).unwrap().five_hour.is_none());
        let control = |n| json!({"rate_limits_available":true,"rate_limits":{"five_hour":{"utilization":n,"resets_at":"2033-05-18T03:33:20Z"}}});
        assert_eq!(
            parse_control(&control(80.0), 0)
                .unwrap()
                .five_hour
                .unwrap()
                .used_percentage,
            80.0
        );
        assert_eq!(
            parse_control(&control(0.8), 0)
                .unwrap()
                .five_hour
                .unwrap()
                .used_percentage,
            0.8
        );
        assert_eq!(
            parse_control(&control(0.0), 0)
                .unwrap()
                .five_hour
                .unwrap()
                .used_percentage,
            0.0
        );
    }
    #[test]
    fn statusline_rate_limits_use_header_percent_and_unix_reset() {
        let event = json!({
            "type": "rate_limit_event",
            "rate_limits": {
                "five_hour": {"used_percentage": 42.5, "resets_at": 2_000_000_000},
                "seven_day": {"used_percentage": 15, "resets_at": 2_100_000_000}
            }
        });
        let parsed = parse_stream(&event, 0).unwrap();
        assert_eq!(parsed.five_hour.as_ref().unwrap().used_percentage, 42.5);
        assert_eq!(parsed.five_hour.as_ref().unwrap().resets_at, Some(2_000_000_000));
        assert_eq!(parsed.seven_day.as_ref().unwrap().used_percentage, 15.0);
        let token = "sk-ant-oat01-test-token";
        let stamp = oauth_quota_stamp(token).unwrap();
        assert!(!stamp.contains(token));
        assert_eq!(stamp.len(), "oauth:".len() + 64);
        let scratch = QuotaScratch::new();
        let state = scratch.state();
        state.ingest_bound_checked(&stamp, parsed.clone(), || true);
        assert_eq!(state.cached_bound(&stamp, || true).windows, parsed);
        let raw = std::fs::read_to_string(scratch.path()).unwrap();
        assert!(!raw.contains(token));
    }
    #[test]
    fn null_unknown_malformed_and_expired_windows_never_invent_zero() {
        for limits in [
            Value::Null,
            json!({}),
            json!({"other":{"utilization":10}}),
            json!({"five_hour":{"utilization":null}}),
            json!({"five_hour":{"utilization":-1}}),
            json!({"five_hour":{"utilization":101}}),
            json!({"five_hour":{"utilization":50,"resets_at":"2026-02-30T00:00:00Z"}}),
        ] {
            assert_eq!(
                parse_control(
                    &json!({"rate_limits_available":true,"rate_limits":limits}),
                    0
                )
                .unwrap(),
                QuotaWindows::default()
            );
        }
        assert_eq!(
            parse_control(&json!({"rate_limits_available":true}), 0),
            Err("unsupported_response")
        );
        assert_eq!(
            parse_control(&json!({"rate_limits_available":false,"rate_limits":{}}), 0),
            Err("quota_not_available")
        );
        assert!(window(&json!({"utilization":0.5,"resetsAt":10}), true, 10).is_none());
        assert!(window(&json!({"utilization":0.5,"resetsAt":-1}), true, 0).is_none());
        let without_reset = window(&json!({"utilization":0.0,"resets_at":null}), false, 0).unwrap();
        assert_eq!(without_reset.resets_at, None);
    }
    #[test]
    fn strict_calendar_and_offsets() {
        assert_eq!(parse_iso8601("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso8601("1970-01-01T08:00:00.123+08:00"), Some(0));
        assert_eq!(parse_iso8601("2033-05-18T03:33:20Z"), Some(2000000000));
        for bad in [
            "2026-02-29T00:00:00Z",
            "2026-01-01T24:00:00Z",
            "2026-01-01T00:00:00",
            "2026-01-01T00:00:00+24:00",
            "２０２６-01-01T00:00:00Z",
        ] {
            assert!(parse_iso8601(bad).is_none(), "{bad}");
        }
    }
    #[test]
    fn every_guard_requires_success_and_ready_true() {
        assert!(guard_ready(true, br#"{"ready":true}"#));
        assert!(!guard_ready(true, br#"{"ready":false}"#));
        assert!(!guard_ready(false, br#"{"ready":true}"#));
        assert!(!guard_ready(true, br#"{"status":"ready"}"#));
        assert!(!guard_ready(true, br#"diagnostic\n{"ready":true}"#));
        assert!(!guard_ready(true, &vec![b' '; MAX_OUTPUT + 1]));
    }
    #[test]
    fn fixed_proxy_replaces_bypasses_without_switching_auth_accounts() {
        let mut cmd = Command::new("not-executed");
        cmd.env("HTTPS_PROXY", "https://unsafe.example")
            .env("NO_PROXY", "*")
            .env("no_proxy", "*")
            .env("ANTHROPIC_API_KEY", "not-a-secret");
        fixed_environment(&mut cmd);
        let env: std::collections::HashMap<_, _> = cmd
            .as_std()
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();
        // Windows environment names compare case-insensitively; Unix retains both.
        let lookup = |key: &str| {
            env.iter()
                .find(|(name, _)| name.eq_ignore_ascii_case(key))
                .unwrap()
                .1
                .as_deref()
        };
        for key in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ] {
            assert_eq!(lookup(key), Some(PROXY));
        }
        for key in ["NO_PROXY", "no_proxy"] {
            assert_eq!(lookup(key), Some(NO_PROXY));
        }
        assert_eq!(env["ANTHROPIC_API_KEY"].as_deref(), Some("not-a-secret"));
    }
    #[test]
    fn alternate_auth_channels_are_rejected_instead_of_silently_replaced() {
        assert!(!auth_env_is_default(Some(
            &serde_json::json!({"anthropic_api_key":"alternate-context"})
        )));
        assert!(auth_env_is_default(None));
        assert!(auth_env_is_default(Some(
            &serde_json::json!({"HTTPS_PROXY": PROXY})
        )));
        for key in AUTH_OVERRIDES {
            let mut env = serde_json::Map::new();
            env.insert(
                (*key).to_owned(),
                Value::String("alternate-context".to_owned()),
            );
            assert!(!auth_env_is_default(Some(&Value::Object(env))), "{key}");
        }
        assert!(!local_workspace_auth_is_default(std::path::Path::new(
            "wsl://Ubuntu/project"
        )));
        assert!(!local_workspace_auth_is_default(std::path::Path::new(
            "ssh://server/project"
        )));
    }
    #[tokio::test]
    async fn cached_reply_rechecks_channel_after_the_cache_lock() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let state = ClaudeQuotaState::default();
        {
            let mut cache = state.cache.lock().unwrap();
            cache.bind("test-account");
            cache.last_attempt = Some(Instant::now());
            cache.snapshot = Some(ClaudeQuotaSnapshot {
                status: "ready",
                account: Some(known_account()),
                windows: QuotaWindows {
                    five_hour: Some(QuotaWindow {
                        used_percentage: 20.0,
                        resets_at: None,
                    }),
                    seven_day: None,
                },
                collected_at: Some(now_seconds()),
                source: Some("native_stream"),
                error_code: None,
            });
        }
        let checks = AtomicUsize::new(0);
        let reply = state
            .read_bound(
                "test-account",
                async {
                    panic!("cached read must not query");
                },
                || checks.fetch_add(1, Ordering::SeqCst) == 0,
            )
            .await;
        assert_eq!(reply.status, "unavailable");
        assert_eq!(reply.error_code, Some("auth_changed"));
        assert_eq!(reply.windows, QuotaWindows::default());
        assert_eq!(reply.account, None);
    }
    #[tokio::test]
    async fn matching_frame_eof_errors_and_output_cap() {
        let frames = b"{\"type\":\"control_response\",\"response\":{\"request_id\":\"other\",\"subtype\":\"success\"}}\n{\"type\":\"control_response\",\"response\":{\"request_id\":\"quota-read\",\"subtype\":\"success\",\"response\":{\"rate_limits_available\":true,\"rate_limits\":null}}}\n";
        let mut reader = &frames[..];
        let mut budget = MAX_OUTPUT;
        assert_eq!(
            matching_response(&mut reader, "quota-read", &mut budget)
                .await
                .unwrap()["rate_limits"],
            Value::Null
        );
        for (bytes,code) in [(b"".as_slice(),"unexpected_eof"), (b"malformed\n".as_slice(),"unsupported_response"), (b"{\"type\":\"assistant\"}\n".as_slice(),"unexpected_inference"), (b"{\"type\":\"control_response\",\"response\":{\"request_id\":\"quota-read\",\"subtype\":\"error\"}}\n".as_slice(),"unsupported_control")] {
            let mut reader=bytes; let mut budget=MAX_OUTPUT;
            assert_eq!(matching_response(&mut reader,"quota-read",&mut budget).await,Err(code));
        }
        let oversized = vec![b' '; MAX_OUTPUT + 1];
        let mut reader = &oversized[..];
        let mut budget = MAX_OUTPUT;
        assert_eq!(
            matching_response(&mut reader, "quota-read", &mut budget).await,
            Err("output_limit")
        );
    }
    #[tokio::test]
    async fn coalescing_cooldown_error_preservation_and_account_isolation() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let calls = AtomicUsize::new(0);
        let state = ClaudeQuotaState::default();
        let query = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Ok(known_query())
        };
        let (one, two) = tokio::join!(
            state.read_bound("account-a", query(), || true),
            state.read_bound("account-a", query(), || true)
        );
        assert_eq!(one, two);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        state.cache.lock().unwrap().last_attempt = None;
        let failed = state
            .read_bound("account-a", async { Err("protection_unavailable") }, || {
                true
            })
            .await;
        assert_eq!(failed.status, "stale");
        assert_eq!(failed.windows, one.windows);
        assert_eq!(failed.account, one.account);
        let cooldown = state
            .read_bound(
                "account-a",
                async { panic!("cooldown must not query") },
                || true,
            )
            .await;
        assert_eq!(failed, cooldown);
        let other = state
            .read_bound("account-b", async { Err("query_timeout") }, || true)
            .await;
        assert_eq!(other.status, "unavailable");
        assert_eq!(other.windows, QuotaWindows::default());
        assert_eq!(other.collected_at, None);
        assert_eq!(other.account, None);
        let changed = state
            .read_bound(
                "account-c",
                async { panic!("invalid stamp must not query") },
                || false,
            )
            .await;
        assert_eq!(changed.error_code, Some("auth_changed"));
    }
    #[tokio::test]
    async fn null_query_preserves_fresh_stream_and_drops_expired_windows() {
        let state = ClaudeQuotaState::default();
        let known = state
            .read_bound("a", async { Ok(known_query()) }, || true)
            .await;
        state.cache.lock().unwrap().last_attempt = None;
        let missing = state
            .read_bound("a", async { Ok(QuotaQueryResult { account: Some(known_account()), windows: Ok(QuotaWindows::default()) }) }, || true)
            .await;
        assert_eq!(missing.status, "stale");
        assert_eq!(missing.windows, known.windows);
        let mut expired = missing.clone();
        expired.expire(now_seconds() + 3600);
        assert_eq!(expired.windows, known.windows);
        assert_eq!(expired.status, "stale");
        let mut old = missing;
        old.collected_at = Some(0);
        old.expire(MAX_CACHE_AGE + 1);
        assert_eq!(old.windows, known.windows);
    }
    #[tokio::test(start_paused = true)]
    async fn query_deadline_returns_error_and_preserves_known_snapshot() {
        let state = ClaudeQuotaState::default();
        let known = state
            .read_bound("a", async { Ok(known_query()) }, || true)
            .await;
        state.cache.lock().unwrap().last_attempt = None;
        let result = state.read_bound("a", std::future::pending(), || true).await;
        assert_eq!(result.error_code, Some("query_timeout"));
        assert_eq!(result.status, "stale");
        assert_eq!(result.windows, known.windows);
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn ready_false_exit_zero_blocks_next_worker_and_timeout_drops_owned_process() {
        let powershell = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut gate = Command::new(&powershell);
        gate.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[Console]::Write('{\"ready\":false}'); exit 0",
        ]);
        let mut launched = false;
        let guarded = async {
            run_guard(gate).await?;
            launched = true;
            Ok::<(), &'static str>(())
        }
        .await;
        assert_eq!(guarded, Err("protection_unavailable"));
        assert!(!launched);
        let pid = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let reported = Arc::clone(&pid);
        let timeout = tokio::time::timeout(Duration::from_millis(100), async {
            let mut fake = Command::new(powershell);
            fake.args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 60",
            ]);
            let mut owned = OwnedWorker::spawn(fake).unwrap();
            reported.store(
                owned.child.id().unwrap(),
                std::sync::atomic::Ordering::SeqCst,
            );
            let _ = owned.child.wait().await;
        })
        .await;
        assert!(timeout.is_err());
        let pid = sysinfo::Pid::from_u32(pid.load(std::sync::atomic::Ordering::SeqCst));
        assert_ne!(pid.as_u32(), 0);
        let mut system = sysinfo::System::new();
        for _ in 0..80 {
            system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
            if system.process(pid).is_none() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("owned worker survived timeout");
    }
}
#[tauri::command]
pub async fn claude_quota_read(
    state: tauri::State<'_, Arc<ClaudeQuotaState>>,
    provider_id: Option<String>,
    force: Option<bool>,
    cache_only: Option<bool>,
    workspace_path: Option<String>,
) -> Result<ClaudeQuotaSnapshot, String> {
    // 【对话额度】force 只保留 IPC 兼容，不能再触发 CLI。
    let _ = force;
    if workspace_path
        .as_ref()
        .is_some_and(|path| !local_workspace_auth_is_default(std::path::Path::new(path)))
    {
        return Ok(ClaudeQuotaSnapshot::unavailable("unsupported_auth_context"));
    }
    // 【对话额度】force 与 cache_only 都不再启动 CLI。调用方只拿到对话缓存。
    Ok(tokio::time::timeout(
        Duration::from_secs(29),
        state.read(
            provider_id.as_deref(),
            cache_only.unwrap_or(false),
            workspace_path.as_deref().map(std::path::Path::new),
        ),
    )
    .await
    .unwrap_or_else(|_| ClaudeQuotaSnapshot::unavailable("query_timeout")))
}
