//! Resident native ACP (`agy acp --stdio`) pool and loopback broker for
//! Antigravity personal subscription turns.
//!
//! Why both an in-process pool and a loopback broker exist:
//! - Main local GUI chats run inside ephemeral per-turn `--task-worker` child
//!   processes (`worker_host::start`). A daemon owned only by a `task-worker`
//!   would exit at the end of every turn, losing the ~5s warm-process win.
//! - Hosting the warm `AgyAcpState` pool in an independent broker service and
//!   exposing an authenticated `127.0.0.1` loopback bridge (`agy-acp-service.json`)
//!   lets every `task-worker` turn AND in-process `/btw` Sidechat turn share
//!   warm `agy acp --stdio` workers (`~40-320ms` turn setup) without altering
//!   the `task-worker` wire contract (`SCHEMA_CONTRACT_V4_HASH`).
//! - Each checked-out worker is leased exclusively for one turn with its own
//!   private `slot_dir` (`AGENTS.md` + `host-chat.json`), preserving strict
//!   per-run `CCGUI_HOST_CHAT_TOKEN` isolation and fresh host rules.
//! - Desktop generations only hold a service lease. Replacing the GUI neither
//!   closes ACP pipes nor drops the jobs that own active ACP process trees.

#[path = "agy_acp_driver.rs"]
mod driver;
#[path = "agy_acp_context.rs"]
mod context;
#[path = "agy_acp_support.rs"]
mod support;
#[path = "agy_acp_outcome.rs"]
mod outcome;
#[path = "agy_acp_service.rs"]
pub(crate) mod service;
#[cfg(test)]
#[path = "agy_acp_tests.rs"]
mod tests;

pub(super) use driver::run_acp_turn;
pub(crate) use support::{
    answer_frame, is_internal_wakeup_prompt, send_run_frame, AGY_BG_TASK_WAKEUP_PROMPT,
};

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, ChildStdin, ChildStdout};

use super::agy::{configure_background_command, HOST_PLUGIN};
use super::qoder_session::{
    encode_ndjson, jsonrpc_request, parse_acp_line, AcpLine, RPC_HANDSHAKE_TIMEOUT,
};
use super::{command_for_binary, hide_console, kill_process_group, LineRead, MAX_LINE_BYTES};

