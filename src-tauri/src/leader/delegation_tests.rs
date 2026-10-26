use super::*;

fn delegated(f: &Fixture, id: &str) -> Value {
    encoded(&branch(f, id)).unwrap()["delegation"].clone()
}

fn complete_report(f: &Fixture, run: &str, session: &str) {
    observe(
        f,
        run,
        session,
        "delta",
        json!("Original result 中文 🚀"),
        1,
    );
    observe(f, run, session, "done", json!({}), 2);
}

#[test]
fn delegation_completed_survives_manual_run_and_parent_wait_is_ready() {
    let f = basic();
    let (id, run) = spawn(&f, "delegated");
    complete_report(&f, &run, "child");
    f.manager.finish(&run);
    f.clock.fetch_add(100, Ordering::SeqCst);
    f.manager
        .prepare(
            "manual-run",
            "codex",
            Some("child"),
            &f.parent.workspace_path,
            None,
        )
        .unwrap();
    observe(
        &f,
        "manual-run",
        "child",
        "delta",
        json!("Unrelated new work"),
        1,
    );
    assert_eq!(branch(&f, &id).state, "running");
    assert_eq!(delegated(&f, &id)["state"], "completed");
    assert_eq!(delegated(&f, &id)["result"], "Original result 中文 🚀");
    let views = f
        .manager
        .views(&f.manager.inner.lock(), &f.parent, None)
        .unwrap();
    assert!(wait_mark(&views[0]).0);
    assert_eq!(wait_news(&HashMap::new(), &views), (vec![id], false));
}

#[test]
fn delegation_terminal_does_not_reopen_for_same_process_continuation() {
    let f = basic();
    let mut args = args("delegated");
    args.engine = "claude".into();
    let (id, run) = spawn_with_args(&f, &args);
    let observe = |run: &str, kind: &str, data: Value, seq: u64| {
        let mut value = event(run, Some("child"), kind, data, seq);
        value["engine"] = json!("claude");
        f.manager.observe(&mut value);
    };
    observe(&run, "delta", json!("Original result"), 1);
    observe(&run, "done", json!({}), 2);
    let completed = delegated(&f, &id);
    assert_eq!(completed["state"], "completed");
    observe(
        &format!("{run}-c1"),
        "delta",
        json!("Manual continuation"),
        1,
    );
    assert_eq!(branch(&f, &id).state, "running");
    assert_eq!(delegated(&f, &id), completed);
}

#[test]
fn delegation_waiting_resumes_under_new_run_and_rejects_old_tail() {
    let f = basic();
    let (id, run) = spawn(&f, "delegated");
    observe(
        &f,
        &run,
        "child",
        "question",
        json!({"requestId":"approve"}),
        1,
    );
    observe(&f, &run, "child", "done", json!({}), 2);
    f.manager.finish(&run);
    assert_eq!(delegated(&f, &id)["state"], "waiting");
    f.manager
        .prepare(
            "approved-run",
            "codex",
            Some("child"),
            &f.parent.workspace_path,
            None,
        )
        .unwrap();
    observe(&f, &run, "child", "error", json!("Late old failure"), 3);
    observe(
        &f,
        "approved-run",
        "child",
        "delta",
        json!("Approved result"),
        1,
    );
    assert_eq!(delegated(&f, &id)["runId"], "approved-run");
    assert_eq!(delegated(&f, &id)["state"], "running");
    assert_eq!(delegated(&f, &id)["result"], "Approved result");
    observe(&f, "approved-run", "child", "done", json!({}), 2);
    assert_eq!(delegated(&f, &id)["state"], "completed");
}

