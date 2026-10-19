//! Sidechat-only Codex process configuration. Never writes native config files.
use serde_json::{json, Value};
use tokio::process::Command;

const DISABLED_FEATURES: &[&str] = &[
    "apps",
    "plugins",
    "remote_plugin",
    "hooks",
    "shell_tool",
    "code_mode",
    "code_mode_only",
    "code_mode_host",
    "code_mode_prewarm",
    "multi_agent",
    "multi_agent_v2",
    "browser_use",
    "computer_use",
    "in_app_browser",
    "in_app_local_automation",
    "memories",
    "skill_mcp_dependency_install",
    "tool_suggest",
    "recommended_plugins",
    "workspace_dependencies",
    "image_generation",
    "artifact",
    "remote_control",
    "standalone_web_search",
];

pub(super) fn configure(command: &mut Command) {
    for name in DISABLED_FEATURES {
        command.args(["-c", &format!("features.{name}=false")]);
    }
    for value in [
        "notify=[]",
        "allow_login_shell=false",
        "sandbox_mode=\"read-only\"",
        "approval_policy=\"never\"",
        "web_search=\"disabled\"",
    ] {
        command.args(["-c", value]);
    }
}

pub(super) fn disable_mcp(command: &mut Command, response: &Value) -> Result<(), String> {
    let config = response
        .get("config")
        .ok_or("Missing Codex sidechat configuration")?;
    if let Some(servers) = config.get("mcp_servers").filter(|v| !v.is_null()) {
        for name in servers
            .as_object()
            .ok_or("Invalid Codex MCP configuration")?
            .keys()
        {
            // Codex CLI dotted overrides do not unquote TOML key segments.
            // Reject ambiguous names rather than targeting a different key.
            if name.is_empty()
                || !name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            {
                return Err("Codex Sidechat cannot safely disable an MCP server with this configuration key".into());
            }
            command.args(["-c", &format!("mcp_servers.{name}.enabled=false")]);
        }
    }
    Ok(())
}

pub(super) fn validate_config(response: &Value) -> Result<(), String> {
    let config = response
        .get("config")
        .ok_or("Missing Codex sidechat configuration")?;
    for feature in DISABLED_FEATURES {
        let setting = config
            .get("features")
            .and_then(|features| features.get(*feature));
        let disabled = setting == Some(&json!(false))
            || (*feature == "code_mode"
                && setting.and_then(|value| value.get("enabled")) == Some(&json!(false)));
        if !disabled {
            return Err(format!(
                "Codex Sidechat cannot verify features.{feature}=false"
            ));
        }
    }
    for (key, expected) in [
        ("notify", json!([])),
        ("allow_login_shell", json!(false)),
        ("sandbox_mode", json!("read-only")),
        ("approval_policy", json!("never")),
        ("web_search", json!("disabled")),
    ] {
        if config.get(key) != Some(&expected) {
            return Err(format!("Codex Sidechat cannot verify {key}"));
        }
    }
    if let Some(servers) = config.get("mcp_servers").filter(|v| !v.is_null()) {
        if servers
            .as_object()
            .ok_or("Invalid Codex MCP configuration")?
            .values()
            .any(|server| server.get("enabled") != Some(&json!(false)))
        {
            return Err("Codex Sidechat refuses an enabled MCP server".into());
        }
    }
    Ok(())
}

pub(super) fn validate_thread(response: &Value) -> Result<(), String> {
    if response.get("approvalPolicy") != Some(&json!("never"))
        || response.pointer("/sandbox/type") != Some(&json!("readOnly"))
        || response.pointer("/sandbox/networkAccess") != Some(&json!(false))
    {
        return Err(
            "Codex Sidechat did not activate a read-only sandbox without network access".into(),
        );
    }
    Ok(())
}

pub(super) fn fork_params(parent_id: &str, ephemeral: bool) -> Value {
    let mut params = json!({"threadId": parent_id});
    // Native forks reject deferGoalContinuation with ephemeral threads,
    // which cannot store goals. Persistent branches still need deferral
    // until the inherited goal is cleared before the first side turn.
    if ephemeral {
        params["ephemeral"] = json!(true);
    } else {
        params["deferGoalContinuation"] = json!(true);
    }
    params
}

pub(super) fn requires_goal_clear(response: &Value, ephemeral: bool) -> Result<bool, String> {
    if response.pointer("/thread/ephemeral") != Some(&json!(ephemeral)) {
        return Err("Codex did not create the requested Sidechat persistence mode".into());
    }
    // Native goal RPCs reject ephemeral threads, which cannot store goals.
    Ok(!ephemeral)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Value {
        let mut features = serde_json::Map::new();
        for name in DISABLED_FEATURES {
            features.insert((*name).into(), json!(false));
        }
        json!({"config":{"features":features,"notify":[],"allow_login_shell":false,
            "sandbox_mode":"read-only","approval_policy":"never","web_search":"disabled",
            "mcp_servers":{"one":{"enabled":false}}}})
    }
    #[test]
    fn rejects_missing_or_enabled_capabilities() {
        let mut value = config();
        assert!(validate_config(&value).is_ok());
        value["config"]["features"]["code_mode"] =
            json!({"enabled":false,"direct_only_tool_namespaces":["example"]});
        assert!(validate_config(&value).is_ok());
        value["config"]["mcp_servers"]["one"]["enabled"] = json!(true);
        assert!(validate_config(&value).is_err());
        value = config();
        value["config"]["features"]["shell_tool"] = Value::Null;
        assert!(validate_config(&value).is_err());
        assert!(validate_config(&json!({})).is_err());
    }
    #[test]
    fn validates_mcp_names_and_rejects_weaker_sandbox() {
        let mut command = Command::new("codex");
        assert!(disable_mcp(&mut command, &json!({"config":{"mcp_servers":{"a.b":{}}}})).is_err());
        disable_mcp(&mut command, &json!({"config":{"mcp_servers":{"a-b":{}}}})).unwrap();
        assert!(command
            .as_std()
            .get_args()
            .any(|arg| arg == "mcp_servers.a-b.enabled=false"));
        assert!(validate_thread(
            &json!({"approvalPolicy":"never","sandbox":{"type":"readOnly","networkAccess":false}})
        )
        .is_ok());
        assert!(validate_thread(
            &json!({"approvalPolicy":"never","sandbox":{"type":"readOnly","networkAccess":true}})
        )
        .is_err());
    }

    #[test]
    fn btw_fork_does_not_defer_goal_continuation() {
        let params = fork_params("parent", true);
        assert_eq!(params["threadId"], "parent");
        assert_eq!(params["ephemeral"], true);
        assert!(params.get("deferGoalContinuation").is_none());
    }

    #[test]
    fn persistent_sidechat_fork_defers_inherited_goals() {
        let params = fork_params("parent", false);
        assert_eq!(params["threadId"], "parent");
        assert_eq!(params["deferGoalContinuation"], true);
        assert!(params.get("ephemeral").is_none());
    }

    #[test]
    fn sidechat_persistence_selects_the_supported_goal_isolation_path() {
        assert!(!requires_goal_clear(&json!({"thread":{"ephemeral":true}}), true).unwrap());
        assert!(requires_goal_clear(&json!({"thread":{"ephemeral":false}}), false).unwrap());
        assert!(requires_goal_clear(&json!({"thread":{"ephemeral":false}}), true).is_err());
        assert!(requires_goal_clear(&json!({"thread":{"ephemeral":true}}), false).is_err());
        assert!(requires_goal_clear(&json!({"thread":{}}), true).is_err());
    }
}
