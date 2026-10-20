use super::agy_throughput::AgyThroughput;
use super::{
    command_for_binary, tool_call_message, tool_result_patch, BuiltCommand, Engine, EngineEvent,
    SendRequest,
};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

/// Antigravity CLI (`agy`) home: `$ANTIGRAVITY_HOME` or `~/.gemini/antigravity-cli`.
pub(crate) fn agy_home() -> PathBuf {
    crate::engine::engine_home(Some("ANTIGRAVITY_HOME"), ".gemini/antigravity-cli")
}

pub(crate) fn session_homes() -> [PathBuf; 2] {
    [agy_home(), super::agy_vertex::app_home()]
}

/// IDs are shared by the UI, so a collision across stores must never resolve
/// to whichever directory happens to be scanned first.
pub(crate) fn session_db(id: &str) -> Result<Option<PathBuf>, String> {
    session_db_in(id, &session_homes())
}

fn session_db_in(id: &str, homes: &[PathBuf]) -> Result<Option<PathBuf>, String> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')) {
        return Err("Invalid Antigravity conversation ID".into());
    }
    let mut found = None;
    for home in homes {
        let candidate = home.join("conversations").join(format!("{id}.db"));
        if candidate.is_file() {
            if found.as_ref().is_some_and(|path| path != &candidate) {
                return Err("Antigravity conversation exists in both billing channels; start a new conversation".into());
            }
            found = Some(candidate);
        }
    }
    Ok(found)
}

fn validate_resume(id: &str, bridged: bool) -> Result<(), String> {
    validate_resume_in(id, bridged, &session_homes())
}

fn validate_resume_in(id: &str, bridged: bool, homes: &[PathBuf; 2]) -> Result<(), String> {
    let found = session_db_in(id, homes)?;
    let expected = homes[usize::from(bridged)].join("conversations").join(format!("{id}.db"));
    if found.as_ref().is_some_and(|path| path != &expected) {
        return Err("Cannot resume an Antigravity conversation through a different billing channel; select its original channel or start a new conversation".into());
    }
    if bridged && found.is_none() {
        return Err("Vertex conversation was not found; start a new conversation".into());
    }
    Ok(())
}

#[derive(Default)]
pub struct AgyEngine {
    throughput: Mutex<AgyThroughput>,
}

impl AgyEngine {
    pub fn new() -> Self {
        Self::default()
    }
}

const HOST_STAGING: &str = "agy-host-staging";
const HOST_PLUGIN: &str = ".agents/plugins/ccgui-host";

/// AGY discovers local plugin MCP and rules through --add-dir. Each process
/// receives a private workspace; no native/global MCP file is ever changed.
fn stage_host_chat(parent: &std::path::Path, server: &Value) -> Result<PathBuf, String> {
    if !parent.is_absolute() || parent.ancestors().any(|path|
        std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())) {
        return Err("AGY host staging requires an absolute directory without links".into());
    }
    std::fs::create_dir_all(parent).map_err(|_| "Cannot create AGY host staging directory")?;
    let parent = dunce::canonicalize(parent).map_err(|_| "Cannot resolve AGY host staging directory")?;
    let root = parent.join(uuid::Uuid::new_v4().to_string());
    #[cfg(unix)]
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(not(unix))]
    let builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
    builder.create(&root).map_err(|_| "Cannot create private AGY host workspace")?;
    // Resolve before using recursive cleanup. A failed resolution may only
    // remove this empty directory, never recurse through an unchecked target.
    let resolved = match dunce::canonicalize(&root) {
        Ok(resolved) if resolved.parent() == Some(parent.as_path()) => resolved,
        _ => {
            let _ = std::fs::remove_dir(&root);
            return Err("AGY host workspace escaped its staging directory".into());
        }
    };
    let root = resolved;
    let staged = (|| {
        let plugin = root.join(HOST_PLUGIN);
        std::fs::create_dir_all(plugin.join("rules")).map_err(|_| "Cannot create AGY host plugin")?;
        let config = serde_json::json!({"mcpServers":{"ccgui":server}});
        for (path, text) in [
            (plugin.join("plugin.json"), "{\"name\":\"ccgui-host\"}".to_string()),
            (plugin.join("mcp_config.json"), serde_json::to_string(&config).map_err(|_| "Cannot encode AGY host plugin")?),
            (plugin.join("rules/AGENTS.md"), String::new()),
        ] {
            use std::io::Write;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
            options.open(path).and_then(|mut file| file.write_all(text.as_bytes()))
                .map_err(|_| "Cannot write AGY host plugin")?;
        }
        Ok(())
    })();
    if let Err(error) = staged {
        super::cleanup_staged_files(std::slice::from_ref(&root));
        return Err(error);
    }
    Ok(root)
}

pub(super) fn append_host_instructions(built: &mut BuiltCommand, instructions: &str) -> Result<(), String> {
    if instructions.is_empty() { return Ok(()); }
    let root = built.cleanup_files.first().ok_or("AGY Leader requires its per-run host plugin")?;
    let path = root.join(HOST_PLUGIN).join("rules/AGENTS.md");
    // The plugin exists only for this launch and has not yet been spawned.
    std::fs::write(path, instructions).map_err(|_| "Cannot write AGY Leader instructions".into())
}

/// 提取并规范化上下文窗口字段
fn attach_context_window(mut usage: Value) -> Value {
    if usage.get("model_context_window").is_some() {
        return usage;
    }

    let window = usage
        .get("context_window")
        .or_else(|| usage.get("contextWindow"))
        .or_else(|| usage.get("model_context_window"))
        .and_then(|v| match v {
            Value::Number(n) => n.as_i64(),
            Value::String(s) => s.parse().ok(),
            _ => None,
        })
        .filter(|&w| w > 0);

    if let Some(w) = window {
        if let Some(obj) = usage.as_object_mut() {
            obj.insert("model_context_window".to_string(), Value::Number(w.into()));
        }
    }

    usage
}

/// AGY never puts the model's window on the stream; it records it (and its own
/// estimate of the live context) in the conversation's `gen_metadata`. When
/// that is readable it replaces the per-request prompt counts, which are not an
/// occupancy. Unreadable (not yet flushed, locked, other layout) leaves `usage`
/// untouched — the post-turn re-read picks the metadata up later.
fn read_native_context_usage(conversation_id: Option<&str>) -> Option<Value> {
    let id = conversation_id.filter(|id| !id.is_empty() && !id.contains(['/', '\\', '.']))?;
    let db = session_db(id).ok().flatten()?;
    crate::history::agy::read_native_context(&db)
        .as_ref()
        .and_then(crate::history::agy::native_context_usage)
}

fn attach_native_context(mut usage: Value, conversation_id: Option<&str>) -> Value {
    if let (Some(native), Some(target)) = (
        read_native_context_usage(conversation_id),
        usage.as_object_mut(),
    ) {
        if let Some(object) = native.as_object() {
            for (key, value) in object {
                target.insert(key.clone(), value.clone());
            }
        }
    }
    usage
}

