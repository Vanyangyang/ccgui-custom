//! All subprocesses are this test executable; no installed CLI or auth files.
use super::*;
use std::io::{BufRead, Write};
use std::path::PathBuf;

const FAKE_TEST: &str = "engine::cursor_picker::process_tests::fake_acp";

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ccgui-cursor-acp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn command(&self, mode: &str) -> tokio::process::Command {
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command.args(["--exact", FAKE_TEST, "--ignored", "--nocapture"])
            .env("CCGUI_CURSOR_FAKE_ROOT", &self.0)
            .env("CCGUI_CURSOR_FAKE_MODE", mode);
        command
    }
    fn lines(&self, file: &str) -> Vec<String> {
        std::fs::read_to_string(self.0.join(file)).unwrap_or_default().lines().map(str::to_owned).collect()
    }
    async fn wait_file(&self, file: &str) {
        tokio::time::timeout(Duration::from_secs(5), async {
            while !self.0.join(file).exists() { tokio::time::sleep(Duration::from_millis(20)).await; }
        }).await.expect("fake process did not start");
    }
    async fn assert_tree_stopped(&self) {
        let pids: Vec<_> = ["parent.pid", "child.pid"].into_iter().map(|name| {
            self.lines(name).first().expect("fake pid recorded").parse::<u32>().unwrap()
        }).collect();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let mut system = sysinfo::System::new();
                system.refresh_processes_specifics(sysinfo::ProcessesToUpdate::All, true, sysinfo::ProcessRefreshKind::nothing());
                if pids.iter().all(|pid| system.process(sysinfo::Pid::from_u32(*pid)).is_none()) { break; }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.expect("catalog left a fake descendant running");
    }
}
impl Drop for Fixture {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

#[test]
#[ignore = "subprocess fixture, invoked only by cursor picker process tests"]
fn fake_acp() {
    let Some(root) = std::env::var_os("CCGUI_CURSOR_FAKE_ROOT").map(PathBuf::from) else { return };
    let mode = std::env::var("CCGUI_CURSOR_FAKE_MODE").unwrap();
    if mode == "child" {
        std::fs::write(root.join("child.pid"), std::process::id().to_string()).unwrap();
        std::thread::sleep(Duration::from_secs(30));
        return;
    }
    std::fs::write(root.join("parent.pid"), std::process::id().to_string()).unwrap();
    let mut launches = std::fs::OpenOptions::new().create(true).append(true).open(root.join("launches")).unwrap();
    writeln!(launches, "launch").unwrap();
    let mut log = std::fs::OpenOptions::new().create(true).append(true).open(root.join("methods")).unwrap();
    // Separate libtest's progress prefix from the first JSON protocol frame.
    println!();
    std::io::stdout().flush().unwrap();
    for line in std::io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let method = request["method"].as_str().unwrap();
        writeln!(log, "{method}").unwrap();
        log.flush().unwrap();
        if method == "initialize" {
            // Start descendants only after the owner has installed its Job.
            let mut child = std::process::Command::new(std::env::current_exe().unwrap());
            child.args(["--exact", FAKE_TEST, "--ignored", "--nocapture"])
                .env("CCGUI_CURSOR_FAKE_MODE", "child")
                .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
            #[cfg(windows)]
            { use std::os::windows::process::CommandExt; child.creation_flags(0x0800_0000); }
            let _descendant = child.spawn().unwrap();
            while !root.join("child.pid").exists() { std::thread::sleep(Duration::from_millis(10)); }
            println!("{}", serde_json::json!({"jsonrpc":"2.0","id":request["id"],"result":{}}));
        } else if mode == "auth" {
            println!("{}", serde_json::json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32000,"message":"Authentication required"}}));
        } else if mode == "failure" {
            println!("{}", serde_json::json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32603,"message":"Fixture failure"}}));
        } else if mode == "notifications" {
            loop {
                println!("{}", serde_json::json!({"jsonrpc":"2.0","method":"fixture/notification"}));
                std::io::stdout().flush().unwrap();
                std::thread::sleep(Duration::from_millis(10));
            }
        } else {
            println!("{}", serde_json::json!({"jsonrpc":"2.0","id":request["id"],"result":{"models":[{"value":"fixture-model","name":"Fixture","configOptions":[]}]}}));
        }
        std::io::stdout().flush().unwrap();
    }
    // A responder deliberately stays alive after EOF to exercise cleanup.
    std::thread::sleep(Duration::from_secs(30));
}

