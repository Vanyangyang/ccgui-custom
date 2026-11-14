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

fn local_auth_stamp(path: &Path, account: &str, subject: &str, token: &str) -> String {
    use base64::Engine;
    let claims = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&serde_json::json!({"sub": subject})).unwrap());
    std::fs::write(path, serde_json::to_vec(&serde_json::json!({
        "auth_mode": "chatgpt",
        "tokens": {"account_id": account, "access_token": token,
            "id_token": format!("header.{claims}.signature")}
    })).unwrap()).unwrap();
    let mut fragment = String::new();
    stamp_file(&mut fragment, path).unwrap();
    format!("{:x}", Sha256::digest(fragment.as_bytes()))
}

#[tokio::test]
async fn restart_after_token_refresh_restores_both_windows_only_for_the_same_identity() {
    let fixture = Fixture::new();
    std::fs::create_dir_all(&fixture.0).unwrap();
    let auth = fixture.0.join("auth.json");
    let original = local_auth_stamp(&auth, "workspace-a", "user-a", "old-token");
    let state = fixture.state();
    state.read_bound(&original, async { Ok(both(25.0)) }, || true).await;
    let at = age(&state, &original);

    let refreshed = local_auth_stamp(&auth, "workspace-a", "user-a", "longer-refreshed-token");
    let restored = fixture.state().cached(&refreshed, || true);
    assert_eq!(restored.status, "stale");
    assert_eq!(restored.collected_at, Some(at));
    assert_eq!(restored.windows.five_hour.unwrap().used_percentage, 25.0);
    assert_eq!(restored.windows.seven_day.unwrap().used_percentage, 25.0);

    for (account, subject) in [("workspace-b", "user-a"), ("workspace-a", "user-b")] {
        let other = local_auth_stamp(&auth, account, subject, "another-token");
        assert_eq!(fixture.state().cached(&other, || true).error_code, Some("not_loaded"));
    }
}

#[tokio::test]
async fn restart_migrates_only_the_exact_legacy_binding() {
    let fixture = Fixture::new();
    let state = fixture.state();
    let legacy = format!("{:x}", Sha256::digest(b"old metadata"));
    let unrelated = format!("{:x}", Sha256::digest(b"different metadata"));
    state.read_bound(&legacy, async { Ok(both(15.0)) }, || true).await;
    state.read_bound(&unrelated, async { Ok(both(70.0)) }, || true).await;

    let mut binding = fixture_binding();
    binding.legacy_stamp = Some(legacy.clone());
    let restored = fixture.state();
    restored.register_binding(&binding);
    assert_eq!(restored.cached(&binding.stamp, || true).windows.five_hour.unwrap().used_percentage, 15.0);
    assert_eq!(restored.cached(&unrelated, || true).windows.five_hour.unwrap().used_percentage, 70.0);
    assert_eq!(restored.cached(&legacy, || true).error_code, Some("not_loaded"));
    assert_eq!(fixture.state().cached(&binding.stamp, || true).windows.seven_day.unwrap().used_percentage, 15.0);

    let mut other_binding = fixture_binding();
    other_binding.stamp = format!("{:x}", Sha256::digest(b"other account"));
    other_binding.legacy_stamp = Some(format!("{:x}", Sha256::digest(b"no matching metadata")));
    restored.register_binding(&other_binding);
    assert_eq!(restored.cached(&other_binding.stamp, || true).error_code, Some("not_loaded"));
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
    let disk = read(&fixture.path()).unwrap().unwrap();
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

#[cfg(windows)]
#[tokio::test]
async fn failed_normal_write_keeps_the_last_persisted_snapshot_for_restart() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = Fixture::new();
    let state = fixture.state();
    let stamp = fixture_binding().stamp;
    state.read_bound(&stamp, async { Ok(both(10.0)) }, || true).await;
    let locked = std::fs::OpenOptions::new().read(true).share_mode(0).open(fixture.path()).unwrap();
    state.ingest(&stamp, both(50.0).windows, || true);
    assert_eq!(state.cached(&stamp, || true).windows.five_hour.unwrap().used_percentage, 50.0);
    drop(locked);
    assert!(!invalidation_path(&fixture.path()).exists());
    let restored = fixture.state().cached(&stamp, || true);
    assert_eq!(restored.windows.five_hour.unwrap().used_percentage, 10.0);
    assert_eq!(restored.windows.seven_day.unwrap().used_percentage, 10.0);
    // A later passive read retries the pending write without a new quota event.
    assert_eq!(state.cached(&stamp, || true).windows.five_hour.unwrap().used_percentage, 50.0);
    assert_eq!(fixture.state().cached(&stamp, || true).windows.five_hour.unwrap().used_percentage, 50.0);
}

