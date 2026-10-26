use super::*;
use serde_json::json;
use tokio::sync::mpsc;

fn fixture() -> (Arc<Relay>, mpsc::UnboundedReceiver<RelayEvent>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let relay = Arc::new(Relay::new(0, REQUEST_TIMEOUT,
        Box::new(move |event| tx.send(event).map_err(|_| "Test emitter closed".into()))));
    relay.set_ready(true).unwrap();
    (relay, rx)
}

#[tokio::test]
async fn sidechat_capabilities_expose_only_self_update() {
    let (relay, mut events) = fixture();
    let token = relay.register("sidechat-capabilities", "codex", Some("side-session"), "G:\\ccgui-custom").unwrap();
    let capabilities = relay.dispatch(&token, "get_host_capabilities".into(), json!({})).await.unwrap();
    assert_eq!(capabilities, json!({"taskTools":false, "selfUpdate":true,
        "pluginManagement":false, "workspaceOrganization":false, "sessionSidebarOrganization":false, "selfUpdateOnly":true}));
    assert!(events.try_recv().is_err());
}

#[test]
fn sidechat_mcp_lists_and_calls_only_its_three_tools() {
    use rmcp::ServerHandler;
    for self_update in [false, true] {
        // Even inconsistent broad flags must not widen the branch's scope.
        let server = mcp::server_with_capabilities(
            RelayClient::new("http://127.0.0.1:12345/host-chat", uuid::Uuid::new_v4().to_string()).unwrap(),
            Ok(json!({"taskTools":true,"selfUpdate":self_update,"pluginManagement":true,
                "workspaceOrganization":true,"sessionSidebarOrganization":true,"selfUpdateOnly":true})),
        ).unwrap();
        let tools = server.visible_tools().list_all();
        assert_eq!(tools.len(), if self_update { 3 } else { 0 });
        for tool in mcp::HostChatServer::tool_router().list_all() {
            assert_eq!(server.get_tool(&tool.name).is_some(), self_update && is_self_update_method(&tool.name), "{}", tool.name);
        }
        let instructions = server.get_info().instructions.unwrap();
        assert_eq!(instructions.contains("coordinate_self_update"), self_update);
        assert!(!instructions.contains("list_chats"));
        assert!(!instructions.contains("task_spawn"));
    }
}

struct SideRun {
    id: String,
    owner: crate::engine::sidechat::SideSessionOwner,
    session: String,
}

impl SideRun {
    fn new(engine: &str, workspace: &str, read_only: bool, ephemeral: bool) -> Self {
        let id = format!("{}{}", if ephemeral { "btw-" } else { "sidechat-" }, uuid::Uuid::new_v4());
        let owner = crate::engine::sidechat::SideSessionOwner {
            engine: engine.into(), workspace_path: workspace.into(), parent_session_id: Some(uuid::Uuid::new_v4().to_string()),
        };
        crate::engine::sidechat::begin_run(&id, owner.clone(), None, read_only).unwrap();
        Self { id, owner, session: uuid::Uuid::new_v4().to_string() }
    }

    fn register(&self, relay: &Relay, session: Option<&str>) -> Result<Option<String>, String> {
        relay.register_sidechat(&self.id, &self.owner.engine, session, &self.owner.workspace_path)
    }
}

impl Drop for SideRun {
    fn drop(&mut self) {
        crate::engine::sidechat::finish_run(&self.id);
        crate::engine::sidechat::unregister_hidden_session(&self.owner.engine, &self.session, None);
    }
}

