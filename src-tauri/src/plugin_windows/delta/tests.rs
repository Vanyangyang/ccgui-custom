use super::*;
use serde_json::json;

fn patch(base: u64, revision: u64, changes: Value) -> Update {
    serde_json::from_value(
        json!({"kind":"patch","baseRevision":base,"revision":revision,"changes":changes}),
    )
    .unwrap()
}
fn fixture(state: Value) -> (Snapshot, DeltaState) {
    let delta = DeltaState::new(&state);
    (Snapshot { revision: 0, state }, delta)
}
#[test]
fn long_conversation_full_snapshot_and_patch_exceed_former_eight_mib_limit() {
    let state = json!({"messages":[{"role":"assistant","text":"x".repeat(10 * 1024 * 1024)}],"draft":"中文🌏"});
    let (mut snapshot, mut delta) = fixture(state);
    validate_full(&snapshot).unwrap();
    delta.apply(&mut snapshot, patch(0, 1, json!([{"op":"set","path":["draft"],"value":"继续👩🏽‍💻"}]))).unwrap();
    assert_eq!(snapshot.state["draft"], "继续👩🏽‍💻");
    assert_eq!(snapshot.state["messages"][0]["text"].as_str().unwrap().len(), 10 * 1024 * 1024);
    assert_eq!(delta.state_bytes, bytes(&snapshot.state));
}
#[test]
fn strict_wire_and_revision_path_depth_budgets() {
    for value in [
        json!({"kind":"unchanged","revision":0,"unknown":true}),
        json!({"kind":"patch","baseRevision":0,"revision":1,"changes":[{"op":"set","path":[],"value":0,"extra":0}]}),
        json!({"kind":"patch","baseRevision":0,"revision":1,"changes":[{"op":"set","path":[-1],"value":0}]}),
    ] {
        assert!(serde_json::from_value::<Update>(value).is_err());
    }
    assert!(Update::Unchanged {
        revision: MAX_REVISION + 1
    }
    .validate()
    .is_err());
    assert!(patch(1, 1, json!([])).validate().is_err());
    assert!(patch(0, 1, json!([{"op":"remove","path":[]}]))
        .validate()
        .is_err());
    assert!(patch(0, 1, json!([{"op":"remove","path":[0]}]))
        .validate()
        .is_err());
    assert!(
        patch(0, 1, json!([{"op":"set","path":vec!["x";65],"value":0}]))
            .validate()
            .is_err()
    );
    assert!(patch(
        0,
        1,
        json!([{"op":"set","path":vec!["x";64],"value":{"x":0}}])
    )
    .validate()
    .is_err());
    assert!(patch(
        0,
        1,
        json!([{"op":"set","path":[],"value":"x".repeat(MAX_PATCH)}])
    )
    .validate()
    .is_err());
    let changes: Vec<_> = (0..257)
        .map(|i| json!({"op":"set","path":[i.to_string()],"value":0}))
        .collect();
    assert!(patch(0, 1, json!(changes)).validate().is_err());
}
#[test]
fn atomic_rejection_on_invalid_late_path_conflict_or_size() {
    let (mut snapshot, mut delta) = fixture(json!({"a":0,"array":[0,1]}));
    let original = snapshot.clone();
    for changes in [
        json!([{"op":"set","path":["a"],"value":1},{"op":"set","path":["absent","x"],"value":1}]),
        json!([{"op":"set","path":["a"],"value":1},{"op":"set","path":["a"],"value":2}]),
        json!([{"op":"set","path":["array"],"value":[]},{"op":"set","path":["array",0],"value":2}]),
        json!([{"op":"set","path":["array",2],"value":2}]),
        json!([{"op":"set","path":["array","0"],"value":2}]),
        json!([{"op":"remove","path":["missing"]}]),
    ] {
        assert!(delta.apply(&mut snapshot, patch(0, 1, changes)).is_err());
        assert_eq!(snapshot, original);
        assert_eq!(delta.state_bytes, bytes(&snapshot.state));
    }
    let (mut snapshot, mut delta) = fixture(json!({"big":"x".repeat(MAX_STATE-32),"a":0}));
    let original = snapshot.clone();
    assert!(delta
        .apply(
            &mut snapshot,
            patch(
                0,
                1,
                json!([{"op":"set","path":["a"],"value":"x".repeat(64)}])
            )
        )
        .is_err());
    assert_eq!(snapshot, original);
}
#[test]
fn byte_count_matches_serialization_across_object_membership_and_unicode() {
    let (mut snapshot, mut delta) = fixture(json!({"obj":{},"array":["初",0],"__proto__":{"x":0}}));
    for (i,changes) in [
        json!([{"op":"set","path":["obj","a"],"value":"中文🧑‍💻"},{"op":"set","path":["obj","b"],"value":"\n\\\""}]),
        json!([{"op":"remove","path":["obj","a"]},{"op":"remove","path":["obj","b"]}]),
        json!([{"op":"set","path":["obj","a"],"value":1}]),
        json!([{"op":"remove","path":["obj","a"]},{"op":"set","path":["obj","b"],"value":2}]),
        json!([{"op":"set","path":["array",0],"value":"😊"},{"op":"set","path":["__proto__","x"],"value":{"constructor":true}}]),
        json!([{"op":"set","path":[],"value":["root",{},null]}]),
    ].into_iter().enumerate() {
        delta.apply(&mut snapshot,patch(i as u64,i as u64+1,changes)).unwrap();
        assert_eq!(delta.state_bytes,bytes(&snapshot.state),"step {i}");
    }
    // Deterministic property sweep with shared parents and mixed insertion/removal.
    let (mut snapshot, mut delta) = fixture(json!({}));
    for revision in 1..=200 {
        let key = format!("key{}", revision % 11);
        let change = if revision % 3 == 0 && snapshot.state.get(&key).is_some() {
            json!({"op":"remove","path":[key]})
        } else {
            json!({"op":"set","path":[key],"value":"汉😊".repeat(revision as usize % 13)})
        };
        delta
            .apply(
                &mut snapshot,
                patch(revision - 1, revision, json!([change])),
            )
            .unwrap();
        assert_eq!(delta.state_bytes, bytes(&snapshot.state));
    }
}
#[test]
fn stale_shape_validation_duplicate_effects_and_exact_base() {
    let (mut snapshot, mut delta) = fixture(json!({"a":0,"gone":1}));
    let update = patch(
        0,
        2,
        json!([{"op":"set","path":["a"],"value":2},{"op":"remove","path":["gone"]}]),
    );
    assert!(delta
        .apply(&mut snapshot, update.clone())
        .unwrap()
        .is_some());
    assert!(delta.apply(&mut snapshot, update).unwrap().is_none());
    assert_eq!(
        delta
            .apply(
                &mut snapshot,
                patch(0, 2, json!([{"op":"set","path":["a"],"value":1}]))
            )
            .unwrap_err(),
        CONFLICT
    );
    assert_eq!(
        delta
            .apply(&mut snapshot, patch(0, 3, json!([])))
            .unwrap_err(),
        BASE
    );
    assert!(delta
        .apply(
            &mut snapshot,
            patch(0, 1, json!([{"op":"remove","path":[]}]))
        )
        .is_err());
    assert!(delta
        .apply(
            &mut snapshot,
            patch(0, 1, json!([{"op":"set","path":["a"],"value":1}]))
        )
        .unwrap()
        .is_none());
    assert!(delta
        .apply(&mut snapshot, Update::Unchanged { revision: 1 })
        .unwrap()
        .is_none());
    assert!(delta
        .apply(&mut snapshot, Update::Unchanged { revision: 3 })
        .is_err());
    assert!(delta
        .apply(
            &mut snapshot,
            Update::Full {
                snapshot: Snapshot {
                    revision: 2,
                    state: json!({})
                }
            }
        )
        .is_err());
    assert_eq!(snapshot.state, json!({"a":2}));
}
#[test]
fn recovery_merges_ancestors_descendants_and_keeps_log_bounded() {
    let (mut snapshot, mut delta) = fixture(json!({"a":{"x":0},"b":0}));
    for (base, changes) in [
        (0, json!([{"op":"set","path":["a"],"value":{"x":1,"y":0}}])),
        (1, json!([{"op":"set","path":["a","x"],"value":2}])),
        (
            2,
            json!([{"op":"remove","path":["a","y"]},{"op":"set","path":["b"],"value":1}]),
        ),
    ] {
        delta
            .apply(&mut snapshot, patch(base, base + 1, changes))
            .unwrap();
    }
    let merged = delta.since(&snapshot, 0).unwrap();
    assert_eq!(
        merged,
        patch(
            0,
            3,
            json!([{"op":"set","path":["a"],"value":{"x":2}},{"op":"set","path":["b"],"value":1}])
        )
    );
    let (mut child, mut child_delta) = fixture(json!({"a":{"x":0},"b":0}));
    child_delta.apply(&mut child, merged).unwrap();
    assert_eq!(child, snapshot);
    assert!(matches!(
        delta.since(&snapshot, 3).unwrap(),
        Update::Unchanged { .. }
    ));
    assert!(delta.since(&snapshot, 4).is_err());
    for revision in 4..40 {
        delta
            .apply(
                &mut snapshot,
                patch(
                    revision - 1,
                    revision,
                    json!([{"op":"set","path":["b"],"value":revision}]),
                ),
            )
            .unwrap();
    }
    assert_eq!(delta.log.len(), 32);
    assert!(delta.log_bytes <= MAX_LOG);
    assert!(matches!(
        delta.since(&snapshot, 0).unwrap(),
        Update::Full { .. }
    ));
    delta
        .apply(
            &mut snapshot,
            Update::Full {
                snapshot: Snapshot {
                    revision: 40,
                    state: json!({"x":1}),
                },
            },
        )
        .unwrap();
    assert!(delta.log.is_empty());
    assert!(matches!(
        delta.since(&snapshot, 39).unwrap(),
        Update::Full { .. }
    ));
}
#[test]
fn patch_preserves_unaffected_history_allocation_and_suppresses_duplicate_events() {
    let (mut snapshot, mut delta) = fixture(json!({"history":"x".repeat(4*1024*1024),"draft":""}));
    let address = snapshot.state["history"].as_str().unwrap().as_ptr();
    for revision in 1..=100 {
        let update = patch(
            revision - 1,
            revision,
            json!([{"op":"set","path":["draft"],"value":revision.to_string()}]),
        );
        assert!(delta
            .apply(&mut snapshot, update.clone())
            .unwrap()
            .is_some());
        assert!(delta.apply(&mut snapshot, update).unwrap().is_none());
        assert_eq!(
            snapshot.state["history"].as_str().unwrap().as_ptr(),
            address
        );
    }
    assert!(delta
        .apply(
            &mut snapshot,
            patch(
                100,
                101,
                json!([{"op":"set","path":["draft"],"value":"100"}])
            )
        )
        .unwrap()
        .is_none());
    assert!(delta.log_bytes < 8192);
}
#[test]
fn full_size_boundary_log_byte_limit_and_oversized_merge_fallback() {
    let exact = Snapshot {
        revision: 0,
        state: json!("x".repeat(MAX_STATE - 2)),
    };
    assert_eq!(bytes(&exact.state), MAX_STATE);
    assert!(validate_full(&exact).is_ok());
    assert!(validate_full(&Snapshot {
        revision: 0,
        state: json!("x".repeat(MAX_STATE - 1))
    })
    .is_err());
    let (mut snapshot, mut delta) = fixture(json!({"object":{}}));
    for revision in 1..=10 {
        let path = if revision == 1 {
            json!(["object"])
        } else {
            json!(["object", format!("k{revision}")])
        };
        let value = if revision == 1 {
            json!({"k1":"x".repeat(200_000)})
        } else {
            json!("x".repeat(200_000))
        };
        delta
            .apply(
                &mut snapshot,
                patch(
                    revision - 1,
                    revision,
                    json!([{"op":"set","path":path,"value":value}]),
                ),
            )
            .unwrap();
        assert!(delta.log_bytes <= MAX_LOG);
        if revision == 2 {
            assert!(matches!(
                delta.since(&snapshot, 0).unwrap(),
                Update::Full { .. }
            ));
        }
    }
    assert!(delta.log.len() < 10);
    assert_eq!(delta.state_bytes, bytes(&snapshot.state));
    assert!(matches!(
        delta.since(&snapshot, 0).unwrap(),
        Update::Full { .. }
    ));
}