#[cfg(windows)]
#[tokio::test]
async fn restart_retries_a_temporarily_locked_cache_without_overwriting_it() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = Fixture::new();
    let state = fixture.state();
    let stamp = fixture_binding().stamp;
    let other = format!("{:x}", Sha256::digest(b"another binding"));
    state.read_bound(&stamp, async { Ok(both(10.0)) }, || true).await;
    state.read_bound(&other, async { Ok(both(20.0)) }, || true).await;
    let locked = std::fs::OpenOptions::new().read(true).share_mode(0).open(fixture.path()).unwrap();

    let restarted = fixture.state();
    assert_eq!(restarted.cached(&stamp, || true).error_code, Some("not_loaded"));
    assert!(!restarted.persistence_loaded.load(Ordering::Relaxed));
    // A successful query while locked may update memory but must not replace
    // the unread disk file or discard another binding.
    restarted.read_bound(&stamp, async { Ok(both(50.0)) }, || true).await;
    drop(locked);
    assert_eq!(restarted.cached(&stamp, || true).windows.five_hour.unwrap().used_percentage, 50.0);
    let next_restart = fixture.state();
    assert_eq!(next_restart.cached(&stamp, || true).windows.five_hour.unwrap().used_percentage, 50.0);
    assert_eq!(next_restart.cached(&other, || true).windows.five_hour.unwrap().used_percentage, 20.0);
}

#[tokio::test]
async fn temporary_auth_unavailability_hides_but_does_not_delete_the_saved_sample() {
    use std::sync::atomic::AtomicBool;
    let fixture = Fixture::new();
    let state = fixture.state();
    let stamp = fixture_binding().stamp;
    state.read_bound(&stamp, async { Ok(both(10.0)) }, || true).await;
    age(&state, &stamp);

    let hidden = state.cached(&stamp, || BindingStatus::Unavailable);
    assert_eq!(hidden.error_code, Some("auth_metadata_unavailable"));
    assert_eq!(hidden.windows, QuotaWindows::default());
    assert_eq!(fixture.state().cached(&stamp, || true).windows.five_hour.unwrap().used_percentage, 10.0);

    let available = AtomicBool::new(true);
    let result = state.read_bound(&stamp, async {
        available.store(false, Ordering::SeqCst);
        Ok(both(80.0))
    }, || if available.load(Ordering::SeqCst) { BindingStatus::Current } else { BindingStatus::Unavailable }).await;
    assert_eq!(result.error_code, Some("auth_metadata_unavailable"));
    assert_eq!(fixture.state().cached(&stamp, || true).windows.seven_day.unwrap().used_percentage, 10.0);
    let recovered = state.read_bound(&stamp, async { Ok(both(30.0)) }, || BindingStatus::Current).await;
    assert_eq!(recovered.windows.seven_day.unwrap().used_percentage, 30.0);
}

// This helper is run in a separate test process against an isolated directory.
// Exiting directly skips Rust destructors, as with an unexpectedly closed app.
#[tokio::test]
#[ignore = "launched only by abrupt_exit_preserves_the_committed_disk_snapshot"]
async fn abrupt_exit_process_helper() {
    let Ok(path) = std::env::var("CCGUI_QUOTA_PROCESS_FIXTURE_PATH") else { return; };
    let action = std::env::var("CCGUI_QUOTA_PROCESS_FIXTURE_ACTION").unwrap();
    let state = CodexQuotaState {
        persistence_path: Some(PathBuf::from(&path)),
        persistence_enabled: true.into(),
        ..Default::default()
    };
    let stamp = fixture_binding().stamp;
    match action.as_str() {
        "write" => {
            state.read_bound(&stamp, async { Ok(both(25.0)) }, || true).await;
            std::process::exit(0);
        }
        "interrupt-write" => {
            state.read_bound(&stamp, async { Ok(both(80.0)) }, || true).await;
            panic!("the test-only write interruption did not run");
        }
        "verify" => {
            let snapshot = state.cached(&stamp, || true);
            assert_eq!(snapshot.status, "stale");
            assert_eq!(snapshot.windows.five_hour.unwrap().used_percentage, 25.0);
            assert_eq!(snapshot.windows.seven_day.unwrap().used_percentage, 25.0);
        }
        _ => panic!("unknown isolated fixture action"),
    }
}

#[test]
fn abrupt_exit_preserves_the_committed_disk_snapshot() {
    let fixture = Fixture::new();
    let exe = std::env::current_exe().unwrap();
    let run = |action: &str| {
        std::process::Command::new(&exe)
            .args(["--exact", "codex_quota::persistence::tests::abrupt_exit_process_helper", "--ignored"])
            .env("CCGUI_QUOTA_PROCESS_FIXTURE_PATH", fixture.path())
            .env("CCGUI_QUOTA_PROCESS_FIXTURE_ACTION", action)
            .output().unwrap().status.code()
    };
    assert_eq!(run("write"), Some(0));
    assert_eq!(run("verify"), Some(0));
    assert_eq!(run("interrupt-write"), Some(23));
    assert_eq!(run("verify"), Some(0));
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
