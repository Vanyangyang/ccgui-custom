//! Independent, constant-space app-server telemetry. Never estimates tokens.
use serde_json::{json, Value};
use std::time::Instant;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Default)]
pub(super) struct CodexThroughput {
    seed: Option<(String, u64)>,
    started: Option<Instant>,
    thread: Option<String>,
    turn: Option<String>,
    baseline: Option<u64>,
    /// Resume sends its restored usage after the RPC reply, before the next
    /// turn lifecycle. Accept that same-thread replay until start is observed.
    awaiting_resume_baseline: bool,
    total: Option<u64>,
    last_emit_ms: Option<u64>,
    reason: Option<&'static str>,
    invalid: bool,
    finished: bool,
}

impl CodexThroughput {
    pub(super) fn begin(&mut self, thread: &str, fresh: bool) {
        let baseline = if fresh {
            Some(0)
        } else {
            self.seed
                .as_ref()
                .filter(|(id, _)| id == thread)
                .map(|(_, n)| *n)
        };
        *self = Self {
            started: Some(Instant::now()),
            thread: Some(thread.to_string()),
            baseline,
            awaiting_resume_baseline: !fresh,
            ..Self::default()
        };
    }

    pub(super) fn acknowledge(&mut self, turn: Option<&str>) {
        self.awaiting_resume_baseline = false;
        if let Some(turn) = turn {
            if self.turn.as_deref().is_some_and(|id| id != turn) {
                self.invalid = true;
                self.reason = Some("invalid_identity");
            } else {
                self.turn = Some(turn.to_string());
            }
        }
    }

    pub(super) fn observe(&mut self, method: &str, params: &Value) -> Option<Value> {
        self.observe_at(method, params, self.elapsed())
    }

    fn elapsed(&self) -> u64 {
        self.started.map_or(0, |at| {
            at.elapsed().as_millis().min(MAX_SAFE_INTEGER as u128) as u64
        })
    }

    fn observe_at(&mut self, method: &str, params: &Value, now_ms: u64) -> Option<Value> {
        let thread = params.get("threadId").and_then(Value::as_str);
        if self.started.is_none() {
            // Freeze only already received usage at the later turn/start boundary.
            if method == "thread/tokenUsage/updated" {
                if let (Some(thread), Some(total)) = (
                    thread,
                    count(params.pointer("/tokenUsage/total/outputTokens")),
                ) {
                    self.seed = Some((thread.to_string(), total));
                }
            }
            return None;
        }
        if self.finished || thread != self.thread.as_deref() {
            return None;
        }
        let turn = params
            .get("turnId")
            .and_then(Value::as_str)
            .or_else(|| params.pointer("/turn/id").and_then(Value::as_str));
        if self.awaiting_resume_baseline && method == "thread/tokenUsage/updated" {
            // The restored counter is not output produced by this turn. Once
            // turn/started or its RPC acknowledgement arrives, old-turn frames
            // remain rejected by the normal identity gate below.
            self.baseline = count(params.pointer("/tokenUsage/total/outputTokens"));
            return None;
        }
        if method == "turn/started" && self.turn.is_none() {
            self.awaiting_resume_baseline = false;
            self.acknowledge(turn);
        }
        // Usage cannot adopt an identity: resume may still deliver an old turn.
        if turn.is_none() || turn != self.turn.as_deref() {
            return None;
        }
        match method {
            "thread/tokenUsage/updated" => self.usage(params),
            "turn/completed" | "turn/failed" => {
                let turn = params.get("turn").unwrap_or(&Value::Null);
                let partial = method == "turn/failed"
                    || turn.get("status").and_then(Value::as_str) != Some("completed")
                    || turn.get("error").is_some_and(|e| !e.is_null());
                let elapsed = count(turn.get("durationMs"))
                    .filter(|ms| *ms > 0)
                    .unwrap_or(now_ms);
                return self.finish_at(partial, elapsed);
            }
            _ => return None,
        }
        if self
            .last_emit_ms
            .is_none_or(|previous| now_ms.saturating_sub(previous) >= 1000)
        {
            self.last_emit_ms = Some(now_ms);
            Some(self.payload("running", now_ms, false))
        } else {
            None
        }
    }

