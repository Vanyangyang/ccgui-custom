//! Hermetic send-path tests: explicitly registered fake CLIs emitting stream-json
//! NDJSON, real send_message command, real EventSink, events captured via
//! listen_any. Run: cargo test --features test-harness --test send_path

use ccgui_next_lib::config::ConfigStore;
use ccgui_next_lib::auto_title::test_support as title_origins;
use ccgui_next_lib::db::Db;
use ccgui_next_lib::engine::{self, ProcessRegistry};
use ccgui_next_lib::engine::isolated_send_test_support::Source;
use ccgui_next_lib::event_sink::{Emit, EventSink, ENGINE_EVENT_NAME};
use ccgui_next_lib::test_harness::TestHarness;
use ccgui_next_lib::AppState;
use serde_json::Value;
use std::sync::{Arc, Mutex, Weak};
use tauri::{Listener, Manager};

// Managed AppState must not retain its owning AppHandle through its sinks:
// that cycle keeps the SQLite connection open after the mock App is dropped.
// The fixture owns the strong handle, while delivery still uses the actual
// AppHandle Emit implementation and the application's listen_any listeners.
struct FixtureEmitter(Weak<tauri::AppHandle<tauri::test::MockRuntime>>);

impl Emit for FixtureEmitter {
    fn emit_json(&self, name: &str, raw_json: &str) {
        if let Some(handle) = self.0.upgrade() {
            Emit::emit_json(handle.as_ref(), name, raw_json);
        }
    }
}

fn leader_marks_path(fixture: &TestHarness) -> std::path::PathBuf {
    fixture.root().join("leader-marks.txt")
}

/// Script line that appends `<cli>:[<CCGUI_LEADER_CHILD>]` for each launch.
fn record_leader_mark(marks: &std::path::Path, name: &str) -> String {
    let marks = marks.to_string_lossy();
    if cfg!(windows) {
        format!("[IO.File]::AppendAllText('{marks}', '{name}:[' + $env:CCGUI_LEADER_CHILD + ']' + [Environment]::NewLine)\r\n")
    } else {
        format!("printf '%s:[%s]\\n' '{name}' \"$CCGUI_LEADER_CHILD\" >> '{marks}'\n")
    }
}

fn leader_marks(fixture: &TestHarness) -> Vec<String> {
    std::fs::read_to_string(leader_marks_path(fixture))
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect()
}

fn write_fake_cli(fixture: &TestHarness, name: &str, hang: bool) -> std::path::PathBuf {
    write_fake_cli_with_origin_gate(fixture, name, hang, false)
}

fn write_fake_haiku_cli(fixture: &TestHarness, supports_agents: bool) {
    let path = write_fake_cli(fixture, "claude", false);
    let script = std::fs::read_to_string(&path).unwrap();
    let probes = fixture.root().join("help-probes.txt");
    let help = if supports_agents { "  --agents <json-or-file> Define custom agents" } else { "  --model <model> Main model" };
    #[cfg(windows)]
    let script = format!("if ($args.Count -eq 1 -and $args[0] -eq '--help') {{ [IO.File]::AppendAllText('{}', 'help' + [Environment]::NewLine); [Console]::Out.WriteLine('{help}'); exit 0 }}\r\n{script}", probes.display());
    #[cfg(unix)]
    let script = format!("#!/bin/sh\nif [ \"$1\" = '--help' ]; then printf 'help\\n' >> '{}'; printf '%s\\n' '{help}'; exit 0; fi\n{}", probes.display(), script.strip_prefix("#!/bin/sh\n").unwrap());
    std::fs::write(path, script).unwrap();
}

fn haiku_cli_args(fixture: &TestHarness) -> Vec<String> {
    let raw = std::fs::read_to_string(fixture.root().join("ws/claude-args.json")).unwrap();
    #[cfg(windows)]
    { serde_json::from_str(&raw).unwrap() }
    #[cfg(unix)]
    { raw.lines().map(str::to_string).collect() }
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn haiku_assist_default_on_off_and_session_isolation_reach_fake_cli() {
    let fixture = TestHarness::new().unwrap();
    write_fake_haiku_cli(&fixture, true);
    let workspace = fixture.root().join("ws").to_string_lossy().to_string();
    let (app, events) = build_app(&fixture);
    let mut original = Vec::new();
    let mut original_system = String::new();
    for (index, (enabled, session)) in [(None, "session-a"), (Some(true), "session-a"), (None, "session-b"), (Some(false), "session-a")].into_iter().enumerate() {
        events.lock().unwrap().clear();
        engine::send_message(app.state::<AppState>(), "claude".into(), workspace.clone(), Some(session.into()), "fake task".into(),
            None, Some("opus".into()), Some("high".into()), Some("manual".into()), None, Some(format!("haiku-{index}")), None, None, enabled).await.unwrap();
        wait_for_settlement(&app, &events).await;
        let mut args = haiku_cli_args(&fixture);
        let prompt_positions: Vec<_> = args.iter().enumerate()
            .filter_map(|(index, arg)| (arg == "--append-system-prompt-file").then_some(index))
            .collect();
        assert_eq!(prompt_positions.len(), 1, "expected exactly one staged system prompt flag");
        let prompt_index = prompt_positions[0] + 1;
        let prompt_path = std::path::Path::new(args.get(prompt_index).expect("system prompt flag requires a path"));
        assert_eq!(prompt_path.parent().unwrap(), fixture.root().join(".ccgui-next/leader-role-staging"),
            "system prompt must remain in fixture-owned staging");
        assert_eq!(prompt_path.extension().and_then(|value| value.to_str()), Some("txt"));
        uuid::Uuid::parse_str(prompt_path.file_stem().unwrap().to_str().unwrap()).expect("staged prompt filename must be a UUID");
        let system = std::fs::read_to_string(fixture.root().join("ws/claude-system.txt")).unwrap();
        if index == 0 {
            assert!(!system.is_empty(), "fake CLI must capture the staged system prompt");
            original_system = system;
        } else {
            assert_eq!(system, original_system, "Haiku toggles and session isolation must preserve system instructions");
        }
        // Only the per-send UUID path varies; compare every other argument unchanged.
        args[prompt_index] = "<fixture-staged-system-prompt>".into();
        assert!(args.windows(2).any(|w| w == ["--model", "opus"]));
        assert!(args.windows(2).any(|w| w == ["--permission-mode", "default"]));
        assert!(args.windows(2).any(|w| w == ["--effort", "high"]));
        assert!(!args.iter().any(|arg| arg == "--dangerously-skip-permissions"));
        if enabled == Some(true) {
            let position = args.iter().position(|arg| arg == "--agents").unwrap();
            let agents: Value = serde_json::from_str(&args[position + 1]).unwrap();
            assert_eq!(agents["ccgui-haiku-assist"]["model"], "haiku");
            assert!(agents["ccgui-haiku-assist"].get("permissionMode").is_none());
            args.drain(position..position + 2);
            assert_eq!(args, original, "enabling changed arguments beyond the optional definition");
        } else {
            assert!(!args.iter().any(|arg| arg == "--agents"));
            if index == 0 { original = args.clone(); }
            if index == 3 { assert_eq!(args, original, "turning off must restore the original argv"); }
        }
    }
    assert_eq!(std::fs::read_to_string(fixture.root().join("help-probes.txt")).unwrap().lines().count(), 1);
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn haiku_assist_unsupported_cli_refuses_launch_and_off_recovers() {
    let fixture = TestHarness::new().unwrap();
    write_fake_haiku_cli(&fixture, false);
    let workspace = fixture.root().join("ws").to_string_lossy().to_string();
    let (app, events) = build_app(&fixture);
    let error = engine::send_message(app.state::<AppState>(), "claude".into(), workspace.clone(), None, "fake task".into(),
        None, Some("opus".into()), None, Some("manual".into()), None, Some("haiku-unsupported".into()), None, None, Some(true)).await.err().unwrap();
    assert!(error.starts_with("CLAUDE_HAIKU_ASSIST_UNAVAILABLE:"), "{error}");
    assert!(!fixture.root().join("ws/fixture-started.txt").exists(), "model process launched after failed capability probe");
    assert!(app.state::<AppState>().processes.0.lock().unwrap().is_empty(), "failed probe leaked a reservation");
    engine::send_message(app.state::<AppState>(), "claude".into(), workspace, None, "fake recovery".into(),
        None, Some("opus".into()), None, Some("manual".into()), None, Some("haiku-off-recovery".into()), None, None, Some(false)).await.unwrap();
    wait_for_settlement(&app, &events).await;
    assert!(!haiku_cli_args(&fixture).iter().any(|arg| arg == "--agents"));
    assert_eq!(std::fs::read_to_string(fixture.root().join("help-probes.txt")).unwrap().lines().count(), 1);
}

/// Holds the first protocol event and the final process exit independently,
/// allowing assertions while the actual reader's origin registration is live.
fn write_fake_cli_with_origin_gate(
    fixture: &TestHarness,
    name: &str,
    hang: bool,
    origin_gate: bool,
) -> std::path::PathBuf {
    let lines: Vec<Value> = if name == "omp" {
        vec![
            serde_json::json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"ok"}}),
            serde_json::json!({"type":"agent_end"}),
        ]
    } else if hang {
        vec![serde_json::json!({"type":"system","subtype":"init","session_id":"fake-hang-1"})]
    } else {
        vec![
            serde_json::json!({"type":"system","subtype":"init","session_id":"fake-session-123"}),
            serde_json::json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello "}}}),
            serde_json::json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"from fake"}}}),
            serde_json::json!({"type":"result","subtype":"success","session_id":"fake-session-123","usage":{"input_tokens":10,"output_tokens":5}}),
        ]
    };
    let marks = leader_marks_path(fixture);
    #[cfg(windows)]
    let (path, script) = {
        let path = fixture.root().join("bin").join(format!("{name}.ps1"));
        let mut script = format!(
            "[IO.File]::WriteAllText('fixture-started.txt', '{name}')\r\n[IO.File]::WriteAllText('fixture-home.txt', $env:HOME)\r\n{}",
            record_leader_mark(&marks, name)
        );
        if name == "omp" {
            script.push_str("[IO.File]::WriteAllLines('omp-args.txt', [string[]]$args)\r\n");
        } else {
            script.push_str("[IO.File]::WriteAllText('claude-args.json', (ConvertTo-Json -Compress -InputObject @($args)))\r\n$roleIndex = [Array]::IndexOf([string[]]$args, '--append-system-prompt-file')\r\n$roleText = if ($roleIndex -ge 0) { [IO.File]::ReadAllText($args[$roleIndex + 1]) } else { '' }\r\n[IO.File]::WriteAllText('claude-system.txt', $roleText)\r\n$firstTask = [Console]::In.ReadLine()\r\n[IO.File]::AppendAllText('claude-tasks.ndjson', $firstTask + [Environment]::NewLine)\r\n");
        }
        if origin_gate {
            script.push_str("while (!(Test-Path 'origin-first-release')) { Start-Sleep -Milliseconds 10 }\r\n");
        }
        for line in &lines {
            script.push_str(&format!("[Console]::Out.WriteLine('{}')\r\n", line));
        }
        script.push_str("[Console]::Out.Flush()\r\n");
        if origin_gate {
            script.push_str("while (!(Test-Path 'origin-exit-release')) { Start-Sleep -Milliseconds 10 }\r\n");
        }
        if hang {
            script.push_str("Start-Sleep -Seconds 60\r\n");
        }
        (path, script)
    };
    #[cfg(unix)]
    let (path, script) = {
        let path = fixture.root().join("bin").join(name);
        let mut script = format!(
            "#!/bin/sh\nprintf '%s' '{name}' > fixture-started.txt\nprintf '%s' \"$HOME\" > fixture-home.txt\n{}",
            record_leader_mark(&marks, name)
        );
        if name == "omp" {
            script.push_str("printf '%s\\n' \"$@\" > omp-args.txt\n");
        } else {
            script.push_str("printf '%s\\n' \"$@\" > claude-args.json\nrolefile=''\nwhile [ \"$#\" -gt 0 ]; do\ncase \"$1\" in --append-system-prompt-file) shift; rolefile=\"$1\";; esac\nshift\ndone\nif [ -n \"$rolefile\" ]; then cat \"$rolefile\" > claude-system.txt; else : > claude-system.txt; fi\nread -r line\nprintf '%s\\n' \"$line\" >> claude-tasks.ndjson\n");
        }
        if origin_gate {
            script.push_str("while [ ! -f origin-first-release ]; do sleep 0.01; done\n");
        }
        for line in &lines {
            script.push_str(&format!("printf '%s\\n' '{}'\n", line));
        }
        if origin_gate {
            script.push_str("while [ ! -f origin-exit-release ]; do sleep 0.01; done\n");
        }
        if hang {
            script.push_str("sleep 60\n");
        }
        (path, script)
    };
    std::fs::write(&path, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    fixture.register_cli(name, &path).unwrap();
    path
}

// Fake app-server replies carry REPLY_ID, swapped for the request's own id: a
// managed role turn reads `config/read` before `thread/start`, shifting the
// sequence.
const REPLY_ID: u64 = 900_001;

