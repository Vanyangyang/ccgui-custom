//! Current-launch AGY accounting with active-time (`model_ms`) subtraction of
//! cold startup and root tool/checkpoint execution intervals.
//! Session result totals are never turn totals.
use super::throughput_common::{
    breakdown_json, compute_breakdown, validate_complete_gate, IntervalTracker,
    StreamTokenEstimator, TimeBreakdown, MAX_SAFE_INTEGER,
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant};

const MAX_COUNT: u64 = MAX_SAFE_INTEGER;
/// Startup offsets below 20ms only occur in in-process unit tests (real process
/// spawns take hundreds of ms to seconds); snapping tiny offsets to 0 keeps
/// back-to-back synchronous test calls from observing a zero post-ready window.
const MIN_STARTUP_STRIP_MS: f64 = 20.0;

#[derive(Default)]
pub(super) struct AgyThroughput {
    started: Option<Instant>,
    ready_offset_ms: Option<f64>,
    root: Option<String>,
    boundary: Option<u64>,
    ended: bool,
    invalid_reason: Option<&'static str>,
    steps: BTreeMap<u64, (String, Value)>,
    pending_responses: BTreeSet<u64>,
    tool_steps: BTreeSet<u64>,
    latest_response_index: Option<u64>,
    context: Option<(u64, Value)>,
    /// Latest root step of this turn and whether it is a finished model response.
    last_step: Option<(u64, bool)>,
    tools: IntervalTracker,
    waits: IntervalTracker,
    estimator: StreamTokenEstimator,
    last_live_emit: Option<Instant>,
}

/// AGY's `input_tokens` is the *uncached* prompt and `cache_read_tokens` is the
/// cached prompt on top of it (so cache can exceed input). The cache counter is
/// exposed under both the codex-style `cached_input_tokens` (kept for existing
/// consumers) and the claude-style `cache_read_input_tokens`, the latter telling
/// the frontend the cache sits *outside* `input_tokens`.
pub(super) fn normalize_usage(value: &Value) -> Value {
    let mut usage = value.clone();
    if let Some(object) = usage.as_object_mut() {
        if let Some(cache) = object.remove("cache_read_tokens") {
            object.insert("cached_input_tokens".into(), cache.clone());
            object.insert("cache_read_input_tokens".into(), cache);
        }
        if let Some(thinking) = object.get("thinking_tokens").cloned() {
            object
                .entry("reasoning_output_tokens")
                .or_insert(thinking);
        }
    }
    usage
}

fn count(usage: &Value, key: &str) -> Option<u64> {
    usage.get(key)?.as_u64().filter(|n| *n <= MAX_COUNT)
}

fn valid_usage(usage: &Value) -> bool {
    let (Some(input), Some(output)) = (count(usage, "input_tokens"), count(usage, "output_tokens"))
    else {
        return false;
    };
    let cache = if usage.get("cached_input_tokens").is_some() {
        count(usage, "cached_input_tokens")
    } else {
        Some(0)
    };
    let Some(cache) = cache else {
        return false;
    };
    let plain = input.checked_add(output);
    plain.is_some_and(|n| n <= MAX_COUNT)
        && usage.get("total_tokens").is_none_or(|_| {
            let total = count(usage, "total_tokens");
            total.is_some() && (total == plain || total == plain.and_then(|n| n.checked_add(cache)))
        })
}

impl AgyThroughput {
    pub(super) fn ended(&self) -> bool {
        self.ended
    }
    pub(super) fn root(&self) -> Option<&str> {
        self.root.as_deref()
    }
    pub(super) fn is_child(&self, id: Option<&str>) -> bool {
        self.root
            .as_deref()
            .zip(id)
            .is_some_and(|(root, id)| root != id)
    }
    pub(super) fn claim_tool_step(&mut self, step: &Value) -> bool {
        let Some(index) = step.get("step_index").and_then(Value::as_u64) else {
            return true;
        };
        if self.tool_steps.len() >= 4096 && !self.tool_steps.contains(&index) {
            return true;
        }
        self.tool_steps.insert(index)
    }
    pub(super) fn begin(&mut self, root: Option<&str>, now: Instant) {
        *self = Self {
            started: Some(now),
            root: root.map(str::to_string),
            ..Self::default()
        };
    }

    fn offset_ms(&self, now: Instant) -> f64 {
        self.started
            .map(|start| now.saturating_duration_since(start).as_secs_f64() * 1000.0)
            .unwrap_or(0.0)
    }

