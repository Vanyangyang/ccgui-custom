//! Actual CLI transport, with every process and file owned by TestHarness.
use super::*;
use base64::Engine as _;

const PNG: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==";

fn tasks(fixture: &TestHarness) -> Vec<Value> {
    std::fs::read_to_string(fixture.root().join("ws/claude-tasks.ndjson"))
        .unwrap_or_default()
        .lines()
        .map(|line| {
            serde_json::from_str(line).expect("fake Claude must record complete stdin JSON")
        })
        .collect()
}

fn assert_image_and_text(task: &Value, expected_text: &str) -> String {
    let content = task["message"]["content"]
        .as_array()
        .expect("structured user content");
    let images: Vec<_> = content
        .iter()
        .filter(|item| item["type"] == "image")
        .collect();
    assert_eq!(images.len(), 1, "expected exactly one genuine image block");
    assert_eq!(images[0]["source"]["type"], "base64");
    assert_eq!(images[0]["source"]["media_type"], "image/png");
    assert_eq!(
        images[0]["source"]["data"], PNG,
        "transport must use the captured original image bytes"
    );
    let text = content
        .iter()
        .filter_map(|item| (item["type"] == "text").then(|| item["text"].as_str().unwrap()))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        text.contains(expected_text),
        "original pending requirements were lost: expected={expected_text:?}, received={text:?}"
    );
    text
}

