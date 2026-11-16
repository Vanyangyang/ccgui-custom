//! Desktop-side admission and reconnection. Native pipes belong to task workers;
//! this registry contains only routing proxies and replay cursors.
use crate::event_sink::Emit;
use crate::task_worker::{self, Command, StartArgs, WorkerClient, WorkerError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, LazyLock, Mutex,
};
use std::time::Duration;
use tauri::Manager;

static HOST: LazyLock<Mutex<Option<Arc<Host>>>> = LazyLock::new(|| Mutex::new(None));
mod diagnostics;
mod recovery;
mod maintenance;
pub(crate) use maintenance::run_stdio as run_recovery_stdio;
pub(crate) use diagnostics::{blocker_snapshot, BlockerSnapshot};
static PAUSED: AtomicBool = AtomicBool::new(false);
const MAX_SOURCES: usize = 4096;
static ARCHIVES: LazyLock<Mutex<VecDeque<(String, Arc<crate::worker_archive::Archive>)>>> =
    LazyLock::new(|| Mutex::new(VecDeque::new()));
struct Host {
    app: tauri::AppHandle,
    workers: Mutex<HashMap<String, Arc<Route>>>,
    ready: AtomicBool,
    paused: AtomicBool,
    observers_paused: AtomicBool,
    stopped: AtomicBool,
    admission: tokio::sync::Mutex<()>,
    controls: tokio::sync::RwLock<()>,
    task_actions: Arc<tokio::sync::RwLock<()>>,
}
struct Route {
    client: WorkerClient,
    // A validated orphan may become archive-only without projecting its tail.
    replay_only: AtomicBool,
    engine: Option<String>,
    binding: Mutex<()>,
    session_id: Mutex<Option<String>>,
    run_aliases: Mutex<HashSet<String>>,
    head: AtomicU64,
    observed: AtomicU64,
    observation_fault: AtomicBool,
    physically_complete: AtomicBool,
    native_complete: AtomicBool,
    archived: AtomicBool,
}

fn host() -> Option<Arc<Host>> {
    HOST.lock().unwrap_or_else(|p| p.into_inner()).clone()
}
fn error(error: WorkerError) -> String {
    // Keep delivery uncertainty machine-readable through the legacy string IPC.
    serde_json::to_string(&error).unwrap_or_else(|_| "Worker request failed".into())
}

fn revoke_task_authority(run_id: &str) {
    crate::leader::finish_run(run_id);
    crate::host_chat::revoke_run(run_id);
}

pub(crate) fn startup_workers() -> Result<Vec<task_worker::WorkerManifest>, String> {
    let workers = task_worker::discover(&crate::paths::app_home()).map_err(error)?;
    let expected_schema = task_worker::schema_hash();
    if workers
        .iter()
        .any(|worker| !task_worker::schemas_compatible(&worker.schema_hash, &expected_schema))
    {
        return Err("Running tasks require the previous database schema; finish them before opening this version".into());
    }
    Ok(workers)
}

pub(crate) async fn initialize(
    app: &tauri::AppHandle,
    workers: Vec<task_worker::WorkerManifest>,
) -> Result<(), String> {
    let owner = Arc::new(Host {
        app: app.clone(),
        workers: Mutex::new(HashMap::new()),
        ready: AtomicBool::new(false),
        paused: AtomicBool::new(PAUSED.load(Ordering::SeqCst)),
        observers_paused: AtomicBool::new(false),
        stopped: AtomicBool::new(false),
        admission: tokio::sync::Mutex::new(()),
        controls: tokio::sync::RwLock::new(()),
        task_actions: Arc::new(tokio::sync::RwLock::new(())),
    });
    for manifest in workers {
        let client = WorkerClient::new(manifest);
        let status = client
            .request(&uuid::Uuid::new_v4().to_string(), Command::Status)
            .await
            .map_err(error)?;
        let session = status["sessionId"].as_str().map(str::to_string);
        let route = owner.install(client, session.clone(), status["engine"].as_str().map(str::to_owned))?;
        // Restore before replay even if the native process finished while the
        // desktop was away: its final journal tail still owns the task result.
        let recovery = (|| -> Result<Option<recovery::RecoveryIdentity>, String> {
            let restored = crate::host_chat::restore_worker_tasks(
                &route.client.manifest().run_id,
                status["engine"].as_str(), status["workspacePath"].as_str(), session.as_deref(),
            )?;
            if !restored && status["managedTask"] == false {
                if let (Some(engine), Some(session), Some(workspace)) = (status["engine"].as_str(), session.as_deref(), status["workspacePath"].as_str()) {
                    let db = &app.state::<crate::AppState>().db;
                    if recovery::owns_children(db, engine, session, workspace)? {
                        if let Some(identity) = recovery::orphan_root(&status, &route.client.manifest().run_id, true) {
                            return Ok(Some(identity));
                        }
                    }
                }
            }
            if status["managedTask"] == true && !restored && status["nativeComplete"] != true {
                return Err("Managed worker has no trusted coordinator checkpoint".into());
            }
            if status["nativeComplete"] != true {
                if let Some(session) = session.as_deref() {
                    owner.bind_session(&route, session)?;
                }
            }
            Ok(None)
        })();
        if let Ok(Some(identity)) = &recovery {
            // An uncheckpointed coordinator is not an isolated agent. Keep it
            // fenced while independently validating its finished, durable tail;
            // never recreate its task or host-chat authority from discovery.
            route.observation_fault.store(true, Ordering::SeqCst);
            revoke_task_authority(&route.client.manifest().run_id);
            owner.poll_orphan(route, identity.clone());
            continue;
        }
        if let Err(cause) = recovery {
            // Discovery proves a live worker, not permission to recreate its
            // coordinator. Keep its proxy/aliases to fence duplicate sends and
            // leave its process/journal intact, but publish no unvalidated tail.
            // A single missing crash-recovery capability must not kill the GUI.
            route.observation_fault.store(true, Ordering::SeqCst);
            revoke_task_authority(&route.client.manifest().run_id);
            eprintln!("[worker-host] task recovery failed (worker retained): {cause}");
            continue;
        }
        owner.poll(route);
    }
    owner.ready.store(true, Ordering::SeqCst);
    *HOST.lock().unwrap_or_else(|p| p.into_inner()) = Some(owner);
    Ok(())
}

pub(crate) fn enabled() -> bool {
    host().is_some_and(|host| host.ready.load(Ordering::SeqCst))
}

