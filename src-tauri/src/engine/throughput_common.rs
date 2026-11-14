//! Shared active-time (`model_ms`) interval union, plausibility gates, and
//! live streaming token estimation across engine throughput trackers.
//!
//! Live estimates are strictly ephemeral UI previews (`liveEstimate`) and never
//! enter completed turn summaries, session ledgers, or `throughput_turns`.

use serde_json::{json, Value};
use std::collections::HashMap;

pub(crate) const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub(crate) const MIN_MODEL_WINDOW_MS: f64 = 1000.0;
pub(crate) const MAX_PLAUSIBLE_TPS: f64 = 1000.0;
pub(crate) const MIN_LIVE_ESTIMATE_MS: f64 = 500.0;

const MAX_OPEN_KEYS: usize = 256;
const MAX_SEGMENTS: usize = 512;

/// Tracks keyed `[start_ms, end_ms]` intervals relative to turn start and
/// computes exact interval unions so parallel tool calls or nested waits never
/// double-subtract from `wall_ms`.
#[derive(Clone, Debug, Default)]
pub(crate) struct IntervalTracker {
    open: HashMap<String, f64>,
    closed: Vec<(f64, f64)>,
}

impl IntervalTracker {
    pub(crate) fn open(&mut self, key: impl Into<String>, at_ms: f64) {
        if !at_ms.is_finite() {
            return;
        }
        let key = key.into();
        if self.open.contains_key(&key) {
            return;
        }
        if self.open.len() >= MAX_OPEN_KEYS {
            return;
        }
        self.open.insert(key, at_ms.max(0.0));
    }

    pub(crate) fn close(&mut self, key: &str, at_ms: f64) -> bool {
        let Some(start) = self.open.remove(key) else {
            return false;
        };
        if at_ms.is_finite() {
            let end = at_ms.max(0.0);
            if end > start {
                push_and_merge(&mut self.closed, (start, end));
            }
        }
        true
    }

    pub(crate) fn close_all(&mut self, at_ms: f64) {
        let keys: Vec<String> = self.open.keys().cloned().collect();
        for key in keys {
            self.close(&key, at_ms);
        }
    }

    pub(crate) fn has_open(&self) -> bool {
        !self.open.is_empty()
    }

    pub(crate) fn closed_segments(&self) -> &[(f64, f64)] {
        &self.closed
    }

    /// Segments including currently open intervals extended up to `now_ms`.
    /// Used while `"running"` so live estimates pause during tool execution or
    /// user waits.
    pub(crate) fn segments_at(&self, now_ms: f64) -> Vec<(f64, f64)> {
        let mut out = self.closed.clone();
        if now_ms.is_finite() {
            let end = now_ms.max(0.0);
            for &start in self.open.values() {
                if end > start {
                    push_and_merge(&mut out, (start, end));
                }
            }
        }
        out
    }
}

fn push_and_merge(segments: &mut Vec<(f64, f64)>, candidate: (f64, f64)) {
    if candidate.1 <= candidate.0 {
        return;
    }
    if segments.len() >= MAX_SEGMENTS {
        if let Some(last) = segments.last_mut() {
            if candidate.0 <= last.1 {
                last.1 = last.1.max(candidate.1);
                return;
            }
        }
        return;
    }
    segments.push(candidate);
    normalize_segments(segments);
}

fn normalize_segments(segments: &mut Vec<(f64, f64)>) {
    if segments.len() <= 1 {
        return;
    }
    segments.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.total_cmp(&b.1)));
    let mut merged: Vec<(f64, f64)> = Vec::with_capacity(segments.len());
    for &(start, end) in segments.iter() {
        if end <= start {
            continue;
        }
        if let Some(last) = merged.last_mut() {
            if start <= last.1 {
                last.1 = last.1.max(end);
                continue;
            }
        }
        merged.push((start, end));
    }
    *segments = merged;
}

fn clamped_duration(segments: &[(f64, f64)], lo: f64, hi: f64) -> f64 {
    if !lo.is_finite() || !hi.is_finite() || hi <= lo || segments.is_empty() {
        return 0.0;
    }
    let mut clipped: Vec<(f64, f64)> = segments
        .iter()
        .filter_map(|&(s, e)| {
            let cs = s.max(lo);
            let ce = e.min(hi);
            (ce > cs).then_some((cs, ce))
        })
        .collect();
    normalize_segments(&mut clipped);
    clipped.into_iter().map(|(s, e)| e - s).sum()
}

