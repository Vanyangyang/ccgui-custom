pub mod agy;
mod agy_throughput;
pub(crate) mod agy_vertex;
pub mod claude;
mod claude_haiku_assist;
mod claude_lifecycle;
#[cfg(test)]
mod claude_lifecycle_tests;
#[cfg(test)]
mod claude_live_input_tests;
mod claude_channel;
pub mod codex;
pub mod cursor;
pub mod cursor_picker;
pub(crate) mod cursor_context;
pub(crate) mod codex_app;
mod codex_auto_review;
mod codex_control;
mod codex_throughput;
mod codex_desktop;
pub(crate) mod codex_provider_env;
mod codex_read_only;
mod host_instructions;
mod codex_usage;
pub mod dsh;
mod dsh_images;
mod dsh_session;
mod events;
pub(crate) mod generated_images;
pub mod grok;
mod grok_acp;
pub mod images;
#[cfg(windows)]
pub(crate) mod job;
pub mod kimi;
mod kimi_acp;
pub mod models;
pub mod opencode;
pub mod opencode_server;
mod opencode_session;
pub mod pi_family;
pub mod pi_family_auth;
pub mod plan_review;
pub mod qoder;
mod qoder_session;
mod reader;
mod native_task_control;
pub(crate) mod side_call;
pub mod sidechat;
mod registry;
pub mod resolve;
pub mod wsl_transport;

pub(crate) use resolve::command_for_binary;

// Event types and tool-call/todo payload helpers (events.rs).
pub(crate) use events::{
    assistant_message, parse_todo_args, parse_todo_result, parse_tool_args_value, push_session_id,
    safe_prompt_arg, tool_call_message, tool_call_patch, tool_path_arg, tool_result_patch,
};
pub use events::{EngineEvent, TodoItem, TodosPayload};
pub use native_task_control::NativeTaskStopResult;
pub use plan_review::{PlanApproval, PlanReview, PlanReviewKind};
// Live child-process registry (registry.rs).
pub(crate) use registry::{kill_process_group, next_virtual_pid};
pub use registry::{ChildEntry, ProcessRegistry};
// Stdout reader / per-turn streaming plumbing (reader.rs).
pub use reader::sweep_staging_dirs;
pub(crate) use reader::{
    cleanup_staged_files, read_line_capped, run_reader, spawn_stderr_capture, spawn_stdin_writer,
    LineRead, RunContext, TurnCore, TurnState, VirtualRunGuard, MAX_LINE_BYTES,
};

use crate::event_sink;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::process::Command;
use tokio::sync::Mutex as TokioMutex;

/// Windows pops a visible console window for every console-subsystem child a
/// GUI process spawns (engine CLIs are node/.cmd shims, so every probe and
/// run flashes one). Suppress it — the child's stdio is piped, the console
/// would be useless anyway.
#[cfg(windows)]
pub(crate) fn hide_console(command: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
}

/// Set on a managed child chat's CLI and inherited by everything it starts
/// (Claude hooks, Codex notify), so local integrations such as Spellcast's
/// completion notices can leave the child's turns to its parent.
pub(crate) const LEADER_CHILD_ENV: &str = "CCGUI_LEADER_CHILD";

/// Call once `prepare_run` admitted the run. Every other launch drops the
/// marker, even when the app itself inherited one.
pub(crate) fn mark_leader_child(command: &mut Command, run_id: &str) {
    if crate::leader::is_managed_child(run_id) {
        command.env(LEADER_CHILD_ENV, "1");
    } else {
        command.env_remove(LEADER_CHILD_ENV);
    }
}

// Existing CLI hooks use this ownership marker to suppress duplicate notices.
// Keep the wire name for that de-duplication contract; it does not connect to a service.
const NATIVE_COMPLETION_OWNER: &str = "CCGUI_SPELLCAST_COMPLETION_OWNER";

/// Native completion capture depends on the GUI source and durable admission,
/// not on the CLI's home directory or its independent project hooks.
fn mark_native_completion_with_admission(
    command: &mut Command,
    eligible: bool,
    managed_child: bool,
    register: impl FnOnce() -> bool,
) -> bool {
    command.env_remove(NATIVE_COMPLETION_OWNER);
    if !eligible || managed_child || !register() {
        return false;
    }
    command.env(NATIVE_COMPLETION_OWNER, "1");
    true
}

pub(crate) fn mark_native_completion(command:&mut Command, run_id:&str, engine:&str, req:&SendRequest, eligible:bool, killed:&Arc<std::sync::atomic::AtomicBool>) -> bool {
    mark_native_completion_with_admission(command, eligible, crate::leader::is_managed_child(run_id), || {
        crate::assistant_notices::completion_outbox::register_run(run_id,engine,&req.workspace.to_string_lossy(),req.session_id.as_deref(),&req.prompt,killed)
    })
}

#[cfg(test)]
mod completion_capture_tests;

#[derive(Clone)]
pub struct SendRequest {
    /// Host-owned, per-turn collaboration guidance. None leaves native
    /// instructions untouched; an empty value clears a previous Leader role.
    pub host_instructions: Option<String>,
    pub session_id: Option<String>,
    pub workspace: PathBuf,
    pub prompt: String,
    pub images: Vec<String>,
    pub model: Option<String>,
    /// Reasoning effort ("low" | "medium" | "high" | "xhigh" | "max" | "ultra"); engines without an
    /// effort knob ignore it. Claude maps the legacy "ultra" value to "max".
    pub effort: Option<String>,
    /// Independent Claude setting; None preserves native configuration.
    pub claude_ultracode: Option<bool>,
    /// OpenAI service tier override (OMP `--service-tier` / Codex `-c service_tier`),
    /// independent of reasoning effort.
    pub service_tier: Option<String>,
    /// Permission mode ("auto" | "manual" | "plan" | "bypass"); each engine
    /// resolves it against the modes it can actually honor at spawn (see
    /// `Engine::resolve_permission`).
    pub permission: Option<String>,
    /// User-granted extra directories (db `granted_roots`); claude launches
    /// pass them as `--add-dir` so reads outside the workspace stop hitting
    /// headless permission denials. Engines without an equivalent flag
    /// ignore them.
    pub additional_dirs: Vec<String>,
    /// Session-scoped channel id. Official / empty injects nothing; spawn
    /// falls back to the engine's `current` when this is None.
    pub provider_id: Option<String>,
    /// Computer use: expose the app's screenshot/input driver to the agent
    /// as an MCP server (see computer_use.rs). Engines without an
    /// MCP-config launch flag ignore it.
    pub computer_use: Option<bool>,
    /// 逐次调用的工具白名单（任务工作台只读节点）：引擎必须真正把它兑现
    /// 为运行时约束，否则 prepare_launch 直接拒绝——不允许用节点名假装。
    pub allowed_tools: Option<Vec<String>>,
}
pub struct BuiltCommand {
    pub command: Command,
    /// Written to stdin after spawn; stdin is then closed.
    pub stdin_payload: Option<String>,
    /// Keep the child's stdin open after the payload instead of closing it:
    /// claude answers control-protocol requests (permission asks, the
    /// AskUserQuestion dialog) on the same pipe via `control_response` lines.
    pub keep_stdin_open: bool,
    /// Private staging files/directories to remove once the process exits.
    pub cleanup_files: Vec<PathBuf>,
    /// omp computer-use injection into the workspace's `.omp/mcp.json`;
    /// restored once the process exits (same funnel as cleanup_files).
    pub mcp_restore: Option<crate::computer_use::McpRestore>,
    /// Session id assigned before spawn (grok `-s <uuid>`).
    pub preassigned_session_id: Option<String>,
}
/// Which transport one send uses. On `Own` the app spawns no engine child:
/// the host driver task owns the process (or the connection) and settles the
/// turn itself.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    /// The app spawns the CLI and reads its stdout.
    Child,
    /// The engine drives its own transport (host session, ACP, app-server).
    Own,
}

pub trait Engine: Send + Sync {
    fn id(&self) -> &'static str;
    fn build_command(&self, req: &SendRequest, bin: &str) -> Result<BuiltCommand, String>;
    /// Only managed desktop chat runs receive the host's per-run chat bridge.
    /// Other engines and constrained/plugin runs keep their existing surface.
    fn build_command_with_host_chat(
        &self,
        req: &SendRequest,
        bin: &str,
        host_chat_server: Option<&Value>,
    ) -> Result<BuiltCommand, String> {
        if host_chat_server.is_some() {
            return Err(format!("engine {} cannot mount the host chat bridge", self.id()));
        }
        self.build_command(req, bin)
    }
    /// Account-scoped local diagnostics must be disabled for remote transports.
    fn disable_account_metrics(&self) {}
    /// The command a host-transport driver spawns, for engines whose `Own`
    /// transport is a process of their own (codex app-server, grok ACP). The
    /// driver spawns it verbatim, so channel flags/env land here exactly as
    /// they do for a child command.
    ///
    /// Default: the placeholder a driver that spawns no local child (qoder,
    /// dsh, opencode) never touches.
    fn host_command(&self, _req: &SendRequest, _bin: &str) -> Result<BuiltCommand, String> {
        Ok(BuiltCommand {
            command: Command::new("unused-virtual-engine"),
            stdin_payload: None,
            keep_stdin_open: false,
            cleanup_files: Vec::new(),
            mcp_restore: None,
            preassigned_session_id: None,
        })
    }
    /// Mount the same per-run capability for a native host transport. This
    /// stays separate from plugin/mission launches and never edits CLI config.
    fn host_command_with_host_chat(
        &self,
        req: &SendRequest,
        bin: &str,
        host_chat_server: Option<&Value>,
    ) -> Result<BuiltCommand, String> {
        if host_chat_server.is_some() {
            return Err(format!("engine {} cannot mount the host chat bridge", self.id()));
        }
        self.host_command(req, bin)
    }
    /// Parse one NDJSON stdout line into zero or more events.
    fn parse_line(&self, line: &str, out: &mut Vec<EngineEvent>);
    /// Settle passive measurements when the child exits without a native result.
    fn finish_telemetry(&self, _interrupted: bool, _out: &mut Vec<EngineEvent>) {}
    /// True when the engine drives its own transport (e.g. a host WS session)
    /// instead of spawning a child process. send_message routes these to a
    /// virtual run: no spawn, no pid — the registry entry carries only the
    /// abort handle, and the transport task settles the turn itself.
    fn drives_own_transport(&self) -> bool {
        false
    }
    /// Transport for one send. Default: an engine that drives its own
    /// transport keeps it for every workspace, so a WSL one has to be
    /// rejected — the driver spawns locally and its session has no remote
    /// path. codex and grok override this: their native harness protocol
    /// carries the question channel for a local workspace, while a remote one
    /// keeps today's one-shot CLI child, which the ssh wrapper owns.
    fn transport_for(&self, _wsl: bool) -> Transport {
        if self.drives_own_transport() {
            Transport::Own
        } else {
            Transport::Child
        }
    }
    /// Whether this engine accepts image attachments.
    fn supports_images(&self) -> bool;
    /// Whether the engine can hand the agent the app's computer-use driver
    /// (requires an MCP-server launch flag the CLI honors).
    fn supports_computer_use(&self) -> bool {
        false
    }
    /// Whether this engine supports reasoning effort configuration.
    fn supports_effort(&self) -> bool {
        false
    }
    /// Whether this engine supports manual context compaction (/compact).
    fn supports_compact(&self) -> bool {
        false
    }
    /// `auto` delegates eligible permission requests to the engine's own
    /// automatic reviewer, with its sandbox still enforced.
    fn supports_auto_review(&self) -> bool {
        false
    }
    /// Whether this engine can enforce a per-call tool whitelist (mission
    /// read-only nodes). Engines that return false are rejected before
    /// spawn rather than silently running without the constraint.
    fn supports_tool_constraints(&self) -> bool {
        false
    }
    /// Permission modes this engine can honor at spawn ("auto" | "manual" |
    /// "plan" | "bypass"). These are one-shot headless launches that cannot
    /// ask mid-turn, so most engines support only a subset; the UI greys out
    /// the rest rather than promising a mode the CLI would silently ignore.
    fn supported_permissions(&self) -> &'static [&'static str] {
        &["auto"]
    }
    /// Effective mode for one send: the requested mode when this engine
    /// supports it, otherwise the engine's first supported mode.
    fn resolve_permission(&self, requested: Option<&str>) -> &'static str {
        let supported = self.supported_permissions();
        requested
            .and_then(|mode| supported.iter().copied().find(|m| *m == mode))
            .unwrap_or(supported[0])
    }
    /// 计划预览与人工审批能力(engine/plan_review.rs)。默认 Legacy:引擎
    /// 自身的原生计划入口保持既有行为。返回 Unavailable 时,显式 plan 请求
    /// 必须在发送前受控拒绝——计划审批是用户决策,auto/bypass、静默回退
    /// 和自动批准参数都不能代替(OMP/Codex/DSH/Grok/Qoder 在各自适配器
    /// 接通前都是 Unavailable;PRD §1 原则 1/4)。
    fn plan_approval(&self) -> PlanApproval {
        PlanApproval::Legacy
    }
}
pub fn engine_by_id(id: &str) -> Option<Box<dyn Engine>> {
    match id {
        "claude" => Some(Box::new(claude::ClaudeEngine::new())),
        "kimi" => Some(Box::new(kimi::KimiEngine)),
        "grok" => Some(Box::new(grok::GrokEngine)),
        "codex" => Some(Box::new(codex::CodexEngine)),
        "pi" => Some(Box::new(pi_family::pi())),
        "omp" => Some(Box::new(pi_family::omp())),
        "dsh" => Some(Box::new(dsh::DshEngine)),
        "agy" => Some(Box::new(agy::AgyEngine::new())),
        "cursor" => Some(Box::new(cursor::CursorEngine::new())),
        "opencode" => Some(Box::new(opencode::OpenCodeEngine)),
        "qoder" => Some(Box::new(qoder::QoderEngine::new(
            qoder::QoderDistribution::Global,
        ))),
        "qoder-cn" => Some(Box::new(qoder::QoderEngine::new(
            qoder::QoderDistribution::Cn,
        ))),
        _ => None,
    }
}
/// Engine home dir: `$ENV_KEY` (with `~` expansion, as the CLIs resolve it)
/// when set and non-empty, else `~/<default_dir>`.
pub(crate) fn engine_home(env_key: Option<&str>, default_dir: &str) -> PathBuf {
    if let Some(home) = crate::development_profile::home() { return home.join(default_dir); }
    if let Some(key) = env_key {
        if let Some(value) = std::env::var_os(key).filter(|v| !v.is_empty()) {
            let text = value.to_string_lossy();
            if let Ok(expanded) = crate::open_app::expand_user_path(&text) {
                return expanded;
            }
            return PathBuf::from(value);
        }
    }
    fallback_home().join(default_dir)
}
/// Codex config/session home. Settings override wins in production so CLI
/// 管理's directory is what history, official config, and `codex exec` all
/// read — not a leftover `~/.codex` default. Tests keep using `CODEX_HOME`
/// / `HOME/.codex` so HomeGuard scratch dirs stay isolated.
pub(crate) fn codex_home() -> PathBuf {
    if let Some(home) = crate::development_profile::home() { return home.join(".codex"); }
    #[cfg(not(test))]
    if let Some(path) = settings_codex_home() {
        return path;
    }
    engine_home(Some("CODEX_HOME"), ".codex")
}
#[cfg(not(test))]
fn settings_codex_home() -> Option<PathBuf> {
    let custom = crate::settings::read_settings().ok()?.codex_home?;
    let trimmed = custom.trim();
    if trimmed.is_empty() {
        return None;
    }
    crate::open_app::expand_user_path(trimmed).ok()
}
/// Home dir for the default engine path. Production uses `dirs` (Known
/// Folder API on Windows); tests steer the fallback through HOME /
/// USERPROFILE env instead, because `dirs` ignores env on Windows and would
/// scan the real profile.
fn fallback_home() -> PathBuf {
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
    dirs::home_dir().unwrap_or_default()
}
// ==================== Commands ====================

#[derive(Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendResult {
    pub run_id: String,
    pub session_id: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub id: String,
    pub available: bool,
    /// False when the user disabled this CLI in settings; the UI hides it
    /// from pickers and history lists rather than erroring on launch.
    pub enabled: bool,
    pub supports_images: bool,
    /// Drives the composer's computer-use toggle: engines without an
    /// MCP-config launch flag cannot receive the driver.
    pub supports_computer_use: bool,
    /// Whether this engine supports reasoning effort configuration.
    pub supports_effort: bool,
    pub supports_compact: bool,
    pub supports_auto_review: bool,
    /// Whether this engine can enforce a per-call tool whitelist (mission
    /// read-only nodes); the workbench blocks read-only nodes otherwise.
    pub supports_tool_constraints: bool,
    /// Permission modes the engine honors at spawn; drives the composer
    /// picker's disabled options.
    pub permissions: Vec<String>,
    /// 计划预览与人工审批能力(engine/plan_review.rs):typed = 审批主干已
    /// 接通;legacy = 引擎原生计划入口(不经主干);unavailable + reason =
    /// 显式计划请求将被受控拒绝,UI 不得提供可点的计划入口。
    pub plan: PlanApproval,
}
fn codex_bin_from_home(settings: &crate::settings::AppSettings) -> Option<String> {
    let home = settings.codex_home.as_deref()?.trim();
    if home.is_empty() {
        return None;
    }
    let expanded = crate::open_app::expand_user_path(home).ok()?;
    let candidate = expanded.join("bin").join("codex");
    candidate
        .exists()
        .then(|| resolve::resolve_launchable_cli_binary(&candidate.to_string_lossy()))
}
/// CLI binary name behind an engine id, when they differ: qoder's engine ids
/// name the product/distribution, but only the `qodercli*` binaries speak
/// ACP (the `qoder` binary is the IDE launcher and is rejected at spawn).
pub(crate) fn cli_binary_name(engine_id: &str) -> &str {
    match engine_id {
        "qoder" => qoder::QoderDistribution::Global.cli_name(),
        "qoder-cn" => qoder::QoderDistribution::Cn.cli_name(),
        "cursor" => "cursor-agent",
        _ => engine_id,
    }
}
pub(crate) fn engine_bin(settings: &crate::settings::AppSettings, engine_id: &str) -> String {
    // An explicit bin override always wins: it predates the codex-home row
    // (hidden for codex in the UI), and a stale codexBin in an upgraded
    // settings.json must not be silently overridden by $home/bin/codex.
    if let Some(custom) = settings.bin_override(engine_id) {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            // Defense in depth: settings write validates too, but the file
            // may have been hand-edited since.
            match crate::settings::validate_bin_override(trimmed) {
                Ok(path) => return resolve::resolve_launchable_cli_binary(&path.to_string_lossy()),
                Err(reason) => {
                    eprintln!("[engine] ignoring invalid {engine_id} bin override: {reason}");
                }
            }
        }
    }
    if engine_id == "codex" {
        if let Some(from_home) = codex_bin_from_home(settings) {
            return from_home;
        }
    }
    resolve::resolve_launchable_cli_binary(cli_binary_name(engine_id))
}
#[tauri::command]
pub async fn list_engines() -> Result<Vec<EngineInfo>, String> {
    tauri::async_runtime::spawn_blocking(list_engines_blocking)
        .await
        .map_err(|error| format!("engine detection task failed: {error}"))
}

fn list_engines_blocking() -> Vec<EngineInfo> {
    let settings = crate::settings::read_settings().unwrap_or_default();
    let config = crate::config::read_config().unwrap_or_default();
    crate::config::ENGINES
        .iter()
        .map(|id| {
            let engine = engine_by_id(id).expect("known engine");
            let available = match settings.bin_override(id) {
                Some(custom) if !custom.trim().is_empty() => {
                    crate::settings::validate_bin_override(custom).is_ok()
                }
                _ if *id == "codex" && codex_bin_from_home(&settings).is_some() => true,
                _ => resolve::find_cli_binary(cli_binary_name(id), None).is_some(),
            };
            EngineInfo {
                id: id.to_string(),
                available,
                enabled: config.section(id).and_then(|s| s.current.as_deref())
                    != Some(crate::config::DISABLED_PROVIDER_ID),
                supports_images: engine.supports_images(),
                supports_computer_use: engine.supports_computer_use(),
                supports_effort: engine.supports_effort(),
                supports_compact: engine.supports_compact(),
                supports_auto_review: engine.supports_auto_review(),
                supports_tool_constraints: engine.supports_tool_constraints(),
                permissions: engine
                    .supported_permissions()
                    .iter()
                    .map(|m| m.to_string())
                    .collect(),
                plan: engine.plan_approval(),
            }
        })
        .collect()
}
/// Concurrent engine runs; past this the machine thrashes and the registry
/// fan-out makes interrupts unreliable anyway.
/// Counted as distinct runs (run ids), not map entries: one run is keyed
/// under both its run id and its session alias, so an entry count would
/// halve the real ceiling.
pub(crate) const MAX_CONCURRENT_RUNS: usize = 64;
/// How long a new claude send waits for the session's previous process to
/// exit. Longer than `reader::LINGER_GRACE`, so by the time it gives up the
/// UI already shows that process's continuation as running.
const PREVIOUS_PROCESS_GRACE: std::time::Duration = std::time::Duration::from_secs(6);

