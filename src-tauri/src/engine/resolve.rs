//! CLI binary resolution and spawnable-command construction.
//!
//! Ported from the reference desktop-cc-gui's `backend/app_server_cli.rs`,
//! trimmed to the engine-spawn use case. Three Windows realities drive the
//! design:
//!
//! - A GUI process inherits the registry PATH snapshot, which often predates
//!   the user's Node/npm install (or misses nvm/fnm/scoop shims entirely), so
//!   `which` alone can't find npm-global CLIs. We probe the registry's live
//!   User/Machine PATH, a list of well-known install dirs, plus
//!   `npm config get prefix`.
//! - npm global bins ship three files: an extensionless POSIX shim, a `.cmd`
//!   wrapper, and a `.ps1` wrapper. CreateProcess matches the exact filename
//!   before PATHEXT and cannot run batch files, so `Command::new("claude")`
//!   or a path to the shim fails with os error 193. We prefer the `.cmd`
//!   variant and wrap batch files in `cmd /c` (`.ps1` in `powershell -File`).
//! - macOS shims are real shebang scripts (`#!/usr/bin/env node`).
//!   `adopt_login_shell_path` usually fixes the process PATH, but discovery
//!   can still succeed via well-known dirs when adopt fails/times out. Any
//!   spawn of a shebang shim must therefore inject [`cli_search_path`] into
//!   the child env — otherwise `/usr/bin/env` cannot see `node` even though
//!   `find_cli_binary("npx")` returned an absolute path.

use std::path::{Path, PathBuf};
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant};

use tokio::process::Command;

/// `npm config get prefix` probing is a blocking spawn; a process-level cache
/// (30s TTL) keeps repeated detection rounds from re-probing. Worst-case
/// staleness after a fresh CLI install is one TTL.
const RESOLUTION_CACHE_TTL: Duration = Duration::from_secs(30);
const NPM_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const NPM_REAP_TIMEOUT: Duration = Duration::from_millis(250);
const NPM_PREFIX_MAX_BYTES: u64 = 16 * 1024;

static EXTRA_SEARCH_PATHS_CACHE: StdMutex<Option<(Vec<PathBuf>, Instant)>> = StdMutex::new(None);

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|existing| paths_equal(existing, &path)) {
        paths.push(path);
    }
}

/// Compare paths (case-insensitive on Windows).
fn paths_equal(a: &Path, b: &Path) -> bool {
    #[cfg(windows)]
    {
        a.to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

// ── npm global prefix discovery ─────────────────────────────────────────────

/// npm's global bin dir from a `npm config get prefix` value: the prefix
/// itself on Windows, `<prefix>/bin` on Unix.
fn resolve_npm_global_bin_dir_from_prefix(prefix: &str) -> Option<PathBuf> {
    let trimmed = prefix.trim();
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("undefined")
        || trimmed.eq_ignore_ascii_case("null")
    {
        return None;
    }
    let prefix_path = PathBuf::from(trimmed);

    #[cfg(windows)]
    {
        Some(prefix_path)
    }
    #[cfg(not(windows))]
    {
        let normalized = if prefix_path.file_name() == Some(std::ffi::OsStr::new("bin")) {
            prefix_path
        } else {
            prefix_path.join("bin")
        };
        Some(normalized)
    }
}

fn reap_npm_probe(child: &mut tokio::process::Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => return false,
        }
    }
}

fn discover_npm_global_bin_dir(seed_paths: &[PathBuf]) -> Option<PathBuf> {
    let joined_paths = std::env::join_paths(seed_paths.iter()).ok()?;
    let cwd = std::env::current_dir().ok()?;
    let npm_bin = which::which_in("npm", Some(&joined_paths), &cwd)
        .ok()
        .or_else(|| which::which("npm").ok())?;
    let npm_bin = strip_verbatim(upgrade_executable_variant(npm_bin));

    let mut command = command_for_binary(&npm_bin.to_string_lossy());
    command.env("PATH", &joined_paths);
    command.args(["config", "get", "prefix"]);
    command.stdin(std::process::Stdio::null());
    command.stderr(std::process::Stdio::null());
    command.kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    super::hide_console(&mut command);

    let output_path =
        std::env::temp_dir().join(format!("ccgui-npm-{}.stdout", uuid::Uuid::new_v4()));
    let mut output_file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&output_path)
        .ok()?;
    let result = (|| {
        use std::io::{Read, Seek, SeekFrom};

        command.stdout(output_file.try_clone().ok()?);
        let deadline = Instant::now() + NPM_PROBE_TIMEOUT;
        let mut child = {
            let runtime = tauri::async_runtime::handle();
            let _entered = runtime.inner().enter();
            command.spawn().ok()?
        };
        let pid = child.id()?;
        #[cfg(windows)]
        let tree_guard = super::job::assign_kill_on_close(&child);
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None)
                    if Instant::now() < deadline
                        && output_file
                            .metadata()
                            .map(|metadata| metadata.len() <= NPM_PREFIX_MAX_BYTES)
                            .unwrap_or(false) =>
                {
                    std::thread::sleep(Duration::from_millis(10));
                }
                _ => break None,
            }
        };
        #[cfg(unix)]
        super::kill_process_group(pid);
        #[cfg(windows)]
        {
            if status.is_none() && tree_guard.is_none() {
                super::kill_process_group(pid);
            }
            drop(tree_guard);
        }
        if status.is_none() {
            let _ = child.start_kill();
            if !reap_npm_probe(&mut child, NPM_REAP_TIMEOUT) {
                eprintln!("[engine] npm probe reap deadline exceeded; cleanup is incomplete");
            }
            return None;
        }
        if !status?.success() {
            return None;
        }
        output_file.seek(SeekFrom::Start(0)).ok()?;
        let mut stdout = Vec::new();
        (&mut output_file)
            .take(NPM_PREFIX_MAX_BYTES + 1)
            .read_to_end(&mut stdout)
            .ok()?;
        if stdout.len() as u64 > NPM_PREFIX_MAX_BYTES {
            return None;
        }
        resolve_npm_global_bin_dir_from_prefix(&String::from_utf8_lossy(&stdout))
    })();
    drop(command);
    drop(output_file);
    if let Err(error) = std::fs::remove_file(output_path) {
        eprintln!("[engine] npm probe output cleanup failed: {error}");
    }
    result
}