#[test]
fn sidechat_admission_requires_executable_mode_and_matching_native_owner() {
    let (relay, _) = fixture();
    for engine in ["claude", "codex", "agy", "cursor"] {
        for (workspace, read_only, ephemeral, allowed) in [
            ("G:\\ccgui-custom", false, false, true),
            ("G:\\ccgui-custom\\src-tauri", false, false, true),
            ("G:\\ccgui-custom", true, false, false),
            ("G:\\ccgui-custom", false, true, false),
            ("G:\\another-project", false, false, false),
        ] {
            let run = SideRun::new(engine, workspace, read_only, ephemeral);
            let token = run.register(&relay, None).unwrap();
            assert_eq!(token.is_some(), allowed, "{engine}, {workspace}, read_only={read_only}, ephemeral={ephemeral}");
            relay.finish(&run.id);
        }
    }
    let run = SideRun::new("claude", "G:\\ccgui-custom", false, false);
    assert!(relay.register_sidechat(&run.id, "codex", None, &run.owner.workspace_path).is_err());
    assert!(relay.register_sidechat(&run.id, "claude", None, "G:\\ccgui-custom\\src-tauri").is_err());
    assert!(run.register(&relay, Some("unowned-session")).is_err());
    crate::engine::sidechat::cancel_run(&run.id);
    assert!(run.register(&relay, None).is_err());
    crate::engine::sidechat::finish_run(&run.id);
    assert!(run.register(&relay, None).unwrap().is_none());
    assert!(relay.inner.lock().runs.is_empty());
}

async fn coordinate_owner(relay: &Arc<Relay>, events: &mut mpsc::UnboundedReceiver<RelayEvent>, token: &str) -> crate::live_update::channel::Owner {
    let task = {
        let relay = relay.clone(); let token = token.to_owned();
        tokio::spawn(async move { relay.dispatch(&token, "coordinate_self_update".into(),
            json!({"action":"ready","changeId":"same-change","summary":"verified","revision":"test","sourceRoot":"G:\\ccgui-custom"})).await })
    };
    let event = tokio::time::timeout(Duration::from_secs(2), events.recv()).await.unwrap().unwrap();
    let RelayEvent::Request(event) = event else { panic!("expected self-update request") };
    let (owner, worker) = relay.self_update_origin(&event.request_id).unwrap();
    assert!(!worker, "Sidechat remains desktop-owned and must block activation while live");
    assert_eq!(owner.session_id, event.sender.session_id);
    relay.respond(&event.request_id, Some(json!({"ready":true})), None).unwrap();
    task.await.unwrap().unwrap();
    owner
}

#[tokio::test]
async fn sidechat_fork_and_resume_bind_updates_to_the_branch_and_revoke_old_tokens() {
    for engine in ["claude", "codex", "agy", "cursor"] {
        let (relay, mut events) = fixture();
        let mut run = SideRun::new(engine, "G:\\ccgui-custom", false, false);
        // Claude forks from this ID; other transports supply None or a verified
        // pre-forked session. The parent's identity is never an update owner.
        let token = run.register(&relay, run.owner.parent_session_id.as_deref()).unwrap().unwrap();
        assert!(relay.inner.lock().runs[&run.id].sender.session_id.is_none());
        assert_eq!(relay.dispatch(&token, "coordinate_self_update".into(),
            json!({"action":"withdraw","changeId":"same-change"})).await.unwrap_err().status, StatusCode::CONFLICT);
        crate::engine::sidechat::register_owned_session(&run.id, &run.session, None).unwrap();
        relay.adopt(&run.id, &run.session);
        relay.adopt(&run.id, &run.session);
        let first = coordinate_owner(&relay, &mut events, &token).await;
        assert_eq!(first.session_id.as_deref(), Some(run.session.as_str()));
        assert_ne!(first.session_id, run.owner.parent_session_id);
        relay.retire_process(&run.id);
        assert!(relay.authenticate(&token).is_err());
        while events.try_recv().is_ok() {}
        crate::engine::sidechat::finish_run(&run.id);
        run.id = format!("sidechat-{}", uuid::Uuid::new_v4());
        crate::engine::sidechat::begin_run(&run.id, run.owner.clone(), None, false).unwrap();
        let resumed_token = run.register(&relay, Some(&run.session)).unwrap().unwrap();
        let resumed = coordinate_owner(&relay, &mut events, &resumed_token).await;
        assert_eq!(first.session_id, resumed.session_id);
        assert_eq!(first.workspace_path, resumed.workspace_path);
        assert_eq!(first.engine, resumed.engine);
        assert_ne!(first.run_id, resumed.run_id);
        relay.adopt(&run.id, "unexpected-session");
        assert!(relay.authenticate(&resumed_token).is_err());
    }
}

