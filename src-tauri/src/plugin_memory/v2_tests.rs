//! Synthetic fixtures only: no user storage, provider configuration or network.
use super::*;

fn request() -> ExtractRequest {
    serde_json::from_value(json!({"requestId":"fixture", "projectId":"game",
        "source":{"kind":"conversation","id":"chat"},"formatVersion":2,
        "expectedSourceDigest":"0".repeat(64)}))
    .unwrap()
}
fn rows() -> Vec<Row> {
    vec![
        Row {
            seq: 0,
            role: "user".into(),
            text: "old cancelled request".into(),
            display_text: None,
        },
        Row {
            seq: 1,
            role: "assistant".into(),
            text: "unfinished answer".into(),
            display_text: None,
        },
        Row {
            seq: 2,
            role: "user".into(),
            text: "现在改为三条生命😀".into(),
            display_text: None,
        },
        Row {
            seq: 3,
            role: "assistant".into(),
            text: "好的，三条生命。".into(),
            display_text: None,
        },
    ]
}
fn loaded(rows: Vec<Row>) -> source::Loaded {
    source::Loaded {
        session: SessionRef {
            engine: "codex".into(),
            session_id: "synthetic".into(),
            workspace_path: "/fixture-game".into(),
        },
        rows,
        later_pages: false,
        fence: "synthetic-native-binding".into(),
        floor_seq: 1,
    }
}
fn selected(request: &ExtractRequest) -> Selected {
    select_loaded(loaded(rows()), &request.source_request()).unwrap()
}
fn old_context() -> Context {
    serde_json::from_value(
        json!({"id":"old","revision":7,"kind":"decision","title":"生命数",
        "text":"保留五条生命", "conditions":["简单模式"],"authority":"assistant_inferred",
        "updatedAt":"2026-10-25T00:00:00Z"}),
    )
    .unwrap()
}
fn note() -> Value {
    json!({"notes":[{"kind":"decision","title":"三条生命","text":"简单模式改为三条生命",
        "conditions":["简单模式"],"relatedIds":["old"],
        "evidence":[{"seq":2,"role":"user","quote":"现在改为三条生命😀"}],
        "relations":[{"kind":"supersedes","targetId":"old","targetRevision":7,"reason":"用户明确更改生命数"}]}]})
}
fn validate(value: &Value, context: &[Context]) -> Result<Vec<Note>, String> {
    validate_output_version(
        &value.to_string(),
        &selected(&request()).selection.slices,
        context,
        2,
    )
}

#[test]
fn prepare_and_provider_share_exact_selected_batch_and_response_contract() {
    let req = request();
    let selection = selected(&req);
    let response = prepared_response(&selection, &req.source_request());
    let prepared = provider_input(selection, &req);
    assert_eq!(
        prepared.input["sourceRows"],
        json!([
            {"seq":2,"role":"user","text":"现在改为三条生命😀"},
            {"seq":3,"role":"assistant","text":"好的，三条生命。"}
        ])
    );
    assert_eq!(
        response,
        json!({"status":"ready","query":"现在改为三条生命😀\n好的，三条生命。",
        "sourceDigest":prepared.source_digest,"fromCursor":null,"nextCursor":prepared.selection.next,
        "sessionRef":prepared.loaded.session,"partial":true,"hasMore":false})
    );
    assert_eq!(response["nextCursor"], prepared.input["nextCursor"]);
    assert_eq!(prepared.input["partialInput"], response["partial"]);
    assert_eq!(prepared.source_digest.len(), 64);
}

#[test]
fn source_digest_ignores_context_and_format_but_provider_digest_covers_them() {
    let mut req = request();
    let a = provider_input(selected(&req), &req);
    req.context = vec![old_context()];
    let b = provider_input(selected(&req), &req);
    assert_eq!(a.source_digest, b.source_digest);
    assert_ne!(a.digest, b.digest);
    req.format_version = None;
    let c = provider_input(selected(&req), &req);
    assert_eq!(b.source_digest, c.source_digest);
    assert_ne!(b.digest, c.digest);
    assert!(c.input.get("formatVersion").is_none());
}

#[test]
fn digest_covers_original_text_cursors_scope_binding_partial_and_pagination() {
    let req = request();
    let original = selected(&req).source_digest;
    for variant in 0..7 {
        let mut source = loaded(rows());
        let mut req = request().source_request();
        match variant {
            0 => source.rows[2].text.push('!'),
            1 => req.cursor = Some(source.rows[1].cursor("synthetic", 0)),
            2 => req.project_id = "other-game".into(),
            3 => req.source.id = "other-chat".into(),
            4 => source.fence = "rebound-native-member".into(),
            5 => source.floor_seq = -1,
            6 => source.later_pages = true,
            _ => unreachable!(),
        }
        assert_ne!(
            original,
            select_loaded(source, &req).unwrap().source_digest,
            "variant {variant}"
        );
    }
    let mut source = loaded(rows());
    source.rows[2].display_text = Some("相同展示".into());
    let a = select_loaded(source, &req.source_request())
        .unwrap()
        .source_digest;
    let mut source = loaded(rows());
    source.rows[2].display_text = Some("相同展示".into());
    source.rows[2].text.push('!');
    // Native fence carries original records even when the displayed slice is unchanged.
    source.fence = "changed-original-proof".into();
    assert_ne!(
        a,
        select_loaded(source, &req.source_request())
            .unwrap()
            .source_digest
    );
}