    fn startup_offset(&self) -> f64 {
        self.ready_offset_ms
            .filter(|ms| ms.is_finite() && *ms >= MIN_STARTUP_STRIP_MS)
            .unwrap_or(0.0)
    }

    pub(super) fn init(&mut self, id: Option<&str>) {
        if let Some(id) = id {
            if self.root.as_deref().is_some_and(|root| root != id) {
                self.invalid_reason.get_or_insert("invalid_identity");
            } else {
                self.root = Some(id.to_string());
            }
        }
    }

    pub(super) fn step(&mut self, step: &Value, id: Option<&str>, now: Instant) {
        if self.ended {
            return;
        }
        // Never adopt a child's ID or count a frame without proven ownership.
        let Some(root) = self.root.as_deref() else {
            self.invalid_reason.get_or_insert("invalid_identity");
            return;
        };
        let Some(id) = id else {
            self.invalid_reason.get_or_insert("invalid_identity");
            return;
        };
        if id != root {
            return;
        }
        let kind = step.get("step_type").and_then(Value::as_str).unwrap_or("");
        let index = step.get("step_index").and_then(Value::as_u64);
        let at_ms = self.offset_ms(now);
        if kind == "user_input" {
            match (self.boundary, index) {
                (None, Some(index)) => {
                    self.boundary = Some(index);
                    self.ready_offset_ms.get_or_insert(at_ms);
                }
                (Some(old), Some(index)) if old == index => {
                    self.ready_offset_ms = Some(at_ms);
                }
                _ => {
                    self.invalid_reason.get_or_insert("missing_boundary");
                }
            }
            return;
        }
        let Some(boundary) = self.boundary else {
            return;
        };
        let Some(index) = index else {
            self.invalid_reason.get_or_insert("missing_boundary");
            if kind == "agent_response" {
                self.context = None;
            }
            return;
        };
        if index <= boundary {
            return;
        }
        let state_str = step.get("state").and_then(Value::as_str).unwrap_or("");
        let done = state_str == "DONE";
        let terminal_non_done = matches!(state_str, "ERROR" | "FAILED" | "CANCELLED");
        if self.last_step.is_none_or(|(latest, _)| index >= latest) {
            self.last_step = Some((index, kind == "agent_response" && done));
        }
        if kind != "agent_response" {
            let key = format!("step:{index}");
            if done || terminal_non_done {
                self.tools.close(&key, at_ms);
            } else {
                self.tools.open(key, at_ms);
            }
        } else {
            // Any active model response means previous synchronous tool steps finished.
            if !done {
                if let Some(thinking) = step
                    .get("thinking_delta")
                    .or_else(|| step.get("thinkingDelta"))
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    self.estimator.push_delta(thinking);
                }
                if let Some(delta) = step
                    .get("text_delta")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    self.estimator.push_delta(delta);
                }
            }
        }
        if kind == "agent_response"
            && self
                .latest_response_index
                .is_none_or(|latest| index > latest)
        {
            self.latest_response_index = Some(index);
            self.context = None;
        }
        if !done {
            if matches!(kind, "agent_response" | "checkpoint") && !self.steps.contains_key(&index) {
                if self.pending_responses.len() >= 4096 {
                    self.invalid_reason.get_or_insert("incomplete");
                } else {
                    self.pending_responses.insert(index);
                }
            }
            return;
        }
        self.pending_responses.remove(&index);
        if kind == "agent_response" && self.latest_response_index == Some(index) {
            self.context = None;
        }
        let Some(raw) = step.get("usage") else {
            // A finished checkpoint is bookkeeping, not a model request, so AGY
            // attaches no usage to it. Only a model response must report one.
            if kind == "agent_response" {
                self.invalid_reason.get_or_insert("missing_usage");
            }
            return;
        };
        let usage = normalize_usage(raw);
        if !valid_usage(&usage) {
            self.invalid_reason.get_or_insert("conflicting_usage");
            return;
        }
        if let Some((previous_kind, previous)) = self.steps.get(&index) {
            if previous != &usage || previous_kind != kind {
                self.invalid_reason.get_or_insert("conflicting_usage");
            } else if kind == "agent_response" && self.latest_response_index == Some(index) {
                self.context = Some((index, usage));
            }
            return;
        }
        if self.steps.len() >= 4096 {
            self.invalid_reason.get_or_insert("incomplete");
            return;
        }
        if let Some(step_out) = count(&usage, "output_tokens") {
            self.estimator.commit_authoritative_step(step_out);
        }
        if kind == "agent_response" && self.latest_response_index == Some(index) {
            self.context = Some((index, usage.clone()));
        }
        self.steps.insert(index, (kind.to_string(), usage));
    }

    /// This turn's last root step is a finished model response: the turn
    /// delivered its answer after any tool call or failed request it made.
    pub(super) fn answered(&self) -> bool {
        self.last_step.is_some_and(|(_, answered)| answered)
    }

    fn totals(&self) -> Option<Value> {
        if self.invalid_reason.is_some()
            || self.boundary.is_none()
            || self.steps.is_empty()
            || !self.pending_responses.is_empty()
        {
            return None;
        }
        let mut input = 0u64;
        let mut output = 0u64;
        let mut cache = 0u64;
        let mut thinking = 0u64;
        let mut saw_thinking = false;
        for (_, usage) in self.steps.values() {
            input = input.checked_add(count(usage, "input_tokens")?)?;
            output = output.checked_add(count(usage, "output_tokens")?)?;
            cache = cache.checked_add(count(usage, "cached_input_tokens").unwrap_or(0))?;
            if let Some(t) = count(usage, "thinking_tokens") {
                thinking = thinking.checked_add(t)?;
                if t > 0 {
                    saw_thinking = true;
                }
            }
        }
        // AGY's cache counter sits outside `input_tokens`, so the billed total
        // is all three.
        let total = input.checked_add(output)?.checked_add(cache)?;
        if total > MAX_COUNT {
            return None;
        }
        let mut out = json!({
            "input_tokens": input,
            "output_tokens": output,
            "cached_input_tokens": cache,
            "cache_read_input_tokens": cache,
            "total_tokens": total,
        });
        if saw_thinking {
            out["thinking_tokens"] = json!(thinking);
            out["reasoning_output_tokens"] = json!(thinking);
        }
        Some(out)
    }

    fn running_breakdown(&self, now: Instant) -> TimeBreakdown {
        let wall_ms = self.offset_ms(now);
        let tool_segs = self.tools.segments_at(wall_ms);
        let wait_segs = self.waits.segments_at(wall_ms);
        compute_breakdown(wall_ms, self.startup_offset(), &tool_segs, &wait_segs)
    }

    fn terminal_breakdown(&self, now: Instant) -> TimeBreakdown {
        let wall_ms = self.offset_ms(now);
        compute_breakdown(
            wall_ms,
            self.startup_offset(),
            self.tools.closed_segments(),
            self.waits.closed_segments(),
        )
    }

    /// Throttled (1 Hz, >= 500ms active model window) live preview while an
    /// `agent_response` step is streaming deltas. Never affects authoritative
    /// totals or fast synchronous unit tests.
    pub(super) fn live_sample(&mut self, now: Instant) -> Option<Value> {
        if self.ended || self.boundary.is_none() || self.tools.has_open() {
            return None;
        }
        if self
            .last_live_emit
            .is_some_and(|prev| now.saturating_duration_since(prev) < Duration::from_secs(1))
        {
            return None;
        }
        let breakdown = self.running_breakdown(now);
        let live = self.estimator.live_estimate_json(breakdown.model_ms)?;
        self.last_live_emit = Some(now);
        let mut sample = json!({
            "version": 1,
            "source": "agy",
            "status": "running",
            "outputTokens": null,
            "elapsedMs": null,
            "generation": null,
            "generationReason": "unavailable_timing",
            "turnReason": null,
            "liveEstimate": live,
        });
        if let Some(b) = breakdown_json(breakdown) {
            sample["breakdown"] = b;
        }
        Some(sample)
    }

    /// Live throughput after a root model response finished while the turn is
    /// still going. `None` while anything is pending, invalid or unmeasured —
    /// a running sample is only ever sent when it is complete and consistent,
    /// and the terminal `finish` sample still replaces it.
    pub(super) fn running_sample(&self, now: Instant) -> Option<Value> {
        if self.ended {
            return None;
        }
        let output = self
            .totals()
            .and_then(|usage| count(&usage, "output_tokens"))?;
        let breakdown = self.running_breakdown(now);
        let elapsed = (breakdown.model_ms > 0.0 && breakdown.model_ms.is_finite())
            .then_some(breakdown.model_ms)?;
        let mut sample = json!({
            "version": 1,
            "source": "agy",
            "status": "running",
            "outputTokens": output,
            "elapsedMs": elapsed,
            "generation": null,
            "generationReason": "unavailable_timing",
            "turnReason": null,
        });
        if let Some(b) = breakdown_json(breakdown) {
            sample["breakdown"] = b;
        }
        if let Some(live) = self.estimator.live_estimate_json(breakdown.model_ms) {
            sample["liveEstimate"] = live;
        }
        Some(sample)
    }

    pub(super) fn usage(&self, session: Option<&Value>) -> Value {
        let totals = self.totals();
        let mut usage = totals.clone().unwrap_or_else(|| json!({}));
        usage["usage_scope"] = json!(if totals.is_some() { "turn" } else { "unknown" });
        if let Some(session) = session {
            usage["session_usage"] = normalize_usage(session);
        }
        usage["context_usage_kind"] = json!("last_prompt");
        usage["context_usage"] = self
            .context
            .as_ref()
            .map(|(_, usage)| usage.clone())
            .unwrap_or(Value::Null);
        usage
    }

    pub(super) fn finish(&mut self, partial: bool, now: Instant) -> Option<Value> {
        if self.ended {
            return None;
        }
        self.ended = true;
        let wall_ms = self.offset_ms(now);
        if partial {
            self.tools.close_all(wall_ms);
            self.waits.close_all(wall_ms);
        }
        let output = self
            .totals()
            .and_then(|usage| count(&usage, "output_tokens"));
        let breakdown = self.terminal_breakdown(now);
        let elapsed = (breakdown.model_ms > 0.0 && breakdown.model_ms.is_finite())
            .then_some(breakdown.model_ms);
        let reason = if partial {
            Some("interrupted")
        } else if let Some(reason) = self.invalid_reason {
            Some(reason)
        } else if self.root.is_none() {
            Some("invalid_identity")
        } else if self.boundary.is_none() {
            Some("missing_boundary")
        } else if !self.pending_responses.is_empty() {
            Some("pending_usage")
        } else {
            validate_complete_gate(output, elapsed)
        };
        let mut sample = json!({
            "version": 1,
            "source": "agy",
            "status": if partial { "partial" } else { "complete" },
            "outputTokens": output,
            "elapsedMs": elapsed,
            "generation": null,
            "generationReason": "unavailable_timing",
            "turnReason": reason,
        });
        if let Some(b) = breakdown_json(breakdown) {
            sample["breakdown"] = b;
        }
        Some(sample)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn tracker() -> (AgyThroughput, Instant) {
        let now = Instant::now();
        let mut tracker = AgyThroughput::default();
        tracker.begin(Some("root"), now);
        tracker.init(Some("root"));
        (tracker, now)
    }

    fn boundary(tracker: &mut AgyThroughput, index: u64, now: Instant) {
        tracker.step(
            &json!({"step_type":"user_input","step_index":index,"state":"DONE"}),
            Some("root"),
            now,
        );
    }

    fn step(index: u64, kind: &str, output: u64) -> Value {
        json!({"step_type":kind,"step_index":index,"state":"DONE","duration_seconds":0.01,
            "usage":{"input_tokens":100,"output_tokens":output,"cache_read_tokens":60,"total_tokens":100+output}})
    }

    #[test]
    fn resumed_turn_dedupes_steps_and_ignores_cumulative_result() {
        let (mut tracker, now) = tracker();
        tracker.step(&step(3, "agent_response", 900), Some("root"), now);
        boundary(&mut tracker, 10, now);
        tracker.step(&step(9, "agent_response", 800), Some("root"), now);
        let mut response = step(11, "agent_response", 20);
        response["usage"]["context_window"] = json!(1_000_000);
        tracker.step(&response, Some("root"), now);
        tracker.step(&response, Some("root"), now);
        tracker.step(&step(12, "checkpoint", 2), Some("root"), now);
        let cumulative = json!({"input_tokens":9000,"output_tokens":4000,"cache_read_tokens":8000});
        let usage = tracker.usage(Some(&cumulative));
        assert_eq!(usage["usage_scope"], "turn");
        assert_eq!(usage["output_tokens"], 22);
        assert_eq!(usage["cached_input_tokens"], 120);
        assert_eq!(usage["session_usage"]["output_tokens"], 4000);
        assert_eq!(usage["session_usage"]["cached_input_tokens"], 8000);
        assert_eq!(usage["context_usage"]["output_tokens"], 20);
        assert_eq!(usage["context_usage"]["context_window"], 1_000_000);
        let sample = tracker.finish(false, now + Duration::from_secs(5)).unwrap();
        assert_eq!(sample["outputTokens"], 22);
        assert_eq!(sample["elapsedMs"], 5000.0);
        assert!(sample["generation"].is_null());
        assert!(sample["turnReason"].is_null());
        assert!(tracker
            .finish(false, now + Duration::from_secs(8))
            .is_none());
    }

    #[test]
    fn strips_cold_startup_and_tool_execution_and_forwards_thinking_tokens() {
        let (mut tracker, now) = tracker();
        // Cold startup takes 5.5s until user_input boundary arrives.
        boundary(&mut tracker, 0, now + Duration::from_millis(5500));
        // Model step 1 streams deltas and finishes at 8.0s (2.5s model time).
        tracker.step(
            &json!({"step_type":"agent_response","step_index":1,"state":"ACTIVE","thinking_delta":"思考中","text_delta":"Checking files"}),
            Some("root"),
            now + Duration::from_millis(6500),
        );
        let live = tracker
            .live_sample(now + Duration::from_millis(6500))
            .expect("live estimate after 1s active model window");
        assert_eq!(live["status"], "running");
        assert_eq!(live["liveEstimate"]["estimated"], true);
        assert_eq!(live["breakdown"]["startupMs"], 5500.0);
        assert_eq!(live["breakdown"]["modelMs"], 1000.0);

        tracker.step(
            &json!({"step_type":"agent_response","step_index":1,"state":"DONE",
                "usage":{"input_tokens":500,"output_tokens":80,"cache_read_tokens":0,"thinking_tokens":45,"total_tokens":580}}),
            Some("root"),
            now + Duration::from_millis(8000),
        );
        // Tool step runs from 8.0s to 12.0s (4.0s tool execution).
        tracker.step(
            &json!({"step_type":"tool","step_index":2,"state":"ACTIVE","tool_info":{"name":"RunCommand"}}),
            Some("root"),
            now + Duration::from_millis(8000),
        );
        // Live sample pauses/suppresses while tool is open.
        assert!(tracker.live_sample(now + Duration::from_millis(10000)).is_none());
        tracker.step(
            &json!({"step_type":"tool","step_index":2,"state":"DONE","tool_info":{"name":"RunCommand","output":"ok"}}),
            Some("root"),
            now + Duration::from_millis(12000),
        );
        // Model step 2 runs from 12.0s to 14.5s (2.5s model time).
        tracker.step(
            &json!({"step_type":"agent_response","step_index":3,"state":"DONE",
                "usage":{"input_tokens":600,"output_tokens":120,"cache_read_tokens":200,"thinking_tokens":55,"total_tokens":720}}),
            Some("root"),
            now + Duration::from_millis(14500),
        );
        let usage = tracker.usage(None);
        assert_eq!(usage["output_tokens"], 200);
        assert_eq!(usage["thinking_tokens"], 100);
        assert_eq!(usage["reasoning_output_tokens"], 100);

        let sample = tracker
            .finish(false, now + Duration::from_millis(14500))
            .unwrap();
        // wall=14500, startup=5500, tool=4000 => model=5000ms => 40 tok/s!
        assert_eq!(sample["outputTokens"], 200);
        assert_eq!(sample["elapsedMs"], 5000.0);
        assert_eq!(sample["breakdown"]["startupMs"], 5500.0);
        assert_eq!(sample["breakdown"]["toolMs"], 4000.0);
        assert_eq!(sample["breakdown"]["modelMs"], 5000.0);
        assert_eq!(sample["breakdown"]["wallMs"], 14500.0);
        assert!(sample["turnReason"].is_null());
    }

    #[test]
    fn no_boundary_missing_id_or_conflicting_steps_never_claim_turn_totals() {
        for case in 0..5 {
            let (mut tracker, now) = tracker();
            if case != 0 {
                boundary(&mut tracker, 10, now);
            }
            tracker.step(
                &step(11, "agent_response", 20),
                if case == 1 { None } else { Some("root") },
                now,
            );
            if case == 2 {
                tracker.step(&step(11, "agent_response", 21), Some("root"), now);
            }
            if case == 3 {
                tracker.step(
                    &json!({"step_type":"agent_response","state":"DONE","usage":{"output_tokens":2}}),
                    Some("root"),
                    now,
                );
            }
            if case == 4 {
                boundary(&mut tracker, 12, now);
            }
            assert_eq!(tracker.usage(None)["usage_scope"], "unknown", "case {case}");
            let sample = tracker.finish(false, now + Duration::from_secs(1)).unwrap();
            assert!(sample["outputTokens"].is_null(), "case {case}");
            let reasons = [
                "missing_boundary",
                "invalid_identity",
                "conflicting_usage",
                "missing_boundary",
                "missing_boundary",
            ];
            assert_eq!(sample["turnReason"], reasons[case]);
        }
    }

    #[test]
    fn child_and_active_steps_do_not_enter_main_usage() {
        let (mut tracker, now) = tracker();
        boundary(&mut tracker, 0, now);
        tracker.step(&step(1, "agent_response", 900), Some("child"), now);
        let mut active = step(1, "agent_response", 30);
        active["state"] = json!("ACTIVE");
        tracker.step(&active, Some("root"), now);
        tracker.step(&step(1, "agent_response", 20), Some("root"), now);
        assert_eq!(
            tracker
                .finish(false, now + Duration::from_secs(1))
                .unwrap()["outputTokens"],
            20
        );
        assert!(tracker.is_child(Some("child")));
    }

    #[test]
    fn cached_steps_and_usage_less_checkpoints_still_measure_the_turn() {
        // Real AGY: step 2+ of a turn reads a large cache while `input_tokens`
        // only counts the uncached remainder; total excludes the cache.
        let (mut tracker, now) = tracker();
        boundary(&mut tracker, 0, now);
        tracker.step(
            &json!({"step_type":"agent_response","step_index":1,"state":"DONE",
                "usage":{"input_tokens":3856,"output_tokens":1205,"cache_read_tokens":51047,"total_tokens":5061}}),
            Some("root"),
            now,
        );
        tracker.step(
            &json!({"step_type":"checkpoint","step_index":2,"state":"ACTIVE"}),
            Some("root"),
            now,
        );
        tracker.step(
            &json!({"step_type":"checkpoint","step_index":2,"state":"DONE"}),
            Some("root"),
            now,
        );
        let usage = tracker.usage(None);
        assert_eq!(usage["usage_scope"], "turn");
        assert_eq!(usage["input_tokens"], 3856);
        assert_eq!(usage["cache_read_input_tokens"], 51047);
        assert_eq!(usage["total_tokens"], 3856 + 1205 + 51047);
        assert_eq!(usage["context_usage"]["cache_read_input_tokens"], 51047);
        let sample = tracker.finish(false, now + Duration::from_secs(5)).unwrap();
        assert_eq!(sample["outputTokens"], 1205);
        assert!(sample["turnReason"].is_null());
    }

    #[test]
    fn running_sample_only_exists_for_a_consistent_unfinished_turn() {
        let (mut tracker, now) = tracker();
        assert!(tracker.running_sample(now + Duration::from_secs(1)).is_none());
        boundary(&mut tracker, 0, now);
        tracker.step(&step(1, "agent_response", 20), Some("root"), now);
        let sample = tracker.running_sample(now + Duration::from_secs(2)).unwrap();
        assert_eq!(sample["status"], "running");
        assert_eq!(sample["outputTokens"], 20);
        assert_eq!(sample["elapsedMs"], 2000.0);
        // A later response still in flight makes totals incomplete again.
        tracker.step(
            &json!({"step_type":"agent_response","step_index":2,"state":"ACTIVE"}),
            Some("root"),
            now + Duration::from_secs(2),
        );
        assert!(tracker.running_sample(now + Duration::from_secs(3)).is_none());
        tracker.step(
            &step(2, "agent_response", 30),
            Some("root"),
            now + Duration::from_secs(3),
        );
        assert_eq!(
            tracker.running_sample(now + Duration::from_secs(4)).unwrap()["outputTokens"],
            50
        );
        tracker.finish(false, now + Duration::from_secs(5));
        assert!(tracker.running_sample(now + Duration::from_secs(6)).is_none());
    }

    #[test]
    fn malformed_counts_missing_usage_and_overflow_are_unknown() {
        for bad in [
            json!(-1),
            json!(1.5),
            json!("20"),
            json!(MAX_COUNT + 1),
            Value::Null,
        ] {
            let (mut tracker, now) = tracker();
            boundary(&mut tracker, 0, now);
            let mut response = step(1, "agent_response", 20);
            response["usage"]["output_tokens"] = bad;
            tracker.step(&response, Some("root"), now);
            assert!(
                tracker.finish(false, now + Duration::from_secs(1)).unwrap()["outputTokens"]
                    .is_null()
            );
        }
        for usage in [
            json!({"input_tokens":10,"output_tokens":2,"cache_read_tokens":11,"total_tokens":99}),
            json!({"input_tokens":10,"output_tokens":2,"total_tokens":99}),
            Value::Null,
        ] {
            let (mut tracker, now) = tracker();
            boundary(&mut tracker, 0, now);
            tracker.step(
                &json!({"step_type":"agent_response","step_index":1,"state":"DONE","usage":usage}),
                Some("root"),
                now,
            );
            assert_eq!(tracker.usage(None)["usage_scope"], "unknown");
        }
    }

    #[test]
    fn unfinished_later_model_response_cannot_make_a_complete_turn_total() {
        let (mut tracker, now) = tracker();
        boundary(&mut tracker, 0, now);
        tracker.step(&step(1, "agent_response", 20), Some("root"), now);
        tracker.step(
            &json!({"step_type":"agent_response","state":"ACTIVE","step_index":2}),
            Some("root"),
            now,
        );
        assert_eq!(tracker.usage(None)["usage_scope"], "unknown");
        let sample = tracker.finish(false, now + Duration::from_secs(1)).unwrap();
        assert!(sample["outputTokens"].is_null());
        assert_eq!(sample["turnReason"], "pending_usage");
    }

    #[test]
    fn failure_interruption_and_zero_clock_are_not_complete_measurements() {
        let (mut tracker, now) = tracker();
        boundary(&mut tracker, 0, now);
        tracker.step(&step(1, "agent_response", 20), Some("root"), now);
        let sample = tracker.finish(true, now).unwrap();
        assert_eq!(sample["status"], "partial");
        assert_eq!(sample["turnReason"], "interrupted");
        assert!(sample["elapsedMs"].is_null());
        tracker.begin(Some("new-root"), now);
        assert_eq!(tracker.usage(None)["usage_scope"], "unknown");
        tracker.init(Some("wrong-root"));
        assert!(
            tracker.finish(false, now + Duration::from_secs(1)).unwrap()["outputTokens"].is_null()
        );
    }

    #[test]
    fn unfinished_checkpoint_excludes_whole_turn_totals() {
        let (mut tracker, now) = tracker();
        boundary(&mut tracker, 0, now);
        tracker.step(&step(1, "agent_response", 20), Some("root"), now);
        tracker.step(
            &json!({"step_type":"checkpoint","state":"ACTIVE","step_index":2}),
            Some("root"),
            now,
        );
        assert_eq!(tracker.usage(None)["usage_scope"], "unknown");
        assert!(
            tracker.finish(false, now + Duration::from_secs(1)).unwrap()["outputTokens"].is_null()
        );
    }

    #[test]
    fn newer_response_invalidates_context_and_late_older_done_cannot_restore_it() {
        for newer in [
            json!({"step_type":"agent_response","step_index":2,"state":"ACTIVE"}),
            json!({"step_type":"agent_response","step_index":2,"state":"DONE"}),
            json!({"step_type":"agent_response","step_index":2,"state":"DONE","usage":{"input_tokens":100,"output_tokens":-1}}),
        ] {
            let (mut tracker, now) = tracker();
            boundary(&mut tracker, 0, now);
            tracker.step(&step(1, "agent_response", 20), Some("root"), now);
            assert_eq!(tracker.usage(None)["context_usage"]["output_tokens"], 20);
            tracker.step(&newer, Some("root"), now);
            assert!(tracker.usage(None)["context_usage"].is_null());
            tracker.step(&step(1, "agent_response", 20), Some("root"), now);
            assert!(tracker.usage(None)["context_usage"].is_null());
            tracker.step(&step(2, "agent_response", 30), Some("root"), now);
            assert_eq!(tracker.usage(None)["context_usage"]["output_tokens"], 30);
            tracker.step(&step(1, "agent_response", 20), Some("root"), now);
            assert_eq!(tracker.usage(None)["context_usage"]["output_tokens"], 30);
        }
    }
}
