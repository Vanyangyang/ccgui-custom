//! Shared app-server steering state. The driver remains the sole stdout reader.
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::oneshot;

use super::registry::ChildEntry;

const STEER_TIMEOUT: Duration = Duration::from_secs(30);
const ID_PREFIX: &str = "ccgui-steer:";

#[derive(Default)]
pub(crate) struct CodexControl(Mutex<State>);

#[derive(Default)]
struct State {
    active: Option<(String, String)>,
    next_id: u64,
    pending: HashMap<String, Pending>,
}

struct Pending {
    turn_id: String,
    reply: oneshot::Sender<Result<bool, String>>,
}

struct Request<'a> {
    control: &'a CodexControl,
    id: String,
    frame: Value,
    reply: oneshot::Receiver<Result<bool, String>>,
}

// A cancelled IPC or timeout must not retain a sender until the run ends.
impl Drop for Request<'_> {
    fn drop(&mut self) {
        self.control
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pending
            .remove(&self.id);
    }
}

impl CodexControl {
    pub(crate) fn activate(&self, thread_id: &str, turn_id: &str) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).active =
            Some((thread_id.into(), turn_id.into()));
    }

    pub(crate) fn close(&self) {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        state.active = None;
        for (_, pending) in state.pending.drain() {
            let _ = pending.reply.send(Err(
                "Codex turn ended before the steering request was acknowledged".into(),
            ));
        }
    }

    fn prepare(&self, input: Vec<Value>) -> Option<Request<'_>> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let (thread_id, turn_id) = state.active.clone()?;
        state.next_id += 1;
        let id = format!("{ID_PREFIX}{}", state.next_id);
        let (reply, receiver) = oneshot::channel();
        state.pending.insert(
            id.clone(),
            Pending {
                turn_id: turn_id.clone(),
                reply,
            },
        );
        Some(Request {
            control: self,
            id: id.clone(),
            frame: json!({"jsonrpc":"2.0", "id":id, "method":"turn/steer",
                "params":{"threadId":thread_id,"expectedTurnId":turn_id,"input":input}}),
            reply: receiver,
        })
    }

    /// Consume only a reply to one of our requests, leaving driver replies and
    /// server requests untouched. String ids cannot collide with pump integers.
    pub(crate) fn dispatch_reply(&self, value: &Value) -> bool {
        if value.get("method").is_some() {
            return false;
        }
        let Some(id) = value.get("id").and_then(Value::as_str) else {
            return false;
        };
        let pending = self
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pending
            .remove(id);
        let Some(pending) = pending else {
            return false;
        };
        let result = if let Some(error) = value.get("error") {
            Err(format!(
                "Codex turn/steer failed ({}): {}",
                error.get("code").and_then(Value::as_i64).unwrap_or(0),
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("protocol error")
            ))
        } else if value.pointer("/result/turnId").and_then(Value::as_str)
            == Some(pending.turn_id.as_str())
        {
            Ok(true)
        } else {
            Err("Codex turn/steer returned an invalid or mismatched turn acknowledgement".into())
        };
        let _ = pending.reply.send(result);
        true
    }

    pub(crate) async fn steer(
        &self,
        entry: &ChildEntry,
        input: Vec<Value>,
    ) -> Result<bool, String> {
        if entry.killed.load(std::sync::atomic::Ordering::SeqCst) {
            return Ok(false);
        }
        let Some(mut request) = self.prepare(input) else {
            return Ok(false);
        };
        // Bound both pipe delivery and acknowledgement. A timeout is uncertain
        // delivery, never permission to retry as an ordinary new turn.
        tokio::time::timeout(STEER_TIMEOUT, async {
            entry
                .write_frame(&request.frame.to_string())
                .await
                .map_err(|e| e.to_string())?;
            (&mut request.reply)
                .await
                .map_err(|_| "Codex steering reply channel closed".to_string())?
        })
        .await
        .map_err(|_| "Codex steering acknowledgement timed out".to_string())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn steer_ack_requires_matching_server_turn_and_preserves_input() {
        let control = CodexControl::default();
        control.activate("native-thread", "native-turn");
        let input = vec![
            json!({"type":"text","text":"继续🙂"}),
            json!({"type":"localImage","path":"G:/image.png"}),
        ];
        let mut request = control.prepare(input.clone()).unwrap();
        assert_eq!(
            request.frame["params"],
            json!({"threadId":"native-thread","expectedTurnId":"native-turn","input":input})
        );
        assert!(request.id.starts_with(ID_PREFIX));
        assert!(!control.dispatch_reply(&json!({"id":1,"result":{}})));
        assert!(!control.dispatch_reply(&json!({"id":request.id,"method":"server/request"})));
        assert!(control.dispatch_reply(&json!({"id":request.id,"result":{"turnId":"native-turn"}})));
        assert_eq!((&mut request.reply).await.unwrap(), Ok(true));
    }

    #[tokio::test]
    async fn steer_protocol_error_and_malformed_ack_fail() {
        for response in [
            json!({"error":{"code":-32602,"message":"turn mismatch"}}),
            json!({"result":{}}),
            json!({"result":{"turnId":"another-turn"}}),
        ] {
            let control = CodexControl::default();
            control.activate("thread", "turn");
            let mut request = control.prepare(vec![]).unwrap();
            let mut response = response;
            response["id"] = json!(request.id);
            assert!(control.dispatch_reply(&response));
            assert!((&mut request.reply).await.unwrap().is_err());
        }
    }

    #[tokio::test]
    async fn steer_close_wakes_all_pending_and_clears_active_turn() {
        let control = CodexControl::default();
        assert!(control.prepare(vec![]).is_none());
        control.activate("thread", "turn");
        let mut a = control.prepare(vec![]).unwrap();
        let mut b = control.prepare(vec![]).unwrap();
        assert_ne!(a.id, b.id);
        control.close();
        assert!((&mut a.reply).await.unwrap().is_err());
        assert!((&mut b.reply).await.unwrap().is_err());
        assert!(control.prepare(vec![]).is_none());
        assert!(control.0.lock().unwrap().pending.is_empty());
    }

    #[tokio::test]
    async fn steer_concurrent_out_of_order_replies_and_dropped_waiter() {
        let control = CodexControl::default();
        control.activate("thread", "turn");
        let mut a = control.prepare(vec![]).unwrap();
        let mut b = control.prepare(vec![]).unwrap();
        assert!(control.dispatch_reply(&json!({"id":b.id,"result":{"turnId":"turn"}})));
        assert_eq!((&mut b.reply).await.unwrap(), Ok(true));
        assert!(control.dispatch_reply(&json!({"id":a.id,"result":{"turnId":"turn"}})));
        assert_eq!((&mut a.reply).await.unwrap(), Ok(true));
        drop(control.prepare(vec![]).unwrap());
        assert!(control.0.lock().unwrap().pending.is_empty());
    }
}
