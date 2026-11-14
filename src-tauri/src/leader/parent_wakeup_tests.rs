use super::*;

#[tokio::test]
async fn task_list_terminal_previews_preserve_unread_notice_and_wait_returns_one_full_body() {
    let f = basic();
    let (id, run) = spawn(&f, "long-completion");
    let body = format!("{}{}", "开头证据🚀".repeat(400), "最终结论🎯".repeat(150));
    observe(&f, &run, "long-child", "session", json!("long-child"), 1);
    observe(&f, &run, "long-child", "delta", json!(&body), 2);
    observe(&f, &run, "long-child", "done", json!({}), 3);
    f.manager.finish(&run);
    assert_eq!(f.manager.parent_wakeups().unwrap().len(), 1);
    let short = f.manager.list_response(&f.manager.inner.lock(), &f.parent).unwrap();
    for value in [&short["branches"][0], &short["branches"][0]["delegation"]] {
        assert_eq!(value["result"].as_str().unwrap().chars().count(), RUNNING_RESULT_PREVIEW_CHARS);
        assert_eq!(value["resultPreview"], true);
        assert_eq!(value["resultTruncated"], true);
    }
    f.manager.consume_parent_wakeups(&f.parent, short["branches"].as_array().unwrap()).unwrap();
    assert_eq!(f.manager.parent_wakeups().unwrap().len(), 1, "a preview is not a full read");
    assert_eq!(branch(&f, &id).delegation.unwrap().result, body, "stored result must remain exact");
    let full = f.manager.list_response_with_options(&f.manager.inner.lock(), &f.parent, false, true).unwrap();
    let result = &full["branches"][0];
    assert_eq!(result["delegation"]["result"], body);
    assert_eq!(result["resultSource"], "delegation.result");
    assert_eq!(result["result"].as_str().unwrap().chars().count(), RUNNING_RESULT_PREVIEW_CHARS);
    let waited = f.manager.wait_for_children(&f.caller, &f.parent, &WaitArgs {
        branch_ids: Some(vec![id.clone()]), timeout_seconds: Some(0), include_task: None,
    }).await.unwrap();
    assert_eq!(waited["branches"][0]["delegation"]["result"], body);
    assert!(f.manager.parent_wakeups().unwrap().is_empty());
    // A later human result is independent of the sealed managed assignment.
    {
        let mut inner = f.manager.inner.lock();
        let record = inner.branches.get_mut(&id).unwrap();
        record.branch.run_id = Some("human-followup".into());
        record.branch.result = "不同的人工续聊结果".repeat(100);
        f.manager.save(record).unwrap();
    }
    let followup = f.manager.list_response_with_options(&f.manager.inner.lock(), &f.parent, false, true).unwrap();
    assert_eq!(followup["branches"][0]["result"], "不同的人工续聊结果".repeat(100));
    assert_eq!(followup["branches"][0]["delegation"]["result"], body);
    assert!(followup["branches"][0].get("resultSource").is_none());
}

fn completed() -> (Fixture, String, String) {
    let f = basic();
    let (id, run) = spawn(&f, "completion-assignment");
    settle(&f, &id, &run, "completion-child");
    (f, id, run)
}

#[tokio::test]
async fn parent_wakeup_full_bounded_storage_result_is_readable_even_when_history_is_longer() {
    let f = basic();
    let (id, run) = spawn(&f, "bounded-completion");
    observe(&f, &run, "bounded-child", "session", json!("bounded-child"), 1);
    observe(&f, &run, "bounded-child", "delta", json!("x".repeat(MAX_RESULT_CHARS + 100)), 2);
    observe(&f, &run, "bounded-child", "done", json!({}), 3);
    f.manager.finish(&run);
    assert_eq!(f.manager.parent_wakeups().unwrap().len(), 1);
    let response = f.manager.wait_for_children(&f.caller, &f.parent, &WaitArgs {
        branch_ids: Some(vec![id]), timeout_seconds: Some(0), include_task: None,
    }).await.unwrap();
    let result = &response["branches"][0]["delegation"];
    assert_eq!(result["resultTruncated"], true, "stored result honestly reports its own limit");
    assert_ne!(result["resultPreview"], true, "the complete stored result was delivered");
    assert_eq!(result["result"].as_str().unwrap().chars().count(), MAX_RESULT_CHARS);
    assert!(f.manager.parent_wakeups().unwrap().is_empty());
}

