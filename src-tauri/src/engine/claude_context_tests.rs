use super::*;
use crate::engine::{claude::ClaudeEngine, Engine, EngineEvent};
use serde_json::json;

fn stream(engine: &ClaudeEngine, event: Value) -> Vec<Value> {
    usages(engine, json!({"type":"stream_event", "event":event}))
}

fn usages(engine: &ClaudeEngine, line: Value) -> Vec<Value> {
    let mut events = Vec::new();
    engine.parse_line(&line.to_string(), &mut events);
    events
        .into_iter()
        .filter_map(|event| match event {
            EngineEvent::Usage(usage) => Some(usage),
            _ => None,
        })
        .collect()
}

fn start(id: &str, input: u64, cached: u64) -> Value {
    json!({"type":"message_start","message":{"id":id,"usage":{
        "input_tokens":input,"cache_read_input_tokens":cached,"cache_creation_input_tokens":10,"output_tokens":1
    }}})
}

#[test]
fn main_request_reports_context_before_text_and_preserves_prompt_on_delta() {
    let engine = ClaudeEngine::new();
    let first = stream(&engine, start("a", 100, 50_000));
    assert_eq!(first.len(), 1);
    assert_eq!(first[0]["usage_scope"], "last_request");
    assert_eq!(first[0]["cache_read_input_tokens"], 50_000);
    let final_usage = stream(
        &engine,
        json!({"type":"message_delta","usage":{"output_tokens":300}}),
    );
    assert_eq!(final_usage[0]["input_tokens"], 100);
    assert_eq!(final_usage[0]["cache_creation_input_tokens"], 10);
    assert_eq!(final_usage[0]["output_tokens"], 300);
    // Same-message assistant snapshots must not regress or double-report.
    assert!(usages(
        &engine,
        json!({"type":"assistant","message":{"id":"a","usage":{
            "input_tokens":100,"cache_read_input_tokens":50_000,"output_tokens":1
        }}})
    )
    .is_empty());
    assert!(stream(
        &engine,
        json!({"type":"message_delta","usage":{"output_tokens":300}})
    )
    .is_empty());
    let next = stream(&engine, start("b", 30, 8_000));
    assert_eq!(next[0]["cache_read_input_tokens"], 8_000);
    assert_eq!(next[0]["output_tokens"], 1);
}

#[test]
fn child_requests_and_mismatched_deltas_do_not_replace_main_context() {
    let engine = ClaudeEngine::new();
    stream(&engine, start("a", 100, 50_000));
    for line in [
        json!({"type":"stream_event","parent_tool_use_id":"child","event":start("child", 1, 900_000)}),
        json!({"type":"assistant","parent_tool_use_id":"child","message":{"usage":{"input_tokens":900_000}}}),
        json!({"type":"assistant","message":{"id":"old","usage":{"input_tokens":900_000}}}),
        json!({"type":"stream_event","event":{"type":"message_delta","message_id":"other","usage":{"output_tokens":9_999}}}),
    ] {
        assert!(usages(&engine, line).is_empty());
    }
    let next = stream(
        &engine,
        json!({"type":"message_delta","usage":{"output_tokens":200}}),
    );
    assert_eq!(next[0]["cache_read_input_tokens"], 50_000);
    assert_eq!(next[0]["output_tokens"], 200);
}

#[test]
fn full_assistant_snapshots_work_without_partial_events() {
    let engine = ClaudeEngine::new();
    for (id, count) in [("a", 50_000), ("b", 60_000)] {
        let result = usages(
            &engine,
            json!({"type":"assistant","message":{"id":id,"usage":{
                "input_tokens":count,"output_tokens":10
            }}}),
        );
        assert_eq!(result[0]["input_tokens"], count);
    }
    assert!(usages(
        &engine,
        json!({"type":"assistant","message":{
            "model":"<synthetic>","usage":{"input_tokens":900_000}
        }})
    )
    .is_empty());
}

#[test]
fn output_only_invalid_and_late_reports_do_not_invent_context() {
    let engine = ClaudeEngine::new();
    for usage in [
        json!({"output_tokens":100}),
        json!({"input_tokens":-1}),
        json!({"input_tokens":9_007_199_254_740_992_u64}),
        json!({"input_tokens":0}),
        json!({}),
    ] {
        assert!(stream(
            &engine,
            json!({"type":"message_start","message":{"id":"a","usage":usage}})
        )
        .is_empty());
        assert!(stream(
            &engine,
            json!({"type":"message_delta","usage":{"output_tokens":200}})
        )
        .is_empty());
    }
    stream(&engine, start("a", 10, 50_000));
    stream(&engine, json!({"type":"message_stop"}));
    assert!(stream(
        &engine,
        json!({"type":"message_delta","usage":{"output_tokens":200}})
    )
    .is_empty());
    usages(
        &engine,
        json!({"type":"result","usage":{"input_tokens":999_999}}),
    );
    assert!(stream(
        &engine,
        json!({"type":"message_delta","usage":{"output_tokens":300}})
    )
    .is_empty());
}

#[test]
fn compaction_and_retry_clear_the_previous_request() {
    let engine = ClaudeEngine::new();
    for subtype in ["compact_boundary", "api_retry"] {
        stream(&engine, start("a", 100, 500_000));
        usages(
            &engine,
            json!({"type":"system","subtype":subtype,"compactMetadata":{"postTokens":8000}}),
        );
        assert!(stream(
            &engine,
            json!({"type":"message_delta","usage":{"output_tokens":300}})
        )
        .is_empty());
        let next = stream(&engine, start("b", 50, 9_000));
        assert_eq!(next[0]["cache_read_input_tokens"], 9_000);
    }
    // A post-compaction request supersedes the earlier boundary's 8000 tokens.
    let mut out = Vec::new();
    engine.parse_line(
        &json!({"type":"result","usage":{"input_tokens":123,"output_tokens":400}}).to_string(),
        &mut out,
    );
    assert!(out.iter().any(
        |event| matches!(event, EngineEvent::Done { usage: Some(usage), .. }
        | EngineEvent::TurnComplete { usage: Some(usage), .. } if usage["input_tokens"] == 123)
    ));
}
