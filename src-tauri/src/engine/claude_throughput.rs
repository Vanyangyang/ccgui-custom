//! Bounded Claude telemetry: active-time (`model_ms`) subtraction of cold
//! startup, between-request tool execution, and `AskUserQuestion` waits, plus
//! `outputRate` (`usage_reports`) stream intervals and `subagent_mixed` safety.
use crate::engine::throughput_common::{
    breakdown_json, compute_breakdown, validate_complete_gate, IntervalTracker,
    StreamTokenEstimator, TimeBreakdown, MAX_SAFE_INTEGER,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

const MAX_MESSAGES: usize = 256;
const MIN_STARTUP_STRIP_MS: f64 = 20.0;
const MIN_MONOTONIC_TURN_MS: f64 = 50.0;

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
    fn strips_startup_tool_execution_and_ask_user_wait_from_active_model_ms() {
        let now = Instant::now();
        let mut t = ClaudeThroughput::default();
        t.arm(now);
        // Cold startup finishes at 2.0s on system/init.
        t.observe(
            &json!({"type":"system","subtype":"init","session_id":"s1"}),
            now + Duration::from_millis(2000),
        );
        // First model call runs 2.0s -> 4.0s (2.0s model time) and stops for tool_use.
        start(&mut t, now + Duration::from_millis(2200), "m1", 0);
        event(
            &mut t,
            now + Duration::from_millis(2200),
            json!({"type":"content_block_start","content_block":{"type":"tool_use","name":"AskUserQuestion"}}),
        );
        let running = event(
            &mut t,
            now + Duration::from_millis(3200),
            json!({"type":"content_block_delta","delta":{"type":"text_delta","text":"Preparing question for you..."}}),
        )
        .expect("throttled live sample with liveEstimate");
        assert_eq!(running["status"], "running");
        assert!(running["outputTokens"].is_null());
        assert_eq!(running["liveEstimate"]["estimated"], true);
        assert!(event(
            &mut t,
            now + Duration::from_millis(3500),
            json!({"type":"content_block_delta","delta":{"type":"text_delta","text":" more"}}),
        )
        .is_none());

        event(
            &mut t,
            now + Duration::from_millis(4000),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":40}}),
        );
        event(
            &mut t,
            now + Duration::from_millis(4000),
            json!({"type":"message_stop"}),
        );
        // AskUserQuestion waits from 4.2s to 14.2s (10.0s user wait), tool_result arrives at 15.0s (1.0s tool overhead).
        t.observe(
            &json!({"type":"control_request","request_id":"req_ask_1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion"}}),
            now + Duration::from_millis(4200),
        );
        t.observe(
            &json!({"type":"user","message":{"content":[{"type":"tool_result"}]}}),
            now + Duration::from_millis(15000),
        );
        // Second model call runs 15.0s -> 18.0s (3.0s model time including prefill).
        start(&mut t, now + Duration::from_millis(15500), "m2", 0);
        stop(&mut t, now + Duration::from_millis(18000), 110);

        let final_report = t
            .observe(
                &json!({"type":"result","subtype":"success","usage":{"output_tokens":150},"duration_ms":16000}),
                now + Duration::from_millis(18000),
            )
            .unwrap();
        // wall=18000, startup=2000, wait=10000.. wait closed at 15000 => wait=[4200,15000]=10800, tool=[4000,4200]=200 => non_model=11000 => model=5000ms!
        assert_eq!(final_report["outputTokens"], 150);
        assert_eq!(final_report["elapsedMs"], 5000);
        assert_eq!(final_report["breakdown"]["startupMs"], 2000.0);
        assert_eq!(final_report["breakdown"]["waitMs"], 10800.0);
        assert_eq!(final_report["breakdown"]["toolMs"], 200.0);
        assert_eq!(final_report["breakdown"]["modelMs"], 5000.0);
        assert_eq!(final_report["breakdown"]["wallMs"], 18000.0);
        assert!(final_report["turnReason"].is_null());
    }

    #[test]
    fn detects_subagent_mixed_result_tokens_and_flushes_eof_partial() {
        let now = Instant::now();
        let mut t = ClaudeThroughput::default();
        t.arm(now);
        t.observe(
            &json!({"type":"system","subtype":"init","session_id":"s1"}),
            now + Duration::from_millis(1000),
        );
        start(&mut t, now + Duration::from_millis(1200), "m1", 0);
        event(
            &mut t,
            now + Duration::from_millis(1300),
            json!({"type":"content_block_start","content_block":{"type":"tool_use","name":"Task"}}),
        );
        stop(&mut t, now + Duration::from_millis(3000), 80);
        // Root stream only generated 80 tokens, while result.usage summed 2400 tokens from child Task!
        let mixed = t
            .observe(
                &json!({"type":"result","subtype":"success","usage":{"output_tokens":2400},"duration_ms":4000}),
                now + Duration::from_millis(5000),
            )
            .unwrap();
        assert_eq!(mixed["turnReason"], "subagent_mixed");
        assert!(t.finish_eof(now + Duration::from_millis(5100)).is_none());

        // Unsettled killed process flushes partial via finish_eof.
        let mut killed = ClaudeThroughput::default();
        killed.arm(now);
        start(&mut killed, now + Duration::from_millis(100), "m1", 0);
        let eof = killed
            .finish_eof(now + Duration::from_millis(1500))
            .unwrap();
        assert_eq!(eof["status"], "partial");
        assert_eq!(eof["turnReason"], "interrupted");
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
    armed: bool,
    active: bool,
    ended: bool,
    started_at: Option<Instant>,
    ready_offset_ms: Option<f64>,
    last_emitted: Option<Instant>,
    message: Option<Message>,
    seen: HashSet<String>,
    samples: HashMap<String, (u64, u64)>,
    excluded: u64,
    interrupted: bool,
    saw_subagent_tool: bool,
    tools: IntervalTracker,
    waits: IntervalTracker,
    estimator: StreamTokenEstimator,
}