fn shutdown_worker_settled(status: &Value, observed: u64) -> bool {
    status["physicalComplete"].as_bool() == Some(true)
        && status["autoTitlePending"].as_bool() == Some(false)
        && status["nativeComplete"].as_bool() == Some(true)
        && status["activeRuns"].as_u64() == Some(0)
        && status["journalFault"].as_bool() == Some(false)
        && status["receiptFault"].as_bool() == Some(false)
        && status["head"].as_u64() == Some(observed)
        && status["durableThrough"].as_u64() == Some(observed)
}

/// Native completion can precede worker-owned auto-title work. Observe fresh
/// status without retiring workers, advancing cursors, or pausing their work.
pub(crate) async fn shutdown_activity() -> Vec<String> {
    use futures_util::StreamExt;
    let Some(owner) = host() else {
        return vec!["native-coordinator-unavailable".into()];
    };
    if !owner.ready.load(Ordering::SeqCst) || owner.stopped.load(Ordering::SeqCst) {
        return vec!["native-coordinator-unavailable".into()];
    }
    let routes: Vec<_> = match owner.workers.lock() {
        Ok(routes) => routes.values().cloned().collect(),
        Err(_) => return vec!["worker-background-work".into()],
    };
    let check = async {
        let mut checks = futures_util::stream::iter(routes.into_iter().map(|route| async move {
            if route.observation_fault.load(Ordering::SeqCst) { return false; }
            // Archived routes already passed the immutable-tail validation.
            if route.archived.load(Ordering::SeqCst) { return true; }
            let request_id = uuid::Uuid::new_v4().to_string();
            match route.client.request(&request_id, Command::Status).await {
                Ok(status) => !route.observation_fault.load(Ordering::SeqCst)
                    && shutdown_worker_settled(&status, route.observed.load(Ordering::SeqCst)),
                Err(_) => false,
            }
        })).buffer_unordered(8);
        while let Some(settled) = checks.next().await {
            if !settled { return false; }
        }
        true
    };
    // One deadline covers all routes, including those waiting for a slot.
    match tokio::time::timeout(Duration::from_secs(2), check).await {
        Ok(true) => Vec::new(),
        _ => vec!["worker-background-work".into()],
    }
}

#[cfg(test)]
mod shutdown_worker_activity_tests {
    use super::*;

    fn finished_status() -> Value {
        json!({"physicalComplete":true,"autoTitlePending":false,
            "nativeComplete":true,"activeRuns":0,"journalFault":false,
            "receiptFault":false,"head":12,"durableThrough":12})
    }

    #[test]
    fn completed_worker_can_settle_before_archival() {
        assert!(shutdown_worker_settled(&finished_status(), 12));
    }

    #[test]
    fn native_completion_does_not_hide_auto_title_or_unobserved_tail() {
        let mut status = finished_status();
        status["autoTitlePending"] = json!(true);
        assert!(!shutdown_worker_settled(&status, 12));
        assert!(!shutdown_worker_settled(&finished_status(), 11));
        assert!(!shutdown_worker_settled(&finished_status(), 13));
    }

    #[test]
    fn missing_faulted_and_incomplete_statuses_remain_blocking() {
        for key in ["physicalComplete", "autoTitlePending", "nativeComplete", "activeRuns",
            "journalFault", "receiptFault", "head", "durableThrough"] {
            let mut status = finished_status();
            status.as_object_mut().unwrap().remove(key);
            assert!(!shutdown_worker_settled(&status, 12), "missing {key}");
        }
        for (key, value) in [("physicalComplete", json!(false)), ("nativeComplete", json!(false)),
            ("activeRuns", json!(1)), ("journalFault", json!(true)), ("receiptFault", json!(true)),
            ("durableThrough", json!(11)), ("head", json!(13)), ("activeRuns", json!("0"))] {
            let mut status = finished_status();
            status[key] = value;
            assert!(!shutdown_worker_settled(&status, 12), "invalid {key}");
        }
    }
}

pub(crate) fn paused() -> bool {
    PAUSED.load(Ordering::SeqCst)
}
pub(crate) fn set_paused(paused: bool) {
    if paused { crate::plugin_memory::cancel_all(false); }
    PAUSED.store(paused, Ordering::SeqCst);
    if let Some(host) = host() {
        host.paused.store(paused, Ordering::SeqCst);
        if !paused {
            host.observers_paused.store(false, Ordering::SeqCst);
        }
    }
}

pub(crate) fn required_sources() -> HashMap<String, u64> {
    host()
        .map(|owner| {
            owner
                .workers
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .iter()
                .map(|(id, route)| (id.clone(), route.observed.load(Ordering::SeqCst)))
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn requires_managed_handoff() -> bool {
    host().is_some_and(|owner| owner.workers.lock().unwrap_or_else(|p| p.into_inner()).values()
        .any(|route| !route.native_complete.load(Ordering::SeqCst)
            && crate::leader::is_managed_child(&route.client.manifest().run_id)))
}

/// Opening the restored relay before its task projection catches up would let
/// tools read stale results or launch a successor before the previous tail.
pub(crate) async fn restore_observers(required: &HashMap<String, u64>) -> Result<(), String> {
    let owner = host().ok_or("Task host unavailable")?;
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let ready = {
                let routes = owner.workers.lock().unwrap_or_else(|p| p.into_inner());
                let mut ready = true;
                for (stream, through) in required {
                    let route = routes.get(stream).ok_or("Recovered task source is unavailable")?;
                    if route.observation_fault.load(Ordering::SeqCst) {
                        return Err("Recovered task projection failed".to_string());
                    }
                    ready &= route.observed.load(Ordering::SeqCst) >= *through;
                }
                ready
            };
            if ready { return Ok(()); }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }).await.map_err(|_| "Recovered task projection has not caught up".to_string())?
}

pub(crate) async fn quiesce() -> Result<(), String> {
    let owner = host().ok_or("Task host unavailable")?;
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        // Drain UI task actions before pausing controls they may still need.
        // Once released, new actions observe paused and fail before mutation.
        let _actions = owner.task_actions.write().await;
        set_paused(true);
        owner.observers_paused.store(true, Ordering::SeqCst);
        let _starts = owner.admission.lock().await;
        let _controls = owner.controls.write().await;
    })
    .await;
    if result.is_err() {
        set_paused(false);
        return Err("Task commands did not drain before update".into());
    }
    Ok(())
}

