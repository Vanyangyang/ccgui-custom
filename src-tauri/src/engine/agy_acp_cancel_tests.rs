use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};

#[tokio::test]
async fn registry_stop_reports_unconfirmed_cleanup_before_reader_abort() {
    use tokio::io::AsyncBufReadExt;
    let fixture = FakeAcpFixture::new().expect("node fixture");
    let owner = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
    owner.start_broker().await.unwrap();
    // A v2 broker that accepts the turn but never finishes retiring it.
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let manifest_path = fixture.root.join(super::super::BROKER_FILE_REL);
    let mut manifest: Value = serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
    manifest["port"] = json!(listener.local_addr().unwrap().port());
    std::fs::write(&manifest_path, manifest.to_string()).unwrap();
    let req = base_req(&fixture.root.join("ws"), Some("auto"));
    let bin = fixture.bin_path.to_string_lossy().to_string();
    let built = AgyEngine::new().build_command(&req, &bin).unwrap();
    let (core, registry, emitter, killed) = make_turn_core("unconfirmed-cleanup", 4_200_000_002);
    let sink = core.sink.clone();
    let entry = registry.get("unconfirmed-cleanup").unwrap();
    let stopper = registry.clone();
    let server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (read, mut write) = stream.into_split();
        let mut read = BufReader::new(read);
        read.read_line(&mut String::new()).await.unwrap();
        write.write_all(b"{\"ok\":true,\"slotPluginRoot\":\"\",\"mcpServers\":[],\"coldStartMs\":0}\n").await.unwrap();
        loop {
            let mut line = String::new();
            if read.read_line(&mut line).await.unwrap() == 0 { break; }
            let request: Value = serde_json::from_str(&line).unwrap();
            let response = match request["method"].as_str().unwrap_or("") {
                "session/new" => json!({"sessionId":"sid-fault","configOptions":[]}),
                "session/set_config_option" => json!({"configOptions":[{"id":request["params"]["configId"],"currentValue":request["params"]["value"]}]}),
                "session/prompt" => {
                    for update in [
                        json!({"sessionUpdate":"tool_call","toolCallId":"bg","title":"run_command","status":"in_progress","rawInput":{"CommandLine":"fixture background"}}),
                        json!({"sessionUpdate":"tool_call_update","toolCallId":"bg","status":"completed","rawOutput":"Tool is running as a background task with task id: sid-fault/task-1\n"}),
                    ] {
                        let notification = json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sid-fault","update":update}});
                        write.write_all(format!("{notification}\n").as_bytes()).await.unwrap();
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    assert!(stopper.kill("unconfirmed-cleanup"));
                    continue;
                }
                "session/cancel" => continue, // Exercise the full 2.5s cancellation budget.
                other => panic!("unexpected request {other}"),
            };
            let response = json!({"jsonrpc":"2.0","id":request["id"],"result":response});
            write.write_all(format!("{response}\n").as_bytes()).await.unwrap();
        }
        // Keep the write half alive after client EOF: retirement is unconfirmed.
        std::future::pending::<()>().await;
        drop(write);
    });
    let client = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
    let run = tokio::spawn(run_acp_turn(core, req, bin, built, client, killed, 4_200_000_002));
    entry.reader_abort.set(run.abort_handle()).unwrap();
    let joined = tokio::time::timeout(Duration::from_secs(12), run).await;
    server.abort();
    owner.kill_spawned();
    joined.unwrap().expect("registry must not abort before the cleanup error is emitted");
    sink.flush();
    let events = emitter.0.lock().unwrap();
    assert!(events.iter().any(|e| e["kind"] == "error" && e["data"].as_str().unwrap_or("").contains("cleanup could not be confirmed")), "{events:?}");
    assert!(!events.iter().any(|e| e["kind"] == "done"));
    let tasks = &events.iter().rev().find(|e| e["kind"] == "tasks").unwrap()["data"]["tasks"];
    assert_eq!(tasks[0]["status"], "unknown");
}

#[tokio::test]
async fn retirement_waits_for_broker_cleanup_and_rejects_a_missing_barrier() {
    let (client, server) = tokio::io::duplex(4096);
    let (read, mut write) = tokio::io::split(client);
    let mut read = BufReader::new(read);
    let cleaned = Arc::new(AtomicBool::new(false));
    let peer_cleaned = cleaned.clone();
    let peer = tokio::spawn(async move {
        let (mut reader, mut writer) = tokio::io::split(server);
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).await.unwrap();
        assert!(bytes.is_empty(), "retirement must not send a reusable-lease sentinel");
        writer.write_all(b"{\"lateReply\":true}\n").await.unwrap();
        tokio::time::sleep(Duration::from_millis(40)).await;
        peer_cleaned.store(true, Ordering::SeqCst);
    });
    super::super::retire_remote_lease(&mut read, &mut Vec::new(), &mut write).await.unwrap();
    assert!(cleaned.load(Ordering::SeqCst));
    peer.await.unwrap();

    let (client, _server) = tokio::io::duplex(4096);
    let (read, mut write) = tokio::io::split(client);
    let error = super::super::retire_remote_lease_with_timeout(
        &mut BufReader::new(read), &mut Vec::new(), &mut write, Duration::from_millis(30),
    ).await.unwrap_err();
    assert!(error.contains("did not finish retiring"));
}

#[tokio::test]
async fn active_prompt_cancellation_reaps_descendants_and_preserves_other_leases() {
    for remote in [false, true] {
        let fixture = FakeAcpFixture::with_behavior(json!({"cancelChild":true})).expect("node fixture");
        let owner = Arc::new(AgyAcpState::with_root(fixture.root.clone()));
        if remote { owner.start_broker().await.unwrap(); }
        let service = if remote { Arc::new(AgyAcpState::with_root(fixture.root.clone())) } else { owner.clone() };
        let profile = auth_fixture_profile(&fixture);
        let (mut sibling, sibling_guard, _, _, _) = owner.checkout_local(&profile, "", None).await.unwrap();
        let mut req = base_req(&fixture.root.join("ws"), Some("auto"));
        req.prompt = "HANG_FOR_CANCEL".into();
        let bin = fixture.bin_path.to_string_lossy().to_string();
        let built = AgyEngine::new().build_command(&req, &bin).unwrap();
        let (core, _, emitter, killed) = make_turn_core(&format!("tree-cancel-{remote}"), 4_200_000_001);
        let sink = core.sink.clone();
        let beat = fixture.root.join("descendant-heartbeat");
        let stop_beat = beat.clone();
        let stop = killed.clone();
        let trigger = tokio::spawn(async move {
            for _ in 0..500 {
                if std::fs::metadata(&stop_beat).is_ok_and(|m| m.len() > 1) {
                    stop.store(true, Ordering::SeqCst);
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("descendant never started");
        });
        tokio::time::timeout(Duration::from_secs(15), run_acp_turn(core, req, bin, built, service, killed, 4_200_000_001)).await.unwrap();
        trigger.await.unwrap();
        sink.flush();
        let events = emitter.0.lock().unwrap().clone();
        assert!(events.iter().any(|e| e["kind"] == "done"), "{events:?}");
        assert!(!events.iter().any(|e| e["kind"] == "error"), "{events:?}");
        let after = std::fs::read(&beat).unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(std::fs::read(&beat).unwrap(), after, "descendant survived cancellation remote={remote}");
        assert!(sibling.child.try_wait().unwrap().is_none(), "unrelated lease was killed");
        assert!(owner.inner.lock().unwrap().idle.is_empty(), "cancelled worker was reused");
        owner.release_local(sibling, true).await;
        drop(sibling_guard);
        owner.kill_spawned();
    }
}
