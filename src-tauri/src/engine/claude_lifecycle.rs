//! Claude's response result is not the end of its native run. The official
//! SDK uses session_state_changed/idle to keep control stdin available through
//! notification followups. We also retain background Bash/Monitor tasks while
//! they run: sending EOF at an earlier idle would ask the CLI to abandon them.
use super::events::{EngineEvent, NativeTask};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Default)]
pub(super) struct ClaudeLifecycle {
    state_seen: bool,
    idle: bool,
    /// The last native session_state was running/requires_action. Unlike
    /// `idle`, task events never touch it: a completion that merely made the
    /// run unfinished is not a reply an interrupt could still abort.
    mid_turn: bool,
    /// The MAIN loop is producing a reply (initial prompt, a follow-up, a
    /// notification continuation). session_state alone cannot say so: a busy
    /// background subagent keeps the CLI "running" (and its tool-permission
    /// requests flip it to requires_action) for minutes after the main reply
    /// ended, and the CLI never reports idle meanwhile. The native main loop
    /// takes a user message in that window (verified with the real CLI), so
    /// "the CLI is working" must not hide the main loop's availability.
    main_in_flight: bool,
    /// An interrupt was acknowledged while a reply was in flight, so that
    /// reply's error_during_execution result is the interrupt's own outcome.
    interrupt_armed: bool,
    result_ready: bool,
    finished: bool,
    snapshot_seen: bool,
    snapshot_ids: HashSet<String>,
    background: HashSet<String>,
    /// Tasks removed from the live snapshot whose completion may still owe
    /// a notification reply. Explicitly stopped tasks owe no such reply;
    /// their terminal patch can clear this debt without a repeated idle.
    unsettled_background: HashSet<String>,
    tasks: Vec<NativeTask>,
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(4096).collect())
}

impl ClaudeLifecycle {
    pub(super) fn system(&mut self, value: &Value, out: &mut Vec<EngineEvent>) {
        if value
            .get("parent_tool_use_id")
            .is_some_and(|v| !v.is_null())
        {
            return;
        }
        let subtype = value.get("subtype").and_then(Value::as_str).unwrap_or("");
        if self.finished
            && !matches!(
                subtype,
                "task_updated" | "task_notification" | "task_progress"
            )
        {
            return;
        }
        match subtype {
            "session_state_changed" => match value.get("state").and_then(Value::as_str) {
                Some("running") => {
                    self.enter_turn();
                    self.state_seen = true;
                    self.idle = false;
                    // With background work alive and no main reply known to be
                    // in flight this is the subagents' activity, not the main
                    // loop's: the run stays "waiting" for the UI.
                    if self.background.is_empty() || self.main_in_flight {
                        self.main_in_flight = true;
                        self.result_ready = false;
                        out.push(EngineEvent::Activity("running"));
                    }
                }
                Some("requires_action") => {
                    self.enter_turn();
                    self.state_seen = true;
                    self.idle = false;
                    if self.background.is_empty() || self.main_in_flight {
                        self.main_in_flight = true;
                        self.result_ready = false;
                        out.push(EngineEvent::Activity("requires_action"));
                    }
                }
                Some("idle") => {
                    self.state_seen = true;
                    self.idle = true;
                    self.main_in_flight = false;
                    // The armed flag deliberately survives idle: native can
                    // report the interrupted result after the idle state.
                    self.mid_turn = false;
                    self.unsettled_background.clear();
                    if !self.finish_if_ready(out) && !self.background.is_empty() {
                        out.push(EngineEvent::Activity("waiting"));
                    }
                }
                _ => {}
            },
            "background_tasks_changed" => {
                let Some(tasks) = value.get("tasks").and_then(Value::as_array) else {
                    return;
                };
                let ids: HashSet<_> = tasks.iter().filter_map(|v| text(v, "task_id")).collect();
                let next: HashSet<_> = tasks
                    .iter()
                    .filter(|v| v.get("ambient").and_then(Value::as_bool) != Some(true))
                    .filter_map(|v| text(v, "task_id"))
                    .collect();
                let reclassified =
                    self.snapshot_seen && ids == self.snapshot_ids && next != self.background;
                if next != self.background && !reclassified {
                    // A previous idle does not certify a completion that just
                    // became runnable. Wait for its own native run boundary;
                    // snapshot and notification bookends may arrive in either order.
                    self.idle = false;
                    for id in self.background.difference(&next) {
                        let stopped = self.tasks.iter().any(|task| task.id == *id && task.status == "stopped");
                        if !stopped { self.unsettled_background.insert(id.clone()); }
                    }
                }
                self.background = next;
                self.snapshot_ids = ids;
                self.snapshot_seen = true;
                for task in tasks {
                    if let Some(row) = self.row(task) {
                        Self::patch(row, task);
                        row.background = Some(true);
                    }
                }
                self.publish_tasks(out);
                // Ambient flips do not finish a task or owe a notification
                // turn. Native can remain idle without emitting another idle.
                if reclassified {
                    self.finish_if_ready(out);
                } else {
                    self.finish_quiet_stops(out);
                }
            }
            "task_started" => {
                let Some(id) = text(value, "task_id") else {
                    return;
                };
                let background = value.get("is_backgrounded").and_then(Value::as_bool);
                if background == Some(true)
                    && value.get("ambient").and_then(Value::as_bool) != Some(true)
                {
                    self.idle = false;
                    if !self.snapshot_seen {
                        self.background.insert(id);
                    }
                }
                if let Some(row) = self.row(value) {
                    Self::patch(row, value);
                    row.status = "running".into();
                }
                self.publish_tasks(out);
            }
            "task_updated" => {
                let Some(id) = text(value, "task_id") else {
                    return;
                };
                let Some(patch) = value.get("patch").filter(|p| p.is_object()) else {
                    return;
                };
                if patch.get("is_backgrounded").and_then(Value::as_bool) == Some(true) {
                    self.idle = false;
                    if !self.snapshot_seen
                        && patch.get("ambient").and_then(Value::as_bool) != Some(true)
                    {
                        self.background.insert(id.clone());
                    }
                }
                if let Some(row) = self.row(value) {
                    Self::patch(row, patch);
                    let terminal = matches!(row.status.as_str(), "completed" | "failed" | "stopped");
                    let quiet = row.status == "stopped" || row.ambient == Some(true);
                    if (terminal || quiet) && !self.snapshot_seen {
                        if !quiet && self.background.contains(&id) {
                            self.unsettled_background.insert(id.clone());
                        }
                        self.background.remove(&id);
                    }
                }
                self.publish_tasks(out);
                if self.tasks.iter().any(|task| task.id == id && task.status == "stopped") {
                    self.unsettled_background.remove(&id);
                    self.finish_quiet_stops(out);
                }
            }
            "task_notification" => {
                let Some(id) = text(value, "task_id") else {
                    return;
                };
                if !self.snapshot_seen {
                    self.background.remove(&id);
                }
                if let Some(row) = self.row(value) {
                    Self::patch(row, value);
                }
                self.publish_tasks(out);
                let stopped = self.tasks.iter().any(|task| task.id == id && task.status == "stopped");
                if stopped {
                    // Native stop_task can report killed + stopped while it
                    // remains idle, with no model reply and no new idle event.
                    self.unsettled_background.remove(&id);
                    self.finish_quiet_stops(out);
                    return;
                }
                self.idle = false;
                // The CLI answers a task's completion with a reply of its own;
                // an ambient watcher owes none.
                let owes_reply = self
                    .tasks
                    .iter()
                    .find(|task| task.id == id)
                    .map_or(true, |task| task.ambient != Some(true));
                if owes_reply {
                    self.enter_main_turn(out);
                }
            }
            "task_progress" => {
                if let Some(row) = self.row(value) {
                    if let Some(summary) = text(value, "summary") {
                        row.summary = Some(summary);
                    }
                    row.progress =
                        text(value, "description").or_else(|| text(value, "last_tool_name"));
                }
                self.publish_tasks(out);
            }
            _ => {}
        }
    }

