use super::{
    command_for_binary, images, push_session_id, tool_call_message, tool_call_patch, BuiltCommand,
    Engine, EngineEvent, SendRequest, INTERRUPT_REQUEST_ID_PREFIX,
};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

#[path = "claude_throughput.rs"]
mod throughput;

pub struct ClaudeEngine {
    throughput: Mutex<throughput::ClaudeThroughput>,
    lifecycle: Mutex<super::claude_lifecycle::ClaudeLifecycle>,
    /// Per-block partial JSON for tool_use inputs. Streamed as
    /// `input_json_delta` after a name-only `content_block_start`.
    pending_tool_json: Mutex<HashMap<u64, PendingTool>>,
    /// tool_use id -> tool name, recorded at `content_block_start` so a
    /// later `tool_result` (user message) can be attributed to its call.
    tool_names: Mutex<HashMap<String, String>>,
    /// tool_use id -> structured path argument, recorded at
    /// `content_block_stop` once the input JSON is complete. Permission
    /// denials resolve the real denied path from here instead of scraping
    /// the free-text error.
    tool_paths: Mutex<HashMap<String, String>>,
    /// Post-compaction remaining context tokens from `compact_boundary` event,
    /// used to report accurate post-compaction usage instead of the turn's billing usage.
    compact_post_tokens: Mutex<Option<i64>>,
    /// Per-run native auth metadata; absent for custom channels.
    quota_stamp: Mutex<Option<(String, std::path::PathBuf)>>,
}

pub(crate) fn normalize_effort(effort: &str) -> Result<&str, String> {
    match effort {
        "ultra" => Ok("max"), // Legacy GUI value was never a native effort.
        "low" | "medium" | "high" | "xhigh" | "max" => Ok(effort),
        _ => Err(format!("unsupported Claude effort: {effort}")),
    }
}

struct PendingTool {
    name: String,
    id: Option<String>,
    json: String,
}

impl ClaudeEngine {
    pub fn new() -> Self {
        Self {
            throughput: Mutex::new(throughput::ClaudeThroughput::default()),
            lifecycle: Mutex::new(super::claude_lifecycle::ClaudeLifecycle::default()),
            pending_tool_json: Mutex::new(HashMap::new()),
            tool_names: Mutex::new(HashMap::new()),
            tool_paths: Mutex::new(HashMap::new()),
            compact_post_tokens: Mutex::new(None),
            quota_stamp: Mutex::new(None),
        }
    }
}

impl Engine for ClaudeEngine {
    fn disable_account_metrics(&self) {
        *self.quota_stamp.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
    fn id(&self) -> &'static str {
        "claude"
    }

