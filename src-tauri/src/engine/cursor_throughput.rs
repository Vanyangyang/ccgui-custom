//! Bounded Cursor CLI (`cursor-agent`) telemetry with active-time (`model_ms`)
//! subtraction of cold startup (`spawn -> system/init`) and `tool_call`
//! (`started -> completed`) execution intervals.
use super::throughput_common::{
    breakdown_json, compute_breakdown, round_ms, validate_complete_gate, IntervalTracker,
    StreamTokenEstimator, TimeBreakdown, MAX_SAFE_INTEGER,
};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

const MIN_STARTUP_STRIP_MS: f64 = 20.0;
const MIN_MONOTONIC_TURN_MS: f64 = 50.0;

fn safe_count(value: &Value) -> Option<u64> {
    value.as_u64().filter(|count| *count <= MAX_SAFE_INTEGER)
}

#[derive(Default)]
pub(super) struct CursorThroughput {
    armed: bool,
    active: bool,
    ended: bool,
    started_at: Option<Instant>,
    ready_offset_ms: Option<f64>,
    last_live_emit: Option<Instant>,
    tools: IntervalTracker,
    waits: IntervalTracker,
    estimator: StreamTokenEstimator,
}

impl CursorThroughput {
    pub(super) fn arm(&mut self, now: Instant) {
        *self = Self {
            armed: true,
            active: true,
            started_at: Some(now),
            ..Self::default()
        };
    }