pub(crate) async fn task_action_guard() -> Result<Option<tokio::sync::OwnedRwLockReadGuard<()>>, String> {
    let Some(owner) = host() else { return Ok(None); };
    let guard = owner.task_actions.clone().read_owned().await;
    if owner.paused.load(Ordering::SeqCst) {
        return Err("runtime_updating: task actions are paused briefly".into());
    }
    Ok(Some(guard))
}

pub(crate) async fn blockers(registry: &crate::engine::ProcessRegistry) -> Vec<String> {
    blocker_snapshot(registry).await.blockers
}

impl Host {
    fn finish_native(&self, route: &Route) {
        let manifest = route.client.manifest();
        self.app.state::<crate::AppState>().processes.remove_run_if_pid(&manifest.run_id, manifest.pid);
        if !route.native_complete.swap(true, Ordering::SeqCst) {
            crate::host_chat::finish_run(&manifest.run_id);
        }
    }

    fn bind_session(&self, route: &Route, session: &str) -> Result<(), String> {
        let _binding = route.binding.lock().unwrap_or_else(|p| p.into_inner());
        let manifest = route.client.manifest();
        let state = self.app.state::<crate::AppState>();
        if state.processes.get(&manifest.run_id).is_some_and(|entry|
            entry.pid == manifest.pid && entry.killed.load(Ordering::SeqCst))
            && !crate::leader::is_managed_child(&manifest.run_id)
        {
            return Ok(());
        }
        let engine = route.engine.clone().or_else(|| crate::host_chat::worker_task_engine(&manifest.run_id));
        let already_owned = state.processes.get(session).is_some_and(|entry|
            entry.run_id == manifest.run_id && entry.pid == manifest.pid);
        let cleanup_only = if let Some(engine) = engine.as_deref() {
            crate::leader::reserve_session_binding(&manifest.run_id, engine, session)?
                == crate::leader::SessionBinding::CleanupOnly
        } else { false };
        let mut stopped = false;
        let claim = (|| {
            let entry = state.processes.get(&manifest.run_id).ok_or("Worker run has retired before session binding")?;
            stopped = entry.killed.load(Ordering::SeqCst);
            if entry.pid != manifest.pid || (stopped && !crate::leader::is_managed_child(&manifest.run_id)) {
                return Err("Worker session binding has no active owned proxy".into());
            }
            state.processes.rekey(&manifest.run_id, session.into())?;
            let alias = state.processes.get(session).ok_or("Worker session alias was not retained")?;
            if alias.run_id != manifest.run_id || alias.pid != manifest.pid {
                return Err("Worker session alias belongs to another run".into());
            }
            if let Some(engine) = engine.as_deref() {
                crate::leader::commit_session_binding(&manifest.run_id, engine, session)?;
            }
            Ok(())
        })();
        if let Err(error) = claim {
            if !already_owned && session != manifest.run_id
                && state.processes.get(session).is_some_and(|entry|
                    entry.run_id == manifest.run_id && entry.pid == manifest.pid)
            {
                state.processes.remove_if_pid(session, manifest.pid);
            }
            if let Some(engine) = engine.as_deref() {
                crate::leader::release_session_binding(&manifest.run_id, engine, session);
            }
            return Err(error);
        }
        // A stopped/reclaiming child's late native identity is needed for
        // cleanup and result projection, never to recreate tool authority.
        if !stopped && !cleanup_only {
            crate::host_chat::adopt_session(&manifest.run_id, session);
        }
        *route.session_id.lock().unwrap_or_else(|p| p.into_inner()) = Some(session.into());
        Ok(())
    }

    fn install(
        self: &Arc<Self>,
        client: WorkerClient,
        session: Option<String>,
        engine: Option<String>,
    ) -> Result<Arc<Route>, String> {
        let manifest = client.manifest();
        let registry = &self.app.state::<crate::AppState>().processes;
        {
            let mut map = registry.0.lock().map_err(|_| "Run registry unavailable")?;
            for key in std::iter::once(&manifest.run_id).chain(session.iter()) {
                if map.get(key).is_some_and(|existing| {
                    existing.run_id != manifest.run_id
                        || (existing.pid != manifest.pid && existing.pid != 0)
                }) {
                    return Err("Recovered task conflicts with another active session".into());
                }
            }
            let mut entry = map.get(&manifest.run_id).cloned().unwrap_or_else(|| {
                crate::engine::ChildEntry::worker_proxy(&manifest.run_id, manifest.pid)
            });
            entry.pid = manifest.pid;
            map.insert(manifest.run_id.clone(), entry.clone());
            if let Some(key) = &session {
                map.insert(key.clone(), entry);
            }
        }
        let worker_id = manifest.worker_id.clone();
        let aliases = HashSet::from([manifest.run_id.clone()]);
        let route = Arc::new(Route {
            client,
            replay_only: AtomicBool::new(false),
            engine,
            binding: Mutex::new(()),
            session_id: Mutex::new(session),
            run_aliases: Mutex::new(aliases),
            head: AtomicU64::new(0),
            observed: AtomicU64::new(0),
            observation_fault: AtomicBool::new(false),
            physically_complete: AtomicBool::new(false),
            native_complete: AtomicBool::new(false),
            archived: AtomicBool::new(false),
        });
        self.workers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(worker_id, route.clone());
        Ok(route)
    }