fn auto_review_thread_reply() -> Value {
    serde_json::json!({"id":REPLY_ID,"result":{
        "thread":{"id":"fake-codex-thread"},
        "approvalPolicy":"on-request","approvalsReviewer":"auto_review",
        "sandbox":{"type":"workspaceWrite","writableRoots":[],"networkAccess":false,
            "excludeTmpdirEnvVar":false,"excludeSlashTmp":false},
        "activePermissionProfile":{"id":":workspace","extends":null},
    }})
}

fn write_fake_codex_app_server(fixture: &TestHarness) {
    write_fake_codex_responses(fixture, Vec::new());
}

/// Resuming fails the way Codex does while another process holds the thread.
fn write_fake_codex_held_elsewhere(fixture: &TestHarness, thread: &str) {
    write_fake_codex_responses(
        fixture,
        vec![(
            "thread/resume",
            vec![serde_json::json!({"id":REPLY_ID,"error":{"code":-32600,
                "message":format!("thread {thread} already has an active writer")}})],
        )],
    );
}

fn write_fake_codex_responses(fixture: &TestHarness, extra: Vec<(&str, Vec<Value>)>) {
    let mut responses = vec![
        ("initialize", vec![serde_json::json!({"id":REPLY_ID,"result":{}})]),
        ("config/read", vec![serde_json::json!({"id":REPLY_ID,"result":{"config":{}}})]),
        ("thread/start", vec![auto_review_thread_reply()]),
        ("experimentalFeature/list", vec![serde_json::json!({"id":REPLY_ID,"result":{
            "data":[{"name":"guardian_approval","enabled":true}],"nextCursor":null,
        }})]),
        ("turn/start", vec![
            serde_json::json!({"id":REPLY_ID,"result":{"turn":{"id":"fake-codex-turn"}}}),
            serde_json::json!({"method":"item/agentMessage/delta","params":{"threadId":"fake-codex-thread","turnId":"fake-codex-turn","delta":"isolated codex"}}),
            serde_json::json!({"method":"turn/completed","params":{"threadId":"fake-codex-thread","turn":{"id":"fake-codex-turn","status":"completed"}}}),
        ]),
    ];
    responses.retain(|(method, _)| !extra.iter().any(|(override_method, _)| method == override_method));
    responses.extend(extra);
    let mark = record_leader_mark(&leader_marks_path(fixture), "codex");
    #[cfg(windows)]
    let (path, mut script) = (
        fixture.root().join("bin/codex.ps1"),
        format!("{mark}while ($null -ne ($line = [Console]::In.ReadLine())) {{\r\n[IO.File]::AppendAllText('codex-requests.ndjson', $line + [Environment]::NewLine)\r\n$frame = $line | ConvertFrom-Json\r\nswitch ($frame.method) {{\r\n"),
    );
    #[cfg(unix)]
    let (path, mut script) = (
        fixture.root().join("bin/codex"),
        format!("#!/bin/sh\n{mark}while IFS= read -r line; do\nprintf '%s\\n' \"$line\" >> codex-requests.ndjson\nid=$(printf '%s' \"$line\" | sed -n 's/.*\"id\":\\([^,}}]*\\).*/\\1/p')\ncase \"$line\" in\n"),
    );
    for (method, frames) in responses {
        #[cfg(windows)]
        script.push_str(&format!("'{method}' {{\r\n"));
        #[cfg(unix)]
        script.push_str(&format!("*'\"method\":\"{method}\"'*)\n"));
        for frame in frames {
            #[cfg(windows)]
            script.push_str(&format!(
                "[Console]::Out.WriteLine('{frame}'.Replace('\"id\":{REPLY_ID}', '\"id\":' + ($frame.id | ConvertTo-Json -Compress)))\r\n"
            ));
            #[cfg(unix)]
            script.push_str(&format!(
                "printf '%s\\n' '{frame}' | sed \"s/\\\"id\\\":{REPLY_ID}/\\\"id\\\":$id/\"\n"
            ));
        }
        #[cfg(windows)]
        script.push_str("[Console]::Out.Flush()\r\n}\r\n");
        #[cfg(unix)]
        script.push_str(";;\n");
    }
    #[cfg(windows)]
    script.push_str("}\r\n}\r\n");
    #[cfg(unix)]
    script.push_str("esac\ndone\n");
    std::fs::write(&path, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    fixture.register_cli("codex", &path).unwrap();
}

fn assert_fixture_started(fixture: &TestHarness, name: &str) {
    let workspace = fixture.root().join("ws");
    assert_eq!(
        std::fs::read_to_string(workspace.join("fixture-started.txt")).unwrap(),
        name
    );
    let child_home = std::fs::read_to_string(workspace.join("fixture-home.txt")).unwrap();
    assert_eq!(std::fs::canonicalize(child_home).unwrap(), fixture.root());
    assert_eq!(
        ccgui_next_lib::paths::settings_path(),
        fixture.root().join(".ccgui-next/settings.json")
    );
}

async fn wait_for_settlement(
    app: &tauri::App<tauri::test::MockRuntime>,
    events: &Arc<Mutex<Vec<Value>>>,
) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        let collected = events.lock().unwrap().clone();
        assert!(
            !collected.iter().any(|event| event["kind"] == "error"),
            "unexpected engine error: {collected:?}"
        );
        let done = collected.iter().any(|event| event["kind"] == "done");
        if done
            && app
                .state::<AppState>()
                .processes
                .0
                .lock()
                .unwrap()
                .is_empty()
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "run did not publish done and drain its process registry"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

fn build_app(
    fixture: &TestHarness,
) -> (tauri::App<tauri::test::MockRuntime>, Arc<Mutex<Vec<Value>>>) {
    let home = fixture.root();
    let app = tauri::test::mock_builder()
        .invoke_handler(tauri::generate_handler![engine::send_message])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let handle = Arc::new(app.handle().clone());
    let emitter: Arc<dyn Emit> = Arc::new(FixtureEmitter(Arc::downgrade(&handle)));
    fixture.keep_alive(Arc::clone(&handle));
    let state = AppState {
        db: Arc::new(Db::open_at(&home.join("app.db")).unwrap()),
        sink: EventSink::new(Arc::clone(&emitter)),
        terminal_sink: EventSink::with_name(
            Arc::clone(&emitter),
            ccgui_next_lib::terminal::TERMINAL_OUTPUT_EVENT,
        ),
        plugin_sink: EventSink::with_name(
            Arc::clone(&emitter),
            ccgui_next_lib::event_sink::PLUGIN_AGENT_EVENT_NAME,
        ),
        mission_sink: EventSink::with_name(
            Arc::clone(&emitter),
            ccgui_next_lib::event_sink::MISSION_AGENT_EVENT_NAME,
        ),
        terminals: ccgui_next_lib::terminal::TerminalRegistry::default(),
        processes: Arc::new(ProcessRegistry::default()),
        emitters: ccgui_next_lib::event_sink::BroadcastEmit::new(emitter),
        web: ccgui_next_lib::web::WebAccessState::default(),
        relay: ccgui_next_lib::relay::RelayState::default(),
        dsh_host: Arc::new(ccgui_next_lib::dsh_host::DshHostState::default()),
        opencode_server: std::sync::Arc::new(
            ccgui_next_lib::engine::opencode_server::OpencodeServerState::default(),
        ),
        worktree_creations: ccgui_next_lib::git_worktree::CreationRegistry::default(),
    };
    app.manage(state);
    app.manage(ConfigStore::default());
    fixture.track_processes(Arc::clone(&app.state::<AppState>().processes));
    fixture
        .track_database(Arc::clone(&app.state::<AppState>().db))
        .unwrap();

    let events: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&events);
    handle.listen_any(ENGINE_EVENT_NAME, move |event: tauri::Event| {
        if let Ok(batch) = serde_json::from_str::<Vec<Value>>(event.payload()) {
            captured.lock().unwrap().extend(batch);
        }
    });
    (app, events)
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn isolated_agents_cannot_resume_managed_task_sessions() {
    let fixture = TestHarness::new().unwrap();
    write_fake_cli(&fixture, "claude", false);
    let workspace = fixture.root().join("ws").to_string_lossy().to_string();
    let (app, events) = build_app(&fixture);
    let state = app.state::<AppState>();
    ccgui_next_lib::leader::prepare_run(&state.db, "schema-only", "pi", None, &workspace, None).unwrap();
    state.db.0.lock().execute(
        "INSERT INTO leader_branches(id,parent_engine,parent_session_id,workspace_path,engine,session_id,state,record_json,permission)
         VALUES('root-owned-child','claude','managed-root',?1,'claude','another-managed-child','completed','{}','manual')",
        [&workspace],
    ).unwrap();
    state.db.0.lock().execute(
        "INSERT INTO leader_branches(id,parent_engine,parent_session_id,workspace_path,engine,session_id,state,record_json,permission)
         VALUES('fixture-child','claude','root-with-children',?1,'claude','managed-child','completed','{}','manual')",
        [&workspace],
    ).unwrap();
    for source in [Source::Plugin, Source::Mission, Source::ConstrainedChat] {
        for branch_state in ["completed", "running", "waiting", "reclaiming", "reclaimed"] {
            state.db.0.lock().execute("UPDATE leader_branches SET state=?1 WHERE id='fixture-child'", [branch_state]).unwrap();
            for session in ["managed-root", "managed-child", "root-with-children"] {
                if session == "root-with-children" && branch_state == "reclaimed" { continue; }
                let result = engine::isolated_send_test_support::send(
                    state.inner(), source, "claude".into(), format!("{workspace}/."), Some(session.into()),
                    format!("isolated-managed-{source:?}-{branch_state}-{session}"),
                ).await;
                let error = result.err().unwrap_or_else(|| panic!("isolated source {source:?} resumed {session}/{branch_state}"));
                assert!(error.contains("managed"), "wrong rejection: {error}");
                assert_eq!(state.processes.active_run_count(), 0);
                assert!(!fixture.root().join("ws/fixture-started.txt").exists());
            }
        }
    }
    assert!(events.lock().unwrap().is_empty());
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn ordinary_isolated_agents_keep_their_own_events_and_ignore_legacy_role_markers() {
    let fixture = TestHarness::new().unwrap();
    write_fake_cli(&fixture, "claude", false);
    let workspace = fixture.root().join("ws").to_string_lossy().to_string();
    let (app, chat_events) = build_app(&fixture);
    let state = app.state::<AppState>();
    ccgui_next_lib::leader::prepare_run(&state.db, "schema-only", "pi", None, &workspace, None).unwrap();
    state.db.0.lock().execute(
        "INSERT INTO leader_roles(engine,session_id,workspace_path,enabled) VALUES('claude','disabled-root',?1,0)", [&workspace],
    ).unwrap();
    state.db.0.lock().execute(
        "INSERT INTO leader_roles(engine,session_id,workspace_path,enabled) VALUES('claude','legacy-enabled-root',?1,1)", [&workspace],
    ).unwrap();
    for (source, event_name) in [(Source::Plugin, ccgui_next_lib::event_sink::PLUGIN_AGENT_EVENT_NAME),
        (Source::Mission, ccgui_next_lib::event_sink::MISSION_AGENT_EVENT_NAME)] {
        let events = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = Arc::clone(&events);
        let listener = app.listen_any(event_name, move |event| {
            if let Ok(batch) = serde_json::from_str::<Vec<Value>>(event.payload()) {
                captured.lock().unwrap().extend(batch);
            }
        });
        for session in [None, Some("disabled-root".into()), Some("legacy-enabled-root".into())] {
            let run = format!("isolated-normal-{source:?}-{}", session.as_deref().unwrap_or("fresh"));
            engine::isolated_send_test_support::send(state.inner(), source, "claude".into(), workspace.clone(), session, run.clone()).await
                .unwrap_or_else(|error| panic!("normal isolated send failed: {error}"));
            wait_for_settlement(&app, &events).await;
            assert_fixture_started(&fixture, "claude");
            let collected = events.lock().unwrap();
            assert!(collected.iter().any(|event| event["runId"] == run && event["kind"] == "done"));
            assert!(collected.iter().all(|event| event.get("leader").is_none()));
        }
        app.unlisten(listener);
    }
    assert!(chat_events.lock().unwrap().is_empty());
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn cancelling_an_isolated_launch_releases_its_reservation() {
    let fixture = TestHarness::new().unwrap();
    write_fake_cli(&fixture, "claude", true);
    let workspace = fixture.root().join("ws").to_string_lossy().to_string();
    let (app, chat_events) = build_app(&fixture);
    let state = app.state::<AppState>();
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = Arc::clone(&events);
    app.listen_any(ccgui_next_lib::event_sink::PLUGIN_AGENT_EVENT_NAME, move |event| {
        if let Ok(batch) = serde_json::from_str::<Vec<Value>>(event.payload()) {
            captured.lock().unwrap().extend(batch);
        }
    });
    engine::isolated_send_test_support::send(state.inner(), Source::Plugin, "claude".into(), workspace.clone(), None, "isolated-previous".into()).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            if events.lock().unwrap().iter().any(|event| event["kind"] == "session") { break; }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }).await.expect("fake previous process did not announce its session");
    let result = tokio::time::timeout(std::time::Duration::from_millis(100),
        engine::isolated_send_test_support::send(state.inner(), Source::Plugin, "claude".into(), workspace,
            Some("fake-hang-1".into()), "isolated-cancelled".into())).await;
    assert!(result.is_err(), "launch did not wait for the previous fake process");
    assert!(!state.processes.0.lock().unwrap().contains_key("isolated-cancelled"));
    assert_eq!(state.processes.active_run_count(), 1);
    assert!(chat_events.lock().unwrap().is_empty());
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn own_transport_isolated_agents_do_not_emit_chat_events() {
    let fixture = TestHarness::new().unwrap();
    write_fake_codex_app_server(&fixture);
    let workspace = fixture.root().join("ws").to_string_lossy().to_string();
    let (app, chat_events) = build_app(&fixture);
    for (source, event_name) in [(Source::Plugin, ccgui_next_lib::event_sink::PLUGIN_AGENT_EVENT_NAME),
        (Source::Mission, ccgui_next_lib::event_sink::MISSION_AGENT_EVENT_NAME)] {
        let events = Arc::new(Mutex::new(Vec::<Value>::new()));
        let mut listeners = Vec::new();
        for name in [ENGINE_EVENT_NAME, event_name] {
            let captured = Arc::clone(&events);
            listeners.push(app.listen_any(name, move |event| {
                if let Ok(batch) = serde_json::from_str::<Vec<Value>>(event.payload()) {
                    captured.lock().unwrap().extend(batch);
                }
            }));
        }
        let run = format!("isolated-own-{source:?}");
        engine::isolated_send_test_support::send(app.state::<AppState>().inner(), source, "codex".into(), workspace.clone(), None, run.clone()).await
            .unwrap_or_else(|error| panic!("fake app-server launch failed: {error}"));
        wait_for_settlement(&app, &events).await;
        assert!(chat_events.lock().unwrap().is_empty(), "isolated app-server events reached the chat sink");
        assert!(events.lock().unwrap().iter().any(|event| event["runId"] == run && event["kind"] == "delta"));
        for listener in listeners { app.unlisten(listener); }
    }
    engine::send_message(
        app.state::<AppState>(), "codex".into(), workspace, None, "ordinary fixture".into(),
        None, None, None, None, None, Some("ordinary-own-chat".into()), None,
        None, None,
    ).await.unwrap_or_else(|error| panic!("ordinary fake app-server launch failed: {error}"));
    wait_for_settlement(&app, &chat_events).await;
    assert!(chat_events.lock().unwrap().iter().any(|event| event["runId"] == "ordinary-own-chat" && event["kind"] == "delta"));
}

const COORDINATOR_CHILD: &str = "CCGUI_SEND_PATH_COORDINATOR_CHILD";

/// The Leader coordinator is a process-global OnceLock. A case that installs
/// it re-runs itself alone in a fresh copy of this test binary, so the real
/// coordinator never leaks into other send-path cases. True inside that child.
fn in_coordinator_child(name: &str) -> bool {
    if std::env::var(COORDINATOR_CHILD).as_deref() == Ok(name) {
        return true;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([name, "--exact", "--nocapture", "--test-threads=1"])
        .env(COORDINATOR_CHILD, name)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && stdout.contains("1 passed"),
        "isolated coordinator case {name} failed:\n{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    false
}

/// Real coordinator over fixture state; reclamation only records deletions.
fn install_recording_coordinator(state: &AppState) -> Arc<Mutex<Vec<String>>> {
    let deleted = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&deleted);
    let fixture_db = Arc::clone(&state.db);
    ccgui_next_lib::leader::install_test_coordinator(
        state,
        Arc::new(move |engine: &str, session: &str| {
            seen.lock().unwrap().push(format!("{engine}/{session}"));
            // Simulate the production deletion's cache removal in this fake
            // database; no native transcript or real HOME is touched.
            let conn = fixture_db.0.lock();
            conn.execute("DELETE FROM session_archives WHERE engine=?1 AND session_id=?2", [engine, session]).map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM sessions WHERE engine=?1 AND session_id=?2", [engine, session]).map_err(|e| e.to_string())?;
            Ok(())
        }),
    )
    .unwrap();
    deleted
}

fn capture(
    app: &tauri::App<tauri::test::MockRuntime>,
    name: &str,
) -> (Arc<Mutex<Vec<Value>>>, tauri::EventId) {
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured = Arc::clone(&events);
    let listener = app.listen_any(name, move |event| {
        if let Ok(batch) = serde_json::from_str::<Vec<Value>>(event.payload()) {
            captured.lock().unwrap().extend(batch);
        }
    });
    (events, listener)
}

async fn wait_until(what: &str, mut ready: impl FnMut() -> bool) {
    tokio::time::timeout(std::time::Duration::from_secs(15), async {
        while !ready() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {what}"));
}

fn count(events: &Arc<Mutex<Vec<Value>>>, run: &str, kinds: &[&str]) -> usize {
    events
        .lock()
        .unwrap()
        .iter()
        .filter(|event| event["runId"] == run && kinds.iter().any(|kind| event["kind"] == *kind))
        .count()
}

fn routed_entry(run_id: &str, pid: u32) -> engine::ChildEntry {
    engine::ChildEntry::test_route(run_id, pid)
}

fn retired(run: &str) -> Option<bool> {
    ccgui_next_lib::leader::test_run_retired(run)
}

fn register_root_workspace(state: &AppState, workspace: &str) {
    state.db.0.lock().execute("INSERT INTO workspaces(id,path,name) VALUES('first-root-ws',?1,'ws')", [workspace]).unwrap();
}

fn fake_requests(fixture: &TestHarness) -> Vec<Value> {
    std::fs::read_to_string(fixture.root().join("ws/codex-requests.ndjson"))
        .unwrap_or_default().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
}

fn claude_args(fixture: &TestHarness) -> String {
    let raw = std::fs::read_to_string(fixture.root().join("ws/claude-args.json")).unwrap();
    #[cfg(windows)]
    { serde_json::from_str::<Vec<String>>(&raw).unwrap().join("\n") }
    #[cfg(unix)]
    { raw }
}

fn live_codex(fixture: &TestHarness) {
    write_fake_codex_responses(fixture, vec![
        ("thread/resume", vec![auto_review_thread_reply()]),
        ("turn/start", vec![serde_json::json!({"id":REPLY_ID,"result":{"turn":{"id":"fake-codex-turn"}}}),
            serde_json::json!({"method":"item/agentMessage/delta","params":{"threadId":"fake-codex-thread","turnId":"fake-codex-turn","delta":"first root still running"}})]),
    ]);
}

#[tokio::test]
async fn codex_auto_review_unavailable_stops_before_task_and_drains_run() {
    let fixture = TestHarness::new().unwrap();
    write_fake_codex_responses(&fixture, vec![("experimentalFeature/list", vec![
        serde_json::json!({"id":REPLY_ID,"result":{"data":[{"name":"guardian_approval","enabled":false}],"nextCursor":null}}),
    ])]);
    let workspace = fixture.root().join("ws").to_string_lossy().to_string();
    let (app, events) = build_app(&fixture);
    let run = "auto-review-disabled";
    engine::send_message(app.state::<AppState>(), "codex".into(), workspace, None, "must not reach model".into(),
        None, None, None, Some("auto".into()), None, Some(run.into()), None, None, None).await.unwrap();
    wait_until("failed reviewer preflight", || count(&events, run, &["error"]) == 1).await;
    wait_until("failed reviewer process drain", || app.state::<AppState>().processes.0.lock().unwrap().is_empty()).await;
    assert_eq!(count(&events, run, &["done", "delta"]), 0);
    assert!(fake_requests(&fixture).iter().all(|frame| frame["method"] != "turn/start"));
    assert!(events.lock().unwrap().iter().any(|event| event["runId"] == run
        && event["data"].as_str().is_some_and(|error| error.starts_with("CODEX_AUTO_REVIEW_UNAVAILABLE:"))));
}

#[tokio::test]
async fn codex_steer_keeps_one_native_turn_and_waits_for_ack() {
    let fixture = TestHarness::new().unwrap();
    write_fake_codex_responses(&fixture, vec![
        ("turn/start", vec![
            serde_json::json!({"id":REPLY_ID,"result":{"turn":{"id":"fake-codex-turn"}}}),
            serde_json::json!({"method":"item/agentMessage/delta","params":{"threadId":"fake-codex-thread","turnId":"fake-codex-turn","delta":"initial "}}),
        ]),
        ("turn/steer", vec![
            serde_json::json!({"id":REPLY_ID,"result":{"turnId":"fake-codex-turn"}}),
            serde_json::json!({"method":"item/agentMessage/delta","params":{"threadId":"fake-codex-thread","turnId":"fake-codex-turn","delta":"steered response"}}),
            serde_json::json!({"method":"turn/completed","params":{"threadId":"fake-codex-thread","turn":{"id":"fake-codex-turn","status":"completed"}}}),
        ]),
    ]);
    let workspace = fixture.root().join("ws").to_string_lossy().to_string();
    let (app, events) = build_app(&fixture);
    let run = "codex-steer-live";
    engine::send_message(
        app.state::<AppState>(), "codex".into(), workspace.clone(), None, "initial task".into(),
        None, None, None, None, None, Some(run.into()), None, None, None,
    ).await.unwrap();
    wait_until("initial Codex delta", || count(&events, run, &["delta"]) == 1).await;
    assert_eq!(count(&events, run, &["done", "error"]), 0);
    assert!(engine::send_follow_up(
        app.state::<AppState>(), "fake-codex-thread".into(), "codex".into(), workspace.clone(),
        "adjust task".into(), Some(vec!["attachment.png".into()]),
    ).await.unwrap());
    wait_for_settlement(&app, &events).await;
    let requests = fake_requests(&fixture);
    let thread = requests.iter().find(|frame| frame["method"] == "thread/start").unwrap();
    assert_eq!(thread["params"]["permissions"], ":workspace");
    assert_eq!(thread["params"]["approvalPolicy"], "on-request");
    assert_eq!(thread["params"]["approvalsReviewer"], "auto_review");
    let verified = requests.iter().position(|frame| frame["method"] == "experimentalFeature/list").unwrap();
    let started = requests.iter().position(|frame| frame["method"] == "turn/start").unwrap();
    assert!(verified < started, "the reviewer must be verified before sending the task");
    let steer = requests.iter().find(|frame| frame["method"] == "turn/steer").unwrap();
    assert!(steer["id"].as_str().unwrap().starts_with("ccgui-steer:"));
    assert_eq!(steer["params"]["threadId"], "fake-codex-thread");
    assert_eq!(steer["params"]["expectedTurnId"], "fake-codex-turn");
    assert_eq!(steer["params"]["input"][0]["text"], "adjust task");
    assert_eq!(steer["params"]["input"][1]["type"], "localImage");
    assert_eq!(steer["params"]["input"][1]["path"], serde_json::json!(fixture.root().join("ws").join("attachment.png").to_string_lossy()));
    assert_eq!(requests.iter().filter(|frame| frame["method"] == "turn/start").count(), 1);
    assert_eq!(requests.iter().filter(|frame| frame["method"] == "turn/interrupt").count(), 0);
    let collected = events.lock().unwrap();
    let text: String = collected.iter().filter(|e| e["runId"] == run && e["kind"] == "delta")
        .filter_map(|e| e["data"].as_str()).collect();
    assert_eq!(text, "initial steered response");
    assert_eq!(collected.iter().filter(|e| e["runId"] == run && e["kind"] == "done").count(), 1);
    drop(collected);
    assert!(!engine::send_follow_up(app.state::<AppState>(), run.into(), "codex".into(), workspace, "late task".into(), None).await.unwrap());
}

#[tokio::test]
async fn codex_child_completion_keeps_parent_available_for_steering() {
    let fixture = TestHarness::new().unwrap();
    write_fake_codex_responses(&fixture, vec![
        ("turn/start", vec![
            serde_json::json!({"id":REPLY_ID,"result":{"turn":{"id":"fake-codex-turn"}}}),
            serde_json::json!({"method":"item/agentMessage/delta","params":{"threadId":"fake-codex-thread","turnId":"fake-codex-turn","delta":"parent waiting "}}),
            serde_json::json!({"method":"thread/started","params":{"thread":{"id":"child-thread"}}}),
            serde_json::json!({"method":"item/agentMessage/delta","params":{"threadId":"child-thread","turnId":"child-turn","delta":"child final"}}),
            serde_json::json!({"method":"thread/tokenUsage/updated","params":{"threadId":"child-thread","turnId":"child-turn","tokenUsage":{"last":{"outputTokens":471}}}}),
            serde_json::json!({"method":"turn/completed","params":{"threadId":"child-thread","turn":{"id":"child-turn","status":"completed"}}}),
            serde_json::json!({"method":"item/agentMessage/delta","params":{"threadId":"fake-codex-thread","turnId":"fake-codex-turn","delta":"still active "}}),
        ]),
        ("turn/steer", vec![
            serde_json::json!({"id":REPLY_ID,"result":{"turnId":"fake-codex-turn"}}),
            serde_json::json!({"method":"item/agentMessage/delta","params":{"threadId":"fake-codex-thread","turnId":"fake-codex-turn","delta":"parent final"}}),
            serde_json::json!({"method":"thread/tokenUsage/updated","params":{"threadId":"fake-codex-thread","turnId":"fake-codex-turn","tokenUsage":{"last":{"outputTokens":17}}}}),
            serde_json::json!({"method":"turn/completed","params":{"threadId":"fake-codex-thread","turn":{"id":"fake-codex-turn","status":"completed"}}}),
        ]),
    ]);
    let workspace = fixture.root().join("ws").to_string_lossy().to_string();
    let (app, events) = build_app(&fixture);
    let run = "codex-child-isolation";
    engine::send_message(app.state::<AppState>(), "codex".into(), workspace.clone(), None, "parent task".into(),
        None, None, None, None, None, Some(run.into()), None, None, None).await.unwrap();
    wait_until("parent continued after child completion", || count(&events, run, &["delta"]) == 2).await;
    assert_eq!(count(&events, run, &["done", "error"]), 0);
    assert!(app.state::<AppState>().processes.0.lock().unwrap().contains_key(run));
    assert!(engine::send_follow_up(app.state::<AppState>(), "fake-codex-thread".into(), "codex".into(), workspace,
        "continue parent".into(), None).await.unwrap());
    wait_for_settlement(&app, &events).await;
    let collected = events.lock().unwrap();
    let own: Vec<_> = collected.iter().filter(|event| event["runId"] == run).collect();
    let text: String = own.iter().filter(|event| event["kind"] == "delta").filter_map(|event| event["data"].as_str()).collect();
    assert_eq!(text, "parent waiting still active parent final");
    assert_eq!(own.iter().filter(|event| event["kind"] == "done").count(), 1);
    assert!(own.iter().all(|event| event["sessionId"] != "child-thread"));
    assert_eq!(own.iter().find(|event| event["kind"] == "done").unwrap()["data"]["usage"]["output_tokens"], 17);
}

#[tokio::test]
async fn codex_steer_protocol_error_mismatch_and_terminal_never_report_success() {
    for reply in [
        Some(serde_json::json!({"id":REPLY_ID,"error":{"code":-32602,"message":"turn rejected"}})),
        Some(serde_json::json!({"id":REPLY_ID,"result":{"turnId":"wrong-turn"}})),
        None,
    ] {
        let fixture = TestHarness::new().unwrap();
        let mut frames: Vec<Value> = reply.into_iter().collect();
        frames.push(serde_json::json!({"method":"turn/completed","params":{"threadId":"fake-codex-thread","turn":{"id":"fake-codex-turn","status":"completed"}}}));
        write_fake_codex_responses(&fixture, vec![
            ("turn/start", vec![
                serde_json::json!({"id":REPLY_ID,"result":{"turn":{"id":"fake-codex-turn"}}}),
                serde_json::json!({"method":"item/agentMessage/delta","params":{"threadId":"fake-codex-thread","turnId":"fake-codex-turn","delta":"initial"}}),
            ]),
            ("turn/steer", frames),
        ]);
        let workspace = fixture.root().join("ws").to_string_lossy().to_string();
        let (app, events) = build_app(&fixture);
        let run = "codex-steer-rejected";
        engine::send_message(app.state::<AppState>(), "codex".into(), workspace.clone(), None, "initial task".into(),
            None, None, None, None, None, Some(run.into()), None, None, None).await.unwrap();
        wait_until("initial Codex delta", || count(&events, run, &["delta"]) == 1).await;
        assert!(engine::send_follow_up(app.state::<AppState>(), run.into(), "codex".into(), workspace,
            "adjust task".into(), None).await.is_err());
        wait_for_settlement(&app, &events).await;
        let requests = fake_requests(&fixture);
        assert_eq!(requests.iter().filter(|frame| frame["method"] == "turn/start").count(), 1);
        assert_eq!(requests.iter().filter(|frame| frame["method"] == "turn/steer").count(), 1);
    }
}

#[tokio::test]
async fn codex_steer_cancel_wakes_pending_acknowledgement() {
    let fixture = TestHarness::new().unwrap();
    write_fake_codex_responses(&fixture, vec![
        ("turn/start", vec![
            serde_json::json!({"id":REPLY_ID,"result":{"turn":{"id":"fake-codex-turn"}}}),
            serde_json::json!({"method":"item/agentMessage/delta","params":{"threadId":"fake-codex-thread","turnId":"fake-codex-turn","delta":"initial"}}),
        ]),
        ("turn/steer", vec![]),
        ("turn/interrupt", vec![serde_json::json!({"method":"turn/completed","params":{"threadId":"fake-codex-thread","turn":{"id":"fake-codex-turn","status":"interrupted"}}})]),
    ]);
    let workspace = fixture.root().join("ws").to_string_lossy().to_string();
    let (app, events) = build_app(&fixture);
    let run = "codex-steer-cancel";
    engine::send_message(app.state::<AppState>(), "codex".into(), workspace.clone(), None, "initial task".into(),
        None, None, None, None, None, Some(run.into()), None, None, None).await.unwrap();
    wait_until("initial Codex delta", || count(&events, run, &["delta"]) == 1).await;
    let (steered, ()) = tokio::join!(
        engine::send_follow_up(app.state::<AppState>(), run.into(), "codex".into(), workspace, "adjust task".into(), None),
        async {
            wait_until("pending steer request", || fake_requests(&fixture).iter().any(|frame| frame["method"] == "turn/steer")).await;
            let processes = Arc::clone(&app.state::<AppState>().processes);
            assert!(tokio::task::spawn_blocking(move || processes.kill(run)).await.unwrap());
        },
    );
    assert!(steered.unwrap_err().contains("before the steering request was acknowledged"));
    wait_for_settlement(&app, &events).await;
    let requests = fake_requests(&fixture);
    assert_eq!(requests.iter().filter(|frame| frame["method"] == "turn/start").count(), 1);
    assert_eq!(requests.iter().filter(|frame| frame["method"] == "turn/interrupt").count(), 1);
}

const ORDINARY_TASK_GUIDANCE: &str = concat!(
    "Collaboration is available for this task without a separate mode. You retain responsibility for decisions, integration and acceptance. ",
    "Delegate within the user's task when useful and verify deliverables before reporting completion. ",
    "Each child sees only its task and shares workspace files: specify scope and coordinate edits. ",
    "Operate only direct children you created. Existing chats contacted with send_message remain independent. ",
    "Inspect task_list modelPolicy before choosing a model; omitted model and effort use user defaults. ",
    "Use task_wait when results are needed. TTL expiry prompts inspection, not termination. Completion preserves conversations.",
);

async fn first_root_live_case(name: &str, root_engine: &str) {
    if !in_coordinator_child(name) { return; }
    let fixture = TestHarness::new().unwrap();
    if root_engine == "claude" {
        write_fake_cli(&fixture, "claude", true);
        write_fake_codex_app_server(&fixture);
    } else {
        write_fake_cli(&fixture, "claude", false);
        live_codex(&fixture);
    }
    let workspace = fixture.root().join("ws").to_string_lossy().to_string();
    let (app, events) = build_app(&fixture);
    let state = app.state::<AppState>();
    register_root_workspace(state.inner(), &workspace);
    install_recording_coordinator(state.inner());
    // Ordinary first sends must not write a mode marker, even when the legacy
    // table remains present for stored-data migration.
    state.db.0.lock().execute_batch("CREATE TRIGGER reject_legacy_role_write BEFORE INSERT ON leader_roles BEGIN SELECT RAISE(ABORT, 'ordinary task must not write a role'); END;").unwrap();
    let run = "ordinary-first-root";
    let session = if root_engine == "claude" { "fake-hang-1" } else { "fake-codex-thread" };
    let sent = engine::ordinary_task_test_send(state.inner(), "main", root_engine.into(), workspace.clone(), None, run.into()).await.unwrap();
    assert!(sent.session_id.is_none());
    wait_until("first genuine root identity", || count(&events, run, &["session"]) == 1).await;
    assert_eq!(count(&events, run, &["error", "done"]), 0);
    let caller = ccgui_next_lib::leader::Caller {
        run_id: run.into(), engine: root_engine.into(), session_id: session.into(), workspace_path: workspace.clone(),
    };
    let list = ccgui_next_lib::leader::dispatch(state.inner(), caller.clone(), "task_list", serde_json::json!({})).await.unwrap();
    assert_eq!(list["branches"].as_array().unwrap().len(), 0);
    assert_eq!(state.db.0.lock().query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    assert_eq!(state.db.0.lock().query_row("SELECT COUNT(*) FROM leader_roles", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    // Assert the full root contract, not merely a role label. The fake Claude
    // CLI captures its prompt file before reading the first task from stdin.
    if root_engine == "claude" {
        let args = claude_args(&fixture);
        let instructions = std::fs::read_to_string(fixture.root().join("ws/claude-system.txt")).unwrap();
        assert!(args.contains("--append-system-prompt-file"), "missing initial root prompt file: {args}");
        let expected_instructions = format!("{ORDINARY_TASK_GUIDANCE}\n\n{}",
            include_str!("../../src/features/interactive-answer/capability-instructions.txt"));
        assert_eq!(instructions, expected_instructions, "incomplete initial root system guidance");
        let tasks = std::fs::read_to_string(fixture.root().join("ws/claude-tasks.ndjson")).unwrap();
        assert_eq!(tasks.lines().count(), 1);
        assert!(tasks.contains("first root task"));
    } else {
        wait_until("Codex first task", || fake_requests(&fixture).iter().any(|frame| frame["method"] == "turn/start")).await;
        let requests = fake_requests(&fixture);
        let thread = requests.iter().find(|frame| frame["method"] == "thread/start").unwrap();
        let expected_instructions = format!("{ORDINARY_TASK_GUIDANCE}\n\n{}",
            include_str!("../../src/features/interactive-answer/capability-instructions.txt"));
        assert_eq!(thread["params"]["developerInstructions"].as_str().unwrap(), expected_instructions,
            "Codex must preserve the complete task role followed by the presentation capability text");
        let configured = requests.iter().position(|frame| frame["method"] == "thread/start").unwrap();
        let first_turn = requests.iter().position(|frame| frame["method"] == "turn/start").unwrap();
        assert!(configured < first_turn, "root guidance must precede the first model turn");
        assert_eq!(requests.iter().filter(|frame| frame["method"] == "turn/start").count(), 1);
        assert!(requests.iter().find(|frame| frame["method"] == "turn/start").unwrap().to_string().contains("first root task"));
    }
    let child = ccgui_next_lib::leader::dispatch(state.inner(), caller.clone(), "task_spawn", serde_json::json!({
        "request_id":"first-child", "engine":if root_engine == "claude" { "codex" } else { "claude" },
        "title":"Child on first turn", "task":"Report a bounded result", "ttl_seconds":60,
    })).await.unwrap();
    assert!(child["branch"]["id"].is_string(), "{child}");
    assert_eq!(count(&events, run, &["error", "done"]), 0, "root must remain live during spawn");
    let processes = Arc::clone(&state.processes);
    assert!(tokio::task::spawn_blocking(move || processes.kill(run)).await.unwrap());
    wait_until("first root retirement", || retired(run) == Some(true)).await;
    // Verified identity provenance supports the next trusted active turn even
    // while the fake CLI has not created history; no persisted mode is needed.
    let followup = "root-followup-before-index";
    engine::send_message_inner(state.inner(), root_engine.into(), workspace.clone(), Some(session.into()),
        "follow-up".into(), None, None, None, None, None, Some(followup.into()), None, None,
    ).await.unwrap();
    wait_until("follow-up task accepted", || {
        if root_engine == "claude" {
            std::fs::read_to_string(fixture.root().join("ws/claude-tasks.ndjson"))
                .unwrap_or_default().lines().count() >= 2
        } else {
            fake_requests(&fixture).iter().filter(|frame| frame["method"] == "turn/start").count() >= 2
        }
    }).await;
    let next_caller = ccgui_next_lib::leader::Caller { run_id: followup.into(), ..caller };
    ccgui_next_lib::leader::dispatch(state.inner(), next_caller, "task_list", serde_json::json!({})).await.unwrap();
    assert_eq!(state.db.0.lock().query_row("SELECT COUNT(*) FROM leader_roles", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    let processes = Arc::clone(&state.processes);
    tokio::task::spawn_blocking(move || processes.kill(followup)).await.unwrap();
    wait_until("follow-up retirement", || retired(followup) == Some(true)).await;
}

#[tokio::test]
async fn first_root_claude_guidance_and_tools_before_indexing() {
    first_root_live_case("first_root_claude_guidance_and_tools_before_indexing", "claude").await;
}

#[tokio::test]
async fn first_root_codex_guidance_and_tools_before_indexing() {
    first_root_live_case("first_root_codex_guidance_and_tools_before_indexing", "codex").await;
}

async fn first_root_rejection_case(name: &str, engine_name: &str, failure: &str) {
    if !in_coordinator_child(name) { return; }
    let fixture = TestHarness::new().unwrap();
    if engine_name == "claude" { write_fake_cli(&fixture, "claude", true); }
    else { live_codex(&fixture); }
    let workspace = fixture.root().join("ws").to_string_lossy().to_string();
    let (app, events) = build_app(&fixture);
    let state = app.state::<AppState>();
    register_root_workspace(state.inner(), &workspace);
    install_recording_coordinator(state.inner());
    let session = if engine_name == "claude" { "fake-hang-1" } else { "fake-codex-thread" };
    if failure == "storage" {
        // New parents no longer persist roles. Make the authority lookup fail
        // instead: launch preparation uses its saved-session baseline, but
        // native identity binding must still read the branch ownership ledger.
        state.db.0.lock().execute_batch("ALTER TABLE leader_branches RENAME TO fixture_unavailable_branches;").unwrap();
    } else {
        state.processes.0.lock().unwrap().insert(session.into(), routed_entry("foreign-alias-owner", 0));
    }
    let run = "rejected-first-root";
    engine::ordinary_task_test_send(state.inner(), "main", engine_name.into(), workspace.clone(), None, run.into()).await.unwrap();
    wait_until("first-root rejection", || count(&events, run, &["error"]) == 1).await;
    wait_until("rejected-root retirement", || retired(run) == Some(true)).await;
    assert_eq!(count(&events, run, &["session", "done"]), 0, "no partial session grant");
    assert_eq!(state.db.0.lock().query_row("SELECT COUNT(*) FROM leader_roles", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    if engine_name == "codex" {
        assert_eq!(fake_requests(&fixture).iter().filter(|frame| frame["method"] == "turn/start").count(), 0, "rejected native identity must precede the first model task");
    }
    if failure == "storage" { state.db.0.lock().execute_batch("ALTER TABLE fixture_unavailable_branches RENAME TO leader_branches;").unwrap(); }
    else { state.processes.0.lock().unwrap().remove(session); }
    engine::ordinary_task_test_send(state.inner(), "main", engine_name.into(), workspace, None, "fresh-root-retry".into()).await.unwrap();
    wait_until("fresh draft retry identity", || count(&events, "fresh-root-retry", &["session"]) == 1).await;
    assert_eq!(state.db.0.lock().query_row("SELECT COUNT(*) FROM leader_roles", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
}

#[tokio::test]
async fn first_root_codex_storage_failure_stops_before_model_and_retries() {
    first_root_rejection_case("first_root_codex_storage_failure_stops_before_model_and_retries", "codex", "storage").await;
}

#[tokio::test]
async fn first_root_codex_alias_collision_stops_before_model_and_retries() {
    first_root_rejection_case("first_root_codex_alias_collision_stops_before_model_and_retries", "codex", "alias").await;
}

#[tokio::test]
async fn first_root_claude_storage_failure_revokes_and_retries() {
    first_root_rejection_case("first_root_claude_storage_failure_revokes_and_retries", "claude", "storage").await;
}

#[tokio::test]
async fn first_root_claude_alias_collision_revokes_and_retries() {
    first_root_rejection_case("first_root_claude_alias_collision_revokes_and_retries", "claude", "alias").await;
}

#[tokio::test]
async fn first_root_command_rejects_nonmain_resumed_remote_and_unregistered() {
    if !in_coordinator_child("first_root_command_rejects_nonmain_resumed_remote_and_unregistered") { return; }
    let fixture = TestHarness::new().unwrap();
    write_fake_cli(&fixture, "claude", false);
    let workspace = fixture.root().join("ws").to_string_lossy().to_string();
    let (app, events) = build_app(&fixture);
    let state = app.state::<AppState>();
    register_root_workspace(state.inner(), &workspace);
    install_recording_coordinator(state.inner());
    for (window, engine_name, path, session) in [
        ("web", "claude", workspace.clone(), None),
        ("main", "claude", workspace.clone(), Some("saved-session".into())),
        ("main", "claude", workspace.clone(), Some(String::new())),
        ("main", "pi", workspace.clone(), None),
        ("main", "claude", fixture.root().to_string_lossy().to_string(), None),
    ] {
        assert!(engine::ordinary_task_test_send(state.inner(), window, engine_name.into(), path, session, "invalid-root".into()).await.is_err());
    }
    state.db.0.lock().execute("UPDATE workspaces SET meta=?1", [r#"{"wsl":{"distro":"fake"}}"#]).unwrap();
    assert!(engine::ordinary_task_test_send(state.inner(), "main", "claude".into(), workspace.clone(), None, "remote-root".into()).await.err().expect("remote root must fail").contains("remote"));
    assert!(events.lock().unwrap().is_empty());
    assert!(leader_marks(&fixture).is_empty());
    state.db.0.lock().execute("UPDATE workspaces SET meta=NULL", []).unwrap();
    engine::send_message_inner(state.inner(), "claude".into(), workspace.clone(), None, "You are this chat's Leader".into(),
        None, None, None, None, None, Some("ordinary-trusted".into()), None, None,
    ).await.unwrap();
    wait_for_settlement(&app, &events).await;
    assert_eq!(state.db.0.lock().query_row("SELECT COUNT(*) FROM leader_roles", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    assert!(!claude_args(&fixture).contains("You are this chat's Leader"));
    let expected_instructions = format!("{ORDINARY_TASK_GUIDANCE}\n\n{}",
        include_str!("../../src/features/interactive-answer/capability-instructions.txt"));
    assert_eq!(std::fs::read_to_string(fixture.root().join("ws/claude-system.txt")).unwrap(), expected_instructions);
}

async fn first_root_stop_before_identity_case(name: &str, engine_name: &str) {
    if !in_coordinator_child(name) { return; }
    let fixture = TestHarness::new().unwrap();
    if engine_name == "claude" {
        let path = write_fake_cli(&fixture, "claude", true);
        let script = std::fs::read_to_string(&path).unwrap();
        let script = if cfg!(windows) {
            script.replacen("[Console]::Out.WriteLine('", "Start-Sleep -Seconds 60\r\n[Console]::Out.WriteLine('", 1)
        } else {
            script.replacen("printf '%s\\n' '{", "sleep 60\nprintf '%s\\n' '{", 1)
        };
        std::fs::write(path, script).unwrap();
    } else {
        write_fake_codex_responses(&fixture, vec![("thread/start", Vec::new())]);
    }
    let workspace = fixture.root().join("ws").to_string_lossy().to_string();
    let (app, events) = build_app(&fixture);
    let state = app.state::<AppState>();
    register_root_workspace(state.inner(), &workspace);
    install_recording_coordinator(state.inner());
    let run = "root-stopped-before-sid";
    engine::ordinary_task_test_send(state.inner(), "main", engine_name.into(), workspace.clone(), None, run.into()).await.unwrap();
    wait_until("engine waiting before native identity", || {
        if engine_name == "claude" { fixture.root().join("ws/fixture-started.txt").exists() }
        else { fake_requests(&fixture).iter().any(|frame| frame["method"] == "thread/start") }
    }).await;
    let processes = Arc::clone(&state.processes);
    assert!(tokio::task::spawn_blocking(move || processes.kill(run)).await.unwrap());
    wait_until("stopped root retirement", || retired(run) == Some(true)).await;
    assert_eq!(count(&events, run, &["session"]), 0);
    assert_eq!(state.db.0.lock().query_row("SELECT COUNT(*) FROM leader_roles", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    if engine_name == "claude" { write_fake_cli(&fixture, "claude", true); }
    else {
        assert_eq!(fake_requests(&fixture).iter().filter(|frame| frame["method"] == "turn/start").count(), 0);
        live_codex(&fixture);
    }
    engine::ordinary_task_test_send(state.inner(), "main", engine_name.into(), workspace, None, "retry-after-no-sid".into()).await.unwrap();
    wait_until("fresh retry after Stop before SID", || count(&events, "retry-after-no-sid", &["session"]) == 1).await;
}

#[tokio::test]
async fn first_root_claude_stop_before_identity_keeps_fresh_retry() {
    first_root_stop_before_identity_case("first_root_claude_stop_before_identity_keeps_fresh_retry", "claude").await;
}

#[tokio::test]
async fn first_root_codex_stop_before_identity_keeps_fresh_retry() {
    first_root_stop_before_identity_case("first_root_codex_stop_before_identity_keeps_fresh_retry", "codex").await;
}

#[tokio::test]
async fn first_root_real_scanner_indexes_own_transcript_before_native_header() {
    if !in_coordinator_child("first_root_real_scanner_indexes_own_transcript_before_native_header") { return; }
    let fixture = TestHarness::new().unwrap();
    let cli = write_fake_cli(&fixture, "claude", true);
    let script = std::fs::read_to_string(&cli).unwrap();
    let script = if cfg!(windows) {
        script.replacen("[Console]::Out.WriteLine('",
            "while (-not (Test-Path -LiteralPath 'release-native-id')) { Start-Sleep -Milliseconds 20 }\r\n[Console]::Out.WriteLine('", 1)
    } else {
        script.replacen("printf '%s\\n' '{", "while [ ! -f release-native-id ]; do sleep 0.02; done\nprintf '%s\\n' '{", 1)
    };
    std::fs::write(cli, script).unwrap();
    let workspace = fixture.root().join("ws").to_string_lossy().to_string();
    let (app, events) = build_app(&fixture);
    let state = app.state::<AppState>();
    register_root_workspace(state.inner(), &workspace);
    install_recording_coordinator(state.inner());
    let run = "root-before-scanner-header";
    engine::ordinary_task_test_send(state.inner(), "main", "claude".into(), workspace.clone(), None, run.into()).await.unwrap();
    wait_until("fake CLI first task before native header", || {
        std::fs::read_to_string(fixture.root().join("ws/claude-tasks.ndjson"))
            .unwrap_or_default().lines().count() == 1
    }).await;
    let session = "fake-hang-1";
    let native_dir = fixture.root().join(".claude/projects")
        .join(ccgui_next_lib::history::claude_encode_project_path(&workspace));
    std::fs::create_dir_all(&native_dir).unwrap();
    let native_file = native_dir.join(format!("{session}.jsonl"));
    std::fs::write(&native_file, format!("{}\n", serde_json::json!({
        "type":"user", "sessionId":session, "cwd":workspace,
        "timestamp":"2026-10-04T00:00:00.000Z", "message":{"role":"user","content":"first root task"},
    }))).unwrap();
    let report = ccgui_next_lib::history::scanner::scan_with(&state.db, || {}).unwrap();
    assert_eq!(report.reparsed, 1);
    let indexed_workspace: String = state.db.0.lock().query_row(
        "SELECT workspace_path FROM sessions WHERE engine='claude' AND session_id=?1", [session], |row| row.get(0),
    ).unwrap();
    assert_eq!(indexed_workspace, workspace);
    assert_eq!(count(&events, run, &["session"]), 0, "scanner must win this interleave");
    state.db.0.lock().execute("UPDATE sessions SET custom_title='preserve-native-cache-row' WHERE engine='claude' AND session_id=?1", [session]).unwrap();
    std::fs::write(fixture.root().join("ws/release-native-id"), "release").unwrap();
    wait_until("root identity after real history scan", || count(&events, run, &["session"]) == 1).await;
    assert_eq!(count(&events, run, &["error"]), 0);
    ccgui_next_lib::leader::dispatch(state.inner(), ccgui_next_lib::leader::Caller {
        run_id: run.into(), engine:"claude".into(), session_id:session.into(), workspace_path:workspace,
    }, "task_list", serde_json::json!({})).await.unwrap();
    let retained: (String, String) = state.db.0.lock().query_row(
        "SELECT file_path,custom_title FROM sessions WHERE engine='claude' AND session_id=?1", [session], |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    assert_eq!(retained, (native_file.to_string_lossy().to_string(), "preserve-native-cache-row".into()));
    let processes = Arc::clone(&state.processes);
    tokio::task::spawn_blocking(move || processes.kill(run)).await.unwrap();
    wait_until("scanner-race root retirement", || retired(run) == Some(true)).await;
}

/// A client may reuse a completed isolated run id. The engine inserts the new
/// placeholder first; the coordinator admits the retry once the previous
/// round retired. Two real rounds each for plugin and mission sends.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn coordinator_accepts_real_retries_of_completed_isolated_run_ids() {
    if !in_coordinator_child("coordinator_accepts_real_retries_of_completed_isolated_run_ids") {
        return;
    }
    let fixture = TestHarness::new().unwrap();
    write_fake_cli(&fixture, "claude", false);
    let workspace = fixture.root().join("ws").to_string_lossy().to_string();
    let (app, chat_events) = build_app(&fixture);
    let state = app.state::<AppState>();
    let deleted = install_recording_coordinator(state.inner());
    for (source, event_name) in [
        (Source::Plugin, ccgui_next_lib::event_sink::PLUGIN_AGENT_EVENT_NAME),
        (Source::Mission, ccgui_next_lib::event_sink::MISSION_AGENT_EVENT_NAME),
    ] {
        let (events, listener) = capture(&app, event_name);
        let run = format!("retry-{source:?}");
        for round in 1..=2 {
            // Retirement trails the terminal event: until then the id still
            // belongs to the previous round and the retry is refused.
            tokio::time::timeout(std::time::Duration::from_secs(15), async {
                loop {
                    let sent = engine::isolated_send_test_support::send(
                        state.inner(), source, "claude".into(), workspace.clone(), None, run.clone(),
                    ).await;
                    match sent {
                        Ok(_) => break,
                        Err(error) if error.contains("already") => {
                            tokio::time::sleep(std::time::Duration::from_millis(20)).await
                        }
                        Err(error) => panic!("{source:?} round {round} rejected: {error}"),
                    }
                }
            })
            .await
            .expect("a completed run id was never accepted again");
            wait_until("round settlement", || count(&events, &run, &["done", "error"]) == round).await;
            assert_eq!(count(&events, &run, &["done"]), round);
        }
        wait_until("final retirement", || retired(&run) == Some(true)).await;
        app.unlisten(listener);
    }
    assert!(chat_events.lock().unwrap().is_empty());
    assert!(deleted.lock().unwrap().is_empty());
}

/// A retry refused while the previous run sits between registry removal and
/// its own finish must not retire that run's ledger entry: the next retry
/// would slip in, and the old finish would then retire the live replacement.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn coordinator_rejected_retry_cannot_retire_the_previous_run() {
    if !in_coordinator_child("coordinator_rejected_retry_cannot_retire_the_previous_run") {
        return;
    }
    let fixture = TestHarness::new().unwrap();
    write_fake_cli(&fixture, "claude", true);
    let workspace = fixture.root().join("ws").to_string_lossy().to_string();
    let (app, chat_events) = build_app(&fixture);
    let state = app.state::<AppState>();
    install_recording_coordinator(state.inner());
    let (events, _listener) = capture(&app, ccgui_next_lib::event_sink::PLUGIN_AGENT_EVENT_NAME);
    let run = "retry-window";
    let send = || engine::isolated_send_test_support::send(
        state.inner(), Source::Plugin, "claude".into(), workspace.clone(), None, run.into(),
    );
    send().await.unwrap();
    wait_until("previous session", || count(&events, run, &["session"]) == 1).await;
    // Hold the window open: the registry is drained, finish() has not run.
    let previous: Vec<engine::ChildEntry> = {
        let mut map = state.processes.0.lock().unwrap();
        let keys: Vec<String> =
            map.iter().filter(|(_, entry)| entry.run_id == run).map(|(key, _)| key.clone()).collect();
        keys.iter().filter_map(|key| map.remove(key)).collect()
    };
    let previous_child = previous.into_iter().find(|entry| entry.child.is_some()).expect("previous child");
    let Err(error) = send().await else { panic!("retry accepted before the previous finish") };
    assert!(error.contains("already"), "{error}");
    assert_eq!(retired(run), Some(false), "a refused retry retired the previous run");
    assert!(send().await.is_err(), "a second retry slipped in before the previous finish");
    // The reader's exit watcher owns the child lock: stop the tree the way the
    // registry does (by pid), without re-registering the previous run.
    let stopper = Arc::new(ProcessRegistry::default());
    stopper.0.lock().unwrap().insert("previous".into(), previous_child);
    assert!(stopper.kill("previous"));
    wait_until("previous retirement", || retired(run) == Some(true)).await;
    send().await.unwrap();
    wait_until("replacement session", || count(&events, run, &["session"]) == 2).await;
    assert_eq!(retired(run), Some(false), "the previous finish retired its replacement");
    state.processes.kill(run);
    wait_until("replacement retirement", || retired(run) == Some(true)).await;
    assert!(chat_events.lock().unwrap().is_empty());
}

/// A managed child whose engine announces a session another live run already
/// routes must not claim it. A model cannot delete either child; explicit user
/// group deletion skips the unowned identity, deletes the owned child and root,
/// and keeps tombstones fencing isolated resumes.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn coordinator_managed_child_never_claims_a_colliding_session() {
    if !in_coordinator_child("coordinator_managed_child_never_claims_a_colliding_session") {
        return;
    }
    let fixture = TestHarness::new().unwrap();
    write_fake_cli(&fixture, "claude", false);
    let workspace = fixture.root().join("ws").to_string_lossy().to_string();
    let (app, chat_events) = build_app(&fixture);
    let state = app.state::<AppState>();
    ccgui_next_lib::leader::prepare_run(&state.db, "schema-only", "pi", None, &workspace, None).unwrap();
    {
        let conn = state.db.0.lock();
        conn.execute("INSERT INTO workspaces(id,path,name) VALUES('fixture-ws',?1,'ws')", [&workspace]).unwrap();
        conn.execute(
            "INSERT INTO sessions(engine,session_id,workspace_path,file_path,file_size,file_mtime_ms)
             VALUES('claude','managed-root',?1,'fixture',0,0)",
            [&workspace],
        ).unwrap();
    }
    let deleted = install_recording_coordinator(state.inner());
    let caller = ccgui_next_lib::leader::Caller {
        run_id: "parent-run".into(),
        engine: "claude".into(),
        session_id: "managed-root".into(),
        workspace_path: workspace.clone(),
    };
    ccgui_next_lib::leader::prepare_run(&state.db, &caller.run_id, "claude", Some("managed-root"), &workspace, Some("auto")).unwrap();
    state.processes.0.lock().unwrap().insert(caller.run_id.clone(), routed_entry(&caller.run_id, 4100));
    let dispatch = |method: &'static str, arguments: Value| {
        ccgui_next_lib::leader::dispatch(state.inner(), caller.clone(), method, arguments)
    };
    let spawn = |request: &str| serde_json::json!({
        "request_id": request, "engine": "claude", "title": "fixture child", "task": "fixture task",
    });
    let listed = |id: &str, views: &Value| -> Value {
        views["branches"].as_array().unwrap().iter().find(|b| b["id"] == id).unwrap().clone()
    };

    // Another live run already routes the session the fake engine announces.
    state.processes.0.lock().unwrap().insert("fake-session-123".into(), routed_entry("foreign-run", 4242));
    let first = dispatch("task_spawn", spawn("collides")).await.unwrap();
    let first_id = first["branch"]["id"].as_str().unwrap().to_string();
    let first_run = first["branch"]["runId"].as_str().unwrap().to_string();
    wait_until("colliding child retirement", || retired(&first_run) == Some(true)).await;
    let branch = listed(&first_id, &dispatch("task_list", serde_json::json!({})).await.unwrap());
    assert!(branch["sessionId"].is_null(), "child claimed another run's session: {branch}");
    assert_eq!(branch["state"], "failed");
    assert_eq!(count(&chat_events, &first_run, &["error"]), 1);
    assert_eq!(count(&chat_events, &first_run, &["session"]), 0);
    assert_eq!(state.processes.0.lock().unwrap()["fake-session-123"].run_id, "foreign-run");
    for method in ["leader_spawn", "leader_list", "leader_wait", "leader_send", "leader_renew", "leader_stop", "leader_reclaim", "task_reclaim"] {
        let arguments = serde_json::json!({"branch_id": first_id});
        assert!(ccgui_next_lib::leader::validate_arguments(method, arguments.clone()).is_err(), "retired tool {method} was accepted");
        let rejected = dispatch(method, arguments).await.unwrap_err();
        assert!(rejected.to_ascii_lowercase().contains("unknown"), "{method}: {rejected}");
    }
    assert!(deleted.lock().unwrap().is_empty(), "model deletion reached another run's session");

    state.processes.0.lock().unwrap().remove("fake-session-123");
    let second = dispatch("task_spawn", spawn("owns")).await.unwrap();
    let second_id = second["branch"]["id"].as_str().unwrap().to_string();
    let second_run = second["branch"]["runId"].as_str().unwrap().to_string();
    wait_until("owning child retirement", || retired(&second_run) == Some(true)).await;
    let branch = listed(&second_id, &dispatch("task_list", serde_json::json!({})).await.unwrap());
    assert_eq!(branch["sessionId"], "fake-session-123");
    assert_eq!(branch["state"], "completed");
    for (run, phase) in [("plugin-on-child", "live child"), ("plugin-on-tombstone", "tombstone")] {
        if phase == "tombstone" {
            for method in ["leader_reclaim", "task_reclaim"] {
                let rejected = dispatch(method, serde_json::json!({"branch_id": second_id})).await.unwrap_err();
                assert!(rejected.to_ascii_lowercase().contains("unknown"), "{method}: {rejected}");
            }
            assert!(deleted.lock().unwrap().is_empty());
            // The user may delete the whole group after its root run retires.
            state.processes.0.lock().unwrap().remove(&caller.run_id);
            ccgui_next_lib::leader::finish_run(&caller.run_id);
            let remaining = ccgui_next_lib::leader::test_group_action(state.inner(), ccgui_next_lib::leader::LeaderIdentity {
                engine: caller.engine.clone(), session_id: caller.session_id.clone(), workspace_path: caller.workspace_path.clone(),
            }, "delete").await.unwrap();
            assert!(remaining.branches.is_empty());
            assert!(remaining.archived_groups.is_empty());
            assert_eq!(*deleted.lock().unwrap(), vec!["claude/fake-session-123".to_string(), "claude/managed-root".to_string()]);
        }
        let Err(error) = engine::isolated_send_test_support::send(
            state.inner(), Source::Plugin, "claude".into(), workspace.clone(),
            Some("fake-session-123".into()), run.into(),
        ).await else { panic!("{phase}: isolated agent resumed the managed child") };
        assert!(error.contains("managed"), "{phase}: {error}");
    }
}

/// Only a managed child's processes carry `CCGUI_LEADER_CHILD`: Claude and
/// Codex children the parent launches, and a turn sent from the child's own
/// tab. The ordinary parent stays unmarked, so local integrations such as
/// completion notices keep reporting the chat the user drives.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn coordinator_marks_only_managed_child_processes() {
    if !in_coordinator_child("coordinator_marks_only_managed_child_processes") {
        return;
    }
    let fixture = TestHarness::new().unwrap();
    write_fake_cli(&fixture, "claude", false);
    write_fake_codex_app_server(&fixture);
    let workspace = fixture.root().join("ws").to_string_lossy().to_string();
    let (app, _chat_events) = build_app(&fixture);
    let state = app.state::<AppState>();
    ccgui_next_lib::leader::prepare_run(&state.db, "schema-only", "pi", None, &workspace, None).unwrap();
    {
        let conn = state.db.0.lock();
        conn.execute("INSERT INTO workspaces(id,path,name) VALUES('fixture-ws',?1,'ws')", [&workspace]).unwrap();
        conn.execute(
            "INSERT INTO sessions(engine,session_id,workspace_path,file_path,file_size,file_mtime_ms)
             VALUES('claude','managed-root',?1,'fixture',0,0)",
            [&workspace],
        ).unwrap();
    }
    install_recording_coordinator(state.inner());
    let caller = ccgui_next_lib::leader::Caller {
        run_id: "parent-run".into(),
        engine: "claude".into(),
        session_id: "managed-root".into(),
        workspace_path: workspace.clone(),
    };
    ccgui_next_lib::leader::prepare_run(&state.db, &caller.run_id, "claude", Some("managed-root"), &workspace, Some("auto")).unwrap();
    state.processes.0.lock().unwrap().insert(caller.run_id.clone(), routed_entry(&caller.run_id, 4100));

    for engine in ["claude", "codex"] {
        let spawned = ccgui_next_lib::leader::dispatch(state.inner(), caller.clone(), "task_spawn", serde_json::json!({
            "request_id": format!("mark-{engine}"), "engine": engine, "title": "fixture child", "task": "fixture task",
        })).await.unwrap();
        let run = spawned["branch"]["runId"].as_str().unwrap().to_string();
        wait_until(&format!("{engine} child retirement"), || retired(&run) == Some(true)).await;
    }
    assert_eq!(leader_marks(&fixture), ["claude:[1]", "codex:[1]"]);

    // The user writes in the child's own tab, then in the ordinary parent.
    for (session, run) in [("fake-session-123", "child-tab-run"), ("managed-root", "root-run")] {
        engine::send_message_inner(
            state.inner(), "claude".into(), workspace.clone(), Some(session.into()), "fixture turn".into(),
            None, None, None, Some("auto".into()), None, Some(run.into()), None,
            None,
        ).await.unwrap();
        wait_until(run, || retired(run) == Some(true)).await;
    }
    assert_eq!(leader_marks(&fixture), ["claude:[1]", "codex:[1]", "claude:[1]", "claude:[]"]);
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn send_message_streams_events_end_to_end() {
    let fixture = TestHarness::new().unwrap();
    let home = fixture.root();
    write_fake_cli(&fixture, "claude", false);
    let workspace = home.join("ws");

    let (app, events) = build_app(&fixture);
    let state = app.state::<AppState>();

    let result = engine::send_message(
        state,
        "claude".to_string(),
        workspace.to_string_lossy().to_string(),
        None,
        "hi".to_string(),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None, None,
    )
    .await
    .expect("send_message must succeed");
    assert!(!result.run_id.is_empty());

    wait_for_settlement(&app, &events).await;
    assert_fixture_started(&fixture, "claude");

    let collected = events.lock().unwrap();
    let kinds: Vec<&str> = collected
        .iter()
        .filter_map(|e| e.get("kind").and_then(Value::as_str))
        .collect();
    assert!(
        kinds.contains(&"session"),
        "session event missing: {kinds:?}"
    );
    assert!(kinds.contains(&"delta"), "delta events missing: {kinds:?}");

    let session_event = collected
        .iter()
        .find(|e| e.get("kind").and_then(Value::as_str) == Some("session"))
        .unwrap();
    assert_eq!(
        session_event.get("data").and_then(Value::as_str),
        Some("fake-session-123")
    );
    let delta_text: String = collected
        .iter()
        .filter(|e| e.get("kind").and_then(Value::as_str) == Some("delta"))
        .filter_map(|e| e.get("data").and_then(Value::as_str).map(str::to_string))
        .collect();
    assert_eq!(delta_text, "Hello from fake");
    assert!(
        kinds.iter().position(|kind| *kind == "session").unwrap()
            < kinds.iter().position(|kind| *kind == "delta").unwrap()
    );
    assert!(
        kinds.iter().rposition(|kind| *kind == "delta").unwrap()
            < kinds.iter().position(|kind| *kind == "done").unwrap()
    );

    let done = collected
        .iter()
        .find(|e| e.get("kind").and_then(Value::as_str) == Some("done"))
        .unwrap();
    assert_eq!(
        done.get("sessionId").and_then(Value::as_str),
        Some("fake-session-123")
    );

    // Process registry drained after exit.
    assert!(app
        .state::<AppState>()
        .processes
        .0
        .lock()
        .unwrap()
        .is_empty());
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn auto_title_origin_local_send_adopts_native_identity_and_retires_after_exit() {
    let fixture = TestHarness::new().unwrap();
    write_fake_cli_with_origin_gate(&fixture, "claude", false, true);
    let workspace = fixture.root().join("ws");
    let workspace_path = workspace.to_string_lossy().to_string();
    let (app, events) = build_app(&fixture);
    let state = app.state::<AppState>();
    register_root_workspace(state.inner(), &workspace_path);
    assert_ne!(
        ccgui_next_lib::settings::read_settings().unwrap_or_default().auto_title_enabled,
        Some(true),
        "this regression must not enable model-backed naming"
    );
    let run = "title-origin-local";
    assert!(title_origins::snapshot(run).is_none());
    let result = engine::send_message(
        state, "claude".into(), workspace_path.clone(), None, "fixture turn".into(),
        None, None, None, None, None, Some(run.into()), None,
        None, None,
    ).await.unwrap();
    assert_eq!(result.run_id, run);

    // The CLI has not emitted its first protocol frame. A fresh GUI send
    // must already be admitted, without mistaking its run id for a session.
    let registered = title_origins::snapshot(run).expect("local send did not register its source");
    assert_eq!(registered.engine, "claude");
    assert_eq!(registered.workspace_path, workspace_path);
    assert_eq!(registered.session_id, None);
    assert!(!registered.killed && !registered.interrupted);
    std::fs::write(workspace.join("origin-first-release"), b"release").unwrap();
    wait_until("local source successful result", || {
        events.lock().unwrap().iter().any(|event| event["runId"] == run && event["kind"] == "done")
    }).await;
    assert_fixture_started(&fixture, "claude");
    let adopted = title_origins::snapshot(run).expect("source retired before the real reader exited");
    assert_eq!(adopted.session_id.as_deref(), Some("fake-session-123"));
    assert!(!adopted.killed && !adopted.interrupted);
    {
        let collected = events.lock().unwrap();
        let emitted: Vec<_> = collected.iter().filter(|event| event["runId"] == run).collect();
        assert!(emitted.iter().all(|event| event["sourceRunId"] == run && event["engine"] == adopted.engine));
        let session = emitted.iter().find(|event| event["kind"] == "session").unwrap();
        assert_eq!(session["data"], "fake-session-123");
        let done = emitted.iter().find(|event| event["kind"] == "done").unwrap();
        assert_eq!(done["sessionId"].as_str(), adopted.session_id.as_deref());
        assert_eq!(done["data"]["usage"]["output_tokens"], 5);
        assert_ne!(done["data"]["interrupted"], true);
        assert!(!emitted.iter().any(|event| event["kind"] == "error"));
    }
    assert!(!app.state::<AppState>().processes.0.lock().unwrap().is_empty());
    std::fs::write(workspace.join("origin-exit-release"), b"release").unwrap();
    wait_for_settlement(&app, &events).await;
    wait_until("local source retirement", || title_origins::snapshot(run).is_none()).await;
    let title_rows: i64 = app.state::<AppState>().db.0.lock()
        .query_row("SELECT COUNT(*) FROM session_auto_titles", [], |row| row.get(0)).unwrap();
    assert_eq!(title_rows, 0, "disabled naming must not persist a title");
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn auto_title_origin_isolated_sends_never_register_even_in_a_local_workspace() {
    let fixture = TestHarness::new().unwrap();
    write_fake_cli_with_origin_gate(&fixture, "claude", false, true);
    let workspace = fixture.root().join("ws");
    let workspace_path = workspace.to_string_lossy().to_string();
    let (app, chat_events) = build_app(&fixture);
    register_root_workspace(app.state::<AppState>().inner(), &workspace_path);
    assert_ne!(
        ccgui_next_lib::settings::read_settings().unwrap_or_default().auto_title_enabled,
        Some(true)
    );
    for (source, event_name) in [
        (Source::Plugin, ccgui_next_lib::event_sink::PLUGIN_AGENT_EVENT_NAME),
        (Source::Mission, ccgui_next_lib::event_sink::MISSION_AGENT_EVENT_NAME),
        (Source::ConstrainedChat, ENGINE_EVENT_NAME),
    ] {
        let events = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = Arc::clone(&events);
        let listener = app.listen_any(event_name, move |event| {
            if let Ok(batch) = serde_json::from_str::<Vec<Value>>(event.payload()) {
                captured.lock().unwrap().extend(batch);
            }
        });
        let run = format!("title-origin-isolated-{source:?}");
        assert!(title_origins::snapshot(&run).is_none());
        engine::isolated_send_test_support::send(
            app.state::<AppState>().inner(), source, "claude".into(),
            workspace_path.clone(), None, run.clone(),
        ).await.unwrap();
        assert!(title_origins::snapshot(&run).is_none(), "isolated launch gained a title source: {source:?}");
        std::fs::write(workspace.join("origin-first-release"), b"release").unwrap();
        wait_until("isolated source successful result", || {
            events.lock().unwrap().iter().any(|event| event["runId"] == run && event["kind"] == "done")
        }).await;
        assert!(title_origins::snapshot(&run).is_none(), "native identity admitted an isolated source: {source:?}");
        {
            let collected = events.lock().unwrap();
            let session = collected.iter().find(|event| event["runId"] == run && event["kind"] == "session").unwrap();
            assert_eq!(session["data"], "fake-session-123");
            let done = collected.iter().find(|event| event["runId"] == run && event["kind"] == "done").unwrap();
            assert_eq!(done["sourceRunId"], run);
            assert_eq!(done["sessionId"], "fake-session-123");
            assert_eq!(done["data"]["usage"]["output_tokens"], 5);
            assert_ne!(done["data"]["interrupted"], true);
        }
        if matches!(source, Source::Plugin | Source::Mission) {
            assert!(chat_events.lock().unwrap().is_empty());
        }
        assert!(!app.state::<AppState>().processes.0.lock().unwrap().is_empty());
        std::fs::write(workspace.join("origin-exit-release"), b"release").unwrap();
        wait_for_settlement(&app, &events).await;
        assert!(title_origins::snapshot(&run).is_none());
        app.unlisten(listener);
        std::fs::remove_file(workspace.join("origin-first-release")).unwrap();
        std::fs::remove_file(workspace.join("origin-exit-release")).unwrap();
    }
    let title_rows: i64 = app.state::<AppState>().db.0.lock()
        .query_row("SELECT COUNT(*) FROM session_auto_titles", [], |row| row.get(0)).unwrap();
    assert_eq!(title_rows, 0);
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn interrupt_kills_running_child() {
    let fixture = TestHarness::new().unwrap();
    let home = fixture.root();
    write_fake_cli(&fixture, "claude", true);
    let workspace = home.join("ws");

    let (app, events) = build_app(&fixture);
    let state = app.state::<AppState>();
    engine::send_message(
        state,
        "claude".to_string(),
        workspace.to_string_lossy().to_string(),
        None,
        "hi".to_string(),
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None, None,
    )
    .await
    .unwrap();

    // Wait for the session event (child registered under native id).
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let seen = events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e.get("kind").and_then(Value::as_str) == Some("session"));
        if seen {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "no session event within 5s"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_fixture_started(&fixture, "claude");

    let killed = engine::interrupt_session(app.state::<AppState>(), "fake-hang-1".to_string())
        .await
        .unwrap();
    assert!(killed, "interrupt must find and kill the child");

    // Child exits shortly after start_kill.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        if app
            .state::<AppState>()
            .processes
            .0
            .lock()
            .unwrap()
            .is_empty()
        {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "child still registered after kill"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !events
        .lock()
        .unwrap()
        .iter()
        .any(|event| matches!(event["kind"].as_str(), Some("done" | "error")))
    {
        assert!(
            std::time::Instant::now() < deadline,
            "interrupt did not publish a terminal event"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}

/// The JS side invokes with camelCase args (`workspacePath`, `sessionId`,
/// `imagePaths`) against snake_case Rust params; this drives the real IPC
/// router to prove that contract plus the command's presence in the handler.
#[test]
fn ipc_send_message_accepts_camel_case_args() {
    let fixture = TestHarness::new().unwrap();
    let home = fixture.root();
    write_fake_cli(&fixture, "claude", false);
    let workspace = home.join("ws");
    let (app, events) = build_app(&fixture);
    let webview = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();

    let res = tauri::test::get_ipc_response(
        &webview,
        tauri::webview::InvokeRequest {
            cmd: "send_message".into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: if cfg!(windows) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .unwrap(),
            body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                "engine": "claude",
                "workspacePath": workspace.to_string_lossy(),
                "sessionId": null,
                "prompt": "hi",
                "imagePaths": null,
                "model": null,
            })),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.to_string(),
        },
    );
    let body = res.unwrap_or_else(|e| panic!("IPC send_message failed: {e}"));
    let value = body.deserialize::<Value>().unwrap();
    let run_id = value.get("runId").and_then(Value::as_str).unwrap_or("");
    assert!(!run_id.is_empty(), "expected runId in response: {value}");
    tauri::async_runtime::block_on(wait_for_settlement(&app, &events));
    assert_fixture_started(&fixture, "claude");
    assert!(events
        .lock()
        .unwrap()
        .iter()
        .any(|event| event["kind"] == "session" && event["data"] == "fake-session-123"));
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn omp_send_uses_persisted_tier_and_model_without_touching_cli_config() {
    let fixture = TestHarness::new().unwrap();
    let home = fixture.root();
    write_fake_cli(&fixture, "omp", false);
    let workspace = home.join("ws");
    let (app, events) = build_app(&fixture);
    let mut settings = ccgui_next_lib::settings::AppSettings::default();
    for (model, tier) in [
        ("openai-codex/gpt-5.4", Some("priority")),
        ("openai-codex/gpt-5.4", Some("default")),
        ("openai-codex/gpt-5.4", None),
        ("openai/gpt-5.4", Some("priority")),
        ("anthropic/claude", Some("priority")),
        ("google/gemini", Some("priority")),
        ("openai-codex/gpt-5.4", Some("priority")),
    ] {
        settings.default_models.insert("omp".into(), model.into());
        settings.omp_openai_service_tier = tier.map(str::to_string);
        ccgui_next_lib::settings::update_app_settings(app.handle().clone(), settings.clone())
            .unwrap();
        let persisted: Value = serde_json::from_str(
            &std::fs::read_to_string(home.join(".ccgui-next/settings.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(persisted["defaultModels"]["omp"], model);
        assert_eq!(persisted["ompOpenaiServiceTier"].as_str(), tier);
        events.lock().unwrap().clear();
        for file in ["omp-args.txt", "fixture-started.txt", "fixture-home.txt"] {
            let path = workspace.join(file);
            if path.exists() {
                std::fs::remove_file(path).unwrap();
            }
        }
        engine::send_message(
            app.state(),
            "omp".into(),
            workspace.to_string_lossy().into(),
            None,
            "hi".into(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None, None,
        )
        .await
        .unwrap();
        wait_for_settlement(&app, &events).await;
        assert_fixture_started(&fixture, "omp");
        let text = std::fs::read_to_string(workspace.join("omp-args.txt")).unwrap();
        let args: Vec<_> = text.lines().collect();
        assert!(args.windows(2).any(|a| a == ["--model", model]));
        let actual = args
            .iter()
            .position(|a| *a == "--service-tier")
            .map(|i| args[i + 1]);
        let expected = if model.starts_with("openai-codex/") {
            tier
        } else {
            None
        };
        assert_eq!(actual, expected, "model {model}");
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e["kind"] == "delta" && e["data"] == "ok"));
    }
    assert!(!home.join(".omp/agent/config.yml").exists());
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn missing_fake_cli_never_falls_back_to_installed_or_external_binaries() {
    let fixture = TestHarness::new().unwrap();
    let home = fixture.root().to_path_buf();
    let workspace = home.join("ws");
    let (app, events) = build_app(&fixture);
    let fake = write_fake_cli(&fixture, "claude", false);
    std::fs::remove_file(fake).unwrap();
    let external_binary = std::env::current_exe().unwrap();
    assert!(fixture.register_cli("claude", &external_binary).is_err());

    // Both a removed registered CLI and an absolute executable outside the
    // fixture must fail before spawn, even with the real process PATH intact.
    for custom_binary in [None, Some(external_binary)] {
        let mut settings = ccgui_next_lib::settings::AppSettings::default();
        if let Some(path) = custom_binary {
            settings.bin_overrides.insert(
                "claudeBin".into(),
                Value::String(path.to_string_lossy().into()),
            );
        }
        std::fs::write(
            home.join(".ccgui-next/settings.json"),
            serde_json::to_vec(&settings).unwrap(),
        )
        .unwrap();
        engine::resolve::clear_search_paths_cache();
        let error = engine::send_message(
            app.state(),
            "claude".into(),
            workspace.to_string_lossy().into(),
            None,
            "hi".into(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None, None,
        )
        .await
        .err()
        .expect("missing or external fake CLI must fail");
        assert!(
            error.contains("failed to spawn") && error.contains("missing-fake-cli"),
            "unexpected refusal: {error}"
        );
        assert!(app
            .state::<AppState>()
            .processes
            .0
            .lock()
            .unwrap()
            .is_empty());
        assert!(!workspace.join("fixture-started.txt").exists());
        assert!(!events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event["kind"] == "delta"));
    }
    drop(app);
    drop(fixture);
    assert!(!home.exists(), "owned scratch root must be cleaned");
}

/// A stand-in for Codex Desktop's app-tools pipe, served by this test under a
/// fixture-only name. It records sends and scripts the thread's readings: the
/// `before` reading until something was sent, then each reading takes the
/// next scripted snapshot, the last one repeating.
#[cfg(windows)]
struct FakeDesktop {
    sends: Arc<Mutex<Vec<Value>>>,
}

#[cfg(windows)]
impl FakeDesktop {
    fn serve(fixture: &TestHarness, thread: &str, status: &str, after: Vec<Value>) -> Self {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::windows::named_pipe::ServerOptions;
        let name = format!(
            r"\\.\pipe\ccgui-fixture-desktop-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        );
        fixture.register_codex_desktop_pipe(&name).unwrap();
        let workspace = fixture.root().join("ws").to_string_lossy().to_string();
        let before = serde_json::json!({
            "schemaVersion": 1,
            "thread": {"id": thread, "status": {"type": status}, "cwd": workspace},
            "turns": [{"id": "desktop-turn-0", "status": "completed", "items": [
                {"type": "userMessage", "id": "u0"},
                {"type": "agentMessage", "id": "a0", "text": "earlier answer"}]}],
        });
        let sends = Arc::new(Mutex::new(Vec::new()));
        let readings = Arc::new(Mutex::new((before, after, 0usize)));
        let mut server = ServerOptions::new().first_pipe_instance(true).create(&name).unwrap();
        let recorded = Arc::clone(&sends);
        tokio::spawn(async move {
            loop {
                if server.connect().await.is_err() {
                    return;
                }
                let mut connection = server;
                server = match ServerOptions::new().create(&name) {
                    Ok(next) => next,
                    Err(_) => return,
                };
                let (recorded, readings) = (Arc::clone(&recorded), Arc::clone(&readings));
                tokio::spawn(async move {
                    while let Ok(length) = connection.read_u32_le().await {
                        let mut body = vec![0; length as usize];
                        if connection.read_exact(&mut body).await.is_err() {
                            return;
                        }
                        let request: Value = serde_json::from_slice(&body).unwrap();
                        let params = &request["params"];
                        let result = match (request["method"].as_str(), params["tool"].as_str()) {
                            (Some("tools/list"), _) => serde_json::json!({"tools": [
                                {"namespace": "codex_app", "name": "read_thread"},
                                {"namespace": "codex_app", "name": "send_message_to_thread"}]}),
                            (Some("tools/call"), Some(tool)) => {
                                let text = if tool == "send_message_to_thread" {
                                    recorded.lock().unwrap().push(params.clone());
                                    serde_json::json!({"threadId": params["arguments"]["threadId"]})
                                } else {
                                    let sent = !recorded.lock().unwrap().is_empty();
                                    let mut readings = readings.lock().unwrap();
                                    let (before, after, next) = &mut *readings;
                                    if !sent || after.is_empty() {
                                        before.clone()
                                    } else {
                                        let reading = after[(*next).min(after.len() - 1)].clone();
                                        *next += 1;
                                        reading
                                    }
                                };
                                serde_json::json!({"success": true, "contentItems": [
                                    {"type": "inputText", "text": text.to_string()}]})
                            }
                            _ => serde_json::json!({}),
                        };
                        let reply = serde_json::to_vec(&serde_json::json!({
                            "jsonrpc": "2.0", "id": request["id"], "result": result})).unwrap();
                        if connection.write_u32_le(reply.len() as u32).await.is_err()
                            || connection.write_all(&reply).await.is_err()
                        {
                            return;
                        }
                    }
                });
            }
        });
        FakeDesktop { sends }
    }
}

#[cfg(windows)]
fn desktop_reading(thread: &str, workspace: &str, thread_status: &str, turn_status: &str, items: Value) -> Value {
    serde_json::json!({
        "schemaVersion": 1,
        "thread": {"id": thread, "status": {"type": thread_status}, "cwd": workspace},
        "turns": [{"id": "desktop-turn-1", "status": turn_status, "items": items},
            {"id": "desktop-turn-0", "status": "completed", "items": []}],
    })
}

#[cfg(windows)]
async fn wait_for_terminal(events: &Arc<Mutex<Vec<Value>>>, run: &str) -> Value {
    let mut terminal = None;
    wait_until("the hand-off run to settle", || {
        terminal = events
            .lock()
            .unwrap()
            .iter()
            .find(|event| event["runId"] == run && matches!(event["kind"].as_str(), Some("done" | "error")))
            .cloned();
        terminal.is_some()
    })
    .await;
    terminal.unwrap()
}

#[cfg(windows)]
fn enable_desktop_handoff(fixture: &TestHarness) {
    let mut settings = ccgui_next_lib::settings::read_settings().unwrap_or_default();
    settings.codex_desktop_handoff_enabled = true;
    std::fs::write(
        fixture.root().join(".ccgui-next/settings.json"),
        serde_json::to_vec(&settings).unwrap(),
    )
    .unwrap();
}

/// Codex Desktop holds the thread, so the fake app-server cannot resume it:
/// the send fails closed by default; with explicit opt-in it goes to Desktop
/// and the run follows Desktop's turn to its end. A
/// request Desktop cannot honor and a stop during the turn each end with
/// their own banner and never resend.
#[cfg(windows)]
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn a_thread_held_by_codex_desktop_continues_there() {
    const THREAD: &str = "01a100bc-fdfa-7dd1-b02a-cf2a51383059";
    let fixture = TestHarness::new().unwrap();
    write_fake_codex_held_elsewhere(&fixture, THREAD);
    let workspace = fixture.root().join("ws").to_string_lossy().to_string();
    let (app, events) = build_app(&fixture);
    let running = desktop_reading(THREAD, &workspace, "active", "inProgress", serde_json::json!([
        {"type": "functionCallOutput", "id": "f1", "name": "send_message_to_thread", "namespace": "codex_app"},
        {"type": "agentMessage", "id": "a1", "text": "looking at it", "phase": "commentary"},
        {"type": "commandExecution", "id": "c1", "command": "git status", "cwd": workspace, "status": "inProgress"}]));
    let finished = desktop_reading(THREAD, &workspace, "idle", "completed", serde_json::json!([
        {"type": "functionCallOutput", "id": "f1", "name": "send_message_to_thread", "namespace": "codex_app"},
        {"type": "agentMessage", "id": "a1", "text": "looking at it", "phase": "commentary"},
        {"type": "commandExecution", "id": "c1", "command": "git status", "cwd": workspace,
            "status": "completed", "exitCode": 0},
        {"type": "agentMessage", "id": "a2", "text": "done from desktop", "phase": "final_answer"}]));
    let desktop = FakeDesktop::serve(&fixture, THREAD, "idle", vec![running.clone(), finished]);
    let send = |run: &str, images: Option<Vec<String>>| {
        engine::send_message(
            app.state::<AppState>(), "codex".into(), workspace.clone(), Some(THREAD.into()),
            "好的 🧭".into(), images, None, None, Some("bypass".into()), None, Some(run.into()), None,
            None, None,
        )
    };

    send("desktop-disabled", None).await.unwrap();
    let terminal = wait_for_terminal(&events, "desktop-disabled").await;
    assert_eq!(terminal["kind"], "error");
    assert!(
        terminal["data"]
            .as_str()
            .unwrap()
            .starts_with("[codex-desktop:disabled]"),
        "{terminal}"
    );
    assert!(desktop.sends.lock().unwrap().is_empty());
    assert!(!events.lock().unwrap().iter().any(|event| {
        event["runId"] == "desktop-disabled"
            && matches!(event["kind"].as_str(), Some("handoff" | "done"))
    }));
    wait_until("the disabled run to drain", || {
        app.state::<AppState>()
            .processes
            .0
            .lock()
            .unwrap()
            .is_empty()
    })
    .await;

    enable_desktop_handoff(&fixture);
    send("desktop-handoff", None).await.unwrap();
    let terminal = wait_for_terminal(&events, "desktop-handoff").await;
    assert_eq!(terminal["kind"], "done", "unexpected end: {terminal}");
    let collected: Vec<Value> = events
        .lock()
        .unwrap()
        .iter()
        .filter(|event| event["runId"] == "desktop-handoff")
        .cloned()
        .collect();
    let stages: Vec<&str> = collected
        .iter()
        .filter(|event| event["kind"] == "handoff")
        .filter_map(|event| event["data"]["stage"].as_str())
        .collect();
    assert_eq!(stages, ["delivering", "waiting", "running"]);
    let answers: Vec<&str> = collected
        .iter()
        .filter(|event| event["kind"] == "message" && event["data"]["role"] == "assistant")
        .filter_map(|event| event["data"]["text"].as_str())
        .collect();
    assert_eq!(answers, ["looking at it", "done from desktop"], "each item once, earlier turns never");
    assert!(collected.iter().any(|event| event["kind"] == "message" && event["data"]["role"] == "tool"));
    let sends = desktop.sends.lock().unwrap().clone();
    assert_eq!(sends.len(), 1);
    assert_eq!(
        sends[0]["arguments"],
        serde_json::json!({"threadId": THREAD, "hostId": "local", "prompt": "好的 🧭"})
    );
    assert_eq!(sends[0]["threadId"], THREAD);
    // Remembered as a digest only, so history can show this delivery, and no
    // other tool's, as the user's own row.
    use sha2::Digest as _;
    assert_eq!(
        app.state::<AppState>().db.codex_desktop_prompts(THREAD).unwrap(),
        std::collections::HashSet::from([format!("{:x}", sha2::Sha256::digest("好的 🧭".as_bytes()))])
    );

    // Images cannot travel to Desktop: refused before anything is sent.
    send("desktop-images", Some(vec!["shot.png".into()])).await.unwrap();
    let terminal = wait_for_terminal(&events, "desktop-images").await;
    assert!(terminal["data"].as_str().unwrap().starts_with("[codex-desktop:images]"), "{terminal}");
    assert_eq!(desktop.sends.lock().unwrap().len(), 1);

    // A stop after delivery ends following without asserting Desktop finished.
    // The fake now repeats the finished turn, which predates this delivery,
    // so the run is still waiting on Desktop when the stop arrives.
    send("desktop-stop", None).await.unwrap();
    wait_until("the second delivery", || desktop.sends.lock().unwrap().len() == 2).await;
    assert!(app.state::<AppState>().processes.kill("desktop-stop"));
    let terminal = wait_for_terminal(&events, "desktop-stop").await;
    assert!(
        terminal["data"].as_str().unwrap_or_default().starts_with("[codex-desktop:stopped]"),
        "{terminal}"
    );
    wait_until("the stopped run to drain", || {
        app.state::<AppState>().processes.0.lock().unwrap().is_empty()
    })
    .await;
}

/// Desktop answers but has not loaded the thread: another client holds it,
/// so the message is not handed over.
#[cfg(windows)]
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn a_thread_held_by_another_client_is_not_handed_to_desktop() {
    const THREAD: &str = "01a100af-7c19-7ed0-89db-7751484da4db";
    let fixture = TestHarness::new().unwrap();
    write_fake_codex_held_elsewhere(&fixture, THREAD);
    let workspace = fixture.root().join("ws").to_string_lossy().to_string();
    let (app, events) = build_app(&fixture);
    let desktop = FakeDesktop::serve(&fixture, THREAD, "notLoaded", Vec::new());
    enable_desktop_handoff(&fixture);
    engine::send_message(
        app.state::<AppState>(), "codex".into(), workspace, Some(THREAD.into()), "继续".into(),
        None, None, None, Some("bypass".into()), None, Some("held-elsewhere".into()), None,
        None, None,
    )
    .await
    .unwrap();
    let terminal = wait_for_terminal(&events, "held-elsewhere").await;
    assert!(terminal["data"].as_str().unwrap().starts_with("[codex-desktop:elsewhere]"), "{terminal}");
    assert!(desktop.sends.lock().unwrap().is_empty());
}