#[test]
fn parent_wakeup_completion_is_durable_and_duplicate_events_do_not_requeue() {
    let (f, id, run) = completed();
    let notices = f.manager.parent_wakeups().unwrap();
    assert_eq!(notices.len(), 1);
    let notice = &notices[0];
    assert_eq!(notice.branch_id, id);
    assert_eq!(notice.parent, f.parent);
    assert_eq!(notice.child_run_id, run);
    assert!(f
        .manager
        .claim_parent_wakeup(&notice.id, "parent-resume")
        .unwrap());
    assert!(f
        .manager
        .claim_parent_wakeup(&notice.id, "parent-resume")
        .unwrap());
    assert!(!f
        .manager
        .claim_parent_wakeup(&notice.id, "other-resume")
        .unwrap());
    assert!(!f
        .manager
        .resolve_parent_wakeup(&notice.id, "wrong-run", "delivered")
        .unwrap());
    assert!(f
        .manager
        .resolve_parent_wakeup(&notice.id, "parent-resume", "delivered")
        .unwrap());
    observe(&f, &run, "completion-child", "done", json!({}), 3);
    assert!(f.manager.parent_wakeups().unwrap().is_empty());
    assert!(!f
        .manager
        .claim_parent_wakeup(&notice.id, "another-resume")
        .unwrap());
}

#[test]
fn parent_wakeup_concurrent_claims_have_one_execution_owner() {
    let (f, _, _) = completed();
    let notice = f.manager.parent_wakeups().unwrap().remove(0);
    let a = f.manager.clone();
    let b = a.clone();
    let id = notice.id.clone();
    let first = std::thread::spawn(move || a.claim_parent_wakeup(&id, "resume-a").unwrap());
    let second = std::thread::spawn(move || b.claim_parent_wakeup(&notice.id, "resume-b").unwrap());
    assert_eq!(
        usize::from(first.join().unwrap()) + usize::from(second.join().unwrap()),
        1
    );
}

#[test]
fn parent_wakeup_no_historical_backfill_or_manual_continuation_replay() {
    let (f, id, _) = completed();
    f.manager
        .db
        .0
        .lock()
        .execute(
            "DELETE FROM plugin_kv WHERE plugin_id='$ccgui-task-parent-wakeup'",
            [],
        )
        .unwrap();
    let mut inner = f.manager.inner.lock();
    let record = inner.branches.get_mut(&id).unwrap();
    record.branch.result = "manual later result".into();
    f.manager.save(record).unwrap();
    drop(inner);
    assert!(f.manager.parent_wakeups().unwrap().is_empty());
}

