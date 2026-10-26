use super::*;
use serde_json::json;

#[test]
fn return_close_and_maintenance_have_distinct_persisted_intents() {
    assert_eq!(
        ReturnReason::Return.intent(),
        Some(Intent {
            presentation: Presentation::Docked,
            was_open: true
        })
    );
    assert_eq!(
        ReturnReason::Closed.intent(),
        Some(Intent {
            presentation: Presentation::Detached,
            was_open: false
        })
    );
    assert_eq!(ReturnReason::Maintenance.intent(), None);
    let mut entry = Entry::new(request());
    assert_eq!(
        entry.request_close(ReturnReason::Maintenance),
        ReturnReason::Maintenance
    );
    assert_eq!(
        entry.request_close(ReturnReason::Closed),
        ReturnReason::Maintenance
    );
    let mut entry = Entry::new(request());
    assert_eq!(
        entry.request_close(ReturnReason::Closed),
        ReturnReason::Closed
    );
    assert_eq!(
        entry.request_close(ReturnReason::Maintenance),
        ReturnReason::Closed
    );
}

fn request() -> OpenRequest {
    OpenRequest {
        plugin_id: "example-plugin".into(),
        tab_id: "plugin:example-plugin:panel".into(),
        registration_id: uuid::Uuid::new_v4().to_string(),
        owner_token: uuid::Uuid::new_v4().to_string(),
        title: "示例 🧑‍💻".into(),
        renderer_export: "renderDetached".into(),
        code: "export function renderDetached() {}".into(),
        css: String::new(),
        snapshot: Snapshot {
            revision: 0,
            state: json!({"text":"initial"}),
        },
        dark: false,
        focus: true,
        labels: Labels {
            return_to_main: "返回".into(),
            owner_unavailable: "不可用".into(),
            action_failed: "失败".into(),
            loading: "加载".into(),
        },
    }
}
fn receipt(entry: &Entry, sequence: u64, value: Value) -> Receipt {
    Receipt {
        sequence,
        ok: true,
        unknown: false,
        value,
        error: None,
        snapshot: entry.request.snapshot.clone(),
    }
}
fn action() -> Action {
    Action {
        name: "save".into(),
        args: vec![json!({"text":"edit"})],
    }
}
fn response(entry: &Entry, sequence: u64, snapshot: Snapshot) -> RespondRequest {
    RespondRequest {
        window_id: entry.identity.window_id.clone(),
        registration_id: entry.request.registration_id.clone(),
        owner_token: entry.request.owner_token.clone(),
        sequence,
        ok: true,
        value: Value::Bool(false),
        error: None,
        snapshot,
    }
}

#[test]
fn rejected_wire_response_without_value_still_delivers_definitive_receipt() {
    let mut entry = Entry::new(request());
    entry.admit(1, &action()).unwrap();
    let request: RespondRequest = serde_json::from_value(json!({
        "windowId": entry.identity.window_id, "registrationId": entry.request.registration_id,
        "ownerToken": entry.request.owner_token, "sequence": 1, "ok": false,
        "error": "binding changed", "snapshot": entry.request.snapshot,
    }))
    .unwrap();
    assert_eq!(request.value, Value::Null);
    entry.respond(request).unwrap();
    let receipt = entry.slots[&1].channel.borrow().clone().unwrap();
    assert!(!receipt.ok);
    assert!(!receipt.unknown);
    assert_eq!(receipt.value, Value::Null);
    assert_eq!(receipt.error.as_deref(), Some("binding changed"));
    let success = super::tests::receipt(&entry, 2, Value::Bool(false));
    let wire = serde_json::to_value(success).unwrap();
    assert!(wire.get("error").is_none());
}

#[test]
fn validates_exact_plugin_tab_ownership_and_bundle_fields() {
    let mut req = request();
    assert!(validate_open(&req).is_ok());
    req.tab_id = "plugin:example-plugin-foreign".into();
    assert!(validate_open(&req).is_err());
    req.tab_id = "plugin:example-plugin:".into();
    assert!(validate_open(&req).is_err());
    req.tab_id = "plugin:example-plugin".into();
    assert!(validate_open(&req).is_ok());
    req.renderer_export = "render.foo".into();
    assert!(validate_open(&req).is_err());
    req.renderer_export = "default".into();
    assert!(validate_open(&req).is_err());
    req.renderer_export = "render".into();
    req.owner_token = "not-an-owner-token".into();
    assert!(validate_open(&req).is_err());
    let mut req = request();
    req.plugin_id = "../escape".into();
    assert!(validate_open(&req).is_err());
}

