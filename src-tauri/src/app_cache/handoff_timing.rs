//! Content-free wall-clock and model-call timings for one handoff attempt.
//! Concurrent model durations overlap; they are deliberately separate from
//! stage wall-clock durations. No prompt, result, endpoint or error text enters
//! these records, and a log write can never change the handoff outcome.

use super::{handoff_diagnostics, HandoffPhase, HandoffProgress};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::time::Instant;

const MAX_LOG_BYTES: u64 = 512 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(MAX_SAFE_INTEGER).min(MAX_SAFE_INTEGER)
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffTiming {
    pub elapsed_ms: u64,
    pub reading_ms: u64,
    pub segments_ms: u64,
    pub merging_ms: u64,
    pub verifying_ms: u64,
    pub model_calls: usize,
    pub completed_model_calls: usize,
    pub active_model_calls: usize,
    pub model_elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_model_call_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub longest_model_call_ms: Option<u64>,
}

fn phase_index(phase: HandoffPhase) -> usize {
    match phase {
        HandoffPhase::Reading => 0,
        HandoffPhase::Segments => 1,
        HandoffPhase::Merging => 2,
        HandoffPhase::Verifying => 3,
    }
}

struct Timings {
    start: Instant,
    phase_start: Instant,
    phases: [Duration; 4],
    progress: HandoffProgress,
    calls: usize,
    completed: usize,
    model_elapsed: Duration,
    last_call: Option<Duration>,
    longest_call: Option<Duration>,
    finished: Option<Duration>,
}

impl Timings {
    fn snapshot(&self, now: Instant) -> HandoffTiming {
        let mut phases = self.phases;
        if self.finished.is_none() {
            phases[phase_index(self.progress.phase)] += now - self.phase_start;
        }
        HandoffTiming {
            elapsed_ms: millis(self.finished.unwrap_or_else(|| now - self.start)),
            reading_ms: millis(phases[0]),
            segments_ms: millis(phases[1]),
            merging_ms: millis(phases[2]),
            verifying_ms: millis(phases[3]),
            model_calls: self.calls,
            completed_model_calls: self.completed,
            active_model_calls: self.calls - self.completed,
            model_elapsed_ms: millis(self.model_elapsed),
            last_model_call_ms: self.last_call.map(millis),
            longest_model_call_ms: self.longest_call.map(millis),
        }
    }

