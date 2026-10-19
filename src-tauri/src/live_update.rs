//! Local-only release staging and crash-readable activation records.
//!
//! The caller supplies an already validated profile and a separately obtained
//! manifest digest. Profile-scoped OS locks serialize state transitions across
//! candidate and supervisor processes. Digests establish integrity, not publisher
//! signatures. This module never executes a candidate or changes the database.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[path = "live_update/activation.rs"]
pub mod activation;
pub mod channel;

const MANIFEST: &str = "manifest.json";
const CHANNEL: &str = "protected-custom";
static WRITES: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub max_files: usize,
    pub max_bytes: u64,
    pub max_manifest_bytes: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            max_files: 4096,
            max_bytes: 2 * 1024 * 1024 * 1024,
            max_manifest_bytes: 4 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseFile {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseManifest {
    pub manifest_version: u32,
    pub channel: String,
    pub release_id: String,
    pub version: String,
    pub worker_protocol: u32,
    pub checkpoint_schema: u32,
    pub schema_hash: String,
    pub executable: String,
    pub files: Vec<ReleaseFile>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseIdentity {
    pub manifest_sha256: String,
    pub channel: String,
    pub release_id: String,
    pub version: String,
    pub worker_protocol: u32,
    pub checkpoint_schema: u32,
    pub schema_hash: String,
    pub executable: String,
}

impl ReleaseManifest {
    fn identity(&self, hash: &str) -> ReleaseIdentity {
        ReleaseIdentity {
            manifest_sha256: hash.into(),
            channel: self.channel.clone(),
            release_id: self.release_id.clone(),
            version: self.version.clone(),
            worker_protocol: self.worker_protocol,
            checkpoint_schema: self.checkpoint_schema,
            schema_hash: self.schema_hash.clone(),
            executable: self.executable.clone(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Compatibility {
    pub worker_protocol: u32,
    pub checkpoint_schema: u32,
    pub schema_hash: String,
}

pub fn check_compatibility(
    candidate: &ReleaseIdentity,
    expected: &Compatibility,
) -> Result<(), String> {
    if candidate.worker_protocol != expected.worker_protocol {
        return Err("worker protocol mismatch".into());
    }
    if candidate.checkpoint_schema != expected.checkpoint_schema {
        return Err("checkpoint schema mismatch".into());
    }
    if !crate::task_worker::schemas_compatible(&candidate.schema_hash, &expected.schema_hash) {
        return Err("database schema hash mismatch".into());
    }
    Ok(())
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn valid_label(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
}
fn relative_path(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 512
        || value.contains('\\')
        || value.split('/').count() > 16
    {
        return Err("invalid release path".into());
    }
    for part in value.split('/') {
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || part
                .chars()
                .any(|c| c.is_control() || "<>:\"|?*".contains(c))
            || matches!(
                stem.as_str(),
                "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" | "CLOCK$"
            )
            || ["COM¹", "COM²", "COM³", "LPT¹", "LPT²", "LPT³"].contains(&stem.as_str())
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            return Err("invalid release path component".into());
        }
    }
    Ok(())
}

fn plain_metadata(path: &Path) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| format!("read release metadata: {e}"))?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("release reparse points are forbidden".into());
        }
    }
    if metadata.file_type().is_symlink() {
        return Err("release symlinks are forbidden".into());
    }
    Ok(metadata)
}

pub(crate) fn checked_directory(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("absolute directory required".into());
    }
    for ancestor in path.ancestors() {
        if !plain_metadata(ancestor)?.is_dir() {
            return Err("release ancestor is not a directory".into());
        }
    }
    Ok(())
}

fn create_directory(path: &Path) -> Result<(), String> {
    let parent = path.parent().ok_or("directory parent required")?;
    checked_directory(parent)?;
    match fs::create_dir(path) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
        Err(e) => return Err(format!("create release directory: {e}")),
    }
    checked_directory(path)
}

pub(crate) fn bounded_read(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let metadata = plain_metadata(path)?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err("release file exceeds limit or is not regular".into());
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|e| e.to_string())?
        .take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("release file grew beyond limit".into());
    }
    Ok(bytes)
}

