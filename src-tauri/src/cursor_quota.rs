//! Cursor 账号用量。CLI 没有无界面的 usage 子命令，这里复用它已经写在本机的登录态，
//! 调用官方 DashboardService，只把百分比、金额和重置时间交回界面。
//! 令牌不进入返回值、日志或错误字符串。

use serde::Serialize;
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const ENDPOINT: &str = "https://api2.cursor.sh/aiserver.v1.DashboardService";
const CACHE_FLOOR: Duration = Duration::from_secs(20);
const MAX_BODY: usize = 256 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CursorQuotaSnapshot {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collected_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub included_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub included_used_cents: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub included_limit_cents: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on_demand: Option<CursorOnDemand>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub included_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<&'static str>,
}

/// On-Demand 只有「关闭」和「固定上限」两种可展示状态。未知时整段省略。
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CursorOnDemand {
    Disabled,
    Fixed { used_cents: i64, limit_cents: i64 },
}

struct Cache {
    at: Instant,
    /// 只记录凭据文件的长度和修改时间，用来发现登出，不读取内容。
    stamp: Option<AuthStamp>,
    snapshot: CursorQuotaSnapshot,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct AuthStamp {
    len: u64,
    modified_ms: u128,
}

static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

fn unavailable(code: &'static str) -> CursorQuotaSnapshot {
    CursorQuotaSnapshot {
        status: "unavailable",
        collected_at: None,
        plan_name: None,
        resets_at: None,
        included_percent: None,
        included_used_cents: None,
        included_limit_cents: None,
        auto_percent: None,
        api_percent: None,
        on_demand: None,
        included_message: None,
        auto_message: None,
        api_message: None,
        error_code: Some(code),
    }
}

fn auth_stamp() -> Option<AuthStamp> {
    let meta = std::fs::metadata(auth_path()?).ok()?;
    if !meta.is_file() {
        return None;
    }
    let modified_ms = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis();
    Some(AuthStamp { len: meta.len(), modified_ms })
}

/// 自动刷新在 20 秒内复用缓存。手动刷新，或凭据文件变了（登录/登出），必须重查。
fn reuse_cache(force: bool, elapsed: Duration, cached: Option<AuthStamp>, current: Option<AuthStamp>) -> bool {
    !force && elapsed < CACHE_FLOOR && current.is_some() && cached == current
}

fn same_account(before: Option<AuthStamp>, after: Option<AuthStamp>) -> bool {
    before.is_some() && before == after
}

fn stale_cached(cache: &Cache, stamp: Option<AuthStamp>) -> Option<CursorQuotaSnapshot> {
    if same_account(cache.stamp, stamp) && cache.snapshot.status == "ready" {
        let mut stale = cache.snapshot.clone();
        stale.status = "stale";
        Some(stale)
    } else {
        None
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 与 Cursor CLI 相同的凭据文件：Windows `%APPDATA%/Cursor/auth.json`。
fn auth_path() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let base = std::env::var_os("APPDATA").map(PathBuf::from).or_else(|| {
            std::env::var_os("USERPROFILE")
                .map(|home| PathBuf::from(home).join("AppData").join("Roaming"))
        })?;
        Some(base.join("Cursor").join("auth.json"))
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".cursor").join("auth.json"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from).or_else(|| {
            std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config"))
        })?;
        Some(base.join("cursor").join("auth.json"))
    }
}

fn valid_token(token: &str) -> bool {
    let len = token.len();
    (20..=4096).contains(&len)
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn read_access_token() -> Result<String, &'static str> {
    let path = auth_path().ok_or("not_logged_in")?;
    let meta = std::fs::metadata(&path).map_err(|_| "not_logged_in")?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > 64 * 1024 {
        return Err("not_logged_in");
    }
    let text = std::fs::read_to_string(&path).map_err(|_| "read_failed")?;
    let value: Value = serde_json::from_str(&text).map_err(|_| "read_failed")?;
    match value.get("accessToken").and_then(Value::as_str) {
        Some(token) if valid_token(token) => Ok(token.to_string()),
        _ => Err("not_logged_in"),
    }
}