/// Partition `[0, wall_ms]` into `(startup_ms, model_ms, tool_ms, wait_ms)`
/// such that all four components are non-negative and sum to `wall_ms`.
/// Overlapping `tool` and `wait` intervals attribute the overlap to `wait_ms`
/// without double-subtracting from `model_ms`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct TimeBreakdown {
    pub(crate) startup_ms: f64,
    pub(crate) model_ms: f64,
    pub(crate) tool_ms: f64,
    pub(crate) wait_ms: f64,
    pub(crate) wall_ms: f64,
}

pub(crate) fn compute_breakdown(
    wall_ms: f64,
    ready_offset_ms: f64,
    tool_segments: &[(f64, f64)],
    wait_segments: &[(f64, f64)],
) -> TimeBreakdown {
    if !wall_ms.is_finite() || wall_ms <= 0.0 {
        return TimeBreakdown::default();
    }
    let startup_ms = if ready_offset_ms.is_finite() {
        ready_offset_ms.clamp(0.0, wall_ms)
    } else {
        0.0
    };
    let wait_ms = clamped_duration(wait_segments, startup_ms, wall_ms);
    let mut union_all = Vec::with_capacity(tool_segments.len() + wait_segments.len());
    union_all.extend_from_slice(tool_segments);
    union_all.extend_from_slice(wait_segments);
    let non_model_ms = clamped_duration(&union_all, startup_ms, wall_ms);
    let tool_ms = (non_model_ms - wait_ms).max(0.0);
    let post_ready_ms = (wall_ms - startup_ms).max(0.0);
    let model_ms = (post_ready_ms - non_model_ms).max(0.0);
    TimeBreakdown {
        startup_ms,
        model_ms,
        tool_ms,
        wait_ms,
        wall_ms,
    }
}

pub(crate) fn round_ms(ms: f64) -> f64 {
    if !ms.is_finite() || ms <= 0.0 {
        0.0
    } else {
        (ms * 10.0).round() / 10.0
    }
}

pub(crate) fn breakdown_json(b: TimeBreakdown) -> Option<Value> {
    if !b.wall_ms.is_finite() || b.wall_ms <= 0.0 {
        return None;
    }
    Some(json!({
        "modelMs": round_ms(b.model_ms),
        "toolMs": round_ms(b.tool_ms),
        "waitMs": round_ms(b.wait_ms),
        "startupMs": round_ms(b.startup_ms),
        "wallMs": round_ms(b.wall_ms),
    }))
}

/// Unified plausibility and minimum-window gate for `"complete"` turns.
/// Priority preserves existing `missing_usage` / `missing_timing` reasons while
/// rejecting `0`-token, `< 1000ms`, and `> 1000 tok/s` samples.
pub(crate) fn validate_complete_gate(
    output: Option<u64>,
    model_ms: Option<f64>,
) -> Option<&'static str> {
    let Some(tokens) = output else {
        return Some("missing_usage");
    };
    let Some(ms) = model_ms.filter(|ms| ms.is_finite() && *ms > 0.0) else {
        return Some("missing_timing");
    };
    if tokens == 0 {
        return Some("missing_usage");
    }
    if ms < MIN_MODEL_WINDOW_MS {
        return Some("insufficient_timing");
    }
    let tps = (tokens as f64) * 1000.0 / ms;
    if !tps.is_finite() || tps > MAX_PLAUSIBLE_TPS {
        return Some("implausible");
    }
    None
}

/// Fractional character/byte accumulator (`100` units = `1` estimated token)
/// so 1-3 character SSE deltas accumulate smoothly without over-counting.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct StreamTokenEstimator {
    completed_tokens: u64,
    inflight_units: u64,
}

impl StreamTokenEstimator {
    pub(crate) fn push_delta(&mut self, text: &str) {
        for ch in text.chars() {
            let add = if is_wide_or_cjk_or_symbol(ch) {
                100_u64
            } else {
                (ch.len_utf8() as u64).saturating_mul(27)
            };
            self.inflight_units = self.inflight_units.saturating_add(add);
        }
    }

    pub(crate) fn clear_inflight(&mut self) {
        self.inflight_units = 0;
    }

    pub(crate) fn commit_authoritative_step(&mut self, tokens: u64) {
        self.inflight_units = 0;
        self.completed_tokens = self
            .completed_tokens
            .saturating_add(tokens)
            .min(MAX_SAFE_INTEGER);
    }

