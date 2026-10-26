//! Native `/usage` quota query. Credential contents never enter this module.
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
use tokio::io::{AsyncRead, AsyncReadExt};

const COOLDOWN: Duration = Duration::from_secs(60);
const MAX_AGE: u64 = 3600;
const MAX_OUTPUT: usize = 256 * 1024;
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
        if self.collected_at.is_none_or(|at| at > now || now - at >= MAX_AGE) {
            self.credits = None;
        }
        self.groups.retain(|g| g.windows != QuotaWindows::default());
        if self.groups.is_empty() {
            self.status = "unavailable";
            self.error_code.get_or_insert("quota_not_available");
        } else if self.groups.iter().flat_map(|g| [&g.windows.five_hour, &g.windows.seven_day])
            .flatten().any(|w| w.resets_at.is_some_and(|at| at <= now))
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
            let (index, suffix) = if let Some(s) = id.strip_prefix("gemini-") {
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
    bin: String,
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
fn binding(provider: Option<&str>, workspace: Option<&Path>) -> Result<Binding, &'static str> {
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
    let resolved = dunce::canonicalize(&bin).map_err(|_| "cli_unavailable")?;
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
        bin,
        workspace,
        provider: provider.map(str::to_owned),
    })
}
async fn read_bounded(reader: impl AsyncRead + Unpin) -> Result<Vec<u8>, &'static str> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_OUTPUT as u64 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| "query_failed")?;
    if bytes.len() > MAX_OUTPUT {
        return Err("response_too_large");
    }
    Ok(bytes)
}
async fn run_slash(binding: &Binding, slash: &str, timeout: &str) -> Result<Value, &'static str> {
    let mut cmd = crate::engine::command_for_binary(&binding.bin);
    crate::engine::agy::configure_background_command(&mut cmd);
    cmd.args([
        "--output-format",
        "json",
        "--print-timeout",
        timeout,
        "--print",
        slash,
    ])
    .current_dir(&binding.workspace)
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped())
    .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    let mut child = cmd.spawn().map_err(|_| "cli_unavailable")?;
    #[cfg(windows)]
    let _job = crate::engine::job::assign_kill_on_close(&child);
    let stdout = child.stdout.take().ok_or("query_failed")?;
    let stderr = child.stderr.take().ok_or("query_failed")?;
    let (output, _, status) =
        tokio::try_join!(read_bounded(stdout), read_bounded(stderr), async {
            child.wait().await.map_err(|_| "query_failed")
        })?;
    if !status.success() {
        return Err("query_failed");
    }
    serde_json::from_slice(&output).or_else(|_| {
        output
            .iter()
            .position(|&b| b == b'{')
            .ok_or("invalid_response")
            .and_then(|i| serde_json::from_slice(&output[i..]).map_err(|_| "invalid_response"))
    })
}

/// `/credits` reply: `{"command":{"name":"credits","data":{"remaining_credits":N}}}`.
fn parse_credits(value: &Value) -> Option<f64> {
    if value.get("status").and_then(Value::as_str) != Some("SUCCESS")
        || value.pointer("/command/name").and_then(Value::as_str) != Some("credits")
    {
        return None;
    }
    value
        .pointer("/command/data/remaining_credits")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= 0.0)
}

static CREDITS: LazyLock<Mutex<HashMap<String, (u64, f64)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn remember_credits(stamp: &str, credits: Option<f64>) {
    let mut map = CREDITS.lock().unwrap_or_else(|p| p.into_inner());
    match credits {
        Some(n) => {
            if map.len() >= MAX_BINDINGS && !map.contains_key(stamp) {
                if let Some(oldest) = map.iter().min_by_key(|(_, (at, _))| *at).map(|(key, _)| key.clone()) {
                    map.remove(&oldest);
                }
            }
            map.insert(stamp.to_owned(), (now_seconds(), n));
        }
        // A failed or malformed read is unknown, not the previous balance.
        None => { map.remove(stamp); }
    }
}

/// Attach the credits recorded by the last successful `/credits` read for
/// this exact binding. Unavailable snapshots never carry a balance.
fn with_credits(mut snapshot: AgyQuotaSnapshot, stamp: &str) -> AgyQuotaSnapshot {
    if snapshot.status == "unavailable" {
        return snapshot;
    }
    let now = now_seconds();
    snapshot.credits = CREDITS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(stamp)
        .filter(|(at, _)| *at <= now && now - *at < MAX_AGE)
        .map(|(_, remaining)| AgyCredits { remaining: *remaining });
    snapshot
}

async fn query(binding: &Binding) -> Result<Vec<AgyQuotaGroup>, &'static str> {
    let usage = run_slash(binding, "/usage", "20s").await?;
    let groups = parse_usage(&usage, now_seconds())?;
    let credits = tokio::time::timeout(
        Duration::from_secs(12),
        run_slash(binding, "/credits", "10s"),
    )
    .await
    .ok()
    .and_then(Result::ok)
    .and_then(|v| parse_credits(&v));
    remember_credits(&binding.stamp, credits);
    Ok(groups)
}

