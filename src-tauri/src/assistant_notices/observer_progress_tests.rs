use super::*;

#[test]
fn progress_checkpoints_accept_every_registered_source_engine() {
    for engine in crate::config::ENGINES {
        let (_scratch, outbox, recorder, _clock) = progress_fixture();
        let killed = Arc::new(AtomicBool::new(false));
        assert!(recorder.register_run(
            "run",
            engine,
            "C:/project",
            Some("session"),
            "question",
            &killed
        ));
        let text = summary(engine);
        for (seq, kind, data) in [
            (1, "delta", json!(text)),
            (2, "message", json!({"role":"tool","text":"Read"})),
        ] {
            recorder.observe_event(&json!({"runId":"run","engine":engine,"sessionId":"session","seq":seq,"kind":kind,"data":data})).unwrap();
        }
        let checkpoint = checkpoint(&outbox, 1_000);
        assert_eq!(checkpoint.engine, engine);
        assert_eq!(checkpoint.summary, text);
    }
}

fn progress_fixture() -> (Scratch, Arc<Outbox>, Recorder, Arc<AtomicU64>) {
    let fixture = fixture();
    fixture.1.set_observer_ready(11, 10_000_000).unwrap();
    fixture
}

fn summary(label: &str) -> String {
    format!("{label} {}", "已完成可验证的项目任务🙂。".repeat(12))
}

fn snapshot(recorder: &Recorder, seq: u64, text: &str) {
    emit(
        recorder,
        "run",
        seq,
        "message",
        json!({"role":"assistant","text":text}),
    );
}

fn checkpoint(outbox: &Outbox, now: u64) -> Checkpoint {
    let rows = outbox.observer_pending(10, now).unwrap();
    assert_eq!(rows.len(), 1);
    rows.into_iter().next().unwrap()
}

fn stored_count(outbox: &Outbox) -> usize {
    outbox
        .connection
        .lock()
        .query_row("SELECT COUNT(*) FROM observer_checkpoints", [], |row| {
            row.get(0)
        })
        .unwrap()
}

#[test]
fn deltas_do_not_write_and_stable_boundary_captures_only_assistant_text_once() {
    let (_scratch, outbox, recorder, clock) = progress_fixture();
    register(&recorder, "run");
    let completion = outbox.pending(10).unwrap();
    let writes: u64 = outbox
        .connection
        .lock()
        .query_row("SELECT total_changes()", [], |row| row.get(0))
        .unwrap();
    let text = "中文🙂".repeat(4);
    for seq in 1..=20 {
        emit(&recorder, "run", seq, "delta", json!(text));
    }
    assert_eq!(stored_count(&outbox), 0);
    let after: u64 = outbox
        .connection
        .lock()
        .query_row("SELECT total_changes()", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        after, writes,
        "ordinary tokens must not acquire a SQLite write"
    );
    emit(
        &recorder,
        "run",
        21,
        "message",
        json!({"role":"tool","text":"Read","args":{"secret":"never send"}}),
    );
    let first = checkpoint(&outbox, 1_000);
    assert_eq!(first.summary, text.repeat(20));
    assert_eq!(first.observer_generation, 11);
    assert_eq!(
        outbox.pending(10).unwrap(),
        completion,
        "progress cannot replace start/completion"
    );
    outbox.finish_checkpoint(&first.id).unwrap();
    assert_eq!(
        outbox
            .with_current_checkpoint(&first, 1_000, || 42)
            .unwrap(),
        Some(42)
    );
    clock.store(31_000, Ordering::SeqCst);
    emit(&recorder, "run", 22, "delta", json!(text.repeat(20)));
    emit(&recorder, "run", 23, "thinking", json!("private reasoning"));
    assert_eq!(
        stored_count(&outbox),
        0,
        "same context stays deduplicated after ACK"
    );
}

#[test]
fn tool_args_results_and_assistant_patches_do_not_trigger_capture() {
    let (_scratch, outbox, recorder, _clock) = progress_fixture();
    register(&recorder, "run");
    for (seq, data) in [
        (
            2,
            json!({"role":"tool","text":"Read","args":{"path":"private"},"patch":true}),
        ),
        (
            4,
            json!({"role":"tool","text":"Read","result":{"secret":"private"},"patch":true}),
        ),
        (
            6,
            json!({"role":"assistant","text":summary("patch"),"patch":true}),
        ),
    ] {
        emit(
            &recorder,
            "run",
            seq - 1,
            "delta",
            json!(summary("segment")),
        );
        emit(&recorder, "run", seq, "message", data);
        assert_eq!(stored_count(&outbox), 0);
    }
    snapshot(&recorder, 7, &summary("complete snapshot"));
    assert_eq!(
        checkpoint(&outbox, 1_000).summary,
        summary("complete snapshot")
    );
}

