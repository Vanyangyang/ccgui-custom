//! Live engine child-process registry: session/run-id keyed entries,
//! interrupt routing, and teardown sweeps.

use super::reader::READER_SETTLE_GRACE;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::io::AsyncWriteExt;
use tokio::process::Child;
use tokio::sync::Mutex as TokioMutex;

// ==================== Process registry ====================

/// Live engine child processes keyed by session key (native session id once
/// known, otherwise the run id). Drop kills everything synchronously. Clone
/// is a refcount bump: the registry keys the same child under BOTH keys —
/// its run id and its session id (preassigned at spawn, or adopted via
/// `rekey`) — so either route can interrupt it.
#[derive(Clone)]
pub struct ChildEntry {
    /// The child process. `None` for virtual runs (host-stream engines): the
    /// entry then only routes interrupt to the transport task via `killed` /
    /// `reader_abort`, and `pid` is a synthetic identity token (see
    /// `next_virtual_pid`), never a real process id.
    pub child: Option<Arc<TokioMutex<Child>>>,
    pub pid: u32,
    /// The run id this entry started under; after a rekey the map key is the
    /// native session id, but the frontend may still cancel by run id.
    pub run_id: String,
    /// Set by `kill()`: a user-initiated stop is not an error — at EOF the
    /// runner commits the partial turn as done instead of pushing a bogus
    /// "exited with status …" error.
    pub killed: Arc<std::sync::atomic::AtomicBool>,
    /// Abort handle for this run's detached stdout-reader task, set by
    /// send_message right after spawn (a OnceLock so registry insertion
    /// still happens before the task starts). A child that closed stdout
    /// but refuses to die would park the reader on `wait()` forever,
    /// pinning the registry/EventSink/engine Arcs it owns: kill() aborts
    /// the reader after a settle grace, kill_all() aborts immediately.
    pub reader_abort: Arc<std::sync::OnceLock<tokio::task::AbortHandle>>,
    /// Interactive stdin kept open past the payload (`keep_stdin_open`):
    /// control responses (question answers) are written on it. Shared by the
    /// run-id and session-id entries; `None` for one-shot runs.
    pub stdin: Option<Arc<TokioMutex<Option<tokio::process::ChildStdin>>>>,
    /// Pending question requests (request_id -> full tool input) awaiting the
    /// user's answer; shared by both registry keys of the run.
    pub questions: Arc<Mutex<HashMap<String, Value>>>,
    /// 停住的计划审批原生回复上下文(plan_id -> {revision, context}):只存
    /// 后端,永不下发前端;由 respond_plan_review 按 planId+revision 消费,
    /// 运行结束时随进程一并过期(与 questions 同生命周期)。
    pub plans: Arc<Mutex<HashMap<String, Value>>>,
    /// Native task catalog and pending stop requests. Shared by run/session
    /// aliases; populated only for Claude runs by the event reader.
    pub(crate) native_tasks: Arc<super::native_task_control::NativeTaskControl>,
    /// Native Codex turn handle and pending steering acknowledgements. Only
    /// app-server runs populate this; aliases share the same control object.
    pub(crate) codex_control: Option<Arc<super::codex_control::CodexControl>>,
}

/// Why a frame did not land on a run's interactive stdin. Callers that can
/// fall back (a live follow-up that may become an ordinary send) need to tell
/// "nothing live can take it" from a genuine pipe failure without matching
/// message text; `Display` keeps the texts `write_line` always returned.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StdinWriteError {
    /// No run under the key, or the run never kept an interactive stdin.
    NoRun,
    /// stdin was already closed (final Done, EOF sent).
    Closed,
    /// The CLI hung up: the pipe's reader is gone (broken pipe). The run is
    /// dying, so this is "nothing live" for fallback purposes.
    PeerGone(String),
    /// Any other write failure.
    Io(String),
}

impl StdinWriteError {
    /// True when no live process can take the frame (as opposed to a real
    /// failure the user must be told about).
    pub(crate) fn is_unavailable(&self) -> bool {
        !matches!(self, Self::Io(_))
    }
}

impl std::fmt::Display for StdinWriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoRun => f.write_str("the session is no longer accepting input"),
            Self::Closed => f.write_str("the session's stdin is already closed"),
            Self::PeerGone(e) | Self::Io(e) => write!(f, "write to the session's stdin: {e}"),
        }
    }
}