// ── extra search paths ──────────────────────────────────────────────────────

/// Well-known CLI install locations on Windows. GUI processes frequently hold
/// a stale PATH, so these are checked directly instead of trusting the env.
#[cfg(any(windows, test))]
fn build_windows_extra_search_paths(
    appdata: Option<&Path>,
    user_profile: Option<&Path>,
    local_app_data: Option<&Path>,
    program_files: Option<&Path>,
    program_files_x86: Option<&Path>,
) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = Vec::new();

    if let Some(appdata) = appdata {
        // npm -g default prefix on Windows (%APPDATA%\npm).
        paths.push(appdata.join("npm"));
    }
    if let Some(user_profile) = user_profile {
        // Fallback: npm global install path via USERPROFILE.
        paths.push(user_profile.join("AppData\\Roaming\\npm"));
        paths.push(user_profile.join(".local\\bin"));
        paths.push(user_profile.join(".codex-cli\\bin"));
        paths.push(user_profile.join(".local\\share\\mise\\shims"));
        // Hermes ships dsh as a Node-global bin, same layout as ~/.hermes/node/bin.
        paths.push(user_profile.join(".hermes\\node"));
        paths.push(user_profile.join(".hermes\\node\\bin"));
        paths.push(user_profile.join(".omp\\bin"));
        paths.push(user_profile.join(".cargo\\bin"));
        paths.push(user_profile.join(".bun\\bin"));
        // Legacy codemoss builds bundled the Claude Agent SDK under the app
        // home; users whose only claude is that copy have nothing on PATH.
        // Scan for the arch-specific package dir instead of hardcoding x64.
        let codemoss_sdk_root =
            user_profile.join(".codemoss\\dependencies\\claude-sdk\\node_modules\\@anthropic-ai");
        if let Ok(entries) = std::fs::read_dir(&codemoss_sdk_root) {
            for entry in entries.flatten() {
                let candidate = entry.path();
                if candidate.is_dir()
                    && entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with("claude-agent-sdk-win32-")
                {
                    paths.push(candidate);
                }
            }
        }
        // Scoop shims + the active Node prefix (npm -g often lands here).
        paths.push(user_profile.join("scoop\\shims"));
        paths.push(user_profile.join("scoop\\apps\\nodejs\\current"));
        paths.push(user_profile.join("scoop\\apps\\nodejs-lts\\current"));
        paths.push(user_profile.join("scoop\\persist\\nodejs"));
        paths.push(user_profile.join("scoop\\persist\\nodejs\\bin"));
        // fnm (Fast Node Manager).
        let fnm_root = user_profile.join("AppData\\Local\\fnm\\node-versions");
        if let Ok(entries) = std::fs::read_dir(&fnm_root) {
            for entry in entries.flatten() {
                let bin_path = entry.path().join("installation");
                if bin_path.is_dir() {
                    paths.push(bin_path);
                }
            }
        }
        // nvm-windows.
        let nvm_root = user_profile.join("AppData\\Roaming\\nvm");
        if let Ok(entries) = std::fs::read_dir(&nvm_root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir()
                    && path
                        .file_name()
                        .is_some_and(|n| n.to_string_lossy().starts_with('v'))
                {
                    paths.push(path);
                }
            }
        }
    }
    if let Some(local_app_data) = local_app_data {
        // Official OMP CLI Windows installer layout: %LOCALAPPDATA%\omp\omp.exe.
        paths.push(local_app_data.join("omp"));
        // Official Cursor Agent installer: %LOCALAPPDATA%\cursor-agent\cursor-agent.cmd.
        paths.push(local_app_data.join("cursor-agent"));
        // Hermes prefixes also live under %LOCALAPPDATA% (per-shell layout);
        // dsh ships as a Node-global bin there.
        paths.push(local_app_data.join("hermes\\node"));
        paths.push(local_app_data.join("hermes\\node\\bin"));
        paths.push(local_app_data.join("Volta\\bin"));
        paths.push(local_app_data.join("pnpm"));
        paths.push(local_app_data.join("mise\\shims"));
        let fnm_multishells = local_app_data.join("fnm_multishells");
        if let Ok(entries) = std::fs::read_dir(&fnm_multishells) {
            for entry in entries.flatten() {
                let candidate = entry.path();
                if candidate.is_dir() {
                    paths.push(candidate);
                }
            }
        }
        // User-scoped Node.js installs (common when not installed to Program Files).
        let programs_root = local_app_data.join("Programs");
        if programs_root.is_dir() {
            paths.push(programs_root.join("nodejs"));
            // Official OpenAI Codex Windows installer layout:
            // %LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe. The installer
            // only appends to User PATH, which a stale-PATH GUI process misses.
            paths.push(programs_root.join("OpenAI\\Codex\\bin"));
            if let Ok(entries) = std::fs::read_dir(&programs_root) {
                for entry in entries.flatten() {
                    let candidate = entry.path();
                    if !candidate.is_dir() {
                        continue;
                    }
                    let folder_name = entry.file_name().to_string_lossy().to_ascii_lowercase();
                    if folder_name == "nodejs"
                        || folder_name.starts_with("node-v")
                        || folder_name.starts_with("nodejs-v")
                    {
                        paths.push(candidate);
                    }
                }
            }
        }
    }
    if let Some(program_files) = program_files {
        paths.push(program_files.join("nodejs"));
    }
    if let Some(program_files_x86) = program_files_x86 {
        paths.push(program_files_x86.join("nodejs"));
    }

    paths
}

