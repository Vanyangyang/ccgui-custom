// Included in codex_app::tests to exercise the actual router and stdin pump.

fn auto_view() -> TurnView {
    TurnView {
        auto_review: true,
        accepting_approvals: true,
        turn_id: Some("turn-auto".into()),
        ..TurnView::default()
    }
}

fn auto_request() -> SendRequest {
    SendRequest {
        claude_ultracode: None,
        host_instructions: None,
        session_id: None,
        workspace: std::env::temp_dir(),
        prompt: "fixture".into(),
        images: Vec::new(),
        model: Some("fixture-model".into()),
        effort: None,
        service_tier: None,
        permission: Some("auto".into()),
        additional_dirs: Vec::new(),
        provider_id: None,
        computer_use: None,
        allowed_tools: None,
    }
}

fn auto_review_params(id: &str, status: &str) -> Value {
    json!({"threadId":"thread-auto","turnId":"turn-auto","reviewId":id,"targetItemId":null,"startedAtMs":1,
        "review":{"status":status,"riskLevel":"low","userAuthorization":"explicit","rationale":"bounded fixture"},
        "action":{"type":"command","source":"unifiedExec","command":"echo fixture","cwd":"G:/fixture"}})
}

#[tokio::test]
async fn native_auto_review_routing_preserves_decisions_and_rejects_other_turns() {
    let (core, _, emitter) = test_core();
    let mut state = TurnState::new(Some("thread-auto".into()));
    let mut view = auto_view();
    for (method, params) in [
        (
            "item/autoApprovalReview/started",
            auto_review_params("r1", "inProgress"),
        ),
        (
            "item/autoApprovalReview/completed",
            auto_review_params("r1", "denied"),
        ),
        (
            "item/autoApprovalReview/started",
            auto_review_params("r1", "inProgress"),
        ),
        (
            "item/autoApprovalReview/completed",
            auto_review_params("r2", "timedOut"),
        ),
        (
            "item/autoApprovalReview/started",
            auto_review_params("r3", "inProgress"),
        ),
    ] {
        route(
            &core,
            &mut state,
            &mut view,
            &json!({"method":method,"params":params}),
        );
    }
    let mut foreign = auto_review_params("foreign", "approved");
    foreign["turnId"] = json!("old-turn");
    route(
        &core,
        &mut state,
        &mut view,
        &json!({"method":"item/autoApprovalReview/completed","params":foreign}),
    );
    abort_reviews(&core, &mut state, &mut view);
    let reviews = flushed(&core, &emitter)
        .into_iter()
        .filter(|(kind, _)| kind == "auto_review")
        .map(|(_, data)| data)
        .collect::<Vec<_>>();
    assert_eq!(reviews.len(), 5);
    assert_eq!(reviews[1]["review"]["status"], "denied");
    assert_eq!(reviews[2]["review"]["status"], "timedOut");
    assert_eq!(reviews[4]["review"]["status"], "aborted");
    assert!(!view.accepting_approvals);
}

#[tokio::test]
async fn human_fallback_parks_full_context_and_native_resolution_is_shared() {
    let (core, registry, emitter) = test_core();
    let mut state = TurnState::new(Some("thread-auto".into()));
    let mut view = auto_view();
    let params = json!({"threadId":"thread-auto","turnId":"turn-auto","itemId":"same-item","command":"echo fixture","availableDecisions":["accept","decline"]});
    for id in [json!(42), json!("second-callback")] {
        let handled = route(
            &core,
            &mut state,
            &mut view,
            &json!({"id":id,"method":"item/commandExecution/requestApproval","params":params}),
        );
        assert!(matches!(handled, Handled::Parked));
        let context = registry
            .get("test-run")
            .unwrap()
            .questions
            .lock()
            .unwrap()
            .get(&id.to_string())
            .cloned()
            .unwrap();
        assert_eq!(context["codexApproval"]["rpcId"], id);
        assert_eq!(
            context["codexApproval"]["params"]["command"],
            "echo fixture"
        );
        assert_eq!(context["codexApproval"]["card"]["grantScope"], "once");
    }
    let events = flushed(&core, &emitter);
    assert_eq!(
        events.iter().filter(|(kind, _)| kind == "question").count(),
        2
    );
    assert!(events
        .iter()
        .filter(|(kind, _)| kind == "question")
        .all(|(_, data)| data.pointer("/input/codexApproval/rpcId").is_none()));
    registry
        .get("test-run")
        .unwrap()
        .questions
        .lock()
        .unwrap()
        .get_mut("42")
        .unwrap()["codexApproval"]["answered"] = json!({"decision":"allow_once"});
    route(
        &core,
        &mut state,
        &mut view,
        &json!({"method":"serverRequest/resolved","params":{"threadId":"thread-auto","requestId":42}}),
    );
    assert!(!registry
        .get("test-run")
        .unwrap()
        .questions
        .lock()
        .unwrap()
        .contains_key("42"));
    assert!(registry
        .get("test-run")
        .unwrap()
        .questions
        .lock()
        .unwrap()
        .contains_key("\"second-callback\""));
    let events = flushed(&core, &emitter);
    let settled = events
        .iter()
        .find(|(kind, _)| kind == "question_settled")
        .unwrap();
    assert_eq!(settled.1["answers"]["decision"], "allow_once");
    registry.get("test-run").unwrap().questions.lock().unwrap().insert("99".into(),json!({"codexApp":{"rpcId":99,"ids":{}}}));
    route(&core,&mut state,&mut view,&json!({"method":"serverRequest/resolved","params":{"threadId":"thread-auto","requestId":99}}));
    assert!(registry.get("test-run").unwrap().questions.lock().unwrap().contains_key("99"));
    assert!(!flushed(&core,&emitter).iter().any(|(kind,data)|kind=="question_settled"&&data["requestId"]=="99"));
}

