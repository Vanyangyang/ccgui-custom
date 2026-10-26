use super::*;
use crate::cli_lifecycle::process_tests::Fixture;
use tokio::time::timeout;

#[tokio::test]
async fn builder_retires_orphan_before_waiting_for_pipe_eof() {
    let mut fixture = Fixture::new();
    let mut command = fixture.command("parent-orphan");
    let run = tokio::spawn(async move { run_builder_command(&mut command, Duration::from_secs(15)).await });
    fixture.start_descendant().await;
    let (status, _, _) = timeout(Duration::from_secs(6), run).await.unwrap().unwrap().unwrap();
    assert!(status.success());
    fixture.assert_exited().await;
}

#[tokio::test]
async fn builder_timeout_retires_descendants() {
    let mut fixture = Fixture::new();
    let mut command = fixture.command("parent-wait");
    let run = tokio::spawn(async move { run_builder_command(&mut command, Duration::from_secs(4)).await });
    fixture.start_descendant().await;
    let result = timeout(Duration::from_secs(9), run).await.unwrap().unwrap();
    assert!(result.unwrap_err().contains("self-update build timed out"));
    fixture.assert_exited().await;
}

#[tokio::test]
async fn builder_cancellation_retires_descendants() {
    let mut fixture = Fixture::new();
    let mut command = fixture.command("parent-wait");
    let run = tokio::spawn(async move { run_builder_command(&mut command, Duration::from_secs(20)).await });
    fixture.start_descendant().await;
    run.abort();
    assert!(run.await.unwrap_err().is_cancelled());
    fixture.assert_exited().await;
}

#[tokio::test]
async fn builder_drains_both_pipes_while_child_is_running() {
    let fixture = Fixture::new();
    let mut command = fixture.command("output");
    let (status, stdout, stderr) = run_builder_command(&mut command, Duration::from_secs(10)).await.unwrap();
    assert!(status.success());
    assert_eq!(stdout.len(), 1024 * 1024);
    assert_eq!(stderr.len(), 64 * 1024);
}