const MAX_IDLE_WORKERS: usize = 3;
const BROKER_PROTOCOL: u32 = 2;
// Keep independent ownership separate from older desktop-owned brokers. A
// rollback to an old GUI must not overwrite or remove this service's manifest.
const BROKER_FILE_REL: &str = "runtime/agy-acp-service.json";
const SLOTS_DIR_NAME: &str = "agy-acp-slots";
const LEASE_DONE_SENTINEL: &str = "__ccgui_agy_lease_done";
const LEASE_RELEASED_ACK: &str = "__ccgui_agy_lease_released";
const POST_KILL_WAIT: Duration = Duration::from_millis(300);
const MAX_AUTH_START_ATTEMPTS: u32 = 2;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkerProfileKey {
    pub bin: String,
    #[serde(default)]
    pub workspace: String,
    pub has_host_chat: bool,
    pub self_update_only: bool,
    pub allows_self_update: bool,
    pub leader_child: bool,
    pub completion_owner: bool,
    pub env_pairs: Vec<(String, String)>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HostChatEndpoint {
    pub command: String,
    pub args: Vec<String>,
    pub url: String,
    pub token: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrokerManifest {
    protocol: u32,
    profile: PathBuf,
    pid: u32,
    process_start_time: u64,
    executable: PathBuf,
    port: u16,
    token: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckoutRequest {
    token: String,
    profile: WorkerProfileKey,
    host_instructions: String,
    host_chat: Option<HostChatEndpoint>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckoutResponse {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    slot_plugin_root: Option<String>,
    #[serde(default)]
    mcp_servers: Vec<Value>,
    #[serde(default)]
    cold_start_ms: f64,
    // Older broker owners do not advertise this optimization.
    #[serde(default)]
    supports_session_resume: bool,
}

pub(super) struct AcpWorker {
    profile: WorkerProfileKey,
    // Captured by the process owner before launch; never sent over the broker.
    auth_fingerprint: Option<String>,
    slot_dir: PathBuf,
    slot_plugin_root: PathBuf,
    token_file: PathBuf,
    mcp_exec: Option<(String, Vec<String>)>,
    pub(super) child: Child,
    pub(super) stdin: ChildStdin,
    pub(super) reader: BufReader<ChildStdout>,
    pub(super) line_buf: Vec<u8>,
    pub(super) next_id: u64,
    pub(super) stderr_buf: Arc<Mutex<String>>,
    pub(super) supports_session_resume: bool,
    #[cfg(windows)]
    _tree_guard: Option<Arc<super::job::KillOnCloseJob>>,
}

struct BrokerRuntime {
    manifest_path: PathBuf,
    token: String,
    accept_task: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
struct PoolInner {
    shutting_down: bool,
    idle: Vec<AcpWorker>,
    broker: Option<BrokerRuntime>,
    desktop_lease: Option<TcpStream>,
}

pub struct AgyAcpState {
    inner: Mutex<PoolInner>,
    active_turns: Arc<AtomicUsize>,
    host_leases: Arc<AtomicUsize>,
    is_broker_host: AtomicBool,
    custom_root: Option<PathBuf>,
    auth_fingerprint_reader: Arc<dyn Fn(&WorkerProfileKey) -> Option<String> + Send + Sync>,
}

impl Default for AgyAcpState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(PoolInner::default()),
            active_turns: Arc::new(AtomicUsize::new(0)),
            host_leases: Arc::new(AtomicUsize::new(0)),
            is_broker_host: AtomicBool::new(false),
            custom_root: None,
            auth_fingerprint_reader: Arc::new(native_worker_auth_fingerprint),
        }
    }
}

pub(super) struct ActiveTurnCounter(Arc<AtomicUsize>);

impl ActiveTurnCounter {
    fn acquire(counter: &Arc<AtomicUsize>) -> Self {
        counter.fetch_add(1, Ordering::SeqCst);
        Self(Arc::clone(counter))
    }
}

impl Drop for ActiveTurnCounter {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl AgyAcpState {
    #[cfg(test)]
    pub(super) fn with_root(root: PathBuf) -> Self {
        Self {
            inner: Mutex::new(PoolInner::default()),
            active_turns: Arc::new(AtomicUsize::new(0)),
            host_leases: Arc::new(AtomicUsize::new(0)),
            is_broker_host: AtomicBool::new(false),
            custom_root: Some(root),
            // Isolated ACP fixtures must never inspect the real user's login.
            auth_fingerprint_reader: Arc::new(|_| Some("fixture-auth".into())),
        }
    }

    fn base_home(&self) -> PathBuf {
        self.custom_root
            .clone()
            .unwrap_or_else(crate::paths::app_home)
    }

    fn slots_parent(&self) -> PathBuf {
        self.base_home().join(SLOTS_DIR_NAME)
    }

    pub fn has_active_turns(&self) -> bool {
        self.active_turns.load(Ordering::SeqCst) > 0
    }

    fn acquire_use(&self, counter: &Arc<AtomicUsize>) -> Result<ActiveTurnCounter, String> {
        let pool = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if pool.shutting_down { return Err("AGY ACP service is shutting down".into()); }
        Ok(ActiveTurnCounter::acquire(counter))
    }

    /// Start the authenticated loopback listener in its independent service so
    /// per-turn `--task-worker` processes share warm `agy acp` workers.
    /// Does not spawn `agy` eagerly; workers start on the first AGY turn.
    async fn start_broker(self: &Arc<Self>) -> Result<u16, String> {
        let base = self.base_home();
        std::fs::create_dir_all(&base)
            .map_err(|e| format!("create agy broker profile dir: {e}"))?;
        let profile = dunce::canonicalize(&base)
            .map_err(|e| format!("canonicalize agy broker profile: {e}"))?;
        let runtime_dir = profile.join("runtime");
        crate::task_worker::private_directory(&runtime_dir).map_err(|e| e.message)?;

        let pid = std::process::id();
        let (executable, process_start_time) =
            crate::task_worker::process_identity(pid).map_err(|e| e.message)?;
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| format!("bind agy acp broker: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("agy acp broker local_addr: {e}"))?
            .port();
        let token = format!(
            "{:032x}{:032x}",
            uuid::Uuid::new_v4().as_u128(),
            uuid::Uuid::new_v4().as_u128()
        );
        let manifest = BrokerManifest {
            protocol: BROKER_PROTOCOL,
            profile: profile.clone(),
            pid,
            process_start_time,
            executable,
            port,
            token: token.clone(),
        };
        let manifest_path = profile.join(BROKER_FILE_REL);
        let pending_path = manifest_path.with_extension(format!("{}.pending", uuid::Uuid::new_v4()));
        let bytes = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
        let mut file =
            crate::task_worker::private_file(&pending_path).map_err(|e| e.message)?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("write agy broker manifest: {e}"))?;
        drop(file);
        std::fs::rename(&pending_path, &manifest_path)
            .map_err(|e| format!("publish agy broker manifest: {e}"))?;

        let state = Arc::clone(self);
        let listener_token = token.clone();
        let accept_task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let _ = stream.set_nodelay(true);
                let peer_state = Arc::clone(&state);
                let expected_token = listener_token.clone();
                tokio::spawn(async move {
                    handle_broker_client(peer_state, stream, expected_token).await;
                });
            }
        });

        let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(old) = guard.broker.replace(BrokerRuntime {
            manifest_path,
            token,
            accept_task,
        }) {
            old.accept_task.abort();
            remove_owned_broker_manifest(&old);
        }
        self.is_broker_host.store(true, Ordering::SeqCst);
        Ok(port)
    }

    pub fn kill_spawned(&self) {
        let (broker, workers, desktop_lease) = {
            let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            guard.shutting_down = true;
            self.is_broker_host.store(false, Ordering::SeqCst);
            (guard.broker.take(), std::mem::take(&mut guard.idle), guard.desktop_lease.take())
        };
        // An independent broker owns its own pipes and jobs. Releasing the
        // desktop lease leaves active turns and the next GUI's lease intact.
        drop(desktop_lease);
        if let Some(broker) = broker {
            broker.accept_task.abort();
            remove_owned_broker_manifest(&broker);
        }
        for mut worker in workers {
            kill_worker_sync(&mut worker);
        }
    }

    pub(super) async fn checkout_local(
        &self,
        profile: &WorkerProfileKey,
        host_instructions: &str,
        host_chat: Option<&HostChatEndpoint>,
    ) -> Result<(AcpWorker, ActiveTurnCounter, String, Vec<Value>, f64), String> {
        let active_guard = self.acquire_use(&self.active_turns)?;
        let checkout_started = Instant::now();
        let mut started_process = false;
        for _ in 0..MAX_AUTH_START_ATTEMPTS {
            let auth_fingerprint = (self.auth_fingerprint_reader)(profile);
            let popped = {
                let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
                if guard.shutting_down {
                    return Err("AGY ACP service is shutting down".into());
                }
                pop_matching_idle(&mut guard.idle, profile, host_chat, auth_fingerprint.as_deref())
            };
            let mut worker = match popped {
                Some(worker) => worker,
                None => {
                    started_process = true;
                    spawn_and_initialize_worker(
                        &self.slots_parent(), profile, host_chat, auth_fingerprint.clone(),
                    ).await?
                }
            };
            if let Err(err) = prepare_worker_slot(&mut worker, host_instructions, host_chat) {
                teardown_worker(&mut worker).await;
                return Err(err);
            }
            // Authentication may change while initialize is in flight. Retry
            // only before handing off the process, never replay a user prompt.
            // This also covers login/logout (None <-> Some).
            if (self.auth_fingerprint_reader)(profile) != auth_fingerprint {
                teardown_worker(&mut worker).await;
                continue;
            }
            let mcp_servers = worker_mcp_servers(&worker, host_chat);
            let plugin_root = worker.slot_plugin_root.to_string_lossy().to_string();
            let cold_start_ms = if started_process {
                checkout_started.elapsed().as_secs_f64() * 1000.0
            } else {
                0.0
            };
            return Ok((worker, active_guard, plugin_root, mcp_servers, cold_start_ms));
        }
        Err("AGY authentication changed during ACP startup; please retry".into())
    }

    pub(super) async fn release_local(&self, mut worker: AcpWorker, healthy: bool) {
        scrub_worker_slot(&worker);
        if !healthy
            || worker.child.try_wait().ok().flatten().is_some()
            || worker.auth_fingerprint.is_none()
            || (self.auth_fingerprint_reader)(&worker.profile) != worker.auth_fingerprint
        {
            teardown_worker(&mut worker).await;
            return;
        }
        let overflow = {
            let mut guard = self.inner.lock().unwrap_or_else(|p| p.into_inner());
            if guard.shutting_down {
                Some(worker)
            } else if guard.idle.len() >= MAX_IDLE_WORKERS {
                let oldest = guard.idle.remove(0);
                guard.idle.push(worker);
                Some(oldest)
            } else {
                guard.idle.push(worker);
                None
            }
        };
        if let Some(mut extra) = overflow {
            teardown_worker(&mut extra).await;
        }
    }

    pub(super) async fn try_connect_remote_broker(
        &self,
        profile: &WorkerProfileKey,
        host_instructions: &str,
        host_chat: Option<&HostChatEndpoint>,
    ) -> Result<Option<(TcpStream, Vec<u8>, String, Vec<Value>, f64, bool)>, String> {
        if self.is_broker_host.load(Ordering::SeqCst) {
            return Ok(None);
        }
        let Some(manifest) = read_live_broker_manifest(&self.base_home()) else {
            return Ok(None);
        };
        let stream = match tokio::time::timeout(
            Duration::from_secs(2),
            TcpStream::connect(("127.0.0.1", manifest.port)),
        )
        .await
        {
            Ok(Ok(stream)) => stream,
            _ => return Ok(None),
        };
        let _ = stream.set_nodelay(true);
        let (read_half, mut write_half) = stream.into_split();
        let req = CheckoutRequest {
            token: manifest.token,
            profile: profile.clone(),
            host_instructions: host_instructions.to_string(),
            host_chat: host_chat.cloned(),
        };
        let frame = encode_ndjson(&serde_json::to_value(&req).map_err(|e| e.to_string())?)?;
        write_half.write_all(&frame).await.map_err(|e| format!("write AGY ACP checkout: {e}"))?;
        write_half.flush().await.map_err(|e| format!("flush AGY ACP checkout: {e}"))?;

        let mut reader = BufReader::new(read_half);
        let mut line_buf = Vec::new();
        let bytes = match tokio::time::timeout(
            RPC_HANDSHAKE_TIMEOUT * MAX_AUTH_START_ATTEMPTS + Duration::from_secs(5),
            read_ndjson_line(&mut reader, &mut line_buf),
        )
        .await
        .map_err(|_| "AGY ACP broker checkout timed out")?
        .map_err(|e| format!("read AGY ACP checkout: {e}"))?
        {
            LineRead::Line(bytes) => bytes,
            _ => return Err("AGY ACP broker closed checkout without a valid response".into()),
        };
        let resp: CheckoutResponse = serde_json::from_slice(&bytes)
            .map_err(|_| "invalid AGY ACP broker checkout response")?;
        if !resp.ok {
            // A reachable host's rejection must not be bypassed by a local
            // fallback, especially after its bounded authentication retries.
            return Err(resp.error.unwrap_or_else(|| "AGY ACP broker rejected checkout".into()));
        }
        let plugin_root = resp.slot_plugin_root.ok_or("AGY ACP checkout missing plugin root")?;
        let reunited = reader.into_inner().reunite(write_half)
            .map_err(|_| "AGY ACP checkout stream mismatch")?;
        Ok(Some((
            reunited,
            line_buf,
            plugin_root,
            resp.mcp_servers,
            resp.cold_start_ms,
            resp.supports_session_resume,
        )))
    }
}