impl Engine for AgyEngine {
    fn id(&self) -> &'static str {
        "agy"
    }

    fn supports_images(&self) -> bool {
        // build_command injects absolute image paths + a `view_file`
        // instruction into the prompt and registers the pasted-images sandbox
        // via `--add-dir`; that IS the agy image transport.
        true
    }
    fn supports_effort(&self) -> bool {
        true
    }
    fn supports_compact(&self) -> bool {
        true
    }

    fn supported_permissions(&self) -> &'static [&'static str] {
        &["auto", "plan", "bypass"]
    }

    fn build_command(&self, req: &SendRequest, bin: &str) -> Result<BuiltCommand, String> {
        let is_compact = super::parse_compact_prompt(&req.prompt).is_some();
        let session_id = req
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if is_compact && session_id.is_none() {
            return Err("当前会话尚未建立，无法压缩上下文".into());
        }
        self.throughput
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .begin(session_id, Instant::now());
        let mut cmd = command_for_binary(bin);
        let bridged = req
            .model
            .as_deref()
            .map(str::trim)
            .is_some_and(super::agy_vertex::is_bridge_model);
        if let Some(id) = session_id {
            validate_resume(id, bridged)?;
        }
        if bridged {
            // `modelProvider: "gemini"` lives only in this data dir, so the
            // subscription sessions keep the untouched native settings.
            cmd.arg("--app_data_dir");
            cmd.arg(super::agy_vertex::prepare_app_dir()?);
        }
        cmd.arg("--output-format");
        cmd.arg("stream-json");
        // Newer CLIs default to unlimited; keep an explicit ceiling for this
        // host while allowing long agent turns with tools.
        cmd.arg("--print-timeout");
        cmd.arg("60m");

        match self.resolve_permission(req.permission.as_deref()) {
            "bypass" => {
                if !is_compact {
                    cmd.arg("--disable-slash-commands");
                }
                cmd.arg("--dangerously-skip-permissions");
            }
            "plan" => {
                cmd.arg("--mode");
                cmd.arg("plan");
            }
            _ => {
                if !is_compact {
                    cmd.arg("--disable-slash-commands");
                }
                cmd.arg("--mode");
                cmd.arg("accept-edits");
            }
        }

        if let Some(model) = req
            .model
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty())
        {
            cmd.arg("--model");
            cmd.arg(model);
            if !bridged {
                if let Some(effort) = effort_flag(req.effort.as_deref(), model) {
                    cmd.arg("--effort");
                    cmd.arg(effort);
                }
            }
        } else if let Some(effort) = effort_flag(req.effort.as_deref(), "") {
            cmd.arg("--effort");
            cmd.arg(effort);
        }

        // Print mode does not treat process cwd as the workspace; the working
        // directory must be registered explicitly via --add-dir.
        let mut seen_dirs = std::collections::HashSet::new();
        let workspace = req.workspace.to_string_lossy();
        if !workspace.is_empty() && seen_dirs.insert(workspace.to_string()) {
            cmd.arg("--add-dir");
            cmd.arg(req.workspace.as_os_str());
        }
        for dir in &req.additional_dirs {
            let dir = dir.trim();
            if dir.is_empty() || !seen_dirs.insert(dir.to_string()) {
                continue;
            }
            cmd.arg("--add-dir");
            cmd.arg(dir);
        }
        // Pasted/imported images live in `~/.ccgui-next/pasted-images` outside
        // the project workspace; register that sandbox via `--add-dir` so
        // `view_file` is permitted in headless `accept-edits` and `plan` modes.
        let pasted_dir = super::images::pasted_images_dir();
        let uses_pasted_sandbox = req
            .images
            .iter()
            .filter_map(|raw| super::images::absolutize_image_path(raw, &req.workspace))
            .any(|path| path.starts_with(&pasted_dir));
        if uses_pasted_sandbox {
            let dir_str = pasted_dir.to_string_lossy().to_string();
            if !dir_str.is_empty() && seen_dirs.insert(dir_str) {
                cmd.arg("--add-dir");
                cmd.arg(pasted_dir.as_os_str());
            }
        }

        if let Some(session_id) = session_id {
            cmd.arg("--conversation");
            cmd.arg(session_id);
        }

        let prompt_text = if is_compact {
            "/compact".to_string()
        } else {
            super::images::agy_prompt_with_images(&req.prompt, &req.images, &req.workspace)
        };
        // `--print` is a string flag: the next token is the prompt. Keep it last
        // so a following option can never be swallowed as the prompt value.
        cmd.arg("--print");
        cmd.arg(&prompt_text);

        Ok(BuiltCommand {
            command: cmd,
            stdin_payload: None,
            keep_stdin_open: false,
            cleanup_files: Vec::new(),
            mcp_restore: None,
            preassigned_session_id: None,
        })
    }

    fn build_command_with_host_chat(&self, req: &SendRequest, bin: &str, server: Option<&Value>) -> Result<BuiltCommand, String> {
        let Some(server) = server else { return self.build_command(req, bin); };
        if req.allowed_tools.is_some() {
            return Err("Tool-constrained AGY runs cannot mount the host chat capability".into());
        }
        let root = stage_host_chat(&crate::paths::app_home().join(HOST_STAGING), server)?;
        let mut request = req.clone();
        request.additional_dirs.push(root.to_string_lossy().to_string());
        match self.build_command(&request, bin) {
            Ok(mut built) => { built.cleanup_files.push(root); Ok(built) }
            Err(error) => { super::cleanup_staged_files(&[root]); Err(error) }
        }
    }

    fn parse_line(&self, line: &str, out: &mut Vec<EngineEvent>) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let mut telemetry = self.throughput.lock().unwrap_or_else(|p| p.into_inner());
        if telemetry.ended() {
            return;
        }
        let payload = nested(&value, event_name(&value));
        if telemetry.is_child(string_field(&value, "conversation_id"))
            || telemetry.is_child(string_field(payload, "conversation_id"))
        {
            return;
        }
        match event_name(&value) {
            "init" => {
                let init = nested(&value, "init");
                if let Some(id) = string_field(&value, "conversation_id")
                    .or_else(|| string_field(init, "conversation_id"))
                {
                    telemetry.init(Some(id));
                    out.push(EngineEvent::SessionId(id.to_string()));
                }
                if let Some(model) = string_field(init, "model") {
                    out.push(EngineEvent::Model(
                        super::agy_vertex::display_model(model).to_string(),
                    ));
                }
                if init
                    .get("expanded_commands")
                    .or_else(|| value.get("expanded_commands"))
                    .and_then(Value::as_array)
                    .is_some_and(|cmds| {
                        cmds.iter()
                            .any(|c| string_field(c, "name") == Some("compact"))
                    })
                {
                    out.push(EngineEvent::Compaction {
                        active: true,
                        reason: Some("manual".to_string()),
                    });
                }
            }
            "step_update" => {
                let step = nested(&value, "step_update");
                let id = string_field(&value, "conversation_id")
                    .or_else(|| string_field(step, "conversation_id"));
                telemetry.step(step, id);
                let emit_tool_call = step
                    .get("tool_info")
                    .is_some_and(Value::is_object)
                    && telemetry.claim_tool_step(step);
                parse_step_update(step, emit_tool_call, out);
                if string_field(step, "step_type") == Some("checkpoint") {
                    match string_field(step, "state") {
                        Some("ACTIVE") => out.push(EngineEvent::Compaction {
                            active: true,
                            reason: None,
                        }),
                        Some("DONE") => {
                            out.push(EngineEvent::Compaction {
                                active: false,
                                reason: None,
                            });
                            if let Some(native) =
                                read_native_context_usage(id.or_else(|| telemetry.root()))
                            {
                                out.push(EngineEvent::Usage(native));
                            }
                        }
                        _ => {}
                    }
                }
                // A multi-step turn used to show nothing until its very end.
                // Each finished root model response refreshes the live rate
                // and context window occupancy.
                if string_field(step, "step_type") == Some("agent_response")
                    && string_field(step, "state") == Some("DONE")
                {
                    if let Some(sample) = telemetry.running_sample(Instant::now()) {
                        out.push(EngineEvent::Throughput(sample));
                    }
                    if let Some(native) =
                        read_native_context_usage(id.or_else(|| telemetry.root()))
                    {
                        out.push(EngineEvent::Usage(native));
                    }
                }
            }
            "result" => {
                let result = nested(&value, "result");
                let conversation_id = string_field(result, "conversation_id")
                    .or_else(|| string_field(&value, "conversation_id"))
                    .or_else(|| telemetry.root());
                let usage = Some(attach_native_context(
                    attach_context_window(telemetry.usage(result.get("usage"))),
                    conversation_id,
                ));
                let succeeded = result_succeeded(result) || answered_turn(result, &telemetry);
                let partial = !succeeded
                    || result.get("interrupted").and_then(Value::as_bool) == Some(true);
                if let Some(sample) = telemetry.finish(partial, Instant::now()) {
                    out.push(EngineEvent::Throughput(sample));
                }
                parse_result(result, usage, succeeded, out);
            }
            "error" => {
                if let Some(native) = read_native_context_usage(
                    string_field(&value, "conversation_id")
                        .or_else(|| string_field(payload, "conversation_id"))
                        .or_else(|| telemetry.root()),
                ) {
                    out.push(EngineEvent::Usage(native));
                }
                if let Some(sample) = telemetry.finish(true, Instant::now()) {
                    out.push(EngineEvent::Throughput(sample));
                }
                let message = string_field(&value, "message")
                    .or_else(|| string_field(&value, "error"))
                    .or_else(|| string_field(payload, "message"))
                    .unwrap_or("agy error")
                    .to_string();
                out.push(EngineEvent::Error(message));
            }
            _ => {}
        }
    }

    fn finish_telemetry(&self, _interrupted: bool, out: &mut Vec<EngineEvent>) {
        let mut telemetry = self
            .throughput
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let root = telemetry.root().map(str::to_string);
        if let Some(sample) = telemetry.finish(true, Instant::now()) {
            if let Some(native) = read_native_context_usage(root.as_deref()) {
                out.push(EngineEvent::Usage(native));
            }
            out.push(EngineEvent::Throughput(sample));
        }
    }
}

