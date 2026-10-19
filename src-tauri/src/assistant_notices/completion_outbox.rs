//! Latest completion per admitted resident root, durably handed from workers to the GUI.
//! This is a bounded delivery outbox, not a conversation archive. Only the GUI sends it.
use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const SLOT_CAP: usize = 512;
const ACTIVE_CAP: usize = 64;
const SUMMARY_CHARS: usize = 8_000;
const PROMPT_CHARS: usize = 500;
const WORKSPACE_BYTES: usize = 4096;
const MAX_MS: u64 = 9_007_199_254_740_991;

#[path = "observer_progress.rs"]
mod observer_progress;
pub use observer_progress::Checkpoint;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pending {
    pub id: String,
    pub engine: String,
    pub session_id: String,
    pub workspace_path: String,
    pub prompt: String,
    pub summary: String,
    pub started_at_ms: u64,
    pub completed_at_ms: u64,
    pub generation: u64,
    pub cancel: bool,
    pub started: bool,
}

pub struct Outbox {
    connection: Mutex<Connection>,
    owner: Option<ProcessOwner>,
}
#[derive(Clone, Copy)]
struct ProcessOwner {
    pid: u32,
    birth: u64,
}
fn current_owner() -> Option<ProcessOwner> {
    #[cfg(all(windows, not(test)))]
    {
        let pid = std::process::id();
        crate::process_liveness::process_birth(pid)
            .ok()
            .flatten()
            .map(|birth| ProcessOwner { pid, birth })
    }
    #[cfg(any(not(windows), test))]
    {
        None
    }
}
#[derive(Clone)]
struct Reservation {
    root: String,
    token: String,
    generation: u64,
}
fn storage(_: rusqlite::Error) -> String {
    "storage_unavailable".into()
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(MAX_MS as u128) as u64
}
fn sqlite_u64(value: u64) -> Result<i64, String> {
    i64::try_from(value).map_err(|_| "invalid_request".into())
}
impl Outbox {
    pub fn open(path: impl AsRef<Path>) -> Result<Arc<Self>, String> {
        Self::open_with_owner(path, current_owner())
    }

