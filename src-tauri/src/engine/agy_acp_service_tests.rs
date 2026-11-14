use super::*;
use crate::engine::agy_acp::{read_live_broker_manifest, service};

const SERVICE_FIXTURE: &str = "CCGUI_ACP_SERVICE_FIXTURE_ROOT";

#[test]
fn isolated_service_process() {
    let Some(root) = std::env::var_os(SERVICE_FIXTURE) else { return; };
    let root = dunce::canonicalize(root).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let service = Arc::new(AgyAcpState::with_root(root.clone()));
    runtime.block_on(service::run_service(service, Duration::from_secs(1), |_| {
        std::fs::write(root.join("service.ready"), b"ready").map_err(|error| error.to_string())
    })).unwrap();
    std::process::exit(0);
}

#[test]
fn isolated_desktop_process() {
    let Some(root) = std::env::var_os(SERVICE_FIXTURE) else { return; };
    let root = dunce::canonicalize(root).unwrap();
    // Reproduce the GUI's inner breakaway scope inside an isolated process;
    // the test runner itself may belong to a restrictive outer launcher job.
    #[cfg(windows)]
    let _scope = crate::engine::job::GuiServiceScope::acquire().unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    runtime.block_on(async {
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command.args(["engine::agy_acp::tests::service_tests::isolated_service_process", "--exact", "--nocapture"])
            .env(SERVICE_FIXTURE, &root);
        service::configure_service_command(&mut command);
        command.stdout(std::process::Stdio::null());
        let mut child = command.spawn().unwrap();
        until(|| {
            assert!(child.try_wait().unwrap().is_none());
            root.join("service.ready").is_file()
        }).await;
        let desktop = Arc::new(AgyAcpState::with_root(root.clone()));
        desktop.ensure_broker_service().await.unwrap();
        std::fs::write(root.join("desktop.ready"), b"ready").unwrap();
        until(|| root.join("desktop.exit").is_file()).await;
        // Abrupt owner exit: no Rust destructor can keep the broker alive or
        // perform graceful socket cleanup for us.
        std::process::exit(29);
    });
}

async fn start_service(fixture: &FakeAcpFixture) -> (tokio::process::Child, u32) {
    let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
    command.args(["engine::agy_acp::tests::service_tests::isolated_desktop_process", "--exact", "--nocapture"])
        .env(SERVICE_FIXTURE, &fixture.root);
    crate::engine::hide_console(&mut command);
    command.kill_on_drop(true).stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    let mut child = command.spawn().unwrap();
    until(|| {
        assert!(child.try_wait().unwrap().is_none(), "isolated desktop exited before readiness");
        fixture.root.join("desktop.ready").is_file()
    }).await;
    let pid = read_live_broker_manifest(&fixture.root).unwrap().pid;
    assert_ne!(pid, child.id().unwrap());
    (child, pid)
}

async fn exit_desktop(fixture: &FakeAcpFixture, desktop: &mut tokio::process::Child) {
    std::fs::write(fixture.root.join("desktop.exit"), b"exit").unwrap();
    assert_eq!(tokio::time::timeout(Duration::from_secs(5), desktop.wait()).await.unwrap().unwrap().code(), Some(29));
}

async fn assert_service_retires(fixture: &FakeAcpFixture, pid: u32) {
    until(|| read_live_broker_manifest(&fixture.root).is_none()
        && crate::task_worker::process_identity(pid).is_err()).await;
    assert_eq!(std::fs::read_dir(fixture.root.join("agy-acp-slots")).unwrap().count(), 0);
}

async fn until(mut predicate: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(15), async {
        while !predicate() { tokio::time::sleep(Duration::from_millis(20)).await; }
    }).await.expect("fixture did not reach its expected boundary");
}

fn deltas(emitter: &CollectingEmitter) -> String {
    emitter.0.lock().unwrap().iter().filter(|event| event["kind"] == "delta")
        .filter_map(|event| event["data"].as_str()).collect()
}

