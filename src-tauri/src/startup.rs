//! Select service modes before any GUI ownership or mutable startup work.
use std::ffi::{OsStr, OsString};
use std::path::PathBuf;

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Mode {
    Gui,
    HostChatMcp,
    ComputerUseMcp,
    TaskWorker,
    TaskWorkerProbe,
    UpdateSupervisor,
}

pub(crate) struct Options {
    pub mode: Mode,
    pub profile: Option<PathBuf>,
    pub resume: Option<String>,
}

pub(crate) fn options(
    args: impl IntoIterator<Item = impl AsRef<OsStr>>,
) -> Result<Options, &'static str> {
    parse_options(args, cfg!(any(debug_assertions, feature = "test-harness")))
}

fn parse_options(
    args: impl IntoIterator<Item = impl AsRef<OsStr>>,
    allow_profile: bool,
) -> Result<Options, &'static str> {
    let (mut host, mut computer, mut worker, mut probe) = (false, false, false, false);
    let mut supervisor = false;
    let mut resume = None;
    let mut profile = None;
    let mut args = args
        .into_iter()
        .map(|arg| arg.as_ref().to_os_string())
        .skip(1);
    while let Some(arg) = args.next() {
        if arg.as_encoded_bytes().starts_with(b"--dev-profile=") && arg.to_str().is_none() {
            return Err("Development profile path must be valid Unicode");
        }
        let inline = arg
            .to_str()
            .and_then(|arg| arg.strip_prefix("--dev-profile="));
        if arg == OsStr::new("--dev-profile") || inline.is_some() {
            if !allow_profile {
                return Err("--dev-profile is only available in debug builds");
            }
            if profile.is_some() {
                return Err("Duplicate --dev-profile option");
            }
            let value = match inline {
                Some(value) => OsString::from(value),
                None => args.next().ok_or("Missing --dev-profile path")?,
            };
            if value.is_empty() {
                return Err("Missing --dev-profile path");
            }
            profile = Some(PathBuf::from(value));
        } else {
            host |= arg == OsStr::new("--host-chat-mcp");
            computer |= arg == OsStr::new("--computer-use-mcp");
            worker |= arg == OsStr::new("--task-worker");
            probe |= arg == OsStr::new("--task-worker-probe");
            supervisor |= arg == OsStr::new("--live-update-supervisor");
            if let Some(id) = arg.to_str().and_then(|arg| arg.strip_prefix("--live-update-resume=")) {
                if resume.is_some() || id.len() != 36 || uuid::Uuid::parse_str(id).is_err() { return Err("Invalid update recovery identity"); }
                resume = Some(id.to_string());
            }
        }
    }
    if [host, computer, worker, probe, supervisor].iter().filter(|enabled| **enabled).count() > 1 {
        return Err("Conflicting MCP service modes");
    }
    let mode = match (host, computer) {
        (true, true) => return Err("Conflicting MCP service modes"),
        (true, false) => Mode::HostChatMcp,
        (false, true) => Mode::ComputerUseMcp,
        _ if worker => Mode::TaskWorker,
        _ if probe => Mode::TaskWorkerProbe,
        _ if supervisor => Mode::UpdateSupervisor,
        _ => Mode::Gui,
    };
    if resume.is_some() && mode != Mode::Gui { return Err("Update recovery requires GUI mode"); }
    Ok(Options { mode, profile, resume })
}

#[cfg(test)]
fn mode(args: impl IntoIterator<Item = impl AsRef<OsStr>>) -> Result<Mode, &'static str> {
    options(args).map(|options| options.mode)
}

#[cfg(windows)]
pub(crate) fn show_single_instance_error(error: &str) {
    use windows::{
        core::PCWSTR,
        Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK},
    };
    let language = crate::settings::read_settings()
        .unwrap_or_default()
        .language;
    let (title, body) = error_text(&language, error);
    let title: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
    let body: Vec<u16> = body.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        MessageBoxW(
            None,
            PCWSTR(body.as_ptr()),
            PCWSTR(title.as_ptr()),
            MB_OK | MB_ICONERROR,
        );
    }
}

