//! Content-free, local RPC fixtures. No real CLI, home, or credentials.
use super::*;
use std::collections::VecDeque;
use std::sync::Arc;
use tokio::io::{duplex, split, AsyncBufReadExt};

fn file(token: &str, account: &str) -> String {
    use base64::Engine;
    let claims = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(br#"{"https://api.openai.com/auth":{"chatgpt_account_is_fedramp":true}}"#);
    json!({"auth_mode":"chatgpt","tokens":{"access_token":token,"account_id":account,"id_token":format!("x.{claims}.x")}}).to_string()
}

fn auth(mode: &str, token: &str) -> Value {
    json!({"authMethod":mode,"authToken":token})
}

fn account(id: &str) -> Value {
    json!({"account":{"type":"chatgpt"},"workspaceRouting":{"chatgptAccountId":id,"backendOrigin":"https://chatgpt.com","accountRoutingOverride":"NO_CONSTRAINT"}})
}

struct Fixture {
    writer: tokio::io::WriteHalf<tokio::io::DuplexStream>,
    reader: BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>,
    requests: Arc<Mutex<Vec<Value>>>,
    task: tokio::task::JoinHandle<()>,
}

fn fixture(replies: Vec<Value>, stall_after_replies: bool) -> Fixture {
    let (client, server) = duplex(16 * 1024);
    let (read, writer) = split(client);
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = requests.clone();
    let task = tokio::spawn(async move {
        let (read, mut write) = split(server);
        let mut lines = BufReader::new(read).lines();
        let mut replies = VecDeque::from(replies);
        while let Some(line) = lines.next_line().await.unwrap() {
            let request: Value = serde_json::from_str(&line).unwrap();
            seen.lock().unwrap().push(request.clone());
            if let Some(result) = replies.pop_front() {
                let response = json!({"id":request["id"],"result":result});
                write
                    .write_all(format!("{response}\n").as_bytes())
                    .await
                    .unwrap();
            } else if stall_after_replies {
                std::future::pending::<()>().await;
            } else {
                panic!("unexpected additional RPC");
            }
        }
    });
    Fixture {
        writer,
        reader: BufReader::new(read),
        requests,
        task,
    }
}

async fn snapshot(
    fixture: &mut Fixture,
    files: Vec<String>,
) -> Result<AuthSnapshot, SideCallError> {
    let mut files = VecDeque::from(files);
    read_stock_auth(
        &mut fixture.writer,
        &mut fixture.reader,
        &toml::Table::new(),
        None,
        "fixture",
        || std::future::ready(Ok(files.pop_front().expect("unexpected file reread"))),
    )
    .await
}

fn assert_requests(fixture: &Fixture, count: usize) {
    let requests = fixture.requests.lock().unwrap();
    assert_eq!(requests.len(), count);
    for (index, request) in requests.iter().enumerate() {
        assert_eq!(request["id"], 3 + index as u64);
        assert_eq!(
            request["method"],
            if index % 2 == 0 {
                "getAuthStatus"
            } else {
                "account/read"
            }
        );
        assert_eq!(request["params"]["refreshToken"], index == 0);
    }
}

#[tokio::test]
async fn api_key_snapshot_has_no_file_bound_cache_identity() {
    let mut fixture = fixture(vec![auth("apikey", "fixture-key")], false);
    let snapshot = read_stock_auth(
        &mut fixture.writer,
        &mut fixture.reader,
        &toml::Table::new(),
        None,
        "fixture",
        || std::future::ready(Err(SideCallError::Unavailable)),
    )
    .await
    .unwrap();
    assert_eq!(snapshot.mode, "apikey");
    assert_eq!(snapshot.token, "fixture-key");
    assert!(snapshot.oauth.is_none());
    assert!(snapshot.workspace_routing.is_none());
    assert_requests(&fixture, 1);
    fixture.task.abort();
}

#[tokio::test]
async fn unreadable_cache_probe_bypasses_reuse_but_strict_snapshot_still_controls_success() {
    // An unreadable optional probe cannot authorize a cached route. A later
    // authoritative read may succeed, or must retain its own precise failure.
    let probe = optional_auth_file_hash(std::future::ready(Err(SideCallError::Unavailable))).await;
    assert_eq!(probe, None);
    let text = file("T1", "A");
    let cache = Mutex::new(None);
    let now = Instant::now();
    store_prepared_route_in(
        &cache,
        [7; 32],
        Some(sha256_bytes(text.as_bytes())),
        now,
        CHATGPT_BASE,
        &HeaderMap::new(),
    );
    assert!(lookup_prepared_route_in(&cache, &[7; 32], probe, now).is_none());
    let mut fixture = fixture(vec![auth("chatgpt", "T1"), account("A")], false);
    let snapshot = snapshot(&mut fixture, vec![text.clone()]).await.unwrap();
    assert_eq!(
        snapshot.oauth.unwrap().file_hash,
        sha256_bytes(text.as_bytes())
    );
    assert_requests(&fixture, 2);
    fixture.task.abort();

    let mut fixture = self::fixture(vec![auth("chatgpt", "T1"), account("A")], false);
    let failure = super::super::diagnostics::capture(async {
        assert!(
            optional_auth_file_hash(std::future::ready(Err(SideCallError::Unavailable)))
                .await
                .is_none()
        );
        read_stock_auth(
            &mut fixture.writer,
            &mut fixture.reader,
            &toml::Table::new(),
            None,
            "fixture",
            || std::future::ready(Err(SideCallError::Unavailable)),
        )
        .await
    })
    .await
    .err()
    .unwrap();
    assert_eq!(failure.kind, SideCallError::Unavailable);
    assert_eq!(failure.stage, Some("oauth_file_read"));
    assert_requests(&fixture, 2);
    fixture.task.abort();
}

#[tokio::test]
async fn same_account_rotation_recovers_one_coherent_snapshot_without_forced_refresh() {
    let mut fixture = fixture(
        vec![
            auth("chatgpt", "T1"),
            account("A"),
            auth("chatgpt", "T2"),
            account("A"),
        ],
        false,
    );
    let latest = file("T2", "A");
    let result = snapshot(&mut fixture, vec![latest.clone(), latest.clone()])
        .await
        .unwrap();
    assert_eq!(result.token, "T2");
    let verified = result.oauth.unwrap();
    assert_eq!(verified.account, "A");
    assert!(verified.fedramp);
    assert_eq!(verified.file_hash, sha256_bytes(latest.as_bytes()));
    assert_ne!(verified.file_hash, sha256_bytes(file("T3", "A").as_bytes()));
    assert_requests(&fixture, 4);
    fixture.task.abort();
}

#[tokio::test]
async fn persistent_rotation_is_bounded_and_reports_only_terminal_mismatch() {
    let mut fixture = fixture(
        vec![
            auth("chatgpt", "T1"),
            account("A"),
            auth("chatgpt", "T2"),
            account("A"),
        ],
        false,
    );
    let failure = super::super::diagnostics::capture(snapshot(
        &mut fixture,
        vec![file("T2", "A"), file("T3", "A")],
    ))
    .await
    .err()
    .unwrap();
    assert_eq!(failure.kind, SideCallError::Unavailable);
    assert_eq!(failure.stage, Some("oauth_token_mismatch"));
    assert_eq!(failure.http_status, None);
    assert_requests(&fixture, 4);
    fixture.task.abort();
}

#[tokio::test]
async fn changed_identity_and_mode_are_never_adopted() {
    for (replies, files, stage, count) in [
        (
            vec![auth("chatgpt", "T1"), account("A")],
            vec![file("T2", "B")],
            "oauth_account_changed",
            2,
        ),
        (
            vec![
                auth("chatgpt", "T1"),
                account("A"),
                auth("chatgpt", "T2"),
                account("B"),
            ],
            vec![file("T2", "A")],
            "oauth_account_changed",
            4,
        ),
        (
            vec![auth("chatgpt", "T1"), account("A"), auth("apikey", "T2")],
            vec![file("T2", "A")],
            "auth_mode",
            3,
        ),
        (
            vec![
                auth("chatgpt", "T1"),
                account("A"),
                auth("chatgpt", "T2"),
                account("A"),
            ],
            vec![file("T2", "A"), file("T2", "B")],
            "oauth_account_changed",
            4,
        ),
    ] {
        let mut fixture = fixture(replies, false);
        let failure = super::super::diagnostics::capture(snapshot(&mut fixture, files))
            .await
            .err()
            .unwrap();
        assert_eq!(failure.stage, Some(stage));
        assert_requests(&fixture, count);
        fixture.task.abort();
    }
}

#[tokio::test]
async fn invalid_file_metadata_or_route_does_not_retry_even_when_token_differs() {
    let mut invalid_routing = account("A");
    invalid_routing["workspaceRouting"]["backendOrigin"] = json!("http://untrusted.example");
    let mut invalid_metadata: Value = serde_json::from_str(&file("T2", "A")).unwrap();
    invalid_metadata["tokens"]["id_token"] = json!("invalid");
    for (text, routing, stage) in [
        ("{".into(), account("A"), "oauth_file_json"),
        ("{}".into(), account("A"), "oauth_file_identity"),
        (
            invalid_metadata.to_string(),
            account("A"),
            "oauth_file_metadata",
        ),
        (file("T2", "A"), invalid_routing, "oauth_routing"),
    ] {
        let mut fixture = fixture(vec![auth("chatgpt", "T1"), routing], false);
        let failure = super::super::diagnostics::capture(snapshot(&mut fixture, vec![text]))
            .await
            .err()
            .unwrap();
        assert_eq!(failure.stage, Some(stage));
        assert_requests(&fixture, 2);
        fixture.task.abort();
    }
}

#[tokio::test(start_paused = true)]
async fn second_read_timeout_and_cancellation_release_preparation_gate() {
    let gate = tokio::sync::Mutex::new(());
    let mut fixture = fixture(vec![auth("chatgpt", "T1"), account("A")], true);
    let failure = super::super::diagnostics::capture(completion_deadline(
        Duration::from_secs(1),
        serialized_preparation(&gate, snapshot(&mut fixture, vec![file("T2", "A")])),
    ))
    .await
    .err()
    .unwrap();
    assert_eq!(failure.kind, SideCallError::Timeout);
    assert_eq!(failure.stage, Some("rpc_auth_status"));
    assert_requests(&fixture, 3);
    assert!(gate.try_lock().is_ok());
    fixture.task.abort();

    let mut fixture = self::fixture(vec![auth("chatgpt", "T1"), account("A")], true);
    let requests = fixture.requests.clone();
    let mut operation = Box::pin(serialized_preparation(
        &gate,
        snapshot(&mut fixture, vec![file("T2", "A")]),
    ));
    loop {
        tokio::select! {
            _ = &mut operation => panic!("stalled operation completed"),
            _ = tokio::task::yield_now() => {}
        }
        if requests.lock().unwrap().len() == 3 {
            break;
        }
    }
    assert!(gate.try_lock().is_err());
    drop(operation);
    assert!(gate.try_lock().is_ok());
    fixture.task.abort();
}

#[tokio::test]
async fn recovered_mismatch_does_not_hide_later_http_failure() {
    let mut fixture = fixture(
        vec![
            auth("chatgpt", "T1"),
            account("A"),
            auth("chatgpt", "T2"),
            account("A"),
        ],
        false,
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut bytes = [0; 8192];
        let _ = stream.read(&mut bytes).await.unwrap();
        stream.write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
    });
    let failure = super::super::diagnostics::capture(async {
        let auth = snapshot(&mut fixture, vec![file("T2", "A"), file("T2", "A")]).await?;
        let mut headers = HeaderMap::new();
        set_bearer(&mut headers, &auth.token)?;
        let schema = json!({"type":"object"});
        let call = StructuredCall {
            system_prompt: "fixture",
            input: "fixture",
            json_schema: &schema,
            model: "fixture",
            provider_id: None,
            effort: "medium",
            timeout: Duration::from_secs(2),
        };
        complete_http(&call, &base, headers).await
    })
    .await
    .err()
    .unwrap();
    assert_eq!(failure.kind, SideCallError::Failed);
    assert_eq!(failure.stage, Some("http_status"));
    assert_eq!(failure.http_status, Some(500));
    assert_requests(&fixture, 4);
    server.await.unwrap();
    fixture.task.abort();
}
