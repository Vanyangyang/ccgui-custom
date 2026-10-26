//! Read-only native account quota. Access tokens stay in the private access module.
mod access;
use crate::claude_quota::{QuotaWindow, QuotaWindows};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const COOLDOWN: Duration = Duration::from_secs(60);
const MAX_AGE: u64 = 3600;
const MAX_BINDINGS: usize = 16;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgyQuotaGroup {
    pub id: &'static str,
    pub windows: QuotaWindows,
}
/// AI credits from the native `/credits` command. `None` means unknown, not zero.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgyCredits {
    pub remaining: f64,
}
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgyQuotaSnapshot {
    pub status: &'static str,
    pub groups: Vec<AgyQuotaGroup>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credits: Option<AgyCredits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collected_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<&'static str>,
}
impl AgyQuotaSnapshot {
    fn unavailable(code: &'static str) -> Self {
        Self {
            status: "unavailable",
            error_code: Some(code),
            ..Default::default()
        }
    }
    fn expire(&mut self, now: u64) {
        if self.collected_at.is_none_or(|at| at > now) {
            self.groups.clear();
        }
        if self
            .collected_at
            .is_none_or(|at| at > now || now - at >= MAX_AGE)
        {
            self.credits = None;
        }
        self.groups.retain(|g| g.windows != QuotaWindows::default());
        if self.groups.is_empty() {
            self.status = "unavailable";
            self.error_code.get_or_insert("quota_not_available");
        } else if self
            .groups
            .iter()
            .flat_map(|g| [&g.windows.five_hour, &g.windows.seven_day])
            .flatten()
            .any(|w| w.resets_at.is_some_and(|at| at <= now))
            || self
                .collected_at
                .is_some_and(|at| at > now || now.saturating_sub(at) >= 120)
        {
            self.status = "stale";
        }
    }
}
fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

// Strict, bounded RFC3339 parsing; impossible dates and unknown offsets fail closed.
fn reset_time(input: &str) -> Option<u64> {
    let b = input.as_bytes();
    if !(20..=64).contains(&b.len())
        || !input.is_ascii()
        || b[4] != b'-'
        || b[7] != b'-'
        || !matches!(b[10], b'T' | b't')
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let num = |a: usize, z: usize| -> Option<i64> {
        input[a..z]
            .bytes()
            .all(|c| c.is_ascii_digit())
            .then(|| input[a..z].parse().ok())
            .flatten()
    };
    let (year, month, day, hour, minute, second) = (
        num(0, 4)?,
        num(5, 7)?,
        num(8, 10)?,
        num(11, 13)?,
        num(14, 16)?,
        num(17, 19)?,
    );
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
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
    let offset = if matches!(tail, "Z" | "z") {
        0
    } else {
        let t = tail.as_bytes();
        if t.len() != 6
            || !matches!(t[0], b'+' | b'-')
            || t[3] != b':'
            || !t[1..3].iter().chain(t[4..6].iter()).all(u8::is_ascii_digit)
            || tail == "-00:00"
        {
            return None;
        }
        let h: i64 = tail[1..3].parse().ok()?;
        let m: i64 = tail[4..6].parse().ok()?;
        if h > 23 || m > 59 {
            return None;
        }
        (h * 3600 + m * 60) * if t[0] == b'+' { 1 } else { -1 }
    };
    let y = year - i64::from(month <= 2);
    let era = y / 400;
    let yoe = y - era * 400;
    let mp = month + if month > 2 { -3 } else { 9 };
    let days =
        era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + (153 * mp + 2) / 5 + day - 1 - 719468;
    let seconds = days * 86400 + hour * 3600 + minute * 60 + second - offset;
    (0..=253_402_300_799)
        .contains(&seconds)
        .then_some(seconds as u64)
}

fn parse_usage(value: &Value, now: u64) -> Result<Vec<AgyQuotaGroup>, &'static str> {
    let invalid = "invalid_response";
    if value.get("status").and_then(Value::as_str) != Some("SUCCESS")
        || value.pointer("/command/name").and_then(Value::as_str) != Some("usage")
    {
        return Err(invalid);
    }
    let groups = value
        .pointer("/command/data/groups")
        .and_then(Value::as_array)
        .ok_or(invalid)?;
    if groups.len() > 32 {
        return Err(invalid);
    }
    let mut result = vec![
        AgyQuotaGroup {
            id: "gemini",
            windows: Default::default(),
        },
        AgyQuotaGroup {
            id: "third_party",
            windows: Default::default(),
        },
        AgyQuotaGroup {
            id: "gemini_argon",
            windows: Default::default(),
        },
    ];
    let mut seen = HashSet::new();
    let mut disabled_count = 0;
    for group in groups {
        let buckets = group
            .get("buckets")
            .and_then(Value::as_array)
            .ok_or(invalid)?;
        if buckets.len() > 64 {
            return Err(invalid);
        }
        for bucket in buckets {
            let id = bucket.get("id").and_then(Value::as_str).ok_or(invalid)?;
            let (index, suffix) = if let Some(s) = id.strip_prefix("argon-") {
                (2, s)
            } else if let Some(s) = id.strip_prefix("gemini-") {
                (0, s)
            } else if let Some(s) = id.strip_prefix("3p-") {
                (1, s)
            } else {
                continue;
            };
            let window = bucket
                .get("window")
                .and_then(Value::as_str)
                .ok_or(invalid)?;
            if !matches!(window, "5h" | "weekly")
                || suffix != window
                || !seen.insert((index, window))
            {
                return Err(invalid);
            }
            // A weekly limit can disable the 5h bucket. Its remaining fraction
            // is then historical and its reset time may be absent.
            if bucket.get("disabled").and_then(Value::as_bool) == Some(true) {
                disabled_count += 1;
                continue;
            }
            let remaining = bucket
                .get("remaining_fraction")
                .and_then(Value::as_f64)
                .filter(|f| f.is_finite() && (0.0..=1.0).contains(f))
                .ok_or(invalid)?;
            let reset = bucket
                .get("reset_time")
                .and_then(Value::as_str)
                .and_then(reset_time)
                .ok_or(invalid)?;
            if reset <= now {
                continue;
            }
            let slot = if window == "5h" {
                &mut result[index].windows.five_hour
            } else {
                &mut result[index].windows.seven_day
            };
            *slot = Some(QuotaWindow {
                used_percentage: 100.0 * (1.0 - remaining),
                resets_at: Some(reset),
            });
        }
    }
    result.retain(|g| g.windows != QuotaWindows::default());
    // An empty/expired response is not an explicit revocation. Only a
    // validated response disabling every supported bucket clears old usage.
    if result.is_empty() && (seen.is_empty() || disabled_count != seen.len()) {
        return Err("quota_not_available");
    }
    Ok(result)
}

