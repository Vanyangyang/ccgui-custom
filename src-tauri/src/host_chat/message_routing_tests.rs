use super::*;

#[test]
fn parent_message_intent_is_explicit_and_strict() {
    let mut args = send_args("intent-test");
    let legacy = validate_arguments("send_message", args.clone()).unwrap();
    assert!(legacy.get("intent").is_none());
    args["intent"] = json!("question");
    assert_eq!(validate_arguments("send_message", args.clone()).unwrap()["intent"], "question");
    for invalid in [json!("report"), json!("completion"), json!(true), json!({"question":true})] {
        args["intent"] = invalid;
        assert!(validate_arguments("send_message", args.clone()).is_err());
    }
    let tools = mcp::HostChatServer::tool_router().list_all();
    let send = tools.iter().find(|tool| tool.name == "send_message").unwrap();
    let schema = serde_json::to_string(&send.input_schema).unwrap();
    assert!(schema.contains("intent"));
    assert!(schema.contains("question"));
    assert!(send.description.as_ref().unwrap().contains("normal assistant output"));
}

#[tokio::test]
async fn parent_message_rejection_never_reaches_the_frontend_queue() {
    let (relay, mut events, token) = fixture(REQUEST_TIMEOUT);
    relay.set_ready(true).unwrap();
    let call = dispatch(&relay, &token, "send_message", send_args("report"));
    let event = request(events.recv().await.unwrap());
    let mut forwarded = false;
    let error = forward_saved_chat_message(&event, |sender, args| {
        assert_eq!(sender.session_id, "source-session-id");
        assert_eq!(sender.engine, "claude");
        assert!(args.intent.is_none());
        Err("TASK_REPORT_REQUIRES_TASK_CHANNEL".into())
    }, || { forwarded = true; Ok(()) }).unwrap_err();
    assert!(!forwarded);
    relay.respond(&event.request_id, None, Some(error)).unwrap();
    assert!(call.await.unwrap().unwrap_err().message.contains("TASK_REPORT_REQUIRES_TASK_CHANNEL"));
    assert!(events.try_recv().is_err());
}

#[tokio::test]
async fn parent_message_question_preserves_the_original_frontend_request() {
    let (relay, mut events, token) = fixture(REQUEST_TIMEOUT);
    relay.set_ready(true).unwrap();
    let mut args = send_args("question");
    args["intent"] = json!("question");
    let call = dispatch(&relay, &token, "send_message", args);
    let event = request(events.recv().await.unwrap());
    let mut forwarded = 0;
    forward_saved_chat_message(&event, |_, args| {
        assert_eq!(args.intent, Some(MessageIntent::Question));
        Ok(())
    }, || relay.forward_live_message(&event, || { forwarded += 1; Ok(()) })).unwrap();
    assert_eq!(forwarded, 1);
    // Admission must not synthesize success: the normal frontend's queue/cost
    // approval result remains the actual tool result.
    assert!(!call.is_finished());
    relay.respond(&event.request_id, Some(json!({"status":"awaiting_cost_approval"})), None).unwrap();
    assert_eq!(call.await.unwrap().unwrap()["status"], "awaiting_cost_approval");
}

#[tokio::test]
async fn parent_message_delayed_forward_is_fenced_by_live_admission() {
    for revoke in ["epoch", "deadline", "token", "ready", "shutdown", "method", "arguments"] {
        let (relay, mut events, token) = fixture(REQUEST_TIMEOUT);
        relay.set_ready(true).unwrap();
        let call = dispatch(&relay, &token, "send_message", send_args("fenced"));
        let event = request(events.recv().await.unwrap());
        {
            let mut inner = relay.inner.lock();
            match revoke {
                "epoch" => inner.epoch += 1,
                "deadline" => inner.pending.get_mut(&event.request_id).unwrap().deadline = Instant::now() - Duration::from_secs(1),
                "token" => { inner.tokens.remove(&token); },
                "ready" => inner.ready = false,
                "shutdown" => inner.shutdown = true,
                "method" => inner.pending.get_mut(&event.request_id).unwrap().method = "list_chats".into(),
                "arguments" => inner.pending.get_mut(&event.request_id).unwrap().arguments["message"] = json!("changed"),
                _ => unreachable!(),
            }
        }
        let mut forwarded = false;
        assert!(relay.forward_live_message(&event, || { forwarded = true; Ok(()) }).is_err(), "{revoke}");
        assert!(!forwarded, "{revoke}");
        call.abort();
        let _ = call.await;
    }
}