/// Well-known CLI install locations on Unix. `adopt_login_shell_path` already
/// imports the login shell's PATH; these are the static fallbacks for
/// detection paths that run before/independent of it.
#[cfg(not(windows))]
fn build_unix_extra_search_paths() -> Vec<PathBuf> {
    let mut paths = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
    ];
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".local/bin"));
        paths.push(home.join(".codex-cli/bin"));
        paths.push(home.join(".local/share/mise/shims"));
        paths.push(home.join(".cargo/bin"));
        paths.push(home.join(".bun/bin"));
        paths.push(home.join(".volta/bin"));
        paths.push(home.join(".omp/bin"));
        paths.push(home.join(".cursor/bin"));
        // nvm: globally installed CLIs land in the active version's bin.
        let nvm_root = home.join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(nvm_root) {
            for entry in entries.flatten() {
                let bin_path = entry.path().join("bin");
                if bin_path.is_dir() {
                    paths.push(bin_path);
                }
            }
        }
    }
    paths
}

/// Expand `%VAR%` references from the process environment (registry PATH
/// values are REG_EXPAND_SZ and winreg returns them raw). Unknown vars stay
/// literal so a partially resolvable value still yields usable entries.
#[cfg(any(windows, test))]
fn expand_windows_env_vars(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => {
                let name = &after[..end];
                match std::env::var(name) {
                    Ok(resolved) => out.push_str(&resolved),
                    Err(_) => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            _ => {
                out.push('%');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// Split a registry PATH value into individual dirs (empty segments out).
#[cfg(any(windows, test))]
fn parse_registry_path_value(value: &str) -> Vec<PathBuf> {
    expand_windows_env_vars(value)
        .split(';')
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .map(PathBuf::from)
        .collect()
}

/// Live PATH from the registry: `HKCU\Environment` (User) and the system
/// Environment key (Machine). A GUI process inherits the PATH snapshot of
/// its launcher, which predates any CLI installed while the app is running;
/// the registry always holds what a freshly opened terminal would see.
#[cfg(windows)]
fn registry_environment_paths() -> Vec<PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let mut paths: Vec<PathBuf> = Vec::new();
    for (root, subkey) in [
        (HKEY_CURRENT_USER, "Environment"),
        (
            HKEY_LOCAL_MACHINE,
            r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
        ),
    ] {
        if let Ok(key) = RegKey::predef(root).open_subkey(subkey) {
            if let Ok(value) = key.get_value::<String, _>("Path") {
                for path in parse_registry_path_value(&value) {
                    push_unique_path(&mut paths, path);
                }
            }
        }
    }
    paths
}

fn get_extra_search_paths() -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = Vec::new();

    #[cfg(windows)]
    {
        let appdata = std::env::var("APPDATA").ok();
        let user_profile = std::env::var("USERPROFILE").ok();
        let local_app_data = std::env::var("LOCALAPPDATA").ok();
        let program_files = std::env::var("ProgramFiles").ok();
        let program_files_x86 = std::env::var("ProgramFiles(x86)").ok();
        paths.extend(build_windows_extra_search_paths(
            appdata.as_deref().map(Path::new),
            user_profile.as_deref().map(Path::new),
            local_app_data.as_deref().map(Path::new),
            program_files.as_deref().map(Path::new),
            program_files_x86.as_deref().map(Path::new),
        ));
        // Live User/Machine PATH: it reflects installs made while the
        // app was running, which the inherited process PATH snapshot misses.
        paths.extend(registry_environment_paths());
    }
    #[cfg(not(windows))]
    {
        paths.extend(build_unix_extra_search_paths());
    }

    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        if !codex_home.trim().is_empty() {
            push_unique_path(&mut paths, PathBuf::from(codex_home.trim()).join("bin"));
        }
    }

    for prefix_key in ["NPM_CONFIG_PREFIX", "npm_config_prefix"] {
        if let Some(env_prefix) = std::env::var_os(prefix_key)
            .and_then(|value| value.into_string().ok())
            .and_then(|value| resolve_npm_global_bin_dir_from_prefix(&value))
        {
            push_unique_path(&mut paths, env_prefix);
        }
    }

    let seed_paths = build_seed_search_paths(None, &paths);
    if let Some(npm_global_bin) = discover_npm_global_bin_dir(&seed_paths) {
        push_unique_path(&mut paths, npm_global_bin);
    }

    paths
}

pub fn clear_search_paths_cache() {
    if let Ok(mut guard) = EXTRA_SEARCH_PATHS_CACHE.lock() {
        *guard = None;
    }
}

fn cached_extra_search_paths() -> Vec<PathBuf> {
    if let Ok(guard) = EXTRA_SEARCH_PATHS_CACHE.try_lock() {
        if let Some((paths, cached_at)) = guard.as_ref() {
            if cached_at.elapsed() <= RESOLUTION_CACHE_TTL {
                return paths.clone();
            }
        }
    }
    let paths = get_extra_search_paths();
    if let Ok(mut guard) = EXTRA_SEARCH_PATHS_CACHE.lock() {
        *guard = Some((paths.clone(), Instant::now()));
    }
    paths
}

fn build_seed_search_paths(custom_bin: Option<&str>, extra_paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut all_paths: Vec<PathBuf> = Vec::new();

    if let Some(bin_path) = custom_bin.filter(|v| !v.trim().is_empty()) {
        if let Some(parent) = Path::new(bin_path)
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            push_unique_path(&mut all_paths, parent.to_path_buf());
        }
    }
    if let Ok(system_path) = std::env::var("PATH") {
        for p in std::env::split_paths(&system_path) {
            push_unique_path(&mut all_paths, p);
        }
    }
    for extra in extra_paths {
        if extra.is_dir() {
            push_unique_path(&mut all_paths, extra.clone());
        }
    }
    all_paths
}

