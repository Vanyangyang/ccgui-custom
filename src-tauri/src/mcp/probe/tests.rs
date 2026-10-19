//! 探针单元测试：用假 MCP 服务验证 stdio / HTTP 两条握手指令链、跳过日志行、
//! 超时与错误路径，以及条目 → 探测目标的字段映射（不在测试里碰真实配置）。

use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;

/// 可执行的假 stdio 服务脚本（unix：/bin/sh 在 CI 与本地都有）。
#[cfg(unix)]
fn fake_stdio_script(tag: &str, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = std::env::temp_dir().join(format!(
        "ccgui-mcp-probe-{}-{tag}.sh",
        std::process::id()
    ));
    std::fs::write(&path, body).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path
}

#[cfg(unix)]
fn stdio_target(script: &PathBuf) -> ProbeTarget {
    ProbeTarget {
        command: Some("/bin/sh".to_string()),
        args: vec![script.to_string_lossy().into_owned()],
        ..ProbeTarget::default()
    }
}

#[test]
fn expand_env_resolves_variables_with_defaults() {
    std::env::set_var("CCGUI_PROBE_TEST_TOKEN", "secret");
    assert_eq!(expand_env("Bearer ${CCGUI_PROBE_TEST_TOKEN}"), "Bearer secret");
    assert_eq!(expand_env("${CCGUI_PROBE_MISSING:-fallback}"), "fallback");
    assert_eq!(expand_env("${CCGUI_PROBE_MISSING}"), "");
    assert_eq!(expand_env("plain text"), "plain text");
    std::env::remove_var("CCGUI_PROBE_TEST_TOKEN");
}

#[test]
fn target_kind_follows_declared_transport_then_fields() {
    let stdio = ProbeTarget {
        command: Some("npx".to_string()),
        ..ProbeTarget::default()
    };
    assert_eq!(stdio.kind(), "stdio");
    let remote = ProbeTarget {
        url: Some("https://x/mcp".to_string()),
        ..ProbeTarget::default()
    };
    assert_eq!(remote.kind(), "http");
    // opencode 的 local/remote 也是同一条归一化路径。
    let local = ProbeTarget {
        transport: Some("local".to_string()),
        command: Some("npx".to_string()),
        ..ProbeTarget::default()
    };
    assert_eq!(local.kind(), "stdio");
    assert_eq!(ProbeTarget::default().kind(), "unknown");
}

#[test]
fn payload_parses_plain_json_and_sse() {
    let json = r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"a"}]}}"#;
    assert!(response_payload(json, 2).is_some());
    let sse = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\n";
    assert!(response_payload(sse, 1).is_some());
    // 其他 id 的帧不算命中。
    assert!(response_payload(sse, 2).is_none());
    assert!(response_payload("not json", 1).is_none());
}

#[cfg(unix)]
#[tokio::test]
async fn stdio_probe_completes_the_handshake_and_reports_tools() {
    let script = fake_stdio_script(
        "ok",
        r#"#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"id":1'*) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"fake"}}}' ;;
    *'"id":2'*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"alpha"},{"name":"beta"}]}}' ;;
  esac
done
"#,
    );
    let result = probe_stdio_within(&stdio_target(&script), Duration::from_secs(10)).await;
    assert_eq!(result.status, "connected", "{:?}", result.message);
    assert_eq!(result.server_name.as_deref(), Some("fake"));
    assert_eq!(result.protocol_version.as_deref(), Some("2025-06-18"));
    assert_eq!(result.tools, vec!["alpha", "beta"]);
    let _ = std::fs::remove_file(script);
}

#[cfg(unix)]
#[tokio::test]
async fn stdio_probe_skips_log_lines_before_the_json() {
    let script = fake_stdio_script(
        "logs",
        r#"#!/bin/sh
echo "starting up"
while IFS= read -r line; do
  case "$line" in
    *'"id":1'*) printf '%s\n' 'not json yet'; printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"noisy"}}}' ;;
    *'"id":2'*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}' ;;
  esac
done
"#,
    );
    let result = probe_stdio_within(&stdio_target(&script), Duration::from_secs(10)).await;
    assert_eq!(result.status, "connected", "{:?}", result.message);
    assert_eq!(result.server_name.as_deref(), Some("noisy"));
    assert!(result.tools.is_empty());
    let _ = std::fs::remove_file(script);
}

#[cfg(unix)]
#[tokio::test]
async fn stdio_probe_reports_exit_before_handshake_and_timeout() {
    let exited = fake_stdio_script("exit", "#!/bin/sh\nexit 0\n");
    let result = probe_stdio_within(&stdio_target(&exited), Duration::from_secs(5)).await;
    assert_eq!(result.status, "failed");
    assert!(
        result.message.as_deref().unwrap().contains("结束"),
        "{:?}",
        result.message
    );
    let _ = std::fs::remove_file(exited);

    let hanging = fake_stdio_script("hang", "#!/bin/sh\nsleep 30\n");
    let result = probe_stdio_within(&stdio_target(&hanging), Duration::from_secs(1)).await;
    assert_eq!(result.status, "failed");
    assert!(
        result.message.as_deref().unwrap().contains("超时"),
        "{:?}",
        result.message
    );
    let _ = std::fs::remove_file(hanging);
}

