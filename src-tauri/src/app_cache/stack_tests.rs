//! Exercise the generated Tauri handler as well as the command's future size.
//! The small-stack probe runs in a child test process: a stack overflow aborts
//! the process on Windows and must not take down the rest of the test suite.

use super::{summarize_session_handoff, HandoffCompressionSelection};
use std::sync::Arc;
use tauri::Manager;

fn app() -> tauri::App<tauri::test::MockRuntime> {
    let app = tauri::test::mock_builder()
        .invoke_handler(tauri::generate_handler![super::summarize_session_handoff])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    app.manage(crate::AppState {
        db: Arc::new(crate::db::Db::open_in_memory().unwrap()),
        sink: crate::event_sink::EventSink::new(Arc::new(app.handle().clone())),
        terminal_sink: crate::event_sink::EventSink::with_name(
            Arc::new(app.handle().clone()),
            crate::terminal::TERMINAL_OUTPUT_EVENT,
        ),
        plugin_sink: crate::event_sink::EventSink::with_name(
            Arc::new(app.handle().clone()),
            crate::event_sink::PLUGIN_AGENT_EVENT_NAME,
        ),
        mission_sink: crate::event_sink::EventSink::with_name(
            Arc::new(app.handle().clone()),
            crate::event_sink::MISSION_AGENT_EVENT_NAME,
        ),
        emitters: crate::event_sink::BroadcastEmit::new(Arc::new(app.handle().clone())),
        terminals: crate::terminal::TerminalRegistry::default(),
        processes: Arc::new(crate::engine::ProcessRegistry::default()),
        web: crate::web::WebAccessState::default(),
        relay: crate::relay::RelayState::default(),
        dsh_host: Arc::new(crate::dsh_host::DshHostState::default()),
        opencode_server: Arc::new(crate::engine::opencode_server::OpencodeServerState::default()),
        worktree_creations: crate::git_worktree::CreationRegistry::default(),
    });
    app
}

#[test]
fn summarize_session_handoff_future_stays_small() {
    // Construct the old oversized future safely so this reports its size rather
    // than aborting the test harness before reaching the assertion.
    std::thread::Builder::new()
        .name("handoff-future-size".into())
        .stack_size(8 * 1024 * 1024)
        .spawn(|| {
            let app = app();
            let future = summarize_session_handoff(
                app.state::<crate::AppState>(),
                String::new(),
                String::new(),
                None,
                None,
                None,
                None,
                Some(HandoffCompressionSelection {
                    engine: "invalid-stack-probe-engine".into(),
                    model: "unused".into(),
                    provider_id: None,
                    effort: None,
                }),
            );
            let bytes = std::mem::size_of_val(&future);
            eprintln!("summarize_session_handoff future: {bytes} bytes");
            assert!(
                bytes <= 16 * 1024,
                "handoff command future uses {bytes} bytes; keep large nested futures behind a heap boundary"
            );
        })
        .unwrap()
        .join()
        .unwrap();
}

// Tauri uses a different async spawn path with debug assertions disabled.
// Run with `cargo test --profile self-update --lib app_cache::stack_tests` on
// Windows to cover the same path and 1 MiB stack budget as the shipped app.
#[cfg(windows)]
#[test]
fn summarize_session_handoff_ipc_fits_one_mib_stack() {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "app_cache::stack_tests::summarize_session_handoff_small_stack_fixture",
            "--ignored",
            "--nocapture",
        ])
        .env("CCGUI_HANDOFF_STACK_FIXTURE", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let output = child.wait_with_output().unwrap();
            panic!(
                "small-stack IPC fixture timed out\nstdout: {}\nstderr: {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "small-stack IPC fixture failed ({})\nstdout: {}\nstderr: {}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("HANDOFF_SMALL_STACK_OK"),
        "child did not execute the IPC probe"
    );
}

