//! Cursor Agent CLI (`cursor-agent`) adapter: one headless process per turn,
//! `-p --output-format stream-json --stream-partial-output`, prompt on stdin.

use super::{
    command_for_binary, tool_call_message, tool_result_patch, BuiltCommand, Engine, EngineEvent,
    SendRequest,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Cursor CLI config home: `$CURSOR_CONFIG_DIR` or `~/.cursor`.
pub(crate) fn cursor_home() -> PathBuf {
    crate::engine::engine_home(Some("CURSOR_CONFIG_DIR"), ".cursor")
}

/// Marker so a re-read prompt can be told apart from user text.
pub const CURSOR_IMAGE_MARKER: &str = "\n\n<!-- ccgui:cursor-image-attachments -->\n";
pub const CURSOR_HOST_INSTRUCTIONS_START: &str = "<!-- ccgui:cursor-host-instructions:start -->";
pub const CURSOR_HOST_INSTRUCTIONS_END: &str = "<!-- ccgui:cursor-host-instructions:end -->";

const HOST_STAGING: &str = "cursor-host-staging";
const HOST_PLUGIN: &str = "ccgui-host";

/// Cursor CLI discovers local plugin MCP servers via `--plugin-dir <dir>` where
/// `<dir>/.cursor-plugin/plugin.json` points to `.mcp.json`. Each process gets
/// a private staging directory so no global `~/.cursor/mcp.json` is mutated.
fn stage_host_chat(parent: &Path, server: &Value) -> Result<PathBuf, String> {
    if !parent.is_absolute()
        || parent.ancestors().any(|path| {
            std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
        })
    {
        return Err("Cursor host staging requires an absolute directory without links".into());
    }
    std::fs::create_dir_all(parent).map_err(|_| "Cannot create Cursor host staging directory")?;
    let parent =
        dunce::canonicalize(parent).map_err(|_| "Cannot resolve Cursor host staging directory")?;
    let root = parent.join(uuid::Uuid::new_v4().to_string());
    #[cfg(unix)]
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(not(unix))]
    let builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(&root)
        .map_err(|_| "Cannot create private Cursor host workspace")?;
    let resolved = match dunce::canonicalize(&root) {
        Ok(resolved) if resolved.parent() == Some(parent.as_path()) => resolved,
        _ => {
            let _ = std::fs::remove_dir(&root);
            return Err("Cursor host workspace escaped its staging directory".into());
        }
    };
    let root = resolved;
    let staged = (|| {
        let plugin = root.join(HOST_PLUGIN);
        let manifest_dir = plugin.join(".cursor-plugin");
        std::fs::create_dir_all(&manifest_dir).map_err(|_| "Cannot create Cursor host plugin")?;
        let manifest = json!({
            "name": "ccgui-host",
            "description": "CCGUI host chat and leader orchestration bridge",
            "version": "0.1.0",
            "mcpServers": ".mcp.json"
        });
        let config = json!({ "mcpServers": { "ccgui": server } });
        for (path, text) in [
            (
                manifest_dir.join("plugin.json"),
                serde_json::to_string(&manifest).map_err(|_| "Cannot encode Cursor plugin manifest")?,
            ),
            (
                plugin.join(".mcp.json"),
                serde_json::to_string(&config).map_err(|_| "Cannot encode Cursor host MCP config")?,
            ),
        ] {
            use std::io::Write;
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options
                .open(path)
                .and_then(|mut file| file.write_all(text.as_bytes()))
                .map_err(|_| "Cannot write Cursor host plugin")?;
        }
        Ok(())
    })();
    if let Err(error) = staged {
        super::cleanup_staged_files(std::slice::from_ref(&root));
        return Err(error);
    }
    Ok(root)
}