    fn supports_images(&self) -> bool {
        true
    }
    fn supports_computer_use(&self) -> bool {
        true
    }
    fn supports_effort(&self) -> bool {
        true
    }
    fn supports_compact(&self) -> bool {
        true
    }
    fn supported_permissions(&self) -> &'static [&'static str] {
        &["auto", "manual", "plan", "bypass"]
    }

    /// 只读工具约束：claude 的 plan 模式会拒绝一切编辑/命令，再叠加
    /// 逐次 --allowedTools 白名单与显式 --disallowedTools。
    fn supports_tool_constraints(&self) -> bool {
        true
    }

    fn build_command(&self, req: &SendRequest, bin: &str) -> Result<BuiltCommand, String> {
        self.build_command_with_host_chat(req, bin, None)
    }

    fn build_command_with_host_chat(
        &self,
        req: &SendRequest,
        bin: &str,
        host_chat_server: Option<&Value>,
    ) -> Result<BuiltCommand, String> {
        if host_chat_server.is_some() && req.allowed_tools.is_some() {
            return Err("tool-constrained runs cannot mount the host chat bridge".into());
        }
        *self.throughput.lock().unwrap_or_else(|p| p.into_inner()) =
            throughput::ClaudeThroughput::default();
        // 【对话额度】原生 Claude 渠道的每段对话都记标记。setup-token 用令牌哈希，
        // 这样响应头带回的 rate_limit_event 不会因为登录摘要为空被丢掉。
        *self.quota_stamp.lock().unwrap_or_else(|p| p.into_inner()) =
            if matches!(
                req.provider_id.as_deref(),
                Some(crate::config::LOCAL_PROVIDER_ID | crate::config::LEGACY_LOCAL_CONFIG_TOML_ID)
            ) && crate::claude_quota::local_workspace_auth_is_default(&req.workspace) {
                crate::claude_quota::conversation_stamp().map(|stamp| (stamp, req.workspace.clone()))
            } else {
                None
            };
        let mut cmd = command_for_binary(bin);
        // The native Agent SDK's run-over signal. `result` alone is only a
        // response boundary and can precede background notification turns.
        cmd.env("CLAUDE_CODE_SDK_READS_SESSION_STATE", "1");
        cmd.arg("-p");
        cmd.arg("--input-format");
        cmd.arg("stream-json");
        cmd.arg("--output-format");
        cmd.arg("stream-json");
        cmd.arg("--verbose");
        cmd.arg("--include-partial-messages");
        // SDK control protocol over stdin/stdout: permission asks — including
        // AskUserQuestion, whose dialog is this client's job — arrive as
        // can_use_tool control_requests. Without the flag the CLI treats
        // every ask as terminal and never mounts AskUserQuestion at all.
        cmd.arg("--permission-prompt-tool");
        cmd.arg("stdio");
        // Headless -p cannot prompt mid-turn: "manual" maps onto claude's
        // default mode, where approval-needing tools are denied and the
        // agent is told to work around them (honest degrade, no fake ask).
        // Tools pre-approved for this run, emitted as a single --allowedTools
        // (headless -p cannot prompt mid-turn, so anything not listed here
        // gets denied outright).
        let mut preapproved: Vec<&str> = Vec::new();
        if let Some(tools) = req.allowed_tools.as_deref() {
            // 任务工作台的只读约束：plan 模式拒绝任何编辑/命令，再叠加
            // 白名单；headless -p 下未列入 --allowedTools 的工具会被拒。
            // 已知写工具额外显式 deny，防止模式解析差异。
            cmd.arg("--permission-mode");
            cmd.arg("plan");
            cmd.arg("--allowedTools");
            for tool in tools {
                cmd.arg(tool);
            }
            cmd.arg("--disallowedTools");
            for tool in ["Bash", "Edit", "Write", "NotebookEdit", "Task"] {
                if !tools.iter().any(|allowed| allowed == tool) {
                    cmd.arg(tool);
                }
            }
        } else {
            match self.resolve_permission(req.permission.as_deref()) {
                "bypass" => {
                    cmd.arg("--dangerously-skip-permissions");
                }
                mode => {
                    cmd.arg("--permission-mode");
                    cmd.arg(match mode {
                        "manual" => "default",
                        "plan" => "plan",
                        _ => "acceptEdits",
                    });
                    if mode == "auto" {
                        // acceptEdits pre-approves file edits only; WebSearch and
                        // WebFetch still ask, and headless -p cannot prompt, so
                        // the CLI would deny every web call outright. Pre-approve
                        // the two read-only network tools in auto mode.
                        preapproved.extend(["WebSearch", "WebFetch"]);
                    }
                }
            }
        }
        let mut mcp_servers = serde_json::Map::new();
        if let Some(server) = host_chat_server {
            mcp_servers.insert(crate::host_chat::MCP_SERVER_NAME.to_string(), server.clone());
            // These exact tools enforce trusted local task scope and direct
            // parent ownership in the host. A headless permission denial would
            // otherwise prevent the authorized delegation from running. Do not
            // approve the whole server: ordinary cross-chat sends still require
            // their existing authorization path.
            preapproved.extend([
                "mcp__ccgui__task_spawn", "mcp__ccgui__task_list",
                "mcp__ccgui__task_wait", "mcp__ccgui__task_send",
                "mcp__ccgui__task_renew", "mcp__ccgui__task_stop",
            ]);
        }
        if req.computer_use == Some(true) {
            // Computer use: expose this app's screenshot/input driver as an
            // MCP child process (see computer_use.rs) and pre-approve its
            // tools — a click-per-approval loop is unusable; the user opted
            // in via the computer-use dialog and the driver itself fails
            // closed on missing OS grants.
            let exe = std::env::current_exe()
                .map_err(|e| format!("resolve own exe for computer use: {e}"))?;
            let mut server = serde_json::json!({
                "command": exe.to_string_lossy(),
                "args": crate::paths::service_args("--computer-use-mcp"),
            });
            // Overlay control channel: the child reports action targets so
            // the main app's virtual cursor can follow (absent in tests).
            if let (Some(base), Some(token)) = (
                crate::cu_overlay::control_base(),
                crate::cu_overlay::control_token(),
            ) {
                server["env"] = serde_json::json!({
                    "CCGUI_CU_CONTROL": base,
                    "CCGUI_CU_TOKEN": token,
                });
            }
            mcp_servers.insert("ccgui-computer".to_string(), server);
            preapproved.push("mcp__ccgui-computer");
        }
        if !mcp_servers.is_empty() {
            cmd.arg("--mcp-config");
            cmd.arg(serde_json::json!({ "mcpServers": mcp_servers }).to_string());
        }
        if !preapproved.is_empty() {
            cmd.arg("--allowedTools");
            for tool in preapproved {
                cmd.arg(tool);
            }
        }
        if let Some(model) = req.model.as_deref() {
            cmd.arg("--model");
            // prepare_launch resolves aliases against the selected channel;
            // reading native settings here would remap independent channels.
            cmd.arg(model);
        }
        if let Some(enabled) = req.claude_ultracode {
            cmd.arg("--settings");
            cmd.arg(serde_json::json!({ "ultracode": enabled }).to_string());
        }
        if let Some(effort) = req.effort.as_deref() {
            let effort = normalize_effort(effort)?;
            cmd.arg("--effort");
            cmd.arg(effort);
            // 【官方思考档位】只保留 CLI 自己的 --effort 与同名环境变量。
            // 不再附加已弃用的 MAX_THINKING_TOKENS。
            cmd.env("CLAUDE_CODE_EFFORT_LEVEL", effort);
        }
        // Granted directories ride every launch: the CLI cannot expand its
        // allowed-dirs mid-process, and each send is a fresh process anyway,
        // so a grant approved mid-conversation takes effect on the next send.
        let mut seen_dirs = std::collections::HashSet::new();
        for dir in &req.additional_dirs {
            let dir = dir.trim();
            if dir.is_empty()
                || dir == req.workspace.to_string_lossy()
                || !seen_dirs.insert(dir.to_string())
            {
                continue;
            }
            cmd.arg("--add-dir");
            cmd.arg(dir);
        }
        if let Some(session_id) = req.session_id.as_deref() {
            cmd.arg("--resume");
            cmd.arg(session_id);
        }
        let stdin_payload = images::claude_stdin_message(&req.prompt, &req.images, &req.workspace)?;
        Ok(BuiltCommand {
            command: cmd,
            stdin_payload: Some(stdin_payload),
            keep_stdin_open: true,
            cleanup_files: Vec::new(),
            mcp_restore: None,
            preassigned_session_id: None,
        })
    }

    fn parse_line(&self, line: &str, out: &mut Vec<EngineEvent>) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        // Independent telemetry must precede result's terminal events. It
        // reads the raw CLI accounting, never compacted context-window usage.
        if let Some(snapshot) = self
            .throughput
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .observe(&value, std::time::Instant::now())
        {
            out.push(EngineEvent::Throughput(snapshot));
        }
        // A subagent's messages carry parent_tool_use_id; only the main loop's
        // own content shows that it is replying (see ClaudeLifecycle).
        if matches!(event_type, "stream_event" | "assistant")
            && value.get("parent_tool_use_id").map_or(true, Value::is_null)
        {
            self.lifecycle
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .main_message(out);
        }
        match event_type {
            "rate_limit_event" => {
                if line.len() <= 256 * 1024 {
                    if let Some((stamp, workspace)) = self
                        .quota_stamp
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .as_ref()
                    {
                        if crate::claude_quota::local_workspace_auth_is_default(workspace) {
                            crate::claude_quota::ingest_stream(stamp, &value);
                        }
                    }
                }
            }
            "system" => {
                push_session_id(&value, "session_id", out);
                self.lifecycle.lock().unwrap_or_else(|p| p.into_inner()).system(&value, out);
                let subtype = value.get("subtype").and_then(Value::as_str);
                if subtype == Some("api_retry") {
                    // Live progress, not an error: the CLI backs off for
                    // minutes (10 attempts, 30s+ delays) and then continues.
                    // The run status line shows "重试中 x/y"; the detail
                    // rides along for its tooltip.
                    out.push(EngineEvent::Retry {
                        attempt: value.get("attempt").and_then(Value::as_u64).unwrap_or(0),
                        max: value
                            .get("max_retries")
                            .and_then(Value::as_u64)
                            .unwrap_or(0),
                        message: format_api_retry(&value),
                    });
                } else if subtype == Some("init") {
                    // `system/init` is the only place the CLI reports which MCP
                    // servers it actually loaded. Capture it as an engine event
                    // (session-scoped snapshot for the MCP settings page); its
                    // `tools` list lets us attribute `mcp__<server>__<tool>`
                    // names back to each server.
                    let servers = value
                        .get("mcp_servers")
                        .or_else(|| value.get("mcpServers"))
                        .and_then(Value::as_array)
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(|item| {
                                    let name = item
                                        .get("name")
                                        .and_then(Value::as_str)
                                        .map(str::trim)
                                        .filter(|name| !name.is_empty())?;
                                    let status = item
                                        .get("status")
                                        .and_then(Value::as_str)
                                        .map(str::trim)
                                        .filter(|status| !status.is_empty())
                                        .map(str::to_string);
                                    Some((name.to_string(), status))
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    if !servers.is_empty() {
                        let tools = value
                            .get("tools")
                            .and_then(Value::as_array)
                            .map(|items| {
                                items
                                    .iter()
                                    .filter_map(Value::as_str)
                                    .map(str::to_string)
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default();
                        out.push(EngineEvent::McpServers { servers, tools });
                    }
                } else if subtype == Some("compact_boundary") {
                    if let Some(post_tokens) = value
                        .get("compactMetadata")
                        .and_then(|m| m.get("postTokens").or_else(|| m.get("post_tokens")))
                        .and_then(Value::as_i64)
                    {
                        if let Ok(mut lock) = self.compact_post_tokens.lock() {
                            *lock = Some(post_tokens);
                        }
                        let usage_obj = serde_json::json!({
                            "input_tokens": post_tokens,
                            "total_tokens": post_tokens,
                        });
                        out.push(EngineEvent::Usage(usage_obj));
                    }
                }
            }
            "stream_event" => parse_stream_event(
                &self.pending_tool_json,
                &self.tool_names,
                &self.tool_paths,
                &value,
                out,
            ),
            "assistant" => {
                // Full message snapshot; used as session-id and actual model source.
                push_session_id(&value, "session_id", out);
                if let Some(model) = value
                    .get("message")
                    .and_then(|m| m.get("model"))
                    .or_else(|| value.get("model"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    out.push(EngineEvent::Model(model.to_string()));
                }
                if let Some(effort) = value
                    .get("message")
                    .and_then(|m| m.get("thinking_effort"))
                    .or_else(|| value.get("thinking_effort"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    out.push(EngineEvent::Effort(effort.to_string()));
                }
            }
            "user" => {
                // tool_result blocks carry permission denials as is_error
                // text (headless cannot prompt). Surface them so the UI can
                // offer a directory grant instead of letting the model
                // narrate a terminal prompt that does not exist.
                for (id, text) in tool_result_error_blocks(&value) {
                    if !looks_like_permission_denial(&text) {
                        continue;
                    }
                    // The denied call's structured input is authoritative:
                    // resolve the real path argument by tool_use id and only
                    // fall back to scraping the free-text error when the call
                    // was never seen (e.g. resumed transcript) or carries no
                    // path argument (e.g. Bash).
                    let tool = id
                        .as_ref()
                        .and_then(|id| self.tool_names.lock().ok()?.get(id).cloned());
                    let path = id
                        .as_ref()
                        .and_then(|id| self.tool_paths.lock().ok()?.get(id).cloned())
                        .or_else(|| extract_absolute_path(&text));
                    out.push(EngineEvent::PermissionDenied {
                        tool,
                        path,
                        message: text,
                    });
                }
                // Tool result output emitted in response to tool_use. The
                // tool name is resolved from the tool_use_id recorded at
                // content_block_start, so the result patch lands on the
                // matching row even when tool calls run in parallel.
                if let Some(content) = value
                    .get("message")
                    .and_then(|m| m.get("content"))
                    .and_then(Value::as_array)
                {
                    for block in content {
                        if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                            // Error blocks are surfaced as permission denials
                            // above (or narrated by the model); denial-shaped
                            // text without is_error stays silent for the same
                            // reason. Keep both out of the timeline panel to
                            // avoid double-reporting.
                            if block
                                .get("is_error")
                                .and_then(Value::as_bool)
                                .unwrap_or(false)
                                || looks_like_permission_denial(&tool_result_block_text(block))
                            {
                                continue;
                            }
                            let res = value.get("toolUseResult").or_else(|| block.get("content"));
                            let name = block
                                .get("tool_use_id")
                                .and_then(Value::as_str)
                                .and_then(|id| {
                                    self.tool_names
                                        .lock()
                                        .ok()
                                        .and_then(|map| map.get(id).cloned())
                                })
                                .unwrap_or_default();
                            out.push(super::tool_result_patch(name, res));
                        }
                    }
                }
            }
            "result" => {
                // Structured fallback: the final result lists every denial
                // of the turn. The frontend dedupes against the tool_result
                // signal above (same path), so double-reporting is harmless.
                if let Some(denials) = value.get("permission_denials").and_then(Value::as_array) {
                    for denial in denials {
                        let tool = denial
                            .get("tool_name")
                            .and_then(Value::as_str)
                            .map(str::trim)
                            .filter(|t| !t.is_empty())
                            .map(str::to_string);
                        let path = denial.get("tool_input").and_then(super::tool_path_arg);
                        if tool.is_some() || path.is_some() {
                            out.push(EngineEvent::PermissionDenied {
                                tool,
                                path,
                                message: String::new(),
                            });
                        }
                    }
                }
                let session_id = value
                    .get("session_id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                let raw_usage = value.get("usage").cloned();
                let usage = if let Ok(mut lock) = self.compact_post_tokens.lock() {
                    match lock.take() {
                        Some(post_tokens) => Some(compact_usage(post_tokens, raw_usage.as_ref())),
                        None => raw_usage,
                    }
                } else {
                    raw_usage
                }
                .map(|usage| attach_reported_context_window(usage, &value));
                let is_error = value
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let subtype = value.get("subtype").and_then(Value::as_str).unwrap_or("");
                // Consumed by every result, so an ack never outlives its reply.
                let acked_interrupt = self
                    .lifecycle
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .take_interrupt();
                if acked_interrupt && is_error && subtype == "error_during_execution" {
                    // The reply the user interrupted (native: control_response
                    // success -> this result -> idle). Only the reply ended; the
                    // CLI and its background tasks live on, so this is a turn
                    // boundary, not a failure. Without a prior ack the same
                    // result stays the terminal Error below, a genuine failure.
                    self.lifecycle
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .interrupted_result(session_id, usage, out);
                } else if is_error || subtype.starts_with("error") {
                    out.push(EngineEvent::Error(result_error_message(&value)));
                } else {
                    self.lifecycle.lock().unwrap_or_else(|p| p.into_inner()).result(session_id, usage, out);
                }
            }
            "control_request" => {
                // SDK control protocol asks. AskUserQuestion surfaces to the
                // UI; every other ask is denied in place (this client has no
                // approval card), preserving the old headless behavior.
                let request = value.get("request");
                let subtype = request
                    .and_then(|r| r.get("subtype"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let request_id = value
                    .get("request_id")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if request_id.is_empty() {
                    return;
                }
                if subtype == "can_use_tool" {
                    let tool_name = request
                        .and_then(|r| r.get("tool_name"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    if tool_name == "AskUserQuestion" {
                        out.push(EngineEvent::Question {
                            request_id: request_id.to_string(),
                            tool_use_id: request
                                .and_then(|r| r.get("tool_use_id"))
                                .and_then(Value::as_str)
                                .map(str::to_string),
                            input: request
                                .and_then(|r| r.get("input"))
                                .cloned()
                                .unwrap_or(Value::Null),
                        });
                    } else {
                        out.push(EngineEvent::ControlPermissionDeny {
                            request_id: request_id.to_string(),
                            tool_name,
                        });
                    }
                }
            }
            "control_response" => {
                if let Some(event) = super::native_task_control::response_event(&value) {
                    out.push(event);
                }
                // The interrupt ack turns the reply's coming
                // error_during_execution result into an interrupted turn end.
                // A failed interrupt (subtype "error") arms nothing.
                let response = value.get("response");
                let acked = response
                    .and_then(|r| r.get("subtype"))
                    .and_then(Value::as_str)
                    == Some("success")
                    && response
                        .and_then(|r| r.get("request_id"))
                        .and_then(Value::as_str)
                        .is_some_and(|id| id.starts_with(INTERRUPT_REQUEST_ID_PREFIX));
                if acked {
                    self.lifecycle
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .interrupt_acknowledged(out);
                }
            }
            "control_cancel_request" => {
                if let Some(request_id) = value.get("request_id").and_then(Value::as_str) {
                    out.push(EngineEvent::QuestionSettled {
                        request_id: request_id.to_string(),
                    });
                }
            }
            _ => {}
        }
    }
}

/// Fold the CLI's reported context window into a turn's usage.
///
/// Claude's `result` line carries the window per model under `modelUsage`
/// (`{ "<model>": { contextWindow, maxOutputTokens, … } }`); it never sends
/// `model_context_window`, which is the key the rest of the app reads. Without
/// this, every Claude turn fell through to the UI's assumed 200k — wrong for
/// the 1M `[1m]` variants, and unverifiable for the rest.
///
/// A turn can name several models (a subagent on a cheap model, background
/// work). The one that actually ran the turn is the one with the most tokens,
/// so its window wins; entries without a usable window are ignored.
fn attach_reported_context_window(mut usage: Value, source: &Value) -> Value {
    if usage.get("model_context_window").is_some() {
        return usage;
    }
    let Some(models) = source.get("modelUsage").and_then(Value::as_object) else {
        return usage;
    };
    let busiest = models
        .values()
        .filter_map(|model| {
            let window = model.get("contextWindow").and_then(Value::as_i64)?;
            if window <= 0 {
                return None;
            }
            let tokens: i64 = [
                "inputTokens",
                "outputTokens",
                "cacheReadInputTokens",
                "cacheCreationInputTokens",
            ]
            .iter()
            .filter_map(|key| model.get(*key).and_then(Value::as_i64))
            .sum();
            Some((tokens, window))
        })
        .max_by_key(|(tokens, _)| *tokens);
    let Some((_, window)) = busiest else {
        return usage;
    };
    if let Some(object) = usage.as_object_mut() {
        object.insert("model_context_window".to_string(), Value::from(window));
    }
    usage
}

/// Usage snapshot for a compacted turn. Occupancy is the post-compaction
/// remainder (`post_tokens`), not the turn's billing input, but the turn's
/// output still enters the context afterwards and the reported context
/// window is carried over so the breakdown keeps its segments and scale
/// (total = post_tokens + output_tokens).
fn compact_usage(post_tokens: i64, raw: Option<&Value>) -> Value {
    let output = raw
        .and_then(|u| u.get("output_tokens"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let mut usage = serde_json::json!({
        "input_tokens": post_tokens,
        "output_tokens": output,
        "total_tokens": post_tokens + output,
    });
    if let (Some(raw), Some(obj)) = (raw, usage.as_object_mut()) {
        if let Some(window) = raw.get("model_context_window") {
            obj.insert("model_context_window".to_string(), window.clone());
        }
    }
    usage
}

/// Phrases the CLI uses when a tool call is denied by the permission
/// system in headless mode (matched case-insensitively against the
/// tool_result error text).
const DENIAL_PHRASES: &[&str] = &[
    "requested permissions",
    "haven't granted it yet",
    "have not granted it yet",
    "requires approval",
    "requires permission",
    "permission denied",
    "blocked for security",
    "blocked. for security",
    "allowed working directories",
    "may only write to files",
    "outside the allowed",
    "outside workspace",
];

fn looks_like_permission_denial(message: &str) -> bool {
    let normalized = message.trim().to_ascii_lowercase();
    !normalized.is_empty() && DENIAL_PHRASES.iter().any(|p| normalized.contains(p))
}

/// What a failed `result` line says went wrong. Success-shaped failures carry
/// `result`; `error_during_execution` (a resume of a session the CLI never
/// persisted, "No conversation found with session ID …") carries only an
/// `errors` list, so reading `result` alone showed every such failure as the
/// bare fallback and hid the cause from the user.
fn result_error_message(value: &Value) -> String {
    let text = |v: &Value| v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    if let Some(message) = value.get("result").and_then(text) {
        return message;
    }
    let errors: Vec<String> = value
        .get("errors")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(text).collect())
        .unwrap_or_default();
    if errors.is_empty() {
        "claude turn failed".to_string()
    } else {
        errors.join("\n")
    }
}

/// First absolute-path-looking token in free text: Windows `C:\…` / `C:/…`
/// or POSIX `/…`, with surrounding quotes and punctuation trimmed.
fn extract_absolute_path(text: &str) -> Option<String> {
    for token in text.split_whitespace() {
        let cleaned = token.trim_matches(|c: char| {
            matches!(
                c,
                '"' | '\'' | '`' | ',' | ';' | ')' | '(' | '[' | ']' | '{' | '}' | '.'
            )
        });
        let bytes = cleaned.as_bytes();
        if cleaned.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'\\' || bytes[2] == b'/')
        {
            return Some(cleaned.to_string());
        }
        if cleaned.starts_with('/') && cleaned.len() > 1 {
            return Some(cleaned.to_string());
        }
    }
    None
}

/// Text payload of a single tool_result block: plain string or joined text
/// parts.
fn tool_result_block_text(block: &Value) -> String {
    match block.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// (tool_use id, error text) pairs of tool_result blocks in a "user" stream
/// line. Content may be a plain string or an array of text blocks.
fn tool_result_error_blocks(value: &Value) -> Vec<(Option<String>, String)> {
    let mut out = Vec::new();
    let Some(content) = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return out;
    };
    for block in content {
        if block.get("type").and_then(Value::as_str) != Some("tool_result") {
            continue;
        }
        if !block
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        let text = tool_result_block_text(block);
        let text = text.trim().chars().take(500).collect::<String>();
        if !text.is_empty() {
            let id = block
                .get("tool_use_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            out.push((id, text));
        }
    }
    out
}

/// Human-readable line for a `system/api_retry` event.
fn format_api_retry(value: &Value) -> String {
    let attempt = value.get("attempt").and_then(Value::as_u64).unwrap_or(0);
    let max = value
        .get("max_retries")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let delay_ms = value
        .get("retry_delay_ms")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let detail = value
        .get("error")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|e| !e.is_empty() && *e != "unknown");
    let mut msg = match value.get("error_status").and_then(Value::as_u64) {
        Some(code) => format!("API error (HTTP {code})"),
        None => match detail {
            Some(detail) => format!("API error: {detail}"),
            None => "API error".to_string(),
        },
    };
    msg.push_str(&format!(
        "; retrying ({attempt}/{max}) in {:.1}s",
        delay_ms as f64 / 1000.0
    ));
    msg
}

/// Anthropic SSE wrapped events (requires --include-partial-messages).
fn parse_stream_event(
    pending: &Mutex<HashMap<u64, PendingTool>>,
    tool_names: &Mutex<HashMap<String, String>>,
    tool_paths: &Mutex<HashMap<String, String>>,
    value: &Value,
    out: &mut Vec<EngineEvent>,
) {
    let Some(event) = value.get("event") else {
        return;
    };
    match event.get("type").and_then(Value::as_str) {
        Some("message_start") => out.push(EngineEvent::Generation { active: true }),
        // Decode window closes after the last block (tool arguments included).
        Some("message_stop") => out.push(EngineEvent::Generation { active: false }),
        Some("content_block_delta") => parse_content_block_delta(pending, event, out),
        // Tool calls surface at block start with `input: {}`; the real
        // arguments stream in as `input_json_delta` and flush on stop.
        Some("content_block_start") => {
            parse_content_block_start(pending, tool_names, tool_paths, event, out)
        }
        Some("content_block_stop") => parse_content_block_stop(pending, tool_paths, event, out),
        _ => {}
    }
}

fn parse_content_block_delta(
    pending: &Mutex<HashMap<u64, PendingTool>>,
    event: &Value,
    out: &mut Vec<EngineEvent>,
) {
    let Some(delta) = event.get("delta") else {
        return;
    };
    match delta.get("type").and_then(Value::as_str) {
        Some("text_delta") | Some("thinking_delta") => {
            let is_thinking = delta.get("type").and_then(Value::as_str) == Some("thinking_delta");
            let key = if is_thinking { "thinking" } else { "text" };
            let Some(text) = delta.get(key).and_then(Value::as_str) else {
                return;
            };
            if text.is_empty() {
                return;
            }
            if is_thinking {
                out.push(EngineEvent::Thinking(text.to_string()));
            } else {
                out.push(EngineEvent::Delta(text.to_string()));
            }
        }
        Some("input_json_delta") => {
            let Some(partial) = delta.get("partial_json").and_then(Value::as_str) else {
                return;
            };
            if partial.is_empty() {
                return;
            }
            let Some(index) = event.get("index").and_then(Value::as_u64) else {
                return;
            };
            if let Ok(mut map) = pending.lock() {
                if let Some(tool) = map.get_mut(&index) {
                    tool.json.push_str(partial);
                }
            }
        }
        _ => {}
    }
}

fn parse_content_block_start(
    pending: &Mutex<HashMap<u64, PendingTool>>,
    tool_names: &Mutex<HashMap<String, String>>,
    tool_paths: &Mutex<HashMap<String, String>>,
    event: &Value,
    out: &mut Vec<EngineEvent>,
) {
    let Some(block) = event.get("content_block") else {
        return;
    };
    if block.get("type").and_then(Value::as_str) != Some("tool_use") {
        return;
    }
    let name = block
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("tool")
        .to_string();
    let input = block.get("input");
    if let Some(id) = block.get("id").and_then(Value::as_str) {
        if let Ok(mut map) = tool_names.lock() {
            map.insert(id.to_string(), name.clone());
        }
        // Non-streaming lines carry the full input at block start; record
        // its path argument immediately (partial streams patch it at stop).
        if let Some(path) = input.and_then(super::tool_path_arg) {
            if let Ok(mut map) = tool_paths.lock() {
                map.insert(id.to_string(), path);
            }
        }
    }
    if let Some(index) = event.get("index").and_then(Value::as_u64) {
        if let Ok(mut map) = pending.lock() {
            map.insert(
                index,
                PendingTool {
                    name: name.clone(),
                    id: block.get("id").and_then(Value::as_str).map(str::to_string),
                    json: String::new(),
                },
            );
        }
    }
    // Name-only start so the timeline can show the tool immediately; args
    // patch in when the JSON stream completes (or if input is already full).
    out.push(tool_call_message(name, input));
}

fn parse_content_block_stop(
    pending: &Mutex<HashMap<u64, PendingTool>>,
    tool_paths: &Mutex<HashMap<String, String>>,
    event: &Value,
    out: &mut Vec<EngineEvent>,
) {
    let Some(index) = event.get("index").and_then(Value::as_u64) else {
        return;
    };
    let Some(tool) = pending.lock().ok().and_then(|mut map| map.remove(&index)) else {
        return;
    };
    let trimmed = tool.json.trim();
    if trimmed.is_empty() {
        return;
    }
    let Ok(args) = serde_json::from_str::<Value>(trimmed) else {
        return;
    };
    if let (Some(id), Some(path)) = (tool.id.as_ref(), super::tool_path_arg(&args)) {
        if let Ok(mut map) = tool_paths.lock() {
            map.insert(id.clone(), path);
        }
    }
    out.push(tool_call_patch(tool.name, Some(&args)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn init_event_reports_mcp_servers_and_tools() {
        let line = serde_json::json!({
            "type": "system",
            "subtype": "init",
            "session_id": "s-1",
            "mcp_servers": [
                { "name": "alpha", "status": "connected" },
                { "name": "broken", "status": "failed" },
                { "name": "  " }
            ],
            "tools": ["Bash", "mcp__alpha__search", 7]
        })
        .to_string();
        let mut out = Vec::new();
        ClaudeEngine::new().parse_line(&line, &mut out);
        let (servers, tools) = out
            .iter()
            .find_map(|event| match event {
                EngineEvent::McpServers { servers, tools } => Some((servers, tools)),
                _ => None,
            })
            .expect("init must emit an MCP snapshot event");
        assert_eq!(
            servers,
            &vec![
                ("alpha".to_string(), Some("connected".to_string())),
                ("broken".to_string(), Some("failed".to_string())),
            ]
        );
        assert_eq!(
            tools,
            &vec!["Bash".to_string(), "mcp__alpha__search".to_string()]
        );

        // 没有 mcp_servers 的 init 不产生事件（不凭空造快照）。
        let mut out = Vec::new();
        ClaudeEngine::new().parse_line(
            &serde_json::json!({
                "type": "system",
                "subtype": "init",
                "session_id": "s-2",
                "mcp_servers": []
            })
            .to_string(),
            &mut out,
        );
        assert!(!out
            .iter()
            .any(|event| matches!(event, EngineEvent::McpServers { .. })));
    }

    #[test]
    fn assistant_message_reports_actual_thinking_effort() {
        let line = serde_json::json!({
            "type": "assistant",
            "session_id": "s-1",
            "message": { "model": "claude-opus-4", "thinking_effort": "high" }
        })
        .to_string();
        let mut out = Vec::new();
        ClaudeEngine::new().parse_line(&line, &mut out);
        assert!(
            out.iter()
                .any(|e| matches!(e, EngineEvent::Effort(level) if level == "high")),
            "got {out:?}"
        );

        // Top-level fallback; blank values are ignored.
        let mut out = Vec::new();
        ClaudeEngine::new().parse_line(
            &serde_json::json!({ "type": "assistant", "thinking_effort": " low " }).to_string(),
            &mut out,
        );
        assert!(
            out.iter()
                .any(|e| matches!(e, EngineEvent::Effort(level) if level == "low")),
            "got {out:?}"
        );
        let mut out = Vec::new();
        ClaudeEngine::new().parse_line(
            &serde_json::json!({ "type": "assistant", "thinking_effort": "  " }).to_string(),
            &mut out,
        );
        assert!(
            !out.iter().any(|e| matches!(e, EngineEvent::Effort(_))),
            "got {out:?}"
        );
    }

    #[test]
    fn ask_user_question_control_request_emits_question() {
        let line = serde_json::json!({
            "type": "control_request",
            "request_id": "req-1",
            "request": {
                "subtype": "can_use_tool",
                "tool_name": "AskUserQuestion",
                "tool_use_id": "call_1",
                "requires_user_interaction": true,
                "input": { "questions": [ { "question": "Q?", "header": "H",
                    "options": [ {"label": "A", "description": "a"}, {"label": "B", "description": "b"} ] } ] }
            }
        })
        .to_string();
        let mut out = Vec::new();
        ClaudeEngine::new().parse_line(&line, &mut out);
        assert_eq!(out.len(), 1);
        match &out[0] {
            EngineEvent::Question {
                request_id,
                tool_use_id,
                input,
            } => {
                assert_eq!(request_id, "req-1");
                assert_eq!(tool_use_id.as_deref(), Some("call_1"));
                assert_eq!(input["questions"][0]["header"], "H");
            }
            other => panic!("expected question event, got {other:?}"),
        }
    }

    #[test]
    fn other_control_asks_are_denied_in_place() {
        let line = serde_json::json!({
            "type": "control_request",
            "request_id": "req-2",
            "request": { "subtype": "can_use_tool", "tool_name": "Bash", "input": {} }
        })
        .to_string();
        let mut out = Vec::new();
        ClaudeEngine::new().parse_line(&line, &mut out);
        match &out[..] {
            [EngineEvent::ControlPermissionDeny {
                request_id,
                tool_name,
            }] => {
                assert_eq!(request_id, "req-2");
                assert_eq!(tool_name, "Bash");
            }
            other => panic!("expected control deny event, got {other:?}"),
        }
    }

    #[test]
    fn control_cancel_request_settles_the_question() {
        let line = serde_json::json!({
            "type": "control_cancel_request",
            "request_id": "req-3"
        })
        .to_string();
        let mut out = Vec::new();
        ClaudeEngine::new().parse_line(&line, &mut out);
        match &out[..] {
            [EngineEvent::QuestionSettled { request_id }] => assert_eq!(request_id, "req-3"),
            other => panic!("expected settled event, got {other:?}"),
        }
    }

    #[test]
    fn stream_message_boundaries_open_and_close_the_generation_window() {
        let engine = ClaudeEngine::new();
        let start = serde_json::json!({
            "type": "stream_event",
            "event": { "type": "message_start", "message": { "id": "msg_1" } }
        })
        .to_string();
        let stop = serde_json::json!({
            "type": "stream_event",
            "event": { "type": "message_stop" }
        })
        .to_string();
        let mut out = Vec::new();
        engine.parse_line(&start, &mut out);
        engine.parse_line(&stop, &mut out);
        assert_eq!(out.len(), 2);
        assert!(matches!(&out[0], EngineEvent::Generation { active: true }));
        assert!(matches!(&out[1], EngineEvent::Generation { active: false }));
    }

    #[test]
    fn tool_use_block_start_emits_tool_message() {
        let line = serde_json::json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 1,
                "content_block": { "type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {} }
            }
        })
        .to_string();
        let mut out = Vec::new();
        ClaudeEngine::new().parse_line(&line, &mut out);
        assert_eq!(out.len(), 1);
        match &out[0] {
            EngineEvent::Message {
                role, text, args, ..
            } => {
                assert_eq!(role, "tool");
                assert_eq!(text, "Bash");
                assert!(args.is_none());
            }
            _ => panic!("expected tool message"),
        }
    }

    #[test]
    fn tool_use_input_json_delta_patches_args() {
        let engine = ClaudeEngine::new();
        let start = serde_json::json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 1,
                "content_block": { "type": "tool_use", "id": "toolu_1", "name": "Read", "input": {} }
            }
        })
        .to_string();
        let delta = serde_json::json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 1,
                "delta": { "type": "input_json_delta", "partial_json": "{\"file_path\":\"src/a.ts\"}" }
            }
        })
        .to_string();
        let stop = serde_json::json!({
            "type": "stream_event",
            "event": { "type": "content_block_stop", "index": 1 }
        })
        .to_string();
        let mut out = Vec::new();
        engine.parse_line(&start, &mut out);
        engine.parse_line(&delta, &mut out);
        assert_eq!(out.len(), 1);
        out.clear();
        engine.parse_line(&stop, &mut out);
        assert_eq!(out.len(), 1);
        match &out[0] {
            EngineEvent::Message {
                text,
                path,
                args,
                patch,
                ..
            } => {
                assert_eq!(text, "Read");
                assert_eq!(path.as_deref(), Some("src/a.ts"));
                assert_eq!(args, &Some(serde_json::json!({"file_path": "src/a.ts"})));
                assert!(*patch);
            }
            _ => panic!("expected patched tool message"),
        }
    }

    #[test]
    fn tool_result_is_attributed_via_tool_use_id() {
        let engine = ClaudeEngine::new();
        let start = serde_json::json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 0,
                "content_block": { "type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {} }
            }
        })
        .to_string();
        let user = serde_json::json!({
            "type": "user",
            "message": {
                "content": [
                    { "type": "tool_result", "tool_use_id": "toolu_1", "content": "On branch main" }
                ]
            }
        })
        .to_string();
        let mut out = Vec::new();
        engine.parse_line(&start, &mut out);
        out.clear();
        engine.parse_line(&user, &mut out);
        let patch = out
            .iter()
            .find(|e| {
                matches!(
                    e,
                    EngineEvent::Message {
                        patch: true,
                        result: Some(_),
                        ..
                    }
                )
            })
            .expect("expected a tool result patch");
        match patch {
            EngineEvent::Message {
                text,
                result,
                patch,
                ..
            } => {
                assert_eq!(text, "Bash");
                assert_eq!(result, &Some(serde_json::json!("On branch main")));
                assert!(*patch);
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn api_retry_system_event_reports_progress_without_settling() {
        let line = serde_json::json!({
            "type": "system",
            "subtype": "api_retry",
            "attempt": 3,
            "max_retries": 10,
            "retry_delay_ms": 9560,
            "error_status": 529,
            "error": "overloaded",
            "session_id": "s-1"
        })
        .to_string();
        let mut out = Vec::new();
        ClaudeEngine::new().parse_line(&line, &mut out);
        assert_eq!(out.len(), 2);
        match &out[1] {
            EngineEvent::Retry {
                attempt,
                max,
                message,
            } => {
                assert_eq!((*attempt, *max), (3, 10));
                assert!(message.contains("529"), "{message}");
                assert!(message.contains("9.6s"), "{message}");
            }
            other => panic!("expected retry progress, got {other:?}"),
        }
    }

    #[test]
    fn api_retry_without_status_falls_back_to_error_text() {
        let line = serde_json::json!({
            "type": "system",
            "subtype": "api_retry",
            "attempt": 1,
            "max_retries": 10,
            "retry_delay_ms": 1000,
            "error_status": null,
            "error": "unknown"
        })
        .to_string();
        let mut out = Vec::new();
        ClaudeEngine::new().parse_line(&line, &mut out);
        match &out[0] {
            EngineEvent::Retry { message, .. } => {
                assert!(message.starts_with("API error;"), "{message}")
            }
            other => panic!("expected retry progress, got {other:?}"),
        }
    }

    #[test]
    fn text_block_start_emits_nothing() {
        let line = serde_json::json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 0,
                "content_block": { "type": "text", "text": "" }
            }
        })
        .to_string();
        let mut out = Vec::new();
        ClaudeEngine::new().parse_line(&line, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn tool_result_permission_denial_surfaces_path() {
        let line = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_1",
                    "is_error": true,
                    "content": [{
                        "type": "text",
                        "text": "Claude requested permissions to read from C:\\dev\\frontend, but you haven't granted it yet."
                    }]
                }]
            }
        })
        .to_string();
        let mut out = Vec::new();
        ClaudeEngine::new().parse_line(&line, &mut out);
        assert_eq!(out.len(), 1);
        match &out[0] {
            EngineEvent::PermissionDenied {
                tool,
                path,
                message,
            } => {
                assert_eq!(*tool, None);
                assert_eq!(path.as_deref(), Some(r"C:\dev\frontend"));
                assert!(message.contains("requested permissions"));
            }
            _ => panic!("expected permission denial"),
        }
    }

    #[test]
    fn tool_result_denial_resolves_path_from_tool_input() {
        let engine = ClaudeEngine::new();
        let start = serde_json::json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_start",
                "index": 0,
                "content_block": { "type": "tool_use", "id": "toolu_9", "name": "Read", "input": {} }
            }
        })
        .to_string();
        let delta = serde_json::json!({
            "type": "stream_event",
            "event": {
                "type": "content_block_delta",
                "index": 0,
                "delta": { "type": "input_json_delta", "partial_json": "{\"file_path\":\"/etc/hosts\"}" }
            }
        })
        .to_string();
        let stop = serde_json::json!({
            "type": "stream_event",
            "event": { "type": "content_block_stop", "index": 0 }
        })
        .to_string();
        // Pathless denial text: nothing for extract_absolute_path to find.
        let denial = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_9",
                    "is_error": true,
                    "content": "Claude requested permissions to read this file, but you haven't granted it yet."
                }]
            }
        })
        .to_string();
        let mut out = Vec::new();
        for line in [&start, &delta, &stop, &denial] {
            engine.parse_line(line, &mut out);
        }
        let denial = out
            .iter()
            .find(|e| matches!(e, EngineEvent::PermissionDenied { .. }))
            .expect("expected permission denial");
        match denial {
            EngineEvent::PermissionDenied { tool, path, .. } => {
                assert_eq!(tool.as_deref(), Some("Read"));
                assert_eq!(path.as_deref(), Some("/etc/hosts"));
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn tool_result_non_error_and_non_denial_stay_silent() {
        for (is_error, text) in [
            (
                false,
                "Claude requested permissions to read from /etc, but you haven't granted it yet.",
            ),
            (true, "file not found: /tmp/missing.txt"),
        ] {
            let line = serde_json::json!({
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "toolu_1",
                        "is_error": is_error,
                        "content": text
                    }]
                }
            })
            .to_string();
            let mut out = Vec::new();
            ClaudeEngine::new().parse_line(&line, &mut out);
            assert!(out.is_empty(), "is_error={is_error} text={text}");
        }
    }

    #[test]
    fn result_permission_denials_emit_structured_events() {
        let line = serde_json::json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "session_id": "s-1",
            "permission_denials": [{
                "tool_name": "Read",
                "tool_use_id": "toolu_1",
                "tool_input": { "file_path": "/Users/x/secrets/key.pem" }
            }]
        })
        .to_string();
        let mut out = Vec::new();
        ClaudeEngine::new().parse_line(&line, &mut out);
        assert_eq!(out.len(), 3);
        assert!(matches!(out[0], EngineEvent::Throughput(_)));
        match &out[1] {
            EngineEvent::PermissionDenied { tool, path, .. } => {
                assert_eq!(tool.as_deref(), Some("Read"));
                assert_eq!(path.as_deref(), Some("/Users/x/secrets/key.pem"));
            }
            _ => panic!("expected permission denial"),
        }
        assert!(matches!(out[2], EngineEvent::Done { .. }));
    }

    #[test]
    fn throughput_flushes_before_every_result_boundary() {
        for (native, error) in [(false, false), (true, false), (false, true)] {
            let engine = ClaudeEngine::new();
            if native {
                feed(
                    &engine,
                    serde_json::json!({"type":"system",
                    "subtype":"session_state_changed","state":"running"}),
                );
            }
            let out = feed(
                &engine,
                serde_json::json!({"type":"result",
                "subtype":if error {"error_during_execution"} else {"success"},
                "is_error":error,"duration_ms":2500,
                "usage":{"output_tokens":25}}),
            );
            assert!(matches!(&out[0], EngineEvent::Throughput(data)
                if data["outputTokens"] == 25 && data["elapsedMs"] == 2500
                && data["status"] == if error {"partial"} else {"complete"}));
            assert_eq!(
                count(&out, |event| matches!(event, EngineEvent::Throughput(_))),
                1
            );
            assert!(out.iter().skip(1).any(|event| matches!(
                event,
                EngineEvent::Done { .. } | EngineEvent::TurnComplete { .. } | EngineEvent::Error(_)
            )));
            let idle = feed(
                &engine,
                serde_json::json!({"type":"system",
                "subtype":"session_state_changed","state":"idle"}),
            );
            assert_eq!(
                count(&idle, |event| matches!(event, EngineEvent::Throughput(_))),
                0
            );
        }
    }

    #[test]
    fn extract_absolute_path_handles_windows_and_posix() {
        assert_eq!(
            extract_absolute_path("read from C:\\dev\\proj, but"),
            Some(r"C:\dev\proj".to_string())
        );
        assert_eq!(
            extract_absolute_path("write to \"/etc/hosts\"."),
            Some("/etc/hosts".to_string())
        );
        assert_eq!(extract_absolute_path("no path here"), None);
    }

    fn compact_result_line() -> String {
        serde_json::json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "session_id": "s-1",
            "usage": {
                "input_tokens": 30190,
                "output_tokens": 1200,
                "total_tokens": 31390,
                "model_context_window": 200000
            }
        })
        .to_string()
    }

    #[test]
    fn compact_boundary_emits_usage_and_overrides_turn_result_once() {
        let engine = ClaudeEngine::new();
        let boundary = serde_json::json!({
            "type": "system",
            "subtype": "compact_boundary",
            "compactMetadata": { "preTokens": 30190, "postTokens": 8038, "durationMs": 4207 }
        })
        .to_string();
        let mut out = Vec::new();
        engine.parse_line(&boundary, &mut out);
        assert_eq!(out.len(), 1);
        match &out[0] {
            EngineEvent::Usage(usage) => {
                assert_eq!(usage["input_tokens"], 8038);
                assert_eq!(usage["total_tokens"], 8038);
            }
            _ => panic!("expected usage event"),
        }

        // The following result's billing usage is replaced by the
        // post-compaction occupancy, keeping output and the context window.
        let mut out = Vec::new();
        engine.parse_line(&compact_result_line(), &mut out);
        assert!(
            matches!(&out[0], EngineEvent::Throughput(data) if data["outputTokens"] == 1200 && data["elapsedMs"].is_null())
        );
        match &out[1] {
            EngineEvent::Done { usage, .. } => {
                let usage = usage.as_ref().expect("usage");
                assert_eq!(usage["input_tokens"], 8038);
                assert_eq!(usage["output_tokens"], 1200);
                assert_eq!(usage["total_tokens"], 8038 + 1200);
                assert_eq!(usage["model_context_window"], 200000);
            }
            _ => panic!("expected done event"),
        }

        // Single-shot: the next turn without a boundary keeps billing usage.
        let mut out = Vec::new();
        engine.parse_line(&compact_result_line(), &mut out);
        match &out[1] {
            EngineEvent::Done { usage, .. } => {
                assert_eq!(usage.as_ref().expect("usage")["input_tokens"], 30190);
            }
            _ => panic!("expected done event"),
        }
    }

    #[test]
    fn result_without_compact_boundary_keeps_billing_usage() {
        let mut out = Vec::new();
        ClaudeEngine::new().parse_line(&compact_result_line(), &mut out);
        match &out[1] {
            EngineEvent::Done { usage, .. } => {
                let usage = usage.as_ref().expect("usage");
                assert_eq!(usage["input_tokens"], 30190);
                assert_eq!(usage["total_tokens"], 31390);
            }
            _ => panic!("expected done event"),
        }
    }

    #[test]
    fn compact_boundary_without_metadata_stays_silent() {
        let line = serde_json::json!({
            "type": "system",
            "subtype": "compact_boundary"
        })
        .to_string();
        let mut out = Vec::new();
        ClaudeEngine::new().parse_line(&line, &mut out);
        assert!(out.is_empty());
    }

    /// The UI's context gauge divided by a hardcoded 200k because nothing
    /// read the window the CLI reports per model. The result line carries it
    /// under `modelUsage`; the model that did the work is the busiest one, so
    /// a cheap subagent's window must not win a mixed turn.
    #[test]
    fn result_reports_the_window_of_the_model_that_did_the_work() {
        let line = serde_json::json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "session_id": "s-1",
            "usage": { "input_tokens": 900000, "output_tokens": 2000, "total_tokens": 902000 },
            "modelUsage": {
                "claude-haiku-4-5": {
                    "inputTokens": 300, "outputTokens": 40, "contextWindow": 200000
                },
                "claude-opus-5[1m]": {
                    "inputTokens": 880000, "outputTokens": 1250, "contextWindow": 1000000
                }
            }
        })
        .to_string();
        let mut out = Vec::new();
        ClaudeEngine::new().parse_line(&line, &mut out);
        match &out[1] {
            EngineEvent::Done { usage, .. } => {
                let usage = usage.as_ref().expect("usage");
                assert_eq!(usage["model_context_window"], 1_000_000);
                // The billing figures stay the CLI's own.
                assert_eq!(usage["input_tokens"], 900000);
            }
            _ => panic!("expected done event"),
        }
    }

    /// Nothing usable reported ⇒ no key at all, so the UI keeps its own
    /// explicit fallback instead of this layer inventing a number.
    #[test]
    fn result_without_a_reported_window_adds_nothing() {
        for models in [
            None,
            Some(serde_json::json!({})),
            Some(serde_json::json!({
                "m": { "inputTokens": 10, "contextWindow": 0 }
            })),
        ] {
            let mut value = serde_json::json!({
                "type": "result",
                "subtype": "success",
                "is_error": false,
                "session_id": "s-1",
                "usage": { "input_tokens": 10, "output_tokens": 1, "total_tokens": 11 }
            });
            if let Some(models) = models {
                value["modelUsage"] = models;
            }
            let mut out = Vec::new();
            ClaudeEngine::new().parse_line(&value.to_string(), &mut out);
            match &out[1] {
                EngineEvent::Done { usage, .. } => {
                    assert!(usage
                        .as_ref()
                        .expect("usage")
                        .get("model_context_window")
                        .is_none());
                }
                _ => panic!("expected done event"),
            }
        }
    }

    /// An explicitly reported window is the more specific statement and must
    /// survive the per-model map.
    #[test]
    fn explicit_context_window_beats_the_model_map() {
        let line = serde_json::json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "session_id": "s-1",
            "usage": {
                "input_tokens": 10, "output_tokens": 1, "total_tokens": 11,
                "model_context_window": 500000
            },
            "modelUsage": { "m": { "inputTokens": 10, "contextWindow": 200000 } }
        })
        .to_string();
        let mut out = Vec::new();
        ClaudeEngine::new().parse_line(&line, &mut out);
        match &out[1] {
            EngineEvent::Done { usage, .. } => {
                assert_eq!(
                    usage.as_ref().expect("usage")["model_context_window"],
                    500000
                );
            }
            _ => panic!("expected done event"),
        }
    }

    /// A compacted turn's usage is rebuilt from the boundary, so the window
    /// has to be re-attached there too — that path dropped it before.
    #[test]
    fn compacted_turn_keeps_the_reported_window() {
        let engine = ClaudeEngine::new();
        let boundary = serde_json::json!({
            "type": "system",
            "subtype": "compact_boundary",
            "compactMetadata": { "preTokens": 900000, "postTokens": 40000, "durationMs": 1000 }
        })
        .to_string();
        let mut out = Vec::new();
        engine.parse_line(&boundary, &mut out);

        let result = serde_json::json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "session_id": "s-1",
            "usage": { "input_tokens": 900000, "output_tokens": 50, "total_tokens": 900050 },
            "modelUsage": { "claude-opus-5[1m]": { "inputTokens": 900000, "contextWindow": 1000000 } }
        })
        .to_string();
        let mut out = Vec::new();
        engine.parse_line(&result, &mut out);
        match &out[1] {
            EngineEvent::Done { usage, .. } => {
                let usage = usage.as_ref().expect("usage");
                assert_eq!(usage["input_tokens"], 40000);
                assert_eq!(usage["model_context_window"], 1_000_000);
            }
            _ => panic!("expected done event"),
        }
    }

    #[test]
    fn build_command_passes_effort_and_independent_ultracode_flags() {
        let engine = ClaudeEngine::new();
        let mut request = SendRequest {
            claude_ultracode: None,
            host_instructions: None,
            session_id: None,
            prompt: "hi".into(),
            images: vec![],
            workspace: std::path::PathBuf::from("/tmp"),
            model: None,
            effort: Some("xhigh".into()),
            service_tier: None,
            permission: None,
            additional_dirs: vec![],
            provider_id: None,
            computer_use: None,
            allowed_tools: None,
        };
        let built = engine.build_command(&request, "claude").unwrap();
        let args: Vec<String> = built
            .command
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert!(args.windows(2).any(|w| w == ["--effort", "xhigh"]));

        request.effort = Some("ultra".into());
        let built = engine.build_command(&request, "claude").unwrap();
        let args: Vec<String> = built
            .command
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert!(args.windows(2).any(|w| w == ["--effort", "max"]));
        assert_eq!(
            built
                .command
                .as_std()
                .get_envs()
                .find(|(k, _)| *k == "CLAUDE_CODE_EFFORT_LEVEL")
                .and_then(|(_, v)| v),
            Some(std::ffi::OsStr::new("max"))
        );
        assert!(!args.iter().any(|arg| arg == "--settings"));
        // Both boolean values must override native settings. Changing effort
        // never turns the independent switch on or off.
        for enabled in [true, false] {
            request.claude_ultracode = Some(enabled);
            for effort in ["high", "max", "low", "medium", "xhigh", "ultra"] {
                request.effort = Some(effort.into());
                let built = engine.build_command(&request, "claude").unwrap();
                let args: Vec<_> = built.command.as_std().get_args()
                    .map(|a| a.to_string_lossy().to_string()).collect();
                let expected_effort = if effort == "ultra" { "max" } else { effort };
                assert!(args.windows(2).any(|w| w == ["--effort", expected_effort]));
                assert_eq!(built.command.as_std().get_envs()
                    .find(|(key, _)| *key == "CLAUDE_CODE_EFFORT_LEVEL").and_then(|(_, value)| value),
                    Some(std::ffi::OsStr::new(expected_effort)));
                assert!(built.command.as_std().get_envs().all(|(key, _)| key != "MAX_THINKING_TOKENS"));
                let overlay = args.windows(2).find(|w| w[0] == "--settings").unwrap();
                assert_eq!(serde_json::from_str::<Value>(&overlay[1]).unwrap(),
                    serde_json::json!({"ultracode": enabled}));
                assert_eq!(args.iter().filter(|arg| *arg == "--settings").count(), 1);
                assert!(!args.windows(2).any(|w| w == ["--effort", "ultracode"]));
            }
        }
        request.effort = Some("ultracode".into());
        assert!(engine.build_command(&request, "claude").is_err());
    }

    /// 任务工作台只读节点：必须真正落到启动参数（plan 模式 + 白名单 +
    /// 显式拒绝写工具），不允许只靠节点名假装。
    #[test]
    fn read_only_tool_constraints_force_plan_mode_and_whitelist() {
        let engine = ClaudeEngine::new();
        assert!(engine.supports_tool_constraints());
        let request = SendRequest {
            claude_ultracode: None,
            host_instructions: None,
            session_id: None,
            prompt: "hi".into(),
            images: vec![],
            workspace: std::path::PathBuf::from("/tmp"),
            model: None,
            effort: None,
            service_tier: None,
            permission: Some("auto".into()),
            additional_dirs: vec![],
            provider_id: None,
            computer_use: None,
            allowed_tools: Some(vec!["Read".into(), "Grep".into()]),
        };
        let built = engine.build_command(&request, "claude").unwrap();
        let args: Vec<String> = built
            .command
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert!(args.windows(2).any(|w| w == ["--permission-mode", "plan"]));
        assert!(args.windows(2).any(|w| w == ["--allowedTools", "Read"]));
        let deny_at = args
            .iter()
            .position(|a| a == "--disallowedTools")
            .expect("deny list");
        for tool in ["Bash", "Edit", "Write", "NotebookEdit", "Task"] {
            assert!(
                args[deny_at + 1..].iter().any(|a| a == tool),
                "{tool} must be explicitly denied"
            );
        }
        // 普通权限参数不应同时出现（避免 mode 冲突）。
        assert!(!args
            .windows(2)
            .any(|w| w == ["--permission-mode", "acceptEdits"]));
    }

    #[test]
    fn host_chat_shares_one_mcp_config_without_preapproving_cross_chat_messages() {
        let engine = ClaudeEngine::new();
        let mut request = SendRequest {
            claude_ultracode: None,
            host_instructions: None,
            session_id: Some("11111111-2222-4333-8444-555555555555".into()),
            prompt: "continue".into(),
            images: vec![],
            workspace: std::path::PathBuf::from("/tmp"),
            model: Some("opus".into()),
            effort: Some("xhigh".into()),
            service_tier: None,
            permission: Some("manual".into()),
            additional_dirs: vec![],
            provider_id: None,
            computer_use: Some(true),
            allowed_tools: None,
        };
        let server = serde_json::json!({
            "command": "fixture-host.exe", "args": ["--host-chat-mcp"],
            "env": {"CCGUI_HOST_CHAT_TOKEN": "fixture-only"}
        });
        let built = engine.build_command_with_host_chat(&request, "claude", Some(&server)).unwrap();
        let args: Vec<_> = built.command.as_std().get_args()
            .map(|a| a.to_string_lossy().to_string()).collect();
        let configs: Vec<_> = args.windows(2).filter(|w| w[0] == "--mcp-config").collect();
        assert_eq!(configs.len(), 1, "one config must preserve both built-in servers");
        let config: Value = serde_json::from_str(&configs[0][1]).unwrap();
        assert_eq!(config["mcpServers"][crate::host_chat::MCP_SERVER_NAME], server);
        for tool in ["task_spawn", "task_list", "task_wait", "task_send", "task_renew", "task_stop"] {
            assert!(args.iter().any(|arg| arg == &format!("mcp__ccgui__{tool}")),
                "{tool} must remain available to authorized Leader runs");
        }
        assert!(!args.iter().any(|arg| arg == "mcp__ccgui__leader_reclaim"));
        assert!(!args.iter().any(|arg| arg.starts_with("mcp__ccgui__leader_")));
        assert!(!args.iter().any(|arg| arg == "mcp__ccgui__send_message"));
        assert!(config["mcpServers"]["ccgui-computer"].is_object());
        assert!(args.windows(2).any(|w| w == ["--permission-mode", "default"]));
        assert!(args.windows(2).any(|w| w == ["--resume", "11111111-2222-4333-8444-555555555555"]));
        assert!(args.windows(2).any(|w| w == ["--effort", "xhigh"]));
        assert!(!args.iter().any(|a| a == "--dangerously-skip-permissions" || a == "mcp__ccgui"));

        request.computer_use = None;
        let ordinary = engine.build_command(&request, "claude").unwrap();
        assert!(!ordinary.command.as_std().get_args().any(|a| a == "--mcp-config"));

        request.allowed_tools = Some(vec!["Read".into()]);
        assert!(engine.build_command_with_host_chat(&request, "claude", Some(&server)).is_err(),
            "a constrained run must not gain cross-chat side effects");
    }

    fn feed(engine: &ClaudeEngine, value: serde_json::Value) -> Vec<EngineEvent> {
        let mut out = Vec::new();
        engine.parse_line(&value.to_string(), &mut out);
        out
    }
    fn state_line(state: &str) -> serde_json::Value {
        serde_json::json!({"type":"system","subtype":"session_state_changed","state":state,"session_id":"s-1"})
    }
    fn interrupt_ack(request_id: &str, subtype: &str) -> serde_json::Value {
        serde_json::json!({"type":"control_response","response":{"subtype":subtype,"request_id":request_id}})
    }
    /// The result native writes for an interrupted reply (verified against
    /// Claude Code 2.1.287): error subtype, is_error, empty text.
    fn interrupted_result_line() -> serde_json::Value {
        serde_json::json!({"type":"result","subtype":"error_during_execution","is_error":true,"result":"","session_id":"s-1","usage":{"output_tokens":4}})
    }
    fn background_snapshot() -> serde_json::Value {
        serde_json::json!({"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"bg","task_type":"local_bash"}]})
    }
    fn count(events: &[EngineEvent], f: impl Fn(&EngineEvent) -> bool) -> usize {
        events.iter().filter(|e| f(e)).count()
    }
    fn is_done(e: &EngineEvent) -> bool {
        matches!(e, EngineEvent::Done { .. })
    }
    fn is_error(e: &EngineEvent) -> bool {
        matches!(e, EngineEvent::Error(_))
    }

    #[test]
    fn startup_interrupt_ack_survives_init_status_and_the_user_echo() {
        // Real Claude Code 2.1.287 startup order: the interrupt can be
        // acknowledged before init and before the initial prompt is echoed.
        let engine = ClaudeEngine::new();
        let mut events = Vec::new();
        for line in [
            serde_json::json!({"type":"system","subtype":"hook_started","session_id":"s-1","hook_id":"hook-1"}),
            serde_json::json!({"type":"system","subtype":"hook_started","session_id":"s-1","hook_id":"hook-2"}),
            state_line("running"),
            interrupt_ack("ccgui-interrupt-startup", "success"),
            serde_json::json!({"type":"system","subtype":"init","session_id":"s-1","mcp_servers":[]}),
            serde_json::json!({"type":"system","subtype":"status","status":null,"session_id":"s-1"}),
            serde_json::json!({"type":"user","session_id":"s-1","message":{"role":"user","content":"fixture prompt"}}),
            interrupted_result_line(),
        ] {
            events.extend(feed(&engine, line));
        }
        assert_eq!(count(&events, is_error), 0, "{events:?}");
        assert_eq!(count(&events, is_done), 0, "the result must keep stdin open: {events:?}");
        assert_eq!(
            count(&events, |e| matches!(e, EngineEvent::TurnComplete { interrupted: true, .. })),
            1,
            "{events:?}"
        );
        events.extend(feed(&engine, state_line("idle")));
        events.extend(feed(&engine, state_line("idle")));
        assert_eq!(count(&events, is_done), 1, "{events:?}");
        assert_eq!(count(&events, is_error), 0, "{events:?}");
    }

    #[test]
    fn main_content_after_idle_cannot_inherit_the_previous_interrupt_ack() {
        let engine = ClaudeEngine::new();
        for line in [
            state_line("running"),
            background_snapshot(),
            interrupt_ack("ccgui-interrupt-old-turn", "success"),
            state_line("idle"),
            serde_json::json!({"type":"stream_event","event":{"type":"message_start"}}),
        ] {
            feed(&engine, line);
        }
        // A main reply can start without another native running state while a
        // background task keeps the same CLI alive. Its failure is its own.
        let out = feed(&engine, interrupted_result_line());
        assert!(
            matches!(
                out.as_slice(),
                [EngineEvent::Throughput(_), EngineEvent::Error(_)]
            ),
            "{out:?}"
        );
    }

    #[test]
    fn a_running_state_after_main_content_preserves_the_current_interrupt_ack() {
        let engine = ClaudeEngine::new();
        for line in [
            state_line("running"),
            background_snapshot(),
            serde_json::json!({"type":"result","subtype":"success","is_error":false}),
            state_line("idle"),
            serde_json::json!({"type":"stream_event","event":{"type":"message_start"}}),
            interrupt_ack("ccgui-interrupt-new-turn", "success"),
            state_line("running"),
        ] {
            feed(&engine, line);
        }
        let out = feed(&engine, interrupted_result_line());
        assert_eq!(count(&out, is_error) + count(&out, is_done), 0, "{out:?}");
        assert_eq!(
            count(&out, |e| matches!(e, EngineEvent::TurnComplete { interrupted: true, .. })),
            1,
            "{out:?}"
        );
        assert!(matches!(out.last(), Some(EngineEvent::Activity("waiting"))), "{out:?}");
    }

    #[test]
    fn an_ack_after_a_result_cannot_rearm_the_completed_reply() {
        let engine = ClaudeEngine::new();
        for line in [
            state_line("running"),
            background_snapshot(),
            interrupt_ack("ccgui-interrupt-duplicate", "success"),
            interrupted_result_line(),
            interrupt_ack("ccgui-interrupt-duplicate", "success"),
        ] {
            feed(&engine, line);
        }
        // Native has not idled yet, but the targeted response already ended.
        let out = feed(&engine, interrupted_result_line());
        assert!(
            matches!(
                out.as_slice(),
                [EngineEvent::Throughput(_), EngineEvent::Error(_)]
            ),
            "{out:?}"
        );
    }

    #[test]
    fn waiting_interrupt_ack_restores_waiting_without_completing_or_dropping_tasks() {
        for activity in ["idle", "running", "requires_action"] {
            let engine = ClaudeEngine::new();
            for line in [
                state_line("running"),
                background_snapshot(),
                serde_json::json!({"type":"result","subtype":"success","is_error":false}),
                state_line("idle"),
                state_line(activity),
            ] {
                feed(&engine, line);
            }
            // The main response ended. Further native running/requires_action
            // states can belong solely to the still-running background task.
            let ack = feed(&engine, interrupt_ack("ccgui-interrupt-waiting", "success"));
            assert!(matches!(ack.as_slice(), [EngineEvent::Activity("waiting")]), "{activity}: {ack:?}");
            let idle = feed(&engine, state_line("idle"));
            assert_eq!(count(&idle, is_done), 0, "the task must stay alive: {idle:?}");
            assert!(matches!(idle.last(), Some(EngineEvent::Activity("waiting"))), "{idle:?}");
            // This ack targeted no main reply and cannot mask a later failure.
            let failure = feed(&engine, interrupted_result_line());
            assert!(
                matches!(
                    failure.as_slice(),
                    [EngineEvent::Throughput(_), EngineEvent::Error(_)]
                ),
                "{activity}: {failure:?}"
            );
        }
    }

    #[test]
    fn an_interrupted_result_after_idle_still_has_one_interrupted_boundary_and_done() {
        let engine = ClaudeEngine::new();
        let mut events = Vec::new();
        for line in [
            state_line("running"),
            interrupt_ack("ccgui-interrupt-before-idle", "success"),
            state_line("idle"),
            interrupted_result_line(),
            state_line("idle"),
        ] {
            events.extend(feed(&engine, line));
        }
        assert_eq!(count(&events, is_error), 0, "{events:?}");
        assert_eq!(count(&events, is_done), 1, "{events:?}");
        assert_eq!(
            count(&events, |e| matches!(e, EngineEvent::TurnComplete { interrupted: true, .. })),
            1,
            "{events:?}"
        );
    }

    #[test]
    fn acknowledged_interrupt_makes_the_error_result_an_interrupted_turn_end() {
        let engine = ClaudeEngine::new();
        let mut events = Vec::new();
        for line in [
            state_line("running"),
            background_snapshot(),
            interrupt_ack("ccgui-interrupt-7", "success"),
            interrupted_result_line(),
        ] {
            events.extend(feed(&engine, line));
        }
        assert_eq!(count(&events, is_error), 0, "{events:?}");
        assert_eq!(count(&events, is_done), 0, "{events:?}");
        assert!(
            events.iter().any(|e| matches!(
                e,
                EngineEvent::TurnComplete { usage: Some(u), interrupted: true } if u["output_tokens"] == 4
            )),
            "{events:?}"
        );
        assert!(
            matches!(events.last(), Some(EngineEvent::Activity("waiting"))),
            "background work keeps the run waiting: {events:?}"
        );
        // Native's idle after the result neither ends the run nor errors.
        let idle = feed(&engine, state_line("idle"));
        assert_eq!(count(&idle, is_done) + count(&idle, is_error), 0);
        assert!(matches!(idle.last(), Some(EngineEvent::Activity("waiting"))));

        // The same native process completes its background work and then
        // delivers an ordinary notification reply with its own usage.
        for line in [
            serde_json::json!({"type":"system","subtype":"background_tasks_changed","tasks":[]}),
            serde_json::json!({"type":"system","subtype":"task_notification","task_id":"bg","status":"completed"}),
            state_line("running"),
            serde_json::json!({"type":"result","subtype":"success","is_error":false,"usage":{"output_tokens":7}}),
            state_line("idle"),
            state_line("idle"),
        ] {
            events.extend(feed(&engine, line));
        }
        assert_eq!(count(&events, is_error), 0, "{events:?}");
        assert_eq!(count(&events, is_done), 1, "{events:?}");
        assert_eq!(
            count(&events, |e| matches!(e, EngineEvent::TurnComplete { usage: Some(u), interrupted: false } if u["output_tokens"] == 7)),
            1,
            "{events:?}"
        );
    }

    #[test]
    fn interrupted_run_without_background_work_ends_with_one_done_at_idle() {
        let engine = ClaudeEngine::new();
        let mut events = Vec::new();
        for line in [
            state_line("running"),
            interrupt_ack("ccgui-interrupt-1", "success"),
            interrupted_result_line(),
        ] {
            events.extend(feed(&engine, line));
        }
        assert_eq!(count(&events, is_done) + count(&events, is_error), 0);
        let idle = feed(&engine, state_line("idle"));
        assert_eq!(count(&idle, is_done), 1);
        assert_eq!(count(&idle, is_error), 0);
    }

    #[test]
    fn error_during_execution_without_an_acknowledged_interrupt_stays_terminal() {
        let engine = ClaudeEngine::new();
        feed(&engine, state_line("running"));
        feed(&engine, background_snapshot());
        let out = feed(&engine, interrupted_result_line());
        assert!(
            matches!(
                out.as_slice(),
                [EngineEvent::Throughput(_), EngineEvent::Error(_)]
            ),
            "{out:?}"
        );
    }

    #[test]
    fn a_result_before_the_ack_is_a_genuine_error_not_a_swallowed_interrupt() {
        // Native orders ack -> result. The reverse cannot be told apart from a
        // real failure, and hiding a failure is worse than a rare false error.
        let engine = ClaudeEngine::new();
        feed(&engine, state_line("running"));
        let out = feed(&engine, interrupted_result_line());
        assert!(
            matches!(
                out.as_slice(),
                [EngineEvent::Throughput(_), EngineEvent::Error(_)]
            ),
            "{out:?}"
        );
        assert!(feed(&engine, interrupt_ack("ccgui-interrupt-1", "success")).is_empty());
    }

    #[test]
    fn other_error_results_stay_terminal_even_after_an_acknowledged_interrupt() {
        for (subtype, is_error) in [
            ("error_max_turns", true),
            ("error_during_execution", false),
            ("success", true),
        ] {
            let engine = ClaudeEngine::new();
            feed(&engine, state_line("running"));
            feed(&engine, interrupt_ack("ccgui-interrupt-1", "success"));
            let out = feed(
                &engine,
                serde_json::json!({"type":"result","subtype":subtype,"is_error":is_error,"result":"boom"}),
            );
            assert!(
                matches!(out.as_slice(), [EngineEvent::Throughput(_), EngineEvent::Error(m)] if m == "boom"),
                "{subtype}/{is_error}: {out:?}"
            );
        }
    }

    #[test]
    fn a_failed_result_reports_the_cli_errors_instead_of_the_bare_fallback() {
        // Real shape of `claude -p --resume <unknown id>` (Claude Code 2.1.287):
        // error_during_execution, no `result`, the cause only in `errors`.
        let missing = serde_json::json!({
            "type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,
            "session_id":"s-1","errors":["No conversation found with session ID: s-1"],
        });
        let out = feed(&ClaudeEngine::new(), missing);
        assert!(
            matches!(out.as_slice(), [EngineEvent::Throughput(_), EngineEvent::Error(m)] if m == "No conversation found with session ID: s-1"),
            "{out:?}"
        );
        for (line, expected) in [
            (
                serde_json::json!({"subtype":"error_during_execution","is_error":true,"errors":["a"," ","b"]}),
                "a\nb",
            ),
            (
                serde_json::json!({"subtype":"error_max_turns","is_error":true,"result":"boom","errors":["x"]}),
                "boom",
            ),
            (
                serde_json::json!({"subtype":"error_during_execution","is_error":true,"result":"","errors":[]}),
                "claude turn failed",
            ),
            (
                serde_json::json!({"subtype":"error_during_execution","is_error":true}),
                "claude turn failed",
            ),
        ] {
            let mut line = line;
            line["type"] = "result".into();
            let out = feed(&ClaudeEngine::new(), line.clone());
            assert!(
                matches!(out.as_slice(), [EngineEvent::Throughput(_), EngineEvent::Error(m)] if m == expected),
                "{line}: {out:?}"
            );
        }
    }

    #[test]
    fn only_a_successful_ccgui_interrupt_ack_arms_the_interrupt() {
        for ack in [
            interrupt_ack("ccgui-interrupt-1", "error"),
            interrupt_ack("some-other-request", "success"),
            serde_json::json!({"type":"control_response","response":{"subtype":"success"}}),
            serde_json::json!({"type":"control_response"}),
        ] {
            let engine = ClaudeEngine::new();
            feed(&engine, state_line("running"));
            assert!(feed(&engine, ack.clone()).is_empty(), "{ack}");
            let out = feed(&engine, interrupted_result_line());
            assert!(
                matches!(
                    out.as_slice(),
                    [EngineEvent::Throughput(_), EngineEvent::Error(_)]
                ),
                "{ack}: {out:?}"
            );
        }
    }

    #[test]
    fn an_ack_while_idle_or_for_an_earlier_turn_never_masks_a_later_failure() {
        // Ack while idle: nothing in flight.
        let engine = ClaudeEngine::new();
        feed(&engine, state_line("running"));
        feed(&engine, background_snapshot());
        feed(
            &engine,
            serde_json::json!({"type":"result","subtype":"success","is_error":false,"usage":{"output_tokens":1}}),
        );
        feed(&engine, state_line("idle"));
        feed(&engine, interrupt_ack("ccgui-interrupt-1", "success"));
        feed(&engine, state_line("running"));
        let out = feed(&engine, interrupted_result_line());
        assert!(
            matches!(
                out.as_slice(),
                [EngineEvent::Throughput(_), EngineEvent::Error(_)]
            ),
            "{out:?}"
        );

        // Ack that raced a reply finishing normally: the result consumes it.
        let engine = ClaudeEngine::new();
        feed(&engine, state_line("running"));
        feed(&engine, background_snapshot());
        feed(&engine, interrupt_ack("ccgui-interrupt-2", "success"));
        let completed = feed(
            &engine,
            serde_json::json!({"type":"result","subtype":"success","is_error":false,"usage":{"output_tokens":1}}),
        );
        assert_eq!(
            count(&completed, |e| matches!(e, EngineEvent::TurnComplete { interrupted: false, .. })),
            1,
            "a successful reply stays ordinary even if interrupt raced it: {completed:?}"
        );
        feed(&engine, state_line("idle"));
        feed(&engine, state_line("running"));
        let out = feed(&engine, interrupted_result_line());
        assert!(
            matches!(
                out.as_slice(),
                [EngineEvent::Throughput(_), EngineEvent::Error(_)]
            ),
            "{out:?}"
        );

        // Ack that landed after its reply stopped (idle, no result): the
        // next turn's failure is its own.
        let engine = ClaudeEngine::new();
        feed(&engine, state_line("running"));
        feed(&engine, background_snapshot());
        feed(&engine, interrupt_ack("ccgui-interrupt-3", "success"));
        feed(&engine, state_line("idle"));
        feed(&engine, state_line("running"));
        let out = feed(&engine, interrupted_result_line());
        assert!(
            matches!(
                out.as_slice(),
                [EngineEvent::Throughput(_), EngineEvent::Error(_)]
            ),
            "{out:?}"
        );
    }

    #[test]
    fn an_ack_with_the_cli_idle_cannot_hide_a_failure_that_follows_directly() {
        let engine = ClaudeEngine::new();
        feed(&engine, state_line("running"));
        feed(&engine, background_snapshot());
        feed(
            &engine,
            serde_json::json!({"type":"result","subtype":"success","is_error":false,"usage":{"output_tokens":1}}),
        );
        feed(&engine, state_line("idle"));
        feed(&engine, interrupt_ack("ccgui-interrupt-1", "success"));
        let out = feed(&engine, interrupted_result_line());
        assert!(
            matches!(
                out.as_slice(),
                [EngineEvent::Throughput(_), EngineEvent::Error(_)]
            ),
            "{out:?}"
        );
    }
}