impl ChildEntry {
    pub(crate) fn worker_proxy(run_id: &str, pid: u32) -> Self {
        Self {
            child: None, pid, run_id:run_id.into(),
            killed:Arc::new(std::sync::atomic::AtomicBool::new(false)),
            reader_abort:Arc::new(std::sync::OnceLock::new()), stdin:None,
            questions:Arc::new(Mutex::new(HashMap::new())), plans:Arc::new(Mutex::new(HashMap::new())),
            native_tasks:Default::default(), codex_control:None,
        }
    }
    /// Integration fixtures route synthetic runs without exposing private
    /// native-control state as a production construction API.
    #[cfg(feature = "test-harness")]
    pub fn test_route(run_id: &str, pid: u32) -> Self {
        Self {
            child: None,
            pid,
            run_id: run_id.into(),
            killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            reader_abort: Arc::new(std::sync::OnceLock::new()),
            stdin: None,
            questions: Arc::new(Mutex::new(HashMap::new())),
            plans: Arc::new(Mutex::new(HashMap::new())),
            native_tasks: Default::default(),
            codex_control: None,
        }
    }

    /// Write one NDJSON frame (`line` + `\n`) to this run's interactive
    /// stdin as a single, uninterruptible unit. The stdin mutex is held for
    /// the whole write, so concurrent frames (follow-up message, question
    /// answer, interrupt) can never interleave bytes. The write runs in its
    /// own task: a caller dropped mid-write (HTTP client gone) must not
    /// leave half a JSON line in the pipe, which would corrupt the NEXT
    /// frame the CLI parses.
    pub(crate) async fn write_frame(&self, line: &str) -> Result<(), StdinWriteError> {
        let stdin = self
            .stdin
            .as_ref()
            .map(Arc::clone)
            .ok_or(StdinWriteError::NoRun)?;
        let mut frame = Vec::with_capacity(line.len() + 1);
        frame.extend_from_slice(line.as_bytes());
        frame.push(b'\n');
        tokio::spawn(async move {
            let mut guard = stdin.lock().await;
            let handle = guard.as_mut().ok_or(StdinWriteError::Closed)?;
            // The flush matters: on Windows tokio hands the bytes to a
            // background blocking write and `write_all` returns Ok before the
            // OS accepted them, so a dead pipe only reports on the NEXT
            // operation. Without it a dead CLI looks like a delivered frame.
            let written = match handle.write_all(&frame).await {
                Ok(()) => handle.flush().await,
                Err(e) => Err(e),
            };
            written.map_err(|e| {
                if e.kind() == std::io::ErrorKind::BrokenPipe {
                    StdinWriteError::PeerGone(e.to_string())
                } else {
                    StdinWriteError::Io(e.to_string())
                }
            })
        })
        .await
        .map_err(|e| StdinWriteError::Io(format!("stdin writer task failed: {e}")))?
    }
}

#[derive(Default)]
pub struct ProcessRegistry(pub Mutex<HashMap<String, ChildEntry>>);
/// Count in-flight runs, not map entries: one run is keyed twice (run id +
/// session alias), so `map.len()` would halve the real concurrency limit.
/// Reservations (pid 0, pre-spawn) count too — a spawn storm must not slip
/// past the limit before the children register.
pub(crate) fn active_run_count(map: &HashMap<String, ChildEntry>) -> usize {
    map.values()
        .map(|entry| entry.run_id.as_str())
        .collect::<std::collections::HashSet<_>>()
        .len()
}

/// Two concurrent runs of one session must never evict each other's entries:
/// an evicted child leaks (no key routes an interrupt to it).
impl ProcessRegistry {
    pub(crate) fn active_run_count_from_map(&self, map:&HashMap<String, ChildEntry>) -> usize { active_run_count(map) }
    /// Clone the entry registered under `key` (run id or session id).
    pub(crate) fn get(&self, key: &str) -> Option<ChildEntry> {
        self.0.lock().ok().and_then(|map| map.get(key).cloned())
    }

    /// Presence, including pre-spawn reservations and virtual transports, is
    /// the host's run-lifetime authority. Silence and missing OS pids are not.
    pub(crate) fn active_run_ids(&self, run_ids: &[String]) -> Result<Vec<String>, String> {
        if run_ids.len() > 256 || run_ids.iter().any(|id| id.is_empty() || id.len() > 256) {
            return Err("Expected at most 256 bounded run IDs".into());
        }
        let map = self.0.lock().map_err(|_| "Process registry unavailable".to_string())?;
        Ok(run_ids.iter().filter(|id| {
            map.get(*id).is_some_and(|entry| entry.run_id == **id)
        }).cloned().collect())
    }

    /// Number of in-flight runs, ignoring the run-id/session-id alias
    /// duplication. The macOS quit guard asks this before letting Cmd+Q /
    /// AppleScript `quit` take the app down mid-turn.
    pub fn active_run_count(&self) -> usize {
        match self.0.lock() {
            Ok(map) => active_run_count(&map),
            Err(poisoned) => active_run_count(&poisoned.into_inner()),
        }
    }