fn build_search_paths(custom_bin: Option<&str>) -> std::ffi::OsString {
    let all_paths = build_seed_search_paths(custom_bin, &cached_extra_search_paths());
    std::env::join_paths(all_paths).unwrap_or_default()
}

/// PATH for child processes that may run shebang shims (`#!/usr/bin/env …`).
/// Same dirs [`find_cli_binary`] searches: process PATH + well-known install
/// locations. Plugin exec must set this on the child — resolving an absolute
/// shim path is not enough for `/usr/bin/env` to find the interpreter.
pub(crate) fn cli_search_path() -> std::ffi::OsString {
    #[cfg(feature = "test-harness")]
    if let Some(path) = crate::test_harness::cli_search_path() {
        return path;
    }
    build_search_paths(None)
}
/// [`cli_search_path`] merged after a caller-supplied PATH: caller entries
/// keep priority (its intent wins on conflicts), the CLI search dirs are
/// appended so shebang shims still find their interpreter. Order-preserving,
/// deduped.
pub(crate) fn merge_cli_search_path(base: Option<&std::ffi::OsStr>) -> std::ffi::OsString {
    #[cfg(feature = "test-harness")]
    if let Some(path) = crate::test_harness::cli_search_path() {
        return path;
    }
    let mut all_paths: Vec<PathBuf> = Vec::new();
    if let Some(base) = base {
        for p in std::env::split_paths(base) {
            push_unique_path(&mut all_paths, p);
        }
    }
    for p in std::env::split_paths(&cli_search_path()) {
        push_unique_path(&mut all_paths, p);
    }
    std::env::join_paths(&all_paths).unwrap_or_default()
}

// ── shim upgrade + batch wrapper ────────────────────────────────────────────

/// Prefer an executable variant (`.cmd`/`.exe`/…) over a same-named
/// extensionless POSIX shim in the same directory.
#[cfg(any(windows, test))]
fn prefer_windows_executable_variant(path: PathBuf) -> PathBuf {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());
    if matches!(
        ext.as_deref(),
        Some("cmd") | Some("exe") | Some("bat") | Some("com") | Some("ps1")
    ) {
        return path;
    }
    let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
        return path;
    };
    let Some(parent) = path.parent() else {
        return path;
    };
    for preferred_ext in ["cmd", "exe", "bat", "com", "ps1"] {
        let candidate = parent.join(format!("{file_name}.{preferred_ext}"));
        if candidate.exists() {
            return candidate;
        }
    }
    path
}

fn upgrade_executable_variant(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        prefer_windows_executable_variant(path)
    }
    #[cfg(not(windows))]
    {
        path
    }
}

/// The (program, leading args) a batch wrapper needs, or None for binaries
/// CreateProcess can launch directly. Test-gated so the mapping is exercised
/// on every platform.
#[cfg(any(windows, test))]
fn windows_wrapper(bin: &str) -> Option<(&'static str, Vec<String>)> {
    let trimmed = bin.trim();
    let lower = trimmed.to_ascii_lowercase();
    if lower.ends_with(".cmd") || lower.ends_with(".bat") {
        Some(("cmd", vec!["/c".to_string(), trimmed.to_string()]))
    } else if lower.ends_with(".ps1") {
        Some((
            "powershell",
            vec![
                "-NoProfile".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-File".to_string(),
                trimmed.to_string(),
            ],
        ))
    } else {
        None
    }
}

