use super::*;
use serde_json::json;
use tokio::sync::mpsc;

fn message_id() -> String { format!("cross:{}", "a".repeat(64)) }
fn send() -> Value { json!({"session_id":"target-session","message":"hello","request_id":"send-1"}) }
fn ack() -> Value { json!({"message_id":message_id(),"read_request_id":"read-1","outcome":"handled"}) }

#[test]
fn associated_arguments_preserve_legacy_and_reject_invalid_combinations() {
    assert_eq!(validate_arguments("send_message", send()).unwrap(), send());
    for field in ["update_of", "reply_to"] {
        let mut args = send(); args[field] = json!("original-1");
        assert_eq!(validate_arguments("send_message", args.clone()).unwrap()["message_kind"], "information");
        for kind in ["information", "constraint", "correction"] {
            args["message_kind"] = json!(kind);
            assert_eq!(validate_arguments("send_message", args.clone()).unwrap(), args);
        }
        args[field] = json!("bad id");
        assert!(validate_arguments("send_message", args).is_err());
    }
    for extension in [json!({"update_of":"a","reply_to":"b"}), json!({"message_kind":"information"}), json!({"update_of":"a","message_kind":"urgent"})] {
        let mut args = send(); args.as_object_mut().unwrap().extend(extension.as_object().unwrap().clone());
        assert!(validate_arguments("send_message", args).is_err());
    }
}

#[test]
fn inbox_arguments_are_bounded_and_cannot_override_identity() {
    for schema in [schemars::schema_for!(ReadMessagesArgs), schemars::schema_for!(AcknowledgeMessageArgs)] {
        let value = serde_json::to_value(schema).unwrap();
        assert_eq!(value["additionalProperties"], false);
        for field in ["sender", "session_id", "engine", "workspace_path", "run_id"] {
            assert!(value["properties"].get(field).is_none());
        }
    }
    assert_eq!(validate_arguments("read_messages", json!({"request_id":"r"})).unwrap()["limit"], 4);
    for args in [json!({"request_id":"r","limit":0}), json!({"request_id":"r","limit":9}), json!({"request_id":"r","limit":1.5}), json!({"request_id":"r","message_ids":[]}), json!({"request_id":"r","message_ids":[message_id(),message_id()]}), json!({"request_id":"bad id"})] {
        assert!(validate_arguments("read_messages", args).is_err());
    }
    for id in [format!("cross:{}", "A".repeat(64)), "cross:abc".into(), format!("other:{}", "a".repeat(64))] {
        assert!(validate_arguments("read_messages", json!({"request_id":"r","message_ids":[id]})).is_err());
        let mut a = ack(); a["message_id"] = json!(id);
        assert!(validate_arguments("acknowledge_message", a).is_err());
    }
    for (method, args) in [("send_message",send()), ("read_messages",json!({"request_id":"r"})), ("acknowledge_message",ack()), ("get_inbox_status",json!({}))] {
        for field in ["sender", "run_id", "source_session_id", "permission"] {
            let mut forged = args.clone(); forged[field] = json!("forged");
            assert!(validate_arguments(method, forged).is_err());
        }
        if method != "send_message" {
            for field in ["session_id", "engine", "workspace_path"] {
                let mut forged = args.clone(); forged[field] = json!("forged");
                assert!(validate_arguments(method, forged).is_err());
            }
        }
    }
    for (field, value) in [("response",json!("😀".repeat(65537))), ("impact_review",json!(" ")), ("impact_review",json!("a".repeat(8001))), ("outcome",json!("verified"))] {
        let mut a = ack(); a[field] = value; assert!(validate_arguments("acknowledge_message", a).is_err());
    }
    let mut a = ack(); a["response"] = json!("😀".repeat(65536));
    assert!(validate_arguments("acknowledge_message", a).is_ok());
    assert!(validate_arguments("get_inbox_status", json!(null)).is_err());
    let names: Vec<_> = mcp::HostChatServer::tool_router().list_all().into_iter().map(|t| t.name.to_string()).collect();
    assert!(names.contains(&"read_messages".into()));
    assert!(names.contains(&"acknowledge_message".into()));
    assert!(!names.contains(&"get_inbox_status".into()));
}

#[test]
fn associated_messages_still_pass_the_parent_report_guard() {
    for field in ["update_of", "reply_to"] {
        let mut arguments = send(); arguments[field] = json!("original");
        arguments["message_kind"] = json!("correction");
        let request = RequestEvent { request_id: uuid::Uuid::new_v4().to_string(),
            sender: Sender { run_id:"caller".into(),engine:"agy".into(),session_id:Some("saved".into()),workspace_path:"workspace".into() },
            method:"send_message".into(), arguments:validate_arguments("send_message",arguments).unwrap() };
        let error = forward_saved_chat_message(&request, |sender,args| {
            assert_eq!(sender.session_id,"saved");
            assert!(args.intent.is_none());
            Err("report guard refused".into())
        }, || panic!("must not forward rejected associated message")).unwrap_err();
        assert_eq!(error,"report guard refused");
    }
}