#[cfg(windows)]
pub(crate) fn withdraw_instance_marker(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    if let Some(marker) = app.try_state::<crate::single_instance::WindowMarker>() {
        marker.withdraw()?;
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn error_text(language: &str, error: &str) -> (String, String) {
    // Shared with the frontend catalogs, even before a webview exists.
    let catalog: serde_json::Value =
        serde_json::from_str(include_str!("../../src/i18n/native-startup.json"))
            .expect("valid bundled startup translations");
    let language = if language.starts_with("en") {
        "en"
    } else {
        "zh"
    };
    let messages = &catalog[language];
    (
        messages["singleInstanceErrorTitle"]
            .as_str()
            .expect("startup title")
            .into(),
        messages["singleInstanceError"]
            .as_str()
            .expect("startup body")
            .replace("{{error}}", error),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_options_preserve_modes_and_reject_missing_duplicate_or_release_options() {
        let parsed = parse_options(
            [
                "fixture",
                "--dev-profile",
                "fixture-path",
                "--computer-use-mcp",
            ],
            true,
        )
        .unwrap();
        assert_eq!(parsed.mode, Mode::ComputerUseMcp);
        assert_eq!(parsed.profile, Some(PathBuf::from("fixture-path")));
        assert_eq!(
            parse_options(
                ["fixture", "--host-chat-mcp", "--dev-profile=fixture-path"],
                true
            )
            .unwrap()
            .mode,
            Mode::HostChatMcp
        );
        for args in [
            vec!["fixture", "--dev-profile"],
            vec!["fixture", "--dev-profile="],
            vec!["fixture", "--dev-profile", ""],
            vec!["fixture", "--dev-profile=a", "--dev-profile=b"],
            vec!["fixture", "--dev-profile", "a", "--dev-profile", "b"],
            vec![
                "fixture",
                "--host-chat-mcp",
                "--computer-use-mcp",
                "--dev-profile=a",
            ],
        ] {
            assert!(options(args).is_err());
        }
        for args in [
            vec!["fixture", "--dev-profile", "a"],
            vec!["fixture", "--dev-profile=a"],
        ] {
            assert!(parse_options(args, false).is_err());
        }
        assert!(parse_options(["fixture"], false).unwrap().profile.is_none());
    }

    #[cfg(windows)]
    #[test]
    fn non_unicode_inline_profile_cannot_be_ignored_as_an_unrelated_argument() {
        use std::os::windows::ffi::OsStringExt;
        let mut wide: Vec<u16> = "--dev-profile=".encode_utf16().collect();
        wide.push(0xd800);
        assert!(options([OsString::from("fixture"), OsString::from_wide(&wide)]).is_err());
    }

    #[test]
    fn gui_and_both_mcp_services_are_distinct_modes() {
        assert_eq!(mode(["ccgui-next.exe"]), Ok(Mode::Gui));
        assert_eq!(mode(["ccgui-next.exe", "--task-worker"]), Ok(Mode::TaskWorker));
        assert_eq!(mode(["ccgui-next.exe", "--task-worker-probe"]), Ok(Mode::TaskWorkerProbe));
        assert!(mode(["ccgui-next.exe", "--task-worker", "--host-chat-mcp"]).is_err());
        assert_eq!(
            mode(["ccgui-next.exe", "--host-chat-mcp"]),
            Ok(Mode::HostChatMcp)
        );
        assert_eq!(
            mode(["ccgui-next.exe", "--computer-use-mcp"]),
            Ok(Mode::ComputerUseMcp)
        );
        assert_eq!(
            mode(["ccgui-next.exe", "--host-chat-mcp", "--computer-use-mcp"]),
            Err("Conflicting MCP service modes")
        );
        assert_eq!(
            mode(["ccgui-next.exe", "--host-chat-mcp-extra"]),
            Ok(Mode::Gui)
        );
    }

    #[test]
    fn native_failure_messages_share_both_frontend_languages() {
        for language in ["zh", "en"] {
            let (title, body) = error_text(language, "fixture: access denied");
            assert!(!title.is_empty());
            assert!(body.contains("fixture: access denied"));
            assert!(!body.contains("{{error}}"));
        }
    }

    #[cfg(windows)]
    #[test]
    fn unrelated_non_unicode_arguments_do_not_break_service_selection() {
        use std::os::windows::ffi::OsStringExt;
        let malformed = std::ffi::OsString::from_wide(&[0xd800]);
        assert_eq!(
            mode([malformed, "--host-chat-mcp".into()]),
            Ok(Mode::HostChatMcp)
        );
    }
}