struct Message {
    id: Option<String>,
    start: Instant,
    baseline: Option<u64>,
    latest: Option<(u64, Instant)>,
    final_delta: bool,
    invalid: bool,
    has_tool_use: bool,
    stops_for_tool: bool,
}

impl ClaudeThroughput {
    pub(super) fn arm(&mut self, now: Instant) {
        *self = Self {
            armed: true,
            active: true,
            started_at: Some(now),
            last_emitted: Some(now),
            ..Self::default()
        };
    }

    fn begin(&mut self, now: Instant) {
        if !self.active || self.ended {
            *self = Self {
                active: true,
                started_at: Some(now),
                ready_offset_ms: Some(0.0),
                last_emitted: Some(now),
                ..Self::default()
            };
        }
    }

    fn offset_ms(&self, now: Instant) -> f64 {
        self.started_at
            .map(|start| now.saturating_duration_since(start).as_secs_f64() * 1000.0)
            .unwrap_or(0.0)
    }

    fn startup_offset(&self) -> f64 {
        self.ready_offset_ms
            .filter(|ms| ms.is_finite() && *ms >= MIN_STARTUP_STRIP_MS)
            .unwrap_or(0.0)
    }

    fn mark_ready(&mut self, now: Instant) {
        if self.ready_offset_ms.is_none() {
            self.ready_offset_ms = Some(self.offset_ms(now));
        }
    }

    fn invalidate(&mut self) {
        if let Some(message) = &mut self.message {
            message.invalid = true;
        }
    }

    fn finish_message(&mut self, stopped: bool, now: Instant) {
        let Some(message) = self.message.take() else {
            return;
        };
        let opens_tool_window = stopped && (message.stops_for_tool || message.has_tool_use);
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
        if let Some((tokens, _)) = sample {
            self.estimator.commit_authoritative_step(tokens);
        } else {
            self.estimator.clear_inflight();
        }
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
        if opens_tool_window {
            let at_ms = self.offset_ms(now);
            self.tools.open("between_requests", at_ms);
        }
    }