/// A claude turn can report Done while its CLI keeps running (a background
/// subagent). Resuming the same session in a second process would have both
/// append to one transcript and fork it, so wait for the old process to
/// leave the registry; if it is still working, refuse instead of racing it.
async fn wait_for_previous_process(
    registry: &registry::ProcessRegistry,
    session_id: &str,
    grace: std::time::Duration,
) -> Result<(), String> {
    let deadline = std::time::Instant::now() + grace;
    loop {
        let alive = registry
            .get(session_id)
            .is_some_and(|entry| entry.child.is_some() && entry.pid != 0);
        if !alive {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err("这个会话上一轮的 Claude 进程还在后台运行（例如后台子代理还没完成）。等它结束后再发，或先点停止。".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}
/// 显式计划请求的能力门禁:计划审批是用户决策,能力不足必须报错,禁止
/// 降级——auto/bypass、resolve_permission 的静默回退和自动批准参数
/// (如 --plan-yolo)都不能代替用户批准(PRD §1 原则 1/4、§3.1)。
/// prepare_launch 在构建命令与 spawn 之前调用;Typed/Legacy 路径放行。
/// Parse a manual `/compact` prompt and optional custom instructions.
pub(crate) fn parse_compact_prompt(prompt: &str) -> Option<Option<&str>> {
    let trimmed = prompt.trim();
    if trimmed == "/compact" {
        return Some(None);
    }
    let rest = trimmed.strip_prefix("/compact")?;
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let instructions = rest.trim();
    Some((!instructions.is_empty()).then_some(instructions))
}

fn ensure_plan_approval(
    engine: &str,
    engine_impl: &dyn Engine,
    permission: Option<&str>,
) -> Result<(), String> {
    if permission == Some("plan") {
        if let PlanApproval::Unavailable { reason } = engine_impl.plan_approval() {
            return Err(format!(
                "engine {engine} cannot run a human-approved plan: {reason}"
            ));
        }
    }
    Ok(())
}

/// Resolved launch parameters for one send: request, binary, built command.
struct Launch {
    req: SendRequest,
    bin: String,
    built: BuiltCommand,
    engine_impl: Box<dyn Engine>,
}
fn prepare_launch(
    engine: &str,
    workspace_path: &str,
    session_id: Option<String>,
    prompt: String,
    image_paths: Option<Vec<String>>,
    model: Option<String>,
    effort: Option<String>,
    permission: Option<String>,
    additional_dirs: Vec<String>,
    provider_id: Option<String>,
    computer_use: Option<bool>,
    allowed_tools: Option<Vec<String>>,
    wsl: bool,
    host_chat_server: Option<&Value>,
    claude_ultracode: Option<bool>,
) -> Result<Launch, String> {
    let engine_impl = engine_by_id(engine).ok_or_else(|| format!("unknown engine: {engine}"))?;
    // 停用 still gates sending. Channel settings apply to this child below;
    // native CLI files remain the official configuration.
    crate::config::ensure_engine_enabled(engine)?;
    ensure_plan_approval(engine, engine_impl.as_ref(), permission.as_deref())?;
    if parse_compact_prompt(&prompt).is_some() {
        if !engine_impl.supports_compact() {
            return Err(format!("引擎 {engine} 不支持手动压缩上下文（/compact）"));
        }
        if session_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_none()
        {
            return Err("当前会话尚未建立，无法压缩上下文".into());
        }
    }
    // 工具白名单是硬约束：引擎不能兑现就直接拒绝启动（不降级为无约束）。
    let allowed_tools = match allowed_tools {
        Some(tools) if !tools.is_empty() => {
            if !engine_impl.supports_tool_constraints() {
                return Err(format!(
                    "engine {engine} does not support per-call tool constraints"
                ));
            }
            Some(
                tools
                    .into_iter()
                    .map(|tool| tool.trim().to_string())
                    .filter(|tool| !tool.is_empty())
                    .take(32)
                    .collect::<Vec<_>>(),
            )
        }
        Some(_) => return Err("tool constraints must not be empty".into()),
        None => None,
    };
    let provider_id = provider_id.filter(|s| !s.trim().is_empty());
    let provider = crate::config::resolve_provider(engine, provider_id.as_deref())?;
    let channel_env = provider
        .as_ref()
        .map(|p| crate::provider_files::channel_env(engine, p))
        .transpose()?
        .unwrap_or_default();
    let settings = crate::settings::read_settings().unwrap_or_default();
    let model = model
        .filter(|m| !m.trim().is_empty())
        .or_else(|| settings.default_models.get(engine).cloned())
        .filter(|m| !m.trim().is_empty());
    let model = if engine == "claude" {
        claude_channel::resolve_model(model.as_deref(), provider.as_ref(), &channel_env)
    } else {
        model
    };
    let effort = effort
        .filter(|e| !e.trim().is_empty())
        .or_else(|| settings.default_efforts.get(engine).cloned())
        .filter(|e| !e.trim().is_empty());
    // Vertex sends go through the app's loopback bridge (see agy_vertex): the
    // agy process then talks to Vertex with the project's key instead of the
    // Antigravity subscription.
    let model = if engine == "agy" {
        match agy_vertex::route(model.as_deref(), effort.as_deref(), provider.as_ref())? {
            Some(bridged) => Some(bridged),
            None => model,
        }
    } else {
        model
    };
    let vertex_bridge = engine == "agy" && model.as_deref().is_some_and(agy_vertex::is_bridge_model);
    if vertex_bridge && wsl {
        return Err("The Vertex route cannot be used with agy running in WSL".into());
    }
    let req = SendRequest {
        claude_ultracode: if engine == "claude" { claude_ultracode } else { None },
        host_instructions: None,
        session_id: session_id.filter(|s| !s.trim().is_empty()),
        workspace: PathBuf::from(workspace_path),
        prompt,
        images: image_paths.unwrap_or_default(),
        model,
        effort,
        service_tier: match engine {
            "omp" => settings.omp_openai_service_tier.clone(),
            "codex" => settings.codex_service_tier.clone(),
            _ => None,
        },
        permission: permission.filter(|p| !p.trim().is_empty()),
        // Cap defensively: the list lands on a command line, and a
        // hand-edited db should not produce an argv bomb.
        additional_dirs: additional_dirs
            .into_iter()
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty() && Path::new(d).is_absolute())
            .take(32)
            .collect(),
        provider_id,
        // Only honored by engines that can actually mount the driver.
        computer_use: computer_use.filter(|on| *on && engine_impl.supports_computer_use()),
        allowed_tools,
    };
    let bin = engine_bin(&settings, engine);
    // Host-transport engines spawn through their driver instead: codex/grok
    // hand back the real app-server / ACP command the driver spawns verbatim
    // (channel flags and env land on it below, as for any child), while the
    // session-only engines keep the placeholder their driver never touches.
    let mut built = if engine_impl.transport_for(wsl) == Transport::Own {
        let mut own = engine_impl.host_command_with_host_chat(&req, &bin, host_chat_server)?;
        // The driver spawns this command with the workspace as its cwd.
        own.command.current_dir(&req.workspace);
        own
    } else if engine == "kimi" && provider.is_some() {
        kimi::build_channel_command(&req, &bin)?
    } else if engine == "claude" && provider.is_none() {
        // Pass the resolved channel snapshot to the per-run parser without
        // changing the public request or re-reading a mutable current channel.
        let mut build_req = req.clone();
        build_req.provider_id = Some(crate::config::LOCAL_PROVIDER_ID.to_owned());
        engine_impl.build_command_with_host_chat(&build_req, &bin, host_chat_server)?
    } else if engine == "claude" && provider.is_some() {
        // The channel stages the single --settings overlay, including this switch.
        let mut build_req = req.clone();
        build_req.claude_ultracode = None;
        engine_impl.build_command_with_host_chat(&build_req, &bin, host_chat_server)?
    } else {
        engine_impl.build_command_with_host_chat(&req, &bin, host_chat_server)?
    };
    if wsl { engine_impl.disable_account_metrics(); }
    for (key, value) in &channel_env {
        built.command.env(key, value);
    }
    if engine == "codex" && codex_read_only::requested(&req) {
        codex_read_only::stage(
            &req,
            &mut built,
            &codex_home(),
            &crate::paths::app_home().join("codex-plan-staging"),
        )?;
    }
    let vertex_env = if vertex_bridge {
        agy_vertex::apply_env(&mut built)
    } else {
        Ok(())
    };
    let configured = match (engine, provider.as_ref()) {
        ("claude", Some(provider)) => {
            claude_channel::apply(&mut built, provider, &channel_env, &req)
        }
        ("kimi", Some(_)) => kimi::apply_channel(&mut built.command, &channel_env, &req),
        ("codex", Some(provider)) => {
            codex::apply_channel(&mut built.command, provider, &channel_env, &req)
        }
        ("grok", Some(provider)) => grok::isolate_channel(&mut built, provider, &req),
        _ => Ok(()),
    }
    .and(vertex_env);
    if let Err(error) = configured {
        cleanup_staged_files(&built.cleanup_files);
        if let Some(restore) = &built.mcp_restore {
            restore.restore();
        }
        return Err(error);
    }
    Ok(Launch {
        req,
        bin,
        built,
        engine_impl,
    })
}

#[tauri::command]
pub async fn send_message(
    state: tauri::State<'_, crate::AppState>,
    engine: String,
    workspace_path: String,
    session_id: Option<String>,
    prompt: String,
    image_paths: Option<Vec<String>>,
    model: Option<String>,
    effort: Option<String>,
    permission: Option<String>,
    provider_id: Option<String>,
    run_id: Option<String>,
    computer_use: Option<bool>,
    claude_ultracode: Option<bool>,
    claude_haiku_assist: Option<bool>,
) -> Result<SendResult, String> {
    send_message_inner_with_sink(
        &state,
        Arc::clone(&state.sink),
        engine,
        workspace_path,
        session_id,
        prompt,
        image_paths,
        model,
        effort,
        permission,
        provider_id,
        run_id,
        computer_use,
        None,
        claude_ultracode,
        claude_haiku_assist,
    )
    .await
}

/// Body of the `send_message` command, taking the state directly: integration
/// tests drive the real spawn/read pipeline without a Tauri app (the mock
/// runtime links the GUI crates into the test exe, which then cannot load
/// without a comctl32 v6 manifest).
/// 插件 agent 轮次入口（plugin_caps::plugin_agent_start 调用）：与聊天发送
/// 共用同一条 spawn/reader/registry 管线，但事件走独立的
/// `plugin-agent://event` 流（绝不进 engine://event——chat store 会把未知
/// runId 当孤儿会话收养）。effort/permission/computer_use/图片暂不开放，
/// provider_id 缺省 = 引擎当前渠道（与聊天发送同一解析）。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn plugin_agent_send(
    state: &crate::AppState,
    engine: String,
    workspace_path: String,
    session_id: Option<String>,
    prompt: String,
    model: Option<String>,
    provider_id: Option<String>,
    run_id: String,
    read_only: Option<bool>,
) -> Result<SendResult, String> {
    let allowed_tools = plugin_agent_tools(&engine, read_only)?;
    let session_id = codex_read_only::fresh_plugin_session(&engine, read_only, session_id);
    let permission = (engine == "codex" && read_only == Some(true))
        .then(|| codex_read_only::PERMISSION.to_string());
    send_message_inner_with_sink(
        state,
        Arc::clone(&state.plugin_sink),
        engine,
        workspace_path,
        session_id,
        prompt,
        None,
        model,
        None,
        permission,
        provider_id,
        Some(run_id),
        None,
        allowed_tools,
        None,
        None,
    )
    .await
}

fn plugin_agent_tools(
    engine: &str,
    read_only: Option<bool>,
) -> Result<Option<Vec<String>>, String> {
    if read_only != Some(true) {
        return Ok(None);
    }
    if engine == "codex" {
        return Ok(None);
    }
    if engine != "pi" {
        return Err(format!(
            "engine {engine} does not support isolated plugin read-only runs; only Pi and audited local Codex planning are supported"
        ));
    }
    Ok(Some(
        ["read", "grep", "find", "ls"]
            .into_iter()
            .map(str::to_string)
            .collect(),
    ))
}

/// 任务工作台 agent 节点入口（mission::mission_agent_start 调用）：同一条
/// spawn/reader/registry 管线，事件走独立的 `mission-agent://event` 流。
/// `allowed_tools` 是逐节点工具白名单（只读约束）；引擎不能兑现时
/// prepare_launch 直接拒绝，而不是静默降级。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn mission_agent_send(
    state: &crate::AppState,
    engine: String,
    workspace_path: String,
    session_id: Option<String>,
    prompt: String,
    model: Option<String>,
    effort: Option<String>,
    provider_id: Option<String>,
    run_id: String,
    allowed_tools: Option<Vec<String>>,
) -> Result<SendResult, String> {
    send_message_inner_with_sink(
        state,
        Arc::clone(&state.mission_sink),
        engine,
        workspace_path,
        session_id,
        prompt,
        None,
        model,
        effort,
        None,
        provider_id,
        Some(run_id),
        None,
        allowed_tools,
        None,
        None,
    )
    .await
}

/// Exercise the actual isolated entry points from hermetic integration tests.
#[cfg(feature = "test-harness")]
#[doc(hidden)]
pub mod isolated_send_test_support {
    use super::*;

    #[derive(Clone, Copy, Debug)]
    pub enum Source { Plugin, Mission, ConstrainedChat }

    pub async fn send(
        state: &crate::AppState,
        source: Source,
        engine: String,
        workspace: String,
        session: Option<String>,
        run: String,
    ) -> Result<SendResult, String> {
        match source {
            Source::Mission => mission_agent_send(state, engine, workspace, session, "fixture".into(), None, None, None, run, None).await,
            Source::Plugin => plugin_agent_send(state, engine, workspace, session, "fixture".into(), None, None, run, None).await,
            Source::ConstrainedChat => send_message_inner_with_sink(
                state, Arc::clone(&state.sink), engine, workspace, session, "fixture".into(),
                None, None, None, None, None, Some(run), None, Some(vec!["Read".into()]),
                None,
                None,
            ).await,
        }
    }
}

/// Exercise the same native command validation without a real WebviewWindow.
/// Test-only; absent from production and every external dispatcher.
#[cfg(feature = "test-harness")]
#[doc(hidden)]
pub async fn ordinary_task_test_send(
    state: &crate::AppState,
    window_label: &str,
    engine: String,
    workspace: String,
    session: Option<String>,
    run: String,
) -> Result<SendResult, String> {
    if window_label != "main" { return Err("Task controls are available only in the main local window".into()); }
    if session.is_some() { return Err("This first-turn fixture requires a fresh chat".into()); }
    crate::leader::validate_first_root_workspace(&state.db, &engine, &workspace)?;
    send_message_inner_with_sink(state, Arc::clone(&state.sink), engine, workspace, None,
        "first root task".into(), None, None, None, None, None, Some(run), None,
        None, None, None).await
}

#[allow(clippy::too_many_arguments)]
pub async fn send_message_inner(
    state: &crate::AppState,
    engine: String,
    workspace_path: String,
    session_id: Option<String>,
    prompt: String,
    image_paths: Option<Vec<String>>,
    model: Option<String>,
    effort: Option<String>,
    permission: Option<String>,
    provider_id: Option<String>,
    run_id: Option<String>,
    computer_use: Option<bool>,
    claude_ultracode: Option<bool>,
) -> Result<SendResult, String> {
    send_message_inner_with_sink(
        state,
        Arc::clone(&state.sink),
        engine,
        workspace_path,
        session_id,
        prompt,
        image_paths,
        model,
        effort,
        permission,
        provider_id,
        run_id,
        computer_use,
        None,
        claude_ultracode,
        None,
    )
    .await
}

tokio::task_local! {
    /// Scoped to the worker RPC, never inherited by an ordinary host request.
    static DETACHED_WORKER_REQUEST: bool;
}

/// Task-worker entry preserves all per-run options without a window command.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn worker_send_message(
    state: &crate::AppState,
    engine: String,
    workspace_path: String,
    session_id: Option<String>,
    prompt: String,
    image_paths: Option<Vec<String>>,
    model: Option<String>,
    effort: Option<String>,
    permission: Option<String>,
    provider_id: Option<String>,
    run_id: Option<String>,
    computer_use: Option<bool>,
    claude_ultracode: Option<bool>,
    claude_haiku_assist: Option<bool>,
) -> Result<SendResult, String> {
    DETACHED_WORKER_REQUEST.scope(true, send_message_inner_with_sink(
        state, Arc::clone(&state.sink), engine, workspace_path, session_id,
        prompt, image_paths, model, effort, permission, provider_id, run_id,
        computer_use, None, claude_ultracode, claude_haiku_assist,
    )).await
}

#[allow(clippy::too_many_arguments)]
async fn send_message_inner_with_sink(
    state: &crate::AppState,
    sink: Arc<event_sink::EventSink>,
    engine: String,
    workspace_path: String,
    session_id: Option<String>,
    prompt: String,
    image_paths: Option<Vec<String>>,
    model: Option<String>,
    effort: Option<String>,
    permission: Option<String>,
    provider_id: Option<String>,
    run_id: Option<String>,
    computer_use: Option<bool>,
    allowed_tools: Option<Vec<String>>,
    claude_ultracode: Option<bool>,
    claude_haiku_assist: Option<bool>,
) -> Result<SendResult, String> {
    let run_id = run_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if run_id.is_empty()
        || run_id.len() > 128
        || !run_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("invalid run id".into());
    }
    if !DETACHED_WORKER_REQUEST.try_with(|value| *value).unwrap_or(false)
        && crate::worker_host::enabled()
        && Arc::ptr_eq(&sink, &state.sink)
        && allowed_tools.is_none() && !sidechat::is_side_run_id(&run_id)
        && !crate::leader::is_managed_child(&run_id)
        && computer_use != Some(true)
        && matches!(engine.as_str(), "claude" | "codex" | "agy" | "cursor")
        && wsl_transport::transport_for_workspace(&state.db, &workspace_path).is_none()
        && crate::leader::validate_worker_session(&state.db, &engine, session_id.as_deref()).is_ok()
    {
        return crate::worker_host::start(run_id, crate::task_worker::StartArgs {
            engine, workspace_path, session_id, prompt, image_paths, model, effort, permission,
            provider_id, computer_use, claude_ultracode, claude_haiku_assist,
            require_host_chat:true, require_leader:false,
        }).await;
    }
    if crate::worker_host::paused() { return Err("runtime_updating: task admission is paused briefly".into()); }
    // Reserve the run id atomically, before the first await: a contains_key
    // check here with the registry insert after spawn would let two
    // concurrent sends carrying the same client id both pass, and the second
    // insert would overwrite the first entry — orphaning its child (no key
    // routes an interrupt to it) and streaming two runs under one runId.
    // The placeholder owns the run's killed/reader_abort handles, so a Stop
    // landing inside the launch window still settles the turn; every error
    // path before the real registration drops the reservation.
    let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let reader_abort = Arc::new(std::sync::OnceLock::new());
    {
        let mut map = state.processes.0.lock().map_err(|e| e.to_string())?;
        if map.contains_key(&run_id) {
            return Err("run id already active".into());
        }
        if registry::active_run_count(&map) >= MAX_CONCURRENT_RUNS {
            return Err(format!(
                "too many concurrent runs ({MAX_CONCURRENT_RUNS}); wait for one to finish"
            ));
        }
        map.insert(
            run_id.clone(),
            ChildEntry {
                child: None,
                pid: 0,
                run_id: run_id.clone(),
                killed: Arc::clone(&killed),
                reader_abort: Arc::clone(&reader_abort),
                stdin: None,
                questions: Arc::new(Mutex::new(HashMap::new())),
                plans: Arc::new(Mutex::new(HashMap::new())),
                native_tasks: Default::default(),
                codex_control: None,
            },
        );
    }
    let reserved = run_id.clone();
    let mut reservation = SendReservation {
        processes: Arc::clone(&state.processes),
        run_id: reserved,
        committed: false,
        leader_registered: std::sync::atomic::AtomicBool::new(false),
        completion_registered: std::sync::atomic::AtomicBool::new(false),
    };
    let result = send_reserved(
        state,
        sink,
        engine,
        workspace_path,
        session_id,
        prompt,
        image_paths,
        model,
        effort,
        permission,
        provider_id,
        run_id,
        killed,
        reader_abort,
        computer_use,
        allowed_tools,
        &reservation.leader_registered,
        &reservation.completion_registered,
        claude_ultracode,
        claude_haiku_assist,
    )
    .await;
    reservation.committed = result.is_ok();
    result
}

// Launch futures can be dropped while waiting for a prior process or transport.
// Retire both fences on errors and cancellation, before a child is registered.
struct SendReservation {
    processes: Arc<ProcessRegistry>,
    run_id: String,
    committed: bool,
    // Set once this attempt's Leader registration succeeded. A rejected retry
    // must not retire the previous run's ledger entry: that would admit the
    // next retry early and let the old run's late finish retire the new one.
    leader_registered: std::sync::atomic::AtomicBool,
    completion_registered: std::sync::atomic::AtomicBool,
}

