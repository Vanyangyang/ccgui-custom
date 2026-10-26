//! Offline Windows wrapper/descendant regression; never launches an installed CLI.
use super::*;
use std::{path::PathBuf, time::Duration};

const FIXTURE_TEST: &str = "engine::models::process_tests::fake_probe";

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ccgui-short-probe-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("probe.cmd"), format!(
            "@echo off\r\nset \"CCGUI_SHORT_PROBE_ROOT={}\"\r\n\"{}\" --exact {FIXTURE_TEST} --ignored --nocapture\r\n",
            root.display(), std::env::current_exe().unwrap().display(),
        )).unwrap();
        Self(root)
    }

    fn start(&self) -> tokio::task::JoinHandle<Result<String, String>> {
        let bin = self.0.join("probe.cmd").to_string_lossy().into_owned();
        tokio::spawn(async move { run_probe(&bin, &[], "fixture").await })
    }

    async fn wait_file(&self, name: &str) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !self.0.join(name).exists() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.expect("fake probe did not start");
    }

    async fn start_descendant(&self) {
        self.wait_file("parent.pid").await;
        std::fs::write(self.0.join("launch"), "").unwrap();
        self.wait_file("child.pid").await;
    }

    fn pids(&self) -> Vec<sysinfo::Pid> {
        ["parent.pid", "child.pid"].iter().filter_map(|name| {
            std::fs::read_to_string(self.0.join(name)).ok()?.parse::<u32>().ok().map(sysinfo::Pid::from_u32)
        }).collect()
    }

    async fn assert_stopped(&self) {
        let pids = self.pids();
        assert_eq!(pids.len(), 2);
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let mut system = sysinfo::System::new();
                system.refresh_processes_specifics(sysinfo::ProcessesToUpdate::All, true, sysinfo::ProcessRefreshKind::nothing());
                if pids.iter().all(|pid| system.process(*pid).is_none()) { break; }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.expect("short probe left a wrapper or descendant alive");
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Fixture processes self-expire even if a test assertion panics.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
#[ignore = "subprocess fixture invoked only by short probe process tests"]
fn fake_probe() {
    let Some(root) = std::env::var_os("CCGUI_SHORT_PROBE_ROOT").map(PathBuf::from) else { return };
    let descendant = std::env::var_os("CCGUI_SHORT_PROBE_CHILD").is_some();
    std::fs::write(root.join(if descendant { "child.pid" } else { "parent.pid" }), std::process::id().to_string()).unwrap();
    if !descendant {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !root.join("launch").exists() {
            if std::time::Instant::now() >= deadline { return; }
            std::thread::sleep(Duration::from_millis(10));
        }
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command.args(["--exact", FIXTURE_TEST, "--ignored", "--nocapture"])
            .env("CCGUI_SHORT_PROBE_CHILD", "1")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
        let _child = command.spawn().unwrap();
    }
    std::thread::sleep(Duration::from_secs(30));
}

#[tokio::test]
async fn short_probe_timeout_sweeps_descendants() {
    let fixture = Fixture::new();
    let probe = fixture.start();
    fixture.start_descendant().await;
    let error = tokio::time::timeout(PROBE_TIMEOUT + Duration::from_secs(5), probe)
        .await.unwrap().unwrap().unwrap_err();
    assert!(error.ends_with("fixture timed out"));
    fixture.assert_stopped().await;
}

#[tokio::test]
async fn short_probe_cancellation_sweeps_descendants() {
    let fixture = Fixture::new();
    let probe = fixture.start();
    fixture.start_descendant().await;
    probe.abort();
    assert!(probe.await.unwrap_err().is_cancelled());
    fixture.assert_stopped().await;
}