    /// Recover only the durable result of an uncheckpointed root. No native
    /// event is projected into Leader and no host-chat capability is restored.
    fn poll_orphan(self: &Arc<Self>, route: Arc<Route>, identity: recovery::RecoveryIdentity) {
        let owner = self.clone();
        tauri::async_runtime::spawn(async move {
            let stream = route.client.manifest().worker_id.clone();
            let mut retired: Option<(u64, &'static str, String)> = None;
            while !owner.stopped.load(Ordering::SeqCst) {
                if owner.observers_paused.load(Ordering::SeqCst) {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
                if let Some((head, terminal, request_id)) = &retired {
                    let observation = owner.controls.read().await;
                    if owner.observers_paused.load(Ordering::SeqCst) {
                        drop(observation);
                        continue;
                    }
                    if let Ok(saved) = archive(&stream).await {
                        if saved.head() == *head && saved.terminal_outcome(&identity.run_id, &identity.engine, &identity.session_id)
                            .ok().flatten().is_some_and(|proof| proof.status == *terminal)
                        {
                            // The immutable archive is verified before removing
                            // the registry alias or advertising a replay source.
                            owner.finish_native(&route);
                            route.head.store(*head, Ordering::SeqCst);
                            route.observed.store(*head, Ordering::SeqCst);
                            route.replay_only.store(true, Ordering::SeqCst);
                            route.physically_complete.store(true, Ordering::SeqCst);
                            route.archived.store(true, Ordering::SeqCst);
                            route.observation_fault.store(false, Ordering::SeqCst);
                            return;
                        }
                    }
                    // A lost retirement ACK is reconciled by the same command
                    // identity. Retirement is idempotent and never re-executes.
                    let result = route.client.request(request_id, Command::Retire { stream_id: stream.clone(), through: *head }).await;
                    if result.as_ref().err().is_some_and(|error| !error.outcome_unknown) { retired = None; }
                    drop(observation);
                } else if let Ok(status) = route.client.request(&uuid::Uuid::new_v4().to_string(), Command::Status).await {
                    if let Some(head) = recovery::finished_head(&status, &identity) {
                        let mut audit = recovery::OrphanAudit::new(&stream, &identity);
                        let mut cursor = 0;
                        let mut valid = true;
                        while cursor < head && !owner.stopped.load(Ordering::SeqCst) && !owner.observers_paused.load(Ordering::SeqCst) {
                            match route.client.events_after(cursor, 128).await {
                                Ok(page) if page.head == head && page.durable_through == head && !page.events.is_empty() && page.through > cursor && page.through <= head => {
                                    for event in &page.events {
                                        if let Err(cause) = audit.observe(event) {
                                            // A completed, immutable tail with inconsistent
                                            // identity must remain fenced, not retry forever.
                                            eprintln!("[worker-host] orphan recovery refused: {cause}");
                                            return;
                                        }
                                    }
                                    cursor = page.through;
                                }
                                _ => { valid = false; break; }
                            }
                        }
                        if valid && cursor == head && !owner.observers_paused.load(Ordering::SeqCst) {
                            let Some(terminal) = audit.finish(head) else {
                                eprintln!("[worker-host] orphan recovery refused: completed journal has no exact terminal");
                                return;
                            };
                            if let Ok(fresh) = route.client.request(&uuid::Uuid::new_v4().to_string(), Command::Status).await {
                                if recovery::finished_head(&fresh, &identity) == Some(head) {
                                    retired = Some((head, terminal, uuid::Uuid::new_v4().to_string()));
                                    continue;
                                }
                            }
                        }
                    }
                }
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        });
    }

    fn poll(self: &Arc<Self>, route: Arc<Route>) {
        let owner = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut cursor = 0;
            let mut delay = Duration::from_millis(25);
            let mut checked_status = tokio::time::Instant::now() - Duration::from_secs(2);
            let mut retirement_id: Option<String> = None;
            while !owner.stopped.load(Ordering::SeqCst) {
                // Admission and native observation share the handoff barrier.
                // Worker journals keep advancing while this desktop projection
                // is frozen; the replacement replays the unseen suffix.
                let observation = owner.controls.read().await;
                if owner.observers_paused.load(Ordering::SeqCst) {
                    drop(observation);
                    tokio::time::sleep(Duration::from_millis(40)).await;
                    continue;
                }
                match route.client.events_after(cursor, 128).await {
                    Ok(page) => {
                        route.head.store(page.head, Ordering::SeqCst);
                        for envelope in page.events {
                            if let Err(cause) = owner.observe_envelope(&route, &envelope) {
                                route.observation_fault.store(true, Ordering::SeqCst);
                                eprintln!("[worker-host] native task observation failed: {cause}");
                                revoke_task_authority(&route.client.manifest().run_id);
                                return;
                            }
                            cursor = envelope.seq;
                            route.observed.store(cursor, Ordering::SeqCst);
                        }
                        delay = if cursor < page.head {
                            Duration::ZERO
                        } else {
                            Duration::from_millis(40)
                        };
                        if cursor == page.head && checked_status.elapsed() >= Duration::from_secs(1)
                        {
                            checked_status = tokio::time::Instant::now();
                            if let Ok(status) = route
                                .client
                                .request(&uuid::Uuid::new_v4().to_string(), Command::Status)
                                .await
                            {
                                if native_tail_observed(&status, cursor) {
                                    owner.finish_native(&route);
                                }
                                if matches!(status["phase"].as_str(), Some("retired" | "failed"))
                                    && status["head"].as_u64() == Some(cursor)
                                    && status["durableThrough"].as_u64() == Some(cursor)
                                {
                                    route.physically_complete.store(true, Ordering::SeqCst);
                                    owner.finish_native(&route);
                                    let stream = route.client.manifest().worker_id.clone();
                                    let id = retirement_id
                                        .get_or_insert_with(|| uuid::Uuid::new_v4().to_string());
                                    let retired = route
                                        .client
                                        .request(
                                            id,
                                            Command::Retire {
                                                stream_id: stream.clone(),
                                                through: cursor,
                                            },
                                        )
                                        .await;
                                    if retired
                                        .as_ref()
                                        .err()
                                        .is_some_and(|error| !error.outcome_unknown)
                                    {
                                        retirement_id = None;
                                    }
                                    if retired.is_ok() {
                                        match archive(&stream).await {
                                            Ok(_) => {
                                                route.archived.store(true, Ordering::SeqCst);
                                                crate::host_chat::abandon_launch(
                                                    &route.client.manifest().run_id,
                                                );
                                                return;
                                            }
                                            Err(_) => { /* Kept unavailable; never claim an unverified archive is replayable. */
                                            }
                                        }
                                    }
                                    delay = Duration::from_millis(250);
                                }
                            }
                        }
                    }
                    Err(cause) => {
                        if let Ok(saved) = archive(&route.client.manifest().worker_id).await {
                            route.head.store(saved.head(), Ordering::SeqCst);
                            while cursor < saved.head() {
                                let page = match saved.replay(cursor, 128) {
                                    Ok(page) if !page.events.is_empty() => page,
                                    _ => {
                                        route.observation_fault.store(true, Ordering::SeqCst);
                                        return;
                                    }
                                };
                                for envelope in page.events {
                                    if let Err(cause) = owner.observe_envelope(&route, &envelope) {
                                        route.observation_fault.store(true, Ordering::SeqCst);
                                        eprintln!("[worker-host] archived task observation failed: {cause}");
                                        revoke_task_authority(&route.client.manifest().run_id);
                                        return;
                                    }
                                    cursor = envelope.seq;
                                    route.observed.store(cursor, Ordering::SeqCst);
                                }
                            }
                            owner.finish_native(&route);
                            route.physically_complete.store(true, Ordering::SeqCst);
                            route.archived.store(true, Ordering::SeqCst);
                            crate::host_chat::abandon_launch(&route.client.manifest().run_id);
                            return;
                        }
                        let state = owner.app.state::<crate::AppState>();
                        state.emitters.emit_json("runtime://worker-unavailable", &json!({
                            "streamId":route.client.manifest().worker_id,"runId":route.client.manifest().run_id,
                            "code":cause.code,"outcomeUnknown":cause.outcome_unknown}).to_string());
                        delay = std::cmp::min(
                            delay.max(Duration::from_millis(100)) * 2,
                            Duration::from_secs(5),
                        );
                    }
                }
                drop(observation);
                tokio::time::sleep(delay).await;
            }
        });
    }

    fn observe_envelope(&self, route: &Route, envelope: &crate::runtime_events::EventEnvelope) -> Result<(), String> {
        if envelope.name == crate::codex_quota::OBSERVATION_EVENT {
            crate::codex_quota::ingest_worker_observation(&envelope.payload);
        }
        if envelope.name == crate::event_sink::ENGINE_EVENT_NAME {
            let events = envelope.payload.as_array().ok_or("Worker engine batch is invalid")?;
            let base_run_id = &route.client.manifest().run_id;
            for event in events {
                let run_id = event["runId"].as_str().filter(|id| worker_event_belongs_to(base_run_id, id))
                    .ok_or("Worker event belongs to another run")?.to_owned();
                if route.engine.as_ref().is_some_and(|engine| event["engine"].as_str() != Some(engine.as_str())) {
                    return Err("Worker event engine differs from its admission".into());
                }
                if crate::leader::is_managed_child(base_run_id) && event["seq"].as_u64().is_none() {
                    return Err("Managed worker event has no replay sequence".into());
                }
                route.run_aliases.lock().unwrap_or_else(|p| p.into_inner()).insert(run_id);
                let stopped = self.app.state::<crate::AppState>().processes.get(base_run_id)
                    .is_some_and(|entry| entry.killed.load(Ordering::SeqCst));
                if event["kind"] == "session" && !route.native_complete.load(Ordering::SeqCst)
                    && (!stopped || crate::leader::is_managed_child(base_run_id)) {
                    if let Some(session) = event["sessionId"].as_str().or_else(|| event["data"].as_str()) {
                        self.bind_session(route, session)?;
                    }
                }
                // This journal is the only native observer for detached runs.
                // Its sequence is preserved across reconnects; Leader's saved
                // per-turn sequence prevents duplicate projection on replay.
                let mut projection = event.clone();
                crate::leader::observe_event(&mut projection);
                if projection["leader"]["identityRejected"] == true {
                    return Err("Worker event native identity was rejected".into());
                }
            }
        }
        let raw = serde_json::to_string(envelope).map_err(|_| "Encode worker event failed")?;
        route.observed.store(envelope.seq, Ordering::SeqCst);
        self.app.state::<crate::AppState>().emitters.emit_json("runtime://worker-event", &raw);
        Ok(())
    }

    fn route(&self, key: &str) -> Option<Arc<Route>> {
        let workers = self.workers.lock().unwrap_or_else(|p| p.into_inner());
        find_route(&workers, key)
    }
}

fn worker_event_belongs_to(base: &str, event_run: &str) -> bool {
    event_run == base || event_run.strip_prefix(base).and_then(|tail| tail.strip_prefix("-c"))
        .is_some_and(|suffix| !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit()))
}

