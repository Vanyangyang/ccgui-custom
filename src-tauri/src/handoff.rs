//! One planned desktop replacement. The checkpoint and host capabilities stay in
//! the private profile; only the UI portion crosses the native command boundary.
use crate::live_update::{Compatibility, Limits, Transaction, TransactionPhase, UpdateStore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    LazyLock, Mutex,
};
use std::time::Duration;
use tauri::Emitter;
use tauri::Manager;

const CHECKPOINT_LIMIT: u64 = 256 * 1024 * 1024;
static OPERATIONS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static CURRENT: LazyLock<Mutex<Current>> = LazyLock::new(|| Mutex::new(Current::default()));
static PRESERVING: AtomicBool = AtomicBool::new(false);
type ObserverReply = tokio::sync::oneshot::Sender<Result<Value, String>>;
static OBSERVERS: LazyLock<Mutex<HashMap<String, ObserverReply>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static ACTIVITIES: LazyLock<Mutex<HashMap<&'static str, usize>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(crate) struct Activity(&'static str);
pub(crate) fn activity(kind: &'static str) -> Result<Activity, String> {
    let mut active = ACTIVITIES.lock().unwrap_or_else(|p| p.into_inner());
    if crate::worker_host::paused() {
        return Err("Runtime update is briefly pausing new native work".into());
    }
    *active.entry(kind).or_default() += 1;
    Ok(Activity(kind))
}
impl Drop for Activity {
    fn drop(&mut self) {
        let mut active = ACTIVITIES.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(count) = active.get_mut(self.0) {
            *count -= 1;
            if *count == 0 {
                active.remove(self.0);
            }
        }
    }
}
#[derive(Default)]
struct Current {
    restore: Option<Checkpoint>,
    fence: Option<(String, crate::host_chat::UpdateTicket)>,
    frontend_ready: bool,
    confirmed: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Checkpoint {
    version: u32,
    transaction_id: String,
    profile: PathBuf,
    previous_executable: PathBuf,
    ui: Value,
    cursors: HashMap<String, u64>,
    required_sources: HashMap<String, u64>,
    host_chat: crate::host_chat::HostCheckpoint,
    web: Option<crate::web::WebAccessInfo>,
    relay_was_connected: bool,
}

pub(crate) fn preserving_workers() -> bool {
    PRESERVING.load(Ordering::SeqCst) || has_resume()
}
fn store() -> Result<UpdateStore, String> {
    UpdateStore::open(&crate::paths::app_home(), Limits::default())
}
fn main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Updates are available only in the main local window".into())
    }
}
fn checkpoint_path(id: &str) -> Result<PathBuf, String> {
    if id.len() != 36 || uuid::Uuid::parse_str(id).is_err() {
        return Err("Invalid update transaction identity".into());
    }
    Ok(crate::paths::app_home()
        .join("runtime-updates/handoffs")
        .join(id)
        .join("checkpoint.json"))
}
fn canonical(path: &Path) -> Result<PathBuf, String> {
    dunce::canonicalize(path).map_err(|_| "Resolve update path failed".into())
}

fn save_checkpoint(checkpoint: &Checkpoint) -> Result<(), String> {
    let path = checkpoint_path(&checkpoint.transaction_id)?;
    let root = crate::paths::app_home().join("runtime-updates");
    for directory in [
        &root,
        &root.join("handoffs"),
        path.parent().ok_or("Missing checkpoint directory")?,
    ] {
        crate::task_worker::private_directory(directory).map_err(|error| error.message)?;
    }
    let bytes = serde_json::to_vec(checkpoint).map_err(|_| "Encode update checkpoint failed")?;
    if bytes.len() as u64 > CHECKPOINT_LIMIT {
        return Err("Update checkpoint exceeds the supported size".into());
    }
    let pending = path.with_extension("pending");
    let mut file = crate::task_worker::private_file(&pending).map_err(|error| error.message)?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Persist update checkpoint failed")?;
    drop(file);
    std::fs::rename(pending, path).map_err(|_| "Publish update checkpoint failed".into())
}