    fn open_with_owner(
        path: impl AsRef<Path>,
        owner: Option<ProcessOwner>,
    ) -> Result<Arc<Self>, String> {
        let path = path.as_ref();
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(|_| "storage_unavailable".to_string())?;
        }
        let mut connection = Connection::open(path).map_err(storage)?;
        connection
            .busy_timeout(Duration::from_secs(2))
            .map_err(storage)?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
            )
            .map_err(storage)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let version: i64 = transaction
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(storage)?;
        if !matches!(version, 0 | 1 | 2 | 3) {
            return Err("unsupported_schema".into());
        }
        transaction.execute_batch(
            "CREATE TABLE IF NOT EXISTS readiness (singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation INTEGER NOT NULL, ready_until_ms INTEGER NOT NULL);
             INSERT OR IGNORE INTO readiness VALUES (1,0,0);
             CREATE TABLE IF NOT EXISTS slots (root TEXT PRIMARY KEY, token TEXT NOT NULL, generation INTEGER NOT NULL,
                 active INTEGER NOT NULL CHECK(active IN (0,1)), last_event_id TEXT,
                 owner_pid INTEGER, owner_birth TEXT, metadata_json TEXT);
             CREATE TABLE IF NOT EXISTS pending (id TEXT PRIMARY KEY, root TEXT NOT NULL UNIQUE REFERENCES slots(root) ON DELETE CASCADE,
                 engine TEXT NOT NULL, session_id TEXT NOT NULL, workspace_path TEXT NOT NULL, prompt TEXT NOT NULL, summary TEXT NOT NULL,
                 started_at_ms INTEGER NOT NULL, completed_at_ms INTEGER NOT NULL, generation INTEGER NOT NULL, cancel INTEGER NOT NULL CHECK(cancel IN (0,1)), started INTEGER NOT NULL DEFAULT 0 CHECK(started IN (0,1)));"
        ).map_err(storage)?;
        if version == 1 {
            transaction.execute_batch("ALTER TABLE pending ADD COLUMN started INTEGER NOT NULL DEFAULT 0 CHECK(started IN (0,1));").map_err(storage)?;
        }
        if version == 1 || version == 2 {
            transaction.execute_batch("ALTER TABLE slots ADD COLUMN owner_pid INTEGER; ALTER TABLE slots ADD COLUMN owner_birth TEXT; ALTER TABLE slots ADD COLUMN metadata_json TEXT;").map_err(storage)?;
        }
        transaction
            .execute_batch("PRAGMA user_version=3;")
            .map_err(storage)?;
        transaction.commit().map_err(storage)?;
        // This optional schema-3 extension must not prevent old completion
        // producers from opening their durable outbox if its setup fails.
        let _ = observer_progress::initialize(&connection);
        Ok(Arc::new(Self {
            connection: Mutex::new(connection),
            owner,
        }))
    }

    pub fn set_ready(&self, generation: u64, ready_until_ms: u64) -> Result<(), String> {
        if generation == 0 || ready_until_ms > MAX_MS {
            return Err("invalid_request".into());
        }
        self.connection
            .lock()
            .execute(
                "UPDATE readiness SET generation=?1,ready_until_ms=?2 WHERE singleton=1",
                params![sqlite_u64(generation)?, sqlite_u64(ready_until_ms)?],
            )
            .map_err(storage)?;
        Ok(())
    }

    pub fn pause(&self) -> Result<(), String> {
        self.connection
            .lock()
            .execute(
                "UPDATE readiness SET ready_until_ms=0 WHERE singleton=1",
                [],
            )
            .map_err(storage)?;
        Ok(())
    }

    pub fn pending(&self, limit: usize) -> Result<Vec<Pending>, String> {
        let connection = self.connection.lock();
        let mut statement = connection.prepare("SELECT id,engine,session_id,workspace_path,prompt,summary,started_at_ms,completed_at_ms,generation,cancel,started FROM pending ORDER BY started_at_ms,id LIMIT ?1").map_err(storage)?;
        let rows = statement
            .query_map([limit.min(SLOT_CAP) as i64], |row| {
                Ok(Pending {
                    id: row.get(0)?,
                    engine: row.get(1)?,
                    session_id: row.get(2)?,
                    workspace_path: row.get(3)?,
                    prompt: row.get(4)?,
                    summary: row.get(5)?,
                    started_at_ms: row.get(6)?,
                    completed_at_ms: row.get(7)?,
                    generation: row.get(8)?,
                    cancel: row.get(9)?,
                    started: row.get(10)?,
                })
            })
            .map_err(storage)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(storage)
    }

    /// An ACK for a copied old event cannot erase a newer replacement in the root's slot.
    pub fn finish(&self, id: &str) -> Result<(), String> {
        let mut connection = self.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        transaction
            .execute("DELETE FROM pending WHERE id=?1", [id])
            .map_err(storage)?;
        transaction.execute("DELETE FROM slots WHERE active=0 AND NOT EXISTS (SELECT 1 FROM pending WHERE pending.root=slots.root)", []).map_err(storage)?;
        transaction.commit().map_err(storage)
    }

    fn reserve(&self, root: &str, now: u64) -> Result<Option<Reservation>, String> {
        #[cfg(all(windows, not(test)))]
        if self.owner.is_none() {
            return Ok(None);
        }
        let mut connection = self.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let (generation, ready_until): (u64, u64) = transaction
            .query_row(
                "SELECT generation,ready_until_ms FROM readiness WHERE singleton=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(storage)?;
        let (slots, active): (usize, usize) = transaction
            .query_row(
                "SELECT COUNT(*),COALESCE(SUM(active),0) FROM slots",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(storage)?;
        if generation == 0 || ready_until <= now || slots >= SLOT_CAP || active >= ACTIVE_CAP {
            return Ok(None);
        }
        let reservation = Reservation {
            root: root.into(),
            token: uuid::Uuid::new_v4().simple().to_string(),
            generation,
        };
        let inserted = transaction.execute(
            "INSERT OR IGNORE INTO slots(root,token,generation,active,owner_pid,owner_birth) VALUES(?1,?2,?3,1,?4,?5)",
            params![root,reservation.token,sqlite_u64(generation)?,self.owner.map(|owner|owner.pid),self.owner.map(|owner|owner.birth.to_string())],
        ).map_err(storage)?;
        transaction.commit().map_err(storage)?;
        Ok((inserted == 1).then_some(reservation))
    }

    fn persist(&self, reservation: &Reservation, event: &Pending) -> Result<(), String> {
        if event.generation != reservation.generation {
            return Err("reservation_lost".into());
        }
        let mut connection = self.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        let previous: Option<Option<String>> = transaction.query_row(
            "SELECT last_event_id FROM slots WHERE root=?1 AND token=?2 AND generation=?3 AND active=1",
            params![reservation.root,reservation.token,sqlite_u64(reservation.generation)?], |row| row.get(0)
        ).optional().map_err(storage)?;
        let Some(previous) = previous else {
            return Err("reservation_lost".into());
        };
        if previous.as_deref() == Some(event.id.as_str()) {
            return Ok(());
        }
        replace_pending(&transaction, &reservation.root, event)?;
        transaction.commit().map_err(storage)
    }

    fn release(&self, root: &str) -> Result<(), String> {
        let mut connection = self.connection.lock();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        transaction
            .execute("UPDATE slots SET active=0 WHERE root=?1", [root])
            .map_err(storage)?;
        transaction.execute("DELETE FROM slots WHERE root=?1 AND NOT EXISTS (SELECT 1 FROM pending WHERE pending.root=slots.root)", [root]).map_err(storage)?;
        transaction.commit().map_err(storage)
    }

    pub fn reap_dead_owners(&self) -> Result<usize, String> {
        #[cfg(all(windows, not(test)))]
        {
            self.reap_with(now_ms(), crate::process_liveness::process_birth)
        }
        #[cfg(any(not(windows), test))]
        {
            Ok(0)
        }
    }

    fn reap_with(
        &self,
        now: u64,
        inspect: impl Fn(u32) -> Result<Option<u64>, ()>,
    ) -> Result<usize, String> {
        let snapshots = {
            let connection = self.connection.lock();
            let mut statement = connection.prepare("SELECT root,token,owner_pid,owner_birth FROM slots WHERE active=1 AND owner_pid IS NOT NULL AND owner_birth IS NOT NULL LIMIT 64").map_err(storage)?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, u32>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })
                .map_err(storage)?;
            rows.collect::<Result<Vec<_>, _>>().map_err(storage)?
        };
        let mut reaped = 0;
        for (root, token, pid, stored_birth) in snapshots {
            let Ok(birth) = stored_birth.parse::<u64>() else {
                continue;
            };
            if pid == 0 || birth == 0 {
                continue;
            }
            let confirmed_dead = match inspect(pid) {
                Ok(None) => true,
                Ok(Some(current)) => current != birth,
                Err(()) => false,
            };
            if !confirmed_dead {
                continue;
            }
            let mut connection = self.connection.lock();
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(storage)?;
            // Re-read after the kernel probe: the dead worker may have committed its
            // terminal between our snapshot and exit. Never replace that completion.
            let current: Option<(u64,Option<String>)> = transaction.query_row(
                "SELECT generation,substr(metadata_json,1,65537) FROM slots WHERE root=?1 AND token=?2 AND active=1 AND owner_pid=?3 AND owner_birth=?4",
                params![root,token,pid,stored_birth], |row| Ok((row.get(0)?,row.get(1)?))
            ).optional().map_err(storage)?;
            let Some((generation, metadata)) = current else {
                continue;
            };
            let pending_started: Option<bool> = transaction
                .query_row(
                    "SELECT started FROM pending WHERE root=?1",
                    [&root],
                    |row| row.get(0),
                )
                .optional()
                .map_err(storage)?;
            transaction
                .execute(
                    "UPDATE slots SET active=0 WHERE root=?1 AND token=?2",
                    params![root, token],
                )
                .map_err(storage)?;
            if pending_started != Some(false) {
                if let Some(mut phase) = metadata
                    .filter(|text| text.len() <= 65_536)
                    .and_then(|text| serde_json::from_str::<Pending>(&text).ok())
                    .filter(|phase| {
                        phase.started
                            && phase.generation == generation
                            && valid_engine(&phase.engine)
                            && valid_id(&phase.session_id)
                            && !phase.workspace_path.is_empty()
                            && phase.workspace_path.len() <= WORKSPACE_BYTES
                            && phase.started_at_ms > 0
                            && phase.started_at_ms <= MAX_MS
                    })
                {
                    phase.id = format!("ccgui-orphan-{:x}", Sha256::digest(token.as_bytes()));
                    phase.prompt.clear();
                    phase.summary.clear();
                    phase.started = false;
                    phase.cancel = true;
                    phase.completed_at_ms = now.clamp(1, MAX_MS).max(phase.started_at_ms);
                    replace_pending(&transaction, &root, &phase)?;
                }
            }
            transaction.execute("DELETE FROM slots WHERE root=?1 AND active=0 AND NOT EXISTS (SELECT 1 FROM pending WHERE pending.root=slots.root)",[&root]).map_err(storage)?;
            transaction.commit().map_err(storage)?;
            reaped += 1;
        }
        Ok(reaped)
    }
}