    fn usage(&mut self, params: &Value) {
        let Some(total) = count(params.pointer("/tokenUsage/total/outputTokens")) else {
            self.invalid = true;
            self.reason = Some("missing_usage");
            return;
        };
        if self.total.is_some_and(|old| total < old)
            || self.baseline.is_some_and(|base| total < base)
        {
            self.invalid = true; // Reset/decreasing totals cannot be silently rebased.
            self.reason = Some("counter_reset");
            return;
        }
        self.total = Some(total);
    }

    pub(super) fn finish(&mut self, partial: bool) -> Option<Value> {
        self.finish_at(partial, self.elapsed())
    }

    fn finish_at(&mut self, partial: bool, elapsed_ms: u64) -> Option<Value> {
        if self.finished {
            return None;
        }
        self.finished = true;
        if self.started.is_none() {
            return Some(json!({"version":1,"source":"codex_app_server",
                "status":if partial { "partial" } else { "complete" },
                "outputTokens":null,"elapsedMs":null,"generation":null,
                "generationReason":"unavailable_timing","turnReason":"unsupported"}));
        }
        Some(self.payload(
            if partial { "partial" } else { "complete" },
            elapsed_ms,
            partial,
        ))
    }

    fn output(&self) -> Option<u64> {
        if self.invalid {
            return None;
        }
        self.total?.checked_sub(self.baseline?)
    }

    fn payload(&self, status: &str, elapsed_ms: u64, partial: bool) -> Value {
        let output = self.output();
        let reason = if partial {
            Some("interrupted")
        } else if let Some(reason) = self.reason {
            Some(reason)
        } else if self.baseline.is_none() {
            Some("missing_baseline")
        } else if self.total.is_none() {
            Some("missing_usage")
        } else if elapsed_ms == 0 {
            Some("missing_timing")
        } else {
            None
        };
        // App-server exposes turn totals and wall time, not a matched model
        // request token count and decode interval. Text chunks cannot supply it.
        json!({"version":1,"source":"codex_app_server","status":status,
            "outputTokens":output,"elapsedMs":if elapsed_ms > 0 { Some(elapsed_ms) } else { None },
            "generation":null,"generationReason":"unavailable_timing",
            "turnReason":if status == "running" { None } else { reason }})
    }
}