#[test]
fn same_registration_reuses_window_new_generation_retires_old_only() {
    let mut registry = Registry::default();
    let req = request();
    let (first, old, reused) = registry.open(req.clone()).unwrap();
    assert!(old.is_none());
    assert!(!reused);
    let (same, old, reused) = registry.open(req.clone()).unwrap();
    assert!(old.is_none());
    assert!(reused);
    assert_eq!(same.window_id, first.window_id);
    let mut wrong = req.clone();
    wrong.owner_token = uuid::Uuid::new_v4().to_string();
    assert!(registry.open(wrong).is_err());
    let mut next = req.clone();
    next.registration_id = uuid::Uuid::new_v4().to_string();
    next.owner_token = uuid::Uuid::new_v4().to_string();
    let (second, old, reused) = registry.open(next).unwrap();
    assert!(!reused);
    assert_eq!(old.unwrap().identity.window_id, first.window_id);
    assert_ne!(second.window_id, first.window_id);
    // An old Destroyed callback cannot withdraw the replacement.
    assert!(registry.remove(&first.window_id, "closed").is_none());
    assert!(registry.entries.contains_key(&second.window_id));
    assert!(registry
        .get_mut(&second.window_id)
        .unwrap()
        .owner(&req.registration_id, &req.owner_token)
        .is_err());
}

#[test]
fn duplicate_actions_share_receipt_and_cannot_execute_twice() {
    let mut entry = Entry::new(request());
    let (_, fresh) = entry.admit(1, &action()).unwrap();
    assert!(fresh);
    let (repeat, fresh) = entry.admit(1, &action()).unwrap();
    assert!(!fresh);
    assert!(entry.admit(3, &action()).is_err());
    entry.finish(receipt(&entry, 1, Value::Bool(false)), true);
    assert_eq!(repeat.borrow().as_ref().unwrap().value, Value::Bool(false));
    entry.finish(receipt(&entry, 1, json!("changed")), true);
    assert_eq!(
        entry
            .admit(1, &action())
            .unwrap()
            .0
            .borrow()
            .as_ref()
            .unwrap()
            .value,
        Value::Bool(false)
    );
    assert_eq!(entry.next_sequence, 2);
}

#[test]
fn receipt_eviction_keeps_admission_watermark() {
    let mut entry = Entry::new(request());
    for sequence in 1..=130 {
        entry.admit(sequence, &action()).unwrap();
        entry.finish(receipt(&entry, sequence, Value::Null), true);
    }
    assert_eq!(entry.slots.len(), MAX_RECEIPTS);
    assert!(entry
        .admit(1, &action())
        .unwrap_err()
        .contains("expired_no_retry"));
    assert!(entry.admit(130, &action()).is_ok());
    assert_eq!(entry.next_sequence, 131);
}

#[test]
fn receipts_have_a_total_byte_budget() {
    let mut entry = Entry::new(request());
    for sequence in 1..=6 {
        entry.admit(sequence, &action()).unwrap();
        entry.finish(
            receipt(&entry, sequence, Value::String("x".repeat(4 * 1024 * 1024))),
            true,
        );
    }
    assert!(entry.receipt_bytes <= MAX_RECEIPT_BYTES);
    assert!(entry.slots.len() < 6);
    assert!(entry
        .admit(1, &action())
        .unwrap_err()
        .contains("expired_no_retry"));
    assert_eq!(entry.next_sequence, 7);
}

#[test]
fn timeout_is_unknown_and_late_first_response_can_resolve_it() {
    let mut entry = Entry::new(request());
    let (receiver, _) = entry.admit(1, &action()).unwrap();
    entry.fail(1, "plugin_window_action_outcome_unknown_no_retry");
    assert!(!receiver.borrow().as_ref().unwrap().ok);
    assert!(!entry.admit(1, &action()).unwrap().1);
    entry.finish(receipt(&entry, 1, json!("saved")), true);
    assert_eq!(receiver.borrow().as_ref().unwrap().value, json!("saved"));
    entry.finish(receipt(&entry, 1, json!("late duplicate")), true);
    assert_eq!(receiver.borrow().as_ref().unwrap().value, json!("saved"));
}