/// A spawnable command for `bin`. On Windows, `.cmd`/`.bat` wrappers run via
/// `cmd /c` and `.ps1` via `powershell -File`; everything else (and all of
/// Unix) spawns directly. Args are appended by the caller afterwards.
pub(crate) fn command_for_binary(bin: &str) -> Command {
    #[cfg(feature = "test-harness")]
    let fixture_binary = crate::test_harness::launchable_binary(bin).map(strip_verbatim);
    #[cfg(feature = "test-harness")]
    let bin = fixture_binary
        .as_ref()
        .and_then(|path| path.to_str())
        .unwrap_or(bin);
    #[cfg(windows)]
    if let Some((program, leading)) = windows_wrapper(bin) {
        #[cfg(feature = "test-harness")]
        let fixture_wrapper = crate::test_harness::wrapper_program(program).map(strip_verbatim);
        #[cfg(feature = "test-harness")]
        let program = fixture_wrapper
            .as_ref()
            .and_then(|path| path.to_str())
            .unwrap_or(program);
        let mut cmd = Command::new(program);
        cmd.args(leading);
        #[cfg(feature = "test-harness")]
        crate::test_harness::configure_command(&mut cmd);
        crate::development_profile::configure_command(&mut cmd);
        cmd.env_remove(super::NATIVE_COMPLETION_OWNER);
        return cmd;
    }
    #[allow(unused_mut)]
    let mut command = Command::new(bin);
    #[cfg(feature = "test-harness")]
    crate::test_harness::configure_command(&mut command);
    crate::development_profile::configure_command(&mut command);
    command.env_remove(super::NATIVE_COMPLETION_OWNER);
    command
}

// ── public resolution entry points ──────────────────────────────────────────

/// Strip the `\\?\` verbatim prefix Windows `canonicalize` produces (the
/// settings validator canonicalizes bin overrides) — cmd.exe cannot parse
/// verbatim paths, so a wrapped spawn would fail on them. UNC shares keep
/// their prefix (stripping would change the path's meaning).
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let s = path.to_string_lossy();
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        if !stripped.starts_with(r"UNC\") {
            return PathBuf::from(stripped);
        }
    }
    path
}