/// `--effort` only when the request names one and the model slug does not
/// already encode it (`gemini-3.8-flash-high`). The requested string is passed
/// through unchanged.
pub(crate) fn effort_flag<'a>(requested: Option<&'a str>, model: &str) -> Option<&'a str> {
    let effort = requested.map(str::trim).filter(|e| !e.is_empty())?;
    if model_encodes_effort(model) {
        return None;
    }
    Some(effort)
}

pub(crate) fn model_encodes_effort(model: &str) -> bool {
    let lower = model.trim().to_ascii_lowercase();
    lower.ends_with("-high") || lower.ends_with("-medium") || lower.ends_with("-low")
}

fn event_name(value: &Value) -> &str {
    value
        .get("event")
        .or_else(|| value.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("")
}

/// `{"event":"init","init":{…}}` payload, or the object itself when flattened.
fn nested<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).filter(|v| v.is_object()).unwrap_or(value)
}

fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn push_conversation_id(value: &Value, out: &mut Vec<EngineEvent>) {
    if let Some(id) = string_field(value, "conversation_id") {
        out.push(EngineEvent::SessionId(id.to_string()));
    }
}

fn parse_step_update(step: &Value, emit_tool_call: bool, out: &mut Vec<EngineEvent>) {
    if let Some(delta) = step
        .get("text_delta")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        out.push(EngineEvent::Delta(delta.to_string()));
    }
    // Child trajectories are observations, never the active session ID.
    if let Some(info) = step.get("subagent_info").filter(|v| v.is_object()) {
        out.push(tool_call_message("subagent", Some(info)));
    }
    let Some(tool) = step.get("tool_info").filter(|v| v.is_object()) else {
        return;
    };
    let name = string_field(tool, "name")
        .or_else(|| string_field(tool, "tool_name"))
        .or_else(|| string_field(tool, "canonical_name"))
        .unwrap_or("tool");
    let args = tool
        .get("parameters")
        .or_else(|| tool.get("args"))
        .or_else(|| tool.get("input"));
    if emit_tool_call && (args.is_some() || tool.get("output").is_none()) {
        out.push(tool_call_message(name, args));
    }
    if let Some(error) = tool.get("error").filter(|v| !v.is_null()) {
        let mut result = serde_json::Map::new();
        if let Some(output) = tool.get("output") {
            result.insert("output".into(), output.clone());
        }
        result.insert("error".into(), error.clone());
        out.push(tool_result_patch(name, Some(&Value::Object(result))));
    } else if let Some(output) = tool.get("output") {
        if !output.is_null() {
            out.push(tool_result_patch(name, Some(output)));
        }
    }
}

/// AGY's `BuildJSONOutput` copies `LastStepError(allSteps)` into `result.error`
/// across the whole conversation trajectory (including earlier recovered retry
/// `ERROR_MESSAGE` steps) before `EmitFinal` sets `status: "SUCCESS"`. An
/// explicit `SUCCESS`/`OK` verdict means the turn recovered and completed;
/// `result.error` alone is only terminal when `status` is absent or non-OK.
fn result_succeeded(result: &Value) -> bool {
    let status = string_field(result, "status").unwrap_or("");
    if status.eq_ignore_ascii_case("success") || status.eq_ignore_ascii_case("ok") {
        return true;
    }
    status.is_empty() && result.get("error").is_none_or(Value::is_null)
}

/// That same trajectory-wide `result.error` also arrives without a `SUCCESS`
/// verdict on later turns that finished normally (seen on resumed sessions
/// whose earlier turn retried past a stream interruption or API error). A turn
/// whose last root step is a finished model response with a final `response`
/// delivered its answer; the error belongs to an earlier, recovered step.
fn answered_turn(result: &Value, telemetry: &AgyThroughput) -> bool {
    telemetry.answered() && string_field(result, "response").is_some()
}

