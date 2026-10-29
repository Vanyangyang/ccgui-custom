use super::*;
#[path = "message_routing_tests.rs"]
mod message_routing_tests;
#[path = "session_sidebar_tests.rs"]
mod session_sidebar_tests;

#[test]
fn managed_plugin_ipc_rejects_unknown_relay_requests() {
    assert!(require_live_plugin_request(None).is_ok());
    assert!(require_live_plugin_request(Some("not-an-admitted-plugin-request")).unwrap_err().contains("no mutation was started"));
}
use serde_json::json;
use tokio::sync::mpsc;

fn organization_save_args() -> Value {
    let path = std::env::temp_dir().to_string_lossy().into_owned();
    json!({"requestId":"organize-1", "name":"Custom grouping", "defaultPath":path,
        "members":[{"path":path,"label":"Free-form label"}]})
}

#[test]
fn organization_tools_have_strict_role_free_inputs_and_no_privileged_operations() {
    assert!(validate_arguments("get_workspace_organization", json!({})).is_ok());
    assert!(validate_arguments("get_workspace_organization", json!({"settings":true})).is_err());
    assert!(validate_arguments("save_workspace_project", organization_save_args()).is_ok());
    for field in ["sourcePluginId", "sourceKey", "sender", "role", "permission"] {
        let mut args = organization_save_args(); args[field] = json!("forged");
        assert!(validate_arguments("save_workspace_project", args).is_err());
    }
    for field in ["role", "canonicalIdentity", "status", "sourcePluginId"] {
        let mut args = organization_save_args(); args["members"][0][field] = json!("forged");
        assert!(validate_arguments("save_workspace_project", args).is_err());
    }
    let mut missing_fingerprint = organization_save_args(); missing_fingerprint["id"] = json!("existing");
    assert!(validate_arguments("save_workspace_project", missing_fingerprint).is_err());
    let mut bad = organization_save_args(); bad["requestId"] = json!("bad id");
    assert!(validate_arguments("save_workspace_project", bad).is_err());
    assert!(validate_arguments("remove_workspace_project", json!({"id":"p"})).is_err());
    assert!(!requires_saved_session("get_workspace_organization"));
    assert!(requires_saved_session("save_workspace_project"));
    let tools = mcp::HostChatServer::tool_router().list_all();
    for name in ["get_workspace_organization", "save_workspace_project"] {
        let tool = tools.iter().find(|t| t.name == name).unwrap();
        assert_eq!(tool.input_schema["additionalProperties"], false);
        assert!(tool.input_schema.get("properties").and_then(|properties| properties.get("sourcePluginId")).is_none());
    }
    assert!(with_workspace_request("plugin-window", "r", "save_workspace_project", |_, _| Ok(())).unwrap_err().contains("main window"));
}

#[test]
fn organization_tools_require_the_host_capability_including_older_hosts() {
    use rmcp::ServerHandler;
    assert_eq!(mcp::startup_capabilities(Ok(json!({"taskTools":false}))).unwrap(), (false, false, false, false));
    assert_eq!(mcp::startup_capabilities(Ok(json!({"taskTools":false,"workspaceOrganization":true}))).unwrap(), (false, false, false, true));
    for workspace_organization in [false, true] {
        let server = mcp::HostChatServer { session_sidebar_organization: false, self_update_only: false, workspace_organization, plugin_management:false, task_tools:false, self_update:false,
            relay:RelayClient::new("http://127.0.0.1:12345/host-chat", uuid::Uuid::new_v4().to_string()).unwrap() };
        for name in ["get_workspace_organization", "save_workspace_project"] {
            assert_eq!(server.get_tool(name).is_some(), workspace_organization);
        }
    }
}

#[tokio::test]
async fn organization_native_gate_binds_arguments_method_and_live_origin() {
    let (relay, mut events, token) = fixture(REQUEST_TIMEOUT);
    relay.set_ready(true).unwrap();
    let args = organization_save_args();
    let call = dispatch(&relay, &token, "save_workspace_project", args.clone());
    let event = request(events.recv().await.unwrap());
    let value = relay.with_workspace_request(&event.request_id, "save_workspace_project", |scope, admitted| {
        assert!(scope.contains("source-session-id"));
        assert_eq!(*admitted, validate_arguments("save_workspace_project", args).unwrap());
        Ok(json!({"saved":true}))
    }).unwrap();
    assert!(relay.with_workspace_request(&event.request_id, "get_workspace_organization", |_, _| Ok(())).is_err());
    assert!(relay.with_workspace_request("unknown", "save_workspace_project", |_, _| Ok(())).is_err());
    relay.respond(&event.request_id, Some(value), None).unwrap();
    assert!(call.await.unwrap().is_ok());
    assert!(relay.with_workspace_request(&event.request_id, "save_workspace_project", |_, _| Ok(())).is_err());

    let call = dispatch(&relay, &token, "save_workspace_project", organization_save_args());
    let event = request(events.recv().await.unwrap());
    relay.inner.lock().pending.get_mut(&event.request_id).unwrap().deadline = Instant::now() - Duration::from_secs(1);
    let mut executed = false;
    assert!(relay.with_workspace_request(&event.request_id, "save_workspace_project", |_, _| { executed = true; Ok(()) }).is_err());
    assert!(!executed);
    relay.finish("trusted-run");
    let _ = call.await;
}

#[tokio::test]
async fn organization_read_allows_unsaved_origin_but_save_does_not() {
    let (relay, mut events, _) = fixture(REQUEST_TIMEOUT);
    let token = relay.register("unsaved-organization", "codex", None, "workspace").unwrap();
    relay.set_ready(true).unwrap();
    let call = dispatch(&relay, &token, "get_workspace_organization", json!({}));
    let event = request(events.recv().await.unwrap());
    relay.with_workspace_request(&event.request_id, "get_workspace_organization", |_, _| Ok(())).unwrap();
    relay.respond(&event.request_id, Some(json!({"projects":[]})), None).unwrap();
    assert!(call.await.unwrap().is_ok());
    assert_eq!(relay.dispatch(&token, "save_workspace_project".into(), organization_save_args()).await.unwrap_err().status, StatusCode::CONFLICT);
    assert!(events.try_recv().is_err());
}

#[test]
fn worker_context_managed_child_requires_exact_run_and_nonempty_branch() {
    let mut context = WorkerHostContext {
        profile: PathBuf::from("fixture-profile"), run_id: "worker-run".into(),
        engine: "claude".into(), session_id: Some("worker-session".into()),
        workspace_path: "fixture-workspace".into(), managed_task_parent: true,
        managed_branch_id: None, server_config: Value::Null,
    };
    // Owning task tools does not make an ordinary root a child.
    assert!(!context.is_managed_child("worker-run"));
    for owns_tasks in [false, true] {
        context.managed_task_parent = owns_tasks;
        context.managed_branch_id = Some("child-branch".into());
        assert!(context.is_managed_child("worker-run"));
        assert!(!context.is_managed_child("other-run"));
        assert!(!context.is_managed_child("worker-run-c1"));
    }
    for empty in ["", " \t\n"] {
        context.managed_branch_id = Some(empty.into());
        assert!(!context.is_managed_child("worker-run"));
    }
}

#[test]
fn worker_context_legacy_capsule_without_branch_is_not_managed_child() {
    let context: WorkerHostContext = serde_json::from_value(json!({
        "profile":"fixture-profile", "runId":"legacy-worker", "engine":"claude",
        "sessionId":"legacy-session", "workspacePath":"fixture-workspace",
        "managedTaskParent":true, "serverConfig":null
    })).unwrap();
    assert!(context.managed_branch_id.is_none());
    assert!(!context.is_managed_child("legacy-worker"));
}

fn fixture(timeout: Duration) -> (Arc<Relay>, mpsc::UnboundedReceiver<RelayEvent>, String) {
    let (tx, rx) = mpsc::unbounded_channel();
    let relay = Arc::new(Relay::new(
        0,
        timeout,
        Box::new(move |event| tx.send(event).map_err(|_| "Test emitter closed".into())),
    ));
    let token = relay
        .register(
            "trusted-run",
            "claude",
            Some("source-session-id"),
            "G:\\trusted-workspace",
        )
        .unwrap();
    (relay, rx, token)
}

fn request(event: RelayEvent) -> RequestEvent {
    match event {
        RelayEvent::Request(event) => event,
        RelayEvent::RunEnded(_) => panic!("expected a request, received run invalidation"),
        RelayEvent::ProcessRetired(_) => panic!("expected a request, received process retirement"),
    }
}

