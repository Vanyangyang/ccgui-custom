//! Account quotas come from Codex's official app-server, independently of token usage.
//! Cache keys use auth metadata and normalized configuration hashes; credentials never leave the CLI.
use crate::claude_quota::{QuotaAccount, QuotaWindow, QuotaWindows};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
mod persistence;

const COOLDOWN: Duration = Duration::from_secs(120);
const MAX_CACHE_AGE: u64 = 3600;
const MAX_BINDINGS: usize = 16;
pub(crate) const OBSERVATION_EVENT: &str = "codex-quota://observation";

/// Only validated percentages/timestamps cross the worker boundary. No auth
/// paths, account identity, raw app-server params or credentials enter a journal.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Observation {
    stamp: String,
    observed_at_ms: u64,
    update: ObservationUpdate,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum ObservationUpdate {
    Limits { windows: QuotaWindows },
    AccountChanged,
}

/// Read-only credit balance. The balance string is display text from the
/// official usage read and is validated before it crosses IPC.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexCredits {
    pub has_credits: bool,
    pub unlimited: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balance: Option<String>,
}

/// Count of available rate-limit reset chances. This module never redeems one.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexResetCredits {
    pub available_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_expires_at: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexQuotaSnapshot {
    pub status: &'static str,
    pub windows: QuotaWindows,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<QuotaAccount>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credits: Option<CodexCredits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset_credits: Option<CodexResetCredits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collected_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<&'static str>,
}

impl CodexQuotaSnapshot {
    fn unavailable(code: &'static str) -> Self {
        Self {
            status: "unavailable",
            error_code: Some(code),
            ..Default::default()
        }
    }

    fn expire(&mut self, now: u64) {
        if self.collected_at.is_none_or(|at| at > now) {
            self.windows = QuotaWindows::default();
        }
        if self.collected_at.is_none_or(|at| at > now || now - at >= MAX_CACHE_AGE) {
            self.credits = None;
            self.reset_credits = None;
        }
        if self.windows == QuotaWindows::default() {
            self.status = "unavailable";
            self.error_code.get_or_insert("quota_not_available");
        } else if [&self.windows.five_hour, &self.windows.seven_day]
            .into_iter().flatten().any(|w| w.resets_at.is_some_and(|at| at <= now))
            || self
            .collected_at
            .is_some_and(|at| at > now || now.saturating_sub(at) >= COOLDOWN.as_secs())
        {
            self.status = "stale";
        }
    }
}

#[derive(Default)]
pub(crate) struct QueryResult {
    pub windows: QuotaWindows,
    pub account: Option<QuotaAccount>,
    pub credits: Option<CodexCredits>,
    pub reset_credits: Option<CodexResetCredits>,
}

#[derive(Clone)]
pub(crate) struct Binding {
    stamp: String,
    provider: Option<String>,
    pub home: PathBuf,
    pub workspace: PathBuf,
}

impl Binding {
    pub(crate) fn current(&self) -> bool {
        binding(self.provider.as_deref(), Some(&self.workspace))
            .is_ok_and(|other| other.stamp == self.stamp)
    }
}

