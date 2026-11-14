//! Independent owner of the warm ACP pool. GUI leases may come and go during
//! self-update; task-worker connections remain attached to this same process.
use super::*;
use std::io::{BufRead, Read};

const START_TIMEOUT: Duration = Duration::from_secs(20);
const RECONNECT_GRACE: Duration = Duration::from_secs(120);
const CONFIG_LIMIT: u64 = 64 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct HostLeaseRequest {
    pub(super) token: String,
    pub(super) host_lease: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Bootstrap {
    profile: PathBuf,
}

impl AgyAcpState {
    pub(crate) async fn ensure_broker_service(self: &Arc<Self>) -> Result<(), String> {
        let root = dunce::canonicalize(self.base_home())
            .map_err(|_| "Resolve AGY ACP service profile failed")?;
        let lease = connect_or_start(&root, || {
            let mut command = tokio::process::Command::new(
                std::env::current_exe().map_err(|_| "Locate AGY ACP service executable failed")?,
            );
            command.args(crate::paths::service_args("--agy-acp-service"));
            Ok(command)
        }).await?;
        let mut state = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if state.shutting_down { return Err("AGY ACP client is shutting down".into()); }
        state.desktop_lease = Some(lease);
        Ok(())
    }
}

async fn connect_or_start(
    root: &Path,
    command: impl Fn() -> Result<tokio::process::Command, String>,
) -> Result<TcpStream, String> {
    let mut last_error = String::new();
    // A service can retire between the identity read and TCP attach. Retry only
    // this idempotent host attachment, never a turn or its prompt. A live owner
    // is never killed/replaced; the service's file lock arbitrates cold starts.
    let connected = tokio::time::timeout(START_TIMEOUT, async {
        loop {
            let result = match read_live_broker_manifest(root) {
                Some(manifest) => attach_host(&manifest).await,
                None => match service_lock(root) {
                    // Retirement unpublishes before cleaning idle process trees.
                    // Wait for that owner to release the lock instead of spawning
                    // repeated doomed services during its bounded cleanup.
                    Ok(lock) => {
                        drop(lock);
                        spawn_service(root, &mut command()?).await
                    }
                    Err(error) => Err(error),
                },
            };
            match result {
                Ok(lease) => return Ok(lease),
                Err(error) => last_error = error,
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }).await;
    match connected {
        Ok(result) => result,
        Err(_) => Err(format!("AGY ACP service connection timed out: {last_error}")),
    }
}

pub(super) async fn attach_host(manifest: &BrokerManifest) -> Result<TcpStream, String> {
    tokio::time::timeout(Duration::from_secs(5), async {
        let stream = TcpStream::connect(("127.0.0.1", manifest.port)).await
            .map_err(|_| "Connect AGY ACP service failed")?;
        let _ = stream.set_nodelay(true);
        let (read, mut write) = stream.into_split();
        let request = HostLeaseRequest { token: manifest.token.clone(), host_lease: true };
        let bytes = encode_ndjson(&serde_json::to_value(request).map_err(|_| "Encode AGY ACP service lease failed")?)?;
        write.write_all(&bytes).await.map_err(|_| "Write AGY ACP service lease failed")?;
        write.flush().await.map_err(|_| "Flush AGY ACP service lease failed")?;
        let mut reader = BufReader::new(read);
        let mut buffer = Vec::new();
        let LineRead::Line(bytes) = read_ndjson_line(&mut reader, &mut buffer).await
            .map_err(|_| "Read AGY ACP service lease failed")? else {
            return Err("AGY ACP service closed its lease".to_string());
        };
        let ready: Value = serde_json::from_slice(&bytes).map_err(|_| "Invalid AGY ACP service lease response")?;
        if ready["protocol"] != BROKER_PROTOCOL || ready["pid"] != manifest.pid || ready["hostLease"] != true {
            return Err("AGY ACP service lease identity mismatch".into());
        }
        reader.into_inner().reunite(write).map_err(|_| "AGY ACP service lease stream mismatch".to_string())
    }).await.map_err(|_| "AGY ACP service lease timed out".to_string())?
}

async fn spawn_service(root: &Path, command: &mut tokio::process::Command) -> Result<TcpStream, String> {
    use tokio::io::AsyncReadExt;
    configure_service_command(command);
    let mut child = command.spawn().map_err(|error| format!("Start independent AGY ACP service failed: {error}"))?;
    let pid = child.id().ok_or("AGY ACP service PID unavailable")?;
    let mut input = child.stdin.take().ok_or("AGY ACP service configuration pipe unavailable")?;
    let output = child.stdout.take().ok_or("AGY ACP service readiness pipe unavailable")?;
    let startup = async {
        let config = Bootstrap { profile: root.to_path_buf() };
        let mut bytes = serde_json::to_vec(&config).map_err(|_| "Encode AGY ACP service configuration failed")?;
        bytes.push(b'\n');
        input.write_all(&bytes).await.map_err(|_| "Deliver AGY ACP service configuration failed")?;
        input.shutdown().await.map_err(|_| "Close AGY ACP service configuration failed")?;
        let mut reader = BufReader::new(output.take(CONFIG_LIMIT + 1));
        let mut frame = Vec::new();
        reader.read_until(b'\n', &mut frame).await.map_err(|_| "Read AGY ACP service readiness failed")?;
        if frame.len() as u64 > CONFIG_LIMIT || !frame.ends_with(b"\n") {
            return Err("Invalid AGY ACP service readiness frame".to_string());
        }
        let ready: Value = serde_json::from_slice(&frame).map_err(|_| "Invalid AGY ACP service readiness data")?;
        let manifest = read_live_broker_manifest(root).ok_or("AGY ACP service publication unavailable")?;
        if ready["protocol"] != BROKER_PROTOCOL || ready["pid"] != pid || manifest.pid != pid || ready["port"] != manifest.port {
            return Err("AGY ACP service readiness identity mismatch".into());
        }
        attach_host(&manifest).await
    };
    let result = tokio::time::timeout(START_TIMEOUT, startup).await
        .map_err(|_| "AGY ACP service startup timed out".to_string())?;
    // Do not kill an ambiguously started service: another task may already have
    // a lease. With no clients it retires itself after RECONNECT_GRACE.
    drop(child);
    result
}

pub(super) fn configure_service_command(command: &mut tokio::process::Command) {
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(false);
    // Match task-worker/supervisor detachment: keep external launcher policy,
    // but leave the GUI's inner job and never inherit its ACP kill-on-close job.
    #[cfg(windows)]
    command.creation_flags(0x0800_0000 | 0x0100_0000);
    #[cfg(unix)]
    command.process_group(0);
}

pub(super) fn service_lock(root: &Path) -> Result<std::fs::File, String> {
    let runtime = root.join("runtime");
    crate::task_worker::private_directory(&runtime).map_err(|error| error.message)?;
    let path = runtime.join("agy-acp-service.lock");
    if let Ok(metadata) = std::fs::symlink_metadata(&path) {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err("AGY ACP service lock must be a regular file".into());
        }
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).read(true).write(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path).map_err(|_| "Open AGY ACP service lock failed")?;
    file.try_lock().map_err(|_| "An AGY ACP service already owns this profile")?;
    Ok(file)
}

pub(crate) fn run_stdio() -> Result<(), String> {
    let mut input = std::io::BufReader::new(std::io::stdin().lock().take(CONFIG_LIMIT + 1));
    let mut frame = Vec::new();
    input.read_until(b'\n', &mut frame).map_err(|_| "Read AGY ACP service configuration failed")?;
    if frame.len() as u64 > CONFIG_LIMIT || !frame.ends_with(b"\n") {
        return Err("Invalid AGY ACP service configuration frame".into());
    }
    let config: Bootstrap = serde_json::from_slice(&frame).map_err(|_| "Invalid AGY ACP service configuration")?;
    let root = dunce::canonicalize(crate::paths::app_home()).map_err(|_| "Resolve AGY ACP service profile failed")?;
    if config.profile != root { return Err("AGY ACP service profile mismatch".into()); }
    drop(input);
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build()
        .map_err(|_| "Create AGY ACP service runtime failed")?;
    runtime.block_on(run_service(Arc::new(AgyAcpState::default()), RECONNECT_GRACE, |port| {
        let ready = json!({"protocol": BROKER_PROTOCOL, "pid": std::process::id(), "port": port});
        let mut output = std::io::stdout().lock();
        serde_json::to_writer(&mut output, &ready).map_err(|_| "Encode AGY ACP service readiness failed")?;
        output.write_all(b"\n").and_then(|_| output.flush()).map_err(|_| "Publish AGY ACP service readiness failed".to_string())
    }))
}

pub(super) async fn run_service(
    state: Arc<AgyAcpState>,
    grace: Duration,
    ready: impl FnOnce(u16) -> Result<(), String>,
) -> Result<(), String> {
    let root = dunce::canonicalize(state.base_home()).map_err(|_| "Resolve AGY ACP service profile failed")?;
    let _lock = service_lock(&root)?;
    let port = state.start_broker().await?;
    // Publication may already have been consumed by a task when the launching
    // GUI disappears. A broken readiness pipe must not kill that task's lease.
    let readiness = ready(port);
    let mut idle_since = None;
    loop {
        if state.has_active_turns() || state.host_leases.load(Ordering::SeqCst) > 0 {
            idle_since = None;
        } else if idle_since.get_or_insert_with(Instant::now).elapsed() >= grace {
            let mut pool = state.inner.lock().unwrap_or_else(|p| p.into_inner());
            // Serialize retirement against both checkout and host attachment.
            // An accepted lease must never race the last idle observation.
            if !state.has_active_turns() && state.host_leases.load(Ordering::SeqCst) == 0 {
                pool.shutting_down = true;
                break;
            }
            idle_since = None;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    state.kill_spawned();
    readiness
}