#[derive(Default)]
struct Entry {
    snapshot: Option<AgyQuotaSnapshot>,
    last_attempt: Option<Instant>,
}
#[derive(Default)]
pub struct AgyQuotaState {
    cache: Mutex<HashMap<String, Entry>>,
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
                source: Some("agy_usage"),
                error_code: None,
                ..Default::default()
            },
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
    let _ = force; // All callers share the minimum cooldown, including manual refresh.
    let binding = match binding(
        provider_id.as_deref(),
        workspace_path.as_deref().map(Path::new),
    ) {
        Ok(b) => b,
        Err(code) => return Ok(AgyQuotaSnapshot::unavailable(code)),
    };
    let stamp = binding.stamp.clone();
    let snapshot = tokio::time::timeout(
        Duration::from_secs(29),
        state.read_bound(
            &binding.stamp,
            cache_only.unwrap_or(false),
            query(&binding),
            || binding.current(),
        ),
    )
    .await
    .unwrap_or_else(|_| AgyQuotaSnapshot::unavailable("query_timeout"));
    Ok(with_credits(snapshot, &stamp))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[tokio::test]
    async fn agy_background_usage_and_credits_receive_true() {
        let fixture = crate::engine::agy::background_tests::Fixture::new(
            "echo {\"disabled\":\"%AGY_CLI_DISABLE_AUTO_UPDATE%\"}",
        );
        let binding = Binding {
            stamp: "fixture".into(),
            bin: fixture.bin(),
            workspace: fixture.0.clone(),
            provider: None,
        };
        for slash in ["/usage", "/credits"] {
            let result = run_slash(&binding, slash, "1s").await.unwrap();
            assert_eq!(result["disabled"], "true");
        }
        assert_eq!(
            fixture.calls(),
            [
                "--output-format json --print-timeout 1s --print /usage",
                "--output-format json --print-timeout 1s --print /credits",
            ]
        );
    }

    #[tokio::test]
    #[ignore = "requires a signed-in native AGY CLI; queries /usage without a model request"]
    async fn agy_live_smoke_reads_native_quota() {
        let workspace = std::env::var("CCGUI_AGY_SMOKE_WORKSPACE").expect("explicit local workspace");
        let binding = binding(None, Some(Path::new(&workspace))).expect("native local quota binding");
        let state = AgyQuotaState::default();
        let snapshot = state.read_bound(&binding.stamp, false, query(&binding), || binding.current()).await;
        assert_eq!(snapshot.status, "ready", "native quota status: {:?}", snapshot.error_code);
        assert_eq!(snapshot.source, Some("agy_usage"));
        assert!(!snapshot.groups.is_empty());
        println!("AGY native /usage validated: {} model groups, no model request", snapshot.groups.len());
    }
    use serde_json::json;
    #[test]
    fn credits_parse_strictly_and_attach_only_to_available_bound_snapshots() {
        let ok = json!({"status":"SUCCESS","command":{"name":"credits","data":{"remaining_credits":250}}});
        assert_eq!(parse_credits(&ok), Some(250.0));
        assert_eq!(parse_credits(&json!({"status":"SUCCESS","command":{"name":"credits","data":{"remaining_credits":0}}})), Some(0.0));
        for bad in [
            json!({"status":"ERROR","command":{"name":"credits","data":{"remaining_credits":1}}}),
            json!({"status":"SUCCESS","command":{"name":"usage","data":{"remaining_credits":1}}}),
            json!({"status":"SUCCESS","command":{"name":"credits","data":{"remaining_credits":-1}}}),
            json!({"status":"SUCCESS","command":{"name":"credits","data":{"remaining_credits":"9"}}}),
            json!({"status":"SUCCESS","command":{"name":"credits","data":{}}}),
        ] {
            assert_eq!(parse_credits(&bad), None, "{bad}");
        }
        remember_credits("credits-test", Some(12.5));
        let ready = AgyQuotaSnapshot { status: "ready", ..Default::default() };
        assert_eq!(with_credits(ready.clone(), "credits-test").credits, Some(AgyCredits { remaining: 12.5 }));
        assert_eq!(with_credits(ready.clone(), "other").credits, None);
        assert_eq!(with_credits(AgyQuotaSnapshot::unavailable("auth_changed"), "credits-test").credits, None);
        remember_credits("credits-test", None);
        assert_eq!(with_credits(ready, "credits-test").credits, None);
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
        assert_eq!(parsed[0].windows.five_hour.as_ref().unwrap().used_percentage, 0.0);
        assert!(parsed[0].windows.seven_day.is_some());
        assert_eq!(parsed[1].windows.seven_day.as_ref().unwrap().used_percentage, 100.0);
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
        let snapshot = state.read_bound("all-disabled", false, async { Ok(groups) }, || true).await;
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
            parse_usage(&response(json!(0.5)), reset_time("2099-01-01T00:00:00Z").unwrap()),
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
    async fn output_limit_and_bounded_cache() {
        assert_eq!(read_bounded(&b"{}"[..]).await.unwrap(), b"{}");
        let oversized = vec![b'x'; MAX_OUTPUT + 1];
        assert_eq!(
            read_bounded(oversized.as_slice()).await,
            Err("response_too_large")
        );
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
                status: "ready", groups: groups(), collected_at,
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
        let first = state.read_bound("a", false, async { Ok(groups()) }, || true).await;
        {
            let mut cache = state.cache.lock().unwrap();
            let entry = cache.get_mut("a").unwrap();
            entry.last_attempt = None;
            entry.snapshot.as_mut().unwrap().collected_at = Some(1);
        }
        let empty = json!({"status":"SUCCESS","command":{"name":"usage","data":{"groups":[]}}});
        let stale = state.read_bound("a", false, async { parse_usage(&empty, now_seconds()) }, || true).await;
        assert_eq!(stale.groups, first.groups);
        assert_eq!(stale.collected_at, Some(1));
        assert_eq!(stale.status, "stale");
        state.cache.lock().unwrap().get_mut("a").unwrap().last_attempt = None;
        let disabled = json!({"status":"SUCCESS","command":{"name":"usage","data":{"groups":[{"buckets":[{"id":"gemini-5h","window":"5h","disabled":true}]}]}}});
        let cleared = state.read_bound("a", false, async { parse_usage(&disabled, now_seconds()) }, || true).await;
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
