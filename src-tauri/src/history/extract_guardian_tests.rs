use super::*;
use serde_json::json;

fn event(status: &str, action: Value) -> Value {
    json!({"timestamp":"2026-10-08T01:02:03Z","type":"event_msg","payload":{
        "type":"guardian_assessment","id":"review-1","turn_id":"turn-1",
        "target_item_id":"item-1","started_at_ms":1000,"completed_at_ms":2000,
        "status":status,"risk_level":"low","user_authorization":"high",
        "rationale":"Fixture assessment.","action":action
    }})
}

fn command() -> Value {
    json!({"type":"command","source":"unified_exec","command":"echo fixture","cwd":"C:\\fixture"})
}

fn parse(events: &[Value]) -> ParsedSession {
    let text = events
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    collect_session(
        std::io::Cursor::new(text),
        &extractor_for("codex", ImageMode::Collect, None),
    )
    .unwrap()
}

#[test]
fn terminal_assessments_preserve_status_metadata_and_timestamp() {
    for (native, app) in [
        ("approved", "approved"),
        ("denied", "denied"),
        ("timed_out", "timedOut"),
        ("aborted", "aborted"),
    ] {
        let parsed = parse(&[event(native, command())]);
        assert_eq!(parsed.messages.len(), 1);
        let row = &parsed.messages[0];
        assert_eq!(row.role, "auto_review");
        assert_eq!(row.text, "");
        assert_eq!(row.ts.as_deref(), Some("2026-10-08T01:02:03Z"));
        assert_eq!(row.seq, 1);
        let args = row.args.as_ref().unwrap();
        assert_eq!(args["review"]["status"], app);
        assert_eq!(args["review"]["riskLevel"], "low");
        assert_eq!(args["review"]["userAuthorization"], "high");
        assert_eq!(args["reviewId"], "review-1");
        assert_eq!(args["turnId"], "turn-1");
        assert_eq!(args["targetItemId"], "item-1");
        assert_eq!(args["startedAtMs"], 1000);
        assert_eq!(args["completedAtMs"], 2000);
        assert_eq!(args["action"]["source"], "unifiedExec");
    }
}

#[test]
fn start_and_completion_produce_one_row_even_without_target_item() {
    let start = event("in_progress", command());
    let mut completed = event("denied", command());
    completed["payload"]
        .as_object_mut()
        .unwrap()
        .remove("target_item_id");
    let parsed = parse(&[start.clone(), completed.clone()]);
    assert_eq!(parsed.messages.len(), 1);
    assert!(parsed.messages[0].args.as_ref().unwrap()["targetItemId"].is_null());
    assert!(parse(&[start]).messages.is_empty());
    let mut acc = ScanAcc::default();
    for row in extract_codex_line(&completed, ImageMode::SkipDataUrls) {
        acc.accept(row);
    }
    assert_eq!(acc.finish().message_count, 1);
}

#[test]
fn action_variants_map_native_fields_and_enums_to_app_server_shape() {
    let cases = [
        (
            json!({"type":"execve","source":"shell","program":"echo","argv":["fixture"],"cwd":"C:\\fixture"}),
            json!({"type":"execve","source":"shell","program":"echo","argv":["fixture"],"cwd":"C:\\fixture"}),
        ),
        (
            json!({"type":"write_stdin","approval_id":"a","process_id":"p","stdin":"x","cwd":"C:\\fixture"}),
            json!({"type":"writeStdin","approvalId":"a","processId":"p","stdin":"x","cwd":"C:\\fixture"}),
        ),
        (
            json!({"type":"apply_patch","cwd":"C:\\fixture","files":["a.rs"]}),
            json!({"type":"applyPatch","cwd":"C:\\fixture","files":["a.rs"]}),
        ),
        (
            json!({"type":"network_access","target":"example.test:443","host":"example.test","protocol":"socks5_tcp","port":443}),
            json!({"type":"networkAccess","target":"example.test:443","host":"example.test","protocol":"socks5Tcp","port":443}),
        ),
        (
            json!({"type":"mcp_tool_call","server":"fixture","tool_name":"read","connector_id":"c","connector_name":null,"tool_title":"Read"}),
            json!({"type":"mcpToolCall","server":"fixture","toolName":"read","connectorId":"c","connectorName":null,"toolTitle":"Read"}),
        ),
        (
            json!({"type":"request_permissions","reason":null,"permissions":{"network":{"enabled":true},"file_system":{"read":["C:\\fixture"],"write":null,"glob_scan_max_depth":2}}}),
            json!({"type":"requestPermissions","reason":null,"permissions":{"network":{"enabled":true},"fileSystem":{"read":["C:\\fixture"],"write":null,"globScanMaxDepth":2}}}),
        ),
    ];
    for (native, expected) in cases {
        let parsed = parse(&[event("approved", native)]);
        assert_eq!(parsed.messages.len(), 1);
        assert_eq!(
            parsed.messages[0].args.as_ref().unwrap()["action"],
            expected
        );
    }
}

#[test]
fn malformed_or_unknown_events_never_become_approved_rows() {
    for (field, value) in [
        ("status", json!("unknown")),
        ("status", Value::Null),
        ("id", json!(42)),
        ("id", json!("")),
        ("turn_id", json!(false)),
        ("started_at_ms", json!("1000")),
        ("completed_at_ms", json!(false)),
        ("target_item_id", json!(42)),
        ("risk_level", json!("future")),
        ("user_authorization", json!(true)),
        ("rationale", json!({})),
        ("action", json!({"type":"future"})),
        (
            "action",
            json!({"type":"command","source":"shell","cwd":"C:\\fixture"}),
        ),
        (
            "action",
            json!({"type":"request_permissions","permissions":{"network":{"enabled":"yes"}}}),
        ),
    ] {
        let mut value_event = event("approved", command());
        value_event["payload"][field] = value;
        assert!(
            parse(&[value_event]).messages.is_empty(),
            "accepted malformed {field}"
        );
    }
}

#[test]
fn legacy_optional_fields_keep_protocol_defaults_without_inventing_assessment() {
    let mut value = event("aborted", command());
    let payload = value["payload"].as_object_mut().unwrap();
    for key in [
        "turn_id",
        "started_at_ms",
        "completed_at_ms",
        "risk_level",
        "user_authorization",
        "rationale",
    ] {
        payload.remove(key);
    }
    let parsed = parse(&[value]);
    let args = parsed.messages[0].args.as_ref().unwrap();
    assert_eq!(args["turnId"], "");
    assert_eq!(args["startedAtMs"], 0);
    assert!(args.get("completedAtMs").is_none());
    assert_eq!(
        args["review"],
        json!({"status":"aborted","riskLevel":null,"userAuthorization":null,"rationale":null})
    );
}