fn file_digest(path: &Path, expected_bytes: u64) -> Result<String, String> {
    let metadata = plain_metadata(path)?;
    if !metadata.is_file() || metadata.len() != expected_bytes {
        return Err("release file size mismatch".into());
    }
    let mut input = File::open(path).map_err(|e| e.to_string())?;
    let mut hash = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 65536];
    loop {
        let n = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        total = total
            .checked_add(n as u64)
            .ok_or("release file size overflow")?;
        if total > expected_bytes {
            return Err("release file grew during verification".into());
        }
        hash.update(&buffer[..n]);
    }
    if total != expected_bytes {
        return Err("release file changed during verification".into());
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn collect_files(
    root: &Path,
    rel: &str,
    files: &mut BTreeSet<String>,
    entries: &mut usize,
    limits: Limits,
) -> Result<(), String> {
    let directory = root.join(rel);
    checked_directory(&directory)?;
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        *entries = entries
            .checked_add(1)
            .ok_or("release entry count overflow")?;
        if *entries > limits.max_files.saturating_mul(17).saturating_add(1) {
            return Err("too many release entries".into());
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "release path is not Unicode")?;
        let path = if rel.is_empty() {
            name
        } else {
            format!("{rel}/{name}")
        };
        relative_path(&path)?;
        let metadata = plain_metadata(&entry.path())?;
        if metadata.is_dir() {
            collect_files(root, &path, files, entries, limits)?;
        } else if metadata.is_file() {
            files.insert(path);
            if files.len() > limits.max_files.saturating_add(1) {
                return Err("too many release files".into());
            }
        } else {
            return Err("non-regular release entry".into());
        }
    }
    Ok(())
}

/// Validates the entire local directory against an independently supplied digest.
pub fn verify_release(
    source: &Path,
    expected_manifest_sha256: &str,
    limits: Limits,
) -> Result<ReleaseIdentity, String> {
    verify_manifest(source, expected_manifest_sha256, limits)
        .map(|manifest| manifest.identity(expected_manifest_sha256))
}

