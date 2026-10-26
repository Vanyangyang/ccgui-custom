//! Isolated child copies of the test binary; no installed engine is launched.
use super::*;
use std::io::Write;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, TerminateProcess,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
};

const FIXTURE_TEST: &str = "cli_lifecycle::process_tests::process_fixture";

pub(crate) struct Fixture {
    root: PathBuf,
    processes: Vec<HANDLE>,
}

impl Fixture {
    pub(crate) fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ccgui-process-cleanup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        Self { root, processes: Vec::new() }
    }

    pub(crate) fn command(&self, mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args(["--exact", FIXTURE_TEST, "--nocapture"])
            .env("CCGUI_PROCESS_CLEANUP_FIXTURE", mode)
            .env("CCGUI_PROCESS_CLEANUP_ROOT", &self.root);
        command
    }

    pub(crate) async fn start_descendant(&mut self) {
        self.track("parent.pid").await;
        // These tests use the current-thread runtime: the command runner has
        // assigned its Job before yielding to this task and releasing the gate.
        std::fs::write(self.root.join("release"), b"go").unwrap();
        self.track("child.pid").await;
    }

    async fn track(&mut self, file: &str) {
        let path = self.root.join(file);
        let pid = timeout(Duration::from_secs(8), async {
            loop {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    if let Ok(pid) = text.trim().parse::<u32>() { break pid; }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.expect("fixture did not publish its PID");
        match unsafe { OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, false, pid) } {
            Ok(handle) => self.processes.push(handle),
            Err(error) => {
                let mut system = sysinfo::System::new();
                let process = sysinfo::Pid::from_u32(pid);
                system.refresh_processes_specifics(sysinfo::ProcessesToUpdate::Some(&[process]), true, sysinfo::ProcessRefreshKind::nothing());
                assert!(system.process(process).is_none(), "cannot inspect live fixture {pid}: {error}");
            }
        }
    }

    pub(crate) async fn assert_exited(&self) {
        timeout(Duration::from_secs(5), async {
            loop {
                let alive = self.processes.iter().any(|handle| {
                    let mut code = 0;
                    unsafe { GetExitCodeProcess(*handle, &mut code).expect("inspect owned fixture process"); }
                    code == 259
                });
                if !alive { return; }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }).await.expect("owned fixture process survived cleanup");
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        for handle in self.processes.drain(..) {
            // Held handles refer only to our fixture children, never a reused PID.
            unsafe { let _ = TerminateProcess(handle, 1); let _ = CloseHandle(handle); }
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn process_fixture() {
    let Ok(mode) = std::env::var("CCGUI_PROCESS_CLEANUP_FIXTURE") else { return; };
    let root = PathBuf::from(std::env::var_os("CCGUI_PROCESS_CLEANUP_ROOT").unwrap());
    if mode == "output" {
        let block = vec![b'x'; 16 * 1024];
        for _ in 0..160 {
            std::io::stdout().write_all(&block).unwrap();
            std::io::stderr().write_all(&block).unwrap();
        }
        return;
    }
    if mode == "child" {
        std::thread::sleep(Duration::from_secs(30));
        return;
    }
    std::fs::write(root.join("parent.pid"), std::process::id().to_string()).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while !root.join("release").exists() {
        assert!(std::time::Instant::now() < deadline, "fixture release was not received");
        std::thread::sleep(Duration::from_millis(10));
    }
    let mut command = std::process::Command::new(std::env::current_exe().unwrap());
    command.args(["--exact", FIXTURE_TEST, "--nocapture"])
        .env("CCGUI_PROCESS_CLEANUP_FIXTURE", "child")
        .stdin(Stdio::null()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
    use std::os::windows::process::CommandExt;
    command.creation_flags(0x0800_0000);
    let child = command.spawn().unwrap();
    std::fs::write(root.join("child.pid"), child.id().to_string()).unwrap();
    if mode == "parent-wait" { std::thread::sleep(Duration::from_secs(30)); }
}

#[tokio::test]
async fn capture_retires_orphan_before_waiting_for_pipe_eof() {
    let mut fixture = Fixture::new();
    let mut command = fixture.command("parent-orphan");
    let run = tokio::spawn(async move { run_capture(&mut command, Duration::from_secs(15)).await });
    fixture.start_descendant().await;
    let output = timeout(Duration::from_secs(6), run).await.unwrap().unwrap().unwrap();
    assert!(output.status.unwrap().success());
    assert!(!output.timed_out);
    fixture.assert_exited().await;
}

#[tokio::test]
async fn streaming_retires_orphan_before_waiting_for_pipe_eof() {
    struct Sink;
    impl crate::event_sink::Emit for Sink {
        fn emit_json(&self, _: &str, _: &str) {}
    }
    let reporter = ProgressReporter::new(BroadcastEmit::new(Arc::new(Sink)), "cleanup-stream".into(), "kimi".into());
    let mut fixture = Fixture::new();
    let mut command = fixture.command("parent-orphan");
    let run = tokio::spawn(async move { run_streaming(&mut command, Duration::from_secs(15), &reporter).await });
    fixture.start_descendant().await;
    let output = timeout(Duration::from_secs(6), run).await.unwrap().unwrap().unwrap();
    assert!(output.status.unwrap().success());
    fixture.assert_exited().await;
}

#[tokio::test]
async fn capture_timeout_retires_descendants() {
    let mut fixture = Fixture::new();
    let mut command = fixture.command("parent-wait");
    let run = tokio::spawn(async move { run_capture(&mut command, Duration::from_secs(4)).await });
    fixture.start_descendant().await;
    let output = timeout(Duration::from_secs(9), run).await.unwrap().unwrap().unwrap();
    assert!(output.timed_out);
    fixture.assert_exited().await;
}

#[tokio::test]
async fn capture_cancellation_retires_descendants() {
    let mut fixture = Fixture::new();
    let mut command = fixture.command("parent-wait");
    let run = tokio::spawn(async move { run_capture(&mut command, Duration::from_secs(20)).await });
    fixture.start_descendant().await;
    run.abort();
    match run.await { Err(error) => assert!(error.is_cancelled()), Ok(_) => panic!("capture was not cancelled") }
    fixture.assert_exited().await;
}

#[tokio::test]
async fn capture_drains_output_past_capacity_and_capture_limit() {
    let fixture = Fixture::new();
    let mut command = fixture.command("output");
    let output = run_capture(&mut command, Duration::from_secs(10)).await.unwrap();
    assert!(output.status.unwrap().success());
    assert!(!output.timed_out);
    assert_eq!(output.stdout.len(), CAPTURE_CAP_BYTES + 1);
    assert_eq!(output.stderr.len(), CAPTURE_CAP_BYTES + 1);
}

#[tokio::test]
async fn output_timeout_aborts_and_joins_readers() {
    let (out, mut out_writer) = tokio::io::duplex(8);
    let (err, mut err_writer) = tokio::io::duplex(8);
    let mut stdout = OutputReader::spawn(capture_pipe(out, 8));
    let mut stderr = OutputReader::spawn(capture_pipe(err, 8));
    let failure = finish_output_readers(&mut stdout, &mut stderr, Duration::from_millis(20)).await.unwrap_err();
    assert!(failure.contains("did not close"));
    use tokio::io::AsyncWriteExt;
    assert!(out_writer.write_all(b"x").await.is_err());
    assert!(err_writer.write_all(b"x").await.is_err());
}

#[tokio::test]
async fn output_future_cancellation_drops_readers() {
    let (out, mut writer) = tokio::io::duplex(8);
    let (started, ready) = tokio::sync::oneshot::channel();
    let run = tokio::spawn(async move {
        let mut reader = OutputReader::spawn(capture_pipe(out, 8));
        let _ = started.send(());
        reader.join().await
    });
    ready.await.unwrap();
    run.abort();
    assert!(run.await.unwrap_err().is_cancelled());
    use tokio::io::AsyncWriteExt;
    assert!(timeout(Duration::from_secs(1), writer.write_all(b"longer than the pipe")).await.unwrap().is_err());
}

#[tokio::test]
async fn output_reader_failure_aborts_peer_and_is_reported() {
    let (err, mut writer) = tokio::io::duplex(8);
    let mut stdout = OutputReader::<Vec<u8>>::spawn(async { Err("fixture read failed".into()) });
    let mut stderr = OutputReader::spawn(capture_pipe(err, 8));
    let failure = finish_output_readers(&mut stdout, &mut stderr, Duration::from_secs(1)).await.unwrap_err();
    assert_eq!(failure, "fixture read failed");
    use tokio::io::AsyncWriteExt;
    assert!(writer.write_all(b"x").await.is_err());
}