fn cold_cache(state: &AppState, session: &str) {
    // The cache module is crate-private; seed only this fixture's existing
    // persistence contract with unequivocally expired observed evidence.
    state.db.plugin_kv_set(
        "$ccgui-prompt-cache",
        &format!("claude:{session}"),
        &serde_json::json!({"ttlSeconds":1,"startedAt":1,"observedAt":1,"source":"image-fixture"}),
    ).unwrap();
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn native_handoff_and_approval_send_captured_images_once() {
    if !in_coordinator_child(
        "managed_images::native_handoff_and_approval_send_captured_images_once",
    ) {
        return;
    }
    let fixture = TestHarness::new().unwrap();
    let fake_cli = write_fake_cli(&fixture, "claude", false);
    let script = std::fs::read_to_string(&fake_cli).unwrap();
    assert!(script.contains("\"input_tokens\":10"));
    // Do not allow the small-context exemption to hide the review branch.
    let script = script.replace("\"input_tokens\":10", "\"input_tokens\":100000");
    #[cfg(windows)]
    let script = format!("[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)\r\n{script}");
    std::fs::write(&fake_cli, &script).unwrap();
    let workspace_dir = fixture.root().join("ws");
    std::fs::create_dir_all(&workspace_dir).unwrap();
    let workspace = workspace_dir.to_string_lossy().to_string();
    let png = base64::engine::general_purpose::STANDARD
        .decode(PNG)
        .unwrap();
    std::fs::write(workspace_dir.join("spawn.png"), &png).unwrap();
    std::fs::write(workspace_dir.join("pending.png"), &png).unwrap();
    let (app, _events) = build_app(&fixture);
    let state = app.state::<AppState>();
    ccgui_next_lib::leader::prepare_run(&state.db, "schema-only", "pi", None, &workspace, None)
        .unwrap();
    {
        let conn = state.db.0.lock();
        conn.execute(
            "INSERT INTO workspaces(id,path,name) VALUES('fixture-images',?1,'ws')",
            [&workspace],
        )
        .unwrap();
        conn.execute("INSERT INTO sessions(engine,session_id,workspace_path,file_path,file_size,file_mtime_ms) VALUES('claude','image-parent',?1,'fixture',0,0)", [&workspace]).unwrap();
    }
    install_recording_coordinator(state.inner());
    let caller = ccgui_next_lib::leader::Caller {
        run_id: "image-parent-run".into(),
        engine: "claude".into(),
        session_id: "image-parent".into(),
        workspace_path: workspace.clone(),
    };
    let parent = ccgui_next_lib::leader::LeaderIdentity {
        engine: caller.engine.clone(),
        session_id: caller.session_id.clone(),
        workspace_path: workspace.clone(),
    };
    ccgui_next_lib::leader::prepare_run(
        &state.db,
        &caller.run_id,
        &caller.engine,
        Some(&caller.session_id),
        &workspace,
        Some("auto"),
    )
    .unwrap();
    state
        .processes
        .0
        .lock()
        .unwrap()
        .insert(caller.run_id.clone(), routed_entry(&caller.run_id, 4100));
    let dispatch = |method: &'static str, arguments: Value| {
        ccgui_next_lib::leader::dispatch(state.inner(), caller.clone(), method, arguments)
    };

    let spawned = dispatch(
        "task_spawn",
        serde_json::json!({
            "request_id":"image-spawn", "engine":"claude", "title":"Image transport fixture",
            "task":"Original spawn with genuine image", "images":["spawn.png"],
        }),
    )
    .await
    .unwrap();
    let original = spawned["branch"]["id"].as_str().unwrap().to_string();
    let first_run = spawned["branch"]["runId"].as_str().unwrap().to_string();
    wait_until("initial image child retirement", || {
        retired(&first_run) == Some(true)
    })
    .await;
    let first_tasks = tasks(&fixture);
    assert_eq!(first_tasks.len(), 1);
    assert_image_and_text(&first_tasks[0], "Original spawn with genuine image");

    cold_cache(state.inner(), "fake-session-123");
    let pending_text =
        "Pending original requirements 中文 😀: inspect the attached pixels exactly.";
    let held_args = serde_json::json!({
        "branch_id":original, "request_id":"image-held", "message":pending_text, "images":["pending.png"],
    });
    let held = dispatch("task_send", held_args.clone()).await.unwrap();
    assert_eq!(held["status"], "awaiting_cost_approval");
    assert_eq!(held["submitted_to_model"], false);
    assert_eq!(held["mayHaveStarted"], false);
    assert_eq!(
        tasks(&fixture).len(),
        1,
        "held request reached CLI before approval"
    );
    let reviewed_model = held["branch"]["model"].as_str().map(str::to_owned);
    std::fs::write(
        workspace_dir.join("pending.png"),
        b"changed original source",
    )
    .unwrap();
    std::fs::remove_file(workspace_dir.join("pending.png")).unwrap();

    // A fresh successor has a different native session, while the old saved
    // session remains owned by its original physical branch.
    std::fs::write(
        &fake_cli,
        script.replace("fake-session-123", "handoff-successor-id"),
    )
    .unwrap();
    let summary =
        "Verified handoff summary 中文: retain original image and every pending requirement.";
    let provider = serde_json::json!({"baseUrl":"https://handoff-fixture.invalid", "apiKey":"fixture-only", "model":"explicit-handoff-model",
        "settingsConfig":{"env":{"ANTHROPIC_DEFAULT_OPUS_MODEL":"explicit-handoff-model"}}});
    ccgui_next_lib::config::upsert_provider(app.state(), app.state(), "claude".into(), "handoff-channel".into(), provider.clone()).unwrap();
    // This profile belongs exclusively to TestHarness. Reproduce the real
    // allowed-alias/fixed-target mismatch without touching user settings.
    let mut settings = ccgui_next_lib::settings::read_settings().unwrap();
    settings.leader_allowed_models.insert("claude".into(), Some(vec!["opus".into()]));
    ccgui_next_lib::settings::persist_settings(&mut settings).unwrap();
    let requested = serde_json::json!({"engine":"claude", "model":"opus", "providerId":"handoff-channel", "effort":"high"});
    // A fake CLI has no embedded model registry; give its isolated native
    // profile an explicit alias mapping rather than inventing a production default.
    std::fs::write(fixture.root().join(".claude/settings.json"),
        r#"{"env":{"ANTHROPIC_DEFAULT_OPUS_MODEL":"official-fixture-opus"}}"#).unwrap();
    let mut official = requested.clone();
    official["providerId"] = serde_json::json!("__local_settings_json__");
    let official = ccgui_next_lib::leader::test_resolve_handoff_selection(official).await.unwrap();
    assert_eq!(official["model"], "official-fixture-opus");
    assert_eq!(official["providerId"], "__local_settings_json__");
    let selected = ccgui_next_lib::leader::test_resolve_handoff_selection(requested.clone()).await.unwrap();
    assert_eq!(selected["model"], "explicit-handoff-model");
    ccgui_next_lib::config::set_engine_enabled(app.state(), app.state(), "claude".into(), false).unwrap();
    assert_eq!(ccgui_next_lib::leader::test_resolve_handoff_selection(selected.clone()).await.unwrap_err(), "HANDOFF_TARGET_UNAVAILABLE");
    ccgui_next_lib::config::set_engine_enabled(app.state(), app.state(), "claude".into(), true).unwrap();
    let mut changed_provider = provider.clone();
    changed_provider["settingsConfig"]["env"]["ANTHROPIC_DEFAULT_OPUS_MODEL"] = serde_json::json!("other-fixed-opus");
    ccgui_next_lib::config::upsert_provider(app.state(), app.state(), "claude".into(), "handoff-channel".into(), changed_provider).unwrap();
    assert_eq!(ccgui_next_lib::leader::test_human_handoff_with_selection(state.inner(), &parent, &original,
        "image-held", "fake-session-123", reviewed_model.as_deref(), "changed-policy-operation", summary,
        selected.clone()).await.unwrap_err(), "HANDOFF_TARGET_NOT_ALLOWED");
    ccgui_next_lib::config::upsert_provider(app.state(), app.state(), "claude".into(), "handoff-channel".into(), provider).unwrap();
    let mut invalid = requested.clone();
    invalid["effort"] = serde_json::json!("default");
    assert_eq!(ccgui_next_lib::leader::test_resolve_handoff_selection(invalid).await.unwrap_err(), "HANDOFF_TARGET_INVALID");
    let mut not_allowed = selected.clone();
    not_allowed["model"] = serde_json::json!("another-fixed-model");
    assert_eq!(ccgui_next_lib::leader::test_resolve_handoff_selection(not_allowed).await.unwrap_err(), "HANDOFF_TARGET_NOT_ALLOWED");
    assert_eq!(ccgui_next_lib::leader::test_human_handoff_with_selection(state.inner(), &parent, &original,
        "image-held", "fake-session-123", reviewed_model.as_deref(), "changed-target-operation", summary,
        requested).await.unwrap_err(), "HANDOFF_TARGET_CHANGED");
    let mut unavailable = selected.clone();
    unavailable["providerId"] = serde_json::json!("missing-handoff-channel");
    assert_eq!(ccgui_next_lib::leader::test_human_handoff_with_selection(state.inner(), &parent, &original,
        "image-held", "fake-session-123", reviewed_model.as_deref(), "invalid-target-operation", summary,
        unavailable).await.unwrap_err(), "HANDOFF_TARGET_RESOLUTION_FAILED");
    assert_eq!(tasks(&fixture).len(), 1, "invalid target must not launch or consume the held task");
    let successor_script = std::fs::read_to_string(&fake_cli).unwrap();
    #[cfg(windows)]
    let successor_script = format!("[IO.File]::WriteAllText('handoff-provider.txt', $env:ANTHROPIC_BASE_URL)\r\n{successor_script}");
    #[cfg(unix)]
    let successor_script = successor_script.replacen("#!/bin/sh\n", "#!/bin/sh\nprintf '%s' \"$ANTHROPIC_BASE_URL\" > handoff-provider.txt\n", 1);
    std::fs::write(&fake_cli, successor_script).unwrap();
    let handed = ccgui_next_lib::leader::test_human_handoff_with_selection(
        state.inner(),
        &parent,
        &original,
        "image-held",
        "fake-session-123",
        reviewed_model.as_deref(),
        "image-operation",
        summary,
        selected.clone(),
    )
    .await
    .unwrap();
    let old = handed
        .branches
        .iter()
        .find(|branch| branch.id == original)
        .unwrap();
    assert_eq!(old.state, "handed_off");
    let successor_id = old.handoff_to.as_ref().unwrap().branch_id.clone();
    let successor = handed
        .branches
        .iter()
        .find(|branch| branch.id == successor_id)
        .unwrap();
    assert_eq!(successor.parent_session_id, parent.session_id);
    assert_eq!(successor.provider_id.as_deref(), Some("handoff-channel"));
    assert_eq!(successor.model.as_deref(), Some("explicit-handoff-model"));
    assert_eq!(successor.handoff_from.as_ref().unwrap().branch_id, original);
    let successor_run = successor.run_id.clone().unwrap();
    wait_until("handoff image successor retirement", || {
        retired(&successor_run) == Some(true)
    })
    .await;
    let received = tasks(&fixture);
    assert_eq!(std::fs::read_to_string(workspace_dir.join("handoff-provider.txt")).unwrap(), "https://handoff-fixture.invalid");
    assert!(haiku_cli_args(&fixture).windows(2).any(|args| args == ["--model", "explicit-handoff-model"]));
    assert_eq!(
        received.len(),
        2,
        "handoff must launch only its fresh successor"
    );
    let text = assert_image_and_text(&received[1], pending_text);
    assert!(text.contains(summary));
    assert_eq!(text.matches(pending_text).count(), 1);
    assert_eq!(text.matches(summary).count(), 1);

    let repeated = ccgui_next_lib::leader::test_human_handoff_with_selection(
        state.inner(),
        &parent,
        &original,
        "image-held",
        "fake-session-123",
        reviewed_model.as_deref(),
        "image-operation",
        summary,
        selected,
    )
    .await
    .unwrap();
    assert_eq!(repeated.branches.len(), handed.branches.len());
    assert_eq!(
        tasks(&fixture).len(),
        2,
        "same operation must not launch another CLI"
    );
    let replay = dispatch("task_send", held_args).await.unwrap();
    assert_eq!(replay["requestState"], "handed_off");
    assert_eq!(replay["originalSubmittedToModel"], false);
    assert_eq!(replay["actualBranchId"], successor_id);
    assert_eq!(
        tasks(&fixture).len(),
        2,
        "replaying held request must never resend it"
    );
    let tracked = dispatch(
        "task_wait",
        serde_json::json!({"branch_ids":[original], "timeout_seconds":1}),
    )
    .await
    .unwrap();
    assert_eq!(tracked["branches"][0]["actualBranchId"], successor_id);
    assert_eq!(tracked["branches"][0]["delegation"]["state"], "completed");

    // Normal approval follows the same transport and durable-image contract,
    // including a parent that still addresses the original logical child ID.
    std::fs::write(workspace_dir.join("approval.png"), &png).unwrap();
    cold_cache(state.inner(), "handoff-successor-id");
    let approval_text = "Approved continuation uses captured image, without a handoff summary.";
    let pending = dispatch("task_send", serde_json::json!({
        "branch_id":original, "request_id":"approved-image", "message":approval_text, "images":["approval.png"],
    })).await.unwrap();
    assert_eq!(pending["status"], "awaiting_cost_approval");
    assert_eq!(tasks(&fixture).len(), 2);
    let approval_model = pending["branch"]["model"].as_str().map(str::to_owned);
    std::fs::remove_file(workspace_dir.join("approval.png")).unwrap();
    let approved = ccgui_next_lib::leader::test_human_cost_decision(
        state.inner(),
        &parent,
        &successor_id,
        "approved-image",
        true,
        approval_model.as_deref(),
    )
    .await
    .unwrap();
    let run = approved
        .branches
        .iter()
        .find(|branch| branch.id == successor_id)
        .unwrap()
        .run_id
        .clone()
        .unwrap();
    wait_until("approved image continuation retirement", || {
        retired(&run) == Some(true)
    })
    .await;
    let received = tasks(&fixture);
    assert_eq!(received.len(), 3);
    let text = assert_image_and_text(&received[2], approval_text);
    assert!(
        !text.contains(summary),
        "previous handoff summary leaked into the next assignment"
    );
}
