use super::protocol::*;
use super::storage::{EventChunk, EventsPage};
use super::{read_frame, schema_hash};
use crate::runtime_events::EventEnvelope;
use base64::Engine as _;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncWriteExt, BufReader};

pub(crate) fn process_identity(pid: u32) -> Result<(PathBuf, u64), WorkerError> {
    let process_id = sysinfo::Pid::from_u32(pid);
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&[process_id]),
        true,
        sysinfo::ProcessRefreshKind::everything(),
    );
    let process = system
        .process(process_id)
        .ok_or_else(|| WorkerError::new("worker_not_running", "Worker process no longer exists"))?;
    let executable = process
        .exe()
        .and_then(|path| dunce::canonicalize(path).ok())
        .ok_or_else(|| {
            WorkerError::new(
                "worker_identity",
                "Cannot verify worker executable identity",
            )
        })?;
    Ok((executable, process.start_time()))
}

fn validate_manifest(manifest: &WorkerManifest, profile: &Path) -> Result<(), WorkerError> {
    if manifest.protocol != PROTOCOL
        || manifest.profile != profile
        || !valid_id(&manifest.worker_id)
        || !valid_id(&manifest.run_id)
        || manifest.port == 0
        || manifest.token.len() != 64
        || !manifest.token.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(WorkerError::new(
            "invalid_manifest",
            "Worker manifest identity or protocol is invalid",
        ));
    }
    let (executable, started) = process_identity(manifest.pid)?;
    if executable != manifest.executable || started != manifest.process_start_time {
        return Err(WorkerError::new(
            "worker_identity",
            "Worker PID was replaced or its executable identity changed",
        ));
    }
    Ok(())
}

fn read_manifest(path: &Path) -> Result<WorkerManifest, WorkerError> {
    let meta = std::fs::symlink_metadata(path)
        .map_err(|_| WorkerError::new("manifest_read", "Cannot inspect worker manifest"))?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 64 * 1024 {
        return Err(WorkerError::new(
            "invalid_manifest",
            "Worker manifest must be a bounded regular file",
        ));
    }
    let bytes = std::fs::read(path)
        .map_err(|_| WorkerError::new("manifest_read", "Cannot read worker manifest"))?;
    serde_json::from_slice(&bytes)
        .map_err(|_| WorkerError::new("invalid_manifest", "Worker manifest is not valid JSON"))
}

/// Discover only live, profile-bound workers. Never print manifests: they contain
/// capability tokens. Dead entries are retained for explicit diagnostic recovery.
/// Call `status` after discovery to authenticate the actual listening process.
/// The manifest's same-account writer is part of the trust boundary. PID/start
/// time/executable checks reject stale records, not forgery by that trusted writer.
pub fn discover(profile: &Path) -> Result<Vec<WorkerManifest>, WorkerError> {
    let profile = dunce::canonicalize(profile).map_err(|_| {
        WorkerError::new(
            "profile_mismatch",
            "Resolve worker discovery profile failed",
        )
    })?;
    let root = profile.join("runtime/task-workers");
    if !root.exists() {
        return Ok(Vec::new());
    }
    if dunce::canonicalize(&root).ok().as_deref() != Some(root.as_path()) {
        return Err(WorkerError::new(
            "profile_mismatch",
            "Worker discovery directory redirects outside the profile",
        ));
    }
    let entries = std::fs::read_dir(&root)
        .map_err(|_| WorkerError::new("manifest_read", "Read worker discovery directory failed"))?;
    let mut result = Vec::new();
    for entry in entries {
        let entry = entry
            .map_err(|_| WorkerError::new("manifest_read", "Read worker directory entry failed"))?;
        let directory = entry.path();
        if !entry
            .file_type()
            .map(|kind| kind.is_dir() && !kind.is_symlink())
            .unwrap_or(false)
        {
            continue;
        }
        if dunce::canonicalize(&directory).ok().as_deref() != Some(directory.as_path()) {
            continue;
        }
        let path = directory.join("manifest.json");
        if !path.exists() {
            continue;
        }
        let manifest = read_manifest(&path)?;
        if directory.file_name().and_then(|name| name.to_str()) != Some(manifest.worker_id.as_str())
        {
            continue;
        }
        match validate_manifest(&manifest, &profile) {
            Ok(()) => result.push(manifest),
            Err(error) if error.code == "worker_not_running" || error.code == "worker_identity" => {
                continue
            }
            Err(error) => return Err(error),
        }
    }
    Ok(result)
}

/// Start only an already verified/activated executable. Download signatures and
/// activation ownership are the host's responsibility. The worker is not joined
/// to a kill-on-close job and has no kill_on_drop relationship with this client.
pub async fn launch(executable: &Path, run_id: &str) -> Result<WorkerManifest, WorkerError> {
    launch_with_context(executable, run_id, None).await
}

