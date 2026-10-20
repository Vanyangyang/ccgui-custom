// App-server multiplexes subagent threads onto the parent's connection.
// These fixtures reproduce a child finishing while the parent still has work.
mod isolation_tests {
    use super::*;

    fn active_view() -> TurnView {
        TurnView {
            accepting_approvals: true,
            turn_id: Some("parent-turn".into()),
            plan_mode: true,
            ..TurnView::default()
        }
    }

    #[tokio::test]
    async fn child_and_stale_turn_notifications_cannot_change_or_end_parent() {
        for (thread, turn) in [("child", "child-turn"), ("parent", "old-turn")] {
            let (core, _, emitter) = test_core();
            let mut state = TurnState::new(Some("parent".into()));
            let mut view = active_view();
            view.last_usage = Some(json!({"output_tokens":17}));
            for (method, extra) in [
                ("turn/started", json!({"turn":{"id":turn}})),
                ("item/agentMessage/delta", json!({"itemId":"m","delta":"foreign answer"})),
                ("item/reasoning/textDelta", json!({"itemId":"r","delta":"foreign reasoning"})),
                ("item/reasoning/summaryTextDelta", json!({"itemId":"r","delta":"foreign summary"})),
                ("item/started", json!({"item":{"id":"tool","type":"mcpToolCall","tool":"inspect_local_file"}})),
                ("item/completed", json!({"item":{"id":"m","type":"agentMessage","text":"foreign final"}})),
                ("item/plan/delta", json!({"itemId":"p","delta":"foreign plan"})),
                ("thread/tokenUsage/updated", json!({"tokenUsage":{"last":{"outputTokens":471}}})),
                ("error", json!({"error":{"message":"foreign error"},"willRetry":true})),
                ("turn/completed", json!({"turn":{"id":turn,"status":"completed"}})),
                ("turn/failed", json!({"turn":{"id":turn,"status":"failed","error":{"message":"foreign failure"}}})),
            ] {
                let mut params = extra;
                params["threadId"] = json!(thread);
                // Turn lifecycle events carry the ID inside turn, not turnId.
                if !matches!(method, "turn/started" | "turn/completed" | "turn/failed") {
                    params["turnId"] = json!(turn);
                }
                assert!(matches!(route(&core, &mut state, &mut view,
                    &json!({"method":method,"params":params})), Handled::Ignore),
                    "{method} from {thread}/{turn} must not end the parent");
                assert_eq!(view.turn_id.as_deref(), Some("parent-turn"), "{method}");
            }
            assert_eq!(state.native_session_id.as_deref(), Some("parent"));
            assert_eq!(view.last_usage, Some(json!({"output_tokens":17})));
            assert!(view.accepting_approvals);
            assert!(!state.saw_error && !state.saw_done);
            assert!(flushed(&core, &emitter).is_empty(), "foreign output must not reach the parent UI");
        }
    }

    #[tokio::test]
    async fn thread_started_notification_cannot_adopt_a_child_identity() {
        for initial in [None, Some("parent".to_string())] {
            let (core, _, emitter) = test_core();
            let mut state = TurnState::new(initial.clone());
            let mut view = active_view();
            route(&core, &mut state, &mut view,
                &json!({"method":"thread/started","params":{"thread":{"id":"child"}}}));
            assert_eq!(state.native_session_id, initial);
            assert!(flushed(&core, &emitter).is_empty());
        }
    }

    #[tokio::test]
    async fn resume_replay_cannot_end_a_turn_before_its_start_or_replace_usage() {
        let (core, _, emitter) = test_core();
        let mut state = TurnState::new(Some("parent".into()));
        let mut view = TurnView::default();
        for method in ["turn/started", "turn/completed"] {
            assert!(matches!(route(&core, &mut state, &mut view,
                &json!({"method":method,"params":{"threadId":"parent","turn":{"id":"old-turn","status":"completed"}}})),
                Handled::Ignore));
        }
        route(&core, &mut state, &mut view,
            &json!({"method":"thread/tokenUsage/updated","params":{"threadId":"parent","turnId":"old-turn","tokenUsage":{"total":{"outputTokens":100},"last":{"outputTokens":40}}}}));
        view.throughput.begin("parent", false);
        view.throughput.acknowledge(Some("parent-turn"));
        assert_eq!(view.turn_id, None);
        assert_eq!(view.last_usage, None);
        assert!(flushed(&core, &emitter).is_empty());
        // Restored totals remain valid as the independent throughput baseline.
        view.throughput.observe("thread/tokenUsage/updated", &json!({"threadId":"parent","turnId":"parent-turn","tokenUsage":{"total":{"outputTokens":120}}}));
        assert_eq!(view.throughput.finish(false).unwrap()["outputTokens"], 20);
    }