    fn running_breakdown(&self, now: Instant) -> TimeBreakdown {
        let wall_ms = self.offset_ms(now);
        let tool_segs = self.tools.segments_at(wall_ms);
        let wait_segs = self.waits.segments_at(wall_ms);
        compute_breakdown(wall_ms, self.startup_offset(), &tool_segs, &wait_segs)
    }

    fn terminal_breakdown(&self, now: Instant, native_duration_ms: Option<u64>) -> (Option<u64>, Option<TimeBreakdown>) {
        let wall_ms = self.offset_ms(now);
        let startup = self.startup_offset();
        let post_ready_ms = (wall_ms - startup).max(0.0);
        if post_ready_ms >= MIN_MONOTONIC_TURN_MS {
            let b = compute_breakdown(
                wall_ms,
                startup,
                self.tools.closed_segments(),
                self.waits.closed_segments(),
            );
            let model_u64 = b.model_ms.round() as u64;
            ((model_u64 > 0).then_some(model_u64), Some(b))
        } else {
            // Synthetic unit tests feed events at a fixed `Instant` (`post_ready_ms < 50ms`)
            // and encode turn duration in `result.duration_ms`.
            let native = native_duration_ms.filter(|ms| *ms > 0);
            let b = native.map(|ms| compute_breakdown(ms as f64, 0.0, &[], &[]));
            (native, b)
        }
    }