pub(super) fn append_host_instructions(
    built: &mut BuiltCommand,
    instructions: &str,
) -> Result<(), String> {
    let trimmed = instructions.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let _root = built
        .cleanup_files
        .first()
        .ok_or("Cursor Leader requires its per-run host plugin")?;
    let current = built.stdin_payload.take().unwrap_or_default();
    built.stdin_payload = Some(format!(
        "{CURSOR_HOST_INSTRUCTIONS_START}\n{trimmed}\n{CURSOR_HOST_INSTRUCTIONS_END}\n\n{current}"
    ));
    Ok(())
}

/// Cursor has no public image flag in headless mode; the agent reads the
/// attached files itself through its Read tool.
fn prompt_with_images(prompt: &str, images: &[String], workspace: &Path) -> String {
    let paths: Vec<PathBuf> = images
        .iter()
        .filter_map(|raw| super::images::absolutize_image_path(raw, workspace))
        .collect();
    if paths.is_empty() {
        return prompt.to_string();
    }
    let mut out = prompt.trim_end().to_string();
    out.push_str(CURSOR_IMAGE_MARKER);
    out.push_str("The user attached the following image file(s). ");
    out.push_str("You MUST read each path below with your file Read tool before answering any question about visual content.\n");
    for (index, path) in paths.iter().enumerate() {
        let display = path.display().to_string();
        let escaped = display
            .replace('&', "&amp;")
            .replace('"', "&quot;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        out.push_str(&format!(
            "{}. {}\n<image path=\"{}\"></image>\n",
            index + 1,
            display,
            escaped
        ));
    }
    out
}

#[derive(Default)]
struct StreamState {
    /// Launch identity is stable; CLI init may report a human-readable label.
    launch_model: Option<String>,
    /// Text already emitted as deltas since the last summary/tool boundary.
    pending: String,
    deltas: u32,
}

#[derive(Default)]
pub struct CursorEngine {
    state: Mutex<StreamState>,
}

impl CursorEngine {
    pub fn new() -> Self {
        Self::default()
    }

    fn configure_model(
        &self,
        cmd: &mut tokio::process::Command,
        model: Option<&str>,
        home: &Path,
    ) -> Result<(), String> {
        let launch_model = if let Some(model) = model.map(str::trim).filter(|m| !m.is_empty()) {
            let launch = super::cursor_picker::split_launch_model(model)?;
            let flag = super::cursor_picker::launch_model_arg(home, model)?;
            cmd.arg("--model").arg(flag);
            Some(launch.model_id)
        } else {
            None
        };
        self.state.lock().unwrap_or_else(|p| p.into_inner()).launch_model = launch_model;
        Ok(())
    }
}

fn reported_model_id(raw: &str) -> Option<String> {
    if raw.eq_ignore_ascii_case("auto") {
        return Some("auto".to_string());
    }
    let launch = super::cursor_picker::split_launch_model(raw).ok()?;
    // Init reports must be plain IDs, never parameter payloads or display labels.
    (launch.model_id == raw).then_some(launch.model_id)
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn assistant_text(value: &Value) -> String {
    value
        .pointer("/message/content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<String>()
        })
        .unwrap_or_default()
}

/// `{"readToolCall":{"args":..,"result":..}}` → (`read`, payload). MCP calls
/// carry their real tool name in `args`.
fn tool_parts(tool_call: &Value) -> Option<(String, &Value)> {
    let (key, payload) = tool_call.as_object()?.iter().next()?;
    let mut name = key.strip_suffix("ToolCall").unwrap_or(key).to_string();
    if name == "mcp" {
        if let Some(real) = payload.pointer("/args/name").and_then(Value::as_str) {
            name = real.to_string();
        }
    }
    Some((name, payload))
}

fn normalize_usage(usage: &Value) -> Option<Value> {
    let num = |key: &str| usage.get(key).and_then(Value::as_u64);
    let input = num("inputTokens")?;
    let output = num("outputTokens").unwrap_or(0);
    Some(json!({
        "input_tokens": input,
        "output_tokens": output,
        "cache_read_input_tokens": num("cacheReadTokens").unwrap_or(0),
        "cache_creation_input_tokens": num("cacheWriteTokens").unwrap_or(0),
    }))
}