    #[tokio::test]
    async fn child_questions_are_answered_without_parking_on_parent() {
        let (core, registry, emitter) = test_core();
        let mut state = TurnState::new(Some("parent".into()));
        let mut view = active_view();
        for (thread, turn) in [("child", "child-turn"), ("parent", "old-turn")] {
            let result = route(&core, &mut state, &mut view, &json!({
                "id":99,"method":"item/tool/requestUserInput","params":{
                    "threadId":thread,"turnId":turn,"itemId":"q",
                    "questions":[{"id":"q1","question":"Foreign question?","options":[{"label":"Yes"}]}]
                }
            }));
            let Handled::Answer(frame) = result else { panic!("foreign request must be answered, not parked") };
            assert_eq!(frame["id"], 99);
            assert_eq!(frame["result"], json!({"answers":{}}));
        }
        assert!(registry.get("test-run").unwrap().questions.lock().unwrap().is_empty());
        assert!(flushed(&core, &emitter).is_empty());
    }

    #[tokio::test]
    async fn bound_parent_can_finish_but_unidentified_completion_cannot() {
        let (core, _, emitter) = test_core();
        let mut state = TurnState::new(Some("parent".into()));
        let mut view = TurnView { accepting_approvals:true, ..TurnView::default() };
        for params in [json!({}), json!({"threadId":"parent","turn":{"id":"old-turn","status":"completed"}})] {
            assert!(matches!(route(&core, &mut state, &mut view,
                &json!({"method":"turn/completed","params":params})), Handled::Ignore));
        }
        route(&core, &mut state, &mut view,
            &json!({"method":"turn/started","params":{"threadId":"parent","turn":{"id":"parent-turn"}}}));
        assert!(view.turn_id.is_none(), "a notification cannot substitute for the start reply");
        view.turn_id = Some("parent-turn".into());
        assert!(matches!(route(&core, &mut state, &mut view,
            &json!({"method":"turn/completed","params":{"threadId":"parent","turn":{"id":"parent-turn","status":"completed"}}})), Handled::Ended));
        assert!(!view.accepting_approvals);
        assert!(flushed(&core, &emitter).is_empty());
    }