fn send_args(id: &str) -> Value {
    json!({ "session_id": "target-session-id", "message": "authorized test message", "request_id": id })
}

fn self_update_args() -> Value {
    json!({"packageDir": std::env::temp_dir().join("ccgui-update-package"), "manifestSha256": "a".repeat(64)})
}

fn self_update_fixture(timeout: Duration) -> (Arc<Relay>, mpsc::UnboundedReceiver<RelayEvent>, String) {
    let (tx, rx) = mpsc::unbounded_channel();
    let relay = Arc::new(Relay::new(
        0,
        timeout,
        Box::new(move |event| tx.send(event).map_err(|_| "Test emitter closed".into())),
    ));
    let token = relay
        .register("trusted-run", "claude", Some("source-session-id"), "G:\\ccgui-custom")
        .unwrap();
    (relay, rx, token)
}

fn worker_fixture() -> (Arc<Relay>, mpsc::UnboundedReceiver<RelayEvent>, String) {
    let (tx, rx) = mpsc::unbounded_channel();
    let relay = Arc::new(Relay::new(0, REQUEST_TIMEOUT,
        Box::new(move |event| tx.send(event).map_err(|_| "Test emitter closed".into()))));
    let token = relay.register_kind("worker-run", "claude", None, "G:\\ccgui-custom", true).unwrap();
    relay.set_ready(true).unwrap();
    (relay, rx, token)
}

fn update_owner() -> crate::live_update::channel::Owner {
    crate::live_update::channel::Owner { run_id: "trusted-run".into(), engine: "claude".into(),
        session_id: Some("source-session-id".into()), workspace_path: "G:\\ccgui-custom".into() }
}

#[tokio::test]
async fn update_channel_binds_identity_to_admission_and_rejects_forged_owner() {
    let (relay, mut events, token) = self_update_fixture(REQUEST_TIMEOUT); relay.set_ready(true).unwrap();
    let args = json!({"action":"begin", "requestId":"build-1", "sourceRoot":std::env::temp_dir()});
    assert!(validate_arguments("coordinate_self_update", args.clone()).is_ok());
    let mut forged = args.clone(); forged["owner"] = json!("another-chat");
    assert!(validate_arguments("coordinate_self_update", forged).is_err());
    let call = dispatch(&relay, &token, "coordinate_self_update", args);
    let mut event = request(events.recv().await.unwrap()); event.sender.run_id = "forged".into();
    assert_eq!(relay.self_update_origin(&event.request_id).unwrap().0, update_owner());
    relay.respond(&event.request_id, Some(json!({"startBuild":false})), None).unwrap();
    assert_eq!(call.await.unwrap().unwrap()["startBuild"], false);
    assert!(relay.self_update_origin(&event.request_id).is_err());
}

#[tokio::test]
async fn startup_capabilities_are_authenticated_internal_and_need_no_saved_session() {
    for worker in [false, true] {
        let (relay, mut events, _) = fixture(REQUEST_TIMEOUT);
        let token = relay.register_kind("ordinary-capability-run", "claude", None,
            "G:\\trusted-workspace", worker).unwrap();
        let ccgui_token = relay.register_kind("ccgui-capability-run", "claude", Some("saved-session"),
            "G:\\ccgui-custom\\src-tauri", worker).unwrap();
        // Startup does not depend on the frontend being ready or session adoption.
        let server = HttpServer::start(relay.clone()).await;
        assert_eq!(server.client(&token).call("get_host_capabilities", json!({})).await.unwrap(),
            json!({"taskTools":false, "selfUpdate":false, "pluginManagement":true, "workspaceOrganization":true, "sessionSidebarOrganization":true}));
        assert_eq!(server.client(&ccgui_token).call("get_host_capabilities", json!({})).await.unwrap(),
            json!({"taskTools":false, "selfUpdate":true, "pluginManagement":true, "workspaceOrganization":true, "sessionSidebarOrganization":true}));
        assert!(events.try_recv().is_err());
        assert!(relay.inner.lock().transport.is_empty());
        assert_eq!(relay.dispatch("forged-token", "get_host_capabilities".into(), json!({})).await.unwrap_err().status,
            StatusCode::UNAUTHORIZED);
        assert!(validate_arguments("get_host_capabilities", json!({"taskTools":true})).is_err());
        relay.set_ready(true).unwrap();
        let denied = relay.dispatch(&token, "get_self_update_status".into(), json!({})).await.unwrap_err();
        assert_eq!(denied.status, StatusCode::FORBIDDEN);
        assert_eq!(denied.message, SELF_UPDATE_WORKSPACE_UNAVAILABLE);
        relay.retire_process("ordinary-capability-run");
        assert_eq!(relay.dispatch(&token, "get_host_capabilities".into(), json!({})).await.unwrap_err().status,
            StatusCode::UNAUTHORIZED);
    }
}

#[test]
fn tool_publication_and_guidance_follow_trusted_capabilities() {
    use rmcp::ServerHandler;
    for task_tools in [false, true] {
        for self_update in [false, true] {
            let server = mcp::HostChatServer { session_sidebar_organization: false, self_update_only: false, workspace_organization: false, plugin_management: false, task_tools, self_update,
                relay: RelayClient::new("http://127.0.0.1:12345/host-chat", uuid::Uuid::new_v4().to_string()).unwrap() };
            let tools = server.visible_tools().list_all();
            assert_eq!(tools.iter().filter(|tool| tool.name.starts_with("task_")).count(), if task_tools { 6 } else { 0 });
            assert!(!tools.iter().any(|tool| tool.name.starts_with("leader_")));
            assert_eq!(tools.iter().filter(|tool| is_self_update_method(&tool.name)).count(), if self_update { 3 } else { 0 });
            assert!(!tools.iter().any(|tool| tool.name == "get_host_capabilities"));
            assert_eq!(server.get_tool("task_spawn").is_some(), task_tools);
            assert!(server.get_tool("leader_spawn").is_none());
            assert_eq!(server.get_tool("coordinate_self_update").is_some(), self_update);
            assert_eq!(server.get_tool("prepare_self_update").is_some(), self_update);
            assert_eq!(server.get_tool("get_self_update_status").is_some(), self_update);
            let instructions = server.get_info().instructions.unwrap();
            assert_eq!(instructions.contains("task_spawn"), task_tools);
            assert!(!instructions.contains("modelPolicy"));
            assert!(!instructions.contains("before choosing a model"));
            assert!(!instructions.contains("Leader mode"));
            assert_eq!(instructions.contains("ccgui-self-update"), self_update);
            assert_eq!(instructions.contains("coordinate_self_update"), self_update);
            if task_tools {
                assert!(instructions.contains("verified child-to-parent"));
                assert!(instructions.contains("acknowledge_message with outcome=handled"));
            }
            if !task_tools {
                for tool in tools {
                    let text = tool.description.as_deref().unwrap_or_default();
                    assert!(!text.contains("Leader") && !text.contains("parent") && !text.contains("child"), "{}: {text}", tool.name);
                }
            }
        }
    }
}

#[test]
fn startup_capabilities_require_the_current_authenticated_contract() {
    assert!(mcp::startup_capabilities(Err("Unsupported host chat method".into())).is_err());
    assert!(mcp::startup_capabilities(Err("Host chat token is missing or expired".into())).is_err());
    assert!(mcp::startup_capabilities(Err("transport outcome is unknown".into())).is_err());
    assert!(mcp::startup_capabilities(Ok(json!({"leaderMode":true, "selfUpdate":true}))).is_err());
    assert_eq!(mcp::startup_capabilities(Ok(json!({"taskTools":true, "selfUpdate":true}))).unwrap(), (true, true, false, false));
    assert_eq!(mcp::startup_capabilities(Ok(json!({"taskTools":true, "selfUpdate":false}))).unwrap(), (true, false, false, false));
}

