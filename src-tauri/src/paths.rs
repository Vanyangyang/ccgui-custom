use std::path::{Path, PathBuf};

#[cfg(any(debug_assertions, feature = "test-harness"))]
static DEV_PROFILE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Resolve before any lock, directory creation, settings read or service startup.
/// An explicit profile never falls back to the production profile on failure.
pub(crate) fn initialize_profile(requested: Option<&Path>) -> Result<(), String> {
    let Some(requested) = requested else {
        return Ok(());
    };
    #[cfg(not(any(debug_assertions, feature = "test-harness")))]
    {
        let _ = requested;
        Err("--dev-profile is only available in debug builds".into())
    }
    #[cfg(any(debug_assertions, feature = "test-harness"))]
    {
        let root = resolve_dev_profile(requested, &original_home_dir())?;
        for child in ["engine-home", "webview-data"] {
            let resolved = canonical_directory(&root.join(child))?;
            if !resolved.starts_with(&root) {
                return Err("development profile runtime directory escapes its root".into());
            }
        }
        #[cfg(feature = "test-harness")]
        if let Some(result) = crate::test_harness::set_profile(&root) {
            return result;
        }
        DEV_PROFILE
            .set(root)
            .map_err(|_| "development profile is already initialized".into())
    }
}

/// Integration-fixture seam: installs the ordinary process profile using a
/// synthetic production home; it does not install a test-harness context.
#[cfg(feature = "test-harness")]
pub(crate) fn initialize_ordinary_profile(requested: &Path, home: &Path) -> Result<(), String> {
    let root = resolve_dev_profile(requested, home)?;
    DEV_PROFILE.set(root).map_err(|_| "development profile is already initialized".into())
}

#[cfg(any(debug_assertions, feature = "test-harness"))]
fn canonical_directory(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() || path.to_str().map_or(true, |text| text.contains('\0')) {
        return Err("development profile must be an absolute Unicode directory path".into());
    }
    #[cfg(windows)]
    for component in path.components() {
        if let std::path::Component::Normal(name) = component {
            let name = name.to_str().ok_or("invalid profile path component")?;
            let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
            if name.ends_with(['.', ' '])
                || name.contains(['<', '>', ':', '"', '|', '?', '*'])
                || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || (stem.len() == 4
                    && (stem.starts_with("COM") || stem.starts_with("LPT"))
                    && matches!(stem.as_bytes()[3], b'1'..=b'9'))
            {
                return Err("invalid development profile path component".into());
            }
        }
    }
    // Resolve the existing ancestor without creating anything. Do not treat a
    // dangling symlink or an inaccessible path as a new directory.
    let mut ancestor = path;
    let mut missing = Vec::new();
    loop {
        match std::fs::symlink_metadata(ancestor) {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(
                    ancestor
                        .file_name()
                        .ok_or("unresolvable development profile path")?,
                );
                ancestor = ancestor
                    .parent()
                    .ok_or("unresolvable development profile ancestor")?;
            }
            Err(error) => return Err(format!("resolve development profile: {error}")),
        }
    }
    let mut canonical = dunce::canonicalize(ancestor)
        .map_err(|error| format!("canonicalize development profile: {error}"))?;
    if !canonical.is_dir() || canonical.to_str().is_none() {
        return Err("development profile ancestor must be a Unicode directory".into());
    }
    for name in missing.into_iter().rev() {
        canonical.push(name);
    }
    Ok(canonical)
}

#[cfg(any(debug_assertions, feature = "test-harness"))]
pub(crate) fn resolve_dev_profile(requested: &Path, home: &Path) -> Result<PathBuf, String> {
    let root = canonical_directory(requested)?;
    let production = canonical_directory(&home.join(".ccgui-next"))?;
    #[cfg(windows)]
    let (comparison, production) = (
        PathBuf::from(root.to_str().unwrap().to_lowercase()),
        PathBuf::from(production.to_str().unwrap().to_lowercase()),
    );
    #[cfg(not(windows))]
    let comparison = &root;
    if comparison.starts_with(&production) {
        return Err(
            "development profile must stay outside the production .ccgui-next directory".into(),
        );
    }
    for child in ["engine-home", "webview-data", "engine-home/.claude", "engine-home/.codex", "engine-home/.config", "engine-home/.local", "engine-home/tmp"] {
        let resolved = canonical_directory(&root.join(child))?;
        if !resolved.starts_with(&root) { return Err("development runtime path escapes its profile".into()); }
    }
    Ok(root)
}

