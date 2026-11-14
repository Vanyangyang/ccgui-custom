//! ACP context occupancy is a session snapshot, separate from turn billing.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::engine::agy::{attach_context_window, attach_native_context};
use crate::engine::qoder_session::AcpLine;
use crate::engine::throughput_common::MAX_SAFE_INTEGER;
use crate::engine::{EngineEvent, TurnCore, TurnState};

#[derive(Default)]
pub(super) struct AgyAcpContext {
    session_id: Option<String>,
    current: Option<Value>,
    // session/new may notify before returning the new session ID. Bind only
    // after its reply; never attribute another pooled session's update to it.
    pending: HashMap<String, Value>,
}

impl AgyAcpContext {
    pub(super) fn observe(&mut self, line: &AcpLine) -> Option<Value> {
        let AcpLine::Notification { method, params } = line else {
            return None;
        };
        if method != "session/update" {
            return None;
        }
        let sid = params
            .get("sessionId")?
            .as_str()
            .filter(|id| !id.is_empty())?;
        if self
            .session_id
            .as_deref()
            .is_some_and(|expected| expected != sid)
        {
            return None;
        }
        let update = params.get("update")?;
        if update.get("sessionUpdate")?.as_str()? != "usage_update" {
            return None;
        }
        let used = update
            .get("used")?
            .as_u64()
            .filter(|&n| n <= MAX_SAFE_INTEGER)?;
        let size = update
            .get("size")?
            .as_u64()
            .filter(|&n| n > 0 && n <= MAX_SAFE_INTEGER)?;
        let usage = json!({
            "context_usage_kind": "current_context",
            "context_usage_source": "acp_usage_update",
            "context_usage": {"input_tokens": used, "output_tokens": 0},
            "model_context_window": size,
        });
        if self.session_id.is_none() {
            if self.pending.len() < 16 || self.pending.contains_key(sid) {
                self.pending.insert(sid.to_owned(), usage);
            }
            return None;
        }
        self.current = Some(usage.clone());
        Some(usage)
    }

    pub(super) fn bind(&mut self, session_id: &str) -> Option<Value> {
        self.session_id = Some(session_id.to_owned());
        self.current = self.pending.remove(session_id);
        self.pending.clear();
        self.current.clone()
    }

    pub(super) fn dispatch(&mut self, line: &AcpLine, core: &TurnCore, state: &mut TurnState) {
        if let Some(usage) = self.observe(line) {
            core.dispatch_event(state, EngineEvent::Usage(usage));
        }
    }

    pub(super) fn current(&self) -> Option<Value> {
        self.current.clone()
    }

    /// The latest official snapshot wins over per-prompt counters and SQLite
    /// estimates, including a valid zero after reset/compaction. Legacy agents
    /// keep the native-metadata fallback. No billing fields are synthesized.
    pub(super) fn enrich(&self, usage: Option<Value>, session_id: &str) -> Option<Value> {
        if let Some(context) = self
            .current
            .as_ref()
            .filter(|_| self.session_id.as_deref() == Some(session_id))
        {
            let mut merged = usage.filter(Value::is_object).unwrap_or_else(|| json!({}));
            merged.as_object_mut()?.extend(context.as_object()?.clone());
            Some(merged)
        } else {
            usage.map(|usage| attach_native_context(attach_context_window(usage), Some(session_id)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn update(sid: &str, used: Value, size: Value) -> AcpLine {
        AcpLine::Notification {
            method: "session/update".into(),
            params: json!({"sessionId":sid,"update":{"sessionUpdate":"usage_update","used":used,"size":size}}),
        }
    }

    #[test]
    fn binds_early_updates_to_the_confirmed_session_and_accepts_zero() {
        let mut context = AgyAcpContext::default();
        assert!(context
            .observe(&update("wanted", json!(0), json!(1048576)))
            .is_none());
        context.observe(&update("other", json!(700), json!(1000)));
        let usage = context.bind("wanted").unwrap();
        assert_eq!(usage["context_usage"]["input_tokens"], 0);
        assert_eq!(usage["model_context_window"], 1048576);
        assert!(context
            .observe(&update("other", json!(999), json!(1000)))
            .is_none());
        assert_eq!(context.current().unwrap(), usage);
    }

    #[test]
    fn invalid_updates_preserve_the_last_snapshot_and_decreases_are_valid() {
        let mut context = AgyAcpContext::default();
        context.bind("s");
        context
            .observe(&update("s", json!(900), json!(1000)))
            .unwrap();
        for (used, size) in [
            (Value::Null, json!(1000)),
            (json!(-1), json!(1000)),
            (json!(1.5), json!(1000)),
            (json!(1), json!(0)),
            (json!(1), json!(MAX_SAFE_INTEGER + 1)),
        ] {
            assert!(context.observe(&update("s", used, size)).is_none());
        }
        assert_eq!(
            context.current().unwrap()["context_usage"]["input_tokens"],
            900
        );
        assert_eq!(
            context
                .observe(&update("s", json!(50), json!(2000)))
                .unwrap()["context_usage"]["input_tokens"],
            50
        );
        assert_eq!(context.current().unwrap()["model_context_window"], 2000);
    }

    #[test]
    fn official_context_enriches_turn_usage_without_fabricating_billing() {
        let mut context = AgyAcpContext::default();
        context.bind("s");
        context.observe(&update("s", json!(500), json!(1000)));
        let usage = context.enrich(Some(json!({"input_tokens":10,"output_tokens":5,"context_usage_kind":"last_prompt","model_context_window":9999})), "s").unwrap();
        assert_eq!(usage["input_tokens"], 10);
        assert_eq!(usage["output_tokens"], 5);
        assert_eq!(usage["context_usage"]["input_tokens"], 500);
        assert_eq!(usage["model_context_window"], 1000);
        assert_eq!(usage["context_usage_source"], "acp_usage_update");
        let context_only = context.enrich(None, "s").unwrap();
        assert!(context_only.get("input_tokens").is_none());
        assert!(context_only.get("output_tokens").is_none());
    }
}