#[test]
fn plugin_tools_are_strict_camel_case_and_capability_gated() {
    let path = std::env::current_dir().unwrap().to_string_lossy().into_owned();
    let install = json!({"path":path,"expectedId":"test-plugin","expectedVersion":"1.2.3"});
    assert_eq!(validate_arguments("install_plugin", install.clone()).unwrap(), install);
    assert!(validate_arguments("list_plugins", json!({})).is_ok());
    assert!(validate_arguments("list_plugins", json!({"id":"test-plugin"})).is_err());
    assert!(validate_arguments("get_plugin_status", json!({"id":"test-plugin","sourcePath":path})).is_ok());
    for id in ["", "a", "-plugin", "Bad-plugin", "plugin_id", &"a".repeat(65)] {
        assert!(validate_arguments("get_plugin_status", json!({"id":id})).is_err());
    }
    for version in ["", "1.2", "1.2.3-beta", "v1.2.3", "1.2.٣"] {
        assert!(validate_arguments("reload_plugin", json!({"id":"test-plugin","expectedVersion":version})).is_err());
    }
    for bad_path in ["relative/plugin", "C:relative", "https://example.com/plugin", "file:///plugin", "", &"a".repeat(4097)] {
        assert!(validate_arguments("install_plugin", json!({"path":bad_path,"expectedId":"test-plugin","expectedVersion":"1.2.3"})).is_err());
        assert!(validate_arguments("get_plugin_status", json!({"id":"test-plugin","sourcePath":bad_path})).is_err());
    }
    assert!(validate_arguments("install_plugin", json!({"path":path,"expected_id":"test-plugin","expectedVersion":"1.2.3"})).is_err());
    assert!(validate_arguments("reload_plugin", json!({"id":"test-plugin","expectedVersion":"1.2.3","enabled":true})).is_err());
    for plugin_management in [false, true] {
        let server = mcp::HostChatServer { session_sidebar_organization: false, self_update_only: false, workspace_organization: false, plugin_management, task_tools:false, self_update:false,
            relay:RelayClient::new("http://127.0.0.1:12345/host-chat", uuid::Uuid::new_v4().to_string()).unwrap() };
        assert_eq!(server.visible_tools().list_all().iter().filter(|tool| is_plugin_method(&tool.name)).count(), if plugin_management { 4 } else { 0 });
    }
    assert_eq!(mcp::startup_capabilities(Ok(json!({"taskTools":false,"pluginManagement":true}))).unwrap(), (false,false,true,false));
    for tool in mcp::HostChatServer::tool_router().list_all().iter().filter(|tool| is_plugin_method(&tool.name)) {
        assert_eq!(tool.input_schema["additionalProperties"], false);
        if tool.name == "install_plugin" {
            assert_eq!(tool.input_schema["properties"]["path"]["maxLength"], 4096);
            assert_eq!(tool.input_schema["properties"]["expectedId"]["pattern"], "^[a-z0-9][a-z0-9-]{1,63}$");
            assert!(tool.input_schema["properties"].get("expectedVersion").is_some());
        }
    }
    assert!(!requires_saved_session("list_plugins"));
    assert!(!requires_saved_session("get_plugin_status"));
    assert!(requires_saved_session("install_plugin"));
    assert!(requires_saved_session("reload_plugin"));
}

#[tokio::test]
async fn plugin_relay_queries_work_without_saved_session_but_mutations_require_one() {
    let (relay, mut events, _) = fixture(REQUEST_TIMEOUT);
    let token = relay.register("unsaved-plugin-run", "claude", None, "G:\\ordinary-workspace").unwrap();
    relay.set_ready(true).unwrap();
    for (method, args) in [("list_plugins", json!({})), ("get_plugin_status", json!({"id":"test-plugin"}))] {
        let call = dispatch(&relay, &token, method, args.clone());
        let event = request(events.recv().await.unwrap());
        assert_eq!(event.method, method);
        assert_eq!(event.arguments, args);
        assert!(relay.request_is_live(&event.request_id));
        relay.respond(&event.request_id, Some(json!({"ok":true})), None).unwrap();
        assert_eq!(call.await.unwrap().unwrap(), json!({"ok":true}));
        assert!(!relay.request_is_live(&event.request_id));
    }
    for (method, args) in [
        ("install_plugin", json!({"path":std::env::temp_dir(),"expectedId":"test-plugin","expectedVersion":"1.2.3"})),
        ("reload_plugin", json!({"id":"test-plugin","expectedVersion":"1.2.3"})),
    ] {
        let error = relay.dispatch(&token, method.into(), args).await.unwrap_err();
        assert_eq!(error.status, StatusCode::CONFLICT);
    }
    assert!(events.try_recv().is_err());
}

#[test]
fn self_update_tools_publish_camel_case_schema_and_reject_unsafe_arguments() {
    use rmcp::ServerHandler;
    let args = self_update_args();
    assert!(validate_arguments("prepare_self_update", args.clone()).is_ok());
    for name in ["sender", "runId", "workerOwned", "url", "activate", "permission"] {
        let mut forged = args.clone(); forged[name] = json!("forged");
        assert!(validate_arguments("prepare_self_update", forged).is_err());
    }
    for path in ["relative/package", "https://host/package", "file:///C:/package", "", "C:\\bad\npath"] {
        let mut invalid = args.clone(); invalid["packageDir"] = json!(path);
        assert!(validate_arguments("prepare_self_update", invalid).is_err(), "accepted {path}");
    }
    for hash in ["a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), "https://host/hash".into()] {
        let mut invalid = args.clone(); invalid["manifestSha256"] = json!(hash);
        assert!(validate_arguments("prepare_self_update", invalid).is_err());
        assert!(validate_arguments("get_self_update_status", json!({"manifestSha256":hash})).is_err());
    }
    assert_eq!(validate_arguments("get_self_update_status", json!({})).unwrap(), json!({}));
    assert!(validate_arguments("get_self_update_status", json!({"runId":"forged"})).is_err());
    let tools = mcp::HostChatServer::tool_router().list_all();
    let prepare = tools.iter().find(|tool| tool.name == "prepare_self_update").unwrap();
    assert_eq!(prepare.input_schema["additionalProperties"], false);
    assert_eq!(prepare.input_schema["properties"]["manifestSha256"]["pattern"], "^[0-9a-f]{64}$");
    assert_eq!(prepare.input_schema["properties"]["packageDir"]["maxLength"], 4096);
    assert!(tools.iter().any(|tool| tool.name == "get_self_update_status"));
    let server = mcp::HostChatServer { session_sidebar_organization: false, self_update_only: false, workspace_organization: false, plugin_management: false, task_tools: false, self_update: true, relay: RelayClient::new("http://127.0.0.1:12345/host-chat", uuid::Uuid::new_v4().to_string()).unwrap() };
    assert!(server.get_info().instructions.unwrap().contains("ccgui-self-update"));
}

#[tokio::test]
async fn self_update_prepare_admits_desktop_owned_origin_but_never_freezes_under_it() {
    let (relay, mut events, token) = self_update_fixture(REQUEST_TIMEOUT);
    relay.set_ready(true).unwrap();
    // A non-worker (managed-child / computer-use style) origin may stage a package.
    let pending = dispatch(&relay, &token, "prepare_self_update", self_update_args());
    let event = request(events.recv().await.unwrap());
    assert_eq!(event.method, "prepare_self_update");
    assert!(!relay.self_update_worker_owned(&event.request_id).unwrap());
    relay.respond(&event.request_id, Some(json!({"accepted":true})), None).unwrap();
    assert_eq!(pending.await.unwrap().unwrap()["accepted"], true);
    // A forged event sender cannot turn that admission into a worker capability.
    let pending = dispatch(&relay, &token, "get_self_update_status", json!({}));
    let mut event = request(events.recv().await.unwrap());
    event.sender.run_id = "worker-run".into();
    assert!(!relay.self_update_worker_owned(&event.request_id).unwrap());
    relay.respond(&event.request_id, Some(json!({"supported":true,"prepareSupported":true,"originWorkerOwned":false})), None).unwrap();
    assert_eq!(pending.await.unwrap().unwrap()["originWorkerOwned"], false);
    // Staging is allowed, but activation cannot freeze while the origin is alive:
    // it would be killed by the switch, so the update waits instead.
    let error = prepare_relay_update(&relay, Duration::from_secs(1)).await.err().expect("must refuse to freeze under a desktop-owned run");
    assert!(error.contains("still belongs to the desktop process"), "{error}");
    assert!(relay.inner.lock().frozen.is_none());
}

