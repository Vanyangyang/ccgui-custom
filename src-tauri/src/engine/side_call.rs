//! One-shot, isolated completions for host features (auto_title).
//!
//! Claude uses the same binary, channel env and settings overlay as a chat send, so
//! routing, auth and the user's proxy settings apply exactly as they do to a
//! conversation. Everything a conversation carries beyond that is switched
//! off: no session file (it would surface as a sidebar row and trigger its
//! own naming), no hooks (user SessionStart hooks would run and inject their
//! context on every call), no MCP servers, skills or tools. The answer comes
//! back through `--json-schema` structured output. Codex uses a pure Responses
//! request with no tools; Pi uses an isolated print transport. Both keep their
//! authentication/routing and parsing inside their own modules below.

use super::{claude_channel, command_for_binary, BuiltCommand};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

mod codex;
pub(crate) mod diagnostics;
mod pi;

/// Stdout cap: a structured answer is a few hundred bytes; anything far past
/// that is not an answer worth parsing.
const MAX_OUTPUT: usize = 256 * 1024;
const MAX_STDERR: usize = 64 * 1024;

/// Lives outside the runner's await so aborting the caller removes its own
/// channel credentials just as a normal return does.
struct StagedFiles(Vec<PathBuf>);

impl Drop for StagedFiles {
    fn drop(&mut self) {
        super::cleanup_staged_files(&self.0);
    }
}

pub(crate) struct StructuredCall<'a> {
    pub system_prompt: &'a str,
    /// Written to stdin as the single user message.
    pub input: &'a str,
    pub json_schema: &'a Value,
    /// Source-native selector (a Claude alias, Codex id or Pi provider/model).
    pub model: &'a str,
    pub provider_id: Option<&'a str>,
    pub effort: &'a str,
    pub timeout: Duration,
}

pub(crate) fn resolve_model(
    selector: &str,
    provider: Option<&Value>,
    env: &HashMap<String, String>,
) -> Option<String> {
    claude_channel::resolve_model(Some(selector), provider, env)
}

/// Capability of the resolved model, rather than its remappable family alias.
/// Unknown relay models get no effort override; their CLI/channel default wins.
pub(crate) fn model_supports_effort(model: &str) -> bool {
    let model = model.strip_suffix("[1m]").unwrap_or(model);
    if matches!(model, "sonnet" | "opus" | "fable") {
        return true;
    }
    // First effort-capable releases. Newer releases in these families retain
    // effort; Haiku and older models do not. Aliases use the installed CLI.
    for (family, first_minor) in [("opus", 5), ("sonnet", 6), ("fable", 0)] {
        if let Some(version) = model.strip_prefix(&format!("claude-{family}-")) {
            let mut parts = version.split('-');
            let major = parts.next().and_then(|s| s.parse::<u32>().ok());
            let minor = parts
                .next()
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(0);
            return major.is_some_and(|major| major > 4 || (major == 4 && minor >= first_minor));
        }
    }
    false
}

fn effective_effort<'a>(call: &'a StructuredCall<'_>, model: Option<&str>) -> Option<&'a str> {
    model
        .filter(|m| model_supports_effort(m))
        .map(|_| super::claude::normalize_effort(call.effort.trim()).unwrap_or("low"))
}

#[derive(Debug)]
pub(crate) struct SideCallOutput {
    pub structured: Value,
    // Preserved as call metadata; separate naming accounting is not enabled.
    #[allow(dead_code)]
    pub usage: Option<Value>,
}

/// Failure classes callers map onto their own user-facing codes. Output is
/// never logged: stderr may echo prompt content or channel credentials.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SideCallError {
    /// The selected source is disabled, unsupported or cannot resolve routing/auth.
    Unavailable,
    Timeout,
    /// The CLI ran but produced no usable structured result.
    BadOutput,
    Failed,
}

pub(crate) async fn claude_structured(
    call: StructuredCall<'_>,
) -> Result<SideCallOutput, SideCallError> {
    let (built, cwd) = build(&call)?;
    run_built(built, &cwd, call.input, call.timeout).await
}

pub(crate) async fn structured(
    engine: &str,
    call: StructuredCall<'_>,
) -> Result<SideCallOutput, SideCallError> {
    tokio::time::timeout(call.timeout, async {
        match engine {
            "claude" => claude_structured(call).await,
            "codex" if call.model.is_empty() => {
                let catalog = super::models::local_catalog("codex").await.map_err(|_| SideCallError::Unavailable)?;
                let model = catalog.models.first().ok_or(SideCallError::Unavailable)?;
                codex::structured(StructuredCall { model: &model.id, ..call }).await
            }
            "codex" => codex::structured(call).await,
            "pi" => pi::structured(call).await,
            _ => Err(SideCallError::Unavailable),
        }
    }).await.map_err(|_| SideCallError::Timeout)?
}