#[tokio::test]
async fn approval_context_is_ready_before_the_card_can_be_observed() {
    struct InspectOnPublish {
        registry: Arc<ProcessRegistry>,
        checked: AtomicBool,
    }
    impl Emit for InspectOnPublish {
        fn emit_json(&self, _: &str, raw: &str) {
            let values: Value = serde_json::from_str(raw).unwrap();
            for event in values.as_array().unwrap() {
                if event["kind"] != "question" {
                    continue;
                }
                let request_id = event["data"]["requestId"].as_str().unwrap();
                let entry = self.registry.get("test-run").unwrap();
                let context = entry
                    .questions
                    .lock()
                    .unwrap()
                    .get(request_id)
                    .cloned()
                    .unwrap();
                assert!(context.pointer("/codexApproval/params").is_some());
                assert!(context.pointer("/codexApproval/rpcId").is_some());
                self.checked.store(true, Ordering::SeqCst);
            }
        }
    }
    let (mut core, registry, _) = test_core();
    let inspect = Arc::new(InspectOnPublish {
        registry,
        checked: AtomicBool::new(false),
    });
    core.sink = EventSink::new(inspect.clone());
    let mut state = TurnState::new(Some("thread-auto".into()));
    let mut view = auto_view();
    // Exceeds EventSink's synchronous flush threshold, exercising the exact
    // publication window that used to expose an incomplete parked context.
    let params =
        json!({"threadId":"thread-auto","turnId":"turn-auto","command":"x".repeat(70*1024)});
    route(
        &core,
        &mut state,
        &mut view,
        &json!({"id":1,"method":"item/commandExecution/requestApproval","params":params}),
    );
    assert!(inspect.checked.load(Ordering::SeqCst));
}

#[test]
fn approvals_outside_current_auto_turn_are_declined_without_a_card() {
    let (core, _, emitter) = test_core();
    let mut state = TurnState::new(Some("thread-auto".into()));
    for (auto, accepting, thread, turn) in [
        (false, true, "thread-auto", "turn-auto"),
        (true, false, "thread-auto", "turn-auto"),
        (true, true, "foreign", "turn-auto"),
        (true, true, "thread-auto", "old-turn"),
    ] {
        let mut view = auto_view();
        view.auto_review = auto;
        view.accepting_approvals = accepting;
        let handled = route(
            &core,
            &mut state,
            &mut view,
            &json!({"id":1,"method":"item/commandExecution/requestApproval","params":{"threadId":thread,"turnId":turn,"command":"echo fixture"}}),
        );
        assert!(
            matches!(handled,Handled::Answer(ref result) if result["result"]["decision"]=="decline")
        );
    }
    assert!(flushed(&core, &emitter)
        .iter()
        .all(|(kind, _)| kind != "question"));
}