fn native_provider(provider: Option<&str>) -> bool {
    let Ok(config) = crate::config::read_config() else {
        return false;
    };
    let Some(section) = config.section("codex") else {
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

/// Validate the effective provider too: a local channel can still select a relay.
pub(crate) fn official_config(config: &Value) -> bool {
    let Some(object) = config.as_object() else {
        return false;
    };
    // Keyring/auto/external auth may change without touching auth.json. Do not
    // reuse account labels or usage when this metadata binding cannot verify it.
    if object
        .get("cli_auth_credentials_store")
        .is_some_and(|v| !v.is_null() && v.as_str() != Some("file"))
    {
        return false;
    }
    if object
        .get("model_provider")
        .is_some_and(|v| !v.is_null() && v.as_str() != Some("openai"))
    {
        return false;
    }
    if object.get("chatgpt_base_url").is_some_and(|v| {
        !v.is_null()
            && !matches!(
                v.as_str(),
                Some("https://chatgpt.com/backend-api") | Some("https://chatgpt.com/backend-api/")
            )
    }) {
        return false;
    }
    if let Some(provider) = config.pointer("/model_providers/openai") {
        if !provider.is_object()
            || [
                "base_url",
                "env_key",
                "experimental_bearer_token",
                "http_headers",
                "env_http_headers",
                "auth",
            ]
            .iter()
            .any(|key| provider.get(key).is_some_and(|v| !v.is_null()))
            || provider
                .get("requires_openai_auth")
                .and_then(Value::as_bool)
                == Some(false)
        {
            return false;
        }
    }
    if let Some(profile) = object.get("profile").and_then(Value::as_str) {
        let Some(selected) = config.get("profiles").and_then(|p| p.get(profile)) else {
            return false;
        };
        if selected.get("profile").is_some() || !official_config(selected) {
            return false;
        }
    }
    true
}

fn stamp_file(stamp: &mut String, path: &Path) -> Result<(), &'static str> {
    stamp.push_str(&path.to_string_lossy());
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => {
            stamp.push_str(&format!("|{}:{:?};", meta.len(), meta.modified().ok()))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => stamp.push_str("|missing;"),
        _ => return Err("auth_metadata_unavailable"),
    }
    Ok(())
}

fn stamp_config(stamp: &mut String, path: &Path) -> Result<(), &'static str> {
    stamp.push_str(&path.to_string_lossy());
    match std::fs::read_to_string(path) {
        Ok(text) => {
            let config: toml::Value =
                toml::from_str(&text).map_err(|_| "unsupported_auth_context")?;
            let mut value = serde_json::to_value(config).map_err(|_| "unsupported_auth_context")?;
            if !official_config(&value) {
                return Err("provider_auth_unavailable");
            }
            strip_display_model_options(&mut value);
            let normalized = serde_json::to_vec(&value).map_err(|_| "unsupported_auth_context")?;
            stamp.push_str(&format!("|{:x};", Sha256::digest(normalized)));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => stamp.push_str("|missing;"),
        Err(_) => return Err("auth_metadata_unavailable"),
    }
    Ok(())
}

fn strip_display_model_options(config: &mut Value) {
    let Some(object) = config.as_object_mut() else { return; };
    for key in ["model", "model_reasoning_effort", "model_reasoning_summary", "model_verbosity", "service_tier"] {
        object.remove(key);
    }
    if let Some(profiles) = object.get_mut("profiles").and_then(Value::as_object_mut) {
        for profile in profiles.values_mut() {
            strip_display_model_options(profile);
        }
    }
}

pub(crate) fn binding(
    provider: Option<&str>,
    workspace: Option<&Path>,
) -> Result<Binding, &'static str> {
    if !native_provider(provider) {
        return Err("custom_channel");
    }
    // These override the native account/provider independently of the GUI channel.
    if [
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "CODEX_API_KEY",
        "CODEX_ACCESS_TOKEN",
        "CHATGPT_BASE_URL",
    ]
    .iter()
    .any(|name| std::env::var_os(name).is_some_and(|v| !v.is_empty()))
    {
        return Err("provider_auth_unavailable");
    }
    let home = crate::engine::codex_home();
    if !home.join("auth.json").is_file() {
        return Err("auth_metadata_unavailable");
    }
    let workspace = workspace.unwrap_or(&home);
    let name = workspace.to_string_lossy().to_lowercase();
    if name.starts_with("wsl:")
        || name.starts_with("ssh:")
        || name.starts_with("\\\\wsl")
        || !workspace.is_absolute()
    {
        return Err("unsupported_auth_context");
    }
    let workspace = std::fs::canonicalize(workspace).map_err(|_| "unsupported_auth_context")?;
    let mut stamp = format!("{}|{}|", home.display(), workspace.display());
    stamp_file(&mut stamp, &home.join("auth.json"))?;
    stamp_config(&mut stamp, &home.join("config.toml"))?;
    // Project config can override the native account route. Include all ancestors
    // so changing/removing an identity-relevant override invalidates old snapshots immediately.
    for ancestor in workspace.ancestors() {
        let config = ancestor.join(".codex/config.toml");
        if config != home.join("config.toml") {
            stamp_config(&mut stamp, &config)?;
        }
    }
    Ok(Binding {
        stamp: format!("{:x}", Sha256::digest(stamp.as_bytes())),
        provider: provider.map(str::to_owned),
        home,
        workspace,
    })
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn parse_window(value: &Value, now: u64) -> Option<(u64, QuotaWindow)> {
    let duration = value.get("windowDurationMins")?.as_u64()?;
    if !matches!(duration, 300 | 10080) {
        return None;
    }
    let used = value.get("usedPercent")?.as_f64()?;
    if !used.is_finite() || !(0.0..=100.0).contains(&used) {
        return None;
    }
    let reset = match value.get("resetsAt").filter(|v| !v.is_null()) {
        Some(value) => {
            let time = value.as_u64()?;
            // JavaScript Date range; epoch seconds must remain representable.
            if time <= now || time > 8_640_000_000_000 {
                return None;
            }
            Some(time)
        }
        None => None,
    };
    Some((
        duration,
        QuotaWindow {
            used_percentage: used,
            resets_at: reset,
        },
    ))
}

/// Only the Codex bucket is relevant; never combine a model-specific bucket
/// with the main subscription or assume that `secondary` always means weekly.
pub(crate) fn parse_limits(value: &Value, now: u64) -> Option<QuotaWindows> {
    let limits = if let Some(buckets) = value.get("rateLimitsByLimitId").filter(|v| !v.is_null()) {
        buckets.get("codex")?
    } else {
        value.get("rateLimits")?
    };
    if limits
        .get("limitId")
        .and_then(Value::as_str)
        .is_some_and(|id| id != "codex")
    {
        return None;
    }
    if !limits.is_object() {
        return None;
    }
    let mut windows = QuotaWindows::default();
    for key in ["primary", "secondary"] {
        if let Some((duration, window)) = limits.get(key).and_then(|v| parse_window(v, now)) {
            let slot = if duration == 300 {
                &mut windows.five_hour
            } else {
                &mut windows.seven_day
            };
            // Contradictory duplicate windows cannot be shown as an exact value.
            if slot.is_some() {
                return None;
            }
            *slot = Some(window);
        }
    }
    Some(windows)
}

/// Credit balance and reset-chance count from the usage read. Both are
/// informational: absence stays `None` and is never shown as zero.
pub(crate) fn parse_credits(
    value: &Value,
    now: u64,
) -> (Option<CodexCredits>, Option<CodexResetCredits>) {
    let bucket = if let Some(buckets) = value.get("rateLimitsByLimitId").filter(|v| !v.is_null()) {
        buckets.get("codex")
    } else {
        value.get("rateLimits")
    };
    let credits = bucket
        .and_then(|b| b.get("credits"))
        .filter(|c| c.is_object())
        .and_then(|c| {
            let has_credits = c.get("hasCredits")?.as_bool()?;
            let unlimited = c.get("unlimited").and_then(Value::as_bool).unwrap_or(false);
            let balance = c
                .get("balance")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|b| {
                    !b.is_empty()
                        && b.len() <= 32
                        && b.chars().all(|ch| ch.is_ascii_digit() || matches!(ch, '.' | '-' | ','))
                })
                .map(str::to_owned);
            Some(CodexCredits { has_credits, unlimited, balance })
        });
    let reset_credits = value
        .get("rateLimitResetCredits")
        .filter(|v| v.is_object())
        .and_then(|summary| {
            let available_count = summary.get("availableCount")?.as_u64()?;
            let next_expires_at = summary
                .get("credits")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|c| c.get("status").and_then(Value::as_str) == Some("available"))
                .filter_map(|c| c.get("expiresAt").and_then(Value::as_u64))
                .filter(|at| *at > now && *at <= 8_640_000_000_000)
                .min();
            Some(CodexResetCredits { available_count, next_expires_at })
        });
    (credits, reset_credits)
}

pub(crate) fn parse_account(value: &Value) -> Result<Option<QuotaAccount>, &'static str> {
    let account = value.get("account").ok_or("provider_auth_unavailable")?;
    if account.get("type").and_then(Value::as_str) != Some("chatgpt") {
        return Err("provider_auth_unavailable");
    }
    let Some(plan) = account
        .get("planType")
        .and_then(Value::as_str)
        .filter(|p| !p.trim().is_empty() && p.len() <= 128)
    else {
        return Ok(None);
    };
    let email = account
        .get("email")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && s.len() <= 320)
        .map(str::to_owned);
    Ok(Some(QuotaAccount {
        email,
        plan: plan.to_owned(),
    }))
}

#[derive(Default)]
struct Entry {
    binding: Option<Binding>,
    snapshot: Option<CodexQuotaSnapshot>,
    observed_at_ms: u64,
    auth_checked_at_ms: u64,
    last_attempt: Option<Instant>,
    revision: u64,
    auth_revision: u64,
    verified: bool,
    identity_hash: Option<String>,
}