async fn run_built(
    mut built: BuiltCommand,
    cwd: &Path,
    input: &str,
    timeout: Duration,
) -> Result<SideCallOutput, SideCallError> {
    let _cleanup = StagedFiles(std::mem::take(&mut built.cleanup_files));
    run(built.command, cwd, input, timeout).await
}

fn build(call: &StructuredCall<'_>) -> Result<(BuiltCommand, std::path::PathBuf), SideCallError> {
    let unavailable = |stage: &str, error: String| {
        eprintln!("[side-call] claude {stage}: {error}");
        SideCallError::Unavailable
    };
    crate::config::ensure_engine_enabled("claude").map_err(|e| unavailable("disabled", e))?;
    let provider =
        crate::config::resolve_provider("claude", call.provider_id).map_err(|e| unavailable("channel", e))?;
    let mut channel_env = provider
        .as_ref()
        .map(|p| crate::provider_files::channel_env("claude", p))
        .transpose()
        .map_err(|e| unavailable("channel env", e))?
        .unwrap_or_default();
    let settings = crate::settings::read_settings().unwrap_or_default();
    let bin = super::engine_bin(&settings, "claude");
    let (command, model) = channel_command(&bin, call, provider.as_ref(), &mut channel_env);
    let mut built = BuiltCommand {
        command,
        stdin_payload: None,
        keep_stdin_open: false,
        cleanup_files: Vec::new(),
        mcp_restore: None,
        preassigned_session_id: None,
    };
    let mut host_settings = Map::new();
    host_settings.insert("disableAllHooks".into(), Value::Bool(true));
    match provider.as_ref() {
        Some(provider) => claude_channel::apply_side_call(
            &mut built,
            provider,
            &channel_env,
            model.as_deref(),
            &host_settings,
        )
        .map_err(|e| {
            super::cleanup_staged_files(&built.cleanup_files);
            unavailable("channel overlay", e)
        })?,
        None => {
            built
                .command
                .arg("--settings")
                .arg(Value::Object(host_settings).to_string());
        }
    }
    // An empty private directory: no project CLAUDE.md, no project settings
    // or auto-memory from whichever workspace the session belongs to.
    let cwd = crate::paths::app_home().join("side-call");
    std::fs::create_dir_all(&cwd).map_err(|e| {
        super::cleanup_staged_files(&built.cleanup_files);
        unavailable("cwd", e.to_string())
    })?;
    Ok((built, cwd))
}

fn channel_command(
    bin: &str,
    call: &StructuredCall<'_>,
    provider: Option<&Value>,
    channel_env: &mut HashMap<String, String>,
) -> (tokio::process::Command, Option<String>) {
    let model = resolve_model(call.model, provider, channel_env);
    // The process and staged settings must agree. Unsupported models must
    // not inherit the parent's or channel's effort override.
    channel_env.remove("CLAUDE_CODE_EFFORT_LEVEL");
    if let Some(effort) = effective_effort(call, model.as_deref()) {
        channel_env.insert("CLAUDE_CODE_EFFORT_LEVEL".into(), effort.into());
    }
    let mut command = isolated_command(bin, call, model.as_deref());
    for (key, value) in channel_env.iter() {
        command.env(key, value);
    }
    (command, model)
}

fn isolated_command(
    bin: &str,
    call: &StructuredCall<'_>,
    model: Option<&str>,
) -> tokio::process::Command {
    let mut command = command_for_binary(bin);
    command.args([
        "-p",
        "--output-format",
        "json",
        "--no-session-persistence",
        "--strict-mcp-config",
        "--mcp-config",
        r#"{"mcpServers":{}}"#,
        "--disable-slash-commands",
        "--tools",
        "",
        "--system-prompt",
        call.system_prompt,
        "--json-schema",
    ]);
    command.arg(call.json_schema.to_string());
    if let Some(model) = model {
        command.arg("--model").arg(model);
    }
    command.env_remove("CLAUDE_CODE_EFFORT_LEVEL");
    if let Some(effort) = effective_effort(call, model) {
        command.arg("--effort").arg(effort);
        command.env("CLAUDE_CODE_EFFORT_LEVEL", effort);
    }
    command
}

