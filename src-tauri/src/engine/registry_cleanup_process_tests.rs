use super::*;
use std::time::{Duration, Instant};

struct OwnedChild(std::process::Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        // Only this test's retained child handle is terminated on assertion failure.
        let _ = self.0.kill();
        let _ = self.0.try_wait();
    }
}

fn local_helper(mode: &str) -> (crate::cli_lifecycle::process_tests::Fixture, OwnedChild) {
    let fixture = crate::cli_lifecycle::process_tests::Fixture::new();
    let mut command = fixture.command(mode);
    crate::engine::hide_console(&mut command);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let child = OwnedChild(command.as_std_mut().spawn().unwrap());
    (fixture, child)
}

#[test]
fn cleanup_helper_deadline_terminates_and_reaps_its_own_process() {
    let (_fixture, mut child) = local_helper("child");
    let started = Instant::now();
    wait_cleanup_helper(
        &mut child.0,
        Duration::from_millis(100),
        Duration::from_secs(1),
    );
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(
        child.0.try_wait().unwrap().is_some(),
        "hung helper survived its deadline"
    );
}

#[test]
fn cleanup_helper_preserves_normal_exit_status() {
    let (_fixture, mut child) = local_helper("output");
    wait_cleanup_helper(&mut child.0, Duration::from_secs(5), Duration::from_secs(1));
    assert!(child
        .0
        .try_wait()
        .unwrap()
        .expect("helper reaped")
        .success());
}
