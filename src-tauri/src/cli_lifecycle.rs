//! Managed-CLI lifecycle behind the CLI 管理 settings header: local version
//! probe (`<bin> --version`), npm registry latest probe, and one-click
//! install/update. Generalizes the retired dsh-only dsh_cli_version /
//! dsh_cli_update pair to every engine.
//!
//! Probes run on explicit request only (settings page open, refresh button)
//! — never on a timer: `npm view` is a network call and every probe spawns
//! processes, so polling would keep the machine awake for nothing.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::State;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::task::JoinHandle;
use tokio::time::timeout;

use crate::engine::{command_for_binary, resolve};
use crate::event_sink::{BroadcastEmit, EventSink, CLI_UPDATE_PROGRESS_EVENT};
use crate::AppState;

const CLI_VERSION_TIMEOUT: Duration = Duration::from_secs(10);
const NPM_VIEW_TIMEOUT: Duration = Duration::from_secs(15);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(420);
/// Bytes of installer output quoted back in a failure error.
const ERROR_TAIL_CAP: usize = 2048;
/// Chars per streamed output line; minified progress-bar lines would
/// otherwise flood the IPC channel in one event.
const PROGRESS_LINE_CAP: usize = 1000;
const UPDATE_LOG_CAP: usize = 200;
/// Per-stream capture cap for run_capture/run_streaming. Callers need the
/// first line (version probes) or a failure tail — both fit in a few KB,
/// and normal npm output stays well under this. Without a cap a chatty or
/// stuck installer buffered unboundedly for up to INSTALL_TIMEOUT.
const CAPTURE_CAP_BYTES: usize = 1024 * 1024;

/// npm-distributed engines → registry package. Grok / agy ship via their own
/// installer scripts (no npm distribution), so they get a local-version probe
/// only — no latest probe and no install/update action.
fn npm_package(engine: &str) -> Option<&'static str> {
    match engine {
        "claude" => Some("@anthropic-ai/claude-code"),
        "kimi" => Some("@moonshot-ai/kimi-code"),
        "codex" => Some("@openai/codex"),
        "pi" => Some("@earendil-works/pi-coding-agent"),
        "omp" => Some("@oh-my-pi/pi-coding-agent"),
        "dsh" => Some("@deepseek-ai/dsh"),
        "opencode" => Some("opencode-ai"),
        _ => None,
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CliVersionStatus {
    pub engine: String,
    pub installed: bool,
    pub local_version: Option<String>,
    pub latest_version: Option<String>,
    pub update_available: bool,
    /// How the install/update button acts: "npm" | "native"; null when the
    /// engine has no lifecycle action (grok).
    pub update_kind: Option<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    pub ok: bool,
    pub version: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CliUpdateLogLine {
    pub stream: &'static str,
    pub text: String,
    pub sequence: u64,
}

/// One bounded, host-owned attempt per engine. A lost transport never starts a
/// replacement installer; clients recover this record instead.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CliUpdateSnapshot {
    pub engine: String,
    pub run_id: String,
    pub status: &'static str,
    pub sequence: u64,
    pub logs: Vec<CliUpdateLogLine>,
    pub error: Option<String>,
    pub version: Option<String>,
}

fn update_attempts() -> &'static parking_lot::Mutex<HashMap<String, CliUpdateSnapshot>> {
    static ATTEMPTS: std::sync::OnceLock<parking_lot::Mutex<HashMap<String, CliUpdateSnapshot>>> =
        std::sync::OnceLock::new();
    ATTEMPTS.get_or_init(Default::default)
}

fn claim_update(
    attempts: &mut HashMap<String, CliUpdateSnapshot>,
    engine: &str,
    run_id: &str,
) -> Result<Option<UpdateResult>, String> {
    if run_id.trim().is_empty() || run_id.len() > 256 {
        return Err("A CLI update requires a non-empty runId of at most 256 bytes".into());
    }
    if let Some(previous) = attempts.get(engine) {
        if previous.status == "running" {
            return Err(format!(
                "{engine} already has a running install/update; recover its progress instead"
            ));
        }
        if previous.run_id == run_id {
            return if previous.status == "done" {
                Ok(Some(UpdateResult {
                    ok: true,
                    version: previous.version.clone(),
                }))
            } else {
                Err(previous
                    .error
                    .clone()
                    .unwrap_or_else(|| "CLI update failed".into()))
            };
        }
    }
    let sequence = attempts
        .get(engine)
        .map(|previous| previous.sequence)
        .unwrap_or(0);
    attempts.insert(
        engine.into(),
        CliUpdateSnapshot {
            engine: engine.into(),
            run_id: run_id.into(),
            status: "running",
            sequence,
            logs: Vec::new(),
            error: None,
            version: None,
        },
    );
    Ok(None)
}

#[tauri::command]
pub fn cli_update_snapshot(engine: String) -> Result<Option<CliUpdateSnapshot>, String> {
    let engine = checked_engine(&engine)?;
    Ok(update_attempts().lock().get(&engine).cloned())
}

