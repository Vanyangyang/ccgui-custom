//! Opt-in CLI agent definition. No settings files, model or permission overrides.
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

const ERROR_PREFIX: &str = "CLAUDE_HAIKU_ASSIST_UNAVAILABLE:";
pub(super) const AGENT_NAME: &str = "ccgui-haiku-assist";

fn unavailable(detail: &str) -> String {
    format!("{ERROR_PREFIX} {detail}")
}

fn check_help(success: bool, help: &str) -> Result<(), String> {
    if success && help.lines().any(|line| {
        line.trim_start().strip_prefix("--agents")
            .is_some_and(|tail| tail.starts_with(char::is_whitespace))
    }) {
        Ok(())
    } else {
        Err(unavailable("The selected Claude CLI does not advertise --agents. Turn assistance off to use the existing strategy."))
    }
}

/// Only a low-impact help probe, against the exact resolved launch binary.
/// Bound time and output; kill-on-drop also handles cancellation and timeout.
pub(super) async fn ensure_supported(bin: &str) -> Result<(), String> {
    let mut command = super::command_for_binary(bin);
    command.arg("--help").stdin(Stdio::null()).stdout(Stdio::piped())
        .stderr(Stdio::null()).kill_on_drop(true);
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut child = command.spawn().map_err(|_| unavailable("Could not inspect the selected Claude CLI."))?;
        let mut help = Vec::new();
        child.stdout.take().ok_or_else(|| unavailable("CLI help output is unavailable."))?
            .take(64 * 1024).read_to_end(&mut help).await
            .map_err(|_| unavailable("Could not read CLI help output."))?;
        let status = child.wait().await.map_err(|_| unavailable("CLI help probe did not finish."))?;
        check_help(status.success(), &String::from_utf8_lossy(&help))
    }).await.map_err(|_| unavailable("CLI help probe timed out."))?
}

pub(super) fn validate_scope(engine: &str, remote: bool) -> Result<(), String> {
    if engine != "claude" || remote {
        return Err(unavailable("Assistance requires a local Claude CLI; remote CLI capabilities cannot be verified here."));
    }
    Ok(())
}

pub(super) fn apply(command: &mut Command) {
    command.arg("--agents").arg(serde_json::json!({
        AGENT_NAME: {
            "description": "Optional Haiku helper for simple searches, summaries and bounded supporting tasks. Delegate only when useful; the main agent owns complex decisions and final review.",
            "prompt": "Complete only the bounded supporting task assigned by the main agent. Preserve existing user changes and obey the session's instructions and permission rules. Report evidence, uncertainty and failures clearly. Return complex decisions and final acceptance to the main agent. Do not delegate further.",
            "model": "haiku"
        }
    }).to_string());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capability_requires_a_successful_exact_option_and_local_claude() {
        assert!(check_help(true, "Options:\n  --agents <json-or-file> JSON agents").is_ok());
        for (success, help) in [(false, "--agents <json>"), (true, "--agent <name>"), (true, "See --agents in a guide"), (true, "--agents-other <json>")] {
            assert!(check_help(success, help).unwrap_err().starts_with(ERROR_PREFIX));
        }
        assert!(validate_scope("claude", false).is_ok());
        assert!(validate_scope("claude", true).is_err());
        assert!(validate_scope("codex", false).is_err());
    }

    #[test]
    fn optional_definition_does_not_override_model_or_permissions() {
        let mut command = Command::new("fake-claude");
        command.args(["--model", "opus", "--permission-mode", "manual", "--resume", "session-a"]);
        let before: Vec<_> = command.as_std().get_args().map(|arg| arg.to_owned()).collect();
        apply(&mut command);
        let args: Vec<_> = command.as_std().get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
        assert_eq!(command.as_std().get_args().take(before.len()).collect::<Vec<_>>(), before.iter().map(|arg| arg.as_os_str()).collect::<Vec<_>>());
        assert_eq!(args[6], "--agents");
        let definition: serde_json::Value = serde_json::from_str(&args[7]).unwrap();
        assert_eq!(definition[AGENT_NAME]["model"], "haiku");
        assert_eq!(definition.as_object().unwrap().len(), 1);
        assert!(definition[AGENT_NAME].get("permissionMode").is_none());
        assert!(command.as_std().get_envs().next().is_none());
    }
}