#[tokio::test]
async fn self_update_status_retries_frozen_transport_without_new_authority() {
    let (relay, mut events, token) = worker_fixture();
    let ticket = prepare_relay_update(&relay, Duration::from_secs(1)).await.unwrap();
    let server = HttpServer::start(relay.clone()).await;
    let client = server.client(&token);
    let call = tokio::spawn(async move { client.call("get_self_update_status", json!({"manifestSha256":"a".repeat(64)})).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(events.try_recv().is_err());
    assert!(relay.inner.lock().transport.is_empty());
    {
        let mut inner = relay.inner.lock();
        assert_eq!(inner.frozen.as_deref(), Some(ticket.nonce.as_str()));
        inner.frozen = None;
    }
    let event = request(tokio::time::timeout(Duration::from_secs(2), events.recv()).await.unwrap().unwrap());
    assert_eq!(event.method, "get_self_update_status");
    assert!(relay.self_update_worker_owned(&event.request_id).unwrap());
    relay.respond(&event.request_id, Some(json!({"matchesTransaction":true,"state":{"transaction":{"phase":"Failed"}}})), None).unwrap();
    let result = call.await.unwrap().unwrap();
    assert_eq!(result["state"]["transaction"]["phase"], "Failed");
    assert!(events.try_recv().is_err());
    assert_eq!(relay.inner.lock().transport.len(), 1);
}

#[cfg(feature = "test-harness")]
#[tokio::test]
async fn self_update_prepare_returns_before_its_own_pending_handoff_drain() {
    let _harness = crate::test_harness::TestHarness::new().unwrap();
    let (update, transaction) = crate::handoff::tests::prepared_update(&crate::paths::app_home());
    let (relay, mut events, token) = worker_fixture();
    let args = json!({"packageDir":crate::paths::app_home().join("missing-package"),
        "manifestSha256":transaction.candidate.manifest_sha256});
    let transport_id = uuid::Uuid::new_v4().to_string();
    let call = {
        let relay = relay.clone(); let token = token.clone(); let id = transport_id.clone();
        tokio::spawn(async move { relay.dispatch_stable(&token, id, "prepare_self_update".into(), args).await })
    };
    let event = request(events.recv().await.unwrap());
    let result = tokio::time::timeout(Duration::from_secs(1), prepare_self_update_request(&relay, &event)).await
        .expect("preparation must not wait for its own admitted request to drain").unwrap();
    assert_eq!(result["accepted"], true);
    assert_eq!(result["transactionId"], transaction.id);
    assert_eq!(result["phase"], "Preparing");
    assert!(relay.inner.lock().pending.contains_key(&event.request_id));
    assert!(relay.inner.lock().frozen.is_none());
    assert_eq!(update.read_state().unwrap().transaction.unwrap().phase, crate::live_update::TransactionPhase::Preparing);
    // Begin may now freeze admission, but only resolves after the stable reply
    // enters the ledger. No claim is made about client-side ACK delivery.
    let draining = {
        let relay = relay.clone();
        tokio::spawn(async move { prepare_relay_update(&relay, Duration::from_secs(2)).await })
    };
    tokio::task::yield_now().await;
    assert!(!draining.is_finished());
    relay.respond(&event.request_id, Some(result.clone()), None).unwrap();
    assert_eq!(call.await.unwrap().unwrap(), result);
    let ticket = draining.await.unwrap().unwrap();
    let checkpoint = relay_checkpoint(&relay, &ticket, crate::paths::app_home()).unwrap();
    assert!(checkpoint.receipts.iter().any(|receipt| receipt.id == transport_id && receipt.reply.result.as_ref() == Some(&result)));
    assert_eq!(relay.dispatch_stable(&token, transport_id, "prepare_self_update".into(), event.arguments).await.unwrap(), result);
    assert!(events.try_recv().is_err());
    update.fail(&transaction.id).unwrap();
    let failed = crate::handoff::prepare_self_update(crate::paths::app_home().join("missing-package").to_string_lossy().into_owned(),
        transaction.candidate.manifest_sha256.clone(), update_owner(), None).await.unwrap();
    assert_eq!(failed["accepted"], false);
    assert_eq!(failed["phase"], "Failed");
    assert_eq!(failed["transactionId"], transaction.id);
    update.rollback(&transaction.id).unwrap();
    let rolled_back = crate::handoff::prepare_self_update(crate::paths::app_home().join("missing-package").to_string_lossy().into_owned(),
        transaction.candidate.manifest_sha256, update_owner(), None).await.unwrap();
    assert_eq!(rolled_back["accepted"], false);
    assert_eq!(rolled_back["phase"], "RolledBack");
    assert_eq!(rolled_back["transactionId"], transaction.id);
}

#[tokio::test]
async fn task_requests_keep_verified_sender_and_expire_with_its_capability() {
    let (relay, mut rx, token) = fixture(REQUEST_TIMEOUT);
    relay.set_ready(true).unwrap();
    let args = json!({"request_id":"child-one","engine":"codex","title":"Review","task":"Inspect only"});
    let pending = dispatch(&relay, &token, "task_spawn", args);
    let event = request(rx.recv().await.unwrap());
    assert_eq!(event.sender.run_id, "trusted-run");
    assert_eq!(event.sender.session_id.as_deref(), Some("source-session-id"));
    assert_eq!(event.sender.workspace_path, "G:\\trusted-workspace");
    assert!(relay.request_is_live(&event.request_id));
    relay.retire_process("trusted-run");
    assert!(!relay.request_is_live(&event.request_id));
    assert!(pending.await.unwrap().is_err());
    assert!(validate_arguments("task_spawn", json!({
        "request_id":"child-two","engine":"claude","title":"Work","task":"Work",
        "parent_session_id":"forged", "permission":"bypass",
    })).is_err());
    assert!(validate_arguments("task_reclaim", json!({"branch_id":"a","sender":{"session_id":"forged"}})).is_err());
}

#[tokio::test]
async fn unregistered_worker_tasks_fail_without_upgrading_authority() {
    for engine in ["claude", "codex", "agy"] {
        let (relay, mut events, _) = fixture(Duration::from_millis(100));
        let token = relay.register_kind("ordinary-worker", engine, Some("worker-session"),
            "G:\\trusted-workspace", true).unwrap();
        relay.set_ready(true).unwrap();
        let error = relay.dispatch(&token, "task_list".into(), json!({})).await.unwrap_err();
        assert_eq!(error.status, StatusCode::FORBIDDEN);
        assert!(error.message.contains("no trusted task registration"));
        assert!(events.try_recv().is_err(), "unregistered worker requests must not enter the task ledger");
        assert!(relay.inner.lock().pending.is_empty());

        // Ordinary peer communication still uses the same authenticated sender.
        let pending = dispatch(&relay, &token, "list_chats", json!({}));
        let event = request(events.recv().await.unwrap());
        assert_eq!(event.sender.run_id, "ordinary-worker");
        assert_eq!(event.sender.engine, engine);
        relay.respond(&event.request_id, Some(json!({"chats":[]})), None).unwrap();
        assert_eq!(pending.await.unwrap().unwrap(), json!({"chats":[]}));
    }
}

#[tokio::test]
async fn worker_task_actions_fail_before_any_child_or_control_dispatch() {
    let (relay, mut events, token) = worker_fixture();
    relay.adopt("worker-run", "worker-session");
    for (method, args) in [
        ("task_spawn", json!({"request_id":"child-one","engine":"agy","title":"Review","task":"Inspect only"})),
        ("task_send", json!({"request_id":"followup-one","branch_id":"branch-one","message":"Continue"})),
        ("task_wait", json!({"timeout_seconds":1})),
        ("task_renew", json!({"branch_id":"branch-one","ttl_seconds":60})),
        ("task_stop", json!({"branch_id":"branch-one"})),
    ] {
        let error = tokio::time::timeout(Duration::from_secs(1),
            relay.dispatch(&token, method.into(), args)).await
            .expect("an unregistered task call must not wait for a desktop dispatch").unwrap_err();
        assert_eq!(error.status, StatusCode::FORBIDDEN);
        assert!(error.message.contains("no trusted task registration"));
        assert!(!error.message.contains("outcome is unknown"));
        assert!(events.try_recv().is_err());
        assert!(relay.inner.lock().pending.is_empty());
    }
}

#[tokio::test]
async fn worker_task_rejection_keeps_http_receipts_and_authentication_boundaries() {
    let (relay, mut events, token) = worker_fixture();
    relay.adopt("worker-run", "worker-session");
    let server = HttpServer::start(relay.clone()).await;
    let error = tokio::time::timeout(Duration::from_secs(1),
        server.client(&token).call("task_list", json!({}))).await.unwrap().unwrap_err();
    assert!(error.contains("no trusted task registration"));
    assert_eq!(relay.inner.lock().transport.len(), 1);
    assert!(events.try_recv().is_err());

    let error = relay.dispatch(&token, "task_list".into(), json!({"worker":false})).await.unwrap_err();
    assert_eq!(error.status, StatusCode::BAD_REQUEST);
    assert!(events.try_recv().is_err());
    let error = relay.dispatch("forged-token", "task_list".into(), json!({})).await.unwrap_err();
    assert_eq!(error.status, StatusCode::UNAUTHORIZED);
    relay.set_ready(false).unwrap();
    let error = relay.dispatch(&token, "task_list".into(), json!({})).await.unwrap_err();
    assert_eq!(error.status, StatusCode::SERVICE_UNAVAILABLE);
    relay.set_ready(true).unwrap();
    relay.retire_process("worker-run");
    let error = relay.dispatch(&token, "task_list".into(), json!({})).await.unwrap_err();
    assert_eq!(error.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn process_retirement_wakes_queues_without_granting_a_chat_capability() {
    let (relay, mut rx, token) = fixture(REQUEST_TIMEOUT);
    let count = relay.inner.lock().runs.len();
    relay.retire_process("plugin-or-mission-run");
    assert!(matches!(rx.recv().await.unwrap(), RelayEvent::ProcessRetired(id) if id == "plugin-or-mission-run"));
    assert_eq!(relay.inner.lock().runs.len(), count);
    assert!(relay.authenticate(&token).is_ok());
    assert!(rx.try_recv().is_err());
}

#[tokio::test]
async fn removed_leader_methods_are_rejected_before_dispatch() {
    let (relay, mut events, token) = fixture(REQUEST_TIMEOUT);
    relay.set_ready(true).unwrap();
    for (method, args) in [
        ("leader_list", json!({})),
        ("leader_spawn", json!({"request_id":"old-spawn","engine":"claude","title":"Review","task":"Inspect only"})),
        ("leader_send", json!({"request_id":"old-send","branch_id":"child-one","message":"Continue"})),
        ("leader_wait", json!({"timeout_seconds":1})),
        ("leader_renew", json!({"branch_id":"child-one","ttl_seconds":60})),
        ("leader_stop", json!({"branch_id":"child-one"})),
    ] {
        assert!(!crate::leader::is_method(method), "removed method still routed: {method}");
        assert!(crate::leader::validate_arguments(method, args.clone()).is_err());
        assert!(validate_arguments(method, args.clone()).is_err());
        let error = relay.dispatch(&token, method.into(), args).await.unwrap_err();
        assert_eq!(error.status, StatusCode::BAD_REQUEST, "{method}");
        assert!(events.try_recv().is_err(), "removed method emitted an event: {method}");
        assert!(relay.inner.lock().pending.is_empty());
    }
}

fn task_capsule(run: &str, session: Option<&str>) -> crate::leader::WorkerTaskRegistration {
    serde_json::from_value(json!({
        "runId":run,"engine":"claude","sessionId":session,"workspacePath":"G:\\ccgui-custom",
        "permission":"manual","rootOnStart":session.is_none(),"rootIdentityBound":session.is_some(),
        "rootSavedBaseline":session.is_none().then(Vec::<String>::new),
        "rootForeignClaims":session.is_none().then(Vec::<String>::new),"verifiedNewRoot":false,
    })).unwrap()
}

#[tokio::test]
async fn registered_worker_task_dispatch_keeps_its_sender_and_expires_on_stop() {
    let (relay, mut events, token) = worker_fixture();
    relay.adopt("worker-run", "worker-session");
    relay.inner.lock().runs.get_mut("worker-run").unwrap().tasks = Some(task_capsule("worker-run", Some("worker-session")));
    let pending = dispatch(&relay, &token, "task_list", json!({}));
    let event = request(events.recv().await.unwrap());
    assert_eq!(event.sender.run_id, "worker-run");
    assert_eq!(event.sender.session_id.as_deref(), Some("worker-session"));
    relay.finish("worker-run");
    assert!(pending.await.unwrap().is_err());
    assert_eq!(relay.dispatch(&token, "task_list".into(), json!({})).await.unwrap_err().status, StatusCode::UNAUTHORIZED);
}

#[test]
fn worker_recovery_requires_existing_capsule_and_exact_origin() {
    let (relay, _events, _) = worker_fixture();
    assert!(relay.worker_task_registration("unknown", Some("claude"), Some("G:\\ccgui-custom"), None).unwrap().is_none());
    assert!(relay.worker_task_registration("worker-run", Some("claude"), Some("G:\\ccgui-custom"), None).unwrap().is_none());
    relay.inner.lock().runs.get_mut("worker-run").unwrap().tasks = Some(task_capsule("worker-run", None));
    // A first native identity may arrive after the checkpoint; binding still
    // goes through the coordinator after restoring this unchanged capsule.
    let recovered = relay.worker_task_registration("worker-run", Some("claude"), Some("G:\\ccgui-custom"), Some("new-session")).unwrap().unwrap();
    assert_eq!(serde_json::to_value(recovered).unwrap()["permission"], "manual");
    assert!(relay.worker_task_registration("worker-run", Some("codex"), Some("G:\\ccgui-custom"), None).is_err());
    assert!(relay.worker_task_registration("worker-run", Some("claude"), Some("G:\\foreign"), None).is_err());
    relay.adopt("worker-run", "worker-session");
    relay.inner.lock().runs.get_mut("worker-run").unwrap().tasks = Some(task_capsule("worker-run", Some("worker-session")));
    assert!(relay.worker_task_registration("worker-run", Some("claude"), Some("G:\\ccgui-custom"), Some("foreign-session")).is_err());
    relay.inner.lock().runs.get_mut("worker-run").unwrap().tasks = Some(task_capsule("foreign-run", Some("worker-session")));
    assert!(relay.worker_task_registration("worker-run", Some("claude"), Some("G:\\ccgui-custom"), Some("worker-session")).is_err());
}

#[tokio::test]
async fn checkpoint_drops_retired_task_authority_and_old_records_default_to_none() {
    let (relay, _events, _) = worker_fixture();
    let raw = serde_json::to_value(&relay.inner.lock().runs["worker-run"]).unwrap();
    let mut legacy = raw;
    legacy.as_object_mut().unwrap().remove("tasks");
    assert!(serde_json::from_value::<Run>(legacy).unwrap().tasks.is_none());
    relay.inner.lock().runs.get_mut("worker-run").unwrap().tasks = Some(task_capsule("worker-run", None));
    // This fixture has no live coordinator registration to refresh.
    let ticket = prepare_relay_update(&relay, Duration::from_millis(100)).await.unwrap();
    let saved = relay_checkpoint(&relay, &ticket, PathBuf::from("fixture-profile")).unwrap();
    assert!(saved.runs.iter().all(|run| run.tasks.is_none()));
}

#[test]
fn checkpoint_worker_identity_handles_both_sides_of_first_adopt() {
    let (relay, _events, _) = worker_fixture();
    {
        let mut inner = relay.inner.lock();
        let run = inner.runs.get_mut("worker-run").unwrap();
        run.tasks = Some(task_capsule("worker-run", None));
        // Before the coordinator commits, neither half may claim an identity.
        refresh_worker_checkpoint_run(run, Some(task_capsule("worker-run", None))).unwrap();
        assert!(run.sender.session_id.is_none());
        assert!(run.tasks.as_ref().unwrap().session_id.is_none());
        // The coordinator has committed, but poll is blocked on the relay lock.
        refresh_worker_checkpoint_run(run, Some(task_capsule("worker-run", Some("first-session")))).unwrap();
        assert_eq!(run.sender.session_id.as_deref(), Some("first-session"));
        let restored: Run = serde_json::from_value(serde_json::to_value(&*run).unwrap()).unwrap();
        assert!(restored.tasks.as_ref().unwrap().matches_origin(
            &restored.sender.run_id, &restored.sender.engine,
            &restored.sender.workspace_path, restored.sender.session_id.as_deref()));
    }
    // The delayed poll adoption is idempotent and keeps the original token.
    relay.adopt("worker-run", "first-session");
    let restored = relay.worker_task_registration("worker-run", Some("claude"), Some("G:\\ccgui-custom"), Some("first-session")).unwrap().unwrap();
    assert_eq!(serde_json::to_value(restored).unwrap()["permission"], "manual");
}

#[test]
fn checkpoint_worker_identity_rejects_changed_or_regressed_origin_without_mutation() {
    let (relay, _events, _) = worker_fixture();
    relay.adopt("worker-run", "owned-session");
    let mut run = relay.inner.lock().runs["worker-run"].clone();
    run.tasks = Some(task_capsule("worker-run", Some("owned-session")));
    let before = serde_json::to_value(&run).unwrap();
    let valid = task_capsule("worker-run", Some("owned-session"));
    let mut wrong_engine = valid.clone();
    wrong_engine.engine = "codex".into();
    let mut wrong_workspace = valid.clone();
    wrong_workspace.workspace_path = "G:\\foreign".into();
    for latest in [
        task_capsule("foreign-run", Some("owned-session")),
        task_capsule("worker-run", Some("foreign-session")),
        task_capsule("worker-run", None), wrong_engine, wrong_workspace,
    ] {
        assert!(refresh_worker_checkpoint_run(&mut run, Some(latest)).is_err());
        assert_eq!(serde_json::to_value(&run).unwrap(), before);
    }
    refresh_worker_checkpoint_run(&mut run, Some(valid)).unwrap();
    assert_eq!(serde_json::to_value(&run).unwrap(), before);
}

#[test]
fn checkpoint_worker_identity_clears_retired_authority_without_upgrading_legacy_runs() {
    let (relay, _events, _) = worker_fixture();
    let mut run = relay.inner.lock().runs["worker-run"].clone();
    // Discovery or an unrelated live registration cannot upgrade a legacy run.
    refresh_worker_checkpoint_run(&mut run, Some(task_capsule("worker-run", Some("foreign-session")))).unwrap();
    assert!(run.tasks.is_none());
    assert!(run.sender.session_id.is_none());
    run.sender.session_id = Some("owned-session".into());
    run.tasks = Some(task_capsule("worker-run", Some("owned-session")));
    refresh_worker_checkpoint_run(&mut run, None).unwrap();
    assert!(run.tasks.is_none());
    assert_eq!(run.sender.session_id.as_deref(), Some("owned-session"));
}

fn dispatch(
    relay: &Arc<Relay>,
    token: &str,
    method: &str,
    args: Value,
) -> tokio::task::JoinHandle<Result<Value, Failure>> {
    let relay = Arc::clone(relay);
    let token = token.to_owned();
    let method = method.to_owned();
    tokio::spawn(async move { relay.dispatch(&token, method, args).await })
}

struct HttpServer {
    task: tokio::task::JoinHandle<()>,
    url: String,
}

impl HttpServer {
    async fn start(relay: Arc<Relay>) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://127.0.0.1:{}{ROUTE}",
            listener.local_addr().unwrap().port()
        );
        let task = tokio::spawn(async move {
            axum::serve(listener, router(relay)).await.unwrap();
        });
        Self { task, url }
    }
    fn client(&self, token: &str) -> RelayClient {
        RelayClient::new(&self.url, token.into()).unwrap()
    }
}

impl Drop for HttpServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[test]
fn argument_bounds_and_schema_reject_overrides_and_forged_source() {
    assert_eq!(
        validate_arguments("list_chats", json!({})).unwrap(),
        json!({"limit":50})
    );
    assert!(validate_arguments("list_chats", json!({"limit":200,"query":"metadata"})).is_ok());
    for limit in [json!(0), json!(201), json!(-1), json!(1.5), json!("2")] {
        assert!(validate_arguments("list_chats", json!({"limit":limit})).is_err());
    }
    assert!(validate_arguments("list_chats", json!({"query":"x".repeat(1025)})).is_err());
    assert!(validate_arguments("other", json!({})).is_err());
    let mut args = send_args("safe-request:1");
    assert!(validate_arguments("send_message", args.clone()).is_ok());
    for name in [
        "sender",
        "source_session_id",
        "model",
        "effort",
        "permission_mode",
    ] {
        args[name] = json!("forged");
        assert!(validate_arguments("send_message", args.clone()).is_err());
        args.as_object_mut().unwrap().remove(name);
    }
    for message in [" ", "", &"界".repeat(MAX_MESSAGE_CHARS + 1)] {
        args["message"] = json!(message);
        assert!(validate_arguments("send_message", args.clone()).is_err());
    }
    args["message"] = json!("😀".repeat(MAX_MESSAGE_CHARS));
    assert!(validate_arguments("send_message", args.clone()).is_ok());
    args["session_id"] = json!("1234567");
    assert!(validate_arguments("send_message", args).is_err());
    for id in ["", "with spaces", "☃", "slash/id", &"a".repeat(65)] {
        assert!(validate_arguments("get_message_status", json!({"request_id":id})).is_err());
    }
    let schema = serde_json::to_value(schemars::schema_for!(SendMessageArgs)).unwrap();
    assert_eq!(
        schema["properties"]["message"]["maxLength"],
        MAX_MESSAGE_CHARS
    );
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(schema["properties"]["wait_seconds"]["maximum"], 20);
    assert!(validate_arguments("send_message", json!({"session_id":"target-session-id","message":"hi","request_id":"r1","wait_seconds":20})).is_ok());
    assert!(validate_arguments("send_message", json!({"session_id":"target-session-id","message":"hi","request_id":"r1","wait_seconds":21})).is_err());
    assert!(validate_arguments("get_message_status", json!({"request_id":"r1","wait_seconds":20})).is_ok());
    assert!(validate_arguments("get_message_status", json!({"request_id":"r1","wait_seconds":21})).is_err());
}

#[test]
fn private_url_validation_refuses_redirect_routes_and_external_hosts() {
    let token = uuid::Uuid::new_v4().to_string();
    assert!(RelayClient::new("http://127.0.0.1:12345/host-chat", token.clone()).is_ok());
    for url in [
        "https://127.0.0.1:12345/host-chat",
        "http://localhost:12345/host-chat",
        "http://127.0.0.2:12345/host-chat",
        "http://example.com:12345/host-chat",
        "http://127.0.0.1:0/host-chat",
        "http://127.0.0.1/host-chat",
        "http://127.0.0.1:12345/other",
        "http://127.0.0.1:12345/host-chat?target=remote",
        "http://127.0.0.1:12345/host-chat#fragment",
        "http://user@127.0.0.1:12345/host-chat",
        "http://127.1:12345/host-chat",
        "http://127.0.0.1:12345/a/../host-chat",
    ] {
        assert!(
            RelayClient::new(url, token.clone()).is_err(),
            "accepted {url}"
        );
    }
    assert!(RelayClient::new("http://127.0.0.1:12345/host-chat", "bad token".into()).is_err());
}

#[test]
fn trusted_origin_registration_is_bounded_and_session_adoption_is_one_way() {
    let (relay, _, token) = fixture(REQUEST_TIMEOUT);
    assert_eq!(
        relay
            .register("trusted-run", "claude", None, "G:\\trusted-workspace")
            .unwrap(),
        token
    );
    assert!(relay
        .register("trusted-run", "codex", None, "G:\\trusted-workspace")
        .is_err());
    assert!(relay
        .register(
            "trusted-run",
            "claude",
            Some("other-session"),
            "G:\\trusted-workspace"
        )
        .is_err());
    assert!(relay.register("", "claude", None, "workspace").is_err());
    assert!(relay
        .register("run", "claude\nforged", None, "workspace")
        .is_err());
    assert!(relay
        .register("run", "claude", None, &"x".repeat(4097))
        .is_err());
    relay.adopt("trusted-run", "source-session-id");
    assert_eq!(
        relay.inner.lock().runs["trusted-run"]
            .sender
            .session_id
            .as_deref(),
        Some("source-session-id")
    );
    for i in 1..MAX_RUNS {
        relay
            .register(&format!("run-{i}"), "claude", None, "workspace")
            .unwrap();
    }
    assert!(relay
        .register("overflow", "claude", None, "workspace")
        .is_err());
}

#[tokio::test]
async fn real_http_authentication_immutable_sender_and_expired_token() {
    let (relay, mut rx, token) = fixture(REQUEST_TIMEOUT);
    relay.set_ready(true).unwrap();
    let server = HttpServer::start(Arc::clone(&relay)).await;
    let client = server.client(&token);
    let missing = client
        .client
        .post(&server.url)
        .json(&json!({"method":"list_chats","arguments":{}}))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::UNAUTHORIZED);
    let wrong = client
        .client
        .post(&server.url)
        .bearer_auth(uuid::Uuid::new_v4().to_string())
        .json(&json!({"method":"list_chats","arguments":{}}))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), StatusCode::UNAUTHORIZED);
    let forged = client.client.post(&server.url).bearer_auth(&token)
        .json(&json!({"method":"send_message","arguments":send_args("id-1"),"sender":{"sessionId":"forged"}}))
        .send().await.unwrap();
    assert_eq!(forged.status(), StatusCode::BAD_REQUEST);
    assert!(rx.try_recv().is_err());
    let call = tokio::spawn(async move { client.call("send_message", send_args("id-1")).await });
    let event = request(rx.recv().await.unwrap());
    assert_eq!(event.sender.run_id, "trusted-run");
    assert_eq!(event.sender.engine, "claude");
    assert_eq!(
        event.sender.session_id.as_deref(),
        Some("source-session-id")
    );
    assert_eq!(event.sender.workspace_path, "G:\\trusted-workspace");
    assert_eq!(event.arguments["request_id"], "id-1");
    relay
        .respond(&event.request_id, Some(json!({"status":"queued"})), None)
        .unwrap();
    assert_eq!(call.await.unwrap().unwrap()["status"], "queued");
    relay.finish("trusted-run");
    let RelayEvent::RunEnded(sender) = rx.recv().await.unwrap() else {
        panic!("missing invalidation")
    };
    assert_eq!(sender.session_id.as_deref(), Some("source-session-id"));
    let error = server
        .client(&token)
        .call("list_chats", json!({}))
        .await
        .unwrap_err();
    assert!(error.contains("expired"));
    relay.finish("trusted-run");
    assert!(rx.try_recv().is_err());
}