#[tokio::test]
async fn independent_acp_survives_desktop_replacement_during_initialize_and_streaming() {
    let fixture = FakeAcpFixture::with_behavior(json!({"initializeGate":true})).expect("node fixture required");
    let (mut original_desktop, service_pid) = start_service(&fixture).await;
    let initial_manifest = read_live_broker_manifest(&fixture.root).unwrap();
    let desktop = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
    let worker = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
    let mut req = base_req(&fixture.root.join("ws"), Some("auto"));
    req.prompt = "HANDOFF_STREAM".into();
    let bin = fixture.bin_path.to_string_lossy().to_string();
    let built = AgyEngine::new().build_command(&req, &bin).unwrap();
    let (core, registry, emitter, killed) = make_turn_core("acp-handoff", 4_000_003_000);
    let turn = tokio::spawn(run_acp_turn(core, req, bin.clone(), built, worker, killed, 4_000_003_000));
    until(|| fixture.requests().iter().any(|request| request["method"] == "initialize")).await;
    assert!(!desktop.has_active_turns(), "independent startup must not become a desktop handoff blocker");
    desktop.kill_spawned();
    drop(desktop);
    exit_desktop(&fixture, &mut original_desktop).await;
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert_eq!(read_live_broker_manifest(&fixture.root).unwrap().pid, service_pid, "startup lease must outlive host reconnect grace");
    assert!(!turn.is_finished());

    let replacement = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
    replacement.ensure_broker_service().await.unwrap();
    std::fs::write(fixture.root.join("initialize.release"), b"continue").unwrap();
    until(|| deltas(&emitter).contains("开始🙂")).await;
    assert!(!replacement.has_active_turns());
    replacement.kill_spawned();
    drop(replacement);
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert_eq!(read_live_broker_manifest(&fixture.root).unwrap().pid, service_pid, "streaming lease must survive another desktop exit");

    let next = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
    next.ensure_broker_service().await.unwrap();
    assert_eq!(read_live_broker_manifest(&fixture.root).unwrap().pid, initial_manifest.pid);
    std::fs::write(fixture.root.join("prompt.release"), b"continue").unwrap();
    tokio::time::timeout(Duration::from_secs(10), turn).await.unwrap().unwrap();
    assert_eq!(deltas(&emitter), "开始🙂\n完成🧪\n");
    let events = emitter.0.lock().unwrap().clone();
    assert_eq!(events.iter().filter(|event| event["kind"] == "done").count(), 1);
    assert!(!events.iter().any(|event| event["kind"] == "error"), "{events:?}");
    assert!(registry.get("acp-handoff").is_none());

    // The next GUI uses the same warm ACP process, with no prompt replay.
    let req = base_req(&fixture.root.join("ws"), Some("auto"));
    let built = AgyEngine::new().build_command(&req, &bin).unwrap();
    let (core, _, events, killed) = make_turn_core("after-handoff", 4_000_003_001);
    let worker = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
    run_acp_turn(core, req, bin, built, worker, killed, 4_000_003_001).await;
    assert!(events.0.lock().unwrap().iter().any(|event| event["kind"] == "done"));
    assert_eq!(fixture.spawn_pids().len(), 1, "handoff must preserve warm process reuse");
    assert_eq!(fixture.requests().iter().filter(|request| request["method"] == "session/prompt").count(), 2);
    next.kill_spawned();
    assert_service_retires(&fixture, service_pid).await;
}

#[tokio::test]
async fn disconnected_turn_releases_service_and_wrong_host_token_cannot_keep_it_alive() {
    let fixture = FakeAcpFixture::new().expect("node fixture required");
    let (mut original_desktop, service_pid) = start_service(&fixture).await;
    let desktop = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
    desktop.ensure_broker_service().await.unwrap();
    let client = AgyAcpState::with_root(fixture.root.clone());
    let profile = auth_fixture_profile(&fixture);
    let lease = client.try_connect_remote_broker(&profile, "", None).await.unwrap().unwrap();
    drop(lease);
    let mut manifest = read_live_broker_manifest(&fixture.root).unwrap();
    manifest.token = "0".repeat(64);
    assert!(service::attach_host(&manifest).await.is_err());
    desktop.kill_spawned();
    exit_desktop(&fixture, &mut original_desktop).await;
    assert_service_retires(&fixture, service_pid).await;
}

#[tokio::test]
async fn duplicate_service_cannot_replace_live_publication() {
    let fixture = FakeAcpFixture::new().expect("node fixture required");
    let first = Arc::new(AgyAcpState::with_root(dunce::canonicalize(&fixture.root).unwrap()));
    let task = tokio::spawn(service::run_service(first.clone(), Duration::from_millis(300), |_| Ok(())));
    until(|| read_live_broker_manifest(&fixture.root).is_some()).await;
    let manifest = read_live_broker_manifest(&fixture.root).unwrap();
    let host = service::attach_host(&manifest).await.unwrap();
    let duplicate = Arc::new(AgyAcpState::with_root(dunce::canonicalize(&fixture.root).unwrap()));
    assert!(service::run_service(duplicate, Duration::from_millis(300), |_| Ok(())).await.unwrap_err().contains("already owns"));
    assert_eq!(read_live_broker_manifest(&fixture.root).unwrap().token, manifest.token);
    drop(host);
    tokio::time::timeout(Duration::from_secs(5), task).await.unwrap().unwrap().unwrap();
}

