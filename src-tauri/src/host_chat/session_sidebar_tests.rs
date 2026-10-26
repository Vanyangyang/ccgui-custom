use super::*;

fn assignment_args() -> Value {
    json!({"requestId":"sidebar-organize-1","assignments":[{
        "engine":"codex","sessionId":"saved-session",
        "expectedWorkspacePath":"C:/source","expectedSidebarWorkspacePath":null,
        "sidebarWorkspacePath":"C:/target"
    }]})
}

#[test]
fn sidebar_tools_reject_unknown_fields_and_require_explicit_compare_state() {
    assert!(validate_arguments("get_session_sidebar_workspaces", json!({})).is_ok());
    assert!(validate_arguments("get_session_sidebar_workspaces", json!({"messages":true})).is_err());
    assert!(validate_arguments("assign_session_sidebar_workspaces", assignment_args()).is_ok());
    for field in ["permission", "sender", "workspacePath"] {
        let mut args = assignment_args();
        args["assignments"][0][field] = json!("forged");
        assert!(validate_arguments("assign_session_sidebar_workspaces", args).is_err());
    }
    let mut args = assignment_args();
    args["assignments"][0].as_object_mut().unwrap().remove("expectedSidebarWorkspacePath");
    assert!(validate_arguments("assign_session_sidebar_workspaces", args).is_err());
    assert!(!requires_saved_session("get_session_sidebar_workspaces"));
    assert!(requires_saved_session("assign_session_sidebar_workspaces"));
    assert!(with_workspace_request("plugin-window", "r", "assign_session_sidebar_workspaces", |_, _| Ok(())).unwrap_err().contains("main window"));
}

#[test]
fn sidebar_tools_need_their_own_capability_even_when_project_organization_exists() {
    use rmcp::ServerHandler;
    for enabled in [false, true] {
        let mut caps = json!({"taskTools":false,"workspaceOrganization":true});
        if enabled { caps["sessionSidebarOrganization"] = json!(true); }
        let server = mcp::server_with_capabilities(
            RelayClient::new("http://127.0.0.1:12345/host-chat", uuid::Uuid::new_v4().to_string()).unwrap(), Ok(caps)
        ).unwrap();
        for name in ["get_session_sidebar_workspaces", "assign_session_sidebar_workspaces"] {
            assert_eq!(server.get_tool(name).is_some(), enabled);
        }
        assert!(server.get_tool("get_workspace_organization").is_some());
    }
}

#[tokio::test]
async fn sidebar_native_gate_uses_admitted_payload_and_expires_after_response() {
    let (relay, mut events, token) = fixture(REQUEST_TIMEOUT);
    relay.set_ready(true).unwrap();
    let args = assignment_args();
    let call = dispatch(&relay, &token, "assign_session_sidebar_workspaces", args.clone());
    let event = request(events.recv().await.unwrap());
    relay.with_workspace_request(&event.request_id, "assign_session_sidebar_workspaces", |scope, admitted| {
        assert!(scope.contains("source-session-id"));
        assert_eq!(*admitted, args);
        Ok(())
    }).unwrap();
    assert!(relay.with_workspace_request(&event.request_id, "get_session_sidebar_workspaces", |_, _| Ok(())).is_err());
    relay.respond(&event.request_id, Some(json!({"assigned":true})), None).unwrap();
    assert!(call.await.unwrap().is_ok());
    assert!(relay.with_workspace_request(&event.request_id, "assign_session_sidebar_workspaces", |_, _| Ok(())).is_err());
}

#[tokio::test]
async fn complete_batch_conflicts_use_the_result_channel_beyond_the_error_budget() {
    let (relay, mut events, token) = fixture(REQUEST_TIMEOUT);
    relay.set_ready(true).unwrap();
    let call = dispatch(&relay, &token, "assign_session_sidebar_workspaces", assignment_args());
    let event = request(events.recv().await.unwrap());
    let conflicts: Vec<_> = (0..100).map(|index| json!({
        "engine":"codex", "sessionId":format!("saved-session-{index}"),
        "code":"SESSION_NOT_FOUND", "message":"Saved session not found"
    })).collect();
    let report = json!({"code":"SESSION_SIDEBAR_ASSIGNMENT_CONFLICT","conflicts":conflicts});
    assert!(report.to_string().len() > MAX_ERROR_BYTES);
    let envelope = crate::session_sidebar_host::assignment_failure(report.to_string()).unwrap();
    relay.respond(&event.request_id, Some(envelope.clone()), None).unwrap();
    assert_eq!(call.await.unwrap().unwrap(), envelope);
    assert_eq!(envelope["assignmentFailure"]["conflicts"].as_array().unwrap().len(), 100);
    assert!(crate::session_sidebar_host::assignment_failure("database unavailable".into()).is_err());
}