struct UpdateLease {
    reporter: ProgressReporter,
    completed: bool,
}
impl UpdateLease {
    fn settle(&mut self, result: &Result<UpdateResult, String>) {
        if let Some(snapshot) = update_attempts()
            .lock()
            .get_mut(self.reporter.engine.as_ref())
        {
            if snapshot.run_id == self.reporter.run_id.as_ref() {
                snapshot.status = if result.is_ok() { "done" } else { "error" };
                snapshot.version = result.as_ref().ok().and_then(|value| value.version.clone());
                snapshot.error = result.as_ref().err().cloned();
            }
        }
        self.completed = true;
        self.reporter.emit("settled", None, Some(result.is_ok()));
        self.reporter.flush();
    }
}
impl Drop for UpdateLease {
    fn drop(&mut self) {
        if !self.completed {
            self.settle(&Err("CLI update interrupted before completion; check the installed version before retrying".into()));
        }
    }
}
/// What the one-click install dialog shows before the user confirms:
/// the exact command plus a copy-paste fallback for manual runs.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliUpdatePlan {
    pub engine: String,
    /// "install" | "update"
    pub action: &'static str,
    /// "npm" | "native" | "none"
    pub kind: &'static str,
    pub command: Vec<String>,
    pub manual_command: String,
    pub can_run: bool,
    pub blockers: Vec<String>,
    pub platform: &'static str,
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

/// npm's Windows launchers live beside node_modules, not inside it. Require
/// both package metadata and a launcher reference to its declared entry point;
/// a directory named `npm` alone (or a nearby native executable) is not proof.
fn npm_shim_prefix(engine: &str, bin: &str) -> Option<PathBuf> {
    let path = Path::new(bin);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if !["", "cmd", "ps1"]
        .iter()
        .any(|allowed| extension.eq_ignore_ascii_case(allowed))
    {
        return None;
    }
    let prefix = path.parent()?;
    let package = npm_package(engine)?;
    let package_dir = prefix.join("node_modules").join(package);
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(package_dir.join("package.json")).ok()?).ok()?;
    if manifest.get("name")?.as_str()? != package {
        return None;
    }
    let entry = manifest.get("bin")?;
    let entry = entry.as_str().or_else(|| entry.get(engine)?.as_str())?;
    if !package_dir.join(entry).is_file() {
        return None;
    }
    let launcher = std::fs::read_to_string(path).ok()?.replace('\\', "/");
    let reference = format!("node_modules/{package}/{}", entry.trim_start_matches("./"));
    if !launcher.contains(&reference) {
        return None;
    }
    // npm expects an ordinary shell path, not Windows' verbatim \\?\ form.
    dunce::canonicalize(prefix).ok()
}

fn claude_update_kind(engine: &str, bin: &str) -> &'static str {
    let resolved = std::fs::canonicalize(bin)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| bin.to_string());
    if resolved
        .replace('\\', "/")
        .split('/')
        .any(|part| part == "node_modules")
        || npm_shim_prefix(engine, bin).is_some()
    {
        "npm"
    } else {
        "native"
    }
}

fn update_kind(engine: &str, bin: &str) -> Option<&'static str> {
    if engine == "claude" || engine == "codex" {
        return Some(claude_update_kind(engine, bin));
    }
    // Cursor Agent installs and updates through its official installer.
    if engine == "cursor" {
        return Some("native");
    }
    npm_package(engine).map(|_| "npm")
}

pub(crate) struct CliProbe {
    pub(crate) installed: bool,
    pub(crate) version: Option<String>,
}

/// `<bin> --version`: first non-empty stdout line, 10s cap. A failed or timed-out
/// probe means unavailable; a successful run with no version line still counts
/// as installed (we just have nothing to display).
pub(crate) async fn probe_local_version(bin: &str) -> CliProbe {
    let mut command = command_for_binary(bin);
    command.arg("--version");
    let output = match run_capture(&mut command, CLI_VERSION_TIMEOUT).await {
        Ok(output) => output,
        Err(_) => {
            return CliProbe {
                installed: false,
                version: None,
            }
        }
    };
    if output.timed_out
        || !output
            .status
            .map(|status| status.success())
            .unwrap_or(false)
    {
        return CliProbe {
            installed: false,
            version: None,
        };
    }
    let version = output
        .stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string);
    CliProbe {
        installed: true,
        version,
    }
}

