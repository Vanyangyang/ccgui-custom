//! Local-only concurrency fixtures: no CLI, real home, or credentials.
use super::*;
use std::future::{poll_fn, Future};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::Poll;
use std::time::Duration;
use tokio::sync::{oneshot, Notify};

async fn assert_pending<F: Future>(mut future: Pin<&mut F>) {
    poll_fn(|cx| {
        assert!(future.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
}

#[tokio::test]
async fn preparation_serializes_token_snapshot_through_owned_headers() {
    let gate = tokio::sync::Mutex::new(());
    let token_file = Mutex::new(String::new());
    let events = Mutex::new(Vec::new());
    let release = Notify::new();
    let mut first = Box::pin(serialized_preparation(&gate, async {
        *token_file.lock().unwrap() = "T1".into();
        events.lock().unwrap().push("T1 snapshot");
        release.notified().await;
        assert_eq!(*token_file.lock().unwrap(), "T1");
        let mut headers = HeaderMap::new();
        set_bearer(&mut headers, &token_file.lock().unwrap())?;
        events.lock().unwrap().push("T1 headers");
        Ok(headers)
    }));
    let mut second = Box::pin(serialized_preparation(&gate, async {
        *token_file.lock().unwrap() = "T2".into();
        events.lock().unwrap().push("T2 snapshot");
        let mut headers = HeaderMap::new();
        set_bearer(&mut headers, &token_file.lock().unwrap())?;
        events.lock().unwrap().push("T2 headers");
        Ok(headers)
    }));
    assert_pending(first.as_mut()).await;
    assert_pending(second.as_mut()).await;
    assert_eq!(*events.lock().unwrap(), ["T1 snapshot"]);
    release.notify_one();
    let first_headers = first.await.unwrap();
    let second_headers = second.await.unwrap();
    assert_eq!(first_headers[AUTHORIZATION], "Bearer T1");
    assert_eq!(second_headers[AUTHORIZATION], "Bearer T2");
    assert_eq!(
        *events.lock().unwrap(),
        ["T1 snapshot", "T1 headers", "T2 snapshot", "T2 headers"]
    );
    assert!(gate.try_lock().is_ok());
}

#[tokio::test(start_paused = true)]
async fn preparation_wait_timeout_does_not_cancel_owner_or_next_call() {
    let gate = tokio::sync::Mutex::new(());
    let release = Notify::new();
    let mut owner = Box::pin(serialized_preparation(&gate, async {
        release.notified().await;
        Ok(1)
    }));
    assert_pending(owner.as_mut()).await;
    let waiter_entered = std::cell::Cell::new(false);
    let failure = super::super::diagnostics::capture(completion_deadline(
        Duration::from_secs(1),
        serialized_preparation(&gate, async {
            waiter_entered.set(true);
            Ok(2)
        }),
    ))
    .await
    .unwrap_err();
    assert!(!waiter_entered.get());
    assert_eq!(failure.kind, SideCallError::Timeout);
    assert_eq!(failure.stage, Some("preparation_wait"));
    let mut next = Box::pin(serialized_preparation(&gate, async { Ok(3) }));
    assert_pending(next.as_mut()).await;
    release.notify_one();
    assert_eq!(owner.await.unwrap(), 1);
    assert_eq!(next.await.unwrap(), 3);
}

#[tokio::test(start_paused = true)]
async fn preparation_failure_timeout_and_drop_release_gate() {
    let gate = tokio::sync::Mutex::new(());
    assert_eq!(
        serialized_preparation(&gate, async { Err::<(), _>(SideCallError::Unavailable) }).await,
        Err(SideCallError::Unavailable)
    );
    assert!(gate.try_lock().is_ok());

    let mut timed = Box::pin(completion_deadline(
        Duration::from_secs(1),
        serialized_preparation(&gate, std::future::pending::<Result<(), SideCallError>>()),
    ));
    assert_pending(timed.as_mut()).await;
    let mut survivor = Box::pin(serialized_preparation(&gate, async { Ok(7) }));
    assert_pending(survivor.as_mut()).await;
    assert_eq!(timed.await, Err(SideCallError::Timeout));
    assert_eq!(survivor.await.unwrap(), 7);

    struct CheckCleanupBeforeUnlock<'a>(&'a tokio::sync::Mutex<()>);
    impl Drop for CheckCleanupBeforeUnlock<'_> {
        fn drop(&mut self) {
            assert!(self.0.try_lock().is_err());
        }
    }
    let mut dropped = Box::pin(serialized_preparation(&gate, async {
        let _cleanup = CheckCleanupBeforeUnlock(&gate);
        std::future::pending::<Result<(), SideCallError>>().await
    }));
    assert_pending(dropped.as_mut()).await;
    let mut survivor = Box::pin(serialized_preparation(&gate, async { Ok(8) }));
    assert_pending(survivor.as_mut()).await;
    drop(dropped);
    assert_eq!(survivor.await.unwrap(), 8);
    assert!(gate.try_lock().is_ok());
}

// Both requests must arrive before either response is released. The fixture
// reads the complete request so the test verifies actual HTTP overlap.
async fn held_http_fixture(
    status: &'static str,
    text: &'static str,
) -> (
    String,
    oneshot::Receiver<String>,
    oneshot::Sender<()>,
    tokio::task::JoinHandle<()>,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (arrived_tx, arrived) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut bytes = [0; 2048];
        let head = loop {
            let count = stream.read(&mut bytes).await.unwrap();
            assert!(count > 0);
            request.extend_from_slice(&bytes[..count]);
            if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                let head = String::from_utf8(request[..end].to_vec()).unwrap();
                let length: usize = head
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|value| value.trim().parse().unwrap())
                    })
                    .unwrap();
                if request.len() >= end + 4 + length {
                    break head;
                }
            }
        };
        arrived_tx.send(head).unwrap();
        released.await.unwrap();
        let body = json!({"status":"completed","output":[{"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":json!({"summary":text}).to_string()}]}]}).to_string();
        let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        stream.write_all(response.as_bytes()).await.unwrap();
    });
    (base, arrived, release, task)
}