    fn ensure_started(&mut self, now: Instant) {
        if !self.active || self.ended {
            *self = Self {
                active: true,
                started_at: Some(now),
                ready_offset_ms: Some(0.0),
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

    pub(super) fn on_init(&mut self, now: Instant) {
        self.ensure_started(now);
        if self.ready_offset_ms.is_none() {
            self.ready_offset_ms = Some(self.offset_ms(now));
        }
    }

    pub(super) fn on_tool_started(&mut self, call_id: Option<&str>, now: Instant) {
        self.ensure_started(now);
        if self.ready_offset_ms.is_none() {
            self.ready_offset_ms = Some(self.offset_ms(now));
        }
        let key = call_id.filter(|s| !s.is_empty()).unwrap_or("tool");
        self.tools.open(key.to_string(), self.offset_ms(now));
    }

    pub(super) fn on_tool_completed(&mut self, call_id: Option<&str>, now: Instant) {
        if !self.active || self.ended {
            return;
        }
        let key = call_id.filter(|s| !s.is_empty()).unwrap_or("tool");
        self.tools.close(key, self.offset_ms(now));
    }

    /// Feed deduplicated thinking or assistant text delta and emit a throttled
    /// (1 Hz, >= 500ms active model window) running preview when eligible.
    pub(super) fn on_stream_delta(&mut self, text: &str, now: Instant) -> Option<Value> {
        if text.is_empty() {
            return None;
        }
        self.ensure_started(now);
        if self.ready_offset_ms.is_none() {
            self.ready_offset_ms = Some(self.offset_ms(now));
        }
        self.estimator.push_delta(text);
        if self.tools.has_open() || self.waits.has_open() {
            return None;
        }
        if self
            .last_live_emit
            .is_some_and(|prev| now.saturating_duration_since(prev) < Duration::from_secs(1))
        {
            return None;
        }
        let b = self.running_breakdown(now);
        let live = self.estimator.live_estimate_json(b.model_ms)?;
        self.last_live_emit = Some(now);
        let mut sample = json!({
            "version": 1,
            "source": "cursor",
            "status": "running",
            "outputTokens": null,
            "elapsedMs": null,
            "generation": null,
            "generationReason": "unavailable_timing",
            "turnReason": null,
            "liveEstimate": live,
        });
        if let Some(bd) = breakdown_json(b) {
            sample["breakdown"] = bd;
        }
        Some(sample)
    }

    fn running_breakdown(&self, now: Instant) -> TimeBreakdown {
        let wall_ms = self.offset_ms(now);
        let tool_segs = self.tools.segments_at(wall_ms);
        let wait_segs = self.waits.segments_at(wall_ms);
        compute_breakdown(wall_ms, self.startup_offset(), &tool_segs, &wait_segs)
    }

    fn terminal_breakdown(
        &self,
        now: Instant,
        native_duration_ms: Option<u64>,
    ) -> (Option<f64>, Option<TimeBreakdown>) {
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
            let model = round_ms(b.model_ms);
            ((model > 0.0).then_some(model), Some(b))
        } else if let Some(native) = native_duration_ms.filter(|ms| *ms > 0) {
            let b = compute_breakdown(native as f64, 0.0, &[], &[]);
            (Some(native as f64), Some(b))
        } else {
            let model = round_ms(post_ready_ms);
            (
                (model > 0.0).then_some(model),
                (wall_ms > 0.0).then(|| compute_breakdown(wall_ms, startup, &[], &[])),
            )
        }
    }

    pub(super) fn finish_result(&mut self, result: &Value, partial: bool, now: Instant) -> Option<Value> {
        if self.ended {
            return None;
        }
        self.ensure_started(now);
        if self.ready_offset_ms.is_none() {
            self.ready_offset_ms = Some(self.offset_ms(now));
        }
        self.armed = false;
        self.ended = true;
        let wall_ms = self.offset_ms(now);
        if partial {
            self.tools.close_all(wall_ms);
            self.waits.close_all(wall_ms);
        }
        let output = result.pointer("/usage/outputTokens").and_then(safe_count);
        let native_duration = result.get("duration_ms").and_then(safe_count);
        let (elapsed, breakdown) = self.terminal_breakdown(now, native_duration);
        let reason = if partial {
            Some("interrupted")
        } else {
            validate_complete_gate(output, elapsed)
        };
        let mut sample = json!({
            "version": 1,
            "source": "cursor",
            "status": if partial { "partial" } else { "complete" },
            "outputTokens": output,
            "elapsedMs": elapsed,
            "generation": null,
            "generationReason": "unavailable_timing",
            "turnReason": reason,
        });
        if let Some(bd) = breakdown.and_then(breakdown_json) {
            sample["breakdown"] = bd;
        }
        Some(sample)
    }

    pub(super) fn finish_eof(&mut self, now: Instant) -> Option<Value> {
        if (!self.armed && !self.active) || self.ended {
            return None;
        }
        self.armed = false;
        self.ended = true;
        let wall_ms = self.offset_ms(now);
        self.tools.close_all(wall_ms);
        self.waits.close_all(wall_ms);
        let (elapsed, breakdown) = self.terminal_breakdown(now, None);
        let mut sample = json!({
            "version": 1,
            "source": "cursor",
            "status": "partial",
            "outputTokens": null,
            "elapsedMs": elapsed,
            "generation": null,
            "generationReason": "unavailable_timing",
            "turnReason": "interrupted",
        });
        if let Some(bd) = breakdown.and_then(breakdown_json) {
            sample["breakdown"] = bd;
        }
        Some(sample)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_17s_cold_startup_and_parallel_tools_from_cursor_model_ms() {
        let now = Instant::now();
        let mut t = CursorThroughput::default();
        t.arm(now);
        // Cold startup takes 17.7s until system/init.
        t.on_init(now + Duration::from_millis(17_700));
        // Model thinks & streams for 1.3s (17.7s -> 19.0s).
        assert!(t
            .on_stream_delta("Analyzing repository...", now + Duration::from_millis(18_500))
            .is_some());
        // Tool execution takes 5.0s (19.0s -> 24.0s).
        t.on_tool_started(Some("call_1"), now + Duration::from_millis(19_000));
        assert!(t
            .on_stream_delta("ignored during tool", now + Duration::from_millis(21_000))
            .is_none());
        t.on_tool_completed(Some("call_1"), now + Duration::from_millis(24_000));
        // Final model answer takes 1.7s (24.0s -> 25.7s).
        let report = t
            .finish_result(
                &json!({"type":"result","subtype":"success","is_error":false,"usage":{"inputTokens":26227,"outputTokens":150,"cacheReadTokens":20000}}),
                false,
                now + Duration::from_millis(25_700),
            )
            .unwrap();
        // wall=25700, startup=17700, tool=5000 => model=3000ms => 50 tok/s (not 150 / 25.7s = 5.8 tok/s!).
        assert_eq!(report["source"], "cursor");
        assert_eq!(report["status"], "complete");
        assert_eq!(report["outputTokens"], 150);
        assert_eq!(report["elapsedMs"], 3000.0);
        assert_eq!(report["breakdown"]["startupMs"], 17_700.0);
        assert_eq!(report["breakdown"]["toolMs"], 5000.0);
        assert_eq!(report["breakdown"]["modelMs"], 3000.0);
        assert_eq!(report["breakdown"]["wallMs"], 25_700.0);
        assert!(report["turnReason"].is_null());
    }

    #[test]
    fn missing_output_tokens_never_fabricates_zero_and_eof_flushes_partial() {
        let now = Instant::now();
        let mut t = CursorThroughput::default();
        t.arm(now);
        t.on_init(now + Duration::from_millis(1000));
        let missing = t
            .finish_result(
                &json!({"type":"result","subtype":"success","usage":{"inputTokens":500}}),
                false,
                now + Duration::from_millis(3000),
            )
            .unwrap();
        assert!(missing["outputTokens"].is_null());
        assert_eq!(missing["turnReason"], "missing_usage");

        let mut killed = CursorThroughput::default();
        killed.arm(now);
        killed.on_init(now + Duration::from_millis(500));
        let eof = killed.finish_eof(now + Duration::from_millis(2000)).unwrap();
        assert_eq!(eof["status"], "partial");
        assert_eq!(eof["turnReason"], "interrupted");
    }
}