/// Latest published version: `npm view <package> version`.
async fn probe_latest_version(package: &str) -> Option<String> {
    let npm = resolve::resolve_launchable_cli_binary("npm");
    let mut command = command_for_binary(&npm);
    command.args(["view", package, "version"]);
    let output = run_capture(&mut command, NPM_VIEW_TIMEOUT).await.ok()?;
    if output.timed_out
        || !output
            .status
            .map(|status| status.success())
            .unwrap_or(false)
    {
        return None;
    }
    output
        .stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

fn checked_engine(engine: &str) -> Result<String, String> {
    let trimmed = engine.trim();
    if crate::config::ENGINES.contains(&trimmed) {
        Ok(trimmed.to_string())
    } else {
        Err(format!("未知引擎：{engine}"))
    }
}

#[tauri::command]
pub async fn cli_version_status(engine: String) -> Result<CliVersionStatus, String> {
    let engine = checked_engine(&engine)?;
    let settings = crate::settings::read_settings().unwrap_or_default();
    let bin = crate::engine::engine_bin(&settings, &engine);
    let package = npm_package(&engine);
    // Local probe and registry probe are independent — run them concurrently
    // so the header waits on the slower of the two, not the sum.
    let (local, latest) = tokio::join!(probe_local_version(&bin), async move {
        match package {
            Some(package) => probe_latest_version(package).await,
            None => None,
        }
    });
    let update_available = match (
        local.version.as_deref().and_then(parse_version),
        latest.as_deref().and_then(parse_version),
    ) {
        (Some(local), Some(latest)) => latest > local,
        _ => false,
    };
    Ok(CliVersionStatus {
        update_kind: update_kind(&engine, &bin),
        engine,
        installed: local.installed,
        local_version: local.version,
        latest_version: latest,
        update_available,
    })
}

/// Execution plan for the confirm dialog: same argv the run uses, so the
/// preview can never drift from what actually executes.
#[tauri::command]
pub async fn cli_update_plan(engine: String) -> Result<CliUpdatePlan, String> {
    let engine = checked_engine(&engine)?;
    let settings = crate::settings::read_settings().unwrap_or_default();
    let bin = crate::engine::engine_bin(&settings, &engine);
    let installed = probe_local_version(&bin).await.installed;
    let kind = update_kind(&engine, &bin);
    let (command, blockers) = match kind {
        Some("npm") => {
            let package = npm_package(&engine).expect("npm kind implies package");
            let (program, args) =
                npm_install_argv(package, npm_shim_prefix(&engine, &bin).as_deref());
            (std::iter::once(program).chain(args).collect(), Vec::new())
        }
        Some("native") => {
            let (program, args) = native_install_argv(&engine);
            (
                std::iter::once(program.to_string())
                    .chain(args.iter().map(|a| a.to_string()))
                    .collect(),
                Vec::new(),
            )
        }
        _ => (Vec::new(), vec![format!("{engine} 不支持一键安装/更新。")]),
    };
    Ok(CliUpdatePlan {
        action: if installed { "update" } else { "install" },
        kind: kind.unwrap_or("none"),
        can_run: blockers.is_empty(),
        manual_command: manual_command(&command),
        command,
        blockers,
        engine,
        platform: platform_name(),
    })
}

#[tauri::command]
pub async fn cli_update(
    engine: String,
    run_id: String,
    state: State<'_, AppState>,
) -> Result<UpdateResult, String> {
    let engine = checked_engine(&engine)?;
    if let Some(result) = claim_update(&mut update_attempts().lock(), &engine, &run_id)? {
        return Ok(result);
    }
    let mut lease = UpdateLease {
        reporter: ProgressReporter::new(state.emitters.clone(), run_id, engine.clone()),
        completed: false,
    };
    lease.reporter.emit("started", None, None);
    let result = async {
        let settings = crate::settings::read_settings().unwrap_or_default();
        let bin = crate::engine::engine_bin(&settings, &engine);
        let (before, target) = tokio::join!(probe_local_version(&bin), async {
            match npm_package(&engine) {
                Some(package) => probe_latest_version(package).await,
                None => None,
            }
        });
        match update_kind(&engine, &bin) {
            Some("npm") => {
                let package = npm_package(&engine).expect("npm kind implies package");
                run_npm_install(
                    package,
                    npm_shim_prefix(&engine, &bin).as_deref(),
                    &lease.reporter,
                )
                .await?;
            }
            Some("native") => run_native_install(&engine, &lease.reporter).await?,
            _ => return Err(format!("{engine} 不支持一键安装/更新。")),
        }
        // A subprocess's finished event is not the final lifecycle outcome.
        resolve::clear_search_paths_cache();
        let effective_bin = crate::engine::engine_bin(&settings, &engine);
        let probe = probe_local_version(&effective_bin).await;
        validate_update(&bin, &effective_bin, &before, &probe, target.as_deref())?;
        Ok(UpdateResult {
            ok: true,
            version: probe.version,
        })
    }
    .await;
    lease.settle(&result);
    use crate::event_sink::Emit;
    state.emitters.emit_json(
        "engine-config://changed",
        &serde_json::json!({ "engine": engine }).to_string(),
    );
    result
}

fn manual_command(command: &[String]) -> String {
    let quoted = command
        .iter()
        .map(|arg| {
            if cfg!(windows) {
                format!("'{}'", arg.replace('\'', "''"))
            } else {
                format!("'{}'", arg.replace('\'', "'\\''"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    if cfg!(windows) && !command.is_empty() {
        format!("& {quoted}")
    } else {
        quoted
    }
}

/// Installer exit status is only an intermediate result. Check the executable
/// the next conversation will actually use, including PATH shadowing.
fn validate_update(
    before_bin: &str,
    effective_bin: &str,
    before: &CliProbe,
    after: &CliProbe,
    target: Option<&str>,
) -> Result<(), String> {
    let old = before.version.as_deref().and_then(parse_version);
    let current = after.version.as_deref().and_then(parse_version);
    let wanted = target.and_then(parse_version);
    let reason = if !after.installed || current.is_none() {
        Some("安装后未找到可验证版本的 CLI")
    } else if matches!((old, current), (Some(old), Some(current)) if current < old) {
        Some("安装后生效版本发生回退")
    } else if matches!((current, wanted), (Some(current), Some(wanted)) if current < wanted) {
        Some("安装后生效版本仍低于目标版本，可能存在其他安装遮蔽")
    } else {
        None
    };
    match reason {
        Some(reason) => Err(format!(
            "{reason}。更新前路径：{before_bin}；当前生效路径：{effective_bin}；更新前版本：{}；更新后版本：{}；目标版本：{}",
            before.version.as_deref().unwrap_or("未知"),
            after.version.as_deref().unwrap_or("未知"),
            target.unwrap_or("未知"),
        )),
        None => Ok(()),
    }
}

/// npm global install argv, shared by the plan preview and the run so the
/// dialog always shows exactly what will execute.
fn npm_install_argv(package: &str, prefix: Option<&Path>) -> (String, Vec<String>) {
    let npm = resolve::resolve_launchable_cli_binary("npm");
    let mut args = vec![
        "install".to_string(),
        "-g".to_string(),
        "--maxsockets=1".to_string(),
        "--fetch-retries=5".to_string(),
        "--no-audit".to_string(),
        "--no-fund".to_string(),
        format!("{package}@latest"),
    ];
    if let Some(prefix) = prefix {
        args.push("--prefix".into());
        args.push(prefix.to_string_lossy().into_owned());
    }
    (npm, args)
}

/// Official installer argv for a native-channel engine (claude / codex).
fn native_install_argv(engine: &str) -> (&'static str, Vec<&'static str>) {
    if engine == "codex" {
        codex_native_argv()
    } else if engine == "cursor" {
        cursor_native_argv()
    } else {
        claude_native_argv()
    }
}

/// Claude native-channel argv (official install script; handles both fresh
/// installs and in-place updates).
fn claude_native_argv() -> (&'static str, Vec<&'static str>) {
    if cfg!(target_os = "windows") {
        (
            "powershell",
            vec![
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "irm https://claude.ai/install.ps1 | iex",
            ],
        )
    } else {
        (
            "bash",
            vec!["-lc", "curl -fsSL https://claude.ai/install.sh | bash"],
        )
    }
}

/// Cursor Agent official installer (fresh install and in-place update).
fn cursor_native_argv() -> (&'static str, Vec<&'static str>) {
    if cfg!(target_os = "windows") {
        (
            "powershell",
            vec![
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "irm 'https://cursor.com/install?win32=true' | iex",
            ],
        )
    } else {
        (
            "bash",
            vec!["-lc", "curl https://cursor.com/install -fsS | bash"],
        )
    }
}

/// Codex standalone installer: updates `~/.local/bin/codex` (or
/// `$CODEX_INSTALL_DIR`) in place instead of forcing an npm global copy.
fn codex_native_argv() -> (&'static str, Vec<&'static str>) {
    if cfg!(target_os = "windows") {
        (
            "powershell",
            vec![
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "irm https://chatgpt.com/codex/install.ps1 | iex",
            ],
        )
    } else {
        (
            "bash",
            vec![
                "-lc",
                "curl -fsSL https://chatgpt.com/codex/install.sh | bash",
            ],
        )
    }
}

async fn run_npm_install(
    package: &str,
    prefix: Option<&Path>,
    reporter: &ProgressReporter,
) -> Result<(), String> {
    let (npm, args) = npm_install_argv(package, prefix);
    let mut command = command_for_binary(&npm);
    command.args(&args);
    let output = run_streaming(&mut command, INSTALL_TIMEOUT, reporter)
        .await
        .map_err(|e| format!("无法运行 npm（{npm}）：{e}"))?;
    if output.timed_out {
        return Err("npm 安装超时（420 秒），请检查网络后重试。".to_string());
    }
    if !output.status.map(|s| s.success()).unwrap_or(false) {
        let combined = format!("{}\n{}", output.stdout, output.stderr);
        let tail = tail(&combined, ERROR_TAIL_CAP);
        return Err(format!(
            "npm 安装失败。{}",
            if tail.is_empty() {
                "无输出。".to_string()
            } else {
                format!("输出末尾：{tail}")
            }
        ));
    }
    Ok(())
}

/// Native channel: the official install script handles both fresh
/// installs and in-place updates.
async fn run_native_install(engine: &str, reporter: &ProgressReporter) -> Result<(), String> {
    let (program, args) = native_install_argv(engine);
    let mut command = Command::new(program);
    command.args(args);
    let output = run_streaming(&mut command, INSTALL_TIMEOUT, reporter)
        .await
        .map_err(|e| format!("无法运行官方安装脚本：{e}"))?;
    if output.timed_out {
        return Err("安装脚本超时（420 秒），请检查网络后重试。".to_string());
    }
    if !output.status.map(|s| s.success()).unwrap_or(false) {
        let combined = format!("{}\n{}", output.stdout, output.stderr);
        let tail = tail(&combined, ERROR_TAIL_CAP);
        return Err(format!(
            "官方安装脚本执行失败。{}",
            if tail.is_empty() {
                "无输出。".to_string()
            } else {
                format!("输出末尾：{tail}")
            }
        ));
    }
    Ok(())
}

// ==================== Progress streaming ====================

/// Per-run reporter: streams installer output lines to the frontend as
/// batched `cli://update-progress` events (32ms/64KB, same as terminal
/// output), so the dialog renders the install as it happens. The `run_id`
/// scopes events to one confirmed run; the frontend ignores anything else.
#[derive(Clone)]
struct ProgressReporter {
    sink: Arc<EventSink>,
    run_id: Arc<str>,
    engine: Arc<str>,
}

fn record_progress(
    attempts: &mut HashMap<String, CliUpdateSnapshot>,
    engine: &str,
    run_id: &str,
    phase: &'static str,
    line: Option<&str>,
) -> Option<u64> {
    attempts
        .get_mut(engine)
        .filter(|snapshot| snapshot.run_id == run_id)
        .map(|snapshot| {
            snapshot.sequence += 1;
            if matches!(phase, "stdout" | "stderr") {
                snapshot.logs.push(CliUpdateLogLine {
                    stream: phase,
                    text: line
                        .unwrap_or_default()
                        .chars()
                        .take(PROGRESS_LINE_CAP)
                        .collect(),
                    sequence: snapshot.sequence,
                });
                if snapshot.logs.len() > UPDATE_LOG_CAP {
                    snapshot.logs.remove(0);
                }
            }
            snapshot.sequence
        })
}

impl ProgressReporter {
    fn new(emitters: Arc<BroadcastEmit>, run_id: String, engine: String) -> Self {
        Self {
            sink: EventSink::with_name(emitters, CLI_UPDATE_PROGRESS_EVENT),
            run_id: run_id.into(),
            engine: engine.into(),
        }
    }

    /// phase: "started" | "stdout" | "stderr" | "finished"
    fn emit(&self, phase: &'static str, line: Option<String>, exit_ok: Option<bool>) {
        let sequence = {
            let mut attempts = update_attempts().lock();
            record_progress(
                &mut attempts,
                self.engine.as_ref(),
                self.run_id.as_ref(),
                phase,
                line.as_deref(),
            )
        };
        self.sink.push(serde_json::json!({
            "runId": self.run_id,
            "engine": self.engine,
            "phase": phase,
            "line": line,
            "exitOk": exit_ok,
            "sequence": sequence,
        }));
    }

    fn flush(&self) {
        self.sink.flush();
    }
}

// ==================== Shared process helpers ====================

/// Run a short-lived command to completion with a timeout, capturing all of
/// stdout/stderr. The child gets its own process group (unix) so a timeout
/// kill takes grandchildren (npm's cmd/node chain) down too.
struct ProcOutput {
    status: Option<std::process::ExitStatus>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

async fn run_capture(command: &mut Command, limit: Duration) -> Result<ProcOutput, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    crate::engine::hide_console(command);
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let pid = child.id();
    // Kill-on-close job (Windows): the taskkill timeout path only walks a
    // live tree, so a grandchild orphaned before it ran would escape; the
    // job sweeps members whenever this guard drops — timeout or completion.
    #[cfg(windows)]
    let _tree_guard = crate::engine::job::assign_kill_on_close(&child);
    let stdout = child.stdout.take().map(spawn_read_all);
    let stderr = child.stderr.take().map(spawn_read_all);
    let (status, timed_out) = match timeout(limit, child.wait()).await {
        Ok(Ok(status)) => (Some(status), false),
        Ok(Err(e)) => return Err(e.to_string()),
        Err(_) => {
            if let Some(pid) = pid {
                crate::engine::kill_process_group(pid);
            }
            let _ = child.start_kill();
            let _ = child.wait().await;
            (None, true)
        }
    };
    // Settle sweep (unix): the group is empty on a clean exit (ESRCH); what
    // remains is a grandchild the probed CLI orphaned — kill it now.
    #[cfg(unix)]
    if let Some(pid) = pid.filter(|p| *p != 0) {
        crate::engine::kill_process_group(pid);
    }
    let stdout = match stdout {
        Some(handle) => handle.await.unwrap_or_default(),
        None => String::new(),
    };
    let stderr = match stderr {
        Some(handle) => handle.await.unwrap_or_default(),
        None => String::new(),
    };
    Ok(ProcOutput {
        status,
        stdout,
        stderr,
        timed_out,
    })
}

fn spawn_read_all<R: AsyncRead + Unpin + Send + 'static>(pipe: R) -> JoinHandle<String> {
    tokio::spawn(async move {
        // Keep the first CAPTURE_CAP_BYTES + 1 bytes, then drain the rest
        // to a sink so the child never blocks on a full pipe (same
        // pattern as plugin_caps::read_stream_capped).
        let mut taken = pipe.take((CAPTURE_CAP_BYTES + 1) as u64);
        let mut bytes = Vec::new();
        let _ = taken.read_to_end(&mut bytes).await;
        let _ = tokio::io::copy(&mut taken.into_inner(), &mut tokio::io::sink()).await;
        String::from_utf8_lossy(&bytes).into_owned()
    })
}
/// Like `run_capture`, but each output line is also pushed to the progress
/// reporter as it arrives. The full text is still captured for failure
/// tails, so error reporting is unchanged.
async fn run_streaming(
    command: &mut Command,
    limit: Duration,
    reporter: &ProgressReporter,
) -> Result<ProcOutput, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    crate::engine::hide_console(command);
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let pid = child.id();
    // Same kill-on-close job rationale as run_capture above.
    #[cfg(windows)]
    let _tree_guard = crate::engine::job::assign_kill_on_close(&child);
    reporter.emit("started", None, None);
    let stdout = child
        .stdout
        .take()
        .map(|pipe| spawn_read_lines(pipe, reporter.clone(), "stdout"));
    let stderr = child
        .stderr
        .take()
        .map(|pipe| spawn_read_lines(pipe, reporter.clone(), "stderr"));
    let (status, timed_out) = match timeout(limit, child.wait()).await {
        Ok(Ok(status)) => (Some(status), false),
        Ok(Err(e)) => return Err(e.to_string()),
        Err(_) => {
            if let Some(pid) = pid {
                crate::engine::kill_process_group(pid);
            }
            let _ = child.start_kill();
            let _ = child.wait().await;
            (None, true)
        }
    };
    // Same unix settle sweep as run_capture above.
    #[cfg(unix)]
    if let Some(pid) = pid.filter(|p| *p != 0) {
        crate::engine::kill_process_group(pid);
    }
    let stdout = match stdout {
        Some(handle) => handle.await.unwrap_or_default(),
        None => String::new(),
    };
    let stderr = match stderr {
        Some(handle) => handle.await.unwrap_or_default(),
        None => String::new(),
    };
    reporter.emit("finished", None, status.map(|s| s.success()));
    reporter.flush();
    Ok(ProcOutput {
        status,
        stdout,
        stderr,
        timed_out,
    })
}

/// Read a stream line by line, reporting each line (clipped to
/// PROGRESS_LINE_CAP chars) while capturing the full text. Invalid UTF-8
/// ends the read early — captured-so-far is still returned.
fn spawn_read_lines<R: AsyncRead + Unpin + Send + 'static>(
    pipe: R,
    reporter: ProgressReporter,
    stream: &'static str,
) -> JoinHandle<String> {
    tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(pipe).lines();
        let mut captured = String::new();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    // Capture is capped; keep draining and reporting past the cap
                    // so the child never blocks on a full pipe.
                    if captured.len() + line.len() <= CAPTURE_CAP_BYTES {
                        captured.push_str(&line);
                        captured.push('\n');
                    }
                    let clipped = if line.chars().count() > PROGRESS_LINE_CAP {
                        line.chars().take(PROGRESS_LINE_CAP).collect()
                    } else {
                        line
                    };
                    reporter.emit(stream, Some(clipped), None);
                }
                Ok(None) | Err(_) => break,
            }
        }
        captured
    })
}

