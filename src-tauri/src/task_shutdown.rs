//! A one-shot, local-window shutdown plan. Only fresh, consecutive observations
//! can advance it; no OS timer survives a renderer disconnect or application exit.
use serde::Serialize;
use std::future::Future;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;

const COUNTDOWN: Duration = Duration::from_secs(60);
const MAX_POLL_GAP: Duration = Duration::from_secs(4);
const NATIVE_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const NATIVE_OPERATIONS: &str = "native-operations";
static PLAN: LazyLock<Mutex<Plan>> = LazyLock::new(|| Mutex::new(Plan::default()));

#[derive(Clone, Copy, Default, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    #[default]
    Off,
    Waiting,
    Countdown,
    Requested,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    supported: bool,
    phase: Phase,
    remaining_seconds: Option<u64>,
    blockers: Vec<String>,
    generation: u64,
    error: Option<String>,
}

#[derive(Default)]
struct Plan {
    phase: Phase,
    generation: u64,
    idle_since: Option<Instant>,
    last_poll: Option<Instant>,
    blockers: Vec<String>,
    error: Option<String>,
}

fn has_unfinished_tasks(blockers: &[String]) -> bool {
    blockers.iter().any(|reason| reason != NATIVE_OPERATIONS)
}

/// Periodic plugin reads are admission barriers, not new AI tasks. Once new
/// native work is fenced, let the accepted short operations finish. Every other
/// blocker stops the commit immediately; nothing is killed to make it idle.
async fn drain_native_operations<F, Fut>(mut read: F) -> Result<Vec<String>, String>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<Vec<String>, String>>,
{
    let deadline = tokio::time::Instant::now() + NATIVE_DRAIN_TIMEOUT;
    let mut last = vec![NATIVE_OPERATIONS.to_owned()];
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Ok(last);
        }
        match tokio::time::timeout(remaining, read()).await {
            Ok(result) => last = result?,
            Err(_) => return Ok(last),
        }
        // The caller owns exactly this pause/frozen relay, not any real work.
        last.retain(|reason| reason != "runtime-updating");
        if last.is_empty() || has_unfinished_tasks(&last) {
            return Ok(last);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

impl Plan {
    fn armed(&self) -> bool {
        matches!(self.phase, Phase::Waiting | Phase::Countdown)
    }

    fn set(&mut self, enabled: bool) {
        self.generation = self.generation.wrapping_add(1);
        self.phase = if enabled { Phase::Waiting } else { Phase::Off };
        self.idle_since = None;
        self.last_poll = None;
        self.blockers.clear();
        self.error = None;
    }

    fn window_closed(&mut self, label: &str) {
        if label == "main" {
            self.set(false);
        }
    }

    fn snapshot(&self, now: Instant) -> Status {
        let fresh = self
            .last_poll
            .is_some_and(|last| now.saturating_duration_since(last) <= MAX_POLL_GAP);
        let phase = if self.phase == Phase::Countdown && !fresh {
            Phase::Waiting
        } else {
            self.phase
        };
        Status {
            supported: cfg!(windows),
            phase,
            remaining_seconds: (phase == Phase::Countdown).then(|| {
                let elapsed = now.saturating_duration_since(self.idle_since.unwrap_or(now));
                COUNTDOWN.saturating_sub(elapsed).as_millis().div_ceil(1000) as u64
            }),
            blockers: self.blockers.clone(),
            generation: self.generation,
            error: self.error.clone(),
        }
    }

    /// Returns true only at the end of an uninterrupted idle interval. Reading
    /// status never advances the plan, and an old poll cannot arm a newer plan.
    fn observe(&mut self, generation: u64, now: Instant, blockers: Vec<String>) -> bool {
        if !self.armed() || generation != self.generation {
            return false;
        }
        if self
            .last_poll
            .is_none_or(|last| now.saturating_duration_since(last) > MAX_POLL_GAP)
        {
            self.idle_since = None;
        }
        self.last_poll = Some(now);
        self.blockers = blockers;
        if has_unfinished_tasks(&self.blockers) {
            self.phase = Phase::Waiting;
            self.idle_since = None;
            return false;
        }
        self.phase = Phase::Countdown;
        let start = *self.idle_since.get_or_insert(now);
        now.saturating_duration_since(start) >= COUNTDOWN
    }

    fn fail(&mut self, generation: u64, error: String) {
        if self.armed() && generation == self.generation {
            self.phase = Phase::Failed;
            self.idle_since = None;
            self.error = Some(error);
        }
    }

    fn acknowledge_native_drain(&mut self, generation: u64) {
        if self.armed() && self.generation == generation {
            self.blockers.retain(|reason| reason != NATIVE_OPERATIONS);
        }
    }

    fn execute(
        &mut self,
        generation: u64,
        now: Instant,
        allow_shutdown: bool,
        shutdown: impl FnOnce() -> Result<(), String>,
    ) {
        if !allow_shutdown
            || !self.armed()
            || generation != self.generation
            || self
                .last_poll
                .is_none_or(|last| now.saturating_duration_since(last) > MAX_POLL_GAP)
            || self
                .idle_since
                .is_none_or(|start| now.saturating_duration_since(start) < COUNTDOWN)
            || !self.blockers.is_empty()
        {
            return;
        }
        // Exactly one attempt, even if the OS rejects it or the IPC reply is lost.
        match shutdown() {
            Ok(()) => {
                self.phase = Phase::Requested;
                self.idle_since = None;
            }
            Err(error) => self.fail(generation, error),
        }
    }
}

fn main_window(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("Shutdown is available only in the main local window".into())
    }
}

