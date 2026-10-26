//! Child-local environment assertions using only hidden local cmd fixtures.
use std::path::PathBuf;

pub(crate) struct Fixture(pub(crate) PathBuf);

impl Fixture {
    pub(crate) fn new(body: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("ccgui-agy-background-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("custom-cli.cmd"), format!(
            "@echo off\r\nif not \"%AGY_CLI_DISABLE_AUTO_UPDATE%\"==\"true\" exit /b 7\r\necho %*>>\"{}\"\r\n{body}\r\n",
            root.join("calls").display(),
        )).unwrap();
        Self(root)
    }

    pub(crate) fn bin(&self) -> String {
        self.0.join("custom-cli.cmd").to_string_lossy().into_owned()
    }

    pub(crate) fn calls(&self) -> Vec<String> {
        std::fs::read_to_string(self.0.join("calls"))
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn agy_background_version_probe_custom_binary_receives_true() {
    let fixture = Fixture::new("echo %AGY_CLI_DISABLE_AUTO_UPDATE%");
    let result = crate::cli_lifecycle::probe_local_version(&fixture.bin()).await;
    assert!(result.installed);
    assert_eq!(result.version.as_deref(), Some("true"));
    assert_eq!(fixture.calls(), ["--version"]);
}
