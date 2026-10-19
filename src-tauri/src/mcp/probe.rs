//! MCP 连接检测：按配置真的连一次，做 `initialize` + `tools/list` 握手。
//!
//! 这是显式动作（UI 上的「检测」/「检测全部」）：stdio 服务会被拉起来，
//! `npx` 可能顺带下载包，所以不在打开页面时自动执行。结果只说明「本应用
//! 此刻能连上并握手成功」，与某个 CLI 会话里报告的连接状态分开表达。
//!
//! 安全边界：目标命令、参数、环境变量与请求头一律从配置文件重新解析
//! （`probe_target`），不接受前端传入的命令；返回值只带工具名与错误摘要，
//! 不带任何凭据。

use super::McpError;
use serde::Serialize;
use serde_json::{json, Value};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, BufReader};

/// stdio 冷启动（npx 首次下载）比 HTTP 慢得多。
const STDIO_TIMEOUT: Duration = Duration::from_secs(25);
const HTTP_TIMEOUT: Duration = Duration::from_secs(12);
/// 单行协议消息上限：服务把日志或大对象写到 stdout 时不至于撑爆内存。
const MAX_LINE: usize = 1 << 20;
/// tools/list 返回的条目上限。
const MAX_TOOLS: usize = 40;
const CLIENT_NAME: &str = "ccgui";
const PROTOCOL_VERSION: &str = "2025-06-18";

/// 从配置解析出的连接目标（未脱敏，只在后端使用）。
#[derive(Debug, Clone, Default)]
pub(crate) struct ProbeTarget {
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: Option<String>,
    pub url: Option<String>,
    pub headers: Vec<(String, String)>,
    /// 配置里的传输类型原样（stdio / http / sse / local / remote / …）。
    pub transport: Option<String>,
}

impl ProbeTarget {
    /// 归一化成探测方式：stdio / http / unknown。
    pub(crate) fn kind(&self) -> &'static str {
        match self.transport.as_deref().map(str::trim) {
            Some("stdio") | Some("local") => "stdio",
            Some("http") | Some("streamable-http") | Some("sse") | Some("remote") => "http",
            _ if self.command.is_some() => "stdio",
            _ if self.url.is_some() => "http",
            _ => "unknown",
        }
    }
}

