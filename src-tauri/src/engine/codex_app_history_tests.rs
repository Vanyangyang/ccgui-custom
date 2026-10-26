// A valid, newline-terminated history can exceed the framing cap. Exercise
// actual pipes and the production resume request, with no model/network calls.
#[cfg(windows)]
mod history_tests {
    use super::*;

    fn history_server() -> SpawnedCodex {
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-Command", r#"
            [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
            [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
            while ($null -ne ($line = [Console]::ReadLine())) {
                $request = $line | ConvertFrom-Json
                switch ($request.method) {
                    'initialize' {
                        @{id=$request.id;result=@{userAgent='codex/0.162.1'}} | ConvertTo-Json -Compress
                    }
                    { $_ -in 'thread/resume','thread/fork','thread/read' } {
                        $turns = @()
                        if ($request.params.excludeTurns -ne $true) {
                            $turns = @(@{id='old-turn';items=@(@{type='agentMessage';text=('x' * (17 * 1024 * 1024))})})
                        }
                        @{id=$request.id;result=@{thread=@{id='thread';turns=$turns};model='fixture-model';reasoningEffort='high';approvalPolicy='never';sandbox=@{type='dangerFullAccess'}}} | ConvertTo-Json -Compress -Depth 12
                    }
                    'turn/start' {
                        @{id=$request.id;result=@{turn=@{id='new-turn'}}} | ConvertTo-Json -Compress -Depth 8
                        '{"method":"item/agentMessage/delta","params":{"threadId":"thread","turnId":"new-turn","itemId":"answer","delta":"fresh response"}}'
                        '{"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"new-turn","status":"completed"}}}'
                        exit
                    }
                }
            }
        "#]);
        spawn_app_server(&mut command, &std::env::temp_dir()).unwrap()
    }

    #[tokio::test]
    async fn long_history_resume_reaches_new_turn_without_hydrating_old_turns() {
        let (core, _, emitter) = test_core();
        let mut spawned = history_server();
        let mut req = auto_request();
        req.session_id = Some("thread".into());
        req.permission = Some("bypass".into());
        req.model = None;
        let mut state = TurnState::new(req.session_id.clone());
        let mut view = TurnView::default();
        let result = handshake_and_turn(&mut spawned.server, &core, &mut state,
            &mut view, &req, &Arc::new(AtomicBool::new(false)), None).await;
        teardown(&mut spawned.child).await;
        result.expect("resume must exclude old turns, even when their valid JSON is larger than 16 MiB");
        assert_eq!(state.native_session_id.as_deref(), Some("thread"));
        let events = flushed(&core, &emitter);
        for (kind, text) in [("model", "fixture-model"), ("effort", "high"), ("delta", "fresh response")] {
            assert!(events.iter().any(|(k, value)| k == kind && value.to_string().contains(text)), "missing {kind}");
        }
        assert!(!state.saw_error);
    }

    #[tokio::test]
    async fn long_history_sidechat_fork_uses_metadata_only_for_both_persistence_modes() {
        for ephemeral in [true, false] {
            let mut spawned = history_server();
            let params = sidechat_codex::fork_params("parent-thread", ephemeral);
            let key = spawned.server.request("thread/fork", params).await.unwrap();
            let result = spawned.server.pump("thread/fork", Expect::Reply(&key),
                Some(Instant::now() + Duration::from_secs(15)), &AtomicBool::new(false),
                None, &mut |_| Handled::Ignore).await;
            teardown(&mut spawned.child).await;
            let reply = result.expect("fork must exclude copied history").unwrap();
            assert_eq!(reply["thread"]["turns"], json!([]));
            assert_eq!(reply["thread"]["id"], "thread");
            assert_eq!(reply["model"], "fixture-model");
            assert_eq!(reply["reasoningEffort"], "high");
        }
    }

    #[tokio::test]
    async fn oversized_valid_history_remains_bounded_with_rpc_context() {
        let mut spawned = history_server();
        let key = spawned.server.request("thread/read", json!({"threadId":"thread"})).await.unwrap();
        let result = spawned.server.pump("thread/read", Expect::Reply(&key),
            Some(Instant::now() + Duration::from_secs(15)), &AtomicBool::new(false),
            None, &mut |_| Handled::Ignore).await;
        teardown(&mut spawned.child).await;
        let error = result.unwrap_err();
        assert!(error.contains("thread/read"), "{error}");
        assert!(error.contains("16 MiB"), "{error}");
        assert!(!error.contains("without a newline"), "a complete large JSON line is valid: {error}");
        assert!(spawned.server.line_buf.len() <= MAX_LINE_BYTES);
    }
}
