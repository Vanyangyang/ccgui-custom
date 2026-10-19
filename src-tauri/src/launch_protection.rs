//! 【启动保护】把桌面「CC GUI（代理保护）」启动脚本的门闩收进已安装的正式程序。
//!
//! 覆盖固定安装路径及正式 profile 的 runtime-updates/releases/<hash>/ccgui-next.exe。
//! 开发 profile 和其它路径的构建直接跳过，避免 `pnpm dev` 被本机防火墙规则误拒。
//! 图形界面在创建窗口、拉起 worker 和联网之前检查代理、Claude 路径、防火墙和 WebView2；
//! 不通过就弹窗退出。同 exe 的 MCP、worker 等非界面模式只继承严格代理环境，不弹这道窗。
//! 防火墙规则的首次安装仍要管理员权限，这里只检查，不静默写入。

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use crate::startup::Mode;

const APPROVED_PROXY: &str = crate::proxy::APPROVED_LAUNCH_PROXY;
const OUTPUT_LIMIT: usize = 64 * 1024;
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
const FAILURE_CODES: [&str; 10] = [
    "proxy_not_approved",
    "claude_bin_not_approved",
    "settings_unreadable",
    "protection_script_missing",
    "proxy_preflight_failed",
    "claude_firewall_not_ready",
    "gui_firewall_not_ready",
    "webview_proxy_not_ready",
    "protection_timeout",
    "protection_check_failed",
];

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum LaunchGate {
    Skip,
    EnvironmentOnly,
    Enforce,
}

#[derive(Debug, PartialEq, Eq)]
struct Failure {
    code: &'static str,
    extra: String,
}

impl Failure {
    fn code(code: &'static str) -> Self {
        Self {
            code,
            extra: String::new(),
        }
    }

    fn with_extra(code: &'static str, extra: impl Into<String>) -> Self {
        Self {
            code,
            extra: extra.into(),
        }
    }
}

pub(crate) fn arm(mode: &Mode) {
    #[cfg(windows)]
    windows_arm(mode);
    #[cfg(not(windows))]
    {
        let _ = mode;
    }
}

/// Resolve whether launch proxy & firewall protection is enabled:
/// - Explicit `Some(true)` / `Some(false)` in `settings.json` always wins.
/// - `None` (unset in `settings.json`) automatically checks whether this machine
///   already has the reviewed proxy configuration AND local protection scripts
///   installed: existing protected machines inherit `true` (so self-update and
///   launch protection stay active without interruption), while fresh/general
///   user installs default to `false` (no forced protection).
pub(crate) fn resolve_launch_proxy_protection_for_profile(
    settings: &crate::settings::AppSettings,
    profile: Option<&Path>,
) -> bool {
    if let Some(explicit) = settings.launch_proxy_protection_enabled {
        return explicit;
    }
    let Some(profile) = profile else {
        return false;
    };
    let claude = profile.join(".local").join("bin").join("claude.exe");
    if reviewed_configuration(
        settings.system_proxy_enabled,
        settings.system_proxy_url.as_deref(),
        settings.bin_override("claude").map(Path::new),
        &claude,
    )
    .is_err()
    {
        return false;
    }
    let preflight = profile
        .join("agent-assets")
        .join("scripts")
        .join("ccgui-network-preflight.mjs");
    let claude_firewall = profile
        .join("plugins")
        .join("claude-supervisor")
        .join("scripts")
        .join("firewall.ps1");
    let gui_firewall = profile
        .join("agent-assets")
        .join("scripts")
        .join("ccgui-firewall.ps1");
    let webview = profile
        .join("agent-assets")
        .join("scripts")
        .join("ccgui-webview-proxy.ps1");
    [preflight, claude_firewall, gui_firewall, webview, claude]
        .iter()
        .all(|path| path.is_file())
}

pub(crate) fn resolve_launch_proxy_protection_enabled(
    settings: &crate::settings::AppSettings,
) -> bool {
    let profile = std::env::var_os("USERPROFILE")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    resolve_launch_proxy_protection_for_profile(settings, profile.as_deref())
}