#[test]
fn outgoing_numeric_merge_uses_js_budget_before_cloning_subtrees() {
    let values = vec![json!(0.000001); 20_000];
    let (mut snapshot, mut delta) = fixture(json!({
        "history": "x".repeat(500_000), "a": [], "b": [],
    }));
    let history_address = snapshot.state["history"].as_str().unwrap().as_ptr();
    for (base, key) in [(0, "a"), (1, "b")] {
        let update = patch(
            base,
            base + 1,
            json!([{"op":"set","path":[key],"value":values}]),
        );
        assert!(bytes(&update) < MAX_PATCH);
        assert!(delta.apply(&mut snapshot, update).unwrap().is_some());
        assert_eq!(
            snapshot.state["history"].as_str().unwrap().as_ptr(),
            history_address
        );
    }
    // Native scientific notation fits, but JS spells each 1e-6 as 0.000001:
    // two individual JS patches fit (~180 KiB), their merge does not (~360 KiB).
    let native_merge = patch(
        0,
        2,
        json!([
            {"op":"set","path":["a"],"value":values},
            {"op":"set","path":["b"],"value":values},
        ]),
    );
    assert!(bytes(&native_merge) < MAX_PATCH);
    let recovered = delta.since(&snapshot, 0).unwrap();
    match recovered {
        Update::Full {
            snapshot: recovered,
        } => assert_eq!(recovered, snapshot),
        other => panic!("numeric merge must recover with full, got {other:?}"),
    }
    assert_eq!(snapshot.revision, 2);
    assert_eq!(snapshot.state["a"], json!(values));
    assert_eq!(snapshot.state["b"], json!(values));
    assert_eq!(delta.state_bytes, bytes(&snapshot.state));
}

#[test]
fn outgoing_draft_merge_stays_a_small_patch_with_large_history() {
    let (mut snapshot, mut delta) = fixture(json!({
        "history": "x".repeat(500_000), "draft": "", "removed": true,
    }));
    delta
        .apply(
            &mut snapshot,
            patch(
                0,
                1,
                json!([
                    {"op":"set","path":["draft"],"value":"输入😊"},
                    {"op":"remove","path":["removed"]},
                ]),
            ),
        )
        .unwrap();
    delta
        .apply(
            &mut snapshot,
            patch(
                1,
                2,
                json!([
                    {"op":"set","path":["draft"],"value":"输入😊继续"},
                ]),
            ),
        )
        .unwrap();
    let update = delta.since(&snapshot, 0).unwrap();
    assert!(matches!(
        update,
        Update::Patch {
            base_revision: 0,
            revision: 2,
            ..
        }
    ));
    assert!(bytes(&update) < 256);
    assert_eq!(
        update,
        patch(
            0,
            2,
            json!([
                {"op":"set","path":["draft"],"value":"输入😊继续"},
                {"op":"remove","path":["removed"]},
            ])
        )
    );
}
