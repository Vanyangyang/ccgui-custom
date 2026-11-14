//! Pure synthetic source/provider fixtures. Never uses provider configuration.
use super::*;

fn record(id: &str) -> Record {
    serde_json::from_value(json!({"id":id,"revision":1,"kind":"decision","title":id,
        "text":"原先采用同一位修士重修。","conditions":["游戏内"],"authority":"user_recorded",
        "source":{"kind":"manual_note","role":"user","complete":true,"text":"untrusted"}}))
    .unwrap()
}
fn request() -> Request {
    Request {
        request_id: "request".into(),
        project_id: "game".into(),
        batch_id: "batch".into(),
        root: record("new"),
        candidates: vec![record("old")],
        reconcile_only: false,
    }
}
fn evidence(seq: i64, role: &str, quote: &str, time: i64) -> VerifiedEvidence {
    VerifiedEvidence {
        seq,
        role: role.into(),
        quote: quote.into(),
        event_ms: Some(time),
        context: quote.into(),
        previous_seq: None,
    }
}
fn proofs() -> Vec<Proof> {
    vec![
        Proof {
            evidence: vec![evidence(
                9,
                "user",
                "现在明确改用历史断片，不再采用同一位修士重修。",
                200,
            )],
            fence: "new-native".into(),
            reason: None,
            replay: None,
        },
        Proof {
            evidence: vec![evidence(1, "user", "原先采用同一位修士重修。", 100)],
            fence: "old-native".into(),
            reason: None,
            replay: None,
        },
    ]
}
fn output() -> Value {
    let p = proofs();
    json!({"judgments":[
        {"targetId":"new","targetRevision":1,"outcome":"keep","reason":"Current decision","successorId":null,"scope":"same","evidence":[{"recordId":"new","quote":p[0].evidence[0].quote}],"dependsOn":[],"preserve":[]},
        {"targetId":"old","targetRevision":1,"outcome":"superseded","reason":"Explicit later user reversal","successorId":"new","scope":"same","evidence":[{"recordId":"new","quote":p[0].evidence[0].quote},{"recordId":"old","quote":p[1].evidence[0].quote}],"dependsOn":[],"preserve":[]}
    ]})
}
fn validate(v: &Value, p: &[Proof]) -> Result<Vec<Judgment>, String> {
    validate_output(&v.to_string(), &request(), p)
}

#[test]
fn later_native_user_decision_can_replace_user_recorded_without_authority_upgrade() {
    let result = validate(&output(), &proofs()).unwrap();
    assert_eq!(result[1].outcome, "superseded");
    assert_eq!(request().candidates[0].authority, "user_recorded");
    assert!(input(&request(), &proofs())
        .to_string()
        .find("authority")
        .is_none());
}

