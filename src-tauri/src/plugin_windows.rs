//! Detached views have no controller or chat authority. The main document owns
//! the token; children can only send ordered actions to that exact owner.
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    sync::LazyLock,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tokio::sync::watch;
mod persistence;
use persistence::{Intent, Presentation};

const PREFIX: &str = "plugin-window-";
const OWNER_TTL: Duration = Duration::from_secs(15);
const ACTION_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_PENDING: usize = 64;
const MAX_RECEIPTS: usize = 128;
const MAX_RECEIPT_BYTES: usize = 16 * 1024 * 1024;
const MAX_WINDOWS: usize = 16;
const MAX_STATE: usize = 8 * 1024 * 1024;
static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::default()));
// Serialize opens without holding the registry across native UI operations.
static OPEN_GATE: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub revision: u64,
    pub state: Value,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Labels {
    pub return_to_main: String,
    pub owner_unavailable: String,
    pub action_failed: String,
    pub loading: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenRequest {
    pub plugin_id: String,
    pub tab_id: String,
    pub registration_id: String,
    pub owner_token: String,
    pub title: String,
    pub renderer_export: String,
    pub code: String,
    pub css: String,
    pub snapshot: Snapshot,
    pub dark: bool,
    pub labels: Labels,
    #[serde(default = "default_focus")]
    pub focus: bool,
}
fn default_focus() -> bool {
    true
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresentationRequest {
    pub plugin_id: String,
    pub tab_id: String,
    pub registration_id: String,
    pub owner_token: String,
    pub presentation: Presentation,
    pub was_open: bool,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowIdentity {
    pub window_id: String,
    pub label: String,
    pub registration_id: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InitInfo {
    #[serde(flatten)]
    pub identity: WindowIdentity,
    pub plugin_id: String,
    pub tab_id: String,
    pub title: String,
    pub renderer_export: String,
    pub code: String,
    pub css: String,
    pub snapshot: Snapshot,
    pub dark: bool,
    pub labels: Labels,
    pub next_sequence: u64,
    pub unresolved_sequences: Vec<u64>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishRequest {
    pub window_id: String,
    pub registration_id: String,
    pub owner_token: String,
    pub snapshot: Snapshot,
    pub dark: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Action {
    pub name: String,
    pub args: Vec<Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionRequest {
    pub window_id: String,
    pub registration_id: String,
    pub sequence: u64,
    pub action: Action,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChildRequest {
    pub window_id: String,
    pub registration_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceiptRequest {
    pub window_id: String,
    pub registration_id: String,
    pub sequence: u64,
}
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReceiptState { Pending, Unknown, Resolved, Missing, Expired }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptInspection {
    #[serde(flatten)]
    pub identity: WindowIdentity,
    pub sequence: u64,
    pub state: ReceiptState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receipt: Option<Receipt>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub sequence: u64,
    pub ok: bool,
    pub unknown: bool,
    pub value: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub snapshot: Snapshot,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RespondRequest {
    pub window_id: String,
    pub registration_id: String,
    pub owner_token: String,
    pub sequence: u64,
    pub ok: bool,
    #[serde(default)]
    pub value: Value,
    pub error: Option<String>,
    pub snapshot: Snapshot,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReturnRequest {
    pub window_id: String,
    pub registration_id: String,
    pub owner_token: Option<String>,
    pub reason: Option<ReturnReason>,
    #[serde(default)]
    pub force: bool,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ReturnReason {
    Return,
    Closed,
    Maintenance,
}
impl ReturnReason {
    fn intent(self) -> Option<Intent> {
        match self {
            Self::Return => Some(Intent {
                presentation: Presentation::Docked,
                was_open: true,
            }),
            Self::Closed => Some(Intent {
                presentation: Presentation::Detached,
                was_open: false,
            }),
            Self::Maintenance => None,
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestReturnRequest {
    pub window_id: String,
    pub registration_id: String,
    pub owner_token: String,
    pub reason: Option<ReturnReason>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerRequest {
    pub registration_id: String,
    pub owner_token: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub owner_available: bool,
    pub closing: bool,
    pub reason: Option<ReturnReason>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotEvent {
    window_id: String,
    registration_id: String,
    snapshot: Snapshot,
    dark: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActionEvent {
    window_id: String,
    registration_id: String,
    owner_token: String,
    sequence: u64,
    action: Action,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReturnedEvent {
    window_id: String,
    registration_id: String,
    owner_token: String,
    tab_id: String,
    reason: &'static str,
}

struct Slot {
    action_hash: [u8; 32],
    channel: watch::Sender<Option<Receipt>>,
    responded: bool,
    completed: bool,
    bytes: usize,
}
struct Entry {
    identity: WindowIdentity,
    request: OpenRequest,
    heartbeat: Instant,
    closing: bool,
    close_reason: Option<ReturnReason>,
    geometry_pending: bool,
    next_sequence: u64,
    slots: HashMap<u64, Slot>,
    completed: VecDeque<u64>,
    receipt_bytes: usize,
}
impl Entry {
    fn request_close(&mut self, reason: ReturnReason) -> ReturnReason {
        self.closing = true;
        *self.close_reason.get_or_insert(reason)
    }
    fn new(request: OpenRequest) -> Self {
        let window_id = uuid::Uuid::new_v4().to_string();
        Self {
            identity: WindowIdentity {
                label: format!("{PREFIX}{window_id}"),
                window_id,
                registration_id: request.registration_id.clone(),
            },
            request,
            heartbeat: Instant::now(),
            closing: false,
            close_reason: None,
            geometry_pending: false,
            next_sequence: 1,
            slots: HashMap::new(),
            completed: VecDeque::new(),
            receipt_bytes: 0,
        }
    }
    fn owner(&self, registration: &str, token: &str) -> Result<(), String> {
        if self.request.registration_id != registration || self.request.owner_token != token {
            return Err("plugin_window_owner_mismatch".into());
        }
        Ok(())
    }
    fn child(&self, label: &str, registration: &str) -> Result<(), String> {
        if self.identity.label != label || self.request.registration_id != registration {
            return Err("plugin_window_identity_mismatch".into());
        }
        Ok(())
    }
    fn available(&self, main_exists: bool, now: Instant) -> bool {
        main_exists && now.saturating_duration_since(self.heartbeat) <= OWNER_TTL
    }
    fn snapshot(&mut self, snapshot: &Snapshot) -> Result<bool, String> {
        validate_snapshot(snapshot)?;
        if snapshot.revision < self.request.snapshot.revision {
            return Ok(false);
        }
        if snapshot.revision == self.request.snapshot.revision {
            return if snapshot == &self.request.snapshot {
                Ok(false)
            } else {
                Err("plugin_window_snapshot_conflict".into())
            };
        }
        self.request.snapshot = snapshot.clone();
        Ok(true)
    }
    fn snapshot_event(&self) -> SnapshotEvent {
        SnapshotEvent {
            window_id: self.identity.window_id.clone(),
            registration_id: self.request.registration_id.clone(),
            snapshot: self.request.snapshot.clone(),
            dark: self.request.dark,
        }
    }
    fn admit(
        &mut self,
        sequence: u64,
        action: &Action,
    ) -> Result<(watch::Receiver<Option<Receipt>>, bool), String> {
        use sha2::{Digest, Sha256};
        let action_hash: [u8; 32] =
            Sha256::digest(serde_json::to_vec(action).map_err(|e| e.to_string())?).into();
        if let Some(slot) = self.slots.get(&sequence) {
            if slot.action_hash != action_hash {
                return Err("plugin_window_action_payload_conflict".into());
            }
            return Ok((slot.channel.subscribe(), false));
        }
        if sequence < self.next_sequence {
            return Err("plugin_window_receipt_expired_no_retry".into());
        }
        if sequence != self.next_sequence {
            return Err("plugin_window_action_out_of_order".into());
        }
        if self.slots.values().filter(|slot| !slot.completed).count() >= MAX_PENDING {
            return Err("plugin_window_too_many_pending_actions".into());
        }
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or("plugin_window_sequence_exhausted")?;
        let (channel, receiver) = watch::channel(None);
        self.slots.insert(
            sequence,
            Slot {
                action_hash,
                channel,
                responded: false,
                completed: false,
                bytes: 0,
            },
        );
        Ok((receiver, true))
    }
    fn respond(&mut self, request: RespondRequest) -> Result<bool, String> {
        let slot = self
            .slots
            .get(&request.sequence)
            .ok_or("plugin_window_action_not_pending_or_expired")?;
        if slot.responded {
            return Ok(false);
        }
        // Publications and async actions share one monotonically increasing
        // document state; a late response cannot roll the detached view back.
        self.snapshot(&request.snapshot)?;
        let receipt = Receipt {
            sequence: request.sequence,
            ok: request.ok,
            unknown: false,
            value: request.value,
            error: request
                .error
                .map(|error| error.chars().take(2048).collect()),
            snapshot: self.request.snapshot.clone(),
        };
        self.finish(receipt, true);
        Ok(true)
    }
    fn finish(&mut self, receipt: Receipt, responded: bool) {
        let Some(slot) = self.slots.get_mut(&receipt.sequence) else {
            return;
        };
        if slot.responded || (slot.completed && !responded) {
            return;
        }
        slot.responded = responded;
        if !slot.completed {
            slot.completed = true;
            self.completed.push_back(receipt.sequence);
        }
        self.receipt_bytes -= slot.bytes;
        slot.bytes = serde_json::to_vec(&receipt)
            .map(|bytes| bytes.len())
            .unwrap_or(MAX_RECEIPT_BYTES);
        self.receipt_bytes += slot.bytes;
        slot.channel.send_replace(Some(receipt));
        while self.completed.len() > MAX_RECEIPTS || self.receipt_bytes > MAX_RECEIPT_BYTES {
            if let Some(sequence) = self.completed.pop_front() {
                if let Some(slot) = self.slots.remove(&sequence) {
                    self.receipt_bytes -= slot.bytes;
                }
            } else {
                break;
            }
        }
    }
    fn fail(&mut self, sequence: u64, error: &str) {
        self.finish(
            Receipt {
                sequence,
                ok: false,
                unknown: true,
                value: Value::Null,
                error: Some(error.into()),
                snapshot: self.request.snapshot.clone(),
            },
            false,
        );
    }
    fn cancel(&mut self, error: &str) {
        let pending = self
            .slots
            .iter()
            .filter_map(|(&id, slot)| (!slot.completed).then_some(id))
            .collect::<Vec<_>>();
        for id in pending {
            self.fail(id, error);
        }
    }
    fn inspect_receipt(&self, sequence: u64) -> Result<ReceiptInspection, String> {
        if sequence == 0 { return Err("plugin_window_invalid_sequence".into()); }
        let (state, receipt) = match self.slots.get(&sequence) {
            Some(slot) => match slot.channel.borrow().clone() {
                Some(mut receipt) if slot.responded && !receipt.unknown => {
                    // Recover the original result with the latest authoritative projection.
                    receipt.snapshot = self.request.snapshot.clone();
                    (ReceiptState::Resolved, Some(receipt))
                }
                Some(_) => (ReceiptState::Unknown, None),
                None => (ReceiptState::Pending, None),
            },
            None if sequence < self.next_sequence => (ReceiptState::Expired, None),
            None => (ReceiptState::Missing, None),
        };
        Ok(ReceiptInspection { identity: self.identity.clone(), sequence, state, receipt })
    }
    fn init(&self) -> InitInfo {
        let mut unresolved_sequences: Vec<_> = self.slots.iter().filter_map(|(&id, slot)| (!slot.responded).then_some(id)).collect();
        unresolved_sequences.sort_unstable();
        InitInfo {
            identity: self.identity.clone(),
            plugin_id: self.request.plugin_id.clone(),
            tab_id: self.request.tab_id.clone(),
            title: self.request.title.clone(),
            renderer_export: self.request.renderer_export.clone(),
            code: self.request.code.clone(),
            css: self.request.css.clone(),
            snapshot: self.request.snapshot.clone(),
            dark: self.request.dark,
            labels: self.request.labels.clone(),
            next_sequence: self.next_sequence,
            unresolved_sequences,
        }
    }
}
#[derive(Default)]
struct Registry {
    entries: HashMap<String, Entry>,
    stopped: bool,
    lifecycle_epoch: u64,
    presentations: HashMap<(String, String), (String, String)>,
}
impl Registry {
    fn inspect_receipt(&self, label: &str, request: &ReceiptRequest) -> Result<ReceiptInspection, String> {
        let entry = self.entries.get(&request.window_id).ok_or("plugin_window_unavailable")?;
        entry.child(label, &request.registration_id)?;
        entry.inspect_receipt(request.sequence)
    }
    fn get_mut(&mut self, id: &str) -> Result<&mut Entry, String> {
        self.entries
            .get_mut(id)
            .ok_or_else(|| "plugin_window_unavailable".into())
    }
    fn for_label(&self, label: &str) -> Result<&Entry, String> {
        self.entries
            .values()
            .find(|entry| entry.identity.label == label)
            .ok_or_else(|| "plugin_window_unsupported_window".into())
    }
    fn remove(&mut self, id: &str, error: &str) -> Option<Entry> {
        let mut entry = self.entries.remove(id)?;
        entry.cancel(error);
        Some(entry)
    }
    fn open(
        &mut self,
        request: OpenRequest,
    ) -> Result<(WindowIdentity, Option<Entry>, bool), String> {
        if self.stopped {
            return Err("plugin_window_shutting_down".into());
        }
        let existing = self
            .entries
            .values()
            .find(|e| {
                e.request.plugin_id == request.plugin_id && e.request.tab_id == request.tab_id
            })
            .map(|e| e.identity.window_id.clone());
        if let Some(id) = existing {
            let entry = self.get_mut(&id)?;
            if entry.request.registration_id == request.registration_id {
                entry.owner(&request.registration_id, &request.owner_token)?;
                if entry.request.code != request.code
                    || entry.request.css != request.css
                    || entry.request.renderer_export != request.renderer_export
                {
                    return Err("plugin_window_registration_bundle_changed".into());
                }
                entry.snapshot(&request.snapshot)?;
                entry.request.dark = request.dark;
                entry.heartbeat = Instant::now();
                return Ok((entry.identity.clone(), None, true));
            }
            let old = self.remove(&id, "plugin_window_owner_replaced");
            let entry = Entry::new(request);
            let identity = entry.identity.clone();
            self.entries.insert(identity.window_id.clone(), entry);
            return Ok((identity, old, false));
        }
        if self.entries.len() >= MAX_WINDOWS {
            return Err("plugin_window_limit_reached".into());
        }
        let entry = Entry::new(request);
        let identity = entry.identity.clone();
        self.entries.insert(identity.window_id.clone(), entry);
        Ok((identity, None, false))
    }
}
fn main_only(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("plugin_window_main_required".into())
    }
}
fn validate_snapshot(snapshot: &Snapshot) -> Result<(), String> {
    if serde_json::to_vec(&snapshot.state)
        .map_err(|e| e.to_string())?
        .len()
        > MAX_STATE
    {
        return Err("plugin_window_state_too_large".into());
    }
    Ok(())
}
fn validate_open(request: &OpenRequest) -> Result<(), String> {
    let id = request.plugin_id.as_bytes();
    if !(2..=64).contains(&id.len())
        || !id
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        || id[0] == b'-'
    {
        return Err("plugin_window_invalid_plugin_id".into());
    }
    let prefix = format!("plugin:{}", request.plugin_id);
    if request.tab_id != prefix
        && !request
            .tab_id
            .strip_prefix(&format!("{prefix}:"))
            .is_some_and(|key| {
                !key.is_empty() && key.len() <= 256 && !key.chars().any(char::is_control)
            })
    {
        return Err("plugin_window_tab_owner_mismatch".into());
    }
    for id in [&request.registration_id, &request.owner_token] {
        uuid::Uuid::parse_str(id).map_err(|_| "plugin_window_invalid_owner")?;
    }
    let name = request.renderer_export.as_bytes();
    if request.renderer_export == "default"
        || name.is_empty()
        || name.len() > 128
        || !(name[0].is_ascii_alphabetic() || b"_$".contains(&name[0]))
        || !name
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || b"_$".contains(b))
    {
        return Err("plugin_window_invalid_renderer_export".into());
    }
    if request.title.trim().is_empty()
        || request.title.len() > 512
        || request.title.chars().any(char::is_control)
    {
        return Err("plugin_window_invalid_title".into());
    }
    if request.code.len() > 16 * 1024 * 1024 || request.css.len() > 2 * 1024 * 1024 {
        return Err("plugin_window_bundle_too_large".into());
    }
    for label in [
        &request.labels.return_to_main,
        &request.labels.owner_unavailable,
        &request.labels.action_failed,
        &request.labels.loading,
    ] {
        if label.is_empty() || label.len() > 2048 {
            return Err("plugin_window_invalid_labels".into());
        }
    }
    validate_snapshot(&request.snapshot)
}
fn validate_installed(request: &OpenRequest) -> Result<(), String> {
    crate::plugins::require_supported_plugin(&request.plugin_id)?;
    let state: crate::plugins::PluginsState = serde_json::from_slice(
        &std::fs::read(crate::paths::app_home().join("plugins.json"))
            .map_err(|e| format!("plugin window state: {e}"))?,
    )
    .map_err(|e| format!("plugin window state: {e}"))?;
    let record = state
        .plugins
        .get(&request.plugin_id)
        .ok_or("plugin_window_not_installed")?;
    if !record.enabled || record.quarantined {
        return Err("plugin_window_plugin_unavailable".into());
    }
    let read =
        |name: &str| crate::plugins::plugin_read_file(request.plugin_id.clone(), name.into());
    let manifest: Value = serde_json::from_str(&read("manifest.json")?)
        .map_err(|_| "plugin_window_invalid_manifest")?;
    if manifest.get("id").and_then(Value::as_str) != Some(request.plugin_id.as_str()) {
        return Err("plugin_window_manifest_mismatch".into());
    }
    for permission in ["ui:center-tab", "ui:detached-window"] {
        if !record.permissions.iter().any(|p| p == permission)
            || !manifest
                .get("permissions")
                .and_then(Value::as_array)
                .is_some_and(|p| p.iter().any(|v| v.as_str() == Some(permission)))
        {
            return Err("plugin_window_permission_denied".into());
        }
    }
    if read("main.js")? != request.code {
        return Err("plugin_window_bundle_mismatch".into());
    }
    let css_path = crate::paths::app_home()
        .join("plugins")
        .join(&request.plugin_id)
        .join("styles.css");
    let css = match std::fs::metadata(css_path) {
        Ok(_) => read("styles.css")?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("plugin window styles: {e}")),
    };
    if css != request.css {
        return Err("plugin_window_styles_mismatch".into());
    }
    Ok(())
}
fn main_exists(app: &AppHandle) -> bool {
    app.get_webview_window("main").is_some()
}
fn emit_snapshot(app: &AppHandle, label: &str, event: SnapshotEvent) -> Result<(), String> {
    app.emit_to(label, "plugin-window://snapshot", event)
        .map_err(|e| e.to_string())
}
fn retired(app: &AppHandle, entry: Entry, reason: Option<&'static str>) {
    if let Some(window) = app.get_webview_window(&entry.identity.label) {
        if let Err(error) = persistence::capture(
            app,
            &window,
            &entry.request.plugin_id,
            &entry.request.tab_id,
        ) {
            eprintln!("plugin window geometry: {error}");
        }
        let _ = window.destroy();
    }
    if let Some(reason) = reason.filter(|_| main_exists(app)) {
        let _ = app.emit_to(
            "main",
            "plugin-window://returned",
            ReturnedEvent {
                window_id: entry.identity.window_id,
                registration_id: entry.request.registration_id,
                owner_token: entry.request.owner_token,
                tab_id: entry.request.tab_id,
                reason,
            },
        );
        if let Some(main) = app
            .get_webview_window("main")
            .filter(|_| reason == "return")
        {
            let _ = main.unminimize();
            let _ = main.show();
            let _ = main.set_focus();
        }
    }
}

#[tauri::command]
pub async fn plugin_window_presentation_register(
    window: WebviewWindow,
    app: AppHandle,
    request: OpenRequest,
) -> Result<Option<Intent>, String> {
    main_only(&window)?;
    validate_open(&request)?;
    let _open = OPEN_GATE.lock().await;
    let epoch = REGISTRY.lock().lifecycle_epoch;
    validate_installed(&request)?;
    let mut registry = REGISTRY.lock();
    if registry.stopped || registry.lifecycle_epoch != epoch {
        return Err("plugin_window_lifecycle_changed".into());
    }
    let saved = persistence::intent(
        &app.state::<std::sync::Arc<crate::db::Db>>(),
        &request.plugin_id,
        &request.tab_id,
    )?;
    registry.presentations.insert(
        (request.plugin_id, request.tab_id),
        (request.registration_id, request.owner_token),
    );
    Ok(saved)
}
#[tauri::command]
pub fn plugin_window_presentation_set(
    window: WebviewWindow,
    app: AppHandle,
    request: PresentationRequest,
) -> Result<(), String> {
    main_only(&window)?;
    let registry = REGISTRY.lock();
    if registry.stopped
        || registry
            .presentations
            .get(&(request.plugin_id.clone(), request.tab_id.clone()))
            != Some(&(request.registration_id, request.owner_token))
    {
        return Err("plugin_window_owner_mismatch".into());
    }
    persistence::set_intent(
        &app.state::<std::sync::Arc<crate::db::Db>>(),
        &request.plugin_id,
        &request.tab_id,
        &Intent {
            presentation: request.presentation,
            was_open: request.was_open,
        },
    )
}

#[tauri::command]
pub async fn plugin_window_open(
    window: WebviewWindow,
    app: AppHandle,
    request: OpenRequest,
) -> Result<WindowIdentity, String> {
    main_only(&window)?;
    validate_open(&request)?;
    let _open = OPEN_GATE.lock().await;
    let lifecycle_epoch = REGISTRY.lock().lifecycle_epoch;
    validate_installed(&request)?;
    if !main_exists(&app) {
        return Err("plugin_window_owner_unavailable".into());
    }
    let focus = request.focus;
    let plugin_id = request.plugin_id.clone();
    let tab_id = request.tab_id.clone();
    let saved = persistence::geometry(
        &app.state::<std::sync::Arc<crate::db::Db>>(),
        &plugin_id,
        &tab_id,
    )?;
    let (identity, old, reuse) = {
        let mut registry = REGISTRY.lock();
        if registry.lifecycle_epoch != lifecycle_epoch {
            return Err("plugin_window_lifecycle_changed".into());
        }
        if registry
            .presentations
            .get(&(plugin_id.clone(), tab_id.clone()))
            != Some(&(request.registration_id.clone(), request.owner_token.clone()))
        {
            return Err("plugin_window_owner_mismatch".into());
        }
        registry.open(request)?
    };
    if let Some(old) = old {
        retired(&app, old, None);
    }
    if reuse {
        let target = app
            .get_webview_window(&identity.label)
            .ok_or("plugin_window_unavailable")?;
        let event = REGISTRY
            .lock()
            .get_mut(&identity.window_id)?
            .snapshot_event();
        emit_snapshot(&app, &identity.label, event)?;
        if focus {
            target.unminimize().map_err(|e| e.to_string())?;
            target.show().map_err(|e| e.to_string())?;
            target.set_focus().map_err(|e| e.to_string())?;
        }
        return Ok(identity);
    }
    let title = REGISTRY
        .lock()
        .get_mut(&identity.window_id)?
        .request
        .title
        .clone();
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        &identity.label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .initialization_script(format!(
        "window.location.hash = '#/plugin-window/{}';",
        identity.window_id
    ))
    .title(title)
    .decorations(true)
    .resizable(true)
    .visible(false)
    .focused(focus)
    .inner_size(420.0, 320.0);
    // A development-profile fixture must not open the installed profile's
    // default WebView data store merely because this is a secondary window.
    if let Some(directory) = crate::development_profile::webview_dir() {
        #[cfg(not(target_os = "macos"))]
        {
            builder = builder.data_directory(directory);
        }
        #[cfg(target_os = "macos")]
        {
            use sha2::{Digest, Sha256};
            let digest = Sha256::digest(directory.to_string_lossy().as_bytes());
            builder = builder.data_store_identifier(digest[..16].try_into().unwrap());
        }
    }
    let result = builder.build();
    let target = match result {
        Ok(window) => window,
        Err(error) => {
            REGISTRY
                .lock()
                .remove(&identity.window_id, "plugin_window_creation_failed");
            return Err(error.to_string());
        }
    };
    #[cfg(feature = "test-harness")]
    if let Err(error) = crate::test_harness::install_runtime_fixture_bridge(&app, &target) {
        // No returned event: opening never completed, and this document must
        // not leave a partially initialized native fixture window behind.
        REGISTRY
            .lock()
            .remove(&identity.window_id, "plugin_window_fixture_failed");
        let _ = target.destroy();
        return Err(error);
    }
    // Destruction or disposal may race the blocking builder; never resurrect it.
    if !REGISTRY.lock().entries.contains_key(&identity.window_id) || !main_exists(&app) {
        let _ = target.destroy();
        REGISTRY
            .lock()
            .remove(&identity.window_id, "plugin_window_owner_unavailable");
        return Err("plugin_window_owner_unavailable".into());
    }
    let callback_app = app.clone();
    let id = identity.window_id.clone();
    let label = identity.label.clone();
    target.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            let payload = { let mut registry = REGISTRY.lock(); registry.entries.get_mut(&id).map(|entry| {
                let reason = entry.request_close(ReturnReason::Closed);
                serde_json::json!({"windowId":id,"registrationId":entry.request.registration_id,"reason":reason})
            }) };
            if let Some(payload) = payload {
                api.prevent_close();
                let _ = callback_app.emit_to(&label, "plugin-window://close-requested", payload);
            }
        }
        tauri::WindowEvent::Destroyed => {
            let entry = { REGISTRY.lock().remove(&id, "plugin_window_closed") };
            if let Some(entry) = entry {
                if main_exists(&callback_app) {
                    if let Err(error) = persistence::set_intent(&callback_app.state::<std::sync::Arc<crate::db::Db>>(), &entry.request.plugin_id, &entry.request.tab_id, &Intent { presentation: Presentation::Detached, was_open: false }) { eprintln!("plugin window close intent: {error}"); }
                }
                retired(&callback_app, entry, Some("closed"));
            }
        }
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } => {
            let schedule = { let mut registry = REGISTRY.lock(); registry.entries.get_mut(&id).is_some_and(|entry| { if entry.geometry_pending { false } else { entry.geometry_pending = true; true } }) };
            if schedule {
                let app = callback_app.clone(); let id = id.clone(); let label = label.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    let key = { let mut registry = REGISTRY.lock(); registry.entries.get_mut(&id).map(|entry| { entry.geometry_pending = false; (entry.request.plugin_id.clone(), entry.request.tab_id.clone()) }) };
                    if let (Some((plugin, tab)), Some(window)) = (key, app.get_webview_window(&label)) {
                        let result = persistence::sample(&app, &window, &plugin, &tab).and_then(|geometry| {
                            let registry = REGISTRY.lock();
                            if registry.entries.contains_key(&id) {
                                if let Some(geometry) = geometry { persistence::set_geometry(&app.state::<std::sync::Arc<crate::db::Db>>(), &plugin, &tab, &geometry)?; }
                            }
                            Ok(())
                        });
                        if let Err(error) = result { eprintln!("plugin window geometry: {error}"); }
                    }
                });
            }
        }
        _ => (),
    });
    let prepared = (|| -> Result<(), String> {
        let initial = match saved {
            Some(saved) => saved,
            None => persistence::initial(&target)?,
        };
        let restored = persistence::restore(&target, &initial)?;
        {
            let registry = REGISTRY.lock();
            registry
                .entries
                .get(&identity.window_id)
                .ok_or("plugin_window_owner_unavailable")?;
            persistence::set_geometry(
                &app.state::<std::sync::Arc<crate::db::Db>>(),
                &plugin_id,
                &tab_id,
                &restored,
            )?;
        }
        if restored.maximized {
            target.maximize().map_err(|e| e.to_string())?;
        }
        let geometry = persistence::sample(&app, &target, &plugin_id, &tab_id)?;
        let registry = REGISTRY.lock();
        registry
            .entries
            .get(&identity.window_id)
            .ok_or("plugin_window_owner_unavailable")?;
        if let Some(geometry) = geometry {
            persistence::set_geometry(
                &app.state::<std::sync::Arc<crate::db::Db>>(),
                &plugin_id,
                &tab_id,
                &geometry,
            )?;
        }
        persistence::set_intent(
            &app.state::<std::sync::Arc<crate::db::Db>>(),
            &plugin_id,
            &tab_id,
            &Intent {
                presentation: Presentation::Detached,
                was_open: true,
            },
        )?;
        drop(registry);
        target.show().map_err(|e| e.to_string())?;
        if focus {
            target.set_focus().map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    if let Err(error) = prepared {
        REGISTRY
            .lock()
            .remove(&identity.window_id, "plugin_window_creation_failed");
        let _ = target.destroy();
        return Err(error);
    }
    Ok(identity)
}

#[tauri::command]
pub fn plugin_window_init(window: WebviewWindow) -> Result<InitInfo, String> {
    Ok(REGISTRY.lock().for_label(window.label())?.init())
}

/// Query only: never admits, emits, cancels, or replays an action.
#[tauri::command]
pub fn plugin_window_inspect_action(window: WebviewWindow, request: ReceiptRequest) -> Result<ReceiptInspection, String> {
    REGISTRY.lock().inspect_receipt(window.label(), &request)
}

#[tauri::command]
pub fn plugin_window_focus_owner(window: WebviewWindow, app: AppHandle, request: ChildRequest) -> Result<(), String> {
    {
        let registry = REGISTRY.lock();
        let entry = registry.entries.get(&request.window_id).ok_or("plugin_window_unavailable")?;
        entry.child(window.label(), &request.registration_id)?;
    }
    let main = app.get_webview_window("main").ok_or("plugin_window_owner_unavailable")?;
    main.unminimize().map_err(|e| e.to_string())?;
    main.show().map_err(|e| e.to_string())?;
    main.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugin_window_publish(
    window: WebviewWindow,
    app: AppHandle,
    request: PublishRequest,
) -> Result<(), String> {
    main_only(&window)?;
    let (label, event) = {
        let mut registry = REGISTRY.lock();
        let entry = registry.get_mut(&request.window_id)?;
        entry.owner(&request.registration_id, &request.owner_token)?;
        entry.snapshot(&request.snapshot)?;
        entry.request.dark = request.dark;
        (entry.identity.label.clone(), entry.snapshot_event())
    };
    emit_snapshot(&app, &label, event)
}

#[tauri::command]
pub async fn plugin_window_action(
    window: WebviewWindow,
    app: AppHandle,
    request: ActionRequest,
) -> Result<Receipt, String> {
    if request.action.name.is_empty()
        || request.action.name.len() > 80
        || request.action.args.len() > 128
        || serde_json::to_vec(&request.action)
            .map_err(|e| e.to_string())?
            .len()
            > 64 * 1024
    {
        return Err("plugin_window_invalid_action".into());
    }
    let exists = main_exists(&app);
    let (mut receiver, event) = {
        let mut registry = REGISTRY.lock();
        let entry = registry.get_mut(&request.window_id)?;
        entry.child(window.label(), &request.registration_id)?;
        if !entry.available(exists, Instant::now()) {
            entry.cancel("plugin_window_owner_unavailable");
            return Err("plugin_window_owner_unavailable".into());
        }
        // Closing only announces a flush request. Already queued child input
        // is admitted until the child explicitly returns or is destroyed.
        let (receiver, fresh) = entry.admit(request.sequence, &request.action)?;
        let event = fresh.then(|| ActionEvent {
            window_id: request.window_id.clone(),
            registration_id: request.registration_id.clone(),
            owner_token: entry.request.owner_token.clone(),
            sequence: request.sequence,
            action: request.action,
        });
        (receiver, event)
    };
    if let Some(event) = event {
        if app
            .emit_to("main", "plugin-window://action", event)
            .is_err()
        {
            if let Ok(entry) = REGISTRY.lock().get_mut(&request.window_id) {
                entry.fail(request.sequence, "plugin_window_owner_unavailable");
            }
        }
    }
    let wait = async {
        loop {
            if let Some(receipt) = receiver.borrow_and_update().clone() {
                return Ok(receipt);
            }
            receiver
                .changed()
                .await
                .map_err(|_| "plugin_window_closed".to_owned())?;
        }
    };
    match tokio::time::timeout(ACTION_TIMEOUT, wait).await {
        Ok(result) => result,
        Err(_) => {
            eprintln!("[plugin-window] action outcome unknown window={} sequence={}", request.window_id, request.sequence);
            if let Ok(entry) = REGISTRY.lock().get_mut(&request.window_id) {
                entry.fail(
                    request.sequence,
                    "plugin_window_action_outcome_unknown_no_retry",
                );
            }
            let receipt = receiver
                .borrow()
                .clone()
                .ok_or_else(|| "plugin_window_closed".to_owned());
            receipt
        }
    }
}

#[tauri::command]
pub fn plugin_window_respond(
    window: WebviewWindow,
    app: AppHandle,
    request: RespondRequest,
) -> Result<(), String> {
    main_only(&window)?;
    validate_snapshot(&request.snapshot)?;
    if serde_json::to_vec(&request.value)
        .map_err(|e| e.to_string())?
        .len()
        > MAX_STATE
    {
        return Err("plugin_window_result_too_large".into());
    }
    let (label, event) = {
        let mut registry = REGISTRY.lock();
        let entry = registry.get_mut(&request.window_id)?;
        entry.owner(&request.registration_id, &request.owner_token)?;
        if !entry.respond(request)? {
            return Ok(());
        }
        (entry.identity.label.clone(), entry.snapshot_event())
    };
    emit_snapshot(&app, &label, event)
}

#[tauri::command]
pub fn plugin_window_return(
    window: WebviewWindow,
    app: AppHandle,
    request: ReturnRequest,
) -> Result<(), String> {
    let (entry, reason) = {
        let mut registry = REGISTRY.lock();
        let entry = registry.get_mut(&request.window_id)?;
        if window.label() == "main" {
            entry.owner(
                &request.registration_id,
                request
                    .owner_token
                    .as_deref()
                    .ok_or("plugin_window_owner_required")?,
            )?;
        } else {
            entry.child(window.label(), &request.registration_id)?;
        }
        if !request.force && entry.slots.values().any(|slot| !slot.responded) {
            return Err("plugin_window_pending_actions".into());
        }
        let reason = if request.force {
            request.reason.unwrap_or(ReturnReason::Closed)
        } else {
            entry
                .close_reason
                .or(request.reason)
                .unwrap_or(ReturnReason::Return)
        };
        if request.force && matches!(reason, ReturnReason::Maintenance) {
            return Err("plugin_window_invalid_return_reason".into());
        }
        if matches!(reason, ReturnReason::Maintenance)
            && !matches!(entry.close_reason, Some(ReturnReason::Maintenance))
            && window.label() != "main"
        {
            return Err("plugin_window_main_required".into());
        }
        let intent = reason.intent();
        if let Some(intent) = intent {
            persistence::set_intent(
                &app.state::<std::sync::Arc<crate::db::Db>>(),
                &entry.request.plugin_id,
                &entry.request.tab_id,
                &intent,
            )?;
        }
        (
            registry.remove(&request.window_id, "plugin_window_returned"),
            reason,
        )
    };
    let reason = match reason {
        ReturnReason::Return => "return",
        ReturnReason::Closed => "closed",
        ReturnReason::Maintenance => "maintenance",
    };
    if let Some(entry) = entry {
        retired(&app, entry, Some(reason));
    }
    Ok(())
}

#[tauri::command]
pub fn plugin_window_request_return(
    window: WebviewWindow,
    app: AppHandle,
    request: RequestReturnRequest,
) -> Result<(), String> {
    main_only(&window)?;
    let (label, payload) = {
        let mut registry = REGISTRY.lock();
        let entry = registry.get_mut(&request.window_id)?;
        entry.owner(&request.registration_id, &request.owner_token)?;
        let reason = entry.request_close(request.reason.unwrap_or(ReturnReason::Return));
        (
            entry.identity.label.clone(),
            serde_json::json!({"windowId":request.window_id,"registrationId":request.registration_id,"reason":reason}),
        )
    };
    app.emit_to(&label, "plugin-window://close-requested", payload)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugin_window_cancel_return(
    window: WebviewWindow,
    app: AppHandle,
    request: ReturnRequest,
) -> Result<(), String> {
    let payload = {
        let mut registry = REGISTRY.lock();
        let entry = registry.get_mut(&request.window_id)?;
        entry.child(window.label(), &request.registration_id)?;
        entry.closing = false;
        entry.close_reason = None;
        serde_json::json!({"windowId":request.window_id,"registrationId":request.registration_id,
            "ownerToken":entry.request.owner_token,"tabId":entry.request.tab_id})
    };
    app.emit_to("main", "plugin-window://return-blocked", payload)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugin_window_dispose(
    window: WebviewWindow,
    app: AppHandle,
    request: OwnerRequest,
) -> Result<(), String> {
    main_only(&window)?;
    let entries = {
        let mut registry = REGISTRY.lock();
        let ids = registry
            .entries
            .values()
            .filter(|entry| entry.request.registration_id == request.registration_id)
            .map(|entry| entry.identity.window_id.clone())
            .collect::<Vec<_>>();
        for id in &ids {
            registry
                .get_mut(id)?
                .owner(&request.registration_id, &request.owner_token)?;
        }
        registry.lifecycle_epoch = registry.lifecycle_epoch.wrapping_add(1);
        registry.presentations.retain(|_, owner| {
            owner != &(request.registration_id.clone(), request.owner_token.clone())
        });
        ids.into_iter()
            .filter_map(|id| registry.remove(&id, "plugin_window_disposed"))
            .collect::<Vec<_>>()
    };
    for entry in entries {
        retired(&app, entry, None);
    }
    Ok(())
}

#[tauri::command]
pub fn plugin_window_owner_alive(
    window: WebviewWindow,
    request: OwnerRequest,
) -> Result<(), String> {
    main_only(&window)?;
    let mut registry = REGISTRY.lock();
    // A registration may heartbeat before its first open or after return.
    for entry in registry
        .entries
        .values_mut()
        .filter(|entry| entry.request.registration_id == request.registration_id)
    {
        entry.owner(&request.registration_id, &request.owner_token)?;
        entry.heartbeat = Instant::now();
    }
    Ok(())
}

#[tauri::command]
pub fn plugin_window_status(window: WebviewWindow, app: AppHandle) -> Result<Status, String> {
    let exists = main_exists(&app);
    let mut registry = REGISTRY.lock();
    let id = registry
        .for_label(window.label())?
        .identity
        .window_id
        .clone();
    let entry = registry.get_mut(&id)?;
    let owner_available = entry.available(exists, Instant::now());
    if !owner_available {
        entry.cancel("plugin_window_owner_unavailable");
    }
    Ok(Status {
        owner_available,
        closing: entry.closing,
        reason: entry.close_reason,
    })
}

pub fn shutdown(app: &AppHandle) {
    let entries = {
        let mut registry = REGISTRY.lock();
        registry.stopped = true;
        registry.presentations.clear();
        registry
            .entries
            .drain()
            .map(|(_, mut entry)| {
                entry.cancel("plugin_window_app_shutdown");
                entry
            })
            .collect::<Vec<_>>()
    };
    for entry in entries {
        retired(app, entry, None);
    }
}
/// Backend disable/uninstall/reload/quarantine must retire views even if the
/// main document has not processed its plugin invalidation event yet.
pub(crate) fn dispose_plugin(app: &AppHandle, plugin_id: &str) {
    let entries = {
        let mut registry = REGISTRY.lock();
        registry.lifecycle_epoch = registry.lifecycle_epoch.wrapping_add(1);
        registry.presentations.retain(|(id, _), _| id != plugin_id);
        let ids = registry
            .entries
            .values()
            .filter(|entry| entry.request.plugin_id == plugin_id)
            .map(|entry| entry.identity.window_id.clone())
            .collect::<Vec<_>>();
        ids.into_iter()
            .filter_map(|id| registry.remove(&id, "plugin_window_plugin_disposed"))
            .collect::<Vec<_>>()
    };
    for entry in entries {
        retired(app, entry, None);
    }
}
pub fn blocking_reasons() -> Vec<String> {
    if REGISTRY.lock().entries.is_empty() {
        vec![]
    } else {
        vec!["plugin-window-without-checkpoint".into()]
    }
}
pub fn is_plugin_window(label: &str) -> bool {
    label
        .strip_prefix(PREFIX)
        .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
}

pub(crate) fn authorize_plugin_window_caller(
    window: &WebviewWindow,
    app: &AppHandle,
    claimed_plugin_id: &str,
    allow_detached: bool,
) -> Result<String, String> {
    let exists = main_exists(app);
    let mut registry = REGISTRY.lock();
    authorize_registry_caller(
        &mut registry,
        window.label(),
        exists,
        Instant::now(),
        claimed_plugin_id,
        allow_detached,
    )
}

fn authorize_registry_caller(
    registry: &mut Registry,
    window_label: &str,
    main_alive: bool,
    now: Instant,
    claimed_plugin_id: &str,
    allow_detached: bool,
) -> Result<String, String> {
    if window_label == "main" {
        if !main_alive || registry.stopped {
            return Err("plugin_window_owner_unavailable".into());
        }
        return Ok(claimed_plugin_id.to_owned());
    }
    if !allow_detached {
        return Err("plugin_window_main_required".into());
    }
    if registry.stopped {
        return Err("plugin_window_shutting_down".into());
    }
    let window_id = registry
        .for_label(window_label)?
        .identity
        .window_id
        .clone();
    let active_owner = {
        let entry = registry.get_mut(&window_id)?;
        entry.child(window_label, &entry.request.registration_id.clone())?;
        if entry.closing {
            return Err("plugin_window_closing".into());
        }
        if !claimed_plugin_id.is_empty() && claimed_plugin_id != entry.request.plugin_id {
            return Err("plugin_window_plugin_mismatch".into());
        }
        if !entry.available(main_alive, now) {
            entry.cancel("plugin_window_owner_unavailable");
            return Err("plugin_window_owner_unavailable".into());
        }
        (
            entry.request.plugin_id.clone(),
            entry.request.tab_id.clone(),
            entry.request.registration_id.clone(),
            entry.request.owner_token.clone(),
        )
    };
    if let Some(presented) = registry
        .presentations
        .get(&(active_owner.0.clone(), active_owner.1))
    {
        if presented != &(active_owner.2, active_owner.3) {
            return Err("plugin_window_owner_mismatch".into());
        }
    }
    Ok(active_owner.0)
}

#[cfg(test)]
mod tests;