#[cfg(windows)]
#[tokio::test]
async fn concurrent_human_approval_answers_write_once_and_cancel_blocks_late_reply() {
    let (core, registry, _) = test_core();
    let mut state = TurnState::new(Some("thread-auto".into()));
    let mut view = auto_view();
    let mut command = Command::new("powershell.exe");
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        r#"
        [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
        $line=[Console]::ReadLine()
        [Console]::WriteLine($line)
        Start-Sleep -Seconds 10
    "#,
    ]);
    let mut spawned = spawn_app_server(&mut command, &std::env::temp_dir()).unwrap();
    registry.set_stdin("test-run", Arc::clone(&spawned.server.stdin));
    let params = json!({"threadId":"thread-auto","turnId":"turn-auto","command":"echo fixture"});
    route(
        &core,
        &mut state,
        &mut view,
        &json!({"id":9,"method":"item/commandExecution/requestApproval","params":params}),
    );
    let answer = json!({"decision":"allow_once"});
    let (first, second) = tokio::join!(
        answer_approval(&registry, "test-run", "9", Some(&answer)),
        answer_approval(&registry, "test-run", "9", Some(&answer))
    );
    assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
    assert!(first
        .err()
        .or_else(|| second.err())
        .unwrap()
        .contains("already answered"));
    let line = timeout(
        Duration::from_secs(5),
        read_line_capped(&mut spawned.server.stdout, &mut spawned.server.line_buf),
    )
    .await
    .unwrap()
    .unwrap();
    let LineRead::Line(line) = line else {
        panic!("expected one native response");
    };
    let frame: Value = serde_json::from_slice(&line).unwrap();
    assert_eq!(frame["id"], 9);
    assert_eq!(frame["result"], json!({"decision":"accept"}));
    route(
        &core,
        &mut state,
        &mut view,
        &json!({"id":10,"method":"item/commandExecution/requestApproval","params":params}),
    );
    registry
        .get("test-run")
        .unwrap()
        .killed
        .store(true, Ordering::SeqCst);
    assert!(answer_approval(&registry, "test-run", "10", Some(&answer))
        .await
        .unwrap_err()
        .contains("cancelled"));
    teardown(&mut spawned.child).await;
}