/// 前端提交的检测请求；条目标识由后端解析成配置里的真实命令。
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpProbeRequest {
    pub entry_id: String,
    #[serde(default)]
    pub workspace: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpProbeResult {
    /// connected | needs_auth | failed | unsupported
    pub status: String,
    pub message: Option<String>,
    pub tools: Vec<String>,
    pub server_name: Option<String>,
    pub protocol_version: Option<String>,
    pub elapsed_ms: u64,
}

impl McpProbeResult {
    fn failed(message: impl Into<String>) -> Self {
        Self {
            status: "failed".to_string(),
            message: Some(message.into()),
            ..Self::default()
        }
    }
    fn connected() -> Self {
        Self {
            status: "connected".to_string(),
            ..Self::default()
        }
    }
}

impl Default for McpProbeResult {
    fn default() -> Self {
        Self {
            status: "failed".to_string(),
            message: None,
            tools: Vec::new(),
            server_name: None,
            protocol_version: None,
            elapsed_ms: 0,
        }
    }
}

/// 检测一台 MCP 服务：显式动作，不缓存结果（UI 自己保存展示状态）。
#[tauri::command]
pub(crate) async fn mcp_probe(
    db: tauri::State<'_, std::sync::Arc<crate::db::Db>>,
    request: McpProbeRequest,
) -> Result<McpProbeResult, McpError> {
    let workspace = super::validate_workspace(request.workspace.as_deref(), &db)?;
    let target = super::probe_target(&request.entry_id, workspace.as_deref())?;
    Ok(run_probe(&target).await)
}

async fn run_probe(target: &ProbeTarget) -> McpProbeResult {
    let started = Instant::now();
    let mut result = match target.kind() {
        "stdio" => probe_stdio(target).await,
        "http" => probe_http(target).await,
        _ => McpProbeResult::failed("配置里既没有命令也没有地址，无法连接"),
    };
    result.elapsed_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
    result
}

// ===== stdio =====

async fn probe_stdio(target: &ProbeTarget) -> McpProbeResult {
    probe_stdio_within(target, STDIO_TIMEOUT).await
}

async fn probe_stdio_within(target: &ProbeTarget, timeout: Duration) -> McpProbeResult {
    let Some(command) = target.command.as_deref() else {
        return McpProbeResult::failed("配置里没有可执行的命令");
    };
    let mut cmd = tokio::process::Command::new(command);
    cmd.args(&target.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some(cwd) = target.cwd.as_deref() {
        cmd.current_dir(cwd);
    }
    for (key, value) in &target.env {
        cmd.env(key, expand_env(value));
    }
    // 自己的进程组：npx / uvx 还会再拉子进程，收尾时要整组杀掉。
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => return McpProbeResult::failed(format!("启动失败：{error}")),
    };
    let pid = child.id().unwrap_or(0);
    let (Some(mut stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        finish_process(pid, &mut child).await;
        return McpProbeResult::failed("无法建立 stdio 通道");
    };
    let handshake = tokio::time::timeout(timeout, stdio_handshake(&mut stdin, stdout)).await;
    drop(stdin);
    finish_process(pid, &mut child).await;
    match handshake {
        Ok(Ok(result)) => result,
        Ok(Err(message)) => McpProbeResult::failed(message),
        Err(_) => McpProbeResult::failed(format!(
            "连接超时（{}s 内没完成握手）",
            timeout.as_secs()
        )),
    }
}

/// 收尾：先杀整个进程组（孙进程持有管道），再回收直接子进程。
async fn finish_process(pid: u32, child: &mut tokio::process::Child) {
    if pid != 0 {
        crate::engine::kill_process_group(pid);
    }
    let _ = child.start_kill();
    let _ = child.wait().await;
}

async fn stdio_handshake(
    stdin: &mut tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
) -> Result<McpProbeResult, String> {
    let mut reader = LineReader::new(stdout);
    write_message(stdin, &initialize_request()).await?;
    let initialized = read_result(&mut reader, 1).await?;
    write_message(stdin, &notification("notifications/initialized")).await?;
    write_message(
        stdin,
        &json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}),
    )
    .await?;
    let tools = read_result(&mut reader, 2).await?;
    Ok(assemble(initialized, tools))
}

async fn write_message(
    stdin: &mut tokio::process::ChildStdin,
    message: &Value,
) -> Result<(), String> {
    let mut text = serde_json::to_string(message).map_err(|error| error.to_string())?;
    text.push('\n');
    use tokio::io::AsyncWriteExt;
    stdin
        .write_all(text.as_bytes())
        .await
        .map_err(|error| format!("写入服务失败：{error}"))?;
    stdin
        .flush()
        .await
        .map_err(|error| format!("写入服务失败：{error}"))
}

/// 逐行读子进程 stdout。一次 read 可能带回多行（日志 + 响应挤在同一个
/// chunk）：剩余字节留在缓冲区，不能随行丢弃。
struct LineReader<R> {
    inner: BufReader<R>,
    buffer: Vec<u8>,
    /// 当前行超长：丢弃到下一个换行。
    dropping: bool,
}

impl<R: tokio::io::AsyncRead + Unpin> LineReader<R> {
    fn new(inner: R) -> Self {
        Self {
            inner: BufReader::new(inner),
            buffer: Vec::new(),
            dropping: false,
        }
    }

