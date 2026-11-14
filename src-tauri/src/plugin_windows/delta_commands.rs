use super::delta::Update;
use super::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    snapshot_delta: u8,
}
#[derive(Serialize)]
pub struct Revision {
    revision: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishUpdateRequest {
    window_id: String,
    registration_id: String,
    owner_token: String,
    update: Update,
    dark: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RespondUpdateRequest {
    window_id: String,
    registration_id: String,
    owner_token: String,
    sequence: u64,
    ok: bool,
    #[serde(default)]
    value: Value,
    error: Option<String>,
    update: Update,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionUpdateRequest {
    window_id: String,
    registration_id: String,
    sequence: u64,
    action: Action,
    known_revision: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InspectUpdateRequest {
    window_id: String,
    registration_id: String,
    sequence: u64,
    known_revision: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateReceipt {
    sequence: u64,
    ok: bool,
    unknown: bool,
    value: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    update: Update,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInspection {
    window_id: String,
    registration_id: String,
    sequence: u64,
    state: ReceiptState,
    #[serde(skip_serializing_if = "Option::is_none")]
    receipt: Option<UpdateReceipt>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateEvent {
    window_id: String,
    registration_id: String,
    update: Update,
    dark: bool,
}

impl Entry {
    fn update_event(&self, update: Update) -> UpdateEvent {
        UpdateEvent {
            window_id: self.identity.window_id.clone(),
            registration_id: self.request.registration_id.clone(),
            update,
            dark: self.request.dark,
        }
    }
    fn update(&mut self, update: Update) -> Result<Option<Update>, String> {
        self.mode(true)?;
        self.delta.apply(&mut self.request.snapshot, update)
    }
    fn known_revision(&self, known: u64) -> Result<(), String> {
        if known > delta::MAX_REVISION || known > self.request.snapshot.revision {
            Err("plugin_window_snapshot_base_mismatch".into())
        } else {
            Ok(())
        }
    }
    fn update_receipt(&self, receipt: Receipt, known: u64) -> Result<UpdateReceipt, String> {
        self.mode(true)?;
        if receipt.snapshot.revision > self.request.snapshot.revision {
            return Err("plugin_window_snapshot_conflict".into());
        }
        Ok(UpdateReceipt {
            sequence: receipt.sequence,
            ok: receipt.ok,
            unknown: receipt.unknown,
            value: receipt.value,
            error: receipt.error,
            update: self.delta.since(&self.request.snapshot, known)?,
        })
    }
    fn respond_update(&mut self, request: RespondUpdateRequest) -> Result<Option<Update>, String> {
        self.mode(true)?;
        request.update.validate()?;
        if delta::bytes(&request.value) > MAX_RESULT {
            return Err("plugin_window_result_too_large".into());
        }
        let slot = self
            .slots
            .get(&request.sequence)
            .ok_or("plugin_window_action_not_pending_or_expired")?;
        // A retransmitted receipt never changes its business result, but its
        // projection must still pass duplicate/conflict validation.
        let responded = slot.responded;
        let update = self.update(request.update)?;
        if !responded {
            self.finish(
                Receipt {
                    sequence: request.sequence,
                    ok: request.ok,
                    unknown: false,
                    value: request.value,
                    error: request
                        .error
                        .map(|error| error.chars().take(2048).collect()),
                    snapshot: self.receipt_snapshot(),
                },
                true,
            );
        }
        Ok(update)
    }
    fn inspect_update(&self, sequence: u64, known: u64) -> Result<UpdateInspection, String> {
        self.mode(true)?;
        self.known_revision(known)?;
        if sequence == 0 {
            return Err("plugin_window_invalid_sequence".into());
        }
        let (state, receipt) = match self.slots.get(&sequence) {
            Some(slot) => match slot.channel.borrow().clone() {
                Some(receipt) if slot.responded && !receipt.unknown => (
                    ReceiptState::Resolved,
                    Some(self.update_receipt(receipt, known)?),
                ),
                Some(_) => (ReceiptState::Unknown, None),
                None => (ReceiptState::Pending, None),
            },
            None if sequence < self.next_sequence => (ReceiptState::Expired, None),
            None => (ReceiptState::Missing, None),
        };
        Ok(UpdateInspection {
            window_id: self.identity.window_id.clone(),
            registration_id: self.request.registration_id.clone(),
            sequence,
            state,
            receipt,
        })
    }
}
fn emit_update(app: &AppHandle, label: &str, event: UpdateEvent) -> Result<(), String> {
    app.emit_to(label, "plugin-window://snapshot", event)
        .map_err(|e| e.to_string())
}
pub(super) fn emit_current(app: &AppHandle, id: &str) -> Result<(), String> {
    let registry = REGISTRY.lock();
    let entry = registry
        .entries
        .get(id)
        .ok_or("plugin_window_unavailable")?;
    if entry.request.incremental {
        let event = entry.update_event(Update::Full {
            snapshot: entry.request.snapshot.clone(),
        });
        let label = entry.identity.label.clone();
        drop(registry);
        emit_update(app, &label, event)
    } else {
        let event = entry.snapshot_event();
        let label = entry.identity.label.clone();
        drop(registry);
        emit_snapshot(app, &label, event)
    }
}

#[tauri::command]
pub fn plugin_window_capabilities(window: WebviewWindow) -> Result<Capabilities, String> {
    main_only(&window)?;
    Ok(Capabilities { snapshot_delta: 1 })
}
#[tauri::command]
pub fn plugin_window_snapshot(
    window: WebviewWindow,
    request: ChildRequest,
) -> Result<SnapshotEvent, String> {
    let registry = REGISTRY.lock();
    let entry = registry
        .entries
        .get(&request.window_id)
        .ok_or("plugin_window_unavailable")?;
    entry.child(window.label(), &request.registration_id)?;
    entry.mode(true)?;
    Ok(entry.snapshot_event())
}
#[tauri::command]
pub fn plugin_window_publish_update(
    window: WebviewWindow,
    app: AppHandle,
    request: PublishUpdateRequest,
) -> Result<Revision, String> {
    main_only(&window)?;
    let (revision, event) = {
        let mut registry = REGISTRY.lock();
        let entry = registry.get_mut(&request.window_id)?;
        entry.owner(&request.registration_id, &request.owner_token)?;
        let update = entry.update(request.update)?;
        let dark_changed = entry.request.dark != request.dark;
        entry.request.dark = request.dark;
        let revision = entry.request.snapshot.revision;
        let update = update.or_else(|| dark_changed.then_some(Update::Unchanged { revision }));
        (
            revision,
            update.map(|update| (entry.identity.label.clone(), entry.update_event(update))),
        )
    };
    if let Some((label, event)) = event {
        emit_update(&app, &label, event)?;
    }
    Ok(Revision { revision })
}
#[tauri::command]
pub fn plugin_window_respond_update(
    window: WebviewWindow,
    app: AppHandle,
    request: RespondUpdateRequest,
) -> Result<Revision, String> {
    main_only(&window)?;
    let (revision, event) = {
        let mut registry = REGISTRY.lock();
        let entry = registry.get_mut(&request.window_id)?;
        entry.owner(&request.registration_id, &request.owner_token)?;
        let update = entry.respond_update(request)?;
        (
            entry.request.snapshot.revision,
            update.map(|update| (entry.identity.label.clone(), entry.update_event(update))),
        )
    };
    if let Some((label, event)) = event {
        emit_update(&app, &label, event)?;
    }
    Ok(Revision { revision })
}
#[tauri::command]
pub fn plugin_window_inspect_action_update(
    window: WebviewWindow,
    request: InspectUpdateRequest,
) -> Result<UpdateInspection, String> {
    let registry = REGISTRY.lock();
    let entry = registry
        .entries
        .get(&request.window_id)
        .ok_or("plugin_window_unavailable")?;
    entry.child(window.label(), &request.registration_id)?;
    entry.inspect_update(request.sequence, request.known_revision)
}
#[tauri::command]
pub async fn plugin_window_action_update(
    window: WebviewWindow,
    app: AppHandle,
    request: ActionUpdateRequest,
) -> Result<UpdateReceipt, String> {
    if request.action.name.is_empty()
        || request.action.name.len() > 80
        || request.action.args.len() > 128
        || delta::bytes(&request.action) > 64 * 1024
    {
        return Err("plugin_window_invalid_action".into());
    }
    let exists = main_exists(&app);
    let (mut receiver, event) = {
        let mut registry = REGISTRY.lock();
        let entry = registry.get_mut(&request.window_id)?;
        entry.child(window.label(), &request.registration_id)?;
        entry.mode(true)?;
        entry.known_revision(request.known_revision)?;
        if !entry.available(exists, Instant::now()) {
            entry.cancel("plugin_window_owner_unavailable");
            return Err("plugin_window_owner_unavailable".into());
        }
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
                return Ok::<_, String>(receipt);
            }
            receiver
                .changed()
                .await
                .map_err(|_| "plugin_window_closed".to_owned())?;
        }
    };
    let receipt = match tokio::time::timeout(ACTION_TIMEOUT, wait).await {
        Ok(result) => result?,
        Err(_) => {
            if let Ok(entry) = REGISTRY.lock().get_mut(&request.window_id) {
                entry.fail(
                    request.sequence,
                    "plugin_window_action_outcome_unknown_no_retry",
                );
            }
            receiver.borrow().clone().ok_or("plugin_window_closed")?
        }
    };
    let registry = REGISTRY.lock();
    let entry = registry
        .entries
        .get(&request.window_id)
        .ok_or("plugin_window_closed")?;
    entry.child(window.label(), &request.registration_id)?;
    entry.update_receipt(receipt, request.known_revision)
}

#[cfg(test)]
mod tests;