    #[tokio::test]
    async fn interrupted_parent_settles_once_and_removes_its_registry_entry() {
        let (core, registry, emitter) = test_core();
        let mut state = TurnState::new(Some("parent".into()));
        let mut view = active_view();
        let killed = registry.get("test-run").unwrap().killed;
        killed.store(true, Ordering::SeqCst);
        assert!(matches!(route(&core, &mut state, &mut view,
            &json!({"method":"turn/completed","params":{"threadId":"child","turn":{"id":"child-turn","status":"interrupted"}}})), Handled::Ignore));
        assert!(matches!(route(&core, &mut state, &mut view,
            &json!({"method":"turn/completed","params":{"threadId":"parent","turn":{"id":"parent-turn","status":"interrupted"}}})), Handled::Ended));
        settle(&core, &mut state, &mut view, Ok(()), &killed, 4_000_000_099, Some("parent".into())).await;
        let events = flushed(&core, &emitter);
        assert_eq!(events.iter().filter(|(kind, _)| matches!(kind.as_str(), "done" | "error")).map(|(kind, _)| kind.as_str()).collect::<Vec<_>>(), ["done"]);
        assert!(registry.get("test-run").is_none());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn child_completion_before_start_ack_keeps_pumping_until_parent_completion() {
        let (core, _, emitter) = test_core();
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-Command", r#"
            [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
            [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
            $start = [Console]::ReadLine() | ConvertFrom-Json
            '{"method":"turn/started","params":{"threadId":"parent","turn":{"id":"old-turn"}}}'
            '{"method":"turn/completed","params":{"threadId":"parent","turn":{"id":"old-turn","status":"completed"}}}'
            '{"method":"turn/started","params":{"threadId":"parent","turn":{"id":"parent-turn"}}}'
            '{"method":"turn/completed","params":{"threadId":"child","turn":{"id":"child-turn","status":"completed"}}}'
            @{id=$start.id;result=@{turn=@{id='parent-turn'}}} | ConvertTo-Json -Compress -Depth 10
            '{"method":"item/agentMessage/delta","params":{"threadId":"child","turnId":"child-turn","itemId":"m","delta":"child final"}}'
            '{"method":"thread/tokenUsage/updated","params":{"threadId":"child","turnId":"child-turn","tokenUsage":{"total":{"outputTokens":471},"last":{"outputTokens":471}}}}'
            '{"method":"turn/completed","params":{"threadId":"child","turn":{"id":"child-turn","status":"completed"}}}'
            '{"method":"item/agentMessage/delta","params":{"threadId":"parent","turnId":"parent-turn","itemId":"m","delta":"parent continues"}}'
            '{"method":"thread/tokenUsage/updated","params":{"threadId":"parent","turnId":"parent-turn","tokenUsage":{"total":{"outputTokens":17},"last":{"outputTokens":17}}}}'
            '{"method":"turn/completed","params":{"threadId":"parent","turn":{"id":"parent-turn","status":"completed","durationMs":1000}}}'
        "#]);
        let mut spawned = spawn_app_server(&mut command, &std::env::temp_dir()).unwrap();
        let killed = Arc::new(AtomicBool::new(false));
        let mut state = TurnState::new(Some("parent".into()));
        let mut view = TurnView::default();
        view.throughput.begin("parent", true);
        let reply = start_requested_turn(&mut spawned.server, &core, &mut state, &mut view,
            json!({"threadId":"parent","input":[]}), Duration::from_secs(10), &killed).await;
        // Tear down even when the regression fires, so the test owns its child.
        if !matches!(&reply, Ok(Some(_))) {
            teardown(&mut spawned.child).await;
            panic!("child or stale completion swallowed the parent start acknowledgement");
        }
        assert_eq!(reply.unwrap().unwrap().turn_id.as_deref(), Some("parent-turn"));
        let result = spawned.server.pump("turn fixture", Expect::Turn,
            Some(Instant::now() + Duration::from_secs(10)), &killed, None,
            &mut |value| route(&core, &mut state, &mut view, value)).await;
        teardown(&mut spawned.child).await;
        result.unwrap();
        assert_eq!(view.last_usage.as_ref().unwrap()["output_tokens"], 17);
        assert_eq!(view.last_usage.as_ref().unwrap()["usage_scope"], "last_request");
        assert_eq!(
            view.turn_throughput,
            Some(json!({ "output_tokens": 17, "elapsed_ms": 1000 }))
        );
        let events = flushed(&core, &emitter);
        let text: Vec<_> = events.iter().filter(|(kind, _)| kind == "delta").map(|(_, data)| data.clone()).collect();
        assert_eq!(text, vec![json!("parent continues")]);
        assert!(events.iter().any(|(kind, data)| kind == "throughput" && data["status"] == "complete" && data["outputTokens"] == 17));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn fast_parent_completion_before_ack_is_replayed_with_resumed_baseline() {
        let (core, _, emitter) = test_core();
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-Command", r#"
            [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
            [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
            $start = [Console]::ReadLine() | ConvertFrom-Json
            '{"method":"thread/tokenUsage/updated","params":{"threadId":"parent","turnId":"old-turn","tokenUsage":{"total":{"outputTokens":100},"last":{"outputTokens":40}}}}'
            '{"method":"turn/started","params":{"threadId":"parent","turn":{"id":"parent-turn"}}}'
            '{"method":"item/agentMessage/delta","params":{"threadId":"parent","turnId":"parent-turn","itemId":"m","delta":"fast parent"}}'
            '{"method":"thread/tokenUsage/updated","params":{"threadId":"parent","turnId":"parent-turn","tokenUsage":{"total":{"outputTokens":117},"last":{"outputTokens":17}}}}'
            '{"method":"turn/completed","params":{"threadId":"parent","turn":{"id":"parent-turn","status":"completed","durationMs":1000}}}'
            @{id=$start.id;result=@{turn=@{id='parent-turn'}}} | ConvertTo-Json -Compress -Depth 10
        "#]);
        let mut spawned = spawn_app_server(&mut command, &std::env::temp_dir()).unwrap();
        let mut state = TurnState::new(Some("parent".into()));
        let mut view = TurnView::default();
        view.throughput.begin("parent", false);
        let result = start_requested_turn(&mut spawned.server, &core, &mut state, &mut view,
            json!({"threadId":"parent","input":[]}), Duration::from_secs(10), &AtomicBool::new(false)).await;
        teardown(&mut spawned.child).await;
        assert!(result.unwrap().is_none(), "the acknowledged parent already completed");
        assert_eq!(view.last_usage.as_ref().unwrap()["output_tokens"], 17);
        assert_eq!(view.last_usage.as_ref().unwrap()["usage_scope"], "last_request");
        assert_eq!(
            view.turn_throughput,
            Some(json!({ "output_tokens": 17, "elapsed_ms": 1000 }))
        );
        let events = flushed(&core, &emitter);
        assert!(events.iter().any(|(kind, data)| kind == "delta" && data == "fast parent"));
        assert!(events.iter().any(|(kind, data)| kind == "throughput" && data["status"] == "complete" && data["outputTokens"] == 17));
    }

    #[tokio::test]
    async fn settled_done_usage_keeps_last_occupancy_separate_from_verified_turn_throughput() {
        // 【Codex多请求回归】last 请求输出 90、本轮累计输出 6000 / 300000ms 时，Done 载荷同时保留 last_request 占用与整轮吞吐统计。
        let (core, _, emitter) = test_core();
        let mut state = TurnState::new(Some("parent".into()));
        let mut view = active_view();
        view.throughput.begin("parent", true);
        view.throughput.acknowledge(Some("parent-turn"));
        route(&core, &mut state, &mut view, &json!({
            "method": "thread/tokenUsage/updated",
            "params": {
                "threadId": "parent",
                "turnId": "parent-turn",
                "tokenUsage": {
                    "total": { "outputTokens": 5910 },
                    "last": { "inputTokens": 40_000, "cachedInputTokens": 32_000, "outputTokens": 1200, "totalTokens": 41_200 }
                }
            }
        }));
        route(&core, &mut state, &mut view, &json!({
            "method": "thread/tokenUsage/updated",
            "params": {
                "threadId": "parent",
                "turnId": "parent-turn",
                "tokenUsage": {
                    "total": { "outputTokens": 6000 },
                    "last": { "inputTokens": 45_000, "cachedInputTokens": 36_000, "outputTokens": 90, "totalTokens": 45_090 }
                }
            }
        }));
        route(&core, &mut state, &mut view, &json!({
            "method": "turn/completed",
            "params": {
                "threadId": "parent",
                "turn": { "id": "parent-turn", "status": "completed", "durationMs": 300_000 }
            }
        }));
        let killed = Arc::new(AtomicBool::new(false));
        settle(&core, &mut state, &mut view, Ok(()), &killed, 4_000_000_099, Some("parent".into())).await;
        let events = flushed(&core, &emitter);
        let done_usage = events.iter()
            .find_map(|(kind, data)| (kind == "done").then(|| data["usage"].clone()))
            .expect("done event with usage");
        assert_eq!(done_usage["usage_scope"], json!("last_request"));
        assert_eq!(done_usage["output_tokens"], json!(90));
        assert_eq!(
            done_usage["turn_throughput"],
            json!({ "output_tokens": 6000, "elapsed_ms": 300_000 })
        );

        // 【Codex缺基线回归】恢复会话缺少基线时不附加 turn_throughput，避免伪造整轮效率。
        let (core_missing, _, emitter_missing) = test_core();
        let mut state_missing = TurnState::new(Some("parent".into()));
        let mut view_missing = active_view();
        view_missing.throughput.begin("parent", false);
        view_missing.throughput.acknowledge(Some("parent-turn"));
        route(&core_missing, &mut state_missing, &mut view_missing, &json!({
            "method": "thread/tokenUsage/updated",
            "params": {
                "threadId": "parent",
                "turnId": "parent-turn",
                "tokenUsage": {
                    "total": { "outputTokens": 6000 },
                    "last": { "inputTokens": 45_000, "outputTokens": 90, "totalTokens": 45_090 }
                }
            }
        }));
        route(&core_missing, &mut state_missing, &mut view_missing, &json!({
            "method": "turn/completed",
            "params": {
                "threadId": "parent",
                "turn": { "id": "parent-turn", "status": "completed", "durationMs": 300_000 }
            }
        }));
        settle(&core_missing, &mut state_missing, &mut view_missing, Ok(()), &killed, 4_000_000_099, Some("parent".into())).await;
        let missing_events = flushed(&core_missing, &emitter_missing);
        let missing_usage = missing_events.iter()
            .find_map(|(kind, data)| (kind == "done").then(|| data["usage"].clone()))
            .expect("done event with usage");
        assert_eq!(missing_usage["usage_scope"], json!("last_request"));
        assert_eq!(missing_usage["output_tokens"], json!(90));
        assert!(missing_usage.get("turn_throughput").is_none());
    }
}
