//! Prompt-cache evidence, independent of file/activity timestamps and process state.
//! Anthropic's usage buckets report the requested TTL; OpenAI's GPT-5.6/6
//! policy specifies a 30-minute minimum. Neither guarantees the next prefix hit.
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

const NAMESPACE: &str = "$ccgui-prompt-cache";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CacheWindow {
    pub ttl_seconds: i64,
    /// Last input/tool-result boundary, a lower bound on the request start.
    pub started_at: i64,
    /// Usage report time, an upper bound on the request start, NOT a renewal.
    pub observed_at: i64,
    pub source: String,
    /// Advisory policy for AGY, not an observed provider expiration deadline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<CacheReference>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CacheReference {
    pub max_ttl_seconds: i64,
    pub cache_read_tokens: u64,
    pub prompt_tokens: u64,
}

impl CacheWindow {
    pub fn max_ttl_seconds(&self) -> i64 {
        self.reference.as_ref().map_or(self.ttl_seconds, |r| r.max_ttl_seconds)
    }

    pub fn heat(&self, now: i64) -> &'static str {
        if self.ttl_seconds <= 0
            || self.max_ttl_seconds() < self.ttl_seconds
            || self.started_at <= 0
            || self.observed_at < self.started_at
            || now < self.observed_at
            || self.reference.as_ref().is_some_and(|r| r.cache_read_tokens == 0 || r.prompt_tokens < r.cache_read_tokens)
        {
            "unknown"
        } else if now
            < self
                .started_at
                .saturating_add(self.ttl_seconds.saturating_mul(1000))
        {
            "hot"
        } else if now
            >= self
                .observed_at
                .saturating_add(self.max_ttl_seconds().saturating_mul(1000))
        {
            "cold"
        } else {
            // The request start is only bounded; don't invent an exact deadline.
            "unknown"
        }
    }
}

pub fn set(
    conn: &Connection,
    engine: &str,
    session: &str,
    window: Option<&CacheWindow>,
) -> rusqlite::Result<()> {
    let key = format!("{engine}:{session}");
    if let Some(window) = window {
        conn.execute("INSERT INTO plugin_kv(plugin_id,key,value) VALUES(?1,?2,?3) ON CONFLICT(plugin_id,key) DO UPDATE SET value=excluded.value",
            params![NAMESPACE, key, serde_json::to_string(window).expect("cache window is serializable")])?;
    } else {
        conn.execute(
            "DELETE FROM plugin_kv WHERE plugin_id=?1 AND key=?2",
            params![NAMESPACE, key],
        )?;
    }
    Ok(())
}

pub fn load_all(conn: &Connection) -> rusqlite::Result<HashMap<String, CacheWindow>> {
    let mut stmt = conn.prepare(
        "SELECT kv.key,kv.value,p.provider_id FROM plugin_kv kv
        LEFT JOIN session_providers p ON p.engine=substr(kv.key,1,instr(kv.key,':')-1)
          AND p.session_id=substr(kv.key,instr(kv.key,':')+1) WHERE kv.plugin_id=?1",
    )?;
    let rows = stmt.query_map([NAMESPACE], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
        ))
    })?;
    let mut result = HashMap::new();
    for row in rows {
        let (key, value, provider) = row?;
        // Cursor policy is intentionally disabled until explicitly enabled.
        if key.starts_with("cursor:") { continue; }
        if let Ok(window) = serde_json::from_str::<CacheWindow>(&value) {
            if window.source != "openai-policy"
                || provider
                    .as_deref()
                    .is_none_or(|p| p == crate::config::LOCAL_PROVIDER_ID)
            {
                result.insert(key, window);
            }
        }
    }
    Ok(result)
}

pub fn delete_for_workspace(conn: &Connection, workspace: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM plugin_kv WHERE plugin_id=?1 AND key IN (SELECT engine || ':' || session_id FROM sessions WHERE workspace_path=?2)", params![NAMESPACE, workspace])?;
    Ok(())
}

pub(super) struct Tracker {
    engine: String,
    model: Option<String>,
    provider: Option<String>,
    input_at: Option<i64>,
    last_codex_total: Option<Value>,
    window: Option<CacheWindow>,
}

impl Tracker {
    pub fn new(engine: &str) -> Self {
        Self {
            engine: engine.into(),
            model: None,
            provider: None,
            input_at: None,
            last_codex_total: None,
            window: None,
        }
    }