#[tokio::test]
async fn real_http_rejects_oversized_body_before_emission() {
    let (relay, mut rx, token) = fixture(REQUEST_TIMEOUT);
    relay.set_ready(true).unwrap();
    let server = HttpServer::start(relay).await;
    let response = server
        .client(&token)
        .client
        .post(&server.url)
        .bearer_auth(token)
        .body("x".repeat(MAX_REQUEST_BYTES + 1))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(rx.try_recv().is_err());
}

#[tokio::test]
async fn readiness_unknown_session_and_adoption_fence_dispatch() {
    let (relay, mut rx, token) = fixture(REQUEST_TIMEOUT);
    let result = relay
        .dispatch(&token, "list_chats".into(), json!({}))
        .await
        .unwrap_err();
    assert_eq!(result.status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(rx.try_recv().is_err());
    relay.set_ready(true).unwrap();
    let new_token = relay
        .register("new-run", "claude", None, "G:\\new")
        .unwrap();
    for (method, arguments) in [
        ("send_message", send_args("new-id")),
        ("get_message_status", json!({"request_id":"new-id"})),
    ] {
        assert_eq!(
            relay
                .dispatch(&new_token, method.into(), arguments)
                .await
                .unwrap_err()
                .status,
            StatusCode::CONFLICT
        );
    }
    assert!(rx.try_recv().is_err());
    let list = dispatch(&relay, &new_token, "list_chats", json!({}));
    let event = request(rx.recv().await.unwrap());
    assert!(event.sender.session_id.is_none());
    relay
        .respond(&event.request_id, Some(json!([])), None)
        .unwrap();
    assert_eq!(list.await.unwrap().unwrap(), json!([]));
    relay.adopt("new-run", "adopted-session");
    relay.adopt("new-run", "adopted-session");
    let send = dispatch(&relay, &new_token, "send_message", send_args("new-id"));
    let event = request(rx.recv().await.unwrap());
    assert_eq!(event.sender.session_id.as_deref(), Some("adopted-session"));
    relay
        .respond(&event.request_id, Some(json!({"status":"received"})), None)
        .unwrap();
    send.await.unwrap().unwrap();
    let pending = dispatch(&relay, &new_token, "send_message", send_args("conflict-id"));
    let event = request(rx.recv().await.unwrap());
    relay.adopt("new-run", "replacement-session");
    assert!(pending
        .await
        .unwrap()
        .unwrap_err()
        .message
        .contains("unknown"));
    assert!(relay.authenticate(&new_token).is_err());
    assert!(relay
        .respond(&event.request_id, Some(json!("wrong source")), None)
        .is_err());
    let RelayEvent::RunEnded(sender) = rx.recv().await.unwrap() else {
        panic!("missing invalidation")
    };
    assert_eq!(sender.session_id.as_deref(), Some("adopted-session"));
}

#[tokio::test]
async fn responses_are_correlated_exactly_once_and_ready_epochs_retire_pending() {
    let (relay, mut rx, token) = fixture(REQUEST_TIMEOUT);
    relay.set_ready(true).unwrap();
    let first = dispatch(&relay, &token, "send_message", send_args("one"));
    let a = request(rx.recv().await.unwrap());
    let second = dispatch(&relay, &token, "send_message", send_args("two"));
    let b = request(rx.recv().await.unwrap());
    assert_ne!(a.request_id, b.request_id);
    assert!(relay
        .respond(
            &uuid::Uuid::new_v4().to_string(),
            Some(json!("forged")),
            None
        )
        .is_err());
    assert!(relay
        .respond(&a.request_id, Some(json!("invalid")), Some("error".into()))
        .is_err());
    relay
        .respond(&b.request_id, Some(json!("two")), None)
        .unwrap();
    relay
        .respond(&a.request_id, Some(json!("one")), None)
        .unwrap();
    assert_eq!(first.await.unwrap().unwrap(), json!("one"));
    assert_eq!(second.await.unwrap().unwrap(), json!("two"));
    assert!(relay
        .respond(&a.request_id, Some(json!("duplicate")), None)
        .is_err());
    let pending = dispatch(&relay, &token, "send_message", send_args("old"));
    let old = request(rx.recv().await.unwrap());
    relay.set_ready(false).unwrap();
    relay.set_ready(true).unwrap();
    assert!(pending
        .await
        .unwrap()
        .unwrap_err()
        .message
        .contains("unknown"));
    assert!(relay
        .respond(&old.request_id, Some(json!("stale")), None)
        .is_err());
    assert_eq!(relay.inner.lock().pending.len(), 0);
}

#[tokio::test]
async fn real_http_timeout_returns_unknown_and_never_replays_send() {
    let (relay, mut rx, token) = fixture(Duration::from_millis(30));
    relay.set_ready(true).unwrap();
    let server = HttpServer::start(Arc::clone(&relay)).await;
    let client = server.client(&token);
    let call = tokio::spawn(async move { client.call("send_message", send_args("same-id")).await });
    let event = request(rx.recv().await.unwrap());
    let error = call.await.unwrap().unwrap_err();
    assert!(error.contains("outcome is unknown") && error.contains("same request_id"));
    assert!(rx.try_recv().is_err());
    assert_eq!(relay.inner.lock().pending.len(), 0);
    assert!(relay
        .respond(&event.request_id, Some(json!({"status":"finished"})), None)
        .is_err());
    let client = server.client(&token);
    let status = tokio::spawn(async move {
        client
            .call("get_message_status", json!({"request_id":"same-id"}))
            .await
    });
    let check = request(rx.recv().await.unwrap());
    assert_eq!(check.method, "get_message_status");
    assert_eq!(check.arguments["request_id"], "same-id");
    relay
        .respond(&check.request_id, Some(json!({"status":"unknown"})), None)
        .unwrap();
    assert_eq!(status.await.unwrap().unwrap()["status"], "unknown");
}

#[tokio::test]
async fn pending_caps_and_finish_revoke_and_unblock_without_fake_completion() {
    let (relay, mut rx, token) = fixture(REQUEST_TIMEOUT);
    relay.set_ready(true).unwrap();
    let mut tasks = Vec::new();
    let mut ids = Vec::new();
    for i in 0..MAX_PENDING_PER_RUN {
        tasks.push(dispatch(
            &relay,
            &token,
            "send_message",
            send_args(&format!("id-{i}")),
        ));
        ids.push(request(rx.recv().await.unwrap()).request_id);
    }
    assert_eq!(
        relay
            .dispatch(&token, "list_chats".into(), json!({}))
            .await
            .unwrap_err()
            .status,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert!(rx.try_recv().is_err());
    relay.finish("trusted-run");
    for task in tasks {
        assert!(task.await.unwrap().unwrap_err().message.contains("unknown"));
    }
    for id in ids {
        assert!(relay.respond(&id, Some(json!("stale")), None).is_err());
    }
    assert!(relay.authenticate(&token).is_err());
    assert_eq!(relay.inner.lock().pending.len(), 0);
    assert!(matches!(rx.recv().await.unwrap(), RelayEvent::RunEnded(_)));
}

#[tokio::test]
async fn global_pending_cap_and_shutdown_revoke_every_method() {
    let (relay, mut rx, token) = fixture(REQUEST_TIMEOUT);
    relay.set_ready(true).unwrap();
    let mut tasks = Vec::new();
    for i in 0..MAX_PENDING {
        let per_run_token = relay
            .register(
                &format!("global-{i}"),
                "claude",
                Some("saved-session"),
                "workspace",
            )
            .unwrap();
        tasks.push(dispatch(&relay, &per_run_token, "list_chats", json!({})));
        request(rx.recv().await.unwrap());
    }
    assert_eq!(
        relay
            .dispatch(&token, "list_chats".into(), json!({}))
            .await
            .unwrap_err()
            .status,
        StatusCode::TOO_MANY_REQUESTS
    );
    relay.shutdown();
    for task in tasks {
        assert!(task.await.unwrap().unwrap_err().message.contains("unknown"));
    }
    assert!(relay.set_ready(true).is_err());
    assert!(relay
        .register("replacement", "claude", None, "workspace")
        .is_err());
    for (method, args) in [
        ("list_chats", json!({})),
        ("send_message", send_args("id")),
        ("get_message_status", json!({"request_id":"id"})),
    ] {
        assert_eq!(
            relay
                .dispatch(&token, method.into(), args)
                .await
                .unwrap_err()
                .status,
            StatusCode::UNAUTHORIZED
        );
    }
    assert!(relay.inner.lock().runs.is_empty());
    assert!(relay.inner.lock().pending.is_empty());
}

#[tokio::test]
async fn cancelled_waiter_is_removed_and_oversized_response_is_not_accepted() {
    let (relay, mut rx, token) = fixture(REQUEST_TIMEOUT);
    relay.set_ready(true).unwrap();
    let cancelled = dispatch(&relay, &token, "send_message", send_args("cancel"));
    let event = request(rx.recv().await.unwrap());
    cancelled.abort();
    assert!(cancelled.await.unwrap_err().is_cancelled());
    assert!(relay.inner.lock().pending.is_empty());
    assert!(relay
        .respond(&event.request_id, Some(json!({"status":"finished"})), None)
        .is_err());
    let call = dispatch(&relay, &token, "list_chats", json!({}));
    let event = request(rx.recv().await.unwrap());
    assert!(relay
        .respond(
            &event.request_id,
            Some(json!("x".repeat(MAX_RESPONSE_BYTES))),
            None
        )
        .is_err());
    assert!(relay
        .respond(
            &event.request_id,
            None,
            Some("x".repeat(MAX_ERROR_BYTES + 1))
        )
        .is_err());
    relay
        .respond(
            &event.request_id,
            None,
            Some("Frontend durable storage failed".into()),
        )
        .unwrap();
    assert_eq!(
        call.await.unwrap().unwrap_err().message,
        "Frontend durable storage failed"
    );
}

#[test]
fn ledger_window_key_and_serialized_bounds_and_plugin_namespace_isolation() {
    assert!(main_only("main").is_ok());
    for label in ["", "popout", "cu-cursor", "main-2"] {
        assert!(main_only(label).is_err());
    }
    let key = format!("{LEDGER_KEY_PREFIX}[\"ccgui-uuid\",\"window-uuid\"]");
    assert!(ledger_key(&key).is_ok());
    for key in [
        "unreserved",
        LEDGER_KEY_PREFIX,
        &format!("{LEDGER_KEY_PREFIX}\nforged"),
        &format!("{LEDGER_KEY_PREFIX}{}", "x".repeat(512)),
    ] {
        assert!(ledger_key(key).is_err());
    }
    assert!(bounded_json(&json!("123"), 5, "Test").is_ok());
    assert!(bounded_json(&json!("123"), 4, "Test").is_err());
    assert!(bounded_json(&json!("\n"), 3, "Test").is_err());
    let scratch = crate::plugins::test_support::Scratch::new();
    let plugin = scratch.path("reserved-plugin");
    crate::plugins::test_support::write_plugin(
        &plugin,
        &crate::plugins::test_support::valid_manifest(LEDGER_NAMESPACE),
    );
    // The same ordinary plugin id validator used by plugin_storage_* rejects
    // this namespace; it cannot be selected through the public plugin API.
    assert!(crate::plugins::test_support::validate(&plugin).is_err());
    let db = crate::db::Db::open_at(&scratch.path("host.db")).unwrap();
    let value = json!({"requests":[{"requestId":"r1","status":"queued"}]});
    db.plugin_kv_set(LEDGER_NAMESPACE, &key, &value).unwrap();
    assert_eq!(
        db.plugin_kv_get(LEDGER_NAMESPACE, &key).unwrap(),
        Some(value)
    );
    assert!(db.plugin_kv_get("ordinary-plugin", &key).unwrap().is_none());
    db.plugin_kv_delete(LEDGER_NAMESPACE, &key).unwrap();
    assert!(db.plugin_kv_get(LEDGER_NAMESPACE, &key).unwrap().is_none());
}

#[test]
fn rmcp_handler_and_tool_schema_compile() {
    use rmcp::ServerHandler;
    let server = mcp::HostChatServer { session_sidebar_organization: false, self_update_only: false, workspace_organization: false, plugin_management: false,
        task_tools: false,
        self_update: false,
        relay: RelayClient::new(
            "http://127.0.0.1:12345/host-chat",
            uuid::Uuid::new_v4().to_string(),
        )
        .unwrap(),
    };
    let info = server.get_info();
    assert_eq!(info.server_info.name, MCP_SERVER_NAME);
    assert!(info.capabilities.tools.is_some());
    assert!(info
        .instructions
        .unwrap()
        .contains("explicit authorization"));
}

#[test]
fn published_task_tools_preserve_delegation_without_model_deletion() {
    let tools = mcp::HostChatServer::tool_router().list_all();
    let mut task_names: Vec<_> = tools
        .iter()
        .filter(|tool| tool.name.starts_with("task_"))
        .map(|tool| tool.name.as_ref())
        .collect();
    task_names.sort_unstable();
    assert_eq!(
        task_names,
        ["task_list", "task_renew", "task_send", "task_spawn", "task_stop", "task_wait"],
        "models may manage child execution but must not archive or delete conversations"
    );

    assert!(!tools.iter().any(|tool| tool.name.starts_with("leader_")));
    let spawn = tools.iter().find(|tool| tool.name == "task_spawn").unwrap();
    let description = spawn.description.as_deref().unwrap();
    assert!(description.contains("same workspace share files"));
    assert!(description.contains("same registered project as the native parent"));
    assert!(!description.contains("enabled Leader mode"));
    assert!(description.contains("Completed children retain their conversation and results"));
    let properties = spawn.input_schema.get("properties").unwrap();
    assert!(properties["workspace_path"]["description"].as_str().unwrap().contains("development members"));
    assert!(!spawn.input_schema["required"].as_array().unwrap().contains(&json!("workspace_path")));
    assert!(properties.get("parent_workspace_path").is_none());
    assert!(properties.get("project_id").is_none());
    assert!(properties["task"]["description"]
        .as_str().unwrap().contains("cannot see this conversation"));
    let model_description = properties["model"]["description"].as_str().unwrap();
    assert!(model_description.contains("Optional exact model ID"));
    assert!(model_description.contains("Omit to use the host's default"));
    assert!(!model_description.contains("task_list"));
    assert!(
        properties["effort"]["description"]
            .as_str().unwrap().contains("Omit to use the user's default"),
        "effort omission must preserve the user's engine default"
    );
    assert!(!description.contains("modelPolicy"));
    assert!(!description.contains("configured=false"));
    assert!(!description.contains("before choosing"));
    let list = tools.iter().find(|tool| tool.name == "task_list").unwrap();
    let list_description = list.description.as_deref().unwrap();
    assert!(!list_description.contains("modelPolicy"));
    assert!(!list_description.contains("allowedModels"));
    let skill = include_str!("../../resources/skills/ccgui-collab/SKILL.md");
    assert!(!skill.contains("modelPolicy"));
    assert!(!skill.contains("Before selecting a model"));

    let wait = tools.iter().find(|tool| tool.name == "task_wait").unwrap();
    let description = wait.description.as_deref().unwrap();
    assert!(description.contains("during this call (listed in changedBranchIds)"));
    assert!(description.contains("assignments already finished when the call starts do not end a wait for other active assignments"));
    assert!(description.contains("call again while you still need results"));
}
