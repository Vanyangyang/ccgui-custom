use super::*;
use serde_json::json;
use std::{path::PathBuf, sync::atomic::AtomicU64};

#[path = "observer_progress_tests.rs"]
mod observer_progress_tests;

#[test]
fn every_registered_engine_captures_native_completion_without_an_engine_allowlist() {
    let (_scratch, outbox, recorder, _clock) = fixture();
    for engine in crate::config::ENGINES {
        let run = format!("run-{engine}");
        let killed = Arc::new(AtomicBool::new(false));
        assert!(
            recorder.register_run(
                &run,
                engine,
                "C:/project",
                Some("session"),
                "question",
                &killed
            ),
            "{engine}"
        );
        for (seq, kind, data) in [
            (1, "delta", json!("Durable answer")),
            (2, "turn_complete", json!({})),
        ] {
            recorder.observe_event(&json!({"runId":run,"engine":engine,"sessionId":"session","seq":seq,"kind":kind,"data":data})).unwrap();
        }
        let rows = outbox.pending(64).unwrap();
        let row = rows.iter().find(|row| row.engine == engine).unwrap();
        assert!(!row.started && !row.cancel, "{engine}");
        assert_eq!(row.summary, "Durable answer");
        recorder.finish_run(&run).unwrap();
    }
    assert_eq!(
        outbox.pending(64).unwrap().len(),
        crate::config::ENGINES.len()
    );
    assert!(!recorder.register_run(
        "unknown",
        "unsupported",
        "C:/project",
        Some("s"),
        "q",
        &Arc::new(AtomicBool::new(false))
    ));
}