pub(crate) async fn launch_with_context(
    executable: &Path,
    run_id: &str,
    host_context: Option<crate::host_chat::WorkerHostContext>,
) -> Result<WorkerManifest, WorkerError> {
    if !valid_id(run_id) {
        return Err(WorkerError::new("invalid_run_id", "Invalid worker run ID"));
    }
    let executable = dunce::canonicalize(executable).map_err(|_| {
        WorkerError::new("worker_executable", "Resolve task worker executable failed")
    })?;
    let profile = dunce::canonicalize(crate::paths::app_home())
        .map_err(|_| WorkerError::new("profile_mismatch", "Resolve worker profile failed"))?;
    let config = WorkerConfig {
        protocol: PROTOCOL,
        worker_id: uuid::Uuid::new_v4().to_string(),
        run_id: run_id.into(),
        profile: profile.clone(),
        schema_hash: schema_hash(),
        token: format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        ),
        host_context,
    };
    let mut command = tokio::process::Command::new(&executable);
    command
        .args(crate::paths::service_args("--task-worker"))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(false);
    #[cfg(windows)]
    {
        // Fail closed if a containing job prohibits breakaway. Retrying inside
        // that job would let host retirement terminate the supposedly live task.
        command.creation_flags(0x0800_0000 | 0x0100_0000);
    }
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|_| WorkerError::new("worker_spawn", "Start independent task worker failed"))?;
    let pid = child
        .id()
        .ok_or_else(|| WorkerError::new("worker_spawn", "Worker PID is unavailable"))?;
    let mut stdin = child.stdin.take().ok_or_else(|| {
        WorkerError::new(
            "worker_spawn",
            "Worker configuration channel is unavailable",
        )
    })?;
    let mut bytes = serde_json::to_vec(&config).map_err(|_| {
        WorkerError::new(
            "invalid_configuration",
            "Encode worker configuration failed",
        )
    })?;
    bytes.push(b'\n');
    stdin.write_all(&bytes).await.map_err(|_| {
        WorkerError::unknown(
            "worker_start_unknown",
            "Worker configuration delivery failed",
        )
    })?;
    stdin.shutdown().await.map_err(|_| {
        WorkerError::unknown(
            "worker_start_unknown",
            "Close worker configuration channel failed",
        )
    })?;
    drop(stdin);
    let stdout = child.stdout.take().ok_or_else(|| {
        WorkerError::new("worker_spawn", "Worker readiness channel is unavailable")
    })?;
    let ready = tokio::time::timeout(
        Duration::from_secs(20),
        read_frame(&mut BufReader::new(stdout)),
    )
    .await
    .map_err(|_| {
        WorkerError::unknown(
            "worker_start_unknown",
            "Worker readiness timed out; discover before retrying",
        )
    })??;
    let ready: Value = serde_json::from_slice(&ready).map_err(|_| {
        WorkerError::unknown("worker_start_unknown", "Invalid worker readiness frame")
    })?;
    if ready["workerId"].as_str() != Some(&config.worker_id)
        || ready["pid"].as_u64() != Some(pid as u64)
        || ready["protocol"].as_u64() != Some(PROTOCOL as u64)
    {
        return Err(WorkerError::unknown(
            "worker_start_unknown",
            "Worker readiness identity differs",
        ));
    }
    let manifest = read_manifest(
        &profile
            .join("runtime/task-workers")
            .join(&config.worker_id)
            .join("manifest.json"),
    )?;
    validate_manifest(&manifest, &profile)?;
    if manifest.pid != pid
        || manifest.executable != executable
        || manifest.schema_hash != config.schema_hash
        || !token_matches(&config.token, &manifest.token)
        || ready["port"].as_u64() != Some(manifest.port as u64)
    {
        return Err(WorkerError::new(
            "worker_identity",
            "Published worker identity differs from its launch",
        ));
    }
    // Dropping Child is explicitly non-killing. Parent death cannot close the
    // run's pipe or job handles because those are created inside the worker.
    drop(child);
    Ok(manifest)
}

#[derive(Clone)]
pub struct WorkerClient {
    manifest: WorkerManifest,
}

impl WorkerClient {
    pub fn new(manifest: WorkerManifest) -> Self {
        Self { manifest }
    }
    pub fn manifest(&self) -> &WorkerManifest {
        &self.manifest
    }

    /// Replay advances the cursor only past complete, hash-verified envelopes.
    /// A disconnect during chunk download returns an error without a new cursor;
    /// retrying the same `after` is safe and does not execute any engine action.
    pub async fn events_after(&self, after: u64, limit: usize) -> Result<EventsPage, WorkerError> {
        replay_with(
            &self.manifest.worker_id,
            after,
            limit,
            |command| async move {
                let id = uuid::Uuid::new_v4().to_string();
                self.request(&id, command).await
            },
        )
        .await
    }