fn cents(value: Option<&Value>) -> Option<i64> {
    let number = value?;
    let raw = number.as_i64().or_else(|| {
        number.as_f64().and_then(|n| {
            if n.is_finite() && (0.0..1e12).contains(&n) {
                Some(n.round() as i64)
            } else {
                None
            }
        })
    })?;
    if (0..1_000_000_000_000).contains(&raw) {
        Some(raw)
    } else {
        None
    }
}

fn percent(value: Option<&Value>) -> Option<f64> {
    let number = value?.as_f64()?;
    if number.is_finite() && (0.0..=1000.0).contains(&number) {
        Some(number)
    } else {
        None
    }
}

fn epoch_seconds(value: Option<&Value>) -> Option<u64> {
    let raw = match value? {
        Value::String(text) => text.parse::<u64>().ok()?,
        Value::Number(number) => number.as_u64().or_else(|| {
            number.as_f64().and_then(|n| {
                if n.is_finite() && n >= 0.0 {
                    Some(n as u64)
                } else {
                    None
                }
            })
        })?,
        _ => return None,
    };
    let millis = if raw < 10_000_000_000 { raw.saturating_mul(1000) } else { raw };
    if (1_600_000_000_000..4_100_000_000_000).contains(&millis) {
        Some(millis / 1000)
    } else {
        None
    }
}

fn clean_text(value: Option<&Value>, max: usize) -> Option<String> {
    let text = value?.as_str()?.trim();
    if text.is_empty() || text.len() > max || text.chars().any(char::is_control) {
        return None;
    }
    if text.contains("Bearer ") || text.contains("eyJ") {
        return None;
    }
    Some(text.to_string())
}

fn plan_name(plan: Option<&Value>) -> Option<String> {
    clean_text(plan?.get("planInfo")?.get("planName"), 40).filter(|name| {
        name.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '+' | '-' | '.'))
    })
}

/// 把官方响应收成面板用的字段。Included 用 includedSpend/limit，和官方那句
/// “You've used N% of your included usage” 对齐；Auto / API 用各自的百分比。
pub(crate) fn parse_usage(
    usage: &Value,
    plan: Option<&Value>,
    hard: Option<&Value>,
    now: u64,
) -> CursorQuotaSnapshot {
    let Some(plan_usage) = usage.get("planUsage").filter(|v| v.is_object()) else {
        return unavailable("plan_unsupported");
    };
    let used = cents(plan_usage.get("includedSpend"));
    let limit = cents(plan_usage.get("limit"));
    let included_percent = match (used, limit) {
        (Some(used_cents), Some(limit_cents)) if limit_cents > 0 => {
            Some(used_cents as f64 / limit_cents as f64 * 100.0)
        }
        _ => percent(plan_usage.get("totalPercentUsed")),
    };
    let mut snapshot = CursorQuotaSnapshot {
        status: "ready",
        collected_at: Some(now),
        plan_name: plan_name(plan),
        resets_at: epoch_seconds(usage.get("billingCycleEnd"))
            .or_else(|| epoch_seconds(plan.and_then(|p| p.get("planInfo")?.get("billingCycleEnd")))),
        included_percent,
        included_used_cents: used,
        included_limit_cents: limit.filter(|n| *n > 0),
        auto_percent: percent(plan_usage.get("autoPercentUsed")),
        api_percent: percent(plan_usage.get("apiPercentUsed")),
        on_demand: on_demand(usage.get("spendLimitUsage"), hard),
        included_message: clean_text(usage.get("displayMessage"), 180),
        auto_message: clean_text(usage.get("autoModelSelectedDisplayMessage"), 180),
        api_message: clean_text(usage.get("namedModelSelectedDisplayMessage"), 180),
        error_code: None,
    };
    if snapshot.included_percent.is_none()
        && snapshot.auto_percent.is_none()
        && snapshot.api_percent.is_none()
    {
        snapshot.status = "unavailable";
        snapshot.error_code = Some("plan_unsupported");
    }
    snapshot
}