    pub fn finish(self) -> Option<CacheWindow> {
        self.window
    }

    fn record(&mut self, ttl: i64, observed: Option<i64>, source: &str) {
        self.window = self
            .input_at
            .zip(observed)
            .filter(|(start, end)| *start > 0 && end >= start)
            .map(|(started_at, observed_at)| CacheWindow {
                ttl_seconds: ttl,
                started_at,
                observed_at,
                source: source.into(),
                reference: None,
            });
    }

    pub fn observe(&mut self, row: &Value) {
        let ts = row
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(super::parse_ts_ms_str);
        let kind = row["type"].as_str().unwrap_or("");
        if self.engine == "claude" {
            if kind == "system" && row["subtype"] == "compact_boundary" {
                self.window = None;
                self.input_at = None;
            }
            if kind == "user" {
                self.input_at = ts;
            }
            if kind != "assistant" {
                return;
            }
            if row.pointer("/message/model").and_then(Value::as_str)
                == Some(super::extract::CLAUDE_SYNTHETIC_MODEL)
            {
                return;
            }
            let Some(usage) = row.pointer("/message/usage") else {
                return;
            };
            let five = usage
                .pointer("/cache_creation/ephemeral_5m_input_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let hour = usage
                .pointer("/cache_creation/ephemeral_1h_input_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            // Read tokens don't disclose the request's retention choice. A new
            // write bucket is required; do not inherit a possibly changed TTL.
            if five > 0 {
                self.record(
                    300,
                    ts,
                    if hour > 0 {
                        "anthropic-mixed"
                    } else {
                        "anthropic-usage"
                    },
                );
            } else if hour > 0 {
                self.record(3600, ts, "anthropic-usage");
            } else {
                self.window = None;
            }
        } else if self.engine == "codex" {
            let payload = &row["payload"];
            if kind == "session_meta" {
                self.provider = payload["model_provider"].as_str().map(str::to_owned);
            }
            if kind == "turn_context" {
                let model = payload["model"].as_str().map(str::to_owned);
                if model != self.model {
                    self.window = None;
                }
                self.model = model;
                self.input_at = ts;
            }
            if (kind == "event_msg"
                && matches!(
                    payload["type"].as_str(),
                    Some("task_started" | "user_message")
                ))
                || (kind == "response_item"
                    && matches!(
                        payload["type"].as_str(),
                        Some("function_call_output" | "custom_tool_call_output")
                    ))
            {
                self.input_at = ts;
            }
            if kind == "event_msg" && payload["type"] == "context_compacted" {
                self.window = None;
                self.input_at = None;
            }
            if kind != "event_msg" || payload["type"] != "token_count" {
                return;
            }
            let Some(info) = payload.get("info").filter(|v| v.is_object()) else {
                return;
            };
            let total = info.get("total_token_usage");
            if total.is_some() && total == self.last_codex_total.as_ref() {
                return;
            }
            self.last_codex_total = total.cloned();
            let eligible = info
                .pointer("/last_token_usage/input_tokens")
                .and_then(Value::as_u64)
                .is_some_and(|n| n >= 1024);
            if self.provider.as_deref() == Some("openai")
                && self
                    .model
                    .as_deref()
                    .is_some_and(openai_thirty_minute_model)
                && eligible
            {
                self.record(1800, ts, "openai-policy");
            } else {
                self.window = None;
            }
        }
    }
}

fn openai_thirty_minute_model(model: &str) -> bool {
    // Explicit verified families, not a blanket promise about future models.
    ["gpt-5.6", "gpt-6"].iter().any(|prefix| {
        model == *prefix
            || model
                .strip_prefix(prefix)
                .is_some_and(|s| s.starts_with('-') || s.starts_with('.'))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const START: &str = "2026-10-17T10:00:00Z";
    const END: &str = "2026-10-17T10:01:00Z";

    fn claude(five: u64, hour: u64) -> CacheWindow {
        let mut t = Tracker::new("claude");
        t.observe(&json!({"type":"user","timestamp":START}));
        t.observe(&json!({"type":"assistant","timestamp":END,"message":{"usage":{"cache_creation":{"ephemeral_5m_input_tokens":five,"ephemeral_1h_input_tokens":hour}}}}));
        t.finish().unwrap()
    }

    #[test]
    fn prompt_cache_uses_actual_claude_buckets_and_time_bounds() {
        let w = claude(0, 1000);
        assert_eq!(w.ttl_seconds, 3600);
        assert_eq!(w.heat(w.started_at + 30 * 60_000), "hot");
        assert_eq!(w.heat(w.started_at + 60 * 60_000), "unknown");
        assert_eq!(w.heat(w.observed_at + 60 * 60_000), "cold");
        assert_eq!(claude(100, 0).ttl_seconds, 300);
        assert_eq!(claude(100, 100).source, "anthropic-mixed");
        assert_eq!(claude(100, 100).ttl_seconds, 300);
    }

    #[test]
    fn prompt_cache_requires_timestamp_and_write_evidence() {
        let mut t = Tracker::new("claude");
        t.observe(&json!({"type":"assistant","timestamp":END,"message":{"usage":{"cache_creation":{"ephemeral_1h_input_tokens":100}}}}));
        assert!(t.finish().is_none());
        let mut t = Tracker::new("claude");
        t.observe(&json!({"type":"user","timestamp":START}));
        t.observe(&json!({"type":"assistant","timestamp":END,"message":{"usage":{"cache_read_input_tokens":10000}}}));
        assert!(t.finish().is_none());
        let mut t = Tracker::new("claude");
        t.observe(&json!({"type":"user","timestamp":START}));
        t.observe(&json!({"type":"assistant","timestamp":END,"message":{"model":"claude-opus-5-5","usage":{"cache_creation":{"ephemeral_1h_input_tokens":1092}}}}));
        t.observe(&json!({"type":"user","timestamp":"2026-10-17T10:01:05Z"}));
        t.observe(&json!({"type":"assistant","timestamp":"2026-10-17T10:01:06Z","message":{"model":"<synthetic>","usage":{"cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0}}}}));
        assert_eq!(t.finish().unwrap().ttl_seconds, 3600);
    }

    #[test]
    fn prompt_cache_codex_policy_is_provider_and_model_scoped() {
        for (provider, model, expected) in [
            ("openai", "gpt-6", true),
            ("openai", "gpt-5.6-codex", true),
            ("openai", "gpt-5.4", false),
            ("custom", "gpt-6", false),
            ("openai", "gpt-60", false),
        ] {
            let mut t = Tracker::new("codex");
            t.observe(&json!({"type":"session_meta","payload":{"model_provider":provider}}));
            t.observe(&json!({"type":"turn_context","timestamp":START,"payload":{"model":model}}));
            let report = json!({"type":"event_msg","timestamp":END,"payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":2048},"last_token_usage":{"input_tokens":2048}}}});
            t.observe(&report);
            // A duplicate report cannot renew a window after a later tool.
            t.observe(&json!({"type":"response_item","timestamp":"2026-10-17T10:10:00Z","payload":{"type":"function_call_output"}}));
            t.observe(&report);
            let w = t.finish();
            assert_eq!(w.is_some(), expected, "{provider}/{model}");
            if let Some(w) = w {
                assert_eq!(w.ttl_seconds, 1800);
                assert_eq!(w.started_at, super::super::parse_ts_ms_str(START).unwrap());
            }
        }
    }

    #[test]
    fn prompt_cache_metadata_round_trips_without_schema_changes() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE plugin_kv(plugin_id TEXT,key TEXT,value TEXT,PRIMARY KEY(plugin_id,key)); CREATE TABLE session_providers(engine TEXT,session_id TEXT,provider_id TEXT);").unwrap();
        let w = claude(0, 100);
        set(&conn, "claude", "a", Some(&w)).unwrap();
        set(&conn, "cursor", "disabled", Some(&w)).unwrap();
        assert!(!load_all(&conn).unwrap().contains_key("cursor:disabled"));
        assert_eq!(load_all(&conn).unwrap()["claude:a"], w);
        let mut openai = w.clone();
        openai.source = "openai-policy".into();
        set(&conn, "codex", "b", Some(&openai)).unwrap();
        conn.execute(
            "INSERT INTO session_providers VALUES('codex','b','custom-channel')",
            [],
        )
        .unwrap();
        assert!(!load_all(&conn).unwrap().contains_key("codex:b"));
        set(&conn, "claude", "a", None).unwrap();
        assert!(load_all(&conn).unwrap().is_empty());
    }
}