#[derive(Default)]
pub struct CodexQuotaState {
    cache: Mutex<HashMap<String, Entry>>,
    query: tokio::sync::Mutex<()>,
    changed: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
    persistence_path: Option<PathBuf>,
    persistence_enabled: std::sync::atomic::AtomicBool,
    persistence_loaded: std::sync::atomic::AtomicBool,
    persistence_warned: std::sync::atomic::AtomicBool,
}
pub static STATE: LazyLock<Arc<CodexQuotaState>> =
    LazyLock::new(|| Arc::new(CodexQuotaState {
        persistence_path: if cfg!(any(test, feature = "test-harness")) {
            None
        } else if crate::paths::is_dev_profile() || dirs::home_dir().is_some() {
            Some(crate::paths::app_home().join("codex-quota-cache.json"))
        } else { None },
        ..Default::default()
    }));

fn identity_hash(account: Option<&QuotaAccount>) -> Option<String> {
    account.and_then(|a| a.email.as_ref())
        .map(|email| format!("{:x}", Sha256::digest(email.as_bytes())))
}

fn merge_account(old: Option<&QuotaAccount>, new: Option<QuotaAccount>) -> Option<QuotaAccount> {
    new.map(|mut account| {
        if account.email.is_none() { account.email = old.and_then(|a| a.email.clone()); }
        account
    }).or_else(|| old.cloned())
}

/// Missing windows retain their original age, never the newer window's age.
fn merge_windows(old: Option<&CodexQuotaSnapshot>, mut windows: QuotaWindows, at: u64)
    -> (QuotaWindows, u64, bool)
{
    let mut retained = false;
    if let Some(old) = old {
        for (new, previous) in [(&mut windows.five_hour, &old.windows.five_hour),
            (&mut windows.seven_day, &old.windows.seven_day)] {
            if new.is_none() && previous.is_some() {
                *new = previous.clone();
                retained = true;
            }
        }
        if retained { return (windows, old.collected_at.unwrap_or(at).min(at), true); }
    }
    (windows, at, false)
}

pub(crate) fn install_events(app: &tauri::AppHandle) {
    use crate::event_sink::Emit;
    use tauri::Manager;
    // Only the native host owns the disk cache. Workers publish sanitized
    // observations; they must never restore or overwrite host persistence.
    STATE.persistence_enabled.store(true, std::sync::atomic::Ordering::Relaxed);
    let emitters = Arc::clone(&app.state::<crate::AppState>().emitters);
    *STATE.changed.lock().unwrap_or_else(|p| p.into_inner()) = Some(Box::new(move || {
        emitters.emit_json("codex-quota://changed", "null");
    }));
}

impl CodexQuotaState {
    fn discard_binding(&self, stamp: &str) {
        let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
        self.restore(&mut cache);
        cache.remove(stamp);
        self.persist(&cache);
    }

    fn register_binding(&self, binding: &Binding) {
        let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
        self.restore(&mut cache);
        if cache.len() >= MAX_BINDINGS && !cache.contains_key(&binding.stamp) {
            if let Some(oldest) = cache.iter().min_by_key(|(_, entry)| entry.last_attempt).map(|(key, _)| key.clone()) {
                cache.remove(&oldest);
            }
        }
        cache.entry(binding.stamp.clone()).or_default().binding = Some(binding.clone());
    }

    fn notify(&self) {
        if let Some(callback) = self
            .changed
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
        {
            callback();
        }
    }

    fn cached(&self, stamp: &str, current: impl Fn() -> bool) -> CodexQuotaSnapshot {
        if !current() {
            self.invalidate_account_at(stamp, now_millis());
            return CodexQuotaSnapshot::unavailable("auth_changed");
        }
        let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
        self.restore(&mut cache);
        let mut result = cache.get(stamp)
            .and_then(|entry| entry.snapshot.clone())
            .unwrap_or_else(|| CodexQuotaSnapshot::unavailable("not_loaded"));
        drop(cache);
        result.expire(now_seconds());
        if !current() {
            self.invalidate_account_at(stamp, now_millis());
            return CodexQuotaSnapshot::unavailable("auth_changed");
        }
        result
    }

    #[cfg(test)]
    fn ingest(&self, stamp: &str, windows: QuotaWindows, current: impl Fn() -> bool) {
        self.ingest_at(stamp, windows, now_millis(), current);
    }

    fn ingest_at(
        &self,
        stamp: &str,
        windows: QuotaWindows,
        observed_at_ms: u64,
        current: impl Fn() -> bool,
    ) {
        // A sparse notification with no supported window is not a revocation.
        // Keep the last validated sample and its original freshness timestamp.
        if windows == QuotaWindows::default() || !current() {
            return;
        }
        {
            let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
            // A query must first verify the effective config and ChatGPT auth.
            let Some(entry) = cache.get_mut(stamp).filter(|e| e.verified) else {
                return;
            };
            if observed_at_ms < entry.observed_at_ms || !current() {
                return;
            }
            let (windows, collected_at, retained) = merge_windows(entry.snapshot.as_ref(), windows, observed_at_ms / 1000);
            entry.snapshot = Some(CodexQuotaSnapshot {
                status: if retained { "stale" } else { "ready" },
                windows,
                account: entry.snapshot.as_ref().and_then(|s| s.account.clone()),
                credits: entry.snapshot.as_ref().and_then(|s| s.credits.clone()),
                reset_credits: entry.snapshot.as_ref().and_then(|s| s.reset_credits.clone()),
                collected_at: Some(collected_at),
                source: Some("codex_app_server"),
                error_code: None,
            });
            entry.revision = entry.revision.wrapping_add(1);
            entry.observed_at_ms = observed_at_ms;
            self.persist(&cache);
        }
        self.notify();
    }