impl Drop for SendReservation {
    fn drop(&mut self) {
        if !self.committed {
            if self.leader_registered.load(std::sync::atomic::Ordering::SeqCst) {
                crate::host_chat::finish_run(&self.run_id);
            } else {
                // Detached workers do not register a Leader role, but may have
                // durably reserved a completion slot before their launch fails.
                if self.completion_registered.load(std::sync::atomic::Ordering::SeqCst)
                    && crate::assistant_notices::completion_outbox::finish_run(&self.run_id).is_err() {
                    eprintln!("[assistant-notices] completion launch cleanup failed");
                }
                crate::host_chat::abandon_launch(&self.run_id);
            }
            self.processes.remove_reservation(&self.run_id);
        }
    }
}
/// Body of [`send_message_inner`] once the run id is reserved: the caller id
/// is used as-is (never regenerated — the frontend pre-routes events by it),
/// and the placeholder's killed/reader_abort handles carry into the real
/// registry entry so an interrupt from the launch window is honored.
#[allow(clippy::too_many_arguments)]
async fn send_reserved(
    state: &crate::AppState,
    sink: Arc<event_sink::EventSink>,
    engine: String,
    workspace_path: String,
    session_id: Option<String>,
    prompt: String,
    image_paths: Option<Vec<String>>,
    model: Option<String>,
    effort: Option<String>,
    permission: Option<String>,
    provider_id: Option<String>,
    run_id: String,
    killed: Arc<std::sync::atomic::AtomicBool>,
    reader_abort: Arc<std::sync::OnceLock<tokio::task::AbortHandle>>,
    computer_use: Option<bool>,
    allowed_tools: Option<Vec<String>>,
    leader_registered: &std::sync::atomic::AtomicBool,
    completion_registered: &std::sync::atomic::AtomicBool,
    claude_ultracode: Option<bool>,
    claude_haiku_assist: Option<bool>,
) -> Result<SendResult, String> {
    // WSL 远程工作区:引擎进程经 ssh 在发行版内执行(见 wsl_transport)。
    let wsl_tp = wsl_transport::transport_for_workspace(&state.db, &workspace_path);
    if claude_haiku_assist == Some(true) {
        claude_haiku_assist::validate_scope(&engine, wsl_tp.is_some())?;
    }
    // This capability belongs to an ordinary local GUI chat, never a plugin
    // agent, mission node, remote CLI, or explicitly tool-constrained run.
    let is_side_run = sidechat::is_side_run_id(&run_id);
    let ordinary_local_chat = !is_side_run
        && matches!(engine.as_str(), "claude" | "codex" | "agy" | "cursor")
        && wsl_tp.is_none()
        && allowed_tools.is_none()
        && Arc::ptr_eq(&sink, &state.sink);
    let local_title_source = !is_side_run && wsl_tp.is_none() && allowed_tools.is_none()
        && Arc::ptr_eq(&sink, &state.sink)
        && crate::auto_title::origin::local_workspace(&state.db, &workspace_path);
    let session_id = session_id.filter(|session| !session.trim().is_empty());
    let detached_worker = DETACHED_WORKER_REQUEST.try_with(|value| *value).unwrap_or(false);
    if detached_worker {
        crate::leader::validate_worker_session(&state.db, &engine, session_id.as_deref())?;
    }
    if !ordinary_local_chat && !detached_worker && !is_side_run {
        crate::leader::prepare_isolated_run(
            &state.db, &run_id, &engine, session_id.as_deref(), &workspace_path,
            &killed,
        )?;
        leader_registered.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    let host_chat_server = if ordinary_local_chat {
        crate::host_chat::server_for_run(
            &run_id,
            &engine,
            session_id.as_deref(),
            &workspace_path,
        )?
    } else {
        None
    };
    let mut launch = prepare_launch(
        &engine,
        &workspace_path,
        session_id,
        prompt,
        image_paths,
        model,
        effort,
        permission,
        // Every user-granted directory rides along as a launch argument, so
        // a grant approved mid-conversation takes effect on the next send
        // (each send is a fresh process).
        state.db.granted_roots().unwrap_or_default(),
        provider_id,
        computer_use,
        allowed_tools,
        wsl_tp.is_some(),
        host_chat_server.as_ref(),
        claude_ultracode,
    )?;
    if is_side_run && engine == "claude" {
        let ephemeral = sidechat::is_ephemeral_run_id(&run_id);
        let fork_session = launch
            .req
            .session_id
            .as_deref()
            .is_some_and(|sid| ephemeral || !sidechat::is_hidden_session("claude", sid));
        sidechat::apply_claude_flags(&mut launch.built.command, fork_session, ephemeral);
        if fork_session {
            launch.built.preassigned_session_id = None;
            launch.req.session_id = None;
        }
    }
    if claude_haiku_assist == Some(true) {
        if let Err(error) = claude_haiku_assist::ensure_supported(&launch.bin).await {
            cleanup_staged_files(&launch.built.cleanup_files);
            if let Some(restore) = &launch.built.mcp_restore { restore.restore(); }
            return Err(error);
        }
        claude_haiku_assist::apply(&mut launch.built.command);
    }
    if ordinary_local_chat {
        let instructions = if detached_worker {
            Ok(crate::host_chat::worker_task_instructions())
        } else {
            crate::leader::prepare_run(
                &state.db,
                &run_id,
                &engine,
                launch.req.session_id.as_deref(),
                &workspace_path,
                launch.req.permission.as_deref(),
            )
        };
        if !detached_worker && instructions.is_ok() {
            leader_registered.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        let instructions = instructions.and_then(|instructions| {
            let instructions = host_instructions::with_chat_presentation(&engine, true, instructions);
            if engine == "claude" {
                if let Some(text) = instructions.as_deref() {
                    host_instructions::append_claude(&mut launch.built, text)?;
                }
            } else if engine == "agy" {
                if let Some(text) = instructions.as_deref() {
                    agy::append_host_instructions(&mut launch.built, text)?;
                }
            } else if engine == "cursor" {
                if let Some(text) = instructions.as_deref() {
                    cursor::append_host_instructions(&mut launch.built, text)?;
                }
            }
            Ok(instructions)
        });
        match instructions {
            Ok(instructions) => launch.req.host_instructions = instructions,
            Err(error) => {
                cleanup_staged_files(&launch.built.cleanup_files);
                if let Some(restore) = &launch.built.mcp_restore { restore.restore(); }
                return Err(error);
            }
        }
    }
    if local_title_source {
        crate::auto_title::origin::register_run(
            &run_id, &engine, &workspace_path, launch.req.session_id.as_deref(), &killed,
        );
    }
    mark_leader_child(&mut launch.built.command, &run_id);
    if mark_native_completion(&mut launch.built.command, &run_id, &engine, &launch.req, local_title_source, &killed) {
        completion_registered.store(true, std::sync::atomic::Ordering::SeqCst);
    }
    // Host-stream engines drive their own transport: no child process — the
    // registry entry only routes interrupts to the transport task. Their
    // drivers spawn locally, so a remote workspace either keeps the CLI
    // transport (codex/grok) or has no path at all — 显式拒绝。
    // OMP 的显式计划会话固定走 ACP 传输(elicitation.form 握手 + 计划文件
    // 全文,见 omp_acp.rs);其余 omp/pi 请求保持既有子进程路径,不迁移。
    if launch.engine_impl.transport_for(wsl_tp.is_some()) == Transport::Own
        || (engine == "omp" && pi_family::acp_plan_requested(&launch.req))
    {
        // 本机驱动没有远端路径:远程工作区显式拒绝(与旧行为一致),而不是
        // 静默起一个连不上远端工作区的本地会话。codex/grok 在上面退回 child。
        if wsl_tp.is_some() {
            return Err(format!("引擎 {engine} 不支持远程工作区(WSL)"));
        }
        // The child path resolves codex's provider credentials further down;
        // the app-server driver owns its own process, so it needs them here.
        if engine == "codex" && !codex_read_only::requested(&launch.req) {
            codex_provider_env::apply(&mut launch.built.command).await;
        }
        return send_host_stream(state, sink, launch, engine, run_id, killed, reader_abort).await;
    }
    if engine == "claude" {
        if let Some(session) = launch.req.session_id.clone() {
            if let Err(error) =
                wait_for_previous_process(&state.processes, &session, PREVIOUS_PROCESS_GRACE).await
            {
                cleanup_staged_files(&launch.built.cleanup_files);
                if let Some(restore) = &launch.built.mcp_restore {
                    restore.restore();
                }
                return Err(error);
            }
        }
    }
    let (mut command, extra_cleanup, skip_local_cwd) = match &wsl_tp {
        Some(tp) => {
            // 操作电脑注入的是本机 .omp/mcp.json 与本机 exe:WSL 远端 omp 都
            // 用不上,先恢复再拒绝,不留下被改过的工作区文件。
            if let Some(restore) = &launch.built.mcp_restore {
                restore.restore();
                return Err("操作电脑不支持远程工作区(WSL):注入的是本机驱动".into());
            }
            // 依赖本机 staging 文件的引擎(grok 等 cleanup_files 非空):
            // 远端 CLI 读不到本机文件,直接拒绝而非跑出莫名其妙的失败;
            // 已写盘的 staging 文件顺手清掉,不 strand。
            if !launch.built.cleanup_files.is_empty() {
                for path in &launch.built.cleanup_files {
                    let _ = std::fs::remove_file(path);
                }
                return Err(format!(
                    "引擎 {engine} 不支持远程工作区(WSL):依赖本机临时文件"
                ));
            }
            match wsl_transport::wrap(launch.built.command, tp).await {
                Ok(wrapped) => (
                    wrapped.command,
                    wrapped.cleanup_files,
                    wrapped.skip_local_cwd,
                ),
                Err(error) => {
                    // wrap 失败(ssh 上传失败等)同样不许 strand staging 文件。
                    for path in &launch.built.cleanup_files {
                        let _ = std::fs::remove_file(path);
                    }
                    return Err(error);
                }
            }
        }
        None => (launch.built.command, Vec::new(), false),
    };
    let mut cleanup_files = launch.built.cleanup_files;
    cleanup_files.extend(extra_cleanup);
    // 本地 env 不跨 ssh:WSL 分支的 command 是本地 ssh 进程,apply 无意义
    // (还白跑一次登录 shell 解析);远端 codex 用发行版自己的配置。
    if engine == "codex" && wsl_tp.is_none() {
        // v1.0.0 switched codex to `codex exec --json`: a CLI that predates
        // the exec transport exits 1 before any event, surfacing as a bare
        // "exit code: 1" banner. Fail fast with an actionable message.
        codex::check_exec_support(&launch.bin, launch.req.session_id.is_some()).await?;
        codex_provider_env::apply(&mut command).await;
    }
    command
        .stdin(
            if launch.built.stdin_payload.is_some() || launch.built.keep_stdin_open {
                std::process::Stdio::piped()
            } else {
                std::process::Stdio::null()
            },
        )
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    // 远程工作区路径在本机不存在 → cwd 落本地当前目录(wsl.exe/ssh 不关心)。
    if skip_local_cwd {
        command.current_dir(wsl_transport::fallback_cwd());
    } else {
        command.current_dir(&launch.req.workspace);
    }
    // Own process group so interrupt can kill the whole tree (grandchildren
    // inherit the stdout pipe and would otherwise block EOF forever).
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    hide_console(&mut command);
    // Shebang shims (`#!/usr/bin/env node`) need the CLI search dirs in
    // PATH: when adopt_login_shell_path failed/timed out, the process PATH
    // is a stale launchd snapshot and an absolute shim path alone cannot
    // find the interpreter. Same dirs find_cli_binary searched; appended
    // after the process PATH, so normal resolution order is unchanged.
    // Harmless for the WSL/ssh-wrapped command (local env doesn't cross).
    command.env("PATH", resolve::cli_search_path());
    crate::development_profile::enforce_homes(&mut command);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            // Never strand the staging files build_command wrote (grok).
            cleanup_staged_files(&cleanup_files);
            if let Some(restore) = &launch.built.mcp_restore {
                restore.restore();
            }
            return Err(format!("failed to spawn {}: {error}", launch.bin));
        }
    };

    let kept_stdin = spawn_stdin_writer(
        &mut child,
        launch.built.stdin_payload,
        launch.built.keep_stdin_open,
    );
    let questions: Arc<Mutex<HashMap<String, Value>>> = Arc::new(Mutex::new(HashMap::new()));
    let plans: Arc<Mutex<HashMap<String, Value>>> = Arc::new(Mutex::new(HashMap::new()));
    let native_tasks = Arc::new(native_task_control::NativeTaskControl::default());

    // The reserved caller id keys the real entry too: inserting under the
    // same run_id replaces the placeholder, and the shared killed/reader_abort
    // Arcs keep interrupts from the launch window routed to this child.
    // Join a kill-on-close job before the run can settle: an orphaned
    // grandchild (claude's pwsh.exe/conhost.exe) must die with the run's
    // context, not accumulate outside every tree taskkill can still walk.
    #[cfg(windows)]
    let tree_guard = job::assign_kill_on_close(&child);
    let pid = child.id().unwrap_or(0);
    // Detach both pipes while we still own the child outright. A missing pipe
    // after spawn is fatal: kill the child so it cannot run unobserved and
    // unregistered.
    let (stdout, stderr) = {
        let pipes = child.stdout.take().zip(child.stderr.take());
        match pipes {
            Some(pair) => pair,
            None => {
                let _ = child.start_kill();
                cleanup_staged_files(&cleanup_files);
                if let Some(restore) = &launch.built.mcp_restore {
                    restore.restore();
                }
                return Err("missing stdout/stderr pipe after spawn".to_string());
            }
        }
    };
    let child = Arc::new(TokioMutex::new(child));
    state.processes.insert(
        run_id.clone(),
        ChildEntry {
            child: Some(Arc::clone(&child)),
            pid,
            run_id: run_id.clone(),
            killed: Arc::clone(&killed),
            reader_abort: Arc::clone(&reader_abort),
            stdin: kept_stdin.clone(),
            questions: Arc::clone(&questions),
            plans: Arc::clone(&plans),
            native_tasks: Arc::clone(&native_tasks),
            codex_control: None,
        },
    );
    if let Some(session_id) = launch.built.preassigned_session_id.as_deref() {
        state.processes.insert_alias(
            session_id.to_string(),
            ChildEntry {
                child: Some(Arc::clone(&child)),
                pid,
                run_id: run_id.clone(),
                killed: Arc::clone(&killed),
                reader_abort: Arc::clone(&reader_abort),
                stdin: kept_stdin.clone(),
                questions: Arc::clone(&questions),
                plans: Arc::clone(&plans),
                native_tasks: Arc::clone(&native_tasks),
                codex_control: None,
            },
        );
    }

    let stderr_buf = spawn_stderr_capture(stderr);
    let initial_model = if engine == "claude" {
        launch
            .req
            .model
            .clone()
            .or_else(|| Some(models::resolve_claude_launch_model("default")))
            .filter(|m| !m.is_empty())
    } else {
        launch.req.model.clone()
    };
    let initial_effort = if engine == "agy" {
        agy::effort_flag(
            launch.req.effort.as_deref(),
            initial_model.as_deref().unwrap_or(""),
        )
        .map(str::to_string)
    } else {
        launch.req.effort.clone().filter(|e| !e.trim().is_empty())
    };
    // MCP runtime snapshots are workspace-scoped; the event dispatcher only
    // has the run id, so remember the mapping for the run's lifetime.
    crate::mcp::register_run(&run_id, &launch.req.workspace.to_string_lossy());
    let ctx = RunContext {
        core: TurnCore {
            sink: Arc::clone(&sink),
            registry: Arc::clone(&state.processes),
            engine_id: engine.clone(),
            run_id: run_id.clone(),
            db: Some(Arc::clone(&state.db)),
        },
        engine_impl: launch.engine_impl,
        pid,
        preassigned_session_id: launch.built.preassigned_session_id.clone(),
        initial_model,
        initial_effort,
        child,
        killed,
        cleanup_files,
        mcp_restore: launch.built.mcp_restore,
        stderr_buf,
        stdout_plain_buf: Arc::new(Mutex::new(String::new())),
        #[cfg(windows)]
        _tree_guard: tree_guard,
    };
    let reader = tokio::spawn(run_reader(stdout, ctx));
    // Registration order is unchanged (entries land before the task can
    // settle); the OnceLock just hands kill()/kill_all() the handle.
    let _ = reader_abort.set(reader.abort_handle());

    Ok(SendResult {
        run_id,
        session_id: launch.built.preassigned_session_id,
    })
}
/// Virtual run path for engines that drive their own transport
/// ([`Engine::drives_own_transport`]): register a child-less entry whose
/// `killed` flag and abort handle route interrupts into the transport task,
/// then detach it. The task dispatches the same event kinds as `run_reader`
/// and settles the turn itself (done/error + registry cleanup).
async fn send_host_stream(
    state: &crate::AppState,
    sink: Arc<event_sink::EventSink>,
    launch: Launch,
    engine: String,
    run_id: String,
    killed: Arc<std::sync::atomic::AtomicBool>,
    reader_abort: Arc<std::sync::OnceLock<tokio::task::AbortHandle>>,
) -> Result<SendResult, String> {
    let pid = next_virtual_pid();
    let entry = ChildEntry {
        child: None,
        pid,
        run_id: run_id.clone(),
        killed: Arc::clone(&killed),
        reader_abort: Arc::clone(&reader_abort),
        stdin: None,
        questions: Arc::new(Mutex::new(HashMap::new())),
        plans: Arc::new(Mutex::new(HashMap::new())),
        native_tasks: Default::default(),
        codex_control: None,
    };
    state.processes.insert(run_id.clone(), entry.clone());
    if let Some(session_id) = launch.req.session_id.as_deref() {
        // A resumed host session is keyed up front (same contract as grok's
        // preassigned id): interrupt by conversation session id must route.
        state.processes.insert_alias(session_id.to_string(), entry);
    }

    // Plugin agents and mission nodes stream on their own sinks.
    let chat = Arc::ptr_eq(&sink, &state.sink) && !sidechat::is_side_run_id(&run_id);
    let core = TurnCore {
        sink,
        registry: Arc::clone(&state.processes),
        engine_id: engine.clone(),
        run_id: run_id.clone(),
        db: Some(Arc::clone(&state.db)),
    };
    let resume_session_id = launch.req.session_id.clone();
    let task = match engine.as_str() {
        "dsh" => tokio::spawn(dsh_session::run_host_turn(
            core,
            launch.req,
            state.dsh_host.clone(),
            killed,
            pid,
        )),
        "opencode" => tokio::spawn(opencode_session::run_server_turn(
            core,
            launch.req,
            launch.bin,
            state.opencode_server.clone(),
            killed,
            pid,
        )),
        "qoder" | "qoder-cn" => tokio::spawn(qoder_session::run_acp_turn(
            core, launch.req, launch.bin, killed, pid,
        )),
        "grok" | "kimi" => tokio::spawn(grok_acp::run_acp_turn(
            core,
            launch.req,
            launch.built,
            killed,
            pid,
        )),
        "codex" => tokio::spawn(codex_app::run_app_server_turn(
            core,
            launch.req,
            launch.built,
            killed,
            pid,
            chat,
        )),
        "omp" => tokio::spawn(pi_family::omp_acp::run_acp_turn(
            core,
            launch.req,
            launch.built,
            killed,
            pid,
        )),
        _ => unreachable!("send_host_stream only routes drives_own_transport engines: {engine}"),
    };
    let _ = reader_abort.set(task.abort_handle());
    Ok(SendResult {
        run_id,
        session_id: resume_session_id,
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn send_side_message_inner(
    state: &crate::AppState,
    engine: String,
    workspace_path: String,
    parent_session_id: Option<String>,
    side_session_id: Option<String>,
    prompt: String,
    image_paths: Option<Vec<String>>,
    ephemeral: bool,
    fallback_transcript: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    provider_id: Option<String>,
    run_id: Option<String>,
) -> Result<SendResult, String> {
    if !sidechat::is_supported_engine(&engine) {
        return Err(format!(
            "引擎 {engine} 暂不支持 /btw 与 /sidechat（目前仅支持 claude、codex、agy、cursor）"
        ));
    }
    if prompt.trim().is_empty() && image_paths.as_ref().is_none_or(Vec::is_empty) {
        return Err("Sidechat question is empty".into());
    }
    let prefix = if ephemeral {
        sidechat::BTW_RUN_PREFIX
    } else {
        sidechat::SIDECHAT_RUN_PREFIX
    };
    let run_id = match run_id.map(|r| r.trim().to_string()).filter(|r| !r.is_empty()) {
        Some(r) if r.starts_with(prefix) => r,
        Some(r) => {
            let bare = r
                .strip_prefix(sidechat::BTW_RUN_PREFIX)
                .or_else(|| r.strip_prefix(sidechat::SIDECHAT_RUN_PREFIX))
                .unwrap_or(&r);
            format!("{prefix}{bare}")
        }
        None => format!("{prefix}{}", uuid::Uuid::new_v4()),
    };
    let parent_session_id = parent_session_id
        .map(|s| s.trim().to_string())
        .filter(|s| sidechat::is_safe_session_id(s));
    let side_session_id = side_session_id
        .map(|s| s.trim().to_string())
        .filter(|s| sidechat::is_safe_session_id(s));
    if ephemeral && side_session_id.is_some() {
        return Err("An ephemeral side question cannot resume a persistent Sidechat session".into());
    }
    let owner = sidechat::SideSessionOwner {
        engine: engine.clone(), workspace_path: workspace_path.clone(), parent_session_id: parent_session_id.clone(),
    };
    if let Some(sid) = side_session_id.as_deref() {
        sidechat::validate_session_owner(&owner, sid, Some(&state.db))?;
        if state.processes.get(sid).is_some_and(|e| !e.killed.load(std::sync::atomic::Ordering::SeqCst)) { return Err("Sidechat session is already running".into()); }
    }
    sidechat::begin_run(&run_id, owner, Some(Arc::clone(&state.db)))?;
    if let Some(sid) = side_session_id.as_deref() {
        if let Err(error) = sidechat::register_owned_session(&run_id, sid, Some(&state.db)) {
            sidechat::finish_run(&run_id);
            return Err(error);
        }
    }
    let result = async {
    let permission = match engine.as_str() {
        "claude" => Some("manual".to_string()),
        "codex" => Some("manual".to_string()),
        "agy" => Some("plan".to_string()),
        "cursor" => Some("ask".to_string()),
        _ => None,
    };

    let (effective_session_id, use_fallback_transcript, pre_forked_session_id) =
        if !ephemeral && side_session_id.is_some() {
            let sid = side_session_id.unwrap();
            if engine == "codex" {
                sidechat::set_codex_spec(
                    &run_id,
                    sidechat::CodexSideSpec {
                        fork_from: None,
                        ephemeral: false,
                        fallback_prompt: None,
                    },
                );
            }
            (Some(sid), false, None)
        } else {
            match engine.as_str() {
                "claude" => {
                    let can_fork = parent_session_id.as_deref().is_some_and(|pid| {
                        sidechat::claude_session_exists(
                            &engine_home(Some("CLAUDE_CONFIG_DIR"), ".claude"),
                            std::path::Path::new(&workspace_path),
                            pid,
                            Some(&state.db),
                        )
                    });
                    if can_fork {
                        (parent_session_id, false, None)
                    } else {
                        (None, true, None)
                    }
                }
                "codex" => {
                    let can_fork = parent_session_id
                        .as_deref()
                        .is_some_and(|pid| sidechat::codex_session_exists(pid, Some(&state.db)));
                    sidechat::set_codex_spec(
                        &run_id,
                        sidechat::CodexSideSpec {
                            fork_from: if can_fork { parent_session_id } else { None },
                            ephemeral,
                            fallback_prompt: None,
                        },
                    );
                    (None, !can_fork, None)
                }
                "agy" => {
                    if let Some(pid) = parent_session_id {
                        let fork_res = tauri::async_runtime::spawn_blocking(move || {
                            sidechat::fork_agy_conversation(&pid)
                        })
                        .await
                        .map_err(|e| e.to_string())?;
                        match fork_res {
                            Ok(forked_id) => {
                                if let Err(error) = sidechat::register_owned_session(&run_id, &forked_id, Some(&state.db)) {
                                    sidechat::cleanup_agy_session_in(&agy::agy_home(), &forked_id);
                                    return Err(error);
                                }
                                (Some(forked_id.clone()), false, Some(forked_id))
                            }
                            Err(_) => (None, true, None),
                        }
                    } else {
                        (None, true, None)
                    }
                }
                "cursor" => {
                    if let Some(pid) = parent_session_id {
                        let fork_res = tauri::async_runtime::spawn_blocking(move || {
                            sidechat::fork_cursor_conversation(&pid)
                        })
                        .await
                        .map_err(|e| e.to_string())?;
                        match fork_res {
                            Ok(forked_id) => {
                                if let Err(error) = sidechat::register_owned_session(&run_id, &forked_id, Some(&state.db)) {
                                    sidechat::cleanup_cursor_session_in(&cursor::cursor_home(), &forked_id);
                                    return Err(error);
                                }
                                (Some(forked_id.clone()), false, Some(forked_id))
                            }
                            Err(_) => (None, true, None),
                        }
                    } else {
                        (None, true, None)
                    }
                }
                _ => (None, true, None),
            }
        };

    let formatted_prompt = sidechat::format_side_prompt(
        &prompt,
        ephemeral,
        if use_fallback_transcript {
            fallback_transcript.as_deref()
        } else {
            None
        },
    );

    let result = if let Err(error) = sidechat::run_owner(&run_id) {
        Err(error)
    } else { send_message_inner_with_sink(
        state,
        Arc::clone(&state.sink),
        engine.clone(),
        workspace_path,
        effective_session_id,
        formatted_prompt,
        image_paths,
        model,
        effort,
        permission,
        provider_id,
        Some(run_id.clone()),
        Some(false),
        None,
        Some(false),
        Some(false),
    )
    .await };

    if let Ok(sent) = &result {
        if let Some(sid) = sent.session_id.as_deref() {
            let _ = sidechat::register_owned_session(&run_id, sid, Some(&state.db));
        }
    }
    if result.is_ok() && sidechat::run_owner(&run_id).is_err() {
        let registry = Arc::clone(&state.processes);
        let stopped_run = run_id.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || registry.kill(&stopped_run)).await;
    }

    if result.is_err() {
        sidechat::remove_codex_spec(&run_id);
        if pre_forked_session_id.is_some() {
            sidechat::spawn_ephemeral_cleanup(
                Some(Arc::clone(&state.db)),
                engine.clone(),
                pre_forked_session_id,
            );
        }
    }
    result
    }.await;
    if result.is_err() { sidechat::finish_run(&run_id); }
    result
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn send_side_message(
    state: tauri::State<'_, crate::AppState>,
    engine: String,
    workspace_path: String,
    parent_session_id: Option<String>,
    side_session_id: Option<String>,
    prompt: String,
    image_paths: Option<Vec<String>>,
    ephemeral: bool,
    fallback_transcript: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    provider_id: Option<String>,
    run_id: Option<String>,
) -> Result<SendResult, String> {
    send_side_message_inner(
        &state,
        engine,
        workspace_path,
        parent_session_id,
        side_session_id,
        prompt,
        image_paths,
        ephemeral,
        fallback_transcript,
        model,
        effort,
        provider_id,
        run_id,
    )
    .await
}

pub(crate) async fn cleanup_side_session_inner(
    state: &crate::AppState,
    engine: String,
    session_id: String,
    workspace_path: String,
    parent_session_id: Option<String>,
) -> Result<(), String> {
    let sid = session_id.trim().to_string();
    if sid.is_empty() || !sidechat::is_safe_session_id(&sid) {
        return Err("Invalid Sidechat session ID".into());
    }
    let owner = sidechat::SideSessionOwner { engine: engine.clone(), workspace_path, parent_session_id };
    sidechat::ensure_hidden_loaded(&state.db);
    // Cleanup is idempotent after the ephemeral reader has already retired
    // this identity. Crucially, no process or file is touched in this case.
    if !sidechat::is_hidden_session(&engine, &sid) { return Ok(()); }
    sidechat::validate_session_owner(&owner, &sid, Some(&state.db))?;
    let registry = Arc::clone(&state.processes);
    let db = Arc::clone(&state.db);
    tauri::async_runtime::spawn_blocking(move || {
        let _ = registry.kill(&sid);
        sidechat::cleanup_side_session_blocking(Some(&db), &engine, &sid)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cleanup_side_session(
    state: tauri::State<'_, crate::AppState>,
    engine: String,
    session_id: String,
    workspace_path: String,
    parent_session_id: Option<String>,
) -> Result<(), String> {
    cleanup_side_session_inner(&state, engine, session_id, workspace_path, parent_session_id).await
}

pub(crate) fn promote_side_session_inner(
    state: &crate::AppState,
    engine: String,
    session_id: String,
    workspace_path: String,
    parent_session_id: Option<String>,
) -> Result<(), String> {
    let sid = session_id.trim();
    if sid.is_empty() || !sidechat::is_safe_session_id(sid) {
        return Err("无效的会话 ID".into());
    }
    let owner = sidechat::SideSessionOwner { engine: engine.clone(), workspace_path, parent_session_id };
    sidechat::validate_session_owner(&owner, sid, Some(&state.db))?;
    if state.processes.get(sid).is_some() { return Err("Stop Sidechat before promoting it".into()); }
    sidechat::unregister_hidden_session(&engine, sid, Some(&state.db));
    Ok(())
}

#[tauri::command]
pub fn promote_side_session(
    state: tauri::State<'_, crate::AppState>,
    engine: String,
    session_id: String,
    workspace_path: String,
    parent_session_id: Option<String>,
) -> Result<(), String> {
    promote_side_session_inner(&state, engine, session_id, workspace_path, parent_session_id)
}
/// Async + spawn_blocking: the kill waits for the Windows tree walk to
/// finish (see `kill_process_group`), and a synchronous command would hold
/// that wait on the UI thread — the app would visibly hitch on every Stop.
#[tauri::command]
pub async fn interrupt_session(
    state: tauri::State<'_, crate::AppState>,
    session_id: String,
) -> Result<bool, String> {
    sidechat::cancel_run(&session_id);
    if let Some(outcome) = crate::worker_host::control(&session_id, &uuid::Uuid::new_v4().to_string(), crate::task_worker::Command::Interrupt).await {
        return outcome.and_then(|value| serde_json::from_value(value).map_err(|_| "Invalid worker interrupt result".into()));
    }
    let registry = Arc::clone(&state.processes);
    tauri::async_runtime::spawn_blocking(move || registry.kill(&session_id))
        .await
        .map_err(|e| e.to_string())
}

/// `request_id` prefix of the interrupt `control_request` this app writes:
/// the reader recognises the CLI's acknowledgement (`control_response` with
/// the same id, then an `error_during_execution` result) by it.
pub(crate) const INTERRUPT_REQUEST_ID_PREFIX: &str = "ccgui-interrupt-";

/// Read-only verification before the UI retires a long-silent run. Returning
/// an error must preserve the UI route; an unavailable registry is not empty.
#[tauri::command]
pub fn active_run_ids(
    state: tauri::State<'_, crate::AppState>,
    run_ids: Vec<String>,
) -> Result<Vec<String>, String> {
    let mut active = state.processes.active_run_ids(&run_ids)?;
    for id in crate::worker_host::active_aliases(&run_ids) { if !active.contains(&id) { active.push(id); } }
    Ok(active)
}

/// The native Esc: interrupts only the CLI's current response; background
/// tasks and the process survive (unlike `interrupt_session`, which kills).
/// The id only needs to be unique within one CLI process.
fn interrupt_frame() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    serde_json::json!({
        "type": "control_request",
        "request_id": format!("{INTERRUPT_REQUEST_ID_PREFIX}{id}"),
        "request": { "subtype": "interrupt" },
    })
    .to_string()
}

/// Body of `send_follow_up`: steer an active native Codex turn, or deliver a
/// user message to a LIVE native Claude CLI with background tasks. Codex
/// success requires the matching app-server acknowledgement. `Ok(false)` =
/// nothing live can take it (unsupported engine or unknown/stopped run), and
/// the caller falls back to an ordinary send; `Err` = a failure the user
/// must see (image load, pipe write). One `write_frame` per message: a
/// follow-up cannot interleave with a concurrent answer/interrupt frame.
pub(crate) async fn send_follow_up_inner(
    registry: &ProcessRegistry,
    key: &str,
    engine: &str,
    workspace: &Path,
    prompt: &str,
    images: &[String],
) -> Result<bool, String> {
    if let Some(outcome) = crate::worker_host::control(key, &uuid::Uuid::new_v4().to_string(), crate::task_worker::Command::Followup {
        prompt:prompt.into(), image_paths:Some(images.to_vec()),
    }).await {
        return outcome.and_then(|value| serde_json::from_value(value).map_err(|_| "Invalid worker follow-up result".into()));
    }
    if engine == "codex" {
        return codex_app::send_steer(registry, key, workspace, prompt, images).await;
    }
    if engine != "claude" {
        return Ok(false);
    }
    // Liveness before the (possibly multi-MB) image read: a dead run falls
    // back to an ordinary send, which reports a bad image itself.
    let Some(entry) = registry.get_live(key) else {
        return Ok(false);
    };
    if prompt.trim().is_empty() && images.is_empty() {
        return Err("the follow-up message is empty".to_string());
    }
    // Same payload as the launch prompt: images first, then the text.
    let line = images::claude_stdin_message(prompt, images, workspace)?;
    match entry.write_frame(&line).await {
        Ok(()) => Ok(true),
        Err(error) if error.is_unavailable() => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

/// Body of `interrupt_turn`: write the native interrupt to a live claude
/// CLI. `Ok(false)` means no live process can accept the frame. A write
/// failure or timeout is `Err`, so the caller can surface it and retry while
/// leaving the process and its background tasks alive.
pub(crate) async fn interrupt_turn_inner(
    registry: &ProcessRegistry,
    key: &str,
) -> Result<bool, String> {
    if let Some(outcome) = crate::worker_host::control(key, &uuid::Uuid::new_v4().to_string(), crate::task_worker::Command::InterruptTurn).await {
        return outcome.and_then(|value| serde_json::from_value(value).map_err(|_| "Invalid worker interrupt result".into()));
    }
    interrupt_turn_within(registry, key, INTERRUPT_WRITE_TIMEOUT).await
}

/// How long Stop waits for the interrupt frame to reach the pipe. Normally
/// milliseconds; it only runs out when the CLI stopped reading stdin (a
/// multi-MB follow-up still blocked in the pipe holds the writer), and Stop
/// must stay responsive then. A timeout reports an error without killing
/// the CLI; an already queued atomic write may still complete later.
const INTERRUPT_WRITE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

async fn interrupt_turn_within(
    registry: &ProcessRegistry,
    key: &str,
    limit: std::time::Duration,
) -> Result<bool, String> {
    let Some(entry) = registry.get_live(key) else {
        return Ok(false);
    };
    let frame = interrupt_frame();
    match tokio::time::timeout(limit, entry.write_frame(&frame)).await {
        Ok(Ok(())) => Ok(true),
        Ok(Err(error)) if error.is_unavailable() => Ok(false),
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => Err("native interrupt timed out while waiting to write to the session's stdin".to_string()),
    }
}

/// Steer an active Codex turn or send a message into a live native Claude run
/// with background tasks. Accepts either the run id
/// or the conversation session id, like `interrupt_session`.
#[tauri::command]
pub async fn send_follow_up(
    state: tauri::State<'_, crate::AppState>,
    session_id: String,
    engine: String,
    workspace_path: String,
    prompt: String,
    image_paths: Option<Vec<String>>,
) -> Result<bool, String> {
    send_follow_up_inner(
        &state.processes,
        &session_id,
        &engine,
        Path::new(&workspace_path),
        &prompt,
        image_paths.as_deref().unwrap_or(&[]),
    )
    .await
}

/// Interrupt only the current native response (Stop/Esc): the process and
/// its background tasks stay alive. Accepts a run id or session id;
/// `Ok(false)` means no live process can accept input, while `Err` is a
/// delivery failure that the caller should surface for retry.
#[tauri::command]
pub async fn interrupt_turn(
    state: tauri::State<'_, crate::AppState>,
    session_id: String,
) -> Result<bool, String> {
    interrupt_turn_inner(&state.processes, &session_id).await
}

/// Stop only the selected task in its original native run. The adapter must
/// confirm a terminal task status; writing the request alone is not success.
#[tauri::command]
pub async fn stop_native_task(
    state: tauri::State<'_, crate::AppState>,
    run_id: String,
    task_id: String,
) -> Result<NativeTaskStopResult, String> {
    stop_native_task_inner(&state.processes, &run_id, &task_id).await
}

pub(crate) async fn stop_native_task_inner(
    processes: &ProcessRegistry,
    run_id: &str,
    task_id: &str,
) -> Result<NativeTaskStopResult, String> {
    if let Some(outcome) = crate::worker_host::control(run_id, &uuid::Uuid::new_v4().to_string(), crate::task_worker::Command::StopTask { task_id:task_id.into() }).await {
        let value = outcome?;
        return Ok(NativeTaskStopResult {
            task_id:value["taskId"].as_str().ok_or("Invalid worker task result")?.into(),
            status:value["status"].as_str().ok_or("Invalid worker task result")?.into(),
        });
    }
    native_task_control::stop_native_task_inner(processes, run_id, task_id).await
}

/// Answer a pending question card. Five transports share this command:
/// - claude (control protocol): the answers merge into the parked tool input
///   and ride stdin as a `control_response`.
/// - omp (rpc-ui): the parked value carries the dialog method; the answer is
///   an `extension_ui_response` frame on the CLI's stdin.
/// - dsh (host session): the parked value is an answer context (origin +
///   clientId + eventId + original request); the answer is an HTTP
///   `$events/result` outcome.
/// - grok (ACP) and codex (app-server): the parked value carries the server
///   request's JSON-RPC id — codex additionally the question-text→id map its
///   protocol answers by; the answer is the response frame on the CLI's stdin.
/// `answers` maps each question's text to the chosen option label — an array
/// of labels for multiSelect questions. `None` means the user
/// skipped/dismissed. Accepts either the run id or the conversation session
/// id, like `interrupt_session`.
#[tauri::command]
pub async fn answer_question(
    state: tauri::State<'_, crate::AppState>,
    session_id: String,
    request_id: String,
    answers: Option<Value>,
) -> Result<(), String> {
    answer_question_inner(&state, session_id, request_id, answers).await
}

pub(crate) async fn answer_question_inner(
    state: &crate::AppState,
    session_id: String,
    request_id: String,
    answers: Option<Value>,
) -> Result<(), String> {
    if let Some(outcome) = crate::worker_host::control(&session_id, &uuid::Uuid::new_v4().to_string(), crate::task_worker::Command::AnswerQuestion {
        question_id:request_id.clone(), answers:answers.clone(),
    }).await { return outcome.map(|_| ()); }
    let entry = state
        .processes
        .get(&session_id)
        .ok_or_else(|| "no running session for this answer".to_string())?;
    // Peek, don't remove: a failed write leaves the question parked so the
    // user can retry (or the EOF drain settles the card honestly).
    let input = entry
        .questions
        .lock()
        .map_err(|_| "question state is poisoned".to_string())?
        .get(&request_id)
        .cloned()
        .ok_or_else(|| "question is no longer pending".to_string())?;
    if let Some(context) = input.get("kimiAcp") {
        let frame = kimi_acp::answer_frame(context, answers.as_ref())?;
        state
            .processes
            .write_line(&session_id, frame.to_string())
            .await?;
        if let Ok(mut questions) = entry.questions.lock() {
            questions.remove(&request_id);
        }
        return Ok(());
    }
    // grok's ACP driver parks the server's `_x.ai/ask_user_question` request:
    // the answer is the JSON-RPC response line on the CLI's stdin.
    if let Some(acp) = input.get("grokAcp") {
        let frame = grok_acp::answer_frame(acp, answers.as_ref())?;
        state
            .processes
            .write_line(&session_id, frame.to_string())
            .await?;
        if let Ok(mut questions) = entry.questions.lock() {
            questions.remove(&request_id);
        }
        return Ok(());
    }
    // codex's app-server driver parks `item/tool/requestUserInput`: same stdin
    // response, but its answer map is keyed by the question ids the server
    // issued — the card answers by question text.
    if input.get("codexApproval").is_some() {
        return codex_app::answer_approval(&state.processes, &session_id, &request_id, answers.as_ref()).await;
    }
    if let Some(app) = input.get("codexApp") {
        let frame = codex_app::answer_frame(app, answers.as_ref())?;
        state
            .processes
            .write_line(&session_id, frame.to_string())
            .await?;
        if let Ok(mut questions) = entry.questions.lock() {
            questions.remove(&request_id);
        }
        return Ok(());
    }
    // pi/omp rpc sessions park the render input plus the dialog method: the
    // answer is an extension_ui_response frame on the CLI's stdin.
    if let Some(extui) = input.get("extui") {
        let method = extui.get("method").and_then(Value::as_str).unwrap_or("");
        let frame = pi_family::extension_ui_answer_frame(method, &request_id, answers.as_ref());
        // A failed write must surface: the frontend keeps the card pending on
        // Err instead of falsely marking the question answered.
        state
            .processes
            .write_line(&session_id, frame.to_string())
            .await?;
        if let Ok(mut questions) = entry.questions.lock() {
            questions.remove(&request_id);
        }
        return Ok(());
    }
    // opencode attached sessions park an answer context: the reply is an HTTP
    // POST to the managed server, not a stdin line.
    if let Some(opencode) = input.get("opencode") {
        let origin = opencode
            .get("origin")
            .and_then(Value::as_str)
            .ok_or_else(|| "question answer context is missing the server origin".to_string())?;
        let directory = opencode
            .get("directory")
            .and_then(Value::as_str)
            .unwrap_or("");
        let request_id = opencode
            .get("requestId")
            .and_then(Value::as_str)
            .ok_or_else(|| "question answer context is missing the request id".to_string())?;
        let request = opencode.get("request").cloned().unwrap_or(Value::Null);
        // 忽略 = reject(工具侧抛 QuestionRejectedError,模型得到「用户拒绝
        // 回答」并继续);否则 reply,answers 与 questions 同序。
        let result = match answers.as_ref() {
            None => {
                opencode_server::post(
                    origin,
                    &format!("/question/{request_id}/reject"),
                    directory,
                    None,
                )
                .await
            }
            Some(answers) => {
                let answers = opencode_session::reply_answers(&request, answers)
                    .ok_or_else(|| "question answer context is malformed".to_string())?;
                opencode_server::post(
                    origin,
                    &format!("/question/{request_id}/reply"),
                    directory,
                    Some(serde_json::json!({ "answers": answers })),
                )
                .await
            }
        };
        // A failed post must surface: the frontend keeps the card pending on
        // Err instead of falsely marking the question answered.
        result?;
        if let Ok(mut questions) = entry.questions.lock() {
            questions.remove(request_id);
        }
        return Ok(());
    }
    // dsh host sessions park an answer context instead of a tool input: the
    // answer is an HTTP outcome, not a stdin line.
    if let Some(dsh) = input.get("dsh") {
        let origin = dsh
            .get("origin")
            .and_then(Value::as_str)
            .ok_or_else(|| "question answer context is missing the host origin".to_string())?;
        let client_id = dsh
            .get("clientId")
            .and_then(Value::as_str)
            .ok_or_else(|| "question answer context is missing the events client id".to_string())?;
        let event_id = dsh
            .get("eventId")
            .and_then(Value::as_str)
            .ok_or_else(|| "question answer context is missing the event id".to_string())?;
        let request = dsh.get("request").cloned().unwrap_or(Value::Null);
        let outcome = dsh_session::question_outcome(&request, answers.as_ref());
        // A failed post must surface: the frontend keeps the card pending on
        // Err instead of falsely marking the question answered.
        crate::dsh_host::host_call(
            origin,
            "$events/result",
            serde_json::json!({
                "clientId": client_id,
                "eventId": event_id,
                "outcome": outcome,
            }),
        )
        .await?;
        // Delivered: drop the parked copy so the turn-end drain skips it.
        if let Ok(mut questions) = entry.questions.lock() {
            questions.remove(&request_id);
        }
        return Ok(());
    }
    let mut updated = match input {
        Value::Object(map) => map,
        // Defensive: a non-object input cannot merge answers; rebuild the
        // minimal shape the question reader expects.
        questions => {
            let mut map = serde_json::Map::new();
            map.insert("questions".to_string(), questions);
            map
        }
    };
    if let Some(answers) = answers {
        updated.insert("answers".to_string(), answers);
    }
    let line = serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": { "behavior": "allow", "updatedInput": Value::Object(updated) },
        },
    })
    .to_string();
    // A failed write must surface: the frontend keeps the card pending on
    // Err instead of falsely marking the question answered.
    state.processes.write_line(&session_id, line).await?;
    // Delivered: drop the parked copy so the EOF drain skips it.
    if let Ok(mut questions) = entry.questions.lock() {
        questions.remove(&request_id);
    }
    Ok(())
}

/// respond_plan_review 的结果:决策已生效,或冲突(当前状态原样返回,供
/// UI 呈现"已被另一窗口/新版本取代"而不是重复执行)。重复点击返回相同
/// 结果或明确冲突——PRD §4.2。
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", tag = "outcome")]
pub enum PlanRespondOutcome {
    Applied { review: PlanReview },
    Conflict { review: PlanReview },
}

/// 计划审批决策入口。前端只提交 planId + expectedRevision + decision +
/// 可选反馈;原生回复上下文从不离开后端。流程:
/// 1. expectedRevision + 状态条件原子抢占(plan_review::submit_decision),
///    决策意图先落盘;
/// 2. 按停住的原生上下文构造回复并写出——写管道失败退回待审、意图留存,
///    批准绝不显示成功;
/// 3. 原生确认后 mark_applied 落账。写成功 ≠ 远端已执行:失联只能标
///    unknown 并核对上游,本客户端保证不重复提交同一批准。
#[tauri::command]
pub async fn respond_plan_review(
    state: tauri::State<'_, crate::AppState>,
    plan_id: String,
    expected_revision: i64,
    decision: plan_review::PlanDecision,
    feedback: Option<String>,
) -> Result<PlanRespondOutcome, String> {
    if let Some(outcome) = try_worker_plan_review(&state, &plan_id, expected_revision, &decision, &feedback).await? {
        return serde_json::from_value(outcome).map_err(|_| "Invalid worker plan decision result".into());
    }
    let result = respond_plan_review_inner(&state, plan_id.clone(), expected_revision, decision, feedback).await;
    announce_plan_review(&state, &plan_id, expected_revision);
    result
}

/// Replay-safe wrapper: legacy/NextTurn decisions are never executed here.
#[tauri::command]
pub async fn runtime_worker_plan_review(
    state: tauri::State<'_, crate::AppState>,
    plan_id: String,
    expected_revision: i64,
    decision: plan_review::PlanDecision,
    feedback: Option<String>,
) -> Result<Value, String> {
    while crate::worker_host::paused() {
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    match try_worker_plan_review(&state, &plan_id, expected_revision, &decision, &feedback).await? {
        Some(value) => Ok(serde_json::json!({"handled":true,"value":value})),
        None => Ok(serde_json::json!({"handled":false})),
    }
}

async fn try_worker_plan_review(
    state: &crate::AppState,
    plan_id: &str,
    expected_revision: i64,
    decision: &plan_review::PlanDecision,
    feedback: &Option<String>,
) -> Result<Option<Value>, String> {
    if let Some(review) = plan_review::get_review(&state.db, plan_id, expected_revision)? {
        if review.review_kind != plan_review::PlanReviewKind::NativeRequest {
            return Ok(None);
        }
        if let Some(run_id) = review.run_id {
            use sha2::Digest;
            let command = crate::task_worker::Command::Plan {
                plan_id:plan_id.to_owned(), expected_revision,
                decision:match decision { plan_review::PlanDecision::Approve => "approve", plan_review::PlanDecision::RequestChanges => "request_changes", plan_review::PlanDecision::Defer => "defer" }.into(),
                feedback:feedback.clone(),
            };
            let encoded = serde_json::to_vec(&command).map_err(|_| "Encode plan decision failed")?;
            let id = format!("{:x}",sha2::Sha256::digest(encoded));
            if let Some(outcome) = crate::worker_host::control(&run_id, &id, command).await {
                return outcome.map(Some);
            }
        }
    }
    Ok(None)
}

pub(crate) async fn worker_respond_plan_review(
    state: &crate::AppState,
    worker_run_id: &str,
    plan_id: String,
    expected_revision: i64,
    decision: plan_review::PlanDecision,
    feedback: Option<String>,
) -> Result<PlanRespondOutcome, String> {
    // Check before the decision CAS: NextTurn creates a new run and is not a
    // control operation on this worker's single, already-admitted run.
    let review = plan_review::get_review(&state.db, &plan_id, expected_revision)?
        .ok_or_else(|| "Worker plan review is unavailable".to_string())?;
    if review.review_kind != plan_review::PlanReviewKind::NativeRequest
        || review.run_id.as_deref() != Some(worker_run_id)
    {
        return Err("Worker can only answer a native plan owned by its original run".into());
    }
    let entry = state.processes.get(worker_run_id)
        .ok_or_else(|| "Worker plan run is no longer active".to_string())?;
    let parked_revision = entry.plans.lock().map_err(|_| "Worker plan state is poisoned".to_string())?
        .get(&plan_id).and_then(|value| value.get("revision")).and_then(Value::as_i64);
    if parked_revision != Some(expected_revision) {
        return Err("Worker plan revision is no longer pending".into());
    }
    let result = DETACHED_WORKER_REQUEST.scope(true,
        respond_plan_review_inner(state, plan_id.clone(), expected_revision, decision, feedback),
    ).await;
    announce_plan_review(&state, &plan_id, expected_revision);
    result
}

fn announce_plan_review(state: &crate::AppState, plan_id: &str, revision: i64) {
    if let Ok(Some(review)) = plan_review::get_review(&state.db, plan_id, revision) {
        use crate::event_sink::Emit;
        state.emitters.emit_json("plan-review://changed", &serde_json::json!({
            "engine": review.engine, "sessionId": review.session_id,
        }).to_string());
    }
}

async fn respond_plan_review_inner(
    state: &crate::AppState,
    plan_id: String,
    expected_revision: i64,
    decision: plan_review::PlanDecision,
    feedback: Option<String>,
) -> Result<PlanRespondOutcome, String> {
    let claimed = match plan_review::submit_decision(
        &state.db,
        &plan_id,
        expected_revision,
        decision,
        feedback.as_deref(),
    )? {
        plan_review::SubmitOutcome::Conflict(review) => {
            return Ok(PlanRespondOutcome::Conflict { review: *review });
        }
        plan_review::SubmitOutcome::Claimed { previous } => previous,
    };
    announce_plan_review(state, &plan_id, expected_revision);
    let fail = |message: String| -> Result<PlanRespondOutcome, String> {
        // 提交权已抢占但路由/写入失败:退回待审,决策意图留存待恢复。
        plan_review::revert_submission(&state.db, &plan_id, expected_revision, claimed)?;
        Err(message)
    };
    let review = plan_review::get_review(&state.db, &plan_id, expected_revision)?
        .ok_or_else(|| "plan review vanished mid-decision".to_string())?;

    // 暂不执行:任何生命周期都不需要写原生回复;原生等待点保持停着,
    // 用户可回到同一会话继续审批(deferred 允许再次提交)。
    if decision == plan_review::PlanDecision::Defer {
        plan_review::mark_applied(&state.db, &plan_id, expected_revision, decision)?;
        let review = plan_review::get_review(&state.db, &plan_id, expected_revision)?
            .ok_or_else(|| "plan review vanished mid-decision".to_string())?;
        return Ok(PlanRespondOutcome::Applied { review });
    }

    if review.review_kind == plan_review::PlanReviewKind::NextTurn {
        // next_turn:计划轮次已正常结束,没有停着的原生请求;批准=原子创建
        // 一次 default 执行 turn,修改=新 plan turn 携反馈。执行器核对线程
        // 存在且最终 plan item 未变(stale 由其就地 expire)。今天只有 codex
        // 是 next_turn;其他引擎声明 next_turn 却没有执行器是编程错误,
        // fail-closed 而不是静默无事发生。
        if review.engine != "codex" {
            return fail(format!(
                "no next_turn plan executor is wired for engine {}",
                review.engine
            ));
        }
        if let Err(message) =
            codex_app::run_plan_decision(&state, &review, decision, feedback.as_deref()).await
        {
            return fail(format!("plan decision was NOT delivered: {message}"));
        }
        plan_review::mark_applied(&state.db, &plan_id, expected_revision, decision)?;
        if decision == plan_review::PlanDecision::Approve {
            // 执行 turn 已被服务端确认创建(原子一次);完成/失败由该 run 的
            // 后续事件推进,approved ≠ 执行成功。
            plan_review::mark_execution(
                &state.db,
                &plan_id,
                expected_revision,
                plan_review::PlanExecution::Starting,
            )?;
        }
        let review = plan_review::get_review(&state.db, &plan_id, expected_revision)?
            .ok_or_else(|| "plan review vanished mid-decision".to_string())?;
        return Ok(PlanRespondOutcome::Applied { review });
    }

    // native_request:取出停住的上下文,校验它属于同一版本、正文未变。
    let session_key = review.run_id.clone().unwrap_or_else(|| review.session_id.clone());
    let entry = state
        .processes
        .get(&session_key)
        .or_else(|| state.processes.get(&review.session_id))
        .ok_or_else(|| "no running session holds this plan's native request".to_string());
    let entry = match entry {
        Ok(entry) => entry,
        Err(message) => return fail(message),
    };
    let parked = entry
        .plans
        .lock()
        .map_err(|_| "plan state is poisoned".to_string())
        .ok()
        .and_then(|plans| plans.get(&plan_id).cloned());
    let Some(parked) = parked else {
        return fail("the native plan request is no longer parked for this session".to_string());
    };
    if parked.get("revision").and_then(Value::as_i64) != Some(expected_revision) {
        return fail("the parked native request belongs to a different plan revision".to_string());
    }
    if let Some(hash) = parked.get("contentHash").and_then(Value::as_str) {
        if hash != review.content_hash {
            // 正文在审批期间变化:不能让已抢占版本带着旧正文继续执行——
            // 先失效,要求重新审阅(PR §4.2 末条)。
            let _ = plan_review::expire_reviews(&state.db, &[(plan_id.clone(), expected_revision)]);
            return Err("plan content changed while awaiting review; the revision was expired"
                .to_string());
        }
    }

    let frame_key = match decision {
        plan_review::PlanDecision::Approve => "approve",
        plan_review::PlanDecision::RequestChanges => "changes",
        plan_review::PlanDecision::Defer => unreachable!("defer returned above"),
    };
    let frame = parked
        .get("frames")
        .and_then(|frames| frames.get(frame_key))
        .cloned()
        .ok_or_else(|| {
            "the parked native context carries no reply frame for this decision".to_string()
        });
    let frame = match frame {
        Ok(frame) => frame,
        Err(message) => return fail(message),
    };
    let frame = substitute_plan_feedback(frame, feedback.as_deref());

    let written = match parked.get("route").and_then(Value::as_str) {
        Some("stdin") => state.processes.write_line(&session_key, frame_to_line(&frame)).await,
        Some("http") => {
            let origin = parked.get("origin").and_then(Value::as_str).unwrap_or("");
            let path = parked.get("path").and_then(Value::as_str).unwrap_or("");
            if origin.is_empty() || path.is_empty() {
                Err("the parked native context is missing its http origin/path".to_string())
            } else {
                crate::dsh_host::host_call(origin, path, frame).await.map(|_| ())
            }
        }
        _ => Err("the parked native context does not declare a reply route".to_string()),
    };
    if let Err(message) = written {
        return fail(format!("plan decision was NOT delivered: {message}"));
    }

    plan_review::mark_applied(&state.db, &plan_id, expected_revision, decision)?;
    if decision == plan_review::PlanDecision::Approve {
        // 原生确认已收到,实施开始;approved ≠ 执行成功,完成/失败由后续
        // 运行事件推进。
        plan_review::mark_execution(
            &state.db,
            &plan_id,
            expected_revision,
            plan_review::PlanExecution::Starting,
        )?;
    }
    if let Ok(mut plans) = entry.plans.lock() {
        plans.remove(&plan_id);
    }
    let review = plan_review::get_review(&state.db, &plan_id, expected_revision)?
        .ok_or_else(|| "plan review vanished mid-decision".to_string())?;
    Ok(PlanRespondOutcome::Applied { review })
}

/// 计划审批历史(重启后历史页加载):按 planId/revision 主键去重,随会话
/// 删除清理。前端 localStorage 不是审批权威。
#[tauri::command]
pub async fn list_plan_reviews(
    state: tauri::State<'_, crate::AppState>,
    engine: String,
    session_id: String,
) -> Result<Vec<PlanReview>, String> {
    plan_review::list_reviews(&state.db, &engine, &session_id)
}

/// 反馈文本注入原生回复帧:适配器在停车时把帧里需要携带用户反馈的字符串
/// 叶子写成该占位符,发送时替换(如 DSH 的 custom 字段)。无占位符的帧原样
/// 通过;无反馈时占位符替换为空对象 null 语义由适配器决定——DSH 规则是
/// 反馈答案 selected:[] + custom 文本,批准答案绝不携带 custom。
pub(crate) const PLAN_FEEDBACK_PLACEHOLDER: &str = "__CCGUI_PLAN_FEEDBACK__";
fn substitute_plan_feedback(frame: Value, feedback: Option<&str>) -> Value {
    match frame {
        Value::String(text) if text.contains(PLAN_FEEDBACK_PLACEHOLDER) => {
            Value::String(text.replace(PLAN_FEEDBACK_PLACEHOLDER, feedback.unwrap_or("")))
        }
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| substitute_plan_feedback(item, feedback))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, substitute_plan_feedback(value, feedback)))
                .collect(),
        ),
        other => other,
    }
}
fn frame_to_line(frame: &Value) -> String {
    match frame {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}
#[cfg(test)]
mod permission_tests {
    use super::*;

    #[test]
    fn list_engines_ipc_runs_off_handler_thread() {
        let app = tauri::test::mock_builder()
            .invoke_handler(tauri::generate_handler![list_engines])
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "engine-test", Default::default())
            .build()
            .unwrap();
        let handler_thread = std::thread::current().id();
        let (sender, receiver) = std::sync::mpsc::channel();
        let webview: &tauri::Webview<tauri::test::MockRuntime> = window.as_ref();
        webview.clone().on_message(
            tauri::webview::InvokeRequest {
                cmd: "list_engines".into(),
                callback: tauri::ipc::CallbackFn(0),
                error: tauri::ipc::CallbackFn(1),
                url: if cfg!(windows) {
                    "http://tauri.localhost"
                } else {
                    "tauri://localhost"
                }
                .parse()
                .unwrap(),
                body: tauri::ipc::InvokeBody::default(),
                headers: Default::default(),
                invoke_key: tauri::test::INVOKE_KEY.to_string(),
            },
            Box::new(move |_, _, response, _, _| {
                sender
                    .send((std::thread::current().id(), response))
                    .unwrap();
            }),
        );
        let (response_thread, response) = receiver
            .recv_timeout(std::time::Duration::from_secs(10))
            .unwrap();
        assert!(matches!(response, tauri::ipc::InvokeResponse::Ok(_)));
        assert_ne!(
            handler_thread, response_thread,
            "engine detection ran inline on the IPC handler"
        );
    }

    #[test]
    fn every_registered_engine_has_an_adapter() {
        for id in crate::config::ENGINES {
            assert!(engine_by_id(id).is_some(), "{id}");
        }
    }

    /// 工具白名单是显式能力：只有实现了约束的引擎才允许被任务工作台
    /// 用于只读节点，其余引擎必须在启动时被拒绝。
    #[test]
    fn tool_constraint_support_is_explicit() {
        assert!(engine_by_id("claude").unwrap().supports_tool_constraints());
        assert!(engine_by_id("pi").unwrap().supports_tool_constraints());
        for id in ["codex", "omp", "grok", "kimi"] {
            assert!(
                !engine_by_id(id).unwrap().supports_tool_constraints(),
                "{id}"
            );
        }
    }

    fn req(permission: Option<&str>) -> SendRequest {
        SendRequest {
            claude_ultracode: None,
            host_instructions: None,
            session_id: None,
            workspace: PathBuf::from("/tmp"),
            prompt: "hi".to_string(),
            images: Vec::new(),
            model: None,
            effort: None,
            service_tier: None,
            permission: permission.map(str::to_string),
            additional_dirs: Vec::new(),
            provider_id: None,
            computer_use: None,
            allowed_tools: None,
        }
    }

    #[test]
    fn pi_read_only_launch_disables_all_extensions_on_start_and_resume() {
        for session_id in [None, Some("existing-session".to_string())] {
            let mut request = req(None);
            request.session_id = session_id;
            request.allowed_tools = Some(vec![
                "read".into(),
                "grep".into(),
                "find".into(),
                "ls".into(),
            ]);
            let args = argv(&pi_family::pi(), &request);
            assert!(args
                .windows(2)
                .any(|args| args == ["--tools", "read,grep,find,ls"]));
            assert!(args.contains(&"--no-extensions".to_string()));
            assert!(!args.contains(&"--extension".to_string()));
            assert!(!args.contains(&"--auto-approve".to_string()));
        }
    }

    #[test]
    fn pi_read_only_rejects_empty_writable_and_custom_tools() {
        for tools in [
            vec![],
            vec![""],
            vec!["read", "bash"],
            vec!["write"],
            vec!["edit"],
            vec!["custom"],
            vec!["read,bash"],
        ] {
            let mut request = req(None);
            request.allowed_tools = Some(tools.into_iter().map(str::to_string).collect());
            assert!(pi_family::pi().build_command(&request, "pi").is_err());
        }
    }

    #[test]
    fn pi_read_only_rejects_computer_use_and_omp_constraints() {
        let mut request = req(None);
        request.allowed_tools = Some(vec!["read".into()]);
        assert!(pi_family::omp().build_command(&request, "omp").is_err());
        request.computer_use = Some(true);
        assert!(pi_family::pi().build_command(&request, "pi").is_err());
    }

    #[test]
    fn pi_read_only_rejects_session_file_destinations() {
        for session in ["/tmp/plan.jsonl", "relative.jsonl", "../plan", "C:\\plan"] {
            let mut request = req(None);
            request.allowed_tools = Some(vec!["read".into()]);
            request.session_id = Some(session.into());
            assert!(
                pi_family::pi().build_command(&request, "pi").is_err(),
                "{session}"
            );
        }
    }

    #[test]
    fn pi_unrestricted_launch_keeps_the_ask_extension() {
        let args = argv(&pi_family::pi(), &req(None));
        assert!(args.contains(&"--extension".to_string()));
        assert!(!args.contains(&"--no-extensions".to_string()));
        assert!(!args.contains(&"--tools".to_string()));
    }

    #[test]
    fn plugin_read_only_is_opt_in_and_fails_closed() {
        for engine in crate::config::ENGINES {
            assert_eq!(plugin_agent_tools(engine, None).unwrap(), None);
            assert_eq!(plugin_agent_tools(engine, Some(false)).unwrap(), None);
            if !matches!(engine, "pi" | "codex") {
                assert!(plugin_agent_tools(engine, Some(true)).is_err(), "{engine}");
            }
        }
        assert_eq!(
            plugin_agent_tools("pi", Some(true)).unwrap(),
            Some(vec![
                "read".into(),
                "grep".into(),
                "find".into(),
                "ls".into()
            ])
        );
        assert!(plugin_agent_tools("unknown", Some(true)).is_err());
        assert_eq!(plugin_agent_tools("codex", Some(true)).unwrap(), None);
    }

    fn argv(engine: &dyn Engine, req: &SendRequest) -> Vec<String> {
        let built = engine.build_command(req, "fake-bin").unwrap();
        built
            .command
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect()
    }

    #[test]
    fn claude_computer_use_mounts_driver_mcp_and_preapproves_it() {
        let mut request = req(None);
        request.computer_use = Some(true);
        let args = argv(&claude::ClaudeEngine::new(), &request);
        let at = args
            .iter()
            .position(|a| a == "--mcp-config")
            .unwrap_or_else(|| panic!("{args:?}"));
        let config: Value =
            serde_json::from_str(&args[at + 1]).expect("mcp config must be inline JSON");
        let server = &config["mcpServers"]["ccgui-computer"];
        assert_eq!(server["args"], serde_json::json!(["--computer-use-mcp"]));
        assert!(!server["command"].as_str().unwrap_or_default().is_empty());
        // Pre-approved: a click-per-approval loop would be unusable.
        let tools_at = args
            .iter()
            .position(|a| a == "--allowedTools")
            .unwrap_or_else(|| panic!("{args:?}"));
        assert!(
            args[tools_at + 1..].contains(&"mcp__ccgui-computer".to_string()),
            "{args:?}"
        );
        // Off by default: no driver, no pre-approval.
        let off = argv(&claude::ClaudeEngine::new(), &req(None));
        assert!(!off.contains(&"--mcp-config".to_string()));
        assert!(!off.contains(&"mcp__ccgui-computer".to_string()));
    }

    /// Without this variable the CLI never emits session_state_changed and the
    /// reader silently reverts to closing stdin at the first `result`, losing
    /// background work. Fresh and resumed launches must both carry it.
    #[test]
    fn claude_launch_opts_into_native_session_state_on_fresh_and_resumed_sessions() {
        for session_id in [None, Some("existing-session".to_string())] {
            let mut request = req(None);
            request.session_id = session_id.clone();
            let built = claude::ClaudeEngine::new()
                .build_command(&request, "fake-bin")
                .unwrap();
            let env: Vec<_> = built
                .command
                .as_std()
                .get_envs()
                .filter(|(key, _)| *key == "CLAUDE_CODE_SDK_READS_SESSION_STATE")
                .collect();
            assert_eq!(
                env,
                [(
                    std::ffi::OsStr::new("CLAUDE_CODE_SDK_READS_SESSION_STATE"),
                    Some(std::ffi::OsStr::new("1"))
                )],
                "session {session_id:?}"
            );
        }
    }

    #[test]
    fn engine_info_exposes_computer_use_support_under_its_camel_case_key() {
        // The composer's /ccgui-cua gate reads `supportsComputerUse` off
        // list_engines; a rename (or a lost rename_all) would make the field
        // read undefined and refuse every engine. Pin the wire name.
        let info = EngineInfo {
            id: "claude".into(),
            available: true,
            enabled: true,
            plan: PlanApproval::Legacy,
            supports_images: true,
            supports_computer_use: true,
            supports_effort: true,
            supports_compact: true,
            supports_auto_review: false,
            supports_tool_constraints: false,
            permissions: vec!["auto".into()],
        };
        let json = serde_json::to_value(&info).expect("EngineInfo serializes");
        assert_eq!(json["supportsComputerUse"], serde_json::json!(true));
        assert!(json.get("supports_computer_use").is_none());
    }

    #[test]
    fn pi_prompt_rides_the_rpc_prompt_command() {
        // pi 也走 rpc 模式(提问桥扩展需要):prompt 是 stdin NDJSON 命令的
        // message 字段,多行文本不再被 Windows 的 cmd.exe shim 截断。
        let mut request = req(None);
        request.prompt = "first line\nsecond line\n%PATH%".to_string();
        let built = pi_family::pi().build_command(&request, "fake-bin").unwrap();
        let args: Vec<String> = built
            .command
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert!(args.windows(2).any(|w| w == ["--mode", "rpc"]), "{args:?}");
        // The ask bridge extension rides along via --extension.
        let at = args
            .iter()
            .position(|a| a == "--extension")
            .expect("{args:?}");
        assert!(args[at + 1].ends_with("ccgui-ask-bridge.ts"), "{args:?}");
        assert!(!args.iter().any(|a| a.contains("first line")), "{args:?}");
        let payload = built.stdin_payload.expect("rpc prompt must ride stdin");
        let mut lines = payload.lines();
        // pi 只有 v1:没有 negotiate_protocol 前导。
        let state: Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        assert_eq!(state["type"], "get_state");
        let prompt: Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        assert_eq!(prompt["type"], "prompt");
        assert_eq!(prompt["message"], request.prompt);
        assert!(
            lines.next().is_none(),
            "unexpected extra command: {payload}"
        );
        // 末尾不得自带换行:writer 统一补 `\n`,自带会在 rpc stdin 上产生
        // 空行,pi 回一帧 `command:"parse"` 失败响应(parse 错误警告横幅)。
        assert!(
            !payload.ends_with('\n'),
            "writer appends the terminator: {payload:?}"
        );
        assert!(built.keep_stdin_open);
    }

    #[test]
    fn omp_prompt_rides_the_rpc_prompt_command() {
        // rpc-ui 模式拒绝位置参数与 @file:prompt 是 stdin NDJSON 命令里的
        // message 字段,图片是命令里的 base64 payload,argv 只带协议 flags。
        // 图片走 prompt 命令的 base64 字段(load_image 覆盖),这里纯文本即可。
        let mut request = req(None);
        request.prompt = "first line\nsecond line".to_string();
        let built = pi_family::omp()
            .build_command(&request, "fake-bin")
            .unwrap();
        let args: Vec<String> = built
            .command
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert!(
            args.windows(2).any(|w| w == ["--mode", "rpc-ui"]),
            "{args:?}"
        );
        assert!(!args.contains(&"--print".to_string()), "{args:?}");
        assert!(!args.iter().any(|a| a.contains("first line")), "{args:?}");
        let payload = built.stdin_payload.expect("rpc prompt must ride stdin");
        let mut lines = payload.lines();
        assert!(lines.next().unwrap().contains("negotiate_protocol"));
        assert!(lines.next().unwrap().contains("get_state"));
        let prompt: Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        assert_eq!(prompt["type"], "prompt");
        assert_eq!(prompt["message"], "first line\nsecond line");
        assert!(
            lines.next().is_none(),
            "unexpected extra command: {payload}"
        );
        // The question answer frames write back over this same stdin.
        assert!(built.keep_stdin_open);
    }

    #[test]
    fn omp_fast_tier_is_explicit_and_independent_of_effort() {
        let mut request = req(None);
        request.model = Some("openai-codex/gpt-5.4".into());
        request.effort = Some("high".into());
        for tier in [None, Some("priority"), Some("default")] {
            request.service_tier = tier.map(str::to_string);
            let args = argv(&pi_family::omp(), &request);
            let actual = args
                .iter()
                .position(|a| a == "--service-tier")
                .map(|i| args[i + 1].as_str());
            assert_eq!(actual, tier);
            assert!(args.windows(2).any(|a| a == ["--thinking", "high"]));
        }
    }

    #[test]
    fn omp_fast_tier_does_not_leak_to_other_models_or_pi() {
        let mut request = req(None);
        request.service_tier = Some("priority".into());
        for model in [
            None,
            Some("anthropic/claude"),
            Some("google/gemini"),
            Some("gpt-5.4"),
            Some("openai/"),
            Some("openai/gpt-5.4"),
            Some("openai-codex/"),
            Some("custom/gpt-5.4"),
        ] {
            request.model = model.map(str::to_string);
            assert!(!argv(&pi_family::omp(), &request)
                .iter()
                .any(|a| a == "--service-tier"));
        }
        request.model = Some("openai-codex/gpt-5.4".into());
        assert!(!argv(&pi_family::pi(), &request)
            .iter()
            .any(|a| a == "--service-tier"));
        assert!(argv(&pi_family::omp(), &request)
            .iter()
            .any(|a| a == "--service-tier"));
        request.service_tier = Some("invalid".into());
        assert!(pi_family::omp()
            .build_command(&request, "fake-bin")
            .is_err());
    }

    #[test]
    fn omp_tier_settings_are_backward_compatible_and_roundtrip() {
        let mut settings: crate::settings::AppSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings.omp_openai_service_tier, None);
        for tier in [Some("priority"), Some("default"), None] {
            settings.omp_openai_service_tier = tier.map(str::to_string);
            let encoded = serde_json::to_string(&settings).unwrap();
            let decoded: crate::settings::AppSettings = serde_json::from_str(&encoded).unwrap();
            assert_eq!(decoded.omp_openai_service_tier.as_deref(), tier);
        }
    }

    #[test]
    fn unsupported_mode_falls_back_to_first_supported() {
        // codex/omp/dsh 的 typed 计划适配器已接通:plan 不再回退 auto。
        let codex = codex::CodexEngine;
        assert_eq!(codex.resolve_permission(Some("plan")), "plan");
        assert_eq!(codex.resolve_permission(Some("manual")), "manual");
        assert_eq!(codex.resolve_permission(None), "auto");
        assert_eq!(pi_family::omp().resolve_permission(Some("plan")), "plan");
        assert_eq!(dsh::DshEngine.resolve_permission(Some("plan")), "plan");
        // 未接通引擎保持回退(门禁 ensure_plan_approval 先拒绝显式 plan,
        // 回退只是防御层)。
        assert_eq!(pi_family::pi().resolve_permission(Some("plan")), "auto");
        let grok = grok::GrokEngine;
        assert_eq!(grok.resolve_permission(Some("auto")), "bypass");
        assert_eq!(grok.resolve_permission(Some("plan")), "bypass");
    }

    #[test]
    fn claude_maps_modes_to_permission_flags() {
        let e = claude::ClaudeEngine::new();
        let auto = argv(&e, &req(Some("auto")));
        assert!(auto.contains(&"--permission-mode".to_string()));
        assert!(auto.contains(&"acceptEdits".to_string()));
        assert!(!auto.contains(&"--dangerously-skip-permissions".to_string()));
        // Headless cannot prompt: auto pre-approves the read-only network
        // tools acceptEdits does not cover, or every web call is denied.
        assert!(auto
            .windows(3)
            .any(|w| w == ["--allowedTools", "WebSearch", "WebFetch"]));

        let manual = argv(&e, &req(Some("manual")));
        assert!(manual.contains(&"default".to_string()));
        assert!(!manual.contains(&"--allowedTools".to_string()));

        let plan = argv(&e, &req(Some("plan")));
        assert!(plan.contains(&"plan".to_string()));

        let bypass = argv(&e, &req(Some("bypass")));
        assert!(bypass.contains(&"--dangerously-skip-permissions".to_string()));
        assert!(!bypass.contains(&"--permission-mode".to_string()));
    }

    #[test]
    fn codex_maps_modes_to_sandbox_flags() {
        let e = codex::CodexEngine;
        let auto = argv(&e, &req(Some("auto")));
        assert!(auto.contains(&"--approve-for-me".to_string()));
        assert!(auto.contains(&"guardian_approval".to_string()));
        assert!(!auto.contains(&"--dangerously-bypass-approvals-and-sandbox".to_string()));

        let manual = argv(&e, &req(Some("manual")));
        assert!(manual.contains(&"sandbox_mode=\"read-only\"".to_string()));

        let bypass = argv(&e, &req(Some("bypass")));
        assert!(bypass.contains(&"--dangerously-bypass-approvals-and-sandbox".to_string()));
    }

    #[test]
    fn codex_resume_avoids_unsupported_sandbox_flag() {
        // `codex exec resume` rejects --sandbox (clap exit 2); the sandbox must
        // travel via -c for manual mode or the parent's --approve-for-me for auto.
        let e = codex::CodexEngine;
        let mut resume = req(Some("manual"));
        resume.session_id = Some("00000000-0000-0000-0000-000000000000".to_string());
        let args = argv(&e, &resume);
        assert!(args.contains(&"resume".to_string()));
        assert!(!args.contains(&"--sandbox".to_string()));
        assert!(args.contains(&"sandbox_mode=\"read-only\"".to_string()));

        let fresh = argv(&e, &req(Some("auto")));
        assert!(!fresh.contains(&"--sandbox".to_string()));
        assert!(fresh.contains(&"--approve-for-me".to_string()));
    }

    #[test]
    fn codex_prompt_goes_through_stdin_not_argv() {
        // Windows resolves npm codex to a `.cmd` shim spawned via `cmd /c`;
        // cmd.exe cuts a multiline argument at the first newline, so only line
        // 1 ever reached the model. The prompt must ride stdin (`-`) verbatim.
        let e = codex::CodexEngine;
        let mut request = req(Some("auto"));
        request.prompt = "first line\nmodel = \"gpt-5\"\n%PATH%".to_string();
        let built = e.build_command(&request, "fake-bin").unwrap();
        let args: Vec<String> = built
            .command
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert!(args.contains(&"-".to_string()));
        assert!(!args.iter().any(|a| a.contains("first line")));
        assert_eq!(
            built.stdin_payload.as_deref(),
            Some(request.prompt.as_str())
        );

        let mut resume = req(Some("auto"));
        resume.session_id = Some("00000000-0000-0000-0000-000000000000".to_string());
        let built = e.build_command(&resume, "fake-bin").unwrap();
        let args: Vec<String> = built
            .command
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert!(args.contains(&"-".to_string()));
        assert_eq!(built.stdin_payload.as_deref(), Some("hi"));
    }

    #[test]
    fn kimi_prompt_mode_never_combines_interactive_permission_flags() {
        let e = kimi::KimiEngine;
        let auto = argv(&e, &req(Some("auto")));
        assert!(!auto.contains(&"--yolo".to_string()));
        assert!(!auto.contains(&"--plan".to_string()));

        assert!(e.build_command(&req(Some("plan")), "kimi").is_err());

        let bypass = argv(&e, &req(Some("bypass")));
        assert!(!bypass.contains(&"--yolo".to_string()));
        assert!(!bypass.contains(&"--auto".to_string()));

        // Manual is unsupported: falls back to auto (no flags).
        let manual = argv(&e, &req(Some("manual")));
        assert!(!manual.contains(&"--yolo".to_string()));
        assert!(!manual.contains(&"--plan".to_string()));
    }

    #[test]
    fn plan_capability_matrix_matches_the_adapter_evidence() {
        // 能力矩阵(验收规格 §2 末行断言的新形态):适配器已接通的引擎声明
        // Typed(reviewKind 与协议生命周期一致),门禁放行 plan;未接通的
        // 保持 fail-closed,显式 plan 请求在构建命令与 spawn 之前受控拒绝,
        // 禁止降级 auto/bypass。各引擎适配器的细节断言(命令行/帧/正文)
        // 在各自模块的测试里,这里只锁矩阵与门禁。
        let typed: Vec<(Box<dyn Engine>, plan_review::PlanReviewKind)> = vec![
            (
                Box::new(pi_family::omp()),
                plan_review::PlanReviewKind::NativeRequest,
            ),
            (
                Box::new(codex::CodexEngine),
                plan_review::PlanReviewKind::NextTurn,
            ),
            (
                Box::new(dsh::DshEngine),
                plan_review::PlanReviewKind::NativeRequest,
            ),
        ];
        for (engine, kind) in typed {
            let id = engine.id().to_string();
            match engine.plan_approval() {
                PlanApproval::Typed { review_kind, .. } => assert_eq!(review_kind, kind, "{id}"),
                other => panic!("{id} must be Typed, got {other:?}"),
            }
            assert!(
                engine.supported_permissions().contains(&"plan"),
                "{id} picker must offer plan"
            );
            assert!(
                ensure_plan_approval(&id, engine.as_ref(), Some("plan")).is_ok(),
                "{id} plan request must pass the gate"
            );
            assert!(ensure_plan_approval(&id, engine.as_ref(), Some("auto")).is_ok());
        }

        let unavailable: Vec<Box<dyn Engine>> = vec![
            Box::new(pi_family::pi()),
            Box::new(grok::GrokEngine),
            Box::new(qoder::QoderEngine::new(qoder::QoderDistribution::Global)),
            Box::new(qoder::QoderEngine::new(qoder::QoderDistribution::Cn)),
        ];
        for engine in unavailable {
            let id = engine.id().to_string();
            assert!(
                matches!(engine.plan_approval(), PlanApproval::Unavailable { .. }),
                "{id} must stay fail-closed until its adapter is proven"
            );
            assert!(
                !engine.supported_permissions().contains(&"plan"),
                "{id} picker must not offer plan"
            );
            let refusal = ensure_plan_approval(&id, engine.as_ref(), Some("plan"));
            let Err(message) = refusal else {
                panic!("{id} plan request must be refused before spawn");
            };
            assert!(message.contains("cannot run a human-approved plan"), "{message}");
            assert!(ensure_plan_approval(&id, engine.as_ref(), Some("auto")).is_ok());
        }

        // omp 计划会话的真实入口是 ACP 传输(--mode acp),不是自动批准的
        // --plan-yolo;细节断言见 pi_family::tests。
        let mut plan_req = req(Some("plan"));
        plan_req.model = Some("openai-codex/gpt-5.4".into());
        let plan = argv(&pi_family::omp(), &plan_req);
        assert!(plan.contains(&"--mode".to_string()));
        assert!(!plan.contains(&"--plan-yolo".to_string()));
        assert!(!plan.contains(&"--plan-yolo-into".to_string()));
        assert!(!plan.contains(&"--auto-approve".to_string()));

        // auto/bypass 路径不受计划门禁影响:模型原样传递,不强制降级。
        let mut auto_req = req(Some("auto"));
        auto_req.model = Some("openai-codex/gpt-5.4".into());
        let auto = argv(&pi_family::omp(), &auto_req);
        let pin = auto.iter().position(|a| a == "--model").expect("model flag");
        assert_eq!(auto[pin + 1], "openai-codex/gpt-5.4");
        assert!(!auto.contains(&"--auto-approve".to_string()));
        let bypass = argv(&pi_family::omp(), &req(Some("bypass")));
        assert!(bypass.contains(&"--auto-approve".to_string()));
        assert!(!bypass.contains(&"--plan-yolo".to_string()));

        // pi never receives approval flags either, whatever it is asked for.
        for mode in [Some("plan"), Some("bypass"), Some("manual")] {
            let args = argv(&pi_family::pi(), &req(mode));
            assert!(!args.contains(&"--plan-yolo".to_string()), "{args:?}");
            assert!(!args.contains(&"--auto-approve".to_string()), "{args:?}");
        }
    }

    #[test]
    fn claude_passes_granted_dirs_as_add_dir() {
        let e = claude::ClaudeEngine::new();
        let mut r = req(Some("auto"));
        // Workspace itself, blanks and duplicates must not reach argv.
        r.additional_dirs = vec![
            "/data/shared".to_string(),
            "/tmp".to_string(),
            "   ".to_string(),
            "/data/shared".to_string(),
        ];
        let args = argv(&e, &r);
        let pairs: Vec<&[String]> = args.windows(2).filter(|w| w[0] == "--add-dir").collect();
        assert_eq!(pairs.len(), 1, "{args:?}");
        assert_eq!(pairs[0][1], "/data/shared");

        // Other engines have no equivalent flag: the field stays inert.
        let codex_args = argv(&codex::CodexEngine, &r);
        assert!(!codex_args.iter().any(|a| a == "--add-dir"));
    }

    #[test]
    fn grok_always_approves_regardless_of_request() {
        let e = grok::GrokEngine;
        for mode in [
            Some("auto"),
            Some("manual"),
            Some("plan"),
            Some("bypass"),
            None,
        ] {
            assert!(argv(&e, &req(mode)).contains(&"--always-approve".to_string()));
        }
    }
}
#[cfg(test)]
mod leader_child_marker_tests {
    use super::*;

