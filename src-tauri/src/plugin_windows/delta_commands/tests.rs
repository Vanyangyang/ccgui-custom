use super::*;
use serde_json::json;
fn entry() -> Entry {
    let mut request = super::super::tests::request();
    request.incremental = true;
    request.snapshot.state = json!({"history":"x".repeat(2*1024*1024),"draft":""});
    Entry::new(request)
}
fn action() -> Action {
    Action {
        name: "input".into(),
        args: vec![json!("输入😊")],
    }
}
fn patch(base: u64, revision: u64, draft: &str) -> Update {
    serde_json::from_value(json!({"kind":"patch","baseRevision":base,"revision":revision,"changes":[{"op":"set","path":["draft"],"value":draft}]})).unwrap()
}
fn respond_request(entry: &Entry, sequence: u64, update: Update) -> RespondUpdateRequest {
    RespondUpdateRequest {
        window_id: entry.identity.window_id.clone(),
        registration_id: entry.request.registration_id.clone(),
        owner_token: entry.request.owner_token.clone(),
        sequence,
        ok: true,
        value: json!(false),
        error: None,
        update,
    }
}
#[test]
fn larger_state_budget_does_not_enlarge_action_result_budget() {
    let mut entry = entry();
    let (receiver, _) = entry.admit(1, &action()).unwrap();
    let mut response = respond_request(&entry, 1, Update::Unchanged { revision: 0 });
    response.value = json!("x".repeat(MAX_RESULT - 1));
    assert_eq!(entry.respond_update(response).unwrap_err(), "plugin_window_result_too_large");
    assert!(receiver.borrow().is_none());
    assert_eq!(entry.request.snapshot.revision, 0);
}
#[test]
fn mixed_modes_rejected_old_open_defaults_and_init_advertises_mode() {
    let mut old = serde_json::to_value(super::super::tests::request()).unwrap();
    old.as_object_mut().unwrap().remove("incremental");
    let request: OpenRequest = serde_json::from_value(old).unwrap();
    assert!(!request.incremental);
    let mut legacy = Entry::new(request);
    assert!(legacy.mode(false).is_ok());
    assert!(legacy.update(Update::Unchanged { revision: 0 }).is_err());
    let entry = entry();
    assert!(entry.mode(false).is_err());
    assert!(entry.init().incremental);
    assert!(entry.child("main", &entry.request.registration_id).is_err());
    assert!(entry.child(&entry.identity.label, "wrong").is_err());
    assert!(entry
        .owner(&entry.request.registration_id, "wrong")
        .is_err());
    let mut registry = Registry::default();
    let (identity, _, _) = registry.open(entry.request.clone()).unwrap();
    let mut other = entry.request.clone();
    other.incremental = false;
    assert!(registry
        .open(other)
        .err()
        .unwrap()
        .contains("mode_mismatch"));
    assert!(registry
        .inspect_receipt(
            &identity.label,
            &ReceiptRequest {
                window_id: identity.window_id,
                registration_id: identity.registration_id,
                sequence: 1
            }
        )
        .is_err());
}
#[test]
fn receipts_are_small_recover_original_results_and_latest_projection() {
    let mut entry = entry();
    let (receiver, fresh) = entry.admit(1, &action()).unwrap();
    assert!(fresh);
    assert!(!entry.admit(1, &action()).unwrap().1);
    let response = respond_request(&entry, 1, patch(0, 1, "输入😊"));
    assert!(entry.respond_update(response).unwrap().is_some());
    let stored = receiver.borrow().clone().unwrap();
    assert_eq!(stored.snapshot.state, Value::Null);
    assert!(entry.receipt_bytes < 1024);
    entry.update(patch(1, 2, "newer publish")).unwrap();
    let receipt = entry.update_receipt(stored, 0).unwrap();
    assert_eq!(receipt.value, json!(false));
    assert_eq!(receipt.update.revision(), 2);
    let inspected = entry.inspect_update(1, 2).unwrap();
    assert_eq!(inspected.state, ReceiptState::Resolved);
    assert!(matches!(
        inspected.receipt.unwrap().update,
        Update::Unchanged { revision: 2 }
    ));
    assert_eq!(entry.next_sequence, 2);
    let duplicate = respond_request(&entry, 1, patch(0, 1, "input"));
    assert!(entry.respond_update(duplicate).unwrap().is_none());
    assert_eq!(entry.request.snapshot.state["draft"], "newer publish");
    let conflict = respond_request(&entry, 1, patch(1, 2, "conflict"));
    assert!(entry
        .respond_update(conflict)
        .unwrap_err()
        .contains("conflict"));
}
#[test]
fn unknown_close_barrier_late_resolution_and_eviction_preserve_admission() {
    let mut entry = entry();
    entry.admit(1, &action()).unwrap();
    entry.request_close(ReturnReason::Closed);
    entry.cancel("timeout");
    assert_eq!(
        entry.inspect_update(1, 0).unwrap().state,
        ReceiptState::Unknown
    );
    assert!(entry.slots.values().any(|slot| !slot.responded));
    assert_eq!(
        entry.slots[&1]
            .channel
            .borrow()
            .as_ref()
            .unwrap()
            .snapshot
            .state,
        Value::Null
    );
    assert!(!entry.admit(1, &action()).unwrap().1);
    let response = respond_request(&entry, 1, patch(0, 1, "late definitive"));
    entry.respond_update(response).unwrap();
    assert_eq!(
        entry.inspect_update(1, 0).unwrap().state,
        ReceiptState::Resolved
    );
    assert!(!entry.slots.values().any(|slot| !slot.responded));
    for sequence in 2..=140 {
        entry.admit(sequence, &action()).unwrap();
        let response = respond_request(&entry, sequence, Update::Unchanged { revision: 1 });
        entry.respond_update(response).unwrap();
    }
    assert_eq!(entry.slots.len(), MAX_RECEIPTS);
    assert!(entry.receipt_bytes < 64 * 1024);
    assert!(entry
        .admit(1, &action())
        .unwrap_err()
        .contains("expired_no_retry"));
    assert_eq!(
        entry.inspect_update(1, 1).unwrap().state,
        ReceiptState::Expired
    );
    assert_eq!(entry.next_sequence, 141);
}
#[test]
fn pending_response_rejects_bad_base_without_finishing_and_retries_after_recovery() {
    let mut entry = entry();
    entry.admit(1, &action()).unwrap();
    entry.update(patch(0, 2, "publication won")).unwrap();
    let response = respond_request(&entry, 1, patch(1, 3, "response"));
    assert_eq!(
        entry.respond_update(response).unwrap_err(),
        "plugin_window_snapshot_base_mismatch"
    );
    assert!(!entry.slots[&1].responded);
    assert!(entry.slots[&1].channel.borrow().is_none());
    let response = respond_request(&entry, 1, patch(2, 3, "response"));
    entry.respond_update(response).unwrap();
    assert!(entry
        .update(patch(0, 1, "late publication"))
        .unwrap()
        .is_none());
    assert_eq!(entry.request.snapshot.state["draft"], "response");
    assert_eq!(
        entry
            .inspect_update(1, 0)
            .unwrap()
            .receipt
            .unwrap()
            .update
            .revision(),
        3
    );
    assert!(entry.inspect_update(1, 4).is_err());
}
#[test]
fn events_use_update_without_canonical_state_and_unchanged_ack_is_silent() {
    let mut entry = entry();
    let update = entry.update(patch(0, 1, "a")).unwrap().unwrap();
    let event = serde_json::to_value(entry.update_event(update)).unwrap();
    assert!(event.get("snapshot").is_none());
    assert_eq!(event["update"]["kind"], "patch");
    assert!(delta::bytes(&event) < 1024);
    entry.admit(1, &action()).unwrap();
    let response = respond_request(&entry, 1, Update::Unchanged { revision: 1 });
    assert!(entry.respond_update(response).unwrap().is_none());
    assert!(entry.update(patch(0, 1, "a")).unwrap().is_none());
}
#[test]
fn force_removal_notifies_waiter_but_does_not_expose_placeholder_as_snapshot() {
    let mut entry = entry();
    let (receiver, _) = entry.admit(1, &action()).unwrap();
    let id = entry.identity.window_id.clone();
    let mut registry = Registry::default();
    registry.entries.insert(id.clone(), entry);
    let removed = registry.remove(&id, "plugin_window_closed").unwrap();
    let receipt = receiver.borrow().clone().unwrap();
    assert!(receipt.unknown);
    assert_eq!(receipt.snapshot.state, Value::Null);
    assert!(registry.get_mut(&id).is_err());
    // The action command checks for a live canonical entry before conversion.
    assert!(registry.entries.get(&id).is_none());
    assert!(removed.slots.values().any(|slot| !slot.responded));
}