#[derive(Clone)]
struct Binding {
    stamp: String,
    workspace: PathBuf,
    provider: Option<String>,
}
impl Binding {
    fn current(&self) -> bool {
        binding(self.provider.as_deref(), Some(&self.workspace))
            .is_ok_and(|b| b.stamp == self.stamp)
    }
}
fn stamp_file(stamp: &mut Sha256, path: &Path) -> Result<(), &'static str> {
    stamp.update(path.to_string_lossy().as_bytes());
    match std::fs::metadata(path) {
        Ok(m) if m.is_file() => stamp.update(
            format!(
                "|{}:{:?}:{:?};",
                m.len(),
                m.modified().ok(),
                m.created().ok()
            )
            .as_bytes(),
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => stamp.update(b"|missing;"),
        _ => return Err("auth_metadata_unavailable"),
    }
    Ok(())
}
// Native /usage is independent of model-provider/MCP configuration. Track
// configuration and account changes through metadata without reading secrets.
fn stamp_context_files(
    stamp: &mut Sha256,
    home: &Path,
    user_home: &Path,
    workspace: &Path,
) -> Result<(), &'static str> {
    for path in [
        home.join("jetski_state.pbtxt"),
        home.join("oauth_creds.json"),
        home.join("settings.json"),
        user_home.join(".gemini/settings.json"),
        user_home.join(".gemini/oauth_creds.json"),
        user_home.join(".gemini/google_accounts.json"),
        user_home.join(".gemini/google_account_id"),
        user_home.join(".gemini/config/config.json"),
        user_home.join(".gemini/antigravity/antigravity_state.pbtxt"),
        user_home.join(".gemini/installation_id"),
    ] {
        stamp_file(stamp, &path)?;
    }
    for directory in workspace.ancestors() {
        stamp_file(stamp, &directory.join(".gemini/settings.json"))?;
        stamp_file(
            stamp,
            &directory.join(".gemini/antigravity-cli/settings.json"),
        )?;
        stamp_file(stamp, &directory.join(".env"))?;
    }
    Ok(())
}
fn local_path(path: &Path) -> bool {
    let text = path.to_string_lossy().to_ascii_lowercase();
    !text.starts_with("wsl:")
        && !text.starts_with("ssh:")
        && !text.starts_with("\\\\")
        && !text.starts_with("//")
}
fn credential_context_allowed() -> bool {
    crate::development_profile::root().is_none()
        && [
            "ANTIGRAVITY_HOME",
            "SSH_TTY",
            "SSH_CONNECTION",
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
        ]
        .iter()
        .all(|key| std::env::var_os(key).is_none_or(|value| value.is_empty()))
}
fn binding(provider: Option<&str>, workspace: Option<&Path>) -> Result<Binding, &'static str> {
    // A shared native keyring is not evidence of identity in custom/isolated homes.
    if !credential_context_allowed() {
        return Err("unsupported_auth_context");
    }
    let config = crate::config::read_config().map_err(|_| "provider_auth_unavailable")?;
    let section = config.section("agy").ok_or("custom_channel")?;
    if section.current.as_deref() == Some(crate::config::DISABLED_PROVIDER_ID) {
        return Err("engine_disabled");
    }
    let id = provider
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| section.current.as_deref().unwrap_or("").trim());
    if !matches!(
        id,
        "" | crate::config::LOCAL_PROVIDER_ID | crate::config::LEGACY_LOCAL_CONFIG_TOML_ID
    ) {
        return Err("custom_channel");
    }
    let user_home = crate::development_profile::home()
        .or_else(dirs::home_dir)
        .ok_or("auth_metadata_unavailable")?;
    let workspace = workspace.unwrap_or(user_home.as_path());
    if !workspace.is_absolute() || !local_path(workspace) {
        return Err("workspace_unavailable");
    }
    let workspace = dunce::canonicalize(workspace).map_err(|_| "workspace_unavailable")?;
    if !workspace.is_dir() || !local_path(&workspace) {
        return Err("workspace_unavailable");
    }
    let home = crate::engine::agy::agy_home();
    if !local_path(&home) {
        return Err("unsupported_auth_context");
    }
    let settings = crate::settings::read_settings().map_err(|_| "cli_unavailable")?;
    let bin = crate::engine::engine_bin(&settings, "agy");
    let resolved = dunce::canonicalize(crate::engine::resolve::resolve_launchable_cli_binary(&bin))
        .map_err(|_| "cli_unavailable")?;
    if !resolved.is_file() || !local_path(&resolved) {
        return Err("cli_unavailable");
    }
    let bin = resolved.to_str().ok_or("cli_unavailable")?.to_owned();
    let mut stamp = Sha256::new();
    stamp.update(format!(
        "{bin}|{}|{}|{id}|",
        home.display(),
        workspace.display()
    ));
    stamp.update(serde_json::to_vec(section).map_err(|_| "provider_auth_unavailable")?);
    stamp_file(&mut stamp, &resolved)?;
    stamp_context_files(&mut stamp, &home, &user_home, &workspace)?;
    Ok(Binding {
        stamp: format!("{:x}", stamp.finalize()),
        workspace,
        provider: provider.map(str::to_owned),
    })
}
// Native API uses camelCase; reuse the strict numeric/window parser without
// ever invoking the CLI or treating model text as a quota report.
fn parse_api(value: &Value, now: u64) -> Result<Vec<AgyQuotaGroup>, &'static str> {
    if value.get("error").is_some()
        || value.get("code").is_some_and(|code| {
            !matches!(code.as_i64(), Some(0 | 200)) && code.as_str() != Some("OK")
        })
    {
        return Err("invalid_response");
    }
    let payload = value
        .get("response")
        .or_else(|| value.get("summary"))
        .unwrap_or(value);
    let groups = payload
        .get("groups")
        .and_then(Value::as_array)
        .ok_or("invalid_response")?;
    if groups.len() > 32 {
        return Err("invalid_response");
    }
    let mut mapped = Vec::new();
    for group in groups {
        let buckets = group
            .get("buckets")
            .and_then(Value::as_array)
            .ok_or("invalid_response")?;
        if buckets.len() > 64 {
            return Err("invalid_response");
        }
        let mut output = Vec::new();
        for bucket in buckets {
            let id = bucket
                .get("bucketId")
                .or_else(|| bucket.get("id"))
                .and_then(Value::as_str)
                .ok_or("invalid_response")?;
            let id = match id {
                "gemini-wtu-5h" => "gemini-5h",
                "gemini-wtu-weekly" => "gemini-weekly",
                "gemini-argon-wtu-weekly" => "argon-weekly",
                "gemini-argon-wtu-5h" => "argon-5h",
                other => other,
            };
            let fraction = bucket
                .get("remainingFraction")
                .or_else(|| bucket.pointer("/remaining/remainingFraction"));
            output.push(serde_json::json!({
                "id": id, "window": bucket.get("window"),
                "remaining_fraction": fraction, "reset_time": bucket.get("resetTime"),
                "disabled": bucket.get("disabled"),
            }));
        }
        mapped.push(serde_json::json!({"buckets": output}));
    }
    parse_usage(
        &serde_json::json!({"status":"SUCCESS","command":{"name":"usage","data":{"groups":mapped}}}),
        now,
    )
}

