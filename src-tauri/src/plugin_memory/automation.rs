//! Durable shared admission. All ledger mutations hold the DB mutex and one
//! SQLite transaction; result eviction never removes request tombstones.
use super::protocol::digest;
use crate::db::Db;
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const NS: &str = "$ccgui-memory-automation";
const DAY_MS: u64 = 86_400_000;
pub const DAILY_TOKENS: u64 = 32_768;
pub const CALL_TOKENS: u64 = 16_384;
pub const OUTPUT_TOKENS: u64 = 8_192;
const CACHE_SIZE: usize = 64;

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
pub fn response(reason: &str, retry: u64) -> Value {
    json!({"status":"deferred", "reason":reason, "retryAfterMs":retry})
}
pub struct Identity {
    pub key: String,
    fingerprint: String,
}
impl Identity {
    pub fn new(plugin: &str, project: &str, kind: &str, id: &str, mut payload: Value) -> Self {
        if let Some(v) = payload.as_object_mut() {
            v.remove("reconcileOnly");
        }
        Self {
            key: format!(
                "request:{}",
                digest(&json!([plugin, project, kind, id]).to_string())
            ),
            fingerprint: digest(&payload.to_string()),
        }
    }
}
#[derive(Default, Serialize, Deserialize)]
struct Record {
    fingerprint: String,
    sent: bool,
    completed: bool,
    result: Option<Value>,
    #[serde(default)]
    replay: Option<Value>,
}
#[derive(Debug)]
pub struct Cached {
    pub result: Value,
    pub replay: Option<Value>,
}
#[derive(Serialize, Deserialize)]
struct Charge {
    key: String,
    at: u64,
    tokens: u64,
    #[serde(default)]
    usage: Option<Usage>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    pub total: u64,
    pub prompt: u64,
    pub candidates: u64,
    pub thoughts: u64,
    pub cached: u64,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Provider {
    config: String,
    failures: u32,
    probes: u32,
    open: bool,
    repair: bool,
    due: u64,
    // Persisted before countTokens. A crashed probe cannot silently reopen.
    active: Option<String>,
    active_since: u64,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Ledger {
    charges: Vec<Charge>,
    cached: Vec<String>,
    provider: Provider,
    calls: Vec<u64>,
}
fn read<T: serde::de::DeserializeOwned>(
    tx: &Transaction<'_>,
    key: &str,
) -> Result<Option<T>, String> {
    let raw: Option<String> = tx
        .query_row(
            "SELECT value FROM plugin_kv WHERE plugin_id=?1 AND key=?2",
            params![NS, key],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| "automation_storage_unavailable")?;
    raw.map(|v| serde_json::from_str(&v).map_err(|_| "automation_storage_corrupt".into()))
        .transpose()
}
fn write(tx: &Transaction<'_>, key: &str, value: &impl Serialize) -> Result<(), String> {
    let raw = serde_json::to_string(value).map_err(|_| "automation_storage_unavailable")?;
    tx.execute("INSERT INTO plugin_kv(plugin_id,key,value) VALUES(?1,?2,?3) ON CONFLICT(plugin_id,key) DO UPDATE SET value=excluded.value", params![NS,key,raw])
        .map_err(|_| "automation_storage_unavailable")?;
    Ok(())
}
fn transaction<T>(
    db: &Db,
    f: impl FnOnce(&Transaction<'_>, &mut Ledger) -> Result<T, String>,
) -> Result<T, String> {
    let mut conn = db.0.lock();
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| "automation_storage_unavailable")?;
    let mut ledger = read::<Ledger>(&tx, "ledger")?.unwrap_or_default();
    let result = f(&tx, &mut ledger)?;
    write(&tx, "ledger", &ledger)?;
    tx.commit().map_err(|_| "automation_storage_unavailable")?;
    Ok(result)
}
fn existing(record: &Record, identity: &Identity) -> Result<Value, String> {
    if record.fingerprint != identity.fingerprint {
        return Err("request_input_mismatch".into());
    }
    if record.completed
        && !record.sent
        && record.result.as_ref().is_some_and(|v| {
            v["status"] == "deferred"
                && matches!(
                    v["reason"].as_str(),
                    Some(
                        "preempted"
                            | "foreground_busy"
                            | "foreground_or_cooldown"
                            | "provider_busy"
                    )
                )
        })
    {
        return Ok(response(
            "request_not_started",
            record
                .result
                .as_ref()
                .and_then(|v| v["retryAfterMs"].as_u64())
                .unwrap_or(30000),
        ));
    }
    Ok(record
        .result
        .clone()
        .unwrap_or_else(|| response("request_outcome_unknown", 60_000)))
}
/// Caller must authorize current plugin permissions and project before lookup.
/// Reconciliation never inserts even a ledger row.
pub fn ready(db: &Db) -> Result<(), String> {
    let mut conn = db.0.lock();
    let tx = conn
        .transaction()
        .map_err(|_| "automation_storage_unavailable")?;
    let _ = read::<Ledger>(&tx, "ledger")?;
    Ok(())
}
/// Read-only scheduler feedback: a stopped provider must not create a new
/// request tombstone every time the plugin polls its local queue.
pub fn scheduler_wait(
    db: &Db,
    config: &str,
    at: u64,
) -> Result<Option<(bool, &'static str, u64)>, String> {
    let mut conn = db.0.lock();
    let tx = conn
        .transaction()
        .map_err(|_| "automation_storage_unavailable")?;
    let ledger = read::<Ledger>(&tx, "ledger")?.unwrap_or_default();
    let charges: Vec<_> = ledger
        .charges
        .iter()
        .filter(|c| at.saturating_sub(c.at) < DAY_MS)
        .map(|c| (c.at, c.tokens))
        .collect();
    if !budget_allows(&charges, at, OUTPUT_TOKENS + 256) {
        let due = charges
            .iter()
            .map(|(t, _)| t.saturating_add(DAY_MS))
            .min()
            .unwrap_or(at.saturating_add(DAY_MS));
        return Ok(Some((
            true,
            "token_budget_exhausted",
            due.saturating_sub(at).max(1000),
        )));
    }
    let provider = &ledger.provider;
    if provider.config == config {
        if provider.active.is_some() && at.saturating_sub(provider.active_since) < 180_000 {
            return Ok(Some((
                true,
                "provider_busy",
                180_000 - at.saturating_sub(provider.active_since),
            )));
        }
        if provider.repair {
            return Ok(Some((false, "provider_requires_repair", 300_000)));
        }
        if provider.due > at {
            return Ok(Some((
                true,
                if provider.open {
                    "provider_circuit_open"
                } else {
                    "provider_backoff"
                },
                provider.due - at,
            )));
        }
    }
    let calls: Vec<_> = ledger
        .calls
        .iter()
        .copied()
        .filter(|t| at.saturating_sub(*t) < 3_600_000)
        .collect();
    let mut due = calls.last().map_or(0, |t| t.saturating_add(60_000));
    if calls.len() >= 6 {
        due = due.max(calls[0].saturating_add(3_600_000));
    }
    Ok((due > at).then(|| (true, "provider_rate_limit", due - at)))
}
pub fn lookup(
    db: &Db,
    identity: &Identity,
    authorize: impl FnOnce() -> Result<(), String>,
) -> Result<Option<Cached>, String> {
    authorize()?;
    let mut conn = db.0.lock();
    let tx = conn
        .transaction()
        .map_err(|_| "automation_storage_unavailable")?;
    read::<Record>(&tx, &identity.key)?
        .map(|r| {
            existing(&r, identity).map(|result| Cached {
                result,
                replay: r.replay,
            })
        })
        .transpose()
}
pub fn begin(db: &Db, identity: &Identity) -> Result<Option<Value>, String> {
    transaction(db, |tx, _| {
        if let Some(record) = read::<Record>(tx, &identity.key)? {
            existing(&record, identity)?;
            // Admission races must never bypass the cache's source validator.
            return Ok(Some(response("request_outcome_unknown", 60_000)));
        }
        write(
            tx,
            &identity.key,
            &Record {
                fingerprint: identity.fingerprint.clone(),
                ..Default::default()
            },
        )?;
        Ok(None)
    })
}
pub fn save_replay(db: &Db, identity: &Identity, replay: Value) -> Result<(), String> {
    transaction(db, |tx, _| {
        let mut record = read::<Record>(tx, &identity.key)?.ok_or("request_not_started")?;
        existing(&record, identity)?;
        if record.completed {
            return Err("request_already_completed".into());
        }
        record.replay = Some(replay);
        write(tx, &identity.key, &record)
    })
}
pub fn complete(db: &Db, identity: &Identity, result: &Value) -> Result<(), String> {
    transaction(db, |tx, ledger| {
        let Some(mut record) = read::<Record>(tx, &identity.key)? else {
            return Ok(());
        };
        existing(&record, identity)?;
        if record.completed {
            return Ok(());
        }
        if !record.sent {
            ledger.charges.retain(|c| c.key != identity.key);
        }
        record.completed = true;
        record.result = Some(result.clone());
        write(tx, &identity.key, &record)?;
        ledger.cached.push(identity.key.clone());
        while ledger.cached.len() > CACHE_SIZE {
            let key = ledger.cached.remove(0);
            if let Some(mut old) = read::<Record>(tx, &key)? {
                old.result = None;
                old.replay = None;
                write(tx, &key, &old)?;
            }
        }
        Ok(())
    })
}
/// countTokens measures prompt input. Schema/protocol allowance is deliberately
/// conservative bytes treated as tokens, never presented as measured usage.
pub fn reservation(input_tokens: u64, schema_bytes: usize) -> Option<u64> {
    let amount = input_tokens
        .checked_add(OUTPUT_TOKENS)?
        .checked_add(schema_bytes as u64)?
        .checked_add(256)?;
    (amount <= CALL_TOKENS).then_some(amount)
}
pub fn budget_allows(charges: &[(u64, u64)], at: u64, amount: u64) -> bool {
    amount <= CALL_TOKENS
        && charges
            .iter()
            .filter(|(t, _)| at.saturating_sub(*t) < DAY_MS)
            .fold(0u64, |sum, (_, n)| sum.saturating_add(*n))
            .saturating_add(amount)
            <= DAILY_TOKENS
}
fn budget(ledger: &mut Ledger, at: u64, amount: u64) -> bool {
    ledger.charges.retain(|c| at.saturating_sub(c.at) < DAY_MS);
    budget_allows(
        &ledger
            .charges
            .iter()
            .map(|c| (c.at, c.tokens))
            .collect::<Vec<_>>(),
        at,
        amount,
    )
}
pub fn claim_provider(
    db: &Db,
    identity: &Identity,
    config: &str,
    at: u64,
) -> Result<Option<Value>, String> {
    transaction(db, |_, ledger| {
        if !budget(ledger, at, OUTPUT_TOKENS + 256) {
            return Ok(Some(response("token_budget_exhausted", DAY_MS)));
        }
        let p = &mut ledger.provider;
        if p.active.is_some() {
            let elapsed = at.saturating_sub(p.active_since);
            if elapsed < 180_000 {
                return Ok(Some(response("provider_busy", 180_000 - elapsed)));
            }
            // The old process/future did not settle its bounded attempt. Keep
            // that request unknown, but account one failure rather than freeze
            // unrelated work forever. An expired owner cannot mark a send.
            p.active = None;
            provider_failure(p, at, 0);
        }
        if p.config != config {
            *p = Provider {
                config: config.into(),
                ..Default::default()
            };
        }
        if p.repair {
            return Ok(Some(response("provider_requires_repair", 0)));
        }
        if p.due > at {
            return Ok(Some(response(
                if p.open {
                    "provider_circuit_open"
                } else {
                    "provider_backoff"
                },
                p.due - at,
            )));
        }
        ledger.calls.retain(|t| at.saturating_sub(*t) < 3_600_000);
        let mut due = ledger.calls.last().map_or(0, |t| t.saturating_add(60_000));
        if ledger.calls.len() >= 6 {
            due = due.max(ledger.calls[0].saturating_add(3_600_000));
        }
        if due > at {
            return Ok(Some(response("provider_rate_limit", due - at)));
        }
        p.active = Some(identity.key.clone());
        p.active_since = at;
        ledger.calls.push(at);
        Ok(None)
    })
}
pub fn reserve(db: &Db, identity: &Identity, tokens: u64, at: u64) -> Result<bool, String> {
    transaction(db, |tx, ledger| {
        let record = read::<Record>(tx, &identity.key)?.ok_or("request_not_started")?;
        existing(&record, identity)?;
        if record.sent || record.completed || ledger.charges.iter().any(|c| c.key == identity.key) {
            return Ok(false);
        }
        if !budget(ledger, at, tokens) {
            return Ok(false);
        }
        ledger.charges.push(Charge {
            key: identity.key.clone(),
            at,
            tokens,
            usage: None,
        });
        Ok(true)
    })
}
pub fn mark_sent(db: &Db, identity: &Identity, at: u64) -> Result<(), String> {
    transaction(db, |tx, ledger| {
        let mut record = read::<Record>(tx, &identity.key)?.ok_or("request_not_started")?;
        existing(&record, identity)?;
        if record.sent || record.completed || !ledger.charges.iter().any(|c| c.key == identity.key)
        {
            return Err("request_already_started".into());
        }
        if ledger.provider.active.as_deref() != Some(identity.key.as_str())
            || at.saturating_sub(ledger.provider.active_since) >= 180_000
        {
            return Err("provider_claim_expired".into());
        }
        ledger.provider.active_since = at;
        record.sent = true;
        write(tx, &identity.key, &record)
    })
}
/// Trust only complete, self-consistent provider usage; cached prompt tokens are
/// a subset of prompt, while thoughts are in total and in the output cap.
pub fn usage(value: &Value) -> Option<u64> {
    let u = value.get("usageMetadata")?;
    let total = u.get("totalTokenCount")?.as_u64()?;
    let prompt = u.get("promptTokenCount")?.as_u64()?;
    let candidates = u.get("candidatesTokenCount")?.as_u64()?;
    let thoughts = u
        .get("thoughtsTokenCount")
        .map(Value::as_u64)
        .unwrap_or(Some(0))?;
    let cached = u
        .get("cachedContentTokenCount")
        .map(Value::as_u64)
        .unwrap_or(Some(0))?;
    (total > 0
        && cached <= prompt
        && total >= prompt.checked_add(candidates)?.checked_add(thoughts)?)
    .then_some(total)
}
pub fn measurement(value: &Value) -> Option<Usage> {
    let total = usage(value)?;
    let u = &value["usageMetadata"];
    Some(Usage {
        total,
        prompt: u["promptTokenCount"].as_u64()?,
        candidates: u["candidatesTokenCount"].as_u64()?,
        thoughts: u
            .get("thoughtsTokenCount")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cached: u
            .get("cachedContentTokenCount")
            .and_then(Value::as_u64)
            .unwrap_or(0),
    })
}
pub fn settle(db: &Db, identity: &Identity, usage: Option<Usage>) -> Result<(), String> {
    transaction(db, |_, ledger| {
        if let (Some(actual), Some(c)) = (
            usage,
            ledger.charges.iter_mut().find(|c| c.key == identity.key),
        ) {
            c.tokens = actual.total;
            c.usage = Some(actual);
        }
        Ok(())
    })
}
pub enum Health {
    Success,
    Neutral,
    Failure,
    Quota(Option<u64>),
    Repair,
}
/// A valid provider envelope proves transport recovery even when the bounded
/// business JSON/evidence validator rejects this particular input's answer.
pub fn business_response_received(db: &Db, identity: &Identity, at: u64) -> Result<(), String> {
    health(db, identity, Health::Success, at).map(|_| ())
}
fn provider_failure(p: &mut Provider, at: u64, jitter: u64) {
    if p.open {
        p.probes = p.probes.saturating_add(1);
        if p.probes >= 2 {
            p.repair = true;
        }
    }
    p.failures = p.failures.saturating_add(1);
    p.open |= p.failures >= 3;
    let base = if p.open {
        1_800_000
    } else {
        60_000u64 << p.failures.saturating_sub(1).min(5)
    };
    p.due = at.saturating_add(base.saturating_add(jitter.min(10_000)).min(1_800_000));
}
pub fn health(db: &Db, identity: &Identity, health: Health, at: u64) -> Result<u64, String> {
    transaction(db, |_, ledger| {
        let p = &mut ledger.provider;
        if p.active.as_deref() != Some(identity.key.as_str()) {
            return Ok(p.due.saturating_sub(at));
        }
        p.active = None;
        if let Some(last) = ledger.calls.last_mut() {
            *last = (*last).max(at);
        }
        match health {
            Health::Success => {
                p.failures = 0;
                p.probes = 0;
                p.open = false;
                p.due = 0;
            }
            Health::Neutral => {}
            Health::Repair => p.repair = true,
            Health::Quota(delay) => {
                let local = if p.open {
                    1_800_000
                } else {
                    60_000u64 << p.failures.saturating_sub(1).min(5)
                };
                p.due = at.saturating_add(delay.unwrap_or(60_000).max(local));
            }
            Health::Failure => {
                provider_failure(p, at, (uuid::Uuid::new_v4().as_u128() % 10_001) as u64);
            }
        }
        Ok(p.due.saturating_sub(at))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    fn fixture() -> Db {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE plugin_kv(plugin_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(plugin_id,key));").unwrap();
        Db(parking_lot::Mutex::new(conn))
    }
    fn id(kind: &str, request: &str) -> Identity {
        Identity::new("plugin", "project", kind, request, json!({"input":"exact"}))
    }
    fn lookup_ok(db: &Db, identity: &Identity) -> Option<Value> {
        lookup(db, identity, || Ok(())).unwrap().map(|c| c.result)
    }
    fn charged(db: &Db) -> u64 {
        transaction(db, |_, l| Ok(l.charges.iter().map(|c| c.tokens).sum())).unwrap()
    }
    #[test]
    fn only_completed_unsent_receipts_prove_no_dispatch() {
        let identity = id("extract", "unsent");
        for reason in [
            "preempted",
            "foreground_busy",
            "foreground_or_cooldown",
            "provider_busy",
        ] {
            let mut record = Record {
                fingerprint: identity.fingerprint.clone(),
                completed: true,
                result: Some(response(reason, 7000)),
                ..Default::default()
            };
            assert_eq!(
                existing(&record, &identity).unwrap(),
                response("request_not_started", 7000)
            );
            record.sent = true;
            assert_eq!(existing(&record, &identity).unwrap()["reason"], reason);
            record.sent = false;
            record.completed = false;
            record.result = None;
            assert_eq!(
                existing(&record, &identity).unwrap()["reason"],
                "request_outcome_unknown"
            );
        }
    }
    #[test]
    fn pure_token_budget_and_usage_include_thinking_and_cache_without_double_count() {
        assert_eq!(reservation(1000, 500), Some(9948));
        assert!(reservation(8000, 1000).is_none());
        assert!(reservation(u64::MAX, 1).is_none());
        assert!(budget_allows(&[(100, 16384)], 100, 16384));
        assert!(!budget_allows(&[(100, 16384), (101, 1)], 101, 16384));
        assert!(budget_allows(&[(100, 32768)], 100 + DAY_MS, 16384));
        let response = json!({"usageMetadata":{"totalTokenCount":5000,"promptTokenCount":1000,"candidatesTokenCount":1000,"thoughtsTokenCount":3000,"cachedContentTokenCount":800}});
        assert_eq!(usage(&response), Some(5000));
        let mut invalid = response.clone();
        invalid["usageMetadata"]["totalTokenCount"] = 2000.into();
        assert_eq!(usage(&invalid), None);
        invalid = response.clone();
        invalid["usageMetadata"]["cachedContentTokenCount"] = 1001.into();
        assert_eq!(usage(&invalid), None);
        assert_eq!(usage(&json!({"usageMetadata":{"totalTokenCount":1}})), None);
        assert_eq!(usage(&json!({})), None);
    }
    #[test]
    fn concurrent_extraction_and_review_reservations_cannot_overspend() {
        let db = Arc::new(fixture());
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let jobs: Vec<_> = (0..8)
            .map(|i| {
                let db = db.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let identity = id(
                        if i % 2 == 0 { "extract" } else { "review" },
                        &i.to_string(),
                    );
                    begin(&db, &identity).unwrap();
                    barrier.wait();
                    reserve(&db, &identity, 16384, 100).unwrap()
                })
            })
            .collect();
        assert_eq!(
            jobs.into_iter()
                .map(|job| job.join().unwrap())
                .filter(|ok| *ok)
                .count(),
            2
        );
        assert_eq!(charged(&db), DAILY_TOKENS);
    }
    #[test]
    fn unknown_and_missing_usage_keep_reservation_known_usage_reclaims_surplus() {
        let db = fixture();
        let first = id("extract", "unknown");
        begin(&db, &first).unwrap();
        assert!(claim_provider(&db, &first, "config", 100)
            .unwrap()
            .is_none());
        assert!(reserve(&db, &first, 16384, 100).unwrap());
        mark_sent(&db, &first, 100).unwrap();
        health(&db, &first, Health::Neutral, 100).unwrap();
        settle(&db, &first, None).unwrap();
        complete(&db, &first, &response("request_outcome_unknown", 60000)).unwrap();
        assert_eq!(charged(&db), 16384);
        assert_eq!(
            lookup_ok(&db, &first).unwrap()["reason"],
            "request_outcome_unknown"
        );
        let second = id("review", "measured");
        begin(&db, &second).unwrap();
        assert!(claim_provider(&db, &second, "config", 60100)
            .unwrap()
            .is_none());
        assert!(reserve(&db, &second, 16384, 60100).unwrap());
        mark_sent(&db, &second, 60100).unwrap();
        let measured = measurement(
            &json!({"usageMetadata":{"totalTokenCount":5000,"promptTokenCount":1000,"candidatesTokenCount":1000,"thoughtsTokenCount":3000,"cachedContentTokenCount":800}}),
        );
        settle(&db, &second, measured).unwrap();
        assert_eq!(
            transaction(&db, |_, l| Ok(l
                .charges
                .iter()
                .find(|c| c.key == second.key)
                .unwrap()
                .usage))
            .unwrap(),
            measured
        );
        complete(&db, &second, &json!({"status":"completed"})).unwrap();
        assert_eq!(charged(&db), 21384);
        assert!(mark_sent(&db, &first, 60100).is_err());
        assert!(!reserve(&db, &first, 1000, 100).unwrap());
    }
    #[test]
    fn both_kinds_reconcile_and_normal_retry_dispatch_at_most_once() {
        for kind in ["extract", "review"] {
            let db = fixture();
            let identity = id(kind, "same-id");
            let mut dispatches = 0;
            // Reconcile-only uses lookup, not begin. No request or ledger row.
            assert!(lookup_ok(&db, &identity).is_none());
            for _ in 0..3 {
                if begin(&db, &identity).unwrap().is_none() {
                    assert!(claim_provider(&db, &identity, "config", 100)
                        .unwrap()
                        .is_none());
                    reserve(&db, &identity, 1000, 100).unwrap();
                    mark_sent(&db, &identity, 100).unwrap();
                    dispatches += 1;
                }
            }
            assert_eq!(dispatches, 1);
            assert_eq!(
                lookup_ok(&db, &identity).unwrap()["reason"],
                "request_outcome_unknown"
            );
            let result = json!({"status":"completed","batch":{"kind":kind}});
            complete(&db, &identity, &result).unwrap();
            assert_eq!(lookup_ok(&db, &identity), Some(result.clone()));
            assert_eq!(
                begin(&db, &identity).unwrap().unwrap()["reason"],
                "request_outcome_unknown"
            );
            let changed = Identity::new(
                "plugin",
                "project",
                kind,
                "same-id",
                json!({"input":"changed"}),
            );
            assert_eq!(
                lookup(&db, &changed, || Ok(())).unwrap_err(),
                "request_input_mismatch"
            );
            let reconcile = Identity::new(
                "plugin",
                "project",
                kind,
                "same-id",
                json!({"input":"exact","reconcileOnly":true}),
            );
            assert_eq!(reconcile.fingerprint, identity.fingerprint);
        }
    }
    #[test]
    fn reconcile_missing_is_read_only_and_revocation_precedes_cached_result() {
        let db = fixture();
        let identity = id("extract", "cached");
        assert!(lookup_ok(&db, &identity).is_none());
        assert_eq!(
            db.0.lock()
                .query_row("SELECT count(*) FROM plugin_kv", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        begin(&db, &identity).unwrap();
        complete(
            &db,
            &identity,
            &json!({"status":"completed","secret":"project result"}),
        )
        .unwrap();
        for denial in ["memory_permission_required", "project_not_registered"] {
            assert_eq!(
                lookup(&db, &identity, || Err(denial.into())).unwrap_err(),
                denial
            );
        }
        let foreign = Identity::new(
            "plugin",
            "other-project",
            "extract",
            "cached",
            json!({"input":"exact"}),
        );
        assert!(lookup_ok(&db, &foreign).is_none());
    }
    #[test]
    fn result_eviction_preserves_replay_tombstone() {
        let db = fixture();
        let first = id("review", "0");
        for n in 0..=CACHE_SIZE {
            let identity = id("review", &n.to_string());
            begin(&db, &identity).unwrap();
            complete(&db, &identity, &json!({"status":"completed","n":n})).unwrap();
        }
        assert_eq!(
            lookup_ok(&db, &first).unwrap()["reason"],
            "request_outcome_unknown"
        );
        assert!(begin(&db, &first).unwrap().is_some());
        assert!(mark_sent(&db, &first, 100).is_err());
        assert_eq!(
            transaction(&db, |_, l| Ok(l.cached.len())).unwrap(),
            CACHE_SIZE
        );
    }
    #[test]
    fn reopen_preserves_unknown_budget_and_provider_breaker() {
        let path = std::env::temp_dir().join(format!(
            "ccgui-memory-fixture-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let identity = id("extract", "sent");
        {
            let conn = rusqlite::Connection::open(&path).unwrap();
            conn.execute_batch("CREATE TABLE plugin_kv(plugin_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(plugin_id,key));").unwrap();
            let db = Db(parking_lot::Mutex::new(conn));
            begin(&db, &identity).unwrap();
            claim_provider(&db, &identity, "config", 100).unwrap();
            reserve(&db, &identity, 16384, 100).unwrap();
            mark_sent(&db, &identity, 100).unwrap();
        }
        let db = Db(parking_lot::Mutex::new(
            rusqlite::Connection::open(&path).unwrap(),
        ));
        assert_eq!(charged(&db), 16384);
        assert!(begin(&db, &identity).unwrap().is_some());
        assert_eq!(
            claim_provider(&db, &id("review", "new"), "config", 200)
                .unwrap()
                .unwrap()["reason"],
            "provider_busy"
        );
        assert_eq!(
            claim_provider(&db, &id("review", "new"), "config", 180100)
                .unwrap()
                .unwrap()["reason"],
            "provider_backoff"
        );
        assert!(
            claim_provider(&db, &id("review", "new"), "verified-changed-config", 240100)
                .unwrap()
                .is_none()
        );
        drop(db);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn shared_failure_circuit_has_single_half_open_and_two_failed_probe_limit() {
        let db = fixture();
        let mut at = 100;
        for (n, delay) in [60000, 120000, 1800000, 1800000, 1800000]
            .into_iter()
            .enumerate()
        {
            let identity = id(
                if n % 2 == 0 { "extract" } else { "review" },
                &n.to_string(),
            );
            assert!(claim_provider(&db, &identity, "config", at)
                .unwrap()
                .is_none());
            assert!(
                claim_provider(&db, &id("extract", "concurrent"), "config", at)
                    .unwrap()
                    .is_some()
            );
            let actual = health(&db, &identity, Health::Failure, at).unwrap();
            assert!((delay..=(delay + 10000).min(1_800_000)).contains(&actual));
            assert!(
                claim_provider(&db, &id("review", "different-task"), "config", at + 1)
                    .unwrap()
                    .is_some()
            );
            at += actual;
        }
        let stopped = claim_provider(&db, &id("review", "sixth"), "config", at + DAY_MS)
            .unwrap()
            .unwrap();
        assert_eq!(stopped["reason"], "provider_requires_repair");
        assert!(
            claim_provider(&db, &id("review", "repaired"), "new-config", at)
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn quota_obeys_retry_after_without_incrementing_transient_failure_count() {
        let db = fixture();
        let identity = id("extract", "quota");
        claim_provider(&db, &identity, "config", 100).unwrap();
        assert_eq!(
            health(&db, &identity, Health::Quota(Some(7_200_000)), 100).unwrap(),
            7_200_000
        );
        assert_eq!(transaction(&db, |_, l| Ok(l.provider.failures)).unwrap(), 0);
        let result = claim_provider(&db, &id("review", "later"), "config", 1000)
            .unwrap()
            .unwrap();
        assert_eq!(result["retryAfterMs"], 7_199_100u64);
    }
    #[test]
    fn three_bad_business_answers_do_not_open_shared_provider_circuit() {
        let db = fixture();
        for n in 0..3 {
            let identity = id(
                if n % 2 == 0 { "extract" } else { "review" },
                &format!("bad-input-{n}"),
            );
            let at = 100 + n * 60_000;
            assert!(claim_provider(&db, &identity, "config", at)
                .unwrap()
                .is_none());
            // This helper is called by the common live transport path before
            // either extraction or review validates its business JSON.
            business_response_received(&db, &identity, at).unwrap();
            assert!(
                super::super::protocol::validate_output("not business JSON", &[], &[]).is_err()
            );
        }
        let health = transaction(&db, |_, ledger| {
            Ok((
                ledger.provider.failures,
                ledger.provider.open,
                ledger.provider.repair,
            ))
        })
        .unwrap();
        assert_eq!(health, (0, false, false));
        assert!(
            claim_provider(&db, &id("review", "unrelated"), "config", 180100)
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn persisted_rate_limit_counts_both_paths_and_expired_owner_cannot_send() {
        let db = fixture();
        for n in 0..6 {
            let identity = id(
                if n % 2 == 0 { "extract" } else { "review" },
                &n.to_string(),
            );
            let at = 100 + n * 60000;
            assert!(claim_provider(&db, &identity, "config", at)
                .unwrap()
                .is_none());
            health(&db, &identity, Health::Neutral, at).unwrap();
        }
        assert_eq!(
            claim_provider(&db, &id("review", "seventh"), "config", 360100)
                .unwrap()
                .unwrap()["reason"],
            "provider_rate_limit"
        );
        let db = fixture();
        let identity = id("extract", "expired");
        begin(&db, &identity).unwrap();
        claim_provider(&db, &identity, "config", 100).unwrap();
        reserve(&db, &identity, 16384, 100).unwrap();
        assert_eq!(
            mark_sent(&db, &identity, 180100).unwrap_err(),
            "provider_claim_expired"
        );
        assert_eq!(
            claim_provider(&db, &id("review", "other"), "config", 180100)
                .unwrap()
                .unwrap()["reason"],
            "provider_backoff"
        );
        assert!(
            claim_provider(&db, &id("review", "other"), "config", 240100)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            mark_sent(&db, &identity, 240100).unwrap_err(),
            "provider_claim_expired"
        );
    }
    #[test]
    fn scheduler_polling_reports_repair_and_budget_without_allocating_requests() {
        let db = fixture();
        let identity = id("extract", "broken-provider");
        claim_provider(&db, &identity, "config", 100).unwrap();
        health(&db, &identity, Health::Repair, 100).unwrap();
        let before = db.plugin_kv_get(NS, "ledger").unwrap();
        for _ in 0..10 {
            assert_eq!(
                scheduler_wait(&db, "config", 60100).unwrap(),
                Some((false, "provider_requires_repair", 300000))
            );
        }
        assert_eq!(db.plugin_kv_get(NS, "ledger").unwrap(), before);
        assert!(scheduler_wait(&db, "changed-config", 60100)
            .unwrap()
            .is_none());
        assert_eq!(
            db.0.lock()
                .query_row(
                    "SELECT count(*) FROM plugin_kv WHERE plugin_id=?1 AND key LIKE 'request:%'",
                    [NS],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );

        let db = fixture();
        for n in 0..2 {
            let identity = id("review", &n.to_string());
            begin(&db, &identity).unwrap();
            assert!(reserve(&db, &identity, CALL_TOKENS, 100).unwrap());
        }
        let before = db.plugin_kv_get(NS, "ledger").unwrap();
        assert_eq!(
            scheduler_wait(&db, "config", 100).unwrap(),
            Some((true, "token_budget_exhausted", DAY_MS))
        );
        assert_eq!(db.plugin_kv_get(NS, "ledger").unwrap(), before);
        assert!(scheduler_wait(&db, "config", 100 + DAY_MS)
            .unwrap()
            .is_none());
    }
}
