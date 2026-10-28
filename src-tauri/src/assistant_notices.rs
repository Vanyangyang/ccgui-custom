//! CCGUI-owned completion inbox and optional, source-bound isolated observations.
//! No external companion application or agent hook is involved in this service.
mod completion_audio;
pub(crate) mod completion_outbox;
mod config;
mod legacy_preferences;
#[cfg(feature = "test-harness")]
pub(crate) mod native_fixture;
mod observer;
mod overlay;
mod policy;
pub(crate) mod store;

use completion_outbox::{Checkpoint, Outbox, Pending};
pub use config::Config;
#[cfg(test)]
use config::Persisted;
use config::{read_config, save_config, MAX_GENERATION};
use parking_lot::Mutex;
use policy::{Policy, Snapshot, Ticket};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use store::{CommitStatus, Notice, NoticeKind, NoticeObserver, NoticeSource, Store};
use tauri::{Emitter, Manager};
use tokio::sync::oneshot;

const MAIN: &str = "main";
const CHANGED: &str = "assistant-notices://changed";
const STATUS: &str = "assistant-notices://status";
const FOCUS: &str = "assistant-notices://focus-request";
const HOLD_MS: u64 = 15_000;
// This is an admission-protocol epoch, not the optional observer's settings revision.
// Already-admitted rows remain deliverable regardless of their stored epoch.
const ADMISSION_GENERATION: u64 = 1;

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|v| v.as_millis().min(MAX_GENERATION as u128) as u64)
        .unwrap_or(0)
}
fn clip(text: &str, max: usize) -> String {
    text.trim()
        .chars()
        .take(max)
        .collect::<String>()
        .trim()
        .to_owned()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    #[serde(flatten)]
    config: Config,
    available: bool,
    observer_available: bool,
    reason: String,
    model: String,
    effort: String,
    provider: String,
    revision: u64,
    voice_available: bool,
    source_engines: Vec<String>,
}
#[derive(Default)]
struct Attention {
    document_id: String,
    active: Option<String>,
    attentive: bool,
    seen_at: u64,
}
struct FocusWait {
    document_id: String,
    generation: u64,
    notice_id: String,
    source_key: String,
    expires: u64,
    result: oneshot::Sender<Result<(), String>>,
}
struct Job {
    ticket: Ticket,
    abort: tokio::task::AbortHandle,
}
struct Observation {
    source: NoticeSource,
    snapshot: Snapshot,
    started_at_ms: u64,
    captured_at_ms: u64,
    policy_generation: u64,
    checkpoint: Option<Checkpoint>,
}
impl Observation {
    fn fresh(&self, at: u64) -> bool {
        at >= self.captured_at_ms && at.saturating_sub(self.captured_at_ms) < policy::TICKET_MS
    }
}
#[derive(Debug)]
enum ObservationError {
    ProgressStorage,
    Store(String),
}
struct Hold {
    remaining: u64,
    until: u64,
}