/// The tree and root are owned together, including when a future is dropped
/// while writing stdin or reading a pipe. No reader tasks outlive this guard.
struct ProcessGuard {
    child: tokio::process::Child,
    #[cfg(unix)]
    pid: Option<u32>,
    #[cfg(windows)]
    job: Option<std::sync::Arc<super::job::KillOnCloseJob>>,
}

impl ProcessGuard {
    fn new(child: tokio::process::Child) -> Self {
        Self {
            #[cfg(unix)]
            pid: child.id(),
            #[cfg(windows)]
            job: super::job::assign_kill_on_close(&child),
            child,
        }
    }

    fn stop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.pid.take() {
            super::kill_process_group(pid);
        }
        #[cfg(windows)]
        if let Some(job) = self.job.take() {
            drop(job);
        } else if let Some(pid) = self.child.id() {
            // The job can be refused by an enclosing host job. Keep the
            // existing tree-walk fallback while the root is still alive.
            super::kill_process_group(pid);
        }
        let _ = self.child.start_kill();
    }
}

impl Drop for ProcessGuard {
    fn drop(&mut self) {
        self.stop();
    }
}

async fn read_capped(
    mut pipe: impl AsyncRead + Unpin,
    cap: usize,
) -> Result<Vec<u8>, SideCallError> {
    let mut collected = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let read = pipe
            .read(&mut chunk)
            .await
            .map_err(|_| SideCallError::Failed)?;
        if read == 0 {
            return Ok(collected);
        }
        if read > cap - collected.len() {
            return Err(SideCallError::BadOutput);
        }
        collected.extend_from_slice(&chunk[..read]);
    }
}

async fn run(
    command: tokio::process::Command,
    cwd: &Path,
    input: &str,
    timeout: Duration,
) -> Result<SideCallOutput, SideCallError> {
    run_with_parser("claude", command, cwd, input, timeout, parse_result).await
}

pub(super) async fn run_with_parser(
    engine: &str,
    mut command: tokio::process::Command,
    cwd: &Path,
    input: &str,
    timeout: Duration,
    parse: fn(&[u8]) -> Result<SideCallOutput, SideCallError>,
) -> Result<SideCallOutput, SideCallError> {
    command
        .current_dir(cwd)
        .env("PATH", super::resolve::cli_search_path())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    super::hide_console(&mut command);
    crate::development_profile::enforce_homes(&mut command);
    let child = command.spawn().map_err(|e| {
        eprintln!("[side-call] {engine} spawn failed: {e}");
        SideCallError::Unavailable
    })?;
    let mut process = ProcessGuard::new(child);
    let mut stdin = process.child.stdin.take().ok_or(SideCallError::Failed)?;
    let stdout = process.child.stdout.take().ok_or(SideCallError::Failed)?;
    let stderr = process.child.stderr.take().ok_or(SideCallError::Failed)?;
    let collected = tokio::time::timeout(timeout, async {
        // Poll writes and both readers together: a CLI can emit diagnostics
        // before accepting stdin, and neither pipe may fill and deadlock it.
        tokio::try_join!(
            async {
                stdin
                    .write_all(input.as_bytes())
                    .await
                    .map_err(|_| SideCallError::Failed)?;
                drop(stdin);
                Ok::<(), SideCallError>(())
            },
            read_capped(stdout, MAX_OUTPUT),
            read_capped(stderr, MAX_STDERR),
            async {
                process
                    .child
                    .wait()
                    .await
                    .map_err(|_| SideCallError::Failed)
            },
        )
    })
    .await;
    let (_, stdout, stderr, status) = match collected {
        Ok(Ok(output)) => output,
        error => {
            process.stop();
            // Reap the killed root before returning; Drop is the backstop if
            // the caller aborts during this final wait as well.
            let _ = tokio::time::timeout(Duration::from_secs(2), process.child.wait()).await;
            return Err(match error {
                Err(_) => SideCallError::Timeout,
                Ok(Err(error)) => error,
                Ok(Ok(_)) => unreachable!(),
            });
        }
    };
    if !status.success() {
        eprintln!(
            "[side-call] {engine} exited {status} (stderr {} bytes)",
            stderr.len()
        );
        return Err(SideCallError::Failed);
    }
    let parsed = parse(&stdout);
    if parsed.is_err() {
        // Exit status and the stderr length only: stderr may quote the prompt.
        eprintln!(
            "[side-call] {engine} exited {} without a structured result (stderr {} bytes)",
            status,
            stderr.len()
        );
    }
    parsed
}