    /// The managed-child case runs against the real coordinator in
    /// tests/send_path.rs; here only the removal for every other launch.
    #[test]
    fn launches_outside_managed_children_drop_an_inherited_marker() {
        let mut command = Command::new("fixture-cli");
        mark_leader_child(&mut command, "unmanaged-run");
        let marker: Vec<_> = command
            .as_std()
            .get_envs()
            .filter(|(key, _)| *key == LEADER_CHILD_ENV)
            .collect();
        assert_eq!(marker, [(std::ffi::OsStr::new(LEADER_CHILD_ENV), None)]);
    }
}
#[cfg(test)]
mod retry_lifecycle_tests {
    use super::*;

    #[derive(Default)]
    struct CollectingEmitter(Mutex<Vec<Value>>);

    impl event_sink::Emit for CollectingEmitter {
        fn emit_json(&self, _name: &str, raw_json: &str) {
            self.0
                .lock()
                .unwrap()
                .extend(serde_json::from_str::<Vec<Value>>(raw_json).unwrap());
        }
    }

    #[tokio::test]
    async fn terminal_error_cannot_be_followed_by_live_retry_events() {
        let emitter = Arc::new(CollectingEmitter::default());
        let core = TurnCore {
            sink: event_sink::EventSink::new(emitter.clone()),
            registry: Arc::new(ProcessRegistry::default()),
            engine_id: "omp".to_string(),
            run_id: "settled-run".to_string(),
            db: None,
        };
        let mut state = TurnState::new(Some("session".to_string()));
        for event in [
            EngineEvent::Error("retry exhausted".to_string()),
            EngineEvent::Retry {
                attempt: 1,
                max: 50,
                message: "socket closed".to_string(),
            },
            EngineEvent::Warn("late request error".to_string()),
            EngineEvent::Done {
                session_id: None,
                usage: None,
            },
        ] {
            core.dispatch_event(&mut state, event);
        }
        core.sink.flush();
        let events = emitter.0.lock().unwrap();
        let kinds: Vec<_> = events
            .iter()
            .map(|event| event["kind"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["error"], "a settled run must not send live events");
    }

    fn routed_entry(run_id: &str, pid: u32) -> ChildEntry {
        ChildEntry {
            child: None,
            pid,
            run_id: run_id.to_string(),
            killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            reader_abort: Arc::new(std::sync::OnceLock::new()),
            stdin: None,
            questions: Arc::new(Mutex::new(HashMap::new())),
            plans: Arc::new(Mutex::new(HashMap::new())),
            native_tasks: Default::default(),
            codex_control: None,
        }
    }

    /// A session key held by another live run is not this run's identity:
    /// it must fail visibly, never be announced, and leave the owner intact.
    #[tokio::test]
    async fn colliding_session_alias_is_rejected_without_claiming_identity() {
        let emitter = Arc::new(CollectingEmitter::default());
        let registry = Arc::new(ProcessRegistry::default());
        registry.insert("owner-run".into(), routed_entry("owner-run", 41));
        registry.insert_alias("shared-session".into(), routed_entry("owner-run", 41));
        registry.insert("late-run".into(), routed_entry("late-run", 42));
        let core = TurnCore {
            sink: event_sink::EventSink::new(emitter.clone()),
            registry: Arc::clone(&registry),
            engine_id: "omp".to_string(),
            run_id: "late-run".to_string(),
            db: None,
        };
        let mut state = TurnState::new(None);
        core.dispatch_event(&mut state, EngineEvent::SessionId("shared-session".into()));
        core.dispatch_event(&mut state, EngineEvent::Delta("late text".into()));
        core.sink.flush();
        let events = emitter.0.lock().unwrap();
        let kinds: Vec<_> = events.iter().map(|event| event["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["error"]);
        assert!(events.iter().all(|event| event["sessionId"].is_null()));
        assert!(state.native_session_id.is_none());
        assert_eq!(registry.get("shared-session").unwrap().run_id, "owner-run");
    }

    async fn replay_cli_output(lines: &[Value]) -> Vec<Value> {
        let path = std::env::temp_dir().join(format!("ccgui-retry-{}.jsonl", uuid::Uuid::new_v4()));
        let mut text = lines
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        text.push('\n');
        std::fs::write(&path, text).unwrap();
        let mut command = tokio::process::Command::new(if cfg!(windows) { "cmd" } else { "cat" });
        if cfg!(windows) {
            command.args(["/d", "/c", "type"]);
        }
        let mut child = command
            .arg(&path)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let emitter = Arc::new(CollectingEmitter::default());
        let ctx = RunContext {
            core: TurnCore {
                sink: event_sink::EventSink::new(emitter.clone()),
                registry: Arc::new(ProcessRegistry::default()),
                engine_id: "omp".to_string(),
                run_id: "pipe-retry-run".to_string(),
                db: None,
            },
            engine_impl: Box::new(pi_family::omp()),
            pid: child.id().unwrap(),
            preassigned_session_id: Some("session".to_string()),
            initial_model: None,
            initial_effort: None,
            child: Arc::new(TokioMutex::new(child)),
            killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            cleanup_files: vec![path],
            mcp_restore: None,
            stderr_buf: Arc::new(Mutex::new(String::new())),
            stdout_plain_buf: Arc::new(Mutex::new(String::new())),
            // Windows-only guard field the production constructor fills; this
            // test spawns a plain child, so there is no job object to hold.
            #[cfg(windows)]
            _tree_guard: None,
        };
        run_reader(stdout, ctx).await;
        let events = std::mem::take(&mut *emitter.0.lock().unwrap());
        events
    }

    /// Old CLIs print startup failures (usage/config errors, node crashes)
    /// to stdout as plain text: parse_line drops non-JSON lines, so the
    /// settle path must fall back to the captured plain tail when stderr
    /// is empty — otherwise the banner is a bare exit code.
    #[tokio::test]
    async fn plain_stdout_tail_surfaces_on_failed_exit_without_stderr() {
        let mut command = tokio::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" });
        if cfg!(windows) {
            command.args(["/c", "echo error: unrecognized arguments: --json & exit 1"]);
        } else {
            command.args(["-c", "echo 'error: unrecognized arguments: --json'; exit 1"]);
        }
        let mut child = command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let emitter = Arc::new(CollectingEmitter::default());
        let ctx = RunContext {
            core: TurnCore {
                sink: event_sink::EventSink::new(emitter.clone()),
                registry: Arc::new(ProcessRegistry::default()),
                engine_id: "codex".to_string(),
                run_id: "plain-stdout-run".to_string(),
                db: None,
            },
            engine_impl: Box::new(codex::CodexEngine),
            pid: child.id().unwrap(),
            preassigned_session_id: None,
            initial_model: None,
            initial_effort: None,
            child: Arc::new(TokioMutex::new(child)),
            killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            cleanup_files: Vec::new(),
            mcp_restore: None,
            stderr_buf: Arc::new(Mutex::new(String::new())),
            stdout_plain_buf: Arc::new(Mutex::new(String::new())),
            // See the pipe-retry constructor above.
            #[cfg(windows)]
            _tree_guard: None,
        };
        run_reader(stdout, ctx).await;
        let events = std::mem::take(&mut *emitter.0.lock().unwrap());
        let last = events.last().unwrap();
        assert_eq!(last["kind"], "error");
        let data = last["data"].as_str().unwrap();
        assert!(data.contains("codex exited with status"), "{data}");
        assert!(data.contains("unrecognized arguments"), "{data}");
    }

    #[tokio::test]
    async fn legacy_agent_end_can_retry_and_recover_before_eof() {
        let events = replay_cli_output(&[
            serde_json::json!({"type":"turn_end","message":{"role":"assistant","stopReason":"error","errorMessage":"socket closed"}}),
            serde_json::json!({"type":"agent_end","messages":[{"role":"assistant","stopReason":"error","errorMessage":"socket closed"}]}),
            serde_json::json!({"type":"auto_retry_start","attempt":1,"maxAttempts":50}),
            serde_json::json!({"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"recovered"}}),
            serde_json::json!({"type":"turn_end","message":{"role":"assistant","stopReason":"stop"}}),
            serde_json::json!({"type":"agent_end","messages":[{"role":"assistant","stopReason":"stop"}]}),
        ]).await;
        let kinds: Vec<_> = events
            .iter()
            .map(|event| event["kind"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["retry", "delta", "done"]);
        assert_eq!(events[1]["data"], "recovered");
    }

    #[tokio::test]
    async fn clean_eof_preserves_a_final_model_failure() {
        for failure in [
            serde_json::json!({"type":"turn_end","message":{"role":"assistant","stopReason":"error","errorMessage":"401 Invalid token"}}),
            serde_json::json!({"type":"auto_retry_end","success":false,"finalError":"socket closed"}),
        ] {
            let events = replay_cli_output(&[failure]).await;
            let last = events.last().unwrap();
            assert_eq!(
                last["kind"], "error",
                "clean process exit must not turn a failed request into success"
            );
            assert!(matches!(
                last["data"].as_str(),
                Some("401 Invalid token" | "socket closed")
            ));
            assert!(!events.iter().any(|event| event["kind"] == "done"));
        }
    }
    /// A background grandchild inheriting stdout keeps the pipe open after
    /// the CLI exits, so EOF never comes. The child-exit watch must settle
    /// the run anyway — drain the buffered lines, emit done, drain the
    /// registry — instead of parking the reader (and the run's concurrency
    /// slots) on the held pipe forever.
    #[cfg(unix)]
    #[tokio::test]
    async fn child_exit_settles_run_despite_pipe_holding_grandchild() {
        let done_lines = [
            serde_json::json!({"type":"turn_end","message":{"role":"assistant","stopReason":"stop"}}),
            serde_json::json!({"type":"agent_end","messages":[{"role":"assistant","stopReason":"stop"}]}),
        ];
        let script = format!(
            "printf '%s\\n' {}; sleep 600 & exit 0",
            done_lines
                .iter()
                .map(|line| format!("'{line}'"))
                .collect::<Vec<_>>()
                .join(" ")
        );
        let mut command = tokio::process::Command::new("sh");
        command
            .arg("-c")
            .arg(script)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        // Match production: own process group, so the settle path's group
        // sweep also reaps the pipe-holding grandchild.
        command.process_group(0);
        let mut child = command.spawn().unwrap();
        let pid = child.id().unwrap();
        let stdout = child.stdout.take().unwrap();
        let child = Arc::new(TokioMutex::new(child));
        let emitter = Arc::new(CollectingEmitter::default());
        let registry = Arc::new(ProcessRegistry::default());
        let killed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        for key in ["pipe-held-run", "session-held"] {
            registry.insert(
                key.to_string(),
                ChildEntry {
                    child: Some(Arc::clone(&child)),
                    pid,
                    run_id: "pipe-held-run".to_string(),
                    killed: Arc::clone(&killed),
                    reader_abort: Arc::new(std::sync::OnceLock::new()),
                    stdin: None,
                    questions: Arc::new(Mutex::new(HashMap::new())),
                    plans: Arc::new(Mutex::new(HashMap::new())),
                    native_tasks: Default::default(),
                    codex_control: None,
                },
            );
        }
        let ctx = RunContext {
            core: TurnCore {
                sink: event_sink::EventSink::new(emitter.clone()),
                registry: Arc::clone(&registry),
                engine_id: "omp".to_string(),
                run_id: "pipe-held-run".to_string(),
                db: None,
            },
            engine_impl: Box::new(pi_family::omp()),
            pid,
            preassigned_session_id: Some("session-held".to_string()),
            initial_model: None,
            initial_effort: None,
            child,
            killed,
            cleanup_files: Vec::new(),
            mcp_restore: None,
            stderr_buf: Arc::new(Mutex::new(String::new())),
            stdout_plain_buf: Arc::new(Mutex::new(String::new())),
            // See the pipe-retry constructor above.
            #[cfg(windows)]
            _tree_guard: None,
        };
        // Unbounded on the old EOF-only reader: the sleep holds the pipe
        // for 600s. POST_EXIT_DRAIN settles this in well under a second.
        tokio::time::timeout(std::time::Duration::from_secs(5), run_reader(stdout, ctx))
            .await
            .expect("reader must settle after child exit, not park on the held pipe");
        let events = std::mem::take(&mut *emitter.0.lock().unwrap());
        let kinds: Vec<_> = events
            .iter()
            .map(|event| event["kind"].as_str().unwrap())
            .collect();
        assert_eq!(
            kinds,
            ["done"],
            "buffered turn events must survive the drain"
        );
        assert_eq!(
            registry.0.lock().unwrap().len(),
            0,
            "settled run must drain its registry entries"
        );
    }

    fn live_entry(child: &Arc<TokioMutex<tokio::process::Child>>, pid: u32, run_id: &str) -> ChildEntry {
        ChildEntry {
            child: Some(Arc::clone(child)),
            pid,
            run_id: run_id.to_string(),
            killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            reader_abort: Arc::new(std::sync::OnceLock::new()),
            stdin: None,
            questions: Arc::new(Mutex::new(HashMap::new())),
            plans: Arc::new(Mutex::new(HashMap::new())),
            native_tasks: Default::default(),
            codex_control: None,
        }
    }

    /// A shell that prints `first`, waits, then prints `second`.
    fn staged_output(first: &std::path::Path, wait_ms: u64, second: &std::path::Path) -> tokio::process::Command {
        #[cfg(windows)]
        {
            let mut command = tokio::process::Command::new("powershell");
            command.args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Get-Content -Raw '{}'; Start-Sleep -Milliseconds {wait_ms}; Get-Content -Raw '{}'",
                    first.display(),
                    second.display()
                ),
            ]);
            command
        }
        #[cfg(not(windows))]
        {
            let mut command = tokio::process::Command::new("sh");
            command.arg("-c").arg(format!(
                "cat '{}'; sleep {}; cat '{}'",
                first.display(),
                wait_ms as f64 / 1000.0,
                second.display()
            ));
            command
        }
    }

    #[tokio::test]
    async fn claude_turn_started_after_done_is_published_as_a_continuation_run() {
        let emitter = Arc::new(CollectingEmitter::default());
        let registry = Arc::new(ProcessRegistry::default());
        registry.insert(
            "run-1".to_string(),
            ChildEntry {
                child: None,
                pid: 7,
                run_id: "run-1".to_string(),
                killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                reader_abort: Arc::new(std::sync::OnceLock::new()),
                stdin: None,
                questions: Arc::new(Mutex::new(HashMap::new())),
                plans: Arc::new(Mutex::new(HashMap::new())),
                native_tasks: Default::default(),
                codex_control: None,
            },
        );
        let core = TurnCore {
            sink: event_sink::EventSink::new(emitter.clone()),
            registry: Arc::clone(&registry),
            engine_id: "claude".to_string(),
            run_id: "run-1".to_string(),
            db: None,
        };
        let mut state = TurnState::new(Some("sess-1".to_string()));
        for event in [
            EngineEvent::Delta("first".into()),
            EngineEvent::Done { session_id: None, usage: None },
            // Not a turn on its own: a trailing report must not reopen anything.
            EngineEvent::Usage(serde_json::json!({"input_tokens": 1})),
            EngineEvent::Delta("background result".into()),
            EngineEvent::Done { session_id: None, usage: None },
        ] {
            core.dispatch_event(&mut state, event);
        }
        core.sink.flush();
        let events = std::mem::take(&mut *emitter.0.lock().unwrap());
        let seen: Vec<_> = events
            .iter()
            .map(|e| (e["kind"].as_str().unwrap().to_string(), e["runId"].as_str().unwrap().to_string()))
            .collect();
        let expect = |kind: &str, run: &str| (kind.to_string(), run.to_string());
        assert_eq!(
            seen,
            [
                expect("delta", "run-1"),
                expect("done", "run-1"),
                expect("session", "run-1-c1"),
                expect("delta", "run-1-c1"),
                expect("done", "run-1-c1"),
            ]
        );
        assert_eq!(events[3]["data"], "background result");
        assert_eq!(events[2]["sessionId"], "sess-1");
        // Stop by the continuation id reaches the same process; settling the
        // spawn's run drains the alias with it.
        assert_eq!(registry.get("run-1-c1").map(|e| e.pid), Some(7));
        registry.remove_run_if_pid("run-1", 7);
        assert!(registry.get("run-1-c1").is_none());
    }

    /// A native task's real terminal status can arrive after the final Done
    /// (an ambient watcher stopping). It must reach the UI under the same run,
    /// without being mistaken for a new turn.
    #[tokio::test]
    async fn native_task_catalog_is_published_after_done_under_the_same_run() {
        let emitter = Arc::new(CollectingEmitter::default());
        let core = TurnCore {
            sink: event_sink::EventSink::new(emitter.clone()),
            registry: Arc::new(ProcessRegistry::default()),
            engine_id: "claude".to_string(),
            run_id: "run-1".to_string(),
            db: None,
        };
        let mut state = TurnState::new(Some("sess-1".to_string()));
        for event in [
            EngineEvent::Delta("first".into()),
            EngineEvent::Done { session_id: None, usage: None },
            EngineEvent::Tasks(vec![events::NativeTask {
                id: "watcher".into(),
                kind: "local_monitor".into(),
                description: "watch".into(),
                status: "completed".into(),
                tool_use_id: None,
                summary: None,
                progress: None,
                background: None,
                ambient: Some(true),
            }]),
        ] {
            core.dispatch_event(&mut state, event);
        }
        core.sink.flush();
        let events = std::mem::take(&mut *emitter.0.lock().unwrap());
        let seen: Vec<_> = events
            .iter()
            .map(|e| (e["kind"].as_str().unwrap(), e["runId"].as_str().unwrap()))
            .collect();
        assert_eq!(
            seen,
            [("delta", "run-1"), ("done", "run-1"), ("tasks", "run-1")],
            "{events:#?}"
        );
        assert_eq!(events[2]["data"]["tasks"][0]["status"], "completed");
    }

    #[tokio::test]
    async fn a_lingering_claude_process_shows_its_continuation_running_until_it_reports() {
        let dir = std::env::temp_dir().join(format!("ccgui-linger-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let delta = |text: &str| {
            serde_json::json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,
                "delta":{"type":"text_delta","text":text}}})
            .to_string()
        };
        let result = serde_json::json!({"type":"result","subtype":"success","is_error":false,
            "session_id":"sess-linger","usage":{"input_tokens":1,"output_tokens":1}})
        .to_string();
        let first = dir.join("first.jsonl");
        let second = dir.join("second.jsonl");
        std::fs::write(&first, format!("{}\n{}\n", delta("turn one"), result)).unwrap();
        std::fs::write(&second, format!("{}\n{}\n", delta("from the subagent"), result)).unwrap();
        let wait_ms = reader::LINGER_GRACE.as_millis() as u64 + 1500;
        let mut command = staged_output(&first, wait_ms, &second);
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        let mut child = command.spawn().unwrap();
        let pid = child.id().unwrap();
        let stdout = child.stdout.take().unwrap();
        let child = Arc::new(TokioMutex::new(child));
        let emitter = Arc::new(CollectingEmitter::default());
        let registry = Arc::new(ProcessRegistry::default());
        registry.insert("run-linger".to_string(), live_entry(&child, pid, "run-linger"));
        let ctx = RunContext {
            core: TurnCore {
                sink: event_sink::EventSink::new(emitter.clone()),
                registry: Arc::clone(&registry),
                engine_id: "claude".to_string(),
                run_id: "run-linger".to_string(),
                db: None,
            },
            engine_impl: Box::new(claude::ClaudeEngine::new()),
            pid,
            preassigned_session_id: Some("sess-linger".to_string()),
            initial_model: None,
            initial_effort: None,
            child,
            killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            cleanup_files: Vec::new(),
            mcp_restore: None,
            stderr_buf: Arc::new(Mutex::new(String::new())),
            stdout_plain_buf: Arc::new(Mutex::new(String::new())),
            #[cfg(windows)]
            _tree_guard: None,
        };
        tokio::time::timeout(std::time::Duration::from_secs(30), run_reader(stdout, ctx))
            .await
            .expect("reader settles once the lingering process exits");
        let _ = std::fs::remove_dir_all(&dir);
        let events = std::mem::take(&mut *emitter.0.lock().unwrap());
        let seen: Vec<_> = events
            .iter()
            .filter(|e| e["kind"] != "usage")
            .map(|e| format!("{}@{}", e["kind"].as_str().unwrap(), e["runId"].as_str().unwrap()))
            .collect();
        assert_eq!(
            seen,
            [
                "delta@run-linger",
                "throughput@run-linger",
                "done@run-linger",
                // Announced by the linger check, before the subagent reports.
                "session@run-linger-c1",
                "delta@run-linger-c1",
                "throughput@run-linger-c1",
                "done@run-linger-c1",
            ],
            "{events:#?}"
        );
        assert_result_throughput(&events, &[("run-linger", 1), ("run-linger-c1", 1)]);
        assert_eq!(registry.0.lock().unwrap().len(), 0, "the run and its continuation alias drain");
    }

    fn assert_result_throughput(events: &[Value], expected: &[(&str, u64)]) {
        let reports: Vec<_> = events.iter().filter(|e| e["kind"] == "throughput").collect();
        assert_eq!(reports.len(), expected.len(), "{events:#?}");
        for (report, (run_id, output_tokens)) in reports.iter().zip(expected) {
            assert_eq!(report["runId"], *run_id);
            assert_eq!(report["data"]["outputTokens"], *output_tokens);
            // These fixtures omit duration and request stream boundaries: never
            // manufacture a rate from process lifetime or the previous turn.
            assert!(report["data"]["elapsedMs"].is_null(), "{report}");
            assert!(report["data"]["generation"].is_null(), "{report}");
        }
    }

    fn claude_state_line(state: &str) -> Value {
        serde_json::json!({"type":"system","subtype":"session_state_changed","state":state})
    }

    fn claude_delta_line(text: &str) -> Value {
        serde_json::json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,
            "delta":{"type":"text_delta","text":text}}})
    }

    fn claude_result_line(output_tokens: u64) -> Value {
        serde_json::json!({"type":"result","subtype":"success","is_error":false,
            "session_id":"sess-native","usage":{"input_tokens":1,"output_tokens":output_tokens}})
    }

    /// Native claude (session-state protocol) writes `first`, then stays alive
    /// past LINGER_GRACE, writes `second`, and exits 0. Returns the published
    /// events, minus usage reports, as `kind@runId` plus the raw events.
    async fn replay_native_claude_past_linger(
        first: &[Value],
        second: &[Value],
    ) -> (Vec<String>, Vec<Value>) {
        let dir = std::env::temp_dir().join(format!("ccgui-native-linger-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let write = |name: &str, lines: &[Value]| {
            let path = dir.join(name);
            let text: String = lines.iter().map(|line| format!("{line}\n")).collect();
            std::fs::write(&path, text).unwrap();
            path
        };
        let first = write("first.jsonl", first);
        let second = write("second.jsonl", second);
        let wait_ms = reader::LINGER_GRACE.as_millis() as u64 + 1500;
        let mut command = staged_output(&first, wait_ms, &second);
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        let mut child = command.spawn().unwrap();
        let pid = child.id().unwrap();
        let stdout = child.stdout.take().unwrap();
        let child = Arc::new(TokioMutex::new(child));
        let emitter = Arc::new(CollectingEmitter::default());
        let registry = Arc::new(ProcessRegistry::default());
        registry.insert("run-native".to_string(), live_entry(&child, pid, "run-native"));
        let ctx = RunContext {
            core: TurnCore {
                sink: event_sink::EventSink::new(emitter.clone()),
                registry: Arc::clone(&registry),
                engine_id: "claude".to_string(),
                run_id: "run-native".to_string(),
                db: None,
            },
            engine_impl: Box::new(claude::ClaudeEngine::new()),
            pid,
            preassigned_session_id: Some("sess-native".to_string()),
            initial_model: None,
            initial_effort: None,
            child,
            killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            cleanup_files: Vec::new(),
            mcp_restore: None,
            stderr_buf: Arc::new(Mutex::new(String::new())),
            stdout_plain_buf: Arc::new(Mutex::new(String::new())),
            #[cfg(windows)]
            _tree_guard: None,
        };
        let started = std::time::Instant::now();
        tokio::time::timeout(std::time::Duration::from_secs(30), run_reader(stdout, ctx))
            .await
            .expect("reader settles once the lingering process exits");
        // The scenario only means something if the process really outlived the
        // linger window; otherwise a missing continuation proves nothing.
        assert!(
            started.elapsed() >= reader::LINGER_GRACE,
            "the replayed process must outlive LINGER_GRACE"
        );
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(registry.0.lock().unwrap().len(), 0, "the run and its continuation alias drain");
        let events = std::mem::take(&mut *emitter.0.lock().unwrap());
        let seen = events
            .iter()
            .filter(|e| e["kind"] != "usage")
            .map(|e| format!("{}@{}", e["kind"].as_str().unwrap(), e["runId"].as_str().unwrap()))
            .collect();
        (seen, events)
    }

    /// The native run settled (idle after the result, final Done published),
    /// but the CLI needed longer than LINGER_GRACE to exit. That slow exit is
    /// not a failure: the earlier Activity(running) must not turn the clean
    /// EOF into "exited before its native run settled". Nor is it a
    /// continuation: the final Done already means idle with no background
    /// work, so a process still alive 4s later is only tearing down (hooks,
    /// MCP) and must not publish a `-c1` run the UI would adopt as a new one.
    #[tokio::test]
    async fn a_native_claude_run_that_settled_does_not_fail_when_the_process_exits_slowly() {
        let (seen, events) = replay_native_claude_past_linger(
            &[
                claude_state_line("running"),
                claude_delta_line("all done"),
                claude_result_line(3),
                claude_state_line("idle"),
            ],
            &[],
        )
        .await;
        assert!(
            !events.iter().any(|e| e["kind"] == "error"),
            "a settled run must not report an error: {events:#?}"
        );
        assert!(
            !events
                .iter()
                .any(|e| e["runId"].as_str().is_some_and(|id| id.ends_with("-c1"))),
            "a slow exit after the native final Done must not open a continuation run: {events:#?}"
        );
        assert_eq!(
            seen,
            [
                "activity@run-native",
                "delta@run-native",
                "throughput@run-native",
                "turn_complete@run-native",
                "done@run-native",
            ],
            "{events:#?}"
        );
        assert_result_throughput(&events, &[("run-native", 3)]);
    }

    /// After the final Done claude starts and answers another turn on its own
    /// (stdin already closed): that response must settle as a Done under the
    /// continuation run id and keep its usage, not vanish into a false error.
    #[tokio::test]
    async fn a_native_claude_response_after_the_final_done_settles_with_its_usage() {
        let (seen, events) = replay_native_claude_past_linger(
            &[
                claude_state_line("running"),
                claude_delta_line("first"),
                claude_result_line(3),
                claude_state_line("idle"),
            ],
            &[
                claude_state_line("running"),
                claude_delta_line("late reply"),
                claude_result_line(7),
                claude_state_line("idle"),
            ],
        )
        .await;
        assert!(
            !events.iter().any(|e| e["kind"] == "error"),
            "a late response must not report an error: {events:#?}"
        );
        assert_eq!(
            seen,
            [
                "activity@run-native",
                "delta@run-native",
                "throughput@run-native",
                "turn_complete@run-native",
                "done@run-native",
                "session@run-native-c1",
                "delta@run-native-c1",
                "throughput@run-native-c1",
                "done@run-native-c1",
            ],
            "{events:#?}"
        );
        assert_result_throughput(&events, &[("run-native", 3), ("run-native-c1", 7)]);
        let late = events.last().unwrap();
        assert_eq!(late["kind"], "done");
        assert_eq!(late["data"]["usage"]["output_tokens"], 7, "{late}");
    }

    #[tokio::test]
    async fn a_new_claude_send_waits_for_the_previous_process_and_refuses_a_lingering_one() {
        let registry = Arc::new(ProcessRegistry::default());
        assert!(wait_for_previous_process(&registry, "sess", std::time::Duration::from_millis(50))
            .await
            .is_ok());
        let empty = std::env::temp_dir().join(format!("ccgui-guard-{}.txt", uuid::Uuid::new_v4()));
        std::fs::write(&empty, "").unwrap();
        let mut command = staged_output(&empty, 20_000, &empty);
        command.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        let child = command.spawn().unwrap();
        let pid = child.id().unwrap();
        let child = Arc::new(TokioMutex::new(child));
        registry.insert("sess".to_string(), live_entry(&child, pid, "run-old"));
        let refused = wait_for_previous_process(&registry, "sess", std::time::Duration::from_millis(300)).await;
        assert!(refused.unwrap_err().contains("还在后台运行"));
        let leaving = Arc::clone(&registry);
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            leaving.remove_if_pid("sess", pid);
        });
        assert!(wait_for_previous_process(&registry, "sess", std::time::Duration::from_secs(5))
            .await
            .is_ok());
        let _ = child.lock().await.kill().await;
        let _ = std::fs::remove_file(&empty);
    }
}
#[cfg(test)]
mod codex_home_bin_tests {
    use super::*;