/// Find a CLI binary using the `which` crate over PATH + the well-known
/// install dirs. On Windows the known dirs are checked for `<name>.<ext>`
/// directly first (more reliable than PATH/PATHEXT), and any extensionless
/// shim result is upgraded to its executable variant.
pub(crate) fn find_cli_binary(name: &str, custom_bin: Option<&str>) -> Option<PathBuf> {
    #[cfg(feature = "test-harness")]
    if let Some(binary) = crate::test_harness::find_cli_binary(name, custom_bin) {
        return binary.map(strip_verbatim);
    }
    if let Some(bin) = custom_bin.filter(|v| !v.trim().is_empty()) {
        let bin_path = Path::new(bin.trim());
        if bin_path.exists() {
            return Some(strip_verbatim(upgrade_executable_variant(
                bin_path.to_path_buf(),
            )));
        }
    }

    #[cfg(windows)]
    {
        for search_path in cached_extra_search_paths() {
            for ext in ["cmd", "exe", "bat", "com", "ps1"] {
                let candidate = search_path.join(format!("{name}.{ext}"));
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
    }

    let search_paths = build_search_paths(custom_bin);
    if let Ok(cwd) = std::env::current_dir() {
        if let Ok(found) = which::which_in(name, Some(&search_paths), &cwd) {
            return Some(upgrade_executable_variant(found));
        }
    }

    which::which(name).ok().map(upgrade_executable_variant)
}

/// Resolve a CLI name or path to something CreateProcess can actually launch:
/// existing paths get the shim upgrade, bare names go through
/// [`find_cli_binary`], and missing path-like inputs pass through untouched
/// (the spawn error names the path the user configured).
pub(crate) fn resolve_launchable_cli_binary(name_or_path: &str) -> String {
    #[cfg(feature = "test-harness")]
    if let Some(binary) = crate::test_harness::launchable_binary(name_or_path) {
        return strip_verbatim(binary).to_string_lossy().into_owned();
    }
    let trimmed = name_or_path.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let path = Path::new(trimmed);
    if path.exists() {
        return strip_verbatim(upgrade_executable_variant(path.to_path_buf()))
            .to_string_lossy()
            .into_owned();
    }
    let looks_like_path = path.is_absolute() || trimmed.contains('/') || trimmed.contains('\\');
    if looks_like_path {
        return trimmed.to_string();
    }
    find_cli_binary(trimmed, None)
        .map(|found| found.to_string_lossy().into_owned())
        .unwrap_or_else(|| trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_cli_command_clears_inherited_spellcast_completion_ownership() {
        for binary in ["fixture.exe", "fixture.cmd", "fixture.ps1"] {
            let command = command_for_binary(binary);
            let marker = command.as_std().get_envs()
                .find(|(key, _)| *key == crate::engine::NATIVE_COMPLETION_OWNER);
            assert_eq!(marker, Some((std::ffi::OsStr::new(crate::engine::NATIVE_COMPLETION_OWNER), None)));
        }
    }

    #[cfg(unix)]
    fn fake_npm(script: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("ccgui npm probe {}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let binary = root.join("npm");
        std::fs::write(&binary, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        root
    }

    #[cfg(unix)]
    #[test]
    fn npm_probe_times_out_and_reaps_child() {
        let root = fake_npm(
            "echo $$ > \"$0.pid\"; /bin/sleep 4 & echo $! > \"$0.child\"; wait; printf /late",
        );
        let started = Instant::now();
        let result = discover_npm_global_bin_dir(&[root.clone(), PathBuf::from("/bin")]);
        let elapsed = started.elapsed();
        let pid: i32 = std::fs::read_to_string(root.join("npm.pid"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let descendant: u32 = std::fs::read_to_string(root.join("npm.child"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let mut status = 0;
        let waited = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        let wait_error = std::io::Error::last_os_error().raw_os_error();
        std::fs::remove_dir_all(root).unwrap();
        assert!(
            result.is_none(),
            "timed-out npm must not supply a prefix: {result:?}"
        );
        assert!(elapsed < Duration::from_secs(3), "probe took {elapsed:?}");
        assert_eq!(waited, -1);
        assert_eq!(wait_error, Some(libc::ECHILD));
        let mut system = sysinfo::System::new();
        let descendant = sysinfo::Pid::from_u32(descendant);
        system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[descendant]), true);
        assert!(
            system.process(descendant).map_or(true, |process| {
                process.status() == sysinfo::ProcessStatus::Zombie
            }),
            "timed-out npm left a running descendant"
        );
    }

    #[cfg(unix)]
    #[test]
    fn npm_probe_does_not_wait_for_descendant_stdout() {
        let root = fake_npm("/bin/sleep 4 &\nprintf '/prefix with spaces\\n'");
        let started = Instant::now();
        let result = discover_npm_global_bin_dir(&[root.clone(), PathBuf::from("/bin")]);
        let elapsed = started.elapsed();
        std::fs::remove_dir_all(root).unwrap();
        assert_eq!(result, Some(PathBuf::from("/prefix with spaces/bin")));
        assert!(
            elapsed < Duration::from_secs(1),
            "stdout outlived npm: {elapsed:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn npm_probe_rejects_failed_command() {
        let root = fake_npm("printf /invalid; exit 1");
        let result = discover_npm_global_bin_dir(&[root.clone(), PathBuf::from("/bin")]);
        std::fs::remove_dir_all(root).unwrap();
        assert!(result.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn cli_search_path_covers_well_known_unix_bins() {
        let path = cli_search_path();
        let joined = path.to_string_lossy();
        assert!(
            joined.contains("/usr/local/bin")
                || joined.contains("/opt/homebrew/bin")
                || joined.contains(".local/bin"),
            "cli_search_path missing well-known dirs: {joined}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn merge_cli_search_path_keeps_caller_dirs_first_and_dedupes() {
        let merged = merge_cli_search_path(Some(std::ffi::OsStr::new(
            "/opt/plugin/bin:/opt/plugin/bin",
        )));
        let dirs: Vec<PathBuf> = std::env::split_paths(&merged).collect();
        assert_eq!(
            dirs.first(),
            Some(&PathBuf::from("/opt/plugin/bin")),
            "caller PATH must keep priority: {dirs:?}"
        );
        assert_eq!(
            dirs.iter().filter(|d| d.as_path() == Path::new("/opt/plugin/bin")).count(),
            1,
            "caller dir must be deduped: {dirs:?}"
        );
        // The CLI search dirs still follow, so shebang shims find node.
        let joined = merged.to_string_lossy();
        assert!(
            joined.contains("/usr/local/bin")
                || joined.contains("/opt/homebrew/bin")
                || joined.contains(".local/bin"),
            "merge dropped well-known dirs: {joined}"
        );
    }

    /// Regression: absolute shebang shim + launchd-like PATH → `env: node: No
    /// such file`. Injecting the search PATH (as plugin_exec does) fixes it.
    #[cfg(unix)]
    #[test]
    fn cli_search_path_lets_env_shebang_find_interpreter() {
        use std::os::unix::fs::PermissionsExt;
        use std::process::Command;

        let root = std::env::temp_dir().join(format!("ccgui-shebang-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let node = root.join("node");
        std::fs::write(&node, "#!/bin/sh\nprintf ok\n").unwrap();
        std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
        let shim = root.join("tool");
        std::fs::write(&shim, "#!/usr/bin/env node\n").unwrap();
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();

        let bare = Command::new(&shim)
            .env("PATH", "/usr/bin:/bin")
            .output()
            .expect("spawn bare");
        assert!(
            !bare.status.success(),
            "launchd-like PATH must fail shebang; stdout={:?} stderr={:?}",
            String::from_utf8_lossy(&bare.stdout),
            String::from_utf8_lossy(&bare.stderr)
        );

        let mut dirs = vec![root.clone()];
        for part in std::env::split_paths(&cli_search_path()) {
            push_unique_path(&mut dirs, part);
        }
        let enriched = std::env::join_paths(&dirs).unwrap();
        let fixed = Command::new(&shim)
            .env("PATH", &enriched)
            .output()
            .expect("spawn enriched");
        let _ = std::fs::remove_dir_all(&root);
        assert!(
            fixed.status.success(),
            "enriched PATH should run shebang; stderr={}",
            String::from_utf8_lossy(&fixed.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&fixed.stdout), "ok");
    }

    #[cfg(unix)]
    #[test]
    fn npm_probe_stops_unlimited_output_before_timeout() {
        let root = fake_npm("while :; do printf '%1024s' x; done");
        let started = Instant::now();
        let result = discover_npm_global_bin_dir(&[root.clone(), PathBuf::from("/bin")]);
        let elapsed = started.elapsed();
        std::fs::remove_dir_all(root).unwrap();
        assert!(result.is_none());
        assert!(
            elapsed < Duration::from_secs(1),
            "output budget took {elapsed:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn npm_probe_reap_is_bounded_for_running_child() {
        let mut child = {
            let runtime = tauri::async_runtime::handle();
            let _entered = runtime.inner().enter();
            Command::new("/bin/sleep")
                .arg("4")
                .kill_on_drop(true)
                .spawn()
                .unwrap()
        };
        let started = Instant::now();
        let reaped = reap_npm_probe(&mut child, Duration::from_millis(20));
        let elapsed = started.elapsed();
        child.start_kill().unwrap();
        assert!(reap_npm_probe(&mut child, NPM_REAP_TIMEOUT));
        assert!(!reaped);
        assert!(elapsed < Duration::from_secs(1), "reap took {elapsed:?}");
    }

    #[cfg(windows)]
    #[test]
    fn npm_probe_windows_cmd_supports_spaces_and_timeout() {
        let root = std::env::temp_dir().join(format!("ccgui npm probe {}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let binary = root.join("npm.cmd");
        let mut paths = vec![root.clone()];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        std::fs::write(&binary, "@echo off\r\necho C:\\prefix with spaces\r\n").unwrap();
        let prefix = discover_npm_global_bin_dir(&paths);
        std::fs::write(
            &binary,
            "@echo off\r\nping -n 8 127.0.0.1 > nul\r\necho C:\\late\r\n",
        )
        .unwrap();
        let started = Instant::now();
        let timeout = discover_npm_global_bin_dir(&paths);
        let elapsed = started.elapsed();
        std::fs::write(
            &binary,
            "@echo off\r\n:output\r\necho repeated-prefix-output\r\ngoto output\r\n",
        )
        .unwrap();
        let output_started = Instant::now();
        let oversized = discover_npm_global_bin_dir(&paths);
        let output_elapsed = output_started.elapsed();
        std::fs::remove_dir_all(root).unwrap();
        assert_eq!(prefix, Some(PathBuf::from(r"C:\prefix with spaces")));
        assert!(timeout.is_none());
        assert!(elapsed < Duration::from_secs(6), "probe took {elapsed:?}");
        assert!(oversized.is_none());
        assert!(
            output_elapsed < NPM_PROBE_TIMEOUT,
            "output budget took {output_elapsed:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn npm_probe_windows_sweeps_descendant_after_parent_exit() {
        let root = std::env::temp_dir().join(format!("ccgui npm orphan {}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("child.cmd"),
            "@echo off\r\nping -n 5 127.0.0.1 > nul\r\necho leaked > \"%~dp0leaked\"\r\n",
        )
        .unwrap();
        std::fs::write(
            root.join("npm.cmd"),
            "@echo off\r\nstart \"\" /b cmd /d /c call \"%~dp0child.cmd\"\r\nping -n 2 127.0.0.1 > nul\r\necho C:\\prefix\r\n",
        )
        .unwrap();
        let mut paths = vec![root.clone()];
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        let prefix = discover_npm_global_bin_dir(&paths);
        std::thread::sleep(Duration::from_secs(5));
        let leaked = root.join("leaked").exists();
        std::fs::remove_dir_all(root).unwrap();
        assert_eq!(prefix, Some(PathBuf::from(r"C:\prefix")));
        assert!(!leaked, "descendant survived the npm wrapper");
    }

    #[test]
    fn npm_prefix_resolution_uses_bin_on_unix() {
        #[cfg(not(windows))]
        {
            let resolved =
                resolve_npm_global_bin_dir_from_prefix("/Users/demo/.npm-global").unwrap();
            assert_eq!(resolved, PathBuf::from("/Users/demo/.npm-global/bin"));
        }
    }

    #[test]
    fn npm_prefix_resolution_ignores_empty_values() {
        assert!(resolve_npm_global_bin_dir_from_prefix("").is_none());
        assert!(resolve_npm_global_bin_dir_from_prefix("undefined").is_none());
        assert!(resolve_npm_global_bin_dir_from_prefix("null").is_none());
    }

    #[test]
    fn prefer_windows_executable_variant_prefers_cmd_over_posix_shim() {
        let root = std::env::temp_dir().join(format!("ccgui-posix-shim-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("create temp dir");
        let posix_shim = root.join("dsh");
        let cmd_path = root.join("dsh.cmd");
        std::fs::write(&posix_shim, "#!/bin/sh\n").expect("write shim");
        std::fs::write(&cmd_path, "@echo off\n").expect("write cmd");

        assert_eq!(
            prefer_windows_executable_variant(posix_shim.clone()),
            cmd_path
        );
        // Already-executable variants and missing dirs pass through.
        assert_eq!(
            prefer_windows_executable_variant(cmd_path.clone()),
            cmd_path
        );
        let missing = PathBuf::from(r"C:\definitely\missing\dsh");
        assert_eq!(prefer_windows_executable_variant(missing.clone()), missing);

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn windows_wrapper_maps_batch_and_ps1() {
        let (program, leading) = windows_wrapper(r"C:\npm\claude.cmd").unwrap();
        assert_eq!(program, "cmd");
        assert_eq!(leading, vec!["/c", r"C:\npm\claude.cmd"]);

        let (program, leading) = windows_wrapper(r"C:\npm\claude.BAT").unwrap();
        assert_eq!(program, "cmd");
        assert_eq!(leading[0], "/c");

        let (program, leading) = windows_wrapper(r"C:\npm\claude.ps1").unwrap();
        assert_eq!(program, "powershell");
        assert_eq!(
            leading,
            vec![
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                r"C:\npm\claude.ps1"
            ]
        );

        assert!(windows_wrapper(r"C:\npm\claude.exe").is_none());
        assert!(windows_wrapper("/usr/local/bin/claude").is_none());
    }

    #[test]
    fn windows_extra_search_paths_cover_npm_global_dir() {
        let user_profile = Path::new(r"C:\Users\demo");
        let appdata = Path::new(r"C:\Users\demo\AppData\Roaming");
        let local_app_data = Path::new(r"C:\Users\demo\AppData\Local");
        let paths = build_windows_extra_search_paths(
            Some(appdata),
            Some(user_profile),
            Some(local_app_data),
            None,
            None,
        );
        let normalized: Vec<String> = paths
            .iter()
            .map(|path| path.to_string_lossy().replace('/', "\\"))
            .collect();
        for expected in [
            r"C:\Users\demo\AppData\Roaming\npm",
            r"C:\Users\demo\.local\bin",
            r"C:\Users\demo\scoop\shims",
        ] {
            assert!(
                normalized.iter().any(|p| p == expected),
                "missing {expected} in {normalized:?}"
            );
        }
    }

    #[test]
    fn strip_verbatim_drops_local_prefix_and_keeps_unc() {
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\C:\npm\claude.cmd")),
            PathBuf::from(r"C:\npm\claude.cmd")
        );
        let unc = PathBuf::from(r"\\?\UNC\server\share\claude.cmd");
        assert_eq!(strip_verbatim(unc.clone()), unc);
        let plain = PathBuf::from(r"C:\npm\claude.cmd");
        assert_eq!(strip_verbatim(plain.clone()), plain);
    }

    #[test]
    fn windows_extra_search_paths_cover_openai_codex_installer() {
        // The Programs dir must exist for the installer path to be pushed;
        // emulate %LOCALAPPDATA% with a temp dir.
        let temp = std::env::temp_dir().join(format!("ccgui-openai-codex-{}", std::process::id()));
        let programs = temp.join("Programs");
        std::fs::create_dir_all(&programs).expect("create Programs dir");

        let paths = build_windows_extra_search_paths(None, None, Some(&temp), None, None);
        let expected = programs.join("OpenAI\\Codex\\bin");
        assert!(
            paths.iter().any(|p| p == &expected),
            "missing {} in {paths:?}",
            expected.display()
        );

        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn windows_extra_search_paths_cover_codemoss_bundled_claude() {
        let temp = std::env::temp_dir().join(format!("ccgui-codemoss-sdk-{}", std::process::id()));
        // Build the expectation the same way the resolver does: the
        // read_dir entry joins with a platform separator, so the final
        // segment is its own component even though the parents carry
        // Windows-style literals.
        let scope_dir =
            temp.join(".codemoss\\dependencies\\claude-sdk\\node_modules\\@anthropic-ai");
        let sdk_dir = scope_dir.join("claude-agent-sdk-win32-x64");
        std::fs::create_dir_all(&sdk_dir).expect("create sdk dir");
        // An unrelated package under the same scope must not be picked up.
        std::fs::create_dir_all(scope_dir.join("sdk")).expect("create unrelated dir");

        let paths = build_windows_extra_search_paths(None, Some(&temp), None, None, None);
        assert!(
            paths.iter().any(|p| p == &sdk_dir),
            "missing {} in {paths:?}",
            sdk_dir.display()
        );

        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn expand_windows_env_vars_resolves_known_and_keeps_unknown() {
        std::env::set_var("CCGUI_TEST_EXPAND_ROOT", r"C:\Users\demo");
        let expanded = expand_windows_env_vars(
            r"%CCGUI_TEST_EXPAND_ROOT%\bin;C:\tools;%CCGUI_NO_SUCH_VAR%\x;100%",
        );
        assert_eq!(
            expanded,
            r"C:\Users\demo\bin;C:\tools;%CCGUI_NO_SUCH_VAR%\x;100%"
        );
        std::env::remove_var("CCGUI_TEST_EXPAND_ROOT");
    }

    #[test]
    fn parse_registry_path_value_splits_and_expands() {
        std::env::set_var("CCGUI_TEST_PATH_ROOT", r"C:\Users\demo");
        let paths = parse_registry_path_value(
            r"C:\Windows;;%CCGUI_TEST_PATH_ROOT%\AppData\Local\Programs\OpenAI\Codex\bin; ",
        );
        assert_eq!(
            paths,
            vec![
                PathBuf::from(r"C:\Windows"),
                PathBuf::from(r"C:\Users\demo\AppData\Local\Programs\OpenAI\Codex\bin"),
            ]
        );
        std::env::remove_var("CCGUI_TEST_PATH_ROOT");
    }

    #[test]
    fn resolve_launchable_cli_binary_passthrough_rules() {
        assert_eq!(resolve_launchable_cli_binary(""), "");
        // Missing absolute paths stay as-is so the spawn error names them.
        let missing = if cfg!(windows) {
            r"C:\definitely\missing\claude.cmd"
        } else {
            "/definitely/missing/claude"
        };
        assert_eq!(resolve_launchable_cli_binary(missing), missing);
    }
}