    async fn read_bound(
        &self,
        stamp: &str,
        query: impl std::future::Future<Output = Result<QueryResult, &'static str>>,
        current: impl Fn() -> bool,
    ) -> CodexQuotaSnapshot {
        let _query = self.query.lock().await;
        if !current() {
            self.discard_binding(stamp);
            return CodexQuotaSnapshot::unavailable("auth_changed");
        }
        let (revision, auth_revision, query_started_at_ms) = {
            let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
            self.restore(&mut cache);
            if cache.len() >= MAX_BINDINGS && !cache.contains_key(stamp) {
                if let Some(oldest) = cache.iter().min_by_key(|(_, entry)| entry.last_attempt).map(|(key, _)| key.clone()) {
                    cache.remove(&oldest);
                }
            }
            let entry = cache.entry(stamp.to_owned()).or_default();
            if entry.last_attempt.is_some_and(|at| at.elapsed() < COOLDOWN) {
                drop(cache);
                return self.cached(stamp, current);
            }
            entry.last_attempt = Some(Instant::now());
            (entry.revision, entry.auth_revision, now_millis())
        };
        let result = tokio::time::timeout(Duration::from_secs(25), query)
            .await
            .unwrap_or(Err("query_timeout"));
        if !current() {
            self.discard_binding(stamp);
            return CodexQuotaSnapshot::unavailable("auth_changed");
        }
        let snapshot = {
            let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
            if !current() {
                cache.remove(stamp);
                self.persist(&cache);
                return CodexQuotaSnapshot::unavailable("auth_changed");
            }
            let entry = cache.entry(stamp.to_owned()).or_default();
            if entry.auth_revision != auth_revision {
                return CodexQuotaSnapshot::unavailable("auth_changed");
            }
            let snapshot = match result {
                Ok(result) => {
                    let new_identity = identity_hash(result.account.as_ref());
                    let identity_changed = entry.identity_hash.as_ref().zip(new_identity.as_ref())
                        .is_some_and(|(old, new)| old != new);
                    if identity_changed {
                        entry.snapshot = None;
                    }
                    if new_identity.is_some() { entry.identity_hash = new_identity; }
                    let account = merge_account(entry.snapshot.as_ref().and_then(|s| s.account.as_ref()), result.account);
                    entry.verified = true;
                    // Worker delivery can lag behind the query. Observations
                    // created during it remain newer than its baseline, even
                    // when they arrive after this future has completed.
                    entry.observed_at_ms = entry.observed_at_ms.max(query_started_at_ms);
                    entry.auth_checked_at_ms = query_started_at_ms;
                    if entry.revision != revision && !identity_changed {
                        let mut latest = entry
                            .snapshot
                            .clone()
                            .unwrap_or_else(|| CodexQuotaSnapshot::unavailable("not_loaded"));
                        // Passive data wins wherever present, but a partial
                        // notification must not discard another query window.
                        let baseline = CodexQuotaSnapshot {
                            windows: result.windows,
                            collected_at: Some(query_started_at_ms / 1000),
                            ..Default::default()
                        };
                        let (windows, at, filled) = merge_windows(
                            Some(&baseline), std::mem::take(&mut latest.windows),
                            latest.collected_at.unwrap_or(query_started_at_ms / 1000),
                        );
                        latest.windows = windows;
                        if filled {
                            latest.collected_at = Some(at);
                            latest.status = "stale";
                        }
                        latest.account = account;
                        latest.credits = result.credits;
                        latest.reset_credits = result.reset_credits;
                        latest
                    } else if result.windows == QuotaWindows::default() {
                        // A successful account read with sparse limits does not
                        // replace the last usage sample or renew its timestamp.
                        let mut latest = entry.snapshot.clone()
                            .unwrap_or_else(|| CodexQuotaSnapshot::unavailable("quota_not_available"));
                        latest.account = account;
                        latest.credits = result.credits;
                        latest.reset_credits = result.reset_credits;
                        latest.status = "stale";
                        latest
                    } else {
                        let (windows, collected_at, retained) = merge_windows(entry.snapshot.as_ref(), result.windows, now_seconds());
                        CodexQuotaSnapshot {
                            status: if retained { "stale" } else { "ready" },
                            windows,
                            account,
                            credits: result.credits,
                            reset_credits: result.reset_credits,
                            collected_at: Some(collected_at),
                            source: Some("codex_app_server"),
                            error_code: None,
                        }
                    }
                }
                Err(code)
                    if matches!(
                        code,
                        "provider_auth_unavailable" | "unsupported_auth_context" | "auth_changed"
                    ) =>
                {
                    entry.verified = false;
                    entry.identity_hash = None;
                    entry.observed_at_ms = entry.observed_at_ms.max(query_started_at_ms);
                    entry.auth_checked_at_ms = query_started_at_ms;
                    CodexQuotaSnapshot::unavailable(code)
                }
                Err(code) => {
                    let mut latest = entry
                        .snapshot
                        .clone()
                        .unwrap_or_else(|| CodexQuotaSnapshot::unavailable(code));
                    if entry.revision == revision {
                        latest.status = "stale";
                        latest.error_code = Some(code);
                    }
                    latest
                }
            };
            entry.snapshot = Some(snapshot.clone());
            entry.revision = entry.revision.wrapping_add(1);
            self.persist(&cache);
            snapshot
        };
        self.notify();
        let mut snapshot = snapshot;
        snapshot.expire(now_seconds());
        if !current() {
            self.discard_binding(stamp);
            return CodexQuotaSnapshot::unavailable("auth_changed");
        }
        snapshot
    }

    #[cfg(test)]
    fn invalidate_account(&self, stamp: &str) {
        self.invalidate_account_at(stamp, now_millis());
    }

    fn invalidate_account_at(&self, stamp: &str, observed_at_ms: u64) {
        {
            let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
            self.restore(&mut cache);
            if let Some(entry) = cache.get_mut(stamp) {
                if observed_at_ms < entry.auth_checked_at_ms {
                    return;
                }
                entry.snapshot = Some(CodexQuotaSnapshot::unavailable("auth_changed"));
                entry.observed_at_ms = entry.observed_at_ms.max(observed_at_ms);
                entry.auth_checked_at_ms = observed_at_ms;
                entry.verified = false;
                entry.identity_hash = None;
                entry.auth_revision = entry.auth_revision.wrapping_add(1);
                entry.revision = entry.revision.wrapping_add(1);
                entry.last_attempt = None;
            }
            self.persist(&cache);
        }
        self.notify();
    }

    fn accept_observation(&self, observation: Observation, current: impl Fn() -> bool) {
        let now = now_millis();
        if observation.observed_at_ms == 0
            || observation.observed_at_ms > now
            || now - observation.observed_at_ms >= MAX_CACHE_AGE * 1000
            || !current()
        {
            return;
        }
        match observation.update {
            ObservationUpdate::Limits { windows } => {
                if [&windows.five_hour, &windows.seven_day]
                    .into_iter()
                    .flatten()
                    .any(|window| {
                        !window.used_percentage.is_finite()
                            || !(0.0..=100.0).contains(&window.used_percentage)
                            || window.resets_at.is_some_and(|reset| reset <= now / 1000)
                    })
                {
                    return;
                }
                self.ingest_at(
                    &observation.stamp,
                    windows,
                    observation.observed_at_ms,
                    current,
                );
            }
            ObservationUpdate::AccountChanged => {
                self.invalidate_account_at(&observation.stamp, observation.observed_at_ms)
            }
        }
    }

