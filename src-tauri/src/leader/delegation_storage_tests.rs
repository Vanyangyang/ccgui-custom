use super::*;

const META: &str = "$ccguiDelegation";

fn raw_branch(f: &Fixture, id: &str) -> Value {
    let raw: String = f
        .manager
        .db
        .0
        .lock()
        .query_row(
            "SELECT record_json FROM leader_branches WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .unwrap();
    serde_json::from_str(&raw).unwrap()
}

fn raw_request(f: &Fixture, id: &str) -> Value {
    let raw: String = f
        .manager
        .db
        .0
        .lock()
        .query_row(
            "SELECT record_json FROM leader_requests WHERE request_id=?1",
            [id],
            |row| row.get(0),
        )
        .unwrap();
    serde_json::from_str(&raw).unwrap()
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

/// V2 decodes Request directly and returns a present response before looking
/// at failed state. Its replay replaces the complete branch object.
fn v2_replay(f: &Fixture, id: &str, branch_id: &str) -> Result<Value, String> {
    let request: Request = serde_json::from_value(raw_request(f, id)).unwrap();
    if let Some(mut response) = request.response {
        let mut branch = branch(f, branch_id);
        branch.delegation = None;
        response["branch"] = tool_branch(&branch, MAX_TOOL_RESPONSE_BYTES - 8192).unwrap();
        return Ok(response);
    }
    if request.state == "failed" {
        return Err(request.error.unwrap());
    }
    Ok(json!({"requestId":id,"requestState":request.state,"mayHaveStarted":true,"replayed":false}))
}

#[test]
fn delegation_storage_keeps_branch_v2_and_places_host_metadata_inside_open_response() {
    let f = basic();
    let (id, run) = spawn(&f, "request");
    observe(&f, &run, "child", "delta", json!("Original result"), 1);
    observe(&f, &run, "child", "done", json!({}), 2);
    let persisted = raw_branch(&f, &id);
    assert!(persisted.get("delegation").is_none());
    let receipt = raw_request(&f, "request");
    assert_eq!(receipt["response"]["branch"][META]["version"], 1);
    assert!(receipt["response"]["branch"].get("delegation").is_none());
    assert_ne!(receipt["response"]["requestState"], "acknowledged");
    assert_eq!(receipt["response"]["mayHaveStarted"], true);
    let recovered = reload(&f);
    assert!(
        recovered.inner.lock().requests[&(key(&f.parent), "request".into())]
            .response
            .is_none()
    );
    assert_eq!(
        recovered.inner.lock().branches[&id]
            .branch
            .delegation
            .as_ref()
            .unwrap()
            .result,
        "Original result"
    );
}

#[test]
fn delegation_storage_failed_no_ack_is_never_a_successful_v2_ack_or_a_relaunch() {
    let f = basic();
    let (id, run) = spawn(&f, "failed");
    f.manager
        .acknowledge(
            &f.parent,
            "failed",
            &run,
            Err("Native launch failed".into()),
        )
        .unwrap_err();
    assert_eq!(
        raw_request(&f, "failed")["response"]["branch"][META]["version"],
        1
    );
    let replay = v2_replay(&f, "failed", &id).unwrap();
    assert_ne!(replay["requestState"], "acknowledged");
    assert_eq!(replay["branch"]["state"], "failed");
    assert_eq!(replay["branch"]["error"], "Native launch failed");
    assert!(replay["branch"].get(META).is_none());
    let recovered = reload(&f);
    assert!(
        recovered.inner.lock().requests[&(key(&f.parent), "failed".into())]
            .response
            .is_none()
    );
    assert!(recovered
        .replay(
            &recovered.inner.lock(),
            &f.parent,
            "failed",
            "task_spawn",
            &encoded(&args("failed")).unwrap()
        )
        .unwrap_err()
        .contains("Native launch failed"));
    assert_eq!(recovered.inner.lock().requests.len(), 1);
}

#[test]
fn delegation_storage_v2_replay_strips_large_private_metadata_before_transport() {
    let f = basic();
    let mut task = args("large");
    task.task = "中".repeat(MAX_INPUT_CHARS);
    let (id, run) = spawn_with_args(&f, &task);
    observe(
        &f,
        &run,
        "child",
        "delta",
        json!("🚀".repeat(MAX_RESULT_CHARS)),
        1,
    );
    f.manager.checkpoint().unwrap();
    assert!(raw_request(&f, "large")["response"]["branch"]
        .get(META)
        .is_some());
    let replay = v2_replay(&f, "large", &id).unwrap();
    assert!(serde_json::to_vec(&replay).unwrap().len() < 1024 * 1024);
    assert!(replay["branch"].get(META).is_none());
}

#[test]
fn delegation_storage_old_reclaim_erases_metadata_without_new_cleanup_hooks() {
    let f = basic();
    let (id, run) = spawn(&f, "request");
    observe(
        &f,
        &run,
        "child",
        "delta",
        json!("Sensitive original result"),
        1,
    );
    observe(&f, &run, "child", "done", json!({}), 2);
    assert!(raw_request(&f, "request")["response"]["branch"]
        .get(META)
        .is_some());
    // Exact V2 ownership cleanup: replace branch content and the entire
    // Request.response; there is no new metadata-specific cleanup call.
    let mut branch = branch(&f, &id);
    branch.state = "reclaimed".into();
    branch.title.clear();
    branch.task.clear();
    branch.result.clear();
    branch.result_truncated = false;
    branch.model = None;
    branch.effort = None;
    branch.error = None;
    branch.cost_approval = None;
    branch.delegation = None;
    let mut request = raw_request(&f, "request");
    request["state"] = json!("reclaimed");
    request["error"] = Value::Null;
    request["response"] = json!({"requestId":"request","requestState":"reclaimed","branch":branch});
    {
        let mut conn = f.manager.db.0.lock();
        let tx = conn.transaction().unwrap();
        tx.execute(
            "UPDATE leader_branches SET state='reclaimed',record_json=?2 WHERE id=?1",
            params![id, serde_json::to_string(&branch).unwrap()],
        )
        .unwrap();
        tx.execute(
            "UPDATE leader_requests SET record_json=?1 WHERE request_id='request'",
            [request.to_string()],
        )
        .unwrap();
        tx.commit().unwrap();
    }
    assert!(!raw_request(&f, "request")
        .to_string()
        .contains("Sensitive original result"));
    assert!(raw_request(&f, "request")["response"]["branch"]
        .get(META)
        .is_none());
    let recovered = reload(&f);
    assert!(recovered.inner.lock().branches[&id]
        .branch
        .delegation
        .is_none());
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

fn complete(f: &Fixture, run: &str, text: &str) {
    observe(f, run, "child", "delta", json!(text), 1);
    observe(f, run, "child", "done", json!({}), 2);
    f.manager.finish(run);
}

fn store_request(f: &Fixture, value: &Value) {
    f.manager.db.0.lock().execute("INSERT INTO leader_requests(parent_engine,parent_session_id,workspace_path,request_id,record_json)
        VALUES(?1,?2,?3,?4,?5) ON CONFLICT(parent_engine,parent_session_id,workspace_path,request_id) DO UPDATE SET record_json=excluded.record_json",
        params![f.parent.engine,f.parent.session_id,f.parent.workspace_path,value["request_id"].as_str().unwrap(),value.to_string()]).unwrap();
}

#[test]
fn delegation_storage_v2_manual_chat_preserves_result_but_new_request_invalidates_latest_selection()
{
    for new_dispatch in [false, true] {
        let f = basic();
        let (id, run) = spawn(&f, "original");
        acknowledge(&f, "original", &run);
        complete(&f, &run, "Original sealed result");
        let mut native = raw_branch(&f, &id);
        native["runId"] = json!("old-host-run");
        native["state"] = json!("completed");
        native["result"] = json!("Later work from the V2 host");
        if new_dispatch {
            native["task"] = json!("A new parent assignment");
            let args = SendArgs {
                branch_id: id.clone(),
                request_id: "v2-next".into(),
                message: "A new parent assignment".into(),
            };
            let mut request = raw_request(&f, "original");
            request["request_id"] = json!("v2-next");
            request["method"] = json!("task_send");
            request["arguments_fingerprint"] =
                json!(arguments_fingerprint(&encoded(&args).unwrap()).unwrap());
            request["state"] = json!("acknowledged");
            request["response"] =
                json!({"requestId":"v2-next","requestState":"acknowledged","branch":native});
            store_request(&f, &request);
        }
        f.manager
            .db
            .0
            .lock()
            .execute(
                "UPDATE leader_branches SET state='completed',record_json=?2 WHERE id=?1",
                params![id, native.to_string()],
            )
            .unwrap();
        let recovered = reload(&f);
        let current = recovered.inner.lock().branches[&id].branch.clone();
        let d = current.delegation.unwrap();
        if new_dispatch {
            assert_eq!(d.state, "unknown");
            assert!(d.result.is_empty());
            assert_ne!(d.request_id, "original");
        } else {
            assert_eq!(d.state, "completed");
            assert_eq!(d.result, "Original sealed result");
        }
        let reply = recovered
            .replay(
                &recovered.inner.lock(),
                &f.parent,
                "original",
                "task_spawn",
                &encoded(&args("original")).unwrap(),
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            reply["branch"]["delegation"]["result"],
            "Original sealed result"
        );
    }
}

#[test]
fn delegation_storage_invalid_metadata_cannot_promote_cached_manual_completion_even_after_rewrite()
{
    for corruption in ["version", "identity", "request", "result-limit", "time"] {
        let f = basic();
        let (id, run) = spawn(&f, "original");
        acknowledge(&f, "original", &run);
        complete(&f, &run, "Original sealed result");
        f.manager
            .prepare(
                "manual-run",
                "codex",
                Some("child"),
                &f.parent.workspace_path,
                None,
            )
            .unwrap();
        complete(
            &f,
            "manual-run",
            "Manual completion must not become the original result",
        );
        hot_send_cache(&f, &id);
        let send = SendArgs {
            branch_id: id.clone(),
            request_id: "next".into(),
            message: "Next assignment".into(),
        };
        f.manager
            .reserve_send(
                &f.caller,
                &f.parent,
                "manual",
                &send,
                encoded(&send).unwrap(),
            )
            .unwrap();
        let mut raw = raw_request(&f, "original");
        assert_eq!(raw["response"]["branch"]["state"], "completed");
        assert_eq!(
            raw["response"]["branch"]["result"],
            "Manual completion must not become the original result"
        );
        let metadata = &mut raw["response"]["branch"][META];
        match corruption {
            "version" => metadata["version"] = json!(999),
            "identity" => metadata["requestIdentity"] = json!("0".repeat(64)),
            "request" => metadata["delegation"]["requestId"] = json!("another"),
            "result-limit" => {
                metadata["delegation"]["result"] = json!("中".repeat(MAX_RESULT_CHARS + 1))
            }
            "time" => metadata["delegation"]["updatedAt"] = json!(-1),
            _ => unreachable!(),
        }
        store_request(&f, &raw);
        let recovered = reload(&f);
        let assert_unknown = |manager: &LeaderManager| {
            let reply = manager
                .replay(
                    &manager.inner.lock(),
                    &f.parent,
                    "original",
                    "task_spawn",
                    &encoded(&args("original")).unwrap(),
                )
                .unwrap()
                .unwrap();
            assert_eq!(
                reply["branch"]["delegation"]["state"], "unknown",
                "{corruption}"
            );
            assert_eq!(reply["branch"]["delegation"]["result"], "", "{corruption}");
        };
        assert_unknown(&recovered);
        // A subsequent ordinary request rewrite must not turn the damaged
        // metadata into a seemingly valid legacy terminal ACK on next load.
        let invalid = recovered.inner.lock().requests[&(key(&f.parent), "original".into())].clone();
        write_request(&recovered.db.0.lock(), &invalid).unwrap();
        assert!(raw_request(&f, "original")["response"]
            .get("branch")
            .is_none());
        assert_unknown(&reload(&f));
    }
}

#[test]
fn delegation_storage_branch_and_receipt_commit_atomically_with_or_without_outer_transaction() {
    let f = basic();
    let (id, run) = spawn(&f, "original");
    acknowledge(&f, "original", &run);
    complete(&f, &run, "Sealed");
    let before_branch = raw_branch(&f, &id);
    let before_request = raw_request(&f, "original");
    f.manager.db.0.lock().execute_batch("CREATE TRIGGER reject_receipt BEFORE UPDATE ON leader_requests BEGIN SELECT RAISE(ABORT,'receipt persistence failure'); END;").unwrap();
    let mut record = f.manager.inner.lock().branches[&id].clone();
    record.branch.title = "Uncommitted new title".into();
    assert!(f
        .manager
        .save(&mut record)
        .unwrap_err()
        .contains("receipt persistence failure"));
    assert_eq!(raw_branch(&f, &id), before_branch);
    assert_eq!(raw_request(&f, "original"), before_request);
    f.manager.db.0.lock().execute_batch("DROP TRIGGER reject_receipt;
        CREATE TRIGGER reject_branch BEFORE UPDATE ON leader_branches BEGIN SELECT RAISE(ABORT,'branch persistence failure'); END;").unwrap();
    hot_send_cache(&f, &id);
    let send = SendArgs {
        branch_id: id.clone(),
        request_id: "not-committed".into(),
        message: "Never started".into(),
    };
    assert!(f
        .manager
        .reserve_send(
            &f.caller,
            &f.parent,
            "manual",
            &send,
            encoded(&send).unwrap()
        )
        .err()
        .unwrap()
        .contains("branch persistence failure"));
    assert_eq!(
        f.manager
            .db
            .0
            .lock()
            .query_row(
                "SELECT COUNT(*) FROM leader_requests WHERE request_id='not-committed'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(raw_branch(&f, &id), before_branch);
    assert_eq!(raw_request(&f, "original"), before_request);
}

#[test]
fn delegation_storage_old_restart_preserves_wrapper_uncertainty_and_known_terminal_result() {
    let f = basic();
    let (id, run) = spawn(&f, "unacked");
    complete(&f, &run, "Finished before ACK");
    // V2 startup updates the Request state but round-trips its open response.
    let mut old: Request = serde_json::from_value(raw_request(&f, "unacked")).unwrap();
    old.state = "unknown".into();
    old.error = Some("Application restarted before launch acknowledgement".into());
    store_request(&f, &encoded(&old).unwrap());
    let response = v2_replay(&f, "unacked", &id).unwrap();
    assert_eq!(response["requestState"], "unknown");
    assert_ne!(response["requestState"], "acknowledged");
    let recovered = reload(&f);
    assert!(
        recovered.inner.lock().requests[&(key(&f.parent), "unacked".into())]
            .response
            .is_none()
    );
    assert_eq!(
        recovered.inner.lock().branches[&id]
            .branch
            .delegation
            .as_ref()
            .unwrap()
            .result,
        "Finished before ACK"
    );
}

#[test]
fn delegation_storage_cold_pending_projection_cannot_outlive_a_v2_terminal_branch() {
    for terminal in ["completed", "failed", "stopped"] {
        let f = basic();
        let (id, run) = spawn(&f, "pending");
        acknowledge(&f, "pending", &run);
        observe(&f, &run, "child", "delta", json!("Known partial"), 1);
        f.manager.checkpoint().unwrap();
        assert_eq!(
            raw_request(&f, "pending")["response"]["branch"][META]["delegation"]["state"],
            "running"
        );
        let mut native = raw_branch(&f, &id);
        native["state"] = json!(terminal);
        native["result"] = json!("Old host may have combined original and later manual turns");
        f.manager
            .db
            .0
            .lock()
            .execute(
                "UPDATE leader_branches SET state=?2,record_json=?3 WHERE id=?1",
                params![id, terminal, native.to_string()],
            )
            .unwrap();
        let recovered = reload(&f);
        let current = recovered.inner.lock().branches[&id].branch.clone();
        assert_eq!(current.state, terminal);
        assert_eq!(current.delegation.as_ref().unwrap().state, "unknown");
        assert_eq!(current.delegation.as_ref().unwrap().result, "Known partial");
        let views = recovered
            .views(&recovered.inner.lock(), &f.parent, None)
            .unwrap();
        assert!(wait_mark(&views[0]).0);
        assert!(!wait_news(&HashMap::new(), &views).1);
    }
}

#[test]
fn delegation_storage_error_preview_is_unicode_bounded_without_mutating_native_error() {
    let f = basic();
    let (id, run) = spawn(&f, "error-preview");
    let original = "中文🚀".repeat(MAX_INPUT_CHARS);
    observe(&f, &run, "child", "error", json!(original), 1);
    f.manager.checkpoint().unwrap();
    assert_eq!(branch(&f, &id).error.as_deref(), Some(original.as_str()));
    let preview = branch(&f, &id).delegation.unwrap().error.unwrap();
    assert_eq!(preview.chars().count(), MAX_INPUT_CHARS);
    assert!(preview.ends_with("\n[truncated]"));
    assert_eq!(raw_branch(&f, &id)["error"], original);
    let recovered = reload(&f);
    assert_eq!(
        recovered.inner.lock().branches[&id]
            .branch
            .delegation
            .as_ref()
            .unwrap()
            .error
            .as_deref(),
        Some(preview.as_str())
    );
}