fn on_demand(spend: Option<&Value>, hard: Option<&Value>) -> Option<CursorOnDemand> {
    if hard.is_some_and(|v| v.get("noUsageBasedAllowed") == Some(&Value::Bool(true))) {
        return Some(CursorOnDemand::Disabled);
    }
    let limit = cents(spend.and_then(|v| v.get("individualLimit")));
    let used = cents(spend.and_then(|v| v.get("individualUsed"))).unwrap_or(0);
    match limit {
        Some(limit) if limit > 0 => Some(CursorOnDemand::Fixed {
            used_cents: used,
            limit_cents: limit,
        }),
        Some(_) => Some(CursorOnDemand::Disabled),
        None if hard.is_some() => None,
        None => None,
    }
}

async fn post_json(client: &reqwest::Client, token: &str, method: &str) -> Result<Value, &'static str> {
    let response = client
        .post(format!("{ENDPOINT}/{method}"))
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .header("connect-protocol-version", "1")
        .body("{}")
        .send()
        .await
        .map_err(|_| "query_failed")?;
    let status = response.status();
    let body = response.text().await.map_err(|_| "query_failed")?;
    // 【Cursor 用量】响应若回显令牌，整段丢弃，避免解析结果把凭据带出进程。
    if body.len() > MAX_BODY || body.contains(token) {
        return Err("query_failed");
    }
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err("auth");
    }
    if !status.is_success() {
        return Err("query_failed");
    }
    serde_json::from_str(&body).map_err(|_| "query_failed")
}

async fn fetch_snapshot(now: u64) -> CursorQuotaSnapshot {
    let token = match read_access_token() {
        Ok(token) => token,
        Err(code) => return unavailable(code),
    };
    let client = match reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(_) => return unavailable("query_failed"),
    };
    let usage = match post_json(&client, &token, "GetCurrentPeriodUsage").await {
        Ok(value) => value,
        Err(code) => return unavailable(code),
    };
    let (plan, hard) = tokio::join!(
        post_json(&client, &token, "GetPlanInfo"),
        post_json(&client, &token, "GetHardLimit"),
    );
    drop(token);
    parse_usage(&usage, plan.ok().as_ref(), hard.ok().as_ref(), now)
}