    /// 读下一行到 `out`；返回消费的字节数，0 表示 EOF。
    async fn next_line(&mut self, out: &mut Vec<u8>) -> std::io::Result<usize> {
        loop {
            if let Some(index) = self.buffer.iter().position(|byte| *byte == b'\n') {
                if self.dropping {
                    self.buffer.drain(..=index);
                    self.dropping = false;
                    return Ok(1);
                }
                out.extend_from_slice(&self.buffer[..index]);
                let consumed = index + 1;
                self.buffer.drain(..consumed);
                return Ok(consumed);
            }
            if self.dropping {
                self.buffer.clear();
            } else if self.buffer.len() > MAX_LINE {
                self.dropping = true;
                self.buffer.clear();
            }
            let mut chunk = [0u8; 8192];
            let read = self.inner.read(&mut chunk).await?;
            if read == 0 {
                if self.buffer.is_empty() {
                    return Ok(0);
                }
                out.extend_from_slice(&self.buffer);
                let total = self.buffer.len();
                self.buffer.clear();
                return Ok(total);
            }
            self.buffer.extend_from_slice(&chunk[..read]);
        }
    }
}

/// 读到 id 匹配的 JSON-RPC 响应；跳过服务打在 stdout 的日志/横幅与
/// 无关通知。
async fn read_result(
    reader: &mut LineReader<tokio::process::ChildStdout>,
    id: i64,
) -> Result<Value, String> {
    let mut line = Vec::new();
    for _ in 0..200 {
        line.clear();
        let read = reader
            .next_line(&mut line)
            .await
            .map_err(|error| format!("读取服务输出失败：{error}"))?;
        if read == 0 {
            return Err("服务在握手完成前结束了".to_string());
        }
        let Ok(text) = std::str::from_utf8(&line) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(text.trim()) else {
            continue;
        };
        if value.get("id").and_then(Value::as_i64) != Some(id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            return Err(rpc_error_message(error));
        }
        return Ok(value.get("result").cloned().unwrap_or(Value::Null));
    }
    Err("服务没有返回可识别的响应".to_string())
}

// ===== HTTP / SSE =====

async fn probe_http(target: &ProbeTarget) -> McpProbeResult {
    let Some(url) = target.url.as_deref().map(expand_env) else {
        return McpProbeResult::failed("配置里没有服务器地址");
    };
    let mut builder = reqwest::Client::builder().timeout(HTTP_TIMEOUT);
    if is_loopback_url(&url) {
        // 本机服务（Figma、IDE 内置 MCP 等）必须直连：环境里的 HTTP_PROXY
        // 会把 127.0.0.1 请求转到代理，得到 502 这种与真实状态无关的结果。
        builder = builder.no_proxy();
    }
    let client = match builder.build() {
        Ok(client) => client,
        Err(error) => return McpProbeResult::failed(format!("HTTP 客户端不可用：{error}")),
    };
    let send = |session: Option<String>, body: Value| {
        let mut request = client
            .post(&url)
            .header(
                reqwest::header::ACCEPT,
                "application/json, text/event-stream",
            )
            .json(&body);
        for (key, value) in &target.headers {
            request = request.header(key, expand_env(value));
        }
        if let Some(session) = session {
            request = request.header("mcp-session-id", session);
        }
        request.send()
    };

    let response = match send(None, initialize_request()).await {
        Ok(response) => response,
        Err(error) => return McpProbeResult::failed(format!("无法连接：{}", error_message(&error))),
    };
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return McpProbeResult {
            status: "needs_auth".to_string(),
            message: Some(format!("服务要求认证（HTTP {}）", status.as_u16())),
            ..McpProbeResult::default()
        };
    }
    if !status.is_success() {
        return McpProbeResult::failed(format!("HTTP {}", status.as_u16()));
    }
    let session = response
        .headers()
        .get("mcp-session-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let body = match response.text().await {
        Ok(body) => body,
        Err(error) => return McpProbeResult::failed(format!("读取响应失败：{error}")),
    };
    let initialized = match response_payload(&body, 1) {
        Some(value) => match payload_result(&value) {
            Ok(result) => result,
            Err(message) => return McpProbeResult::failed(message),
        },
        None => return McpProbeResult::failed("服务没有返回可识别的 initialize 响应"),
    };
    let _ = send(
        session.clone(),
        notification("notifications/initialized"),
    )
    .await;
    let tools = match send(
        session,
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}),
    )
    .await
    {
        Ok(response) if response.status().is_success() => match response.text().await {
            Ok(body) => response_payload(&body, 2)
                .map(|value| payload_result(&value).unwrap_or(Value::Null))
                .unwrap_or(Value::Null),
            Err(error) => return McpProbeResult::failed(format!("读取响应失败：{error}")),
        },
        Ok(response) => {
            let code = response.status();
            if code == reqwest::StatusCode::UNAUTHORIZED || code == reqwest::StatusCode::FORBIDDEN
            {
                return McpProbeResult {
                    status: "needs_auth".to_string(),
                    message: Some(format!("服务要求认证（HTTP {}）", code.as_u16())),
                    ..McpProbeResult::default()
                };
            }
            return McpProbeResult::failed(format!("tools/list 返回 HTTP {}", code.as_u16()));
        }
        Err(error) => {
            return McpProbeResult::failed(format!("tools/list 失败：{}", error_message(&error)))
        }
    };
    if initialized.get("error").is_some() {
        return McpProbeResult::failed(rpc_error_message(&initialized["error"]));
    }
    assemble(initialized, tools)
}

