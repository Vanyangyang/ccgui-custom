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
static PAUSED: AtomicBool = AtomicBool::new(false);
const MAX_SOURCES: usize = 4096;
static ARCHIVES: LazyLock<Mutex<VecDeque<(String, Arc<crate::worker_archive::Archive>)>>> =
    LazyLock::new(|| Mutex::new(VecDeque::new()));
struct Host {
    app: tauri::AppHandle,
    workers: Mutex<HashMap<String, Arc<Route>>>,
    ready: AtomicBool,
    paused: AtomicBool,
    stopped: AtomicBool,
    admission: tokio::sync::Mutex<()>,
    controls: tokio::sync::RwLock<()>,
}
struct Route {
    client: WorkerClient,
    session_id: Mutex<Option<String>>,
    run_aliases: Mutex<HashSet<String>>,
    head: AtomicU64,
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
        stopped: AtomicBool::new(false),
        admission: tokio::sync::Mutex::new(()),
        controls: tokio::sync::RwLock::new(()),
    });
    for manifest in workers {
        let client = WorkerClient::new(manifest);
        let status = client
            .request(&uuid::Uuid::new_v4().to_string(), Command::Status)
            .await
            .map_err(error)?;
        let session = status["sessionId"].as_str().map(str::to_string);
        let route = owner.install(client, session.clone())?;
        if status["nativeComplete"] == true {
            owner.finish_native(&route);
        } else {
            crate::host_chat::restore_worker_tasks(
                &route.client.manifest().run_id,
                status["engine"].as_str(), status["workspacePath"].as_str(), session.as_deref(),
            )?;
            if let Some(session) = session.as_deref() {
                owner.bind_session(&route, session)?;
            }
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
pub(crate) fn paused() -> bool {
    PAUSED.load(Ordering::SeqCst)
}
pub(crate) fn set_paused(paused: bool) {
    PAUSED.store(paused, Ordering::SeqCst);
    if let Some(host) = host() {
        host.paused.store(paused, Ordering::SeqCst);
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
                .map(|(id, route)| (id.clone(), route.head.load(Ordering::SeqCst)))
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) async fn quiesce() -> Result<(), String> {
    let owner = host().ok_or("Task host unavailable")?;
    set_paused(true);
    let result = tokio::time::timeout(Duration::from_secs(15), async {
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

pub(crate) async fn blockers(registry: &crate::engine::ProcessRegistry) -> Vec<String> {
    let Some(owner) = host() else {
        return vec!["worker-unavailable".into()];
    };
    let routes: Vec<_> = owner
        .workers
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .values()
        .cloned()
        .collect();
    let managed: HashSet<_> = routes
        .iter()
        .map(|route| route.client.manifest().run_id.clone())
        .collect();
    let mut blockers = Vec::new();
    if registry
        .0
        .lock()
        .map(|map| map.values().any(|entry| !managed.contains(&entry.run_id)))
        .unwrap_or(true)
    {
        blockers.push("legacy-runs".into());
    }
    for route in routes {
        if route.archived.load(Ordering::SeqCst) {
            continue;
        }
        match tokio::time::timeout(
            Duration::from_secs(3),
            route
                .client
                .request(&uuid::Uuid::new_v4().to_string(), Command::Status),
        )
        .await
        {
            Ok(Ok(status)) => {
                if status["journalFault"] == true || status["receiptFault"] == true {
                    blockers.push("worker-journal-fault".into());
                }
            }
            _ => blockers.push("worker-unavailable".into()),
        }
    }
    blockers.sort();
    blockers.dedup();
    blockers
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
        let manifest = route.client.manifest();
        let state = self.app.state::<crate::AppState>();
        let engine = crate::host_chat::worker_task_engine(&manifest.run_id);
        let already_owned = state.processes.get(session).is_some_and(|entry|
            entry.run_id == manifest.run_id && entry.pid == manifest.pid);
        if let Some(engine) = engine.as_deref() {
            match crate::leader::reserve_session_binding(&manifest.run_id, engine, session)? {
                crate::leader::SessionBinding::Adopt => {},
                crate::leader::SessionBinding::CleanupOnly => {
                    crate::leader::release_session_binding(&manifest.run_id, engine, session);
                    return Err("Worker parent cannot bind a retiring child identity".into());
                }
            }
        }
        let claim = (|| {
            let entry = state.processes.get(&manifest.run_id).ok_or("Worker run has retired before session binding")?;
            if entry.pid != manifest.pid || entry.killed.load(Ordering::SeqCst) {
                return Err("Worker session binding has no active owned proxy".into());
            }
            state.processes.rekey(&manifest.run_id, session.into())?;
            let alias = state.processes.get(session).ok_or("Worker session alias was not retained")?;
            if alias.run_id != manifest.run_id || alias.pid != manifest.pid || alias.killed.load(Ordering::SeqCst) {
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
        crate::host_chat::adopt_session(&manifest.run_id, session);
        *route.session_id.lock().unwrap_or_else(|p| p.into_inner()) = Some(session.into());
        Ok(())
    }

    fn install(
        self: &Arc<Self>,
        client: WorkerClient,
        session: Option<String>,
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
            session_id: Mutex::new(session),
            run_aliases: Mutex::new(aliases),
            head: AtomicU64::new(0),
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

    fn poll(self: &Arc<Self>, route: Arc<Route>) {
        let owner = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut cursor = 0;
            let mut delay = Duration::from_millis(25);
            let mut checked_status = tokio::time::Instant::now() - Duration::from_secs(2);
            let mut retirement_id: Option<String> = None;
            while !owner.stopped.load(Ordering::SeqCst) {
                match route.client.events_after(cursor, 128).await {
                    Ok(page) => {
                        route.head.store(page.head, Ordering::SeqCst);
                        let state = owner.app.state::<crate::AppState>();
                        for envelope in page.events {
                            if envelope.name == crate::codex_quota::OBSERVATION_EVENT {
                                crate::codex_quota::ingest_worker_observation(&envelope.payload);
                            }
                            if envelope.name == crate::event_sink::ENGINE_EVENT_NAME {
                                for event in envelope.payload.as_array().into_iter().flatten() {
                                    if let Some(run_id) = event["runId"].as_str() {
                                        route
                                            .run_aliases
                                            .lock()
                                            .unwrap_or_else(|p| p.into_inner())
                                            .insert(run_id.into());
                                    }
                                    if event["kind"] == "session" && !route.native_complete.load(Ordering::SeqCst) {
                                        if let Some(session) = event["sessionId"].as_str() {
                                            if let Err(cause) = owner.bind_session(&route, session) {
                                                eprintln!(
                                                    "[worker-host] session route rejected: {cause}"
                                                );
                                                revoke_task_authority(&route.client.manifest().run_id);
                                            }
                                        }
                                    }
                                }
                            }
                            if let Ok(raw) = serde_json::to_string(&envelope) {
                                state.emitters.emit_json("runtime://worker-event", &raw);
                            }
                            cursor = envelope.seq;
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
                                if status["nativeComplete"] == true {
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
                tokio::time::sleep(delay).await;
            }
        });
    }

    fn route(&self, key: &str) -> Option<Arc<Route>> {
        let workers = self.workers.lock().unwrap_or_else(|p| p.into_inner());
        find_route(&workers, key)
    }
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
            session_id: Mutex::new(saved.session_id()),
            run_aliases: Mutex::new(saved.run_ids().into_iter().collect()),
            head: AtomicU64::new(saved.head()),
            physically_complete: AtomicBool::new(true),
            native_complete: AtomicBool::new(true),
            archived: AtomicBool::new(true),
        });
        let mut routes = owner.workers.lock().unwrap_or_else(|p| p.into_inner());
        if routes.len() >= MAX_SOURCES && !routes.contains_key(id) { return Err("Worker source retention capacity reached".into()); }
        routes.insert(id.clone(), route);
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
    let owner = host().ok_or("Task host has not initialized")?;
    // Accepted launches outlive a disconnected caller, including the window
    // between child spawn, stable Start receipt, and returning the session id.
    tauri::async_runtime::spawn(async move {
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
                        if status["nativeComplete"] == true {
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
            let route = owner.install(WorkerClient::new(manifest), args.session_id.clone())?;
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
            revoke_task_authority(&run_id);
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
    while paused() {
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    if !enabled()
        || crate::leader::is_managed_child(&run_id)
        || args.computer_use == Some(true)
        || args.require_leader
        || !matches!(args.engine.as_str(), "claude" | "codex" | "agy" | "cursor")
        || crate::engine::wsl_transport::transport_for_workspace(&state.db, &args.workspace_path)
            .is_some()
        || crate::leader::validate_worker_session(
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
    let owner = host()?;
    let route = owner.route(key)?;
    let _control = loop {
        let guard = owner.controls.read().await;
        if !owner.paused.load(Ordering::SeqCst) {
            break guard;
        }
        drop(guard);
        tokio::time::sleep(Duration::from_millis(25)).await;
    };
    if matches!(command, Command::Interrupt) {
        // Fence the desktop capability before the RPC can race a late tool call.
        // InterruptTurn and StopTask keep the parent run alive.
        if let Some(entry) = owner.app.state::<crate::AppState>().processes.get(&route.client.manifest().run_id) {
            entry.killed.store(true, Ordering::SeqCst);
        }
        revoke_task_authority(&route.client.manifest().run_id);
    }
    Some(route_request(&route, request_id, command).await)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Source {
    stream_id: String,
    run_id: String,
    head: u64,
    active: bool,
    session_id: Option<String>,
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
                    head: route.head.load(Ordering::SeqCst),
                    active: !route.physically_complete.load(Ordering::SeqCst),
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
    if route.archived.load(Ordering::SeqCst) {
        return archive(&stream_id).await?.replay(after, limit);
    }
    let page = route
        .client
        .events_after(after, limit)
        .await
        .map_err(error)?;
    Ok(crate::runtime_events::ReplayBatch {
        stream_id: page.stream_id,
        through: page.through,
        events: page.events,
    })
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
    use super::*;
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
            session_id: Mutex::new(Some("same-session".into())),
            run_aliases: Mutex::new(HashSet::from([id.into(), format!("{id}-c1")])),
            head: AtomicU64::new(1),
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