fn parse_result(result: &Value, usage: Option<Value>, succeeded: bool, out: &mut Vec<EngineEvent>) {
    push_conversation_id(result, out);
    // Headless denied_actions contains action/display_name, not tool arguments
    // or paths. Surface the refusal without inventing execution or a grant path.
    if let Some(actions) = result.get("denied_actions").and_then(Value::as_array) {
        for action in actions {
            let name = string_field(action, "display_name");
            let kind = string_field(action, "action");
            out.push(EngineEvent::PermissionDenied {
                tool: name.map(str::to_string),
                path: None,
                message: format!(
                    "agy denied action: {}",
                    match (name, kind) {
                        (Some(name), Some(kind)) => format!("{name} ({kind})"),
                        (Some(value), None) | (None, Some(value)) => value.to_string(),
                        (None, None) => action.to_string(),
                    }
                ),
            });
        }
    }
    if let Some(usage) = usage.clone() {
        out.push(EngineEvent::Usage(usage));
    }
    if !succeeded {
        let status = string_field(result, "status").unwrap_or("agy error");
        let message = string_field(result, "error")
            .or_else(|| string_field(result, "message"))
            .unwrap_or(status)
            .to_string();
        out.push(EngineEvent::Error(message));
        return;
    }
    let session_id = string_field(result, "conversation_id").map(str::to_string);
    out.push(EngineEvent::Done { session_id, usage });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn resume_keeps_billing_channel_and_rejects_colliding_ids() {
        let root = std::env::temp_dir().join(format!("agy-resume-{}", uuid::Uuid::new_v4()));
        let homes = [root.join("native"), root.join("vertex")];
        for home in &homes { std::fs::create_dir_all(home.join("conversations")).unwrap(); }
        let native = homes[0].join("conversations/native.db");
        let vertex = homes[1].join("conversations/vertex.db");
        std::fs::write(&native, "").unwrap();
        std::fs::write(&vertex, "").unwrap();
        assert!(validate_resume_in("native", false, &homes).is_ok());
        assert!(validate_resume_in("vertex", true, &homes).is_ok());
        assert!(validate_resume_in("native", true, &homes).is_err());
        assert!(validate_resume_in("vertex", false, &homes).is_err());
        assert!(validate_resume_in("missing", true, &homes).is_err());
        assert!(session_db_in("../native", &homes).is_err());
        assert_eq!(session_db_in("vertex", &homes).unwrap(), Some(vertex));
        std::fs::write(homes[1].join("conversations/native.db"), "").unwrap();
        assert!(session_db_in("native", &homes).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    fn req(permission: Option<&str>) -> SendRequest {
        SendRequest {
            claude_ultracode: None,
            host_instructions: None,
            session_id: None,
            workspace: PathBuf::from("/tmp/ws"),
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
    fn host_plugin_is_private_and_preserves_prompt_resume_and_role_text() {
        let engine = AgyEngine::new();
        let mut request = req(Some("auto"));
        request.session_id = Some("native-session".into());
        request.prompt = "用户任务 🧭\n原文 $(id) %PATH%".into();
        request.model = Some("gemini-3.8-flash-high".into());
        let server = serde_json::json!({"command":"fake-ccgui","args":["--host-chat-mcp"],"env":{"CCGUI_HOST_CHAT_TOKEN":"first-run"}});
        let mut first = engine.build_command_with_host_chat(&request, "agy", Some(&server)).unwrap();
        let second_server = serde_json::json!({"command":"fake-ccgui","env":{"CCGUI_HOST_CHAT_TOKEN":"second-run"}});
        let second = engine.build_command_with_host_chat(&request, "agy", Some(&second_server)).unwrap();
        assert_ne!(first.cleanup_files, second.cleanup_files);
        let root = &first.cleanup_files[0];
        let config: Value = serde_json::from_slice(&std::fs::read(root.join(HOST_PLUGIN).join("mcp_config.json")).unwrap()).unwrap();
        assert_eq!(config["mcpServers"]["ccgui"], server);
        assert!(config.to_string().contains("first-run"));
        assert!(!config.to_string().contains("second-run"));
        let args: Vec<_> = first.command.as_std().get_args().map(|s| s.to_string_lossy().to_string()).collect();
        assert_eq!(&args[args.len()-2..], &["--print".to_string(), request.prompt.clone()]);
        assert!(args.windows(2).any(|args| args == ["--conversation", "native-session"]));
        assert!(args.windows(2).any(|args| args == ["--add-dir", root.to_str().unwrap()]));
        let role = "Leader 指令 🧭\n子任务范围：%PATH% `echo` $(id)";
        append_host_instructions(&mut first, role).unwrap();
        assert_eq!(std::fs::read_to_string(first.cleanup_files[0].join(HOST_PLUGIN).join("rules/AGENTS.md")).unwrap(), role);
        super::super::cleanup_staged_files(&first.cleanup_files);
        super::super::cleanup_staged_files(&second.cleanup_files);
        assert!(first.cleanup_files.iter().all(|path| !path.exists()));
        assert!(second.cleanup_files.iter().all(|path| !path.exists()));
    }

    #[test]
    fn absent_host_and_constrained_runs_cannot_gain_a_plugin() {
        let engine = AgyEngine::new();
        let request = req(Some("auto"));
        let mut built = engine.build_command_with_host_chat(&request, "agy", None).unwrap();
        assert!(built.cleanup_files.is_empty());
        assert!(append_host_instructions(&mut built, "Leader role").is_err());
        assert!(append_host_instructions(&mut built, "").is_ok());
        let mut constrained = request;
        constrained.allowed_tools = Some(vec!["Read".into()]);
        assert!(engine.build_command_with_host_chat(&constrained, "agy", Some(&serde_json::json!({"command":"fake"}))).is_err());
    }

    #[test]
    fn host_staging_rejects_relative_and_nondirectory_roots_without_mutating_them() {
        assert!(stage_host_chat(std::path::Path::new("relative"), &Value::Null).is_err());
        let file = std::env::temp_dir().join(format!("ccgui-agy-staging-file-{}", uuid::Uuid::new_v4()));
        std::fs::write(&file, "keep").unwrap();
        assert!(stage_host_chat(&file, &Value::Null).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "keep");
        std::fs::remove_file(file).unwrap();
    }

    /// Explicit opt-in smoke check: two tiny real model replies, no tools.
    #[tokio::test]
    #[ignore = "requires a signed-in native AGY CLI and two real model requests"]
    async fn agy_live_smoke_measures_current_and_resumed_turn() {
        use tokio::io::{AsyncBufReadExt, BufReader};
        async fn run(engine: &AgyEngine, request: &SendRequest, bin: &str) -> Vec<EngineEvent> {
            let mut built = engine.build_command(request, bin).unwrap();
            built.command.current_dir(&request.workspace).stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).kill_on_drop(true);
            let mut child = built.command.spawn().expect("native AGY starts");
            let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
            let mut events = Vec::new();
            while let Some(line) = lines.next_line().await.expect("read native AGY") {
                assert!(line.len() <= 256 * 1024, "bounded smoke output");
                engine.parse_line(&line, &mut events);
            }
            assert!(child.wait().await.unwrap().success(), "native AGY exits successfully");
            events
        }
        let bin = std::env::var("CCGUI_AGY_SMOKE_BIN").expect("explicit native binary is required");
        let workspace = std::env::temp_dir().join(format!("ccgui-agy-smoke-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&workspace).unwrap();
        let engine = AgyEngine::new();
        let mut request = req(Some("auto"));
        request.workspace = workspace.clone();
        request.model = Some("gemini-3.8-flash-low".into());
        request.prompt = "Do not use any tools. Reply with exactly: AGY telemetry test.".into();
        for turn in 0..2 {
            let events = tokio::time::timeout(std::time::Duration::from_secs(35), run(&engine, &request, &bin))
                .await.expect("bounded native smoke request");
            let sample = events.iter().rev().find_map(|event| if let EngineEvent::Throughput(value) = event { Some(value) } else { None }).expect("native TPS sample");
            assert_eq!(sample["source"], "agy");
            assert_eq!(sample["status"], "complete");
            assert!(sample["outputTokens"].as_u64().is_some_and(|n| n > 0));
            assert!(sample["elapsedMs"].as_f64().is_some_and(|n| n > 0.0));
            let (session_id, usage) = events.iter().find_map(|event| if let EngineEvent::Done {session_id,usage} = event { Some((session_id,usage)) } else {None}).expect("native done");
            let usage = usage.as_ref().unwrap();
            assert_eq!(usage["usage_scope"], "turn");
            assert!(matches!(usage["context_usage_kind"].as_str(), Some("last_prompt" | "current_context")));
            assert!(usage["context_usage"].is_object());
            assert_eq!(usage["output_tokens"], sample["outputTokens"]);
            assert!(usage["session_usage"]["output_tokens"].as_u64().unwrap() >= sample["outputTokens"].as_u64().unwrap());
            println!("AGY native turn {turn}: current-turn accounting, context provenance and TPS verified");
            request.session_id = session_id.clone();
            assert!(request.session_id.is_some());
        }
        // Do not recursively remove anything an unexpected tool might have written.
        let _ = std::fs::remove_dir(&workspace);
    }

    fn argv(req: &SendRequest) -> Vec<String> {
        let built = AgyEngine::new().build_command(req, "agy").unwrap();
        built
            .command
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect()
    }

    fn events(line: &str) -> Vec<EngineEvent> {
        let mut out = Vec::new();
        AgyEngine::new().parse_line(line, &mut out);
        out
    }

    #[test]
    fn print_flag_is_last_and_owns_the_prompt() {
        let args = argv(&req(Some("auto")));
        assert_eq!(args[args.len() - 2], "--print");
        assert_eq!(args[args.len() - 1], "hi");
        assert!(args
            .windows(2)
            .any(|w| w == ["--output-format", "stream-json"]));
        assert!(args.windows(2).any(|w| w == ["--print-timeout", "60m"]));
        assert!(args.windows(2).any(|w| w == ["--mode", "accept-edits"]));
        assert!(args.contains(&"--disable-slash-commands".to_string()));
        assert!(args.windows(2).any(|w| w == ["--add-dir", "/tmp/ws"]));
        assert!(!args.contains(&"--dangerously-skip-permissions".to_string()));
    }

    #[test]
    fn maps_plan_and_bypass() {
        let plan = argv(&req(Some("plan")));
        assert!(plan.windows(2).any(|w| w == ["--mode", "plan"]));
        assert!(!plan.contains(&"--dangerously-skip-permissions".to_string()));
        assert!(!plan.contains(&"--disable-slash-commands".to_string()));

        let bypass = argv(&req(Some("bypass")));
        assert!(bypass.contains(&"--dangerously-skip-permissions".to_string()));
        assert!(bypass.contains(&"--disable-slash-commands".to_string()));
        assert!(!bypass.contains(&"--mode".to_string()));
    }

    #[test]
    fn resume_and_model_and_extra_dirs() {
        let mut request = req(Some("auto"));
        request.session_id = Some("45d30962-3fae-4b48-8de5-0ed0edf5b9cb".into());
        request.model = Some("gemini-3.8-flash-high".into());
        request.effort = Some("high".into());
        request.additional_dirs = vec!["/tmp/ws".into(), "/extra".into()];
        let args = argv(&request);
        assert!(args
            .windows(2)
            .any(|w| { w == ["--conversation", "45d30962-3fae-4b48-8de5-0ed0edf5b9cb"] }));
        assert!(args
            .windows(2)
            .any(|w| w == ["--model", "gemini-3.8-flash-high"]));
        // Slug already encodes effort — do not send a redundant flag.
        assert!(!args.contains(&"--effort".to_string()));
        assert_eq!(args.iter().filter(|a| *a == "--add-dir").count(), 2);
        assert!(args.windows(2).any(|w| w == ["--add-dir", "/extra"]));
    }

    #[test]
    fn supports_images_and_injects_view_file_prompt_and_pasted_dir() {
        assert!(AgyEngine::new().supports_images());
        let pasted_dir = crate::engine::images::pasted_images_dir();
        let pasted_img = pasted_dir.join("clip-123.png");
        let mut request = req(Some("auto"));
        request.images = vec![pasted_img.to_string_lossy().to_string()];
        let args = argv(&request);
        let pasted_dir_str = pasted_dir.to_string_lossy().to_string();
        assert!(
            args.windows(2)
                .any(|w| w == ["--add-dir", pasted_dir_str.as_str()]),
            "expected --add-dir for pasted_images_dir, got: {args:?}"
        );
        let prompt_arg = args.last().unwrap();
        assert!(prompt_arg.starts_with("hi"));
        assert!(prompt_arg.contains(crate::engine::images::AGY_IMAGE_MARKER));
        assert!(prompt_arg.contains("view_file"));
        assert!(prompt_arg.contains(&format!("<image path=\"{}\"></image>", pasted_img.display())));
    }

    #[test]
    fn effort_passed_when_slug_has_none() {
        let mut request = req(Some("auto"));
        request.model = Some("claude-sonnet-4-6".into());
        request.effort = Some("xhigh".into());
        let args = argv(&request);
        assert!(args.windows(2).any(|w| w == ["--effort", "xhigh"]));
    }

    #[test]
    fn parses_init_delta_tool_and_result() {
        let init = events(r#"{"event":"init","init":{"conversation_id":"abc-1"}}"#);
        match &init[..] {
            [EngineEvent::SessionId(id)] => assert_eq!(id, "abc-1"),
            other => panic!("unexpected init: {other:?}"),
        }

        let delta = events(
            r#"{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"Hello"}}"#,
        );
        match &delta[..] {
            [EngineEvent::Delta(text)] => assert_eq!(text, "Hello"),
            other => panic!("unexpected delta: {other:?}"),
        }

        let tool = events(
            r#"{"event":"step_update","step_update":{"step_type":"tool","tool_info":{"name":"read_file","parameters":{"path":"a.ts"},"output":"ok"}}}"#,
        );
        assert!(matches!(
            &tool[0],
            EngineEvent::Message { role, text, path, patch, .. }
                if role == "tool" && text == "read_file" && path.as_deref() == Some("a.ts") && !patch
        ));
        assert!(matches!(
            &tool[1],
            EngineEvent::Message {
                result: Some(_),
                patch: true,
                ..
            }
        ));

        let done = events(
            r#"{"event":"result","result":{"status":"SUCCESS","conversation_id":"abc-1","usage":{"input_tokens":3,"output_tokens":4}}}"#,
        );
        assert!(done
            .iter()
            .any(|e| matches!(e, EngineEvent::SessionId(id) if id == "abc-1")));
        assert!(done.iter().any(|e| matches!(e, EngineEvent::Usage(_))));
        assert!(done.iter().any(|e| matches!(
            e,
            EngineEvent::Done { session_id: Some(id), usage: Some(_) } if id == "abc-1"
        )));
    }

    #[test]
    fn result_error_status_is_terminal_error() {
        for raw in [
            r#"{"event":"result","result":{"status":"ERROR","error":"RESOURCE_EXHAUSTED"}}"#,
            r#"{"event":"result","result":{"error":"RESOURCE_EXHAUSTED"}}"#,
        ] {
            let ev = events(raw);
            match &ev[..] {
                [EngineEvent::Throughput(sample), EngineEvent::Usage(_), EngineEvent::Error(msg)] => {
                    assert_eq!(msg, "RESOURCE_EXHAUSTED");
                    assert_eq!(sample["status"], "partial");
                }
                other => panic!("unexpected: {other:?}"),
            }
        }
    }

    #[test]
    fn success_result_ignores_recovered_trajectory_retry_error() {
        let ev = events(
            r#"{"event":"result","result":{"status":"SUCCESS","conversation_id":"abc-1","error":"API error (attempt 1): request failed: Post \"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse\": EOF","usage":{"input_tokens":10,"output_tokens":5}}}"#,
        );
        assert!(ev.iter().any(|e| matches!(
            e,
            EngineEvent::Throughput(sample) if sample["status"] == "complete"
        )));
        assert!(ev.iter().any(|e| matches!(
            e,
            EngineEvent::Done { session_id: Some(id), .. } if id == "abc-1"
        )));
        assert!(!ev.iter().any(|e| matches!(e, EngineEvent::Error(_))));
    }

    fn turn(steps: &[(u64, &str, &str)], result: &str) -> Vec<EngineEvent> {
        let engine = AgyEngine::new();
        let mut out = Vec::new();
        engine.parse_line(r#"{"event":"init","conversation_id":"root","init":{}}"#, &mut out);
        for (index, kind, state) in steps {
            let line = serde_json::json!({"event":"step_update","step_update":{
                "conversation_id":"root","step_index":index,"step_type":kind,"state":state}});
            engine.parse_line(&line.to_string(), &mut out);
        }
        out.clear();
        engine.parse_line(result, &mut out);
        out
    }

    #[test]
    fn answered_turn_ignores_stale_trajectory_error_without_success_verdict() {
        let stale = "The stream was interrupted. Please continue the task you were working on.";
        let answered = [(333, "user_input", "DONE"), (334, "system_message", "DONE"),
            (335, "agent_response", "ACTIVE"), (335, "agent_response", "DONE")];
        for result in [
            serde_json::json!({"event":"result","result":{"conversation_id":"root","response":"答复 ✅","error":stale}}),
            serde_json::json!({"event":"result","result":{"conversation_id":"root","status":"ERROR","response":"答复 ✅","error":stale}}),
        ] {
            let ev = turn(&answered, &result.to_string());
            assert!(!ev.iter().any(|e| matches!(e, EngineEvent::Error(_))), "{ev:?}");
            assert!(ev.iter().any(|e| matches!(e, EngineEvent::Done { session_id: Some(id), .. } if id == "root")));
            assert!(ev.iter().any(|e| matches!(e, EngineEvent::Throughput(sample) if sample["status"] == "complete")));
        }
    }

    #[test]
    fn unanswered_turn_keeps_result_error_terminal() {
        let failed = r#"{"event":"result","result":{"conversation_id":"root","status":"ERROR","response":"partial","error":"API error (attempt 4): Error 429"}}"#;
        for steps in [
            // The failed request came after a tool step: no final model response.
            &[(10, "user_input", "DONE"), (11, "agent_response", "DONE"), (12, "tool", "DONE")][..],
            // The final model response never finished.
            &[(10, "user_input", "DONE"), (11, "agent_response", "ACTIVE")][..],
            // Nothing of this turn ran at all.
            &[][..],
        ] {
            let ev = turn(steps, failed);
            assert!(ev.iter().any(|e| matches!(e, EngineEvent::Error(m) if m == "API error (attempt 4): Error 429")), "{ev:?}");
            assert!(!ev.iter().any(|e| matches!(e, EngineEvent::Done { .. })));
        }
        // A finished response with no final text is not an answered turn.
        let ev = turn(&[(10, "user_input", "DONE"), (11, "agent_response", "DONE")],
            r#"{"event":"result","result":{"conversation_id":"root","status":"ERROR","error":"RESOURCE_EXHAUSTED"}}"#);
        assert!(ev.iter().any(|e| matches!(e, EngineEvent::Error(m) if m == "RESOURCE_EXHAUSTED")));
        // Steps from before this turn's user input never count as its answer.
        let ev = turn(&[(20, "user_input", "DONE"), (19, "agent_response", "DONE")],
            r#"{"event":"result","result":{"conversation_id":"root","response":"old","error":"RESOURCE_EXHAUSTED"}}"#);
        assert!(ev.iter().any(|e| matches!(e, EngineEvent::Error(_))));
    }

    #[test]
    fn older_ok_status_still_finishes() {
        let ev = events(r#"{"event":"result","result":{"status":"OK","conversation_id":"x"}}"#);
        assert!(ev.iter().any(|e| matches!(
            e,
            EngineEvent::Done { session_id: Some(id), .. } if id == "x"
        )));
    }

    #[test]
    fn print_preserves_prompt_verbatim_in_all_modes() {
        for permission in ["auto", "plan", "bypass"] {
            for prompt in ["-literal\n中文 😀 ", "@reference", "  /plan\n"] {
                let mut request = req(Some(permission));
                request.prompt = prompt.into();
                let args = argv(&request);
                assert_eq!(&args[args.len() - 2..], &["--print", prompt]);
            }
        }
    }

    #[test]
    fn init_prefers_outer_id_and_reports_actual_model() {
        let ev = events(
            r#"{"event":"init","conversation_id":"outer","init":{"conversation_id":"inner","model":"gemini-3.8-flash-high"}}"#,
        );
        assert!(
            matches!(&ev[..], [EngineEvent::SessionId(id), EngineEvent::Model(model)]
            if id == "outer" && model == "gemini-3.8-flash-high")
        );
        let flat = events(r#"{"event":"init","conversation_id":"flat","model":"actual"}"#);
        assert!(
            matches!(&flat[..], [EngineEvent::SessionId(id), EngineEvent::Model(model)]
            if id == "flat" && model == "actual")
        );
    }

    #[test]
    fn text_deltas_preserve_whitespace_and_unicode() {
        let chunks = ["  ", "中文", "\n", "😀 ", "```\n", "  code\n", "```", ""];
        let mut actual = String::new();
        for chunk in chunks {
            let line =
                serde_json::json!({"event":"step_update", "step_update":{"text_delta":chunk}})
                    .to_string();
            let ev = events(&line);
            if chunk.is_empty() {
                assert!(ev.is_empty());
            } else {
                assert!(matches!(&ev[..], [EngineEvent::Delta(text)] if text == chunk));
                if let EngineEvent::Delta(text) = &ev[0] {
                    actual.push_str(text);
                }
            }
        }
        assert_eq!(actual, chunks.concat());
    }

    #[test]
    fn tool_error_is_a_result_and_preserves_output() {
        for output in [None, Some(serde_json::json!("partial output"))] {
            let error = serde_json::json!({"type":"execution_error", "message":"failed"});
            let mut tool = serde_json::json!({"name":"RunCommand", "parameters":{"command":"test"}, "error":error});
            if let Some(output) = &output {
                tool["output"] = output.clone();
            }
            let ev = events(
                &serde_json::json!({"event":"step_update", "step_update":{"tool_info":tool}})
                    .to_string(),
            );
            assert_eq!(ev.len(), 2);
            assert!(
                matches!(&ev[1], EngineEvent::Message { result: Some(result), patch: true, .. }
                if result["error"] == error && result.get("output") == output.as_ref())
            );
            assert!(!ev.iter().any(|e| matches!(e, EngineEvent::Error(_))));
        }
    }

    #[test]
    fn denied_actions_are_not_successful_tools_or_terminal_errors() {
        let ev = events(
            r#"{"event":"result","result":{"status":"SUCCESS","denied_actions":[{"action":"command","display_name":"RunCommand"}]}}"#,
        );
        assert!(
            matches!(&ev[..], [EngineEvent::Throughput(_), EngineEvent::PermissionDenied { tool: Some(tool), path: None, message }, EngineEvent::Usage(_), EngineEvent::Done { .. }]
            if tool == "RunCommand" && message.contains("RunCommand") && message.contains("command"))
        );
        let empty =
            events(r#"{"event":"result","result":{"status":"SUCCESS","denied_actions":[]}}"#);
        assert!(matches!(
            &empty[..],
            [
                EngineEvent::Throughput(_),
                EngineEvent::Usage(_),
                EngineEvent::Done { .. }
            ]
        ));
    }

    #[test]
    fn subagent_metadata_is_observed_without_switching_sessions() {
        let info = serde_json::json!({"subagents":[{"type_name":"explorer","role":"research","conversation_id":"child-1","log_uri":"file:///child","workspace_uris":["file:///workspace"]}], "future_metadata":true});
        let ev = events(
            &serde_json::json!({"event":"step_update", "step_update":{"subagent_info":info}})
                .to_string(),
        );
        assert!(
            matches!(&ev[..], [EngineEvent::Message { role, text, args: Some(args), result: None, .. }]
            if role == "tool" && text == "subagent" && args == &info)
        );
    }

    #[test]
    fn terminal_observation_precedes_done_and_uses_only_current_main_steps() {
        let engine = AgyEngine::new();
        engine.build_command(&req(Some("auto")), "agy").unwrap();
        let mut out = Vec::new();
        for value in [
            serde_json::json!({"event":"init","conversation_id":"root","init":{"model":"actual"}}),
            serde_json::json!({"event":"init","conversation_id":"child","init":{"model":"child-model"}}),
            serde_json::json!({"event":"step_update","step_update":{"conversation_id":"root","step_index":12,"state":"DONE","step_type":"user_input"}}),
            serde_json::json!({"event":"step_update","step_update":{"conversation_id":"child","step_index":13,"state":"DONE","step_type":"agent_response","usage":{"input_tokens":500,"output_tokens":900}}}),
            serde_json::json!({"event":"step_update","step_update":{"conversation_id":"root","step_index":13,"state":"DONE","step_type":"agent_response","usage":{"input_tokens":100,"output_tokens":20,"cache_read_tokens":60}}}),
            serde_json::json!({"event":"result","result":{"conversation_id":"root","status":"SUCCESS","duration_seconds":999,"usage":{"input_tokens":5000,"output_tokens":3000}}}),
        ] {
            engine.parse_line(&value.to_string(), &mut out);
        }
        let telemetry_index = out
            .iter()
            .position(|e| matches!(e, EngineEvent::Throughput(_)))
            .unwrap();
        assert!(!out
            .iter()
            .any(|e| matches!(e, EngineEvent::SessionId(id) if id == "child")));
        let done_index = out
            .iter()
            .position(|e| matches!(e, EngineEvent::Done { .. }))
            .unwrap();
        assert!(telemetry_index < done_index);
        assert!(
            matches!(&out[telemetry_index],EngineEvent::Throughput(sample) if sample["outputTokens"] == 20 && sample["source"] == "agy")
        );
        assert!(
            matches!(&out[done_index],EngineEvent::Done {usage:Some(usage),..}
            if usage["output_tokens"] == 20 && usage["session_usage"]["output_tokens"] == 3000
                && usage["context_usage"]["cached_input_tokens"] == 60)
        );
        let settled_len = out.len();
        for late in [
            r#"{"event":"result","result":{"conversation_id":"root","status":"SUCCESS","usage":{"input_tokens":9999,"output_tokens":9999}}}"#,
            r#"{"event":"step_update","step_update":{"conversation_id":"root","step_index":14,"state":"DONE","step_type":"agent_response","text_delta":"late","usage":{"input_tokens":100,"output_tokens":20}}}"#,
            r#"{"event":"error","conversation_id":"root","message":"late"}"#,
            r#"{"event":"init","conversation_id":"root","init":{"model":"late"}}"#,
        ] {
            engine.parse_line(late, &mut out);
        }
        assert_eq!(out.len(), settled_len);
        assert_eq!(
            out.iter()
                .filter(|e| matches!(e, EngineEvent::Usage(_)))
                .count(),
            1
        );
        assert_eq!(
            out.iter()
                .filter(|e| matches!(e, EngineEvent::Done { .. }))
                .count(),
            1
        );
        let mut tail = Vec::new();
        engine.finish_telemetry(false, &mut tail);
        assert!(tail.is_empty());
    }

    #[test]
    fn eof_and_error_are_partial_and_child_result_cannot_end_main_telemetry() {
        let engine = AgyEngine::new();
        engine.build_command(&req(Some("auto")), "agy").unwrap();
        let mut out = Vec::new();
        engine.parse_line(r#"{"event":"init","conversation_id":"root"}"#, &mut out);
        out.clear();
        engine.parse_line(
            r#"{"event":"result","result":{"conversation_id":"child","status":"SUCCESS"}}"#,
            &mut out,
        );
        assert!(out.is_empty());
        engine.finish_telemetry(false, &mut out);
        assert!(
            matches!(&out[..],[EngineEvent::Throughput(sample)] if sample["status"] == "partial")
        );
        let error = events(r#"{"event":"error","message":"failed"}"#);
        assert!(
            matches!(&error[..],[EngineEvent::Throughput(sample),EngineEvent::Error(message)]
            if sample["status"] == "partial" && message == "failed")
        );
    }

    #[test]
    fn child_errors_and_content_cannot_mutate_or_end_the_main_turn() {
        let engine = AgyEngine::new();
        engine.build_command(&req(Some("auto")), "agy").unwrap();
        let mut out = Vec::new();
        engine.parse_line(r#"{"event":"init","conversation_id":"root"}"#, &mut out);
        out.clear();
        for child in [
            r#"{"event":"error","conversation_id":"child","message":"failed child"}"#,
            r#"{"event":"error","error":{"conversation_id":"child","message":"failed child"}}"#,
            r#"{"event":"error","conversation_id":"root","error":{"conversation_id":"child","message":"conflicting ownership"}}"#,
            r#"{"event":"step_update","conversation_id":"child","step_update":{"text_delta":"child text","tool_info":{"name":"RunCommand","output":"child output"}}}"#,
            r#"{"event":"step_update","step_update":{"conversation_id":"child","text_delta":"child text","tool_info":{"name":"Read","parameters":{"path":"child"}}}}"#,
        ] {
            engine.parse_line(child, &mut out);
        }
        assert!(out.is_empty());
        engine.parse_line(r#"{"event":"step_update","step_update":{"conversation_id":"root","subagent_info":{"subagents":[{"conversation_id":"child"}]}}}"#,&mut out);
        assert!(matches!(&out[..],[EngineEvent::Message {text,..}] if text == "subagent"));
        out.clear();
        engine.parse_line(
            r#"{"event":"result","result":{"conversation_id":"root","status":"SUCCESS"}}"#,
            &mut out,
        );
        assert!(
            matches!(&out[0],EngineEvent::Throughput(sample) if sample["status"] == "complete")
        );
        assert_eq!(
            out.iter()
                .filter(|e| matches!(e, EngineEvent::Done { .. }))
                .count(),
            1
        );
        assert!(!out.iter().any(|e| matches!(e, EngineEvent::Error(_))));
    }

    #[test]
    fn finished_root_responses_emit_running_samples_even_with_cached_prompts() {
        let engine = AgyEngine::new();
        engine.build_command(&req(Some("auto")), "agy").unwrap();
        let mut out = Vec::new();
        for value in [
            serde_json::json!({"event":"init","conversation_id":"root","init":{}}),
            serde_json::json!({"event":"step_update","step_update":{"conversation_id":"root","step_index":0,"state":"DONE","step_type":"user_input"}}),
            serde_json::json!({"event":"step_update","step_update":{"conversation_id":"root","step_index":1,"state":"DONE","step_type":"agent_response","usage":{"input_tokens":3856,"output_tokens":100,"cache_read_tokens":51047,"total_tokens":3956}}}),
            serde_json::json!({"event":"step_update","step_update":{"conversation_id":"root","step_index":2,"state":"DONE","step_type":"checkpoint"}}),
        ] {
            engine.parse_line(&value.to_string(), &mut out);
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
        engine.parse_line(
            r#"{"event":"step_update","step_update":{"conversation_id":"root","step_index":3,"state":"DONE","step_type":"agent_response","usage":{"input_tokens":10,"output_tokens":50,"cache_read_tokens":59000}}}"#,
            &mut out,
        );
        let running: Vec<_> = out
            .iter()
            .filter_map(|e| if let EngineEvent::Throughput(s) = e { Some(s) } else { None })
            .collect();
        assert_eq!(running.len(), 2);
        assert!(running.iter().all(|s| s["status"] == "running"));
        assert_eq!(running[0]["outputTokens"], 100);
        assert_eq!(running[1]["outputTokens"], 150);
        assert!(!out.iter().any(|e| matches!(e, EngineEvent::Usage(_))));
    }

    #[test]
    fn suppresses_independent_effort_when_model_id_encodes_tier() {
        assert_eq!(effort_flag(Some("medium"), "gemini-4-argon-high"), None);
        assert_eq!(effort_flag(Some("medium"), "claude-opus-4-6-thinking-low"), None);
        assert_eq!(effort_flag(Some("medium"), "gpt-oss-120b-medium"), None);
        assert_eq!(effort_flag(Some("medium"), "custom-model"), Some("medium"));

        let db = crate::db::Db::open_in_memory().unwrap();
        db.0.lock()
            .execute(
                "INSERT INTO sessions(engine,session_id,workspace_path,file_path,file_size,file_mtime_ms) VALUES('agy','s-agy-1','/tmp/ws','/tmp/ws/s.jsonl',1,1)",
                [],
            )
            .unwrap();
        db.remember_session_model("agy", "s-agy-1", "gemini-4-argon-high", 1)
            .unwrap();
        db.remember_session_effort("agy", "s-agy-1", "medium", 1)
            .unwrap();
        let sessions = crate::history::reader::list_sessions_from(&db).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].model.as_deref(), Some("gemini-4-argon-high"));
        assert_eq!(sessions[0].effort, None);
    }

    #[test]
    fn compact_prompt_enables_slash_commands_requires_session_and_emits_compaction_events() {
        let engine = AgyEngine::new();
        assert!(engine.supports_compact());

        let mut missing_session = req(Some("auto"));
        missing_session.prompt = "/compact".into();
        assert!(engine.build_command(&missing_session, "agy").is_err());

        for permission in ["auto", "plan", "bypass"] {
            let mut request = req(Some(permission));
            request.session_id = Some("compact-session".into());
            request.prompt = "/compact 聚焦改动".into();
            let args = argv(&request);
            assert!(
                !args.contains(&"--disable-slash-commands".to_string()),
                "compact must not disable slash commands in {permission} mode: {args:?}"
            );
            assert_eq!(&args[args.len() - 2..], &["--print", "/compact"]);
        }

        let mut request = req(Some("auto"));
        request.session_id = Some("compact-session".into());
        request.prompt = "/compact".into();
        engine.build_command(&request, "agy").unwrap();

        let mut out = Vec::new();
        for line in [
            serde_json::json!({
                "event": "init",
                "conversation_id": "compact-session",
                "init": {
                    "model": "gemini-api://ccgui-vertex/medium/models/gemini-4-argon",
                    "expanded_commands": [{"name": "compact", "type": "system"}]
                }
            }),
            serde_json::json!({
                "event": "step_update",
                "step_update": {
                    "conversation_id": "compact-session",
                    "step_index": 2,
                    "state": "DONE",
                    "step_type": "user_input"
                }
            }),
            serde_json::json!({
                "event": "step_update",
                "step_update": {
                    "conversation_id": "compact-session",
                    "step_index": 4,
                    "state": "ACTIVE",
                    "step_type": "checkpoint"
                }
            }),
            serde_json::json!({
                "event": "step_update",
                "step_update": {
                    "conversation_id": "compact-session",
                    "step_index": 4,
                    "state": "DONE",
                    "step_type": "checkpoint"
                }
            }),
            serde_json::json!({
                "event": "result",
                "result": {
                    "conversation_id": "compact-session",
                    "status": "SUCCESS",
                    "usage": {"input_tokens": 500, "output_tokens": 100}
                }
            }),
        ] {
            engine.parse_line(&line.to_string(), &mut out);
        }

        assert!(out.iter().any(|e| matches!(e, EngineEvent::Model(m) if m == "gemini-4-argon")));
        let compactions: Vec<_> = out
            .iter()
            .filter_map(|e| match e {
                EngineEvent::Compaction { active, reason } => Some((*active, reason.as_deref())),
                _ => None,
            })
            .collect();
        assert_eq!(
            compactions,
            vec![(true, Some("manual")), (true, None), (false, None)]
        );
        assert!(out.iter().any(|e| matches!(
            e,
            EngineEvent::Done { session_id: Some(id), .. } if id == "compact-session"
        )));
    }
}