#[test]
fn delegation_explicit_task_send_replaces_projection_and_preserves_old_receipt() {
    let f = basic();
    let (id, run) = spawn(&f, "delegated");
    complete_report(&f, &run, "child");
    f.manager.finish(&run);
    hot_send_cache(&f, &id);
    let args = SendArgs {
        branch_id: id.clone(),
        request_id: "next-task".into(),
        message: "New assignment".into(),
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
        panic!("expected a new task");
    };
    assert_eq!(delegated(&f, &id)["requestId"], "next-task");
    assert_eq!(delegated(&f, &id)["runId"], next_run);
    assert_eq!(delegated(&f, &id)["state"], "starting");
    let old_args = super::args("delegated");
    let replay = f
        .manager
        .replay(
            &f.manager.inner.lock(),
            &f.parent,
            "delegated",
            "task_spawn",
            &encoded(&old_args).unwrap(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(replay["branch"]["delegation"]["requestId"], "delegated");
    assert_eq!(replay["branch"]["delegation"]["state"], "completed");
    assert_eq!(
        replay["branch"]["delegation"]["result"],
        "Original result 中文 🚀"
    );
}

fn reload(f: &Fixture) -> LeaderManager {
    let clock = f.clock.clone();
    LeaderManager::with_services(
        f.manager.db.clone(),
        Arc::new(crate::engine::ProcessRegistry::default()),
        f.emitter.clone(),
        Arc::new(move || clock.load(Ordering::SeqCst)),
        Arc::new(|_, _, _| Ok(())),
    )
    .unwrap()
}

fn acknowledge(f: &Fixture, request: &str, run: &str) {
    f.manager
        .acknowledge(
            &f.parent,
            request,
            run,
            Ok(crate::engine::SendResult {
                run_id: run.into(),
                session_id: Some("child".into()),
            }),
        )
        .unwrap();
}

fn legacy_without_delegation(f: &Fixture) {
    f.manager.checkpoint().unwrap();
    let conn = f.manager.db.0.lock();
    conn.execute(
        "UPDATE leader_branches SET record_json=json_remove(record_json,'$.delegation')",
        [],
    )
    .unwrap();
    conn.execute("UPDATE leader_requests SET record_json=json_remove(record_json,'$.response.branch.delegation','$.response.branch.$ccguiDelegation')", []).unwrap();
}

#[test]
fn delegation_completed_persists_while_manual_run_becomes_unknown_on_reload() {
    let f = basic();
    let (id, run) = spawn(&f, "delegated");
    complete_report(&f, &run, "child");
    f.manager.finish(&run);
    let original = delegated(&f, &id);
    f.manager
        .prepare(
            "manual-run",
            "codex",
            Some("child"),
            &f.parent.workspace_path,
            None,
        )
        .unwrap();
    observe(
        &f,
        "manual-run",
        "child",
        "delta",
        json!("Manual result"),
        1,
    );
    f.manager.checkpoint().unwrap();
    let recovered = reload(&f);
    let current = &recovered.inner.lock().branches[&id].branch;
    assert_eq!(current.state, "unknown");
    assert_eq!(encoded(current).unwrap()["delegation"], original);
}

#[test]
fn delegation_legacy_ack_without_terminal_proof_never_borrows_current_result() {
    for manual_new_run in [false, true] {
        let f = basic();
        let (id, run) = spawn(&f, "delegated");
        acknowledge(&f, "delegated", &run);
        complete_report(&f, &run, "child");
        f.manager.finish(&run);
        if manual_new_run {
            f.manager
                .prepare(
                    "manual-run",
                    "codex",
                    Some("child"),
                    &f.parent.workspace_path,
                    None,
                )
                .unwrap();
            observe(
                &f,
                "manual-run",
                "child",
                "delta",
                json!("Manual result must not be inherited"),
                1,
            );
        }
        legacy_without_delegation(&f);
        let recovered = reload(&f);
        let current = encoded(&recovered.inner.lock().branches[&id].branch).unwrap();
        assert_eq!(current["delegation"]["requestId"], "delegated");
        assert_eq!(current["delegation"]["runId"], run);
        assert_eq!(current["delegation"]["state"], "unknown");
        assert_eq!(current["delegation"]["result"], "");
        assert!(current["delegation"]["error"]
            .as_str()
            .unwrap()
            .contains("history"));
    }
}

#[test]
fn delegation_legacy_terminal_ack_is_preserved() {
    let f = basic();
    let (id, run) = spawn(&f, "delegated");
    complete_report(&f, &run, "child");
    acknowledge(&f, "delegated", &run);
    f.manager.finish(&run);
    f.manager
        .prepare(
            "manual-run",
            "codex",
            Some("child"),
            &f.parent.workspace_path,
            None,
        )
        .unwrap();
    observe(
        &f,
        "manual-run",
        "child",
        "delta",
        json!("Manual result"),
        1,
    );
    legacy_without_delegation(&f);
    let recovered = reload(&f);
    let current = encoded(&recovered.inner.lock().branches[&id].branch).unwrap();
    assert_eq!(current["delegation"]["state"], "completed");
    assert_eq!(current["delegation"]["result"], "Original result 中文 🚀");
}

#[test]
fn delegation_mixed_legacy_branch_preserves_only_its_matching_cached_terminal_projection() {
    for correct_request in [true, false] {
        let f = basic();
        let (id, run) = spawn(&f, "delegated");
        complete_report(&f, &run, "child");
        f.manager.finish(&run);
        let original = delegated(&f, &id);
        f.manager
            .prepare(
                "manual-run",
                "codex",
                Some("child"),
                &f.parent.workspace_path,
                None,
            )
            .unwrap();
        observe(
            &f,
            "manual-run",
            "child",
            "delta",
            json!("Manual latest result"),
            1,
        );
        // The original ACK can arrive after a manual continuation: its branch
        // activity is newer, but its nested delegated result remains sealed.
        acknowledge(&f, "delegated", &run);
        {
            let conn = f.manager.db.0.lock();
            conn.execute(
                "UPDATE leader_branches SET record_json=json_remove(record_json,'$.delegation')",
                [],
            )
            .unwrap();
            if !correct_request {
                conn.execute("UPDATE leader_requests SET record_json=json_set(record_json,'$.response.branch.$ccguiDelegation.delegation.requestId','another-request')", []).unwrap();
            }
        }
        let recovered = reload(&f);
        let current = encoded(&recovered.inner.lock().branches[&id].branch).unwrap();
        if correct_request {
            assert_eq!(current["delegation"], original);
        } else {
            assert_eq!(current["delegation"]["requestId"], "delegated");
            assert_eq!(current["delegation"]["state"], "unknown");
            assert_eq!(current["delegation"]["result"], "");
        }
    }
}

#[test]
fn delegation_ambiguous_legacy_order_uses_nonexecuting_unknown_identity() {
    let f = basic();
    let (id, run) = spawn(&f, "delegated");
    acknowledge(&f, "delegated", &run);
    complete_report(&f, &run, "child");
    f.manager.finish(&run);
    hot_send_cache(&f, &id);
    let args = SendArgs {
        branch_id: id.clone(),
        request_id: "second".into(),
        message: "Second task".into(),
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
        panic!();
    };
    acknowledge(&f, "second", &next_run);
    legacy_without_delegation(&f);
    let recovered = reload(&f);
    let current = encoded(&recovered.inner.lock().branches[&id].branch).unwrap();
    assert_eq!(
        current["delegation"]["requestId"],
        format!("legacy-unknown:{id}")
    );
    assert!(current["delegation"]["runId"].is_null());
    assert_eq!(current["delegation"]["state"], "unknown");
    assert_eq!(current["delegation"]["result"], "");
}

#[test]
fn delegation_old_request_replay_adds_unknown_projection_to_nonterminal_legacy_ack() {
    let f = basic();
    let (id, run) = spawn(&f, "delegated");
    acknowledge(&f, "delegated", &run);
    let mut old = f.manager.inner.lock().requests[&(key(&f.parent), "delegated".into())].clone();
    old.response.as_mut().unwrap()["branch"]
        .as_object_mut()
        .unwrap()
        .remove("delegation");
    complete_report(&f, &run, "child");
    f.manager.finish(&run);
    hot_send_cache(&f, &id);
    let args = SendArgs {
        branch_id: id.clone(),
        request_id: "second".into(),
        message: "Second task".into(),
    };
    f.manager
        .reserve_send(
            &f.caller,
            &f.parent,
            "manual",
            &args,
            encoded(&args).unwrap(),
        )
        .unwrap();
    let response = delegation::response_branch(&old, &branch(&f, &id)).unwrap();
    assert_eq!(response["delegation"]["requestId"], "delegated");
    assert_eq!(response["delegation"]["state"], "unknown");
    assert_eq!(response["delegation"]["result"], "");
    old.response.as_mut().unwrap()["branch"]["delegation"] = delegated(&f, &id);
    let response = delegation::response_branch(&old, &branch(&f, &id)).unwrap();
    assert_eq!(response["delegation"]["requestId"], "delegated");
    assert_eq!(response["delegation"]["state"], "unknown");
}

#[test]
fn delegation_cost_approval_preserves_identity_time_and_cancel_is_terminal() {
    let f = basic();
    let (id, run) = spawn(&f, "delegated");
    settle(&f, &id, &run, "child");
    {
        let mut inner = f.manager.inner.lock();
        let record = inner.branches.get_mut(&id).unwrap();
        record.branch.model = Some("test-model".into());
        f.manager.save(record).unwrap();
    }
    held_send(&f, &id, "held");
    let held = delegated(&f, &id);
    assert_eq!(held["state"], "awaiting_cost_approval");
    assert_eq!(held["costApproval"]["requestId"], "held");
    assert!(held["createdAt"].as_i64().unwrap() > 1_000_000);
    f.clock.fetch_add(100, Ordering::SeqCst);
    let (_, next_run, _) = f
        .manager
        .resolve_cost_approval(&f.parent, &id, "held", true, Some("test-model"))
        .unwrap()
        .unwrap();
    assert_eq!(delegated(&f, &id)["createdAt"], held["createdAt"]);
    assert_eq!(delegated(&f, &id)["runId"], next_run);
    assert!(delegated(&f, &id)["costApproval"].is_null());
    settle(&f, &id, &next_run, "child");
    held_send(&f, &id, "cancelled");
    f.manager
        .resolve_cost_approval(&f.parent, &id, "cancelled", false, None)
        .unwrap();
    assert_eq!(delegated(&f, &id)["state"], "stopped");
    assert!(delegated(&f, &id)["costApproval"].is_null());
    f.manager
        .prepare(
            "manual-run",
            "codex",
            Some("child"),
            &f.parent.workspace_path,
            None,
        )
        .unwrap();
    assert_eq!(delegated(&f, &id)["state"], "stopped");
}

#[test]
fn delegation_registry_kill_and_native_reply_interrupt_are_terminal_without_revival() {
    for reply_only in [false, true] {
        let f = basic();
        let (id, run) = spawn(&f, "delegated");
        observe(&f, &run, "child", "delta", json!("Partial result"), 1);
        if reply_only {
            observe(
                &f,
                &run,
                "child",
                "turn_complete",
                json!({"interrupted":true}),
                2,
            );
            assert_eq!(branch(&f, &id).state, "running");
        } else {
            let entry = reservation(&run);
            entry.killed.store(true, Ordering::SeqCst);
            f.manager.processes.insert(run.clone(), entry);
            observe(&f, &run, "child", "done", json!({}), 2);
            assert_eq!(branch(&f, &id).state, "stopped");
            f.manager.processes.remove_reservation(&run);
        }
        assert_eq!(delegated(&f, &id)["state"], "stopped");
        assert_eq!(delegated(&f, &id)["result"], "Partial result");
        f.manager.finish(&run);
        f.manager
            .prepare(
                "manual-run",
                "codex",
                Some("child"),
                &f.parent.workspace_path,
                None,
            )
            .unwrap();
        observe(
            &f,
            "manual-run",
            "child",
            "delta",
            json!("Manual new work"),
            1,
        );
        assert_eq!(branch(&f, &id).state, "running");
        assert_eq!(delegated(&f, &id)["state"], "stopped");
    }
}

#[tokio::test]
async fn delegation_task_stop_and_reclaim_seal_then_erase_the_projection() {
    let f = basic();
    let (id, run) = spawn(&f, "delegated");
    observe(&f, &run, "child", "delta", json!("Partial result"), 1);
    // Retirement has occurred without a final native result; explicit Stop
    // must still publish a stopped delegation rather than leave it running.
    f.manager
        .inner
        .lock()
        .runs
        .get_mut(&run)
        .unwrap()
        .launch_pending = false;
    f.manager.stop(&f.parent, &id).await.unwrap();
    assert_eq!(delegated(&f, &id)["state"], "stopped");
    f.manager.reclaim(&f.parent, &id).await.unwrap();
    assert!(branch(&f, &id).delegation.is_none());
    let request = &f.manager.inner.lock().requests[&(key(&f.parent), "delegated".into())];
    assert!(request.response.as_ref().unwrap()["branch"]["delegation"].is_null());
}

#[test]
fn delegation_nested_tool_results_are_bounded_without_losing_identity() {
    let f = basic();
    let (id, run) = spawn(&f, "delegated");
    observe(
        &f,
        &run,
        "child",
        "delta",
        json!("中文🚀".repeat(MAX_RESULT_CHARS)),
        1,
    );
    let value = tool_branch(&branch(&f, &id), 4096).unwrap();
    assert!(serde_json::to_vec(&value).unwrap().len() <= 4096);
    assert_eq!(value["delegation"]["requestId"], "delegated");
    assert_eq!(value["delegation"]["runId"], run);
    assert_eq!(value["delegation"]["resultTruncated"], true);
}

#[test]
fn delegation_monotonic_time_survives_clock_rollback_and_legacy_prefix_is_not_reserved() {
    let f = basic();
    let (id, run) = spawn(&f, "legacy-unknown:user-selected-id");
    complete_report(&f, &run, "child");
    f.manager.finish(&run);
    f.clock.store(999_000, Ordering::SeqCst);
    hot_send_cache(&f, &id);
    let args = SendArgs {
        branch_id: id.clone(),
        request_id: "next".into(),
        message: "Next".into(),
    };
    f.manager
        .reserve_send(
            &f.caller,
            &f.parent,
            "manual",
            &args,
            encoded(&args).unwrap(),
        )
        .unwrap();
    let current = branch(&f, &id);
    assert!(current.delegation.as_ref().unwrap().created_at > 1_000_000);
    delegation::validate_worker(&current).unwrap();
    let recovered = reload(&f);
    let cold = &recovered.inner.lock().branches[&id].branch;
    assert_eq!(cold.delegation.as_ref().unwrap().state, "unknown");
    assert!(
        cold.delegation.as_ref().unwrap().updated_at
            >= cold.delegation.as_ref().unwrap().created_at
    );
    // The request prefix is ordinary user data, not an execution capability.
    let mut ordinary = current;
    ordinary.delegation.as_mut().unwrap().request_id = "legacy-unknown:ordinary-active-task".into();
    delegation::validate_worker(&ordinary).unwrap();
}