#[cfg(windows)]
#[tokio::test]
async fn auto_handshake_verifies_actual_capability_before_new_or_resumed_turn() {
    for (resume, feature, reviewer) in [
        (false, true, "auto_review"),
        (true, true, "auto_review"),
        (false, false, "auto_review"),
        (false, true, "user"),
    ] {
        let directory =
            std::env::temp_dir().join(format!("ccgui-auto-fixture-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let log = directory.join("requests.jsonl");
        let mut command = Command::new("powershell.exe");
        command
            .env("CCGUI_TEST_LOG", &log)
            .env("CCGUI_TEST_FEATURE", if feature { "true" } else { "false" })
            .env("CCGUI_TEST_REVIEWER", reviewer);
        command.args(["-NoProfile","-NonInteractive","-Command",r#"
            [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
            while ($line=[Console]::ReadLine()) {
                [IO.File]::AppendAllText($env:CCGUI_TEST_LOG,$line+[Environment]::NewLine)
                $request=$line|ConvertFrom-Json
                $reply=switch($request.method) {
                    'initialize' { @{userAgent='codex/0.159.2'} }
                    'thread/start' { @{thread=@{id='thread-auto'};approvalPolicy='on-request';approvalsReviewer=$env:CCGUI_TEST_REVIEWER;sandbox=@{type='workspaceWrite'};model='fixture-model'} }
                    'thread/resume' { @{thread=@{id='thread-auto'};approvalPolicy='on-request';approvalsReviewer=$env:CCGUI_TEST_REVIEWER;sandbox=@{type='workspaceWrite'};model='fixture-model'} }
                    'experimentalFeature/list' { @{data=@(@{name='guardian_approval';enabled=($env:CCGUI_TEST_FEATURE -eq 'true')});nextCursor=$null} }
                    'turn/start' { @{turn=@{id='turn-auto'}} }
                    default { @{} }
                }
                @{id=$request.id;result=$reply}|ConvertTo-Json -Compress -Depth 30
            }
        "#]);
        let (core, _, _) = test_core();
        let mut state = TurnState::new(None);
        let mut view = TurnView::default();
        let mut req = auto_request();
        if resume {
            req.session_id = Some("thread-auto".into());
        }
        let killed = Arc::new(AtomicBool::new(false));
        let mut spawned = spawn_app_server(&mut command, &directory).unwrap();
        let result = handshake_and_start(
            &mut spawned.server,
            &core,
            &mut state,
            &mut view,
            &req,
            &killed,
            None,
            Duration::from_secs(8),
        )
        .await;
        teardown(&mut spawned.child).await;
        let requests = std::fs::read_to_string(&log)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        let thread = requests
            .iter()
            .find(|value| {
                value["method"]
                    == if resume {
                        "thread/resume"
                    } else {
                        "thread/start"
                    }
            })
            .unwrap();
        assert_eq!(thread["params"]["permissions"], ":workspace");
        assert_eq!(thread["params"]["approvalPolicy"], "on-request");
        assert_eq!(thread["params"]["approvalsReviewer"], "auto_review");
        assert!(thread["params"].get("sandbox").is_none());
        if feature && reviewer == "auto_review" {
            assert!(result.is_ok());
            let feature_at = requests
                .iter()
                .position(|value| value["method"] == "experimentalFeature/list")
                .unwrap();
            let turn_at = requests
                .iter()
                .position(|value| value["method"] == "turn/start")
                .unwrap();
            assert!(feature_at < turn_at);
            assert_eq!(view.turn_id.as_deref(), Some("turn-auto"));
        } else {
            assert!(result
                .err()
                .unwrap()
                .starts_with(codex_auto_review::UNAVAILABLE));
            assert!(requests.iter().all(|value| value["method"] != "turn/start"));
        }
        std::fs::remove_dir_all(directory).unwrap();
    }
}

/// Opt-in live acceptance through CCGUI's actual driver. This calls the real
/// model once and writes one authorized marker outside a dedicated workspace.
/// It never approves fallback requests automatically or changes user config.
#[tokio::test]
#[ignore = "requires a signed-in Codex CLI and CCGUI_AUTO_REVIEW_SMOKE=1; uses model quota"]
async fn real_codex_auto_review_approves_only_the_authorized_smoke_write() {
    assert_eq!(std::env::var("CCGUI_AUTO_REVIEW_SMOKE").as_deref(), Ok("1"));
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("artifacts/codex-autoreview-smoke");
    let run = root.join(uuid::Uuid::new_v4().to_string());
    let workspace = run.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let output = run.join("authorized-marker.txt");
    let marker = format!("ccgui-auto-review-{}", uuid::Uuid::new_v4());
    let (core, _, emitter) = test_core();
    let mut req = auto_request();
    req.workspace = workspace.clone();
    req.model = Some("gpt-6-astra".into());
    req.effort = Some("medium".into());
    req.service_tier = Some("default".into());
    req.prompt=format!("This is an authorized CCGUI Auto-review integration test. Your only task is to write exactly {marker} into the new file {} outside the current workspace {}. Use the shell tool with sandbox_permissions=require_escalated so the native automatic reviewer evaluates this exact write. The user explicitly authorizes only this harmless marker write. Do not read other files, use MCP tools, browse, spawn agents, change configuration, or perform any other mutation. If approval is denied or unavailable, stop and report it; do not work around it. After the write, respond only SMOKE_OK.", output.display(),workspace.display());
    let bin =
        super::super::resolve::find_cli_binary("codex", None).expect("Codex CLI must be installed");
    let built = super::super::codex::CodexEngine
        .host_command(&req, &bin.to_string_lossy())
        .unwrap();
    let killed = Arc::new(AtomicBool::new(false));
    let mut state = TurnState::new(None);
    let mut view = TurnView::default();
    let result = timeout(
        Duration::from_secs(180),
        turn_inner(&core, &mut state, &mut view, &req, built, &killed, None),
    )
    .await;
    let events = flushed(&core, &emitter);
    let reviews = events
        .iter()
        .filter(|(kind, _)| kind == "auto_review")
        .map(|(_, data)| data.clone())
        .collect::<Vec<_>>();
    let errors = events
        .iter()
        .filter(|(kind, _)| kind == "error" || kind == "warn")
        .map(|(kind, data)| json!({"kind":kind,"data":data}))
        .collect::<Vec<_>>();
    let report = json!({"threadId":state.native_session_id,"workspace":workspace,"markerPath":output,"reviews":reviews,"errors":errors,"transportOk":matches!(result,Ok(Ok(()))),"markerMatches":std::fs::read_to_string(&output).is_ok_and(|text|text.trim()==marker)});
    std::fs::write(
        run.join("report.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!(
        "Auto-review smoke report: {}",
        run.join("report.json").display()
    );
    assert!(
        matches!(result, Ok(Ok(()))),
        "native driver did not complete: {result:?}"
    );
    assert!(
        reviews.iter().any(
            |review| review.pointer("/review/status").and_then(Value::as_str) == Some("approved")
        ),
        "the real reviewer did not approve any action"
    );
    assert_eq!(
        report["markerMatches"], true,
        "authorized write did not complete"
    );
    assert!(
        !events.iter().any(|(kind, _)| kind == "question"),
        "smoke requested human approval instead of native Auto-review"
    );
}