fn native_tail_observed(status: &Value, observed: u64) -> bool {
    status["nativeComplete"] == true
        && status["head"].as_u64() == Some(observed)
        && status["durableThrough"].as_u64() == Some(observed)
}

fn find_route(workers: &HashMap<String, Arc<Route>>, key: &str) -> Option<Arc<Route>> {
    workers
        .values()
        .find(|route| {
            route
                .run_aliases
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .contains(key)
        })
        .or_else(|| {
            workers.values().find(|route| {
                !route.native_complete.load(Ordering::SeqCst)
                    && route
                        .session_id
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .as_deref()
                        == Some(key)
            })
        })
        .cloned()
}

async fn archive(id: &str) -> Result<Arc<crate::worker_archive::Archive>, String> {
    if let Some(archive) = ARCHIVES
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .find(|(key, _)| key == id)
        .map(|(_, archive)| archive.clone())
    {
        return Ok(archive);
    }
    let id_owned = id.to_owned();
    let opened = tauri::async_runtime::spawn_blocking(move || {
        crate::worker_archive::open(&crate::paths::app_home(), &id_owned)
    })
    .await
    .map_err(|_| "Read worker archive task failed".to_string())??;
    let opened = Arc::new(opened);
    let mut cache = ARCHIVES.lock().unwrap_or_else(|p| p.into_inner());
    if cache.len() >= 4 {
        cache.pop_front();
    }
    cache.push_back((id.into(), opened.clone()));
    Ok(opened)
}

pub(crate) async fn ensure_sources(cursors: &HashMap<String, u64>) -> Result<(), String> {
    if cursors.len() > MAX_SOURCES {
        return Err("Too many worker checkpoint sources".into());
    }
    let owner = host().ok_or("Task host unavailable")?;
    for (id, cursor) in cursors {
        let route = owner
            .workers
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
            .cloned();
        if let Some(route) = route {
            let head = if route.archived.load(Ordering::SeqCst) {
                archive(id).await?.head()
            } else {
                route
                    .client
                    .request(&uuid::Uuid::new_v4().to_string(), Command::Status)
                    .await
                    .map_err(error)?["head"]
                    .as_u64()
                    .ok_or("Worker replay head is unavailable")?
            };
            if head < *cursor {
                return Err("Worker source is behind its checkpoint".into());
            }
            continue;
        }
        let saved = archive(id).await?;
        if saved.head() < *cursor {
            return Err("Worker archive is behind its checkpoint".into());
        }
        let route = Arc::new(Route {
            client: WorkerClient::new(saved.manifest().clone()),
            replay_only: AtomicBool::new(true),
            engine: None,
            binding: Mutex::new(()),
            session_id: Mutex::new(saved.session_id()),
            run_aliases: Mutex::new(saved.run_ids().into_iter().collect()),
            head: AtomicU64::new(saved.head()),
            observed: AtomicU64::new(saved.head()),
            observation_fault: AtomicBool::new(false),
            physically_complete: AtomicBool::new(true),
            native_complete: AtomicBool::new(true),
            archived: AtomicBool::new(true),
        });
        let mut routes = owner.workers.lock().unwrap_or_else(|p| p.into_inner());
        let at_capacity = routes.len() >= MAX_SOURCES;
        // Archive I/O yielded; preserve a worker installed in the meantime.
        if let std::collections::hash_map::Entry::Vacant(entry) = routes.entry(id.clone()) {
            if at_capacity { return Err("Worker source retention capacity reached".into()); }
            entry.insert(route);
        }
    }
    Ok(())
}