fn fixture() -> (Arc<Relay>, mpsc::UnboundedReceiver<RelayEvent>, String) {
    let (tx, rx) = mpsc::unbounded_channel();
    let relay = Arc::new(Relay::new(1, Duration::from_secs(30), Box::new(move |e| tx.send(e).map_err(|_| "closed".into()))));
    let token = relay.register("caller-run", "agy", Some("caller-session"), "caller-workspace").unwrap();
    relay.set_ready(true).unwrap();
    (relay, rx, token)
}

async fn next(rx: &mut mpsc::UnboundedReceiver<RelayEvent>) -> RequestEvent {
    match rx.recv().await.unwrap() { RelayEvent::Request(r) => r, _ => panic!("expected request") }
}

#[tokio::test]
async fn inbox_admission_rejects_unsaved_and_sidechat_and_keeps_stable_receipts() {
    let (relay, mut rx, token) = fixture();
    let unsaved = relay.register("unsaved", "agy", None, "caller-workspace").unwrap();
    let side = relay.register("sidechat-restricted", "claude", Some("side-session"), "caller-workspace").unwrap();
    for (method, args) in [("read_messages",json!({"request_id":"r"})), ("acknowledge_message",ack()), ("get_inbox_status",json!({}))] {
        assert_eq!(relay.dispatch(&unsaved, method.into(), args.clone()).await.unwrap_err().status, StatusCode::CONFLICT);
        assert_eq!(relay.dispatch(&side, method.into(), args.clone()).await.unwrap_err().status, StatusCode::FORBIDDEN);
        assert!(rx.try_recv().is_err());
        let id = uuid::Uuid::new_v4().to_string();
        let task = { let relay=relay.clone(); let token=token.clone(); let id=id.clone(); let args=args.clone(); tokio::spawn(async move { relay.dispatch_stable(&token,id,method.into(),args).await }) };
        let request = next(&mut rx).await;
        assert_eq!(request.sender.run_id,"caller-run");
        assert_eq!(request.sender.session_id.as_deref(),Some("caller-session"));
        relay.respond(&request.request_id,Some(json!({"ok":true})),None).unwrap();
        assert_eq!(task.await.unwrap().unwrap(),json!({"ok":true}));
        assert_eq!(relay.dispatch_stable(&token,id,method.into(),args).await.unwrap(),json!({"ok":true}));
        assert!(rx.try_recv().is_err());
    }
}

#[tokio::test]
async fn task_wait_inbox_is_caller_scoped_and_failures_preserve_original_result() {
    let (relay, mut rx, token) = fixture();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://127.0.0.1:{}/host-chat",listener.local_addr().unwrap().port());
    let server = { let relay=relay.clone(); tokio::spawn(async move { axum::serve(listener,router(relay)).await.unwrap(); }) };
    let client = RelayClient::new(&url,token).unwrap();
    for mode in ["success","timeout","unavailable","oversized","original_error"] {
        let call = { let client=client.clone(); tokio::spawn(async move { client.call_with_inbox("task_wait",json!({})).await }) };
        let request = next(&mut rx).await;
        let original = json!({"branches":[{"sessionId":"other-target"}],"timedOut":false});
        if mode == "original_error" {
            relay.respond(&request.request_id,None,Some("original task failure".into())).unwrap();
            assert!(call.await.unwrap().unwrap_err().contains("original task failure"));
            assert!(rx.try_recv().is_err());
            continue;
        }
        relay.respond(&request.request_id,Some(original.clone()),None).unwrap();
        let status = next(&mut rx).await;
        assert_eq!(status.method,"get_inbox_status");
        assert_eq!(status.arguments,json!({}));
        assert_eq!(status.sender.run_id,request.sender.run_id);
        assert_eq!(status.sender.session_id.as_deref(),Some("caller-session"));
        assert_eq!(status.sender.engine,"agy");
        assert_eq!(status.sender.workspace_path,"caller-workspace");
        match mode {
            "success" => relay.respond(&status.request_id,Some(json!({"unreadCount":1})),None).unwrap(),
            "unavailable" => relay.set_ready(false).unwrap(),
            "oversized" => { let summary=json!({"guidance":"x".repeat(MAX_RESPONSE_BYTES-20)}); relay.respond(&status.request_id,Some(summary),None).unwrap(); },
            _ => {},
        }
        let result = tokio::time::timeout(Duration::from_millis(1100),call).await.expect("summary must be bounded").unwrap().unwrap();
        if mode == "success" { assert_eq!(result["inbox"]["unreadCount"],1); assert_eq!(result["branches"],original["branches"]); }
        else { assert_eq!(result,original); }
        relay.set_ready(true).unwrap();
    }
    server.abort();
}