fn invalidates_account(code: &str) -> bool {
    matches!(
        code,
        "auth_expired"
            | "auth_changed"
            | "auth_missing"
            | "auth_invalid"
            | "auth_read_failed"
            | "quota_forbidden"
    )
}

#[derive(Default)]
struct Entry {
    snapshot: Option<AgyQuotaSnapshot>,
    last_attempt: Option<Instant>,
}
#[derive(Default)]
pub struct AgyQuotaState {
    cache: Mutex<HashMap<String, Entry>>,
    identities: Mutex<HashMap<String, (String, u64)>>,
    identity_generation: std::sync::atomic::AtomicU64,
    query: tokio::sync::Mutex<()>,
    changed: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
}
pub static STATE: LazyLock<Arc<AgyQuotaState>> =
    LazyLock::new(|| Arc::new(AgyQuotaState::default()));
pub(crate) fn install_events(app: &tauri::AppHandle) {
    use crate::event_sink::Emit;
    use tauri::Manager;
    let emitters = Arc::clone(&app.state::<crate::AppState>().emitters);
    *STATE.changed.lock().unwrap_or_else(|p| p.into_inner()) = Some(Box::new(move || {
        emitters.emit_json("agy-quota://changed", "null")
    }));
}
impl AgyQuotaState {
    fn forget_identity(&self, base: &str) {
        self.forget_identity_if(base, None);
    }

