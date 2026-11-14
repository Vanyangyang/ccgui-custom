//! Per-call, content-free failure context. Keep the shared error classes stable;
//! interested callers can transport the first failing stage instead of losing it
//! in stderr (which GUI launches commonly discard).

use super::SideCallError;
use std::cell::Cell;
use std::future::Future;

tokio::task_local! {
    static CONTEXT: Context;
}

#[derive(Default)]
struct Context {
    stage: Cell<Option<&'static str>>,
    active_phase: Cell<Option<&'static str>>,
    http_status: Cell<Option<u16>>,
    timeout_ms: Cell<Option<u64>>,
    received_bytes: Cell<Option<u64>>,
    sse_events: Cell<Option<u64>>,
    last_event: Cell<Option<&'static str>>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Failure {
    pub kind: SideCallError,
    pub stage: Option<&'static str>,
    pub http_status: Option<u16>,
    pub timeout_ms: Option<u64>,
    pub received_bytes: Option<u64>,
    pub sse_events: Option<u64>,
    pub last_event: Option<&'static str>,
}

/// Active waits are independent of the first specific failure.
pub(crate) fn active_phase(phase: &'static str) {
    let _ = CONTEXT.try_with(|current| current.active_phase.set(Some(phase)));
}

pub(crate) fn deadline(timeout: std::time::Duration) {
    let millis = u64::try_from(timeout.as_millis()).unwrap_or(u64::MAX);
    let _ = CONTEXT.try_with(|current| current.timeout_ms.set(Some(millis)));
}

pub(crate) fn timed_out() {
    let phase = CONTEXT.try_with(|current| current.active_phase.get()).ok().flatten();
    if let Some(phase) = phase { record(phase); }
}

pub(crate) fn body_started() {
    let _ = CONTEXT.try_with(|current| {
        current.received_bytes.set(Some(0));
        current.sse_events.set(Some(0));
    });
}

pub(crate) fn received_bytes(bytes: usize) {
    let bytes = u64::try_from(bytes).unwrap_or(u64::MAX);
    let _ = CONTEXT.try_with(|current| {
        current.received_bytes.set(Some(current.received_bytes.get().unwrap_or(0).saturating_add(bytes)));
    });
}

/// Normalize untrusted event names here; never store arbitrary upstream strings.
pub(crate) fn sse_event(kind: &str) {
    let category = match kind {
        "response.created" | "response.in_progress" => "lifecycle",
        "response.completed" => "completed",
        "error" | "response.failed" | "response.incomplete" => "failure",
        "response.output_item.added" | "response.output_item.done" => "output_item",
        "response.output_text.delta" | "response.output_text.done" => "output_text",
        "response.reasoning_summary_text.delta" | "response.reasoning_summary_text.done"
        | "response.reasoning_text.delta" | "response.reasoning_text.done"
        | "response.reasoning_summary_part.added" | "response.reasoning_summary_part.done" => "reasoning",
        "response.output_text.refusal" | "response.refusal.delta" | "response.refusal.done" => "refusal",
        _ if kind.contains("tool_call") || kind.contains("function_call") => "tool_call",
        _ => "other",
    };
    let _ = CONTEXT.try_with(|current| {
        current.sse_events.set(Some(current.sse_events.get().unwrap_or(0).saturating_add(1)));
        current.last_event.set(Some(category));
    });
}

/// Only fixed internal codes belong here, never response text or credentials.
pub(crate) fn record(stage: &'static str) {
    let _ = CONTEXT.try_with(|current| {
        if current.stage.get().is_none() {
            current.stage.set(Some(stage));
        }
    });
}

pub(crate) fn record_http_status(status: u16) {
    let _ = CONTEXT.try_with(|current| current.http_status.set(Some(status)));
}