#[tokio::test]
async fn parent_wakeup_original_handoff_selector_consumes_successor_completion() {
    let (f, original, _, held) = handoff_fixture();
    let (next, run, _, _) = handoff(&f, &original, &held.request_id, "wake-handoff", "summary")
        .unwrap()
        .unwrap();
    settle(&f, &next.id, &run, "wake-successor");
    let pending = f.manager.parent_wakeups().unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].branch_id, next.id);
    assert_eq!(pending[0].parent, f.parent);
    // GUI snapshot/view construction does not claim that the parent read it.
    let _ = f
        .manager
        .views(&f.manager.inner.lock(), &f.parent, None)
        .unwrap();
    assert_eq!(f.manager.parent_wakeups().unwrap().len(), 1);
    let response = f
        .manager
        .wait_for_children(
            &f.caller,
            &f.parent,
            &WaitArgs {
                branch_ids: Some(vec![original]),
                timeout_seconds: Some(0),
                include_task: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(response["branches"][0]["actualBranchId"], next.id);
    assert!(f.manager.parent_wakeups().unwrap().is_empty());
}

#[test]
fn parent_wakeup_explicit_new_assignment_cancels_the_old_notice() {
    let (f, id, _) = completed();
    let old = f.manager.parent_wakeups().unwrap().remove(0);
    let _ = held_send(&f, &id, "new-assignment");
    assert!(f.manager.parent_wakeups().unwrap().is_empty());
    assert!(!f
        .manager
        .claim_parent_wakeup(&old.id, "stale-resume")
        .unwrap());
}

#[test]
fn parent_wakeup_retry_is_pre_spawn_only_and_unknown_is_not_replayable() {
    let (f, _, _) = completed();
    let notice = f.manager.parent_wakeups().unwrap().remove(0);
    assert!(f
        .manager
        .claim_parent_wakeup(&notice.id, "attempt-one")
        .unwrap());
    assert!(f
        .manager
        .resolve_parent_wakeup(&notice.id, "attempt-one", "retry")
        .unwrap());
    assert!(f
        .manager
        .claim_parent_wakeup(&notice.id, "attempt-two")
        .unwrap());
    assert!(f
        .manager
        .resolve_parent_wakeup(&notice.id, "attempt-two", "unknown")
        .unwrap());
    assert!(!f
        .manager
        .claim_parent_wakeup(&notice.id, "attempt-three")
        .unwrap());
    assert_eq!(f.manager.parent_wakeups().unwrap()[0].state, "unknown");
}

#[test]
fn parent_wakeup_stop_can_cancel_before_a_claim() {
    let (f, _, _) = completed();
    let notice = f.manager.parent_wakeups().unwrap().remove(0);
    assert!(f
        .manager
        .resolve_parent_wakeup(&notice.id, "stop-before-send", "cancelled")
        .unwrap());
    assert!(!f
        .manager
        .claim_parent_wakeup(&notice.id, "after-stop",)
        .unwrap());
}

#[test]
fn parent_wakeup_does_not_retain_slots_for_deleted_branches() {
    let (f, id, _) = completed();
    f.manager.inner.lock().branches.remove(&id);
    f.manager
        .db
        .0
        .lock()
        .execute("DELETE FROM leader_branches WHERE id=?1", [&id])
        .unwrap();
    assert!(f.manager.parent_wakeups().unwrap().is_empty());
    let count: u64 = f
        .manager
        .db
        .0
        .lock()
        .query_row(
            "SELECT count(*) FROM plugin_kv WHERE plugin_id='$ccgui-task-parent-wakeup'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
#[cfg(windows)]
fn parent_wakeup_task_send_preserves_windows_parent_path_aliases() {
    let mut f = fixture_with_workspace(Arc::new(|_, _, _| Ok(())), "claude", "G:\\repo");
    let (id, run) = spawn(&f, "first-path-assignment");
    settle(&f, &id, &run, "alias-child");
    f.parent.workspace_path = "g:/repo".into();
    f.caller.workspace_path = "g:/repo".into();
    hot_send_cache(&f, &id);
    let args = SendArgs {
        branch_id: id.clone(),
        request_id: "alias-followup".into(),
        message: "followup".into(),
        images: vec![],
    };
    let Reservation::Start((_, next_run)) = f
        .manager
        .reserve_send(
            &f.caller,
            &f.parent,
            "manual",
            &args,
            encoded(&args).unwrap(),
        )
        .unwrap()
    else {
        panic!("expected followup start");
    };
    settle(&f, &id, &next_run, "alias-child");
    let notices = f.manager.parent_wakeups().unwrap();
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0].request_id, "alias-followup");
    assert!(same_workspace(&notices[0].parent.workspace_path, "G:/repo"));
}

#[test]
fn parent_wakeup_cold_restart_retains_pending_and_fences_uncertain_starts() {
    let (f, _, _) = completed();
    let notice = f.manager.parent_wakeups().unwrap().remove(0);
    let (second, run) = spawn(&f, "second-completion");
    settle(&f, &second, &run, "second-completed-child");
    assert!(f
        .manager
        .claim_parent_wakeup(&notice.id, "unconfirmed-start")
        .unwrap());
    let restarted = LeaderManager::with_services(
        f.manager.db.clone(),
        Arc::new(crate::engine::ProcessRegistry::default()),
        Arc::new(FakeEmitter::default()),
        Arc::new(|| 1_000_000),
        Arc::new(|_, _, _| Ok(())),
    )
    .unwrap();
    let notices = restarted.parent_wakeups().unwrap();
    assert_eq!(notices.iter().filter(|n| n.state == "pending").count(), 1);
    assert_eq!(notices.iter().filter(|n| n.state == "unknown").count(), 1);
    assert!(!restarted
        .claim_parent_wakeup(&notice.id, "replayed-start")
        .unwrap());
}

#[test]
fn parent_wakeup_result_and_outbox_commit_or_rollback_together() {
    let f = basic();
    let (id, run) = spawn(&f, "atomic-completion");
    observe(
        &f,
        &run,
        "atomic-child",
        "session",
        json!("atomic-child"),
        1,
    );
    f.manager.db.0.lock().execute_batch("CREATE TRIGGER reject_completion_outbox BEFORE INSERT ON plugin_kv
        WHEN NEW.plugin_id='$ccgui-task-parent-wakeup' BEGIN SELECT RAISE(ABORT,'outbox write failed'); END;").unwrap();
    observe(&f, &run, "atomic-child", "done", json!({}), 2);
    assert!(f.manager.parent_wakeups().is_err());
    let persisted: String = f
        .manager
        .db
        .0
        .lock()
        .query_row(
            "SELECT state FROM leader_branches WHERE id=?1",
            [&id],
            |r| r.get(0),
        )
        .unwrap();
    assert_ne!(persisted, "completed");
    f.manager
        .db
        .0
        .lock()
        .execute_batch("DROP TRIGGER reject_completion_outbox")
        .unwrap();
    assert_eq!(f.manager.parent_wakeups().unwrap().len(), 1);
}