    fn forget_identity_if(&self, base: &str, generation: Option<u64>) {
        let mut identities = self.identities.lock().unwrap_or_else(|p| p.into_inner());
        if generation.is_some_and(|generation| {
            identities
                .get(base)
                .is_none_or(|(_, current)| *current != generation)
        }) {
            return;
        }
        identities.remove(base);
        let prefix = format!("{base}:");
        self.cache
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|key, _| !key.starts_with(&prefix));
    }

    fn bind_identity(&self, base: &str, fingerprint: &str) -> u64 {
        let mut identities = self.identities.lock().unwrap_or_else(|p| p.into_inner());
        if let Some((old, generation)) = identities.get(base) {
            if old == fingerprint {
                return *generation;
            }
        }
        let generation = self
            .identity_generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let prefix = format!("{base}:");
        let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
        cache.retain(|key, _| !key.starts_with(&prefix));
        if identities.len() >= MAX_BINDINGS && !identities.contains_key(base) {
            if let Some(old) = identities.keys().next().cloned() {
                identities.remove(&old);
                let prefix = format!("{old}:");
                cache.retain(|key, _| !key.starts_with(&prefix));
            }
        }
        identities.insert(base.to_owned(), (fingerprint.to_owned(), generation));
        generation
    }

    async fn read_access<R, F, Fut>(
        &self,
        base_stamp: &str,
        cache_only: bool,
        read: R,
        fetch: F,
        current: impl Fn() -> bool,
    ) -> AgyQuotaSnapshot
    where
        R: Fn() -> Result<access::Credential, &'static str>,
        F: Fn(access::Credential) -> Fut,
        Fut: std::future::Future<Output = Result<Value, &'static str>>,
    {
        if !current() {
            self.forget_identity(base_stamp);
            return AgyQuotaSnapshot::unavailable("auth_changed");
        }
        let mut credential = match read() {
            Ok(value) => value,
            Err(code) => {
                self.forget_identity(base_stamp);
                return AgyQuotaSnapshot::unavailable(code);
            }
        };
        // AGY may have renewed its own token. Re-read once, never renew it here.
        if !credential.usable(now_seconds()) {
            credential = match read() {
                Ok(value) if value.usable(now_seconds()) => value,
                _ => {
                    self.forget_identity(base_stamp);
                    return AgyQuotaSnapshot::unavailable("auth_expired");
                }
            };
        }
        let fingerprint = credential.fingerprint.clone();
        let generation = self.bind_identity(base_stamp, &fingerprint);
        let stamp = format!("{base_stamp}:{generation}:{fingerprint}");
        let still_current = || {
            let same = current()
                && self
                    .identities
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .get(base_stamp)
                    .is_some_and(|(identity, epoch)| {
                        identity == &fingerprint && *epoch == generation
                    })
                && read().is_ok_and(|value| {
                    value.fingerprint == fingerprint && value.usable(now_seconds())
                });
            if !same {
                self.forget_identity_if(base_stamp, Some(generation));
            }
            same
        };
        let query = async {
            if !still_current() {
                return Err("auth_changed");
            }
            let value = match fetch(credential).await {
                Err("quota_unauthorized") => {
                    // A new token may represent another account: do not replay under
                    // the old binding. The next read establishes its own cache key.
                    return Err(match read() {
                        Ok(value) if value.fingerprint != fingerprint => "auth_changed",
                        _ => "auth_expired",
                    });
                }
                result => result?,
            };
            parse_api(&value, now_seconds())
        };
        self.read_bound(&stamp, cache_only, query, still_current)
            .await
    }
    fn cached(&self, stamp: &str, current: impl Fn() -> bool) -> AgyQuotaSnapshot {
        if !current() {
            return AgyQuotaSnapshot::unavailable("auth_changed");
        }
        let mut result = self
            .cache
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(stamp)
            .and_then(|e| e.snapshot.clone())
            .unwrap_or_else(|| AgyQuotaSnapshot::unavailable("not_loaded"));
        result.expire(now_seconds());
        if !current() {
            return AgyQuotaSnapshot::unavailable("auth_changed");
        }
        result
    }
    async fn read_bound(
        &self,
        stamp: &str,
        cache_only: bool,
        query: impl std::future::Future<Output = Result<Vec<AgyQuotaGroup>, &'static str>>,
        current: impl Fn() -> bool,
    ) -> AgyQuotaSnapshot {
        if cache_only {
            return self.cached(stamp, current);
        }
        let _guard = self.query.lock().await;
        if !current() {
            return AgyQuotaSnapshot::unavailable("auth_changed");
        }
        {
            let mut cache = self.cache.lock().unwrap_or_else(|p| p.into_inner());
            if cache.len() >= MAX_BINDINGS && !cache.contains_key(stamp) {
                if let Some(oldest) = cache
                    .iter()
                    .min_by_key(|(_, e)| e.last_attempt)
                    .map(|(key, _)| key.clone())
                {
                    cache.remove(&oldest);
                }
            }
            let entry = cache.entry(stamp.to_owned()).or_default();
            if entry.last_attempt.is_some_and(|at| at.elapsed() < COOLDOWN) {
                drop(cache);
                return self.cached(stamp, current);
            }
            entry.last_attempt = Some(Instant::now());
        }
        let result = tokio::time::timeout(Duration::from_secs(25), query)
            .await
            .unwrap_or(Err("query_timeout"));
        if !current() {
            return AgyQuotaSnapshot::unavailable("auth_changed");
        }
        let mut snapshot = match result {
            Ok(groups) => AgyQuotaSnapshot {
                status: "ready",
                groups,
                collected_at: Some(now_seconds()),
                source: Some("agy_quota_api"),
                error_code: None,
                ..Default::default()
            },
            Err(code) if invalidates_account(code) => AgyQuotaSnapshot::unavailable(code),
            Err(code) => {
                let mut old = self.cached(stamp, &current);
                old.status = "stale";
                old.error_code = Some(code);
                old
            }
        };
        snapshot.expire(now_seconds());
        if !current() {
            return AgyQuotaSnapshot::unavailable("auth_changed");
        }
        self.cache
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(stamp.to_owned())
            .or_default()
            .snapshot = Some(snapshot.clone());
        if let Some(callback) = self
            .changed
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_ref()
        {
            callback();
        }
        if !current() {
            return AgyQuotaSnapshot::unavailable("auth_changed");
        }
        snapshot
    }
}
#[tauri::command]
pub async fn agy_quota_read(
    state: tauri::State<'_, Arc<AgyQuotaState>>,
    provider_id: Option<String>,
    force: Option<bool>,
    cache_only: Option<bool>,
    workspace_path: Option<String>,
) -> Result<AgyQuotaSnapshot, String> {
    let _ = force; // Manual and automatic API reads share the same cooldown.
    let binding = match binding(
        provider_id.as_deref(),
        workspace_path.as_deref().map(Path::new),
    ) {
        Ok(value) => value,
        Err(code) => return Ok(AgyQuotaSnapshot::unavailable(code)),
    };
    Ok(tokio::time::timeout(
        Duration::from_secs(15),
        state.read_access(
            &binding.stamp,
            cache_only.unwrap_or(false),
            access::read,
            |credential| async move { access::fetch(&credential).await },
            || binding.current(),
        ),
    )
    .await
    .unwrap_or_else(|_| AgyQuotaSnapshot::unavailable("query_timeout")))
}

