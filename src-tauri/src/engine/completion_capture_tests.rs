use super::{mark_native_completion_with_admission, Command, NATIVE_COMPLETION_OWNER};
use std::ffi::OsStr;

fn owner_override(command: &Command) -> Option<Option<&OsStr>> {
    command
        .as_std()
        .get_envs()
        .find(|(name, _)| *name == NATIVE_COMPLETION_OWNER)
        .map(|(_, value)| value)
}

#[test]
fn custom_homes_and_project_hooks_do_not_block_native_capture() {
    let root = std::env::temp_dir().join(format!("ccgui-completion-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let fixtures = [
        (".claude", "settings.json", r#"{"hooks":{"Stop":[{}]}}"#),
        (
            ".claude",
            "settings.local.json",
            r#"{"hooks":{"Stop":[{}]}}"#,
        ),
        (".codex", "config.toml", "notify = ['fixture']"),
    ];
    for (directory, name, text) in fixtures {
        std::fs::create_dir_all(root.join(directory)).unwrap();
        std::fs::write(root.join(directory).join(name), text).unwrap();
    }
    for engine in ["claude", "codex", "grok"] {
        let mut command = Command::new(engine);
        command.current_dir(&root);
        for key in [
            "CODEX_HOME",
            "CLAUDE_CONFIG_DIR",
            "GROK_HOME",
            "SPELLCAST_COMPLETIONS_DIR",
        ] {
            command.env(key, root.join(format!("custom-{key}")));
        }
        let mut admitted = false;
        assert!(mark_native_completion_with_admission(
            &mut command,
            true,
            false,
            || {
                admitted = true;
                true
            }
        ));
        assert!(admitted);
        assert_eq!(owner_override(&command), Some(Some(OsStr::new("1"))));
        // Capturing a completion must not rewrite CLI configuration or hooks.
        for (directory, name, text) in fixtures {
            assert_eq!(
                std::fs::read_to_string(root.join(directory).join(name)).unwrap(),
                text
            );
        }
        for key in [
            "CODEX_HOME",
            "CLAUDE_CONFIG_DIR",
            "GROK_HOME",
            "SPELLCAST_COMPLETIONS_DIR",
        ] {
            let expected = root.join(format!("custom-{key}"));
            assert!(command
                .as_std()
                .get_envs()
                .any(|(name, value)| name == key && value == Some(expected.as_os_str())));
        }
    }
    for (directory, name, _) in fixtures {
        std::fs::remove_file(root.join(directory).join(name)).unwrap();
    }
    std::fs::remove_dir(root.join(".claude")).unwrap();
    std::fs::remove_dir(root.join(".codex")).unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[test]
fn ineligible_sources_and_managed_children_never_attempt_admission() {
    // `eligible` remains the existing local_title_source decision: it excludes
    // remote, sidechat/BTW, tool-constrained and non-GUI sources upstream.
    for (eligible, managed_child) in [(false, false), (false, true), (true, true)] {
        let mut command = Command::new("fixture");
        command.env(NATIVE_COMPLETION_OWNER, "1");
        assert!(!mark_native_completion_with_admission(
            &mut command,
            eligible,
            managed_child,
            || { panic!("excluded source must not reserve a durable completion") }
        ));
        assert_eq!(owner_override(&command), Some(None));
    }
}

#[test]
fn failed_durable_admission_never_sets_owner_marker() {
    for previous_marker in [None, Some("1")] {
        let mut command = Command::new("fixture");
        if let Some(value) = previous_marker {
            command.env(NATIVE_COMPLETION_OWNER, value);
        }
        let mut attempts = 0;
        assert!(!mark_native_completion_with_admission(
            &mut command,
            true,
            false,
            || {
                attempts += 1;
                false
            }
        ));
        assert_eq!(attempts, 1);
        // An explicit removal also suppresses any inherited owner marker.
        assert_eq!(owner_override(&command), Some(None));
    }
}
