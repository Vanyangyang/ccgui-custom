//! Private-stdio supervisor. The UI host owns checkpoint creation and health
//! confirmation; this process only waits, launches and supervises its own child.

use super::{
    checked_directory, plain_metadata, FailureReason, Limits, TransactionPhase, UpdateStore,
};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

const CONFIG_LIMIT: u64 = 16 * 1024;
const OLD_HOST_WAIT_SECONDS: u64 = 30;

#[cfg(feature = "test-harness")]
fn fixture_trace(value: serde_json::Value) {
    if !crate::paths::is_dev_profile() { return; }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true)
        .open(crate::paths::app_home().join("runtime-fixture-activation.jsonl"))
    {
        let _ = writeln!(file, "{value}");
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SupervisorConfig {
    pub transaction_id: String,
    pub previous_executable: PathBuf,
    pub candidate_executable: PathBuf,
    pub old_pid: u32,
    /// sysinfo start_time(): seconds since the Unix epoch, matching task workers.
    pub old_process_start_time: u64,
    pub health_timeout_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SupervisorStarted {
    pub transaction_id: String,
    pub pid: u32,
}

/// None means the PID is absent. Missing executable/start identity fails closed.
pub fn process_identity(pid: u32) -> Result<Option<(PathBuf, u64)>, String> {
    let pid = sysinfo::Pid::from_u32(pid);
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::Some(&[pid]),
        true,
        sysinfo::ProcessRefreshKind::everything(),
    );
    let Some(process) = system.process(pid) else {
        return Ok(None);
    };
    let executable = process
        .exe()
        .and_then(|path| dunce::canonicalize(path).ok())
        .ok_or("cannot verify process executable identity")?;
    if process.start_time() == 0 {
        return Err("cannot verify process creation time".into());
    }
    Ok(Some((executable, process.start_time())))
}

fn canonical_executable(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("absolute executable path required".into());
    }
    checked_directory(path.parent().ok_or("executable parent required")?)?;
    if !plain_metadata(path)?.is_file() {
        return Err("executable must be a regular file".into());
    }
    dunce::canonicalize(path).map_err(|_| "cannot resolve executable identity".into())
}

fn validate_context(
    store: &UpdateStore,
    profile: &Path,
    current_executable: &Path,
    config: &SupervisorConfig,
) -> Result<(), String> {
    if uuid::Uuid::parse_str(&config.transaction_id).is_err()
        || config.old_pid == 0
        || config.old_process_start_time == 0
        || !(60_000..=180_000).contains(&config.health_timeout_ms)
    {
        return Err("invalid supervisor configuration".into());
    }
    let state = store.read_state()?;
    let transaction = state.transaction.ok_or("no activation transaction")?;
    if transaction.id != config.transaction_id || transaction.phase != TransactionPhase::Activating
    {
        return Err("supervisor requires the current Activating transaction".into());
    }
    store.verify_identity(&transaction.candidate)?;
    let candidate = canonical_executable(&config.candidate_executable)?;
    let expected_candidate = canonical_executable(
        &store
            .release_path(&transaction.candidate)?
            .join(&transaction.candidate.executable),
    )?;
    if candidate != expected_candidate {
        return Err("candidate path differs from staged transaction".into());
    }
    let previous = canonical_executable(&config.previous_executable)?;
    let expected_previous = if let Some(previous) = &transaction.previous {
        store.verify_identity(previous)?;
        canonical_executable(&store.release_path(previous)?.join(&previous.executable))?
    } else {
        // First adoption can predate the release store. Its only allowed baseline
        // is this running supervisor binary, not a path selected on the CLI.
        canonical_executable(current_executable)?
    };
    if previous != expected_previous {
        return Err("previous executable identity differs".into());
    }
    let directory = profile
        .join("runtime-updates/handoffs")
        .join(&config.transaction_id);
    checked_directory(&directory)?;
    if !plain_metadata(&directory.join("checkpoint.json"))?.is_file() {
        return Err("activation checkpoint is not a regular file".into());
    }
    Ok(())
}