/// 取出 JSON-RPC 响应里的 `result`；带 `error` 的一律报错。
fn payload_result(value: &Value) -> Result<Value, String> {
    if let Some(error) = value.get("error") {
        return Err(rpc_error_message(error));
    }
    Ok(value.get("result").cloned().unwrap_or(Value::Null))
}

fn is_loopback_url(raw: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(raw) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return true;
    }
    host.parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

/// 响应体可能是 JSON，也可能是 SSE（`data: {...}`）；取 id 匹配的那条。
fn response_payload(body: &str, id: i64) -> Option<Value> {
    let trimmed = body.trim();
    if trimmed.starts_with('{') {
        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            if value.get("id").and_then(Value::as_i64) == Some(id) {
                return Some(value);
            }
        }
    }
    for line in body.lines() {
        let line = line.trim();
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(data.trim()) else {
            continue;
        };
        if value.get("id").and_then(Value::as_i64) == Some(id) {
            return Some(value);
        }
    }
    None
}

// ===== 公共部分 =====

fn initialize_request() -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": { "name": CLIENT_NAME, "version": env!("CARGO_PKG_VERSION") },
        },
    })
}

fn notification(method: &str) -> Value {
    json!({ "jsonrpc": "2.0", "method": method })
}

fn assemble(initialized: Value, tools: Value) -> McpProbeResult {
    let mut result = McpProbeResult::connected();
    result.protocol_version = initialized
        .get("protocolVersion")
        .and_then(Value::as_str)
        .map(str::to_string);
    result.server_name = initialized
        .get("serverInfo")
        .and_then(|info| info.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string);
    result.tools = tools
        .get("tools")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("name").and_then(Value::as_str))
                .take(MAX_TOOLS)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    result
}

fn rpc_error_message(error: &Value) -> String {
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("服务返回了错误");
    match error.get("code").and_then(Value::as_i64) {
        Some(code) => format!("{message}（code {code}）"),
        None => message.to_string(),
    }
}

fn error_message(error: &reqwest::Error) -> String {
    let detail = error.to_string();
    if error.is_timeout() {
        return "连接超时".to_string();
    }
    // reqwest 把 TCP 连接错误包在 Request kind 里，`is_connect()` 不一定为真。
    if error.is_connect() || detail.contains("connect") {
        return "无法建立连接（服务未启动或地址不可达）".to_string();
    }
    detail
}

/// 配置里的 `${VAR}` / `${VAR:-default}` 展开（与 CLI 一致）；未定义的变量
/// 展开成空串，不把字面量发出去。
pub(crate) fn expand_env(value: &str) -> String {
    if !value.contains("${") {
        return value.to_string();
    }
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let Some(end) = rest[start..].find('}') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let token = &rest[start + 2..start + end];
        let (name, default) = match token.split_once(":-") {
            Some((name, default)) => (name, Some(default)),
            None => (token, None),
        };
        match std::env::var(name) {
            Ok(resolved) if !resolved.is_empty() => out.push_str(&resolved),
            _ => out.push_str(default.unwrap_or("")),
        }
        rest = &rest[start + end + 1..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests;