#[cfg(test)]
mod tests {
    use super::*;

    use serde_json::json;

    fn api_response(fraction: f64) -> Value {
        json!({"groups":[{"buckets":[{"bucketId":"gemini-5h", "window":"5h", "remainingFraction":fraction,"resetTime":"2099-01-01T00:00:00Z"}]}]})
    }

    fn credential(id: usize) -> access::Credential {
        access::fixture_credential(
            &format!("fixture-{id}"),
            reset_time("2099-01-01T00:00:00Z").unwrap(),
        )
    }

    #[tokio::test]
    async fn observed_identity_loss_never_revives_an_old_cache() {
        for missing in [false, true] {
            let state = AgyQuotaState::default();
            state
                .read_access(
                    "route",
                    false,
                    || Ok(credential(1)),
                    |_| async { Ok(api_response(0.5)) },
                    || true,
                )
                .await;
            if missing {
                state
                    .read_access(
                        "route",
                        true,
                        || Err("auth_missing"),
                        |_| async { panic!("cache only") },
                        || true,
                    )
                    .await;
            } else {
                state
                    .read_access(
                        "route",
                        true,
                        || Ok(credential(2)),
                        |_| async { panic!("cache only") },
                        || true,
                    )
                    .await;
            }
            let restored = state
                .read_access(
                    "route",
                    true,
                    || Ok(credential(1)),
                    |_| async { panic!("cache only") },
                    || true,
                )
                .await;
            assert_eq!(restored.error_code, Some("not_loaded"));
            assert!(restored.groups.is_empty());
        }
    }

    #[tokio::test]
    async fn invalid_context_never_reads_credentials_and_expiry_during_fetch_discards_reply() {
        let state = AgyQuotaState::default();
        let blocked = state
            .read_access(
                "route",
                false,
                || panic!("must not read credentials"),
                |_| async { panic!("must not fetch") },
                || false,
            )
            .await;
        assert_eq!(blocked.error_code, Some("auth_changed"));
        let expired = AtomicBool::new(false);
        let result = state
            .read_access(
                "route",
                false,
                || {
                    Ok(if expired.load(Ordering::SeqCst) {
                        access::fixture_credential("fixture-1", 1)
                    } else {
                        credential(1)
                    })
                },
                |_| async {
                    expired.store(true, Ordering::SeqCst);
                    Ok(api_response(0.5))
                },
                || true,
            )
            .await;
        assert_eq!(result.error_code, Some("auth_changed"));
        assert!(state.cache.lock().unwrap().is_empty());
    }