pub(crate) fn is_launch_proxy_protection_enabled() -> bool {
    crate::settings::read_settings()
        .map(|s| resolve_launch_proxy_protection_enabled(&s))
        .unwrap_or(false)
}

#[cfg(windows)]
fn windows_arm(mode: &Mode) {
    if crate::paths::is_dev_profile() || !is_launch_proxy_protection_enabled() {
        return;
    }
    let Ok(current) = std::env::current_exe() else {
        return;
    };
    let Some(installed) = reviewed_gui_executable() else {
        return;
    };
    let gate = launch_gate(
        mode,
        false,
        &identity(&current),
        &identity(&installed),
        &identity(&crate::paths::app_home().join("runtime-updates/releases")),
    );
    if gate == LaunchGate::Skip {
        return;
    }
    // 【启动保护】先于预检写入代理环境，预检会核对本进程的 HTTP(S)_PROXY / NO_PROXY。
    crate::proxy::begin_strict_launch_proxy();
    if gate == LaunchGate::Enforce {
        if let Err(failure) = verify(&current) {
            show_blocked(&failure);
            std::process::exit(1);
        }
    }
}

pub(crate) fn launch_gate(
    mode: &Mode,
    dev_profile: bool,
    current: &Path,
    installed: &Path,
    releases: &Path,
) -> LaunchGate {
    if dev_profile || !(same_path(current, installed) || is_release_executable(current, releases)) {
        return LaunchGate::Skip;
    }
    if *mode == Mode::Gui {
        LaunchGate::Enforce
    } else {
        LaunchGate::EnvironmentOnly
    }
}

// Recognize every retained release, including candidates, rollback versions and
// old workers. The active pointer alone cannot describe those valid lifetimes.
fn is_release_executable(executable: &Path, releases: &Path) -> bool {
    let executable = normalized_path(executable);
    let prefix = format!("{}\\", normalized_path(releases).trim_end_matches('\\'));
    let Some(relative) = executable.strip_prefix(&prefix) else {
        return false;
    };
    let Some((hash, name)) = relative.split_once('\\') else {
        return false;
    };
    hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_hexdigit()) && name == "ccgui-next.exe"
}

static RECENT_CANDIDATE_VERIFY: std::sync::LazyLock<
    std::sync::Mutex<Option<(String, Option<std::time::SystemTime>, std::time::Instant)>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(None));

/// The staged candidate must have its own application firewall rule.
/// When the candidate fails only `gui_firewall_not_ready`, attempt an elevated
/// install of its exact release rule once before re-verifying.
pub(crate) fn verify_update_candidate(executable: &Path) -> Result<(), String> {
    #[cfg(windows)]
    if update_protection_required() {
        let key = normalized_path(executable);
        let mtime = std::fs::metadata(executable).and_then(|m| m.modified()).ok();
        if let Some((cached_key, cached_mtime, at)) = RECENT_CANDIDATE_VERIFY
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
        {
            if cached_key == key && cached_mtime == mtime && at.elapsed() < Duration::from_secs(15) {
                return Ok(());
            }
        }
        let result = match verify(executable) {
            Err(failure) if failure.code == "gui_firewall_not_ready" => {
                let _ = install_candidate_gui_firewall(executable);
                verify(executable)
            }
            other => other,
        };
        result.map_err(|failure| {
            let language = crate::settings::read_settings()
                .map(|s| s.language)
                .unwrap_or_else(|_| "zh".into());
            format!(
                "{}\n{}",
                protection_text(&language, &failure).1,
                executable.display()
            )
        })?;
        *RECENT_CANDIDATE_VERIFY.lock().unwrap_or_else(|p| p.into_inner()) =
            Some((key, mtime, std::time::Instant::now()));
    }
    let _ = executable;
    Ok(())
}