/// 按请求内容回应的假 HTTP MCP 服务（initialize / tools/login 各一份）。
fn spawn_fake_http(initialize: String, tools: String, unauthorized: bool) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 2048];
            loop {
                let read = match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => read,
                };
                buffer.extend_from_slice(&chunk[..read]);
                let text = String::from_utf8_lossy(&buffer);
                if let Some(head_end) = text.find("\r\n\r\n") {
                    let length = text
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if buffer.len() >= head_end + 4 + length {
                        break;
                    }
                }
            }
            let request = String::from_utf8_lossy(&buffer).to_string();
            let (status, body) = if unauthorized {
                (
                    "401 Unauthorized",
                    "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32001,\"message\":\"auth required\"}}"
                        .to_string(),
                )
            } else if request.contains("\"method\":\"initialize\"") {
                ("200 OK", initialize.clone())
            } else if request.contains("\"method\":\"tools/list\"") {
                ("200 OK", tools.clone())
            } else {
                ("202 Accepted", String::new())
            };
            let extra = if unauthorized {
                "WWW-Authenticate: Bearer\r\n".to_string()
            } else {
                "mcp-session-id: fake-session\r\n".to_string()
            };
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
    });
    format!("http://{addr}/mcp")
}

#[tokio::test]
async fn http_probe_parses_json_and_sse_responses() {
    let url = spawn_fake_http(
        r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"remote"}}}"#
            .to_string(),
        "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{\"name\":\"search\"}]}}\n\n"
            .to_string(),
        false,
    );
    let target = ProbeTarget {
        url: Some(url),
        ..ProbeTarget::default()
    };
    let result = probe_http(&target).await;
    assert_eq!(result.status, "connected", "{:?}", result.message);
    assert_eq!(result.server_name.as_deref(), Some("remote"));
    assert_eq!(result.tools, vec!["search"]);
}

#[tokio::test]
async fn http_probe_maps_auth_and_unreachable_to_distinct_states() {
    let unauthorized = spawn_fake_http(String::new(), String::new(), true);
    let target = ProbeTarget {
        url: Some(unauthorized),
        ..ProbeTarget::default()
    };
    let result = probe_http(&target).await;
    assert_eq!(result.status, "needs_auth");
    assert!(result.message.unwrap().contains("认证"));

    // 未监听的端口：连接失败，不是「未配置」。
    let target = ProbeTarget {
        url: Some("http://127.0.0.1:9/mcp".to_string()),
        ..ProbeTarget::default()
    };
    let result = probe_http(&target).await;
    let message = result.message.unwrap_or_default();
    assert_eq!(result.status, "failed");
    assert!(message.contains("无法连接"), "message={message}");
}

#[test]
fn declarative_targets_map_engine_specific_fields() {
    let scratch = std::env::temp_dir().join(format!("ccgui-mcp-probe-map-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&scratch);
    std::fs::create_dir_all(&scratch).unwrap();

    // opencode：`command` 是数组，环境变量叫 environment。
    let opencode = scratch.join("opencode.json");
    std::fs::write(
        &opencode,
        r#"{"mcp":{"local":{"type":"local","command":["npx","-y","pkg"],"environment":{"TOKEN":"${CCGUI_PROBE_MAP_TOKEN:-x}"}}}}"#,
    )
    .unwrap();
    let json = std::fs::read_to_string(&opencode).unwrap();
    let root: Value = serde_json::from_str(&json).unwrap();
    let object = root["mcp"]["local"].as_object().unwrap();
    let target = super::super::sources::probe_target_from_json(
        object,
        true,
        super::super::sources::OPENCODE_FIELDS,
    );
    assert_eq!(target.command.as_deref(), Some("npx"));
    assert_eq!(target.args, vec!["-y", "pkg"]);
    assert_eq!(target.env, vec![("TOKEN".to_string(), "${CCGUI_PROBE_MAP_TOKEN:-x}".to_string())]);
    assert_eq!(target.kind(), "stdio");

    // agy：远程地址在 serverUrl。
    let agy = scratch.join("mcp_config.json");
    std::fs::write(
        &agy,
        r#"{"mcpServers":{"remote":{"serverUrl":"https://x/mcp","headers":{"Authorization":"Bearer ${CCGUI_PROBE_MAP_TOKEN:-x}"}}}}"#,
    )
    .unwrap();
    let json = std::fs::read_to_string(&agy).unwrap();
    let root: Value = serde_json::from_str(&json).unwrap();
    let object = root["mcpServers"]["remote"].as_object().unwrap();
    let target = super::super::sources::probe_target_from_json(
        object,
        false,
        super::super::sources::AGY_FIELDS,
    );
    assert_eq!(target.url.as_deref(), Some("https://x/mcp"));
    assert_eq!(target.kind(), "http");
    assert_eq!(
        target.headers,
        vec![("Authorization".to_string(), "Bearer ${CCGUI_PROBE_MAP_TOKEN:-x}".to_string())]
    );

    let _ = std::fs::remove_dir_all(&scratch);
}