struct Inner {
    config: Config,
    generation: u64,
    policy_epoch: u64,
    policy_context: Option<(u64, bool, String)>,
    fatal: Option<String>,
    configuration_error: Option<String>,
    storage_error: Option<String>,
    window_error: bool,
    observer_available: bool,
    observer_storage_error: bool,
    observer_error: Option<String>,
    observer_route: Option<[u8; 32]>,
    source_engines: Vec<String>,
    stopped: bool,
    policy: Policy,
    locale: String,
    actually_focused: bool,
    document_id: String,
    attention: Attention,
    sources: HashMap<String, NoticeSource>,
    focus: HashMap<String, FocusWait>,
    jobs: HashMap<String, Job>,
    holds: HashMap<String, Hold>,
    dragging: bool,
    last_reap: u64,
    desktop_ids: Vec<String>,
}
impl Inner {
    fn observer_ready(&self, at: u64) -> bool {
        self.config.enabled
            && self.config.observer_enabled
            && self.observer_available
            && !self.observer_storage_error
            && !self.config.paused
            && !(self.config.focus_mode && self.foreground_source(at).is_some())
            && !self.stopped
            && self.fatal.is_none()
            && self.configuration_error.is_none()
            && self.storage_error.is_none()
    }
    fn set_observer_available(&mut self, available: bool, at: u64) {
        self.observer_available = available;
        self.reconfigure(at);
    }
    fn set_environment(
        &mut self,
        available: bool,
        route: Option<[u8; 32]>,
        sources: Vec<String>,
        at: u64,
    ) {
        if self.observer_route != route || self.source_engines != sources {
            self.observer_route = route;
            self.source_engines = sources;
            self.observer_error = None;
            self.policy_context = None;
        }
        self.set_observer_available(available, at);
    }
    fn save_preferences(
        &mut self,
        path: &Path,
        config: Config,
        expected_revision: u64,
        at: u64,
    ) -> Result<bool, String> {
        if expected_revision != self.generation {
            return Err("config_conflict".into());
        }
        config.validate()?;
        if self.config == config && self.configuration_error.is_none() {
            return Ok(false);
        }
        let generation = self
            .generation
            .checked_add(1)
            .filter(|v| *v <= MAX_GENERATION)
            .ok_or("generation_exhausted")?;
        // No policy, admission or in-flight job is mutated until the durable write succeeds.
        save_config(path, &config, generation)?;
        self.config = config;
        self.generation = generation;
        self.configuration_error = None;
        self.observer_error = None;
        self.reconfigure(at);
        self.fail_focus("settings_changed");
        Ok(true)
    }
    fn open_notice(&self, store: &Store, id: &str) -> Result<Notice, String> {
        if self.document_id.is_empty() {
            return Err("focus_unavailable".into());
        }
        if self.focus.len() >= 8 {
            return Err("focus_capacity".into());
        }
        store
            .get(id)?
            .filter(|n| n.kind == NoticeKind::Aside || !n.read)
            .ok_or_else(|| "notice_unavailable".into())
    }
    fn foreground_source(&self, at: u64) -> Option<&str> {
        (self.actually_focused
            && self.attention.attentive
            && !self.document_id.is_empty()
            && self.attention.document_id == self.document_id
            && at.saturating_sub(self.attention.seen_at) < 15_000)
            .then_some(self.attention.active.as_deref())
            .flatten()
    }
    fn desktop_notices(&self, notices: Vec<Notice>, at: u64) -> Vec<Notice> {
        if !self.config.enabled || self.stopped {
            return Vec::new();
        }
        let foreground = self.foreground_source(at);
        notices
            .into_iter()
            .filter(|notice| {
                notice.kind != NoticeKind::Aside || foreground != Some(notice.source.key().as_str())
            })
            .collect()
    }
    fn clear_disabled_asides(&mut self, store: &Store, at: u64) -> Result<bool, String> {
        if self.config.enabled && self.config.observer_enabled && !self.config.paused {
            return Ok(false);
        }
        let mut changed = false;
        for notice in store
            .unread(at)?
            .into_iter()
            .filter(|n| n.kind == NoticeKind::Aside)
        {
            changed |= store.mark_read(&notice.id)?;
        }
        self.holds.clear();
        Ok(changed)
    }
    fn attach(&mut self) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        self.fail_focus("document_replaced");
        self.document_id = id.clone();
        self.attention = Attention::default();
        self.sources.clear();
        id
    }
    fn acknowledge(
        &mut self,
        store: &Store,
        document: &str,
        request: &str,
        success: bool,
        focused: bool,
        at: u64,
    ) -> Result<bool, String> {
        if document.is_empty() || self.document_id != document {
            return Err("stale_document".into());
        }
        let pending = self.focus.get(request).ok_or("focus_expired")?;
        if pending.document_id != document
            || pending.generation != self.generation
            || pending.expires <= at
        {
            return Err("focus_expired".into());
        }
        let result = if !success || !focused {
            Err("focus_failed".into())
        } else {
            match store.get(&pending.notice_id)? {
                // A preceding explicit attention sync may already have read this exact notice.
                Some(item) if item.source.key() == pending.source_key => {
                    store.mark_read(&pending.notice_id).map(|_| ())
                }
                _ => Err("notice_unavailable".into()),
            }
        };
        let changed = result.is_ok();
        if let Some(pending) = self.focus.remove(request) {
            let _ = pending.result.send(result);
        }
        Ok(changed)
    }
    fn status(&self) -> Status {
        let reason = if self.stopped {
            "stopped"
        } else if let Some(reason) = &self.fatal {
            reason
        } else if let Some(reason) = &self.storage_error {
            reason
        } else if self.window_error {
            "window_unavailable"
        } else if let Some(reason) = &self.configuration_error {
            reason
        } else if self.config.observer_enabled && self.observer_error.is_some() {
            self.observer_error.as_deref().unwrap()
        } else if self.config.observer_enabled && !self.observer_available {
            "observer_unavailable"
        } else {
            "ok"
        };
        Status {
            config: self.config.clone(),
            available: !self.stopped
                && self.fatal.is_none()
                && self.storage_error.is_none()
                && !self.window_error,
            observer_available: self.observer_available && !self.observer_storage_error,
            reason: reason.into(),
            model: self.config.observer_model.clone(),
            effort: self.config.observer_effort.clone(),
            provider: if self.config.observer_engine == config::VERTEX_ENGINE {
                "vertex".into()
            } else {
                self.config.observer_engine.clone()
            },
            revision: self.generation,
            voice_available: cfg!(windows),
            source_engines: self.source_engines.clone(),
        }
    }
    fn reconfigure(&mut self, at: u64) {
        let viewing_chat = self.foreground_source(at).is_some();
        let context = (
            self.generation,
            self.observer_ready(at),
            self.locale.clone(),
        );
        if self.policy_context.as_ref() != Some(&context) {
            if let Some(next) = self
                .policy_epoch
                .checked_add(1)
                .filter(|epoch| *epoch <= MAX_GENERATION)
            {
                self.policy_epoch = next;
            } else {
                self.fatal = Some("generation_exhausted".into());
            }
            self.policy_context = Some(context);
        }
        self.policy.configure(
            self.policy_epoch,
            self.config.enabled
                && self.config.observer_enabled
                && self.observer_available
                && !self.observer_storage_error
                && !self.stopped
                && self.fatal.is_none()
                && self.configuration_error.is_none()
                && self.storage_error.is_none(),
            self.config.paused,
            self.config.focus_mode,
            viewing_chat,
            &self.locale,
            at,
        );
        let expired: Vec<_> = self
            .jobs
            .iter()
            .filter(|(_, job)| !self.policy.current(&job.ticket, at))
            .map(|(key, _)| key.clone())
            .collect();
        for key in expired {
            if let Some(job) = self.jobs.remove(&key) {
                job.abort.abort();
            }
        }
    }
    fn fail_focus(&mut self, reason: &str) {
        for (_, request) in self.focus.drain() {
            let _ = request.result.send(Err(reason.into()));
        }
    }
    fn cancel_job(&mut self, key: &str, at: u64) {
        self.policy.cancel(key, at);
        if let Some(job) = self.jobs.remove(key) {
            job.abort.abort();
        }
    }
}