impl Drop for AgyAcpState {
    fn drop(&mut self) {
        self.kill_spawned();
    }
}

fn native_worker_auth_fingerprint(profile: &WorkerProfileKey) -> Option<String> {
    // Overrides can select a different credential store or API channel. The
    // shared native keyring is not evidence of identity for those processes.
    const AUTH_SELECTORS: &[&str] = &[
        "ANTIGRAVITY_HOME", "ANTIGRAVITY_GEMINI_DIR", "ANTIGRAVITY_CONFIG_REL_DIR",
        "ANTIGRAVITY_APP_DATA_DIR", "SSH_TTY", "SSH_CONNECTION", "GEMINI_API_KEY",
        "GOOGLE_API_KEY", "AGY_ADC_AUTH", "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_GENAI_USE_VERTEXAI",
    ];
    if AUTH_SELECTORS.iter().any(|key| std::env::var_os(key).is_some_and(|v| !v.is_empty()))
        || profile.env_pairs.iter().any(|(key, value)| {
        !value.is_empty()
            && AUTH_SELECTORS.iter().chain(["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"].iter())
                .any(|name| key.eq_ignore_ascii_case(name))
    }) {
        return None;
    }
    crate::agy_quota::native_auth_fingerprint()
}

fn pop_matching_idle(
    idle: &mut Vec<AcpWorker>,
    profile: &WorkerProfileKey,
    host_chat: Option<&HostChatEndpoint>,
    auth_fingerprint: Option<&str>,
) -> Option<AcpWorker> {
    let mut idx = idle.len();
    while idx > 0 {
        idx -= 1;
        if idle[idx].child.try_wait().ok().flatten().is_some()
            || auth_fingerprint.is_none()
            || idle[idx].auth_fingerprint.as_deref() != auth_fingerprint
        {
            let mut dead = idle.swap_remove(idx);
            kill_worker_sync(&mut dead);
            continue;
        }
        let exec_matches = match (&idle[idx].mcp_exec, host_chat) {
            (Some((cmd, args)), Some(hc)) => cmd == &hc.command && args == &hc.args,
            (None, _) | (_, None) => true,
        };
        if &idle[idx].profile == profile && exec_matches {
            return Some(idle.swap_remove(idx));
        }
    }
    None
}

