use super::*;
use std::os::windows::process::CommandExt;

const CHILD_ENV: &str = "CCGUI_MCP_CONSOLE_TEST_FIXTURE";

/// FreeConsole is restricted to this isolated test process, never the test runner.
#[test]
fn isolated_gui_parent() {
    let Some(fixture) = std::env::var_os(CHILD_ENV) else {
        return;
    };
    #[link(name = "kernel32")]
    extern "system" {
        fn FreeConsole() -> i32;
        fn GetConsoleWindow() -> *mut std::ffi::c_void;
    }
    unsafe {
        FreeConsole();
        assert!(
            GetConsoleWindow().is_null(),
            "fixture parent must have no console window"
        );
    }
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        // Do not launch a deliberately visible positive control: a broken default
        // Terminal handoff can leave its UI behind after the fixture exits. The
        // isolated parent has no console; removing the production hide flag makes
        // this assertion fail even when Terminal returns an invisible proxy HWND.
        let mut target = ProbeTarget {
            command: Some(fixture.to_string_lossy().into_owned()),
            ..Default::default()
        };
        let result = probe_stdio_within(&target, Duration::from_secs(10)).await;
        assert_eq!(result.status, "connected", "{:?}", result.message);
        assert_eq!(
            result.server_name.as_deref(),
            Some("no_console_window"),
            "background probe must not allocate a console window handle"
        );
        assert_eq!(result.tools, ["fixture_tool"]);
        assert_eq!(result.protocol_version.as_deref(), Some("2025-06-18"));
        target.args = vec!["exit".into()];
        let result = probe_stdio_within(&target, Duration::from_secs(5)).await;
        assert_eq!(result.status, "failed");
        assert!(result.message.unwrap().contains("结束"));
        target.args = vec!["hang".into()];
        let result = probe_stdio_within(&target, Duration::from_millis(300)).await;
        assert_eq!(result.status, "failed");
        assert!(result.message.unwrap().contains("超时"));
    });
}

#[test]
fn gui_stdio_probe_has_no_console_window_and_preserves_handshake_and_failures() {
    let directory =
        std::env::temp_dir().join(format!("ccgui-mcp-console-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(directory.clone());
    let fixture = directory.join("mcp-fixture.exe");
    let source =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/mcp/probe/tests/windows_fixture.rs");
    let output = std::process::Command::new("rustc")
        .creation_flags(0x08000000)
        .arg("--edition=2021")
        .arg(source)
        .arg("-o")
        .arg(&fixture)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .creation_flags(0x08000000)
        .args([
            "--exact",
            "mcp::probe::tests::windows::isolated_gui_parent",
            "--nocapture",
        ])
        .env(CHILD_ENV, fixture)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("1 passed"),
        "isolated regression must execute"
    );
}

fn descendant_target(
    fixture: &crate::cli_lifecycle::process_tests::Fixture,
    mode: &str,
) -> ProbeTarget {
    let command = fixture.command(mode);
    let command = command.as_std();
    ProbeTarget {
        command: Some(command.get_program().to_string_lossy().into_owned()),
        args: command
            .get_args()
            .map(|value| value.to_string_lossy().into_owned())
            .collect(),
        env: command
            .get_envs()
            .filter_map(|(key, value)| {
                value.map(|value| {
                    (
                        key.to_string_lossy().into_owned(),
                        value.to_string_lossy().into_owned(),
                    )
                })
            })
            .collect(),
        ..Default::default()
    }
}

#[tokio::test]
async fn probe_timeout_sweeps_descendant_after_wrapper_exits() {
    let mut fixture = crate::cli_lifecycle::process_tests::Fixture::new();
    let target = descendant_target(&fixture, "parent-orphan");
    let run =
        tokio::spawn(async move { probe_stdio_within(&target, Duration::from_secs(4)).await });
    fixture.start_descendant().await;
    let result = tokio::time::timeout(Duration::from_secs(8), run)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.status, "failed");
    assert!(result.message.unwrap().contains("超时"));
    fixture.assert_exited().await;
}

#[tokio::test]
async fn probe_cancellation_sweeps_wrapper_and_descendant() {
    let mut fixture = crate::cli_lifecycle::process_tests::Fixture::new();
    let target = descendant_target(&fixture, "parent-wait");
    let run =
        tokio::spawn(async move { probe_stdio_within(&target, Duration::from_secs(20)).await });
    fixture.start_descendant().await;
    run.abort();
    assert!(run.await.unwrap_err().is_cancelled());
    fixture.assert_exited().await;
}