#[test]
fn attempts_are_throttled_at_thirty_seconds_and_old_ack_cannot_erase_replacement() {
    let (_scratch, outbox, recorder, clock) = progress_fixture();
    register(&recorder, "run");
    snapshot(&recorder, 1, &summary("first"));
    let old = checkpoint(&outbox, 1_000);
    clock.store(30_999, Ordering::SeqCst);
    snapshot(&recorder, 2, &summary("second"));
    assert_eq!(checkpoint(&outbox, 30_999).id, old.id);
    clock.store(31_000, Ordering::SeqCst);
    snapshot(&recorder, 3, &summary("second"));
    let replacement = checkpoint(&outbox, 31_000);
    assert_ne!(replacement.id, old.id);
    outbox.finish_checkpoint(&old.id).unwrap();
    assert_eq!(checkpoint(&outbox, 31_000), replacement);
    // Progress ACK leaves the original completion start available.
    outbox.finish_checkpoint(&replacement.id).unwrap();
    assert_eq!(outbox.pending(10).unwrap().len(), 1);
    assert_eq!(
        outbox
            .with_current_checkpoint(&replacement, 31_000, || true)
            .unwrap(),
        Some(true)
    );
}

#[test]
fn readiness_pause_old_policy_future_time_and_ttl_reject_copied_checkpoints() {
    let (_scratch, outbox, recorder, _clock) = progress_fixture();
    register(&recorder, "run");
    snapshot(&recorder, 1, &summary("first"));
    let copied = checkpoint(&outbox, 1_000);
    assert!(outbox.observer_pending(10, 999).unwrap().is_empty());
    assert_eq!(
        outbox
            .with_current_checkpoint(&copied, 999, || panic!("future"))
            .unwrap(),
        None::<()>
    );
    assert_eq!(
        outbox
            .with_current_checkpoint(&copied, 181_000, || true)
            .unwrap(),
        Some(true)
    );
    assert_eq!(
        outbox
            .with_current_checkpoint(&copied, 181_001, || panic!("expired"))
            .unwrap(),
        None::<()>
    );
    outbox.set_observer_ready(11, 0).unwrap();
    assert_eq!(stored_count(&outbox), 0);
    assert!(outbox.observer_pending(10, 1_000).unwrap().is_empty());
    assert_eq!(
        outbox
            .with_current_checkpoint(&copied, 1_000, || panic!("paused"))
            .unwrap(),
        None::<()>
    );
    outbox.set_observer_ready(12, 100_000).unwrap();
    assert_eq!(
        outbox
            .with_current_checkpoint(&copied, 1_000, || panic!("old policy"))
            .unwrap(),
        None::<()>
    );
    assert!(outbox.observer_pending(10, 1_000).unwrap().is_empty());
}

#[test]
fn unknown_readiness_still_throttles_attempts_and_short_unicode_text_is_ignored() {
    let (_scratch, outbox, recorder, clock) = fixture();
    register(&recorder, "run");
    snapshot(&recorder, 1, &"🙂".repeat(79));
    assert_eq!(stored_count(&outbox), 0);
    snapshot(&recorder, 2, &"🙂".repeat(80));
    assert_eq!(stored_count(&outbox), 0);
    outbox.set_observer_ready(11, 1_000_000).unwrap();
    clock.store(30_999, Ordering::SeqCst);
    snapshot(&recorder, 3, &"🙂".repeat(80));
    assert_eq!(stored_count(&outbox), 0);
    clock.store(31_000, Ordering::SeqCst);
    snapshot(&recorder, 4, &format!(" {} ", "🙂".repeat(2_000)));
    let captured = checkpoint(&outbox, 31_000);
    assert_eq!(captured.summary.chars().count(), 1_500);
    assert!(captured.summary.chars().all(|character| character == '🙂'));
}

