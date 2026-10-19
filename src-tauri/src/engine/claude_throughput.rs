//! Bounded metadata only: native usage-report intervals, never text/chunk timing.
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

const MAX_MESSAGES: usize = 256;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn safe_count(value: &Value) -> Option<u64> {
    value.as_u64().filter(|count| *count <= MAX_SAFE_INTEGER)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(t: &mut ClaudeThroughput, now: Instant, event: Value) -> Option<Value> {
        t.observe(
            &json!({"type":"stream_event","parent_tool_use_id":null,"event":event}),
            now,
        )
    }
    fn start(t: &mut ClaudeThroughput, now: Instant, id: &str, tokens: u64) {
        event(
            t,
            now,
            json!({"type":"message_start","message":{"id":id,"usage":{"output_tokens":tokens}}}),
        );
    }
    fn delta(t: &mut ClaudeThroughput, now: Instant, tokens: u64) {
        event(
            t,
            now,
            json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":tokens}}),
        );
    }
    fn stop(t: &mut ClaudeThroughput, now: Instant, tokens: u64) {
        delta(t, now, tokens);
        event(t, now, json!({"type":"message_stop"}));
    }
    fn result(t: &mut ClaudeThroughput, now: Instant) -> Value {
        t.observe(&json!({"type":"result","subtype":"success","usage":{"output_tokens":120},"duration_ms":4000,"duration_api_ms":500}), now).unwrap()
    }
    fn expected(tokens: u64, ms: u64, samples: u64, excluded: u64) -> Value {
        json!({"basis":"usage_reports","outputTokens":tokens,"elapsedMs":ms,"samples":samples,"excludedSamples":excluded})
    }

    #[test]
    fn native_baseline_and_final_report_are_independent_of_chunks() {
        let now = Instant::now();
        for chunks in [0, 1, 20] {
            let mut t = ClaudeThroughput::default();
            start(&mut t, now, "a", 7);
            for i in 0..chunks {
                event(
                    &mut t,
                    now + Duration::from_millis(i),
                    json!({"type":"content_block_delta","delta":{"type":"text_delta","text":"你🙂"}}),
                );
            }
            stop(&mut t, now + Duration::from_millis(500), 27);
            let value = result(&mut t, now);
            assert_eq!(value["outputRate"], expected(20, 500, 1, 0));
            assert!(value["generation"].is_null());
            assert_eq!(value["generationReason"], "unavailable_timing");
            assert_eq!(value["outputTokens"], 120);
            assert_eq!(value["elapsedMs"], 4000);
            assert!(value["turnReason"].is_null());
        }
    }

    #[test]
    fn thinking_and_client_tool_arguments_count_but_between_request_wait_does_not() {
        let now = Instant::now();
        let mut t = ClaudeThroughput::default();
        start(&mut t, now, "a", 2);
        for kind in ["thinking", "redacted_thinking", "tool_use"] {
            event(
                &mut t,
                now,
                json!({"type":"content_block_start","content_block":{"type":kind}}),
            );
        }
        event(
            &mut t,
            now,
            json!({"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}),
        );
        delta(&mut t, now + Duration::from_millis(200), 12);
        event(
            &mut t,
            now + Duration::from_millis(200),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":12}}),
        );
        event(
            &mut t,
            now + Duration::from_millis(200),
            json!({"type":"message_stop"}),
        );
        t.observe(
            &json!({"type":"user","message":{"content":[{"type":"tool_result"}]}}),
            now,
        );
        start(&mut t, now + Duration::from_secs(60), "b", 5);
        stop(&mut t, now + Duration::from_millis(60300), 25);
        assert_eq!(result(&mut t, now)["outputRate"], expected(30, 500, 2, 0));
    }

    #[test]
    fn bad_later_requests_preserve_completed_samples() {
        let now = Instant::now();
        for bad in [
            "incomplete",
            "rollback",
            "duplicate",
            "retry",
            "server",
            "mismatch",
            "missing_usage",
            "missing_baseline",
        ] {
            let mut t = ClaudeThroughput::default();
            start(&mut t, now, "a", 3);
            stop(&mut t, now + Duration::from_millis(100), 13);
            start(
                &mut t,
                now + Duration::from_secs(1),
                if bad == "duplicate" { "a" } else { "b" },
                5,
            );
            match bad {
                "rollback" => {
                    delta(&mut t, now + Duration::from_millis(1100), 20);
                    delta(&mut t, now + Duration::from_millis(1200), 10);
                }
                "retry" => {
                    t.observe(&json!({"type":"system","subtype":"api_retry"}), now);
                }
                "server" => {
                    event(
                        &mut t,
                        now,
                        json!({"type":"content_block_start","content_block":{"type":"server_tool_use"}}),
                    );
                }
                "mismatch" => {
                    event(
                        &mut t,
                        now,
                        json!({"type":"message_delta","message_id":"other","usage":{"output_tokens":8}}),
                    );
                }
                "missing_usage" => {
                    event(&mut t, now, json!({"type":"message_delta","usage":{}}));
                }
                "missing_baseline" => {
                    t.message.as_mut().unwrap().baseline = None;
                }
                _ => {}
            }
            if bad != "incomplete" {
                stop(&mut t, now + Duration::from_millis(1500), 30);
            }
            assert_eq!(
                result(&mut t, now)["outputRate"],
                expected(10, 100, 1, 1),
                "{bad}"
            );
        }
    }

    #[test]
    fn child_and_assistant_usage_never_supply_or_overwrite_reports() {
        let now = Instant::now();
        let mut t = ClaudeThroughput::default();
        start(&mut t, now, "a", 8);
        assert!(t.observe(&json!({"type":"stream_event","parent_tool_use_id":"child","event":{"type":"message_start","message":{"id":"child"}}}), now).is_none());
        assert!(t.observe(&json!({"type":"result","parent_tool_use_id":"child","usage":{"output_tokens":999}}), now).is_none());
        t.observe(
            &json!({"type":"assistant","message":{"id":"a","usage":{"output_tokens":999}}}),
            now,
        );
        delta(&mut t, now + Duration::from_millis(20), 10);
        delta(&mut t, now + Duration::from_millis(30), 10);
        stop(&mut t, now + Duration::from_millis(40), 18);
        assert_eq!(result(&mut t, now)["outputRate"], expected(10, 40, 1, 0));
    }

    #[test]
    fn turn_reasons_and_interrupt_are_independent_and_next_turn_resets() {
        let now = Instant::now();
        let mut t = ClaudeThroughput::default();
        start(&mut t, now, "a", 1);
        stop(&mut t, now + Duration::from_millis(100), 11);
        start(&mut t, now, "b", 1);
        t.observe(&json!({"type":"control_response","response":{"subtype":"success","request_id":format!("{}1", super::super::INTERRUPT_REQUEST_ID_PREFIX)}}), now);
        let value = result(&mut t, now);
        assert_eq!(value["status"], "partial");
        assert_eq!(value["turnReason"], "interrupted");
        assert_eq!(value["outputRate"], expected(10, 100, 1, 1));
        start(&mut t, now, "a", 2);
        stop(&mut t, now + Duration::from_millis(50), 5);
        assert_eq!(result(&mut t, now)["outputRate"], expected(3, 50, 1, 0));
        for (input, reason) in [
            (
                json!({"type":"result","duration_api_ms":50}),
                "missing_usage",
            ),
            (
                json!({"type":"result","usage":{"output_tokens":2},"duration_ms":0}),
                "missing_timing",
            ),
            (json!({"type":"result","is_error":true}), "interrupted"),
        ] {
            assert_eq!(t.observe(&input, now).unwrap()["turnReason"], reason);
        }
    }

    #[test]
    fn zero_timing_missing_final_and_unsafe_counts_are_excluded() {
        let now = Instant::now();
        for bad in ["zero", "final", "unsafe", "identity", "backwards"] {
            let mut t = ClaudeThroughput::default();
            start(&mut t, now, if bad == "identity" { "" } else { "a" }, 1);
            if bad == "final" {
                event(
                    &mut t,
                    now + Duration::from_millis(100),
                    json!({"type":"message_delta","usage":{"output_tokens":10}}),
                );
                event(&mut t, now, json!({"type":"message_stop"}));
            } else {
                stop(
                    &mut t,
                    if bad == "zero" {
                        now
                    } else if bad == "backwards" {
                        now - Duration::from_millis(1)
                    } else {
                        now + Duration::from_millis(100)
                    },
                    if bad == "unsafe" {
                        MAX_SAFE_INTEGER + 1
                    } else {
                        10
                    },
                );
            }
            assert_eq!(
                result(&mut t, now)["outputRate"],
                expected(0, 0, 0, 1),
                "{bad}"
            );
        }
    }

    #[test]
    fn aggregate_overflow_excludes_only_new_sample_and_identity_storage_is_bounded() {
        let now = Instant::now();
        let mut t = ClaudeThroughput::default();
        start(&mut t, now, "a", 0);
        stop(&mut t, now + Duration::from_millis(1), MAX_SAFE_INTEGER);
        start(&mut t, now, "b", 0);
        stop(&mut t, now + Duration::from_millis(1), 1);
        assert_eq!(
            result(&mut t, now)["outputRate"],
            expected(MAX_SAFE_INTEGER, 1, 1, 1)
        );
        for i in 0..MAX_MESSAGES + 5 {
            start(&mut t, now, &i.to_string(), 0);
            stop(&mut t, now + Duration::from_millis(1), 1);
        }
        assert_eq!(t.seen.len(), MAX_MESSAGES);
        assert_eq!(
            result(&mut t, now)["outputRate"],
            expected(256, 256, 256, 5)
        );
    }

    #[test]
    fn late_server_tool_snapshot_revokes_only_its_own_sample() {
        let now = Instant::now();
        let mut t = ClaudeThroughput::default();
        for id in ["a", "b"] {
            start(&mut t, now, id, 1);
            stop(&mut t, now + Duration::from_millis(100), 11);
        }
        t.observe(&json!({"type":"assistant","message":{"id":"a","content":[{"type":"server_tool_use"}]}}), now);
        assert_eq!(result(&mut t, now)["outputRate"], expected(10, 100, 1, 1));
    }

    #[test]
    fn live_emissions_are_throttled_and_terminal_flushes() {
        let now = Instant::now();
        let mut t = ClaudeThroughput::default();
        start(&mut t, now, "a", 1);
        for ms in 1..1000 {
            assert!(event(
                &mut t,
                now + Duration::from_millis(ms),
                json!({"type":"ping"})
            )
            .is_none());
        }
        let value = event(&mut t, now + Duration::from_secs(1), json!({"type":"ping"})).unwrap();
        assert_eq!(value["status"], "running");
        assert!(value["outputTokens"].is_null());
        assert!(value["elapsedMs"].is_null());
        assert_eq!(
            result(&mut t, now + Duration::from_millis(1001))["status"],
            "complete"
        );
    }
}

#[derive(Default)]
pub(super) struct ClaudeThroughput {
    active: bool,
    ended: bool,
    last_emitted: Option<Instant>,
    message: Option<Message>,
    seen: HashSet<String>,
    samples: HashMap<String, (u64, u64)>,
    excluded: u64,
    interrupted: bool,
}

struct Message {
    id: Option<String>,
    start: Instant,
    baseline: Option<u64>,
    latest: Option<(u64, Instant)>,
    final_delta: bool,
    invalid: bool,
}

impl ClaudeThroughput {
    fn begin(&mut self, now: Instant) {
        if !self.active || self.ended {
            *self = Self {
                active: true,
                last_emitted: Some(now),
                ..Self::default()
            };
        }
    }

    fn invalidate(&mut self) {
        if let Some(message) = &mut self.message {
            message.invalid = true;
        }
    }

    fn finish_message(&mut self, stopped: bool) {
        let Some(message) = self.message.take() else {
            return;
        };
        let sample = message
            .baseline
            .zip(message.latest)
            .and_then(|(baseline, (end, at))| {
                let tokens = end.checked_sub(baseline)?;
                let millis =
                    u64::try_from(at.checked_duration_since(message.start)?.as_millis()).ok()?;
                (stopped && !message.invalid && message.final_delta && millis > 0)
                    .then_some((tokens, millis))
            });
        let sample = sample.filter(|(tokens, millis)| {
            self.samples
                .values()
                .try_fold(
                    (*tokens, *millis),
                    |(tokens, millis), (next_tokens, next_millis)| {
                        Some((
                            tokens.checked_add(*next_tokens)?,
                            millis.checked_add(*next_millis)?,
                        ))
                    },
                )
                .is_some_and(|(tokens, millis)| {
                    tokens <= MAX_SAFE_INTEGER && millis <= MAX_SAFE_INTEGER
                })
        });
        if let Some((id, sample)) = message.id.zip(sample) {
            self.samples.insert(id, sample);
        } else {
            self.excluded = self.excluded.saturating_add(1);
        }
    }

    pub(super) fn observe(&mut self, value: &Value, now: Instant) -> Option<Value> {
        if value
            .get("parent_tool_use_id")
            .is_some_and(|parent| !parent.is_null())
        {
            return None;
        }
        match value.get("type").and_then(Value::as_str) {
            Some("result") => {
                self.begin(now);
                let partial = self.interrupted
                    || value.get("is_error").and_then(Value::as_bool) == Some(true)
                    || value
                        .get("subtype")
                        .and_then(Value::as_str)
                        .is_some_and(|subtype| subtype.starts_with("error"));
                self.finish_message(false);
                let output = value.pointer("/usage/output_tokens").and_then(safe_count);
                let elapsed = value.get("duration_ms").and_then(safe_count);
                let reason = if partial {
                    Some("interrupted")
                } else if output.is_none() {
                    Some("missing_usage")
                } else if !elapsed.is_some_and(|ms| ms > 0) {
                    Some("missing_timing")
                } else {
                    None
                };
                self.ended = true;
                self.last_emitted = Some(now);
                return Some(self.snapshot(
                    if partial { "partial" } else { "complete" },
                    output,
                    elapsed,
                    reason,
                ));
            }
            Some("stream_event") => {
                self.begin(now);
                if let Some(event) = value.get("event") {
                    self.stream(event, now);
                }
            }
            Some("assistant") => {
                self.begin(now);
                // Assistant usage may be a placeholder; never use it as a report.
                if value
                    .pointer("/message/content")
                    .and_then(Value::as_array)
                    .is_some_and(|blocks| {
                        blocks.iter().any(|block| {
                            block.get("type").and_then(Value::as_str) == Some("server_tool_use")
                        })
                    })
                {
                    let id = value.pointer("/message/id").and_then(Value::as_str);
                    if self
                        .message
                        .as_ref()
                        .is_some_and(|message| message.id.as_deref() == id)
                    {
                        self.invalidate();
                    }
                    if let Some(id) = id {
                        if self.samples.remove(id).is_some() {
                            self.excluded = self.excluded.saturating_add(1);
                        }
                    }
                }
            }
            Some("system") if self.active && !self.ended => {
                if value.get("subtype").and_then(Value::as_str) == Some("api_retry") {
                    self.finish_message(false);
                }
            }
            Some("control_response") if self.active && !self.ended => {
                if value.pointer("/response/subtype").and_then(Value::as_str) == Some("success")
                    && value
                        .pointer("/response/request_id")
                        .and_then(Value::as_str)
                        .is_some_and(|id| id.starts_with(super::INTERRUPT_REQUEST_ID_PREFIX))
                {
                    self.interrupted = true;
                    self.invalidate();
                }
            }
            _ => return None,
        }
        if self.active
            && !self.ended
            && self.last_emitted.is_some_and(|previous| {
                now.saturating_duration_since(previous) >= Duration::from_secs(1)
            })
        {
            self.last_emitted = Some(now);
            Some(self.snapshot("running", None, None, None))
        } else {
            None
        }
    }

    fn stream(&mut self, event: &Value, now: Instant) {
        // Native deltas have no ID; the single open root message is their boundary.
        // If an explicit ID is supplied it must agree with that boundary.
        if event.get("type").and_then(Value::as_str) != Some("message_start") {
            for id in [event.get("message_id"), event.pointer("/message/id")]
                .into_iter()
                .flatten()
            {
                if !self.message.as_ref().is_some_and(|message| {
                    id.as_str().is_some() && id.as_str() == message.id.as_deref()
                }) {
                    self.invalidate();
                    return;
                }
            }
        }
        match event.get("type").and_then(Value::as_str) {
            Some("message_start") => {
                self.finish_message(false);
                let id = event
                    .pointer("/message/id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty() && id.len() <= 4096);
                let id = id
                    .filter(|id| self.seen.len() < MAX_MESSAGES && !self.seen.contains(*id))
                    .map(str::to_owned);
                if let Some(id) = &id {
                    self.seen.insert(id.clone());
                }
                self.message = Some(Message {
                    invalid: id.is_none() || self.interrupted,
                    id,
                    start: now,
                    baseline: event
                        .pointer("/message/usage/output_tokens")
                        .and_then(safe_count),
                    latest: None,
                    final_delta: false,
                });
            }
            Some("message_delta") => {
                if let Some(message) = &mut self.message {
                    let tokens = event.pointer("/usage/output_tokens").and_then(safe_count);
                    if let Some(tokens) = tokens {
                        let previous = message
                            .latest
                            .map(|(tokens, _)| tokens)
                            .or(message.baseline);
                        if previous.is_some_and(|previous| tokens < previous)
                            || message.latest.is_some_and(|(_, previous)| now < previous)
                        {
                            message.invalid = true;
                        }
                        message.latest = Some((tokens, now));
                    } else {
                        message.invalid = true;
                    }
                    // A terminal delta (including tool_use/max_tokens) is required.
                    message.final_delta = event
                        .pointer("/delta/stop_reason")
                        .and_then(Value::as_str)
                        .is_some_and(|reason| !reason.is_empty());
                }
            }
            Some("message_stop") => self.finish_message(true),
            Some("content_block_start")
                if event.pointer("/content_block/type").and_then(Value::as_str)
                    == Some("server_tool_use") =>
            {
                self.invalidate()
            }
            Some("error") => self.invalidate(),
            _ => {}
        }
    }

    fn snapshot(
        &self,
        status: &str,
        output: Option<u64>,
        elapsed: Option<u64>,
        reason: Option<&str>,
    ) -> Value {
        let totals = self.samples.values().try_fold(
            (0_u64, 0_u64),
            |(tokens, ms), (next_tokens, next_ms)| {
                Some((tokens.checked_add(*next_tokens)?, ms.checked_add(*next_ms)?))
            },
        );
        let rate = totals
            .filter(|_| !self.samples.is_empty() || self.excluded > 0)
            .map(|(tokens, ms)| {
                json!({
                    "basis":"usage_reports", "outputTokens":tokens, "elapsedMs":ms,
                    "samples":self.samples.len(), "excludedSamples":self.excluded,
                })
            });
        json!({
            "version":1, "source":"claude", "status":status,
            "outputTokens":output, "elapsedMs":elapsed, "turnReason":reason,
            "generation":null, "generationReason":"unavailable_timing", "outputRate":rate,
        })
    }
}