/// Both close requests and destruction invalidate in-flight final polls. A
/// cancelled close still leaves the one-shot plan off until explicitly rearmed.
pub(crate) fn cancel_on_window_close(label: &str) {
    PLAN.lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .window_closed(label);
}

#[tauri::command]
pub(crate) fn task_shutdown_status(window: tauri::WebviewWindow) -> Result<Status, String> {
    main_window(window.label())?;
    Ok(PLAN
        .lock()
        .map_err(|_| "Shutdown plan unavailable")?
        .snapshot(Instant::now()))
}

#[tauri::command]
pub(crate) fn task_shutdown_set(
    window: tauri::WebviewWindow,
    enabled: bool,
) -> Result<Status, String> {
    main_window(window.label())?;
    if enabled && !cfg!(windows) {
        return Err("Task shutdown is not supported on this platform".into());
    }
    let mut plan = PLAN.lock().map_err(|_| "Shutdown plan unavailable")?;
    plan.set(enabled);
    Ok(plan.snapshot(Instant::now()))
}

/// Owns only the temporary fence taken for this shutdown attempt. Failure or
/// cancellation releases it; an update's independently-owned fence is untouched.
struct AdmissionFence(crate::host_chat::UpdateTicket);
impl Drop for AdmissionFence {
    fn drop(&mut self) {
        crate::worker_host::set_paused(false);
        if let Err(error) = crate::host_chat::abort_update(&self.0) {
            eprintln!("[task-shutdown] release admission fence: {error}");
        }
    }
}