#[test]
fn cancellation_terminal_new_turn_and_finish_invalidate_even_acked_copies() {
    for action in [
        "error",
        "turn_complete",
        "cancelled",
        "killed",
        "finish",
        "continuation",
    ] {
        let (_scratch, outbox, recorder, clock) = progress_fixture();
        let killed = register(&recorder, "run");
        snapshot(&recorder, 1, &summary("before"));
        let copied = checkpoint(&outbox, 1_000);
        outbox.finish_checkpoint(&copied.id).unwrap();
        clock.store(2_000, Ordering::SeqCst);
        match action {
            "finish" => recorder.finish_run("run").unwrap(),
            "killed" => {
                killed.store(true, Ordering::SeqCst);
                emit(&recorder, "run", 2, "usage", json!({}));
            }
            "continuation" => {
                recorder
                    .observe_event(&event(
                        "run",
                        "run-c1",
                        2,
                        "message",
                        json!({"role":"assistant","text":summary("after")}),
                    ))
                    .unwrap();
                let newer = checkpoint(&outbox, 2_000);
                assert!(newer.started_at_ms > copied.started_at_ms);
                assert_ne!(newer.id, copied.id);
            }
            kind => emit(&recorder, "run", 2, kind, json!({})),
        }
        assert_eq!(
            outbox
                .with_current_checkpoint(&copied, 2_000, || panic!("old turn"))
                .unwrap(),
            None::<()>
        );
        if action != "continuation" {
            assert!(outbox.observer_pending(10, 2_000).unwrap().is_empty());
        }
    }
}

#[test]
fn invalid_source_sequence_and_replay_cannot_produce_checkpoints() {
    let (_scratch, outbox, recorder, _clock) = progress_fixture();
    register(&recorder, "run");
    emit(&recorder, "run", 2, "delta", json!("short"));
    let valid = event(
        "run",
        "run",
        3,
        "message",
        json!({"role":"assistant","text":summary("valid")}),
    );
    for mutate in 0..4 {
        let mut wrong = valid.clone();
        match mutate {
            0 => wrong["sourceRunId"] = json!("unknown"),
            1 => wrong["sessionId"] = json!("wrong-session"),
            2 => wrong["seq"] = json!(2),
            _ => wrong["engine"] = json!("codex"),
        }
        recorder.observe_event(&wrong).unwrap();
        assert_eq!(stored_count(&outbox), 0);
    }
    recorder.observe_event(&valid).unwrap();
    let copied = checkpoint(&outbox, 1_000);
    outbox.finish_checkpoint(&copied.id).unwrap();
    recorder.observe_event(&valid).unwrap();
    assert_eq!(stored_count(&outbox), 0);
}