fn hidden_from_supervisor(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // The supervisor already escaped the old GUI's job at creation. A GUI
        // launched here may inherit a remaining outer launcher's job: it is not
        // owned by this supervisor or by the retired GUI. Requiring a second
        // breakaway fails with ERROR_ACCESS_DENIED for restrictive outer jobs.
        // Worker/supervisor creation still requires BREAKAWAY and fails closed.
        command.creation_flags(0x0800_0000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
}

/// Launches only the current executable, with all private configuration on stdin.
/// Readiness confirms validation, not activation or health. The caller must then
/// retire the old GUI host; no process is stopped by this function.
pub async fn spawn_supervisor(config: SupervisorConfig) -> Result<SupervisorStarted, String> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
    let executable = std::env::current_exe().map_err(|_| "cannot locate supervisor executable")?;
    let profile = crate::paths::app_home();
    let store = UpdateStore::open(&profile, Limits::default())?;
    validate_context(&store, &profile, &executable, &config)?;
    let identity = process_identity(config.old_pid)?
        .ok_or("old host already exited before supervisor spawn")?;
    if config.old_pid != std::process::id()
        || identity.0 != canonical_executable(&config.previous_executable)?
        || identity.1 != config.old_process_start_time
    {
        return Err("old host identity differs from the spawning process".into());
    }
    let mut bytes = serde_json::to_vec(&config).map_err(|_| "cannot encode supervisor config")?;
    bytes.push(b'\n');
    if bytes.len() as u64 > CONFIG_LIMIT {
        return Err("supervisor config exceeds limit".into());
    }
    let mut command = tokio::process::Command::new(executable);
    command
        .args(crate::paths::service_args("--live-update-supervisor"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(false);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000 | 0x0100_0000);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|_| "cannot start independent supervisor")?;
    let pid = child.id().ok_or("supervisor PID unavailable")?;
    let mut stdin = child.stdin.take().ok_or("supervisor stdin unavailable")?;
    stdin.write_all(&bytes).await.map_err(|_| {
        "supervisor configuration delivery failed; inspect transaction before retry"
    })?;
    stdin
        .shutdown()
        .await
        .map_err(|_| "supervisor configuration close failed")?;
    drop(stdin);
    let stdout = child
        .stdout
        .take()
        .ok_or("supervisor readiness pipe unavailable")?;
    let mut reader = tokio::io::BufReader::new(stdout.take(CONFIG_LIMIT + 1));
    let mut frame = Vec::new();
    tokio::time::timeout(
        Duration::from_secs(20),
        reader.read_until(b'\n', &mut frame),
    )
    .await
    .map_err(|_| "supervisor readiness timed out; inspect transaction before retry")?
    .map_err(|_| "cannot read supervisor readiness")?;
    if frame.len() as u64 > CONFIG_LIMIT || !frame.ends_with(b"\n") {
        return Err("invalid supervisor readiness frame".into());
    }
    let ready: SupervisorStarted =
        serde_json::from_slice(&frame).map_err(|_| "invalid supervisor readiness data")?;
    if ready.pid != pid || ready.transaction_id != config.transaction_id {
        return Err("supervisor readiness identity mismatch".into());
    }
    // stdio ownership is not a worker lifetime relationship. Dropping this child
    // and the readiness pipe leaves the independent supervisor alive.
    drop(child);
    Ok(ready)
}