#[test]
fn query_unicode_recent_user_priority_and_bounded_selection_empty_are_deterministic() {
    let slices = vec![
        Slice {
            seq: 0,
            role: "user".into(),
            text: "older".into(),
        },
        Slice {
            seq: 1,
            role: "user".into(),
            text: "😀中文".repeat(400),
        },
        Slice {
            seq: 2,
            role: "assistant".into(),
            text: "assistant".into(),
        },
    ];
    let query = query_hint(&slices);
    assert_eq!(query.chars().count(), 512);
    assert_eq!(query, slices[1].text.chars().take(512).collect::<String>());
    assert_eq!(query_hint(&[]), "");
    let mut source = loaded(vec![Row {
        seq: 2,
        role: "user".into(),
        text: "😀中".repeat(SOURCE_BYTES),
        display_text: None,
    }]);
    source.floor_seq = -1;
    let a = select_loaded(source, &request().source_request()).unwrap();
    assert!(a.selection.partial && a.selection.has_more);
    assert!(a.selection.slices[0].text.len() <= SOURCE_BYTES);
    assert_eq!(query_hint(&a.selection.slices).chars().count(), 512);
    let empty = select_loaded(loaded(vec![]), &request().source_request()).unwrap();
    let response = prepared_response(&empty, &request().source_request());
    assert_eq!(response["query"], "");
    assert_eq!(response["nextCursor"]["seq"], -1);
    assert_eq!(response["hasMore"], false);
    let many = (0..30)
        .map(|seq| Row {
            seq,
            role: "user".into(),
            text: "x".into(),
            display_text: None,
        })
        .collect();
    let mut source = loaded(many);
    source.floor_seq = -1;
    let selected = select_loaded(source, &request().source_request()).unwrap();
    assert_eq!(selected.selection.slices.len(), 24);
    assert!(selected.selection.has_more);
}

#[test]
fn format_digest_validation_and_rewrite_dispositions_do_not_offer_advance() {
    let mut req = request();
    assert!(req.validate_version().is_ok());
    let prepared = provider_input(selected(&req), &req);
    assert!(!source_matches(&prepared, &req));
    req.expected_source_digest = Some(prepared.source_digest.to_uppercase());
    assert!(source_matches(&prepared, &req));
    for invalid in ["a".repeat(63), "x".repeat(64), "😀".repeat(16)] {
        req.expected_source_digest = Some(invalid);
        assert!(req.validate_version().is_err());
    }
    req.expected_source_digest = None;
    assert!(req.validate_version().is_err());
    req.format_version = Some(3);
    assert!(req.validate_version().is_err());
    req.format_version = None;
    assert!(req.validate_version().is_ok());
    assert!(source_matches(&prepared, &req));
    assert_eq!(
        extract_source_error("cursor_history_changed", &req)["status"],
        "invalid_source"
    );
    let response = extract_source_error("cursor_history_changed", &request());
    assert_eq!(
        response,
        json!({"status":"deferred","reason":"source_changed","retryAfterMs":60000})
    );
    assert!(response.get("cursor").is_none() && response.get("batch").is_none());
}

#[test]
fn v2_exact_relation_and_evidence_with_v1_shape_preserved() {
    let context = vec![old_context()];
    let valid = note();
    let v2 = validate(&valid, &context).unwrap();
    assert_eq!(v2[0].relations.as_ref().unwrap().len(), 1);
    let mut expected = valid["notes"].clone();
    expected[0].as_object_mut().unwrap().remove("relations");
    let v1 = validate_output(
        &valid.to_string(),
        &selected(&request()).selection.slices,
        &context,
    )
    .unwrap();
    assert_eq!(serde_json::to_value(v1).unwrap(), expected);
    let mut legacy = valid.clone();
    legacy["notes"][0]
        .as_object_mut()
        .unwrap()
        .remove("relations");
    assert!(validate(&legacy, &context).is_err());
    assert!(validate_output(
        &legacy.to_string(),
        &selected(&request()).selection.slices,
        &context
    )
    .is_ok());
    let mut empty = valid.clone();
    empty["notes"][0]["relations"] = json!([]);
    assert!(validate(&empty, &context).is_ok());
    assert!(validate(&json!({"notes":[]}), &context).is_ok());
}

