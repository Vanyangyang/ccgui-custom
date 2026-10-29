use super::*;
use crate::codex_quota::tests::{query, fixture_binding};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self { Self(std::env::temp_dir().join(format!("ccgui-codex-cache-{}", uuid::Uuid::new_v4()))) }
    fn path(&self) -> PathBuf { self.0.join("cache.json") }
    fn state(&self) -> CodexQuotaState {
        CodexQuotaState {
            persistence_path: Some(self.path()),
            persistence_enabled: true.into(),
            ..Default::default()
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}
fn both(percent: f64) -> QueryResult {
    let mut result = query(percent);
    result.windows.five_hour = result.windows.seven_day.clone();
    result
}
fn age(state: &CodexQuotaState, stamp: &str) -> u64 {
    let at = now_seconds() - 600;
    let mut cache = state.cache.lock().unwrap();
    let entry = cache.get_mut(stamp).unwrap();
    entry.snapshot.as_mut().unwrap().collected_at = Some(at);
    entry.last_attempt = None;
    state.persist(&cache);
    at
}

#[tokio::test]
async fn restart_restores_only_bound_stale_windows_without_verifying_identity() {
    let fixture = Fixture::new();
    let state = fixture.state();
    let stamp = fixture_binding().stamp;
    state.read_bound(&stamp, async { Ok(both(25.0)) }, || true).await;
    let at = age(&state, &stamp);
    let restored = fixture.state();
    let snapshot = restored.cached(&stamp, || true);
    assert_eq!(snapshot.status, "stale");
    assert_eq!(snapshot.collected_at, Some(at));
    assert!(snapshot.windows.five_hour.is_some());
    assert!(snapshot.account.is_none() && snapshot.credits.is_none() && snapshot.reset_credits.is_none());
    assert_eq!(restored.cached("other-binding", || true).error_code, Some("not_loaded"));
    assert!(!restored.cache.lock().unwrap()[&stamp].verified);
    restored.ingest(&stamp, query(90.0).windows, || true);
    assert_eq!(restored.cached(&stamp, || true), snapshot);
    let calls = std::sync::atomic::AtomicUsize::new(0);
    let fresh = restored.read_bound(&stamp, async {
        calls.fetch_add(1, Ordering::SeqCst);
        Ok(both(30.0))
    }, || true).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(fresh.status, "ready");
    assert!(fresh.collected_at.unwrap() > at);
    let text = std::fs::read_to_string(fixture.path()).unwrap();
    for forbidden in ["email", "fixture@example.test", "fixture-home", "workspace", "account", "balance", "credits", "token"] {
        assert!(!text.contains(forbidden), "unexpected persisted field: {forbidden}");
    }
    let disk = read(&fixture.path()).unwrap();
    assert_eq!(disk.records.len(), 1);
    assert!(disk.records[0].identity_hash.is_some());
}

#[tokio::test]
async fn partial_active_and_passive_updates_keep_old_window_age_and_complete_updates_recover() {
    let state = CodexQuotaState::default();
    state.read_bound("a", async { Ok(both(10.0)) }, || true).await;
    let at = age(&state, "a");
    let partial = state.read_bound("a", async { Ok(query(20.0)) }, || true).await;
    assert_eq!(partial.windows.five_hour.unwrap().used_percentage, 10.0);
    assert_eq!(partial.windows.seven_day.unwrap().used_percentage, 20.0);
    assert_eq!(partial.collected_at, Some(at));
    assert_eq!(partial.status, "stale");
    state.ingest("a", query(30.0).windows, || true);
    let passive = state.cached("a", || true);
    assert_eq!(passive.windows.five_hour.unwrap().used_percentage, 10.0);
    assert_eq!(passive.windows.seven_day.unwrap().used_percentage, 30.0);
    assert_eq!(passive.collected_at, Some(at));
    assert_eq!(passive.status, "stale");
    state.ingest("a", both(40.0).windows, || true);
    let complete = state.cached("a", || true);
    assert_eq!(complete.status, "ready");
    assert!(complete.collected_at.unwrap() > at);
}

#[tokio::test]
async fn new_account_does_not_inherit_restored_or_live_windows() {
    for restart in [false, true] {
        let fixture = Fixture::new();
        let state = fixture.state();
        let stamp = fixture_binding().stamp;
        state.read_bound(&stamp, async { Ok(both(10.0)) }, || true).await;
        age(&state, &stamp);
        let state = if restart { fixture.state() } else { state };
        let fresh = state.read_bound(&stamp, async {
            let mut result = query(75.0);
            result.account.as_mut().unwrap().email = Some("different@example.test".into());
            Ok(result)
        }, || true).await;
        assert!(fresh.windows.five_hour.is_none());
        assert_eq!(fresh.windows.seven_day.unwrap().used_percentage, 75.0);
        assert!(fixture.state().cached(&stamp, || true).windows.five_hour.is_none());
    }
}

#[tokio::test]
async fn sparse_or_failed_query_preserves_same_binding_restored_history() {
    let fixture = Fixture::new();
    let state = fixture.state();
    let stamp = fixture_binding().stamp;
    state.read_bound(&stamp, async { Ok(both(10.0)) }, || true).await;
    let at = age(&state, &stamp);
    for response in [Ok(QueryResult::default()), Err("query_failed")] {
        let restored = fixture.state();
        let result = restored.read_bound(&stamp, async { response }, || true).await;
        assert_eq!(result.collected_at, Some(at));
        assert_eq!(result.status, "stale");
        assert_eq!(result.windows.five_hour.unwrap().used_percentage, 10.0);
        assert_eq!(fixture.state().cached(&stamp, || true).collected_at, Some(at));
    }
}

#[tokio::test]
async fn invalidated_and_rejected_auth_records_cannot_resurrect() {
    for explicit in [true, false] {
        let fixture = Fixture::new();
        let state = fixture.state();
        let stamp = fixture_binding().stamp;
        state.read_bound(&stamp, async { Ok(both(10.0)) }, || true).await;
        age(&state, &stamp);
        let restored = fixture.state();
        if explicit { restored.invalidate_account(&stamp); }
        else { restored.read_bound(&stamp, async { Err("provider_auth_unavailable") }, || true).await; }
        assert_eq!(fixture.state().cached(&stamp, || true).error_code, Some("not_loaded"));
    }
}

#[tokio::test]
async fn disk_failure_preserves_memory() {
    let fixture = Fixture::new();
    std::fs::create_dir_all(fixture.path()).unwrap();
    let state = fixture.state();
    let stamp = fixture_binding().stamp;
    let result = state.read_bound(&stamp, async { Ok(both(40.0)) }, || true).await;
    assert_eq!(result.status, "ready");
    assert_eq!(state.cached(&stamp, || true), result);
    assert!(state.persistence_warned.load(Ordering::Relaxed));
}

#[tokio::test]
async fn corrupt_future_oversized_and_non_whitelisted_records_are_rejected() {
    let fixture = Fixture::new();
    let state = fixture.state();
    let stamp = fixture_binding().stamp;
    state.read_bound(&stamp, async { Ok(both(10.0)) }, || true).await;
    let valid: Value = serde_json::from_str(&std::fs::read_to_string(fixture.path()).unwrap()).unwrap();
    let mut invalid = Vec::new();
    let mut future = valid.clone(); future["records"][0]["collected_at"] = (now_seconds() + 1000).into(); invalid.push(future);
    let mut percentage = valid.clone(); percentage["records"][0]["five_hour"]["used_percentage"] = 101.into(); invalid.push(percentage);
    let mut field = valid.clone(); field["records"][0]["email"] = "forbidden".into(); invalid.push(field);
    let mut version = valid.clone(); version["version"] = 2.into(); invalid.push(version);
    let mut many = valid.clone(); many["records"] = Value::Array(vec![valid["records"][0].clone(); MAX_BINDINGS + 1]); invalid.push(many);
    for value in invalid {
        std::fs::write(fixture.path(), serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(fixture.state().cached(&stamp, || true).error_code, Some("not_loaded"));
    }
    for bytes in [b"{broken".to_vec(), vec![b' '; MAX_BYTES + 1]] {
        std::fs::write(fixture.path(), bytes).unwrap();
        assert_eq!(fixture.state().cached(&stamp, || true).error_code, Some("not_loaded"));
    }
}

#[tokio::test]
async fn worker_state_never_reads_or_overwrites_host_disk_cache() {
    let fixture = Fixture::new();
    let host = fixture.state();
    let stamp = fixture_binding().stamp;
    host.read_bound(&stamp, async { Ok(both(10.0)) }, || true).await;
    let worker = CodexQuotaState { persistence_path: Some(fixture.path()), ..Default::default() };
    assert_eq!(worker.cached(&stamp, || true).error_code, Some("not_loaded"));
    assert!(!worker.persistence_loaded.load(Ordering::Relaxed));
    worker.read_bound(&stamp, async { Ok(both(20.0)) }, || true).await;
    host.invalidate_account(&stamp);
    let before = std::fs::read(fixture.path()).unwrap();
    worker.accept_observation(Observation {
        stamp: "another-stamp".into(), observed_at_ms: now_millis(),
        update: ObservationUpdate::AccountChanged,
    }, || true);
    assert_eq!(std::fs::read(fixture.path()).unwrap(), before);
    assert_eq!(fixture.state().cached(&stamp, || true).error_code, Some("not_loaded"));
}

#[tokio::test]
async fn same_identity_partial_account_keeps_known_email_in_all_success_branches() {
    for branch in 0..3 {
        let state = CodexQuotaState::default();
        state.read_bound("a", async { Ok(both(10.0)) }, || true).await;
        age(&state, "a");
        let result = state.read_bound("a", async {
            let mut result = both(20.0);
            result.account = Some(QuotaAccount { email: None, plan: "plus".into() });
            if branch == 1 { result.windows = QuotaWindows::default(); }
            if branch == 2 { state.ingest("a", query(30.0).windows, || true); }
            Ok(result)
        }, || true).await;
        let account = result.account.unwrap();
        assert_eq!(account.email.as_deref(), Some("fixture@example.test"));
        assert_eq!(account.plan, "plus");
    }
}

#[tokio::test]
async fn partial_observation_during_query_keeps_new_weekly_and_fills_missing_five_hour() {
    let state = CodexQuotaState::default();
    state.read_bound("a", async { Ok(query(10.0)) }, || true).await;
    age(&state, "a");
    let mut passive_at = None;
    let result = state.read_bound("a", async {
        tokio::task::yield_now().await;
        state.ingest("a", query(60.0).windows, || true);
        passive_at = state.cached("a", || true).collected_at;
        Ok(both(20.0))
    }, || true).await;
    assert_eq!(result.windows.seven_day.unwrap().used_percentage, 60.0);
    assert_eq!(result.windows.five_hour.unwrap().used_percentage, 20.0);
    assert_eq!(result.status, "stale");
    assert!(result.collected_at <= passive_at);
    assert!(result.collected_at.unwrap() <= state.cache.lock().unwrap()["a"].auth_checked_at_ms / 1000);
}

#[cfg(windows)]
#[tokio::test]
async fn locked_disk_revocation_blocks_restart_restore_until_fresh_write() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = Fixture::new();
    let state = fixture.state();
    let stamp = fixture_binding().stamp;
    state.read_bound(&stamp, async { Ok(both(10.0)) }, || true).await;
    let locked = std::fs::OpenOptions::new().read(true).share_mode(0).open(fixture.path()).unwrap();
    state.invalidate_account(&stamp);
    assert_eq!(state.cached(&stamp, || true).error_code, Some("auth_changed"));
    assert!(state.persistence_warned.load(Ordering::Relaxed));
    assert!(fixture.path().is_file());
    assert!(invalidation_path(&fixture.path()).is_file());
    assert_eq!(fixture.state().cached(&stamp, || true).error_code, Some("not_loaded"));
    drop(locked);
    assert_eq!(fixture.state().cached(&stamp, || true).error_code, Some("not_loaded"));
    state.read_bound(&stamp, async { Ok(both(50.0)) }, || true).await;
    assert!(!invalidation_path(&fixture.path()).exists());
    assert_eq!(fixture.state().cached(&stamp, || true).windows.five_hour.unwrap().used_percentage, 50.0);
}
