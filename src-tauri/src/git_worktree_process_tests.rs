use super::*;
use std::os::windows::process::CommandExt;
use std::time::Duration;

struct Fixture {
    root: PathBuf,
    exe: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ccgui-git-process-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let exe = root.join("fixture.exe");
        let output = std::process::Command::new("rustc")
            .creation_flags(0x08000000)
            .args(["--edition=2021"])
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("src/git_worktree_process_fixture.rs"))
            .arg("-o")
            .arg(&exe)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        Self { root, exe }
    }
    fn command(&self, mode: &str, tag: &str) -> Command {
        let mut command = Command::new(&self.exe);
        command.arg(mode).arg(self.root.join(tag));
        command
    }
    async fn pid(&self, tag: &str) -> u32 {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(text) = std::fs::read_to_string(self.root.join(tag)) {
                    if let Ok(pid) = text.parse() {
                        break pid;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("fixture started")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
async fn assert_exited(pid: u32) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while crate::process_liveness::process_birth(pid) != Ok(None) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("owned fixture process must exit");
}

#[tokio::test]
async fn git_and_gh_hidden_processes_settle_and_cancel_without_orphans() {
    let fixture = Fixture::new();
    let preview = gh_pr_view_command(fixture.command("query", "query"), Duration::from_secs(3))
        .await
        .unwrap();
    assert!(matches!(
        preview.title.as_deref(),
        Some("no_console" | "hidden")
    ));
    let (output, cancelled) = run_git_command(
        fixture.command("query", "git-query"),
        None,
        Duration::from_secs(1),
    )
    .await
    .unwrap();
    assert!(!cancelled);
    assert!(!output.stdout.contains("visible"));

    // Parent exits, descendant holds both pipes. Job must close before drain.
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        run_git_command(
            fixture.command("fork", "git-child"),
            None,
            Duration::from_secs(1),
        ),
    )
    .await
    .expect("pipe holding descendant cannot hang git")
    .unwrap();
    assert!(result.0.stdout.contains("fixture"));
    assert_exited(fixture.pid("git-child").await).await;

    let task = tokio::spawn(gh_pr_view_command(
        fixture.command("fork-live", "gh-child"),
        Duration::from_secs(1),
    ));
    let pid = fixture.pid("gh-child").await;
    assert!(task.await.unwrap().is_none());
    assert_exited(pid).await;

    let cancel = Arc::new(CreationCancel {
        cancelled: AtomicBool::new(false),
        notify: Notify::new(),
    });
    let owned_cancel = Arc::clone(&cancel);
    let command = fixture.command("fork-live", "cancel-child");
    let task = tokio::spawn(async move {
        run_git_command(command, Some(&owned_cancel), Duration::from_secs(1)).await
    });
    let pid = fixture.pid("cancel-child").await;
    cancel.cancelled.store(true, Ordering::SeqCst);
    cancel.notify.notify_waiters();
    assert!(task.await.unwrap().unwrap().1);
    assert_exited(pid).await;

    let task = tokio::spawn(run_git_command(
        fixture.command("fork-live", "abort-child"),
        None,
        Duration::from_secs(1),
    ));
    let pid = fixture.pid("abort-child").await;
    task.abort();
    assert!(matches!(task.await, Err(error) if error.is_cancelled()));
    assert_exited(pid).await;
}