#[cfg(windows)]
#[test]
#[ignore = "invoked in an isolated process by summarize_session_handoff_ipc_fits_one_mib_stack"]
fn summarize_session_handoff_small_stack_fixture() {
    assert_eq!(
        std::env::var("CCGUI_HANDOFF_STACK_FIXTURE").as_deref(),
        Ok("1")
    );
    std::thread::Builder::new()
        .name("handoff-ui-stack".into())
        .stack_size(1024 * 1024)
        .spawn(|| {
            let app = app();
            let window =
                tauri::WebviewWindowBuilder::new(&app, "handoff-stack-test", Default::default())
                    .build()
                    .unwrap();
            let (sender, receiver) = std::sync::mpsc::channel();
            let webview: &tauri::Webview<tauri::test::MockRuntime> = window.as_ref();
            webview.clone().on_message(
                tauri::webview::InvokeRequest {
                    cmd: "summarize_session_handoff".into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "http://tauri.localhost".parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                        "engine": "",
                        "sessionId": "",
                        "compressionSelection": {
                            "engine": "invalid-stack-probe-engine",
                            "model": "unused"
                        }
                    })),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.to_string(),
                },
                Box::new(move |_, _, response, _, _| sender.send(response).unwrap()),
            );
            let response = receiver
                .recv_timeout(std::time::Duration::from_secs(10))
                .unwrap();
            match response {
                tauri::ipc::InvokeResponse::Err(error) => assert_eq!(
                    error.0,
                    serde_json::json!("unsupported handoff compression engine")
                ),
                tauri::ipc::InvokeResponse::Ok(_) => panic!("invalid engine unexpectedly accepted"),
            }
        })
        .unwrap()
        .join()
        .unwrap();
    println!("HANDOFF_SMALL_STACK_OK");
}

/// Explicit live acceptance only: run this exact ignored test in its own
/// process with CCGUI_CODEX_LIVE_HANDOFF_TEST=1. Default tests stay offline.
#[cfg(windows)]
#[test]
#[ignore = "requires explicit opt-in and an available Codex gpt-6-astra provider"]
fn live_codex_handoff_ipc_fits_one_mib_stack() {
    assert_eq!(
        std::env::var("CCGUI_CODEX_LIVE_HANDOFF_TEST").as_deref(),
        Ok("1")
    );
    std::thread::Builder::new()
        .name("live-handoff-ui-stack".into())
        .stack_size(1024 * 1024)
        .spawn(|| {
            let app = app();
            let window = tauri::WebviewWindowBuilder::new(
                &app,
                "live-handoff-stack-test",
                Default::default(),
            )
            .build()
            .unwrap();
            let main = (1..=20).map(|n| format!(
                "验收项 {n}：脚本 tasks/case-{n}.ps1 的预检与构建异常必须在 finally 中清理临时目录 cache-{n}；仅允许删除本轮创建的目录，不能清理用户已有内容。编译失败应保留退出码，取消时停止自己启动的进程树并释放文件锁。"
            )).collect::<Vec<_>>().join("\n");
            let children = (1..=3).map(|n| format!(
                "子任务 {n} 报告：检查 tasks/case-{}.ps1 到 tasks/case-{}.ps1；发现预检位于 try 之前，失败会跳过 finally。建议把预检移入保护区并保留错误传播。报告完成不等于已验收：只完成静态检查，未改代码，未跑桌面验证；仍需验证并发取消、只读目录及旧进程晚到事件。",
                (n - 1) * 6 + 1, n * 6
            )).collect::<Vec<_>>().join("\n");
            let (sender, receiver) = std::sync::mpsc::channel();
            let webview: &tauri::Webview<tauri::test::MockRuntime> = window.as_ref();
            let started = std::time::Instant::now();
            webview.clone().on_message(
                tauri::webview::InvokeRequest {
                    cmd: "summarize_session_handoff".into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: "http://tauri.localhost".parse().unwrap(),
                    body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                        "engine": "claude",
                        "sessionId": "synthetic-handoff-smoke",
                        "title": "构建脚本异常清理",
                        "transcriptExcerpt": main,
                        "childContext": children,
                        "compressionSelection": {
                            "engine": "codex",
                            "model": "gpt-6-astra",
                            "effort": "high",
                            "providerId": "__local_settings_json__"
                        }
                    })),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.to_string(),
                },
                Box::new(move |_, _, response, _, _| sender.send(response).unwrap()),
            );
            let response = receiver
                .recv_timeout(std::time::Duration::from_secs(90))
                .expect("live handoff IPC did not respond within 90 seconds");
            let summary: String = match response {
                tauri::ipc::InvokeResponse::Ok(tauri::ipc::InvokeResponseBody::Json(json)) =>
                    serde_json::from_str(&json).expect("live handoff IPC returned a non-string JSON result"),
                _ => panic!("live handoff IPC did not return a successful JSON response"),
            };
            let chars = summary.trim().chars().count();
            eprintln!(
                "live handoff IPC: summary_chars={chars} elapsed_ms={}",
                started.elapsed().as_millis()
            );
            assert!(chars >= 12, "live handoff summary was shorter than 12 characters");
        })
        .unwrap()
        .join()
        .unwrap();
}