#[test]
fn receipt_inspection_is_read_only_and_late_response_recovers_the_original_action() {
    let mut entry = Entry::new(request());
    let initial = entry.inspect_receipt(1).unwrap();
    assert_eq!(initial.state, ReceiptState::Missing);
    assert_eq!(entry.next_sequence, 1);
    assert!(entry.slots.is_empty());
    entry.admit(1, &action()).unwrap();
    assert_eq!(entry.inspect_receipt(1).unwrap().state, ReceiptState::Pending);
    entry.fail(1, "plugin_window_action_outcome_unknown_no_retry");
    assert_eq!(entry.inspect_receipt(1).unwrap().state, ReceiptState::Unknown);
    assert!(entry.inspect_receipt(1).unwrap().receipt.is_none());
    let mut response = response(&entry, 1, entry.request.snapshot.clone());
    response.value = json!("saved once");
    entry.respond(response).unwrap();
    let resolved = entry.inspect_receipt(1).unwrap();
    assert_eq!(resolved.state, ReceiptState::Resolved);
    assert_eq!(resolved.receipt.unwrap().value, json!("saved once"));
    assert_eq!(entry.next_sequence, 2);
    assert_eq!(entry.slots.len(), 1);
}

#[test]
fn receipt_inspection_rejects_other_windows_and_generations_without_admitting_actions() {
    let mut registry = Registry::default();
    let (identity, _, _) = registry.open(request()).unwrap();
    let query = ReceiptRequest { window_id: identity.window_id.clone(), registration_id: identity.registration_id.clone(), sequence: 1 };
    assert!(registry.inspect_receipt("main", &query).is_err());
    let wrong = ReceiptRequest { registration_id: "wrong-generation".into(), ..query };
    assert!(registry.inspect_receipt(&identity.label, &wrong).is_err());
    let query = ReceiptRequest { registration_id: identity.registration_id.clone(), ..wrong };
    assert_eq!(registry.inspect_receipt(&identity.label, &query).unwrap().state, ReceiptState::Missing);
    assert_eq!(registry.entries[&identity.window_id].next_sequence, 1);
    assert!(registry.entries[&identity.window_id].slots.is_empty());
}

#[test]
fn init_retains_native_sequence_and_unresolved_actions_across_window_reload() {
    let mut entry = Entry::new(request());
    entry.admit(1, &action()).unwrap();
    entry.finish(receipt(&entry, 1, Value::Null), true);
    entry.admit(2, &action()).unwrap();
    entry.fail(2, "plugin_window_action_outcome_unknown_no_retry");
    entry.admit(3, &action()).unwrap();
    let info = entry.init();
    assert_eq!(info.next_sequence, 4);
    assert_eq!(info.unresolved_sequences, vec![2, 3]);
    assert_eq!(entry.next_sequence, 4);
}

#[test]
fn pending_limit_and_owner_retirement_cancel_waiters() {
    let mut entry = Entry::new(request());
    for sequence in 1..=MAX_PENDING as u64 {
        entry.admit(sequence, &action()).unwrap();
    }
    assert!(entry
        .admit(MAX_PENDING as u64 + 1, &action())
        .unwrap_err()
        .contains("too_many_pending"));
    let (receiver, _) = entry.admit(1, &action()).unwrap();
    assert!(entry.available(true, entry.heartbeat + Duration::from_secs(14)));
    assert!(!entry.available(true, entry.heartbeat + Duration::from_secs(16)));
    assert!(!entry.available(false, entry.heartbeat));
    entry.cancel("plugin_window_owner_unavailable");
    assert_eq!(
        receiver.borrow().as_ref().unwrap().error.as_deref(),
        Some("plugin_window_owner_unavailable")
    );
    assert!(entry.slots.values().all(|slot| slot.completed));
}