    /// Write one NDJSON control line to a live run's interactive stdin.
    /// Err when the run is unknown, its stdin is already closed, or the
    /// pipe refuses the write — a swallowed failure would leave the CLI
    /// parked while the caller believes the answer landed.
    pub(crate) async fn write_line(&self, key: &str, line: String) -> Result<(), String> {
        self.write_frame(key, &line)
            .await
            .map_err(|e| e.to_string())
    }

    /// `write_line` with a typed failure (see `StdinWriteError`).
    pub(crate) async fn write_frame(&self, key: &str, line: &str) -> Result<(), StdinWriteError> {
        let entry = self.get(key).ok_or(StdinWriteError::NoRun)?;
        entry.write_frame(line).await
    }

    /// The entry under `key` when a live claude-style interactive frame
    /// (follow-up message, interrupt) can still be delivered to it: a real
    /// child process that is not being killed. Virtual runs (host-stream
    /// drivers keep their own protocol on the pipe) and a run the user
    /// already stopped yield `None` — the caller then falls back instead of
    /// writing into a dying or foreign pipe. Does not touch `killed`.
    pub(crate) fn get_live(&self, key: &str) -> Option<ChildEntry> {
        self.get(key).filter(|entry| {
            entry.child.is_some() && !entry.killed.load(std::sync::atomic::Ordering::SeqCst)
        })
    }

    /// Close a run's interactive stdin: the CLI treats EOF as the end of the
    /// session and exits once the current turn is done.
    pub(crate) fn close_stdin(&self, key: &str) {
        let Some(entry) = self.get(key) else { return; };
        entry.native_tasks.close();
        if let Some(control) = &entry.codex_control { control.close(); }
        let Some(stdin) = entry.stdin else {
            return;
        };
        tokio::spawn(async move {
            *stdin.lock().await = None;
        });
    }
    /// Hand a host-stream driver's interactive stdin to the registry. Those
    /// drivers spawn their own child (the entry has `child: None`), but an
    /// answer to a parked question still rides that child's stdin, so
    /// `write_line` has to find it. One run is keyed twice (run id + session
    /// alias) and the alias was cloned before the child existed: both copies
    /// get the same handle or answering by session id would miss.
    pub(crate) fn set_stdin(
        &self,
        key: &str,
        stdin: Arc<TokioMutex<Option<tokio::process::ChildStdin>>>,
    ) {
        if let Ok(mut map) = self.0.lock() {
            let Some(run_id) = map.get(key).map(|entry| entry.run_id.clone()) else {
                return;
            };
            for entry in map.values_mut().filter(|entry| entry.run_id == run_id) {
                entry.stdin = Some(Arc::clone(&stdin));
            }
        }
    }

    pub(crate) fn set_codex_control(&self, key: &str, control: Arc<super::codex_control::CodexControl>) {
        if let Ok(mut map) = self.0.lock() {
            let Some(run_id) = map.get(key).map(|entry| entry.run_id.clone()) else { return; };
            for entry in map.values_mut().filter(|entry| entry.run_id == run_id) {
                entry.codex_control = Some(Arc::clone(&control));
            }
        }
    }

    /// Drain and return the request ids of a run's pending questions.
    pub(crate) fn take_questions(&self, key: &str) -> Vec<String> {
        let Some(entry) = self.get(key) else {
            return Vec::new();
        };
        let Ok(mut questions) = entry.questions.lock() else {
            return Vec::new();
        };
        let ids: Vec<String> = questions.keys().cloned().collect();
        questions.clear();
        ids
    }
    /// Drain and return a run's parked plan-review contexts as
    /// (plan_id, revision, context): the native request dies with the run, so
    /// the settle path expires every record still open for approval.
    pub(crate) fn take_plans(&self, key: &str) -> Vec<(String, i64, Value)> {
        let Some(entry) = self.get(key) else {
            return Vec::new();
        };
        let Ok(mut plans) = entry.plans.lock() else {
            return Vec::new();
        };
        plans
            .drain()
            .map(|(plan_id, context)| {
                let revision = context
                    .get("revision")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                (plan_id, revision, context)
            })
            .collect()
    }

