//! Profile-wide coordination before a release package exists. The OS lock is
//! shared with activation; no lease expires into a second concurrent builder.
use super::*;
use rmcp::schemars;

const MAX_CHANGES: usize = 128;
const CHANNEL_LIMIT: u64 = 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Owner {
    pub run_id: String,
    pub engine: String,
    pub session_id: Option<String>,
    pub workspace_path: String,
}
impl Owner {
    fn same_chat(&self, other: &Self) -> bool {
        self.engine == other.engine && self.workspace_path == other.workspace_path
            && match (&self.session_id, &other.session_id) {
                (Some(a), Some(b)) => a == b,
                _ => self.run_id == other.run_id,
            }
    }
}

fn main_window_owner() -> Owner {
    Owner {
        run_id: "main-window".into(), engine: "ccgui-desktop".into(),
        session_id: None, workspace_path: "ccgui:main-window".into(),
    }
}

#[derive(Clone, Debug, Default)]
pub struct ActiveRunsSnapshot {
    pub run_ids: std::collections::HashSet<String>,
    pub owners: Vec<Owner>,
}
impl ActiveRunsSnapshot {
    pub fn is_run_live(&self, run_id: &str) -> bool {
        self.run_ids.contains(run_id)
    }
    pub fn is_chat_live(&self, owner: &Owner) -> bool {
        self.run_ids.contains(&owner.run_id)
            || self.owners.iter().any(|live| live.same_chat(owner))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum Request {
    /// Declare an in-progress source modification in this chat so an update
    /// request knows to wait for this task before freezing the batch.
    Working { change_id: String, summary: String, source_root: String },
    /// Mark a verified source revision ready. Repeating a changeId replaces only
    /// this chat's queued revision; a frozen batch is never edited.
    Ready { change_id: String, summary: String, source_root: String, revision: String },
    Withdraw { change_id: String },
    /// Persist a durable update request bounded to currently ready and working
    /// tasks (plus optional wait_for_change_ids). Automatically freezes the batch
    /// once all in-scope tasks are ready.
    RequestUpdate {
        request_id: String,
        source_root: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        wait_for_change_ids: Vec<String>,
    },
    /// Cancel a pending update request before it freezes a build batch.
    CancelRequest { request_id: String },
    /// Atomically claim all ready entries for this source tree, before building.
    Begin { request_id: String, source_root: String },
    /// Release this chat's build claim after its build has stopped. Never aborts
    /// an activation transaction or kills a process.
    Abort { batch_id: String, reason: String },
}

fn label(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}
fn key(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}
pub fn validate_request(request: &Request) -> Result<(), String> {
    let valid = match request {
        Request::Working { change_id, summary, source_root } =>
            key(change_id) && label(summary, 512) && source_path_valid(source_root),
        Request::Ready { change_id, summary, source_root, revision } =>
            key(change_id) && label(summary, 512) && source_path_valid(source_root) && label(revision, 256),
        Request::Withdraw { change_id } => key(change_id),
        Request::RequestUpdate { request_id, source_root, wait_for_change_ids } =>
            key(request_id) && source_path_valid(source_root) && wait_for_change_ids.len() <= MAX_CHANGES
                && wait_for_change_ids.iter().all(|id| key(id)),
        Request::CancelRequest { request_id } => key(request_id),
        Request::Begin { request_id, source_root } => key(request_id) && source_path_valid(source_root),
        Request::Abort { batch_id, reason } => uuid::Uuid::parse_str(batch_id).is_ok() && label(reason, 512),
    };
    if valid { Ok(()) } else { Err("Invalid self-update channel arguments".into()) }
}
fn source_path_valid(value: &str) -> bool {
    label(value, 4096) && !value.contains("://") && Path::new(value).is_absolute()
}
fn source_root(value: &str) -> Result<String, String> {
    if !source_path_valid(value) { return Err("sourceRoot must be an absolute local directory".into()); }
    checked_directory(Path::new(value))?;
    let canonical = dunce::canonicalize(value).map_err(|e| format!("canonicalize update source: {e}"))?;
    let value = canonical.to_str().ok_or("update source is not Unicode")?.to_owned();
    #[cfg(windows)]
    let value = value.to_lowercase();
    Ok(value)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingTask {
    pub id: String,
    pub change_id: String,
    pub summary: String,
    pub source_root: String,
    pub owner: Owner,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    pub id: String,
    pub change_id: String,
    pub summary: String,
    pub source_root: String,
    pub revision: String,
    pub owner: Owner,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateRequest {
    pub id: String,
    pub request_id: String,
    pub owner: Owner,
    pub source_root: String,
    /// Bounded changeIds that must reach `ready` (or be withdrawn) before this
    /// request freezes its batch. Tasks started later belong to the next batch.
    pub target_change_ids: Vec<String>,
    pub waiting_for: Vec<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Phase { Building, Staging, Preparing, Ready, Activating, Committed, Failed, RolledBack, Aborted }
impl Phase {
    pub fn busy(&self) -> bool {
        matches!(self, Self::Building | Self::Staging | Self::Preparing | Self::Ready | Self::Activating)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Batch {
    pub id: String,
    pub request_id: String,
    pub owner: Owner,
    pub source_root: String,
    pub phase: Phase,
    pub changes: Vec<Change>,
    pub manifest_sha256: Option<String>,
    pub transaction_id: Option<String>,
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub auto_build: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Channel {
    pub version: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub working: Vec<PendingTask>,
    pub ready: Vec<Change>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_request: Option<UpdateRequest>,
    pub batch: Option<Batch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_source_root: Option<String>,
}
impl Default for Channel {
    fn default() -> Self {
        Self { version: 1, working: Vec::new(), ready: Vec::new(), update_request: None, batch: None, default_source_root: None }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    /// Only true for a newly persisted claim. A replay never instructs the caller
    /// to launch another build, even when it owns the existing batch.
    pub start_build: bool,
    pub owns_batch: bool,
    pub channel: Channel,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BatchProof {
    pub batch_id: String,
    pub source_root: String,
    pub changes: Vec<ChangeProof>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangeProof { pub id: String, pub revision: String }
impl Batch {
    pub fn proof(&self) -> BatchProof {
        BatchProof { batch_id: self.id.clone(), source_root: self.source_root.clone(),
            changes: self.changes.iter().map(|c| ChangeProof { id: c.id.clone(), revision: c.revision.clone() }).collect() }
    }
}

pub(super) fn transaction_busy(state: &UpdateState) -> bool {
    state.transaction.as_ref().is_some_and(|tx| {
        matches!(tx.phase, TransactionPhase::Preparing | TransactionPhase::Ready | TransactionPhase::Activating)
            || (tx.phase == TransactionPhase::Failed && tx.failure_reason == Some(FailureReason::CandidateIdentityUnknown))
    })
}

fn push_unique(list: &mut Vec<String>, item: String) {
    if !list.iter().any(|existing| existing == &item) {
        list.push(item);
    }
}

fn restore_unclaimed_batch_changes(ready: &mut Vec<Change>, batch_changes: &[Change]) -> Result<(), String> {
    let mut restored = Vec::new();
    for change in batch_changes {
        if !ready.iter().any(|queued| queued.owner.same_chat(&change.owner) && queued.change_id == change.change_id) {
            restored.push(change.clone());
        }
    }
    if restored.len().saturating_add(ready.len()) > MAX_CHANGES {
        return Err("self-update ready queue is full".into());
    }
    restored.append(ready);
    *ready = restored;
    Ok(())
}

/// Remove working declarations left behind by chats that are no longer actively
/// running in host_chat so an idle/dead session never blocks `waiting_for`.
fn prune_orphaned_working(channel: &mut Channel, active: Option<&ActiveRunsSnapshot>) -> bool {
    let Some(active) = active else { return false; };
    let before = channel.working.len();
    let mut removed: Vec<(String, String)> = Vec::new();
    channel.working.retain(|task| {
        let keep = active.is_chat_live(&task.owner);
        if !keep {
            removed.push((task.source_root.clone(), task.change_id.clone()));
        }
        keep
    });
    if channel.working.len() == before {
        return false;
    }
    if let Some(req) = channel.update_request.as_mut() {
        for (root, change_id) in removed {
            if root != req.source_root {
                continue;
            }
            let still_exists = channel.working.iter().any(|t| t.source_root == req.source_root && t.change_id == change_id)
                || channel.ready.iter().any(|c| c.source_root == req.source_root && c.change_id == change_id);
            if !still_exists {
                req.target_change_ids.retain(|id| id != &change_id);
                req.waiting_for.retain(|id| id != &change_id);
            }
        }
        if req.target_change_ids.is_empty() {
            channel.update_request = None;
        }
    }
    true
}

/// Reclaim a manual `Begin` batch (`auto_build == false`, `Phase::Building`, no
/// bound manifest) when the run that claimed it is no longer active, restoring
/// its changes to `ready` so a server restart or interrupted turn does not
/// strand the channel.
fn reclaim_orphaned_manual_batch(
    channel: &mut Channel,
    state: &UpdateState,
    active: Option<&ActiveRunsSnapshot>,
) -> Result<bool, String> {
    let Some(active) = active else { return Ok(false); };
    if transaction_busy(state) {
        return Ok(false);
    }
    let is_orphaned = channel.batch.as_ref().is_some_and(|batch| {
        batch.phase == Phase::Building
            && !batch.auto_build
            && batch.manifest_sha256.is_none()
            && !active.is_run_live(&batch.owner.run_id)
    });
    if !is_orphaned {
        return Ok(false);
    }
    let batch = channel.batch.as_mut().unwrap();
    restore_unclaimed_batch_changes(&mut channel.ready, &batch.changes)?;
    batch.phase = Phase::Aborted;
    batch.error = Some("orphaned manual build run ended before staging a package".into());
    Ok(true)
}

/// Recompute waiting_for for a bounded UpdateRequest and atomically freeze the
/// matching ready changes into a Building batch when all in-scope tasks are ready
/// and the build/activation channel is idle.
fn advance_update_request(channel: &mut Channel, state: &UpdateState, claimer_override: Option<&Owner>) -> bool {
    let Some(req) = channel.update_request.as_mut() else { return false; };
    req.waiting_for.retain(|change_id| {
        !channel.ready.iter().any(|c| c.source_root == req.source_root && &c.change_id == change_id)
    });
    for task in &channel.working {
        if task.source_root == req.source_root
            && req.target_change_ids.iter().any(|id| id == &task.change_id)
            && !channel.ready.iter().any(|c| c.source_root == req.source_root && c.change_id == task.change_id)
        {
            push_unique(&mut req.waiting_for, task.change_id.clone());
        }
    }
    if !req.waiting_for.is_empty() {
        return false;
    }
    if channel.batch.as_ref().is_some_and(|b| b.phase.busy()) || transaction_busy(state) {
        return false;
    }
    let has_in_scope = channel.ready.iter().any(|c| {
        c.source_root == req.source_root && req.target_change_ids.iter().any(|id| id == &c.change_id)
    });
    if !has_in_scope {
        return false;
    }
    let req = channel.update_request.take().unwrap();
    let mut frozen = Vec::new();
    let mut remaining = Vec::new();
    for change in std::mem::take(&mut channel.ready) {
        if change.source_root == req.source_root && req.target_change_ids.iter().any(|id| id == &change.change_id) {
            frozen.push(change);
        } else {
            remaining.push(change);
        }
    }
    channel.ready = remaining;
    // A chat completing the last task must not take ownership of a desktop
    // request: its stable identity is also the terminal replay key.
    let batch_owner = if req.owner == main_window_owner() {
        req.owner
    } else {
        claimer_override.cloned().unwrap_or(req.owner)
    };
    channel.batch = Some(Batch {
        id: uuid::Uuid::new_v4().to_string(),
        request_id: req.request_id,
        owner: batch_owner,
        source_root: req.source_root,
        phase: Phase::Building,
        changes: frozen,
        manifest_sha256: None,
        transaction_id: None,
        error: None,
        auto_build: true,
    });
    true
}

impl UpdateStore {
    fn read_channel_unlocked(&self) -> Result<Channel, String> {
        checked_directory(&self.root)?;
        let path = self.root.join("channel.json");
        let mut channel: Channel = match fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Channel::default(),
            Err(e) => return Err(e.to_string()),
            Ok(_) => serde_json::from_slice(&bounded_read(&path, CHANNEL_LIMIT)?)
                .map_err(|e| format!("corrupt update channel: {e}"))?,
        };
        if channel.version != 1 || channel.ready.len() > MAX_CHANGES || channel.working.len() > MAX_CHANGES {
            return Err("unsupported or oversized update channel".into());
        }
        if let Some(req) = &channel.update_request {
            if uuid::Uuid::parse_str(&req.id).is_err()
                || req.target_change_ids.len() > MAX_CHANGES
                || req.waiting_for.len() > MAX_CHANGES
            {
                return Err("invalid update request".into());
            }
        }
        if let Some(batch) = &channel.batch {
            if uuid::Uuid::parse_str(&batch.id).is_err() || batch.changes.is_empty() || batch.changes.len() > MAX_CHANGES
                || batch.manifest_sha256.as_deref().is_some_and(|hash| !valid_hash(hash)) {
                return Err("invalid update batch".into());
            }
        }
        // The activation journal is authoritative. Never infer success from an
        // accepted prepare call, an expired clock, or a missing owner process.
        let state = self.read_state()?;
        if let (Some(batch), Some(tx)) = (&mut channel.batch, state.transaction.as_ref()) {
            if batch.manifest_sha256.as_deref() == Some(tx.candidate.manifest_sha256.as_str()) && batch.phase != Phase::Aborted {
                batch.transaction_id = Some(tx.id.clone());
                batch.phase = match tx.phase {
                    TransactionPhase::Preparing => Phase::Preparing,
                    TransactionPhase::Ready => Phase::Ready,
                    TransactionPhase::Activating => Phase::Activating,
                    TransactionPhase::Committed => Phase::Committed,
                    TransactionPhase::RolledBack => Phase::RolledBack,
                    TransactionPhase::Failed if tx.failure_reason == Some(FailureReason::CandidateIdentityUnknown) => Phase::Activating,
                    TransactionPhase::Failed => Phase::Failed,
                };
                batch.error = tx.failure_reason.map(|reason| format!("{reason:?}"));
            }
        }
        if channel.default_source_root.is_none() {
            if let Ok(raw) = fs::read_to_string(self.root.join("default-source-root.txt")) {
                let trimmed = raw.trim();
                if source_path_valid(trimmed)
                    && Path::new(trimmed).join("src-tauri").join("tauri.conf.json").is_file()
                {
                    channel.default_source_root = Some(trimmed.to_owned());
                }
            }
        }
        Ok(channel)
    }

    pub fn channel_status(&self) -> Result<Channel, String> {
        let _guard = WRITES.lock().map_err(|_| "update write lock poisoned")?;
        let _process_guard = state_lock(&self.root)?;
        self.read_channel_unlocked()
    }

    /// Advance a ready UpdateRequest when the previous batch/transaction has
    /// finished, and return the active auto_build Batch if one is Building.
    pub fn poll_update_request(&self) -> Result<Option<Batch>, String> {
        let active = crate::host_chat::active_runs_snapshot();
        self.poll_update_request_with_active(active.as_ref())
    }

    pub fn poll_update_request_with_active(
        &self,
        active: Option<&ActiveRunsSnapshot>,
    ) -> Result<Option<Batch>, String> {
        let _guard = WRITES.lock().map_err(|_| "update write lock poisoned")?;
        let _process_guard = state_lock(&self.root)?;
        let mut channel = self.read_channel_unlocked()?;
        let state = self.read_state()?;
        let pruned = prune_orphaned_working(&mut channel, active);
        let reclaimed = reclaim_orphaned_manual_batch(&mut channel, &state, active)?;
        let advanced = advance_update_request(&mut channel, &state, None);
        if pruned || reclaimed || advanced {
            self.persist_channel(&channel)?;
        }
        Ok(channel.batch.filter(|b| b.phase == Phase::Building && b.auto_build))
    }

    /// Called under the shared state lock before replacing the sole activation
    /// journal. Preserve its final outcome before that evidence is superseded.
    pub(super) fn checkpoint_channel_unlocked(&self) -> Result<(), String> {
        let channel = self.read_channel_unlocked()?;
        if channel.batch.is_some() || channel.update_request.is_some() || !channel.working.is_empty() {
            self.persist_channel(&channel)?;
        }
        Ok(())
    }

    fn persist_channel(&self, channel: &Channel) -> Result<(), String> {
        checked_directory(&self.root)?;
        let destination = self.root.join("channel.json");
        if destination.try_exists().map_err(|e| e.to_string())? && !plain_metadata(&destination)?.is_file() {
            return Err("update channel is not a regular file".into());
        }
        let bytes = serde_json::to_vec(channel).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > CHANNEL_LIMIT { return Err("update channel exceeds its size limit".into()); }
        let temporary = self.root.join(format!(".channel-{}.tmp", uuid::Uuid::new_v4()));
        write_new(&temporary, &bytes)?;
        fs::rename(temporary, destination).map_err(|e| format!("commit update channel: {e}"))?;
        sync_directory(&self.root)
    }

    pub fn coordinate_update(&self, owner: Owner, request: Request) -> Result<Reply, String> {
        let active = crate::host_chat::active_runs_snapshot();
        self.coordinate_update_with_active(owner, request, active.as_ref())
    }

    /// The desktop owns its request independently of every authenticated chat.
    /// Inspecting the queue and requesting its bounded scope share the same OS
    /// lock as MCP coordination, so a competing request cannot be overwritten.
    pub fn request_update_from_main_window(&self, request_id: String) -> Result<Reply, String> {
        self.request_update_from_main_window_with_source(request_id, None)
    }

    pub fn request_update_from_main_window_with_source(
        &self,
        request_id: String,
        fallback_source_root: Option<String>,
    ) -> Result<Reply, String> {
        let active = crate::host_chat::active_runs_snapshot();
        self.request_update_from_main_window_with_active_and_source(request_id, fallback_source_root, active.as_ref())
    }

    fn request_update_from_main_window_with_active(
        &self,
        request_id: String,
        active: Option<&ActiveRunsSnapshot>,
    ) -> Result<Reply, String> {
        self.request_update_from_main_window_with_active_and_source(request_id, None, active)
    }

    fn request_update_from_main_window_with_active_and_source(
        &self,
        request_id: String,
        fallback_source_root: Option<String>,
        active: Option<&ActiveRunsSnapshot>,
    ) -> Result<Reply, String> {
        if !key(&request_id) { return Err("Invalid self-update request ID".into()); }
        let owner = main_window_owner();
        let _guard = WRITES.lock().map_err(|_| "update write lock poisoned")?;
        let _process_guard = state_lock(&self.root)?;
        let mut channel = self.read_channel_unlocked()?;
        let owns_batch = channel.batch.as_ref().is_some_and(|b| b.owner.same_chat(&owner));
        if channel.update_request.is_some() || channel.batch.as_ref().is_some_and(|b| {
            b.phase.busy() || (b.owner.same_chat(&owner) && b.request_id == request_id)
        }) {
            return Ok(Reply { start_build: false, owns_batch, channel });
        }
        let state = self.read_state()?;
        prune_orphaned_working(&mut channel, active);
        if channel.ready.is_empty() && channel.working.is_empty() {
            if let Some(raw_root) = fallback_source_root.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                let normalized = source_root(raw_root)?;
                channel.ready.push(Change {
                    id: uuid::Uuid::new_v4().to_string(),
                    change_id: "self-dev-manual-build".to_string(),
                    summary: "Manual build & live update from self-dev workspace".to_string(),
                    source_root: normalized,
                    revision: "working-tree".to_string(),
                    owner: owner.clone(),
                });
            }
        }
        let mut roots = channel.ready.iter().map(|c| c.source_root.as_str())
            .chain(channel.working.iter().map(|t| t.source_root.as_str()));
        let root = roots.next().ok_or("no ready or working changes are registered")?;
        if roots.any(|other| other != root) {
            return Err("ready or working changes use different source trees; integrate and register them in one sourceRoot before requesting an update".into());
        }
        let root = source_root(root)?;
        let request = Request::RequestUpdate {
            request_id, source_root: root.clone(), wait_for_change_ids: Vec::new(),
        };
        self.coordinate_update_locked(owner, request, Some(root), active, channel, state)
    }

    pub fn coordinate_update_with_active(
        &self,
        owner: Owner,
        request: Request,
        active: Option<&ActiveRunsSnapshot>,
    ) -> Result<Reply, String> {
        validate_request(&request)?;
        let source = match &request {
            Request::Working { source_root: root, .. }
            | Request::Ready { source_root: root, .. }
            | Request::RequestUpdate { source_root: root, .. }
            | Request::Begin { source_root: root, .. } => Some(source_root(root)?),
            _ => None,
        };
        let _guard = WRITES.lock().map_err(|_| "update write lock poisoned")?;
        let _process_guard = state_lock(&self.root)?;
        let channel = self.read_channel_unlocked()?;
        let state = self.read_state()?;
        self.coordinate_update_locked(owner, request, source, active, channel, state)
    }

    fn coordinate_update_locked(
        &self,
        owner: Owner,
        request: Request,
        source: Option<String>,
        active: Option<&ActiveRunsSnapshot>,
        mut channel: Channel,
        state: UpdateState,
    ) -> Result<Reply, String> {
        prune_orphaned_working(&mut channel, active);
        if !matches!(request, Request::Abort { .. }) {
            reclaim_orphaned_manual_batch(&mut channel, &state, active)?;
        }
        let mut start_build = false;
        match request {
            Request::Working { change_id, summary, .. } => {
                let root = source.unwrap();
                channel.ready.retain(|c| !(c.owner.same_chat(&owner) && c.change_id == change_id));
                if let Some(task) = channel.working.iter_mut().find(|t| t.owner.same_chat(&owner) && t.change_id == change_id) {
                    task.summary = summary;
                    task.source_root = root;
                } else {
                    if channel.working.len() >= MAX_CHANGES { return Err("self-update working queue is full".into()); }
                    channel.working.push(PendingTask {
                        id: uuid::Uuid::new_v4().to_string(),
                        change_id,
                        summary,
                        source_root: root,
                        owner: owner.clone(),
                    });
                }
            }
            Request::Ready { change_id, summary, revision, .. } => {
                let root = source.unwrap();
                channel.working.retain(|t| !(t.owner.same_chat(&owner) && t.change_id == change_id));
                if let Some(change) = channel.ready.iter_mut().find(|c| c.owner.same_chat(&owner) && c.change_id == change_id) {
                    change.summary = summary; change.source_root = root; change.revision = revision;
                } else {
                    if channel.ready.len() >= MAX_CHANGES { return Err("self-update ready queue is full".into()); }
                    channel.ready.push(Change { id: uuid::Uuid::new_v4().to_string(), change_id, summary,
                        source_root: root, revision, owner: owner.clone() });
                }
                start_build = advance_update_request(&mut channel, &state, Some(&owner));
            }
            Request::Withdraw { change_id } => {
                channel.working.retain(|t| !(t.owner.same_chat(&owner) && t.change_id == change_id));
                channel.ready.retain(|c| !(c.owner.same_chat(&owner) && c.change_id == change_id));
                if let Some(req) = channel.update_request.as_mut() {
                    let still_exists = channel.working.iter().any(|t| t.source_root == req.source_root && t.change_id == change_id)
                        || channel.ready.iter().any(|c| c.source_root == req.source_root && c.change_id == change_id);
                    if !still_exists {
                        req.target_change_ids.retain(|id| id != &change_id);
                        req.waiting_for.retain(|id| id != &change_id);
                    }
                    if req.target_change_ids.is_empty() {
                        channel.update_request = None;
                    }
                }
                start_build = advance_update_request(&mut channel, &state, Some(&owner));
            }
            Request::RequestUpdate { request_id, wait_for_change_ids, .. } => {
                let root = source.unwrap();
                if let Some(batch) = &channel.batch {
                    if batch.phase.busy() || (batch.owner.same_chat(&owner) && batch.request_id == request_id) {
                        return Ok(Reply { start_build: false, owns_batch: batch.owner.same_chat(&owner), channel });
                    }
                }
                if channel.update_request.is_some() {
                    return Ok(Reply { start_build: false, owns_batch: false, channel });
                }
                if channel.ready.iter().any(|c| c.source_root != root)
                    || channel.working.iter().any(|t| t.source_root != root)
                {
                    return Err("ready or working changes use different source trees; integrate and register them in one sourceRoot before requesting an update".into());
                }
                let mut target_change_ids = Vec::new();
                for change in &channel.ready {
                    if change.source_root == root {
                        push_unique(&mut target_change_ids, change.change_id.clone());
                    }
                }
                let mut waiting_for = Vec::new();
                for task in &channel.working {
                    if task.source_root == root {
                        push_unique(&mut target_change_ids, task.change_id.clone());
                        if !channel.ready.iter().any(|c| c.source_root == root && c.change_id == task.change_id) {
                            push_unique(&mut waiting_for, task.change_id.clone());
                        }
                    }
                }
                for explicit_id in wait_for_change_ids {
                    let known_ready = channel.ready.iter().any(|c| c.source_root == root && c.change_id == explicit_id);
                    let known_working = channel.working.iter().any(|t| t.source_root == root && t.change_id == explicit_id);
                    if known_ready || known_working || active.is_none() {
                        push_unique(&mut target_change_ids, explicit_id.clone());
                        if !known_ready {
                            push_unique(&mut waiting_for, explicit_id);
                        }
                    }
                }
                if target_change_ids.is_empty() {
                    return Err("no ready or working changes are registered for this sourceRoot".into());
                }
                if target_change_ids.len() > MAX_CHANGES {
                    return Err("self-update request scope exceeds limit".into());
                }
                channel.update_request = Some(UpdateRequest {
                    id: uuid::Uuid::new_v4().to_string(),
                    request_id,
                    owner: owner.clone(),
                    source_root: root,
                    target_change_ids,
                    waiting_for,
                });
                start_build = advance_update_request(&mut channel, &state, Some(&owner));
            }
            Request::CancelRequest { request_id } => {
                if let Some(existing) = &channel.update_request {
                    if existing.request_id != request_id {
                        return Err("update request_id does not match the active update request".into());
                    }
                    channel.update_request = None;
                }
            }
            Request::Begin { request_id, .. } => {
                if let Some(batch) = &channel.batch {
                    if batch.phase.busy() || (batch.owner.same_chat(&owner) && batch.request_id == request_id) {
                        return Ok(Reply { start_build: false, owns_batch: batch.owner.same_chat(&owner), channel });
                    }
                }
                if transaction_busy(&state) { return Err("an update transaction is already pending; query get_self_update_status".into()); }
                let root = source.unwrap();
                if let Some(req) = &channel.update_request {
                    if !req.waiting_for.is_empty() {
                        return Err(format!("update request is waiting for in-scope tasks: {}", req.waiting_for.join(", ")));
                    }
                }
                if channel.ready.is_empty() { return Err("no changes are marked ready".into()); }
                if channel.ready.iter().any(|change| change.source_root != root) {
                    return Err("ready changes use different source trees; integrate and register them in one sourceRoot before beginning".into());
                }
                let changes = if let Some(req) = channel.update_request.take() {
                    let mut frozen = Vec::new();
                    let mut remaining = Vec::new();
                    for change in std::mem::take(&mut channel.ready) {
                        if change.source_root == root && req.target_change_ids.iter().any(|id| id == &change.change_id) {
                            frozen.push(change);
                        } else {
                            remaining.push(change);
                        }
                    }
                    channel.ready = remaining;
                    if frozen.is_empty() { std::mem::take(&mut channel.ready) } else { frozen }
                } else {
                    std::mem::take(&mut channel.ready)
                };
                channel.batch = Some(Batch { id: uuid::Uuid::new_v4().to_string(), request_id, owner: owner.clone(),
                    source_root: root, phase: Phase::Building, changes,
                    manifest_sha256: None, transaction_id: None, error: None, auto_build: false });
                start_build = true;
            }
            Request::Abort { batch_id, reason } => {
                let batch = channel.batch.as_mut().ok_or("no update batch")?;
                let can_release_orphaned = active.is_some_and(|live| {
                    batch.phase == Phase::Building
                        && !batch.auto_build
                        && batch.manifest_sha256.is_none()
                        && !live.is_run_live(&batch.owner.run_id)
                        && source_root(&owner.workspace_path).ok().as_deref() == Some(batch.source_root.as_str())
                });
                if batch.id != batch_id || (!batch.owner.same_chat(&owner) && !can_release_orphaned) {
                    return Err("only the claiming chat can release this update batch".into());
                }
                if transaction_busy(&state) { return Err("activation is in progress; build abort cannot release its channel".into()); }
                if !matches!(batch.phase, Phase::Building | Phase::Staging | Phase::Aborted) {
                    return Err("this batch already has an activation outcome".into());
                }
                if batch.phase != Phase::Aborted {
                    restore_unclaimed_batch_changes(&mut channel.ready, &batch.changes)?;
                }
                batch.phase = Phase::Aborted; batch.error = Some(reason);
                start_build = advance_update_request(&mut channel, &state, None);
            }
        }
        self.persist_channel(&channel)?;
        Ok(Reply { start_build, owns_batch: channel.batch.as_ref().is_some_and(|b| b.owner.same_chat(&owner)), channel })
    }

    /// Bind one immutable package to the build claim before asynchronous staging.
    /// The packager records the frozen inventory; this is a local provenance
    /// declaration, not proof that arbitrary source code compiled successfully.
    pub fn bind_update_package(&self, owner: &Owner, batch_id: Option<&str>, hash: &str, source: &Path) -> Result<(), String> {
        if !valid_hash(hash) { return Err("invalid update manifest hash".into()); }
        let _guard = WRITES.lock().map_err(|_| "update write lock poisoned")?;
        let _process_guard = state_lock(&self.root)?;
        let mut channel = self.read_channel_unlocked()?;
        let Some(batch) = channel.batch.as_mut() else {
            return if batch_id.is_none() { Ok(()) } else { Err("unknown update batch".into()) };
        };
        // Legacy package-only callers remain compatible when there is no active
        // claim. They cannot replace or join somebody else's in-progress build.
        if batch_id.is_none() && !batch.phase.busy() { return Ok(()); }
        if batch_id != Some(batch.id.as_str()) || !batch.owner.same_chat(owner) {
            return Err("self-update channel is claimed; use its owning chat and batchId".into());
        }
        if let Some(bound) = &batch.manifest_sha256 {
            return if bound == hash { Ok(()) } else { Err("batch is already bound to another manifest; reconcile the original update first".into()) };
        }
        if batch.phase != Phase::Building { return Err("batch is not building".into()); }
        let state = self.read_state()?;
        if state.active.as_ref().is_some_and(|active| active.manifest_sha256 == hash)
            || state.transaction.as_ref().is_some_and(|tx| tx.candidate.manifest_sha256 == hash) {
            return Err("a new batch cannot claim an earlier release; build a new package".into());
        }
        let manifest = verify_manifest(source, hash, self.limits)?;
        let proof_file = manifest.files.iter().find(|file| file.path == "build-provenance.json")
            .ok_or("package manifest does not cover build provenance")?;
        let proof_bytes = bounded_read(&source.join("build-provenance.json"), CHANNEL_LIMIT)?;
        if proof_bytes.len() as u64 != proof_file.bytes || format!("{:x}", Sha256::digest(&proof_bytes)) != proof_file.sha256 {
            return Err("build provenance differs from the verified package manifest".into());
        }
        let provenance: serde_json::Value = serde_json::from_slice(&proof_bytes)
            .map_err(|_| "invalid build provenance")?;
        let proof: BatchProof = serde_json::from_value(provenance.get("updateBatch").cloned().ok_or("package must include the frozen updateBatch provenance")?)
            .map_err(|_| "invalid updateBatch provenance")?;
        if proof != batch.proof() { return Err("package does not declare every frozen ready revision".into()); }
        batch.manifest_sha256 = Some(hash.to_owned()); batch.phase = Phase::Staging;
        self.persist_channel(&channel)
    }

    pub fn check_channel_candidate(&self, hash: &str) -> Result<(), String> {
        let _guard = WRITES.lock().map_err(|_| "update write lock poisoned")?;
        let _process_guard = state_lock(&self.root)?;
        self.check_channel_candidate_unlocked(hash)
    }
    pub(super) fn check_channel_candidate_unlocked(&self, hash: &str) -> Result<(), String> {
        if let Some(batch) = self.read_channel_unlocked()?.batch {
            if batch.phase == Phase::Aborted && batch.manifest_sha256.as_deref() == Some(hash) {
                return Err("this package belongs to an aborted build batch".into());
            }
            if batch.phase.busy() && batch.manifest_sha256.as_deref() != Some(hash) {
                return Err("a self-update batch already owns the build and activation channel".into());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("ccgui-channel-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap(); Self(path)
        }
        fn store(&self) -> UpdateStore { UpdateStore::open(&self.0, Limits::default()).unwrap() }
        fn ready(&self, owner: &Owner, name: &str, revision: &str) -> Reply {
            self.store().coordinate_update(owner.clone(), Request::Ready { change_id: name.into(), summary: name.into(),
                source_root: self.0.to_string_lossy().into(), revision: revision.into() }).unwrap()
        }
        fn begin(&self, owner: &Owner, id: &str) -> Reply {
            self.store().coordinate_update(owner.clone(), Request::Begin { request_id: id.into(),
                source_root: self.0.to_string_lossy().into() }).unwrap()
        }
        fn package(&self, batch: &Batch) -> PathBuf {
            let path = self.0.join(format!("package-{}", uuid::Uuid::new_v4())); fs::create_dir(&path).unwrap();
            fs::write(path.join("ccgui-next.exe"), b"fixture").unwrap();
            fs::write(path.join("build-provenance.json"), serde_json::to_vec(&serde_json::json!({"updateBatch":batch.proof()})).unwrap()).unwrap(); path
        }
        fn hash(&self, path: &Path) -> String {
            let files = ["build-provenance.json", "ccgui-next.exe"].iter().map(|name| {
                let bytes = fs::read(path.join(name)).unwrap();
                ReleaseFile { path: (*name).into(), bytes: bytes.len() as u64, sha256: format!("{:x}", Sha256::digest(&bytes)) }
            }).collect();
            let manifest = ReleaseManifest { manifest_version: 1, channel: CHANNEL.into(), release_id: "fixture".into(),
                version: "1.0.0".into(), worker_protocol: 1, checkpoint_schema: 1, schema_hash: "b".repeat(64), executable: "ccgui-next.exe".into(), files };
            let bytes = serde_json::to_vec(&manifest).unwrap();
            fs::write(path.join(MANIFEST), &bytes).unwrap(); format!("{:x}", Sha256::digest(bytes))
        }
        fn transaction(&self, hash: &str, phase: TransactionPhase) {
            let candidate = ReleaseIdentity { manifest_sha256: hash.into(), channel: CHANNEL.into(), release_id: "fixture".into(),
                version: "1.0.0".into(), worker_protocol: 1, checkpoint_schema: 1, schema_hash: "b".repeat(64), executable: "ccgui-next.exe".into() };
            self.store().persist(&UpdateState { state_version: 1,
                active: if phase == TransactionPhase::Committed { Some(candidate.clone()) } else { None },
                transaction: Some(Transaction { id: uuid::Uuid::new_v4().to_string(), phase, candidate, previous: None, failure_reason: None }) }).unwrap();
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    fn owner(name: &str) -> Owner { Owner { run_id: format!("run-{name}"), engine: name.into(), session_id: Some(format!("chat-{name}")), workspace_path: "fixture".into() } }

    #[test]
    fn main_window_request_freezes_once_and_replays_terminal_batch() {
        let f = Fixture::new();
        f.ready(&owner("codex"), "ui", "r1");
        let first = f.store().request_update_from_main_window("desktop-1".into()).unwrap();
        assert!(first.start_build);
        let batch = first.channel.batch.unwrap();
        assert!(batch.auto_build);
        assert_eq!(batch.owner.engine, "ccgui-desktop");
        assert_ne!(batch.owner, owner("codex"));
        let replay = f.store().request_update_from_main_window("desktop-1".into()).unwrap();
        assert!(!replay.start_build);
        assert_eq!(replay.channel.batch.as_ref(), Some(&batch));
        f.store().coordinate_update(batch.owner.clone(), Request::Abort {
            batch_id: batch.id.clone(), reason: "fixture build failed".into(),
        }).unwrap();
        let terminal = f.store().request_update_from_main_window("desktop-1".into()).unwrap();
        assert!(!terminal.start_build);
        assert_eq!(terminal.channel.batch.unwrap().phase, Phase::Aborted);
        assert_eq!(terminal.channel.ready.len(), 1);
        assert!(f.store().request_update_from_main_window("desktop-2".into()).unwrap().start_build);
    }

    #[test]
    fn main_window_request_rejects_empty_and_ambiguous_sources() {
        let f = Fixture::new();
        assert!(f.store().request_update_from_main_window("empty".into()).unwrap_err().contains("no ready or working"));
        assert!(f.store().request_update_from_main_window("invalid ID".into()).is_err());
        f.ready(&owner("codex"), "ui", "r1");
        let other = Fixture::new();
        f.store().coordinate_update(owner("claude"), Request::Working {
            change_id: "other".into(), summary: "other source".into(), source_root: other.0.to_string_lossy().into(),
        }).unwrap();
        assert!(f.store().request_update_from_main_window_with_active("ambiguous".into(), None).unwrap_err().contains("different source trees"));
        assert!(f.store().channel_status().unwrap().batch.is_none());
    }

    #[test]
    fn main_window_request_preserves_pending_scope_and_foreign_busy_batch() {
        let f = Fixture::new(); let a = owner("codex");
        f.ready(&a, "ui", "r1");
        f.store().coordinate_update(a.clone(), Request::Working {
            change_id: "work".into(), summary: "working".into(), source_root: f.0.to_string_lossy().into(),
        }).unwrap();
        let pending = f.store().coordinate_update(a.clone(), Request::RequestUpdate {
            request_id: "chat-request".into(), source_root: f.0.to_string_lossy().into(), wait_for_change_ids: Vec::new(),
        }).unwrap().channel.update_request;
        f.ready(&owner("claude"), "later", "r2");
        let reply = f.store().request_update_from_main_window_with_active("desktop".into(), None).unwrap();
        assert!(!reply.start_build);
        assert_eq!(reply.channel.update_request, pending);
        let batch = f.ready(&a, "work", "r3").channel.batch;
        let reply = f.store().request_update_from_main_window("desktop".into()).unwrap();
        assert!(!reply.start_build);
        assert!(!reply.owns_batch);
        assert_eq!(reply.channel.batch, batch);
        assert!(reply.channel.update_request.is_none());
        assert_eq!(reply.channel.ready.len(), 1);
    }

    #[test]
    fn chat_request_cannot_replace_desktop_pending_scope_or_busy_batch() {
        let f = Fixture::new(); let a = owner("codex");
        f.ready(&a, "ui", "r1");
        f.store().coordinate_update(a.clone(), Request::Working {
            change_id: "work".into(), summary: "working".into(), source_root: f.0.to_string_lossy().into(),
        }).unwrap();
        let pending = f.store().request_update_from_main_window_with_active("desktop".into(), None).unwrap().channel.update_request;
        assert!(pending.is_some());
        f.ready(&owner("claude"), "later", "r2");
        let request = Request::RequestUpdate {
            request_id: "chat-request".into(), source_root: f.0.to_string_lossy().into(), wait_for_change_ids: vec!["extra".into()],
        };
        let reply = f.store().coordinate_update(a.clone(), request.clone()).unwrap();
        assert!(!reply.start_build);
        assert_eq!(reply.channel.update_request, pending);
        let batch = f.ready(&a, "work", "r3").channel.batch;
        let reply = f.store().coordinate_update(a, request).unwrap();
        assert!(!reply.start_build);
        assert_eq!(reply.channel.batch, batch);
        assert!(reply.channel.update_request.is_none());
        assert_eq!(reply.channel.ready.len(), 1);
    }

    #[test]
    fn desktop_waiting_request_keeps_owner_through_ready_and_committed_replay() {
        let f = Fixture::new(); let a = owner("codex");
        f.store().coordinate_update(a.clone(), Request::Working {
            change_id: "work".into(), summary: "working".into(), source_root: f.0.to_string_lossy().into(),
        }).unwrap();
        let pending = f.store().request_update_from_main_window_with_active("desktop".into(), None).unwrap();
        assert!(!pending.start_build);
        let batch = f.ready(&a, "work", "r1").channel.batch.unwrap();
        assert_eq!(batch.owner, main_window_owner());
        let package = f.package(&batch); let hash = f.hash(&package);
        f.store().bind_update_package(&batch.owner, Some(&batch.id), &hash, &package).unwrap();
        f.transaction(&hash, TransactionPhase::Committed);
        f.ready(&a, "next", "r2");
        let replay = f.store().request_update_from_main_window("desktop".into()).unwrap();
        assert!(!replay.start_build);
        assert!(replay.owns_batch);
        let committed = replay.channel.batch.unwrap();
        assert_eq!(committed.id, batch.id);
        assert_eq!(committed.phase, Phase::Committed);
        assert_eq!(replay.channel.ready.len(), 1);
    }

    #[test]
    fn freezes_all_providers_once_and_new_ready_is_next_batch() {
        let f = Fixture::new(); let a = owner("codex"); let b = owner("agy");
        f.ready(&a, "ui", "rev1"); f.ready(&b, "fix", "rev2");
        let first = f.begin(&a, "first"); assert!(first.start_build);
        let frozen = first.channel.batch.unwrap(); assert_eq!(frozen.changes.len(), 2);
        assert!(!f.begin(&b, "other").start_build); assert!(!f.begin(&a, "first").start_build);
        f.ready(&a, "ui", "rev3");
        let reopened = f.store().channel_status().unwrap();
        assert_eq!(reopened.batch.unwrap(), frozen);
        assert_eq!(reopened.ready[0].revision, "rev3");
    }

    #[test]
    fn ready_ids_are_scoped_to_authenticated_chat_and_withdraw_does_not_edit_batch() {
        let f = Fixture::new(); let a = owner("claude"); let b = owner("codex");
        f.ready(&a, "same", "1"); f.ready(&b, "same", "2"); f.ready(&a, "same", "3");
        assert_eq!(f.store().channel_status().unwrap().ready.len(), 2);
        let first = f.begin(&a, "build");
        let after = f.store().coordinate_update(b, Request::Withdraw { change_id: "same".into() }).unwrap();
        assert_eq!(after.channel.batch, first.channel.batch);
    }

    #[test]
    fn different_source_trees_must_be_integrated_before_claiming() {
        let f = Fixture::new(); let other = Fixture::new(); let a = owner("codex");
        f.ready(&a, "first", "r1");
        f.store().coordinate_update(a.clone(), Request::Ready { change_id: "second".into(), summary: "second".into(),
            source_root: other.0.to_string_lossy().into(), revision: "r2".into() }).unwrap();
        assert!(f.store().coordinate_update(a, Request::Begin { request_id: "build".into(), source_root: f.0.to_string_lossy().into() }).is_err());
        assert_eq!(f.store().channel_status().unwrap().ready.len(), 2);
    }

    #[test]
    fn busy_channel_blocks_legacy_candidate_and_foreign_owner() {
        let f = Fixture::new(); let a = owner("codex"); f.ready(&a, "ui", "r1");
        let batch = f.begin(&a, "build").channel.batch.unwrap(); let package = f.package(&batch); let hash = f.hash(&package);
        assert!(f.store().check_channel_candidate(&hash).is_err());
        assert!(f.store().bind_update_package(&owner("agy"), Some(&batch.id), &hash, &package).is_err());
        assert!(f.store().bind_update_package(&a, None, &hash, &package).is_err());
        f.store().bind_update_package(&a, Some(&batch.id), &hash, &package).unwrap();
        assert!(f.store().check_channel_candidate(&hash).is_ok());
        assert!(f.store().check_channel_candidate(&"b".repeat(64)).is_err());
        assert!(f.store().bind_update_package(&a, Some(&batch.id), &"b".repeat(64), &package).is_err());
        // Lost prepare reply: same owner, batch and hash can reconcile even when
        // the original package path is no longer available.
        f.store().bind_update_package(&a, Some(&batch.id), &hash, &f.0.join("gone")).unwrap();
    }

    #[test]
    fn package_must_declare_every_frozen_revision() {
        let f = Fixture::new(); let a = owner("codex"); f.ready(&a, "ui", "r1"); f.ready(&a, "fix", "r2");
        let batch = f.begin(&a, "build").channel.batch.unwrap(); let package = f.package(&batch);
        let mut proof = batch.proof(); proof.changes.pop();
        fs::write(package.join("build-provenance.json"), serde_json::to_vec(&serde_json::json!({"updateBatch":proof})).unwrap()).unwrap();
        assert!(f.store().bind_update_package(&a, Some(&batch.id), &f.hash(&package), &package).is_err());
        assert_eq!(f.store().channel_status().unwrap().batch.unwrap().phase, Phase::Building);
    }

    #[test]
    fn abort_is_owner_only_persists_and_does_not_replay_claim() {
        let f = Fixture::new(); let a = owner("codex"); let b = owner("agy");
        f.ready(&a, "ui", "r1"); f.ready(&b, "peer", "b1");
        let batch = f.begin(&a, "build").channel.batch.unwrap();
        f.ready(&a, "ui", "r2-while-building");
        let abort = Request::Abort { batch_id: batch.id, reason: "compiler failed; process stopped".into() };
        assert!(f.store().coordinate_update(owner("agy"), abort.clone()).is_err());
        let mut next_turn = a.clone(); next_turn.run_id = "next-run".into();
        let aborted = f.store().coordinate_update(next_turn.clone(), abort.clone()).unwrap();
        assert_eq!(aborted.channel.batch.as_ref().unwrap().phase, Phase::Aborted);
        // Peer's change is restored to ready; owner's newer revision queued during build is not overwritten.
        assert_eq!(aborted.channel.ready.len(), 2);
        assert_eq!(aborted.channel.ready.iter().find(|c| c.change_id == "peer").unwrap().revision, "b1");
        assert_eq!(aborted.channel.ready.iter().find(|c| c.change_id == "ui").unwrap().revision, "r2-while-building");
        // Idempotent abort does not duplicate restored entries.
        let replay = f.store().coordinate_update(next_turn, abort).unwrap();
        assert_eq!(replay.channel.ready.len(), 2);
        assert!(!f.begin(&a, "build").start_build);
        let retry = f.begin(&a, "retry-after-fix");
        assert!(retry.start_build);
        assert_eq!(retry.channel.batch.unwrap().changes.len(), 2);
    }

    #[test]
    fn native_activation_blocks_abort_and_drives_the_only_success_signal() {
        let f = Fixture::new(); let a = owner("codex"); f.ready(&a, "ui", "r1");
        let batch = f.begin(&a, "build").channel.batch.unwrap(); let package = f.package(&batch); let hash = f.hash(&package);
        f.store().bind_update_package(&a, Some(&batch.id), &hash, &package).unwrap();
        f.transaction(&hash, TransactionPhase::Preparing);
        assert!(f.store().coordinate_update(a.clone(), Request::Abort { batch_id: batch.id.clone(), reason: "cancel".into() }).is_err());
        assert_eq!(f.store().channel_status().unwrap().batch.unwrap().phase, Phase::Preparing);
        f.transaction(&hash, TransactionPhase::Committed);
        assert_eq!(f.store().channel_status().unwrap().batch.unwrap().phase, Phase::Committed);
        f.ready(&a, "next", "r2"); assert!(f.begin(&a, "next").start_build);
    }

    #[test]
    fn existing_release_cannot_falsely_complete_a_new_batch() {
        let f = Fixture::new(); let a = owner("codex"); let hash = "a".repeat(64);
        f.transaction(&hash, TransactionPhase::Committed); f.ready(&a, "new", "r2");
        let batch = f.begin(&a, "new").channel.batch.unwrap();
        assert!(f.store().bind_update_package(&a, Some(&batch.id), &hash, &f.package(&batch)).is_err());
        assert_eq!(f.store().channel_status().unwrap().batch.unwrap().phase, Phase::Building);
    }

    #[test]
    fn failed_hash_verification_cannot_bind_another_packages_proof() {
        let f = Fixture::new(); let a = owner("codex"); f.ready(&a, "ui", "r1");
        let batch = f.begin(&a, "build").channel.batch.unwrap();
        let package_p = f.package(&batch); let hash_p = f.hash(&package_p);
        let mut other = batch.clone(); other.id = uuid::Uuid::new_v4().to_string();
        let package_q = f.package(&other); let hash_q = f.hash(&package_q);
        assert!(f.store().bind_update_package(&a, Some(&batch.id), &hash_q, &package_p).is_err());
        assert!(f.store().channel_status().unwrap().batch.unwrap().manifest_sha256.is_none());
        assert!(f.store().bind_update_package(&a, Some(&batch.id), &hash_q, &package_q).is_err());
        assert_eq!(f.store().channel_status().unwrap().batch.unwrap().phase, Phase::Building);
        f.store().bind_update_package(&a, Some(&batch.id), &hash_p, &package_p).unwrap();
    }

    #[test]
    fn terminal_batch_survives_legacy_replacement_of_the_activation_journal() {
        for (phase, expected) in [(TransactionPhase::Committed, Phase::Committed),
            (TransactionPhase::Failed, Phase::Failed), (TransactionPhase::RolledBack, Phase::RolledBack)] {
            let f = Fixture::new(); let a = owner("codex"); f.ready(&a, "ui", "r1");
            let batch = f.begin(&a, "build").channel.batch.unwrap();
            let package_a = f.package(&batch); let hash_a = f.hash(&package_a);
            f.store().bind_update_package(&a, Some(&batch.id), &hash_a, &package_a).unwrap();
            f.store().stage(&package_a, &hash_a).unwrap();
            f.transaction(&hash_a, TransactionPhase::Preparing);
            f.ready(&a, "late", "r2"); // Persist the nonterminal Preparing view.
            f.transaction(&hash_a, phase);
            assert_eq!(f.store().channel_status().unwrap().batch.unwrap().phase, expected);
            let mut other = batch.clone(); other.id = uuid::Uuid::new_v4().to_string();
            let package_b = f.package(&other); let hash_b = f.hash(&package_b);
            let store = f.store(); let candidate = store.stage(&package_b, &hash_b).unwrap();
            store.prepare(candidate, &Compatibility { worker_protocol: 1, checkpoint_schema: 1, schema_hash: "b".repeat(64) }).unwrap();
            assert_eq!(f.store().channel_status().unwrap().batch.unwrap().phase, expected);
            f.transaction(&hash_b, TransactionPhase::Committed);
            assert!(f.begin(&a, "next").start_build, "terminal batch must not resurrect after journal replacement");
        }
    }

    #[test]
    fn malformed_channel_and_forged_arguments_fail_closed() {
        let f = Fixture::new(); let store = f.store();
        fs::write(store.root.join("channel.json"), b"{broken").unwrap();
        assert!(store.channel_status().is_err());
        assert!(serde_json::from_value::<Request>(serde_json::json!({"action":"begin","requestId":"a","sourceRoot":f.0,"owner":"forged"})).is_err());
        assert!(validate_request(&Request::Ready { change_id: "a".into(), summary: "x".into(), source_root: "relative".into(), revision: "r".into() }).is_err());
    }

    #[test]
    fn bounded_update_request_waits_for_working_tasks_and_leaves_later_tasks_for_next_batch() {
        let f = Fixture::new();
        let a = owner("codex");
        let b = owner("agy");
        let c = owner("claude");
        let d = owner("cursor");
        let root: String = f.0.to_string_lossy().into();

        // A is already ready; B and C are actively editing source code.
        f.ready(&a, "change-a", "rev-a");
        f.store().coordinate_update(b.clone(), Request::Working {
            change_id: "change-b".into(), summary: "editing b".into(), source_root: root.clone(),
        }).unwrap();
        f.store().coordinate_update(c.clone(), Request::Working {
            change_id: "change-c".into(), summary: "editing c".into(), source_root: root.clone(),
        }).unwrap();

        // User says "update" -> RequestUpdate bounds scope to [change-a, change-b, change-c] and waits for [change-b, change-c].
        let req = f.store().coordinate_update(a.clone(), Request::RequestUpdate {
            request_id: "req-1".into(), source_root: root.clone(), wait_for_change_ids: Vec::new(),
        }).unwrap();
        assert!(!req.start_build);
        assert!(req.channel.batch.is_none());
        let pending = req.channel.update_request.unwrap();
        assert_eq!(pending.target_change_ids, vec!["change-a", "change-b", "change-c"]);
        assert_eq!(pending.waiting_for, vec!["change-b", "change-c"]);

        // Later task D starts working and even finishes ready BEFORE C finishes -> D is outside the bounded request!
        f.store().coordinate_update(d.clone(), Request::Working {
            change_id: "change-d".into(), summary: "editing d".into(), source_root: root.clone(),
        }).unwrap();
        let d_ready = f.ready(&d, "change-d", "rev-d");
        assert!(!d_ready.start_build);
        assert!(d_ready.channel.batch.is_none());

        // B finishes ready -> still waiting for C.
        let b_ready = f.ready(&b, "change-b", "rev-b");
        assert!(!b_ready.start_build);
        assert_eq!(b_ready.channel.update_request.unwrap().waiting_for, vec!["change-c"]);

        // C finishes ready -> last in-scope task! Automatically freezes [change-a, change-b, change-c] and leaves change-d in ready for the next batch.
        let c_ready = f.ready(&c, "change-c", "rev-c");
        assert!(c_ready.start_build);
        assert!(c_ready.owns_batch);
        assert!(c_ready.channel.update_request.is_none());
        let batch = c_ready.channel.batch.unwrap();
        let frozen_ids: Vec<_> = batch.changes.iter().map(|ch| ch.change_id.as_str()).collect();
        assert_eq!(frozen_ids, vec!["change-a", "change-b", "change-c"]);
        assert_eq!(c_ready.channel.ready.len(), 1);
        assert_eq!(c_ready.channel.ready[0].change_id, "change-d");
    }

    #[test]
    fn withdrawing_last_waiting_task_advances_update_request() {
        let f = Fixture::new();
        let a = owner("codex");
        let b = owner("agy");
        let root: String = f.0.to_string_lossy().into();

        f.ready(&a, "change-a", "rev-a");
        f.store().coordinate_update(b.clone(), Request::Working {
            change_id: "change-b".into(), summary: "editing b".into(), source_root: root.clone(),
        }).unwrap();
        let req = f.store().coordinate_update(a.clone(), Request::RequestUpdate {
            request_id: "req-withdraw".into(), source_root: root, wait_for_change_ids: Vec::new(),
        }).unwrap();
        assert!(!req.start_build);

        // B decides no source changes were needed and withdraws -> A is frozen immediately.
        let withdrawn = f.store().coordinate_update(b, Request::Withdraw { change_id: "change-b".into() }).unwrap();
        assert!(withdrawn.start_build);
        let batch = withdrawn.channel.batch.unwrap();
        assert_eq!(batch.changes.len(), 1);
        assert_eq!(batch.changes[0].change_id, "change-a");
    }

    #[test]
    fn orphaned_working_tasks_and_interrupted_manual_batches_are_reclaimed_automatically() {
        let f = Fixture::new();
        let a = owner("codex");
        let b = owner("agy");
        let c = owner("claude");
        let root: String = f.0.to_string_lossy().into();

        // A claims a manual Begin batch ("change-a"), then A's run terminates before staging a package.
        f.ready(&a, "change-a", "rev-a");
        let claimed = f.begin(&a, "manual-build-1");
        assert!(claimed.start_build);
        assert_eq!(claimed.channel.batch.as_ref().unwrap().phase, Phase::Building);
        assert!(!claimed.channel.batch.as_ref().unwrap().auto_build);

        // Meanwhile B declared working ("orphan-b") and then its session went idle/exited without ready/withdraw.
        f.store().coordinate_update(b.clone(), Request::Working {
            change_id: "orphan-b".into(), summary: "stale working".into(), source_root: root.clone(),
        }).unwrap();
        // C registers a fresh ready change ("change-c") and is currently the only active run.
        f.ready(&c, "change-c", "rev-c");

        let active = ActiveRunsSnapshot {
            run_ids: std::collections::HashSet::from([c.run_id.clone()]),
            owners: vec![c.clone()],
        };

        // C calls RequestUpdate:
        // 1. Orphan working "orphan-b" (owner B is not live) is pruned and never enters waiting_for.
        // 2. Orphan manual batch from A (run-codex is not live) is aborted and "change-a" is restored to ready.
        // 3. Both "change-a" and "change-c" are immediately frozen into an auto_build batch!
        let reply = f.store().coordinate_update_with_active(
            c.clone(),
            Request::RequestUpdate {
                request_id: "auto-req-1".into(),
                source_root: root.clone(),
                wait_for_change_ids: vec!["orphan-b".into()],
            },
            Some(&active),
        ).unwrap();
        assert!(reply.start_build);
        assert!(reply.channel.working.is_empty());
        assert!(reply.channel.update_request.is_none());
        let batch = reply.channel.batch.unwrap();
        assert!(batch.auto_build);
        let frozen_ids: Vec<_> = batch.changes.iter().map(|ch| ch.change_id.as_str()).collect();
        assert_eq!(frozen_ids, vec!["change-a", "change-c"]);
    }

    #[test]
    fn poll_update_request_prunes_newly_orphaned_working_task_and_freezes_batch() {
        let f = Fixture::new();
        let a = owner("codex");
        let b = owner("agy");
        let root: String = f.0.to_string_lossy().into();

        f.ready(&a, "change-a", "rev-a");
        f.store().coordinate_update(b.clone(), Request::Working {
            change_id: "change-b".into(), summary: "editing b".into(), source_root: root.clone(),
        }).unwrap();

        // Both A and B are alive when RequestUpdate is called -> waits for B.
        let both_live = ActiveRunsSnapshot {
            run_ids: std::collections::HashSet::from([a.run_id.clone(), b.run_id.clone()]),
            owners: vec![a.clone(), b.clone()],
        };
        let req = f.store().coordinate_update_with_active(
            a.clone(),
            Request::RequestUpdate {
                request_id: "req-poll".into(),
                source_root: root,
                wait_for_change_ids: Vec::new(),
            },
            Some(&both_live),
        ).unwrap();
        assert!(!req.start_build);
        assert_eq!(req.channel.update_request.unwrap().waiting_for, vec!["change-b"]);

        // B's run crashes/exits without calling ready or withdraw -> next poll prunes B and freezes A.
        let only_a_live = ActiveRunsSnapshot {
            run_ids: std::collections::HashSet::from([a.run_id.clone()]),
            owners: vec![a.clone()],
        };
        let auto_batch = f.store().poll_update_request_with_active(Some(&only_a_live)).unwrap().expect("should freeze batch");
        assert!(auto_batch.auto_build);
        assert_eq!(auto_batch.changes.len(), 1);
        assert_eq!(auto_batch.changes[0].change_id, "change-a");
    }

    #[test]
    fn manual_build_from_fallback_source_root_without_ready_changes() {
        let f = Fixture::new();
        let root: String = f.0.to_string_lossy().into();
        let reply = f
            .store()
            .request_update_from_main_window_with_source("ui-manual-1".into(), Some(root.clone()))
            .unwrap();
        assert!(reply.start_build);
        let batch = reply.channel.batch.expect("should freeze manual build batch");
        assert!(batch.auto_build);
        assert_eq!(batch.phase, Phase::Building);
        assert_eq!(batch.changes.len(), 1);
        assert_eq!(batch.changes[0].change_id, "self-dev-manual-build");
        assert_eq!(batch.changes[0].revision, "working-tree");
    }

    #[test]
    #[ignore = "invoked by process_race_has_one_builder in two independent processes"]
    fn channel_process_helper() {
        let root = std::env::var_os("CCGUI_CHANNEL_TEST_ROOT").expect("test root");
        let who = std::env::var("CCGUI_CHANNEL_TEST_OWNER").unwrap();
        let store = UpdateStore::open(Path::new(&root), Limits::default()).unwrap();
        let reply = store.coordinate_update(owner(&who), Request::Begin { request_id: who.clone(), source_root: root.to_string_lossy().into() }).unwrap();
        fs::write(Path::new(&root).join(format!("result-{who}.json")), serde_json::to_vec(&reply).unwrap()).unwrap();
    }

    #[test]
    fn process_race_has_one_builder() {
        let f = Fixture::new(); f.ready(&owner("codex"), "one", "r1");
        let mut children = Vec::new();
        for who in ["codex", "agy"] {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command.args(["--exact", "live_update::channel::tests::channel_process_helper", "--ignored"])
                .env("CCGUI_CHANNEL_TEST_ROOT", &f.0).env("CCGUI_CHANNEL_TEST_OWNER", who)
                .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped());
            #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x0800_0000); }
            children.push(command.spawn().unwrap());
        }
        for child in children { let output = child.wait_with_output().unwrap(); assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr)); }
        let winners = ["codex", "agy"].iter().filter(|who| {
            serde_json::from_slice::<serde_json::Value>(&fs::read(f.0.join(format!("result-{who}.json"))).unwrap()).unwrap()["startBuild"] == true
        }).count();
        assert_eq!(winners, 1);
    }
}