    fn finish(&mut self, now: Instant) {
        self.phases[phase_index(self.progress.phase)] += now - self.phase_start;
        self.finished = Some(now - self.start);
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Outcome { Completed, Failed, Cancelled }

struct RunState {
    id: String,
    engine: &'static str,
    path: Option<PathBuf>,
    timings: Mutex<Timings>,
}

impl RunState {
    fn write(&self, data: impl Serialize) {
        if let Some(path) = &self.path {
            // The common envelope contains only fixed codes and a random ID.
            let record = serde_json::json!({
                "version": 1,
                "run_id": self.id,
                "engine": self.engine,
                "timestamp_ms": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
                "data": data,
            });
            let _ = handoff_diagnostics::append_record(path, &record, MAX_LOG_BYTES);
        }
    }

    fn finish(&self, outcome: Outcome) {
        let timing = {
            let mut current = self.timings.lock().unwrap_or_else(|p| p.into_inner());
            if current.finished.is_some() { return; }
            let now = Instant::now();
            current.finish(now);
            current.snapshot(now)
        };
        self.write(serde_json::json!({ "kind": "run", "outcome": outcome, "timing": timing }));
    }
}

impl Drop for RunState {
    fn drop(&mut self) {
        // An aborted native future must still leave a terminal diagnostic.
        // Outstanding call guards hold a reference and settle before this drop.
        self.finish(Outcome::Cancelled);
    }
}

#[derive(Clone)]
pub(super) struct HandoffRun(Arc<RunState>);

impl HandoffRun {
    pub(super) fn logged(engine: &str, phase: HandoffPhase) -> Self {
        Self::new(engine, phase, Some(crate::paths::app_home().join("logs/handoff-timings.jsonl")))
    }

    pub(super) fn silent(phase: HandoffPhase) -> Self { Self::new("test", phase, None) }

    fn new(engine: &str, phase: HandoffPhase, path: Option<PathBuf>) -> Self {
        let now = Instant::now();
        Self(Arc::new(RunState {
            id: uuid::Uuid::new_v4().to_string(),
            engine: match engine { "codex" => "codex", "claude" => "claude", "pi" => "pi", "cursor" => "cursor", _ => "unknown" },
            path,
            timings: Mutex::new(Timings {
                start: now, phase_start: now, phases: [Duration::ZERO; 4],
                progress: HandoffProgress::stage(phase), calls: 0, completed: 0,
                model_elapsed: Duration::ZERO, last_call: None, longest_call: None, finished: None,
            }),
        }))
    }

    /// Stage counters remain the algorithm's counters, not model-call totals.
    pub(super) fn observe(&self, mut event: HandoffProgress) -> HandoffProgress {
        let mut current = self.0.timings.lock().unwrap_or_else(|p| p.into_inner());
        let now = Instant::now();
        if current.finished.is_none() {
            if current.progress.phase != event.phase {
                let phase = phase_index(current.progress.phase);
                let elapsed = now - current.phase_start;
                current.phases[phase] += elapsed;
                current.phase_start = now;
            }
            event.timing = None;
            current.progress = event;
        }
        let mut event = current.progress.clone();
        event.timing = Some(current.snapshot(now));
        event
    }

    pub(super) fn progress(&self) -> HandoffProgress {
        let current = self.0.timings.lock().unwrap_or_else(|p| p.into_inner());
        let mut event = current.progress.clone();
        event.timing = Some(current.snapshot(Instant::now()));
        event
    }

    pub(super) fn start_call(&self, phase: HandoffPhase, index: usize, total: usize, round: Option<usize>) -> CallTimer {
        let mut current = self.0.timings.lock().unwrap_or_else(|p| p.into_inner());
        current.calls += 1;
        CallTimer { run: Some(self.clone()), start: Instant::now(), phase, index, total, round }
    }

    pub(super) fn finish(&self, outcome: Outcome) { self.0.finish(outcome); }
}

pub(super) struct CallTimer {
    run: Option<HandoffRun>,
    start: Instant,
    phase: HandoffPhase,
    index: usize,
    total: usize,
    round: Option<usize>,
}

impl CallTimer {
    pub(super) fn finish(mut self, outcome: Outcome) { self.settle(outcome); }

    fn settle(&mut self, outcome: Outcome) {
        let Some(run) = self.run.take() else { return; };
        let duration = self.start.elapsed();
        {
            let mut current = run.0.timings.lock().unwrap_or_else(|p| p.into_inner());
            current.completed += 1;
            current.model_elapsed += duration;
            current.last_call = Some(duration);
            current.longest_call = Some(current.longest_call.unwrap_or_default().max(duration));
        }
        run.0.write(serde_json::json!({
            "kind": "model_call", "phase": self.phase, "index": self.index,
            "total": self.total, "round": self.round, "elapsed_ms": millis(duration), "outcome": outcome,
        }));
    }
}

impl Drop for CallTimer {
    fn drop(&mut self) { self.settle(Outcome::Cancelled); }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn wall_clock_stages_and_overlapping_calls_are_separate_and_freeze() {
        let run = HandoffRun::silent(HandoffPhase::Reading);
        tokio::time::advance(Duration::from_millis(10)).await;
        run.observe(HandoffProgress::stage(HandoffPhase::Segments));
        let first = run.start_call(HandoffPhase::Segments, 1, 2, None);
        tokio::time::advance(Duration::from_millis(20)).await;
        let second = run.start_call(HandoffPhase::Segments, 2, 2, None);
        tokio::time::advance(Duration::from_millis(30)).await;
        first.finish(Outcome::Completed);
        let partial = run.progress().timing.unwrap();
        assert_eq!((partial.model_calls, partial.completed_model_calls, partial.active_model_calls), (2, 1, 1));
        tokio::time::advance(Duration::from_millis(10)).await;
        second.finish(Outcome::Failed);
        run.observe(HandoffProgress::stage(HandoffPhase::Merging));
        let third = run.start_call(HandoffPhase::Merging, 1, 1, Some(1));
        tokio::time::advance(Duration::from_millis(40)).await;
        third.finish(Outcome::Completed);
        run.observe(HandoffProgress::stage(HandoffPhase::Verifying));
        tokio::time::advance(Duration::from_millis(5)).await;
        run.finish(Outcome::Completed);
        let expected = HandoffTiming { elapsed_ms: 115, reading_ms: 10, segments_ms: 60, merging_ms: 40, verifying_ms: 5,
            model_calls: 3, completed_model_calls: 3, active_model_calls: 0, model_elapsed_ms: 130,
            last_model_call_ms: Some(40), longest_model_call_ms: Some(50) };
        assert_eq!(run.progress().timing, Some(expected.clone()));
        tokio::time::advance(Duration::from_secs(10)).await;
        assert_eq!(run.progress().timing, Some(expected));
    }

    #[tokio::test(start_paused = true)]
    async fn dropped_calls_and_attempts_leave_bounded_content_free_terminal_records() {
        let directory = std::env::temp_dir().join(format!("ccgui-handoff-timing-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("timings.jsonl");
        std::fs::write(&path, vec![b'x'; MAX_LOG_BYTES as usize]).unwrap();
        let run = HandoffRun::new("private-provider-name", HandoffPhase::Segments, Some(path.clone()));
        let completed = run.start_call(HandoffPhase::Segments, 1, 2, None);
        tokio::time::advance(Duration::from_millis(10)).await;
        completed.finish(Outcome::Completed);
        let call = run.start_call(HandoffPhase::Segments, 2, 2, None);
        tokio::time::advance(Duration::from_millis(30)).await;
        drop(call);
        assert_eq!(run.progress().timing.unwrap().active_model_calls, 0);
        drop(run);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.len() < MAX_LOG_BYTES as usize);
        assert!(!text.contains("private-provider-name"));
        let rows: Vec<serde_json::Value> = text.lines().map(|line| serde_json::from_str(line).unwrap()).collect();
        assert_eq!(rows.len(), 3, "explicit finish plus Drop must produce exactly one row per call and run");
        assert_eq!(rows[0]["data"]["kind"], "model_call");
        assert_eq!(rows[0]["data"]["outcome"], "completed");
        assert_eq!(rows[0]["data"]["elapsed_ms"], 10);
        assert_eq!(rows[1]["data"]["kind"], "model_call");
        assert_eq!(rows[1]["data"]["outcome"], "cancelled");
        assert_eq!(rows[1]["data"]["elapsed_ms"], 30);
        assert_eq!(rows[2]["data"]["kind"], "run");
        assert_eq!(rows[2]["data"]["outcome"], "cancelled");
        assert_eq!(rows[2]["data"]["timing"]["activeModelCalls"], 0);
        assert_eq!(rows[2]["data"]["timing"]["completedModelCalls"], 2);
        assert_eq!(rows[0]["run_id"], rows[2]["run_id"]);
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn log_write_failure_does_not_affect_timing_or_result() {
        let run = HandoffRun::new("codex", HandoffPhase::Reading, Some(std::env::temp_dir()));
        run.finish(Outcome::Failed);
        assert_eq!(run.progress().timing.unwrap().model_calls, 0);
    }
}