fn replace_pending(
    transaction: &rusqlite::Transaction<'_>,
    root: &str,
    event: &Pending,
) -> Result<(), String> {
    transaction
        .execute("DELETE FROM pending WHERE root=?1", [root])
        .map_err(storage)?;
    let inserted=transaction.execute("INSERT OR IGNORE INTO pending(id,root,engine,session_id,workspace_path,prompt,summary,started_at_ms,completed_at_ms,generation,cancel,started) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![event.id,root,event.engine,event.session_id,event.workspace_path,event.prompt,event.summary,sqlite_u64(event.started_at_ms)?,sqlite_u64(event.completed_at_ms)?,sqlite_u64(event.generation)?,event.cancel,event.started]).map_err(storage)?;
    if inserted != 1 {
        return Err("event_conflict".into());
    }
    let mut metadata = event.clone();
    metadata.prompt.clear();
    metadata.summary.clear();
    let metadata = serde_json::to_string(&metadata).map_err(|_| "invalid_request".to_string())?;
    transaction
        .execute(
            "UPDATE slots SET last_event_id=?1,metadata_json=?2 WHERE root=?3",
            params![event.id, metadata, root],
        )
        .map_err(storage)?;
    Ok(())
}

struct Terminal {
    id: String,
    completed_at_ms: u64,
    cancel: bool,
}
struct Run {
    reservation: Reservation,
    engine: String,
    session: Option<String>,
    workspace: String,
    prompt: String,
    logical: String,
    continuation: u64,
    last_seq: Option<u64>,
    started_at_ms: u64,
    admitted_at_ms: u64,
    summary: String,
    summary_chars: usize,
    terminal: Option<Terminal>,
    pending_start: Option<Pending>,
    progress: observer_progress::ProgressCapture,
    poisoned: bool,
    killed: Arc<AtomicBool>,
}

pub struct Recorder {
    outbox: Arc<Outbox>,
    runs: Mutex<HashMap<String, Run>>,
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 160
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}
fn valid_engine(engine: &str) -> bool {
    crate::config::ENGINES.contains(&engine)
}
fn bounded(text: &str, chars: usize) -> String {
    text.chars().take(chars).collect()
}
fn continuation(root: &str, logical: &str) -> Option<u64> {
    if root == logical {
        return Some(0);
    }
    let suffix = logical.strip_prefix(root)?.strip_prefix("-c")?;
    if suffix.is_empty() || suffix.starts_with('0') || !suffix.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    suffix.parse::<u64>().ok().filter(|n| *n > 0)
}
fn event_id(root: &str, logical: &str, seq: u64) -> String {
    let bytes = serde_json::to_vec(&(root, logical, seq)).expect("fixed scalar tuple");
    format!("ccgui-{:x}", Sha256::digest(bytes))
}
impl Recorder {
    pub fn new(outbox: Arc<Outbox>) -> Self {
        Self {
            outbox,
            runs: Mutex::new(HashMap::new()),
            clock: Arc::new(now_ms),
        }
    }

    /// A successful return is backed by a cross-process durable capacity reservation.
    pub fn register_run(
        &self,
        run_id: &str,
        engine: &str,
        workspace: &str,
        session: Option<&str>,
        prompt: &str,
        killed: &Arc<AtomicBool>,
    ) -> bool {
        if !valid_id(run_id)
            || !valid_engine(engine)
            || workspace.is_empty()
            || workspace.len() > WORKSPACE_BYTES
            || workspace.chars().any(char::is_control)
            || session.is_some_and(|s| !valid_id(s))
            || killed.load(Ordering::SeqCst)
        {
            return false;
        }
        let mut runs = self.runs.lock();
        if runs.contains_key(run_id) || runs.len() >= ACTIVE_CAP {
            return false;
        }
        let now = (self.clock)().clamp(1, MAX_MS);
        let Ok(Some(reservation)) = self.outbox.reserve(run_id, now) else {
            return false;
        };
        // Starting another turn on a known source invalidates its previous aside.
        // Sequence zero is reserved for this admission event; reader sequences start at one.
        if let Some(session) = session {
            let cancellation = Pending {
                id: event_id(run_id, run_id, 0),
                engine: engine.into(),
                session_id: session.into(),
                workspace_path: workspace.into(),
                prompt: bounded(prompt, PROMPT_CHARS),
                summary: String::new(),
                started_at_ms: now,
                completed_at_ms: now,
                generation: reservation.generation,
                cancel: true,
                started: true,
            };
            if self.outbox.persist(&reservation, &cancellation).is_err() {
                let _ = self.outbox.release(run_id);
                return false;
            }
        }
        runs.insert(
            run_id.into(),
            Run {
                reservation,
                engine: engine.into(),
                session: session.map(str::to_string),
                workspace: workspace.into(),
                prompt: bounded(prompt, PROMPT_CHARS),
                logical: run_id.into(),
                continuation: 0,
                last_seq: None,
                started_at_ms: now,
                admitted_at_ms: now,
                summary: String::new(),
                summary_chars: 0,
                terminal: None,
                pending_start: None,
                progress: Default::default(),
                poisoned: false,
                killed: killed.clone(),
            },
        );
        true
    }

    /// Reader adoption is the only way to learn a native source; event payloads cannot bind it.
    pub fn adopt_session(&self, run_id: &str, engine: &str, session: &str) -> bool {
        if !valid_engine(engine) || !valid_id(session) {
            return false;
        }
        let mut runs = self.runs.lock();
        let Some(run) = runs.get_mut(run_id) else {
            return false;
        };
        if run.engine != engine || run.session.as_deref().is_some_and(|old| old != session) {
            run.poisoned = true;
            return false;
        }
        let first_adoption = run.session.is_none();
        run.session = Some(session.into());
        if first_adoption && run.terminal.is_none() && run.pending_start.is_none() {
            run.pending_start = Some(Pending {
                id: event_id(run_id, run_id, 0),
                engine: run.engine.clone(),
                session_id: session.into(),
                workspace_path: run.workspace.clone(),
                prompt: run.prompt.clone(),
                summary: String::new(),
                started_at_ms: run.admitted_at_ms,
                completed_at_ms: run.admitted_at_ms,
                generation: run.reservation.generation,
                cancel: true,
                started: true,
            });
        }
        // A terminal can precede an explicit identity adoption; its original ID/time stays fixed.
        self.persist(run).is_ok()
    }

    fn persist(&self, run: &mut Run) -> Result<(), String> {
        if let Some(started) = run.pending_start.take() {
            if let Err(error) = self.outbox.persist(&run.reservation, &started) {
                run.pending_start = Some(started);
                return Err(error);
            }
        }
        let (Some(session), Some(terminal)) = (&run.session, &run.terminal) else {
            return Ok(());
        };
        self.outbox.persist(
            &run.reservation,
            &Pending {
                id: terminal.id.clone(),
                engine: run.engine.clone(),
                session_id: session.clone(),
                workspace_path: run.workspace.clone(),
                prompt: run.prompt.clone(),
                summary: if terminal.cancel {
                    String::new()
                } else {
                    run.summary.clone()
                },
                started_at_ms: run.started_at_ms,
                completed_at_ms: terminal.completed_at_ms,
                generation: run.reservation.generation,
                cancel: terminal.cancel,
                started: false,
            },
        )
    }

    pub fn observe_event(&self, event: &Value) -> Result<(), String> {
        let Some(logical) = event.get("runId").and_then(Value::as_str) else {
            return Ok(());
        };
        let root = match event.get("sourceRunId") {
            None | Some(Value::Null) => logical,
            Some(Value::String(root)) => root.as_str(),
            _ => return Ok(()),
        };
        let (Some(engine), Some(seq), Some(kind)) = (
            event.get("engine").and_then(Value::as_str),
            event.get("seq").and_then(Value::as_u64),
            event.get("kind").and_then(Value::as_str),
        ) else {
            return Ok(());
        };
        if seq == 0 || seq >= MAX_MS {
            return Ok(());
        }
        let Some(ordinal) = continuation(root, logical) else {
            return Ok(());
        };
        let mut runs = self.runs.lock();
        let Some(run) = runs.get_mut(root) else {
            return Ok(());
        };
        if engine != run.engine
            || ordinal < run.continuation
            || run.last_seq.is_some_and(|old| seq <= old)
        {
            return Ok(());
        }
        if let Some(session) = event.get("sessionId").filter(|v| !v.is_null()) {
            let Some(session) = session.as_str() else {
                return Ok(());
            };
            if Some(session) != run.session.as_deref() {
                return Ok(());
            }
        }
        run.last_seq = Some(seq);
        let data = &event["data"];
        let role = data.get("role").and_then(Value::as_str);
        let output = matches!(kind, "delta" | "thinking")
            && data.as_str().is_some_and(|text| !text.is_empty())
            || kind == "message"
                && (matches!(role, Some("tool" | "thinking"))
                    || role == Some("assistant")
                        && data
                            .get("text")
                            .and_then(Value::as_str)
                            .is_some_and(|text| !text.is_empty()));
        let cancelled = run.killed.load(Ordering::SeqCst)
            || run.poisoned
            || matches!(
                kind,
                "error" | "killed" | "interrupted" | "reclaimed" | "cancelled" | "canceled"
            )
            || ["interrupted", "killed", "reclaimed", "cancelled"]
                .iter()
                .any(|key| data.get(*key).and_then(Value::as_bool) == Some(true));
        let now = (self.clock)().clamp(1, MAX_MS);
        let stamp = event
            .get("ts")
            .and_then(Value::as_u64)
            .filter(|n| *n > 0 && *n <= MAX_MS)
            .unwrap_or(now)
            .min(now);
        if cancelled {
            run.poisoned = true;
            self.outbox.invalidate_checkpoint(&run.reservation);
            if !run
                .terminal
                .as_ref()
                .is_some_and(|terminal| terminal.cancel)
            {
                run.logical = logical.into();
                run.continuation = ordinal;
                run.terminal = Some(Terminal {
                    id: event_id(root, logical, seq),
                    completed_at_ms: stamp.max(run.started_at_ms),
                    cancel: true,
                });
            }
            return self.persist(run);
        }
        let mut progress_candidate = None;
        if output {
            // A late patch can update an existing display row but cannot start another turn.
            if run.terminal.is_some() && data.get("patch").and_then(Value::as_bool) == Some(true) {
                return Ok(());
            }
            if run.terminal.is_some() || ordinal > run.continuation {
                self.outbox.invalidate_checkpoint(&run.reservation);
                run.progress = Default::default();
                run.started_at_ms = stamp.max(run.started_at_ms.saturating_add(1)).min(MAX_MS);
                run.terminal = None;
                run.summary.clear();
                run.summary_chars = 0;
                if let Some(session) = &run.session {
                    run.pending_start = Some(Pending {
                        id: format!("start-{}", event_id(root, logical, seq)),
                        engine: run.engine.clone(),
                        session_id: session.clone(),
                        workspace_path: run.workspace.clone(),
                        prompt: run.prompt.clone(),
                        summary: String::new(),
                        started_at_ms: run.started_at_ms,
                        completed_at_ms: run.started_at_ms,
                        generation: run.reservation.generation,
                        cancel: true,
                        started: true,
                    });
                }
            }
            run.logical = logical.into();
            run.continuation = ordinal;
            if kind == "thinking" || kind == "message" && matches!(role, Some("tool" | "thinking"))
            {
                if data.get("patch").and_then(Value::as_bool) != Some(true) {
                    progress_candidate = observer_progress::stable_candidate(&run.summary);
                }
                run.summary.clear();
                run.summary_chars = 0;
            } else if kind == "message" && role == Some("assistant") {
                if let Some(text) = data.get("text").and_then(Value::as_str) {
                    run.summary = bounded(text, SUMMARY_CHARS);
                    run.summary_chars = run.summary.chars().count();
                    if data.get("patch").and_then(Value::as_bool) != Some(true) {
                        progress_candidate = observer_progress::stable_candidate(&run.summary);
                    }
                }
            } else if kind == "delta" {
                if let Some(text) = data.as_str() {
                    for character in text.chars().take(SUMMARY_CHARS - run.summary_chars) {
                        run.summary.push(character);
                        run.summary_chars += 1;
                    }
                }
            }
        }
        if matches!(kind, "done" | "turn_complete") && run.terminal.is_none() {
            self.outbox.invalidate_checkpoint(&run.reservation);
            run.logical = logical.into();
            run.continuation = ordinal;
            run.terminal = Some(Terminal {
                id: event_id(root, logical, seq),
                completed_at_ms: stamp.max(run.started_at_ms),
                cancel: false,
            });
        }
        let persisted = self.persist(run);
        if persisted.is_ok() && run.terminal.is_none() {
            if let Some(summary) = progress_candidate {
                observer_progress::capture(&self.outbox, run, summary, now);
            }
        }
        persisted
    }

    pub fn finish_run(&self, run_id: &str) -> Result<(), String> {
        let mut runs = self.runs.lock();
        if let Some(run) = runs.get_mut(run_id) {
            self.outbox.invalidate_checkpoint(&run.reservation);
            if run.terminal.is_none() || run.killed.load(Ordering::SeqCst) || run.poisoned {
                if !run
                    .terminal
                    .as_ref()
                    .is_some_and(|terminal| terminal.cancel)
                {
                    let seq = run.last_seq.unwrap_or(0).saturating_add(1);
                    run.terminal = Some(Terminal {
                        id: event_id(run_id, &run.logical, seq),
                        completed_at_ms: (self.clock)().max(run.started_at_ms),
                        cancel: true,
                    });
                }
            }
            self.persist(run)?;
        }
        self.outbox.release(run_id)?;
        runs.remove(run_id);
        Ok(())
    }
}

static RECORDER: OnceLock<Arc<Recorder>> = OnceLock::new();
/// Tests and development profiles never inspect or open the production outbox.
pub fn init() -> Result<Option<Arc<Outbox>>, String> {
    #[cfg(test)]
    {
        Ok(None)
    }
    #[cfg(not(test))]
    {
        if crate::paths::is_dev_profile() {
            return Ok(None);
        }
        if let Some(recorder) = RECORDER.get() {
            return Ok(Some(recorder.outbox.clone()));
        }
        // Preserve the existing durable queue and reservations across the module move.
        let outbox = Outbox::open(crate::paths::app_home().join("spellcast-completions.sqlite"))?;
        let _ = RECORDER.set(Arc::new(Recorder::new(outbox)));
        Ok(RECORDER.get().map(|recorder| recorder.outbox.clone()))
    }
}
pub fn register_run(
    run_id: &str,
    engine: &str,
    workspace: &str,
    session: Option<&str>,
    prompt: &str,
    killed: &Arc<AtomicBool>,
) -> bool {
    RECORDER.get().is_some_and(|recorder| {
        recorder.register_run(run_id, engine, workspace, session, prompt, killed)
    })
}
pub fn adopt_session(run_id: &str, engine: &str, session: &str) -> bool {
    RECORDER
        .get()
        .is_some_and(|recorder| recorder.adopt_session(run_id, engine, session))
}
pub fn observe_event(event: &Value) -> Result<(), String> {
    RECORDER
        .get()
        .map_or(Ok(()), |recorder| recorder.observe_event(event))
}
pub fn finish_run(run_id: &str) -> Result<(), String> {
    RECORDER
        .get()
        .map_or(Ok(()), |recorder| recorder.finish_run(run_id))
}

#[cfg(test)]
#[path = "completion_outbox_tests.rs"]
mod tests;