/// Startup-mode entry point. Never log configuration or checkpoint contents.
pub fn run_stdio() -> Result<(), String> {
    use std::io::Read;
    let mut reader = std::io::BufReader::new(std::io::stdin().lock().take(CONFIG_LIMIT + 1));
    let mut frame = Vec::new();
    reader
        .read_until(b'\n', &mut frame)
        .map_err(|_| "cannot read supervisor configuration")?;
    if frame.len() as u64 > CONFIG_LIMIT || !frame.ends_with(b"\n") {
        return Err("invalid supervisor configuration frame".into());
    }
    let config: SupervisorConfig =
        serde_json::from_slice(&frame).map_err(|_| "invalid supervisor configuration")?;
    let profile = crate::paths::app_home();
    let current = std::env::current_exe().map_err(|_| "cannot locate supervisor executable")?;
    let store = UpdateStore::open(&profile, Limits::default())?;
    validate_context(&store, &profile, &current, &config)?;
    // Old PID reuse is harmless: only an exact executable + creation time counts
    // as the host we must wait for, and the old host is never terminated here.
    let ready = SupervisorStarted {
        transaction_id: config.transaction_id.clone(),
        pid: std::process::id(),
    };
    let mut output = std::io::stdout().lock();
    serde_json::to_writer(&mut output, &ready).map_err(|_| "cannot encode supervisor readiness")?;
    output
        .write_all(b"\n")
        .and_then(|_| output.flush())
        .map_err(|_| "cannot publish supervisor readiness")?;
    drop(output);
    supervise(&store, &profile, &current, &config, &mut NativeRuntime)
}

trait Runtime {
    type Candidate;
    fn old_alive(&mut self, config: &SupervisorConfig) -> Result<bool, String>;
    fn launch(&mut self, executable: &Path, transaction: &str) -> Result<Self::Candidate, String>;
    fn alive(&mut self, candidate: &mut Self::Candidate) -> Result<bool, String>;
    fn terminate_owned(&mut self, candidate: &mut Self::Candidate) -> Result<(), String>;
    fn tick(&mut self);
}

struct OwnedChild {
    child: Child,
    executable: PathBuf,
    started: Option<u64>,
}
struct NativeRuntime;
impl Runtime for NativeRuntime {
    type Candidate = OwnedChild;
    fn old_alive(&mut self, config: &SupervisorConfig) -> Result<bool, String> {
        let previous = canonical_executable(&config.previous_executable)?;
        Ok(
            process_identity(config.old_pid)?.is_some_and(|(path, started)| {
                started == config.old_process_start_time && path == previous
            }),
        )
    }
    fn launch(&mut self, executable: &Path, transaction: &str) -> Result<OwnedChild, String> {
        #[cfg(feature = "test-harness")]
        fixture_trace(serde_json::json!({"stage":"launch-begin","executable":executable,"pid":std::process::id(),"fixture":crate::test_harness::runtime_fixture_enabled()}));
        #[cfg(all(feature = "test-harness", windows))]
        {
            use windows::Win32::System::JobObjects::{IsProcessInJob, QueryInformationJobObject, JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION};
            let mut in_job = windows::core::BOOL::default();
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            let (membership, limits) = unsafe {
                (IsProcessInJob(windows::Win32::System::Threading::GetCurrentProcess(), None, &mut in_job),
                 QueryInformationJobObject(None, JobObjectExtendedLimitInformation, &mut info as *mut _ as *mut _, std::mem::size_of_val(&info) as u32, None))
            };
            fixture_trace(serde_json::json!({"stage":"launch-context", "inJob":membership.is_ok().then_some(in_job.as_bool()),
                "jobLimits":limits.is_ok().then_some(info.BasicLimitInformation.LimitFlags.0),"cwd":std::env::current_dir().ok()}));
        }
        let executable = canonical_executable(executable).map_err(|error| {
            #[cfg(feature = "test-harness")]
            fixture_trace(serde_json::json!({"stage":"launch-path","error":error}));
            error
        })?;
        let mut command = Command::new(&executable);
        command
            .args(crate::paths::service_args(&format!(
                "--live-update-resume={transaction}"
            )))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        hidden_from_supervisor(&mut command);
        let child = command
            .spawn()
            .map_err(|error| {
                #[cfg(feature = "test-harness")]
                {
                    fixture_trace(serde_json::json!({
                        "stage": "activation-spawn", "osCode": error.raw_os_error(),
                        "kind": format!("{:?}", error.kind()), "message": error.to_string(),
                    }));
                }
                format!("cannot launch activation executable: {error}")
            })?;
        #[cfg(feature = "test-harness")]
        fixture_trace(serde_json::json!({"stage":"launch-created","pid":child.id()}));
        let started = process_identity(child.id())
            .ok()
            .flatten()
            .and_then(|(path, started)| (path == executable).then_some(started));
        Ok(OwnedChild {
            child,
            executable,
            started,
        })
    }
    fn alive(&mut self, candidate: &mut OwnedChild) -> Result<bool, String> {
        if candidate
            .child
            .try_wait()
            .map_err(|_| "cannot inspect candidate child")?
            .is_some()
        {
            return Ok(false);
        }
        if let Some((path, started)) = process_identity(candidate.child.id())? {
            if path != candidate.executable
                || candidate
                    .started
                    .is_some_and(|expected| expected != started)
            {
                return Err("candidate identity changed".into());
            }
            candidate.started = Some(started);
        }
        Ok(true)
    }
    fn terminate_owned(&mut self, candidate: &mut OwnedChild) -> Result<(), String> {
        if candidate
            .child
            .try_wait()
            .map_err(|_| "cannot inspect candidate exit")?
            .is_some()
        {
            return Ok(());
        }
        let (path, started) = process_identity(candidate.child.id())?
            .ok_or("cannot verify candidate before termination")?;
        if path != candidate.executable || candidate.started != Some(started) {
            return Err("candidate termination identity mismatch".into());
        }
        // Child::kill targets our held child handle, not a process tree/job.
        candidate
            .child
            .kill()
            .map_err(|_| "cannot terminate owned candidate")?;
        candidate
            .child
            .wait()
            .map_err(|_| "cannot reap owned candidate")?;
        Ok(())
    }
    fn tick(&mut self) {
        std::thread::sleep(Duration::from_secs(1));
    }
}

