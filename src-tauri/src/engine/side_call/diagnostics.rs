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
    http_status: Cell<Option<u16>>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Failure {
    pub kind: SideCallError,
    pub stage: Option<&'static str>,
    pub http_status: Option<u16>,
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
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
