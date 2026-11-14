//! Read-only MCP declarations returned by native CLI plugin inventories.
//!
//! These are configuration observations, not connection status. In particular,
//! resolving plugin variables and launching the server belongs to the CLI.

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{config, McpConfigEntry};

pub(crate) struct PluginMcpDeclaration {
    pub engine: String,
    pub plugin_id: String,
    pub scope: String,
    pub source_path: String,
    pub server_name: String,
    pub enabled: Option<bool>,
    /// Never serialize this: native plugin output may include credentials.
    pub config: Value,
}

pub(super) fn entries(declarations: Vec<PluginMcpDeclaration>) -> Vec<McpConfigEntry> {
    declarations
        .into_iter()
        .filter_map(|declaration| {
            let config = declaration.config.as_object()?;
            let source = format!("{}_plugin", declaration.engine);
            // Hash a structured identity, rather than joining untrusted names
            // with delimiters that may themselves appear in plugin IDs.
            let identity = serde_json::to_vec(&(
                &declaration.engine,
                &declaration.plugin_id,
                &declaration.scope,
                &declaration.source_path,
                &declaration.server_name,
            ))
            .ok()?;
            let version = format!("{:x}", Sha256::digest(serde_json::to_vec(config).ok()?));
            let text = |key: &str| {
                config
                    .get(key)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            };
            Some(McpConfigEntry {
                id: format!("{source}:{:x}", Sha256::digest(identity)),
                engine: declaration.engine,
                name: format!("{} · {}", declaration.plugin_id, declaration.server_name),
                source,
                scope: match declaration.scope.as_str() {
                    "project" | "local" => "project".into(),
                    "user" => "user".into(),
                    _ => "unknown".into(),
                },
                path: declaration.source_path,
                format: "json".into(),
                enabled: declaration.enabled.unwrap_or(false),
                enablement_known: declaration.enabled.is_none().then_some(false),
                transport: text("type").or_else(|| text("transport")),
                command: text("command"),
                args_count: config
                    .get("args")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len),
                url: text("url")
                    .or_else(|| text("serverUrl"))
                    .map(|url| super::redact_plugin_url(&url)),
                env_keys: config::object_keys(config.get("env")),
                header_keys: config::object_keys(config.get("headers")),
                writable: false,
                readonly_reason: None,
                readonly_reason_code: Some("plugin_managed".into()),
                probe_allowed: Some(false),
                version,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn declaration(plugin: &str, scope: &str, enabled: bool) -> PluginMcpDeclaration {
        PluginMcpDeclaration {
            engine: "claude".into(),
            plugin_id: plugin.into(),
            scope: scope.into(),
            source_path: "/plugins/example".into(),
            server_name: "example".into(),
            enabled: Some(enabled),
            config: serde_json::json!({
                "type": "http",
                "command": "node",
                "args": ["secret argument"],
                "url": "https://user:password@example.com/mcp?token=secret-value",
                "env": {"API_KEY": "secret-env"},
                "headers": {"Authorization": "secret-header"}
            }),
        }
    }

    #[test]
    fn declarations_are_read_only_redacted_and_never_directly_probed() {
        let entries = entries(vec![declaration("sample@market", "user", false)]);
        let entry = &entries[0];
        assert!(!entry.enabled);
        assert!(!entry.writable);
        assert_eq!(entry.probe_allowed, Some(false));
        assert_eq!(
            entry.readonly_reason_code.as_deref(),
            Some("plugin_managed")
        );
        assert_eq!(entry.env_keys, ["API_KEY"]);
        assert_eq!(entry.header_keys, ["Authorization"]);
        let public = serde_json::to_string(entry).unwrap();
        for secret in [
            "password",
            "secret-value",
            "secret-env",
            "secret-header",
            "secret argument",
        ] {
            assert!(!public.contains(secret), "sensitive value leaked: {secret}");
        }
    }

    #[test]
    fn same_server_from_different_plugins_and_scopes_has_distinct_identity() {
        let entries = entries(vec![
            declaration("a@market", "user", true),
            declaration("a@market", "project", true),
            declaration("b@market", "user", true),
        ]);
        assert_ne!(entries[0].id, entries[1].id);
        assert_ne!(entries[0].id, entries[2].id);
        assert_eq!(entries[1].scope, "project");
    }

    #[test]
    fn unknown_enablement_is_not_reported_as_disabled() {
        let mut unknown = declaration("sample@market", "user", true);
        unknown.enabled = None;
        let entry = entries(vec![unknown]).remove(0);
        assert_eq!(entry.enablement_known, Some(false));
        assert_eq!(entry.probe_allowed, Some(false));
    }

    #[test]
    fn malformed_urls_and_fragments_never_expose_credentials() {
        let mut invalid = declaration("sample", "user", true);
        invalid.config["url"] = serde_json::json!("https://alice:secret@bad host/mcp");
        let mut fragment = declaration("other", "user", true);
        fragment.config["url"] =
            serde_json::json!("https://example.test/mcp?custom=unknown-secret#secret-fragment");
        let serialized = serde_json::to_string(&entries(vec![invalid, fragment])).unwrap();
        assert!(!serialized.contains("alice"));
        assert!(!serialized.contains("secret-fragment"));
        assert!(!serialized.contains("unknown-secret"));
        assert!(!serialized.contains("bad host"));
    }
}