pub(crate) fn capture<T>(
    operation: impl Future<Output = Result<T, SideCallError>>,
) -> impl Future<Output = Result<T, Failure>> {
    // Box before returning a future. An async fn would retain the entire
    // unstarted operation inline, even if its body boxed it on the first poll.
    // Tauri's release IPC path moves that future through several stack frames
    // on Windows' 1 MiB UI stack before the runtime can poll it.
    let operation = Box::pin(operation);
    CONTEXT.scope(Context::default(), async move {
        operation.await.map_err(|kind| Failure {
            kind,
            stage: CONTEXT.with(|context| context.stage.get()),
            http_status: CONTEXT.with(|context| context.http_status.get()),
            timeout_ms: CONTEXT.with(|context| context.timeout_ms.get()),
            received_bytes: CONTEXT.with(|context| context.received_bytes.get()),
            sse_events: CONTEXT.with(|context| context.sse_events.get()),
            last_event: CONTEXT.with(|context| context.last_event.get()),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn timeout_metadata_is_isolated_bounded_and_preserves_specific_failures() {
        let (first, untouched) = tokio::join!(
            capture(async {
                deadline(std::time::Duration::from_secs(600));
                active_phase("http_stream_wait");
                body_started();
                received_bytes(12);
                sse_event("private upstream event name");
                let inner = capture(async {
                    active_phase("http_headers");
                    deadline(std::time::Duration::from_secs(1));
                    timed_out();
                    Err::<(), _>(SideCallError::Timeout)
                }).await.unwrap_err();
                assert_eq!(inner.stage, Some("http_headers"));
                assert_eq!(inner.timeout_ms, Some(1000));
                assert_eq!(inner.received_bytes, None);
                record("sse_error");
                timed_out();
                Err::<(), _>(SideCallError::Timeout)
            }),
            capture(async {
                tokio::task::yield_now().await;
                Err::<(), _>(SideCallError::Failed)
            }),
        );
        let first = first.unwrap_err();
        assert_eq!(first.stage, Some("sse_error"));
        assert_eq!(first.timeout_ms, Some(600_000));
        assert_eq!(first.received_bytes, Some(12));
        assert_eq!(first.sse_events, Some(1));
        assert_eq!(first.last_event, Some("other"));
        assert!(!format!("{first:?}").contains("private upstream"));
        let untouched = untouched.unwrap_err();
        assert_eq!(untouched.stage, None);
        assert_eq!(untouched.timeout_ms, None);
        assert_eq!(untouched.received_bytes, None);
        assert_eq!(untouched.sse_events, None);
        assert_eq!(untouched.last_event, None);
        let overflow = capture(async {
            deadline(std::time::Duration::MAX);
            received_bytes(usize::MAX);
            received_bytes(usize::MAX);
            Err::<(), _>(SideCallError::Timeout)
        }).await.unwrap_err();
        assert_eq!(overflow.timeout_ms, Some(u64::MAX));
        assert_eq!(overflow.received_bytes, Some((usize::MAX as u64).saturating_add(usize::MAX as u64)));
    }

    #[tokio::test]
    async fn stages_are_isolated_and_preserve_the_first_failure() {
        let (first, second) = tokio::join!(
            capture(async {
                record("first");
                record_http_status(200);
                tokio::task::yield_now().await;
                record("outer_wrapper");
                Err::<(), _>(SideCallError::BadOutput)
            }),
            capture(async {
                record("second");
                record_http_status(429);
                Err::<(), _>(SideCallError::Failed)
            }),
        );
        let first = first.unwrap_err();
        let second = second.unwrap_err();
        assert_eq!(first.stage, Some("first"));
        assert_eq!(first.http_status, Some(200));
        assert_eq!(second.stage, Some("second"));
        assert_eq!(second.http_status, Some(429));
        record("outside_scope");
        assert_eq!(
            capture(async { Err::<(), _>(SideCallError::Timeout) })
                .await
                .unwrap_err()
                .stage,
            None
        );
    }

    #[tokio::test]
    async fn nested_capture_and_success_do_not_leak_stages() {
        let result = capture(async {
            record("outer");
            let inner = capture(async {
                record("inner");
                Err::<(), _>(SideCallError::BadOutput)
            })
            .await
            .unwrap_err();
            assert_eq!(inner.stage, Some("inner"));
            Err::<(), _>(SideCallError::Timeout)
        })
        .await
        .unwrap_err();
        assert_eq!(result.stage, Some("outer"));
        assert_eq!(
            capture(async {
                record("recovered");
                Ok::<_, SideCallError>(42)
            })
            .await,
            Ok(42)
        );
    }
}