fn read_live_broker_manifest(base_home: &Path) -> Option<BrokerManifest> {
    let profile = dunce::canonicalize(base_home).ok()?;
    let path = profile.join(BROKER_FILE_REL);
    let meta = std::fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 64 * 1024 {
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    let manifest: BrokerManifest = serde_json::from_slice(&bytes).ok()?;
    if manifest.protocol != BROKER_PROTOCOL
        || manifest.profile != profile
        || manifest.port == 0
        || manifest.token.len() != 64
        || !manifest.token.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return None;
    }
    let (exe, started) = crate::task_worker::process_identity(manifest.pid).ok()?;
    if exe != manifest.executable || started != manifest.process_start_time {
        return None;
    }
    Some(manifest)
}

fn remove_owned_broker_manifest(broker: &BrokerRuntime) {
    // A late shutdown must never unlink another generation's publication.
    let owned = std::fs::read(&broker.manifest_path).ok()
        .and_then(|bytes| serde_json::from_slice::<BrokerManifest>(&bytes).ok())
        .is_some_and(|manifest| manifest.pid == std::process::id() && manifest.token == broker.token);
    if owned { let _ = std::fs::remove_file(&broker.manifest_path); }
}

pub(crate) fn live_broker_executable(base_home: &Path) -> Option<PathBuf> {
    read_live_broker_manifest(base_home).map(|manifest| manifest.executable)
}