#[tauri::command]
pub async fn cursor_quota_read(force: Option<bool>) -> CursorQuotaSnapshot {
    let force = force.unwrap_or(false);
    let now = now_secs();
    let stamp = auth_stamp();
    if let Ok(guard) = CACHE.lock() {
        if let Some(cache) = guard.as_ref() {
            if reuse_cache(force, cache.at.elapsed(), cache.stamp, stamp) {
                return cache.snapshot.clone();
            }
        }
    }
    let snapshot = fetch_snapshot(now).await;
    // Never publish an in-flight response after the local account changes.
    if matches!(snapshot.error_code, Some("auth" | "not_logged_in")) {
        if let Ok(mut guard) = CACHE.lock() {
            *guard = None;
        }
        return snapshot;
    }
    if !same_account(stamp, auth_stamp()) {
        return unavailable("auth_changed");
    }
    if snapshot.status == "ready" {
        if let Ok(mut guard) = CACHE.lock() {
            *guard = Some(Cache {
                at: Instant::now(),
                stamp,
                snapshot: snapshot.clone(),
            });
        }
        return snapshot;
    }
    // 临时查询失败保留同一账号最后成功结果及采样时间。登录失效仍直接清空。
    if let Ok(guard) = CACHE.lock() {
        if let Some(cache) = guard.as_ref() {
            if let Some(mut stale) = stale_cached(cache, stamp) {
                stale.error_code = snapshot.error_code;
                return stale;
            }
        }
    }
    snapshot
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn transient_failure_keeps_old_sample_only_for_verified_same_account() {
        let stamp = AuthStamp { len: 1, modified_ms: 1 };
        let mut snapshot = unavailable("fixture");
        snapshot.status = "ready";
        snapshot.collected_at = Some(1);
        snapshot.included_percent = Some(42.0);
        let cache = Cache { at: Instant::now() - Duration::from_secs(7200), stamp: Some(stamp), snapshot };
        let stale = stale_cached(&cache, Some(stamp)).unwrap();
        assert_eq!(stale.status, "stale");
        assert_eq!(stale.collected_at, Some(1));
        assert_eq!(stale.included_percent, Some(42.0));
        assert!(stale_cached(&cache, None).is_none());
        assert!(!same_account(None, None));
        assert!(!same_account(Some(stamp), Some(AuthStamp { len: 2, modified_ms: 2 })));
    }

    #[test]
    fn included_uses_spend_over_limit_and_keeps_auto_api() {
        let usage = json!({
            "billingCycleEnd": "1794428806000",
            "planUsage": {
                "includedSpend": 1000,
                "limit": 4000,
                "autoPercentUsed": 12.15,
                "apiPercentUsed": 1.58,
                "totalPercentUsed": 3.0
            },
            "displayMessage": "You've used 25% of your included usage",
            "autoModelSelectedDisplayMessage": "You've used 12% of your included total usage",
            "namedModelSelectedDisplayMessage": "You've used 2% of your included API usage",
            "spendLimitUsage": { "limitType": "user" }
        });
        let plan = json!({"planInfo": {"planName": "Ultra", "billingCycleEnd": "1794428806000"}});
        let hard = json!({"noUsageBasedAllowed": true});
        let snapshot = parse_usage(&usage, Some(&plan), Some(&hard), 1_700_000_000);
        assert_eq!(snapshot.status, "ready");
        assert_eq!(snapshot.plan_name.as_deref(), Some("Ultra"));
        assert_eq!(snapshot.included_percent, Some(25.0));
        assert_eq!(snapshot.auto_percent, Some(12.15));
        assert_eq!(snapshot.api_percent, Some(1.58));
        assert_eq!(snapshot.on_demand, Some(CursorOnDemand::Disabled));
        assert_eq!(snapshot.resets_at, Some(1_794_428_806));
        assert!(snapshot.included_message.unwrap().contains("25%"));
    }

    #[test]
    fn on_demand_fixed_limit_and_rejects_token_text() {
        let usage = json!({
            "planUsage": { "totalPercentUsed": 10.0 },
            "displayMessage": "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
            "spendLimitUsage": { "individualUsed": 1200, "individualLimit": 5000 }
        });
        let snapshot = parse_usage(&usage, None, None, 10);
        assert_eq!(snapshot.included_percent, Some(10.0));
        assert_eq!(snapshot.included_message, None);
        assert_eq!(
            snapshot.on_demand,
            Some(CursorOnDemand::Fixed { used_cents: 1200, limit_cents: 5000 })
        );
    }

    #[test]
    fn missing_plan_usage_is_unavailable() {
        let snapshot = parse_usage(&json!({"enabled": true}), None, None, 10);
        assert_eq!(snapshot.status, "unavailable");
        assert_eq!(snapshot.error_code, Some("plan_unsupported"));
    }

    #[test]
    fn cache_misses_when_refreshed_or_auth_file_changes() {
        let stamp = AuthStamp { len: 10, modified_ms: 1 };
        let changed = AuthStamp { len: 0, modified_ms: 2 };
        assert!(reuse_cache(false, Duration::from_secs(5), Some(stamp), Some(stamp)));
        assert!(!reuse_cache(true, Duration::from_secs(5), Some(stamp), Some(stamp)));
        assert!(!reuse_cache(false, Duration::from_secs(5), Some(stamp), Some(changed)));
        assert!(!reuse_cache(false, Duration::from_secs(5), Some(stamp), None));
    }
}