/// Called under GUI ownership, before any database migration or service startup.
pub(crate) fn load_resume(id: Option<&str>) -> Result<(), String> {
    let Some(id) = id else {
        return Ok(());
    };
    let update = store()?;
    let state = update.read_state()?;
    let transaction = state
        .transaction
        .as_ref()
        .ok_or("No update is available to resume")?;
    if transaction.id != id
        || !matches!(
            transaction.phase,
            TransactionPhase::Activating | TransactionPhase::RolledBack | TransactionPhase::Failed
        )
    {
        return Err("Update resume does not match the current transaction".into());
    }
    let path = checkpoint_path(id)?;
    if canonical(&path)? != path {
        return Err("Update checkpoint redirects outside its profile".into());
    }
    let meta =
        std::fs::symlink_metadata(&path).map_err(|_| "Read update checkpoint metadata failed")?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > CHECKPOINT_LIMIT {
        return Err("Invalid update checkpoint file".into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&path)
        .map_err(|_| "Open update checkpoint failed")?
        .take(CHECKPOINT_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Read update checkpoint failed")?;
    let checkpoint: Checkpoint =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid update checkpoint")?;
    if bytes.len() as u64 > CHECKPOINT_LIMIT
        || checkpoint.version != 1
        || checkpoint.transaction_id != id
        || checkpoint.profile != canonical(&crate::paths::app_home())?
    {
        return Err("Update checkpoint identity or version differs".into());
    }
    validate_ui(&checkpoint.ui, &checkpoint.cursors)?;
    let expected = if transaction.phase == TransactionPhase::Activating {
        update
            .release_path(&transaction.candidate)?
            .join(&transaction.candidate.executable)
    } else {
        checkpoint.previous_executable.clone()
    };
    if canonical(&std::env::current_exe().map_err(|_| "Read current executable failed")?)?
        != canonical(&expected)?
    {
        return Err("Update resume belongs to a different executable".into());
    }
    CURRENT.lock().unwrap_or_else(|p| p.into_inner()).restore = Some(checkpoint);
    crate::worker_host::set_paused(true);
    Ok(())
}

/// The original installed launcher follows the committed, verified release on
/// later ordinary opens. Explicit recovery is owned by the supervisor instead.
pub(crate) fn redirect_committed() -> Result<bool, String> {
    let state_path = crate::paths::app_home().join("runtime-updates/state.json");
    if !state_path.exists() {
        return Ok(false);
    }
    let update = store()?;
    let state = update.read_state()?;
    // A second ordinary launcher must not win the ownership gap between the
    // retiring host and the supervisor's explicitly checkpointed candidate.
    if state
        .transaction
        .as_ref()
        .is_some_and(|transaction| transaction.phase == TransactionPhase::Activating)
    {
        return Ok(true);
    }
    let Some(active) = state.active else {
        return Ok(false);
    };
    let directory = update.release_path(&active)?;
    crate::live_update::verify_release(&directory, &active.manifest_sha256, Limits::default())?;
    let executable = canonical(&directory.join(&active.executable))?;
    let current =
        canonical(&std::env::current_exe().map_err(|_| "Read current executable failed")?)?;
    if executable == current
        || launcher_supersedes_committed(
            &current,
            &executable,
            &state_path,
            &crate::paths::app_home().join("runtime-updates/releases"),
        )
    {
        return Ok(false);
    }
    let mut command = std::process::Command::new(executable);
    command.args(crate::paths::service_args("--live-update-open"));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
        .spawn()
        .map_err(|_| "Start committed update failed")?;
    Ok(true)
}

fn launcher_supersedes_committed(
    current: &Path,
    committed_executable: &Path,
    state_path: &Path,
    releases_root: &Path,
) -> bool {
    if let Ok(releases_root) = canonical(releases_root) {
        if current.starts_with(&releases_root) {
            return false;
        }
    }
    let Ok(current_mtime) = std::fs::metadata(current).and_then(|m| m.modified()) else {
        return false;
    };
    let Ok(state_mtime) = std::fs::metadata(state_path).and_then(|m| m.modified()) else {
        return false;
    };
    let Ok(committed_mtime) =
        std::fs::metadata(committed_executable).and_then(|m| m.modified())
    else {
        return false;
    };
    current_mtime > state_mtime && current_mtime > committed_mtime
}

pub(crate) async fn restore_services(
    app: &tauri::AppHandle,
    workers: &[crate::task_worker::WorkerManifest],
) -> Result<bool, String> {
    let restored = CURRENT
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .restore
        .clone();
    let Some(mut checkpoint) = restored else {
        return Ok(false);
    };
    checkpoint
        .host_chat
        .retain_runs(&workers.iter().map(|worker| worker.run_id.clone()).collect());
    crate::host_chat::restore(app, checkpoint.host_chat)?;
    let ticket = crate::host_chat::prepare_update(Duration::from_secs(5)).await?;
    CURRENT.lock().unwrap_or_else(|p| p.into_inner()).fence =
        Some((checkpoint.transaction_id, ticket));
    if let Some(web) = checkpoint.web {
        crate::web::restore_for_update(app.clone(), web).await?;
    }
    Ok(true)
}

pub(crate) fn has_resume() -> bool {
    CURRENT
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .restore
        .is_some()
}

pub(crate) async fn restore_sources() -> Result<(), String> {
    let saved = CURRENT
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .restore
        .clone();
    if let Some(saved) = saved {
        crate::worker_host::ensure_sources(&saved.required_sources).await?;
        crate::worker_host::ensure_sources(&saved.cursors).await?;
    }
    Ok(())
}

async fn blockers(app: &tauri::AppHandle) -> Vec<String> {
    let state = app.state::<crate::AppState>();
    let mut blockers = crate::worker_host::blockers(&state.processes).await;
    if !state.terminals.lock().await.is_empty() {
        blockers.push("terminal-sessions".into());
    }
    if state
        .worktree_creations
        .snapshot()
        .iter()
        .any(|creation| creation.active)
    {
        blockers.push("worktree-creation".into());
    }
    if crate::auto_title::has_pending() {
        blockers.push("auto-title-pending".into());
    }
    if crate::plugin_caps::has_tracked_children() {
        blockers.push("plugin-processes".into());
    }
    blockers.extend(
        ACTIVITIES
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .keys()
            .map(|kind| (*kind).to_string()),
    );
    if !CURRENT
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .frontend_ready
    {
        blockers.push("frontend-not-ready".into());
    }
    blockers
}

static ACTIVE_AUTO_BUILDS: LazyLock<Mutex< std::collections::HashSet<String>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));

fn ensure_auto_build() {
    let Ok(update) = store() else { return; };
    let Ok(Some(batch)) = update.poll_update_request() else { return; };
    if !ACTIVE_AUTO_BUILDS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(batch.id.clone())
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let batch_id = batch.id.clone();
        let owner = batch.owner.clone();
        if let Err(reason) = run_auto_build_batch(batch).await {
            let released = store().and_then(|update| {
                update.coordinate_update(
                    owner,
                    crate::live_update::channel::Request::abort_after_failure(batch_id.clone(), &reason),
                ).map(|_| ())
            });
            if let Err(error) = released {
                eprintln!("self-update batch {batch_id} failure could not release its channel: {error}");
            }
        }
        ACTIVE_AUTO_BUILDS
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&batch_id);
    });
}