async fn handle_broker_client(
    state: Arc<AgyAcpState>,
    stream: TcpStream,
    expected_token: String,
) {
    let (read_half, mut write_half) = stream.into_split();
    let mut client_reader = BufReader::new(read_half);
    let mut client_buf = Vec::new();
    let first = match tokio::time::timeout(
        Duration::from_secs(5),
        read_ndjson_line(&mut client_reader, &mut client_buf),
    )
    .await
    {
        Ok(Ok(LineRead::Line(bytes))) => bytes,
        _ => return,
    };
    if let Ok(lease) = serde_json::from_slice::<service::HostLeaseRequest>(&first) {
        if lease.token == expected_token && lease.host_lease {
            let Ok(_lease) = state.acquire_use(&state.host_leases) else { return; };
            let ready = json!({"protocol": BROKER_PROTOCOL, "pid": std::process::id(), "hostLease": true});
            if let Ok(bytes) = encode_ndjson(&ready) {
                if write_half.write_all(&bytes).await.is_ok() && write_half.flush().await.is_ok() {
                    // EOF follows GUI exit, including abrupt exit. No heartbeats
                    // or frontend timer is needed to preserve an active service.
                    let _ = read_ndjson_line(&mut client_reader, &mut client_buf).await;
                }
            }
        }
        return;
    }
    let Ok(req) = serde_json::from_slice::<CheckoutRequest>(&first) else {
        return;
    };
    if req.token != expected_token {
        return;
    }
    let checkout = state
        .checkout_local(&req.profile, &req.host_instructions, req.host_chat.as_ref())
        .await;
    let (mut worker, turn_guard, plugin_root, mcp_servers, cold_start_ms) = match checkout {
        Ok(tuple) => tuple,
        Err(err) => {
            let reply = CheckoutResponse {
                ok: false,
                error: Some(err),
                slot_plugin_root: None,
                mcp_servers: Vec::new(),
                cold_start_ms: 0.0,
                supports_session_resume: false,
            };
            if let Ok(val) = serde_json::to_value(&reply) {
                if let Ok(bytes) = encode_ndjson(&val) {
                    let _ = write_half.write_all(&bytes).await;
                    let _ = write_half.flush().await;
                }
            }
            return;
        }
    };

    let reply = CheckoutResponse {
        ok: true,
        error: None,
        slot_plugin_root: Some(plugin_root),
        mcp_servers,
        cold_start_ms,
        supports_session_resume: worker.supports_session_resume,
    };
    let Ok(reply_val) = serde_json::to_value(&reply) else {
        state.release_local(worker, false).await;
        return;
    };
    let Ok(reply_bytes) = encode_ndjson(&reply_val) else {
        state.release_local(worker, false).await;
        return;
    };
    if write_half.write_all(&reply_bytes).await.is_err() || write_half.flush().await.is_err() {
        state.release_local(worker, false).await;
        return;
    }

    let clean_lease = bridge_worker_io(&mut worker, &mut client_reader, &mut client_buf, &mut write_half).await;
    state.release_local(worker, clean_lease).await;
    drop(turn_guard);
    if clean_lease {
        if let Ok(ack) = encode_ndjson(&json!({ LEASE_RELEASED_ACK: true })) {
            let _ = write_half.write_all(&ack).await;
            let _ = write_half.flush().await;
        }
    }
}