async fn route_request(route: &Route, id: &str, command: Command) -> Result<Value, String> {
    if route.archived.load(Ordering::SeqCst) {
        let saved = archive(&route.client.manifest().worker_id).await?;
        if let Some(receipt) = saved.receipt_for(id, &command)? {
            return receipt.map_err(error);
        }
        return match command {
            Command::Interrupt | Command::InterruptTurn | Command::Followup { .. } => {
                Ok(json!(false))
            }
            _ => Err("The task has completed; no new control operation was dispatched".into()),
        };
    }
    for attempt in 0..4 {
        match route.client.request(id, command.clone()).await {
            Ok(value) => return Ok(value),
            Err(mut cause) => {
                // A terminal worker may have archived while its last response
                // was in flight. Its durable receipt remains authoritative.
                if let Ok(saved) = archive(&route.client.manifest().worker_id).await {
                    if let Some(receipt) = saved.receipt_for(id, &command)? {
                        return receipt.map_err(error);
                    }
                }
                let transport = cause.code.starts_with("transport_")
                    || matches!(
                        cause.code.as_str(),
                        "invalid_response" | "worker_not_running" | "worker_identity"
                    );
                if transport && attempt < 3 {
                    tokio::time::sleep(Duration::from_millis(50 * (attempt + 1))).await;
                    continue;
                }
                if transport {
                    cause.outcome_unknown = true;
                }
                return Err(error(cause));
            }
        }
    }
    unreachable!("bounded worker receipt recovery returns on its final attempt")
}

pub(crate) async fn start(
    run_id: String,
    args: StartArgs,
) -> Result<crate::engine::SendResult, String> {
    let memory_foreground = crate::plugin_memory::foreground();
    let owner = host().ok_or("Task host has not initialized")?;
    // Accepted launches outlive a disconnected caller, including the window
    // between child spawn, stable Start receipt, and returning the session id.
    tauri::async_runtime::spawn(async move {
        let _memory_foreground = memory_foreground;
        let _admission = loop {
            if owner.stopped.load(Ordering::SeqCst) {
                return Err("Task host is closing".into());
            }
            let guard = owner.admission.lock().await;
            if !owner.paused.load(Ordering::SeqCst) {
                break guard;
            }
            drop(guard);
            tokio::time::sleep(Duration::from_millis(25)).await;
        };
        let route = if let Some(route) = owner.route(&run_id) {
            route
        } else {
            if owner.workers.lock().unwrap_or_else(|p| p.into_inner()).len() >= MAX_SOURCES {
                return Err("Worker source retention capacity reached; no new task was started".into());
            }
            let state = owner.app.state::<crate::AppState>();
            if let Some(session) = &args.session_id {
                let deadline = tokio::time::Instant::now() + Duration::from_secs(6);
                while let Some(previous) = state.processes.get(session) {
                    if let Some(route) = owner.route(&previous.run_id) {
                        let status = route
                            .client
                            .request(&uuid::Uuid::new_v4().to_string(), Command::Status)
                            .await
                            .map_err(error)?;
                        if native_tail_observed(&status, route.observed.load(Ordering::SeqCst)) {
                            owner.finish_native(&route);
                            break;
                        }
                    }
                    if tokio::time::Instant::now() >= deadline {
                        return Err(
                            "Previous session run has not retired; use its live follow-up control"
                                .into(),
                        );
                    }
                    tokio::time::sleep(Duration::from_millis(40)).await;
                }
            }
            {
                let mut map = state
                    .processes
                    .0
                    .lock()
                    .map_err(|_| "Run registry unavailable")?;
                if map.contains_key(&run_id)
                    || args
                        .session_id
                        .as_ref()
                        .is_some_and(|id| map.contains_key(id))
                {
                    return Err("Session already has an active run".into());
                }
                if state.processes.active_run_count_from_map(&map)
                    >= crate::engine::MAX_CONCURRENT_RUNS
                {
                    return Err("Too many concurrent runs".into());
                }
                let entry = crate::engine::ChildEntry::worker_proxy(&run_id, 0);
                map.insert(run_id.clone(), entry.clone());
                if let Some(session) = &args.session_id {
                    map.insert(session.clone(), entry);
                }
            }
            let mut reservation = Reservation {
                registry: state.processes.clone(),
                run_id: run_id.clone(),
                committed: false,
                tasks_registered: false,
            };
            let executable =
                std::env::current_exe().map_err(|_| "Resolve task executable failed")?;
            let context = if args.require_host_chat {
                Some(crate::host_chat::prepare_worker_context(
                    &state.db,
                    &run_id,
                    &args.engine,
                    args.session_id.as_deref(),
                    &args.workspace_path,
                    args.permission.as_deref(),
                    &executable,
                )?)
            } else {
                None
            };
            reservation.tasks_registered = context.is_some();
            let manifest =
                match task_worker::launch_with_context(&executable, &run_id, context).await {
                    Ok(manifest) => manifest,
                    Err(cause) => {
                        crate::host_chat::finish_run(&run_id);
                        return Err(error(cause));
                    }
                };
            if owner.stopped.load(Ordering::SeqCst) {
                let client = WorkerClient::new(manifest);
                let _ = client
                    .request(&uuid::Uuid::new_v4().to_string(), Command::Shutdown)
                    .await;
                return Err("Task host closed during worker launch".into());
            }
            let route = owner.install(WorkerClient::new(manifest), args.session_id.clone(), Some(args.engine.clone()))?;
            reservation.committed = true;
            owner.poll(route.clone());
            route
        };
        let result = route_request(&route, &run_id, Command::Start { args }).await?;
        if owner
            .app
            .state::<crate::AppState>()
            .processes
            .get(&run_id)
            .is_some_and(|entry| entry.killed.load(Ordering::SeqCst))
        {
            crate::host_chat::revoke_run(&run_id);
            route
                .client
                .request(&format!("launch-stop-{run_id}"), Command::Interrupt)
                .await
                .map_err(error)?;
        }
        let result: crate::engine::SendResult =
            serde_json::from_value(result).map_err(|_| "Invalid worker start response")?;
        if let Some(session) = &result.session_id {
            if !route.native_complete.load(Ordering::SeqCst) {
                if let Err(error) = owner.bind_session(&route, session) {
                    revoke_task_authority(&run_id);
                    return Err(error);
                }
            }
        }
        Ok(result)
    })
    .await
    .map_err(|_| "Task admission failed; recover the same run ID".to_string())?
}