    /// Restore the existing native idle only when all removed tasks have
    /// proved to be stopped. A natural completion or an in-flight main reply
    /// still needs its own response/idle boundary and must retain stdin.
    fn finish_quiet_stops(&mut self, out: &mut Vec<EngineEvent>) {
        if self.state_seen && !self.mid_turn && !self.main_in_flight
            && self.result_ready && self.unsettled_background.is_empty()
        {
            self.idle = true;
            self.finish_if_ready(out);
        }
    }

    /// A reply starting after idle is a new turn: an interrupt acknowledged
    /// for the previous one must not turn this turn's genuine failure into a
    /// quiet interrupt.
    fn enter_turn(&mut self) {
        if !self.mid_turn {
            self.interrupt_armed = false;
        }
        self.mid_turn = true;
    }

    /// The CLI acknowledged a ccgui interrupt control_request. Only a reply
    /// in flight can be interrupted. When only background work remains, the
    /// ack restores waiting so a Stop with no response result still settles
    /// its pending UI state. After the final Done it changes nothing.
    pub(super) fn interrupt_acknowledged(&mut self, out: &mut Vec<EngineEvent>) {
        if self.finished {
            return;
        }
        if self.result_ready && !self.main_in_flight && !self.background.is_empty() {
            out.push(EngineEvent::Activity("waiting"));
        } else if (self.mid_turn || self.main_in_flight) && !self.result_ready {
            self.interrupt_armed = true;
        }
    }

    /// Main-loop content (a streamed delta or an assistant message that does
    /// not belong to a subagent) arrived: the main loop is replying, whether
    /// it started because we wrote a follow-up or on its own.
    pub(super) fn main_message(&mut self, out: &mut Vec<EngineEvent>) {
        self.enter_main_turn(out);
    }

    fn enter_main_turn(&mut self, out: &mut Vec<EngineEvent>) {
        if self.main_in_flight || self.finished || !self.state_seen {
            return;
        }
        self.enter_turn();
        self.idle = false;
        self.result_ready = false;
        self.main_in_flight = true;
        out.push(EngineEvent::Activity("running"));
    }

    /// Consume the armed interrupt at a `result` line. Any result ends the
    /// reply the interrupt was aimed at, so the flag never outlives it.
    /// Native orders the ack before the result; a result that comes first
    /// finds nothing armed and keeps its error terminal: a genuine failure
    /// must never be swallowed on the strength of an ack that has not arrived.
    pub(super) fn take_interrupt(&mut self) -> bool {
        std::mem::take(&mut self.interrupt_armed)
    }

    pub(super) fn result(
        &mut self,
        session_id: Option<String>,
        usage: Option<Value>,
        out: &mut Vec<EngineEvent>,
    ) {
        self.finish_response(session_id, usage, false, out);
    }

    /// The reply ended by an acknowledged interrupt. The run stays open: the
    /// CLI idles and background tasks keep running, so only the usual idle
    /// logic may finish it.
    pub(super) fn interrupted_result(
        &mut self,
        session_id: Option<String>,
        usage: Option<Value>,
        out: &mut Vec<EngineEvent>,
    ) {
        self.finish_response(session_id, usage, true, out);
    }

    fn finish_response(
        &mut self,
        session_id: Option<String>,
        usage: Option<Value>,
        interrupted: bool,
        out: &mut Vec<EngineEvent>,
    ) {
        if self.finished {
            // The run already ended and stdin is closed, yet claude answered
            // again on its own. Nothing else will mark that response's end, so
            // it is its own Done boundary (the pre-lifecycle behavior).
            self.emit_done(session_id, usage, out);
            return;
        }
        // Old CLIs without native session-state events retain their existing
        // one-shot behavior, except while they explicitly report background work.
        if !self.state_seen && self.background.is_empty() {
            self.emit_done(session_id, usage, out);
            return;
        }
        if let Some(id) = session_id {
            out.push(EngineEvent::SessionId(id));
        }
        self.main_in_flight = false;
        self.result_ready = true;
        out.push(EngineEvent::TurnComplete { usage, interrupted });
        if !self.finish_if_ready(out) && !self.background.is_empty() {
            out.push(EngineEvent::Activity("waiting"));
        }
    }