fn supervise<R: Runtime>(
    store: &UpdateStore,
    profile: &Path,
    current: &Path,
    config: &SupervisorConfig,
    runtime: &mut R,
) -> Result<(), String> {
    for tick in 0..=OLD_HOST_WAIT_SECONDS {
        if !runtime.old_alive(config)? {
            break;
        }
        if tick == OLD_HOST_WAIT_SECONDS {
            store.record_failure_reason(
                &config.transaction_id,
                FailureReason::OldHostStillRunning,
            )?;
            store.fail(&config.transaction_id)?;
            return Err("old host still running; activation was not started".into());
        }
        runtime.tick();
    }
    validate_context(store, profile, current, config)?;
    let mut candidate = match runtime.launch(&config.candidate_executable, &config.transaction_id) {
        Ok(candidate) => candidate,
        Err(_) => {
            return restore_previous(store, config, runtime, FailureReason::CandidateLaunchFailed)
        }
    };
    let seconds = config.health_timeout_ms.div_ceil(1000);
    for tick in 0..=seconds {
        let state = store.read_state()?;
        let transaction = state
            .transaction
            .ok_or("activation transaction disappeared")?;
        if transaction.id != config.transaction_id {
            return Err("activation transaction was superseded".into());
        }
        if transaction.phase == TransactionPhase::Committed {
            return Ok(());
        }
        if transaction.phase != TransactionPhase::Activating {
            return Err("activation transaction changed externally".into());
        }
        match runtime.alive(&mut candidate) {
            Ok(false) => {
                return restore_previous(store, config, runtime, FailureReason::CandidateExited)
            }
            Err(_) => {
                store.record_failure_reason(
                    &config.transaction_id,
                    FailureReason::CandidateIdentityUnknown,
                )?;
                return Err(
                    "candidate identity unavailable; rollback withheld to avoid a second live host"
                        .into(),
                );
            }
            Ok(true) => (),
        }
        if tick == seconds {
            // Claim failure atomically before termination. A health confirmation
            // that won the race keeps its committed process alive.
            if store
                .abort_activation(
                    &config.transaction_id,
                    FailureReason::CandidateHealthTimeout,
                )
                .is_err()
            {
                let state = store.read_state()?;
                if state.transaction.is_some_and(|transaction| {
                    transaction.id == config.transaction_id
                        && transaction.phase == TransactionPhase::Committed
                }) {
                    return Ok(());
                }
                return Err("activation changed before timeout retirement".into());
            }
            if runtime.terminate_owned(&mut candidate).is_err() {
                store.record_failure_reason(
                    &config.transaction_id,
                    FailureReason::CandidateIdentityUnknown,
                )?;
                return Err("candidate could not be safely retired; rollback withheld".into());
            }
            return restore_previous(
                store,
                config,
                runtime,
                FailureReason::CandidateHealthTimeout,
            );
        }
        runtime.tick();
    }
    unreachable!("bounded activation loop always returns")
}