fn count(value: Option<&Value>) -> Option<u64> {
    value?.as_u64().filter(|n| *n <= MAX_SAFE_INTEGER)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tracker(fresh: bool) -> CodexThroughput {
        let mut value = CodexThroughput::default();
        value.begin("thread", fresh);
        value.acknowledge(Some("turn"));
        value
    }
    fn usage(total: u64, last: u64) -> Value {
        json!({"threadId":"thread","turnId":"turn","tokenUsage":{
            "total":{"outputTokens":total},"last":{"outputTokens":last,"reasoningOutputTokens":0}}})
    }
    fn text(method: &str, tracker: &mut CodexThroughput, now: u64) {
        let params = if method.ends_with("delta") {
            json!({"threadId":"thread","turnId":"turn","itemId":"text","delta":"x"})
        } else {
            json!({"threadId":"thread","turnId":"turn","item":{"id":"text","type":"agentMessage"}})
        };
        assert!(tracker
            .observe_at(method, &params, now)
            .is_none_or(|v| v["status"] == "running"));
    }

    #[test]
    fn terminal_reasons_preserve_success_and_duration_fallback() {
        let mut missing = tracker(true);
        let report = missing.finish_at(false, 10).unwrap();
        assert_eq!(report["status"], "complete");
        assert_eq!(report["turnReason"], "missing_usage");

        let mut reset = tracker(true);
        reset.observe_at("thread/tokenUsage/updated", &usage(10, 10), 1);
        reset.observe_at("thread/tokenUsage/updated", &usage(9, 9), 2);
        let report = reset.finish_at(false, 10).unwrap();
        assert_eq!(report["turnReason"], "counter_reset");
        assert!(report["outputTokens"].is_null());

        let mut identity = tracker(true);
        identity.acknowledge(Some("different"));
        assert_eq!(
            identity.finish_at(false, 10).unwrap()["turnReason"],
            "invalid_identity"
        );

        for native in [Value::Null, json!(0), json!(-1)] {
            let mut t = tracker(true);
            t.observe_at("thread/tokenUsage/updated", &usage(10, 10), 1);
            let terminal = json!({"threadId":"thread","turn":{
                "id":"turn","status":"completed","durationMs":native}});
            let report = t.observe_at("turn/completed", &terminal, 20).unwrap();
            assert_eq!(report["elapsedMs"], 20);
            assert!(report["turnReason"].is_null());
        }
        let mut no_time = tracker(true);
        no_time.observe_at("thread/tokenUsage/updated", &usage(0, 0), 0);
        let report = no_time.finish_at(false, 0).unwrap();
        assert_eq!(report["status"], "complete");
        assert_eq!(report["turnReason"], "missing_timing");
        assert!(report["elapsedMs"].is_null());
        let mut interrupted = tracker(true);
        assert_eq!(
            interrupted.finish_at(true, 10).unwrap()["turnReason"],
            "interrupted"
        );
    }

    #[test]
    fn retry_between_deltas_invalidates_generation_without_losing_turn_totals() {
        let mut t = tracker(true);
        text("item/started", &mut t, 0);
        text("item/agentMessage/delta", &mut t, 100);
        assert!(t
            .observe_at(
                "error",
                &json!({
                    "threadId":"thread", "turnId":"turn", "willRetry":true,
                    "error":{"message":"retry fixture"}
                }),
                500
            )
            .is_none());
        text("item/agentMessage/delta", &mut t, 1100);
        text("item/completed", &mut t, 1200);
        t.observe_at("thread/tokenUsage/updated", &usage(10, 10), 1400);
        let sample = t.finish_at(false, 1500).unwrap();
        assert_eq!(sample["status"], "complete");
        assert_eq!(sample["outputTokens"], 10);
        assert!(sample["generation"].is_null());
        assert_eq!(sample["generationReason"], "unavailable_timing");
    }

    #[test]
    fn totals_dedupe_and_old_turns_cannot_enter_the_counter() {
        let mut t = tracker(true);
        let first = t
            .observe_at("thread/tokenUsage/updated", &usage(10, 10), 100)
            .unwrap();
        assert_eq!(first["outputTokens"], 10);
        assert!(t
            .observe_at("thread/tokenUsage/updated", &usage(10, 10), 500)
            .is_none());
        let mut old = usage(900, 900);
        old["turnId"] = json!("old");
        assert!(t
            .observe_at("thread/tokenUsage/updated", &old, 1500)
            .is_none());
        assert_eq!(t.finish_at(false, 2000).unwrap()["outputTokens"], 10);
    }

    #[test]
    fn resumed_turn_requires_a_matching_prestart_baseline() {
        let mut t = CodexThroughput::default();
        t.observe_at("thread/tokenUsage/updated", &usage(100, 40), 0);
        t.begin("thread", false);
        t.acknowledge(Some("turn"));
        t.observe_at("thread/tokenUsage/updated", &usage(130, 30), 100);
        assert_eq!(t.finish_at(false, 2000).unwrap()["outputTokens"], 30);
        let mut unknown = tracker(false);
        unknown.observe_at("thread/tokenUsage/updated", &usage(130, 30), 100);
        let final_report = unknown.finish_at(false, 2000).unwrap();
        assert!(final_report["outputTokens"].is_null());
        assert_eq!(final_report["status"], "complete");
        assert_eq!(final_report["turnReason"], "missing_baseline");
    }

    #[test]
    fn resumed_usage_replay_after_reply_precedes_new_turn_and_counts_only_new_requests() {
        let mut t = CodexThroughput::default();
        t.begin("thread", false);
        let mut replay = usage(100, 40);
        replay["turnId"] = json!("previous-turn");
        assert!(t
            .observe_at("thread/tokenUsage/updated", &replay, 1)
            .is_none());
        let mut foreign = replay.clone();
        foreign["threadId"] = json!("another-thread");
        foreign["tokenUsage"]["total"]["outputTokens"] = json!(900);
        assert!(t
            .observe_at("thread/tokenUsage/updated", &foreign, 2)
            .is_none());
        t.observe_at(
            "turn/started",
            &json!({"threadId":"thread","turn":{"id":"turn"}}),
            3,
        );
        t.observe_at("thread/tokenUsage/updated", &usage(130, 30), 100);
        // A replay trailing the new lifecycle cannot replace its frozen baseline.
        assert!(t
            .observe_at("thread/tokenUsage/updated", &replay, 1100)
            .is_none());
        t.observe_at("thread/tokenUsage/updated", &usage(150, 20), 1200);
        let final_report = t.finish_at(false, 2000).unwrap();
        assert_eq!(final_report["status"], "complete");
        assert_eq!(final_report["outputTokens"], 50);
        assert_eq!(final_report["elapsedMs"], 2000);

        let mut unknown = CodexThroughput::default();
        unknown.begin("thread", false);
        unknown.acknowledge(Some("turn"));
        assert!(unknown
            .observe_at("thread/tokenUsage/updated", &replay, 1)
            .is_none());
        unknown.observe_at("thread/tokenUsage/updated", &usage(130, 30), 100);
        assert_eq!(
            unknown.finish_at(false, 2000).unwrap()["turnReason"],
            "missing_baseline"
        );
    }

    #[test]
    fn reset_and_missing_fields_never_create_zero_or_negative_counts() {
        let mut t = tracker(true);
        t.observe_at("thread/tokenUsage/updated", &usage(10, 10), 100);
        t.observe_at("thread/tokenUsage/updated", &usage(2, 2), 1100);
        assert!(t.finish_at(false, 2000).unwrap()["outputTokens"].is_null());
        let mut t = tracker(true);
        let mut missing = usage(10, 10);
        missing["tokenUsage"]["total"] = Value::Null;
        t.observe_at("thread/tokenUsage/updated", &missing, 100);
        assert!(t.finish_at(false, 2000).unwrap()["outputTokens"].is_null());
    }

    #[test]
    fn pure_text_has_no_generation_metric_and_uses_native_turn_duration() {
        let mut t = tracker(true);
        text("item/started", &mut t, 0);
        text("item/agentMessage/delta", &mut t, 100);
        text("item/agentMessage/delta", &mut t, 1100);
        text("item/completed", &mut t, 1200);
        t.observe_at("thread/tokenUsage/updated", &usage(10, 10), 1400);
        let terminal = json!({"threadId":"thread","turn":{"id":"turn","status":"completed","durationMs":1700}});
        let final_report = t.observe_at("turn/completed", &terminal, 9000).unwrap();
        assert_eq!(final_report["elapsedMs"], 1700);
        assert!(final_report["generation"].is_null());
        assert_eq!(final_report["generationReason"], "unavailable_timing");
        assert!(t.finish_at(false, 10000).is_none());
    }

    #[test]
    fn initial_zero_and_input_only_updates_do_not_count_as_output_responses() {
        let mut t = tracker(true);
        let mut initial = usage(0, 0);
        initial["tokenUsage"]["total"]["inputTokens"] = json!(100);
        t.observe_at("thread/tokenUsage/updated", &initial, 0);
        initial["tokenUsage"]["total"]["inputTokens"] = json!(200);
        t.observe_at("thread/tokenUsage/updated", &initial, 1000);
        text("item/started", &mut t, 1100);
        text("item/agentMessage/delta", &mut t, 1200);
        text("item/agentMessage/delta", &mut t, 2200);
        text("item/completed", &mut t, 2300);
        t.observe_at("thread/tokenUsage/updated", &usage(10, 10), 2400);
        t.observe_at("thread/tokenUsage/updated", &usage(10, 10), 2500);
        let final_report = t.finish_at(false, 3000).unwrap();
        assert_eq!(final_report["outputTokens"], 10);
        assert!(final_report["generation"].is_null());
        assert_eq!(final_report["generationReason"], "unavailable_timing");
    }

    #[test]
    fn tool_rounds_keep_turn_totals_but_have_no_decode_metric() {
        let mut t = tracker(true);
        t.observe_at("thread/tokenUsage/updated", &usage(10, 10), 100);
        t.observe_at(
            "item/started",
            &json!({"threadId":"thread","turnId":"turn","item":{"type":"commandExecution"}}),
            200,
        );
        t.observe_at("thread/tokenUsage/updated", &usage(30, 20), 1200);
        let report = t.finish_at(false, 2000).unwrap();
        assert_eq!(report["outputTokens"], 30);
        assert!(report["generation"].is_null());
        assert_eq!(report["generationReason"], "unavailable_timing");
    }

    #[test]
    fn cancel_and_failure_flush_partial_and_bad_duration_falls_back() {
        for status in ["failed", "interrupted"] {
            let mut t = tracker(true);
            t.observe_at("thread/tokenUsage/updated", &usage(10, 10), 100);
            let terminal =
                json!({"threadId":"thread","turn":{"id":"turn","status":status,"durationMs":-1}});
            let report = t.observe_at("turn/completed", &terminal, 500).unwrap();
            assert_eq!(report["status"], "partial");
            assert_eq!(report["elapsedMs"], 500);
            assert!(report["generation"].is_null());
        }
        let mut t = tracker(true);
        t.observe_at("thread/tokenUsage/updated", &usage(4, 4), 100);
        assert_eq!(t.finish_at(true, 200).unwrap()["status"], "partial");
    }

    #[test]
    fn fast_notifications_bind_only_on_turn_started_before_ack() {
        let mut t = CodexThroughput::default();
        t.begin("thread", true);
        assert!(t
            .observe_at("thread/tokenUsage/updated", &usage(999, 999), 0)
            .is_none());
        t.observe_at(
            "turn/started",
            &json!({"threadId":"thread","turn":{"id":"turn"}}),
            1,
        );
        t.observe_at("thread/tokenUsage/updated", &usage(5, 5), 2);
        let final_report = t
            .observe_at(
                "turn/completed",
                &json!({"threadId":"thread","turn":{"id":"turn","status":"completed"}}),
                3,
            )
            .unwrap();
        assert_eq!(final_report["outputTokens"], 5);
    }

    #[test]
    fn reasoning_missing_breakdown_and_non_streaming_do_not_claim_decode_speed() {
        for reason in ["reasoning", "ambiguous", "non_streaming"] {
            let mut t = tracker(true);
            if reason != "non_streaming" {
                text("item/agentMessage/delta", &mut t, 100);
                text("item/agentMessage/delta", &mut t, 1100);
            }
            text("item/completed", &mut t, 1200);
            let mut report = usage(10, 10);
            if reason == "reasoning" {
                report["tokenUsage"]["last"]["reasoningOutputTokens"] = json!(5);
            } else if reason == "ambiguous" {
                report["tokenUsage"]["last"]["reasoningOutputTokens"] = Value::Null;
            }
            t.observe_at("thread/tokenUsage/updated", &report, 1400);
            let final_report = t.finish_at(false, 2000).unwrap();
            assert_eq!(final_report["outputTokens"], 10);
            assert!(final_report["generation"].is_null());
            assert_eq!(final_report["generationReason"], "unavailable_timing");
        }
    }

    #[test]
    fn missing_usage_and_conflicting_identity_do_not_change_successful_lifecycle() {
        let mut t = tracker(true);
        t.observe_at("thread/tokenUsage/updated", &usage(10, 10), 100);
        let mut missing = usage(20, 10);
        missing["tokenUsage"]["total"] = Value::Null;
        t.observe_at("thread/tokenUsage/updated", &missing, 1100);
        let report = t.finish_at(false, 2000).unwrap();
        assert_eq!(report["status"], "complete");
        assert_eq!(report["turnReason"], "missing_usage");
        let mut t = tracker(true);
        t.observe_at("thread/tokenUsage/updated", &usage(10, 10), 100);
        t.acknowledge(Some("different"));
        assert!(t.finish_at(false, 2000).unwrap()["outputTokens"].is_null());
        let report = CodexThroughput::default().finish_at(true, 0).unwrap();
        assert!(report["elapsedMs"].is_null());
        assert_eq!(report["generationReason"], "unavailable_timing");
        assert_eq!(report["turnReason"], "unsupported");
    }
}