#[test]
fn explicit_condition_refinement_is_allowed_only_when_all_changed_conditions_are_examined() {
    let mut r = request();
    r.candidates[0].conditions = vec!["游戏内全部轮回环节".into()];
    r.root.conditions = vec!["仅历史断片挑战点".into()];
    let mut p = proofs();
    p[0].evidence[0] = evidence(
        9,
        "user",
        "现在把游戏内全部轮回环节改为仅历史断片挑战点，主角不再降阶重修。",
        200,
    );
    let mut v = output();
    v["judgments"][0]["evidence"][0]["quote"] = p[0].evidence[0].quote.clone().into();
    v["judgments"][1]["evidence"][0]["quote"] = p[0].evidence[0].quote.clone().into();
    assert_eq!(
        validate_output(&v.to_string(), &r, &p).unwrap()[1].outcome,
        "needs_review"
    );
    v["judgments"][1]["evidence"]
        .as_array_mut()
        .unwrap()
        .extend([
            json!({"recordId":"old","quote":r.candidates[0].conditions[0]}),
            json!({"recordId":"new","quote":r.root.conditions[0]}),
        ]);
    assert_eq!(
        validate_output(&v.to_string(), &r, &p).unwrap()[1].outcome,
        "superseded"
    );
    v["judgments"][1]["scope"] = "disjoint".into();
    assert_eq!(
        validate_output(&v.to_string(), &r, &p).unwrap()[1].outcome,
        "needs_review"
    );
}
#[test]
fn late_import_and_unknown_original_time_never_win() {
    for time in [Some(99), Some(100), None] {
        let mut p = proofs();
        p[0].evidence[0].event_ms = time;
        let result = validate(&output(), &p).unwrap();
        assert_eq!(result[1].outcome, "needs_review");
        assert!(result[1].successor_id.is_null());
    }
    let mut value = serde_json::to_value(request()).unwrap();
    value["root"]["createdAt"] = "2099".into();
    assert!(serde_json::from_value::<Request>(value).is_err());
}
#[test]
fn unknown_source_never_kept_or_used_as_successor() {
    let mut p = proofs();
    p[0] = Proof::unknown("source_provenance_unavailable");
    let mut v = output();
    v["judgments"][0]["evidence"] = json!([]);
    v["judgments"][1]["evidence"][0]["quote"] = request().root.text.into();
    let result = validate(&v, &p).unwrap();
    assert!(result.iter().all(|j| j.outcome == "needs_review"));
    assert!(result
        .iter()
        .all(|j| j.depends_on.is_empty() && j.preserve.is_empty()));
}
#[test]
fn assistant_claim_of_user_approval_is_not_a_user_decision() {
    let mut p = proofs();
    p[0].evidence[0].role = "assistant".into();
    assert_eq!(validate(&output(), &p).unwrap()[1].outcome, "needs_review");
}
#[test]
fn short_approval_requires_unique_preceding_proposal_and_native_causal_time() {
    let mut p = proofs();
    p[0].evidence[0] = evidence(9, "user", "好", 200);
    let mut v = output();
    v["judgments"][1]["evidence"][0]["quote"] = "好".into();
    v["judgments"][0]["evidence"][0]["quote"] = "好".into();
    assert_eq!(validate(&v, &p).unwrap()[1].outcome, "needs_review");
    let proposal = evidence(
        8,
        "assistant",
        "建议使用可选的历史断片挑战，保留现有资产关系和等级。",
        150,
    );
    p[0].evidence[0].previous_seq = Some(8);
    p[0].evidence.push(proposal.clone());
    v["judgments"][1]["evidence"]
        .as_array_mut()
        .unwrap()
        .push(json!({"recordId":"new","quote":proposal.quote}));
    assert_eq!(validate(&v, &p).unwrap()[1].outcome, "superseded");
    p[0].evidence[0].previous_seq = Some(7);
    assert_eq!(validate(&v, &p).unwrap()[1].outcome, "needs_review");
    p[0].evidence[0].previous_seq = Some(8);
    p[0].evidence[1].event_ms = Some(201);
    assert_eq!(validate(&v, &p).unwrap()[1].outcome, "needs_review");
}
#[test]
fn short_refusal_ambiguity_or_question_never_adopts_the_adjacent_proposal() {
    let proposal = evidence(
        8,
        "assistant",
        "建议使用可选的历史断片挑战，保留现有资产关系和等级。",
        150,
    );
    for text in [
        "不行",
        "别改",
        "不同意",
        "收到",
        "嗯",
        "再看看",
        "好？",
        "我不同意这个方案",
        "do not change",
        "I disagree",
    ] {
        let mut user = evidence(9, "user", text, 200);
        user.previous_seq = Some(8);
        assert!(
            !explicit_decision(&user, &[&user, &proposal]),
            "refusal/ambiguity: {text}"
        );
    }
    for text in ["好", "行", "同意", "按推荐方案", "OK", "sounds good"] {
        let mut user = evidence(9, "user", text, 200);
        user.previous_seq = Some(8);
        assert!(
            explicit_decision(&user, &[&user, &proposal]),
            "affirmative: {text}"
        );
        assert!(
            !explicit_decision(&user, &[&user]),
            "approval requires its proposal"
        );
    }
    let user = evidence(
        9,
        "user",
        "不再采用同一位修士重修的旧设计，现在明确改用历史断片挑战。",
        200,
    );
    assert!(
        explicit_decision(&user, &[&user]),
        "long explicit reversal can negate the old design"
    );
}
#[test]
fn ai_paraphrase_body_proves_coverage_but_cannot_replace_native_user_authority() {
    let mut request = request();
    request.root.text = "轮回改为历史片段中的挑战，不再由同一角色进行重修。".into();
    request.candidates[0].text = "轮回方案以角色自身的再次修行为载体。".into();
    let mut v = output();
    assert_eq!(
        validate_output(&v.to_string(), &request, &proofs()).unwrap()[1].outcome,
        "needs_review"
    );
    v["judgments"][1]["evidence"]
        .as_array_mut()
        .unwrap()
        .push(json!({"recordId":"old","quote":request.candidates[0].text}));
    assert_eq!(
        validate_output(&v.to_string(), &request, &proofs()).unwrap()[1].outcome,
        "superseded"
    );
    // A body quotation is not a user quote, even when it claims user approval.
    request.root.text = "用户已经确认更换轮回设计。".into();
    v["judgments"][1]["evidence"][0]["quote"] = request.root.text.clone().into();
    assert_eq!(
        validate_output(&v.to_string(), &request, &proofs()).unwrap()[1].outcome,
        "needs_review"
    );
    let mut p = proofs();
    p[0].evidence[0].role = "assistant".into();
    let mut trusted_body = output();
    trusted_body["judgments"][1]["evidence"]
        .as_array_mut()
        .unwrap()
        .push(json!({"recordId":"old","quote":request.candidates[0].text}));
    assert_eq!(
        validate_output(&trusted_body.to_string(), &request, &p).unwrap()[1].outcome,
        "needs_review"
    );
}
#[test]
fn partial_paraphrase_citation_must_not_erase_an_uncited_valid_constraint() {
    let mut request = request();
    request.candidates[0].text =
        "轮回方案以角色自身的再次修行为载体。仍然拒绝根基固化解释。".into();
    let mut v = output();
    v["judgments"][1]["evidence"]
        .as_array_mut()
        .unwrap()
        .push(json!({"recordId":"old","quote":"轮回方案以角色自身的再次修行为载体。"}));
    assert_eq!(
        validate_output(&v.to_string(), &request, &proofs()).unwrap()[1].outcome,
        "needs_review"
    );
    v["judgments"][1]["scope"] = "overlap".into();
    v["judgments"][1]["preserve"] =
        json!([{"title":"old","text":"仍然拒绝根基固化解释。","conditions":["游戏内"]}]);
    assert_eq!(
        validate_output(&v.to_string(), &request, &proofs()).unwrap()[1].outcome,
        "superseded"
    );
}
#[test]
fn state_defaults_active_and_withdrawal_is_sent_but_cannot_support_current() {
    let mut request = request();
    assert!(request.root.state.is_active());
    assert_eq!(input(&request, &proofs())["records"][0]["state"], "active");
    request.root.state = RecordState::Withdrawn;
    assert_eq!(
        input(&request, &proofs())["records"][0]["state"],
        "withdrawn"
    );
    let result = validate_output(&output().to_string(), &request, &proofs()).unwrap();
    assert!(result.iter().all(|j| j.outcome == "needs_review"));
    for invalid in [json!(null), json!("deleted"), json!(false)] {
        let mut v = serde_json::to_value(&request).unwrap();
        v["root"]["state"] = invalid;
        assert!(serde_json::from_value::<Request>(v).is_err());
    }
}
#[test]
fn withdrawn_premise_and_support_quote_cannot_keep_an_active_target() {
    let mut request = request();
    request.candidates[0].state = RecordState::Withdrawn;
    let mut v = output();
    v["judgments"][1]["outcome"] = "needs_review".into();
    v["judgments"][1]["successorId"] = Value::Null;
    v["judgments"][0]["reason"] = "Requires old as the necessary premise".into();
    v["judgments"][0]["evidence"]
        .as_array_mut()
        .unwrap()
        .push(json!({"recordId":"old","quote":proofs()[1].evidence[0].quote}));
    for dependencies in [json!([]), json!(["old"])] {
        v["judgments"][0]["dependsOn"] = dependencies;
        let result = validate_output(&v.to_string(), &request, &proofs()).unwrap();
        assert_eq!(result[0].outcome, "needs_review");
        assert!(result[0].depends_on.is_empty());
    }
}
#[test]
fn quoted_fragment_cannot_hide_question_or_conditional_context() {
    for full in [
        "是否现在明确改用历史断片，不再采用同一位修士重修？",
        "如果现在明确改用历史断片，不再采用同一位修士重修。",
    ] {
        let mut p = proofs();
        p[0].evidence[0].context = full.into();
        assert_eq!(validate(&output(), &p).unwrap()[1].outcome, "needs_review");
        assert_eq!(
            input(&request(), &p)["records"][0]["nativeEvidence"][0]["context"],
            full
        );
    }
}
#[test]
fn disjoint_unknown_or_changed_conditions_do_not_replace() {
    for scope in ["disjoint", "unknown", "overlap"] {
        let mut v = output();
        v["judgments"][1]["scope"] = scope.into();
        assert_eq!(validate(&v, &proofs()).unwrap()[1].outcome, "needs_review");
    }
    let mut r = request();
    r.root.conditions = vec!["其他游戏".into()];
    assert_eq!(
        validate_output(&output().to_string(), &r, &proofs()).unwrap()[1].outcome,
        "needs_review"
    );
}
#[test]
fn partial_preservation_requires_exact_target_text_title_and_conditions() {
    let mut request = request();
    request.candidates[0]
        .text
        .push_str("仍然拒绝根基固化解释。");
    let check = |v: &Value| validate_output(&v.to_string(), &request, &proofs());
    let mut v = output();
    assert_eq!(
        check(&v).unwrap()[1].outcome,
        "needs_review",
        "cannot erase the uncovered negative constraint"
    );
    v["judgments"][1]["scope"] = "overlap".into();
    v["judgments"][1]["preserve"] =
        json!([{"title":"old","text":"仍然拒绝根基固化解释。","conditions":["游戏内"]}]);
    assert_eq!(check(&v).unwrap()[1].outcome, "superseded");
    for (field, value) in [
        ("title", json!("新结论")),
        ("text", json!("接受根基固化解释")),
        ("conditions", json!([])),
    ] {
        let mut bad = v.clone();
        bad["judgments"][1]["preserve"][0][field] = value;
        assert!(check(&bad).is_err());
    }
}
#[test]
fn model_unknown_fields_outcome_targets_duplicates_and_forged_quotes_rejected() {
    let mutations: Vec<(&str, Value)> = vec![
        ("outcome", json!("unknown")),
        ("targetId", json!("foreign")),
        ("targetRevision", json!(2)),
        ("scope", json!("global")),
        ("unknown", json!(true)),
        ("successorId", json!("old")),
    ];
    for (field, value) in mutations {
        let mut v = output();
        v["judgments"][1][field] = value;
        assert!(validate(&v, &proofs()).is_err());
    }
    let mut v = output();
    v["judgments"][1]["evidence"][0]["quote"] = "用户已同意这段伪造的话".into();
    assert!(validate(&v, &proofs()).is_err());
    let mut v = output();
    v["judgments"][1] = v["judgments"][0].clone();
    assert!(validate(&v, &proofs()).is_err());
    let mut v = output();
    v["judgments"].as_array_mut().unwrap().pop();
    assert!(validate(&v, &proofs()).is_err());
}
#[test]
fn root_can_be_the_older_target_and_same_kind_facts_require_later_evidence() {
    let mut r = request();
    r.root.id = "old".into();
    r.candidates[0].id = "new".into();
    let mut p = proofs();
    p.swap(0, 1);
    assert_eq!(
        validate_output(&output().to_string(), &r, &p).unwrap()[1].outcome,
        "superseded"
    );
    for kind in ["observation", "handoff"] {
        r.root.kind = kind.into();
        r.candidates[0].kind = kind.into();
        p[0].evidence[0].role = "assistant".into();
        p[1].evidence[0].role = "assistant".into();
        assert_eq!(
            validate_output(&output().to_string(), &r, &p).unwrap()[1].outcome,
            "superseded"
        );
    }
    r.root.kind = "decision".into();
    assert_eq!(
        validate_output(&output().to_string(), &r, &p).unwrap()[1].outcome,
        "needs_review"
    );
}
#[test]
fn dependency_requires_target_and_premise_evidence_reason_and_no_cycle() {
    let mut v = output();
    v["judgments"][0]["dependsOn"] = json!(["old"]);
    assert!(validate(&v, &proofs()).is_err());
    v["judgments"][0]["reason"] = "Requires old because this factual premise is necessary".into();
    v["judgments"][0]["evidence"]
        .as_array_mut()
        .unwrap()
        .push(json!({"recordId":"old","quote":proofs()[1].evidence[0].quote}));
    assert!(
        validate(&v, &proofs()).is_err(),
        "dependency plus replacement cycle"
    );
    v["judgments"][1]["outcome"] = "keep".into();
    v["judgments"][1]["successorId"] = Value::Null;
    assert!(validate(&v, &proofs()).is_ok());
}
#[test]
fn input_budget_unicode_limits_source_shape_and_provenance_authority() {
    let mut r = request();
    assert!(r.validate().is_ok());
    assert!(provenance(&r.root, "game").unwrap().is_none());
    r.root.text = "😀".repeat(1601);
    assert!(r.validate().is_err());
    r = request();
    r.root.source.text = "界".repeat(8192);
    r.candidates[0].source.text = "界".repeat(8192);
    assert!(r.validate().is_err());
    r = request();
    r.root.source.kind = "ai_background_extract".into();
    r.root.source.text = "{}".into();
    assert!(provenance(&r.root, "game").is_err());
    let mut v = serde_json::to_value(request()).unwrap();
    v["root"]["source"]["userVerified"] = true.into();
    assert!(serde_json::from_value::<Request>(v).is_err());
}
#[test]
fn review_provider_schema_is_fixed_tools_free_and_does_not_send_claimed_authority() {
    let body = memory::review_request_body(&input(&request(), &proofs()));
    assert!(body.get("tools").is_none());
    assert_eq!(body["generationConfig"]["candidateCount"], 1);
    assert_eq!(
        body["generationConfig"]["responseSchema"]["properties"]["judgments"]["maxItems"],
        7
    );
    let prompt = body["systemInstruction"]["parts"][0]["text"]
        .as_str()
        .unwrap();
    for rule in [
        "same comparable issue",
        "original evidence",
        "immediately preceding proposal",
        "negations",
        "dependsOn",
        "lossless partition",
        "No self links",
    ] {
        assert!(prompt.contains(rule), "{rule}");
    }
    let content = body["contents"][0]["parts"][0]["text"].as_str().unwrap();
    assert!(!content.contains("user_recorded") && !content.contains("createdAt"));
}