    #[test]
    fn api_preserves_real_zero_and_separate_argon_windows() {
        let value = json!({"groups":[{"buckets":[
            {"bucketId":"gemini-5h","window":"5h","remainingFraction":0.5,"resetTime":"2099-01-01T00:00:00Z"},
            {"bucketId":"gemini-argon-wtu-weekly","window":"weekly","remainingFraction":0,"resetTime":"2099-01-01T00:00:00Z"},
            {"bucketId":"3p-5h","window":"5h","disabled":true}
        ]}]});
        let parsed = parse_api(&value, now_seconds()).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].id, "gemini");
        assert_eq!(parsed[1].id, "gemini_argon");
        assert_eq!(
            parsed[1]
                .windows
                .seven_day
                .as_ref()
                .unwrap()
                .used_percentage,
            100.0
        );
        assert_eq!(
            parse_api(&json!({"response":value.clone()}), now_seconds()).unwrap(),
            parsed
        );
        assert_eq!(
            parse_api(&json!({"summary":value}), now_seconds()).unwrap(),
            parsed
        );
        assert!(parse_api(&json!({"error":{"message":"private"},"groups":[]}), 0).is_err());
        assert!(parse_api(&json!({"groups":[]}), 0).is_err());
    }

    #[tokio::test]
    async fn api_bootstrap_is_read_only_and_cache_only_never_fetches() {
        let state = AgyQuotaState::default();
        let calls = AtomicUsize::new(0);
        let fetch = |_| async {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(api_response(0.75))
        };
        let empty = state
            .read_access("route", true, || Ok(credential(1)), fetch, || true)
            .await;
        assert_eq!(empty.error_code, Some("not_loaded"));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let (a, b) = tokio::join!(
            state.read_access("route", false, || Ok(credential(1)), fetch, || true),
            state.read_access("route", false, || Ok(credential(1)), fetch, || true),
        );
        assert_eq!(a, b);
        assert_eq!(a.source, Some("agy_quota_api"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert!(a.credits.is_none());
    }

    #[tokio::test]
    async fn expired_or_missing_credentials_never_fetch_or_show_old_quota() {
        let state = AgyQuotaState::default();
        state
            .read_access(
                "route",
                false,
                || Ok(credential(1)),
                |_| async { Ok(api_response(0.5)) },
                || true,
            )
            .await;
        let missing = state
            .read_access(
                "route",
                false,
                || Err("auth_missing"),
                |_| async { panic!("must not fetch") },
                || true,
            )
            .await;
        assert_eq!(missing.error_code, Some("auth_missing"));
        let reads = AtomicUsize::new(0);
        let expired = state
            .read_access(
                "route",
                false,
                || {
                    reads.fetch_add(1, Ordering::SeqCst);
                    Ok(access::fixture_credential("fixture-1", now_seconds() + 30))
                },
                |_| async { panic!("must not fetch") },
                || true,
            )
            .await;
        assert_eq!(expired.error_code, Some("auth_expired"));
        assert!(expired.groups.is_empty());
        assert_eq!(reads.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn agy_renewed_credentials_can_be_reread_without_refreshing_them() {
        let state = AgyQuotaState::default();
        let reads = AtomicUsize::new(0);
        let result = state
            .read_access(
                "route",
                false,
                || {
                    if reads.fetch_add(1, Ordering::SeqCst) == 0 {
                        Ok(access::fixture_credential("old-fixture", 1))
                    } else {
                        Ok(credential(2))
                    }
                },
                |_| async { Ok(api_response(0.5)) },
                || true,
            )
            .await;
        assert_eq!(result.status, "ready");
    }

    #[tokio::test]
    async fn unauthorized_never_replays_and_clears_even_unexpired_cached_values() {
        let state = AgyQuotaState::default();
        state
            .read_access(
                "route",
                false,
                || Ok(credential(1)),
                |_| async { Ok(api_response(0.5)) },
                || true,
            )
            .await;
        for entry in state.cache.lock().unwrap().values_mut() {
            entry.last_attempt = None;
        }
        let calls = AtomicUsize::new(0);
        let failed = state
            .read_access(
                "route",
                false,
                || Ok(credential(1)),
                |_| async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Err("quota_unauthorized")
                },
                || true,
            )
            .await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(failed.status, "unavailable");
        assert_eq!(failed.error_code, Some("auth_expired"));
        assert!(failed.groups.is_empty());
        let cache = state
            .read_access(
                "route",
                true,
                || Ok(credential(1)),
                |_| async { panic!("cache only") },
                || true,
            )
            .await;
        assert!(cache.groups.is_empty());
    }

    #[tokio::test]
    async fn changed_account_during_fetch_never_enters_new_accounts_cache() {
        let state = AgyQuotaState::default();
        let identity = AtomicUsize::new(1);
        for unauthorized in [false, true] {
            identity.store(1, Ordering::SeqCst);
            let result = state
                .read_access(
                    if unauthorized { "401" } else { "success" },
                    false,
                    || Ok(credential(identity.load(Ordering::SeqCst))),
                    |_| async {
                        identity.store(2, Ordering::SeqCst);
                        if unauthorized {
                            Err("quota_unauthorized")
                        } else {
                            Ok(api_response(0.5))
                        }
                    },
                    || true,
                )
                .await;
            assert_eq!(result.error_code, Some("auth_changed"));
            assert!(result.groups.is_empty());
        }
        let next = state
            .read_access(
                "success",
                true,
                || Ok(credential(2)),
                |_| async { panic!("cache only") },
                || true,
            )
            .await;
        assert_eq!(next.error_code, Some("not_loaded"));
    }

    #[tokio::test]
    #[ignore = "reads the user's native access token and performs one read-only Google quota request; never refreshes credentials"]
    async fn agy_access_live_smoke() {
        assert!(credential_context_allowed());
        let credential = access::read().unwrap_or_else(|code| panic!("credential status: {code}"));
        assert!(
            credential.usable(now_seconds()),
            "AGY access token needs renewal by AGY"
        );
        let value = access::fetch(&credential)
            .await
            .unwrap_or_else(|code| panic!("quota status: {code}"));
        let groups =
            parse_api(&value, now_seconds()).unwrap_or_else(|code| panic!("quota schema: {code}"));
        assert!(!groups.is_empty());
        println!(
            "Read-only AGY quota verified: {} groups; credentials unchanged",
            groups.len()
        );
    }
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    fn response(fraction: Value) -> Value {
        json!({"status":"SUCCESS", "command":{"name":"usage", "data":{"groups":[{"name":"untrusted display name", "buckets":[{"id":"gemini-5h", "window":"5h", "remaining_fraction":fraction, "reset_time":"2099-01-01T00:00:00Z"}]}]}}})
    }
    fn groups() -> Vec<AgyQuotaGroup> {
        parse_usage(&response(json!(0.75)), now_seconds()).unwrap()
    }
    #[test]
    fn fractions_zero_and_unknown_groups() {
        for (fraction, used) in [(0.0, 100.0), (1.0, 0.0), (0.75, 25.0)] {
            assert_eq!(
                parse_usage(&response(json!(fraction)), 0).unwrap()[0]
                    .windows
                    .five_hour
                    .as_ref()
                    .unwrap()
                    .used_percentage,
                used
            );
        }
        let mut v = response(json!(1));
        v["command"]["data"]["groups"][0]["buckets"][0]["id"] = json!("future-5h");
        assert_eq!(parse_usage(&v, 0), Err("quota_not_available"));
    }
    #[test]
    fn rejects_invalid_and_duplicate_buckets() {
        for v in [json!(-0.01), json!(1.01), json!("0.5"), Value::Null] {
            assert!(parse_usage(&response(v), 0).is_err());
        }
        for (key, value) in [
            ("window", json!("weekly")),
            ("reset_time", json!("2026-02-30T00:00:00Z")),
        ] {
            let mut v = response(json!(0.5));
            v["command"]["data"]["groups"][0]["buckets"][0][key] = value;
            assert!(parse_usage(&v, 0).is_err());
        }
        let mut v = response(json!(0.5));
        let duplicate = v["command"]["data"]["groups"][0].clone();
        v["command"]["data"]["groups"]
            .as_array_mut()
            .unwrap()
            .push(duplicate);
        assert!(parse_usage(&v, 0).is_err());
        v["status"] = json!("ERROR");
        assert!(parse_usage(&v, 0).is_err());
    }
    #[test]
    fn disabled_window_preserves_other_windows_and_real_zero() {
        let v = json!({"status":"SUCCESS", "command":{"name":"usage", "data":{"groups":[
            {"buckets":[
                {"id":"gemini-weekly","window":"weekly","remaining_fraction":0.002357103396207094,"reset_time":"2099-01-01T00:00:00Z"},
                {"id":"gemini-5h","window":"5h","remaining_fraction":1,"reset_time":"2099-01-01T00:00:00Z"}
            ]},
            {"buckets":[
                {"id":"3p-weekly","window":"weekly","remaining_fraction":0,"reset_time":"2099-01-01T00:00:00Z"},
                {"id":"3p-5h","window":"5h","disabled":true,"remaining_fraction":0.2773062288761139}
            ]}
        ]}}});
        let parsed = parse_usage(&v, 0).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(
            parsed[0]
                .windows
                .five_hour
                .as_ref()
                .unwrap()
                .used_percentage,
            0.0
        );
        assert!(parsed[0].windows.seven_day.is_some());
        assert_eq!(
            parsed[1]
                .windows
                .seven_day
                .as_ref()
                .unwrap()
                .used_percentage,
            100.0
        );
        assert!(parsed[1].windows.five_hour.is_none());

        // Only an explicit true permits the missing reset; enabled/malformed
        // buckets must retain the same strict validation.
        for disabled in [Value::Null, json!(false), json!("true")] {
            let mut enabled = v.clone();
            enabled["command"]["data"]["groups"][1]["buckets"][1]["disabled"] = disabled;
            assert_eq!(parse_usage(&enabled, 0), Err("invalid_response"));
        }
    }
    #[tokio::test]
    async fn all_disabled_windows_are_unavailable() {
        let v = json!({"status":"SUCCESS", "command":{"name":"usage", "data":{"groups":[
            {"buckets":[{"id":"3p-5h","window":"5h","disabled":true,"remaining_fraction":0.27}]}
        ]}}});
        let groups = parse_usage(&v, 0).unwrap();
        assert!(groups.is_empty());
        let state = AgyQuotaState::default();
        let snapshot = state
            .read_bound("all-disabled", false, async { Ok(groups) }, || true)
            .await;
        assert_eq!(snapshot.status, "unavailable");
        assert_eq!(snapshot.error_code, Some("quota_not_available"));
        assert!(snapshot.groups.is_empty());
    }
    #[test]
    fn strict_time_and_expiry() {
        assert_eq!(reset_time("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(reset_time("1970-01-01T01:00:00.123+01:00"), Some(0));
        for time in [
            "2026-02-29T00:00:00Z",
            "2026-01-01T24:00:00Z",
            "2026-01-01T00:00:00-00:00",
            "2026-01-01T00:00:00Zjunk",
        ] {
            assert_eq!(reset_time(time), None);
        }
        let mut s = AgyQuotaSnapshot {
            status: "ready",
            groups: groups(),
            collected_at: Some(1000),
            source: Some("agy_usage"),
            error_code: None,
            ..Default::default()
        };
        s.expire(1120);
        assert_eq!(s.status, "stale");
        s.expire(4600);
        assert_eq!(s.status, "stale");
        assert!(!s.groups.is_empty());
        assert_eq!(s.collected_at, Some(1000));
        assert_eq!(
            parse_usage(
                &response(json!(0.5)),
                reset_time("2099-01-01T00:00:00Z").unwrap()
            ),
            Err("quota_not_available")
        );
    }
    #[tokio::test]
    async fn concurrent_refresh_cooldown_cache_only_and_binding_changes() {
        let state = AgyQuotaState::default();
        let calls = AtomicUsize::new(0);
        let query = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Ok(groups())
        };
        let (a, b) = tokio::join!(
            state.read_bound("a", false, query(), || true),
            state.read_bound("a", false, query(), || true)
        );
        assert_eq!(a, b);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let _lock = state.query.lock().await;
        assert_eq!(
            state
                .read_bound("a", true, async { panic!("cache only") }, || true)
                .await,
            a
        );
        assert!(state
            .read_bound("b", true, async { panic!("cache only") }, || true)
            .await
            .groups
            .is_empty());
        assert_eq!(state.cached("a", || false).error_code, Some("auth_changed"));
    }
    #[tokio::test]
    async fn changed_during_query_and_failed_refresh() {
        let state = AgyQuotaState::default();
        let current = AtomicBool::new(true);
        let result = state
            .read_bound(
                "a",
                false,
                async {
                    current.store(false, Ordering::SeqCst);
                    Ok(groups())
                },
                || current.load(Ordering::SeqCst),
            )
            .await;
        assert_eq!(result.error_code, Some("auth_changed"));
        assert!(state.cached("a", || true).groups.is_empty());
        state
            .read_bound("b", false, async { Ok(groups()) }, || true)
            .await;
        state
            .cache
            .lock()
            .unwrap()
            .get_mut("b")
            .unwrap()
            .last_attempt = None;
        let stale = state
            .read_bound("b", false, async { Err("query_failed") }, || true)
            .await;
        assert_eq!(stale.status, "stale");
        assert!(!stale.groups.is_empty());
        assert_eq!(
            state
                .read_bound("b", false, async { panic!("cooldown") }, || true)
                .await,
            stale
        );
    }
    #[tokio::test]
    async fn bounded_cache_does_not_lose_other_bindings() {
        let state = AgyQuotaState::default();
        for index in 0..(MAX_BINDINGS + 3) {
            state
                .read_bound(&index.to_string(), false, async { Ok(groups()) }, || true)
                .await;
            assert!(state.cache.lock().unwrap().len() <= MAX_BINDINGS);
        }
        assert!(state.cached("0", || true).groups.is_empty());
        let checks = AtomicUsize::new(0);
        assert_eq!(
            state
                .cached("18", || checks.fetch_add(1, Ordering::SeqCst) == 0)
                .error_code,
            Some("auth_changed")
        );
    }
    #[tokio::test(start_paused = true)]
    async fn timeout_drops_query_and_consumes_cooldown() {
        struct DropFlag<'a>(&'a AtomicBool);
        impl Drop for DropFlag<'_> {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let dropped = AtomicBool::new(false);
        let state = AgyQuotaState::default();
        let result = state
            .read_bound(
                "a",
                false,
                async {
                    let _guard = DropFlag(&dropped);
                    std::future::pending::<Result<Vec<AgyQuotaGroup>, &'static str>>().await
                },
                || true,
            )
            .await;
        assert_eq!(result.error_code, Some("query_timeout"));
        assert!(dropped.load(Ordering::SeqCst));
        assert_eq!(
            state
                .read_bound(
                    "a",
                    false,
                    async { panic!("failed attempt still cools down") },
                    || true
                )
                .await,
            result
        );
    }
    #[test]
    fn groups_and_individual_window_expiry() {
        let mut v = response(json!(0.5));
        let buckets = v["command"]["data"]["groups"][0]["buckets"]
            .as_array_mut()
            .unwrap();
        buckets.push(json!({"id":"3p-weekly","window":"weekly","remaining_fraction":1,"reset_time":"2099-01-01T00:00:00Z"}));
        let parsed = parse_usage(&v, 0).unwrap();
        assert_eq!(parsed[1].id, "third_party");
        assert!(parsed[1].windows.five_hour.is_none());
        assert_eq!(
            parsed[1]
                .windows
                .seven_day
                .as_ref()
                .unwrap()
                .used_percentage,
            0.0
        );
        let mut snapshot = AgyQuotaSnapshot {
            status: "ready",
            groups: parsed,
            collected_at: Some(1000),
            source: Some("agy_usage"),
            error_code: None,
            ..Default::default()
        };
        snapshot.groups[0]
            .windows
            .five_hour
            .as_mut()
            .unwrap()
            .resets_at = Some(1100);
        snapshot.expire(1100);
        assert_eq!(snapshot.groups.len(), 2);
        assert_eq!(snapshot.groups[0].id, "gemini");
        assert_eq!(snapshot.status, "stale");
        let mut v = response(json!(0.5));
        v["command"]["name"] = json!("other");
        assert!(parse_usage(&v, 0).is_err());
    }
    #[test]
    fn remote_paths_fail_closed() {
        assert!(!local_path(Path::new("wsl:Ubuntu/home")));
        assert!(!local_path(Path::new("ssh:host/path")));
    }
    #[test]
    fn quota_rejects_missing_and_future_sample_times() {
        for collected_at in [None, Some(2000)] {
            let mut snapshot = AgyQuotaSnapshot {
                status: "ready",
                groups: groups(),
                collected_at,
                ..Default::default()
            };
            snapshot.expire(1000);
            assert_eq!(snapshot.status, "unavailable");
            assert!(snapshot.groups.is_empty());
        }
    }
    #[tokio::test]
    async fn old_sample_survives_sparse_and_failed_reads_but_disabled_clears() {
        let state = AgyQuotaState::default();
        let first = state
            .read_bound("a", false, async { Ok(groups()) }, || true)
            .await;
        {
            let mut cache = state.cache.lock().unwrap();
            let entry = cache.get_mut("a").unwrap();
            entry.last_attempt = None;
            entry.snapshot.as_mut().unwrap().collected_at = Some(1);
        }
        let empty = json!({"status":"SUCCESS","command":{"name":"usage","data":{"groups":[]}}});
        let stale = state
            .read_bound(
                "a",
                false,
                async { parse_usage(&empty, now_seconds()) },
                || true,
            )
            .await;
        assert_eq!(stale.groups, first.groups);
        assert_eq!(stale.collected_at, Some(1));
        assert_eq!(stale.status, "stale");
        state
            .cache
            .lock()
            .unwrap()
            .get_mut("a")
            .unwrap()
            .last_attempt = None;
        let disabled = json!({"status":"SUCCESS","command":{"name":"usage","data":{"groups":[{"buckets":[{"id":"gemini-5h","window":"5h","disabled":true}]}]}}});
        let cleared = state
            .read_bound(
                "a",
                false,
                async { parse_usage(&disabled, now_seconds()) },
                || true,
            )
            .await;
        assert!(cleared.groups.is_empty());
        assert_eq!(cleared.status, "unavailable");
    }
    #[test]
    fn unrelated_settings_and_dotenv_are_metadata_only() {
        let scratch =
            std::env::temp_dir().join(format!("ccgui-agy-quota-{}", uuid::Uuid::new_v4()));
        let home = scratch.join("agy");
        let workspace = scratch.join("workspace");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(scratch.join(".gemini")).unwrap();
        std::fs::write(home.join("settings.json"), br#"{"mcpServers":{"other":{"baseUrl":"https://mcp.invalid","provider":"unrelated"}},"env":{"OPENAI_API_KEY":"fixture"}}"#).unwrap();
        std::fs::write(workspace.join(".env"), "OTHER_ENGINE_KEY=fixture").unwrap();
        let stamp = || {
            let mut hash = Sha256::new();
            stamp_context_files(&mut hash, &home, &scratch, &workspace).unwrap();
            format!("{:x}", hash.finalize())
        };
        let before = stamp();
        std::fs::write(scratch.join(".gemini/google_account_id"), "fixture-account").unwrap();
        assert_ne!(before, stamp());
        // Invalid JSON still binds by metadata; this module never parses settings.
        std::fs::write(home.join("settings.json"), "not JSON and not inspected").unwrap();
        assert_ne!(before, stamp());
        std::fs::remove_dir_all(&scratch).unwrap();
    }
}
