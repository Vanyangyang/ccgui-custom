//! Stop one Claude task through its native control channel. A successful
//! control acknowledgement is not proof that the task ended: callers wait
//! for the task catalog's terminal status, without touching the whole run.
use super::{events::NativeTask, registry::ProcessRegistry, EngineEvent};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::oneshot;

pub(super) const STOP_TASK_REQUEST_PREFIX: &str = "ccgui-stop-task-";
const STOP_TASK_TIMEOUT: Duration = Duration::from_secs(10);
const RUN_CLOSED: &str = "The native session ended before the task stop was confirmed";

/// A native terminal fact, also returned when the caller missed its task
/// event (for example a web client reconnecting while another task runs).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeTaskStopResult {
    pub task_id: String,
    pub status: String,
}

#[derive(Default)]
pub(crate) struct NativeTaskControl {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    /// Populated only by the Claude adapter's task catalog, never UI input.
    tasks: HashMap<String, String>,
    closed: bool,
    pending: HashMap<String, PendingStop>,
}

struct PendingStop {
    task_id: String,
    reply: oneshot::Sender<Result<String, String>>,
}

struct StopRequest {
    control: Arc<NativeTaskControl>,
    request_id: String,
    frame: String,
    reply: oneshot::Receiver<Result<String, String>>,
}

enum PreparedStop {
    Ended(NativeTaskStopResult),
    Request(StopRequest),
}

impl Drop for StopRequest {
    fn drop(&mut self) {
        // Also handles an abandoned IPC call or a timeout. Late task events
        // still update the UI, but cannot revive this request or leak a waiter.
        self.control
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .pending
            .remove(&self.request_id);
    }
}

fn terminal(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "stopped")
}

impl NativeTaskControl {
    pub(super) fn observe(&self, tasks: &[NativeTask]) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.tasks = tasks
            .iter()
            .map(|task| (task.id.clone(), task.status.clone()))
            .collect();
        let settled: Vec<_> = state
            .pending
            .iter()
            .filter_map(|(id, pending)| {
                match state.tasks.get(&pending.task_id).map(String::as_str) {
                    Some(status) if terminal(status) => Some((id.clone(), Ok(status.to_string()))),
                    Some("unknown") => Some((id.clone(), Err(RUN_CLOSED.to_string()))),
                    _ => None,
                }
            })
            .collect();
        for (id, result) in settled {
            if let Some(pending) = state.pending.remove(&id) {
                let _ = pending.reply.send(result);
            }
        }
    }

    fn prepare(self: &Arc<Self>, task_id: &str) -> Result<PreparedStop, String> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if state.closed {
            return Err(RUN_CLOSED.into());
        }
        match state.tasks.get(task_id).map(String::as_str) {
            Some(status) if terminal(status) => {
                return Ok(PreparedStop::Ended(NativeTaskStopResult {
                    task_id: task_id.into(),
                    status: status.into(),
                }))
            }
            Some("running" | "paused") => {}
            Some(_) => return Err("The native task has no confirmed running state".into()),
            None => return Err("The task does not belong to this live Claude run".into()),
        }
        let request_id = format!("{STOP_TASK_REQUEST_PREFIX}{}", uuid::Uuid::new_v4());
        let (reply, receiver) = oneshot::channel();
        state.pending.insert(
            request_id.clone(),
            PendingStop {
                task_id: task_id.to_string(),
                reply,
            },
        );
        let frame = json!({
            "type": "control_request",
            "request_id": request_id,
            "request": { "subtype": "stop_task", "task_id": task_id },
        })
        .to_string();
        Ok(PreparedStop::Request(StopRequest {
            control: Arc::clone(self),
            request_id,
            frame,
            reply: receiver,
        }))
    }

    pub(super) fn response(&self, request_id: &str, error: Option<&str>) {
        // Acceptance alone must not report success. Some versions send only a
        // task_updated/killed frame, with no task_notification at all.
        let Some(error) = error else {
            return;
        };
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(pending) = state.pending.remove(request_id) {
            let _ = pending.reply.send(Err(error.to_string()));
        }
    }

    pub(crate) fn close(&self) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.closed = true;
        for (_, pending) in state.pending.drain() {
            let _ = pending.reply.send(Err(RUN_CLOSED.into()));
        }
    }
}

/// Only this client's task-stop responses are consumed. Interrupt, permission
/// and other control replies retain their existing handlers.
pub(super) fn response_event(value: &Value) -> Option<EngineEvent> {
    let response = value.get("response")?;
    let request_id = response.get("request_id")?.as_str()?;
    if !request_id.starts_with(STOP_TASK_REQUEST_PREFIX) {
        return None;
    }
    let error = match response.get("subtype")?.as_str()? {
        "success" => None,
        "error" => Some(
            response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Claude rejected the task stop request")
                .chars()
                .take(4096)
                .collect(),
        ),
        _ => return None,
    };
    Some(EngineEvent::NativeTaskStopResponse {
        request_id: request_id.into(),
        error,
    })
}

pub(super) async fn stop_native_task_inner(
    registry: &ProcessRegistry,
    run_id: &str,
    task_id: &str,
) -> Result<NativeTaskStopResult, String> {
    stop_native_task_within(registry, run_id, task_id, STOP_TASK_TIMEOUT).await
}

pub(super) async fn stop_native_task_within(
    registry: &ProcessRegistry,
    run_id: &str,
    task_id: &str,
    limit: Duration,
) -> Result<NativeTaskStopResult, String> {
    if task_id.trim().is_empty() {
        return Err("A native task id is required".into());
    }
    let entry = registry
        .get_live(run_id)
        .filter(|entry| entry.run_id == run_id)
        .ok_or("The native run is no longer accepting task controls")?;
    let mut request = match entry.native_tasks.prepare(task_id)? {
        PreparedStop::Ended(result) => return Ok(result),
        PreparedStop::Request(request) => request,
    };
    let status = tokio::time::timeout(limit, async {
        entry
            .write_frame(&request.frame)
            .await
            .map_err(|e| e.to_string())?;
        (&mut request.reply)
            .await
            .map_err(|_| RUN_CLOSED.to_string())?
    })
    .await
    .map_err(|_| {
        "Timed out waiting for the native task to stop; its status is still unconfirmed".to_string()
    })??;
    Ok(NativeTaskStopResult {
        task_id: task_id.into(),
        status,
    })
}

#[cfg(test)]
mod tests;