#[test]
fn child_identity_and_owner_tokens_are_independent() {
    let entry = Entry::new(request());
    assert!(entry
        .child(&entry.identity.label, &entry.request.registration_id)
        .is_ok());
    assert!(entry.child("main", &entry.request.registration_id).is_err());
    assert!(entry
        .child(&entry.identity.label, &uuid::Uuid::new_v4().to_string())
        .is_err());
    assert!(entry
        .owner(&entry.request.registration_id, "wrong")
        .is_err());
    let serialized = serde_json::to_value(entry.init()).unwrap();
    assert!(serialized.get("ownerToken").is_none());
    assert_eq!(serialized["windowId"], entry.identity.window_id);
}

#[test]
fn snapshot_is_monotonic_and_equal_revision_must_be_identical() {
    let mut entry = Entry::new(request());
    assert!(!entry.snapshot(&entry.request.snapshot.clone()).unwrap());
    assert!(entry
        .snapshot(&Snapshot {
            revision: 0,
            state: Value::Null
        })
        .unwrap_err()
        .contains("conflict"));
    assert!(entry
        .snapshot(&Snapshot {
            revision: 1,
            state: json!({"text":"new"})
        })
        .unwrap());
    assert!(!entry
        .snapshot(&Snapshot {
            revision: 0,
            state: json!({"text":"old"})
        })
        .unwrap());
    assert_eq!(entry.request.snapshot.state, json!({"text":"new"}));
}

#[test]
fn registry_is_bounded_and_shutdown_rejects_open() {
    let mut registry = Registry::default();
    for index in 0..MAX_WINDOWS {
        let mut req = request();
        req.tab_id = format!("plugin:example-plugin:{index}");
        registry.open(req).unwrap();
    }
    let mut extra = request();
    extra.tab_id = "plugin:example-plugin:extra".into();
    assert!(registry.open(extra).is_err());
    registry.stopped = true;
    assert!(registry.open(request()).is_err());
}

#[test]
fn closing_retirement_wakes_pending_and_cannot_reappear() {
    let mut registry = Registry::default();
    let (id, _, _) = registry.open(request()).unwrap();
    let (receiver, _) = registry
        .get_mut(&id.window_id)
        .unwrap()
        .admit(1, &action())
        .unwrap();
    registry
        .remove(&id.window_id, "plugin_window_closed")
        .unwrap();
    assert_eq!(
        receiver.borrow().as_ref().unwrap().error.as_deref(),
        Some("plugin_window_closed")
    );
    assert!(registry.get_mut(&id.window_id).is_err());
}

#[test]
fn publication_then_older_response_keeps_latest_snapshot_and_false_value() {
    let mut entry = Entry::new(request());
    let (receiver, _) = entry.admit(1, &action()).unwrap();
    let older = Snapshot {
        revision: 1,
        state: json!({"text":"action result"}),
    };
    let latest = Snapshot {
        revision: 2,
        state: json!({"text":"later publication"}),
    };
    entry.snapshot(&latest).unwrap();
    // A slow publication is ignored too, not surfaced as a failed business action.
    assert!(!entry.snapshot(&older).unwrap());
    entry.respond(response(&entry, 1, older)).unwrap();
    let receipt = receiver.borrow();
    let receipt = receipt.as_ref().unwrap();
    assert!(receipt.ok);
    assert!(!receipt.unknown);
    assert_eq!(receipt.value, Value::Bool(false));
    assert_eq!(receipt.snapshot, latest);
    assert_eq!(entry.request.snapshot, latest);
}

#[test]
fn duplicate_sequence_with_different_payload_is_a_conflict() {
    let mut entry = Entry::new(request());
    entry.admit(1, &action()).unwrap();
    let different = Action {
        name: "save".into(),
        args: vec![json!({"text":"different"})],
    };
    assert!(entry
        .admit(1, &different)
        .unwrap_err()
        .contains("payload_conflict"));
    entry.finish(receipt(&entry, 1, Value::Null), true);
    assert!(entry
        .admit(1, &different)
        .unwrap_err()
        .contains("payload_conflict"));
    assert!(!entry.admit(1, &action()).unwrap().1);
}