async fn bridge_worker_io(
    worker: &mut AcpWorker,
    client_reader: &mut BufReader<tokio::net::tcp::OwnedReadHalf>,
    client_buf: &mut Vec<u8>,
    client_writer: &mut tokio::net::tcp::OwnedWriteHalf,
) -> bool {
    loop {
        tokio::select! {
            client_line = read_ndjson_line(client_reader, client_buf) => {
                match client_line {
                    Ok(LineRead::Line(mut bytes)) => {
                        if let Ok(val) = serde_json::from_slice::<Value>(&bytes) {
                            if val.get(LEASE_DONE_SENTINEL).and_then(Value::as_bool) == Some(true) {
                                return true;
                            }
                        }
                        bytes.push(b'\n');
                        if worker.stdin.write_all(&bytes).await.is_err()
                            || worker.stdin.flush().await.is_err()
                        {
                            return false;
                        }
                    }
                    _ => return false,
                }
            }
            worker_line = read_ndjson_line(&mut worker.reader, &mut worker.line_buf) => {
                match worker_line {
                    Ok(LineRead::Line(mut bytes)) => {
                        bytes.push(b'\n');
                        if client_writer.write_all(&bytes).await.is_err()
                            || client_writer.flush().await.is_err()
                        {
                            return false;
                        }
                    }
                    _ => return false,
                }
            }
        }
    }
}