    /// No blind retries. For a timeout/disconnect, query Receipt or repeat exactly
    /// this request ID and command; a new ID could perform an operation twice.
    pub async fn request(&self, id: &str, command: Command) -> Outcome {
        if !valid_id(id) {
            return Err(WorkerError::new(
                "invalid_request_id",
                "Invalid stable worker request ID",
            ));
        }
        let active_profile = dunce::canonicalize(crate::paths::app_home()).map_err(|_| {
            WorkerError::new(
                "profile_mismatch",
                "Resolve active worker client profile failed",
            )
        })?;
        validate_manifest(&self.manifest, &active_profile)?;
        let request = Request {
            protocol: PROTOCOL,
            worker_id: self.manifest.worker_id.clone(),
            token: self.manifest.token.clone(),
            id: id.into(),
            command,
        };
        let action = async {
            let mut socket =
                tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, self.manifest.port))
                    .await
                    .map_err(|_| {
                        WorkerError::unknown(
                            "transport_connect",
                            "Worker connection failed; recover the same request ID",
                        )
                    })?;
            let mut bytes = serde_json::to_vec(&request)
                .map_err(|_| WorkerError::new("invalid_command", "Encode worker request failed"))?;
            if bytes.len() >= MAX_FRAME_BYTES {
                return Err(WorkerError::new(
                    "invalid_frame",
                    "Worker request exceeds frame limit",
                ));
            }
            bytes.push(b'\n');
            socket.write_all(&bytes).await.map_err(|_| {
                WorkerError::unknown(
                    "transport_write",
                    "Worker request delivery is unknown; recover the same request ID",
                )
            })?;
            let frame = read_frame(&mut BufReader::new(socket)).await?;
            let response: Response = serde_json::from_slice(&frame).map_err(|_| {
                WorkerError::unknown(
                    "invalid_response",
                    "Worker response is invalid; recover the same request ID",
                )
            })?;
            if response.protocol != PROTOCOL
                || response.worker_id != self.manifest.worker_id
                || response.id != id
            {
                return Err(WorkerError::unknown(
                    "invalid_response",
                    "Worker response identity differs",
                ));
            }
            response.outcome
        };
        tokio::time::timeout(Duration::from_secs(45), action)
            .await
            .map_err(|_| {
                WorkerError::unknown(
                    "transport_timeout",
                    "Worker command timed out; recover the same request ID",
                )
            })?
    }
}

/// Shared by the real network client and in-process protocol regressions.
pub(super) async fn replay_with<F, Fut>(
    stream_id: &str,
    after: u64,
    limit: usize,
    mut request: F,
) -> Result<EventsPage, WorkerError>
where
    F: FnMut(Command) -> Fut,
    Fut: std::future::Future<Output = Outcome>,
{
    if limit == 0 || limit > 512 {
        return Err(WorkerError::new(
            "invalid_limit",
            "Expected 1 to 512 events",
        ));
    }
    let invalid = || {
        WorkerError::new(
            "invalid_event_replay",
            "Worker event page or chunk is inconsistent",
        )
    };
    let payload = request(Command::Events {
        stream_id: stream_id.into(),
        after,
        limit,
    })
    .await?;
    let mut page: EventsPage = serde_json::from_value(payload).map_err(|_| invalid())?;
    if page.stream_id != stream_id || page.events.len() > limit || page.durable_through > page.head
    {
        return Err(invalid());
    }
    let mut through = after;
    for event in &page.events {
        through = through.checked_add(1).ok_or_else(invalid)?;
        if event.stream_id != stream_id || event.seq != through {
            return Err(invalid());
        }
    }
    if page.through != through || through > page.head {
        return Err(invalid());
    }
    if let Some(fragment) = page.fragment.take() {
        if page.events.len() == limit
            || fragment.stream_id != stream_id
            || fragment.seq != through.checked_add(1).ok_or_else(invalid)?
            || fragment.seq > page.head
            || fragment.total_bytes == 0
            || fragment.total_bytes > MAX_REASSEMBLED_EVENT_BYTES
            || fragment.sha256.len() != 64
            || !fragment.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(invalid());
        }
        let total = usize::try_from(fragment.total_bytes).map_err(|_| invalid())?;
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(total).map_err(|_| {
            WorkerError::new("event_allocation", "Cannot allocate complete worker event")
        })?;
        let mut digest = Sha256::new();
        while bytes.len() < total {
            let offset = bytes.len() as u64;
            let length = std::cmp::min(EVENT_CHUNK_BYTES, total - bytes.len());
            let payload = request(Command::EventChunk {
                stream_id: stream_id.into(),
                seq: fragment.seq,
                offset,
                limit: length,
            })
            .await?;
            let chunk: EventChunk = serde_json::from_value(payload).map_err(|_| invalid())?;
            if chunk.event != fragment
                || chunk.offset != offset
                || chunk.data_base64.len() > ((EVENT_CHUNK_BYTES + 2) / 3) * 4
            {
                return Err(invalid());
            }
            let data = base64::engine::general_purpose::STANDARD
                .decode(&chunk.data_base64)
                .map_err(|_| invalid())?;
            if data.is_empty() || data.len() > length || data.len() > total - bytes.len() {
                return Err(invalid());
            }
            digest.update(&data);
            bytes.extend_from_slice(&data);
        }
        if format!("{:x}", digest.finalize()) != fragment.sha256 {
            return Err(WorkerError::new(
                "event_integrity",
                "Worker event digest does not match the complete envelope",
            ));
        }
        let event: EventEnvelope = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        if event.stream_id != stream_id || event.seq != fragment.seq {
            return Err(invalid());
        }
        page.through = event.seq;
        page.events.push(event);
    }
    Ok(page)
}