pub struct Service {
    app: tauri::AppHandle,
    path: PathBuf,
    store: Option<Arc<Store>>,
    outbox: Option<Arc<Outbox>>,
    observer_probe: fn(&Config) -> bool,
    audio: completion_audio::AudioService,
    inner: Mutex<Inner>,
    presentation: Mutex<()>,
    emitted_status: Mutex<Option<Status>>,
    loop_handle: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl Service {
    fn update_environment(&self, inner: &mut Inner, at: u64) {
        let available = (self.observer_probe)(&inner.config);
        let route = if available {
            observer::selection(&inner.config)
                .ok()
                .map(|route| route.fingerprint)
        } else {
            None
        };
        inner.set_environment(
            available && route.is_some(),
            route,
            observer::source_engines(),
            at,
        );
    }
    fn focused(&self) -> bool {
        overlay::main_focused(&self.app)
    }
    fn emit<T: Serialize + Clone>(&self, name: &str, payload: T) {
        let _ = self.app.emit_to(MAIN, name, payload.clone());
        let _ = self.app.emit_to(overlay::LABEL, name, payload);
    }
    fn status(&self) -> Status {
        self.inner.lock().status()
    }
    fn emit_status(&self) {
        let status = self.status();
        let mut last = self.emitted_status.lock();
        if last.as_ref() == Some(&status) {
            return;
        }
        *last = Some(status.clone());
        drop(last);
        self.emit(STATUS, status);
    }
    fn usable<'a>(&'a self, inner: &Inner) -> Result<&'a Store, String> {
        if inner.stopped {
            return Err("stopped".into());
        }
        if let Some(reason) = &inner.fatal {
            return Err(reason.clone());
        }
        self.store
            .as_deref()
            .ok_or_else(|| "storage_unavailable".into())
    }
    // No caller holds Inner across native window work. Serial presentation reads the latest
    // configuration, so an older refresh cannot show a window after opt-out hides it.
    fn refresh(&self, mut changed: bool) {
        let _presentation = self.presentation.lock();
        let visible = {
            let mut inner = self.inner.lock();
            let result = self.store.as_ref().map(|s| s.unread(now()));
            match result {
                Some(Ok(items)) => {
                    let items = inner.desktop_notices(items, now());
                    let ids: Vec<_> = items.iter().map(|item| item.id.clone()).collect();
                    changed |= inner.desktop_ids != ids;
                    inner.desktop_ids = ids;
                    inner.fatal.is_none() && !items.is_empty()
                }
                Some(Err(reason)) => {
                    inner.storage_error = Some(reason);
                    false
                }
                None => false,
            }
        };
        let result = overlay::show(&self.app, visible);
        {
            let mut inner = self.inner.lock();
            inner.window_error = result.is_err();
        }
        if changed {
            self.emit(CHANGED, ());
        }
        self.emit_status();
    }
    fn release_hold(store: &Store, inner: &mut Inner, id: &str, at: u64) -> Result<(), String> {
        if let Some(hold) = inner.holds.get(id) {
            store.set_expiry(id, Some(at.saturating_add(hold.remaining.max(1))))?;
            inner.holds.remove(id);
        }
        Ok(())
    }
    fn hold(store: &Store, inner: &mut Inner, id: &str, held: bool, at: u64) -> Result<(), String> {
        if !held {
            return Self::release_hold(store, inner, id, at);
        }
        let item = store
            .get(id)?
            .filter(|n| n.kind == NoticeKind::Aside && !n.read)
            .ok_or("notice_unavailable")?;
        if item.pinned {
            return Ok(());
        }
        if let Some(hold) = inner.holds.get_mut(id) {
            hold.until = at + HOLD_MS;
            return Ok(());
        }
        if inner.holds.len() >= 2 {
            return Err("hold_capacity".into());
        }
        let expires = item.expires_at_ms.unwrap_or(at + 18_000);
        if expires <= at {
            return Err("notice_unavailable".into());
        }
        store.set_expiry(id, None)?;
        inner.holds.insert(
            id.into(),
            Hold {
                remaining: expires - at,
                until: at + HOLD_MS,
            },
        );
        Ok(())
    }
    fn maintenance(&self, inner: &mut Inner, at: u64, dragging: bool) -> Result<bool, String> {
        let store = self.usable(inner)?;
        if dragging {
            for item in inner
                .desktop_notices(store.unread(at)?, at)
                .into_iter()
                .filter(|n| n.kind == NoticeKind::Aside && !n.pinned)
            {
                Self::hold(store, inner, &item.id, true, at)?;
            }
        } else if inner.dragging {
            for hold in inner.holds.values_mut() {
                hold.until = at + 5000;
            }
        }
        inner.dragging = dragging;
        let elapsed: Vec<_> = inner
            .holds
            .iter()
            .filter(|(_, hold)| at >= hold.until)
            .map(|(id, _)| id.clone())
            .collect();
        for id in elapsed {
            Self::release_hold(store, inner, &id, at)?;
        }
        let expired: Vec<_> = inner
            .focus
            .iter()
            .filter(|(_, req)| at >= req.expires)
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            if let Some(req) = inner.focus.remove(&id) {
                let _ = req.result.send(Err("focus_timeout".into()));
            }
        }
        store.expire(at)
    }
    fn source(inner: &Inner, pending: &Pending) -> NoticeSource {
        let source = NoticeSource {
            engine: pending.engine.clone(),
            session_id: pending.session_id.clone(),
            workspace_path: pending.workspace_path.clone(),
            label: String::new(),
        };
        inner.sources.get(&source.key()).cloned().unwrap_or(source)
    }
    fn snapshot(source: &NoticeSource, pending: &Pending) -> Option<Snapshot> {
        let project = Path::new(&source.workspace_path)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "Workspace".into());
        let value = Snapshot {
            checkpoint_id: pending.id.clone(),
            project: clip(&project, 200),
            goal: clip(&pending.prompt, 500),
            change: clip(&pending.summary, 1500),
            facts: vec![
                "This is a finished response, not confirmation that the project is accepted."
                    .into(),
            ],
        };
        (!value.goal.is_empty() && !value.change.is_empty()).then_some(value)
    }
    fn progress_observation(inner: &Inner, checkpoint: Checkpoint) -> Option<Observation> {
        let source = NoticeSource {
            engine: checkpoint.engine.clone(),
            session_id: checkpoint.session_id.clone(),
            workspace_path: checkpoint.workspace_path.clone(),
            label: String::new(),
        };
        let source = inner.sources.get(&source.key()).cloned().unwrap_or(source);
        let project = Path::new(&source.workspace_path)
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "Workspace".into());
        let snapshot = Snapshot {
            checkpoint_id: checkpoint.id.clone(),
            project: clip(&project, 200),
            goal: clip(&checkpoint.prompt, 500),
            change: clip(&checkpoint.summary, 1500),
            facts: vec!["任务仍在进行；不是已完成/已验证结果。The task is still in progress; this is not a completed or verified result.".into()],
        };
        (source.validate().is_ok() && !snapshot.goal.is_empty() && !snapshot.change.is_empty())
            .then_some(Observation {
                source,
                snapshot,
                started_at_ms: checkpoint.started_at_ms,
                captured_at_ms: checkpoint.captured_at_ms,
                policy_generation: checkpoint.observer_generation,
                checkpoint: Some(checkpoint),
            })
    }
    fn drain_progress(inner: &Inner, outbox: &Outbox, at: u64) -> Result<Vec<Observation>, String> {
        let mut candidates = Vec::new();
        for checkpoint in outbox.observer_pending(8, at)? {
            let current = inner.observer_ready(at)
                && checkpoint.observer_generation == inner.policy_epoch
                && outbox
                    .with_current_checkpoint(&checkpoint, at, || ())?
                    .is_some();
            // Checkpoints are best-effort observations, never completion/read-state writes.
            // Consume once even when policy, payload, cooldown or capacity rejects the request.
            outbox.finish_checkpoint(&checkpoint.id)?;
            if current {
                if let Some(candidate) = Self::progress_observation(inner, checkpoint) {
                    candidates.push(candidate);
                }
            }
        }
        Ok(candidates)
    }
    fn revoke_progress(inner: &mut Inner, outbox: &Outbox, at: u64) {
        if outbox.set_observer_ready(inner.policy_epoch, 0).is_err() {
            inner.observer_storage_error = true;
            inner.reconfigure(at);
        }
    }
    fn progress_cycle(inner: &mut Inner, outbox: &Outbox, at: u64) -> Vec<Observation> {
        let result = (|| {
            outbox.set_observer_ready(
                inner.policy_epoch,
                if inner.observer_ready(at) {
                    at.saturating_add(10_000)
                } else {
                    0
                },
            )?;
            Self::drain_progress(inner, outbox, at)
        })();
        match result {
            Ok(candidates) => {
                if inner.observer_storage_error {
                    inner.observer_storage_error = false;
                    inner.reconfigure(at);
                }
                candidates
            }
            Err(_) => {
                inner.observer_storage_error = true;
                inner.reconfigure(at);
                Self::revoke_progress(inner, outbox, at);
                Vec::new()
            }
        }
    }
    fn tick(self: &Arc<Self>) {
        let focused = self.focused();
        let dragging = overlay::dragging();
        let at = now();
        let mut candidates = Vec::new();
        let mut progress = Vec::new();
        let mut changed = false;
        {
            let mut inner = self.inner.lock();
            if inner.stopped || inner.fatal.is_some() {
                return;
            }
            inner.actually_focused = focused;
            let run = (|| -> Result<(), String> {
                changed |= self.maintenance(&mut inner, at, dragging)?;
                let outbox = self.outbox.as_ref().ok_or("outbox_unavailable")?;
                let store = self.store.as_ref().ok_or("storage_unavailable")?;
                changed |= inner.clear_disabled_asides(store, at)?;
                if at.saturating_sub(inner.last_reap) >= 10_000 {
                    self.update_environment(&mut inner, at);
                    outbox.reap_dead_owners()?;
                    inner.last_reap = at;
                }
                inner.storage_error = None;
                inner.reconfigure(at);
                if !inner.config.enabled {
                    outbox.pause()?;
                } else {
                    // Publication and opt-out share this lock. Policy changes do not change admission identity.
                    store.unread(at)?;
                    outbox.set_ready(ADMISSION_GENERATION, at.saturating_add(10_000))?;
                }
                let app_state = self.app.try_state::<crate::AppState>();
                candidates = Self::drain(&mut inner, store, outbox, at, &mut changed, |source| {
                    let app_state = app_state.as_ref().ok_or("source_identity_unavailable")?;
                    crate::leader::is_managed_child_session(
                        &app_state.db, &source.engine, &source.session_id, &source.workspace_path,
                    )
                })?;
                Ok(())
            })();
            if let Err(reason) = run {
                inner.storage_error = Some(reason);
                inner.reconfigure(at);
                if let Some(outbox) = &self.outbox {
                    Self::revoke_progress(&mut inner, outbox, at);
                    let _ = outbox.pause();
                }
            } else if let Some(outbox) = &self.outbox {
                progress = Self::progress_cycle(&mut inner, outbox, at);
            }
        }
        self.refresh(changed);
        for (source, item, policy_generation) in candidates {
            // Only a newly committed inbox completion reaches this path; replay/dedup does not.
            self.audio.enqueue(&item.engine, item.completed_at_ms);
            self.observe(source, item, policy_generation);
        }
        for candidate in progress {
            self.observe_candidate(candidate);
        }
    }
    fn drain(
        inner: &mut Inner,
        store: &Store,
        outbox: &Outbox,
        at: u64,
        changed: &mut bool,
        is_managed_child: impl Fn(&NoticeSource) -> Result<bool, String>,
    ) -> Result<Vec<(NoticeSource, Pending, u64)>, String> {
        let mut candidates = Vec::new();
        // For eligible main conversations, durable admission survives preference
        // changes. Child identity is checked separately before domain publication.
        for item in outbox.pending(512)?.into_iter().take(8) {
            let source = Self::source(inner, &item);
            source.validate()?;
            let key = source.key();
            // Older worker versions may already have queued a child's result.
            // Consume it before inbox, overlay, observer or audio publication;
            // this changes notification policy, not the task's real outcome.
            if is_managed_child(&source)? {
                inner.cancel_job(&key, at);
                outbox.finish(&item.id)?;
                continue;
            }
            let turn = format!("{}-{}", key, item.started_at_ms);
            if item.started || item.cancel {
                if inner.policy.begin(&key, &turn, item.started_at_ms, at) {
                    inner.cancel_job(&key, at);
                }
                outbox.finish(&item.id)?;
                continue;
            }
            let commit = store.record_completion(&item, &source)?;
            if commit.status == CommitStatus::Recorded
                && inner.policy.begin(&key, &turn, item.started_at_ms, at)
            {
                // A terminal can replace its queued start before the GUI polls it. Fence
                // the prior turn here too, even when cooldown denies a new observation.
                if inner
                    .jobs
                    .get(&key)
                    .is_some_and(|job| job.ticket.turn_id != turn)
                {
                    inner.cancel_job(&key, at);
                }
            }
            if commit.status == CommitStatus::Recorded
                && inner.config.enabled
                && inner.foreground_source(at) == Some(key.as_str())
                && at > item.completed_at_ms
            {
                *changed |= store.attention(&source, at)?;
            }
            *changed |= commit.status == CommitStatus::Recorded;
            // Exact ACK follows the durable domain commit. A failure stops the drain.
            outbox.finish(&item.id)?;
            if commit.status == CommitStatus::Recorded {
                candidates.push((source, item, inner.policy_epoch));
            }
        }
        Ok(candidates)
    }
    fn observe(self: &Arc<Self>, source: NoticeSource, pending: Pending, policy_generation: u64) {
        let Some(snapshot) = Self::snapshot(&source, &pending) else {
            return;
        };
        self.observe_candidate(Observation {
            source,
            snapshot,
            started_at_ms: pending.started_at_ms,
            captured_at_ms: pending.completed_at_ms,
            policy_generation,
            checkpoint: None,
        });
    }
    fn prepare_observation(
        inner: &mut Inner,
        store: &Store,
        outbox: Option<&Outbox>,
        candidate: &Observation,
        at: u64,
    ) -> Result<Option<Ticket>, ObservationError> {
        inner.reconfigure(at);
        if candidate.policy_generation != inner.policy_epoch
            || !candidate.fresh(at)
            || inner.window_error
            || inner.storage_error.is_some()
            || !inner.source_engines.contains(&candidate.source.engine)
        {
            return Ok(None);
        }
        let items = store.unread(at).map_err(ObservationError::Store)?;
        let active = items.iter().filter(|n| n.kind == NoticeKind::Aside).count();
        let key = candidate.source.key();
        let turn = format!("{}-{}", key, candidate.started_at_ms);
        let prepare = || {
            inner
                .policy
                .prepare(
                    &key,
                    &turn,
                    candidate.started_at_ms,
                    candidate.snapshot.clone(),
                    active,
                    at,
                )
                .map_err(ObservationError::Store)
        };
        if let Some(checkpoint) = &candidate.checkpoint {
            outbox
                .ok_or(ObservationError::ProgressStorage)?
                .with_current_checkpoint(checkpoint, at, prepare)
                .map_err(|_| ObservationError::ProgressStorage)?
                .unwrap_or(Ok(None))
        } else {
            let mut prepare = prepare;
            prepare()
        }
    }
    fn commit_observation(
        inner: &mut Inner,
        store: &Store,
        outbox: Option<&Outbox>,
        candidate: &Observation,
        ticket: &Ticket,
        tease: &str,
        body: &str,
        at: u64,
    ) -> Result<bool, ObservationError> {
        Self::commit_observation_with_observer(
            inner, store, outbox, candidate, None, ticket, tease, body, at,
        )
    }
    fn commit_observation_with_observer(
        inner: &mut Inner,
        store: &Store,
        outbox: Option<&Outbox>,
        candidate: &Observation,
        observer: Option<&NoticeObserver>,
        ticket: &Ticket,
        tease: &str,
        body: &str,
        at: u64,
    ) -> Result<bool, ObservationError> {
        inner.reconfigure(at);
        if !inner.policy.current(ticket, at)
            || !candidate.fresh(at)
            || !inner.source_engines.contains(&candidate.source.engine)
        {
            return Ok(false);
        }
        let commit = || {
            store
                .add_aside_with_observer(
                    &ticket.id,
                    &candidate.source,
                    observer,
                    &ticket.turn_id,
                    tease,
                    body,
                    at,
                    18_000,
                )
                .map_err(ObservationError::Store)
        };
        // The outbox transaction fences worker cancellation/new turns while Store commits.
        // The caller also holds Inner, so configuration changes cannot interleave. No await.
        let result = if let Some(checkpoint) = &candidate.checkpoint {
            outbox
                .ok_or(ObservationError::ProgressStorage)?
                .with_current_checkpoint(checkpoint, at, commit)
                .map_err(|_| ObservationError::ProgressStorage)?
                .transpose()?
        } else {
            Some(commit()?)
        };
        Ok(result.is_some_and(|commit| commit.status == CommitStatus::Recorded))
    }
    fn observe_candidate(self: &Arc<Self>, candidate: Observation) {
        let mut inner = self.inner.lock();
        let at = now();
        self.update_environment(&mut inner, at);
        let Some(store) = self.store.as_ref() else {
            return;
        };
        let ticket = match Self::prepare_observation(
            &mut inner,
            store,
            self.outbox.as_deref(),
            &candidate,
            at,
        ) {
            Ok(Some(ticket)) => ticket,
            Ok(None) => return,
            Err(reason) => {
                match reason {
                    ObservationError::ProgressStorage => inner.observer_storage_error = true,
                    ObservationError::Store(reason) => inner.storage_error = Some(reason),
                }
                inner.reconfigure(at);
                if let Some(outbox) = &self.outbox {
                    Self::revoke_progress(&mut inner, outbox, at);
                }
                drop(inner);
                self.refresh(false);
                return;
            }
        };
        let key = candidate.source.key();
        if let Some(old) = inner.jobs.remove(&key) {
            old.abort.abort();
        }
        let service = Arc::clone(self);
        let captured = ticket.clone();
        let selection = match observer::selection(&inner.config) {
            Ok(selection) => selection,
            Err(error) => {
                inner.observer_error = Some(observer::failure_code(error).into());
                inner.policy.finish(&captured, at);
                drop(inner);
                self.refresh(false);
                return;
            }
        };
        let job = tokio::spawn(async move {
            let result = observer::generate(&selection, &captured.locale, &captured.snapshot).await;
            let focused = service.focused();
            let changed = {
                let mut inner = service.inner.lock();
                let at = now();
                inner.actually_focused = focused;
                // Probe again after await: disable/provider changes must fence a late result
                // even if the periodic configuration probe has not run yet.
                service.update_environment(&mut inner, at);
                inner.reconfigure(at);
                let valid = inner.policy.current(&captured, at)
                    && inner.observer_route == Some(selection.fingerprint)
                    && inner.source_engines.contains(&candidate.source.engine);
                let mut changed = false;
                if valid {
                    inner.observer_error = result
                        .as_ref()
                        .err()
                        .map(|error| observer::failure_code(*error).into());
                    if let (Ok(Some(thought)), Some(store)) = (result, service.store.as_ref()) {
                        if let Some(tease) =
                            thought.get("tease").and_then(serde_json::Value::as_str)
                        {
                            let body = thought
                                .get("body")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("");
                            let observer_meta = NoticeObserver {
                                engine: selection.engine.clone(),
                                model: selection.model.clone(),
                                effort: selection.effort.clone(),
                            };
                            match Self::commit_observation_with_observer(
                                &mut inner,
                                store,
                                service.outbox.as_deref(),
                                &candidate,
                                Some(&observer_meta),
                                &captured,
                                tease,
                                body,
                                at,
                            ) {
                                Ok(recorded) => changed = recorded,
                                Err(ObservationError::Store(reason))
                                    if reason == "aside_capacity" || reason == "inbox_capacity" => {
                                }
                                Err(ObservationError::Store(reason)) => {
                                    inner.storage_error = Some(reason)
                                }
                                Err(ObservationError::ProgressStorage) => {
                                    inner.observer_storage_error = true;
                                    inner.reconfigure(at);
                                    if let Some(outbox) = &service.outbox {
                                        Self::revoke_progress(&mut inner, outbox, at);
                                    }
                                }
                            }
                        }
                    }
                    inner.policy.finish(&captured, at);
                }
                if inner
                    .jobs
                    .get(&captured.source_key)
                    .is_some_and(|j| j.ticket.id == captured.id)
                {
                    inner.jobs.remove(&captured.source_key);
                }
                changed
            };
            service.refresh(changed);
        });
        inner.jobs.insert(
            key,
            Job {
                ticket,
                abort: job.abort_handle(),
            },
        );
    }
    pub fn stop(&self) {
        self.audio.stop();
        {
            let mut inner = self.inner.lock();
            inner.stopped = true;
            inner.reconfigure(now());
            inner.fail_focus("stopped");
            if let Some(outbox) = &self.outbox {
                Self::revoke_progress(&mut inner, outbox, now());
                let _ = outbox.pause();
            }
            if let Some(store) = &self.store {
                let ids: Vec<_> = inner.holds.keys().cloned().collect();
                for id in ids {
                    let _ = Self::release_hold(store, &mut inner, &id, now());
                }
            }
        }
        if let Some(task) = self.loop_handle.lock().take() {
            task.abort();
        }
        overlay::shutdown(&self.app);
    }
}