/// `--output-format json` prints one result object; its `structured_output`
/// is the schema-validated answer.
fn parse_result(stdout: &[u8]) -> Result<SideCallOutput, SideCallError> {
    let text = String::from_utf8_lossy(stdout);
    let value: Value = text
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .ok_or(SideCallError::BadOutput)?;
    if value.get("type").and_then(Value::as_str) != Some("result")
        || value.get("is_error").and_then(Value::as_bool) == Some(true)
        || value.get("subtype").and_then(Value::as_str) != Some("success")
    {
        return Err(SideCallError::Failed);
    }
    let structured = value
        .get("structured_output")
        .filter(|v| v.is_object())
        .cloned()
        .ok_or(SideCallError::BadOutput)?;
    Ok(SideCallOutput {
        structured,
        usage: value.get("usage").cloned(),
    })
}

pub(crate) fn cleanup_cursor_side_call_workspace(cursor_home: &Path, workspace: &Path) {
    let raw = workspace.to_string_lossy().to_string();
    let trimmed = raw.trim_end_matches(['/', '\\']).to_string();
    let mut slugs = Vec::new();
    for spelling in [&raw, &trimmed] {
        for lowercase in [true, false] {
            let slug = crate::history::discovery::cursor_encode_project_slug(spelling, lowercase);
            if !slug.is_empty() && !slugs.contains(&slug) {
                slugs.push(slug);
            }
        }
    }
    let projects_base = cursor_home.join("projects");
    for slug in slugs {
        let proj_dir = projects_base.join(&slug);
        if let Ok(entries) = std::fs::read_dir(proj_dir.join("agent-transcripts")) {
            for entry in entries.flatten() {
                let path = entry.path();
                let sid = if path.is_dir() {
                    path.file_name().and_then(|n| n.to_str()).map(str::to_string)
                } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                    path.file_stem().and_then(|s| s.to_str()).map(str::to_string)
                } else {
                    None
                };
                if let Some(sid) = sid {
                    super::sidechat::cleanup_cursor_session_in(cursor_home, &sid);
                }
            }
        }
        if proj_dir.is_dir() {
            let _ = std::fs::remove_dir_all(&proj_dir);
        }
    }
}

struct CursorSideCallCleanup {
    cursor_home: PathBuf,
    workspace: PathBuf,
}

impl Drop for CursorSideCallCleanup {
    fn drop(&mut self) {
        cleanup_cursor_side_call_workspace(&self.cursor_home, &self.workspace);
    }
}

/// One-shot Cursor CLI text call (`cursor-agent -p --output-format stream-json --mode ask`)
/// running in `<app_home>/side-call`. Any session created by Cursor CLI is immediately
/// removed from `~/.cursor/chats` and `~/.cursor/projects` upon completion or drop.
pub(crate) async fn cursor_text_call(
    model: &str,
    input: &str,
    timeout: Duration,
) -> Result<String, SideCallError> {
    let settings = crate::settings::read_settings().unwrap_or_default();
    super::cursor::ensure_model_selected(&settings, Some(model))
        .map_err(|_| SideCallError::Unavailable)?;
    let bin = super::engine_bin(&settings, "cursor");
    let cwd = crate::paths::app_home().join("side-call");
    std::fs::create_dir_all(&cwd).map_err(|_| SideCallError::Unavailable)?;
    let cursor_home = super::cursor::cursor_home();
    let _cleanup_guard = CursorSideCallCleanup {
        cursor_home,
        workspace: cwd.clone(),
    };
    let command = cursor_text_command(&bin, model, &cwd);
    let output = run_with_parser(
        "cursor",
        command,
        &cwd,
        input,
        timeout,
        parse_cursor_text_result,
    )
    .await?;
    output
        .structured
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or(SideCallError::BadOutput)
}

fn cursor_text_command(bin: &str, model: &str, cwd: &Path) -> tokio::process::Command {
    let mut command = command_for_binary(bin);
    crate::proxy::configure_cursor_command_proxy(&mut command);
    // Side-call callers supply a CLI slug, not a chat picker composite ID.
    // In particular keep -low/-fast suffixes and never substitute another model.
    command.args([
        "-p",
        "--output-format",
        "stream-json",
        "--trust",
        "--mode",
        "ask",
        "--model",
        model,
        "--workspace",
    ]);
    command.arg(cwd.as_os_str());
    command
}

fn parse_cursor_text_result(stdout: &[u8]) -> Result<SideCallOutput, SideCallError> {
    parse_cursor_text_result_in(stdout, &super::cursor::cursor_home())
}

