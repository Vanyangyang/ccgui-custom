use super::*;
use serde_json::json;

fn fixture() -> (Loaded, super::super::review::Provenance) {
    let session = SessionRef {
        engine: "codex".into(),
        session_id: "synthetic".into(),
        workspace_path: "/synthetic-game".into(),
    };
    let rows = vec![
        Row {
            seq: 0,
            role: "user".into(),
            text: "旧决定：同一位修士重修。".into(),
            display_text: None,
        },
        Row {
            seq: 1,
            role: "assistant".into(),
            text: "建议保留资产关系并采用历史断片挑战作为可选玩法。".into(),
            display_text: None,
        },
        Row {
            seq: 2,
            role: "user".into(),
            text: "现在明确采用历史断片挑战，同时保留资产关系。".into(),
            display_text: None,
        },
        Row {
            seq: 3,
            role: "assistant".into(),
            text: "更晚的无关对话。".into(),
            display_text: None,
        },
    ];
    let p=serde_json::from_value(json!({"version":2,"scope":"game_project","hostProjectId":"project","memoryProjectId":"game",
        "source":{"kind":"conversation","id":"owned"},"sessionRef":session,"fromCursor":rows[0].cursor("synthetic",0),"nextCursor":rows[2].cursor("synthetic",0),
        "inputDigest":"a".repeat(64),"sourceDigest":"b".repeat(64),"partial":false,"model":MODEL,
        "evidence":[{"seq":2,"role":"user","quote":"现在明确采用历史断片挑战"}]})).unwrap();
    (
        Loaded {
            session,
            rows,
            later_pages: false,
            fence: "owned-source".into(),
            owner_fence: "owned-binding".into(),
            floor_seq: -1,
        },
        p,
    )
}
#[test]
fn historical_owned_range_survives_later_rows_but_not_rebinding() {
    let (loaded, p) = fixture();
    assert!(validate_review_selection(&loaded, &p).is_ok());
    let mut wrong = p.clone();
    wrong.session_ref.session_id = "foreign".into();
    assert!(validate_review_selection(&loaded, &wrong).is_err());
    let mut wrong = p.clone();
    wrong.session_ref.workspace_path = "/foreign".into();
    assert!(validate_review_selection(&loaded, &wrong).is_err());
    let mut wrong = p.clone();
    wrong.next_cursor.session_id = "foreign".into();
    assert!(validate_review_selection(&loaded, &wrong).is_err());
}
#[test]
fn forged_role_quote_cursor_and_failed_turn_fence_are_rejected() {
    let (mut loaded, p) = fixture();
    for variant in 0..5 {
        let mut wrong = p.clone();
        match variant {
            0 => wrong.evidence[0].role = "assistant".into(),
            1 => wrong.evidence[0].quote = "用户从未说过的决定".into(),
            2 => wrong.evidence[0].seq = 0,
            3 => wrong.next_cursor.row_digest = Some("f".repeat(64)),
            _ => wrong.from_cursor.as_mut().unwrap().row_digest = Some("f".repeat(64)),
        }
        assert!(
            validate_review_selection(&loaded, &wrong).is_err(),
            "variant {variant}"
        );
    }
    loaded.floor_seq = 2;
    assert!(validate_review_selection(&loaded, &p).is_err());
}
#[test]
fn unicode_partial_end_cannot_authorize_quote_outside_original_slice() {
    let (loaded, mut p) = fixture();
    p.next_cursor.offset = 2;
    assert!(validate_review_selection(&loaded, &p).is_err());
    p.evidence[0].quote = "现在".into();
    assert!(validate_review_selection(&loaded, &p).is_ok());
    p.next_cursor.offset = 1000;
    assert!(validate_review_selection(&loaded, &p).is_err());
}
#[test]
fn native_event_timestamp_and_full_original_row_are_required_not_import_time() {
    let (loaded, _) = fixture();
    let original = &loaded.rows[2];
    let mut native = crate::history::Message {
        seq: 19,
        role: "user".into(),
        text: original.text.clone(),
        ts: Some("2026-10-27T00:00:00Z".into()),
        path: None,
        args: None,
        result: None,
        todos: None,
        usage: None,
        model: None,
        effort: None,
        duration_ms: None,
        images: vec![],
    };
    let matched = review_native_match(original, &native, &SourceKind::Conversation).unwrap();
    assert_eq!(
        matched.0,
        crate::history::parse_ts_ms_str("2026-10-27T00:00:00Z").unwrap()
    );
    assert!(review_native_match(original, &native, &SourceKind::Coordination).is_none());
    native.seq = 2;
    assert!(review_native_match(original, &native, &SourceKind::Coordination).is_some());
    native.text = "采用历史断片挑战".into();
    assert!(review_native_match(original, &native, &SourceKind::Conversation).is_none());
    native.text = original.text.clone();
    native.ts = None;
    assert_eq!(
        review_native_match(original, &native, &SourceKind::Conversation)
            .unwrap()
            .0,
        0
    );
    native.role = "assistant".into();
    assert!(review_native_match(original, &native, &SourceKind::Conversation).is_none());
}
