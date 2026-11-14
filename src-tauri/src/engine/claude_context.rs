//! Latest main-request occupancy, independent of result's cumulative billing.
use serde_json::{Map, Value};

#[derive(Default)]
pub(super) struct ClaudeContext {
    message_id: Option<String>,
    usage: Option<Map<String, Value>>,
    streaming: bool,
}

const COUNTERS: [&str; 4] = [
    "input_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
    "output_tokens",
];

impl ClaudeContext {
    pub(super) fn observe(&mut self, source: &Value) -> Option<Value> {
        // Child requests have their own context; never replace the parent's gauge.
        if source
            .get("parent_tool_use_id")
            .is_some_and(|v| !v.is_null())
        {
            return None;
        }
        match source.get("type").and_then(Value::as_str)? {
            "stream_event" => {
                let event = source.get("event")?;
                match event.get("type").and_then(Value::as_str)? {
                    "message_start" => {
                        *self = Self::default();
                        self.streaming = true;
                        let message = event.get("message")?;
                        self.message_id =
                            message.get("id").and_then(Value::as_str).map(str::to_owned);
                        self.update(message.get("usage")?)
                    }
                    "message_delta" => {
                        if !self.streaming || self.usage.is_none() {
                            return None;
                        }
                        if let Some(id) = event.get("message_id").and_then(Value::as_str) {
                            if self.message_id.as_deref() != Some(id) {
                                return None;
                            }
                        }
                        self.update(event.get("usage")?)
                    }
                    "message_stop" => {
                        self.streaming = false;
                        None
                    }
                    _ => None,
                }
            }
            "assistant" => {
                let message = source.get("message")?;
                if message.get("model").and_then(Value::as_str) == Some("<synthetic>") {
                    return None;
                }
                let id = message.get("id").and_then(Value::as_str);
                if self.streaming && self.message_id.as_deref() != id {
                    return None;
                }
                if id.is_none() || self.message_id.as_deref() != id {
                    self.usage = None;
                }
                self.message_id = id.map(str::to_owned);
                self.update(message.get("usage")?)
            }
            "result" => {
                *self = Self::default();
                None
            }
            "system"
                if matches!(
                    source.get("subtype").and_then(Value::as_str),
                    Some("compact_boundary" | "api_retry")
                ) =>
            {
                *self = Self::default();
                None
            }
            _ => None,
        }
    }

    fn update(&mut self, report: &Value) -> Option<Value> {
        let report = report.as_object()?;
        let mut usage = self.usage.clone().unwrap_or_default();
        for key in COUNTERS {
            if let Some(count) = report
                .get(key)
                .and_then(Value::as_u64)
                .filter(|count| *count <= 9_007_199_254_740_991)
            {
                // Snapshots for one message can repeat after its final delta.
                let previous = usage.get(key).and_then(Value::as_u64).unwrap_or(0);
                usage.insert(key.to_owned(), Value::from(count.max(previous)));
            }
        }
        // Output alone cannot tell us how much context the request occupies.
        if !COUNTERS[..3]
            .iter()
            .any(|key| usage.get(*key).and_then(Value::as_u64).unwrap_or(0) > 0)
        {
            return None;
        }
        usage.insert("usage_scope".into(), Value::from("last_request"));
        if self.usage.as_ref() == Some(&usage) {
            return None;
        }
        self.usage = Some(usage.clone());
        Some(Value::Object(usage))
    }
}

#[cfg(test)]
#[path = "claude_context_tests.rs"]
mod tests;