/// Last `cap` bytes of `text`, on a char boundary.
fn tail(text: &str, cap: usize) -> &str {
    if text.len() <= cap {
        return text.trim();
    }
    let mut start = text.len() - cap;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].trim()
}

// ==================== Version compare ====================

/// Semver-ish tuple from the first digit-run in the text: "v1.2.3",
/// "2.1.228 (Claude Code)", "1.2" all parse; anything without digits → None.
fn parse_version(text: &str) -> Option<(u64, u64, u64)> {
    let text = text.trim();
    let start = text.find(|c: char| c.is_ascii_digit())?;
    let mut parts = text[start..].split('.');
    let major = leading_number(parts.next()?)?;
    let minor = parts.next().and_then(leading_number).unwrap_or(0);
    let patch = parts.next().and_then(leading_number).unwrap_or(0);
    Some((major, minor, patch))
}

fn leading_number(text: &str) -> Option<u64> {
    let digits: String = text.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FixtureDir(PathBuf);
    impl FixtureDir {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "ccgui-cli-lifecycle-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for FixtureDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn npm_windows_shims_require_matching_package_and_launcher_evidence() {
        let root = FixtureDir::new();
        // Deliberately not a directory called npm: metadata determines ownership.
        let prefix = root.0.join("custom global prefix");
        for engine in ["codex", "claude"] {
            let package = npm_package(engine).unwrap();
            let package_dir = prefix.join("node_modules").join(package);
            std::fs::create_dir_all(package_dir.join("bin")).unwrap();
            std::fs::write(package_dir.join("bin/cli.js"), "// entry").unwrap();
            std::fs::write(
                package_dir.join("package.json"),
                serde_json::json!({
                    "name": package, "bin": {engine: "bin/cli.js"}
                })
                .to_string(),
            )
            .unwrap();
            for suffix in [".cmd", ".ps1", ""] {
                let shim = prefix.join(format!("{engine}{suffix}"));
                std::fs::write(
                    &shim,
                    format!(
                        "node \"%dp0%\\node_modules\\{}\\bin\\cli.js\"",
                        package.replace('/', "\\")
                    ),
                )
                .unwrap();
                let bin = shim.to_str().unwrap();
                assert_eq!(update_kind(engine, bin), Some("npm"));
                let detected = npm_shim_prefix(engine, bin).unwrap();
                assert_eq!(detected, dunce::canonicalize(&prefix).unwrap());
                let (_, args) = npm_install_argv(package, Some(&detected));
                assert_eq!(args[args.len() - 2], "--prefix");
                assert_eq!(args.last().unwrap(), &detected.to_string_lossy());
                std::fs::write(&shim, "unrelated native launcher").unwrap();
                assert_eq!(update_kind(engine, bin), Some("native"));
            }
            let exe = prefix.join(format!("{engine}.exe"));
            std::fs::write(&exe, format!("MZ node_modules/{package}/bin/cli.js")).unwrap();
            assert_eq!(update_kind(engine, exe.to_str().unwrap()), Some("native"));
            let shim = prefix.join(format!("{engine}.cmd"));
            std::fs::write(&shim, format!("node_modules/{package}/bin/cli.js")).unwrap();
            std::fs::remove_file(package_dir.join("bin/cli.js")).unwrap();
            assert!(npm_shim_prefix(engine, shim.to_str().unwrap()).is_none());
        }
        assert_eq!(
            update_kind("codex", root.0.join("npm/codex.cmd").to_str().unwrap()),
            Some("native")
        );
    }

    fn probe(version: Option<&str>) -> CliProbe {
        CliProbe {
            installed: version.is_some(),
            version: version.map(str::to_string),
        }
    }

    #[test]
    fn manual_npm_command_preserves_spaces_and_quotes_in_prefix() {
        let prefix = Path::new("custom global prefix/owner's tools");
        let (program, args) = npm_install_argv("@openai/codex", Some(prefix));
        let command: Vec<_> = std::iter::once(program).chain(args).collect();
        let manual = manual_command(&command);
        if cfg!(windows) {
            assert!(manual.starts_with("& '"));
            assert!(manual.ends_with("'--prefix' 'custom global prefix/owner''s tools'"));
        } else {
            assert!(manual.ends_with("'--prefix' 'custom global prefix/owner'\\''s tools'"));
        }
    }

    #[test]
    fn update_validation_rejects_shadowed_old_missing_and_rolled_back_versions() {
        let before = probe(Some("codex-cli 0.159.2"));
        for after in [
            probe(Some("0.159.2")),
            probe(Some("0.162.1")),
            probe(Some("0.158.0")),
            probe(None),
            probe(Some("unparseable")),
        ] {
            let error = validate_update(
                "old/codex.cmd",
                "effective/codex.cmd",
                &before,
                &after,
                Some("0.163.0"),
            )
            .unwrap_err();
            assert!(error.contains("effective/codex.cmd"));
            assert!(error.contains("old/codex.cmd"));
            assert!(error.contains("0.159.2"));
            assert!(error.contains("0.163.0"));
        }
        assert!(validate_update(
            "old",
            "new",
            &before,
            &probe(Some("0.163.0")),
            Some("0.163.0")
        )
        .is_ok());
        assert!(validate_update(
            "old",
            "new",
            &before,
            &probe(Some("0.164.0")),
            Some("0.163.0")
        )
        .is_ok());
    }

    #[test]
    fn update_validation_allows_latest_idempotence_and_unknown_target_without_regression() {
        let before = probe(Some("0.163.0"));
        assert!(validate_update("bin", "bin", &before, &before, Some("0.163.0")).is_ok());
        assert!(validate_update("bin", "bin", &before, &before, None).is_ok());
        assert!(validate_update("bin", "bin", &before, &probe(Some("0.162.0")), None).is_err());
        assert!(validate_update("bin", "bin", &before, &probe(None), None).is_err());
        assert!(validate_update("bin", "bin", &probe(None), &before, Some("0.163.0")).is_ok());
        assert!(validate_update("bin", "bin", &probe(None), &before, None).is_ok());
        assert!(validate_update("bin", "bin", &probe(None), &probe(None), None).is_err());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn local_probe_rejects_version_output_from_failed_process() {
        let root = FixtureDir::new();
        let bin = root.0.join("fake-cli.cmd");
        std::fs::write(&bin, "@echo off\r\necho 1.2.3\r\nexit /b 3\r\n").unwrap();
        let result = probe_local_version(bin.to_str().unwrap()).await;
        assert!(!result.installed);
        assert!(result.version.is_none());
    }

    #[test]
    fn update_claim_is_engine_scoped_and_same_attempt_never_restarts() {
        let mut attempts = HashMap::new();
        assert!(claim_update(&mut attempts, "pi", "run-one")
            .unwrap()
            .is_none());
        assert!(claim_update(&mut attempts, "pi", "run-two").is_err());
        assert!(claim_update(&mut attempts, "pi", "run-one").is_err());
        assert!(claim_update(&mut attempts, "omp", "independent-run")
            .unwrap()
            .is_none());
        let snapshot = attempts.get_mut("pi").unwrap();
        snapshot.status = "done";
        snapshot.version = Some("2.0".into());
        assert_eq!(
            claim_update(&mut attempts, "pi", "run-one")
                .unwrap()
                .unwrap()
                .version
                .as_deref(),
            Some("2.0")
        );
        let snapshot = attempts.get_mut("pi").unwrap();
        snapshot.status = "error";
        snapshot.error = Some("installer failed".into());
        assert_eq!(
            claim_update(&mut attempts, "pi", "run-one")
                .err()
                .as_deref(),
            Some("installer failed")
        );
        assert!(claim_update(&mut attempts, "pi", "new-attempt")
            .unwrap()
            .is_none());
    }

    #[test]
    fn update_snapshot_bounds_output_and_rejects_late_previous_run_lines() {
        let mut attempts = HashMap::new();
        claim_update(&mut attempts, "pi", "old-run").unwrap();
        for index in 0..220 {
            record_progress(
                &mut attempts,
                "pi",
                "old-run",
                "stdout",
                Some(&index.to_string()),
            );
        }
        let snapshot = attempts.get("pi").unwrap();
        assert_eq!(snapshot.logs.len(), 200);
        assert_eq!(snapshot.logs.first().unwrap().text, "20");
        assert_eq!(snapshot.sequence, 220);
        attempts.get_mut("pi").unwrap().status = "done";
        claim_update(&mut attempts, "pi", "new-run").unwrap();
        assert!(record_progress(&mut attempts, "pi", "old-run", "stderr", Some("late")).is_none());
        let long_line = "中".repeat(1100);
        assert_eq!(
            record_progress(&mut attempts, "pi", "new-run", "stdout", Some(&long_line)),
            Some(221)
        );
        let snapshot = attempts.get("pi").unwrap();
        assert_eq!(snapshot.logs.len(), 1);
        assert_eq!(snapshot.logs[0].text.chars().count(), 1000);
    }

    #[test]
    fn parse_version_extracts_first_digit_run() {
        assert_eq!(parse_version("2.1.228 (Claude Code)"), Some((2, 1, 228)));
        assert_eq!(parse_version("v1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_version("1.2"), Some((1, 2, 0)));
        assert_eq!(parse_version("no digits"), None);
    }

    #[test]
    fn npm_package_covers_every_npm_engine() {
        for engine in ["claude", "kimi", "codex", "pi", "omp", "dsh", "opencode"] {
            assert!(npm_package(engine).is_some(), "{engine} missing package");
        }
        assert_eq!(npm_package("grok"), None);
        assert_eq!(npm_package("agy"), None);
        // qodercli/qoderclicn ship via their own installer (like grok/agy):
        // no npm lifecycle.
        assert_eq!(npm_package("qoder"), None);
        assert_eq!(npm_package("qoder-cn"), None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_streaming_emits_scoped_lines_then_finished() {
        use std::sync::Mutex as StdMutex;

        use crate::event_sink::Emit;

        struct Collector {
            raws: StdMutex<Vec<String>>,
        }
        impl Emit for Collector {
            fn emit_json(&self, _name: &str, raw_json: &str) {
                self.raws
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(raw_json.to_string());
            }
        }

        let collector = Arc::new(Collector {
            raws: StdMutex::new(Vec::new()),
        });
        let emitters = crate::event_sink::BroadcastEmit::new(collector.clone());
        let reporter = ProgressReporter::new(emitters, "run-test".to_string(), "kimi".to_string());
        let mut command = Command::new("bash");
        command.args(["-c", "printf 'out1\\nout2\\n'; printf 'err1\\n' >&2"]);

        let output = run_streaming(&mut command, Duration::from_secs(10), &reporter)
            .await
            .unwrap();

        // Captured text is unchanged from run_capture semantics.
        assert_eq!(output.stdout, "out1\nout2\n");
        assert_eq!(output.stderr, "err1\n");
        assert_eq!(output.status.map(|s| s.success()), Some(true));
        assert!(!output.timed_out);

        // The sink flushes events as JSON arrays; flatten them.
        let events: Vec<serde_json::Value> = collector
            .raws
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .flat_map(|raw| serde_json::from_str::<Vec<serde_json::Value>>(raw).unwrap())
            .collect();
        // Every event carries the run scope.
        assert!(events.iter().all(|e| e["runId"] == "run-test"));
        assert_eq!(events.first().unwrap()["phase"], "started");
        assert_eq!(events.last().unwrap()["phase"], "finished");
        assert_eq!(events.last().unwrap()["exitOk"], true);
        let lines: Vec<(&str, &str)> = events
            .iter()
            .filter(|e| e["phase"] == "stdout" || e["phase"] == "stderr")
            .map(|e| (e["phase"].as_str().unwrap(), e["line"].as_str().unwrap()))
            .collect();
        assert_eq!(
            lines,
            vec![("stdout", "out1"), ("stdout", "out2"), ("stderr", "err1")]
        );
    }

    #[test]
    fn update_kind_matches_distribution_channel() {
        // npm engines always update through npm, regardless of binary path.
        assert_eq!(update_kind("dsh", "/usr/local/bin/dsh"), Some("npm"));
        // grok has no lifecycle action.
        assert_eq!(update_kind("grok", "/usr/local/bin/grok"), None);
        assert_eq!(update_kind("agy", "/usr/local/bin/agy"), None);
        // claude / codex: a node_modules path means the npm distribution;
        // anything else uses the official standalone installer.
        assert_eq!(
            update_kind(
                "claude",
                "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js"
            ),
            Some("npm")
        );
        assert_eq!(update_kind("codex", "/usr/local/bin/codex"), Some("native"));
        assert_eq!(
            update_kind(
                "codex",
                "/usr/local/lib/node_modules/@openai/codex/bin/codex.js"
            ),
            Some("npm")
        );
    }
}