    fn publish_notification(
        &self,
        binding: &Binding,
        method: &str,
        params: &Value,
        sink: &crate::event_sink::EventSink,
        current: impl Fn() -> bool,
    ) {
        if !current() {
            return;
        }
        if let Some(observation) = observation(binding, method, params) {
            self.accept_observation(observation.clone(), &current);
            if current() {
                if let Ok(payload) = serde_json::to_string(&observation) {
                    sink.emit_codex_quota_observation(&payload);
                }
            }
        }
    }

    fn ingest_worker_payload(&self, payload: &Value, current: impl Fn(&Binding) -> bool) {
        let Ok(observation) = serde_json::from_value::<Observation>(payload.clone()) else {
            return;
        };
        let binding = self
            .cache
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&observation.stamp)
            .and_then(|entry| entry.binding.clone());
        if let Some(binding) = binding {
            self.accept_observation(observation, || current(&binding));
        }
    }
}

fn observation(binding: &Binding, method: &str, params: &Value) -> Option<Observation> {
    let update = match method {
        "account/rateLimits/updated" => ObservationUpdate::Limits {
            windows: parse_limits(params, now_seconds())?,
        },
        "account/updated" if account_notification_invalidates(params) => ObservationUpdate::AccountChanged,
        _ => return None,
    };
    Some(Observation {
        stamp: binding.stamp.clone(),
        observed_at_ms: now_millis(),
        update,
    })
}

/// App-server sends ChatGPT status at initialization/routing readiness too.
/// The file/config binding still guards identity changes independently; only
/// an explicit non-ChatGPT (or unknown) mode revokes that bound subscription.
pub(crate) fn account_notification_invalidates(params: &Value) -> bool {
    params.get("authMode").and_then(Value::as_str) != Some("chatgpt")
}

pub(crate) fn ingest_notification(
    binding: &Binding,
    method: &str,
    params: &Value,
    sink: &crate::event_sink::EventSink,
) {
    STATE.publish_notification(binding, method, params, sink, || binding.current());
}

/// Only the native host's authenticated worker poll calls this, once per journal
/// event. Client replay preserves the envelope without reapplying its effects.
pub(crate) fn ingest_worker_observation(payload: &Value) {
    STATE.ingest_worker_payload(payload, Binding::current);
}