async fn run_auto_build_batch(batch: crate::live_update::channel::Batch) -> Result<(), String> {
    use tokio::io::AsyncReadExt;
    let root = PathBuf::from(&batch.source_root);
    let script = root.join("scripts/self-update-build.mjs");
    if !script.is_file() {
        return Err("sourceRoot does not contain scripts/self-update-build.mjs".into());
    }
    let cache_dir = root.join(".artifacts/self-update-cache");
    let packages_dir = root.join(".artifacts/self-update-packages");
    std::fs::create_dir_all(&cache_dir).map_err(|e| format!("create self-update cache dir: {e}"))?;
    std::fs::create_dir_all(&packages_dir).map_err(|e| format!("create self-update packages dir: {e}"))?;
    let batch_file = cache_dir.join(format!("batch-{}.json", batch.id));
    let batch_bytes = serde_json::to_vec_pretty(&batch).map_err(|e| e.to_string())?;
    std::fs::write(&batch_file, batch_bytes).map_err(|e| format!("write batch file: {e}"))?;
    let output_dir = packages_dir.join(format!("pkg-{}", batch.id));
    let short_id: String = batch.id.chars().take(8).collect();
    let release_id = format!("auto-{short_id}");
    let node = {
        let win_node = PathBuf::from(r"C:\Program Files\nodejs\node.exe");
        if win_node.is_file() { win_node } else { PathBuf::from("node") }
    };
    let mut command = tokio::process::Command::new(node);
    command
        .arg(&script)
        .args([
            "--mode",
            "working-tree",
            "--capture-snapshot",
            "--batch-file",
            &batch_file.to_string_lossy(),
            "--output",
            &output_dir.to_string_lossy(),
            "--release-id",
            &release_id,
        ])
        .current_dir(&root)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command.spawn().map_err(|e| format!("spawn self-update builder failed: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("builder stdout unavailable")?;
    let mut stderr = child.stderr.take().ok_or("builder stderr unavailable")?;
    let status = tokio::time::timeout(Duration::from_secs(1800), child.wait())
        .await
        .map_err(|_| {
            let _ = child.start_kill();
            "self-update build timed out".to_string()
        })?
        .map_err(|e| format!("wait for self-update builder failed: {e}"))?;
    let mut out_bytes = Vec::new();
    let _ = stdout.take(1024 * 1024).read_to_end(&mut out_bytes).await;
    let mut err_bytes = Vec::new();
    let _ = stderr.take(64 * 1024).read_to_end(&mut err_bytes).await;
    if !status.success() {
        let err_text = String::from_utf8_lossy(&err_bytes).trim().to_string();
        return Err(if err_text.is_empty() {
            format!("self-update builder exited with {status}")
        } else {
            err_text.chars().take(500).collect()
        });
    }
    let report: Value = serde_json::from_slice(&out_bytes)
        .map_err(|_| "parse self-update build report failed".to_string())?;
    let package_dir = report["package"]["output"]
        .as_str()
        .ok_or("build report missing package.output")?
        .to_string();
    let manifest_sha256 = report["package"]["manifestSha256"]
        .as_str()
        .ok_or("build report missing package.manifestSha256")?
        .to_string();
    prepare_self_update(package_dir, manifest_sha256, batch.owner, Some(batch.id)).await?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn live_update_request(
    window: tauri::WebviewWindow,
    request_id: String,
    source_root: Option<String>,
) -> Result<crate::live_update::channel::Reply, String> {
    main_window(&window)?;
    let operation = OPERATIONS.lock().await;
    let reply = store()?.request_update_from_main_window_with_source(request_id, source_root)?;
    drop(operation);
    ensure_auto_build();
    Ok(reply)
}

#[tauri::command]
pub(crate) async fn live_update_status(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    main_window(&window)?;
    ensure_auto_build();
    Ok(
        json!({"supported":true,"state":store()?.read_state()?,"channel":store()?.channel_status()?,"blockers":blockers(&app).await,
        "pendingHandoff":preserving_workers() || has_resume()}),
    )
}

/// Native authenticated HostChat capability. Reading a matching hash does not
/// imply that the candidate has committed or that the client received a reply.
pub(crate) async fn self_update_status(
    app: &tauri::AppHandle,
    worker_owned: bool,
    manifest_sha256: Option<&str>,
) -> Result<Value, String> {
    if let Some(hash) = manifest_sha256 { validate_update_hash(hash)?; }
    ensure_auto_build();
    let state = store()?.read_state()?;
    Ok(json!({
        "supported": true,
        "prepareSupported": true,
        "unsupportedReason": Value::Null,
        // A desktop-owned origin (Leader, computer-use...) cannot be carried across
        // the switch, so activation waits for it to finish.
        "originWorkerOwned": worker_owned,
        "activationWaitsForOrigin": !worker_owned,
        "matchesTransaction": manifest_sha256.map(|hash| state.transaction.as_ref().is_some_and(|tx| tx.candidate.manifest_sha256 == hash)),
        "matchesActive": manifest_sha256.map(|hash| state.active.as_ref().is_some_and(|active| active.manifest_sha256 == hash)),
        "requestedManifestSha256": manifest_sha256,
        "state": state,
        "channel": store()?.channel_status()?,
        "blockers": blockers(app).await,
        "pendingHandoff": preserving_workers() || has_resume(),
    }))
}

pub(crate) fn validate_update_hash(hash: &str) -> Result<(), String> {
    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
        return Err("manifestSha256 must contain exactly 64 lowercase hexadecimal characters".into());
    }
    Ok(())
}

pub(crate) fn validate_update_package(source: &str, hash: &str) -> Result<(), String> {
    validate_update_hash(hash)?;
    if source.is_empty() || source.chars().count() > 4096
        || source.chars().any(char::is_control) || source.contains("://")
        || !Path::new(source).is_absolute()
    {
        return Err("packageDir must be an absolute local package directory path (maximum 4096 characters), not a URL".into());
    }
    Ok(())
}

/// Only stage and persist Preparing. The frontend's existing update owner begins
/// handoff after this admitted HostChat call can finish and enter its receipt.
pub(crate) async fn coordinate_self_update(owner: crate::live_update::channel::Owner, request: crate::live_update::channel::Request) -> Result<Value, String> {
    let _operation = OPERATIONS.lock().await;
    let reply = store()?.coordinate_update(owner, request)?;
    let value = serde_json::to_value(reply).map_err(|e| e.to_string())?;
    drop(_operation);
    ensure_auto_build();
    Ok(value)
}

pub(crate) async fn prepare_self_update(source: String, manifest_sha256: String, owner: crate::live_update::channel::Owner, batch_id: Option<String>) -> Result<Value, String> {
    validate_update_package(&source, &manifest_sha256)?;
    let _operation = OPERATIONS.lock().await;
    let update = store()?;
    update.bind_update_package(&owner, batch_id.as_deref(), &manifest_sha256, Path::new(&source))?;
    let transaction = stage_update_locked(update, source, manifest_sha256).await?;
    Ok(json!({
        "accepted": !matches!(transaction.phase, TransactionPhase::Failed | TransactionPhase::RolledBack),
        "transactionId": transaction.id,
        "phase": transaction.phase,
        "manifestSha256": transaction.candidate.manifest_sha256,
    }))
}

#[tauri::command]
pub(crate) async fn live_update_stage(
    window: tauri::WebviewWindow,
    source: String,
    manifest_sha256: String,
) -> Result<Transaction, String> {
    main_window(&window)?;
    stage_update(source, manifest_sha256).await
}

async fn stage_update(source: String, manifest_sha256: String) -> Result<Transaction, String> {
    validate_update_package(&source, &manifest_sha256)?;
    stage_update_in_store(store()?, source, manifest_sha256).await
}

async fn stage_update_in_store(update: UpdateStore, source: String, manifest_sha256: String) -> Result<Transaction, String> {
    let _operation = OPERATIONS.lock().await;
    stage_update_locked(update, source, manifest_sha256).await
}

async fn stage_update_locked(update: UpdateStore, source: String, manifest_sha256: String) -> Result<Transaction, String> {
    update.check_channel_candidate(&manifest_sha256)?;
    let state = update.read_state()?;
    if let Some(transaction) = state.transaction {
        // A durable result is authoritative even if the caller lost its reply or
        // the source package has since disappeared. Never retry a failed release.
        if transaction.candidate.manifest_sha256 == manifest_sha256 { return Ok(transaction); }
        if matches!(transaction.phase, TransactionPhase::Preparing | TransactionPhase::Ready | TransactionPhase::Activating)
            || (transaction.phase == TransactionPhase::Failed
                && transaction.failure_reason == Some(crate::live_update::FailureReason::CandidateIdentityUnknown)) {
            return Err("an update transaction is already pending".into());
        }
    }
    let expected = Compatibility {
        worker_protocol: crate::task_worker::PROTOCOL,
        checkpoint_schema: 1,
        schema_hash: crate::task_worker::schema_hash(),
    };
    let expected_for_stage = expected.clone();
    let (update, candidate) = tauri::async_runtime::spawn_blocking(move || {
        let source_path = Path::new(&source);
        let candidate = update.stage_compatible(source_path, &manifest_sha256, Some(&expected_for_stage))?;
        crate::launch_protection::verify_update_candidate(&update.release_path(&candidate)?.join(&candidate.executable))?;
        Ok::<_, String>((update, candidate))
    })
    .await
    .map_err(|_| "Stage update task failed".to_string())??;
    probe_candidate(&update.release_path(&candidate)?.join(&candidate.executable), &candidate).await?;
    update.prepare(candidate, &expected)
}

async fn probe_candidate(executable:&Path, candidate:&crate::live_update::ReleaseIdentity) -> Result<(),String> {
    use tokio::io::AsyncReadExt;
    let mut command = tokio::process::Command::new(executable);
    command.arg("--task-worker-probe").stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command.spawn().map_err(|_| "Start candidate compatibility probe failed")?;
    let output = child.stdout.take().ok_or("Candidate probe output is unavailable")?;
    let checked = tokio::time::timeout(Duration::from_secs(5), async {
        let mut bytes = Vec::new();
        output.take(64*1024+1).read_to_end(&mut bytes).await.map_err(|_| "Read candidate compatibility probe failed")?;
        if bytes.len() > 64*1024 || !child.wait().await.map_err(|_| "Wait for candidate compatibility probe failed")?.success() {
            return Err("Candidate compatibility probe failed".to_string());
        }
        let value:Value = serde_json::from_slice(&bytes).map_err(|_| "Candidate has no compatible runtime probe")?;
        validate_candidate_probe(&value, candidate, crate::launch_protection::update_protection_required())?;
        Ok(value)
    }).await;
    let value = match checked {
        Ok(result) => result?,
        Err(_) => { let _ = child.start_kill(); return Err("Candidate compatibility probe timed out".into()); },
    };
    let root = executable.parent().ok_or("Candidate release directory is missing")?.to_path_buf();
    let hash = candidate.manifest_sha256.clone();
    tauri::async_runtime::spawn_blocking(move || crate::frontend_assets::validate_candidate(&root, &hash, &value))
        .await.map_err(|_| "Candidate frontend verification task failed".to_string())?
}

fn validate_candidate_probe(value: &Value, candidate: &crate::live_update::ReleaseIdentity, protection_required: bool) -> Result<(), String> {
        if protection_required && value["capabilities"]["launchProtection"] != 1 {
            return Err("Candidate does not support protected launch after self-update".into());
        }
        if value["protocol"] != candidate.worker_protocol || value["checkpointSchema"] != candidate.checkpoint_schema
            || value["schemaHash"].as_str() != Some(candidate.schema_hash.as_str())
            || value["capabilities"]["eventReplay"] != true || value["capabilities"]["commandDeduplication"] != true
            || value["capabilities"]["hostChat"] != true {
            return Err("Candidate binary differs from its declared runtime compatibility".into());
        }
        Ok(())
}

#[tauri::command]
pub(crate) async fn live_update_begin(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    transaction_id: String,
) -> Result<(), String> {
    main_window(&window)?;
    let _operation = OPERATIONS.lock().await;
    let state = store()?.read_state()?;
    let transaction = state.transaction.ok_or("No prepared update")?;
    if transaction.id != transaction_id || transaction.phase != TransactionPhase::Preparing {
        return Err("Update transaction is no longer preparing".into());
    }
    if CURRENT
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .fence
        .is_some()
    {
        return Err("Update handoff already owns admission".into());
    }
    let found = blockers(&app).await;
    if !found.is_empty() {
        return Err(format!("Update is waiting: {}", found.join(", ")));
    }
    let candidate_executable = store()?.release_path(&transaction.candidate)?.join(&transaction.candidate.executable);
    tauri::async_runtime::spawn_blocking(move || crate::launch_protection::verify_update_candidate(&candidate_executable))
        .await.map_err(|_| "Candidate protection check failed".to_string())??;
    let ticket = crate::host_chat::prepare_update(Duration::from_secs(15)).await?;
    if let Err(error) = crate::worker_host::quiesce().await {
        let _ = crate::host_chat::abort_update(&ticket);
        return Err(error);
    }
    let found = blockers(&app).await;
    if !found.is_empty() {
        crate::worker_host::set_paused(false);
        let _ = crate::host_chat::abort_update(&ticket);
        return Err(format!("Update is waiting: {}", found.join(", ")));
    }
    CURRENT.lock().unwrap_or_else(|p| p.into_inner()).fence = Some((transaction_id, ticket));
    Ok(())
}

fn validate_ui(checkpoint: &Value, cursors: &HashMap<String, u64>) -> Result<(), String> {
    if checkpoint["version"] != 1
        || !checkpoint["participants"].is_object()
        || cursors.len() > 4096
        || cursors.iter().any(|(id, seq)| {
            id.len() != 36 || uuid::Uuid::parse_str(id).is_err() || *seq > 9_007_199_254_740_991
        })
    {
        return Err("Invalid UI checkpoint or worker cursors".into());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn live_update_activate(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    transaction_id: String,
    checkpoint: Value,
    cursors: HashMap<String, u64>,
) -> Result<(), String> {
    main_window(&window)?;
    let _operation = OPERATIONS.lock().await;
    validate_ui(&checkpoint, &cursors)?;
    let ticket = CURRENT
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .fence
        .as_ref()
        .filter(|(id, _)| id == &transaction_id)
        .map(|(_, ticket)| ticket.clone())
        .ok_or("Update admission is not owned by this transaction")?;
    let update = store()?;
    let transaction = update
        .read_state()?
        .transaction
        .ok_or("No prepared update")?;
    if transaction.id != transaction_id || transaction.phase != TransactionPhase::Preparing {
        return Err("Update transaction is no longer preparing".into());
    }
    let found = blockers(&app).await;
    if !found.is_empty() {
        return Err(format!("Update is waiting: {}", found.join(", ")));
    }
    let (executable, start_time) =
        crate::live_update::activation::process_identity(std::process::id())?
            .ok_or("Current process identity is unavailable")?;
    let saved = Checkpoint {
        version: 1,
        transaction_id: transaction_id.clone(),
        profile: canonical(&crate::paths::app_home())?,
        previous_executable: executable.clone(),
        ui: checkpoint,
        cursors,
        required_sources: crate::worker_host::required_sources(),
        host_chat: crate::host_chat::checkpoint(&ticket)?,
        web: crate::web::web_access_status(app.clone()),
        relay_was_connected: crate::relay::web_relay_status(app.clone())
            .is_some_and(|relay| relay.connected),
    };
    save_checkpoint(&saved)?;
    update.ready(&transaction_id)?;
    update.activating(&transaction_id)?;
    crate::live_update::activation::spawn_supervisor(
        crate::live_update::activation::SupervisorConfig {
            transaction_id: transaction_id.clone(),
            previous_executable: executable,
            candidate_executable: update
                .release_path(&transaction.candidate)?
                .join(&transaction.candidate.executable),
            old_pid: std::process::id(),
            old_process_start_time: start_time,
            health_timeout_ms: 120_000,
        },
    )
    .await?;
    PRESERVING.store(true, Ordering::SeqCst);
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(250)).await;
        crate::worker_host::shutdown(true).await;
        crate::host_chat::shutdown();
        app.exit(0);
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn live_update_abort(
    window: tauri::WebviewWindow,
    transaction_id: String,
    defer: Option<bool>,
) -> Result<(), String> {
    main_window(&window)?;
    let _operation = OPERATIONS.lock().await;
    if preserving_workers() {
        return Err("Update activation has already transferred ownership".into());
    }
    let update = store()?;
    let transaction = update
        .read_state()?
        .transaction
        .ok_or("No update transaction")?;
    if transaction.id != transaction_id {
        return Err("Cannot abort another update transaction".into());
    }
    if !matches!(
        transaction.phase,
        TransactionPhase::Preparing
            | TransactionPhase::Ready
            | TransactionPhase::Failed
            | TransactionPhase::Activating
    ) {
        return Err("Update transaction cannot be aborted".into());
    }
    if has_resume() {
        return Err("Candidate recovery cannot resume the retired desktop".into());
    }
    let keep_preparing = defer == Some(true) && transaction.phase == TransactionPhase::Preparing;
    if !keep_preparing && transaction.phase != TransactionPhase::Failed {
        update.fail(&transaction_id)?;
    }
    let fence = CURRENT
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .fence
        .take();
    let result = fence
        .map(|(_, ticket)| crate::host_chat::abort_update(&ticket))
        .unwrap_or(Ok(()));
    crate::worker_host::set_paused(false);
    result
}

#[tauri::command]
pub(crate) fn live_update_bootstrap(window: tauri::WebviewWindow) -> Result<Value, String> {
    main_window(&window)?;
    let current = CURRENT.lock().unwrap_or_else(|p| p.into_inner());
    Ok(current
        .restore
        .as_ref()
        .map(|checkpoint| {
            json!({"transactionId":checkpoint.transaction_id,
        "checkpoint":checkpoint.ui,"cursors":checkpoint.cursors})
        })
        .unwrap_or(Value::Null))
}

const RESTART_RESUME_TTL_MS: u64 = 5 * 60 * 1000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestartResumeSession {
    pub engine: String,
    pub session_id: String,
    pub workspace_path: String,
    #[serde(default = "default_restart_resume_prompt")]
    pub prompt: String,
}

fn default_restart_resume_prompt() -> String {
    "继续".to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestartResumeRecord {
    version: u32,
    created_at_ms: u64,
    sessions: Vec<RestartResumeSession>,
}

fn restart_resume_path_in(home: &Path) -> PathBuf {
    home.join("runtime-updates/restart-resume.json")
}

fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(crate) fn save_restart_resumes_in(
    home: &Path,
    sessions: Vec<RestartResumeSession>,
    now_ms: u64,
) -> Result<(), String> {
    let path = restart_resume_path_in(home);
    if sessions.is_empty() {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    let _ = UpdateStore::open(home, Limits::default())?;
    let record = RestartResumeRecord {
        version: 1,
        created_at_ms: now_ms,
        sessions,
    };
    let bytes = serde_json::to_vec(&record).map_err(|_| "Encode restart resume record failed")?;
    let pending = path.with_extension("pending");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&pending)
        .map_err(|_| "Open restart resume record failed")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Persist restart resume record failed")?;
    drop(file);
    std::fs::rename(pending, path).map_err(|_| "Publish restart resume record failed".into())
}

pub(crate) fn take_restart_resumes_in(home: &Path, now_ms: u64) -> Vec<RestartResumeSession> {
    let path = restart_resume_path_in(home);
    let Ok(bytes) = std::fs::read(&path) else {
        return Vec::new();
    };
    let _ = std::fs::remove_file(&path);
    let Ok(record) = serde_json::from_slice::<RestartResumeRecord>(&bytes) else {
        return Vec::new();
    };
    if record.version != 1
        || now_ms.saturating_sub(record.created_at_ms) > RESTART_RESUME_TTL_MS
    {
        return Vec::new();
    }
    record
        .sessions
        .into_iter()
        .filter(|item| {
            !item.engine.trim().is_empty()
                && !item.session_id.trim().is_empty()
                && !item.workspace_path.trim().is_empty()
        })
        .collect()
}

pub(crate) fn record_restart_resumes_for_active_runs() {
    let sessions: Vec<RestartResumeSession> =
        crate::host_chat::active_sessions_for_restart(!preserving_workers())
            .into_iter()
            .map(|(engine, session_id, workspace_path)| RestartResumeSession {
                engine,
                session_id,
                workspace_path,
                prompt: default_restart_resume_prompt(),
            })
            .collect();
    if !sessions.is_empty() {
        let _ = save_restart_resumes_in(&crate::paths::app_home(), sessions, now_unix_ms());
    }
}

#[tauri::command]
pub(crate) fn live_update_frontend_ready(window: tauri::WebviewWindow) -> Result<Value, String> {
    main_window(&window)?;
    if has_resume() {
        return Err("A recovering frontend must confirm its transaction".into());
    }
    CURRENT
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .frontend_ready = true;
    let resume_sessions = take_restart_resumes_in(&crate::paths::app_home(), now_unix_ms());
    if resume_sessions.is_empty() {
        Ok(Value::Null)
    } else {
        Ok(json!({ "resumeSessions": resume_sessions }))
    }
}

#[tauri::command]
pub(crate) async fn live_update_confirm(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    transaction_id: String,
) -> Result<(), String> {
    main_window(&window)?;
    let _operation = OPERATIONS.lock().await;
    if CURRENT
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .confirmed
        .as_deref()
        == Some(&transaction_id)
    {
        return Ok(());
    }
    let checkpoint = CURRENT
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .restore
        .clone()
        .ok_or("No recovering frontend")?;
    if checkpoint.transaction_id != transaction_id {
        return Err("Frontend recovery identity differs".into());
    }
    let ticket = CURRENT
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .fence
        .as_ref()
        .filter(|(id, _)| id == &transaction_id)
        .map(|(_, ticket)| ticket.clone())
        .ok_or("Recovery admission fence is unavailable")?;
    crate::host_chat::checkpoint(&ticket)?;
    crate::worker_host::ensure_sources(&checkpoint.required_sources).await?;
    crate::worker_host::ensure_sources(&checkpoint.cursors).await?;
    if checkpoint.relay_was_connected {
        tokio::time::timeout(Duration::from_secs(30), async {
            while !crate::relay::web_relay_status(app.clone()).is_some_and(|relay| relay.connected)
            {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        })
        .await
        .map_err(|_| "Remote relay has not recovered")?;
    }
    let found = crate::worker_host::blockers(&app.state::<crate::AppState>().processes).await;
    if !found.is_empty() {
        return Err(format!(
            "Recovered tasks are not healthy: {}",
            found.join(", ")
        ));
    }
    let update = store()?;
    let transaction = update
        .read_state()?
        .transaction
        .ok_or("No recovery transaction")?;
    let expected = if matches!(
        transaction.phase,
        TransactionPhase::Activating | TransactionPhase::Committed
    ) {
        update
            .release_path(&transaction.candidate)?
            .join(&transaction.candidate.executable)
    } else {
        checkpoint.previous_executable.clone()
    };
    if canonical(&std::env::current_exe().map_err(|_| "Read recovery executable failed")?)?
        != canonical(&expected)?
    {
        return Err("Recovery ownership moved to another executable".into());
    }
    #[cfg(feature = "test-harness")]
    if crate::test_harness::runtime_fixture_enabled()
        && transaction.phase == TransactionPhase::Activating
        && std::env::var("CCGUI_RUNTIME_FIXTURE_FAIL_HEALTH_RELEASE").as_deref()
            == Ok(transaction.candidate.release_id.as_str())
    {
        return Err("Fixture candidate health rejection".into());
    }
    match transaction.phase {
        TransactionPhase::Activating => {
            update.confirm_healthy(&transaction_id)?;
        }
        TransactionPhase::RolledBack | TransactionPhase::Failed | TransactionPhase::Committed => {}
        _ => return Err("Recovery transaction already changed".into()),
    }
    crate::host_chat::abort_update(&ticket)?;
    let mut current = CURRENT.lock().unwrap_or_else(|p| p.into_inner());
    current.restore = None;
    current.fence = None;
    current.frontend_ready = true;
    current.confirmed = Some(transaction_id);
    crate::worker_host::set_paused(false);
    Ok(())
}

/// A newly connected viewer needs the exact chat prefix for its source cursors,
/// not a mixture of current CLI history and a replay starting at sequence zero.
pub(crate) async fn runtime_observer_snapshot(app: tauri::AppHandle) -> Result<Value, String> {
    tokio::time::timeout(Duration::from_secs(30), async {
        while !CURRENT
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .frontend_ready
            || crate::worker_host::paused()
        {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .map_err(|_| "Desktop chat snapshot is waiting for recovery")?;
    // Legacy engine transports have no replay cursor. Preserve their existing
    // history-based viewer boot until those runs finish, instead of promising
    // a complete cut across two different delivery contracts.
    if crate::worker_host::blockers(&app.state::<crate::AppState>().processes)
        .await
        .iter()
        .any(|reason| reason == "legacy-runs")
    {
        return Ok(Value::Null);
    }
    let (reply, receive) = tokio::sync::oneshot::channel();
    let request_id = uuid::Uuid::new_v4().to_string();
    {
        let mut pending = OBSERVERS.lock().unwrap_or_else(|p| p.into_inner());
        if pending.len() >= 4 {
            return Err("Desktop chat snapshot queue is full".into());
        }
        pending.insert(request_id.clone(), reply);
    }
    struct Remove(String);
    impl Drop for Remove {
        fn drop(&mut self) {
            OBSERVERS
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&self.0);
        }
    }
    let _remove = Remove(request_id.clone());
    app.get_webview_window("main")
        .ok_or("Desktop chat window is unavailable")?
        .emit(
            "runtime://observer-snapshot",
            json!({"requestId":request_id}),
        )
        .map_err(|_| "Request desktop chat snapshot failed")?;
    tokio::time::timeout(Duration::from_secs(15), receive)
        .await
        .map_err(|_| "Desktop chat snapshot timed out")?
        .map_err(|_| "Desktop chat snapshot owner closed")?
}

#[tauri::command]
pub(crate) fn runtime_observer_respond(
    window: tauri::WebviewWindow,
    request_id: String,
    snapshot: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    main_window(&window)?;
    let response = match (snapshot, error) {
        (Some(snapshot), None) => {
            let participants = snapshot["checkpoint"]["participants"]
                .as_object()
                .ok_or("Invalid observer checkpoint")?;
            if snapshot["observer"] != true
                || participants.len() != 1
                || !participants.contains_key("chat")
                || serde_json::to_vec(&snapshot)
                    .map_err(|_| "Encode observer checkpoint failed")?
                    .len()
                    > 32 * 1024 * 1024
            {
                return Err("Invalid or oversized observer checkpoint".into());
            }
            let cursors: HashMap<String, u64> = serde_json::from_value(snapshot["cursors"].clone())
                .map_err(|_| "Invalid observer cursors")?;
            validate_ui(&snapshot["checkpoint"], &cursors)?;
            Ok(snapshot)
        }
        (None, Some(error)) if error.len() <= 2048 => Err(error),
        _ => return Err("Expected one observer snapshot or error".into()),
    };
    OBSERVERS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(&request_id)
        .ok_or("Observer snapshot request expired")?
        .send(response)
        .map_err(|_| "Observer snapshot request closed".into())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn protected_self_update_rejects_candidate_without_launch_guard() {
        let candidate = crate::live_update::ReleaseIdentity {
            manifest_sha256: "a".repeat(64), channel: "protected-custom".into(),
            release_id: "protected".into(), version: "1.0.0".into(),
            worker_protocol: crate::task_worker::PROTOCOL, checkpoint_schema: 1,
            schema_hash: crate::task_worker::schema_hash(), executable: "ccgui-next.exe".into(),
        };
        let mut probe = crate::task_worker::probe();
        assert!(validate_candidate_probe(&probe, &candidate, true).is_ok());
        probe["capabilities"].as_object_mut().unwrap().remove("launchProtection");
        assert!(validate_candidate_probe(&probe, &candidate, true).unwrap_err().contains("protected launch"));
        assert!(validate_candidate_probe(&probe, &candidate, false).is_ok());
        probe["capabilities"]["launchProtection"] = json!(1);
        probe["schemaHash"] = json!("0".repeat(64));
        assert!(validate_candidate_probe(&probe, &candidate, true).is_err());
    }

    // A real verified release/store transaction, with a deliberately non-PE
    // executable: returning this receipt must not copy or run its probe again.
    pub(crate) fn prepared_update(profile: &Path) -> (UpdateStore, Transaction) {
        let source = profile.join("self-update-test-package");
        std::fs::create_dir(&source).unwrap();
        let executable = b"receipt fixture, not an executable";
        std::fs::write(source.join("ccgui-next.exe"), executable).unwrap();
        let manifest = crate::live_update::ReleaseManifest {
            manifest_version: 1, channel: "protected-custom".into(), release_id: "self-update-test".into(),
            version: "1.0.0".into(), worker_protocol: crate::task_worker::PROTOCOL,
            checkpoint_schema: 1, schema_hash: crate::task_worker::schema_hash(),
            executable: "ccgui-next.exe".into(),
            files: vec![crate::live_update::ReleaseFile {
                path: "ccgui-next.exe".into(), bytes: executable.len() as u64,
                sha256: format!("{:x}", Sha256::digest(executable)),
            }],
        };
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        std::fs::write(source.join("manifest.json"), bytes).unwrap();
        let update = UpdateStore::open(profile, Limits::default()).unwrap();
        let candidate = update.stage(&source, &hash).unwrap();
        let transaction = update.prepare(candidate, &Compatibility {
            worker_protocol: crate::task_worker::PROTOCOL, checkpoint_schema: 1,
            schema_hash: crate::task_worker::schema_hash(),
        }).unwrap();
        (update, transaction)
    }

    #[tokio::test]
    async fn self_update_same_hash_reuses_each_persisted_phase_without_copy_or_probe() {
        struct Scratch(PathBuf);
        impl Drop for Scratch { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
        for phase in [TransactionPhase::Preparing, TransactionPhase::Ready, TransactionPhase::Activating,
            TransactionPhase::Committed, TransactionPhase::Failed, TransactionPhase::RolledBack] {
            let root = Scratch(std::env::temp_dir().join(format!("ccgui-self-update-{}", uuid::Uuid::new_v4())));
            std::fs::create_dir(&root.0).unwrap();
            let (update, initial) = prepared_update(&root.0);
            match phase {
                TransactionPhase::Preparing => (),
                TransactionPhase::Ready => { update.ready(&initial.id).unwrap(); },
                TransactionPhase::Activating | TransactionPhase::Committed => {
                    update.ready(&initial.id).unwrap(); update.activating(&initial.id).unwrap();
                    if phase == TransactionPhase::Committed { update.confirm_healthy(&initial.id).unwrap(); }
                },
                TransactionPhase::Failed | TransactionPhase::RolledBack => {
                    update.fail(&initial.id).unwrap();
                    if phase == TransactionPhase::RolledBack { update.rollback(&initial.id).unwrap(); }
                },
            }
            let before = update.read_state().unwrap();
            let state_file = root.0.join("runtime-updates/state.json");
            let before_bytes = std::fs::read(&state_file).unwrap();
            let reused = stage_update_in_store(update, root.0.join("missing-package").to_string_lossy().into_owned(),
                initial.candidate.manifest_sha256).await.unwrap();
            assert_eq!(reused, before.transaction.unwrap());
            assert_eq!(reused.phase, phase);
            assert_eq!(std::fs::read(&state_file).unwrap(), before_bytes);
        }
    }

    #[tokio::test]
    async fn self_update_different_hash_pending_is_rejected_before_source_access() {
        let root = std::env::temp_dir().join(format!("ccgui-self-update-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let (update, initial) = prepared_update(&root);
        let result = stage_update_in_store(update, root.join("missing-package").to_string_lossy().into_owned(), "0".repeat(64)).await;
        assert_eq!(result.unwrap_err(), "an update transaction is already pending");
        assert_eq!(UpdateStore::open(&root, Limits::default()).unwrap().read_state().unwrap().transaction.unwrap(), initial);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn checkpoint_rejects_non_json_shape_unsafe_cursor_and_path_identity() {
        let ui = json!({"version":1,"participants":{}});
        let id = uuid::Uuid::new_v4().to_string();
        assert!(validate_ui(&ui, &HashMap::from([(id.clone(), 42)])).is_ok());
        assert!(validate_ui(&ui, &HashMap::from([(id, u64::MAX)])).is_err());
        assert!(validate_ui(&json!({"version":2,"participants":{}}), &HashMap::new()).is_err());
        assert!(checkpoint_path("../other").is_err());
    }

    #[tokio::test]
    async fn self_update_incompatible_schema_is_rejected_before_staging_or_probe() {
        let root = std::env::temp_dir().join(format!("ccgui-self-update-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let source = root.join("incompatible-package");
        std::fs::create_dir(&source).unwrap();
        let executable = b"not a valid PE binary; must never be staged or probed";
        std::fs::write(source.join("ccgui-next.exe"), executable).unwrap();
        let manifest = crate::live_update::ReleaseManifest {
            manifest_version: 1,
            channel: "protected-custom".into(),
            release_id: "incompatible-test".into(),
            version: "1.0.0".into(),
            worker_protocol: crate::task_worker::PROTOCOL,
            checkpoint_schema: 1,
            schema_hash: "0".repeat(64),
            executable: "ccgui-next.exe".into(),
            files: vec![crate::live_update::ReleaseFile {
                path: "ccgui-next.exe".into(),
                bytes: executable.len() as u64,
                sha256: format!("{:x}", Sha256::digest(executable)),
            }],
        };
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        std::fs::write(source.join("manifest.json"), bytes).unwrap();
        let update = UpdateStore::open(&root, Limits::default()).unwrap();
        let err = stage_update_in_store(
            update,
            source.to_string_lossy().into_owned(),
            hash.clone(),
        )
        .await
        .unwrap_err();
        assert_eq!(err, "database schema hash mismatch");
        assert!(!root.join("runtime-updates/releases").join(&hash).exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn launcher_supersedes_committed_only_when_external_launcher_is_newer_than_state_and_release() {
        let root = std::env::temp_dir().join(format!("ccgui-redirect-{}", uuid::Uuid::new_v4()));
        let releases = root.join("runtime-updates/releases");
        let committed_dir = releases.join("a".repeat(64));
        std::fs::create_dir_all(&committed_dir).unwrap();
        let state_path = root.join("runtime-updates/state.json");
        let committed_exe = committed_dir.join("ccgui-next.exe");
        let launcher_exe = root.join("installed-ccgui-next.exe");
        std::fs::write(& launcher_exe, b"old launcher").unwrap();
        std::thread::sleep(Duration::from_millis(25));
        std::fs::write(&committed_exe, b"committed release").unwrap();
        std::fs::write(&state_path, b"{}").unwrap();
        assert!(!launcher_supersedes_committed(
            &canonical(&launcher_exe).unwrap(),
            &canonical(&committed_exe).unwrap(),
            &state_path,
            &releases,
        ));
        std::thread::sleep(Duration::from_millis(25));
        std::fs::write(&launcher_exe, b"upgraded offline launcher").unwrap();
        assert!(launcher_supersedes_committed(
            &canonical(&launcher_exe).unwrap(),
            &canonical(&committed_exe).unwrap(),
            &state_path,
            &releases,
        ));
        assert!(!launcher_supersedes_committed(
            &canonical(&committed_exe).unwrap(),
            &canonical(&committed_exe).unwrap(),
            &state_path,
            &releases,
        ));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restart_resumes_persist_consume_once_and_expire_after_ttl() {
        let root = std::env::temp_dir().join(format!("ccgui-restart-resume-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let item = RestartResumeSession {
            engine: "agy".into(),
            session_id: "session-123".into(),
            workspace_path: "G:\\Projects\\ccgui-custom".into(),
            prompt: "继续".into(),
        };
        save_restart_resumes_in(&root, vec![item.clone()], 1_000).unwrap();
        assert_eq!(take_restart_resumes_in(&root, 2_000), vec![item.clone()]);
        assert!(take_restart_resumes_in(&root, 2_000).is_empty());

        save_restart_resumes_in(&root, vec![item], 1_000).unwrap();
        assert!(take_restart_resumes_in(&root, 1_000 + RESTART_RESUME_TTL_MS + 1).is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}