    pub(super) fn finish_eof(&mut self, now: Instant) -> Option<Value> {
        if (!self.armed && !self.active) || self.ended {
            return None;
        }
        self.armed = false;
        self.ended = true;
        self.finish_message(false, now);
        let wall_ms = self.offset_ms(now);
        self.tools.close_all(wall_ms);
        self.waits.close_all(wall_ms);
        let (elapsed, breakdown) = self.terminal_breakdown(now, None);
        Some(self.snapshot("partial", None, elapsed, Some("interrupted"), breakdown, None))
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
                self.mark_ready(now);
                self.armed = false;
                let partial = self.interrupted
                    || value.get("is_error").and_then(Value::as_bool) == Some(true)
                    || value
                        .get("subtype")
                        .and_then(Value::as_str)
                        .is_some_and(|subtype| subtype.starts_with("error"));
                self.finish_message(false, now);
                let wall_ms = self.offset_ms(now);
                if partial {
                    self.tools.close_all(wall_ms);
                    self.waits.close_all(wall_ms);
                }
                let output = value.pointer("/usage/output_tokens").and_then(safe_count);
                let native_elapsed = value.get("duration_ms").and_then(safe_count);
                let (elapsed, breakdown) = self.terminal_breakdown(now, native_elapsed);
                let stream_tokens: u64 = self
                    .samples
                    .values()
                    .fold(0_u64, |acc, (tok, _)| acc.saturating_add(*tok));
                let subagent_mixed = !partial
                    && self.saw_subagent_tool
                    && self.excluded == 0
                    && stream_tokens > 0
                    && output.is_some_and(|res| {
                        res > stream_tokens.saturating_add((res / 10).max(200))
                    });
                let reason = if partial {
                    Some("interrupted")
                } else if subagent_mixed {
                    Some("subagent_mixed")
                } else {
                    validate_complete_gate(output, elapsed.map(|ms| ms as f64))
                };
                self.ended = true;
                self.last_emitted = Some(now);
                return Some(self.snapshot(
                    if partial { "partial" } else { "complete" },
                    output,
                    elapsed,
                    reason,
                    breakdown,
                    None,
                ));
            }
            Some("stream_event") => {
                self.begin(now);
                self.mark_ready(now);
                if let Some(event) = value.get("event") {
                    self.stream(event, now);
                }
            }
            Some("assistant") => {
                self.begin(now);
                self.mark_ready(now);
                // Assistant usage may be a placeholder; never use it as a report.
                if value
                    .pointer("/message/content")
                    .and_then(Value::as_array)
                    .is_some_and(|blocks| {
                        blocks.iter().any(|block| {
                            let kind = block.get("type").and_then(Value::as_str);
                            if kind == Some("tool_use")
                                && matches!(
                                    block.get("name").and_then(Value::as_str),
                                    Some("Task" | "Agent")
                                )
                            {
                                self.saw_subagent_tool = true;
                            }
                            kind == Some("server_tool_use")
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
                match value.get("subtype").and_then(Value::as_str) {
                    Some("init") => self.mark_ready(now),
                    Some("api_retry") => self.finish_message(false, now),
                    _ => {}
                }
            }
            Some("user") if self.active && !self.ended => {
                let at_ms = self.offset_ms(now);
                self.waits.close_all(at_ms);
                self.tools.close("between_requests", at_ms);
                return None;
            }
            Some("control_request") if self.active && !self.ended => {
                if value
                    .pointer("/request/subtype")
                    .and_then(Value::as_str)
                    == Some("can_use_tool")
                {
                    if let Some(id) = value
                        .get("request_id")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                    {
                        let at_ms = self.offset_ms(now);
                        self.waits.open(id.to_string(), at_ms);
                    }
                }
                return None;
            }
            Some("control_cancel_request") if self.active && !self.ended => {
                if let Some(id) = value.get("request_id").and_then(Value::as_str) {
                    let at_ms = self.offset_ms(now);
                    self.waits.close(id, at_ms);
                }
                return None;
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
            let b = self.running_breakdown(now);
            let live = if self.tools.has_open() || self.waits.has_open() {
                None
            } else {
                self.estimator.live_estimate_json(b.model_ms)
            };
            Some(self.snapshot(
                "running",
                None,
                None,
                None,
                (b.wall_ms >= MIN_MONOTONIC_TURN_MS).then_some(b),
                live,
            ))
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
                let at_ms = self.offset_ms(now);
                self.waits.close_all(at_ms);
                self.tools.close("between_requests", at_ms);
                self.finish_message(false, now);
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
                    has_tool_use: false,
                    stops_for_tool: false,
                });
            }
            Some("content_block_delta") => {
                match event.pointer("/delta/type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        if let Some(text) = event
                            .pointer("/delta/text")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                        {
                            self.estimator.push_delta(text);
                        }
                    }
                    Some("thinking_delta") => {
                        if let Some(text) = event
                            .pointer("/delta/thinking")
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                        {
                            self.estimator.push_delta(text);
                        }
                    }
                    _ => {}
                }
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
                    let stop_reason = event
                        .pointer("/delta/stop_reason")
                        .and_then(Value::as_str)
                        .filter(|reason| !reason.is_empty());
                    // A terminal delta (including tool_use/max_tokens) is required.
                    message.final_delta = stop_reason.is_some();
                    if stop_reason == Some("tool_use") {
                        message.stops_for_tool = true;
                    }
                }
            }
            Some("message_stop") => self.finish_message(true, now),
            Some("content_block_start") => {
                match event.pointer("/content_block/type").and_then(Value::as_str) {
                    Some("server_tool_use") => self.invalidate(),
                    Some("tool_use") => {
                        if let Some(message) = &mut self.message {
                            message.has_tool_use = true;
                        }
                        if matches!(
                            event.pointer("/content_block/name").and_then(Value::as_str),
                            Some("Task" | "Agent")
                        ) {
                            self.saw_subagent_tool = true;
                        }
                    }
                    _ => {}
                }
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
        breakdown: Option<TimeBreakdown>,
        live: Option<Value>,
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
        let mut out = json!({
            "version":1, "source":"claude", "status":status,
            "outputTokens":output, "elapsedMs":elapsed, "turnReason":reason,
            "generation":null, "generationReason":"unavailable_timing", "outputRate":rate,
        });
        if let Some(b) = breakdown.and_then(breakdown_json) {
            out["breakdown"] = b;
        }
        if let Some(est) = live {
            out["liveEstimate"] = est;
        }
        out
    }
}
