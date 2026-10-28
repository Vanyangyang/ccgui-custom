use super::*;

#[test]
fn codex_new_turn_without_context_never_inherits_the_previous_turn_model() {
    let user = json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]}});
    for native_boundaries in [false, true] {
        let mut lines = vec![];
        if native_boundaries {
            lines.push(json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"first"}}));
        }
        let mut context = model_context(json!("gpt-6.1-sol"));
        if native_boundaries { context["payload"]["turn_id"] = json!("first"); }
        lines.extend([context, user.clone(), model_answer("known"), model_usage(60000)]);
        if native_boundaries {
            lines.push(json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"first"}}));
            lines.push(json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"second"}}));
        }
        lines.extend([user.clone(), model_answer("unknown"), model_usage(70000)]);
        let parsed = parse_model_history(&lines, false);
        let answers = parsed.messages.iter().filter(|row| row.role == "assistant").collect::<Vec<_>>();
        assert_eq!(answers.len(), 2);
        assert_eq!(answers[0].model.as_deref(), Some("gpt-6.1-sol"));
        assert_eq!(answers[1].model, None);
        assert_eq!(answers[1].usage.as_ref().unwrap()["total_tokens"], 70000);
    }
}

#[test]
fn codex_context_before_user_keeps_its_model_and_filtered_context_is_not_a_turn() {
    let parsed = parse_model_history(&[
        model_context(json!("gpt-6.1-sol")),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"question"}]}}),
        model_answer("answer"),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<system-reminder>injected metadata</system-reminder>"}]}}),
        model_usage(60000),
    ], false);
    assert_eq!(parsed.messages.len(), 2);
    assert_eq!(parsed.messages[1].model.as_deref(), Some("gpt-6.1-sol"));
    assert_eq!(parsed.messages[1].usage.as_ref().unwrap()["total_tokens"], 60000);
}

#[test]
fn codex_native_turn_context_survives_a_steered_user_message() {
    let parsed = parse_model_history(&[
        json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"turn"}}),
        json!({"type":"turn_context","payload":{"turn_id":"turn","model":"gpt-6.1-sol"}}),
        model_answer("before steer"),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"additional instruction"}]}}),
        model_answer("after steer"), model_usage(60000),
    ], false);
    assert_eq!(parsed.messages[2].model.as_deref(), Some("gpt-6.1-sol"));
    assert_eq!(parsed.messages[2].usage.as_ref().unwrap()["total_tokens"], 60000);
}

use serde_json::json;

fn model_context(model: Value) -> Value {
    json!({"type":"turn_context","payload":{"model":model,"effort":"high"}})
}
fn model_answer(text: &str) -> Value {
    json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":text}]}})
}
fn model_usage(tokens: u64) -> Value {
    json!({"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":tokens,"total_tokens":tokens},"model_context_window":570000}}})
}
fn parse_model_history(lines: &[Value], handed: bool) -> ParsedSession {
    let input = lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
    let handed = handed.then(|| HandedPrompts { thread:"fixture-thread".into(), digests:Default::default() });
    collect_session(std::io::Cursor::new(input), &extractor_for("codex", ImageMode::Collect, handed)).unwrap()
}

#[test]
fn codex_turn_models_follow_each_native_context_for_history_and_handoffs() {
    let lines = [
        model_context(json!("gpt-6.1-sol")), model_answer("first"), model_usage(60000),
        model_context(json!("gpt-6.1-terra")),
        json!({"type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"second reasoning"}]}}),
        model_answer("second"), model_usage(70000),
    ];
    for handed in [false, true] {
        let parsed = parse_model_history(&lines, handed);
        assert_eq!(parsed.messages.len(), 3);
        assert_eq!(parsed.messages[0].model.as_deref(), Some("gpt-6.1-sol"));
        assert_eq!(parsed.messages[0].effort.as_deref(), Some("high"));
        assert_eq!(parsed.messages[0].usage.as_ref().unwrap()["total_tokens"], 60000);
        assert_eq!(parsed.messages[1].model.as_deref(), Some("gpt-6.1-terra"));
        assert_eq!(parsed.messages[2].model.as_deref(), Some("gpt-6.1-terra"));
        assert_eq!(parsed.messages[2].usage.as_ref().unwrap()["total_tokens"], 70000);
    }
    let input = lines.iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
    let mut scan = ScanAcc::default();
    walk_lines(std::io::Cursor::new(input), &extractor_for("codex", ImageMode::SkipDataUrls, None), |row| scan.accept(row)).unwrap();
    assert_eq!(scan.finish().message_count, 3, "context markers must not become visible rows");
}

#[test]
fn codex_context_and_startup_usage_cannot_relabel_an_older_answer() {
    let parsed = parse_model_history(&[
        model_context(json!("gpt-6.1-terra")), model_answer("earlier"), model_usage(60000),
        model_context(json!("gpt-6.1-sol")), model_usage(80000),
    ], false);
    assert_eq!(parsed.messages.len(), 1);
    assert_eq!(parsed.messages[0].model.as_deref(), Some("gpt-6.1-terra"));
    assert_eq!(parsed.messages[0].usage.as_ref().unwrap()["total_tokens"], 60000);
}

#[test]
fn codex_missing_or_invalid_context_keeps_model_unknown() {
    let no_context = parse_model_history(&[model_answer("legacy"), model_usage(60000)], false);
    assert_eq!(no_context.messages[0].model, None);
    assert_eq!(no_context.messages[0].usage.as_ref().unwrap()["total_tokens"], 60000);
    for missing in [Value::Null, json!(""), json!("   "), json!(123)] {
        let parsed = parse_model_history(&[
            model_context(json!("gpt-6.1-sol")), model_answer("known"), model_usage(60000),
            model_context(missing), model_answer("unknown"), model_usage(70000),
        ], false);
        assert_eq!(parsed.messages[0].model.as_deref(), Some("gpt-6.1-sol"));
        assert_eq!(parsed.messages[1].model, None);
        assert_eq!(parsed.messages[1].usage.as_ref().unwrap()["total_tokens"], 70000);
    }
}

#[test]
fn codex_new_user_before_context_does_not_absorb_usage_into_previous_turn() {
    let parsed = parse_model_history(&[
        model_context(json!("gpt-6.1-sol")), model_answer("previous"), model_usage(60000),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"new prompt"}]}}),
        model_usage(90000),
    ], false);
    assert_eq!(parsed.messages.len(), 2);
    assert_eq!(parsed.messages[0].usage.as_ref().unwrap()["total_tokens"], 60000);
    assert!(parsed.messages[1].usage.is_none());
}

