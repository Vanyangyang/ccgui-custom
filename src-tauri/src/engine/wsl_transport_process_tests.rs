use super::*;
use std::os::windows::process::CommandExt;
use std::time::Duration;

struct Fixture {
    root: PathBuf,
    exe: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ccgui-ssh-process-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let exe = root.join("fixture.exe");
        let output = std::process::Command::new("rustc")
            .creation_flags(0x08000000)
            .arg("--edition=2021")
            .arg(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("src/git_worktree_process_fixture.rs"),
            )
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
    .expect("owned upload process must exit");
}

#[tokio::test]
async fn upload_deadline_covers_blocked_write_and_cancel_cleans_tree() {
    let fixture = Fixture::new();
    upload_command(
        fixture.command("read", "read"),
        b"script",
        Duration::from_secs(3),
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(fixture.root.join("read.visible")).unwrap(),
        "false"
    );
    let command = fixture.command("refuse", "blocked");
    let mut task = tokio::spawn(async move {
        upload_command(
            command,
            &vec![b'x'; 8 * 1024 * 1024],
            Duration::from_secs(1),
        )
        .await
    });
    let pid = fixture.pid("blocked").await;
    let result = match tokio::time::timeout(Duration::from_secs(5), &mut task).await {
        Ok(result) => result.unwrap(),
        Err(_) => {
            task.abort();
            let _ = task.await;
            assert_exited(pid).await;
            panic!("write must be bounded");
        }
    };
    assert!(result.unwrap_err().contains("超时"));
    assert_exited(pid).await;

    let command = fixture.command("fork-live", "cancel-child");
    let task = tokio::spawn(async move {
        upload_command(
            command,
            &vec![b'x'; 8 * 1024 * 1024],
            Duration::from_secs(30),
        )
        .await
    });
    let pid = fixture.pid("cancel-child").await;
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert_exited(pid).await;

    let result = upload_command(
        fixture.command("exit", "broken"),
        &vec![b'x'; 8 * 1024 * 1024],
        Duration::from_secs(3),
    )
    .await;
    assert!(
        result.is_err(),
        "broken stdin must fail instead of reporting success"
    );
}
