use super::*;
use std::{path::PathBuf, process::{Command, Stdio}, time::{Duration, Instant}};

fn sandbox() -> PathBuf {
    let root = std::env::temp_dir().join(format!("ccgui-staging-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap(); root
}
fn owned(parent: &Path) -> PathBuf { parent.join(format!("{PREFIX}{}", uuid::Uuid::new_v4())) }
struct TestChild(std::process::Child);
impl Drop for TestChild {
    fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
}

#[test]
fn sweep_reclaims_only_owned_unlocked_roots_and_retains_uncertain_records() {
    let temp = sandbox();
    let stale = owned(&temp); let mut guard = create(&stale).unwrap();
    let lease = guard.lease.take(); std::mem::forget(guard); drop(lease);
    let active = owned(&temp); let active_guard = create(&active).unwrap();
    let unrelated = temp.join("unrelated"); std::fs::create_dir(&unrelated).unwrap();
    let unmarked = owned(&temp); std::fs::create_dir(&unmarked).unwrap();
    let invalid = owned(&temp); let mut invalid_guard = create(&invalid).unwrap();
    let lease = invalid_guard.lease.take(); std::mem::forget(invalid_guard); drop(lease);
    std::fs::write(invalid.join(MARKER), "unrelated marker").unwrap();
    let pending = owned(&temp); let mut guard = create(&pending).unwrap();
    std::fs::write(pending.join(CHILD), "pending").unwrap();
    let lease = guard.lease.take(); std::mem::forget(guard); drop(lease);
    sweep_in(&temp);
    assert!(!stale.exists());
    for retained in [&active, &unrelated, &unmarked, &invalid, &pending] { assert!(retained.exists()); }
    drop(active_guard); std::fs::remove_dir_all(temp).unwrap();
}

#[test]
fn live_cli_identity_survives_host_lease_loss() {
    let temp = sandbox(); let root = owned(&temp); let mut guard = create(&root).unwrap();
    let home = root.join("home"); std::fs::create_dir(&home).unwrap();
    spawned(&home, Some(std::process::id())).unwrap();
    let lease = guard.lease.take(); std::mem::forget(guard); drop(lease);
    sweep_in(&temp); assert!(root.exists(), "active CLI lost its private state");
    #[cfg(windows)] {
    let mut identity: ChildIdentity = serde_json::from_slice(&std::fs::read(root.join(CHILD)).unwrap()).unwrap();
    assert!(identity.started > 1);
    identity.started -= 1;
    std::fs::write(root.join(CHILD), serde_json::to_vec(&identity).unwrap()).unwrap();
    sweep_in(&temp); assert!(!root.exists());
    }
    std::fs::remove_dir_all(temp).unwrap();
}

#[cfg(unix)]
#[test]
fn out_of_range_process_id_is_unknown_and_retained() {
    let temp = sandbox(); let root = owned(&temp); let mut guard = create(&root).unwrap();
    let lease = guard.lease.take(); std::mem::forget(guard); drop(lease);
    std::fs::write(root.join(CHILD), br#"{"pid":2147483648,"started":1}"#).unwrap();
    sweep_in(&temp); assert!(root.exists()); std::fs::remove_dir_all(temp).unwrap();
}

#[cfg(unix)]
#[test]
fn surviving_process_group_keeps_state_after_its_leader_exits() {
    use std::os::unix::process::CommandExt;
    let temp = sandbox(); let root = owned(&temp); let mut guard = create(&root).unwrap();
    let home = root.join("home"); std::fs::create_dir(&home).unwrap();
    let mut leader = TestChild(Command::new("sleep").arg("30").process_group(0).spawn().unwrap());
    let mut member = TestChild(Command::new("sleep").arg("30").process_group(leader.0.id() as i32).spawn().unwrap());
    spawned(&home, Some(leader.0.id())).unwrap();
    let lease = guard.lease.take(); std::mem::forget(guard); drop(lease);
    leader.0.kill().unwrap(); leader.0.wait().unwrap();
    sweep_in(&temp); assert!(root.exists(), "live wrapper descendant lost its profile");
    member.0.kill().unwrap(); member.0.wait().unwrap();
    sweep_in(&temp); assert!(!root.exists()); std::fs::remove_dir_all(temp).unwrap();
}

#[cfg(windows)]
#[test]
fn blocked_payload_keeps_recovery_marker_until_a_later_sweep() {
    use std::os::windows::fs::OpenOptionsExt;
    let temp = sandbox(); let root = owned(&temp); let mut guard = create(&root).unwrap();
    let lease = guard.lease.take(); std::mem::forget(guard); drop(lease);
    let payload = root.join("private-cache.db"); std::fs::write(&payload, b"synthetic cache").unwrap();
    let handle = OpenOptions::new().read(true).share_mode(0).open(&payload).unwrap();
    sweep_in(&temp);
    assert!(payload.exists()); assert!(root.join(MARKER).exists()); assert!(root.join(CHILD).exists());
    drop(handle); sweep_in(&temp); assert!(!root.exists()); std::fs::remove_dir_all(temp).unwrap();
}

#[cfg(unix)]
#[test]
fn sweep_never_follows_a_link_to_another_directory() {
    let temp = sandbox(); let target = temp.join("unrelated"); std::fs::create_dir(&target).unwrap();
    std::fs::write(target.join("keep"), "keep").unwrap();
    let link = owned(&temp); std::os::unix::fs::symlink(&target, &link).unwrap();
    sweep_in(&temp); assert!(target.join("keep").exists()); assert!(link.is_symlink());
    std::fs::remove_dir_all(temp).unwrap();
}

#[cfg(windows)]
#[test]
fn sweep_skips_junctions_even_when_the_target_contains_a_valid_marker() {
    let temp = sandbox(); let target = temp.join("unrelated"); let mut guard = create(&target).unwrap();
    let lease = guard.lease.take(); std::mem::forget(guard); drop(lease);
    std::fs::write(target.join("keep"), b"keep").unwrap();
    let link = owned(&temp);
    let mut command = Command::new("powershell.exe");
    command.args(["-NoProfile", "-NonInteractive", "-Command", "New-Item -ItemType Junction -Path $env:CCGUI_TEST_LINK -Target $env:CCGUI_TEST_TARGET | Out-Null"])
        .env("CCGUI_TEST_LINK", &link).env("CCGUI_TEST_TARGET", &target)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    use std::os::windows::process::CommandExt; command.creation_flags(0x08000000);
    assert!(command.status().unwrap().success());
    sweep_in(&temp);
    assert!(link.exists()); assert!(target.join("keep").exists());
    std::fs::remove_dir(&link).unwrap(); std::fs::remove_dir_all(temp).unwrap();
}

#[test]
fn crash_fixture() {
    let Some(root) = std::env::var_os("CCGUI_OBSERVER_CRASH_FIXTURE") else { return; };
    let root = PathBuf::from(root);
    if std::env::var_os("CCGUI_OBSERVER_RECOVERY_ONLY").is_some() { sweep_in(&root); return; }
    let _guard = create(&root).unwrap();
    std::fs::create_dir_all(root.join("home/.gemini/antigravity-cli/conversations")).unwrap();
    std::fs::write(root.join("home/.gemini/antigravity-cli/conversations/synthetic.db"), "synthetic cache").unwrap();
    std::fs::write(root.join("ready"), b"ready").unwrap();
    loop { std::thread::sleep(Duration::from_millis(100)); }
}

fn fixture(root: &Path) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args(["--exact", "engine::side_call::agy::staging::tests::crash_fixture", "--nocapture"])
        .env("CCGUI_OBSERVER_CRASH_FIXTURE", root)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    command
}

#[test]
fn killed_owner_leaves_cache_hidden_then_a_fresh_process_recovers_it() {
    let temp = sandbox(); let root = owned(&temp);
    let mut child = TestChild(fixture(&root).spawn().unwrap());
    let deadline = Instant::now() + Duration::from_secs(10);
    while !root.join("ready").exists() {
        assert!(Instant::now() < deadline, "crash fixture did not become ready");
        assert!(child.0.try_wait().unwrap().is_none()); std::thread::sleep(Duration::from_millis(20));
    }
    sweep_in(&temp); assert!(root.exists(), "concurrent startup deleted another host's session");
    child.0.kill().unwrap(); child.0.wait().unwrap(); // TerminateProcess/SIGKILL: no Drop hooks.
    assert!(root.join("home/.gemini/antigravity-cli/conversations/synthetic.db").is_file());
    assert!(fixture(&temp).env("CCGUI_OBSERVER_RECOVERY_ONLY", "1").status().unwrap().success());
    assert!(!root.exists(), "fresh host left the orphan behind");
    std::fs::remove_dir_all(temp).unwrap();
}

#[cfg(any(unix, windows))]
#[tokio::test]
async fn abnormal_cli_process_exit_still_removes_staging() {
    let temp = sandbox(); let root = owned(&temp);
    {
        let _guard = create(&root).unwrap();
        let home = root.join("home"); let cwd = root.join("workspace");
        std::fs::create_dir(&home).unwrap(); std::fs::create_dir(&cwd).unwrap();
        #[cfg(windows)] let mut command = tokio::process::Command::new("powershell.exe");
        #[cfg(windows)] command.args(["-NoProfile", "-NonInteractive", "-Command", "exit 7"]);
        #[cfg(unix)] let mut command = tokio::process::Command::new("sh");
        #[cfg(unix)] command.args(["-c", "exit 7"]);
        let result = crate::engine::side_call::run_with_parser_in_home("agy", command, &cwd, "", Duration::from_secs(5), super::super::parse_result, Some(&home)).await;
        assert!(result.is_err());
    }
    let deadline = Instant::now() + Duration::from_secs(4);
    while root.exists() { assert!(Instant::now() < deadline); tokio::time::sleep(Duration::from_millis(30)).await; }
    std::fs::remove_dir_all(temp).unwrap();
}
