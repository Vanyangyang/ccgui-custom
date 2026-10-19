//! Explicit HTTP CONNECT transport for the remote relay only. Errors deliberately
//! omit URLs, library error payloads and proxy response text: any can hold keys.

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::handshake::client::{Request, Response};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

const MAX_CONNECT_HEADER_BYTES: usize = 16 * 1024;

struct ProxyEndpoint {
    host: String,
    port: u16,
}

fn proxy_endpoint(enabled: bool, value: Option<&str>) -> Result<ProxyEndpoint, String> {
    if !enabled {
        return Err("外网中继需要启用网络代理；不会尝试直连".to_string());
    }
    let raw = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "外网中继的网络代理地址未配置".to_string())?;
    if raw
        .bytes()
        .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace() || byte == b'\\')
    {
        return Err("网络代理地址无效".to_string());
    }
    let url = reqwest::Url::parse(raw).map_err(|_| "网络代理地址无效".to_string())?;
    if url.scheme() != "http" {
        return Err("外网中继目前仅支持 http:// 网络代理".to_string());
    }
    // Inspect the original authority/tail too: URL normalization can hide an
    // empty userinfo (`@`) or reduce an unsupported path such as `/x/..` to `/`.
    let authority_and_tail = raw
        .split_once("://")
        .map(|(_, rest)| rest)
        .ok_or_else(|| "网络代理地址无效".to_string())?;
    let tail_offset = authority_and_tail
        .find(['/', '?', '#'])
        .unwrap_or(authority_and_tail.len());
    let authority = &authority_and_tail[..tail_offset];
    let tail = &authority_and_tail[tail_offset..];
    if authority.contains('@') || !url.username().is_empty() || url.password().is_some() {
        return Err("外网中继不支持包含用户凭据的网络代理地址".to_string());
    }
    if !matches!(tail, "" | "/") || url.query().is_some() || url.fragment().is_some() {
        return Err("网络代理地址不能包含路径、查询参数或片段".to_string());
    }
    let host = url
        .host_str()
        .filter(|host| !host.is_empty())
        .ok_or_else(|| "网络代理地址缺少主机".to_string())?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_string();
    let port = url
        .port_or_known_default()
        .filter(|port| *port != 0)
        .ok_or_else(|| "网络代理端口无效".to_string())?;
    Ok(ProxyEndpoint { host, port })
}

fn target_authority(request: &Request) -> Result<String, String> {
    let uri = request.uri();
    let default_port = match uri.scheme_str() {
        Some("ws") => 80,
        Some("wss") => 443,
        _ => return Err("中继地址必须使用 ws:// 或 wss://".to_string()),
    };
    let authority = uri
        .authority()
        .ok_or_else(|| "中继地址缺少主机".to_string())?;
    if authority.as_str().contains('@') {
        return Err("中继地址不支持用户凭据".to_string());
    }
    let host = authority.host();
    if host.is_empty() {
        return Err("中继地址缺少主机".to_string());
    }
    let port = match &authority.as_str()[host.len()..] {
        "" => default_port,
        suffix => suffix
            .strip_prefix(':')
            .and_then(|port| port.parse::<u16>().ok())
            .filter(|port| *port != 0)
            .ok_or_else(|| "中继端口无效".to_string())?,
    };
    // http::Uri retains IPv6 brackets. Only this authority goes to CONNECT;
    // the full request (including authentication) is sent inside the tunnel.
    Ok(format!("{host}:{port}"))
}

fn connect_status(header: &[u8]) -> Result<u16, String> {
    let invalid = || "网络代理 CONNECT 响应格式无效".to_string();
    if !header.ends_with(b"\r\n\r\n") {
        return Err(invalid());
    }
    let mut lines = header[..header.len() - 2].split(|byte| *byte == b'\n');
    // Discard only the final empty line; every actual line must end in CRLF.
    lines.next_back();
    let status_line = lines.next().ok_or_else(invalid)?;
    let status_line = status_line.strip_suffix(b"\r").ok_or_else(invalid)?;
    let mut parts = status_line.splitn(3, |byte| *byte == b' ');
    if !matches!(parts.next(), Some(b"HTTP/1.1" | b"HTTP/1.0")) {
        return Err(invalid());
    }
    let code = parts.next().ok_or_else(invalid)?;
    let reason = parts.next().ok_or_else(invalid)?;
    let valid_value = |bytes: &[u8]| {
        bytes
            .iter()
            .all(|byte| *byte == b'\t' || (*byte >= b' ' && *byte != 0x7f))
    };
    if code.len() != 3 || !code.iter().all(u8::is_ascii_digit) || !valid_value(reason) {
        return Err(invalid());
    }
    let status = u16::from(code[0] - b'0') * 100
        + u16::from(code[1] - b'0') * 10
        + u16::from(code[2] - b'0');
    if !(100..=599).contains(&status) {
        return Err(invalid());
    }
    for line in lines {
        let line = line.strip_suffix(b"\r").ok_or_else(invalid)?;
        let colon = line
            .iter()
            .position(|byte| *byte == b':')
            .ok_or_else(invalid)?;
        let name = &line[..colon];
        if name.is_empty()
            || !name
                .iter()
                .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(byte))
            || !valid_value(&line[colon + 1..])
        {
            return Err(invalid());
        }
    }
    Ok(status)
}