#[cfg(windows)]
fn install_candidate_gui_firewall(executable: &Path) -> Result<(), ()> {
    let profile = std::env::var_os("USERPROFILE")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or(())?;
    let gui_firewall = profile
        .join("agent-assets")
        .join("scripts")
        .join("ccgui-firewall.ps1");
    if !gui_firewall.is_file() || !executable.is_file() {
        return Err(());
    }
    let powershell = powershell_exe();
    let script_escaped = gui_firewall.to_string_lossy().replace('\'', "''");
    let exe_escaped = executable.to_string_lossy().replace('\'', "''");
    let command = format!(
        "$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @('-WindowStyle','Hidden','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','{script_escaped}','-Mode','Install','-GuiExe','{exe_escaped}'); if ($null -eq $p -or $p.ExitCode -ne 0) {{ exit 1 }}"
    );
    let mut child = std::process::Command::new(powershell);
    child
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &command])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    {
        use std::os::windows::process::CommandExt;
        child.creation_flags(0x0900_0000);
    }
    child.status().ok().filter(|s| s.success()).map(|_| ()).ok_or(())
}

pub(crate) fn update_protection_required() -> bool {
    #[cfg(windows)]
    if !crate::paths::is_dev_profile() && is_launch_proxy_protection_enabled() {
        if let (Ok(current), Some(installed)) = (std::env::current_exe(), reviewed_gui_executable())
        {
            return launch_gate(
                &Mode::Gui,
                false,
                &identity(&current),
                &identity(&installed),
                &identity(&crate::paths::app_home().join("runtime-updates/releases")),
            ) == LaunchGate::Enforce;
        }
    }
    false
}

pub(crate) fn reviewed_gui_executable() -> Option<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA")?;
    if local.is_empty() {
        return None;
    }
    Some(
        PathBuf::from(local)
            .join("Programs")
            .join("CCGUI")
            .join("ccgui-next.exe"),
    )
}

fn identity(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn same_path(left: &Path, right: &Path) -> bool {
    normalized_path(left) == normalized_path(right)
}

fn normalized_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    let text = text
        .strip_prefix(r"\\?\")
        .or_else(|| text.strip_prefix(r"//?/"))
        .unwrap_or(text.as_ref());
    text.replace('/', "\\").to_lowercase()
}

fn same_existing_path(left: &Path, right: &Path) -> bool {
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => same_path(&left, &right),
        _ => same_path(left, right),
    }
}

pub(crate) fn reviewed_configuration(
    enabled: bool,
    url: Option<&str>,
    claude_bin: Option<&Path>,
    expected_claude: &Path,
) -> Result<(), &'static str> {
    if !enabled || url.map(str::trim) != Some(APPROVED_PROXY) {
        return Err("proxy_not_approved");
    }
    let Some(claude_bin) = claude_bin else {
        return Err("claude_bin_not_approved");
    };
    if !same_existing_path(claude_bin, expected_claude) {
        return Err("claude_bin_not_approved");
    }
    Ok(())
}