struct Reservation {
    registry: Arc<crate::engine::ProcessRegistry>,
    run_id: String,
    committed: bool,
    tasks_registered: bool,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        if !self.committed {
            self.registry.remove_run_if_pid(&self.run_id, 0);
            if self.tasks_registered {
                crate::host_chat::finish_run(&self.run_id);
            } else {
                crate::host_chat::abandon_launch(&self.run_id);
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn runtime_worker_start(
    state: tauri::State<'_, crate::AppState>,
    run_id: String,
    mut args: StartArgs,
) -> Result<Value, String> {
    let _memory_foreground = crate::plugin_memory::foreground();
    while paused() {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    if !enabled()
        || args.computer_use == Some(true)
        || args.require_leader
        || !matches!(args.engine.as_str(), "claude" | "codex" | "agy" | "cursor")
        || crate::engine::wsl_transport::transport_for_workspace(&state.db, &args.workspace_path)
            .is_some()
        || crate::leader::validate_host_worker_session(
            &state.db,
            &args.engine,
            args.session_id.as_deref(),
        )
        .is_err()
    {
        return Ok(json!({"handled":false}));
    }
    if run_id.is_empty()
        || run_id.len() > 96
        || !run_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
    {
        return Err("Invalid stable task run ID".into());
    }
    args.require_host_chat = true;
    let result = start(run_id, args).await?;
    Ok(json!({"handled":true,"value":result}))
}

pub(crate) fn active_aliases(run_ids: &[String]) -> Vec<String> {
    host()
        .map(|owner| {
            run_ids
                .iter()
                .filter(|id| {
                    owner
                        .route(id)
                        .is_some_and(|route| !route.native_complete.load(Ordering::SeqCst))
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) async fn control(
    key: &str,
    request_id: &str,
    command: Command,
) -> Option<Result<Value, String>> {
    let _memory_foreground = matches!(command, Command::Followup { .. }).then(crate::plugin_memory::foreground);
    let owner = host()?;
    let route = owner.route(key)?;
    if route.observation_fault.load(Ordering::SeqCst) && !recovery_control_allowed(&command) {
        return Some(Err("Worker recovery failed; only status, receipts and interrupt are available".into()));
    }
    let _control = loop {
        let guard = owner.controls.read().await;
        if !owner.paused.load(Ordering::SeqCst) {
            break guard;
        }
        drop(guard);
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    if matches!(command, Command::Interrupt) {
        let _binding = route.binding.lock().unwrap_or_else(|p| p.into_inner());
        // Fence the desktop capability before the RPC can race a late tool call.
        // InterruptTurn and StopTask keep the parent run alive.
        if let Some(entry) = owner.app.state::<crate::AppState>().processes.get(&route.client.manifest().run_id) {
            entry.killed.store(true, Ordering::SeqCst);
        }
        crate::host_chat::revoke_run(&route.client.manifest().run_id);
    }
    Some(route_request(&route, request_id, command).await)
}

fn recovery_control_allowed(command: &Command) -> bool {
    matches!(command, Command::Status | Command::Receipt { .. } | Command::Interrupt)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Source {
    stream_id: String,
    run_id: String,
    head: u64,
    active: bool,
    replay_only: bool,
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    recovery_error: Option<&'static str>,
}

#[tauri::command]
pub(crate) async fn runtime_worker_terminal_outcome(
    run_id: String,
    engine: String,
    session_id: String,
    workspace_path: String,
) -> Result<Option<crate::worker_archive::TerminalOutcome>, String> {
    tokio::task::spawn_blocking(move || crate::worker_archive::terminal_outcome(
        &crate::paths::app_home(), &run_id, &engine, &session_id, &workspace_path,
    )).await.map_err(|_| "Read worker terminal archive task failed".to_string())?
}

#[tauri::command]
pub(crate) async fn runtime_worker_sources(
    stream_ids: Option<Vec<String>>,
) -> Result<Vec<Source>, String> {
    if let Some(ids) = stream_ids {
        ensure_sources(&ids.into_iter().map(|id| (id, 0)).collect()).await?;
    }
    Ok(host()
        .map(|host| {
            host.workers
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .values()
                .map(|route| Source {
                    stream_id: route.client.manifest().worker_id.clone(),
                    run_id: route.client.manifest().run_id.clone(),
                    head: route.observed.load(Ordering::SeqCst),
                    active: !route.physically_complete.load(Ordering::SeqCst),
                    replay_only: route.replay_only.load(Ordering::SeqCst),
                    recovery_error: route.observation_fault.load(Ordering::SeqCst)
                        .then_some("worker-recovery-failed"),
                    session_id: route
                        .session_id
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .clone(),
                })
                .collect()
        })
        .unwrap_or_default())
}

#[tauri::command]
pub(crate) async fn runtime_worker_events(
    stream_id: String,
    after: u64,
    limit: usize,
) -> Result<crate::runtime_events::ReplayBatch, String> {
    let owner = host().ok_or("Task host unavailable")?;
    ensure_sources(&HashMap::from([(stream_id.clone(), after)])).await?;
    let route = owner
        .workers
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&stream_id)
        .cloned()
        .ok_or("Unknown worker stream")?;
    if route.observation_fault.load(Ordering::SeqCst) {
        return Err("Worker recovery failed; its event journal has not been validated".into());
    }
    if route.archived.load(Ordering::SeqCst) {
        return archive(&stream_id).await?.replay(after, limit);
    }
    let observed = route.observed.load(Ordering::SeqCst);
    if after > observed { return Err("Worker replay cursor is ahead of its validated task projection".into()); }
    let page = route
        .client
        .events_after(after, limit)
        .await
        .map_err(error)?;
    // Publication follows native validation. During handoff, observers are
    // frozen while the worker continues; do not expose that unseen suffix to
    // the frontend checkpoint or rewrite any payload to make it fit.
    Ok(validated_replay(page.stream_id, after, observed, page.events))
}

fn validated_replay(stream_id: String, after: u64, observed: u64, mut events: Vec<crate::runtime_events::EventEnvelope>) -> crate::runtime_events::ReplayBatch {
    events.retain(|event| event.seq <= observed);
    let through = events.last().map_or(after, |event| event.seq);
    crate::runtime_events::ReplayBatch { stream_id, through, events }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ControlRequest {
    pub key: String,
    pub request_id: String,
    pub command: Command,
}

#[tauri::command]
pub(crate) async fn runtime_worker_control(request: ControlRequest) -> Result<Value, String> {
    while paused() {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    if matches!(
        request.command,
        Command::Start { .. } | Command::Retire { .. } | Command::Shutdown
    ) {
        return Err("Worker lifecycle commands are owned by the desktop".into());
    }
    match control(&request.key, &request.request_id, request.command).await {
        Some(outcome) => outcome.map(|value| json!({"handled":true,"value":value})),
        None => Ok(json!({"handled":false})),
    }
}

pub(crate) async fn shutdown(preserve: bool) {
    crate::plugin_memory::cancel_all(true);
    let Some(owner) = host() else {
        return;
    };
    owner.paused.store(true, Ordering::SeqCst);
    owner.stopped.store(true, Ordering::SeqCst);
    if preserve {
        return;
    }
    let _admission = owner.admission.lock().await;
    let routes: Vec<_> = owner
        .workers
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .values()
        .cloned()
        .collect();
    let mut shutdowns = tokio::task::JoinSet::new();
    for route in routes
        .into_iter()
        .filter(|route| !route.archived.load(Ordering::SeqCst))
    {
        shutdowns.spawn(async move {
            let _ = tokio::time::timeout(
                Duration::from_secs(5),
                route
                    .client
                    .request(&uuid::Uuid::new_v4().to_string(), Command::Shutdown),
            )
            .await;
        });
    }
    while shutdowns.join_next().await.is_some() {}
}

#[cfg(test)]
mod tests {
    #[test]
    fn failed_recovery_allows_inspection_and_stop_but_no_new_work_or_replay() {
        for command in [
            json!({"op":"status"}),
            json!({"op":"receipt","request_id":"original-request"}),
            json!({"op":"interrupt"}),
        ] {
            assert!(super::recovery_control_allowed(&serde_json::from_value(command).unwrap()));
        }
        for command in [
            json!({"op":"followup","prompt":"continue","image_paths":null}),
            json!({"op":"interrupt_turn"}),
            json!({"op":"stop_task","task_id":"child"}),
            json!({"op":"answer_question","question_id":"question","answers":null}),
            json!({"op":"plan","plan_id":"plan","expected_revision":1,"decision":"approve","feedback":null}),
            json!({"op":"events","stream_id":"stream","after":0,"limit":10}),
            json!({"op":"retire","stream_id":"stream","through":10}),
            json!({"op":"shutdown"}),
        ] {
            assert!(!super::recovery_control_allowed(&serde_json::from_value(command).unwrap()));
        }
    }

    use super::*;
    #[test]
    fn replay_exposes_only_validated_events_and_preserves_their_original_payload() {
        let event = crate::runtime_events::EventEnvelope {
            stream_id: "worker".into(), seq: 1, name: crate::event_sink::ENGINE_EVENT_NAME.into(),
            payload: json!([{"runId":"child","kind":"session","leader":{"branchId":"branch","title":"原任务","assignment":"原任务 中文😀"}}]),
        };
        let unseen = crate::runtime_events::EventEnvelope { seq: 2, payload: json!([{"kind":"done"}]), ..event.clone() };
        let page = validated_replay("worker".into(), 0, 1, vec![event.clone(), unseen]);
        assert_eq!(page.through, 1);
        assert_eq!(page.events, vec![event]);
        let paused = validated_replay("worker".into(), 1, 1, Vec::new());
        assert_eq!(paused.through, 1);
        assert!(paused.events.is_empty());
    }
    #[test]
    fn native_completion_cannot_retire_an_unobserved_or_unflushed_tail() {
        let status = json!({"nativeComplete":true,"head":12,"durableThrough":12});
        assert!(!native_tail_observed(&status, 11));
        assert!(native_tail_observed(&status, 12));
        assert!(!native_tail_observed(&json!({"nativeComplete":true,"head":12,"durableThrough":11}), 12));
        assert!(!native_tail_observed(&json!({"nativeComplete":false,"head":12,"durableThrough":12}), 12));
        assert!(!native_tail_observed(&json!({"nativeComplete":true}), 0));
    }

    #[test]
    fn worker_event_ownership_accepts_only_its_exact_run_and_continuations() {
        assert!(worker_event_belongs_to("run-a", "run-a"));
        assert!(worker_event_belongs_to("run-a", "run-a-c2"));
        for wrong in ["run-b", "run-a-extra", "run-a-c", "run-a-c2-extra", "run-a-c-2"] {
            assert!(!worker_event_belongs_to("run-a", wrong));
        }
    }

    fn route(id: &str, completed: bool) -> Arc<Route> {
        Arc::new(Route {
            client: WorkerClient::new(task_worker::WorkerManifest {
                protocol: 1,
                worker_id: id.into(),
                run_id: id.into(),
                profile: std::path::PathBuf::new(),
                executable: std::path::PathBuf::new(),
                pid: 1,
                process_start_time: 1,
                port: 1,
                token: String::new(),
                schema_hash: String::new(),
            }),
            engine: Some("claude".into()),
            replay_only: AtomicBool::new(false),
            binding: Mutex::new(()),
            session_id: Mutex::new(Some("same-session".into())),
            run_aliases: Mutex::new(HashSet::from([id.into(), format!("{id}-c1")])),
            head: AtomicU64::new(1),
            observed: AtomicU64::new(1),
            observation_fault: AtomicBool::new(false),
            physically_complete: AtomicBool::new(completed),
            native_complete: AtomicBool::new(completed),
            archived: AtomicBool::new(completed),
        })
    }
    #[test]
    fn session_controls_select_successor_but_old_run_receipts_keep_their_archive_owner() {
        let previous = route("old", true);
        let current = route("new", false);
        let routes = HashMap::from([
            ("old".into(), previous.clone()),
            ("new".into(), current.clone()),
        ]);
        assert!(Arc::ptr_eq(
            &find_route(&routes, "same-session").unwrap(),
            &current
        ));
        assert!(Arc::ptr_eq(
            &find_route(&routes, "old-c1").unwrap(),
            &previous
        ));
        assert!(Arc::ptr_eq(
            &find_route(&routes, "new-c1").unwrap(),
            &current
        ));
        assert!(find_route(&HashMap::from([("old".into(), previous)]), "same-session").is_none());
    }
}
