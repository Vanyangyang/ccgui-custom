#[cfg(windows)]
mod model_attribution_tests {
    use super::*;

    #[tokio::test]
    async fn resumed_thread_model_cannot_override_the_explicit_turn_model() {
        for (requested, permission) in [
            (Some("gpt-6.1-sol"), Some("bypass")),
            (Some("gpt-6.1-sol"), Some("plan")),
            (None, Some("bypass")),
        ] {
            let (core, _, emitter) = test_core();
            let expected = requested.unwrap_or("gpt-6.1-terra");
            let mut command = Command::new("powershell.exe");
            command.env("CCGUI_MODEL_TEST_REQUEST", requested.unwrap_or(""));
            command.args(["-NoProfile", "-NonInteractive", "-Command", r#"
                [Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
                [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
                while ($null -ne ($line = [Console]::ReadLine())) {
                    $request = $line | ConvertFrom-Json
                    if ($null -eq $request.id) { continue }
                    switch ($request.method) {
                        'initialize' {
                            @{id=$request.id;result=@{userAgent='codex/0.162.1'}} | ConvertTo-Json -Compress
                        }
                        'thread/resume' {
                            if ($request.params.model -ne $env:CCGUI_MODEL_TEST_REQUEST -and $env:CCGUI_MODEL_TEST_REQUEST) {
                                @{id=$request.id;error=@{message='wrong resume model'}} | ConvertTo-Json -Compress -Depth 5
                                exit
                            }
                            @{id=$request.id;result=@{thread=@{id='thread'};model='gpt-6.1-terra';reasoningEffort='high'}} | ConvertTo-Json -Compress -Depth 8
                        }
                        'turn/start' {
                            $actual = $request.params.model
                            if ($request.params.collaborationMode) { $actual = $request.params.collaborationMode.settings.model }
                            if ($env:CCGUI_MODEL_TEST_REQUEST -and $actual -ne $env:CCGUI_MODEL_TEST_REQUEST) {
                                @{id=$request.id;error=@{message='wrong turn model'}} | ConvertTo-Json -Compress -Depth 5
                                exit
                            }
                            @{id=$request.id;result=@{turn=@{id='new-turn'}}} | ConvertTo-Json -Compress -Depth 8
                            exit
                        }
                    }
                }
            "#]);
            let mut spawned = spawn_app_server(&mut command, &std::env::temp_dir()).unwrap();
            let mut req = desktop_request();
            req.session_id = Some("thread".into());
            req.model = requested.map(str::to_string);
            req.permission = permission.map(str::to_string);
            let mut state = TurnState::new(req.session_id.clone());
            let mut view = TurnView::default();
            let result = handshake_and_start(&mut spawned.server, &core, &mut state, &mut view,
                &req, &Arc::new(AtomicBool::new(false)), None, Duration::from_secs(10)).await;
            teardown(&mut spawned.child).await;
            result.expect("fixture must accept the intended turn/start model");
            let models = flushed(&core, &emitter).into_iter()
                .filter(|(kind, _)| kind == "model").map(|(_, value)| value).collect::<Vec<_>>();
            assert_eq!(models, vec![json!(expected)], "attribute usage to this turn, not the prior thread model");
        }
    }
}