#[test]
fn sidechat_scope_survives_serialization_and_never_becomes_a_main_restart_session() {
    let (relay, _) = fixture();
    for (id, worker, expected_restart) in [("ordinary-run", false, true), ("worker-run", true, true), ("sidechat-run", false, false)] {
        relay.register_kind(id, "codex", Some("saved-session"), "G:\\ccgui-custom", worker).unwrap();
        let run = relay.inner.lock().runs[id].clone();
        let restored: Run = serde_json::from_value(serde_json::to_value(&run).unwrap()).unwrap();
        assert_eq!(restored.self_update_only(), id.starts_with("sidechat-"));
        assert_eq!(restored.restart_session(true).is_some(), expected_restart);
        assert_eq!(restored.restart_session(false).is_some(), expected_restart && !worker);
    }
}

#[tokio::test]
async fn cancelled_sidechat_cannot_dispatch_or_complete_a_pending_self_update() {
    let (relay, mut events) = fixture();
    let run = SideRun::new("codex", "G:\\ccgui-custom", false, false);
    let token = run.register(&relay, None).unwrap().unwrap();
    crate::engine::sidechat::register_owned_session(&run.id, &run.session, None).unwrap();
    relay.adopt(&run.id, &run.session);
    let call = {
        let relay = relay.clone(); let token = token.clone();
        tokio::spawn(async move { relay.dispatch(&token, "get_self_update_status".into(), json!({})).await })
    };
    let event = tokio::time::timeout(Duration::from_secs(2), events.recv()).await.unwrap().unwrap();
    let RelayEvent::Request(event) = event else { panic!("expected pending request") };
    crate::engine::sidechat::cancel_run(&run.session);
    assert!(relay.self_update_origin(&event.request_id).is_err());
    relay.respond(&event.request_id, None, Some("Sidechat request was cancelled".into())).unwrap();
    assert!(call.await.unwrap().is_err());
    assert_eq!(relay.dispatch(&token, "get_self_update_status".into(), json!({})).await.unwrap_err().status, StatusCode::FORBIDDEN);
    assert_eq!(relay.dispatch_stable(&token, uuid::Uuid::new_v4().to_string(), "get_self_update_status".into(), json!({})).await.unwrap_err().status, StatusCode::FORBIDDEN);
    assert!(events.try_recv().is_err());
    assert!(relay.inner.lock().transport.is_empty());
    relay.retire_process(&run.id);
    assert!(relay.authenticate(&token).is_err());
}

#[tokio::test]
async fn sidechat_relay_rejects_unrelated_host_methods_before_dispatch() {
    let (relay, mut events) = fixture();
    let token = relay.register("sidechat-restricted", "claude", Some("side-session"), "G:\\ccgui-custom").unwrap();
    for (method, args) in [
        ("list_chats", json!({})),
        ("get_workspace_organization", json!({})),
        ("list_plugins", json!({})),
        ("task_list", json!({})),
    ] {
        for stable in [false, true] {
            let result = tokio::time::timeout(Duration::from_millis(500), async {
                if stable {
                    relay.dispatch_stable(&token, uuid::Uuid::new_v4().to_string(), method.into(), args.clone()).await
                } else {
                    relay.dispatch(&token, method.into(), args.clone()).await
                }
            }).await.expect("an unrelated sidechat call must be rejected before dispatch");
            assert_eq!(result.unwrap_err().status, StatusCode::FORBIDDEN);
            assert!(events.try_recv().is_err());
            assert!(relay.inner.lock().pending.is_empty());
            assert!(relay.inner.lock().transport.is_empty());
        }
    }
}