#[tauri::command]
pub async fn codex_quota_read(
    state: tauri::State<'_, Arc<CodexQuotaState>>,
    provider_id: Option<String>,
    force: Option<bool>,
    cache_only: Option<bool>,
    workspace_path: Option<String>,
) -> Result<CodexQuotaSnapshot, String> {
    let _ = force; // Explicit refresh cannot bypass the shared cooldown.
    let binding = match binding(
        provider_id.as_deref(),
        workspace_path.as_deref().map(Path::new),
    ) {
        Ok(binding) => binding,
        Err(code) => return Ok(CodexQuotaSnapshot::unavailable(code)),
    };
    if cache_only.unwrap_or(false) {
        return Ok(state.cached(&binding.stamp, || binding.current()));
    }
    state.register_binding(&binding);
    Ok(tokio::time::timeout(
        Duration::from_secs(29),
        state.read_bound(
            &binding.stamp,
            crate::engine::codex_app::read_account_quota(&binding),
            || binding.current(),
        ),
    )
    .await
    .unwrap_or_else(|_| CodexQuotaSnapshot::unavailable("query_timeout")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    fn limits(primary: Value, secondary: Value) -> Value {
        json!({"rateLimits":{"limitId":"codex","primary":primary,"secondary":secondary}})
    }
    fn window(minutes: u64, percent: f64) -> Value {
        json!({"windowDurationMins":minutes,"usedPercent":percent,"resetsAt":2000})
    }
    pub(super) fn query(percent: f64) -> QueryResult {
        QueryResult {
            windows: QuotaWindows {
                five_hour: None,
                seven_day: Some(QuotaWindow {
                    used_percentage: percent,
                    resets_at: Some(now_seconds() + 10000),
                }),
            },
            account: Some(QuotaAccount {
                email: Some("fixture@example.test".into()),
                plan: "pro".into(),
            }),
            ..Default::default()
        }
    }

    #[test]
    fn codex_credits_and_reset_chances_are_parsed_read_only() {
        let value = json!({
            "rateLimits": {"limitId":"codex","credits":{"hasCredits":true,"unlimited":false,"balance":"12.50"}},
            "rateLimitResetCredits": {"availableCount": 2, "credits": [
                {"id":"a","status":"available","expiresAt": 5000},
                {"id":"b","status":"redeemed","expiresAt": 3000},
                {"id":"c","status":"available","expiresAt": 4000}]}
        });
        let (credits, resets) = parse_credits(&value, 1000);
        let credits = credits.unwrap();
        assert!(credits.has_credits && !credits.unlimited);
        assert_eq!(credits.balance.as_deref(), Some("12.50"));
        let resets = resets.unwrap();
        assert_eq!(resets.available_count, 2);
        assert_eq!(resets.next_expires_at, Some(4000));
        // Missing or malformed data is unknown, never zero; hostile balance text is dropped.
        assert_eq!(parse_credits(&json!({"rateLimits":{}}), 1000), (None, None));
        let hostile = json!({"rateLimits":{"credits":{"hasCredits":true,"unlimited":false,"balance":"<b>9</b>"}}});
        assert_eq!(parse_credits(&hostile, 1000).0.unwrap().balance, None);
    }

    #[test]
    fn codex_weekly_window_can_be_primary_and_missing_is_not_zero() {
        let parsed = parse_limits(&limits(window(10080, 0.0), Value::Null), 1000).unwrap();
        assert_eq!(parsed.seven_day.unwrap().used_percentage, 0.0);
        assert!(parsed.five_hour.is_none());
        let both = parse_limits(&limits(window(10080, 53.0), window(300, 12.5)), 1000).unwrap();
        assert_eq!(both.seven_day.unwrap().used_percentage, 53.0);
        assert_eq!(both.five_hour.unwrap().used_percentage, 12.5);
        assert_eq!(
            parse_limits(&limits(Value::Null, Value::Null), 1000),
            Some(QuotaWindows::default())
        );
        assert!(parse_limits(&json!({}), 1000).is_none());
    }

    #[test]
    fn codex_quota_rejects_invalid_expired_and_unrelated_windows() {
        for value in [
            window(300, -1.0),
            window(300, 101.0),
            window(15, 20.0),
            json!({"windowDurationMins":10080,"usedPercent":10,"resetsAt":1000}),
            json!({"windowDurationMins":10080,"usedPercent":10,"resetsAt":"2000"}),
        ] {
            assert_eq!(
                parse_limits(&limits(value, Value::Null), 1000),
                Some(QuotaWindows::default())
            );
        }
        assert!(parse_limits(&limits(window(300, 1.0), window(300, 2.0)), 1000).is_none());
        assert!(parse_limits(
            &json!({"rateLimits":{"limitId":"codex_other","primary":window(300,2.0)}}),
            1000
        )
        .is_none());
        let multi = json!({"rateLimits":{"primary":window(300,99.0)},"rateLimitsByLimitId":{
            "codex":{"primary":window(10080,25.0)},"codex_other":{"primary":window(300,88.0)}}});
        let result = parse_limits(&multi, 1000).unwrap();
        assert!(result.five_hour.is_none());
        assert_eq!(result.seven_day.unwrap().used_percentage, 25.0);
    }

    #[test]
    fn codex_quota_account_only_copies_subscription_display_fields() {
        assert_eq!(
            parse_account(&json!({"account":{"type":"apiKey"}})).unwrap_err(),
            "provider_auth_unavailable"
        );
        let result = parse_account(&json!({"account":{"type":"chatgpt","email":"user@example.test","planType":"plus","token":"do-not-copy"}})).unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({"email":"user@example.test","plan":"plus"})
        );
        assert_eq!(
            parse_account(&json!({"account":{"type":"chatgpt"}})).unwrap(),
            None
        );
    }

    #[test]
    fn codex_quota_official_channel_may_not_hide_a_custom_provider() {
        assert!(official_config(&json!({})));
        assert!(official_config(&json!({"model_provider":"openai"})));
        assert!(!official_config(&json!({"model_provider":"relay"})));
        assert!(!official_config(
            &json!({"chatgpt_base_url":"https://relay.example"})
        ));
        assert!(!official_config(
            &json!({"model_providers":{"openai":{"env_key":"SECRET"}}})
        ));
        assert!(!official_config(
            &json!({"profile":"relay","profiles":{"relay":{"model_provider":"relay"}}})
        ));
        assert!(official_config(
            &json!({"profile":"coding","profiles":{"coding":{"model":"gpt-test"}}})
        ));
        assert!(official_config(
            &json!({"cli_auth_credentials_store":"file"})
        ));
        for mode in ["keyring", "auto", "ephemeral"] {
            assert!(!official_config(
                &json!({"cli_auth_credentials_store":mode})
            ));
        }
    }

    #[test]
    fn config_stamp_ignores_only_known_model_options_and_still_validates_auth() {
        let path = std::env::temp_dir().join(format!("ccgui-quota-{}.toml", uuid::Uuid::new_v4()));
        let stamp = |text: &str| {
            std::fs::write(&path, text).unwrap();
            let mut result = String::new();
            stamp_config(&mut result, &path).map(|_| result)
        };
        let baseline = stamp("model='first'\nmodel_reasoning_effort='high'\n[profiles.coding]\nmodel='first'\nservice_tier='fast'\n").unwrap();
        assert_eq!(baseline, stamp("model='second'\nmodel_reasoning_effort='low'\n[profiles.coding]\nmodel='second'\nservice_tier='default'\n").unwrap());
        assert_ne!(baseline, stamp("forced_chatgpt_workspace_id='different'\n[profiles.coding]\n").unwrap());
        assert_ne!(baseline, stamp("unknown_auth_setting='different'\n[profiles.coding]\n").unwrap());
        assert_eq!(stamp("model_provider='relay'"), Err("provider_auth_unavailable"));
        assert_eq!(stamp("cli_auth_credentials_store='keyring'"), Err("provider_auth_unavailable"));
        let empty = stamp("").unwrap();
        std::fs::remove_file(&path).unwrap();
        let mut missing = String::new();
        stamp_config(&mut missing, &path).unwrap();
        assert_ne!(empty, missing);
    }

    #[tokio::test]
    async fn codex_quota_merges_concurrent_reads_and_enforces_cooldown() {
        let state = CodexQuotaState::default();
        let calls = AtomicUsize::new(0);
        let request = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Ok(query(25.0))
        };
        let (a, b) = tokio::join!(
            state.read_bound("account-a", request(), || true),
            state.read_bound("account-a", request(), || true)
        );
        assert_eq!(a, b);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(state.read_bound("account-a", request(), || true).await, a);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let other = state
            .read_bound("account-b", async { Ok(query(72.0)) }, || true)
            .await;
        assert_eq!(other.windows.seven_day.unwrap().used_percentage, 72.0);
        assert_eq!(state.cached("account-a", || true), a);
    }

    #[tokio::test]
    async fn codex_quota_cache_reads_do_not_wait_for_network() {
        let state = CodexQuotaState::default();
        let _guard = state.query.lock().await;
        assert_eq!(state.cached("new", || true).error_code, Some("not_loaded"));
        state.ingest("unverified", query(99.0).windows, || true);
        assert!(state.cache.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn codex_quota_does_not_replace_new_passive_data_with_old_refresh() {
        let state = CodexQuotaState::default();
        state
            .read_bound("a", async { Ok(query(10.0)) }, || true)
            .await;
        state
            .cache
            .lock()
            .unwrap()
            .get_mut("a")
            .unwrap()
            .last_attempt = None;
        let response = state
            .read_bound(
                "a",
                async {
                    state.ingest("a", query(60.0).windows, || true);
                    Ok(query(20.0))
                },
                || true,
            )
            .await;
        assert_eq!(response.windows.seven_day.unwrap().used_percentage, 60.0);
        assert!(response.account.is_some());
    }

    #[tokio::test]
    async fn codex_quota_auth_change_discards_in_flight_and_cached_data() {
        let state = CodexQuotaState::default();
        let current = AtomicBool::new(true);
        let result = state
            .read_bound(
                "a",
                async {
                    current.store(false, Ordering::SeqCst);
                    Ok(query(30.0))
                },
                || current.load(Ordering::SeqCst),
            )
            .await;
        assert_eq!(result.error_code, Some("auth_changed"));
        assert!(result.account.is_none());
        assert_eq!(state.cached("a", || false).windows, QuotaWindows::default());
        assert_eq!(state.cached("a", || true).error_code, Some("not_loaded"));
    }

    #[tokio::test]
    async fn codex_quota_account_notification_invalidates_an_in_flight_refresh() {
        let state = CodexQuotaState::default();
        let result = state
            .read_bound(
                "a",
                async {
                    state.invalidate_account("a");
                    Ok(query(30.0))
                },
                || true,
            )
            .await;
        assert_eq!(result.error_code, Some("auth_changed"));
        assert_eq!(state.cached("a", || true).error_code, Some("auth_changed"));
        state.ingest("a", query(55.0).windows, || true);
        assert!(state.cached("a", || true).account.is_none());
        // The new identity is allowed to refresh immediately, independently of
        // the old account's cooldown, and only then accepts passive windows.
        let fresh = state
            .read_bound("a", async { Ok(query(60.0)) }, || true)
            .await;
        assert_eq!(fresh.windows.seven_day.unwrap().used_percentage, 60.0);
    }

    #[tokio::test]
    async fn codex_quota_failure_keeps_only_valid_same_account_values() {
        let state = CodexQuotaState::default();
        state
            .read_bound("a", async { Ok(query(50.0)) }, || true)
            .await;
        state
            .cache
            .lock()
            .unwrap()
            .get_mut("a")
            .unwrap()
            .last_attempt = None;
        let stale = state
            .read_bound("a", async { Err("query_failed") }, || true)
            .await;
        assert_eq!(stale.status, "stale");
        assert_eq!(
            stale.windows.seven_day.as_ref().unwrap().used_percentage,
            50.0
        );
        state
            .cache
            .lock()
            .unwrap()
            .get_mut("a")
            .unwrap()
            .last_attempt = None;
        let signed_out = state
            .read_bound("a", async { Err("provider_auth_unavailable") }, || true)
            .await;
        assert!(signed_out.account.is_none());
        assert_eq!(signed_out.windows, QuotaWindows::default());
    }

    #[test]
    fn codex_quota_expiration_does_not_fabricate_new_allowances() {
        let mut snapshot = CodexQuotaSnapshot {
            status: "ready",
            windows: query(40.0).windows,
            account: None,
            collected_at: Some(1000),
            source: Some("codex_app_server"),
            error_code: None,
            ..Default::default()
        };
        snapshot.windows.seven_day.as_mut().unwrap().resets_at = Some(1200);
        snapshot.expire(1120);
        assert_eq!(snapshot.status, "stale");
        snapshot.expire(1200);
        snapshot.expire(100_000);
        assert_eq!(snapshot.status, "stale");
        assert_eq!(snapshot.windows.seven_day.unwrap().used_percentage, 40.0);
        assert_eq!(snapshot.collected_at, Some(1000));
    }

    #[test]
    fn quota_rejects_missing_and_future_sample_times() {
        for collected_at in [None, Some(2000)] {
            let mut snapshot = CodexQuotaSnapshot {
                status: "ready", windows: query(40.0).windows, collected_at,
                ..Default::default()
            };
            snapshot.expire(1000);
            assert_eq!(snapshot.status, "unavailable");
            assert_eq!(snapshot.windows, QuotaWindows::default());
        }
    }

    #[tokio::test]
    async fn sparse_refresh_preserves_old_sample_but_never_another_account() {
        let state = CodexQuotaState::default();
        let first = state.read_bound("a", async { Ok(query(45.0)) }, || true).await;
        {
            let mut cache = state.cache.lock().unwrap();
            let entry = cache.get_mut("a").unwrap();
            entry.last_attempt = None;
            entry.snapshot.as_mut().unwrap().collected_at = Some(1);
        }
        let sparse = state.read_bound("a", async { Ok(QueryResult::default()) }, || true).await;
        assert_eq!(sparse.windows, first.windows);
        assert_eq!(sparse.account, first.account);
        assert_eq!(sparse.collected_at, Some(1));
        assert_eq!(sparse.status, "stale");
        state.cache.lock().unwrap().get_mut("a").unwrap().last_attempt = None;
        let changed = state.read_bound("a", async { Ok(QueryResult {
            account: Some(QuotaAccount { email: Some("different@example.test".into()), plan: "plus".into() }),
            ..Default::default()
        }) }, || true).await;
        assert_eq!(changed.windows, QuotaWindows::default());
    }

    #[tokio::test]
    async fn cache_capacity_evicts_only_one_binding() {
        let state = CodexQuotaState::default();
        for n in 0..=MAX_BINDINGS {
            state.read_bound(&n.to_string(), async { Ok(query(20.0)) }, || true).await;
        }
        assert_eq!(state.cache.lock().unwrap().len(), MAX_BINDINGS);
        assert!(state.cached(&MAX_BINDINGS.to_string(), || true).windows.seven_day.is_some());
    }

    pub(super) fn fixture_binding() -> Binding {
        Binding {
            stamp: format!("{:x}", Sha256::digest(b"fixture-metadata")),
            provider: None,
            home: PathBuf::from("fixture-home"),
            workspace: PathBuf::from("fixture-workspace"),
        }
    }

    #[tokio::test]
    async fn chatgpt_status_keeps_verified_quota_and_accepts_later_usage() {
        let state = CodexQuotaState::default();
        let binding = fixture_binding();
        state.read_bound(&binding.stamp, async { Ok(query(35.0)) }, || true).await;
        let before = state.cached(&binding.stamp, || true);
        if let Some(update) = observation(&binding, "account/updated", &json!({"authMode":"chatgpt","planType":"pro"})) {
            state.accept_observation(update, || true);
        }
        assert_eq!(state.cached(&binding.stamp, || true), before);
        state.ingest(&binding.stamp, query(40.0).windows, || true);
        assert_eq!(state.cached(&binding.stamp, || true).windows.seven_day.unwrap().used_percentage, 40.0);
        // Metadata/config invalidation continues to hide an old account.
        assert_eq!(state.cached(&binding.stamp, || false).error_code, Some("auth_changed"));
    }

    #[tokio::test]
    async fn sparse_usage_does_not_clear_quota_or_refresh_its_age() {
        let state = CodexQuotaState::default();
        state.read_bound("a", async { Ok(query(35.0)) }, || true).await;
        let before = state.cached("a", || true);
        state.ingest_at("a", QuotaWindows::default(), now_millis() + 1, || true);
        assert_eq!(state.cached("a", || true), before);
    }

    #[test]
    fn account_mode_changes_remain_fail_closed() {
        let binding = fixture_binding();
        for params in [json!({"authMode":null}), json!({"authMode":"apikey"}), json!({"authMode":"unknown"}), json!({})] {
            assert!(account_notification_invalidates(&params));
            assert!(matches!(observation(&binding, "account/updated", &params).unwrap().update, ObservationUpdate::AccountChanged));
        }
        assert!(!account_notification_invalidates(&json!({"authMode":"chatgpt"})));
    }

    #[tokio::test]
    async fn worker_without_gui_cache_publishes_only_sanitized_quota_to_verified_host() {
        #[derive(Default)]
        struct Collector(Mutex<Vec<(String, Value)>>);
        impl crate::event_sink::Emit for Collector {
            fn emit_json(&self, name: &str, raw: &str) {
                self.0
                    .lock()
                    .unwrap()
                    .push((name.into(), serde_json::from_str(raw).unwrap()));
            }
        }
        let worker = CodexQuotaState::default();
        let host = CodexQuotaState::default();
        let binding = fixture_binding();
        host.register_binding(&binding);
        host.read_bound(&binding.stamp, async { Ok(query(10.0)) }, || true)
            .await;
        let collector = Arc::new(Collector::default());
        let sink = crate::event_sink::EventSink::new(collector.clone());
        let params = json!({"rateLimits":{"limitId":"codex","primary":{
            "windowDurationMins":10080,"usedPercent":64.0,"resetsAt":now_seconds()+1000,
            "secret":"do-not-publish"}},"account":{"email":"do-not-publish"},"token":"do-not-publish"});
        worker.publish_notification(
            &binding,
            "account/rateLimits/updated",
            &params,
            &sink,
            || true,
        );
        assert!(
            worker.cache.lock().unwrap().is_empty(),
            "worker must not require or create a GUI cache"
        );
        let published = collector.0.lock().unwrap();
        assert_eq!(published.len(), 1);
        assert_eq!(published[0].0, OBSERVATION_EVENT);
        let raw = published[0].1.to_string();
        for secret in [
            "do-not-publish",
            "fixture-home",
            "fixture-workspace",
            "fixture-metadata",
            "email",
            "token",
        ] {
            assert!(!raw.contains(secret), "unsafe journal field: {secret}");
        }
        host.ingest_worker_payload(&published[0].1, |_| true);
        let result = host.cached(&binding.stamp, || true);
        assert_eq!(result.windows.seven_day.unwrap().used_percentage, 64.0);
        assert_eq!(
            result.account.unwrap().email.as_deref(),
            Some("fixture@example.test")
        );
    }

    #[tokio::test]
    async fn worker_replay_cannot_refresh_old_data_or_invalidate_a_newer_query() {
        let host = CodexQuotaState::default();
        let binding = fixture_binding();
        host.register_binding(&binding);
        host.read_bound(&binding.stamp, async { Ok(query(55.0)) }, || true)
            .await;
        let initial = host.cached(&binding.stamp, || true);
        let recorded = host.cache.lock().unwrap()[&binding.stamp].observed_at_ms;
        for update in [
            ObservationUpdate::Limits {
                windows: query(5.0).windows,
            },
            ObservationUpdate::AccountChanged,
        ] {
            let payload = serde_json::to_value(Observation {
                stamp: binding.stamp.clone(),
                observed_at_ms: recorded - 1,
                update,
            })
            .unwrap();
            host.ingest_worker_payload(&payload, |_| true);
            assert_eq!(host.cached(&binding.stamp, || true), initial);
        }
        let fresh = Observation {
            stamp: binding.stamp.clone(),
            observed_at_ms: now_millis(),
            update: ObservationUpdate::Limits {
                windows: query(80.0).windows,
            },
        };
        host.ingest_worker_payload(&serde_json::to_value(&fresh).unwrap(), |_| false);
        assert_eq!(
            host.cached(&binding.stamp, || true),
            initial,
            "changed auth context must be rejected"
        );
        let mut other = fresh.clone();
        other.stamp = "another-account".into();
        host.ingest_worker_payload(&serde_json::to_value(other).unwrap(), |_| true);
        assert_eq!(host.cached(&binding.stamp, || true), initial);
        for at in [now_millis() + 60_000, now_millis() - MAX_CACHE_AGE * 1000] {
            let mut invalid = fresh.clone();
            invalid.observed_at_ms = at;
            host.ingest_worker_payload(&serde_json::to_value(invalid).unwrap(), |_| true);
            assert_eq!(host.cached(&binding.stamp, || true), initial);
        }
        let change = Observation {
            stamp: binding.stamp.clone(),
            observed_at_ms: now_millis(),
            update: ObservationUpdate::AccountChanged,
        };
        host.ingest_worker_payload(&serde_json::to_value(change).unwrap(), |_| true);
        host.ingest_worker_payload(&serde_json::to_value(fresh).unwrap(), |_| true);
        assert_eq!(
            host.cached(&binding.stamp, || true).error_code,
            Some("auth_changed")
        );
        assert!(host.cached(&binding.stamp, || true).account.is_none());
    }

    #[tokio::test]
    async fn delayed_worker_observations_from_during_a_query_are_not_old_replay() {
        let host = CodexQuotaState::default();
        let binding = fixture_binding();
        host.register_binding(&binding);
        let mut limits = None;
        let mut account_changed = None;
        host.read_bound(
            &binding.stamp,
            async {
                tokio::time::sleep(Duration::from_millis(2)).await;
                account_changed = Some(Observation {
                    stamp: binding.stamp.clone(),
                    observed_at_ms: now_millis(),
                    update: ObservationUpdate::AccountChanged,
                });
                tokio::time::sleep(Duration::from_millis(2)).await;
                limits = Some(Observation {
                    stamp: binding.stamp.clone(),
                    observed_at_ms: now_millis(),
                    update: ObservationUpdate::Limits {
                        windows: query(80.0).windows,
                    },
                });
                tokio::time::sleep(Duration::from_millis(2)).await;
                Ok(query(10.0))
            },
            || true,
        )
        .await;
        // Both were produced during the query; reverse delivery also must not
        // let a newer window's timestamp suppress an account invalidation.
        host.ingest_worker_payload(&serde_json::to_value(limits.unwrap()).unwrap(), |_| true);
        assert_eq!(
            host.cached(&binding.stamp, || true)
                .windows
                .seven_day
                .unwrap()
                .used_percentage,
            80.0
        );
        host.ingest_worker_payload(
            &serde_json::to_value(account_changed.unwrap()).unwrap(),
            |_| true,
        );
        assert_eq!(
            host.cached(&binding.stamp, || true).error_code,
            Some("auth_changed")
        );
    }

    #[tokio::test]
    #[ignore = "explicit live read-only Codex account query; no model turn"]
    async fn live_native_codex_quota_query() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let binding = binding(Some(crate::config::LOCAL_PROVIDER_ID), Some(root))
            .expect("native Codex binding");
        let result = crate::engine::codex_app::read_account_quota(&binding)
            .await
            .expect("official account quota response");
        assert!(
            result.account.is_some(),
            "subscription identity is available"
        );
        assert_ne!(
            result.windows,
            QuotaWindows::default(),
            "at least one supported quota window"
        );
        println!(
            "Verified native Codex account quota: 5h={}, weekly={}",
            result.windows.five_hour.is_some(),
            result.windows.seven_day.is_some()
        );
    }
}
