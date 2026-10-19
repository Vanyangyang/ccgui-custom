use super::*;
use crate::engine::codex::CodexEngine;
use crate::engine::{Engine, SendRequest};

fn request(permission: Option<&str>) -> SendRequest {
    SendRequest {
        claude_ultracode: None,
        host_instructions: None,
        session_id: None,
        workspace: "G:/project".into(),
        prompt: "bounded task".into(),
        images: Vec::new(),
        model: None,
        effort: None,
        service_tier: None,
        permission: permission.map(str::to_string),
        additional_dirs: Vec::new(),
        provider_id: None,
        computer_use: None,
        allowed_tools: None,
    }
}

fn args(command: &Command) -> Vec<String> {
    command
        .as_std()
        .get_args()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect()
}

#[test]
fn auto_launches_pin_official_reviewer_and_keep_other_modes_separate() {
    for permission in [None, Some("auto")] {
        let req = request(permission);
        let built = CodexEngine.host_command(&req, "codex").unwrap();
        let args = args(&built.command);
        for setting in [
            "guardian_approval",
            "approval_policy=\"on-request\"",
            "approvals_reviewer=\"auto_review\"",
            "sandbox_mode=\"workspace-write\"",
        ] {
            assert!(args.iter().any(|arg| arg == setting), "{args:?}");
        }
        assert!(!args
            .iter()
            .any(|arg| arg.contains("danger-full-access") || arg.contains("bypass")));
    }
    for permission in [
        "manual",
        "bypass",
        "plan",
        super::super::codex_read_only::PERMISSION,
    ] {
        assert!(!enabled(Some(permission)));
    }
}

#[test]
fn exec_resume_places_approve_for_me_before_the_resume_subcommand() {
    for resume in [false, true] {
        let mut req = request(Some("auto"));
        if resume {
            req.session_id = Some("thread".into());
        }
        let built = CodexEngine.build_command(&req, "codex").unwrap();
        let args = args(&built.command);
        let exec = args.iter().position(|arg| arg == "exec").unwrap();
        let approve = args
            .iter()
            .position(|arg| arg == "--approve-for-me")
            .unwrap();
        assert!(exec < approve);
        assert!(args.iter().any(|arg| arg == "guardian_approval"));
        if resume {
            assert!(approve < args.iter().position(|arg| arg == "resume").unwrap());
        }
    }
}

#[test]
fn thread_overrides_reject_missing_reviewer_and_wrong_actual_sandbox() {
    let mut params = json!({"cwd":"G:/work"});
    configure_thread(&mut params);
    assert_eq!(params["permissions"], ":workspace");
    assert!(params.get("sandbox").is_none());
    let good = json!({"approvalPolicy":"on-request","approvalsReviewer":"auto_review","sandbox":{"type":"workspaceWrite"}});
    validate_thread(&good).unwrap();
    for (field, value) in [
        ("approvalPolicy", json!("never")),
        ("approvalsReviewer", json!("user")),
        ("sandbox", json!({"type":"dangerFullAccess"})),
        ("sandbox", json!({"type":"readOnly"})),
    ] {
        let mut bad = good.clone();
        bad[field] = value;
        assert!(validate_thread(&bad).unwrap_err().starts_with(UNAVAILABLE));
    }
    assert!(validate_thread(&json!({"thread":{"id":"legacy"}})).is_err());
    assert_eq!(
        feature_enabled(&json!({"data":[{"name":"guardian_approval","enabled":false}]})),
        Some(false)
    );
    assert_eq!(
        feature_enabled(&json!({"data":[{"name":"guardian_approval","enabled":true}]})),
        Some(true)
    );
    assert_eq!(feature_enabled(&json!({"data":[]})), None);
}

fn review(id: &str, status: &str) -> Value {
    json!({"reviewId":id,"threadId":"thread","turnId":"turn","targetItemId":null,"startedAtMs":1,
        "review":{"status":status,"riskLevel":null,"userAuthorization":null,"rationale":null},
        "action":{"type":"networkAccess","target":"host","host":"example.test","protocol":"https","port":443}})
}

#[test]
fn review_lifecycle_is_monotonic_independent_and_cancelled_honestly() {
    let mut tracker = Reviews::default();
    assert!(tracker.observe(&review("r1", "approved")).is_some());
    assert!(tracker.observe(&review("r1", "inProgress")).is_none());
    assert!(tracker.observe(&review("r1", "denied")).is_none());
    assert!(tracker.observe(&review("r2", "inProgress")).is_some());
    assert!(tracker.observe(&review("r2", "inProgress")).is_none());
    assert!(tracker.observe(&review("r3", "timedOut")).is_some());
    assert!(tracker.observe(&review("r4", "invented")).is_none());
    let aborted = tracker.abort_pending();
    assert_eq!(aborted.len(), 1);
    assert_eq!(aborted[0]["reviewId"], "r2");
    assert_eq!(aborted[0]["review"]["status"], "aborted");
    assert!(tracker.abort_pending().is_empty());
}