pub(crate) fn parse_cursor_text_result_in(
    stdout: &[u8],
    cursor_home: &Path,
) -> Result<SideCallOutput, SideCallError> {
    let text = String::from_utf8_lossy(stdout);
    let mut assistant_chunks = String::new();
    let mut result_text: Option<String> = None;
    let mut usage: Option<Value> = None;
    let mut saw_success = false;
    let mut session_ids = Vec::new();

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if let Some(sid) = value
            .get("session_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if !session_ids.iter().any(|existing| existing == sid) {
                session_ids.push(sid.to_string());
            }
        }
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        let subtype = value.get("subtype").and_then(Value::as_str).unwrap_or("");
        match kind {
            "assistant" => {
                if let Some(blocks) = value.pointer("/message/content").and_then(Value::as_array) {
                    let chunk: String = blocks
                        .iter()
                        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                        .filter_map(|b| b.get("text").and_then(Value::as_str))
                        .collect();
                    if !chunk.is_empty() {
                        // Without --stream-partial-output each assistant event is a full block,
                        // or if multiple arrive we keep the latest complete summary block.
                        if value.get("timestamp_ms").is_none() {
                            assistant_chunks = chunk;
                        } else {
                            assistant_chunks.push_str(&chunk);
                        }
                    }
                }
            }
            "result" => {
                let failed = value.get("is_error").and_then(Value::as_bool) == Some(true)
                    || (!subtype.is_empty() && subtype != "success");
                if failed {
                    for sid in &session_ids {
                        super::sidechat::cleanup_cursor_session_in(cursor_home, sid);
                    }
                    return Err(SideCallError::Failed);
                }
                saw_success = true;
                usage = value.get("usage").cloned();
                if let Some(res) = value
                    .get("result")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    result_text = Some(res.to_string());
                }
            }
            _ => {}
        }
    }

    for sid in &session_ids {
        super::sidechat::cleanup_cursor_session_in(cursor_home, sid);
    }

    let final_text = result_text
        .or_else(|| {
            let trimmed = assistant_chunks.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        })
        .filter(|_| saw_success || !assistant_chunks.trim().is_empty())
        .ok_or(SideCallError::BadOutput)?;

    Ok(SideCallOutput {
        structured: serde_json::json!({ "text": final_text }),
        usage,
    })
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handoff_cursor_command_preserves_exact_slug_and_ask_mode() {
        for model in ["grok-4.7-low-fast", "grok-4.7-low", "future-model-unknown"] {
            let command = cursor_text_command("cursor-agent", model, Path::new("private-side-call"));
            let args: Vec<_> = command.as_std().get_args().map(|s| s.to_string_lossy().into_owned()).collect();
            let value = |flag| args.iter().position(|arg| arg == flag).map(|index| args[index + 1].as_str());
            assert_eq!(value("--model"), Some(model));
            assert_eq!(value("--mode"), Some("ask"));
            assert_eq!(value("--workspace"), Some("private-side-call"));
        }
    }
    use std::io::{Read, Write};

    const FIXTURE: &str = "engine::side_call::tests::fake_claude_process";

    #[test]
    fn naming_settings_reach_actual_command_and_override_channel_effort() {
        use crate::auto_title::config::NamingConfig;
        let schema = serde_json::json!({"type": "object"});
        let provider = serde_json::json!({"settingsConfig": {}});
        for (model, effort, resolved, expected_effort) in [
            (None, None, "sonnet", Some("xhigh")),
            (
                Some("opus"),
                Some("xhigh"),
                "claude-opus-5-5",
                Some("xhigh"),
            ),
            (Some("opus"), Some("ultra"), "claude-opus-5-5", Some("max")),
            (Some("bogus"), Some("bogus"), "sonnet", Some("xhigh")),
            (Some("haiku"), Some("max"), "claude-haiku-4-5", None),
            (Some("sonnet"), Some("high"), "claude-sonnet-4-5", None),
            (Some("opus"), Some("high"), "gemini-3.8-flash", None),
        ] {
            let settings = crate::settings::AppSettings {
                auto_title_enabled: Some(false),
                auto_title_model: model.map(str::to_string),
                auto_title_effort: effort.map(str::to_string),
                default_models: HashMap::from([("claude".into(), "chat-model".into())]),
                default_efforts: HashMap::from([("claude".into(), "medium".into())]),
                ..Default::default()
            };
            let naming = NamingConfig::from_settings(&settings);
            let call = naming.request("fixture conversation", &schema);
            let mut env = HashMap::from([
                (
                    format!("ANTHROPIC_DEFAULT_{}_MODEL", naming.model.to_uppercase()),
                    resolved.to_string(),
                ),
                ("CLAUDE_CODE_EFFORT_LEVEL".into(), "medium".into()),
            ]);
            let (command, actual_model) =
                channel_command("fixture-claude", &call, Some(&provider), &mut env);
            let args: Vec<_> = command
                .as_std()
                .get_args()
                .map(|a| a.to_string_lossy().into_owned())
                .collect();
            let value = |flag: &str| {
                args.iter()
                    .position(|a| a == flag)
                    .map(|i| args[i + 1].as_str())
            };
            assert_eq!(actual_model.as_deref(), Some(resolved));
            assert_eq!(value("--model"), Some(resolved));
            assert_eq!(value("--effort"), expected_effort);
            assert_eq!(
                env.get("CLAUDE_CODE_EFFORT_LEVEL").map(String::as_str),
                expected_effort
            );
            let process_env = command
                .as_std()
                .get_envs()
                .find(|(k, _)| *k == "CLAUDE_CODE_EFFORT_LEVEL")
                .and_then(|(_, v)| v)
                .map(|v| v.to_str().unwrap());
            assert_eq!(process_env, expected_effort);
            assert!(args.iter().any(|a| a == "--no-session-persistence"));
            assert_eq!(settings.auto_title_enabled, Some(false));
            assert_eq!(settings.default_models["claude"], "chat-model");
            assert_eq!(settings.default_efforts["claude"], "medium");
        }
    }

    #[test]
    fn resolved_model_capabilities_exclude_haiku_old_releases_and_unknown_relays() {
        for model in [
            "haiku",
            "claude-haiku-4-5-20251001",
            "claude-sonnet-4-5",
            "claude-opus-4-1",
            "relay-sonnet",
            "default",
        ] {
            assert!(!model_supports_effort(model), "{model}");
        }
        for model in [
            "sonnet",
            "opus",
            "fable",
            "claude-sonnet-4-6",
            "claude-opus-4-5-20251101",
            "claude-opus-5-5[1m]",
        ] {
            assert!(model_supports_effort(model), "{model}");
        }
    }

    struct FixtureDir(PathBuf);

    impl FixtureDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("ccgui-side-call-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn built(&self, mode: &str) -> (BuiltCommand, PathBuf, PathBuf) {
            let staged = self.0.join("private-channel.json");
            let unrelated = self.0.join("another-call.json");
            std::fs::write(&staged, b"fake channel credential").unwrap();
            std::fs::write(&unrelated, b"another call owns this").unwrap();
            let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
            command
                .args(["--exact", FIXTURE, "--ignored", "--nocapture"])
                .env("CCGUI_SIDE_CALL_FIXTURE", &self.0)
                .env("CCGUI_SIDE_CALL_MODE", mode);
            (
                BuiltCommand {
                    command,
                    stdin_payload: None,
                    keep_stdin_open: false,
                    cleanup_files: vec![staged.clone()],
                    mcp_restore: None,
                    preassigned_session_id: None,
                },
                staged,
                unrelated,
            )
        }
    }

    impl Drop for FixtureDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Runs only as a fake CLI subprocess. It never reads application config,
    /// credentials, transcripts or a real model. Long-lived modes deliberately
    /// keep a descendant alive to verify the production tree cleanup too.
    #[test]
    #[ignore = "fake CLI subprocess for side-call regressions"]
    fn fake_claude_process() {
        let Some(dir) = std::env::var_os("CCGUI_SIDE_CALL_FIXTURE") else {
            return;
        };
        let dir = PathBuf::from(dir);
        let mode = std::env::var("CCGUI_SIDE_CALL_MODE").unwrap();
        if mode == "descendant" {
            std::fs::write(dir.join("descendant.pid"), std::process::id().to_string()).unwrap();
            std::thread::sleep(Duration::from_secs(30));
            return;
        }
        std::fs::write(dir.join("root.pid"), std::process::id().to_string()).unwrap();
        let mut input = String::new();
        std::io::stdin().read_to_string(&mut input).unwrap();
        if matches!(
            mode.as_str(),
            "hang" | "oversized_stdout" | "oversized_stderr"
        ) {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args(["--exact", FIXTURE, "--ignored", "--nocapture"])
                .env("CCGUI_SIDE_CALL_MODE", "descendant")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x08000000);
            }
            let _descendant = command.spawn().unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while !dir.join("descendant.pid").exists() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "descendant startup timed out"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            if mode == "oversized_stdout" {
                std::io::stdout()
                    .write_all(&vec![b'x'; MAX_OUTPUT + 1])
                    .unwrap();
                std::io::stdout().flush().unwrap();
            } else if mode == "oversized_stderr" {
                std::io::stderr()
                    .write_all(&vec![b'x'; MAX_STDERR + 1])
                    .unwrap();
                std::io::stderr().flush().unwrap();
            }
            std::thread::sleep(Duration::from_secs(30));
            return;
        }
        if mode == "success" || mode == "nonzero" {
            println!(
                "\n{}",
                serde_json::json!({
                    "type": "result", "subtype": "success", "is_error": false,
                    "structured_output": { "action": "keep", "title": "fixture" }
                })
            );
            std::io::stdout().flush().unwrap();
            if mode == "nonzero" {
                std::process::exit(7);
            }
        } else {
            println!("\ninvalid result");
        }
    }

    async fn wait_for_tree(dir: &Path) -> Vec<u32> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            let pids: Option<Vec<u32>> = ["root.pid", "descendant.pid"]
                .iter()
                .map(|name| std::fs::read_to_string(dir.join(name)).ok()?.parse().ok())
                .collect();
            if let Some(pids) = pids {
                return pids;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "fake CLI tree did not start"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn assert_tree_stopped(pids: &[u32]) {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
        let pids: Vec<_> = pids.iter().copied().map(Pid::from_u32).collect();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let mut system = System::new();
        loop {
            system.refresh_processes_specifics(
                ProcessesToUpdate::Some(&pids),
                true,
                ProcessRefreshKind::nothing(),
            );
            if pids.iter().all(|pid| system.process(*pid).is_none()) {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "fake CLI process survived: {pids:?}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[test]
    fn command_disables_conversation_features_and_preserves_schema_and_model() {
        let schema =
            serde_json::json!({"type": "object", "properties": {"title": {"type": "string"}}});
        for model in ["sonnet", "haiku", "relay-sonnet"] {
            let call = StructuredCall {
                provider_id: None,
                system_prompt: "fixture system prompt",
                input: "fixture input",
                json_schema: &schema,
                model,
                effort: "low",
                timeout: Duration::from_secs(5),
            };
            let command = isolated_command("fixture-claude", &call, Some(model));
            let args: Vec<_> = command
                .as_std()
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect();
            for flag in [
                "-p",
                "--no-session-persistence",
                "--strict-mcp-config",
                "--disable-slash-commands",
            ] {
                assert!(args.iter().any(|arg| arg == flag), "missing {flag}");
            }
            let value =
                |flag: &str| args[args.iter().position(|arg| arg == flag).unwrap() + 1].as_str();
            assert_eq!(value("--output-format"), "json");
            assert_eq!(value("--mcp-config"), r#"{"mcpServers":{}}"#);
            assert_eq!(value("--tools"), "");
            assert_eq!(value("--json-schema"), schema.to_string());
            assert_eq!(value("--model"), model);
            if model_supports_effort(model) {
                assert_eq!(value("--effort"), "low");
            } else {
                assert!(!args.iter().any(|arg| arg == "--effort"));
            }
            assert_eq!(value("--system-prompt"), call.system_prompt);
            assert!(!args.iter().any(|arg| arg.contains("dangerously")
                || arg == "--resume"
                || arg == "--session-id"));
            assert!(!args.iter().any(|arg| arg == call.input));
        }
    }

    #[tokio::test]
    async fn successful_and_failed_calls_remove_only_their_staged_file() {
        for (mode, error) in [
            ("success", None),
            ("bad", Some(SideCallError::BadOutput)),
            ("nonzero", Some(SideCallError::Failed)),
        ] {
            let dir = FixtureDir::new();
            let (built, staged, unrelated) = dir.built(mode);
            let result = run_built(built, &dir.0, "fixture input", Duration::from_secs(10)).await;
            assert_eq!(result.as_ref().err().copied(), error);
            if mode == "success" {
                assert_eq!(result.unwrap().structured["title"], "fixture");
            }
            assert!(!staged.exists());
            assert!(unrelated.exists());
        }
    }

    #[tokio::test]
    async fn spawn_failure_removes_the_staged_file() {
        let dir = FixtureDir::new();
        let (mut built, staged, unrelated) = dir.built("success");
        built.command = tokio::process::Command::new(dir.0.join("nonexistent-cli"));
        assert_eq!(
            run_built(built, &dir.0, "fixture", Duration::from_secs(1))
                .await
                .unwrap_err(),
            SideCallError::Unavailable
        );
        assert!(!staged.exists());
        assert!(unrelated.exists());
    }

    #[tokio::test]
    async fn oversized_stdout_and_stderr_stop_the_tree_before_the_timeout() {
        for mode in ["oversized_stdout", "oversized_stderr"] {
            let dir = FixtureDir::new();
            let (built, staged, unrelated) = dir.built(mode);
            let result = run_built(built, &dir.0, "fixture", Duration::from_secs(10)).await;
            assert_eq!(result.unwrap_err(), SideCallError::BadOutput);
            let pids = wait_for_tree(&dir.0).await;
            assert_tree_stopped(&pids).await;
            assert!(!staged.exists());
            assert!(unrelated.exists());
        }
    }

    #[tokio::test]
    async fn timeout_removes_credentials_and_stops_the_tree() {
        let dir = FixtureDir::new();
        let (built, staged, unrelated) = dir.built("hang");
        let result = run_built(built, &dir.0, "fixture", Duration::from_secs(2)).await;
        assert_eq!(result.unwrap_err(), SideCallError::Timeout);
        let pids = wait_for_tree(&dir.0).await;
        assert_tree_stopped(&pids).await;
        assert!(!staged.exists());
        assert!(unrelated.exists());
    }

    #[tokio::test]
    async fn abort_removes_credentials_and_stops_the_tree() {
        let dir = FixtureDir::new();
        let (built, staged, unrelated) = dir.built("hang");
        let cwd = dir.0.clone();
        let task = tokio::spawn(async move {
            run_built(built, &cwd, "fixture", Duration::from_secs(30)).await
        });
        let pids = wait_for_tree(&dir.0).await;
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_tree_stopped(&pids).await;
        assert!(!staged.exists());
        assert!(unrelated.exists());
    }

    #[test]
    fn parses_the_structured_answer_of_a_successful_result() {
        let out = br#"{"type":"result","subtype":"success","is_error":false,"structured_output":{"action":"keep","title":"t","reason":"r"},"usage":{"output_tokens":3}}"#;
        let parsed = parse_result(out).unwrap();
        assert_eq!(parsed.structured["action"], "keep");
        assert_eq!(parsed.usage.unwrap()["output_tokens"], 3);
    }

    #[test]
    fn errors_and_missing_structure_are_not_answers() {
        let error = br#"{"type":"result","subtype":"error_during_execution","is_error":true}"#;
        assert_eq!(parse_result(error).unwrap_err(), SideCallError::Failed);
        let plain = br#"{"type":"result","subtype":"success","is_error":false,"result":"hi"}"#;
        assert_eq!(parse_result(plain).unwrap_err(), SideCallError::BadOutput);
        assert_eq!(
            parse_result(b"not json").unwrap_err(),
            SideCallError::BadOutput
        );
    }

    #[test]
    fn cursor_side_call_parses_text_and_cleans_up_ephemeral_sessions() {
        let root = std::env::temp_dir().join(format!("ccgui-cursor-sidecall-{}", uuid::Uuid::new_v4()));
        let cursor_home = root.join("cursor-home");
        let side_ws = root.join("side-call");
        std::fs::create_dir_all(&side_ws).unwrap();

        let slug = crate::history::discovery::cursor_encode_project_slug(
            &side_ws.to_string_lossy(),
            true,
        );
        let sid = "ephemeral-sid-1234";
        let chat_dir = cursor_home.join("chats/md5bucket").join(sid);
        let transcript_dir = cursor_home
            .join("projects")
            .join(&slug)
            .join("agent-transcripts")
            .join(sid);
        std::fs::create_dir_all(&chat_dir).unwrap();
        std::fs::create_dir_all(&transcript_dir).unwrap();
        std::fs::write(transcript_dir.join(format!("{sid}.jsonl")), b"{}").unwrap();

        let stream = format!(
            "{}\n{}\n{}\n",
            serde_json::json!({"type":"system","subtype":"init","session_id":sid,"model":"Grok 4.7"}),
            serde_json::json!({"type":"assistant","message":{"content":[{"type":"text","text":"- **目标与背景**：交接压缩"}]}}),
            serde_json::json!({"type":"result","subtype":"success","is_error":false,"session_id":sid,"result":"- **目标与背景**：交接压缩"})
        );
        let parsed = parse_cursor_text_result_in(stream.as_bytes(), &cursor_home).unwrap();
        assert_eq!(parsed.structured["text"], "- **目标与背景**：交接压缩");
        assert!(!chat_dir.exists(), "chat dir should be removed immediately");
        assert!(
            !transcript_dir.exists(),
            "transcript dir should be removed immediately"
        );

        cleanup_cursor_side_call_workspace(&cursor_home, &side_ws);
        assert!(!cursor_home.join("projects").join(&slug).exists());

        let _ = std::fs::remove_dir_all(&root);
    }
}