async fn finish(app: &tauri::AppHandle, generation: u64) -> Result<(), String> {
    let operation = crate::handoff::task_shutdown_operation().await;
    {
        let plan = PLAN.lock().map_err(|_| "Shutdown plan unavailable")?;
        if !plan.armed() || generation != plan.generation {
            return Ok(());
        }
    }
    if crate::worker_host::paused() {
        return Err("Runtime admission is already paused".into());
    }
    // Unlike worker quiescence this fence never cancels memory inference. Hold
    // it before observing leases, so none can enter between this check and the
    // worker's existing cancel_all behavior.
    let memory_pause = crate::plugin_memory::pause_admission();
    let state = app.state::<crate::AppState>();
    let blockers = crate::task_shutdown_activity::blockers(&state).await?;
    if has_unfinished_tasks(&blockers) {
        PLAN.lock()
            .map_err(|_| "Shutdown plan unavailable")?
            .observe(generation, Instant::now(), blockers);
        return Ok(());
    }
    let ticket = crate::host_chat::prepare_update(Duration::from_secs(2)).await?;
    let fence = AdmissionFence(ticket);
    crate::worker_host::quiesce().await?;
    let blockers =
        drain_native_operations(|| crate::task_shutdown_activity::blockers(&state)).await?;
    if !blockers.is_empty() {
        PLAN.lock()
            .map_err(|_| "Shutdown plan unavailable")?
            .observe(generation, Instant::now(), blockers);
        return Ok(());
    }
    let processes = state.processes.clone();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        // spawn_blocking outlives cancellation of its awaiting future. Keep both
        // admission fences owned by the actual final check and OS callback.
        let _memory_pause = memory_pause;
        let _fence = fence;
        // Linearize the final check with pre-spawn reservations. Legacy sends
        // recheck paused under this same lock; worker admission is quiesced.
        let runs = processes
            .0
            .lock()
            .map_err(|_| "Process registry unavailable")?;
        let mut plan = PLAN.lock().map_err(|_| "Shutdown plan unavailable")?;
        if !runs.is_empty() {
            plan.observe(generation, Instant::now(), vec!["native-runs".into()]);
        } else {
            // Clear only the short operations just proven drained, retaining
            // the original frontend heartbeat age and countdown deadline.
            plan.acknowledge_native_drain(generation);
            plan.execute(
                generation,
                Instant::now(),
                app.get_webview_window("main").is_some(),
                request_shutdown,
            );
        }
        Ok::<_, String>(())
    })
    .await
    .map_err(|_| "Shutdown request worker failed".to_string())?
}

#[tauri::command]
pub(crate) async fn task_shutdown_poll(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    generation: u64,
    frontend_busy: bool,
    allow_shutdown: bool,
) -> Result<Status, String> {
    main_window(window.label())?;
    {
        let plan = PLAN.lock().map_err(|_| "Shutdown plan unavailable")?;
        if !plan.armed() || generation != plan.generation {
            return Ok(plan.snapshot(Instant::now()));
        }
    }
    let result = crate::task_shutdown_activity::blockers(&app.state::<crate::AppState>()).await;
    let due = {
        let mut plan = PLAN.lock().map_err(|_| "Shutdown plan unavailable")?;
        match result {
            Ok(mut blockers) => {
                if frontend_busy {
                    blockers.push("frontend-tasks".into());
                }
                plan.observe(generation, Instant::now(), blockers)
            }
            Err(error) => {
                plan.fail(generation, error);
                false
            }
        }
    };
    // A normal heartbeat may reach zero after a delayed timer. It cannot commit
    // until the renderer has synchronously fenced new submissions for this poll.
    if due && allow_shutdown {
        if let Err(error) = finish(&app, generation).await {
            PLAN.lock()
                .map_err(|_| "Shutdown plan unavailable")?
                .fail(generation, error);
        }
    }
    Ok(PLAN
        .lock()
        .map_err(|_| "Shutdown plan unavailable")?
        .snapshot(Instant::now()))
}

#[cfg(windows)]
fn request_shutdown() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // Keep the cancellable countdown in CCGUI. Windows implies /f for /t > 0:
    // https://learn.microsoft.com/windows-server/administration/windows-commands/shutdown
    // Resolve the system executable explicitly, never through the workspace PATH.
    let root = std::env::var_os("SystemRoot").ok_or("Windows system directory unavailable")?;
    let executable = std::path::PathBuf::from(root)
        .join("System32")
        .join("shutdown.exe");
    if !executable.is_absolute() {
        return Err("Invalid Windows system directory".into());
    }
    let output = std::process::Command::new(executable)
        .args(["/s", "/t", "0"])
        .creation_flags(0x0800_0000)
        .output()
        .map_err(|error| format!("Unable to request Windows shutdown: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Windows rejected shutdown (exit code {:?})",
            output.status.code()
        ))
    }
}