pub(crate) fn verify_manifest(
    source: &Path,
    expected_hash: &str,
    limits: Limits,
) -> Result<ReleaseManifest, String> {
    if !valid_hash(expected_hash) {
        return Err("invalid expected manifest SHA256".into());
    }
    checked_directory(source)?;
    let bytes = bounded_read(&source.join(MANIFEST), limits.max_manifest_bytes)?;
    if format!("{:x}", Sha256::digest(&bytes)) != expected_hash {
        return Err("manifest SHA256 mismatch".into());
    }
    let manifest: ReleaseManifest =
        serde_json::from_slice(&bytes).map_err(|e| format!("invalid release manifest: {e}"))?;
    if manifest.manifest_version != 1
        || manifest.channel != CHANNEL
        || manifest.executable != "ccgui-next.exe"
        || !valid_label(&manifest.release_id)
        || !valid_label(&manifest.version)
        || !valid_hash(&manifest.schema_hash)
        || manifest.worker_protocol != 1
        || manifest.checkpoint_schema != 1
    {
        return Err("unsupported release metadata".into());
    }
    if manifest.files.is_empty() || manifest.files.len() > limits.max_files {
        return Err("release file count exceeds limit".into());
    }
    let mut paths = BTreeSet::new();
    let mut folded = BTreeSet::from([MANIFEST.to_string()]);
    let mut total = 0u64;
    for file in &manifest.files {
        relative_path(&file.path)?;
        if !valid_hash(&file.sha256) || !folded.insert(file.path.to_lowercase()) {
            return Err("duplicate, reserved or invalid release file".into());
        }
        paths.insert(file.path.clone());
        total = total
            .checked_add(file.bytes)
            .ok_or("release size overflow")?;
        if total > limits.max_bytes {
            return Err("release total bytes exceeds limit".into());
        }
    }
    if !paths.contains(&manifest.executable) {
        return Err("release executable is undeclared".into());
    }
    // Also reject case aliases of directories (a/x and A/y) and file/dir collisions.
    let mut prefixes = std::collections::BTreeMap::new();
    for path in &paths {
        let parts: Vec<_> = path.split('/').collect();
        for n in 1..=parts.len() {
            let prefix = parts[..n].join("/");
            let key = prefix.to_lowercase();
            if let Some(previous) = prefixes.insert(key, prefix.clone()) {
                if previous != prefix {
                    return Err("Windows path case collision".into());
                }
            }
            if n < parts.len() && folded.contains(&prefix.to_lowercase()) {
                return Err("release file/directory collision".into());
            }
        }
    }
    let mut actual = BTreeSet::new();
    collect_files(source, "", &mut actual, &mut 0, limits)?;
    paths.insert(MANIFEST.into());
    if actual != paths {
        return Err("release contains missing or undeclared files".into());
    }
    for file in &manifest.files {
        if file_digest(&source.join(&file.path), file.bytes)? != file.sha256 {
            return Err("release file SHA256 mismatch".into());
        }
    }
    Ok(manifest)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TransactionPhase {
    Preparing,
    Ready,
    Activating,
    Committed,
    RolledBack,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FailureReason {
    OldHostStillRunning,
    CandidateLaunchFailed,
    CandidateExited,
    CandidateHealthTimeout,
    CandidateIdentityUnknown,
    PreviousLaunchFailed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Transaction {
    pub id: String,
    pub phase: TransactionPhase,
    pub candidate: ReleaseIdentity,
    pub previous: Option<ReleaseIdentity>,
    #[serde(default)]
    pub failure_reason: Option<FailureReason>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateState {
    pub state_version: u32,
    pub active: Option<ReleaseIdentity>,
    pub transaction: Option<Transaction>,
}
impl Default for UpdateState {
    fn default() -> Self {
        Self {
            state_version: 1,
            active: None,
            transaction: None,
        }
    }
}

pub struct UpdateStore {
    root: PathBuf,
    limits: Limits,
}

impl UpdateStore {
    pub fn open(profile_root: &Path, limits: Limits) -> Result<Self, String> {
        checked_directory(profile_root)?;
        let root = profile_root.join("runtime-updates");
        create_directory(&root)?;
        create_directory(&root.join("releases"))?;
        let store = Self { root, limits };
        store.read_state()?;
        Ok(store)
    }

    pub fn release_path(&self, identity: &ReleaseIdentity) -> Result<PathBuf, String> {
        validate_identity(identity)?;
        Ok(self.root.join("releases").join(&identity.manifest_sha256))
    }

    pub fn stage(
        &self,
        source: &Path,
        expected_manifest_sha256: &str,
    ) -> Result<ReleaseIdentity, String> {
        self.stage_compatible(source, expected_manifest_sha256, None)
    }

    pub fn stage_compatible(
        &self,
        source: &Path,
        expected_manifest_sha256: &str,
        expected: Option<&Compatibility>,
    ) -> Result<ReleaseIdentity, String> {
        let _guard = WRITES.lock().map_err(|_| "update write lock poisoned")?;
        let _process_guard = state_lock(&self.root)?;
        checked_directory(&self.root.join("releases"))?;
        let manifest = verify_manifest(source, expected_manifest_sha256, self.limits)?;
        let identity = manifest.identity(expected_manifest_sha256);
        if let Some(expected) = expected {
            check_compatibility(&identity, expected)?;
        }
        let destination = self.release_path(&identity)?;
        match fs::symlink_metadata(&destination) {
            Ok(_) => {
                self.verify_identity(&identity)?;
                return Ok(identity);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.to_string()),
        }
        let staging = self
            .root
            .join("releases")
            .join(format!(".staging-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&staging).map_err(|e| e.to_string())?;
        // Failed staging directories are retained for diagnosis, never recursively
        // cleaned up here. They are not reachable through an active identity.
        let manifest_bytes = bounded_read(&source.join(MANIFEST), self.limits.max_manifest_bytes)?;
        if format!("{:x}", Sha256::digest(&manifest_bytes)) != expected_manifest_sha256 {
            return Err("manifest SHA256 mismatch".into());
        }
        write_new(&staging.join(MANIFEST), &manifest_bytes)?;
        let mut buffer = [0u8; 65536];
        for file in &manifest.files {
            let destination = staging.join(&file.path);
            let mut parent = staging.clone();
            let components: Vec<_> = file.path.split('/').collect();
            for component in &components[..components.len() - 1] {
                parent.push(component);
                create_directory(&parent)?;
            }
            plain_metadata(&source.join(&file.path))?;
            let mut input = File::open(source.join(&file.path))
                .map_err(|e| e.to_string())?
                .take(file.bytes.saturating_add(1));
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(destination)
                .map_err(|e| e.to_string())?;
            let mut hasher = Sha256::new();
            let mut copied = 0u64;
            loop {
                let read = input.read(&mut buffer).map_err(|e| e.to_string())?;
                if read == 0 {
                    break;
                }
                copied = copied.saturating_add(read as u64);
                if copied > file.bytes {
                    return Err("candidate changed during staging".into());
                }
                output.write_all(&buffer[..read]).map_err(|e| e.to_string())?;
                hasher.update(&buffer[..read]);
            }
            if copied != file.bytes || format!("{:x}", hasher.finalize()) != file.sha256 {
                return Err("candidate changed during staging".into());
            }
            if file.path == manifest.executable {
                output.sync_all().map_err(|e| e.to_string())?;
            }
        }
        fs::rename(&staging, &destination)
            .map_err(|e| format!("publish immutable release: {e}"))?;
        sync_directory(&self.root.join("releases"))?;
        Ok(identity)
    }

    fn verify_identity(&self, identity: &ReleaseIdentity) -> Result<(), String> {
        let actual = verify_release(
            &self.release_path(identity)?,
            &identity.manifest_sha256,
            self.limits,
        )?;
        if actual != *identity {
            return Err("release identity mismatch".into());
        }
        Ok(())
    }

    pub fn read_state(&self) -> Result<UpdateState, String> {
        checked_directory(&self.root)?;
        let path = self.root.join("state.json");
        let state: UpdateState = match fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(UpdateState::default()),
            Err(e) => return Err(e.to_string()),
            Ok(_) => serde_json::from_slice(&bounded_read(&path, 65536)?)
                .map_err(|e| format!("corrupt update state: {e}"))?,
        };
        if state.state_version != 1 {
            return Err("unsupported update state version".into());
        }
        if let Some(active) = &state.active {
            validate_identity(active)?;
        }
        if let Some(transaction) = &state.transaction {
            if uuid::Uuid::parse_str(&transaction.id).is_err() {
                return Err("corrupt update transaction ID".into());
            }
            validate_identity(&transaction.candidate)?;
            if let Some(previous) = &transaction.previous {
                validate_identity(previous)?;
            }
            let expected = if transaction.phase == TransactionPhase::Committed {
                Some(&transaction.candidate)
            } else {
                transaction.previous.as_ref()
            };
            if state.active.as_ref() != expected {
                return Err("inconsistent update pointer and transaction".into());
            }
        }
        Ok(state)
    }

    /// Seed a known, staged baseline once. Existing active state is never replaced.
    pub fn initialize_active(&self, identity: ReleaseIdentity) -> Result<(), String> {
        let _guard = WRITES.lock().map_err(|_| "update write lock poisoned")?;
        let _process_guard = state_lock(&self.root)?;
        let mut state = self.read_state()?;
        if state.active.is_some() || state.transaction.is_some() {
            return Err("update state already initialized".into());
        }
        self.verify_identity(&identity)?;
        state.active = Some(identity);
        self.persist(&state)
    }

    pub fn prepare(
        &self,
        candidate: ReleaseIdentity,
        expected: &Compatibility,
    ) -> Result<Transaction, String> {
        let _guard = WRITES.lock().map_err(|_| "update write lock poisoned")?;
        let _process_guard = state_lock(&self.root)?;
        let mut state = self.read_state()?;
        self.check_channel_candidate_unlocked(&candidate.manifest_sha256)?;
        if state.transaction.as_ref().is_some_and(|t| {
            matches!(
                t.phase,
                TransactionPhase::Preparing
                    | TransactionPhase::Ready
                    | TransactionPhase::Activating
            ) || (t.phase == TransactionPhase::Failed
                && t.failure_reason == Some(FailureReason::CandidateIdentityUnknown))
        }) {
            return Err("an update transaction is already pending".into());
        }
        self.verify_identity(&candidate)?;
        check_compatibility(&candidate, expected)?;
        self.checkpoint_channel_unlocked()?;
        let transaction = Transaction {
            id: uuid::Uuid::new_v4().to_string(),
            phase: TransactionPhase::Preparing,
            candidate,
            previous: state.active.clone(),
            failure_reason: None,
        };
        state.transaction = Some(transaction.clone());
        self.persist(&state)?;
        Ok(transaction)
    }

    pub fn ready(&self, id: &str) -> Result<Transaction, String> {
        self.advance(id, TransactionPhase::Preparing, TransactionPhase::Ready)
    }
    pub fn activating(&self, id: &str) -> Result<Transaction, String> {
        self.advance(id, TransactionPhase::Ready, TransactionPhase::Activating)
    }

    /// Call only after the external supervisor confirms candidate health.
    pub fn confirm_healthy(&self, id: &str) -> Result<Transaction, String> {
        self.advance(
            id,
            TransactionPhase::Activating,
            TransactionPhase::Committed,
        )
    }

    fn advance(
        &self,
        id: &str,
        from: TransactionPhase,
        to: TransactionPhase,
    ) -> Result<Transaction, String> {
        let _guard = WRITES.lock().map_err(|_| "update write lock poisoned")?;
        let _process_guard = state_lock(&self.root)?;
        let mut state = self.read_state()?;
        let transaction = state.transaction.as_mut().ok_or("no update transaction")?;
        if transaction.id != id || transaction.phase != from {
            return Err("invalid update transition".into());
        }
        self.verify_identity(&transaction.candidate)?;
        transaction.phase = to;
        if transaction.phase == TransactionPhase::Committed {
            state.active = Some(transaction.candidate.clone());
        }
        let result = transaction.clone();
        self.persist(&state)?;
        Ok(result)
    }

    /// Restores the complete previous identity. The caller decides how to run it.
    pub fn rollback(&self, id: &str) -> Result<Option<ReleaseIdentity>, String> {
        self.finish_failure(id, TransactionPhase::RolledBack)
    }
    pub fn fail(&self, id: &str) -> Result<Option<ReleaseIdentity>, String> {
        self.finish_failure(id, TransactionPhase::Failed)
    }

    pub fn record_failure_reason(&self, id: &str, reason: FailureReason) -> Result<(), String> {
        let _guard = WRITES.lock().map_err(|_| "update write lock poisoned")?;
        let _process_guard = state_lock(&self.root)?;
        let mut state = self.read_state()?;
        let transaction = state.transaction.as_mut().ok_or("no update transaction")?;
        if transaction.id != id {
            return Err("stale update transaction".into());
        }
        transaction.failure_reason = Some(reason);
        self.persist(&state)
    }

    /// Claims a failed activation before retiring its child. This excludes a
    /// concurrent late health confirmation; no committed candidate is aborted.
    pub fn abort_activation(&self, id: &str, reason: FailureReason) -> Result<(), String> {
        let _guard = WRITES.lock().map_err(|_| "update write lock poisoned")?;
        let _process_guard = state_lock(&self.root)?;
        let mut state = self.read_state()?;
        let transaction = state.transaction.as_mut().ok_or("no update transaction")?;
        if transaction.id != id || transaction.phase != TransactionPhase::Activating {
            return Err("activation is no longer pending".into());
        }
        transaction.phase = TransactionPhase::Failed;
        transaction.failure_reason = Some(reason);
        self.persist(&state)
    }

    fn finish_failure(
        &self,
        id: &str,
        phase: TransactionPhase,
    ) -> Result<Option<ReleaseIdentity>, String> {
        let _guard = WRITES.lock().map_err(|_| "update write lock poisoned")?;
        let _process_guard = state_lock(&self.root)?;
        let mut state = self.read_state()?;
        let transaction = state.transaction.as_mut().ok_or("no update transaction")?;
        if transaction.id != id
            || transaction.phase == TransactionPhase::RolledBack
            || (transaction.phase == TransactionPhase::Failed
                && phase != TransactionPhase::RolledBack)
        {
            return Err("invalid update failure transition".into());
        }
        if let Some(previous) = &transaction.previous {
            self.verify_identity(previous)?;
        }
        transaction.phase = phase;
        state.active = transaction.previous.clone();
        let result = state.active.clone();
        self.persist(&state)?;
        Ok(result)
    }

    fn persist(&self, state: &UpdateState) -> Result<(), String> {
        checked_directory(&self.root)?;
        let destination = self.root.join("state.json");
        if destination.try_exists().map_err(|e| e.to_string())?
            && !plain_metadata(&destination)?.is_file()
        {
            return Err("update state is not a file".into());
        }
        let temp = self
            .root
            .join(format!(".state-{}.tmp", uuid::Uuid::new_v4()));
        write_new(
            &temp,
            &serde_json::to_vec(state).map_err(|e| e.to_string())?,
        )?;
        fs::rename(&temp, destination).map_err(|e| format!("commit update state: {e}"))?;
        sync_directory(&self.root)
    }
}

fn validate_identity(identity: &ReleaseIdentity) -> Result<(), String> {
    if !valid_hash(&identity.manifest_sha256)
        || identity.channel != CHANNEL
        || !valid_label(&identity.release_id)
        || !valid_label(&identity.version)
        || !valid_hash(&identity.schema_hash)
        || identity.executable != "ccgui-next.exe"
        || identity.worker_protocol != 1
        || identity.checkpoint_schema != 1
    {
        return Err("invalid release identity".into());
    }
    Ok(())
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())
}
fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(windows)]
struct StateLock(windows::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl Drop for StateLock {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::System::Threading::ReleaseMutex(self.0);
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
#[cfg(windows)]
fn state_lock(root: &Path) -> Result<StateLock, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, WAIT_ABANDONED, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{CreateMutexW, WaitForSingleObject};
    checked_directory(root)?;
    let root =
        dunce::canonicalize(root).map_err(|e| format!("canonicalize update lock root: {e}"))?;
    let key = format!(
        "{:x}",
        Sha256::digest(root.to_string_lossy().to_lowercase().as_bytes())
    );
    let name: Vec<u16> = format!("Global\\ccgui-update-state-{key}")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let handle = unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) }
        .map_err(|_| "cannot open update state mutex")?;
    let result = unsafe { WaitForSingleObject(handle, 30_000) };
    if result == WAIT_OBJECT_0 || result == WAIT_ABANDONED {
        return Ok(StateLock(handle));
    }
    unsafe {
        let _ = CloseHandle(handle);
    }
    Err("cannot acquire update state mutex".into())
}

#[cfg(unix)]
struct StateLock(File);
#[cfg(unix)]
impl Drop for StateLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}
#[cfg(unix)]
fn state_lock(root: &Path) -> Result<StateLock, String> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;
    checked_directory(root)?;
    let path = root.join(".state.lock");
    if path.exists() && !plain_metadata(&path)?.is_file() {
        return Err("invalid update lock file".into());
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| "cannot open update state lock")?;
    let until = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(StateLock(file));
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::WouldBlock || std::time::Instant::now() >= until {
            return Err("cannot acquire update state lock".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("ccgui-live-update-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn release(&self, name: &str) -> (PathBuf, String) {
            let directory = self.0.join(name);
            fs::create_dir(&directory).unwrap();
            fs::write(directory.join("ccgui-next.exe"), name).unwrap();
            let manifest = ReleaseManifest {
                manifest_version: 1,
                channel: CHANNEL.into(),
                release_id: name.into(),
                version: "1.0.0+protected.1".into(),
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
            let hash = write_manifest(&directory, &manifest);
            (directory, hash)
        }
        fn store(&self) -> UpdateStore {
            UpdateStore::open(&self.0, Limits::default()).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn write_manifest(path: &Path, manifest: &ReleaseManifest) -> String {
        let bytes = serde_json::to_vec(manifest).unwrap();
        let hash = format!("{:x}", Sha256::digest(&bytes));
        fs::write(path.join(MANIFEST), bytes).unwrap();
        hash
    }
    fn compatibility() -> Compatibility {
        Compatibility {
            worker_protocol: 1,
            checkpoint_schema: 1,
            schema_hash: "a".repeat(64),
        }
    }

    #[test]
    fn integrity_missing_extra_and_limits_fail_closed() {
        let fixture = Fixture::new();
        let (source, hash) = fixture.release("one");
        assert!(verify_release(&source, &"0".repeat(64), Limits::default()).is_err());
        assert!(verify_release(
            &source,
            &hash,
            Limits {
                max_files: 0,
                ..Limits::default()
            }
        )
        .is_err());
        assert!(verify_release(
            &source,
            &hash,
            Limits {
                max_bytes: 2,
                ..Limits::default()
            }
        )
        .is_err());
        fs::write(source.join("extra"), "x").unwrap();
        assert!(verify_release(&source, &hash, Limits::default()).is_err());
        fs::remove_file(source.join("extra")).unwrap();
        fs::write(source.join("ccgui-next.exe"), "two").unwrap();
        assert!(verify_release(&source, &hash, Limits::default()).is_err());
        fs::remove_file(source.join("ccgui-next.exe")).unwrap();
        assert!(verify_release(&source, &hash, Limits::default()).is_err());
    }

    #[test]
    fn paths_case_duplicates_and_wrong_channel_are_rejected() {
        let fixture = Fixture::new();
        let (source, hash) = fixture.release("one");
        let original = verify_manifest(&source, &hash, Limits::default()).unwrap();
        for invalid in [
            "../outside",
            "C:/outside",
            "/outside",
            "a\\b",
            "x/CON.txt",
            "COM¹",
            "CONIN$",
            "x.",
            "manifest.json",
            "ccgui-next.exe",
            "CCGUI-NEXT.EXE",
        ] {
            let mut manifest = original.clone();
            let mut file = manifest.files[0].clone();
            file.path = invalid.into();
            manifest.files.push(file);
            let hash = write_manifest(&source, &manifest);
            assert!(
                verify_release(&source, &hash, Limits::default()).is_err(),
                "{invalid}"
            );
        }
        let mut manifest = original;
        manifest.channel = "official".into();
        let hash = write_manifest(&source, &manifest);
        assert!(verify_release(&source, &hash, Limits::default()).is_err());
    }

    #[test]
    fn restart_unconfirmed_activation_commit_and_rollback() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let (old, old_hash) = fixture.release("old");
        let previous = store.stage(&old, &old_hash).unwrap();
        store.initialize_active(previous.clone()).unwrap();
        let (new, new_hash) = fixture.release("new");
        let candidate = store.stage(&new, &new_hash).unwrap();
        assert_eq!(store.stage(&new, &new_hash).unwrap(), candidate);
        let transaction = store.prepare(candidate.clone(), &compatibility()).unwrap();
        assert!(store.confirm_healthy(&transaction.id).is_err());
        store.ready(&transaction.id).unwrap();
        store.activating(&transaction.id).unwrap();
        drop(store);
        let store = fixture.store();
        let state = store.read_state().unwrap();
        assert_eq!(state.active, Some(previous.clone()));
        assert_eq!(
            state.transaction.unwrap().phase,
            TransactionPhase::Activating
        );
        store.confirm_healthy(&transaction.id).unwrap();
        assert_eq!(
            fixture.store().read_state().unwrap().active,
            Some(candidate)
        );
        assert_eq!(
            store.rollback(&transaction.id).unwrap(),
            Some(previous.clone())
        );
        assert_eq!(fixture.store().read_state().unwrap().active, Some(previous));
    }

    #[test]
    fn failure_corruption_and_compatibility_are_explicit() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let (source, hash) = fixture.release("one");
        let candidate = store.stage(&source, &hash).unwrap();
        let mut incompatible = compatibility();
        incompatible.worker_protocol = 2;
        assert!(store.prepare(candidate.clone(), &incompatible).is_err());
        incompatible = compatibility();
        incompatible.checkpoint_schema = 2;
        assert!(check_compatibility(&candidate, &incompatible).is_err());
        incompatible = compatibility();
        incompatible.schema_hash = "b".repeat(64);
        assert!(check_compatibility(&candidate, &incompatible).is_err());
        let transaction = store.prepare(candidate, &compatibility()).unwrap();
        assert!(store.ready("wrong").is_err());
        assert_eq!(store.fail(&transaction.id).unwrap(), None);
        assert_eq!(
            fixture
                .store()
                .read_state()
                .unwrap()
                .transaction
                .unwrap()
                .phase,
            TransactionPhase::Failed
        );
        fs::write(store.root.join("state.json"), "{broken").unwrap();
        assert!(store.read_state().is_err());
        assert!(UpdateStore::open(&fixture.0, Limits::default()).is_err());
    }

    #[test]
    fn modified_staged_candidate_cannot_be_activated() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let (source, hash) = fixture.release("one");
        let candidate = store.stage(&source, &hash).unwrap();
        let transaction = store.prepare(candidate.clone(), &compatibility()).unwrap();
        fs::write(
            store
                .release_path(&candidate)
                .unwrap()
                .join("ccgui-next.exe"),
            "bad",
        )
        .unwrap();
        assert!(store.ready(&transaction.id).is_err());
        assert!(store.read_state().unwrap().active.is_none());
    }

    #[test]
    fn health_confirmation_and_abort_are_mutually_exclusive() {
        for commit_first in [true, false] {
            let fixture = Fixture::new();
            let store = fixture.store();
            let (source, hash) = fixture.release("one");
            let candidate = store.stage(&source, &hash).unwrap();
            let transaction = store.prepare(candidate.clone(), &compatibility()).unwrap();
            store.ready(&transaction.id).unwrap();
            store.activating(&transaction.id).unwrap();
            if commit_first {
                store.confirm_healthy(&transaction.id).unwrap();
                assert!(store
                    .abort_activation(&transaction.id, FailureReason::CandidateHealthTimeout)
                    .is_err());
                assert_eq!(store.read_state().unwrap().active, Some(candidate));
            } else {
                store
                    .abort_activation(&transaction.id, FailureReason::CandidateHealthTimeout)
                    .unwrap();
                assert!(store.confirm_healthy(&transaction.id).is_err());
                assert_eq!(store.rollback(&transaction.id).unwrap(), None);
            }
        }
    }

    #[test]
    fn transaction_process_fixture() {
        let Ok(root) = std::env::var("CCGUI_UPDATE_TEST_ROOT") else {
            return;
        };
        let id = std::env::var("CCGUI_UPDATE_TEST_TRANSACTION").unwrap();
        let action = std::env::var("CCGUI_UPDATE_TEST_ACTION").unwrap();
        let store = UpdateStore::open(Path::new(&root), Limits::default()).unwrap();
        let result = if action == "commit" {
            store.confirm_healthy(&id).map(|_| ())
        } else {
            store.abort_activation(&id, FailureReason::CandidateHealthTimeout)
        };
        std::process::exit(if result.is_ok() { 0 } else { 2 });
    }

    #[test]
    fn separate_processes_cannot_both_commit_and_abort() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let (source, hash) = fixture.release("one");
        let candidate = store.stage(&source, &hash).unwrap();
        let transaction = store.prepare(candidate.clone(), &compatibility()).unwrap();
        store.ready(&transaction.id).unwrap();
        store.activating(&transaction.id).unwrap();
        let spawn = |action: &str| {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "live_update::tests::transaction_process_fixture",
                    "--nocapture",
                ])
                .env("CCGUI_UPDATE_TEST_ROOT", &fixture.0)
                .env("CCGUI_UPDATE_TEST_TRANSACTION", &transaction.id)
                .env("CCGUI_UPDATE_TEST_ACTION", action)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(0x0800_0000);
            }
            command.spawn().unwrap()
        };
        let mut commit = spawn("commit");
        let mut abort = spawn("abort");
        let commit_status = commit.wait().unwrap().code().unwrap();
        let abort_status = abort.wait().unwrap().code().unwrap();
        assert!(
            matches!((commit_status, abort_status), (0, 2) | (2, 0)),
            "commit={commit_status}, abort={abort_status}"
        );
        let state = store.read_state().unwrap();
        if commit_status == 0 {
            assert_eq!(state.active, Some(candidate));
            assert_eq!(
                state.transaction.unwrap().phase,
                TransactionPhase::Committed
            );
        } else {
            assert_eq!(state.active, None);
            assert_eq!(state.transaction.unwrap().phase, TransactionPhase::Failed);
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlink_source_is_rejected() {
        let fixture = Fixture::new();
        let (source, hash) = fixture.release("one");
        let alias = fixture.0.join("alias");
        std::os::unix::fs::symlink(&source, &alias).unwrap();
        assert!(verify_release(&alias, &hash, Limits::default()).is_err());
    }

    #[test]
    fn compatibility_accepts_legacy_equivalent_schema_hashes_and_rejects_unknown_hashes() {
        let fixture = Fixture::new();
        let (source, hash) = fixture.release("one");
        let mut candidate = verify_release(&source, &hash, Limits::default()).unwrap();
        let current = crate::task_worker::schema_hash();
        for &legacy in crate::task_worker::LEGACY_V1_SOURCE_SCHEMA_HASHES {
            candidate.schema_hash = current.clone();
            let expected = Compatibility {
                worker_protocol: 1,
                checkpoint_schema: 1,
                schema_hash: legacy.into(),
            };
            assert!(check_compatibility(&candidate, &expected).is_ok());
            candidate.schema_hash = legacy.into();
            let expected_current = Compatibility {
                worker_protocol: 1,
                checkpoint_schema: 1,
                schema_hash: current.clone(),
            };
            assert!(check_compatibility(&candidate, &expected_current).is_ok());
        }
        candidate.schema_hash = "c".repeat(64);
        assert_eq!(
            check_compatibility(
                &candidate,
                &Compatibility {
                    worker_protocol: 1,
                    checkpoint_schema: 1,
                    schema_hash: current,
                }
            )
            .unwrap_err(),
            "database schema hash mismatch"
        );
    }
}