async fn spawn_and_initialize_worker(
    slots_parent: &Path,
    profile: &WorkerProfileKey,
    host_chat: Option<&HostChatEndpoint>,
    auth_fingerprint: Option<String>,
) -> Result<AcpWorker, String> {
    std::fs::create_dir_all(slots_parent)
        .map_err(|e| format!("create agy acp slots parent: {e}"))?;
    let slots_parent = dunce::canonicalize(slots_parent)
        .map_err(|e| format!("canonicalize agy acp slots parent: {e}"))?;
    let slot_dir = slots_parent.join(uuid::Uuid::new_v4().to_string());
    crate::task_worker::private_directory(&slot_dir).map_err(|e| e.message)?;

    let slot_plugin_root = slot_dir.join("host-plugin");
    let plugin_dir = slot_plugin_root.join(HOST_PLUGIN);
    std::fs::create_dir_all(plugin_dir.join("rules"))
        .map_err(|e| format!("create agy slot plugin dir: {e}"))?;
    std::fs::write(
        plugin_dir.join("plugin.json"),
        r#"{"name":"ccgui-host","version":"0.1.0","rules":"rules"}"#,
    )
    .map_err(|e| format!("write agy slot plugin.json: {e}"))?;
    std::fs::write(plugin_dir.join("rules/AGENTS.md"), "")
        .map_err(|e| format!("write agy slot AGENTS.md: {e}"))?;
    let token_file = slot_dir.join("host-chat.json");

    let mut command = command_for_binary(&profile.bin);
    configure_background_command(&mut command);
    for (k, v) in &profile.env_pairs {
        command.env(k, v);
    }
    if profile.leader_child {
        command.env("CCGUI_LEADER_MANAGED_CHILD", "1");
    } else {
        command.env_remove("CCGUI_LEADER_MANAGED_CHILD");
    }
    if profile.completion_owner {
        command.env("CCGUI_SPELLCAST_COMPLETION_OWNER", "1");
    } else {
        command.env_remove("CCGUI_SPELLCAST_COMPLETION_OWNER");
    }
    let launch_cwd = {
        let ws = Path::new(&profile.workspace);
        if !profile.workspace.is_empty() && ws.is_dir() {
            ws
        } else {
            slot_dir.as_path()
        }
    };
    command
        .arg("acp")
        .arg("--stdio")
        .current_dir(launch_cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    hide_console(&mut command);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&slot_dir);
            return Err(format!("failed to spawn {}: {error}", profile.bin));
        }
    };
    #[cfg(windows)]
    let tree_guard = super::job::assign_kill_on_close(&child);
    let (stdin, stdout, stderr) = match (child.stdin.take(), child.stdout.take(), child.stderr.take())
    {
        (Some(stdin), Some(stdout), Some(stderr)) => (stdin, stdout, stderr),
        _ => {
            let _ = child.start_kill();
            let _ = std::fs::remove_dir_all(&slot_dir);
            return Err("missing stdio pipe after spawning agy acp".into());
        }
    };
    let mut worker = AcpWorker {
        profile: profile.clone(),
        auth_fingerprint,
        slot_dir,
        slot_plugin_root,
        token_file,
        mcp_exec: host_chat.map(|hc| (hc.command.clone(), hc.args.clone())),
        child,
        stdin,
        reader: BufReader::new(stdout),
        line_buf: Vec::new(),
        next_id: 1,
        stderr_buf: super::spawn_stderr_capture(stderr),
        supports_session_resume: false,
        #[cfg(windows)]
        _tree_guard: tree_guard,
    };

    let init_req = jsonrpc_request(
        worker.next_id,
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientCapabilities": support::client_capabilities(),
            "clientInfo": {
                "name": "ccgui",
                "version": env!("CARGO_PKG_VERSION"),
            }
        }),
    );
    worker.next_id += 1;
    let init_res = async {
        let bytes = encode_ndjson(&init_req)?;
        worker
            .stdin
            .write_all(&bytes)
            .await
            .map_err(|e| format!("write agy acp initialize: {e}"))?;
        worker
            .stdin
            .flush()
            .await
            .map_err(|e| format!("flush agy acp initialize: {e}"))?;
        let deadline = Instant::now() + RPC_HANDSHAKE_TIMEOUT;
        loop {
            let rem = deadline.saturating_duration_since(Instant::now());
            if rem.is_zero() {
                return Err("agy acp initialize timed out".to_string());
            }
            let line = tokio::time::timeout(
                rem,
                read_ndjson_line(&mut worker.reader, &mut worker.line_buf),
            )
            .await
            .map_err(|_| "agy acp initialize timed out".to_string())?
            .map_err(|e| format!("agy acp initialize read error: {e}"))?;
            let bytes = match line {
                LineRead::Line(b) => b,
                LineRead::Eof => return Err("agy acp exited during initialize".into()),
                LineRead::TooLong => return Err("agy acp initialize frame too large".into()),
            };
            let Ok(val) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            if let AcpLine::Response { id, result, error } = parse_acp_line(&val) {
                if id.as_u64() == Some(1) {
                    if let Some(err) = error {
                        return Err(format!("agy acp initialize failed: {}", err.message));
                    }
                    worker.supports_session_resume = result.as_ref()
                        .and_then(|value| value.pointer("/agentCapabilities/sessionCapabilities/resume"))
                        .is_some_and(|capability| capability.is_object() || capability == true);
                    return Ok(());
                }
            }
        }
    }
    .await;

    if let Err(err) = init_res {
        let stderr = worker
            .stderr_buf
            .lock()
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        teardown_worker(&mut worker).await;
        return Err(if stderr.is_empty() {
            err
        } else {
            format!("{err}: {stderr}")
        });
    }
    Ok(worker)
}