    #[test]
    fn engine_bin_prefers_codex_home_bin() {
        let dir =
            std::env::temp_dir().join(format!("ccgui-codex-home-bin-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        let candidate = dir.join("bin").join("codex");
        std::fs::write(&candidate, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&candidate, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let mut settings = crate::settings::AppSettings::default();
        settings.codex_home = Some(dir.to_string_lossy().into_owned());
        let resolved = engine_bin(&settings, "codex");
        assert_eq!(PathBuf::from(&resolved), candidate);

        // An explicit codexBin override (set before the home row existed, or
        // hand-edited) still wins over $home/bin/codex.
        #[cfg(unix)]
        {
            settings.bin_overrides.insert(
                "codexBin".to_string(),
                serde_json::Value::String("/bin/sh".to_string()),
            );
            assert_eq!(engine_bin(&settings, "codex"), "/bin/sh");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
#[cfg(test)]
mod plan_respond_tests {
    //! respond_plan_review 的交付路径测试:批准/修改帧真实写进子进程
    //! stdin、写失败退回待审、重复提交冲突。停车上下文需要 pub(crate)
    //! 的 registry insert,故在 crate 内;IPC 形状与 fail-closed 见
    //! tests/plan_review.rs。
    use super::*;
    use crate::engine::plan_review::{self, PlanDecision, PlanReview};
    use serde_json::json;
    use std::sync::{Arc, Mutex};
    use tauri::Manager;

    fn build_state(tag: &str) -> (tauri::App<tauri::test::MockRuntime>, Arc<crate::db::Db>) {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let dir = std::env::temp_dir().join(format!(
            "ccgui-plan-respond-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Arc::new(crate::db::Db::open_at(&dir.join("app.db")).unwrap());
        app.manage(crate::AppState {
            db: Arc::clone(&db),
            sink: crate::event_sink::EventSink::new(Arc::new(app.handle().clone())),
            terminal_sink: crate::event_sink::EventSink::with_name(
                Arc::new(app.handle().clone()),
                crate::terminal::TERMINAL_OUTPUT_EVENT,
            ),
            plugin_sink: crate::event_sink::EventSink::with_name(
                Arc::new(app.handle().clone()),
                crate::event_sink::PLUGIN_AGENT_EVENT_NAME,
            ),
            mission_sink: crate::event_sink::EventSink::with_name(
                Arc::new(app.handle().clone()),
                crate::event_sink::MISSION_AGENT_EVENT_NAME,
            ),
            terminals: crate::terminal::TerminalRegistry::default(),
            processes: Arc::new(registry::ProcessRegistry::default()),
            emitters: crate::event_sink::BroadcastEmit::new(Arc::new(app.handle().clone())),
            web: crate::web::WebAccessState::default(),
            relay: crate::relay::RelayState::default(),
            dsh_host: Arc::new(crate::dsh_host::DshHostState::default()),
            opencode_server: Arc::new(opencode_server::OpencodeServerState::default()),
            worktree_creations: crate::git_worktree::CreationRegistry::default(),
        });
        (app, db)
    }

    fn review(plan_id: &str, session_id: &str) -> PlanReview {
        PlanReview {
            plan_id: plan_id.into(),
            engine: "dsh".into(),
            session_id: session_id.into(),
            workspace_path: "/tmp/ccgui-plan-respond-ws".into(),
            run_id: None,
            revision: 0,
            title: "Test plan".into(),
            content: "# Plan\n\ndo the thing".into(),
            content_hash: plan_review::content_hash("# Plan\n\ndo the thing"),
            complete: true,
            review_kind: plan_review::PlanReviewKind::NativeRequest,
            native_plan_id: Some(format!("native-{plan_id}")),
            exec_permission: "auto".into(),
            status: plan_review::PlanStatus::AwaitingReview,
            execution: plan_review::PlanExecution::NotStarted,
            decision: None,
            decision_intent_at: None,
            applied_at: None,
            created_at: 0,
            updated_at: 0,
            superseded_by: None,
        }
    }

    #[tokio::test]
    async fn runtime_worker_plan_wrapper_never_executes_legacy_decisions() {
        let (app, db) = build_state("worker-plan-wrapper-legacy");
        for (id, kind) in [
            ("next-turn", plan_review::PlanReviewKind::NextTurn),
            ("unowned-native", plan_review::PlanReviewKind::NativeRequest),
        ] {
            let mut candidate = review(id, "session-wrapper");
            candidate.review_kind = kind;
            if id == "next-turn" { candidate.run_id = Some("legacy-run".into()); }
            plan_review::record_review(&db, &candidate).unwrap();
            let outcome = runtime_worker_plan_review(app.state(), id.into(), 1, PlanDecision::Defer, None).await.unwrap();
            assert_eq!(outcome, json!({"handled":false}));
            let stored = plan_review::get_review(&db, id, 1).unwrap().unwrap();
            assert_eq!(stored.status, plan_review::PlanStatus::AwaitingReview);
            assert!(stored.decision.is_none());
        }
        assert_eq!(runtime_worker_plan_review(app.state(), "missing".into(), 1, PlanDecision::Approve, None).await.unwrap(), json!({"handled":false}));
        assert_eq!(runtime_worker_plan_review(app.state(), "next-turn".into(), 99, PlanDecision::Approve, None).await.unwrap(), json!({"handled":false}));
    }

    #[tokio::test]
    async fn deferred_plan_notifies_other_control_surfaces_without_resuming_the_run() {
        use tauri::Listener;
        let (app, db) = build_state("defer-shared");
        plan_review::record_review(&db, &review("plan-shared", "sess-shared")).unwrap();
        let events = Arc::new(Mutex::new(Vec::<Value>::new()));
        let captured = events.clone();
        app.listen_any("plan-review://changed", move |event| {
            captured.lock().unwrap().push(serde_json::from_str(event.payload()).unwrap());
        });
        let result = respond_plan_review(app.state(), "plan-shared".into(), 1,
            PlanDecision::Defer, None).await.unwrap();
        assert!(matches!(result, PlanRespondOutcome::Applied { review } if review.status == plan_review::PlanStatus::Deferred));
        let captured = events.lock().unwrap();
        assert_eq!(captured.len(), 2, "both submitting and final DB state must invalidate other surfaces");
        assert!(captured.iter().all(|event| event == &json!({"engine":"dsh","sessionId":"sess-shared"})));
    }

    /// 停车一个 native_request 上下文并(可选)接一根真实 stdin。
    fn park(
        app: &tauri::App<tauri::test::MockRuntime>,
        key: &str,
        plan_id: &str,
        stdin: Option<Arc<tokio::sync::Mutex<Option<tokio::process::ChildStdin>>>>,
        extra: serde_json::Value,
    ) {
        let state = app.state::<crate::AppState>();
        let mut parked = json!({
            "revision": 1,
            "route": "stdin",
            "frames": {
                "approve": {"jsonrpc": "2.0", "id": 9, "result": {"outcome": "approved"}},
                "changes": {"jsonrpc": "2.0", "id": 9, "result": {"outcome": "changes", "custom": PLAN_FEEDBACK_PLACEHOLDER}},
            },
        });
        if let Some(obj) = extra.as_object() {
            for (k, v) in obj {
                parked[k] = v.clone();
            }
        }
        let mut plans = std::collections::HashMap::new();
        plans.insert(plan_id.to_string(), parked);
        state.processes.insert(
            key.to_string(),
            registry::ChildEntry {
                child: None,
                pid: 4242,
                run_id: key.to_string(),
                killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                reader_abort: Arc::new(std::sync::OnceLock::new()),
                stdin,
                questions: Arc::new(Mutex::new(std::collections::HashMap::new())),
                plans: Arc::new(Mutex::new(plans)),
                native_tasks: Default::default(),
                codex_control: None,
            },
        );
    }

    /// A byte-preserving child copies received frames into a file on either OS.
    fn spawn_frame_sink(
        tag: &str,
    ) -> (
        tokio::process::Child,
        Arc<tokio::sync::Mutex<Option<tokio::process::ChildStdin>>>,
        std::path::PathBuf,
    ) {
        let out_path = std::env::temp_dir().join(format!(
            "ccgui-plan-frames-{tag}-{}",
            std::process::id()
        ));
        let out_file = std::fs::File::create(&out_path).unwrap();
        #[cfg(windows)]
        let mut command = {
            let mut command = tokio::process::Command::new("powershell.exe");
            command.args(["-NoProfile", "-NonInteractive", "-Command",
                "[Console]::OpenStandardInput().CopyTo([Console]::OpenStandardOutput())"]);
            command.creation_flags(0x08000000);
            command
        };
        #[cfg(not(windows))]
        let mut command = tokio::process::Command::new("cat");
        let mut child = command.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::from(out_file))
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stdin = Arc::new(tokio::sync::Mutex::new(child.stdin.take()));
        (child, stdin, out_path)
    }

    async fn drain_frames(
        app: &tauri::App<tauri::test::MockRuntime>,
        key: &str,
        mut child: tokio::process::Child,
        out_path: &std::path::Path,
    ) -> String {
        let entry = app.state::<crate::AppState>().processes.get(key).unwrap();
        if let Some(stdin) = entry.stdin {
            *stdin.lock().await = None;
        }
        child.wait().await.unwrap();
        std::fs::read_to_string(out_path).unwrap()
    }

    #[tokio::test]
    async fn approve_delivers_the_native_frame_then_conflicts_on_repeat() {
        let (app, db) = build_state("approve");
        plan_review::record_review(&db, &review("plan-a", "sess-a")).unwrap();
        let (child, stdin, out_path) = spawn_frame_sink("approve");
        park(&app, "sess-a", "plan-a", Some(stdin), json!({}));

        let outcome = respond_plan_review(
            app.state::<crate::AppState>(),
            "plan-a".to_string(),
            1,
            PlanDecision::Approve,
            None,
        )
        .await
        .expect("approve must apply");
        let PlanRespondOutcome::Applied { review } = outcome else {
            panic!("approve must apply, got {outcome:?}");
        };
        assert_eq!(review.status, plan_review::PlanStatus::Approved);
        assert_eq!(review.execution, plan_review::PlanExecution::Starting);

        let written = drain_frames(&app, "sess-a", child, &out_path).await;
        assert!(written.contains("\"outcome\":\"approved\""), "{written}");

        // 停住的上下文已移除;重复提交同一 revision 返回冲突而非重复执行。
        let entry = app.state::<crate::AppState>().processes.get("sess-a").unwrap();
        assert!(entry.plans.lock().unwrap().is_empty());
        let again = respond_plan_review(
            app.state::<crate::AppState>(),
            "plan-a".to_string(),
            1,
            PlanDecision::Approve,
            None,
        )
        .await
        .expect("repeat respond must not error");
        assert!(
            matches!(again, PlanRespondOutcome::Conflict { .. }),
            "double submit must conflict: {again:?}"
        );
    }

    #[tokio::test]
    async fn request_changes_substitutes_feedback_into_the_frame() {
        let (app, db) = build_state("changes");
        plan_review::record_review(&db, &review("plan-b", "sess-b")).unwrap();
        let (child, stdin, out_path) = spawn_frame_sink("changes");
        park(&app, "sess-b", "plan-b", Some(stdin), json!({}));

        let outcome = respond_plan_review(
            app.state::<crate::AppState>(),
            "plan-b".to_string(),
            1,
            PlanDecision::RequestChanges,
            Some("收紧范围,别动鉴权模块".to_string()),
        )
        .await
        .expect("changes must apply");
        let PlanRespondOutcome::Applied { review } = outcome else {
            panic!("changes must apply, got {outcome:?}");
        };
        assert_eq!(review.status, plan_review::PlanStatus::ChangesRequested);

        let written = drain_frames(&app, "sess-b", child, &out_path).await;
        assert!(written.contains("收紧范围,别动鉴权模块"), "{written}");
        assert!(!written.contains(PLAN_FEEDBACK_PLACEHOLDER), "{written}");
    }

    #[tokio::test]
    async fn a_closed_stdin_reverts_to_pending_and_keeps_the_intent() {
        let (app, db) = build_state("revert");
        plan_review::record_review(&db, &review("plan-c", "sess-c")).unwrap();
        // stdin 已关闭:写管道失败,批准绝不显示成功。
        park(
            &app,
            "sess-c",
            "plan-c",
            Some(Arc::new(tokio::sync::Mutex::new(None))),
            json!({}),
        );

        let result = respond_plan_review(
            app.state::<crate::AppState>(),
            "plan-c".to_string(),
            1,
            PlanDecision::Approve,
            None,
        )
        .await;
        let Err(message) = result else {
            panic!("a closed stdin must fail the respond");
        };
        assert!(message.contains("NOT delivered"), "{message}");

        let reverted = plan_review::get_review(&db, "plan-c", 1).unwrap().unwrap();
        assert_eq!(reverted.status, plan_review::PlanStatus::AwaitingReview);
        assert_eq!(reverted.execution, plan_review::PlanExecution::NotStarted);
        assert!(reverted.decision_intent_at.is_some());
        assert!(reverted.applied_at.is_none());
        // 停住的上下文保留,用户可重试。
        let entry = app.state::<crate::AppState>().processes.get("sess-c").unwrap();
        assert!(entry.plans.lock().unwrap().contains_key("plan-c"));
    }

    #[tokio::test]
    async fn a_changed_body_expires_the_revision_instead_of_executing() {
        let (app, db) = build_state("stale-body");
        plan_review::record_review(&db, &review("plan-d", "sess-d")).unwrap();
        let (_child, stdin, _out) = spawn_frame_sink("stale-body");
        // 停车上下文记录的正文哈希与落盘记录不一致:审批期间正文已变,
        // 先失效再要求重新审阅,绝不带着旧正文执行(PRD §4.2 末条)。
        park(
            &app,
            "sess-d",
            "plan-d",
            Some(stdin),
            json!({"contentHash": "different-hash"}),
        );

        let result = respond_plan_review(
            app.state::<crate::AppState>(),
            "plan-d".to_string(),
            1,
            PlanDecision::Approve,
            None,
        )
        .await;
        let Err(message) = result else {
            panic!("a changed body must not execute");
        };
        assert!(message.contains("expired"), "{message}");
        let expired = plan_review::get_review(&db, "plan-d", 1).unwrap().unwrap();
        assert_eq!(expired.status, plan_review::PlanStatus::Expired);
    }
}