    pub(crate) fn insert(&self, key: String, entry: ChildEntry) {
        if let Ok(mut map) = self.0.lock() {
            map.insert(key, entry);
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.0.lock().map(|map| map.len()).unwrap_or(0)
    }

    /// Register a second lookup key for the same live child without
    /// replacing an unrelated concurrent run. A resumed session is keyed
    /// here at spawn: its id is preassigned, so the engine's own session
    /// announcement equals it and never triggers a rekey.
    pub(crate) fn insert_alias(&self, key: String, entry: ChildEntry) {
        if let Ok(mut map) = self.0.lock() {
            if !map.contains_key(&key) {
                map.insert(key, entry);
            }
        }
    }

    /// Copy the entry to the native-session key once known. The run_id key
    /// STAYS: the frontend interrupts by session id and by run id (a resume
    /// whose session-id announcement never arrives leaves run id as the only
    /// route), and a moving rekey closed exactly that path — the user hit
    /// Stop, the by-run-id lookup found nothing, and the CLI kept streaming.
    /// `kill` de-duplicates by pid: hitting both keys kills the tree once.
    /// A colliding target key belongs to another live run — never overwrite,
    /// and report it: the caller must not claim an identity it does not own.
    pub(crate) fn rekey(&self, from: &str, to: String) -> Result<(), String> {
        if from == to {
            return Ok(());
        }
        let mut map = self
            .0
            .lock()
            .map_err(|_| "process registry is unavailable".to_string())?;
        // A run whose entries were already drained has no alias left to claim.
        let Some(entry) = map.get(from).cloned() else {
            return Ok(());
        };
        match map.get(&to) {
            // The same child already keyed there (a preassigned resume alias).
            Some(existing) if existing.run_id == entry.run_id && existing.pid == entry.pid => Ok(()),
            Some(existing) if !existing.killed.load(std::sync::atomic::Ordering::SeqCst) => {
                Err("Engine announced a native session owned by another live run".into())
            }
            _ => {
                map.insert(to, entry);
                Ok(())
            }
        }
    }

    /// Drop a pre-spawn run-id reservation after a failed launch. Only the
    /// placeholder (no child, pid 0) is removed — a registered run, real or
    /// virtual, is never touched.
    pub(crate) fn remove_reservation(&self, key: &str) {
        if let Ok(mut map) = self.0.lock() {
            let reserved = map
                .get(key)
                .map(|entry| entry.child.is_none() && entry.pid == 0)
                .unwrap_or(false);
            if reserved {
                map.remove(key);
            }
        }
    }

    /// Remove only if the entry is still the same child (pid match): a run
    /// that lost its session key to nothing must not evict another run's
    /// entry that now lives under that key.
    pub(crate) fn remove_if_pid(&self, key: &str, pid: u32) {
        if let Ok(mut map) = self.0.lock() {
            if map.get(key).map(|entry| entry.pid) == Some(pid) {
                if let Some(entry) = map.remove(key) {
                    entry.native_tasks.close();
                    if let Some(control) = &entry.codex_control { control.close(); }
                }
            }
        }
    }
    /// Backstop for the abort path in `kill`: an aborted reader never
    /// reaches its `remove_if_pid` calls, so its entries would pin a run
    /// slot forever (no sweeper walks dead pids). Drop every entry still
    /// owned by this run here. Run id AND pid must both match — a client
    /// retry that reused the run id, or an OS-recycled pid, must not evict
    /// the live successor.
    pub(crate) fn remove_run_if_pid(&self, run_id: &str, pid: u32) {
        if let Ok(mut map) = self.0.lock() {
            map.retain(|_, entry| {
                let keep = entry.run_id != run_id || entry.pid != pid;
                if !keep {
                    entry.native_tasks.close();
                    if let Some(control) = &entry.codex_control { control.close(); }
                }
                keep
            });
        }
    }

    /// Kill one entry (pid-reuse guarded). Returns false when the child was
    /// already reaped — nothing left to signal. Virtual runs (no child) only
    /// raise the killed flag: the transport task observes it on its next
    /// loop tick, cancels the host-side turn, and settles the turn itself.
    fn kill_entry(
        child: Option<&Arc<TokioMutex<tokio::process::Child>>>,
        pid: u32,
        killed: &Arc<std::sync::atomic::AtomicBool>,
    ) -> bool {
        killed.store(true, std::sync::atomic::Ordering::SeqCst);
        let Some(child) = child else {
            return true;
        };
        if let Ok(mut guard) = child.try_lock() {
            // Pid-reuse guard: a reaped child's pid may already belong to
            // someone else — never signal a group we no longer own.
            match guard.try_wait() {
                Ok(Some(_)) => false,
                _ => {
                    kill_process_group(pid);
                    let _ = guard.start_kill();
                    true
                }
            }
        } else {
            // The runner holds the lock only while reaping post-EOF; that
            // window is tiny and the kill flag already settles the turn.
            kill_process_group(pid);
            true
        }
    }

    /// Kill **every** entry matching `key`: the map key (native session id or
    /// run id) and the recorded run id both match. One session resumed into
    /// several parallel runs must all die on a single stop, or the survivors
    /// keep streaming and fight the next run over the session file.
    pub fn kill(self: &Arc<Self>, key: &str) -> bool {
        let mut entries: Vec<(
            u32,
            String,
            Option<Arc<TokioMutex<tokio::process::Child>>>,
            Arc<std::sync::atomic::AtomicBool>,
            Arc<std::sync::OnceLock<tokio::task::AbortHandle>>,
        )> = match self.0.lock() {
            Ok(map) => {
                let mut seen_pids = std::collections::HashSet::new();
                map.iter()
                    .filter(|(k, e)| *k == key || e.run_id == key)
                    .filter(|(_, e)| seen_pids.insert(e.pid))
                    .map(|(_, e)| {
                        e.native_tasks.close();
                        if let Some(control) = &e.codex_control { control.close(); }
                        (
                            e.pid,
                            e.run_id.clone(),
                            e.child.clone(),
                            Arc::clone(&e.killed),
                            Arc::clone(&e.reader_abort),
                        )
                    })
                    .collect()
            }
            Err(_) => Vec::new(),
        };
        // The registry keys one child under BOTH its session id and run id
        // (rekey copies): de-duplicate by pid so one stop fires one
        // taskkill, not one per key.
        entries.sort_by_key(|(pid, _, _, _, _)| *pid);
        entries.dedup_by_key(|(pid, _, _, _, _)| *pid);
        // No Iterator::any here: it short-circuits on the first true, which
        // would leave every later parallel run alive — the exact bug this
        // aggregate kill exists to fix.
        let mut killed_any = false;
        for (pid, _, child, killed, _) in &entries {
            killed_any |= Self::kill_entry(child.as_ref(), *pid, killed);
        }
        // Backstop for a child that ignores SIGKILL (uninterruptible
        // sleep): its reader parks on wait() after EOF, pinning the Arcs it
        // owns. Abort it after a grace long enough for a healthy settle
        // (kill → EOF → wait → terminal event, milliseconds in practice) —
        // on an already-finished task abort is a no-op, so normal stop
        // semantics are unchanged. kill() only runs inside a runtime
        // (spawn_blocking callers), so tokio::spawn is safe here.
        for (pid, run_id, _, _, reader_abort) in &entries {
            if let Some(handle) = reader_abort.get() {
                let handle = handle.clone();
                // The abort skips the reader's own remove_if_pid cleanup:
                // drain the run's entries here or its slots stay pinned
                // until app exit. On a healthy settle this is a no-op.
                let registry = Arc::clone(self);
                let run_id = run_id.clone();
                let pid = *pid;
                tokio::spawn(async move {
                    tokio::time::sleep(READER_SETTLE_GRACE).await;
                    handle.abort();
                    registry.remove_run_if_pid(&run_id, pid);
                });
            }
        }
        killed_any
    }

    pub fn kill_all(&self) {
        // Blocking lock on the teardown path: skipping children because the
        // lock was briefly contended would leak engine processes.
        let mut entries: Vec<ChildEntry> = match self.0.lock() {
            Ok(mut map) => map.drain().map(|(_, e)| e).collect(),
            Err(poisoned) => poisoned.into_inner().drain().map(|(_, e)| e).collect(),
        };
        // rekey keys one child under BOTH its session id and run id:
        // de-duplicate by pid or the sweep signals the same process group
        // twice (a second, doomed taskkill on Windows).
        entries.sort_by_key(|e| e.pid);
        entries.dedup_by_key(|e| e.pid);
        for entry in entries {
            entry.native_tasks.close();
            if let Some(control) = &entry.codex_control { control.close(); }
            // Virtual runs own no process group; their task aborts below/via
            // the abort handle.
            if let Some(child) = entry.child.as_ref() {
                kill_process_group(entry.pid);
                if let Ok(mut guard) = child.try_lock() {
                    let _ = guard.start_kill();
                }
            }
            // Teardown: abort the reader outright so it drops its
            // registry/sink Arcs now instead of parking on wait() past
            // exit. Settle events would go nowhere anyway (the window is
            // being destroyed).
            if let Some(handle) = entry.reader_abort.get() {
                handle.abort();
            }
        }
    }
}

impl Drop for ProcessRegistry {
    fn drop(&mut self) {
        // &mut self makes locking unnecessary; poisoning must not skip the
        // kill sweep either (a panicked run leaves live children).
        let map = self.0.get_mut().unwrap_or_else(|e| e.into_inner());
        let mut entries: Vec<ChildEntry> = map.drain().map(|(_, e)| e).collect();
        // Same double-keying as kill_all: signal each process group once.
        entries.sort_by_key(|e| e.pid);
        entries.dedup_by_key(|e| e.pid);
        for entry in entries {
            entry.native_tasks.close();
            if let Some(control) = &entry.codex_control { control.close(); }
            // Virtual runs own no process group; their task aborts below/via
            // the abort handle.
            if let Some(child) = entry.child.as_ref() {
                kill_process_group(entry.pid);
                if let Ok(mut guard) = child.try_lock() {
                    let _ = guard.start_kill();
                }
            }
        }
    }
}

/// SIGKILL the child's whole process group (spawn used `process_group(0)`,
/// so pgid == pid). Grandchildren holding the stdout pipe die too, which is
/// what lets the reader task observe EOF and drain the registry.
#[cfg(unix)]
pub(crate) fn kill_process_group(pid: u32) {
    // SAFETY: kill with a negated pgid signals the group; no memory touched.
    unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
}

/// Windows has no process groups; npm CLIs spawn as `cmd /c x.cmd`, so the
/// real CLI (node/bun) is a grandchild. `taskkill /T /F` walks the tree from
/// the wrapper down.
///
/// This MUST complete before the caller terminates the direct child. It used
/// to be fire-and-forget, and `kill_entry`'s `start_kill()` killed the
/// wrapper first: by the time taskkill ran, its target pid was gone, the
/// tree walk found nothing, and the real CLI kept streaming as an orphan
/// (dangling ppid) long after the user pressed Stop. Waiting here is what
/// makes the stop button actually stop the engine.
#[cfg(not(unix))]
pub(crate) fn kill_process_group(pid: u32) {
    let mut command = std::process::Command::new("taskkill");
    command
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let Ok(mut killer) = command.spawn() else {
        return;
    };
    // Bounded: app teardown sweeps every child, and a wedged taskkill must
    // not hang the exit path. Normal completion is tens of milliseconds.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        match killer.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
    }
}