#[cfg(windows)]
fn verify(executable: &Path) -> Result<(), Failure> {
    let settings =
        crate::settings::read_settings().map_err(|_| Failure::code("settings_unreadable"))?;
    let profile = std::env::var_os("USERPROFILE")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| Failure::code("protection_check_failed"))?;
    let claude = profile.join(".local").join("bin").join("claude.exe");
    reviewed_configuration(
        settings.system_proxy_enabled,
        settings.system_proxy_url.as_deref(),
        settings.bin_override("claude").map(Path::new),
        &claude,
    )
    .map_err(Failure::code)?;

    let node = PathBuf::from(r"C:\Program Files\nodejs\node.exe");
    let powershell = powershell_exe();
    let preflight = profile
        .join("agent-assets")
        .join("scripts")
        .join("ccgui-network-preflight.mjs");
    let claude_firewall = profile
        .join("plugins")
        .join("claude-supervisor")
        .join("scripts")
        .join("firewall.ps1");
    let gui_firewall = profile
        .join("agent-assets")
        .join("scripts")
        .join("ccgui-firewall.ps1");
    let webview = profile
        .join("agent-assets")
        .join("scripts")
        .join("ccgui-webview-proxy.ps1");
    for path in [
        &node,
        &powershell,
        &preflight,
        &claude_firewall,
        &gui_firewall,
        &webview,
        &claude,
    ] {
        if !path.is_file() {
            return Err(Failure::with_extra(
                "protection_script_missing",
                path.display().to_string(),
            ));
        }
    }

    let c1_args: Vec<OsString> = vec![preflight.into()];
    let c2_args: Vec<OsString> = vec![
        "-NoProfile".into(),
        "-NonInteractive".into(),
        "-ExecutionPolicy".into(),
        "Bypass".into(),
        "-File".into(),
        claude_firewall.into(),
        "-Mode".into(),
        "Check".into(),
        "-ClaudeExe".into(),
        claude.into(),
    ];
    let c3_args: Vec<OsString> = vec![
        "-NoProfile".into(),
        "-NonInteractive".into(),
        "-ExecutionPolicy".into(),
        "Bypass".into(),
        "-File".into(),
        gui_firewall.into(),
        "-Mode".into(),
        "Check".into(),
        "-GuiExe".into(),
        executable.as_os_str().to_owned(),
    ];
    let c4_args: Vec<OsString> = vec![
        "-NoProfile".into(),
        "-NonInteractive".into(),
        "-ExecutionPolicy".into(),
        "Bypass".into(),
        "-File".into(),
        webview.into(),
        "-Mode".into(),
        "Check".into(),
    ];
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| Failure::code("protection_check_failed"))?;
    let (r1, r2, r3, r4) = runtime.block_on(async {
        tokio::join!(
            ensure_ready_async(&node, &c1_args, "proxy_preflight_failed"),
            ensure_ready_async(&powershell, &c2_args, "claude_firewall_not_ready"),
            ensure_ready_async(&powershell, &c3_args, "gui_firewall_not_ready"),
            ensure_ready_async(&powershell, &c4_args, "webview_proxy_not_ready"),
        )
    });
    r1?;
    r2?;
    r3?;
    r4?;
    Ok(())
}

fn powershell_exe() -> PathBuf {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| OsString::from(r"C:\Windows"));
    PathBuf::from(root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
}

async fn ensure_ready_async(program: &Path, args: &[OsString], failure: &'static str) -> Result<(), Failure> {
    match run_ready_check_async(program, args, CHECK_TIMEOUT).await {
        Ok(()) => Ok(()),
        Err("protection_timeout") => Err(Failure::code("protection_timeout")),
        Err("protection_script_missing") => Err(Failure::with_extra(
            "protection_script_missing",
            program.display().to_string(),
        )),
        Err(_) => Err(Failure::code(failure)),
    }
}

fn run_ready_check_with_timeout(
    program: &Path,
    args: &[OsString],
    timeout: Duration,
) -> Result<(), &'static str> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| "protection_check_failed")?;
    runtime.block_on(run_ready_check_async(program, args, timeout))
}

async fn run_ready_check_async(
    program: &Path,
    args: &[OsString],
    timeout: Duration,
) -> Result<(), &'static str> {
    if !program.is_file() {
        return Err("protection_script_missing");
    }
    {
        use tokio::io::AsyncReadExt;
        let mut command = tokio::process::Command::new(program);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x0800_0000);
        let mut child = command.spawn().map_err(|_| "protection_check_failed")?;
        #[cfg(windows)]
        let job = crate::engine::job::assign_kill_on_close(&child);
        let output = child.stdout.take().ok_or("protection_check_failed")?;
        // One deadline includes EOF. A descendant retaining stdout cannot turn
        // the nominal 30-second limit into an unbounded reader-thread join.
        let result = tokio::time::timeout(timeout, async {
            let mut bytes = Vec::new();
            output
                .take(OUTPUT_LIMIT as u64 + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| "protection_check_failed")?;
            if bytes.len() > OUTPUT_LIMIT {
                return Err("protection_check_failed");
            }
            let status = child.wait().await.map_err(|_| "protection_check_failed")?;
            if status.success() && stdout_reports_ready(&bytes) {
                Ok(())
            } else {
                Err("protection_check_failed")
            }
        })
        .await
        .unwrap_or(Err("protection_timeout"));
        #[cfg(windows)]
        drop(job);
        if result.is_err() {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(1), child.wait()).await;
        }
        result
    }
}

