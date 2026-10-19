#[cfg(windows)]
mod timeout_tests {
    use super::*;

    // A real pipe, with no model or network dependency. Ready is read before
    // pausing Tokio time so process startup cannot race virtual deadlines.
    async fn echo_server() -> SpawnedCodex {
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-Command", r#"
            [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
            [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
            [Console]::WriteLine('{"id":"ready","result":{}}')
            while ($null -ne ($line = [Console]::ReadLine())) {
                if ($line -eq 'close') { break }
                $frame = $line | ConvertFrom-Json
                if ($frame.method -eq 'turn/interrupt') {
                    @{method='fixture/interrupt';params=$frame.params} | ConvertTo-Json -Compress
                } else { [Console]::WriteLine($line) }
            }
        "#]);
        let mut spawned = spawn_app_server(&mut command, &std::env::temp_dir()).unwrap();
        spawned.server.pump(
            "ready", Expect::Reply("ready"), Some(Instant::now() + Duration::from_secs(10)),
            &AtomicBool::new(false), None, &mut |_| Handled::Ignore,
        ).await.unwrap();
        spawned
    }

    async fn write_frame(stdin: &Arc<TokioMutex<Option<ChildStdin>>>, frame: &Value) {
        let mut lock = stdin.lock().await;
        let pipe = lock.as_mut().unwrap();
        pipe.write_all(&encode_ndjson(frame).unwrap()).await.unwrap();
        pipe.flush().await.unwrap();
    }

    #[tokio::test]
    async fn active_turn_streams_and_completes_after_thirty_minutes() {
        let mut spawned = echo_server().await;
        let stdin = Arc::clone(&spawned.server.stdin);
        let (core, _, emitter) = test_core();
        let mut state = TurnState::new(Some("thread".into()));
        let mut view = TurnView { accepting_approvals:true, ..TurnView::default() };
        let killed = Arc::new(AtomicBool::new(false));
        let started = TurnStarted { thread_id: "thread".into(), turn_id: Some("turn".into()) };
        tokio::time::pause();
        let result = {
            let turn = pump_turn_to_end(&mut spawned.server, &core, &mut state, &mut view, &started, &killed);
            tokio::pin!(turn);
            assert!(futures_util::poll!(&mut turn).is_pending());
            tokio::time::advance(Duration::from_secs(31 * 60)).await;
            assert!(futures_util::poll!(&mut turn).is_pending(), "a silent active turn must survive the old limit");
            tokio::time::resume();
            write_frame(&stdin, &json!({"method":"item/agentMessage/delta","params":{"threadId":"thread","turnId":"turn","itemId":"answer","delta":"仍在运行🙂"}})).await;
            write_frame(&stdin, &json!({"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":"completed"}}})).await;
            timeout(Duration::from_secs(5), &mut turn).await.unwrap()
        };
        teardown(&mut spawned.child).await;
        result.unwrap();
        assert!(flushed(&core, &emitter).iter().any(|(kind, data)| kind == "delta" && data.to_string().contains("仍在运行🙂")));
    }

    #[tokio::test]
    async fn active_turn_still_reports_pipe_closure_after_thirty_minutes() {
        let mut spawned = echo_server().await;
        let stdin = Arc::clone(&spawned.server.stdin);
        let (core, _, _) = test_core();
        let mut state = TurnState::new(Some("thread".into()));
        let mut view = TurnView::default();
        let killed = Arc::new(AtomicBool::new(false));
        let started = TurnStarted { thread_id: "thread".into(), turn_id: Some("turn".into()) };
        tokio::time::pause();
        let result = {
            let turn = pump_turn_to_end(&mut spawned.server, &core, &mut state, &mut view, &started, &killed);
            tokio::pin!(turn);
            assert!(futures_util::poll!(&mut turn).is_pending());
            tokio::time::advance(Duration::from_secs(31 * 60)).await;
            assert!(futures_util::poll!(&mut turn).is_pending());
            tokio::time::resume();
            let mut lock = stdin.lock().await;
            lock.as_mut().unwrap().write_all(b"close\n").await.unwrap();
            drop(lock);
            timeout(Duration::from_secs(5), &mut turn).await.unwrap()
        };
        teardown(&mut spawned.child).await;
        assert!(result.unwrap_err().contains("closed stdout"));
    }

    #[tokio::test]
    async fn unbounded_turn_interrupt_still_has_bounded_settle_time() {
        let mut spawned = echo_server().await;
        let killed = AtomicBool::new(false);
        let mut interrupt = None;
        let mut on_message = |value: &Value| {
            if value["method"] == "fixture/interrupt" { interrupt = Some(value["params"].clone()); }
            Handled::Ignore
        };
        tokio::time::pause();
        let result = {
            let turn = spawned.server.pump("turn", Expect::Turn, None, &killed, Some(("thread", "turn")), &mut on_message);
            tokio::pin!(turn);
            assert!(futures_util::poll!(&mut turn).is_pending());
            tokio::time::advance(Duration::from_secs(31 * 60)).await;
            assert!(futures_util::poll!(&mut turn).is_pending());
            killed.store(true, Ordering::SeqCst);
            tokio::time::advance(KILL_POLL).await;
            assert!(futures_util::poll!(&mut turn).is_pending());
            // Let the real fixture echo the interrupt while Tokio time is live.
            tokio::time::resume();
            let stop_started = Instant::now();
            let result = timeout(Duration::from_secs(5), &mut turn).await.unwrap();
            assert!(stop_started.elapsed() < Duration::from_secs(4));
            result
        };
        teardown(&mut spawned.child).await;
        assert_eq!(result.unwrap_err(), CANCELLED);
        assert_eq!(interrupt, Some(json!({"threadId":"thread","turnId":"turn"})));
    }

    #[tokio::test]
    async fn rpc_reply_deadline_is_still_enforced() {
        let mut spawned = echo_server().await;
        let killed = AtomicBool::new(false);
        tokio::time::pause();
        let result = {
            let mut on_message = |_: &Value| Handled::Ignore;
            let reply = spawned.server.pump("initialize", Expect::Reply("missing"), Some(Instant::now() + RPC_HANDSHAKE_TIMEOUT), &killed, None, &mut on_message);
            tokio::pin!(reply);
            assert!(futures_util::poll!(&mut reply).is_pending());
            tokio::time::advance(RPC_HANDSHAKE_TIMEOUT).await;
            reply.await
        };
        tokio::time::resume();
        teardown(&mut spawned.child).await;
        assert_eq!(result.unwrap_err(), "initialize timed out");
    }
}