pub(crate) fn dev_profile() -> Option<PathBuf> {
    #[cfg(feature = "test-harness")]
    if let Some(profile) = crate::test_harness::profile() {
        return profile;
    }
    #[cfg(any(debug_assertions, feature = "test-harness"))]
    {
        DEV_PROFILE.get().cloned()
    }
    #[cfg(not(any(debug_assertions, feature = "test-harness")))]
    {
        None
    }
}

pub(crate) fn is_dev_profile() -> bool {
    dev_profile().is_some()
}

/// Self-spawned stdio services must inherit the same explicit profile.
pub(crate) fn service_args(mode: &str) -> Vec<String> {
    let mut args = vec![mode.to_owned()];
    if let Some(root) = dev_profile() {
        args.push("--dev-profile".into());
        args.push(root.to_str().expect("validated profile path").into());
    }
    args
}

/// Home dir without panicking: a headless/odd environment falls back to the
/// current directory so startup degrades instead of crashing.
///
/// Production resolves through `dirs` (Known Folder API on Windows). Tests
/// steer it through HOME / USERPROFILE instead, because `dirs` ignores the
/// environment on Windows and would read the real profile — the same split
/// `engine::fallback_home` uses. The scanner's provider-home tests set a
/// scratch HOME and expect `~/.ccgui` under it; without this the v0.9
/// legacy scan kept looking at the real profile and found nothing.
fn original_home_dir() -> PathBuf {
    #[cfg(feature = "test-harness")]
    if let Some(home) = crate::test_harness::home_dir() {
        return home;
    }
    #[cfg(test)]
    {
        if let Some(home) = std::env::var_os("HOME").filter(|v| !v.is_empty()) {
            return PathBuf::from(home);
        }
        #[cfg(windows)]
        if let Some(profile) = std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()) {
            return PathBuf::from(profile);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

pub(crate) fn home_dir() -> PathBuf {
    crate::development_profile::home().unwrap_or_else(original_home_dir)
}

/// Serialize tests that steer process-global HOME / USERPROFILE (read by the
/// cfg(test) branch above): module-private locks would not exclude each other,
/// so every HOME-mutating test across the crate holds this one lock.
#[cfg(test)]
pub(crate) static HOME_ENV_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

/// Application home: the validated explicit debug profile, or ~/.ccgui-next/.
pub fn app_home() -> PathBuf {
    dev_profile().unwrap_or_else(|| home_dir().join(".ccgui-next"))
}

pub fn legacy_home() -> PathBuf {
    home_dir().join(".ccgui")
}

/// Legacy desktop-cc-gui's workspace list: its Tauri app-data dir (bundle id
/// `com.zhukunpenglinyutong.ccgui`) holds workspaces.json — the sidebar the
/// upgrade imports on first launch so old users keep their workspaces.
pub fn legacy_workspaces_path() -> PathBuf {
    let base = crate::development_profile::config_dir().or_else(dirs::config_dir).unwrap_or_else(home_dir);
    base.join("com.zhukunpenglinyutong.ccgui")
        .join("workspaces.json")
}

/// Legacy app's settings next to its workspace list: holds `workspaceGroups`
/// (sidebar 分组定义), imported on upgrade so groups survive the switch.
pub fn legacy_settings_path() -> PathBuf {
    let base = crate::development_profile::config_dir().or_else(dirs::config_dir).unwrap_or_else(home_dir);
    base.join("com.zhukunpenglinyutong.ccgui")
        .join("settings.json")
}

/// Legacy desktop-cc-gui's agent catalog: `~/.ccgui/agent.json` (singular —
/// the new app's catalog is `agents.json`). Imported on upgrade.
pub fn legacy_agents_path() -> PathBuf {
    legacy_home().join("agent.json")
}

/// Legacy desktop-cc-gui's Tauri app-data dir: per-workspace custom prompts
/// lived under `workspaces/<id>/prompts` here.
pub fn legacy_app_data_dir() -> PathBuf {
    let base = crate::development_profile::config_dir().or_else(dirs::config_dir).unwrap_or_else(home_dir);
    base.join("com.zhukunpenglinyutong.ccgui")
}

/// Legacy global prompts: the default Codex home's `prompts` dir, shared
/// with the Codex CLI itself (CODEX_HOME wins, matching the legacy
/// resolver). Migration copies out of it — never moves — because the CLI
/// still reads this directory.
pub fn legacy_global_prompts_dir() -> PathBuf {
    if let Some(home) = crate::development_profile::home() { return home.join(".codex/prompts"); }
    if let Some(value) = std::env::var_os("CODEX_HOME").filter(|v| !v.is_empty()) {
        return PathBuf::from(value).join("prompts");
    }
    home_dir().join(".codex").join("prompts")
}

pub fn config_path() -> PathBuf {
    app_home().join("config.json")
}

pub fn settings_path() -> PathBuf {
    app_home().join("settings.json")
}

pub fn db_path() -> PathBuf {
    app_home().join("app.db")
}

pub fn ensure_dirs() -> std::io::Result<()> {
    std::fs::create_dir_all(app_home())?;
    if let Some(home) = crate::development_profile::home() {
        for child in ["", "tmp", "appdata", "localappdata", ".config", ".local/share", ".cache"] {
            std::fs::create_dir_all(home.join(child))?;
        }
    }
    Ok(())
}

#[cfg(all(test, feature = "test-harness"))]
mod dev_profile_tests {
    use super::*;
    use crate::test_harness::TestHarness;

    fn directory_alias(fixture: &TestHarness, alias: &Path, target: &Path) {
        #[cfg(windows)]
        {
            // A registered fixture/bin script invokes the allowlisted cmd
            // wrapper. Junction creation needs no symlink privilege changes.
            let script = fixture.root().join("bin/profile-junction.cmd");
            std::fs::write(
                &script,
                b"@echo off\r\nmklink /J \"%CCGUI_TEST_LINK%\" \"%CCGUI_TEST_TARGET%\"\r\n",
            )
            .unwrap();
            fixture.register_cli("profile-junction", &script).unwrap();
            let mut command = crate::engine::resolve::command_for_binary(script.to_str().unwrap());
            command
                .env("CCGUI_TEST_LINK", dunce::simplified(alias))
                .env("CCGUI_TEST_TARGET", dunce::simplified(target));
            let output = command.as_std_mut().output().unwrap();
            assert!(
                output.status.success(),
                "fixture junction failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        #[cfg(unix)]
        {
            let _ = fixture;
            std::os::unix::fs::symlink(target, alias).unwrap();
        }
    }

    #[test]
    fn default_profile_and_service_arguments_are_unchanged() {
        let fixture = TestHarness::new().unwrap();
        assert_eq!(app_home(), fixture.root().join(".ccgui-next"));
        assert!(!is_dev_profile());
        assert_eq!(service_args("--computer-use-mcp"), ["--computer-use-mcp"]);
        assert_eq!(service_args("--host-chat-mcp"), ["--host-chat-mcp"]);
        initialize_profile(None).unwrap();
        assert_eq!(app_home(), fixture.root().join(".ccgui-next"));
    }

    #[test]
    fn explicit_profile_routes_storage_and_keeps_fake_cli_allowlist() {
        let fixture = TestHarness::new().unwrap();
        let production_settings = fixture.root().join(".ccgui-next/settings.json");
        std::fs::write(&production_settings, br#"{"language":"en"}"#).unwrap();
        let root = dunce::simplified(fixture.root())
            .join("dev profile 中文 🦀")
            .join("nested");
        fixture.use_profile(&root).unwrap();
        assert!(
            !root.exists(),
            "profile resolution must not create directories"
        );
        assert_eq!(app_home(), root);
        assert!(is_dev_profile());
        assert_eq!(config_path(), root.join("config.json"));
        assert_eq!(settings_path(), root.join("settings.json"));
        assert_eq!(db_path(), root.join("app.db"));
        ensure_dirs().unwrap();
        let canonical = dunce::canonicalize(&root).unwrap();
        assert_eq!(app_home(), canonical);
        std::fs::write(settings_path(), br#"{"language":"zh"}"#).unwrap();
        assert_eq!(crate::settings::read_settings().unwrap().language, "zh");
        assert_eq!(
            std::fs::read(&production_settings).unwrap(),
            br#"{"language":"en"}"#
        );
        for mode in ["--computer-use-mcp", "--host-chat-mcp"] {
            let args = service_args(mode);
            assert_eq!(args, [mode, "--dev-profile", canonical.to_str().unwrap()]);
            let options = crate::startup::options(
                std::iter::once("fixture-host").chain(args.iter().map(String::as_str)),
            )
            .unwrap();
            assert_eq!(options.profile.as_deref(), Some(root.as_path()));
        }
        // Choosing a CCGUI profile never disables the fixture's engine-home
        // routing or permits discovery of a real CLI.
        assert_eq!(home_dir(), root.join("engine-home"));
        let fake = fixture.root().join("bin/claude.cmd");
        std::fs::write(&fake, b"fixture only; never executed").unwrap();
        fixture.register_cli("claude", &fake).unwrap();
        assert_eq!(
            crate::engine::resolve::find_cli_binary("claude", None),
            Some(dunce::canonicalize(&fake).unwrap())
        );
        std::fs::remove_file(&fake).unwrap();
        assert!(crate::engine::resolve::find_cli_binary("claude", None).is_none());
        assert!(crate::engine::resolve::find_cli_binary("codex", None).is_none());
    }

    #[test]
    fn invalid_paths_fail_without_creating_directories_or_changing_selection() {
        let fixture = TestHarness::new().unwrap();
        let selected = dunce::simplified(fixture.root()).join("selected");
        fixture.use_profile(&selected).unwrap();
        let file = fixture.root().join("not-a-directory");
        std::fs::write(&file, b"fixture").unwrap();
        let production = fixture.root().join(".ccgui-next");
        for invalid in [
            PathBuf::from("relative-profile"),
            PathBuf::new(),
            file.clone(),
            file.join("child"),
            production.clone(),
            production.join("."),
            fixture.root().join("ws/../.ccgui-next"),
            production.join("dev"),
            fixture.root().join("missing/../.ccgui-next"),
            fixture.root().join("bad\0path"),
        ] {
            assert!(
                fixture.use_profile(&invalid).is_err(),
                "accepted {}",
                invalid.display()
            );
            assert_eq!(app_home(), selected);
        }
        #[cfg(windows)]
        for invalid in ["NUL", "CON.txt", "bad:stream", "trailing.", "trailing "] {
            assert!(fixture.use_profile(&fixture.root().join(invalid)).is_err());
        }
        assert!(!selected.exists());
        assert!(!production.join("dev").exists());
        assert!(!fixture.root().join("missing").exists());
        assert_eq!(std::fs::read(file).unwrap(), b"fixture");
    }

    #[test]
    fn canonical_aliases_reject_production_and_resolve_development_roots() {
        let fixture = TestHarness::new().unwrap();
        let production = fixture.root().join(".ccgui-next");
        let alias = fixture.root().join("production-alias");
        directory_alias(&fixture, &alias, &production);
        assert!(fixture.use_profile(&alias).is_err());
        assert!(fixture.use_profile(&alias.join("new-child")).is_err());
        #[cfg(windows)]
        assert!(fixture
            .use_profile(&PathBuf::from(production.to_str().unwrap().to_uppercase()))
            .is_err());
        let development = fixture.root().join("development");
        std::fs::create_dir(&development).unwrap();
        let alias = fixture.root().join("development-alias");
        directory_alias(&fixture, &alias, &development);
        fixture.use_profile(&alias).unwrap();
        assert_eq!(app_home(), dunce::canonicalize(&development).unwrap());
        fixture.use_profile(&alias.join("new-child")).unwrap();
        assert_eq!(
            app_home(),
            dunce::canonicalize(&development).unwrap().join("new-child")
        );
        assert!(!development.join("new-child").exists());
        std::fs::remove_dir(&development).unwrap();
        assert!(
            fixture.use_profile(&alias).is_err(),
            "dangling aliases must fail closed"
        );
    }

    #[test]
    fn absent_production_root_is_protected_without_creating_it() {
        let fixture = TestHarness::new().unwrap();
        let home = fixture.root().join("fake-home");
        std::fs::create_dir(&home).unwrap();
        assert!(resolve_dev_profile(&home.join(".ccgui-next"), &home).is_err());
        assert!(resolve_dev_profile(&home.join(".ccgui-next/child"), &home).is_err());
        assert!(resolve_dev_profile(&home.join("dev"), &home).is_ok());
        assert!(!home.join(".ccgui-next").exists());
        assert!(!home.join("dev").exists());
    }

    #[test]
    fn fixture_profile_selection_is_removed_on_drop() {
        {
            let fixture = TestHarness::new().unwrap();
            fixture.use_profile(&fixture.root().join("dev")).unwrap();
            assert!(is_dev_profile());
        }
        let fixture = TestHarness::new().unwrap();
        assert!(!is_dev_profile());
        assert_eq!(app_home(), fixture.root().join(".ccgui-next"));
    }
}