fn approval_context(method: &str, params: Value, changes: Option<&Value>) -> Value {
    let card = approval_card(method, &params, changes).unwrap();
    json!({"rpcId":42,"method":method,"params":params,"card":card})
}

#[test]
fn human_command_decisions_do_not_grant_session_or_rule_amendments() {
    let method = "item/commandExecution/requestApproval";
    let context = approval_context(
        method,
        json!({"command":"echo ok","availableDecisions":["accept","decline",{"acceptWithExecpolicyAmendment":{"execpolicyAmendment":["echo"]}}]}),
        None,
    );
    assert_eq!(
        answer_result(&context, Some(&json!({"decision":"allow_once"}))).unwrap(),
        json!({"decision":"accept"})
    );
    assert_eq!(
        answer_result(&context, Some(&json!({"decision":"decline"}))).unwrap(),
        json!({"decision":"decline"})
    );
    assert_eq!(
        answer_result(&context, None).unwrap(),
        json!({"decision":"decline"})
    );
    for invalid in [
        json!({"decision":"acceptForSession"}),
        json!({"decision":"allow_once","permissions":{"network":{"enabled":true}}}),
        json!("allow_once"),
    ] {
        assert!(answer_result(&context, Some(&invalid)).is_err());
    }
    let limited = approval_context(
        method,
        json!({"availableDecisions":["decline","cancel"]}),
        None,
    );
    assert!(!limited["card"]["canApprove"].as_bool().unwrap());
    assert!(answer_result(&limited, Some(&json!({"decision":"allow_once"}))).is_err());
}

#[test]
fn permissions_copy_only_the_requested_profile_for_the_current_turn() {
    let context = approval_context(
        "item/permissions/requestApproval",
        json!({"permissions":{"network":{"enabled":true},"fileSystem":{"write":["G:/scratch"]}}}),
        None,
    );
    assert_eq!(context["card"]["grantScope"], "turn");
    assert_eq!(
        answer_result(&context, Some(&json!({"decision":"allow_once"}))).unwrap(),
        json!({"scope":"turn","permissions":{"network":{"enabled":true},"fileSystem":{"write":["G:/scratch"]}}})
    );
    assert_eq!(
        answer_result(&context, None).unwrap(),
        json!({"scope":"turn","permissions":{}})
    );
    let bad = approval_context(
        "item/permissions/requestApproval",
        json!({"permissions":{"unknownPrivilege":true}}),
        None,
    );
    assert!(answer_result(&bad, Some(&json!({"decision":"allow_once"}))).is_err());
}

#[test]
fn file_approval_requires_visible_changes_and_never_grants_a_root_permanently() {
    let method = "item/fileChange/requestApproval";
    let unknown = approval_context(method, json!({"grantRoot":"G:/root"}), None);
    assert!(answer_result(&unknown, Some(&json!({"decision":"allow_once"}))).is_err());
    let changes = json!([{"path":"G:/root/file.txt","kind":"update","diff":"+small change"}]);
    let known = approval_context(method, json!({"grantRoot":"G:/root"}), Some(&changes));
    assert_eq!(
        answer_result(&known, Some(&json!({"decision":"allow_once"}))).unwrap(),
        json!({"decision":"accept"})
    );
}

#[test]
fn mcp_approval_is_not_a_general_form_or_authentication_acceptance() {
    let method = "mcpServer/elicitation/request";
    let request = json!({"mode":"form","serverName":"fixture","requestedSchema":{"type":"object","properties":{}},
        "_meta":{"codex_request_type":"approval_request","codex_approval_kind":"mcp_tool_call","tool_name":"bounded_tool","tool_params":{"path":"one"}}});
    let context = approval_context(method, request.clone(), None);
    assert_eq!(
        context["card"]["details"]["arguments"],
        json!({"path":"one"})
    );
    assert_eq!(
        answer_result(&context, Some(&json!({"decision":"allow_once"}))).unwrap()["action"],
        "accept"
    );
    assert_eq!(
        answer_result(&context, Some(&json!({"decision":"allow_once"}))).unwrap()["content"],
        json!({})
    );
    let mut no_args = request.clone();
    no_args["_meta"]
        .as_object_mut()
        .unwrap()
        .remove("tool_params");
    assert_eq!(
        approval_card(method, &no_args, None).unwrap()["details"]["arguments"],
        json!({})
    );
    for mutate in [
        "noMetadata",
        "requiresInput",
        "nonemptySchema",
        "url",
        "browserAuth",
    ] {
        let mut request = request.clone();
        match mutate {
            "noMetadata" => request["_meta"] = Value::Null,
            "requiresInput" => request["_meta"]["codex_requires_user_input"] = json!(true),
            "nonemptySchema" => {
                request["requestedSchema"]["properties"] = json!({"code":{"type":"string"}})
            }
            "url" => request["mode"] = json!("url"),
            _ => request["_meta"]["codex_approval_kind"] = json!("browser_auth"),
        }
        assert!(approval_card(method, &request, None).is_none(), "{mutate}");
    }
}