    fn finish_if_ready(&mut self, out: &mut Vec<EngineEvent>) -> bool {
        if self.finished || !self.idle || !self.result_ready || !self.background.is_empty() {
            return false;
        }
        self.finished = true;
        self.emit_done(None, None, out);
        true
    }

    /// Every Done also settles the rows still unresolved, as the reader does
    /// to its copy. Task events can keep arriving after Done and each one
    /// republishes this catalog; stale "running" rows would undo the reader's
    /// settle and make a later clean exit look like unfinished work.
    fn emit_done(
        &mut self,
        session_id: Option<String>,
        usage: Option<Value>,
        out: &mut Vec<EngineEvent>,
    ) {
        for task in &mut self.tasks {
            if matches!(task.status.as_str(), "running" | "paused") {
                task.status = "unknown".into();
            }
        }
        out.push(EngineEvent::Done { session_id, usage });
    }

    fn row(&mut self, value: &Value) -> Option<&mut NativeTask> {
        let id = text(value, "task_id")?;
        let i = if let Some(i) = self.tasks.iter().position(|t| t.id == id) {
            i
        } else {
            self.tasks.push(NativeTask {
                description: id.clone(),
                id,
                kind: "task".into(),
                status: "running".into(),
                tool_use_id: None,
                summary: None,
                progress: None,
                background: None,
                ambient: None,
            });
            self.tasks.len() - 1
        };
        Some(&mut self.tasks[i])
    }

    fn patch(row: &mut NativeTask, value: &Value) {
        if let Some(kind) = text(value, "task_type") {
            row.kind = kind;
        }
        if let Some(description) = text(value, "description") {
            row.description = description;
        }
        if let Some(id) = text(value, "tool_use_id") {
            row.tool_use_id = Some(id);
        }
        if let Some(summary) = text(value, "summary") {
            row.summary = Some(summary);
        }
        if let Some(background) = value.get("is_backgrounded").and_then(Value::as_bool) {
            row.background = Some(background);
        }
        if let Some(ambient) = value.get("ambient").and_then(Value::as_bool) {
            row.ambient = Some(ambient);
        }
        if let Some(status) = value.get("status").and_then(Value::as_str) {
            row.status = match status {
                "running" | "pending" => "running",
                "completed" => "completed",
                "failed" => "failed",
                "stopped" | "killed" => "stopped",
                "paused" => "paused",
                _ => "unknown",
            }
            .into();
        }
    }

    fn publish_tasks(&mut self, out: &mut Vec<EngineEvent>) {
        // Bound completed history, never evict a live native task.
        let mut excess = self
            .tasks
            .iter()
            .filter(|t| !matches!(t.status.as_str(), "running" | "paused"))
            .count()
            .saturating_sub(256);
        self.tasks.retain(|task| {
            if excess > 0
                && !matches!(task.status.as_str(), "running" | "paused")
                && !self.background.contains(&task.id)
            {
                excess -= 1;
                false
            } else {
                true
            }
        });
        out.push(EngineEvent::Tasks(self.tasks.clone()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn state(lifecycle: &mut ClaudeLifecycle, name: &str, out: &mut Vec<EngineEvent>) {
        lifecycle.system(
            &json!({"subtype":"session_state_changed","state":name}),
            out,
        );
    }
    fn snapshot(lifecycle: &mut ClaudeLifecycle, tasks: Value, out: &mut Vec<EngineEvent>) {
        lifecycle.system(
            &json!({"subtype":"background_tasks_changed","tasks":tasks}),
            out,
        );
    }
    fn done(events: &[EngineEvent]) -> usize {
        events
            .iter()
            .filter(|e| matches!(e, EngineEvent::Done { .. }))
            .count()
    }
    fn response(lifecycle: &mut ClaudeLifecycle, out: &mut Vec<EngineEvent>) {
        lifecycle.result(
            Some("native-session".into()),
            Some(json!({"output_tokens":7})),
            out,
        );
    }

    #[test]
    fn stopping_last_idle_task_finishes_without_a_repeated_idle_or_notification_reply() {
        for snapshot_first in [true, false] {
            for notify in [true, false] {
                let mut lifecycle = ClaudeLifecycle::default();
                let mut events = vec![];
                state(&mut lifecycle, "running", &mut events);
                snapshot(&mut lifecycle, json!([{"task_id":"bg", "task_type":"local_bash"}]), &mut events);
                response(&mut lifecycle, &mut events);
                state(&mut lifecycle, "idle", &mut events);
                events.clear();
                if snapshot_first { snapshot(&mut lifecycle, json!([]), &mut events); }
                assert_eq!(done(&events), 0, "a removal alone is not proof of a quiet stop");
                lifecycle.system(&json!({"subtype":"task_updated", "task_id":"bg", "patch":{"status":"killed"}}), &mut events);
                if !snapshot_first { snapshot(&mut lifecycle, json!([]), &mut events); }
                if notify {
                    lifecycle.system(&json!({"subtype":"task_notification", "task_id":"bg", "status":"stopped"}), &mut events);
                }
                assert_eq!(done(&events), 1, "native does not re-emit idle for an already-idle stop");
                assert_eq!(last_tasks(&events)[0].status, "stopped");
                assert!(!events.iter().any(|e| matches!(e, EngineEvent::Activity("running"))));
            }
        }
    }

    #[test]
    fn stopping_a_task_cannot_discard_another_tasks_pending_notification() {
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        state(&mut lifecycle, "running", &mut events);
        snapshot(&mut lifecycle, json!([{"task_id":"a"},{"task_id":"b"}]), &mut events);
        response(&mut lifecycle, &mut events);
        state(&mut lifecycle, "idle", &mut events);
        snapshot(&mut lifecycle, json!([{"task_id":"b"}]), &mut events);
        lifecycle.system(&json!({"subtype":"task_updated", "task_id":"a", "patch":{"status":"completed"}}), &mut events);
        snapshot(&mut lifecycle, json!([]), &mut events);
        lifecycle.system(&json!({"subtype":"task_updated", "task_id":"b", "patch":{"status":"killed"}}), &mut events);
        lifecycle.system(&json!({"subtype":"task_notification", "task_id":"b", "status":"stopped"}), &mut events);
        assert_eq!(done(&events), 0, "a completed naturally and still owes its notification reply");
        lifecycle.system(&json!({"subtype":"task_notification", "task_id":"a", "status":"completed"}), &mut events);
        response(&mut lifecycle, &mut events);
        state(&mut lifecycle, "idle", &mut events);
        assert_eq!(done(&events), 1);
    }

    #[test]
    fn snapshotless_stop_keeps_another_natural_completion_pending() {
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        state(&mut lifecycle, "running", &mut events);
        for id in ["a", "b"] {
            lifecycle.system(&json!({"subtype":"task_started", "task_id":id, "is_backgrounded":true}), &mut events);
        }
        response(&mut lifecycle, &mut events);
        state(&mut lifecycle, "idle", &mut events);
        lifecycle.system(&json!({"subtype":"task_updated", "task_id":"a", "patch":{"status":"completed"}}), &mut events);
        lifecycle.system(&json!({"subtype":"task_updated", "task_id":"b", "patch":{"status":"killed"}}), &mut events);
        assert_eq!(done(&events), 0, "snapshotless natural completion still owes its notification reply");
        lifecycle.system(&json!({"subtype":"task_notification", "task_id":"a", "status":"completed"}), &mut events);
        response(&mut lifecycle, &mut events);
        state(&mut lifecycle, "idle", &mut events);
        assert_eq!(done(&events), 1);
    }

    #[test]
    fn stopping_last_task_during_a_main_reply_waits_for_that_reply() {
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        state(&mut lifecycle, "running", &mut events);
        snapshot(&mut lifecycle, json!([{"task_id":"bg"}]), &mut events);
        response(&mut lifecycle, &mut events);
        state(&mut lifecycle, "idle", &mut events);
        lifecycle.main_message(&mut events);
        snapshot(&mut lifecycle, json!([]), &mut events);
        lifecycle.system(&json!({"subtype":"task_updated", "task_id":"bg", "patch":{"status":"killed"}}), &mut events);
        lifecycle.system(&json!({"subtype":"task_notification", "task_id":"bg", "status":"stopped"}), &mut events);
        assert_eq!(done(&events), 0);
        response(&mut lifecycle, &mut events);
        assert_eq!(done(&events), 0);
        state(&mut lifecycle, "idle", &mut events);
        assert_eq!(done(&events), 1);
    }

    #[test]
    fn native_result_keeps_control_input_until_authoritative_idle() {
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        state(&mut lifecycle, "running", &mut events);
        response(&mut lifecycle, &mut events);
        assert_eq!(
            done(&events),
            0,
            "a result cannot close stdin while native continuation is pending"
        );
        state(&mut lifecycle, "requires_action", &mut events);
        assert_eq!(done(&events), 0);
        state(&mut lifecycle, "running", &mut events);
        response(&mut lifecycle, &mut events);
        state(&mut lifecycle, "idle", &mut events);
        assert_eq!(done(&events), 1);
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, EngineEvent::TurnComplete { .. }))
                .count(),
            2
        );
        state(&mut lifecycle, "idle", &mut events);
        assert_eq!(done(&events), 1);
    }

