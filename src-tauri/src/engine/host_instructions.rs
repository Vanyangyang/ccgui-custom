//! Host role guidance is additional context, not a replacement for the user's
//! instructions. A file keeps multiline guidance out of Windows command shims.
use std::io::Write;
use std::path::{Path, PathBuf};

pub(super) const STAGING_DIRECTORY: &str = "leader-role-staging";

const CHAT_PRESENTATION: &str = include_str!("../../../src/features/interactive-answer/capability-instructions.txt");

/// Engines whose ordinary chat renderer supports this protocol; keep aligned
/// with `supportsInteractiveAnswer` in the interactive-answer frontend. Compose
/// with the existing role context: Codex keeps configured developer
/// instructions, Claude appends it to the system prompt, and AGY loads it from
/// its per-run host plugin rules.
const PRESENTATION_ENGINES: [&str; 3] = ["codex", "claude", "agy"];

pub(super) fn with_plugin_instructions(host: Option<String>, plugin: Option<String>) -> Option<String> {
    match (host, plugin) {
        (Some(host), Some(plugin)) => Some(format!("{host}\n\n{plugin}")),
        (host, None) => host,
        (None, plugin) => plugin,
    }
}

pub(super) fn with_chat_presentation(engine: &str, ordinary_chat: bool, role: Option<String>) -> Option<String> {
    if !ordinary_chat || !PRESENTATION_ENGINES.contains(&engine) { return role; }
    Some(match role.filter(|text| !text.is_empty()) {
        Some(text) => format!("{text}\n\n{CHAT_PRESENTATION}"),
        None => CHAT_PRESENTATION.to_string(),
    })
}

/// Built-in availability/presentation hints carry no task ownership. They may
/// be omitted when another host takes an ordinary conversation; managed task
/// instructions and any unknown custom guidance still require this host.
pub(super) fn requires_local_host(instructions: Option<&str>) -> bool {
    let Some(text) = instructions.filter(|text| !text.is_empty()) else { return false; };
    let ordinary = crate::leader::unscoped_task_instructions();
    text != CHAT_PRESENTATION && text != ordinary
        && text != format!("{ordinary}\n\n{CHAT_PRESENTATION}")
}

fn stage(root: &Path, instructions: &str) -> Result<PathBuf, String> {
    if std::fs::symlink_metadata(root).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err("Leader instruction staging root must not be a symlink".into());
    }
    std::fs::create_dir_all(root).map_err(|_| "Cannot create Leader instruction staging directory")?;
    let path = root.join(format!("{}.txt", uuid::Uuid::new_v4()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|_| "Cannot create Leader instruction file")?;
    if let Err(error) = file.write_all(instructions.as_bytes()) {
        drop(file);
        let _ = std::fs::remove_file(&path);
        return Err(format!("Cannot write Leader instruction file: {error}"));
    }
    Ok(path)
}

pub(super) fn append_claude(
    built: &mut super::BuiltCommand,
    instructions: &str,
) -> Result<(), String> {
    if instructions.is_empty() { return Ok(()); }
    let path = stage(&crate::paths::app_home().join(STAGING_DIRECTORY), instructions)?;
    built.command.arg("--append-system-prompt-file").arg(&path);
    built.cleanup_files.push(path);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_policy_preserves_role_presentation_and_staging_cleanup() {
        for engine in ["claude", "codex"] {
            let native = with_chat_presentation(engine, true, Some("managed-child role".into()));
            let combined = with_plugin_instructions(native, Some("plugin policy v2".into())).unwrap();
            assert!(combined.starts_with("managed-child role\n\n"));
            assert_eq!(combined.matches(CHAT_PRESENTATION).count(), 1);
            assert_eq!(combined.matches("plugin policy v2").count(), 1);
            let root = std::env::temp_dir().join(format!("ccgui-plugin-role-{}", uuid::Uuid::new_v4()));
            let file = stage(&root, &combined).unwrap();
            assert_eq!(std::fs::read_to_string(&file).unwrap(), combined);
            crate::engine::cleanup_staged_files(&[file.clone()]);
            assert!(!file.exists());
            std::fs::remove_dir(root).unwrap();
        }
    }

    #[test]
    fn optional_host_hints_do_not_impersonate_a_managed_task_scope() {
        for hints in [None, Some(String::new()), Some(CHAT_PRESENTATION.into()),
            Some(crate::leader::unscoped_task_instructions()),
            with_chat_presentation("codex", true, Some(crate::leader::unscoped_task_instructions()))] {
            assert!(!requires_local_host(hints.as_deref()));
        }
        for role in ["Keep this private task scope".into(), crate::leader::owned_task_instructions()] {
            assert!(requires_local_host(Some(&role)));
            assert!(requires_local_host(with_chat_presentation("codex", true, Some(role)).as_deref()));
        }
    }

    #[test]
    fn presentation_context_is_scoped_and_preserves_role_guidance() {
        for engine in ["cursor", "gemini"] {
            assert_eq!(with_chat_presentation(engine, true, Some("role".into())), Some("role".into()));
        }
        for engine in PRESENTATION_ENGINES {
            assert_eq!(with_chat_presentation(engine, false, Some("role".into())), Some("role".into()));
            assert_eq!(with_chat_presentation(engine, false, None), None);
            assert_eq!(with_chat_presentation(engine, true, None), Some(CHAT_PRESENTATION.into()));
            assert_eq!(with_chat_presentation(engine, true, Some("role".into())), Some(format!("role\n\n{CHAT_PRESENTATION}")));
        }
        assert_eq!(with_chat_presentation("claude", true, Some("Leader".into())).unwrap(),
            format!("Leader

{CHAT_PRESENTATION}"));
        let plain = with_chat_presentation("codex", true, None).unwrap();
        assert!(plain.contains("ccgui-ui"));
        assert_eq!(with_chat_presentation("codex", true, Some(String::new())).unwrap(), plain);
        assert_eq!(with_chat_presentation("codex", true, Some("Leader 🧭".into())).unwrap(), format!("Leader 🧭\n\n{plain}"));
    }

    #[test]
    fn staged_instructions_preserve_multiline_unicode_and_shell_text() {
        let root = std::env::temp_dir().join(format!("ccgui-leader-role-{}", uuid::Uuid::new_v4()));
        let text = "推进目标 🧭\n父会话：%PATH% `echo` $(id)\n保留自主判断。";
        let first = stage(&root, text).unwrap();
        let second = stage(&root, "other").unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read_to_string(&first).unwrap(), text);
        assert!(first.starts_with(&root));
        crate::engine::cleanup_staged_files(&[first.clone(), second.clone()]);
        assert!(!first.exists() && !second.exists());
        std::fs::remove_dir(&root).unwrap();
    }
}