/// Synthetic registry identity for virtual (host-stream) runs: they own no
/// process, but the registry's dedup/remove paths are pid-keyed, so each run
/// gets a unique token well above any real pid. Never passed to an OS call.
pub(crate) fn next_virtual_pid() -> u32 {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(u32::MAX / 2);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

#[cfg(test)]
mod registry_tests {
    use super::*;

    /// rekey must COPY (not move) so both the session-id and run-id keys
    /// route an interrupt to the same process. A resume whose
    /// thread.started never arrives leaves run id as the only route — a
    /// moving rekey leaked the child (user pressed Stop, nothing died).
    #[tokio::test]
    async fn rekey_keeps_both_keys_and_kill_routes_by_either() {
        let child = tokio::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" })
            .args(if cfg!(windows) {
                ["/c", "ping -n 30 127.0.0.1"]
            } else {
                ["-c", "sleep 30"]
            })
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn sleep child");
        let pid = child.id().unwrap_or(0);
        let entry = ChildEntry {
            child: Some(Arc::new(TokioMutex::new(child))),
            pid,
            run_id: "run-1".to_string(),
            killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            reader_abort: Arc::new(std::sync::OnceLock::new()),
            stdin: None,
            questions: Arc::new(Mutex::new(HashMap::new())),
            plans: Arc::new(Mutex::new(HashMap::new())),
            native_tasks: Default::default(),
            codex_control: None,
        };
        let registry = Arc::new(ProcessRegistry::default());
        registry.insert("run-1".to_string(), entry);

        // Simulate the engine adopting the native session id mid-run.
        registry.rekey("run-1", "session-9".to_string()).unwrap();

        // Both keys route to the same pid; killing by the RUN id (the
        // fallback route when the session announcement never arrived) must
        // still find it, and the session key must survive the by-run-id
        // kill so a second stop also lands (idempotent, pid-deduped).
        assert!(registry.kill("run-1"));
        // kill does not drain: both keys still map to the (now dying)
        // child, so a second stop via the session id still lands on the
        // same entry. Its boolean result is racy (the child may already be
        // reaped, in which case kill_entry reports false on a SUCCESSFUL
        // interrupt), so assert the routing — not the return value.
        assert_eq!(registry.len(), 2);
        let _ = registry.kill("session-9");

        // The registry drains the entry from both keys on exit.
        registry.remove_if_pid("session-9", pid);
        registry.remove_if_pid("run-1", pid);
        assert_eq!(registry.len(), 0);
    }

    fn virtual_entry(run_id: &str, pid: u32) -> ChildEntry {
        ChildEntry {
            child: None,
            pid,
            run_id: run_id.to_string(),
            killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            reader_abort: Arc::new(std::sync::OnceLock::new()),
            stdin: None,
            questions: Arc::new(Mutex::new(HashMap::new())),
            plans: Arc::new(Mutex::new(HashMap::new())),
            native_tasks: Default::default(),
            codex_control: None,
        }
    }

    /// A colliding session key belongs to another live run. The claim fails
    /// visibly and leaves that run's route intact; the run's own alias (or a
    /// drained run) is not a collision.
    #[test]
    fn rekey_reports_a_collision_without_touching_the_owner() {
        let registry = ProcessRegistry::default();
        registry.insert("owner-run".into(), virtual_entry("owner-run", 7));
        registry.insert_alias("shared-session".into(), virtual_entry("owner-run", 7));
        registry.insert("late-run".into(), virtual_entry("late-run", 8));
        assert!(registry.rekey("late-run", "shared-session".into()).is_err());
        assert_eq!(registry.get("shared-session").unwrap().run_id, "owner-run");
        assert!(registry.rekey("owner-run", "shared-session".into()).is_ok());
        assert!(registry.rekey("late-run", "late-session".into()).is_ok());
        assert_eq!(registry.get("late-session").unwrap().run_id, "late-run");
        assert!(registry.rekey("drained-run", "other-session".into()).is_ok());
        assert!(registry.get("other-session").is_none());
    }

    /// A resumed session is registered under its preassigned id at spawn:
    /// the engine's own announcement of that same id equals it, so
    /// adopt_session_id early-returns and never rekeys. Without the alias a
    /// by-session-id Stop found nothing.
    #[tokio::test]
    async fn preassigned_session_alias_routes_stop_before_session_event() {
        let child = tokio::process::Command::new(if cfg!(windows) { "cmd" } else { "sh" })
            .args(if cfg!(windows) {
                ["/c", "ping -n 30 127.0.0.1"]
            } else {
                ["-c", "sleep 30"]
            })
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn sleep child");
        let pid = child.id().unwrap_or(0);
        let entry = ChildEntry {
            child: Some(Arc::new(TokioMutex::new(child))),
            pid,
            run_id: "run-preassigned".to_string(),
            killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            reader_abort: Arc::new(std::sync::OnceLock::new()),
            stdin: None,
            questions: Arc::new(Mutex::new(HashMap::new())),
            plans: Arc::new(Mutex::new(HashMap::new())),
            native_tasks: Default::default(),
            codex_control: None,
        };
        let registry = Arc::new(ProcessRegistry::default());
        registry.insert("run-preassigned".to_string(), entry.clone());
        registry.insert_alias("session-preassigned".to_string(), entry);

        assert!(registry.kill("session-preassigned"));
        registry.remove_if_pid("session-preassigned", pid);
        registry.remove_if_pid("run-preassigned", pid);
        assert_eq!(registry.len(), 0);
    }

    /// The real Windows stop bug: engine CLIs run as `cmd /c shim.cmd` and
    /// the model process is a grandchild. Killing must take the WHOLE tree
    /// down synchronously — a fire-and-forget taskkill that raced the direct
    /// child's start_kill orphaned the grandchild (it kept streaming and
    /// burning tokens after the user pressed Stop). This spawns a cmd whose
    /// grandchild outlives it and asserts the grandchild is gone after kill.
    #[cfg(windows)]
    #[tokio::test]
    async fn kill_reaps_windows_grandchild_process_tree() {
        use std::collections::HashSet;
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

        let child = tokio::process::Command::new("cmd")
            .args(["/c", "ping -n 60 127.0.0.1 > NUL"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn cmd child");
        let cmd_pid = child.id().unwrap_or(0);

        // Let cmd spawn its ping grandchild.
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        let mut sys = System::new();
        sys.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing(),
        );
        let grandchildren: Vec<Pid> = sys
            .processes()
            .iter()
            .filter(|(_, p)| p.parent() == Some(Pid::from_u32(cmd_pid)))
            .map(|(pid, _)| *pid)
            .collect();
        assert!(
            !grandchildren.is_empty(),
            "expected cmd to have spawned a ping grandchild"
        );

        let entry = ChildEntry {
            child: Some(Arc::new(TokioMutex::new(child))),
            pid: cmd_pid,
            run_id: "run-tree".to_string(),
            killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            reader_abort: Arc::new(std::sync::OnceLock::new()),
            stdin: None,
            questions: Arc::new(Mutex::new(HashMap::new())),
            plans: Arc::new(Mutex::new(HashMap::new())),
            native_tasks: Default::default(),
            codex_control: None,
        };
        let registry = Arc::new(ProcessRegistry::default());
        registry.insert("run-tree".to_string(), entry);
        assert!(registry.kill("run-tree"));

        // Poll: process teardown is observable only after the kernel reaps.
        let targets: HashSet<Pid> = grandchildren
            .iter()
            .copied()
            .chain(std::iter::once(Pid::from_u32(cmd_pid)))
            .collect();
        let mut alive = targets.clone();
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            sys.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing(),
            );
            alive.retain(|pid| sys.process(*pid).is_some());
            if alive.is_empty() {
                break;
            }
        }
        assert!(
            alive.is_empty(),
            "stop left process-tree survivors alive: {alive:?}"
        );
    }
    fn stub_entry(run_id: &str, pid: u32) -> ChildEntry {
        ChildEntry {
            child: None,
            pid,
            run_id: run_id.to_string(),
            killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            reader_abort: Arc::new(std::sync::OnceLock::new()),
            stdin: None,
            questions: Arc::new(Mutex::new(HashMap::new())),
            plans: Arc::new(Mutex::new(HashMap::new())),
            native_tasks: Default::default(),
            codex_control: None,
        }
    }

    #[test]
    fn active_run_ids_include_virtual_and_reserved_runs_but_not_aliases() {
        let registry = ProcessRegistry::default();
        registry.insert("virtual".into(), stub_entry("virtual", 101));
        registry.insert_alias("session".into(), stub_entry("virtual", 101));
        registry.insert("reserved".into(), stub_entry("reserved", 0));
        let ids = ["virtual", "session", "reserved", "missing"].map(str::to_string);
        assert_eq!(registry.active_run_ids(&ids).unwrap(), vec!["virtual", "reserved"]);
        registry.remove_run_if_pid("virtual", 101);
        assert_eq!(registry.active_run_ids(&ids).unwrap(), vec!["reserved"]);
        assert!(registry.active_run_ids(&vec!["run".into(); 257]).is_err());
        assert!(registry.active_run_ids(&[String::new()]).is_err());
    }

    #[test]
    fn active_run_ids_registry_failure_is_not_reported_as_no_active_runs() {
        let registry = Arc::new(ProcessRegistry::default());
        let poison = Arc::clone(&registry);
        let _ = std::thread::spawn(move || {
            let _guard = poison.0.lock().unwrap();
            panic!("poison fixture");
        }).join();
        assert!(registry.active_run_ids(&["run".into()]).is_err());
    }

    /// The concurrency limit counts RUNS, not map entries: a run keyed
    /// under both its run id and its session alias is one run — an entry
    /// count halved the real ceiling (16 felt like 8).
    #[test]
    fn active_run_count_dedupes_session_alias_keys() {
        let registry = ProcessRegistry::default();
        registry.insert("run-1".to_string(), stub_entry("run-1", 101));
        registry.insert_alias("session-1".to_string(), stub_entry("run-1", 101));
        registry.insert("run-2".to_string(), stub_entry("run-2", 102));
        // A pre-spawn reservation (pid 0) is an in-flight run too.
        registry.insert("run-3".to_string(), stub_entry("run-3", 0));
        let map = registry.0.lock().expect("lock registry");
        assert_eq!(map.len(), 4);
        assert_eq!(active_run_count(&map), 3);
    }

    /// The kill() abort backstop skips the reader's remove_if_pid cleanup;
    /// remove_run_if_pid must drain BOTH keys of the run so its slots do
    /// not stay pinned until app exit.
    #[test]
    fn remove_run_if_pid_drains_every_key_of_the_run() {
        let registry = ProcessRegistry::default();
        registry.insert("run-1".to_string(), stub_entry("run-1", 101));
        registry.insert_alias("session-1".to_string(), stub_entry("run-1", 101));
        registry.insert("run-2".to_string(), stub_entry("run-2", 102));
        registry.remove_run_if_pid("run-1", 101);
        assert!(registry.get("run-1").is_none());
        assert!(registry.get("session-1").is_none());
        assert!(registry.get("run-2").is_some());
    }

    /// A client retry that reused the run id registers a NEW child with a
    /// different pid; the backstop for the old run must not evict it (same
    /// guard class as remove_if_pid's pid match).
    #[test]
    fn remove_run_if_pid_spares_same_id_successor() {
        let registry = ProcessRegistry::default();
        registry.insert("run-1".to_string(), stub_entry("run-1", 101));
        registry.remove_run_if_pid("run-1", 999);
        assert!(registry.get("run-1").is_some());
    }
}
