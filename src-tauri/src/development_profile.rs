//! Development runtime layout. No process environment or user files are changed.
use std::ffi::OsString;
use std::path::PathBuf;

pub(crate) fn root() -> Option<PathBuf> {
    crate::paths::dev_profile()
}
pub(crate) fn home() -> Option<PathBuf> {
    root().map(|root| root.join("engine-home"))
}
pub(crate) fn config_dir() -> Option<PathBuf> {
    home().map(|home| home.join(".config"))
}
pub(crate) fn webview_dir() -> Option<PathBuf> {
    root().map(|root| root.join("webview-data"))
}

pub(crate) fn automatic_integrations_allowed() -> bool {
    root().is_none()
}

#[tauri::command]
pub fn development_profile_active() -> bool {
    root().is_some()
}

/// Also used by the ordinary command path: fixture environment cleaning must
/// never be the only reason an isolated child avoids inherited credentials.
pub(crate) fn child_environment() -> Option<Vec<(OsString, OsString)>> {
    let home = home()?;
    let mut env = Vec::new();
    // Installed programs remain available for future explicit manual runs.
    // No credential, proxy, hook or engine-home variables are inherited.
    for key in ["PATH", "SystemRoot", "WINDIR"] {
        if let Some(value) = std::env::var_os(key) {
            env.push((key.into(), value));
        }
    }
    for (key, suffix) in [
        ("HOME", ""),
        ("USERPROFILE", ""),
        ("APPDATA", "appdata"),
        ("LOCALAPPDATA", "localappdata"),
        ("TEMP", "tmp"),
        ("TMP", "tmp"),
        ("XDG_CONFIG_HOME", ".config"),
        ("XDG_DATA_HOME", ".local/share"),
        ("XDG_CACHE_HOME", ".cache"),
        ("CLAUDE_CONFIG_DIR", ".claude"),
        ("CODEX_HOME", ".codex"),
        ("PI_CODING_AGENT_DIR", ".pi/agent"),
        ("OMP_CODING_AGENT_DIR", ".omp/agent"),
        ("KIMI_CODE_HOME", ".kimi-code"),
        ("GROK_HOME", ".grok"),
        ("GROK_CONFIG_PATH", ".grok/config.toml"),
        ("GROK_AUTH_PATH", ".grok/auth.toml"),
        ("ANTIGRAVITY_HOME", ".gemini/antigravity-cli"),
        ("DSH_HOME", ".dsh"),
        ("OPENCODE_HOME", ".local/share/opencode"),
        ("HERMES_HOME", ".hermes"),
        ("GEMINI_DIR", ".gemini"),
    ] {
        env.push((key.into(), home.join(suffix).into_os_string()));
    }
    Some(env)
}

pub(crate) fn configure_command(command: &mut tokio::process::Command) {
    if let Some(env) = child_environment() {
        command.env_clear().envs(env);
    }
}

/// Keep home routing authoritative after a provider supplied explicit launch
/// values. Its explicit credentials are allowed; inherited credentials are not.
pub(crate) fn enforce_homes(command: &mut tokio::process::Command) {
    if let Some(env) = child_environment() {
        command.envs(
            env.into_iter()
                .filter(|(key, _)| key != "PATH" && key != "SystemRoot" && key != "WINDIR"),
        );
    }
}

/// Namespace is deterministic for one canonical root, independent of process
/// ids and reconnect generations. The legacy stable relay route stays intact.
pub(crate) fn relay_scope() -> Option<String> {
    use sha2::{Digest, Sha256};
    root().map(|root| {
        let text = root.to_string_lossy();
        #[cfg(windows)]
        let text = text.to_lowercase();
        format!("dev-{:x}", Sha256::digest(text.as_bytes()))
    })
}

pub(crate) fn run_automatic(action: impl FnOnce()) {
    if automatic_integrations_allowed() {
        action();
    }
}