async fn open_tunnel(proxy: ProxyEndpoint, authority: &str) -> Result<TcpStream, String> {
    // This is the only TCP dial. Resolving a proxy hostname is permitted;
    // resolving the relay hostname here would defeat CONNECT's DNS routing.
    let mut stream = TcpStream::connect((proxy.host.as_str(), proxy.port))
        .await
        .map_err(|_| "无法连接网络代理".to_string())?;
    let connect = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n");
    stream
        .write_all(connect.as_bytes())
        .await
        .map_err(|_| "发送网络代理 CONNECT 请求失败".to_string())?;
    let mut header = Vec::with_capacity(256);
    loop {
        if header.len() == MAX_CONNECT_HEADER_BYTES {
            return Err("网络代理 CONNECT 响应头过大".to_string());
        }
        // Consume exactly the header, even if the proxy coalesces it with the
        // first tunnel bytes. No buffered data is lost before TLS/WS starts.
        let byte = stream
            .read_u8()
            .await
            .map_err(|_| "读取网络代理 CONNECT 响应失败或响应不完整".to_string())?;
        header.push(byte);
        if header.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let status = connect_status(&header)?;
    if !(200..300).contains(&status) {
        return Err(format!("网络代理拒绝 CONNECT 隧道（HTTP {status}）"));
    }
    Ok(stream)
}

pub(super) async fn connect(
    request: Request,
    proxy_enabled: bool,
    proxy_url: Option<&str>,
) -> Result<(WebSocketStream<MaybeTlsStream<TcpStream>>, Response), String> {
    let proxy = proxy_endpoint(proxy_enabled, proxy_url)?;
    let authority = target_authority(&request)?;
    let stream = open_tunnel(proxy, &authority).await?;
    // Keep the original URI for SNI, certificate verification and the WS
    // request. The library's default rustls connector uses webpki roots.
    tokio_tungstenite::client_async_tls(request, stream)
        .await
        .map_err(|_| "CONNECT 隧道已建立，但中继 TLS/WebSocket 握手失败".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use std::time::Duration;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::Message;

    const FAKE_SECRET: &str = "relay-test-secret-never-real";
    const TEST_TIMEOUT: Duration = Duration::from_secs(3);

    fn request(url: &str) -> Request {
        url.into_client_request().unwrap()
    }

    async fn listener() -> TcpListener {
        TcpListener::bind("127.0.0.1:0").await.unwrap()
    }

    // Fixture reads independently of the production response parser and
    // bounds its input so a broken client cannot hang the test indefinitely.
    async fn read_request(stream: &mut TcpStream) -> String {
        let mut bytes = Vec::new();
        for _ in 0..4096 {
            let mut byte = [0];
            stream.read_exact(&mut byte).await.unwrap();
            bytes.push(byte[0]);
            if bytes.ends_with(b"\r\n\r\n") {
                return String::from_utf8(bytes).unwrap();
            }
        }
        panic!("fixture received an oversized request");
    }

    async fn assert_no_direct_connection(target: &TcpListener) {
        assert!(
            tokio::time::timeout(Duration::from_millis(100), target.accept())
                .await
                .is_err(),
            "relay unexpectedly dialed the target directly"
        );
    }

    fn assert_safe_error(error: &str) {
        assert!(!error.contains(FAKE_SECRET));
        assert!(!error.contains("/agent"));
        assert!(!error.contains("127.0.0.1"));
    }

    #[test]
    fn authority_uses_ws_defaults_explicit_ports_and_ipv6_brackets() {
        for (url, expected) in [
            ("ws://relay.invalid/agent?key=ignored", "relay.invalid:80"),
            ("wss://relay.invalid/agent", "relay.invalid:443"),
            ("wss://relay.invalid:8443/agent", "relay.invalid:8443"),
            ("ws://[::1]/agent", "[::1]:80"),
            ("wss://[::1]:8443/agent", "[::1]:8443"),
        ] {
            assert_eq!(target_authority(&request(url)).unwrap(), expected);
        }
        for url in [
            "https://relay.invalid/agent",
            "ws://relay.invalid:0/agent",
            "ws://relay.invalid:99999/agent",
            "ws://user@relay.invalid/agent",
        ] {
            // A Request builder lets the transport validate addresses that
            // IntoClientRequest might reject before reaching the transport.
            let req = Request::builder().uri(url).body(()).unwrap();
            assert!(target_authority(&req).is_err());
        }
    }

    #[test]
    fn proxy_validation_accepts_only_plain_http_authorities() {
        for url in [
            "http://localhost",
            " http://127.0.0.1:7897/ ",
            "http://[::1]:7897",
        ] {
            assert!(proxy_endpoint(true, Some(url)).is_ok());
        }
        let ipv6 = proxy_endpoint(true, Some("http://[::1]:7897")).unwrap();
        assert_eq!(ipv6.host, "::1");
        assert_eq!(ipv6.port, 7897);
        assert_eq!(
            proxy_endpoint(true, Some("http://localhost")).unwrap().port,
            80
        );
    }

    #[tokio::test]
    async fn connect_tunnels_unresolvable_target_and_preserves_ws_authentication() {
        tokio::time::timeout(TEST_TIMEOUT, async {
            let proxy = listener().await;
            let proxy_url = format!("http://{}", proxy.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut stream, _) = proxy.accept().await.unwrap();
                let connect = read_request(&mut stream).await;
                assert_eq!(connect, "CONNECT relay-does-not-resolve.invalid:80 HTTP/1.1\r\nHost: relay-does-not-resolve.invalid:80\r\n\r\n");
                assert!(!connect.contains(FAKE_SECRET));
                assert!(!connect.contains("/agent"));
                stream.write_all(b"HTTP/1.1 200 Connection established\r\nX-Proxy: mock\r\n\r\n").await.unwrap();
                let mut socket = tokio_tungstenite::accept_hdr_async(
                    stream,
                    |req: &Request, response: tokio_tungstenite::tungstenite::handshake::server::Response| {
                        assert_eq!(req.uri().path_and_query().unwrap().as_str(), format!("/agent?key={FAKE_SECRET}"));
                        assert_eq!(req.headers()["authorization"].to_str().unwrap(), format!("Bearer {FAKE_SECRET}"));
                        Ok(response)
                    },
                ).await.unwrap();
                let message = socket.next().await.unwrap().unwrap();
                assert_eq!(message, Message::Text("through-proxy".into()));
                socket.send(message).await.unwrap();
            });
            let mut req = request(&format!("ws://relay-does-not-resolve.invalid/agent?key={FAKE_SECRET}"));
            req.headers_mut().insert("authorization", format!("Bearer {FAKE_SECRET}").parse().unwrap());
            let (mut socket, _) = connect(req, true, Some(&proxy_url)).await.unwrap();
            socket.send(Message::Text("through-proxy".into())).await.unwrap();
            assert_eq!(socket.next().await.unwrap().unwrap(), Message::Text("through-proxy".into()));
            server.await.unwrap();
        }).await.expect("mock CONNECT + WS timed out");
    }

    #[tokio::test]
    async fn connect_header_does_not_consume_coalesced_tunnel_bytes() {
        tokio::time::timeout(TEST_TIMEOUT, async {
            let proxy = listener().await;
            let proxy_url = format!("http://{}", proxy.local_addr().unwrap());
            let server = tokio::spawn(async move {
                let (mut stream, _) = proxy.accept().await.unwrap();
                read_request(&mut stream).await;
                stream
                    .write_all(b"HTTP/1.0 299 Tunnel ready\r\n\r\ntunnel-bytes")
                    .await
                    .unwrap();
            });
            let mut tunnel = open_tunnel(
                proxy_endpoint(true, Some(&proxy_url)).unwrap(),
                "relay.invalid:443",
            )
            .await
            .unwrap();
            let mut bytes = [0; 12];
            tunnel.read_exact(&mut bytes).await.unwrap();
            assert_eq!(&bytes, b"tunnel-bytes");
            server.await.unwrap();
        })
        .await
        .expect("coalesced tunnel test timed out");
    }

    #[tokio::test]
    async fn invalid_or_disabled_proxy_never_falls_back_to_reachable_target() {
        tokio::time::timeout(TEST_TIMEOUT, async {
            let target = listener().await;
            let url = format!(
                "ws://{}/agent?key={FAKE_SECRET}",
                target.local_addr().unwrap()
            );
            let credential_proxy = format!("http://user:{FAKE_SECRET}@127.0.0.1:7897");
            for (enabled, proxy) in [
                (false, Some("http://127.0.0.1:7897")),
                (true, None),
                (true, Some(" ")),
                (true, Some("not a URL")),
                (true, Some("https://127.0.0.1:7897")),
                (true, Some("socks5://127.0.0.1:7897")),
                (true, Some(credential_proxy.as_str())),
                (true, Some("http://@127.0.0.1:7897")),
                (true, Some("http://127.0.0.1:7897/path")),
                (true, Some("http://127.0.0.1:7897/x/..")),
                (true, Some("http://127.0.0.1:7897?key=ignored")),
                (true, Some("http://127.0.0.1:7897#ignored")),
                (true, Some("http://127.0.0.1:0")),
            ] {
                let error = connect(request(&url), enabled, proxy).await.unwrap_err();
                assert_safe_error(&error);
                assert_no_direct_connection(&target).await;
            }
        })
        .await
        .expect("fail-closed configuration test timed out");
    }

    #[tokio::test]
    async fn unreachable_proxy_never_falls_back_to_reachable_target() {
        tokio::time::timeout(TEST_TIMEOUT, async {
            let target = listener().await;
            let unused_proxy = listener().await;
            let proxy_url = format!("http://{}", unused_proxy.local_addr().unwrap());
            drop(unused_proxy);
            let url = format!(
                "ws://{}/agent?key={FAKE_SECRET}",
                target.local_addr().unwrap()
            );
            let error = connect(request(&url), true, Some(&proxy_url))
                .await
                .unwrap_err();
            assert_safe_error(&error);
            assert!(error.contains("无法连接网络代理"));
            assert_no_direct_connection(&target).await;
        })
        .await
        .expect("unreachable proxy test timed out");
    }

    async fn rejected_response(response: Vec<u8>, tls: bool) -> String {
        let target = listener().await;
        let proxy = listener().await;
        let proxy_url = format!("http://{}", proxy.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut stream, _) = proxy.accept().await.unwrap();
            read_request(&mut stream).await;
            // Oversized response tests may close while this write is pending.
            let _ = stream.write_all(&response).await;
        });
        let scheme = if tls { "wss" } else { "ws" };
        let url = format!(
            "{scheme}://{}/agent?key={FAKE_SECRET}",
            target.local_addr().unwrap()
        );
        let error = connect(request(&url), true, Some(&proxy_url))
            .await
            .unwrap_err();
        server.await.unwrap();
        assert_safe_error(&error);
        assert_no_direct_connection(&target).await;
        error
    }

    #[tokio::test]
    async fn connect_rejects_non_2xx_malformed_incomplete_and_oversized_responses() {
        tokio::time::timeout(TEST_TIMEOUT, async {
            let rejected = format!(
                "HTTP/1.1 407 {FAKE_SECRET}\r\nX-Private: {FAKE_SECRET}\r\n\r\n{FAKE_SECRET}"
            );
            assert!(rejected_response(rejected.into_bytes(), false)
                .await
                .contains("HTTP 407"));
            for response in [
                b"HTTP/1.1 200".as_slice(),
                b"HTTP/1.1 20x Bad\r\n\r\n",
                b"HTTP/9.9 200 Bad\r\n\r\n",
                b"HTTP/1.1 2000 Bad\r\n\r\n",
                b"HTTP/1.1 099 Bad\r\n\r\n",
                b"HTTP/1.1 200 OK\nX: Bad\r\n\r\n",
                b"HTTP/1.1 200 OK\r\nNot-a-header\r\n\r\n",
            ] {
                rejected_response(response.to_vec(), false).await;
            }
            let mut oversized = b"HTTP/1.1 200 OK\r\nX-Large: ".to_vec();
            oversized.extend(vec![b'x'; MAX_CONNECT_HEADER_BYTES]);
            oversized.extend_from_slice(b"\r\n\r\n");
            assert!(rejected_response(oversized, false)
                .await
                .contains("响应头过大"));
        })
        .await
        .expect("rejected response test timed out");
    }

    #[tokio::test]
    async fn tls_and_ws_handshake_failure_never_falls_back_or_leaks_response_text() {
        tokio::time::timeout(TEST_TIMEOUT, async {
            let response = format!(
                "HTTP/1.1 200 Tunnel ready\r\n\r\nHTTP/1.1 403 {FAKE_SECRET}\r\n\r\n{FAKE_SECRET}"
            );
            for tls in [false, true] {
                let error = rejected_response(response.as_bytes().to_vec(), tls).await;
                assert!(error.contains("TLS/WebSocket"));
            }
        })
        .await
        .expect("handshake failure test timed out");
    }
}