fn restore_previous<R: Runtime>(
    store: &UpdateStore,
    config: &SupervisorConfig,
    runtime: &mut R,
    reason: FailureReason,
) -> Result<(), String> {
    let state = store.read_state()?;
    let transaction = state
        .transaction
        .ok_or("activation transaction disappeared")?;
    if transaction.id != config.transaction_id {
        return Err("activation transaction was superseded".into());
    }
    if transaction.phase == TransactionPhase::Activating {
        store.abort_activation(&config.transaction_id, reason)?;
    } else if transaction.phase != TransactionPhase::Failed {
        return Err("activation changed before rollback".into());
    }
    store.rollback(&config.transaction_id)?;
    // Check again after the candidate has exited: never create a second host if
    // the caller's old host identity has become visible again.
    if runtime.old_alive(config)? {
        return Err("old host is still present; previous launch withheld".into());
    }
    if runtime
        .launch(&config.previous_executable, &config.transaction_id)
        .is_err()
    {
        store.record_failure_reason(&config.transaction_id, FailureReason::PreviousLaunchFailed)?;
        return Err("rollback recorded but previous executable could not be launched".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::live_update::{Compatibility, ReleaseFile, ReleaseManifest};
    use sha2::{Digest, Sha256};

    struct Fixture {
        root: PathBuf,
        store: UpdateStore,
        config: SupervisorConfig,
    }
    impl Fixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("ccgui-activation-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            let store = UpdateStore::open(&root, Limits::default()).unwrap();
            let make = |name: &str| {
                let source = root.join(name);
                std::fs::create_dir(&source).unwrap();
                std::fs::write(source.join("ccgui-next.exe"), name).unwrap();
                let manifest = ReleaseManifest {
                    manifest_version: 1,
                    channel: "protected-custom".into(),
                    release_id: name.into(),
                    version: "1.0.0".into(),
                    worker_protocol: 1,
                    checkpoint_schema: 1,
                    schema_hash: "a".repeat(64),
                    executable: "ccgui-next.exe".into(),
                    files: vec![ReleaseFile {
                        path: "ccgui-next.exe".into(),
                        bytes: name.len() as u64,
                        sha256: format!("{:x}", Sha256::digest(name.as_bytes())),
                    }],
                };
                let bytes = serde_json::to_vec(&manifest).unwrap();
                let hash = format!("{:x}", Sha256::digest(&bytes));
                std::fs::write(source.join("manifest.json"), bytes).unwrap();
                store.stage(&source, &hash).unwrap()
            };
            let previous = make("old");
            store.initialize_active(previous.clone()).unwrap();
            let candidate = make("new");
            let transaction = store
                .prepare(
                    candidate.clone(),
                    &Compatibility {
                        worker_protocol: 1,
                        checkpoint_schema: 1,
                        schema_hash: "a".repeat(64),
                    },
                )
                .unwrap();
            store.ready(&transaction.id).unwrap();
            store.activating(&transaction.id).unwrap();
            let directory = root.join("runtime-updates/handoffs").join(&transaction.id);
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(directory.join("checkpoint.json"), "{}").unwrap();
            let config = SupervisorConfig {
                transaction_id: transaction.id,
                previous_executable: store
                    .release_path(&previous)
                    .unwrap()
                    .join("ccgui-next.exe"),
                candidate_executable: store
                    .release_path(&candidate)
                    .unwrap()
                    .join("ccgui-next.exe"),
                old_pid: 100,
                old_process_start_time: 1,
                health_timeout_ms: 60_000,
            };
            Self {
                root,
                store,
                config,
            }
        }
        fn run(&self, runtime: &mut FakeRuntime) -> Result<(), String> {
            supervise(
                &self.store,
                &self.root,
                &self.config.previous_executable,
                &self.config,
                runtime,
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
    #[derive(Default)]
    struct FakeRuntime {
        old_alive: bool,
        candidate_alive: bool,
        launch_fails: bool,
        identity_fails: bool,
        launches: Vec<PathBuf>,
        terminated: usize,
        ticks: usize,
        commit_on_tick: Option<(PathBuf, String)>,
    }
    impl Runtime for FakeRuntime {
        type Candidate = ();
        fn old_alive(&mut self, _: &SupervisorConfig) -> Result<bool, String> {
            Ok(self.old_alive)
        }
        fn launch(&mut self, path: &Path, _: &str) -> Result<(), String> {
            self.launches.push(path.into());
            if self.launch_fails && self.launches.len() == 1 {
                Err("fake spawn failure".into())
            } else {
                Ok(())
            }
        }
        fn alive(&mut self, _: &mut ()) -> Result<bool, String> {
            Ok(self.candidate_alive)
        }
        fn terminate_owned(&mut self, _: &mut ()) -> Result<(), String> {
            if self.identity_fails {
                Err("fake identity mismatch".into())
            } else {
                self.terminated += 1;
                Ok(())
            }
        }
        fn tick(&mut self) {
            self.ticks += 1;
            if let Some((profile, id)) = self.commit_on_tick.take() {
                UpdateStore::open(&profile, Limits::default())
                    .unwrap()
                    .confirm_healthy(&id)
                    .unwrap();
            }
        }
    }

    #[test]
    fn old_host_is_never_killed_or_replaced() {
        let fixture = Fixture::new();
        let mut runtime = FakeRuntime {
            old_alive: true,
            ..Default::default()
        };
        assert!(fixture.run(&mut runtime).is_err());
        assert!(runtime.launches.is_empty());
        assert_eq!(runtime.terminated, 0);
        let transaction = fixture.store.read_state().unwrap().transaction.unwrap();
        assert_eq!(transaction.phase, TransactionPhase::Failed);
        assert_eq!(
            transaction.failure_reason,
            Some(FailureReason::OldHostStillRunning)
        );
    }

    #[test]
    fn early_exit_and_spawn_failure_restore_only_previous() {
        for launch_fails in [false, true] {
            let fixture = Fixture::new();
            let mut runtime = FakeRuntime {
                launch_fails,
                ..Default::default()
            };
            fixture.run(&mut runtime).unwrap();
            assert_eq!(
                runtime.launches,
                vec![
                    fixture.config.candidate_executable.clone(),
                    fixture.config.previous_executable.clone()
                ]
            );
            assert_eq!(runtime.terminated, 0);
            let state = fixture.store.read_state().unwrap();
            let transaction = state.transaction.unwrap();
            assert_eq!(transaction.phase, TransactionPhase::RolledBack);
            assert_eq!(state.active, transaction.previous);
        }
    }

    #[test]
    fn first_update_after_offline_install_rolls_back_to_standalone_not_retained_release() {
        for launch_fails in [false, true] {
            let mut fixture = Fixture::new();
            let retained = fixture.config.previous_executable.clone();
            let standalone = fixture.root.join("installed-v2.exe");
            std::fs::write(&standalone, b"standalone v2 baseline").unwrap();
            let mut state = fixture.store.read_state().unwrap();
            state.active = None;
            state.transaction.as_mut().unwrap().previous = None;
            fixture.store.persist(&state).unwrap();
            fixture.config.previous_executable = standalone.clone();
            let mut runtime = FakeRuntime { launch_fails, ..Default::default() };
            fixture.run(&mut runtime).unwrap();
            assert_eq!(runtime.launches, vec![fixture.config.candidate_executable.clone(), standalone]);
            assert!(!runtime.launches.contains(&retained));
            assert_eq!(runtime.terminated, 0);
            let state = fixture.store.read_state().unwrap();
            assert!(state.active.is_none());
            assert_eq!(state.transaction.unwrap().phase, TransactionPhase::RolledBack);
        }
    }

    #[test]
    fn timeout_only_terminates_owned_candidate_and_preserves_failure() {
        let fixture = Fixture::new();
        let mut runtime = FakeRuntime {
            candidate_alive: true,
            ..Default::default()
        };
        fixture.run(&mut runtime).unwrap();
        assert_eq!(runtime.terminated, 1);
        assert_eq!(runtime.ticks, 60);
        assert_eq!(
            fixture
                .store
                .read_state()
                .unwrap()
                .transaction
                .unwrap()
                .failure_reason,
            Some(FailureReason::CandidateHealthTimeout)
        );
    }

    #[test]
    fn confirmed_health_keeps_candidate_and_commits_pointer() {
        let fixture = Fixture::new();
        let mut runtime = FakeRuntime {
            candidate_alive: true,
            commit_on_tick: Some((fixture.root.clone(), fixture.config.transaction_id.clone())),
            ..Default::default()
        };
        fixture.run(&mut runtime).unwrap();
        assert_eq!(
            runtime.launches,
            vec![fixture.config.candidate_executable.clone()]
        );
        assert_eq!(runtime.terminated, 0);
        let state = fixture.store.read_state().unwrap();
        assert_eq!(
            state.active,
            Some(state.transaction.as_ref().unwrap().candidate.clone())
        );
        assert_eq!(
            state.transaction.unwrap().phase,
            TransactionPhase::Committed
        );
    }

    #[test]
    fn identity_failure_withholds_termination_and_rollback() {
        let fixture = Fixture::new();
        let mut runtime = FakeRuntime {
            candidate_alive: true,
            identity_fails: true,
            ..Default::default()
        };
        assert!(fixture.run(&mut runtime).is_err());
        assert_eq!(runtime.terminated, 0);
        assert_eq!(runtime.launches.len(), 1);
        assert_eq!(
            fixture
                .store
                .read_state()
                .unwrap()
                .transaction
                .unwrap()
                .phase,
            TransactionPhase::Failed
        );
    }

    #[test]
    fn arbitrary_candidate_and_missing_checkpoint_are_rejected() {
        let mut fixture = Fixture::new();
        fixture.config.candidate_executable = fixture.config.previous_executable.clone();
        assert!(validate_context(
            &fixture.store,
            &fixture.root,
            &fixture.config.previous_executable,
            &fixture.config
        )
        .is_err());
        let fixture = Fixture::new();
        std::fs::remove_file(
            fixture
                .root
                .join("runtime-updates/handoffs")
                .join(&fixture.config.transaction_id)
                .join("checkpoint.json"),
        )
        .unwrap();
        assert!(validate_context(
            &fixture.store,
            &fixture.root,
            &fixture.config.previous_executable,
            &fixture.config
        )
        .is_err());
    }
}