#[test]
fn close_request_allows_queued_actions_until_return() {
    let mut entry = Entry::new(request());
    entry.closing = true;
    assert!(entry.available(true, Instant::now()));
    let (receiver, fresh) = entry.admit(1, &action()).unwrap();
    assert!(fresh);
    entry
        .respond(response(&entry, 1, entry.request.snapshot.clone()))
        .unwrap();
    assert!(receiver.borrow().as_ref().unwrap().ok);
}

#[test]
fn native_cancellation_is_unknown_but_business_rejection_is_definitive() {
    let mut entry = Entry::new(request());
    let (receiver, _) = entry.admit(1, &action()).unwrap();
    entry.fail(1, "plugin_window_action_outcome_unknown_no_retry");
    assert!(receiver.borrow().as_ref().unwrap().unknown);
    let mut response = response(&entry, 1, entry.request.snapshot.clone());
    response.ok = false;
    response.error = Some("business rejection".into());
    entry.respond(response).unwrap();
    let receipt = receiver.borrow();
    let receipt = receipt.as_ref().unwrap();
    assert!(!receipt.ok);
    assert!(!receipt.unknown);
}

#[test]
fn authorizes_main_and_active_detached_window_callers_only() {
    let mut registry = Registry::default();
    let now = Instant::now();
    assert_eq!(
        authorize_registry_caller(&mut registry, "main", true, now, "example-plugin", false)
            .unwrap(),
        "example-plugin"
    );
    assert!(
        authorize_registry_caller(&mut registry, "main", false, now, "example-plugin", true)
            .is_err()
    );

    let req = request();
    registry.presentations.insert(
        (req.plugin_id.clone(), req.tab_id.clone()),
        (req.registration_id.clone(), req.owner_token.clone()),
    );
    let (identity, _, _) = registry.open(req.clone()).unwrap();

    // Active detached window can call when allow_detached = true and derives real plugin_id
    assert_eq!(
        authorize_registry_caller(&mut registry, &identity.label, true, now, "", true).unwrap(),
        "example-plugin"
    );
    assert_eq!(
        authorize_registry_caller(
            &mut registry,
            &identity.label,
            true,
            now,
            "example-plugin",
            true
        )
        .unwrap(),
        "example-plugin"
    );

    // Resolve (allow_detached = false) is forbidden from detached windows
    assert_eq!(
        authorize_registry_caller(
            &mut registry,
            &identity.label,
            true,
            now,
            "example-plugin",
            false
        )
        .unwrap_err(),
        "plugin_window_main_required"
    );

    // Spoofed plugin_id from detached window is rejected
    assert_eq!(
        authorize_registry_caller(
            &mut registry,
            &identity.label,
            true,
            now,
            "other-plugin",
            true
        )
        .unwrap_err(),
        "plugin_window_plugin_mismatch"
    );

    // Closing detached window is rejected
    registry.get_mut(&identity.window_id).unwrap().closing = true;
    assert_eq!(
        authorize_registry_caller(
            &mut registry,
            &identity.label,
            true,
            now,
            "example-plugin",
            true
        )
        .unwrap_err(),
        "plugin_window_closing"
    );
    registry.get_mut(&identity.window_id).unwrap().closing = false;

    // Expired owner heartbeat is rejected
    assert_eq!(
        authorize_registry_caller(
            &mut registry,
            &identity.label,
            true,
            now + OWNER_TTL + Duration::from_secs(1),
            "example-plugin",
            true
        )
        .unwrap_err(),
        "plugin_window_owner_unavailable"
    );

    // Replaced presentation owner is rejected
    registry.presentations.insert(
        (req.plugin_id.clone(), req.tab_id.clone()),
        ("replaced-reg".into(), "replaced-token".into()),
    );
    assert_eq!(
        authorize_registry_caller(
            &mut registry,
            &identity.label,
            true,
            now,
            "example-plugin",
            true
        )
        .unwrap_err(),
        "plugin_window_owner_mismatch"
    );

    // Removed/closed window is rejected
    registry.remove(&identity.window_id, "closed");
    assert_eq!(
        authorize_registry_caller(
            &mut registry,
            &identity.label,
            true,
            now,
            "example-plugin",
            true
        )
        .unwrap_err(),
        "plugin_window_unsupported_window"
    );
}