    #[test]
    fn idle_can_precede_the_result_without_hanging_a_normal_response() {
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        state(&mut lifecycle, "running", &mut events);
        state(&mut lifecycle, "idle", &mut events);
        assert_eq!(done(&events), 0);
        response(&mut lifecycle, &mut events);
        assert_eq!(done(&events), 1);
    }

    #[test]
    fn background_bash_survives_initial_idle_and_drains_all_notification_results() {
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        state(&mut lifecycle, "running", &mut events);
        snapshot(
            &mut lifecycle,
            json!([{"task_id":"bash-1","task_type":"local_bash","description":"Tests 中文 🧪"}]),
            &mut events,
        );
        response(&mut lifecycle, &mut events);
        state(&mut lifecycle, "idle", &mut events);
        assert_eq!(done(&events), 0);
        assert!(events
            .iter()
            .any(|e| matches!(e, EngineEvent::Activity("waiting"))));
        snapshot(&mut lifecycle, json!([]), &mut events);
        // The full snapshot may arrive before bookends, or before a held-back
        // result. Its empty set and a result are not a new idle certification.
        response(&mut lifecycle, &mut events);
        assert_eq!(done(&events), 0);
        lifecycle.system(&json!({"subtype":"task_notification","task_id":"bash-1","status":"completed","summary":"Tests passed"}), &mut events);
        state(&mut lifecycle, "running", &mut events);
        response(&mut lifecycle, &mut events); // coalesced, empty intermediate result
        response(&mut lifecycle, &mut events); // actual notification response
        assert_eq!(done(&events), 0);
        state(&mut lifecycle, "idle", &mut events);
        assert_eq!(done(&events), 1);
        assert_eq!(lifecycle.tasks[0].status, "completed");
        assert_eq!(lifecycle.tasks[0].description, "Tests 中文 🧪");
    }

    #[test]
    fn terminal_update_without_notification_settles_on_native_idle() {
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        state(&mut lifecycle, "running", &mut events);
        lifecycle.system(&json!({"subtype":"task_started","task_id":"agent","task_type":"local_agent","description":"Review","is_backgrounded":false}), &mut events);
        lifecycle.system(
            &json!({"subtype":"task_updated","task_id":"agent","patch":{"is_backgrounded":true}}),
            &mut events,
        );
        snapshot(
            &mut lifecycle,
            json!([{"task_id":"agent","task_type":"local_agent"}]),
            &mut events,
        );
        lifecycle.system(
            &json!({"subtype":"task_progress","task_id":"agent","description":"Reading code"}),
            &mut events,
        );
        assert_eq!(lifecycle.tasks[0].description, "Review");
        assert_eq!(lifecycle.tasks[0].progress.as_deref(), Some("Reading code"));
        lifecycle.system(
            &json!({"subtype":"task_updated","task_id":"agent","patch":{"status":"killed"}}),
            &mut events,
        );
        snapshot(&mut lifecycle, json!([]), &mut events);
        response(&mut lifecycle, &mut events);
        state(&mut lifecycle, "idle", &mut events);
        assert_eq!(done(&events), 1);
        assert_eq!(lifecycle.tasks.len(), 1);
        assert_eq!(lifecycle.tasks[0].status, "stopped");
    }