#[test]
fn progress_failure_is_throttled_and_cannot_poison_completion() {
    let (_scratch, outbox, recorder, clock) = progress_fixture();
    register(&recorder, "run");
    outbox.connection.lock().execute_batch("CREATE TRIGGER fail_progress BEFORE INSERT ON observer_checkpoints BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    snapshot(&recorder, 1, &summary("first"));
    assert_eq!(stored_count(&outbox), 0);
    assert!(!recorder.runs.lock().get("run").unwrap().poisoned);
    outbox
        .connection
        .lock()
        .execute_batch("DROP TRIGGER fail_progress;")
        .unwrap();
    clock.store(30_999, Ordering::SeqCst);
    snapshot(&recorder, 2, &summary("first"));
    assert_eq!(stored_count(&outbox), 0);
    clock.store(31_000, Ordering::SeqCst);
    snapshot(&recorder, 3, &summary("first"));
    assert_eq!(stored_count(&outbox), 1);
    let copied = checkpoint(&outbox, 31_000);
    outbox.connection.lock().execute_batch("CREATE TRIGGER fail_progress_delete BEFORE DELETE ON observer_checkpoints BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
    emit(&recorder, "run", 4, "done", json!({}));
    let done = outbox.pending(10).unwrap().pop().unwrap();
    assert!(!done.cancel && !done.started);
    assert_eq!(done.summary, summary("first"));
    assert_eq!(
        outbox
            .with_current_checkpoint(&copied, 31_000, || panic!(
                "terminal metadata must fence stale copies"
            ))
            .unwrap(),
        None::<()>
    );
    assert_eq!(
        stored_count(&outbox),
        1,
        "fixture proves invalidation write failed"
    );
    // Optional DELETE failures must not cascade into completion ACK or capacity
    // release. Its orphaned progress row remains bounded and is independently stale.
    recorder.finish_run("run").unwrap();
    outbox.finish(&done.id).unwrap();
    assert!(outbox.pending(10).unwrap().is_empty());
    assert_eq!(
        outbox
            .connection
            .lock()
            .query_row("SELECT COUNT(*) FROM slots", [], |row| row
                .get::<_, usize>(0))
            .unwrap(),
        0
    );
    // Cleanup failure is visible to the consumer, but cannot undo the completion.
    assert!(outbox.observer_pending(10, 31_000).is_err());
    outbox
        .connection
        .lock()
        .execute_batch("DROP TRIGGER fail_progress_delete;")
        .unwrap();
    assert!(outbox.observer_pending(10, 31_000).unwrap().is_empty());
    assert_eq!(stored_count(&outbox), 0);
}

#[test]
fn schema_three_extension_is_compatible_with_second_connection_and_legacy_completion_sql() {
    let (scratch, outbox, recorder, _clock) = progress_fixture();
    register(&recorder, "run");
    snapshot(&recorder, 1, &summary("working"));
    let copied = checkpoint(&outbox, 1_000);
    let reopened = Outbox::open(scratch.path()).unwrap();
    assert_eq!(checkpoint(&reopened, 1_000), copied);
    let legacy = Connection::open(scratch.path()).unwrap();
    assert_eq!(
        legacy
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        3
    );
    // These are the existing schema-3 completion consumer statements. Progress
    // neither occupies its result set nor disappears when a start is ACKed.
    let id: String = legacy
        .query_row(
            "SELECT id FROM pending ORDER BY started_at_ms,id LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    legacy
        .execute("DELETE FROM pending WHERE id=?1", [&id])
        .unwrap();
    legacy.execute("DELETE FROM slots WHERE active=0 AND NOT EXISTS (SELECT 1 FROM pending WHERE pending.root=slots.root)", []).unwrap();
    assert_eq!(checkpoint(&reopened, 1_000), copied);
    assert_eq!(
        reopened
            .with_current_checkpoint(&copied, 1_000, || true)
            .unwrap(),
        Some(true)
    );
    emit(&recorder, "run", 2, "done", json!({}));
    let terminal: (String, bool, bool) = legacy
        .query_row("SELECT id,cancel,started FROM pending", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .unwrap();
    assert!(!terminal.1 && !terminal.2);
    assert_ne!(terminal.0, id);
    assert!(reopened.observer_pending(10, 1_000).unwrap().is_empty());
}

#[test]
fn unknown_session_needs_authoritative_adoption_before_progress() {
    let (_scratch, outbox, recorder, clock) = progress_fixture();
    let killed = Arc::new(AtomicBool::new(false));
    assert!(recorder.register_run(
        "run",
        "claude",
        "C:/project",
        None,
        &"问".repeat(600),
        &killed
    ));
    let mut snapshot = event(
        "run",
        "run",
        1,
        "message",
        json!({"role":"assistant","text":summary("first")}),
    );
    snapshot["sessionId"] = Value::Null;
    recorder.observe_event(&snapshot).unwrap();
    assert_eq!(stored_count(&outbox), 0);
    assert!(recorder.adopt_session("run", "claude", "native-1"));
    clock.store(31_000, Ordering::SeqCst);
    snapshot["sessionId"] = json!("native-1");
    snapshot["seq"] = json!(2);
    recorder.observe_event(&snapshot).unwrap();
    assert_eq!(checkpoint(&outbox, 31_000).prompt.chars().count(), 500);
}

#[test]
fn copied_checkpoint_requires_original_reservation_and_current_source() {
    for column in ["token", "generation", "active", "metadata_json"] {
        let (_scratch, outbox, recorder, _clock) = progress_fixture();
        register(&recorder, "run");
        snapshot(&recorder, 1, &summary("first"));
        let copied = checkpoint(&outbox, 1_000);
        match column {
            "token" => {
                outbox
                    .connection
                    .lock()
                    .execute("UPDATE slots SET token='replacement'", [])
                    .unwrap();
            }
            "generation" => {
                outbox
                    .connection
                    .lock()
                    .execute("UPDATE slots SET generation=99", [])
                    .unwrap();
            }
            "active" => {
                outbox
                    .connection
                    .lock()
                    .execute("UPDATE slots SET active=0", [])
                    .unwrap();
            }
            _ => {
                let mut phase = outbox.pending(1).unwrap().pop().unwrap();
                phase.session_id = "replacement-session".into();
                outbox
                    .connection
                    .lock()
                    .execute(
                        "UPDATE slots SET metadata_json=?1",
                        [serde_json::to_string(&phase).unwrap()],
                    )
                    .unwrap();
            }
        }
        assert_eq!(
            outbox
                .with_current_checkpoint(&copied, 1_000, || panic!("stale private proof"))
                .unwrap(),
            None::<()>
        );
        assert!(outbox.observer_pending(10, 1_000).unwrap().is_empty());
        assert_eq!(stored_count(&outbox), 0);
    }
}

#[test]
fn stale_cleanup_is_bounded_and_does_not_starve_current_rows_or_completions() {
    let (_scratch, outbox, recorder, clock) = progress_fixture();
    register(&recorder, "old");
    emit(
        &recorder,
        "old",
        1,
        "message",
        json!({"role":"assistant","text":summary("expired")}),
    );
    // Both rows must still be current when the producer admits the second one:
    // it already prunes expired rows, and a newer root for the same source also
    // invalidates the old root. Use distinct sources, then expire only the first
    // row without another producer boundary, exercising consumer-side cleanup.
    clock.store(2_000, Ordering::SeqCst);
    let killed = Arc::new(AtomicBool::new(false));
    assert!(recorder.register_run(
        "fresh",
        "claude",
        "C:/project",
        Some("native-2"),
        "question",
        &killed,
    ));
    let mut fresh_event = event(
        "fresh",
        "fresh",
        1,
        "message",
        json!({"role":"assistant","text":summary("current")}),
    );
    fresh_event["sessionId"] = json!("native-2");
    recorder.observe_event(&fresh_event).unwrap();
    assert_eq!(stored_count(&outbox), 2);
    clock.store(181_001, Ordering::SeqCst);
    assert_eq!(stored_count(&outbox), 2);
    let before = outbox.pending(10).unwrap();
    let rows = outbox.observer_pending(1, 181_001).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].summary, summary("current"));
    assert_eq!(rows[0].session_id, "native-2");
    assert_eq!(rows[0].captured_at_ms, 2_000);
    assert_eq!(stored_count(&outbox), 1);
    assert_eq!(outbox.pending(10).unwrap(), before);
}

#[test]
fn fingerprint_history_is_bounded_without_stopping_long_turns() {
    let (_scratch, outbox, recorder, clock) = progress_fixture();
    register(&recorder, "run");
    for index in 0..65 {
        let now = 1_000 + index * 30_000;
        clock.store(now, Ordering::SeqCst);
        snapshot(&recorder, index + 1, &summary(&format!("context-{index}")));
        assert_eq!(
            checkpoint(&outbox, now).summary,
            summary(&format!("context-{index}"))
        );
    }
    clock.store(1_951_000, Ordering::SeqCst);
    snapshot(&recorder, 66, &summary("context-1"));
    assert_eq!(
        checkpoint(&outbox, 1_951_000).summary,
        summary("context-64"),
        "recent context is deduplicated"
    );
    snapshot(&recorder, 67, &summary("context-0"));
    assert_eq!(
        checkpoint(&outbox, 1_951_000).summary,
        summary("context-0"),
        "oldest fingerprint was evicted, not the entire turn"
    );
}

#[test]
fn publication_transaction_blocks_cross_connection_terminal_until_closure_finishes() {
    let (scratch, outbox, recorder, _clock) = progress_fixture();
    register(&recorder, "run");
    snapshot(&recorder, 1, &summary("first"));
    let copied = checkpoint(&outbox, 1_000);
    let competing = Connection::open(scratch.path()).unwrap();
    competing.busy_timeout(Duration::ZERO).unwrap();
    let result = outbox
        .with_current_checkpoint(&copied, 1_000, || {
            // A real second SQLite connection cannot change terminal/start metadata
            // between validation and publication, even though no checkpoint row is read.
            assert!(competing
                .execute("UPDATE slots SET active=0 WHERE root='run'", [])
                .is_err());
            "published"
        })
        .unwrap();
    assert_eq!(result, Some("published"));
    assert_eq!(
        competing
            .execute("UPDATE slots SET active=0 WHERE root='run'", [])
            .unwrap(),
        1
    );
    assert_eq!(
        outbox
            .with_current_checkpoint(&copied, 1_000, || panic!("retired"))
            .unwrap(),
        None::<()>
    );
}

#[test]
fn same_source_new_root_and_equal_time_ambiguity_fence_old_checkpoint() {
    for same_time in [false, true] {
        let (_scratch, outbox, recorder, clock) = progress_fixture();
        register(&recorder, "run");
        snapshot(&recorder, 1, &summary("before"));
        let copied = checkpoint(&outbox, 1_000);
        outbox.finish_checkpoint(&copied.id).unwrap();
        clock.store(if same_time { 1_000 } else { 2_000 }, Ordering::SeqCst);
        register(&recorder, "new-root");
        assert_eq!(
            outbox
                .with_current_checkpoint(&copied, 2_000, || panic!("new source turn"))
                .unwrap(),
            None::<()>
        );
        emit(
            &recorder,
            "new-root",
            1,
            "message",
            json!({"role":"assistant","text":summary("after")}),
        );
        if same_time {
            assert!(
                outbox.observer_pending(10, 2_000).unwrap().is_empty(),
                "equal-time distinct roots are ambiguous"
            );
        } else {
            assert_eq!(checkpoint(&outbox, 2_000).summary, summary("after"));
        }
        emit(&recorder, "new-root", 2, "done", json!({}));
        recorder.finish_run("new-root").unwrap();
        assert_eq!(
            outbox
                .with_current_checkpoint(&copied, 2_000, || panic!("newer inactive unACKed slot"))
                .unwrap(),
            None::<()>
        );
    }
}

#[test]
fn progress_has_independent_capacity_and_recovers_orphans_without_blocking_completion() {
    let (_scratch, outbox, recorder, clock) = progress_fixture();
    register(&recorder, "run");
    snapshot(&recorder, 1, &summary("first"));
    {
        let mut connection = outbox.connection.lock();
        let transaction = connection.transaction().unwrap();
        for index in 1..SLOT_CAP {
            transaction.execute(
                "INSERT INTO observer_checkpoints(root,format,id,token,admission_generation,engine,session_id,workspace_path,prompt,summary,started_at_ms,captured_at_ms,observer_generation)
                 SELECT ?1,format,?2,token,admission_generation,engine,session_id,workspace_path,prompt,summary,started_at_ms,captured_at_ms,observer_generation FROM observer_checkpoints WHERE root='run'",
                params![format!("orphan-{index}"), uuid::Uuid::new_v4().to_string()],
            ).unwrap();
        }
        transaction.execute_batch("CREATE TRIGGER fail_cleanup BEFORE DELETE ON observer_checkpoints BEGIN SELECT RAISE(ABORT,'fixture'); END;").unwrap();
        transaction.commit().unwrap();
    }
    assert_eq!(stored_count(&outbox), SLOT_CAP);
    clock.store(2_000, Ordering::SeqCst);
    register(&recorder, "new-root");
    emit(
        &recorder,
        "new-root",
        1,
        "message",
        json!({"role":"assistant","text":summary("blocked by capacity")}),
    );
    assert_eq!(stored_count(&outbox), SLOT_CAP);
    assert_eq!(
        outbox
            .connection
            .lock()
            .query_row(
                "SELECT COUNT(*) FROM observer_checkpoints WHERE root='new-root'",
                [],
                |row| row.get::<_, usize>(0)
            )
            .unwrap(),
        0
    );
    outbox
        .connection
        .lock()
        .execute_batch("DROP TRIGGER fail_cleanup;")
        .unwrap();
    clock.store(32_000, Ordering::SeqCst);
    emit(
        &recorder,
        "new-root",
        2,
        "message",
        json!({"role":"assistant","text":summary("recovered")}),
    );
    assert_eq!(stored_count(&outbox), 1);
    assert_eq!(checkpoint(&outbox, 32_000).summary, summary("recovered"));
    emit(&recorder, "new-root", 3, "done", json!({}));
    assert!(outbox
        .pending(10)
        .unwrap()
        .iter()
        .any(|pending| !pending.cancel && pending.summary == summary("recovered")));
}
