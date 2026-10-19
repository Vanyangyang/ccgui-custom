//! Current-launch AGY accounting. Session result totals are never turn totals.
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

const MAX_COUNT: u64 = 9_007_199_254_740_991;

#[derive(Default)]
pub(super) struct AgyThroughput {
    started: Option<Instant>,
    root: Option<String>,
    boundary: Option<u64>,
    ended: bool,
    invalid_reason: Option<&'static str>,
    steps: BTreeMap<u64, (String, Value)>,
    pending_responses: BTreeSet<u64>,
    tool_steps: BTreeSet<u64>,
    latest_response_index: Option<u64>,
    context: Option<(u64, Value)>,
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

    pub(super) fn init(&mut self, id: Option<&str>) {
        if let Some(id) = id {
            if self.root.as_deref().is_some_and(|root| root != id) {
                self.invalid_reason.get_or_insert("invalid_identity");
            } else {
                self.root = Some(id.to_string());
            }
        }
    }

    pub(super) fn step(&mut self, step: &Value, id: Option<&str>) {
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
        if kind == "user_input" {
            match (self.boundary, index) {
                (None, Some(index)) => self.boundary = Some(index),
                (Some(old), Some(index)) if old == index => {}
                _ => { self.invalid_reason.get_or_insert("missing_boundary"); },
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
        if kind == "agent_response"
            && self
                .latest_response_index
                .is_none_or(|latest| index > latest)
        {
            self.latest_response_index = Some(index);
            self.context = None;
        }
        if step.get("state").and_then(Value::as_str) != Some("DONE") {
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
        if kind == "agent_response" && self.latest_response_index == Some(index) {
            self.context = Some((index, usage.clone()));
        }
        self.steps.insert(index, (kind.to_string(), usage));
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
        for (_, usage) in self.steps.values() {
            input = input.checked_add(count(usage, "input_tokens")?)?;
            output = output.checked_add(count(usage, "output_tokens")?)?;
            cache = cache.checked_add(count(usage, "cached_input_tokens").unwrap_or(0))?;
        }
        // AGY's cache counter sits outside `input_tokens`, so the billed total
        // is all three.
        let total = input.checked_add(output)?.checked_add(cache)?;
        if total > MAX_COUNT {
            return None;
        }
        Some(json!({
            "input_tokens": input,
            "output_tokens": output,
            "cached_input_tokens": cache,
            "cache_read_input_tokens": cache,
            "total_tokens": total,
        }))
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
        let elapsed = self
            .started
            .map(|start| now.saturating_duration_since(start).as_secs_f64() * 1000.0)
            .filter(|n| *n > 0.0 && n.is_finite())?;
        Some(json!({"version":1,"source":"agy","status":"running",
            "outputTokens":output,"elapsedMs":elapsed,"generation":null,
            "generationReason":"unavailable_timing","turnReason":null}))
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
        let output = self
            .totals()
            .and_then(|usage| count(&usage, "output_tokens"));
        let elapsed = self
            .started
            .map(|start| now.saturating_duration_since(start).as_secs_f64() * 1000.0)
            .filter(|n| *n > 0.0 && n.is_finite());
        let reason = if partial { Some("interrupted") }
            else if let Some(reason) = self.invalid_reason { Some(reason) }
            else if self.root.is_none() { Some("invalid_identity") }
            else if self.boundary.is_none() { Some("missing_boundary") }
            else if !self.pending_responses.is_empty() { Some("pending_usage") }
            else if output.is_none() { Some("missing_usage") }
            else if elapsed.is_none() { Some("missing_timing") }
            else { None };
        Some(
            json!({"version":1,"source":"agy","status":if partial {"partial"} else {"complete"},
            "outputTokens":output,"elapsedMs":elapsed,"generation":null,"generationReason":"unavailable_timing", "turnReason":reason}),
        )
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

    fn boundary(tracker: &mut AgyThroughput, index: u64) {
        tracker.step(
            &json!({"step_type":"user_input","step_index":index,"state":"DONE"}),
            Some("root"),
        );
    }

    fn step(index: u64, kind: &str, output: u64) -> Value {
        json!({"step_type":kind,"step_index":index,"state":"DONE","duration_seconds":0.01,
            "usage":{"input_tokens":100,"output_tokens":output,"cache_read_tokens":60,"total_tokens":100+output}})
    }

    #[test]
    fn resumed_turn_dedupes_steps_and_ignores_cumulative_result() {
        let (mut tracker, now) = tracker();
        tracker.step(&step(3, "agent_response", 900), Some("root"));
        boundary(&mut tracker, 10);
        tracker.step(&step(9, "agent_response", 800), Some("root"));
        let mut response = step(11, "agent_response", 20);
        response["usage"]["context_window"] = json!(1_000_000);
        tracker.step(&response, Some("root"));
        tracker.step(&response, Some("root"));
        tracker.step(&step(12, "checkpoint", 2), Some("root"));
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
    fn no_boundary_missing_id_or_conflicting_steps_never_claim_turn_totals() {
        for case in 0..5 {
            let (mut tracker, now) = tracker();
            if case != 0 {
                boundary(&mut tracker, 10);
            }
            tracker.step(
                &step(11, "agent_response", 20),
                if case == 1 { None } else { Some("root") },
            );
            if case == 2 {
                tracker.step(&step(11, "agent_response", 21), Some("root"));
            }
            if case == 3 {
                tracker.step(&json!({"step_type":"agent_response","state":"DONE","usage":{"output_tokens":2}}),Some("root"));
            }
            if case == 4 {
                boundary(&mut tracker, 12);
            }
            assert_eq!(tracker.usage(None)["usage_scope"], "unknown", "case {case}");
            let sample = tracker.finish(false, now + Duration::from_secs(1)).unwrap();
            assert!(sample["outputTokens"].is_null(), "case {case}");
            let reasons = ["missing_boundary", "invalid_identity", "conflicting_usage", "missing_boundary", "missing_boundary"];
            assert_eq!(sample["turnReason"], reasons[case]);
        }
    }

    #[test]
    fn child_and_active_steps_do_not_enter_main_usage() {
        let (mut tracker, now) = tracker();
        boundary(&mut tracker, 0);
        tracker.step(&step(1, "agent_response", 900), Some("child"));
        let mut active = step(1, "agent_response", 30);
        active["state"] = json!("ACTIVE");
        tracker.step(&active, Some("root"));
        tracker.step(&step(1, "agent_response", 20), Some("root"));
        assert_eq!(
            tracker.finish(false, now + Duration::from_secs(1)).unwrap()["outputTokens"],
            20
        );
        assert!(tracker.is_child(Some("child")));
    }

    #[test]
    fn cached_steps_and_usage_less_checkpoints_still_measure_the_turn() {
        // Real AGY: step 2+ of a turn reads a large cache while `input_tokens`
        // only counts the uncached remainder; total excludes the cache.
        let (mut tracker, now) = tracker();
        boundary(&mut tracker, 0);
        tracker.step(&json!({"step_type":"agent_response","step_index":1,"state":"DONE",
            "usage":{"input_tokens":3856,"output_tokens":1205,"cache_read_tokens":51047,"total_tokens":5061}}), Some("root"));
        tracker.step(&json!({"step_type":"checkpoint","step_index":2,"state":"ACTIVE"}), Some("root"));
        tracker.step(&json!({"step_type":"checkpoint","step_index":2,"state":"DONE"}), Some("root"));
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
        boundary(&mut tracker, 0);
        tracker.step(&step(1, "agent_response", 20), Some("root"));
        let sample = tracker.running_sample(now + Duration::from_secs(2)).unwrap();
        assert_eq!(sample["status"], "running");
        assert_eq!(sample["outputTokens"], 20);
        assert_eq!(sample["elapsedMs"], 2000.0);
        // A later response still in flight makes totals incomplete again.
        tracker.step(&json!({"step_type":"agent_response","step_index":2,"state":"ACTIVE"}), Some("root"));
        assert!(tracker.running_sample(now + Duration::from_secs(3)).is_none());
        tracker.step(&step(2, "agent_response", 30), Some("root"));
        assert_eq!(tracker.running_sample(now + Duration::from_secs(4)).unwrap()["outputTokens"], 50);
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
            boundary(&mut tracker, 0);
            let mut response = step(1, "agent_response", 20);
            response["usage"]["output_tokens"] = bad;
            tracker.step(&response, Some("root"));
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
            let (mut tracker, _) = tracker();
            boundary(&mut tracker, 0);
            tracker.step(
                &json!({"step_type":"agent_response","step_index":1,"state":"DONE","usage":usage}),
                Some("root"),
            );
            assert_eq!(tracker.usage(None)["usage_scope"], "unknown");
        }
    }

    #[test]
    fn unfinished_later_model_response_cannot_make_a_complete_turn_total() {
        let (mut tracker, now) = tracker();
        boundary(&mut tracker, 0);
        tracker.step(&step(1, "agent_response", 20), Some("root"));
        tracker.step(
            &json!({"step_type":"agent_response","state":"ACTIVE","step_index":2}),
            Some("root"),
        );
        assert_eq!(tracker.usage(None)["usage_scope"], "unknown");
        let sample = tracker.finish(false, now + Duration::from_secs(1)).unwrap();
        assert!(sample["outputTokens"].is_null());
        assert_eq!(sample["turnReason"], "pending_usage");
    }

    #[test]
    fn failure_interruption_and_zero_clock_are_not_complete_measurements() {
        let (mut tracker, now) = tracker();
        boundary(&mut tracker, 0);
        tracker.step(&step(1, "agent_response", 20), Some("root"));
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
        boundary(&mut tracker, 0);
        tracker.step(&step(1, "agent_response", 20), Some("root"));
        tracker.step(
            &json!({"step_type":"checkpoint","state":"ACTIVE","step_index":2}),
            Some("root"),
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
            let (mut tracker, _) = tracker();
            boundary(&mut tracker, 0);
            tracker.step(&step(1, "agent_response", 20), Some("root"));
            assert_eq!(tracker.usage(None)["context_usage"]["output_tokens"], 20);
            tracker.step(&newer, Some("root"));
            assert!(tracker.usage(None)["context_usage"].is_null());
            tracker.step(&step(1, "agent_response", 20), Some("root"));
            assert!(tracker.usage(None)["context_usage"].is_null());
            tracker.step(&step(2, "agent_response", 30), Some("root"));
            assert_eq!(tracker.usage(None)["context_usage"]["output_tokens"], 30);
            tracker.step(&step(1, "agent_response", 20), Some("root"));
            assert_eq!(tracker.usage(None)["context_usage"]["output_tokens"], 30);
        }
    }
}