#[tokio::test]
async fn cancelled_turn_after_desktop_exit_releases_the_independent_service() {
    let fixture = FakeAcpFixture::new().expect("node fixture required");
    let (mut desktop, service_pid) = start_service(&fixture).await;
    let worker = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
    let mut req = base_req(&fixture.root.join("ws"), Some("auto"));
    req.prompt = "HANG_FOR_CANCEL".into();
    let bin = fixture.bin_path.to_string_lossy().to_string();
    let built = AgyEngine::new().build_command(&req, &bin).unwrap();
    let (core, registry, emitter, killed) = make_turn_core("cancel-after-handoff", 4_000_003_002);
    let turn = tokio::spawn(run_acp_turn(core, req, bin, built, worker, killed.clone(), 4_000_003_002));
    until(|| deltas(&emitter).contains("partial-before-cancel")).await;
    exit_desktop(&fixture, &mut desktop).await;
    killed.store(true, Ordering::SeqCst);
    tokio::time::timeout(Duration::from_secs(10), turn).await.unwrap().unwrap();
    assert_eq!(deltas(&emitter), "partial-before-cancel");
    assert!(registry.get("cancel-after-handoff").is_none());
    assert_service_retires(&fixture, service_pid).await;
}

#[tokio::test]
async fn stale_attachment_is_rechecked_without_replacing_a_live_service() {
    let fixture = FakeAcpFixture::new().expect("node fixture required");
    let service = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
    service.start_broker().await.unwrap();
    let mut manifest = read_live_broker_manifest(&fixture.root).unwrap();
    let original = serde_json::to_vec(&manifest).unwrap();
    let unused = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    manifest.port = unused.local_addr().unwrap().port();
    drop(unused);
    let path = fixture.root.join(crate::engine::agy_acp::BROKER_FILE_REL);
    std::fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let repair = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(50)).await;
        std::fs::write(path, original).unwrap();
    });
    let desktop = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
    desktop.ensure_broker_service().await.unwrap();
    repair.await.unwrap();
    assert_eq!(service.host_leases.load(Ordering::SeqCst), 1);
    desktop.kill_spawned();
    service.kill_spawned();
}

#[tokio::test]
async fn unpublished_retiring_service_is_allowed_to_finish_cleanup_before_reconnect() {
    let fixture = FakeAcpFixture::new().expect("node fixture required");
    let root = dunce::canonicalize(&fixture.root).unwrap();
    let old_lock = service::service_lock(&root).unwrap();
    let state = Arc::new(AgyAcpState::with_root(root.clone()));
    let next = state.clone();
    let retirement = tokio::spawn(async move {
        // Longer than the old three-attempt retry window. While the publication
        // is absent, the retiring owner still holds its process cleanup lock.
        tokio::time::sleep(Duration::from_millis(500)).await;
        next.start_broker().await.unwrap();
        drop(old_lock);
    });
    let desktop = Arc::new(AgyAcpState::with_root(root));
    desktop.ensure_broker_service().await.unwrap();
    retirement.await.unwrap();
    assert_eq!(state.host_leases.load(Ordering::SeqCst), 1);
    desktop.kill_spawned();
    state.kill_spawned();
}

#[tokio::test]
async fn late_shutdown_cannot_unlink_another_brokers_manifest() {
    let fixture = FakeAcpFixture::new().expect("node fixture required");
    let old = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
    old.start_broker().await.unwrap();
    let new = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
    new.start_broker().await.unwrap();
    let expected = read_live_broker_manifest(&fixture.root).unwrap().token;
    old.kill_spawned();
    assert_eq!(read_live_broker_manifest(&fixture.root).unwrap().token, expected);
    new.kill_spawned();
    assert!(read_live_broker_manifest(&fixture.root).is_none());
}

#[tokio::test]
async fn lost_readiness_pipe_does_not_terminate_a_published_service_with_a_host_lease() {
    let fixture = FakeAcpFixture::new().expect("node fixture required");
    let state = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
    let task = tokio::spawn(service::run_service(state, Duration::from_millis(300), |_| Err("readiness pipe closed".into())));
    until(|| read_live_broker_manifest(&fixture.root).is_some()).await;
    let host = service::attach_host(&read_live_broker_manifest(&fixture.root).unwrap()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!task.is_finished());
    drop(host);
    assert_eq!(tokio::time::timeout(Duration::from_secs(5), task).await.unwrap().unwrap().unwrap_err(), "readiness pipe closed");
}