fn stdout_reports_ready(output: &[u8]) -> bool {
    let text = decode_output(output);
    for line in text.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
            return value.get("ready").and_then(|ready| ready.as_bool()) == Some(true);
        }
    }
    false
}

fn decode_output(output: &[u8]) -> String {
    let utf16 = output.starts_with(&[0xFF, 0xFE])
        || (output.len() >= 4 && output[1] == 0 && output[3] == 0);
    if utf16 {
        let units = output
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        return String::from_utf16_lossy(&units)
            .trim_start_matches('\u{feff}')
            .to_string();
    }
    String::from_utf8_lossy(output)
        .trim_start_matches('\u{feff}')
        .to_string()
}

#[cfg(windows)]
fn show_blocked(failure: &Failure) {
    use windows::{
        core::PCWSTR,
        Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK},
    };
    let language = crate::settings::read_settings()
        .map(|settings| settings.language)
        .unwrap_or_else(|_| "zh".to_string());
    let (title, body) = protection_text(&language, failure);
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

fn protection_text(language: &str, failure: &Failure) -> (String, String) {
    let catalog: serde_json::Value =
        serde_json::from_str(include_str!("../../src/i18n/native-startup.json"))
            .expect("valid bundled startup translations");
    let language = if language.starts_with("en") {
        "en"
    } else {
        "zh"
    };
    let messages = &catalog[language];
    let detail = messages[failure.code]
        .as_str()
        .unwrap_or(failure.code)
        .to_string();
    let detail = if failure.extra.is_empty() {
        detail
    } else {
        format!("{detail}\n{}", failure.extra)
    };
    (
        messages["launchProtectionTitle"]
            .as_str()
            .expect("launch protection title")
            .to_string(),
        messages["launchProtectionBody"]
            .as_str()
            .expect("launch protection body")
            .replace("{{error}}", &detail),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn installed() -> PathBuf {
        PathBuf::from(r"C:\Users\example\AppData\Local\Programs\CCGUI\ccgui-next.exe")
    }

    fn releases() -> PathBuf {
        PathBuf::from(r"C:\Users\example\.ccgui-next\runtime-updates\releases")
    }

    #[test]
    fn installed_gui_is_enforced_and_other_launches_skip_or_only_inherit_env() {
        let installed = installed();
        assert_eq!(
            launch_gate(&Mode::Gui, false, &installed, &installed, &releases()),
            LaunchGate::Enforce
        );
        assert_eq!(
            launch_gate(
                &Mode::Gui,
                false,
                Path::new(r"\\?\C:\Users\example\AppData\Local\Programs\CCGUI\ccgui-next.exe"),
                &installed,
                &releases()
            ),
            LaunchGate::Enforce
        );
        assert_eq!(
            launch_gate(&Mode::Gui, true, &installed, &installed, &releases()),
            LaunchGate::Skip
        );
        assert_eq!(
            launch_gate(
                &Mode::Gui,
                false,
                Path::new(r"G:\Projects\ccgui-custom\src-tauri\target\debug\ccgui-next.exe"),
                &installed,
                &releases()
            ),
            LaunchGate::Skip
        );
        assert_eq!(
            launch_gate(
                &Mode::HostChatMcp,
                false,
                &installed,
                &installed,
                &releases()
            ),
            LaunchGate::EnvironmentOnly
        );
        assert_eq!(
            launch_gate(
                &Mode::TaskWorker,
                false,
                &installed,
                &installed,
                &releases()
            ),
            LaunchGate::EnvironmentOnly
        );
    }

    #[test]
    fn candidate_committed_and_retained_release_paths_share_the_gate() {
        let root = releases();
        for hash in ["a".repeat(64), "b".repeat(64), "c".repeat(64)] {
            let exe = root.join(hash).join("ccgui-next.exe");
            assert_eq!(
                launch_gate(&Mode::Gui, false, &exe, &installed(), &root),
                LaunchGate::Enforce
            );
            for mode in [Mode::TaskWorker, Mode::HostChatMcp, Mode::UpdateSupervisor] {
                assert_eq!(
                    launch_gate(&mode, false, &exe, &installed(), &root),
                    LaunchGate::EnvironmentOnly
                );
            }
            assert_eq!(
                launch_gate(&Mode::Gui, true, &exe, &installed(), &root),
                LaunchGate::Skip
            );
        }
        for relative in [
            "short/ccgui-next.exe".to_string(),
            format!("{}/nested/ccgui-next.exe", "a".repeat(64)),
            format!("{}/other.exe", "a".repeat(64)),
            format!("{}/ccgui-next.exe", "g".repeat(64)),
        ] {
            assert!(!is_release_executable(&root.join(relative), &root));
        }
        assert!(!is_release_executable(
            &PathBuf::from(format!(
                "{}-other/{}/ccgui-next.exe",
                root.display(),
                "a".repeat(64)
            )),
            &root
        ));
    }

    #[cfg(windows)]
    fn check_script(script: &str, timeout: Duration) -> Result<(), &'static str> {
        run_ready_check_with_timeout(
            &powershell_exe(),
            &[
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                script.into(),
            ],
            timeout,
        )
    }

    #[cfg(windows)]
    #[test]
    fn check_rejects_output_overflow_and_nonzero_exit() {
        assert_eq!(
            check_script(
                "[Console]::WriteLine('{\"ready\":true}'); [Console]::Write('x' * 70000); exit 0",
                Duration::from_secs(10)
            ),
            Err("protection_check_failed")
        );
        assert_eq!(
            check_script(
                "[Console]::WriteLine('{\"ready\":true}'); exit 1",
                Duration::from_secs(10)
            ),
            Err("protection_check_failed")
        );
        assert_eq!(
            check_script(
                "[Console]::WriteLine('{\"ready\":true}')",
                Duration::from_secs(10)
            ),
            Ok(())
        );
    }

    #[cfg(windows)]
    #[test]
    fn check_timeout_covers_descendant_held_stdout() {
        let started = std::time::Instant::now();
        // Process.Start inherits this redirected stdout, then the parent exits.
        // The child sleeps even though the immediate process is already done.
        let script = "$p = New-Object System.Diagnostics.ProcessStartInfo; $p.FileName = 'powershell.exe'; $p.Arguments = '-NoProfile -NonInteractive -Command Start-Sleep -Seconds 30'; $p.UseShellExecute = $false; $p.CreateNoWindow = $true; [void][System.Diagnostics.Process]::Start($p); [Console]::WriteLine('{\"ready\":true}')";
        assert_eq!(
            check_script(script, Duration::from_secs(2)),
            Err("protection_timeout")
        );
        assert!(started.elapsed() < Duration::from_secs(6));
    }

    #[test]
    fn reviewed_configuration_accepts_only_the_approved_proxy_and_claude_path() {
        let claude = PathBuf::from(r"C:\Users\example\.local\bin\claude.exe");
        assert!(reviewed_configuration(true, Some(APPROVED_PROXY), Some(&claude), &claude).is_ok());
        assert_eq!(
            reviewed_configuration(false, Some(APPROVED_PROXY), Some(&claude), &claude),
            Err("proxy_not_approved")
        );
        assert_eq!(
            reviewed_configuration(true, Some("http://127.0.0.1:7890"), Some(&claude), &claude),
            Err("proxy_not_approved")
        );
        assert_eq!(
            reviewed_configuration(true, Some(APPROVED_PROXY), None, &claude),
            Err("claude_bin_not_approved")
        );
        assert_eq!(
            reviewed_configuration(
                true,
                Some(APPROVED_PROXY),
                Some(Path::new(r"C:\Tools\claude.exe")),
                &claude
            ),
            Err("claude_bin_not_approved")
        );
    }

    #[test]
    fn ready_output_accepts_utf8_and_utf16_json_and_ignores_leading_noise() {
        assert!(stdout_reports_ready(
            br#"note{"ready":false}
{"ready":true,"proxy":"http://127.0.0.1:7897"}"#
        ));
        assert!(!stdout_reports_ready(br#"{"ready":false}"#));
        let mut utf16 = vec![0xFF, 0xFE];
        for unit in r#"{"ready":true}"#.encode_utf16() {
            utf16.extend_from_slice(&unit.to_le_bytes());
        }
        assert!(stdout_reports_ready(&utf16));
    }

    #[test]
    fn launch_proxy_protection_auto_detects_protected_machine_and_defaults_off_for_general_user() {
        let mut settings = crate::settings::AppSettings::default();
        assert_eq!(settings.launch_proxy_protection_enabled, None);
        // General user without claudeBin override / protection scripts defaults to false.
        assert!(!resolve_launch_proxy_protection_for_profile(&settings, None));

        // Create a temporary profile directory with the reviewed scripts + claude.exe
        let temp = std::env::temp_dir().join(format!(
            "ccgui-launch-prot-test-{}",
            uuid::Uuid::new_v4()
        ));
        let claude = temp.join(".local").join("bin").join("claude.exe");
        let preflight = temp
            .join("agent-assets")
            .join("scripts")
            .join("ccgui-network-preflight.mjs");
        let claude_fw = temp
            .join("plugins")
            .join("claude-supervisor")
            .join("scripts")
            .join("firewall.ps1");
        let gui_fw = temp
            .join("agent-assets")
            .join("scripts")
            .join("ccgui-firewall.ps1");
        let webview = temp
            .join("agent-assets")
            .join("scripts")
            .join("ccgui-webview-proxy.ps1");
        for file in [&claude, &preflight, &claude_fw, &gui_fw, &webview] {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, b"ok").unwrap();
        }

        // Still false when claudeBin is not configured to match reviewed path
        assert!(!resolve_launch_proxy_protection_for_profile(
            &settings,
            Some(&temp)
        ));

        // Existing protected machine (proxy = 7897, claudeBin = ~/.local/bin/claude.exe, scripts present)
        // automatically inherits true even when launchProxyProtectionEnabled is None!
        settings.bin_overrides.insert(
            "claudeBin".into(),
            serde_json::Value::String(claude.to_string_lossy().into_owned()),
        );
        assert!(resolve_launch_proxy_protection_for_profile(
            &settings,
            Some(&temp)
        ));

        // Explicit user toggle (Some(false) or Some(true)) always overrides auto-detection
        settings.launch_proxy_protection_enabled = Some(false);
        assert!(!resolve_launch_proxy_protection_for_profile(
            &settings,
            Some(&temp)
        ));
        settings.launch_proxy_protection_enabled = Some(true);
        assert!(resolve_launch_proxy_protection_for_profile(&settings, None));

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn protection_dialog_has_both_languages_for_every_failure() {
        for code in FAILURE_CODES {
            let failure = Failure::with_extra(code, r"C:\missing.ps1");
            let (zh_title, zh_body) = protection_text("zh", &failure);
            let (en_title, en_body) = protection_text("en-US", &failure);
            assert!(zh_title.contains("保护"));
            assert!(zh_body.contains("不会打开窗口"));
            assert!(zh_body.contains(r"C:\missing.ps1"));
            assert!(en_title.contains("protection"));
            assert!(en_body.contains("will not open a window"));
            assert!(!zh_body.contains("{{error}}"));
            assert!(!en_body.contains(code));
        }
    }
}