#[tokio::test]
async fn model_query_never_authenticates_and_sweeps_success_tree() {
    let fixture = Fixture::new();
    let result = request_catalog_command(fixture.command("success"), Duration::from_secs(5)).await.unwrap();
    assert_eq!(result[0].id, "fixture-model");
    assert_eq!(fixture.lines("methods"), ["initialize", "cursor/list_available_models"]);
    fixture.assert_tree_stopped().await;
}

#[tokio::test]
async fn auth_error_is_cached_without_login_or_retry() {
    let fixture = Fixture::new();
    let cache = CatalogCache::default();
    for _ in 0..2 {
        let error = cached_catalog(&cache, "fake", request_catalog_command(fixture.command("auth"), Duration::from_secs(5))).await.unwrap_err();
        assert!(error.starts_with("cursor_auth_required:"));
    }
    assert_eq!(fixture.lines("launches").len(), 1);
    assert_eq!(fixture.lines("methods"), ["initialize", "cursor/list_available_models"]);
    fixture.assert_tree_stopped().await;
}

#[tokio::test]
async fn concurrent_catalog_requests_share_one_process() {
    let fixture = Fixture::new();
    let cache = CatalogCache::default();
    let (first, second) = tokio::join!(
        cached_catalog(&cache, "fake", request_catalog_command(fixture.command("success"), Duration::from_secs(5))),
        cached_catalog(&cache, "fake", request_catalog_command(fixture.command("success"), Duration::from_secs(5))),
    );
    assert_eq!(first.unwrap(), second.unwrap());
    assert_eq!(fixture.lines("launches").len(), 1);
    fixture.assert_tree_stopped().await;
}

#[tokio::test]
async fn expired_auth_failure_can_refresh_and_binary_change_invalidates_cache() {
    let fixture = Fixture::new();
    let cache = CatalogCache::default();
    assert!(cached_catalog(&cache, "fake", request_catalog_command(fixture.command("auth"), Duration::from_secs(5))).await.is_err());
    fixture.assert_tree_stopped().await;
    cache.lock().await.as_mut().unwrap().expires = Instant::now();
    std::fs::remove_file(fixture.0.join("child.pid")).unwrap();
    assert!(cached_catalog(&cache, "fake", request_catalog_command(fixture.command("success"), Duration::from_secs(5))).await.is_ok());
    fixture.assert_tree_stopped().await;
    std::fs::remove_file(fixture.0.join("child.pid")).unwrap();
    assert!(cached_catalog(&cache, "changed-fake", request_catalog_command(fixture.command("success"), Duration::from_secs(5))).await.is_ok());
    assert_eq!(fixture.lines("launches").len(), 3);
    fixture.assert_tree_stopped().await;
}

#[tokio::test]
async fn total_deadline_and_protocol_failure_sweep_descendants() {
    for mode in ["notifications", "failure"] {
        let fixture = Fixture::new();
        let error = request_catalog_command(fixture.command(mode), Duration::from_secs(2)).await.unwrap_err();
        assert_eq!(error, if mode == "notifications" { "Cursor model catalog timed out" } else { "Cursor model catalog failed" });
        fixture.assert_tree_stopped().await;
    }
}

#[tokio::test]
async fn cancelling_query_sweeps_descendants() {
    let fixture = Fixture::new();
    let command = fixture.command("notifications");
    let query = tokio::spawn(request_catalog_command(command, Duration::from_secs(20)));
    fixture.wait_file("child.pid").await;
    query.abort();
    assert!(query.await.unwrap_err().is_cancelled());
    fixture.assert_tree_stopped().await;
}