impl Engine for CursorEngine {
    fn id(&self) -> &'static str {
        "cursor"
    }

    fn supports_images(&self) -> bool {
        true
    }

    /// Headless `-p` cannot prompt: without `--force` every edit, shell and
    /// MCP call is denied, so "auto" must run with `--force` to be usable.
    /// "plan" is the CLI's read-only mode.
    fn supported_permissions(&self) -> &'static [&'static str] {
        &["auto", "plan", "bypass"]
    }

    fn build_command(&self, req: &SendRequest, bin: &str) -> Result<BuiltCommand, String> {
        let mut cmd = command_for_binary(bin);
        crate::proxy::configure_cursor_command_proxy(&mut cmd);
        for arg in [
            "-p",
            "--output-format",
            "stream-json",
            "--stream-partial-output",
            "--trust",
        ] {
            cmd.arg(arg);
        }
        if req.permission.as_deref() == Some("ask") {
            cmd.arg("--mode");
            cmd.arg("ask");
        } else {
            match self.resolve_permission(req.permission.as_deref()) {
                "plan" => {
                    cmd.arg("--mode");
                    cmd.arg("plan");
                }
                _ => {
                    cmd.arg("--force");
                    cmd.arg("--approve-mcps");
                }
            }
        }
        // 【cursor模型】参数模型和 Fast/上下文分开传；CLI 只认基础 id，参数写入它自己的配置。
        self.configure_model(&mut cmd, req.model.as_deref(), &cursor_home())?;
        let mut seen = std::collections::HashSet::new();
        let workspace = req.workspace.to_string_lossy().to_string();
        if !workspace.is_empty() && seen.insert(workspace) {
            cmd.arg("--workspace");
            cmd.arg(req.workspace.as_os_str());
        }
        for dir in &req.additional_dirs {
            let dir = dir.trim();
            if !dir.is_empty() && seen.insert(dir.to_string()) {
                cmd.arg("--add-dir");
                cmd.arg(dir);
            }
        }
        let pasted_dir = super::images::pasted_images_dir();
        let uses_pasted = req
            .images
            .iter()
            .filter_map(|raw| super::images::absolutize_image_path(raw, &req.workspace))
            .any(|path| path.starts_with(&pasted_dir));
        if uses_pasted && seen.insert(pasted_dir.to_string_lossy().to_string()) {
            cmd.arg("--add-dir");
            cmd.arg(pasted_dir.as_os_str());
        }
        if let Some(session) = req.session_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            cmd.arg("--resume");
            cmd.arg(session);
        }
        // Prompt on stdin: cursor-agent.cmd runs under delayed expansion on
        // Windows, which would mangle `!` / `%` in argv.
        Ok(BuiltCommand {
            command: cmd,
            stdin_payload: Some(prompt_with_images(&req.prompt, &req.images, &req.workspace)),
            keep_stdin_open: false,
            cleanup_files: Vec::new(),
            mcp_restore: None,
            preassigned_session_id: None,
        })
    }

    fn build_command_with_host_chat(
        &self,
        req: &SendRequest,
        bin: &str,
        server: Option<&Value>,
    ) -> Result<BuiltCommand, String> {
        let Some(server) = server else {
            return self.build_command(req, bin);
        };
        if req.allowed_tools.is_some() {
            return Err("Tool-constrained Cursor runs cannot mount the host chat capability".into());
        }
        let root = stage_host_chat(&crate::paths::app_home().join(HOST_STAGING), server)?;
        let plugin_dir = root.join(HOST_PLUGIN);
        match self.build_command(req, bin) {
            Ok(mut built) => {
                built.command.arg("--plugin-dir");
                built.command.arg(plugin_dir.as_os_str());
                if self.resolve_permission(req.permission.as_deref()) == "plan" {
                    built.command.arg("--approve-mcps");
                }
                built.cleanup_files.push(root);
                Ok(built)
            }
            Err(error) => {
                super::cleanup_staged_files(&[root]);
                Err(error)
            }
        }
    }

    fn parse_line(&self, line: &str, out: &mut Vec<EngineEvent>) {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let kind = str_field(&value, "type").unwrap_or("");
        let subtype = str_field(&value, "subtype").unwrap_or("");
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        match kind {
            "system" if subtype == "init" => {
                if let Some(id) = str_field(&value, "session_id") {
                    out.push(EngineEvent::SessionId(id.to_string()));
                }
                if let Some(model) = state.launch_model.clone().or_else(|| {
                    str_field(&value, "model").and_then(reported_model_id)
                }) {
                    out.push(EngineEvent::Model(model));
                }
            }
            "thinking" if subtype == "delta" => {
                if let Some(text) = value.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                    out.push(EngineEvent::Thinking(text.to_string()));
                }
            }
            "assistant" => {
                let text = assistant_text(&value);
                if text.is_empty() {
                    return;
                }
                // With --stream-partial-output the CLI replays everything it
                // already streamed as one summary message: at the end of the
                // turn (no timestamp) and before each tool call (carries a
                // model_call_id). Streamed deltas have a timestamp and no
                // model_call_id. A retry/query flush is told apart by being
                // exactly the accumulated text of several deltas.
                let summary = value.get("timestamp_ms").is_none()
                    || value.get("model_call_id").is_some()
                    || (state.deltas > 1 && text == state.pending);
                if summary {
                    if state.deltas == 0 {
                        out.push(EngineEvent::Delta(text));
                    }
                    state.pending.clear();
                    state.deltas = 0;
                } else {
                    state.pending.push_str(&text);
                    state.deltas += 1;
                    out.push(EngineEvent::Delta(text));
                }
            }
            "tool_call" => {
                let Some((name, payload)) = value.get("tool_call").and_then(tool_parts) else {
                    return;
                };
                match subtype {
                    "started" => out.push(tool_call_message(name, payload.get("args"))),
                    "completed" => {
                        let result = payload.get("result");
                        let unwrapped = result.and_then(|r| r.get("success")).or(result);
                        out.push(tool_result_patch(name, unwrapped));
                    }
                    _ => {}
                }
            }
            "result" => {
                let session_id = str_field(&value, "session_id").map(str::to_string);
                // 【cursor上下文】计费合计仍原样上送；当前占用另从本机会话状态并入。
                let mut usage = value.get("usage").and_then(normalize_usage);
                if let Some(id) = session_id.as_deref() {
                    if let Some(context) = super::cursor_context::read_cursor_context_usage(id) {
                        usage = Some(super::cursor_context::merge_context_usage(usage, context));
                    }
                }
                if let Some(usage) = usage.clone() {
                    out.push(EngineEvent::Usage(usage));
                }
                let failed = value.get("is_error").and_then(Value::as_bool) == Some(true)
                    || (!subtype.is_empty() && subtype != "success");
                if failed {
                    let message = str_field(&value, "result")
                        .or_else(|| str_field(&value, "error"))
                        .unwrap_or("cursor-agent reported an error");
                    out.push(EngineEvent::Error(message.to_string()));
                } else {
                    out.push(EngineEvent::Done { session_id, usage });
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(permission: Option<&str>) -> SendRequest {
        SendRequest {
            claude_ultracode: None,
            host_instructions: None,
            session_id: None,
            workspace: PathBuf::from("/tmp/ws"),
            prompt: "hi 100% !".to_string(),
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

    fn args(built: &BuiltCommand) -> Vec<String> {
        built
            .command
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect()
    }

    fn feed(engine: &CursorEngine, lines: &[&str]) -> Vec<EngineEvent> {
        let mut out = Vec::new();
        for line in lines {
            engine.parse_line(line, &mut out);
        }
        out
    }

    fn deltas(events: &[EngineEvent]) -> String {
        events
            .iter()
            .filter_map(|e| match e {
                EngineEvent::Delta(t) => Some(t.as_str()),
                _ => None,
            })
            .collect()
    }

    fn init_model(engine: &CursorEngine, reported: &str) -> Option<String> {
        let events = feed(engine, &[&json!({
            "type": "system", "subtype": "init", "model": reported,
        }).to_string()]);
        events.into_iter().find_map(|event| match event {
            EngineEvent::Model(model) => Some(model),
            _ => None,
        })
    }

    #[test]
    fn init_preserves_encoded_launch_identity_and_parameters() {
        let home = std::env::temp_dir().join(format!("ccgui-cursor-identity-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&home).unwrap();
        let config = home.join("cli-config.json");
        std::fs::write(&config, "{}").unwrap();
        let engine = CursorEngine::new();
        let mut cmd = command_for_binary("cursor-agent");
        engine.configure_model(
            &mut cmd,
            Some("grok-4.7\u{1e}{\"context\":\"256k\",\"fast\":\"true\"}"),
            &home,
        ).unwrap();
        let saved: Value = serde_json::from_slice(&std::fs::read(&config).unwrap()).unwrap();
        std::fs::remove_dir_all(&home).unwrap();

        assert_eq!(init_model(&engine, "Grok 4.7 256K High Fast").as_deref(), Some("grok-4.7"));
        let args: Vec<_> = cmd.as_std().get_args().map(|arg| arg.to_string_lossy().to_string()).collect();
        assert!(args.windows(2).any(|args| args == ["--model", "grok-4.7"]));
        assert_eq!(saved["selectedModel"]["modelId"], "grok-4.7");
        assert_eq!(saved["selectedModel"]["parameters"], json!([
            {"id": "context", "value": "256k"}, {"id": "fast", "value": "true"},
        ]));
    }

    #[test]
    fn init_preserves_bare_launch_ids_and_auto_defaults() {
        for (model, flag) in [("composer-2", "composer-2"), ("auto", "auto"), ("default", "auto")] {
            let engine = CursorEngine::new();
            let mut request = req(None);
            request.model = Some(model.into());
            let built = engine.build_command(&request, "cursor-agent").unwrap();
            assert!(args(&built).windows(2).any(|args| args == ["--model", flag]));
            assert_eq!(init_model(&engine, "Some CLI display label").as_deref(), Some(model));
        }
    }

    #[test]
    fn init_without_launch_choice_accepts_only_usable_reported_ids() {
        let engine = CursorEngine::new();
        for (reported, expected) in [
            ("Auto", Some("auto")),
            ("composer-2", Some("composer-2")),
            ("Grok 4.7 256K High Fast", None),
            ("grok-4.7\u{1e}{}", None),
            ("", None),
        ] {
            assert_eq!(init_model(&engine, reported).as_deref(), expected);
        }
        let mut request = req(None);
        request.model = Some("composer-2".into());
        engine.build_command(&request, "cursor-agent").unwrap();
        engine.build_command(&req(None), "cursor-agent").unwrap();
        assert_eq!(init_model(&engine, "Auto").as_deref(), Some("auto"));
        assert_eq!(init_model(&engine, "Grok 4.7 256K High Fast"), None);
    }

    #[test]
    fn command_is_headless_with_stdin_prompt_and_permission_modes() {
        let engine = CursorEngine::new();
        let mut request = req(Some("auto"));
        request.session_id = Some("sess-1".into());
        request.model = Some("composer-2".into());
        let built = engine.build_command(&request, "cursor-agent").unwrap();
        let a = args(&built);
        assert!(a.contains(&"--stream-partial-output".to_string()));
        assert!(a.contains(&"--force".to_string()));
        assert!(a.windows(2).any(|w| w == ["--resume", "sess-1"]));
        assert!(a.windows(2).any(|w| w == ["--model", "composer-2"]));
        assert!(a.windows(2).any(|w| w == ["--workspace", "/tmp/ws"]));
        assert!(!a.iter().any(|x| x.contains("100%")), "prompt must not ride argv");
        assert_eq!(built.stdin_payload.as_deref(), Some("hi 100% !"));

        let plan = args(&engine.build_command(&req(Some("plan")), "cursor-agent").unwrap());
        assert!(plan.windows(2).any(|w| w == ["--mode", "plan"]));
        assert!(!plan.contains(&"--force".to_string()));
        // manual is unsupported and resolves to the first supported mode.
        let manual = args(&engine.build_command(&req(Some("manual")), "cursor-agent").unwrap());
        assert!(manual.contains(&"--force".to_string()));
    }

    #[test]
    fn partial_stream_is_not_duplicated_by_summary_messages() {
        let engine = CursorEngine::new();
        let events = feed(
            &engine,
            &[
                r#"{"type":"system","subtype":"init","session_id":"s1","model":"Auto"}"#,
                r#"{"type":"thinking","subtype":"delta","text":"hmm"}"#,
                r#"{"type":"thinking","subtype":"completed"}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"PO"}]},"timestamp_ms":1}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"NG"}]},"timestamp_ms":2}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"PONG"}]},"model_call_id":"m","timestamp_ms":3}"#,
                r#"{"type":"tool_call","subtype":"started","call_id":"c","tool_call":{"readToolCall":{"args":{"path":"a.txt"}}}}"#,
                r#"{"type":"tool_call","subtype":"completed","call_id":"c","tool_call":{"readToolCall":{"args":{"path":"a.txt"},"result":{"success":{"content":"x"}}}}}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]},"timestamp_ms":4}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}"#,
                r#"{"type":"result","subtype":"success","is_error":false,"session_id":"s1","usage":{"inputTokens":10,"outputTokens":2,"cacheReadTokens":3,"cacheWriteTokens":0}}"#,
            ],
        );
        assert_eq!(deltas(&events), "PONGok");
        assert!(events.iter().any(|e| matches!(e, EngineEvent::SessionId(id) if id == "s1")));
        assert!(events.iter().any(|e| matches!(e, EngineEvent::Thinking(t) if t == "hmm")));
        let tools: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                EngineEvent::Message { text, patch, .. } => Some((text.as_str(), *patch)),
                _ => None,
            })
            .collect();
        assert_eq!(tools, [("read", false), ("read", true)]);
        assert!(matches!(events.last(), Some(EngineEvent::Done { session_id: Some(id), usage: Some(u) })
            if id == "s1" && u["cache_read_input_tokens"] == 3));
    }

    #[test]
    fn unstreamed_summary_still_renders_and_errors_surface() {
        let engine = CursorEngine::new();
        let events = feed(
            &engine,
            &[r#"{"type":"assistant","message":{"content":[{"type":"text","text":"whole"}]}}"#],
        );
        assert_eq!(deltas(&events), "whole");
        let events = feed(
            &engine,
            &[r#"{"type":"result","subtype":"error","is_error":true,"result":"boom"}"#],
        );
        assert!(matches!(events.last(), Some(EngineEvent::Error(m)) if m == "boom"));
    }

    #[test]
    fn mcp_tool_uses_its_real_name() {
        let engine = CursorEngine::new();
        let events = feed(
            &engine,
            &[r#"{"type":"tool_call","subtype":"started","call_id":"c","tool_call":{"mcpToolCall":{"args":{"name":"ccgui-send","args":{}}}}}"#],
        );
        assert!(matches!(&events[0], EngineEvent::Message { text, .. } if text == "ccgui-send"));
    }
}