struct Scratch {
    root: PathBuf,
    parent: PathBuf,
}
impl Scratch {
    fn new() -> Self {
        let parent = std::env::temp_dir().canonicalize().unwrap();
        let root = parent.join(format!("ccgui-completion-outbox-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        Self { root, parent }
    }
    fn path(&self) -> PathBuf {
        self.root.join("outbox.sqlite")
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        if let Ok(path) = self.root.canonicalize() {
            if path.parent() == Some(self.parent.as_path())
                && path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("ccgui-completion-outbox-")
            {
                let _ = std::fs::remove_dir_all(path);
            }
        }
    }
}
fn fixture() -> (Scratch, Arc<Outbox>, Recorder, Arc<AtomicU64>) {
    fixture_with_owner(None)
}
fn fixture_with_owner(
    owner: Option<ProcessOwner>,
) -> (Scratch, Arc<Outbox>, Recorder, Arc<AtomicU64>) {
    let scratch = Scratch::new();
    let outbox = Outbox::open_with_owner(scratch.path(), owner).unwrap();
    outbox.set_ready(7, 10_000).unwrap();
    let clock = Arc::new(AtomicU64::new(1_000));
    let clock_clone = clock.clone();
    let recorder = Recorder {
        outbox: outbox.clone(),
        runs: Mutex::new(HashMap::new()),
        clock: Arc::new(move || clock_clone.load(Ordering::SeqCst)),
    };
    (scratch, outbox, recorder, clock)
}
fn register(recorder: &Recorder, root: &str) -> Arc<AtomicBool> {
    let killed = Arc::new(AtomicBool::new(false));
    assert!(recorder.register_run(
        root,
        "claude",
        "C:/project",
        Some("native-1"),
        "question",
        &killed
    ));
    killed
}
fn event(root: &str, logical: &str, seq: u64, kind: &str, data: Value) -> Value {
    json!({"sourceRunId":root,"runId":logical,"engine":"claude","sessionId":"native-1","seq":seq,"kind":kind,"data":data,"ts":1_000})
}
fn emit(recorder: &Recorder, root: &str, seq: u64, kind: &str, data: Value) {
    recorder
        .observe_event(&event(root, root, seq, kind, data))
        .unwrap();
}
fn terminal(recorder: &Recorder, root: &str, text: &str) {
    emit(recorder, root, 1, "delta", json!(text));
    emit(recorder, root, 2, "turn_complete", json!({}));
}
fn row(id: &str, generation: u64) -> Pending {
    Pending {
        id: id.into(),
        engine: "claude".into(),
        session_id: "native-1".into(),
        workspace_path: "C:/project".into(),
        prompt: "question".into(),
        summary: "answer".into(),
        started_at_ms: 1_000,
        completed_at_ms: 1_001,
        generation,
        cancel: false,
        started: false,
    }
}

#[test]
fn real_sqlite_reopen_preserves_unacked_and_ack_does_not_replay_a_terminal() {
    let (scratch, outbox, recorder, _clock) = fixture();
    register(&recorder, "run");
    terminal(&recorder, "run", "完整答案😀");
    let first = outbox.pending(10).unwrap().pop().unwrap();
    emit(
        &recorder,
        "run",
        3,
        "done",
        json!({"usage":{"output_tokens":99}}),
    );
    assert_eq!(outbox.pending(10).unwrap(), vec![first.clone()]);
    let reopened = Outbox::open(scratch.path()).unwrap();
    assert_eq!(reopened.pending(10).unwrap(), vec![first.clone()]);
    reopened.finish(&first.id).unwrap();
    emit(&recorder, "run", 4, "usage", json!({"output_tokens":100}));
    emit(&recorder, "run", 5, "done", json!({}));
    assert!(outbox.pending(10).unwrap().is_empty());
    recorder.finish_run("run").unwrap();
    assert!(reopened.pending(10).unwrap().is_empty());
}

#[test]
fn latest_resident_turn_replaces_unacked_copy_and_delayed_ack_cannot_delete_it() {
    let (_scratch, outbox, recorder, clock) = fixture();
    register(&recorder, "run");
    terminal(&recorder, "run", "old");
    let old = outbox.pending(1).unwrap().pop().unwrap();
    clock.store(2_000, Ordering::SeqCst);
    emit(&recorder, "run", 3, "delta", json!("new"));
    emit(&recorder, "run", 4, "turn_complete", json!({}));
    let new = outbox.pending(1).unwrap().pop().unwrap();
    assert_ne!(old.id, new.id);
    assert_eq!(new.summary, "new");
    assert!(new.started_at_ms > old.started_at_ms);
    outbox.finish(&old.id).unwrap();
    assert_eq!(outbox.pending(1).unwrap(), vec![new.clone()]);
    recorder.finish_run("run").unwrap();
    assert_eq!(outbox.pending(1).unwrap(), vec![new.clone()]);
    outbox.finish(&new.id).unwrap();
    assert!(outbox.pending(1).unwrap().is_empty());
}

#[test]
fn active_reservations_are_cross_connection_bounded_and_survive_readiness_loss() {
    let (scratch, outbox, recorder, _clock) = fixture();
    let other = Outbox::open(scratch.path()).unwrap();
    let mut reservations = Vec::new();
    for n in 0..ACTIVE_CAP {
        reservations.push(other.reserve(&format!("root-{n}"), 1_000).unwrap().unwrap());
    }
    let killed = Arc::new(AtomicBool::new(false));
    assert!(!recorder.register_run(
        "overflow",
        "claude",
        "C:/project",
        Some("native"),
        "q",
        &killed
    ));
    outbox.pause().unwrap();
    let first = &reservations[0];
    outbox.persist(first, &row("event-1", 7)).unwrap();
    assert_eq!(outbox.pending(1).unwrap().len(), 1);
    outbox.release(&first.root).unwrap();
    assert!(other.reserve("still-disabled", 1_000).unwrap().is_none());
    for reservation in reservations.iter().skip(1) {
        other.release(&reservation.root).unwrap();
    }
}

#[test]
fn slot_capacity_is_reserved_before_suppression_and_terminal_does_not_need_free_space() {
    let (_scratch, outbox, recorder, _clock) = fixture();
    for n in 0..SLOT_CAP - 1 {
        let root = format!("closed-{n}");
        let reservation = outbox.reserve(&root, 1_000).unwrap().unwrap();
        outbox
            .persist(&reservation, &row(&format!("event-{n}"), 7))
            .unwrap();
        outbox.release(&root).unwrap();
    }
    register(&recorder, "last-slot");
    let killed = Arc::new(AtomicBool::new(false));
    assert!(!recorder.register_run(
        "no-slot",
        "claude",
        "C:/project",
        Some("native"),
        "q",
        &killed
    ));
    outbox.pause().unwrap();
    terminal(&recorder, "last-slot", "guaranteed");
    assert_eq!(outbox.pending(usize::MAX).unwrap().len(), SLOT_CAP);
    assert!(outbox
        .pending(SLOT_CAP)
        .unwrap()
        .iter()
        .any(|p| p.summary == "guaranteed"));
    recorder.finish_run("last-slot").unwrap();
}

#[test]
fn stale_or_missing_readiness_never_suppresses_legacy_hooks() {
    let (_scratch, outbox, recorder, clock) = fixture();
    let killed = Arc::new(AtomicBool::new(false));
    outbox.pause().unwrap();
    assert!(!recorder.register_run(
        "disabled",
        "claude",
        "C:/project",
        Some("native"),
        "q",
        &killed
    ));
    outbox.set_ready(8, 1_000).unwrap();
    assert!(!recorder.register_run(
        "expired",
        "claude",
        "C:/project",
        Some("native"),
        "q",
        &killed
    ));
    outbox.set_ready(8, 1_001).unwrap();
    assert!(recorder.register_run(
        "ready",
        "claude",
        "C:/project",
        Some("native-1"),
        "q",
        &killed
    ));
    clock.store(1_001, Ordering::SeqCst);
    assert!(!recorder.register_run(
        "expired-next",
        "claude",
        "C:/project",
        Some("native"),
        "q",
        &killed
    ));
    terminal(&recorder, "ready", "answer");
    assert_eq!(outbox.pending(1).unwrap()[0].generation, 8);
}

#[test]
fn explicit_identity_adoption_is_required_and_mismatched_native_events_are_ignored() {
    let (_scratch, outbox, recorder, _clock) = fixture();
    let killed = Arc::new(AtomicBool::new(false));
    assert!(recorder.register_run("run", "claude", "C:/project", None, "q", &killed));
    emit(&recorder, "run", 99, "done", json!({}));
    let mut malformed = event("run", "run", 99, "done", json!({}));
    malformed["sessionId"] = json!(42);
    recorder.observe_event(&malformed).unwrap();
    assert!(outbox.pending(1).unwrap().is_empty());
    assert!(recorder.adopt_session("run", "claude", "native-1"));
    malformed["sessionId"] = json!("native-1");
    malformed["sourceRunId"] = json!(42);
    recorder.observe_event(&malformed).unwrap();
    let mut wrong = event("run", "run", 100, "delta", json!("wrong"));
    wrong["sessionId"] = json!("other");
    recorder.observe_event(&wrong).unwrap();
    wrong["sessionId"] = json!("native-1");
    wrong["engine"] = json!("codex");
    recorder.observe_event(&wrong).unwrap();
    terminal(&recorder, "run", "right");
    assert_eq!(outbox.pending(1).unwrap()[0].summary, "right");
    assert!(!recorder.adopt_session("run", "claude", "replacement"));
    recorder.finish_run("run").unwrap();
    assert!(outbox.pending(1).unwrap()[0].cancel);
    assert_eq!(outbox.pending(1).unwrap()[0].session_id, "native-1");
}

#[test]
fn terminal_before_explicit_adoption_keeps_original_event_time() {
    let (_scratch, outbox, recorder, clock) = fixture();
    let killed = Arc::new(AtomicBool::new(false));
    assert!(recorder.register_run("run", "agy", "C:/project", None, "q", &killed));
    let mut value = event("run", "run", 1, "delta", json!("answer"));
    value["engine"] = json!("agy");
    value["sessionId"] = Value::Null;
    recorder.observe_event(&value).unwrap();
    value["seq"] = json!(2);
    value["kind"] = json!("done");
    value["data"] = json!({});
    value["ts"] = json!(1_500);
    clock.store(2_000, Ordering::SeqCst);
    recorder.observe_event(&value).unwrap();
    assert!(outbox.pending(1).unwrap().is_empty());
    clock.store(3_000, Ordering::SeqCst);
    assert!(recorder.adopt_session("run", "agy", "adopted"));
    let pending = outbox.pending(1).unwrap().pop().unwrap();
    assert_eq!(pending.completed_at_ms, 1_500);
    assert_eq!(pending.summary, "answer");
}

#[test]
fn unicode_bounds_latest_assistant_segment_and_snapshot_patch_are_preserved() {
    let (_scratch, outbox, recorder, _clock) = fixture();
    let killed = Arc::new(AtomicBool::new(false));
    assert!(recorder.register_run(
        "run",
        "claude",
        "C:/project",
        Some("native-1"),
        &"问题😀".repeat(300),
        &killed
    ));
    emit(&recorder, "run", 1, "delta", json!("before tool"));
    emit(
        &recorder,
        "run",
        2,
        "message",
        json!({"role":"tool","text":"secret tool output"}),
    );
    emit(&recorder, "run", 3, "thinking", json!("private thought"));
    emit(&recorder, "run", 4, "delta", json!("答😀".repeat(5_000)));
    emit(&recorder, "run", 5, "done", json!({}));
    let pending = outbox.pending(1).unwrap().pop().unwrap();
    assert_eq!(pending.prompt.chars().count(), 500);
    assert_eq!(pending.summary.chars().count(), 8_000);
    assert!(pending.summary.ends_with('😀'));
    assert!(!pending.summary.contains("tool"));
    assert!(!pending.summary.contains("thought"));
    emit(&recorder, "run", 6, "delta", json!("partial"));
    emit(
        &recorder,
        "run",
        7,
        "message",
        json!({"role":"assistant","text":"snapshot"}),
    );
    emit(
        &recorder,
        "run",
        8,
        "message",
        json!({"role":"assistant","text":"corrected 😀","patch":true}),
    );
    emit(&recorder, "run", 9, "turn_complete", json!({}));
    assert_eq!(outbox.pending(1).unwrap()[0].summary, "corrected 😀");
}

#[test]
fn errors_interruptions_reclaim_and_killed_runs_never_become_normal_completion() {
    for kind in ["error", "interrupted", "reclaimed", "killed"] {
        let (_scratch, outbox, recorder, _clock) = fixture();
        register(&recorder, "run");
        emit(&recorder, "run", 1, "delta", json!("partial"));
        emit(&recorder, "run", 2, kind, json!("not user-facing"));
        emit(&recorder, "run", 3, "done", json!({}));
        let pending = outbox.pending(1).unwrap().pop().unwrap();
        assert!(pending.cancel);
        assert!(pending.summary.is_empty());
        assert_eq!(pending.id, event_id("run", "run", 2));
    }
    let (_scratch, outbox, recorder, _clock) = fixture();
    let killed = register(&recorder, "run");
    emit(&recorder, "run", 1, "delta", json!("partial"));
    killed.store(true, Ordering::SeqCst);
    emit(&recorder, "run", 2, "turn_complete", json!({}));
    assert!(outbox.pending(1).unwrap()[0].cancel);
    register(&recorder, "interrupted-field");
    emit(
        &recorder,
        "interrupted-field",
        1,
        "turn_complete",
        json!({"interrupted":true}),
    );
    assert!(outbox.pending(10).unwrap().iter().all(|p| p.cancel));
}

#[test]
fn cancellation_can_replace_pending_success_without_being_deleted_by_old_ack() {
    let (_scratch, outbox, recorder, _clock) = fixture();
    let killed = register(&recorder, "run");
    terminal(&recorder, "run", "answer");
    let old = outbox.pending(1).unwrap().pop().unwrap();
    killed.store(true, Ordering::SeqCst);
    recorder.finish_run("run").unwrap();
    let cancelled = outbox.pending(1).unwrap().pop().unwrap();
    assert!(cancelled.cancel);
    assert_ne!(cancelled.id, old.id);
    outbox.finish(&old.id).unwrap();
    assert_eq!(outbox.pending(1).unwrap(), vec![cancelled]);
}

#[test]
fn exact_continuations_monotonic_sequence_and_late_tails_do_not_replay() {
    let (_scratch, outbox, recorder, _clock) = fixture();
    register(&recorder, "run");
    terminal(&recorder, "run", "first");
    let first = outbox.pending(1).unwrap().pop().unwrap();
    for (seq, kind, data) in [
        (3, "usage", json!({})),
        (4, "done", json!({})),
        (5, "delta", json!("")),
        (
            6,
            "message",
            json!({"role":"assistant","text":"late patch","patch":true}),
        ),
    ] {
        emit(&recorder, "run", seq, kind, data);
    }
    assert_eq!(outbox.pending(1).unwrap(), vec![first.clone()]);
    for logical in ["run-c0", "run-c01", "run-c-1", "run-cx", "other-c1"] {
        recorder
            .observe_event(&event("run", logical, 100, "delta", json!("invalid")))
            .unwrap();
    }
    recorder
        .observe_event(&event("run", "run-c1", 7, "delta", json!("second")))
        .unwrap();
    recorder
        .observe_event(&event("run", "run-c1", 7, "delta", json!("duplicate")))
        .unwrap();
    recorder
        .observe_event(&event("run", "run", 99, "delta", json!("late old logical")))
        .unwrap();
    recorder
        .observe_event(&event("run", "run-c1", 8, "done", json!({})))
        .unwrap();
    let second = outbox.pending(1).unwrap().pop().unwrap();
    assert_eq!(second.summary, "second");
    assert_eq!(second.id, event_id("run", "run-c1", 8));
    assert!(second.started_at_ms > first.started_at_ms);
    assert!(second.id.len() <= 160);
    assert!(valid_id(&second.id));
}

#[test]
fn unregistered_leader_plugin_side_runs_are_ignored_and_finish_without_terminal_cancels() {
    let (_scratch, outbox, recorder, _clock) = fixture();
    for root in ["leader", "plugin", "sidechat", "btw"] {
        terminal(&recorder, root, "must not notify");
        recorder.finish_run(root).unwrap();
    }
    assert!(outbox.pending(1).unwrap().is_empty());
    register(&recorder, "admitted");
    emit(&recorder, "admitted", 1, "delta", json!("partial"));
    recorder.finish_run("admitted").unwrap();
    assert!(outbox.pending(1).unwrap()[0].cancel);
    assert!(recorder.runs.lock().is_empty());
}

#[test]
fn pause_retains_immutable_retry_payload_and_reopen_does_not_clear_it() {
    let (scratch, outbox, recorder, _clock) = fixture();
    register(&recorder, "run");
    terminal(&recorder, "run", "answer");
    let pending = outbox.pending(1).unwrap();
    outbox.pause().unwrap();
    recorder.finish_run("run").unwrap();
    let reopened = Outbox::open(scratch.path()).unwrap();
    reopened.set_ready(8, 10_000).unwrap();
    assert_eq!(reopened.pending(1).unwrap(), pending);
    assert_eq!(pending[0].generation, 7);
    reopened.finish(&pending[0].id).unwrap();
    assert!(reopened.pending(1).unwrap().is_empty());
}

#[test]
fn test_global_wrappers_never_open_production_and_unknown_schema_is_rejected() {
    assert!(init().unwrap().is_none());
    let killed = Arc::new(AtomicBool::new(false));
    assert!(!register_run(
        "root",
        "claude",
        "C:/project",
        Some("session"),
        "q",
        &killed
    ));
    let scratch = Scratch::new();
    let connection = Connection::open(scratch.path()).unwrap();
    connection.pragma_update(None, "user_version", 4).unwrap();
    drop(connection);
    assert!(matches!(Outbox::open(scratch.path()),Err(error) if error=="unsupported_schema"));
}

#[test]
fn concurrent_process_style_admissions_cannot_reserve_the_same_run_twice() {
    let (scratch, outbox, _recorder, _clock) = fixture();
    let other = Outbox::open(scratch.path()).unwrap();
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let other_barrier = barrier.clone();
    let task = std::thread::spawn(move || {
        other_barrier.wait();
        other.reserve("shared-root", 1_000).unwrap().is_some()
    });
    barrier.wait();
    let admitted = outbox.reserve("shared-root", 1_000).unwrap().is_some();
    assert_ne!(admitted, task.join().unwrap());
    outbox.release("shared-root").unwrap();
}

#[test]
fn failed_terminal_write_keeps_reservation_and_can_be_retried_on_finish() {
    let (_scratch, outbox, recorder, _clock) = fixture();
    register(&recorder, "run");
    outbox.connection.lock().execute_batch("CREATE TRIGGER fail_terminal BEFORE INSERT ON pending BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
    emit(&recorder, "run", 1, "delta", json!("answer"));
    assert_eq!(
        recorder
            .observe_event(&event("run", "run", 2, "done", json!({})))
            .unwrap_err(),
        "storage_unavailable"
    );
    assert_eq!(
        recorder.finish_run("run").unwrap_err(),
        "storage_unavailable"
    );
    assert!(recorder.runs.lock().contains_key("run"));
    outbox
        .connection
        .lock()
        .execute_batch("DROP TRIGGER fail_terminal;")
        .unwrap();
    recorder.finish_run("run").unwrap();
    assert_eq!(outbox.pending(1).unwrap()[0].id, event_id("run", "run", 2));
    assert!(recorder.runs.lock().is_empty());
}

#[test]
fn admission_and_first_authoritative_adoption_start_only_their_own_sources() {
    let (_scratch, outbox, recorder, _clock) = fixture();
    let killed = Arc::new(AtomicBool::new(false));
    assert!(recorder.register_run(
        "known",
        "claude",
        "C:/project",
        Some("native-own"),
        "question",
        &killed
    ));
    let initial = outbox.pending(10).unwrap();
    assert_eq!(initial.len(), 1);
    assert!(initial[0].cancel);
    assert!(initial[0].started);
    assert_eq!(initial[0].engine, "claude");
    assert_eq!(initial[0].session_id, "native-own");
    assert_eq!(initial[0].id, event_id("known", "known", 0));
    assert!(recorder.register_run("new", "claude", "C:/project", None, "new question", &killed));
    assert!(recorder.adopt_session("new", "claude", "new-native"));
    let adopted = outbox.pending(10).unwrap();
    assert_eq!(adopted.len(), 2);
    let new_source = adopted
        .iter()
        .find(|pending| pending.session_id == "new-native")
        .unwrap();
    assert!(new_source.started && new_source.cancel);
    assert_eq!(new_source.id, event_id("new", "new", 0));
    assert_eq!(new_source.started_at_ms, 1_000);
    let mut done = event("known", "known", 1, "done", json!({}));
    done["sessionId"] = json!("native-own");
    recorder.observe_event(&done).unwrap();
    let completed: Vec<_> = outbox
        .pending(10)
        .unwrap()
        .into_iter()
        .filter(|pending| pending.session_id == "native-own")
        .collect();
    assert_eq!(completed.len(), 1);
    assert!(!completed[0].cancel);
    assert!(!completed[0].started);
    assert_eq!(completed[0].session_id, "native-own");
    assert_ne!(completed[0].id, initial[0].id);
    outbox.finish(&initial[0].id).unwrap();
    assert_eq!(
        outbox
            .pending(10)
            .unwrap()
            .into_iter()
            .filter(|pending| pending.session_id == "native-own")
            .collect::<Vec<_>>(),
        completed
    );
}

#[test]
fn schema_one_migration_preserves_old_pending_and_defaults_to_terminal_phase() {
    let (scratch, outbox, recorder, _clock) = fixture();
    register(&recorder, "run");
    terminal(&recorder, "run", "kept");
    recorder.finish_run("run").unwrap();
    let expected = outbox.pending(1).unwrap();
    outbox
        .connection
        .lock()
        .execute_batch("ALTER TABLE pending DROP COLUMN started; ALTER TABLE slots DROP COLUMN owner_pid; ALTER TABLE slots DROP COLUMN owner_birth; ALTER TABLE slots DROP COLUMN metadata_json; PRAGMA user_version=1;")
        .unwrap();
    let reopened = Outbox::open(scratch.path()).unwrap();
    assert_eq!(reopened.pending(1).unwrap(), expected);
    assert!(!reopened.pending(1).unwrap()[0].started);
    assert_eq!(
        reopened
            .connection
            .lock()
            .query_row("PRAGMA user_version", [], |row| row.get::<_, u64>(0))
            .unwrap(),
        3
    );
}

#[test]
fn pause_preserves_generation_and_pending_without_new_admission() {
    let (_scratch, outbox, recorder, _clock) = fixture();
    register(&recorder, "run");
    terminal(&recorder, "run", "kept");
    let expected = outbox.pending(1).unwrap();
    outbox.pause().unwrap();
    assert!(outbox.reserve("paused", 1_000).unwrap().is_none());
    assert_eq!(outbox.pending(1).unwrap(), expected);
    assert_eq!(
        outbox
            .connection
            .lock()
            .query_row("SELECT generation FROM readiness", [], |row| row
                .get::<_, u64>(0))
            .unwrap(),
        7
    );
}

#[test]
fn resumed_turn_starts_before_terminal_and_old_ack_cannot_remove_its_phase() {
    let (_scratch, outbox, recorder, _clock) = fixture();
    register(&recorder, "run");
    terminal(&recorder, "run", "old");
    let old = outbox.pending(1).unwrap().pop().unwrap();
    emit(
        &recorder,
        "run",
        3,
        "message",
        json!({"role":"assistant","text":"late patch","patch":true}),
    );
    assert_eq!(outbox.pending(1).unwrap(), vec![old.clone()]);
    recorder
        .observe_event(&event("run", "run-c1", 4, "delta", json!("new")))
        .unwrap();
    let started = outbox.pending(1).unwrap().pop().unwrap();
    assert!(started.started && started.cancel);
    assert!(started.summary.is_empty());
    assert_ne!(started.id, old.id);
    outbox.finish(&old.id).unwrap();
    assert_eq!(outbox.pending(1).unwrap(), vec![started.clone()]);
    recorder
        .observe_event(&event("run", "run-c1", 5, "done", json!({})))
        .unwrap();
    let done = outbox.pending(1).unwrap().pop().unwrap();
    assert!(!done.started && !done.cancel);
    assert_eq!(done.summary, "new");
    assert_eq!(done.started_at_ms, started.started_at_ms);
    assert_ne!(done.id, started.id);
    outbox.finish(&started.id).unwrap();
    assert_eq!(outbox.pending(1).unwrap(), vec![done]);
}

#[test]
fn oversized_workspace_never_reserves_native_ownership() {
    let (_scratch, outbox, recorder, _clock) = fixture();
    let killed = Arc::new(AtomicBool::new(false));
    let workspace = format!("C:/{}", "x".repeat(4094));
    assert_eq!(workspace.len(), 4097);
    assert!(!recorder.register_run(
        "too-long",
        "claude",
        &workspace,
        Some("native-1"),
        "q",
        &killed
    ));
    assert!(outbox.pending(1).unwrap().is_empty());
    assert_eq!(
        outbox
            .connection
            .lock()
            .query_row("SELECT COUNT(*) FROM slots", [], |row| row.get::<_, u64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn dead_owner_after_start_ack_becomes_one_stable_final_cancellation() {
    let (_scratch, outbox, recorder, _clock) = fixture_with_owner(Some(ProcessOwner {
        pid: 41,
        birth: 900_719_925_474_099_123,
    }));
    register(&recorder, "run");
    let started = outbox.pending(1).unwrap().pop().unwrap();
    let metadata: String = outbox
        .connection
        .lock()
        .query_row("SELECT metadata_json FROM slots", [], |row| row.get(0))
        .unwrap();
    let metadata: Pending = serde_json::from_str(&metadata).unwrap();
    assert!(metadata.prompt.is_empty() && metadata.summary.is_empty());
    outbox.finish(&started.id).unwrap();
    assert!(outbox.pending(1).unwrap().is_empty());
    assert_eq!(
        outbox
            .reap_with(2_000, |pid| {
                assert_eq!(pid, 41);
                Ok(None)
            })
            .unwrap(),
        1
    );
    let cancelled = outbox.pending(1).unwrap().pop().unwrap();
    assert!(cancelled.cancel && !cancelled.started);
    assert!(cancelled.id.starts_with("ccgui-orphan-"));
    assert!(cancelled.prompt.is_empty() && cancelled.summary.is_empty());
    assert_eq!(cancelled.generation, 7);
    assert_eq!(cancelled.started_at_ms, started.started_at_ms);
    assert_eq!(cancelled.completed_at_ms, 2_000);
    outbox.finish(&started.id).unwrap();
    assert_eq!(outbox.pending(1).unwrap(), vec![cancelled.clone()]);
    assert_eq!(outbox.reap_with(3_000, |_| Ok(None)).unwrap(), 0);
    assert_eq!(outbox.pending(1).unwrap(), vec![cancelled.clone()]);
    outbox.finish(&cancelled.id).unwrap();
    assert_eq!(
        outbox
            .connection
            .lock()
            .query_row("SELECT COUNT(*) FROM slots", [], |row| row.get::<_, u64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn live_and_unknown_owners_are_retained_but_pid_reuse_retires_the_old_incarnation() {
    let (_scratch, outbox, recorder, _clock) = fixture_with_owner(Some(ProcessOwner {
        pid: 42,
        birth: 123,
    }));
    register(&recorder, "run");
    let started = outbox.pending(1).unwrap();
    assert_eq!(outbox.reap_with(2_000, |_| Ok(Some(123))).unwrap(), 0);
    assert_eq!(outbox.reap_with(2_000, |_| Err(())).unwrap(), 0);
    assert_eq!(outbox.pending(1).unwrap(), started);
    assert_eq!(outbox.reap_with(2_000, |_| Ok(Some(456))).unwrap(), 1);
    assert!(outbox.pending(1).unwrap()[0].cancel && !outbox.pending(1).unwrap()[0].started);
}

#[test]
fn committed_completion_survives_owner_death_even_if_committed_during_probe() {
    let (_scratch, outbox, recorder, _clock) = fixture_with_owner(Some(ProcessOwner {
        pid: 43,
        birth: 123,
    }));
    register(&recorder, "run");
    assert_eq!(
        outbox
            .reap_with(2_000, |_| {
                terminal(&recorder, "run", "committed before exit");
                Ok(None)
            })
            .unwrap(),
        1
    );
    let result = outbox.pending(1).unwrap().pop().unwrap();
    assert!(!result.cancel && !result.started);
    assert_eq!(result.summary, "committed before exit");
    assert_eq!(result.id, event_id("run", "run", 2));
    outbox.finish(&result.id).unwrap();
    assert!(outbox.pending(1).unwrap().is_empty());
}

#[test]
fn reaper_token_compare_and_swap_cannot_retire_a_replacement_reservation() {
    let (_scratch, outbox, recorder, _clock) = fixture_with_owner(Some(ProcessOwner {
        pid: 44,
        birth: 123,
    }));
    register(&recorder, "run");
    let original = outbox.pending(1).unwrap();
    assert_eq!(
        outbox
            .reap_with(2_000, |_| {
                outbox
                    .connection
                    .lock()
                    .execute("UPDATE slots SET token='replacement' WHERE root='run'", [])
                    .unwrap();
                Ok(None)
            })
            .unwrap(),
        0
    );
    assert_eq!(outbox.pending(1).unwrap(), original);
    assert_eq!(
        outbox
            .connection
            .lock()
            .query_row("SELECT active FROM slots", [], |row| row.get::<_, u64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn schema_two_migration_preserves_started_rows_and_keeps_unknown_owners() {
    let (scratch, outbox, recorder, _clock) = fixture();
    register(&recorder, "run");
    let expected = outbox.pending(1).unwrap();
    outbox.connection.lock().execute_batch("ALTER TABLE slots DROP COLUMN owner_pid; ALTER TABLE slots DROP COLUMN owner_birth; ALTER TABLE slots DROP COLUMN metadata_json; PRAGMA user_version=2;").unwrap();
    let reopened = Outbox::open(scratch.path()).unwrap();
    assert_eq!(reopened.pending(1).unwrap(), expected);
    assert_eq!(
        reopened
            .reap_with(2_000, |_| panic!("unknown owners must not be guessed"))
            .unwrap(),
        0
    );
    assert_eq!(
        reopened
            .connection
            .lock()
            .query_row("SELECT active FROM slots", [], |row| row.get::<_, u64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn dead_empty_unknown_session_reservation_releases_capacity_without_faking_a_source() {
    let (_scratch, outbox, recorder, _clock) = fixture_with_owner(Some(ProcessOwner {
        pid: 45,
        birth: 123,
    }));
    let killed = Arc::new(AtomicBool::new(false));
    assert!(recorder.register_run("run", "claude", "C:/project", None, "q", &killed));
    assert_eq!(outbox.reap_with(2_000, |_| Ok(None)).unwrap(), 1);
    assert!(outbox.pending(1).unwrap().is_empty());
    assert_eq!(
        outbox
            .connection
            .lock()
            .query_row("SELECT COUNT(*) FROM slots", [], |row| row.get::<_, u64>(0))
            .unwrap(),
        0
    );
}