#[test]
fn relations_reject_foreign_revision_duplicate_self_id_and_shape_abuse() {
    let context = vec![old_context()];
    for (field, value) in [
        ("targetId", json!("foreign")),
        ("targetRevision", json!(8)),
        ("targetRevision", json!(0)),
        ("targetRevision", json!(-1)),
        ("targetRevision", json!(1.5)),
        ("reason", json!("😀".repeat(301))),
        ("reason", json!("")),
        ("kind", json!("deletes")),
    ] {
        let mut forged = note();
        forged["notes"][0]["relations"][0][field] = value;
        assert!(validate(&forged, &context).is_err(), "{field}");
    }
    let mut duplicate = note();
    let relation = duplicate["notes"][0]["relations"][0].clone();
    duplicate["notes"][0]["relations"] = json!([relation, relation]);
    assert!(validate(&duplicate, &context).is_err());
    duplicate["notes"][0]["relations"] = json!([relation, relation, relation, relation]);
    assert!(validate(&duplicate, &context).is_err());
    let mut self_id = note();
    self_id["notes"][0]["id"] = "old".into();
    assert!(validate(&self_id, &context).is_err());
    let mut authority = note();
    authority["notes"][0]["authority"] = "user_confirmed".into();
    assert!(validate(&authority, &context).is_err());
    let mut max = note();
    max["notes"][0]["relations"][0]["reason"] = "😀".repeat(300).into();
    assert!(validate(&max, &context).is_ok());
}

#[test]
fn supersedes_requires_matching_decisions_conditions_native_user_and_unprotected_authority() {
    for authority in ["user_confirmed", "user_recorded"] {
        let mut target = old_context();
        target.authority = Some(authority.into());
        assert!(validate(&note(), &[target.clone()]).is_err());
        let mut conflict = note();
        conflict["notes"][0]["relations"][0]["kind"] = "conflicts".into();
        assert!(validate(&conflict, &[target]).is_ok());
    }
    let mut target = old_context();
    target.kind = "idea".into();
    assert!(validate(&note(), &[target]).is_err());
    let mut target = old_context();
    target.conditions = vec!["困难模式".into()];
    assert!(validate(&note(), &[target]).is_err());
    let mut forged = note();
    forged["notes"][0]["kind"] = "idea".into();
    assert!(validate(&forged, &[old_context()]).is_err());
    for evidence in [
        json!({"seq":3,"role":"user","quote":"好的，三条生命。"}),
        json!({"seq":2,"role":"user","quote":"用户已经批准"}),
        json!({"seq":0,"role":"user","quote":"old cancelled request"}),
        json!({"seq":3,"role":"assistant","quote":"好的，三条生命。"}),
    ] {
        let mut forged = note();
        forged["notes"][0]["evidence"] = json!([evidence]);
        assert!(validate(&forged, &[old_context()]).is_err());
    }
    let mut target = old_context();
    target.conditions = vec!["简单模式".into(), "战斗内".into()];
    let mut reordered = note();
    reordered["notes"][0]["conditions"] = json!(["战斗内", "简单模式"]);
    assert!(validate(&reordered, &[target]).is_ok());
}

#[test]
fn optional_context_metadata_is_bounded_with_legacy_compatibility() {
    let mut context = old_context();
    context.authority = None;
    context.updated_at = None;
    assert!(validate_context(&[context.clone()]).is_ok());
    let value = serde_json::to_value(&context).unwrap();
    assert!(value.get("authority").is_none() && value.get("updatedAt").is_none());
    context.authority = Some("a".repeat(65));
    assert!(validate_context(&[context.clone()]).is_err());
    context.authority = Some("assistant_inferred".into());
    context.updated_at = Some("a".repeat(65));
    assert!(validate_context(&[context.clone()]).is_err());
    context.updated_at = Some("2026-10-25".into());
    assert!(validate_context(&vec![context.clone(); 7]).is_err());
    let contexts: Vec<_> = (0..6)
        .map(|n| {
            let mut c = context.clone();
            c.id = n.to_string();
            c.text = "中".repeat(1600);
            c
        })
        .collect();
    assert_eq!(validate_context(&contexts).unwrap_err(), "context_limit");
}

#[tokio::test]
async fn prepare_read_foreground_preemption_rejects_late_results_without_model_admission() {
    let gate = Arc::new(gate::Gate::new());
    let registry = crate::engine::ProcessRegistry::default();
    let epoch = gate.read_epoch(|| false, false).unwrap();
    let guard = gate.foreground();
    drop(guard);
    assert!(cancellable_read(&gate, epoch, &registry, async {
        panic!("stale read must not poll")
    })
    .await
    .is_err());
    let epoch = gate.read_epoch(|| false, false).unwrap();
    let late = async {
        let guard = gate.foreground();
        drop(guard);
        "late"
    };
    // A result completed in the same poll as foreground start is still stale.
    assert!(cancellable_read(&gate, epoch, &registry, late)
        .await
        .is_err());
    assert!(!gate.valid(epoch));
}