    pub(crate) fn set_completed_tokens(&mut self, tokens: u64) {
        self.completed_tokens = tokens.min(MAX_SAFE_INTEGER);
    }

    pub(crate) fn inflight_tokens(&self) -> u64 {
        if self.inflight_units == 0 {
            0
        } else {
            ((self.inflight_units.saturating_add(50)) / 100).max(1)
        }
    }

    pub(crate) fn live_estimate_json(&self, active_model_ms: f64) -> Option<Value> {
        if !active_model_ms.is_finite() || active_model_ms < MIN_LIVE_ESTIMATE_MS {
            return None;
        }
        let inflight = self.inflight_tokens();
        let total = self
            .completed_tokens
            .saturating_add(inflight)
            .min(MAX_SAFE_INTEGER);
        if total == 0 {
            return None;
        }
        let tps = (total as f64) * 1000.0 / active_model_ms;
        if !tps.is_finite() || tps > MAX_PLAUSIBLE_TPS {
            return None;
        }
        Some(json!({
            "outputTokens": total,
            "elapsedMs": round_ms(active_model_ms),
            "estimated": inflight > 0 || self.completed_tokens == 0,
        }))
    }
}

fn is_wide_or_cjk_or_symbol(ch: char) -> bool {
    let cp = ch as u32;
    matches!(
        cp,
        0x2E80..=0x9FFF   // CJK Radicals, Symbols, Kana, Bopomofo, Unified Ideographs
        | 0xAC00..=0xD7AF // Hangul Syllables
        | 0xF900..=0xFAFF // CJK Compatibility Ideographs
        | 0xFE30..=0xFE6F // CJK Compatibility Forms
        | 0xFF01..=0xFF60 // Fullwidth Forms
        | 0x1F300..=0x1FAFF // Emoji & Pictographs
        | 0x20000..=0x2FA1F // CJK Unified Ideographs Extensions B-F
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parallel_tools_and_overlapping_waits_partition_wall_time_without_double_counting() {
        let mut tools = IntervalTracker::default();
        tools.open("call_a", 1500.0);
        tools.open("call_b", 2500.0);
        assert!(tools.close("call_a", 4500.0));
        assert!(tools.close("call_b", 5500.0));
        // Union of [1500, 4500] and [2500, 5500] is [1500, 5500] = 4000ms.

        let mut waits = IntervalTracker::default();
        // Nested user approval wait inside a tool window [2000, 4000] = 2000ms.
        waits.open("ask_1", 2000.0);
        assert!(waits.close("ask_1", 4000.0));

        let b = compute_breakdown(
            8000.0,
            1000.0,
            tools.closed_segments(),
            waits.closed_segments(),
        );
        assert_eq!(b.startup_ms, 1000.0);
        assert_eq!(b.wait_ms, 2000.0);
        assert_eq!(b.tool_ms, 2000.0);
        assert_eq!(b.model_ms, 3000.0);
        assert_eq!(b.startup_ms + b.model_ms + b.tool_ms + b.wait_ms, b.wall_ms);
    }

    #[test]
    fn complete_gate_rejects_zero_tokens_short_windows_and_implausible_rates() {
        assert_eq!(validate_complete_gate(None, Some(2000.0)), Some("missing_usage"));
        assert_eq!(validate_complete_gate(Some(0), None), Some("missing_timing"));
        assert_eq!(validate_complete_gate(Some(10), Some(0.0)), Some("missing_timing"));
        assert_eq!(validate_complete_gate(Some(0), Some(2000.0)), Some("missing_usage"));
        assert_eq!(
            validate_complete_gate(Some(20), Some(999.0)),
            Some("insufficient_timing")
        );
        assert_eq!(
            validate_complete_gate(Some(109_000), Some(4400.0)),
            Some("implausible")
        );
        assert_eq!(validate_complete_gate(Some(120), Some(2400.0)), None);
    }

    #[test]
    fn stream_estimator_accumulates_single_char_deltas_smoothly() {
        let mut est = StreamTokenEstimator::default();
        for _ in 0..4 {
            est.push_delta("a");
        }
        assert_eq!(est.inflight_tokens(), 1);
        est.push_delta("你好🙂");
        assert_eq!(est.inflight_tokens(), 4);
        assert!(est.live_estimate_json(400.0).is_none());
        let live = est.live_estimate_json(1000.0).unwrap();
        assert_eq!(live["outputTokens"], 4);
        assert_eq!(live["elapsedMs"], 1000.0);
        assert_eq!(live["estimated"], true);
    }
}