async fn fake_prepared_http(
    gate: Arc<tokio::sync::Mutex<()>>,
    base: String,
    token: &'static str,
) -> Result<SideCallOutput, SideCallError> {
    let (base, headers) = serialized_preparation(&gate, async {
        let mut headers = HeaderMap::new();
        set_bearer(&mut headers, token)?;
        Ok((base, headers))
    })
    .await?;
    let schema = json!({"type":"object"});
    let call = StructuredCall {
        system_prompt: "fixture",
        input: "fixture",
        json_schema: &schema,
        model: "fixture-model",
        provider_id: None,
        effort: "high",
        timeout: Duration::from_secs(5),
    };
    complete_http(&call, &base, headers).await
}

#[tokio::test]
async fn prepared_http_overlaps_and_reverse_completion_keeps_results_isolated() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let gate = Arc::new(tokio::sync::Mutex::new(()));
        let (base_a, arrived_a, release_a, server_a) = held_http_fixture("200 OK", "first").await;
        let (base_b, arrived_b, release_b, server_b) = held_http_fixture("200 OK", "second").await;
        let first = tokio::spawn(fake_prepared_http(gate.clone(), base_a, "T1"));
        assert!(arrived_a.await.unwrap().contains("Bearer T1"));
        let second = tokio::spawn(fake_prepared_http(gate.clone(), base_b, "T2"));
        assert!(arrived_b.await.unwrap().contains("Bearer T2"));
        assert!(gate.try_lock().is_ok());
        release_b.send(()).unwrap();
        assert_eq!(
            second.await.unwrap().unwrap().structured["summary"],
            "second"
        );
        assert!(!first.is_finished());
        release_a.send(()).unwrap();
        assert_eq!(first.await.unwrap().unwrap().structured["summary"], "first");
        server_a.await.unwrap();
        server_b.await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn prepared_http_failure_does_not_cancel_other_inflight_call() {
    tokio::time::timeout(Duration::from_secs(5), async {
        let gate = Arc::new(tokio::sync::Mutex::new(()));
        let (base_a, arrived_a, release_a, server_a) =
            held_http_fixture("200 OK", "survivor").await;
        let (base_b, arrived_b, release_b, server_b) =
            held_http_fixture("500 Internal Server Error", "failed").await;
        let first = tokio::spawn(fake_prepared_http(gate.clone(), base_a, "T1"));
        arrived_a.await.unwrap();
        let second = tokio::spawn(fake_prepared_http(gate, base_b, "T2"));
        arrived_b.await.unwrap();
        release_b.send(()).unwrap();
        assert_eq!(second.await.unwrap().unwrap_err(), SideCallError::Failed);
        assert!(!first.is_finished());
        release_a.send(()).unwrap();
        assert_eq!(
            first.await.unwrap().unwrap().structured["summary"],
            "survivor"
        );
        server_a.await.unwrap();
        server_b.await.unwrap();
    })
    .await
    .unwrap();
}
