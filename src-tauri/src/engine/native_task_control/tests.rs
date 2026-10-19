use super::*;

fn pending_request(control: &Arc<NativeTaskControl>, task_id: &str) -> StopRequest {
    match control.prepare(task_id).unwrap() {
        PreparedStop::Request(request) => request,
        PreparedStop::Ended(_) => panic!("task should still be running"),
    }
}

fn task(id: &str, status: &str) -> NativeTask {
    NativeTask {
        id: id.into(),
        status: status.into(),
        kind: "local_bash".into(),
        description: "Background check".into(),
        tool_use_id: None,
        summary: None,
        progress: None,
        background: Some(true),
        ambient: None,
    }
}

#[tokio::test]
async fn acknowledgement_alone_does_not_claim_the_task_stopped() {
    let control = Arc::new(NativeTaskControl::default());
    control.observe(&[task("selected", "running"), task("other", "running")]);
    let mut request = pending_request(&control, "selected");
    control.response(&request.request_id, None);
    assert!(matches!(
        request.reply.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    control.observe(&[task("selected", "stopped"), task("other", "running")]);
    assert_eq!((&mut request.reply).await.unwrap(), Ok("stopped".into()));
    assert_eq!(control.state.lock().unwrap().tasks["other"], "running");
}

#[tokio::test]
async fn native_rejection_targets_only_its_own_request_and_can_be_retried() {
    let control = Arc::new(NativeTaskControl::default());
    control.observe(&[task("a", "running"), task("b", "paused")]);
    let mut first = pending_request(&control, "a");
    let mut other = pending_request(&control, "b");
    control.response(&first.request_id, Some("unsupported task type"));
    assert_eq!(
        (&mut first.reply).await.unwrap(),
        Err("unsupported task type".into())
    );
    assert!(matches!(
        other.reply.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    assert!(matches!(
        control.prepare("a").unwrap(),
        PreparedStop::Request(_)
    ));
    assert_eq!(control.state.lock().unwrap().tasks["a"], "running");
}

#[tokio::test]
async fn terminal_event_before_ack_is_also_a_confirmed_outcome() {
    let control = Arc::new(NativeTaskControl::default());
    control.observe(&[task("a", "running")]);
    let mut request = pending_request(&control, "a");
    control.observe(&[task("a", "completed")]);
    control.response(&request.request_id, Some("task is no longer running"));
    assert_eq!((&mut request.reply).await.unwrap(), Ok("completed".into()));
    assert!(
        matches!(control.prepare("a").unwrap(), PreparedStop::Ended(result)
        if result.task_id == "a" && result.status == "completed")
    );
}

#[test]
fn missed_terminal_event_can_be_recovered_with_its_exact_status() {
    for status in ["completed", "failed", "stopped"] {
        let control = Arc::new(NativeTaskControl::default());
        control.observe(&[task("finished", status), task("other", "running")]);
        let PreparedStop::Ended(result) = control.prepare("finished").unwrap() else {
            panic!("already terminal task must not send another stop request");
        };
        assert_eq!(
            serde_json::to_value(result).unwrap(),
            json!({"taskId":"finished", "status":status})
        );
        assert!(control.state.lock().unwrap().pending.is_empty());
    }
}

#[test]
fn foreign_and_unknown_tasks_never_create_control_requests() {
    let control = Arc::new(NativeTaskControl::default());
    control.observe(&[task("unknown", "unknown")]);
    assert!(control.prepare("another-run-task").is_err());
    assert!(control.prepare("unknown").is_err());
    assert!(control.state.lock().unwrap().pending.is_empty());
}

#[test]
fn task_id_is_exact_json_data_not_a_protocol_fragment() {
    let control = Arc::new(NativeTaskControl::default());
    let task_id = "id-中文\"\n🧪";
    control.observe(&[task(task_id, "running")]);
    let request = pending_request(&control, task_id);
    let frame: Value = serde_json::from_str(&request.frame).unwrap();
    assert_eq!(request.frame.lines().count(), 1);
    assert_eq!(
        frame["request"],
        json!({"subtype":"stop_task", "task_id":task_id})
    );
    assert_eq!(frame["request_id"], request.request_id);
}

#[tokio::test]
async fn closing_or_losing_the_task_status_is_never_success() {
    for close in [true, false] {
        let control = Arc::new(NativeTaskControl::default());
        control.observe(&[task("a", "running")]);
        let mut request = pending_request(&control, "a");
        if close {
            control.close();
        } else {
            control.observe(&[task("a", "unknown")]);
        }
        assert!((&mut request.reply).await.unwrap().is_err());
        assert!(control.prepare("a").is_err());
    }
}

#[test]
fn abandoned_waiter_is_removed_and_late_response_cannot_affect_retry() {
    let control = Arc::new(NativeTaskControl::default());
    control.observe(&[task("a", "running")]);
    let request = pending_request(&control, "a");
    let old_id = request.request_id.clone();
    drop(request);
    assert!(control.state.lock().unwrap().pending.is_empty());
    let mut retry = pending_request(&control, "a");
    control.response(&old_id, Some("late error"));
    assert!(matches!(
        retry.reply.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
}

#[test]
fn control_responses_are_filtered_and_native_errors_are_preserved() {
    let response = |id: &str, subtype: &str| {
        json!({"response": {
            "request_id":id, "subtype":subtype, "error":"No task with that id",
        }})
    };
    assert!(response_event(&response("ccgui-interrupt-1", "success")).is_none());
    assert!(response_event(&response("foreign", "error")).is_none());
    let id = format!("{STOP_TASK_REQUEST_PREFIX}1");
    assert!(matches!(response_event(&response(&id, "error")),
        Some(EngineEvent::NativeTaskStopResponse { error: Some(error), .. }) if error == "No task with that id"));
    assert!(matches!(
        response_event(&response(&id, "success")),
        Some(EngineEvent::NativeTaskStopResponse { error: None, .. })
    ));
}