pub fn init(app: &tauri::AppHandle) -> Arc<Service> {
    let path = crate::paths::app_home().join("assistant-notices.json");
    let mut fatal = None;
    let mut configuration_error = None;
    let mut config = Config::default();
    let mut generation = 1;
    let mut store = None;
    let mut outbox = None;
    let mut observer_available = false;
    let mut observer_storage_error = false;
    if crate::paths::is_dev_profile() || cfg!(test) {
        fatal = Some("unsupported_profile".into());
    } else {
        let setup = (|| -> Result<(), String> {
            match read_config(&path) {
                Ok(stored) => {
                    config = stored.config();
                    generation = stored.generation;
                }
                Err(reason) => configuration_error = Some(reason),
            }
            observer_available = observer::configured(&config);
            std::fs::create_dir_all(crate::paths::app_home()).map_err(|_| "storage_unavailable")?;
            store = Some(Store::open(
                crate::paths::app_home().join("assistant-notices.sqlite"),
            )?);
            // A process exit may leave a transient hover with NULL expiry. Restore a bounded lifetime.
            for notice in store.as_ref().unwrap().unread(now())? {
                if notice.kind == NoticeKind::Aside
                    && !notice.pinned
                    && notice.expires_at_ms.is_none()
                {
                    store
                        .as_ref()
                        .unwrap()
                        .set_expiry(&notice.id, Some(now() + 18_000))?;
                }
            }
            outbox = completion_outbox::init()?;
            if outbox.is_none() {
                return Err("outbox_unavailable".into());
            }
            outbox.as_ref().unwrap().pause()?;
            observer_storage_error = outbox
                .as_ref()
                .unwrap()
                .set_observer_ready(generation, 0)
                .is_err();
            Ok(())
        })();
        if let Err(reason) = setup {
            fatal = Some(reason);
        }
    }
    let locale = crate::settings::read_settings()
        .ok()
        .filter(|s| s.language == "en")
        .map(|_| "en")
        .unwrap_or("zh-CN")
        .to_string();
    let audio = completion_audio::AudioService::new(now());
    if fatal.is_none() {
        audio.load(crate::paths::app_home().join("completion-audio.json"));
    }
    audio.configure(
        config.enabled && config.voice_enabled && fatal.is_none(),
        &locale,
    );
    let observer_route = observer::selection(&config)
        .ok()
        .map(|selection| selection.fingerprint);
    let display_target = config.display_target.clone();
    let service = Arc::new(Service {
        app: app.clone(),
        path,
        store,
        outbox,
        observer_probe: observer::configured,
        audio,
        inner: Mutex::new(Inner {
            config,
            generation,
            // A new process cannot accept progress left under a prior process's policy.
            policy_epoch: (u64::from_le_bytes(
                uuid::Uuid::new_v4().as_bytes()[..8].try_into().unwrap(),
            ) & (MAX_GENERATION >> 1))
                .max(1),
            policy_context: None,
            fatal,
            configuration_error,
            storage_error: None,
            window_error: false,
            observer_available,
            observer_storage_error,
            observer_error: None,
            observer_route,
            source_engines: observer::source_engines(),
            stopped: false,
            policy: Policy::default(),
            locale,
            actually_focused: false,
            document_id: String::new(),
            attention: Attention::default(),
            sources: HashMap::new(),
            focus: HashMap::new(),
            jobs: HashMap::new(),
            holds: HashMap::new(),
            dragging: false,
            last_reap: 0,
            desktop_ids: Vec::new(),
        }),
        presentation: Mutex::new(()),
        emitted_status: Mutex::new(None),
        loop_handle: Mutex::new(None),
    });
    app.manage(Arc::clone(&service));
    if service.inner.lock().fatal.is_none() {
        if overlay::configure(app, &display_target).is_err() {
            service.inner.lock().window_error = true;
        }
        let runner = Arc::clone(&service);
        *service.loop_handle.lock() = Some(tauri::async_runtime::spawn(async move {
            loop {
                runner.tick();
                if runner.inner.lock().stopped {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }));
    }
    service
}

fn gate(window: &tauri::Window, main_only: bool) -> Result<(), String> {
    if crate::paths::is_dev_profile()
        || (window.label() != MAIN && (main_only || window.label() != overlay::LABEL))
    {
        Err("unsupported_window".into())
    } else {
        Ok(())
    }
}
fn overlay_gate(window: &tauri::Window) -> Result<(), String> {
    if window.label() != overlay::LABEL || crate::paths::is_dev_profile() {
        Err("unsupported_window".into())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub fn assistant_notices_status(
    window: tauri::Window,
    state: tauri::State<'_, Arc<Service>>,
) -> Result<Status, String> {
    gate(&window, false)?;
    Ok(state.status())
}
#[tauri::command]
pub async fn assistant_notices_models(
    window: tauri::Window,
) -> Result<Vec<crate::auto_title::config::NamingModel>, String> {
    gate(&window, true)?;
    observer::models().await
}
#[tauri::command]
pub async fn assistant_notices_configure(
    window: tauri::Window,
    state: tauri::State<'_, Arc<Service>>,
    config: Config,
    expected_revision: u64,
) -> Result<Status, String> {
    gate(&window, true)?;
    let focused = state.focused();
    {
        let mut inner = state.inner.lock();
        let store = state.usable(&inner)?;
        if inner.save_preferences(&state.path, config, expected_revision, now())? {
            if let Some(outbox) = &state.outbox {
                Service::revoke_progress(&mut inner, outbox, now());
            }
            // Only total opt-out revokes new completion admission. Observer settings are independent.
            if !inner.config.enabled {
                if let Some(outbox) = &state.outbox {
                    if let Err(reason) = outbox.pause() {
                        inner.storage_error = Some(reason);
                    }
                }
            }
            inner.actually_focused = focused;
            state.update_environment(&mut inner, now());
            inner.reconfigure(now());
            if let Err(reason) = inner.clear_disabled_asides(store, now()) {
                inner.storage_error = Some(reason);
            }
            state.audio.configure(
                inner.config.enabled && inner.config.voice_enabled,
                &inner.locale,
            );
            inner.window_error =
                overlay::configure(&state.app, &inner.config.display_target).is_err();
        }
    }
    state.refresh(true);
    Ok(state.status())
}
#[tauri::command]
pub fn assistant_notices_displays(
    window: tauri::Window,
    state: tauri::State<'_, Arc<Service>>,
) -> Result<Vec<overlay::DisplayInfo>, String> {
    gate(&window, true)?;
    overlay::monitors(&state.app)
}
#[tauri::command]
pub fn assistant_notices_audio_settings(
    window: tauri::Window,
    state: tauri::State<'_, Arc<Service>>,
) -> Result<completion_audio::AudioView, String> {
    gate(&window, true)?;
    state.usable(&state.inner.lock())?;
    Ok(state.audio.view())
}
#[tauri::command]
pub async fn assistant_notices_audio_configure(
    window: tauri::Window,
    state: tauri::State<'_, Arc<Service>>,
    settings: completion_audio::AudioSettings,
    expected_revision: u64,
) -> Result<completion_audio::AudioView, String> {
    gate(&window, true)?;
    state.usable(&state.inner.lock())?;
    state.audio.save(settings, expected_revision)
}
#[tauri::command]
pub async fn assistant_notices_audio_voices(
    window: tauri::Window,
    state: tauri::State<'_, Arc<Service>>,
) -> Result<Vec<completion_audio::VoiceInfo>, String> {
    gate(&window, true)?;
    state.usable(&state.inner.lock())?;
    completion_audio::voices().await
}
#[tauri::command]
pub async fn assistant_notices_audio_preview(
    window: tauri::Window,
    state: tauri::State<'_, Arc<Service>>,
    engine: String,
    settings: completion_audio::AudioSettings,
) -> Result<(), String> {
    gate(&window, true)?;
    state.usable(&state.inner.lock())?;
    state.audio.preview(&engine, settings)
}
#[tauri::command]
pub fn assistant_notices_attach(
    window: tauri::Window,
    state: tauri::State<'_, Arc<Service>>,
) -> Result<String, String> {
    gate(&window, true)?;
    let mut inner = state.inner.lock();
    state.usable(&inner)?;
    Ok(inner.attach())
}
#[tauri::command]
pub async fn assistant_notices_sync(
    window: tauri::Window,
    state: tauri::State<'_, Arc<Service>>,
    document_id: String,
    sources: Vec<NoticeSource>,
    active: Option<NoticeSource>,
    attentive: bool,
    attention_event: bool,
    locale: String,
) -> Result<(), String> {
    gate(&window, true)?;
    if sources.len() > 64 || !matches!(locale.as_str(), "zh-CN" | "en") {
        return Err("invalid_sync".into());
    }
    let mut mapped = HashMap::new();
    for source in sources {
        source.validate()?;
        let key = source.key();
        if mapped.insert(key, source).is_some() {
            return Err("invalid_sync".into());
        }
    }
    if let Some(source) = &active {
        source.validate()?;
    }
    let active = active.map(|source| source.key());
    if active.as_ref().is_some_and(|key| !mapped.contains_key(key)) {
        return Err("invalid_sync".into());
    }
    let focused = state.focused();
    let changed = {
        let mut inner = state.inner.lock();
        let store = state.usable(&inner)?;
        if document_id.is_empty() || inner.document_id != document_id {
            return Err("stale_document".into());
        }
        let at = now();
        inner.locale = locale;
        state.audio.configure(
            inner.config.enabled && inner.config.voice_enabled,
            &inner.locale,
        );
        inner.actually_focused = focused;
        inner.sources = mapped;
        inner.attention = Attention {
            document_id,
            active: active.clone(),
            attentive: attentive && focused,
            seen_at: at,
        };
        inner.reconfigure(at);
        if attention_event && attentive && focused && inner.config.enabled {
            active
                .and_then(|key| inner.sources.get(&key))
                .map(|source| store.attention(source, at))
                .transpose()?
                .unwrap_or(false)
        } else {
            false
        }
    };
    // Source/focus changes can change the desktop route without changing persisted read state.
    state.refresh(changed);
    Ok(())
}
#[tauri::command]
pub fn assistant_notices_list(
    window: tauri::Window,
    state: tauri::State<'_, Arc<Service>>,
) -> Result<Vec<Notice>, String> {
    gate(&window, false)?;
    let inner = state.inner.lock();
    let at = now();
    let items = state.usable(&inner)?.unread(at)?;
    Ok(if window.label() == overlay::LABEL {
        inner.desktop_notices(items, at)
    } else {
        items
    })
}
fn recent_history(store: &Store, limit: Option<usize>, at: u64) -> Result<Vec<Notice>, String> {
    let limit = limit.unwrap_or(10);
    if limit > 10 {
        return Err("invalid_limit".into());
    }
    let mut items: Vec<_> = store
        .unread(at)?
        .into_iter()
        .filter(|n| n.kind == NoticeKind::Completion)
        .collect();
    items.extend(
        store
            .history(512)?
            .into_iter()
            .filter(|n| n.kind == NoticeKind::Aside)
            .take(limit),
    );
    items.sort_by(|a, b| {
        b.created_at_ms
            .cmp(&a.created_at_ms)
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(items)
}
#[tauri::command]
pub fn assistant_notices_history(
    window: tauri::Window,
    state: tauri::State<'_, Arc<Service>>,
    limit: Option<usize>,
) -> Result<Vec<Notice>, String> {
    gate(&window, false)?;
    let inner = state.inner.lock();
    recent_history(state.usable(&inner)?, limit, now())
}
#[tauri::command]
pub async fn assistant_notices_read(
    window: tauri::Window,
    state: tauri::State<'_, Arc<Service>>,
    id: String,
) -> Result<bool, String> {
    gate(&window, false)?;
    let changed = {
        let mut inner = state.inner.lock();
        let changed = state.usable(&inner)?.mark_read(&id)?;
        inner.holds.remove(&id);
        changed
    };
    state.refresh(changed);
    Ok(changed)
}
#[tauri::command]
pub async fn assistant_notices_pin(
    window: tauri::Window,
    state: tauri::State<'_, Arc<Service>>,
    id: String,
    pinned: bool,
) -> Result<bool, String> {
    gate(&window, false)?;
    let changed = {
        let mut inner = state.inner.lock();
        let changed = state.usable(&inner)?.set_pinned(&id, pinned, now())?;
        inner.holds.remove(&id);
        changed
    };
    state.refresh(changed);
    Ok(changed)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FocusRequest {
    id: String,
    document_id: String,
    notice_id: String,
    engine: String,
    session_id: String,
    workspace_path: String,
    action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}
#[tauri::command]
pub async fn assistant_notices_open(
    window: tauri::Window,
    state: tauri::State<'_, Arc<Service>>,
    id: String,
    action: String,
) -> Result<(), String> {
    gate(&window, false)?;
    if !matches!(action.as_str(), "open" | "draft") {
        return Err("invalid_action".into());
    }
    let (request, receiver) = {
        let mut inner = state.inner.lock();
        let store = state.usable(&inner)?;
        // The total switch controls automatic reminders, not a user's explicit history action.
        let item = inner.open_notice(store, &id)?;
        let request_id = uuid::Uuid::new_v4().to_string();
        let text = if action == "draft" {
            let prefix = if inner.locale == "zh-CN" {
                "请结合当前任务考虑这条想法：\n\n"
            } else {
                "Please consider this thought in the current task:\n\n"
            };
            Some(clip(
                &format!("{}{}\n\n{}", prefix, item.tease, item.body),
                6000,
            ))
        } else {
            None
        };
        let request = FocusRequest {
            id: request_id.clone(),
            document_id: inner.document_id.clone(),
            notice_id: id.clone(),
            engine: item.source.engine.clone(),
            session_id: item.source.session_id.clone(),
            workspace_path: item.source.workspace_path.clone(),
            action,
            text,
        };
        let (sender, receiver) = oneshot::channel();
        let pending = FocusWait {
            document_id: inner.document_id.clone(),
            generation: inner.generation,
            notice_id: id,
            source_key: item.source.key(),
            expires: now() + 6500,
            result: sender,
        };
        inner.focus.insert(request_id, pending);
        (request, receiver)
    };
    if overlay::focus_main(&state.app).is_err()
        || state.app.emit_to(MAIN, FOCUS, request.clone()).is_err()
    {
        state.inner.lock().focus.remove(&request.id);
        return Err("focus_unavailable".into());
    }
    let result = tokio::time::timeout(Duration::from_secs(7), receiver).await;
    state.inner.lock().focus.remove(&request.id);
    match result {
        Ok(Ok(result)) => result,
        _ => Err("focus_timeout".into()),
    }
}
#[tauri::command]
pub async fn assistant_notices_focus_ack(
    window: tauri::Window,
    state: tauri::State<'_, Arc<Service>>,
    document_id: String,
    request_id: String,
    success: bool,
) -> Result<(), String> {
    gate(&window, true)?;
    let focused = state.focused();
    let changed = {
        let mut inner = state.inner.lock();
        let store = state.usable(&inner)?;
        inner.acknowledge(store, &document_id, &request_id, success, focused, now())?
    };
    if changed {
        state.refresh(true);
    }
    Ok(())
}
#[tauri::command]
pub fn assistant_notices_hold(
    window: tauri::Window,
    state: tauri::State<'_, Arc<Service>>,
    id: String,
    held: bool,
) -> Result<(), String> {
    gate(&window, false)?;
    let mut inner = state.inner.lock();
    let store = state.usable(&inner)?;
    Service::hold(store, &mut inner, &id, held, now())
}
#[tauri::command]
pub async fn assistant_notices_drag(
    window: tauri::Window,
    state: tauri::State<'_, Arc<Service>>,
) -> Result<(), String> {
    overlay_gate(&window)?;
    let ids = {
        let mut inner = state.inner.lock();
        let store = state.usable(&inner)?;
        let ids: Vec<_> = inner
            .desktop_notices(store.unread(now())?, now())
            .into_iter()
            .filter(|n| n.kind == NoticeKind::Aside && !n.pinned)
            .map(|n| n.id)
            .collect();
        for id in &ids {
            Service::hold(store, &mut inner, id, true, now())?;
        }
        ids
    };
    let result = overlay::drag(&state.app);
    let mut inner = state.inner.lock();
    for id in ids {
        if let Some(hold) = inner.holds.get_mut(&id) {
            hold.until = now() + 5000;
        }
    }
    result
}
#[tauri::command]
pub async fn assistant_notices_pointer(
    window: tauri::Window,
    state: tauri::State<'_, Arc<Service>>,
    interactive: bool,
) -> Result<(), String> {
    overlay_gate(&window)?;
    overlay::interactive(&state.app, interactive)
}
#[tauri::command]
pub async fn assistant_notices_size(
    window: tauri::Window,
    state: tauri::State<'_, Arc<Service>>,
    height: f64,
) -> Result<(), String> {
    overlay_gate(&window)?;
    if !height.is_finite() || !(1.0..=8192.0).contains(&height) {
        return Err("invalid_size".into());
    }
    overlay::resize(&state.app, height)
}

#[cfg(test)]
#[path = "assistant_notices/runtime_tests.rs"]
mod runtime_tests;