    #[test]
    fn failure_and_unknown_native_status_are_never_success() {
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        lifecycle.system(&json!({"subtype":"task_notification","task_id":"failed","status":"failed","summary":"exit 1"}), &mut events);
        lifecycle.system(&json!({"subtype":"task_updated","task_id":"unknown","patch":{"status":"new-native-state"}}), &mut events);
        assert_eq!(lifecycle.tasks[0].status, "failed");
        assert_eq!(lifecycle.tasks[1].status, "unknown");
    }

    #[test]
    fn old_cli_without_state_events_retains_one_shot_compatibility() {
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        response(&mut lifecycle, &mut events);
        assert_eq!(done(&events), 1);
        assert!(matches!(
            &events[0],
            EngineEvent::Done { usage: Some(_), .. }
        ));
    }

    #[test]
    fn malformed_snapshots_and_child_state_cannot_end_the_parent() {
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        state(&mut lifecycle, "running", &mut events);
        snapshot(&mut lifecycle, json!([{"task_id":"live"}]), &mut events);
        snapshot(&mut lifecycle, Value::Null, &mut events);
        lifecycle.system(
            &json!({"subtype":"session_state_changed","state":"idle","parent_tool_use_id":"child"}),
            &mut events,
        );
        response(&mut lifecycle, &mut events);
        assert_eq!(done(&events), 0);
        assert!(lifecycle.background.contains("live"));
    }

    #[test]
    fn ambient_watchers_do_not_pin_idle_and_late_terminal_status_still_arrives() {
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        state(&mut lifecycle, "running", &mut events);
        snapshot(
            &mut lifecycle,
            json!([{"task_id":"watcher","task_type":"local_monitor","ambient":true}]),
            &mut events,
        );
        response(&mut lifecycle, &mut events);
        state(&mut lifecycle, "idle", &mut events);
        assert_eq!(done(&events), 1);
        lifecycle.system(
            &json!({"subtype":"task_updated","task_id":"watcher","patch":{"status":"killed"}}),
            &mut events,
        );
        assert_eq!(lifecycle.tasks[0].status, "stopped");
        assert_eq!(lifecycle.tasks[0].ambient, Some(true));
    }

    #[test]
    fn paused_task_is_preserved_as_paused_not_failed_or_completed() {
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        lifecycle.system(
            &json!({"subtype":"task_started","task_id":"agent","is_backgrounded":true}),
            &mut events,
        );
        lifecycle.system(
            &json!({"subtype":"task_updated","task_id":"agent","patch":{"status":"paused"}}),
            &mut events,
        );
        assert_eq!(lifecycle.tasks[0].status, "paused");
        response(&mut lifecycle, &mut events);
        assert_eq!(
            done(&events),
            0,
            "a paused legacy background task has no terminal outcome"
        );
        state(&mut lifecycle, "requires_action", &mut events);
        state(&mut lifecycle, "running", &mut events);
        lifecycle.system(
            &json!({"subtype":"task_updated","task_id":"agent","patch":{"status":"completed"}}),
            &mut events,
        );
        response(&mut lifecycle, &mut events);
        state(&mut lifecycle, "idle", &mut events);
        assert_eq!(done(&events), 1);
    }

    #[test]
    fn old_cli_with_a_background_task_reports_each_response_once() {
        // No session_state_changed at all: only an explicit backgrounded task
        // takes the old CLI off the one-shot boundary.
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        lifecycle.system(
            &json!({"subtype":"task_started","task_id":"bg","is_backgrounded":true}),
            &mut events,
        );
        lifecycle.result(None, Some(json!({"output_tokens":3})), &mut events);
        assert_eq!(done(&events), 0, "the running task keeps the run open");
        assert!(matches!(
            events.last(),
            Some(EngineEvent::Activity("waiting"))
        ));
        assert!(events.iter().any(|e| matches!(
            e,
            EngineEvent::TurnComplete { usage: Some(u), interrupted: false } if u["output_tokens"] == 3
        )));
        lifecycle.system(
            &json!({"subtype":"task_notification","task_id":"bg","status":"completed"}),
            &mut events,
        );
        lifecycle.result(None, Some(json!({"output_tokens":5})), &mut events);
        assert_eq!(done(&events), 1);
        assert!(matches!(
            events.last(),
            Some(EngineEvent::Done { usage: Some(u), .. }) if u["output_tokens"] == 5
        ));
    }