#[cfg(not(windows))]
fn request_shutdown() -> Result<(), String> {
    Err("Task shutdown is not supported on this platform".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idle_until(plan: &mut Plan, start: Instant, seconds: u64) -> bool {
        let mut due = false;
        for second in 0..=seconds {
            due = plan.observe(plan.generation, start + Duration::from_secs(second), vec![]);
        }
        due
    }

    #[test]
    fn requires_a_full_idle_countdown_and_executes_once() {
        let now = Instant::now();
        let mut plan = Plan::default();
        plan.set(true);
        assert!(!idle_until(&mut plan, now, 59));
        assert_eq!(
            plan.snapshot(now + Duration::from_secs(59))
                .remaining_seconds,
            Some(1)
        );
        assert!(plan.observe(plan.generation, now + COUNTDOWN, vec![]));
        let mut calls = 0;
        plan.execute(plan.generation, now + COUNTDOWN, false, || {
            panic!("unfenced heartbeat")
        });
        plan.execute(plan.generation, now + COUNTDOWN, true, || {
            calls += 1;
            Ok(())
        });
        plan.execute(plan.generation, now + COUNTDOWN, true, || {
            calls += 1;
            Ok(())
        });
        assert_eq!(calls, 1);
        assert_eq!(plan.phase, Phase::Requested);
    }

    #[tokio::test(start_paused = true)]
    async fn idle_workbench_polling_reaches_shutdown_only_after_native_operations_drain() {
        let now = Instant::now();
        let mut plan = Plan::default();
        plan.set(true);
        // The workbench refreshes every five seconds even with no AI tasks.
        // Before the fix each sample at 0/5/10/... restarted the full minute.
        for second in 0..=60 {
            let blockers = if second % 5 == 0 {
                vec![NATIVE_OPERATIONS.into()]
            } else {
                vec![]
            };
            assert_eq!(
                plan.observe(plan.generation, now + Duration::from_secs(second), blockers),
                second == 60
            );
        }
        assert_eq!(plan.snapshot(now + COUNTDOWN).remaining_seconds, Some(0));
        plan.execute(plan.generation, now + COUNTDOWN, true, || {
            panic!("native read still in flight")
        });
        let mut observations = std::collections::VecDeque::from([
            vec!["runtime-updating".into(), NATIVE_OPERATIONS.into()],
            vec!["runtime-updating".into()],
        ]);
        let final_blockers =
            drain_native_operations(|| std::future::ready(Ok(observations.pop_front().unwrap())))
                .await
                .unwrap();
        assert!(final_blockers.is_empty());
        plan.acknowledge_native_drain(plan.generation);
        let mut requests = 0;
        plan.execute(plan.generation, now + COUNTDOWN, true, || {
            requests += 1;
            Ok(())
        });
        assert_eq!(requests, 1);
        assert_eq!(plan.phase, Phase::Requested);
    }

    #[test]
    fn real_tasks_still_reset_countdown_alongside_periodic_native_reads() {
        let now = Instant::now();
        for reason in [
            "native-runs",
            "child-tasks",
            "parent-continuations",
            "frontend-tasks",
            "background-work",
            "worker-background-work",
        ] {
            let mut plan = Plan::default();
            plan.set(true);
            idle_until(&mut plan, now, 59);
            assert!(!plan.observe(
                plan.generation,
                now + COUNTDOWN,
                vec![NATIVE_OPERATIONS.into(), reason.into()]
            ));
            plan.acknowledge_native_drain(plan.generation);
            plan.execute(plan.generation, now + COUNTDOWN, true, || {
                panic!("unfinished {reason}")
            });
            assert_eq!(plan.phase, Phase::Waiting);
            assert!(!plan.observe(plan.generation, now + Duration::from_secs(61), vec![]));
            assert_eq!(
                plan.snapshot(now + Duration::from_secs(61))
                    .remaining_seconds,
                Some(60)
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn final_drain_is_bounded_and_does_not_ignore_new_tasks_or_errors() {
        let started = tokio::time::Instant::now();
        let result =
            drain_native_operations(|| std::future::ready(Ok(vec![NATIVE_OPERATIONS.into()])))
                .await
                .unwrap();
        assert_eq!(result, [NATIVE_OPERATIONS]);
        assert!(
            tokio::time::Instant::now() - started
                <= NATIVE_DRAIN_TIMEOUT + Duration::from_millis(50)
        );
        let result = drain_native_operations(|| {
            std::future::ready(Ok(vec!["native-runs".into(), NATIVE_OPERATIONS.into()]))
        })
        .await
        .unwrap();
        assert!(has_unfinished_tasks(&result));
        let error =
            drain_native_operations(|| std::future::ready(Err("activity unavailable".into())))
                .await
                .unwrap_err();
        assert_eq!(error, "activity unavailable");
    }

    #[tokio::test(start_paused = true)]
    async fn slow_final_activity_read_cannot_turn_unknown_state_into_idle() {
        let result = drain_native_operations(|| async {
            tokio::time::sleep(Duration::from_secs(10)).await;
            Ok(Vec::new())
        })
        .await
        .unwrap();
        assert!(!result.is_empty());
    }

    #[test]
    fn cancellation_or_rearm_during_native_drain_cannot_clear_the_new_plan() {
        let now = Instant::now();
        let mut plan = Plan::default();
        plan.set(true);
        let old = plan.generation;
        idle_until(&mut plan, now, 60);
        plan.set(false);
        plan.acknowledge_native_drain(old);
        plan.execute(old, now + COUNTDOWN, true, || panic!("cancelled"));
        plan.set(true);
        plan.observe(
            plan.generation,
            now + COUNTDOWN,
            vec![NATIVE_OPERATIONS.into()],
        );
        plan.acknowledge_native_drain(old);
        assert_eq!(plan.blockers, [NATIVE_OPERATIONS]);
    }

    #[test]
    fn new_work_restarts_the_entire_countdown() {
        let now = Instant::now();
        let mut plan = Plan::default();
        plan.set(true);
        idle_until(&mut plan, now, 59);
        assert!(!plan.observe(
            plan.generation,
            now + COUNTDOWN,
            vec!["parent-continuations".into()]
        ));
        assert_eq!(plan.phase, Phase::Waiting);
        assert!(!plan.observe(plan.generation, now + Duration::from_secs(61), vec![]));
        assert_eq!(
            plan.snapshot(now + Duration::from_secs(61))
                .remaining_seconds,
            Some(60)
        );
    }

    #[test]
    fn disconnect_sleep_and_late_final_check_never_execute() {
        let now = Instant::now();
        let mut plan = Plan::default();
        plan.set(true);
        idle_until(&mut plan, now, 59);
        plan.execute(
            plan.generation,
            now + Duration::from_secs(120),
            true,
            || panic!("stale observation"),
        );
        assert!(!plan.observe(plan.generation, now + Duration::from_secs(120), vec![]));
        assert_eq!(
            plan.snapshot(now + Duration::from_secs(120))
                .remaining_seconds,
            Some(60)
        );
    }

    #[test]
    fn cancellation_and_rearming_reject_old_inflight_work() {
        let now = Instant::now();
        let mut plan = Plan::default();
        plan.set(true);
        let old = plan.generation;
        assert!(idle_until(&mut plan, now, 60));
        plan.set(false);
        plan.execute(old, now + COUNTDOWN, true, || panic!("cancelled"));
        assert!(!plan.observe(old, now + COUNTDOWN, vec![]));
        plan.set(true);
        plan.fail(old, "old error".into());
        plan.execute(old, now + COUNTDOWN, true, || panic!("old plan"));
        assert!(!plan.observe(old, now + COUNTDOWN, vec![]));
        assert_eq!(plan.phase, Phase::Waiting);
        assert_eq!(plan.error, None);
    }

    #[test]
    fn main_close_invalidates_final_poll_even_if_window_still_exists() {
        let now = Instant::now();
        let mut plan = Plan::default();
        plan.set(true);
        let generation = plan.generation;
        assert!(idle_until(&mut plan, now, 60));
        // CloseRequested precedes destruction, so the window can still exist.
        plan.window_closed("main");
        assert_eq!(plan.phase, Phase::Off);
        assert_ne!(plan.generation, generation);
        plan.acknowledge_native_drain(generation);
        plan.execute(generation, now + COUNTDOWN, true, || panic!("closed main"));
        assert!(!plan.observe(generation, now + COUNTDOWN, vec![]));
        // A subsequent Destroyed event invalidates again, and a newly armed
        // plan cannot be advanced by the old window's final poll.
        plan.window_closed("main");
        plan.set(true);
        plan.execute(generation, now + COUNTDOWN, true, || panic!("old window"));
        assert_eq!(plan.phase, Phase::Waiting);
    }

    #[test]
    fn final_commit_requires_existing_main_window_and_ignores_secondary_closes() {
        let now = Instant::now();
        let mut plan = Plan::default();
        plan.set(true);
        let generation = plan.generation;
        assert!(idle_until(&mut plan, now, 60));
        for label in ["plugin:window", "pet-overlay", "web"] {
            plan.window_closed(label);
        }
        assert_eq!(plan.generation, generation);
        plan.execute(generation, now + COUNTDOWN, false, || panic!("missing main"));
        assert_eq!(plan.phase, Phase::Countdown);
        let mut requests = 0;
        plan.execute(generation, now + COUNTDOWN, true, || {
            requests += 1;
            Ok(())
        });
        assert_eq!(requests, 1);
    }

    #[tokio::test]
    async fn accepted_memory_work_blocks_shutdown_without_cancelling_its_lease() {
        let now = Instant::now();
        let mut plan = Plan::default();
        plan.set(true);
        assert!(idle_until(&mut plan, now, 60));
        let gate = crate::plugin_memory::gate::Gate::test_ready();
        let mut lease = gate.admit("p", "review", || false, false).unwrap();
        assert!(lease.mark_sent());
        let pause = gate.pause_admission();
        assert!(gate.has_active_work());
        plan.observe(plan.generation, now + COUNTDOWN, vec!["background-work".into()]);
        plan.execute(plan.generation, now + COUNTDOWN, true, || panic!("active memory"));
        assert_eq!(plan.phase, Phase::Waiting);
        assert!(!*lease.cancelled.borrow());
        assert_eq!(lease.run(async { 42 }).await, Ok(42));
        drop(lease);
        assert!(!gate.has_active_work());
        drop(pause);
        assert!(gate.read_epoch(|| false, false).is_ok());
        assert!(idle_until(&mut plan, now + Duration::from_secs(61), 60));
        let mut requests = 0;
        plan.execute(plan.generation, now + Duration::from_secs(121), true, || {
            requests += 1;
            Ok(())
        });
        assert_eq!(requests, 1);
    }

    #[test]
    fn failed_os_request_does_not_retry_and_cold_start_is_off() {
        let now = Instant::now();
        let mut plan = Plan::default();
        assert_eq!(plan.phase, Phase::Off);
        plan.set(true);
        idle_until(&mut plan, now, 60);
        plan.execute(plan.generation, now + COUNTDOWN, true, || {
            Err("access denied".into())
        });
        plan.execute(plan.generation, now + COUNTDOWN, true, || panic!("retry"));
        assert_eq!(plan.phase, Phase::Failed);
        assert_eq!(plan.error.as_deref(), Some("access denied"));
    }

    #[test]
    fn only_local_main_window_can_control_power() {
        assert!(main_window("main").is_ok());
        for label in ["plugin:window", "web", "pet-overlay", ""] {
            assert!(main_window(label).is_err());
        }
    }
}