fn prepare_worker_slot(
    worker: &mut AcpWorker,
    host_instructions: &str,
    host_chat: Option<&HostChatEndpoint>,
) -> Result<(), String> {
    let rules_path = worker
        .slot_plugin_root
        .join(HOST_PLUGIN)
        .join("rules/AGENTS.md");
    if rules_path
        .ancestors()
        .take_while(|p| p.starts_with(&worker.slot_dir))
        .any(|p| std::fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()))
    {
        return Err("AGY ACP slot directory contains unexpected symlinks".into());
    }
    std::fs::write(&rules_path, host_instructions.as_bytes())
        .map_err(|e| format!("write AGY ACP rules: {e}"))?;

    let _ = std::fs::remove_file(&worker.token_file);
    if let Some(hc) = host_chat {
        if worker.mcp_exec.is_none() {
            worker.mcp_exec = Some((hc.command.clone(), hc.args.clone()));
        }
        let payload = serde_json::to_vec(&json!({
            "url": hc.url,
            "token": hc.token,
        }))
        .map_err(|e| e.to_string())?;
        let mut file =
            crate::task_worker::private_file(&worker.token_file).map_err(|e| e.message)?;
        file.write_all(&payload)
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("write AGY ACP host-chat config: {e}"))?;
    }
    Ok(())
}

fn worker_mcp_servers(worker: &AcpWorker, host_chat: Option<&HostChatEndpoint>) -> Vec<Value> {
    let Some(hc) = host_chat else {
        return Vec::new();
    };
    vec![json!({
        "name": crate::host_chat::MCP_SERVER_NAME,
        "command": hc.command,
        "args": hc.args,
        "env": [{
            "name": crate::host_chat::DYNAMIC_CONFIG_ENV,
            "value": worker.token_file.to_string_lossy().to_string(),
        }],
    })]
}

fn scrub_worker_slot(worker: &AcpWorker) {
    let _ = std::fs::remove_file(&worker.token_file);
    let rules_path = worker
        .slot_plugin_root
        .join(HOST_PLUGIN)
        .join("rules/AGENTS.md");
    let _ = std::fs::write(rules_path, b"");
}

async fn teardown_worker(worker: &mut AcpWorker) {
    scrub_worker_slot(worker);
    if let Some(pid) = worker.child.id() {
        kill_process_group(pid);
    }
    let _ = worker.child.kill().await;
    let _ = tokio::time::timeout(POST_KILL_WAIT, worker.child.wait()).await;
    let _ = std::fs::remove_dir_all(&worker.slot_dir);
}

fn kill_worker_sync(worker: &mut AcpWorker) {
    scrub_worker_slot(worker);
    if let Some(pid) = worker.child.id() {
        kill_process_group(pid);
    }
    let _ = worker.child.start_kill();
    let _ = std::fs::remove_dir_all(&worker.slot_dir);
}

pub(super) async fn read_ndjson_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    line: &mut Vec<u8>,
) -> std::io::Result<LineRead> {
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(if line.is_empty() {
                LineRead::Eof
            } else {
                LineRead::Line(std::mem::take(line))
            });
        }
        let end = available
            .iter()
            .position(|b| *b == b'\n')
            .unwrap_or(available.len());
        if line.len() + end > MAX_LINE_BYTES {
            return Ok(LineRead::TooLong);
        }
        line.extend_from_slice(&available[..end]);
        if end < available.len() {
            reader.consume(end + 1);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(LineRead::Line(std::mem::take(line)));
        }
        reader.consume(end);
    }
}

pub(super) async fn finish_remote_lease<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin>(
    reader: &mut R,
    line_buf: &mut Vec<u8>,
    writer: &mut W,
) -> Result<(), String> {
    let bytes = encode_ndjson(&json!({ LEASE_DONE_SENTINEL: true }))?;
    writer
        .write_all(&bytes)
        .await
        .map_err(|e| format!("write lease done: {e}"))?;
    writer
        .flush()
        .await
        .map_err(|e| format!("flush lease done: {e}"))?;
    let _ = tokio::time::timeout(Duration::from_secs(2), async {
        while let Ok(LineRead::Line(raw)) = read_ndjson_line(reader, line_buf).await {
            if let Ok(val) = serde_json::from_slice::<Value>(&raw) {
                if val.get(LEASE_RELEASED_ACK).and_then(Value::as_bool) == Some(true) {
                    break;
                }
            }
        }
    })
    .await;
    Ok(())
}

#[allow(dead_code)]
fn _assert_send_sync() {
    fn check<T: Send + Sync>() {}
    check::<AgyAcpState>();
}