    fn activity_sequence(events: &[EngineEvent]) -> Vec<&'static str> {
        events
            .iter()
            .filter_map(|e| match e {
                EngineEvent::Activity(state) => Some(*state),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn busy_subagent_after_the_main_reply_leaves_the_run_waiting_until_the_main_loop_replies() {
        // Real CLI (hooks loaded): after the main result a busy background
        // subagent keeps session_state running / requires_action for minutes and
        // idle only comes at the very end, yet the main loop answers a user
        // message meanwhile. The UI must keep saying "waiting" for that window.
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        state(&mut lifecycle, "running", &mut events);
        assert_eq!(activity_sequence(&events), vec!["running"]);
        snapshot(
            &mut lifecycle,
            json!([{"task_id":"agent","task_type":"local_agent"}]),
            &mut events,
        );
        response(&mut lifecycle, &mut events);
        assert_eq!(activity_sequence(&events), vec!["running", "waiting"]);
        events.clear();

        // The subagent's tool-permission denials and model calls.
        state(&mut lifecycle, "requires_action", &mut events);
        state(&mut lifecycle, "running", &mut events);
        assert!(
            activity_sequence(&events).is_empty(),
            "subagent activity is not the main loop replying: {events:?}"
        );

        // A follow-up reply: main-loop content flips the UI to running once.
        lifecycle.main_message(&mut events);
        lifecycle.main_message(&mut events);
        assert_eq!(activity_sequence(&events), vec!["running"]);
        response(&mut lifecycle, &mut events);
        assert_eq!(activity_sequence(&events), vec!["running", "waiting"]);
        events.clear();

        // The subagent finishes: its notification starts the main loop's reply.
        lifecycle.system(
            &json!({"subtype":"task_notification","task_id":"agent","status":"completed"}),
            &mut events,
        );
        snapshot(&mut lifecycle, json!([]), &mut events);
        assert_eq!(activity_sequence(&events), vec!["running"]);
        response(&mut lifecycle, &mut events);
        state(&mut lifecycle, "idle", &mut events);
        assert_eq!(done(&events), 1, "one final Done after the notification reply");
    }

    #[test]
    fn main_loop_questions_still_surface_while_its_reply_is_in_flight() {
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        state(&mut lifecycle, "running", &mut events);
        snapshot(
            &mut lifecycle,
            json!([{"task_id":"agent","task_type":"local_agent"}]),
            &mut events,
        );
        response(&mut lifecycle, &mut events);
        lifecycle.main_message(&mut events);
        events.clear();
        // The main loop (not a subagent) now needs the user.
        state(&mut lifecycle, "requires_action", &mut events);
        assert_eq!(activity_sequence(&events), vec!["requires_action"]);
    }

    #[test]
    fn an_ambient_watcher_completion_does_not_claim_a_main_reply() {
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        state(&mut lifecycle, "running", &mut events);
        snapshot(
            &mut lifecycle,
            json!([{"task_id":"watch","task_type":"local_monitor","ambient":true}]),
            &mut events,
        );
        response(&mut lifecycle, &mut events);
        state(&mut lifecycle, "idle", &mut events);
        events.clear();
        lifecycle.system(
            &json!({"subtype":"task_notification","task_id":"watch","status":"completed"}),
            &mut events,
        );
        assert!(activity_sequence(&events).is_empty());
    }

    fn last_tasks(events: &[EngineEvent]) -> Vec<NativeTask> {
        events
            .iter()
            .rev()
            .find_map(|e| match e {
                EngineEvent::Tasks(rows) => Some(rows.clone()),
                _ => None,
            })
            .expect("a tasks republish")
    }

    #[test]
    fn finishing_settles_unresolved_rows_so_a_late_task_event_cannot_revive_them() {
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        state(&mut lifecycle, "running", &mut events);
        // Foreground work with no terminal evidence when native goes idle.
        lifecycle.system(
            &json!({"subtype":"task_started","task_id":"fg","task_type":"local_agent","description":"Review","is_backgrounded":false}),
            &mut events,
        );
        response(&mut lifecycle, &mut events);
        state(&mut lifecycle, "idle", &mut events);
        assert_eq!(done(&events), 1);
        events.clear();
        // The reader settles its copy to unknown at Done; a republish carrying
        // "running" would undo that and make a later clean EOF look unfinished.
        lifecycle.system(
            &json!({"subtype":"task_progress","task_id":"fg","description":"Reading"}),
            &mut events,
        );
        assert_eq!(last_tasks(&events)[0].status, "unknown");
        // Genuine late terminal evidence still patches the row.
        lifecycle.system(
            &json!({"subtype":"task_updated","task_id":"fg","patch":{"status":"completed"}}),
            &mut events,
        );
        assert_eq!(last_tasks(&events)[0].status, "completed");
    }

    #[test]
    fn one_shot_done_settles_unresolved_rows_too() {
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        lifecycle.system(
            &json!({"subtype":"task_started","task_id":"fg","is_backgrounded":false}),
            &mut events,
        );
        response(&mut lifecycle, &mut events);
        assert_eq!(done(&events), 1);
        events.clear();
        lifecycle.system(
            &json!({"subtype":"task_progress","task_id":"fg","description":"Reading"}),
            &mut events,
        );
        assert_eq!(last_tasks(&events)[0].status, "unknown");
    }

    #[test]
    fn a_response_after_the_run_finished_is_its_own_done_boundary() {
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        state(&mut lifecycle, "running", &mut events);
        response(&mut lifecycle, &mut events);
        state(&mut lifecycle, "idle", &mut events);
        assert_eq!(done(&events), 1);
        events.clear();
        // Session-state echoes after the final Done stay ignored.
        state(&mut lifecycle, "running", &mut events);
        state(&mut lifecycle, "idle", &mut events);
        assert!(events.is_empty(), "{}", events.len());
        // stdin is already closed, so claude answering on its own can only be
        // reported by this response's own Done, with its usage.
        lifecycle.result(
            Some("native-session".into()),
            Some(json!({"output_tokens":9})),
            &mut events,
        );
        match events.as_slice() {
            [EngineEvent::Done {
                session_id: Some(id),
                usage: Some(usage),
            }] => {
                assert_eq!(id, "native-session");
                assert_eq!(usage["output_tokens"], 9);
            }
            _ => panic!("expected exactly one Done carrying usage, got {}", events.len()),
        }
    }

    #[test]
    fn staggered_background_completions_only_finish_after_the_last_one() {
        let waiting = |events: &[EngineEvent]| {
            events
                .iter()
                .filter(|e| matches!(e, EngineEvent::Activity("waiting")))
                .count()
        };
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        state(&mut lifecycle, "running", &mut events);
        snapshot(
            &mut lifecycle,
            json!([{"task_id":"a","task_type":"local_bash"},{"task_id":"b","task_type":"local_bash"}]),
            &mut events,
        );
        response(&mut lifecycle, &mut events);
        state(&mut lifecycle, "idle", &mut events);
        assert_eq!(done(&events), 0);

        // a finishes: its notification turn runs and idles while b still runs.
        snapshot(
            &mut lifecycle,
            json!([{"task_id":"b","task_type":"local_bash"}]),
            &mut events,
        );
        lifecycle.system(
            &json!({"subtype":"task_notification","task_id":"a","status":"completed","summary":"a done"}),
            &mut events,
        );
        state(&mut lifecycle, "running", &mut events);
        response(&mut lifecycle, &mut events);
        events.retain(|e| !matches!(e, EngineEvent::Activity("waiting")));
        state(&mut lifecycle, "idle", &mut events);
        assert_eq!(done(&events), 0, "b still runs after a's notification idle");
        assert_eq!(waiting(&events), 1, "idle with b pending reports waiting");

        snapshot(&mut lifecycle, json!([]), &mut events);
        lifecycle.system(
            &json!({"subtype":"task_notification","task_id":"b","status":"completed","summary":"b done"}),
            &mut events,
        );
        state(&mut lifecycle, "running", &mut events);
        response(&mut lifecycle, &mut events);
        assert_eq!(done(&events), 0);
        state(&mut lifecycle, "idle", &mut events);
        assert_eq!(done(&events), 1);
        let rows = last_tasks(&events);
        assert!(rows.iter().all(|row| row.status == "completed"), "{rows:?}");
    }

    #[test]
    fn becoming_ambient_does_not_wait_for_an_idle_the_native_cli_will_not_repeat() {
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        state(&mut lifecycle, "running", &mut events);
        snapshot(
            &mut lifecycle,
            json!([{"task_id":"watcher","ambient":false}]),
            &mut events,
        );
        response(&mut lifecycle, &mut events);
        state(&mut lifecycle, "idle", &mut events);
        assert_eq!(done(&events), 0);
        snapshot(
            &mut lifecycle,
            json!([{"task_id":"watcher","ambient":true}]),
            &mut events,
        );
        assert_eq!(done(&events), 1);
    }

    fn reply(lifecycle: &mut ClaudeLifecycle, tokens: u64, out: &mut Vec<EngineEvent>) {
        lifecycle.result(
            Some("native-session".into()),
            Some(json!({"output_tokens": tokens})),
            out,
        );
    }
    /// (output_tokens, interrupted) of every response end, in order.
    fn turns(events: &[EngineEvent]) -> Vec<(u64, bool)> {
        events
            .iter()
            .filter_map(|e| match e {
                EngineEvent::TurnComplete { usage, interrupted } => Some((
                    usage
                        .as_ref()
                        .map_or(0, |u| u["output_tokens"].as_u64().unwrap_or(0)),
                    *interrupted,
                )),
                _ => None,
            })
            .collect()
    }
    fn activities(events: &[EngineEvent], name: &str) -> usize {
        events
            .iter()
            .filter(|e| matches!(e, EngineEvent::Activity(a) if *a == name))
            .count()
    }
    /// Reply ended, CLI idle, one background task still alive.
    fn idle_with_background_task(lifecycle: &mut ClaudeLifecycle, out: &mut Vec<EngineEvent>) {
        state(lifecycle, "running", out);
        snapshot(
            lifecycle,
            json!([{"task_id":"bg","task_type":"local_bash","description":"dev server"}]),
            out,
        );
        reply(lifecycle, 7, out);
        state(lifecycle, "idle", out);
        assert_eq!(done(out), 0);
    }
    fn complete_background_task(lifecycle: &mut ClaudeLifecycle, out: &mut Vec<EngineEvent>) {
        snapshot(lifecycle, json!([]), out);
        lifecycle.system(
            &json!({"subtype":"task_notification","task_id":"bg","status":"completed","summary":"done"}),
            out,
        );
    }

    #[test]
    fn follow_up_replies_keep_the_run_open_and_each_keeps_its_own_usage() {
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        idle_with_background_task(&mut lifecycle, &mut events);

        // The user's follow-up is a whole new response cycle on the live CLI.
        // With the task alive a bare `running` state is not proof of a main
        // reply (a busy subagent reports it too); the main loop's own streamed
        // content that follows is what starts the response.
        let running_before = activities(&events, "running");
        state(&mut lifecycle, "running", &mut events);
        assert_eq!(activities(&events, "running"), running_before);
        lifecycle.main_message(&mut events);
        assert_eq!(activities(&events, "running"), running_before + 1);
        reply(&mut lifecycle, 11, &mut events);
        assert_eq!(done(&events), 0, "the follow-up result alone ends nothing");
        assert!(matches!(
            events.last(),
            Some(EngineEvent::Activity("waiting"))
        ));
        state(&mut lifecycle, "idle", &mut events);
        assert_eq!(
            done(&events),
            0,
            "the task still runs after the follow-up idles"
        );
        assert!(matches!(
            events.last(),
            Some(EngineEvent::Activity("waiting"))
        ));

        // A second follow-up cycles the same way.
        state(&mut lifecycle, "running", &mut events);
        reply(&mut lifecycle, 13, &mut events);
        state(&mut lifecycle, "idle", &mut events);
        assert_eq!(done(&events), 0);

        // Only the task's own notification turn can end the run, once.
        complete_background_task(&mut lifecycle, &mut events);
        state(&mut lifecycle, "running", &mut events);
        reply(&mut lifecycle, 17, &mut events);
        assert_eq!(done(&events), 0);
        state(&mut lifecycle, "idle", &mut events);
        assert_eq!(done(&events), 1);
        assert!(matches!(events.last(), Some(EngineEvent::Done { .. })));
        assert_eq!(
            turns(&events),
            vec![(7, false), (11, false), (13, false), (17, false)],
            "every response reports its own usage exactly once"
        );
        // Echoes after the final Done stay ignored.
        state(&mut lifecycle, "idle", &mut events);
        assert_eq!(done(&events), 1);
    }

    #[test]
    fn a_task_finishing_during_a_follow_up_waits_for_its_own_continuation_turn() {
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        idle_with_background_task(&mut lifecycle, &mut events);

        state(&mut lifecycle, "running", &mut events);
        let waiting_before = activities(&events, "waiting");
        // The task ends while the follow-up reply is still streaming.
        complete_background_task(&mut lifecycle, &mut events);
        reply(&mut lifecycle, 11, &mut events);
        assert_eq!(done(&events), 0, "the follow-up result is not the run's end");
        assert_eq!(
            activities(&events, "waiting"),
            waiting_before,
            "no task is left to wait for"
        );
        // Native then runs the notification as its own continuation turn.
        state(&mut lifecycle, "running", &mut events);
        reply(&mut lifecycle, 13, &mut events);
        assert_eq!(done(&events), 0);
        state(&mut lifecycle, "idle", &mut events);
        assert_eq!(done(&events), 1);
        assert!(matches!(events.last(), Some(EngineEvent::Done { .. })));
        assert_eq!(turns(&events), vec![(7, false), (11, false), (13, false)]);
        let rows = last_tasks(&events);
        assert!(rows.iter().all(|row| row.status == "completed"), "{rows:?}");
    }

    #[test]
    fn acknowledged_interrupt_ends_only_the_reply_and_keeps_background_work() {
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        idle_with_background_task(&mut lifecycle, &mut events);
        state(&mut lifecycle, "running", &mut events);
        lifecycle.main_message(&mut events);
        lifecycle.interrupt_acknowledged(&mut events);
        assert!(lifecycle.take_interrupt());
        lifecycle.interrupted_result(
            Some("native-session".into()),
            Some(json!({"output_tokens": 3})),
            &mut events,
        );
        assert_eq!(done(&events), 0);
        assert!(matches!(
            events.last(),
            Some(EngineEvent::Activity("waiting"))
        ));
        state(&mut lifecycle, "idle", &mut events);
        assert_eq!(
            done(&events),
            0,
            "the background task survived the interrupt"
        );
        assert!(matches!(
            events.last(),
            Some(EngineEvent::Activity("waiting"))
        ));

        complete_background_task(&mut lifecycle, &mut events);
        state(&mut lifecycle, "running", &mut events);
        reply(&mut lifecycle, 5, &mut events);
        state(&mut lifecycle, "idle", &mut events);
        assert_eq!(done(&events), 1);
        assert_eq!(turns(&events), vec![(7, false), (3, true), (5, false)]);
    }

    #[test]
    fn interrupted_reply_without_background_tasks_still_finishes_through_idle() {
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        state(&mut lifecycle, "running", &mut events);
        lifecycle.interrupt_acknowledged(&mut events);
        lifecycle.interrupted_result(None, Some(json!({"output_tokens": 2})), &mut events);
        assert_eq!(
            done(&events),
            0,
            "the interrupted result is no Done by itself"
        );
        assert_eq!(activities(&events, "waiting"), 0, "no task to wait for");
        state(&mut lifecycle, "idle", &mut events);
        assert_eq!(done(&events), 1);
        assert_eq!(turns(&events), vec![(2, true)]);
    }

    #[test]
    fn an_interrupt_ack_with_nothing_in_flight_arms_nothing() {
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        // No session state seen yet.
        lifecycle.interrupt_acknowledged(&mut events);
        assert!(!lifecycle.take_interrupt());
        // Idle with a background task alive: nothing to interrupt.
        idle_with_background_task(&mut lifecycle, &mut events);
        lifecycle.interrupt_acknowledged(&mut events);
        assert!(!lifecycle.take_interrupt());
        // A task event clears `idle` but is not a reply in flight either.
        snapshot(&mut lifecycle, json!([]), &mut events);
        lifecycle.interrupt_acknowledged(&mut events);
        assert!(!lifecycle.take_interrupt());
        // After the final Done the CLI's stdin is closed.
        state(&mut lifecycle, "running", &mut events);
        reply(&mut lifecycle, 1, &mut events);
        state(&mut lifecycle, "idle", &mut events);
        assert_eq!(done(&events), 1);
        lifecycle.interrupt_acknowledged(&mut events);
        assert!(!lifecycle.take_interrupt());
    }

    #[test]
    fn an_armed_interrupt_never_survives_into_the_next_turn() {
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        idle_with_background_task(&mut lifecycle, &mut events);
        state(&mut lifecycle, "running", &mut events);
        lifecycle.main_message(&mut events);
        lifecycle.interrupt_acknowledged(&mut events);
        assert!(lifecycle.interrupt_armed);
        // The reply finished before the interrupt landed; idle follows.
        state(&mut lifecycle, "idle", &mut events);
        // A new reply after idle is a new turn: its failure is genuine.
        state(&mut lifecycle, "running", &mut events);
        assert!(!lifecycle.take_interrupt());

        // A requires_action after idle starts a new turn as well.
        lifecycle.main_message(&mut events);
        lifecycle.interrupt_acknowledged(&mut events);
        assert!(lifecycle.interrupt_armed);
        state(&mut lifecycle, "idle", &mut events);
        state(&mut lifecycle, "requires_action", &mut events);
        assert!(!lifecycle.take_interrupt());

        // Consuming clears it: one ack interrupts one reply.
        state(&mut lifecycle, "running", &mut events);
        lifecycle.main_message(&mut events);
        lifecycle.interrupt_acknowledged(&mut events);
        assert!(lifecycle.take_interrupt());
        assert!(!lifecycle.take_interrupt());
    }

    #[test]
    fn background_activity_keeps_the_completed_main_reply_ready_for_a_waiting_ack() {
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        idle_with_background_task(&mut lifecycle, &mut events);
        events.clear();
        state(&mut lifecycle, "requires_action", &mut events);
        state(&mut lifecycle, "running", &mut events);
        assert!(lifecycle.result_ready);
        assert!(!lifecycle.main_in_flight);
        assert!(events.is_empty(), "background activity cannot claim a main reply");
        lifecycle.interrupt_acknowledged(&mut events);
        assert!(matches!(events.as_slice(), [EngineEvent::Activity("waiting")]));
        assert!(!lifecycle.take_interrupt());
        assert!(lifecycle.background.contains("bg"));
        assert_eq!(lifecycle.tasks[0].status, "running");
        assert_eq!(done(&events), 0);
        assert!(turns(&events).is_empty());
    }

    #[test]
    fn the_interrupt_ack_survives_idle_for_a_result_reported_after_it() {
        let mut lifecycle = ClaudeLifecycle::default();
        let mut events = vec![];
        state(&mut lifecycle, "running", &mut events);
        lifecycle.interrupt_acknowledged(&mut events);
        state(&mut lifecycle, "idle", &mut events);
        assert!(lifecycle.take_interrupt());
    }
}
