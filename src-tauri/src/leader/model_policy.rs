use crate::settings::{normalize_leader_allowed_models, AppSettings};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EngineModelPolicy {
    allowed_models: Option<Vec<String>>,
    default_model: Option<String>,
}

#[derive(Debug, Serialize)]
pub(super) struct ModelPolicy {
    claude: EngineModelPolicy,
    codex: EngineModelPolicy,
    agy: EngineModelPolicy,
    cursor: EngineModelPolicy,
}

impl EngineModelPolicy {
    fn resolve(&self, engine: &str, requested: Option<&str>) -> Result<Option<String>, String> {
        let Some(allowed) = &self.allowed_models else {
            return Ok(requested
                .map(str::to_owned)
                .or_else(|| self.default_model.clone()));
        };
        let choices = serde_json::to_string(allowed).map_err(|e| e.to_string())?;
        if allowed.is_empty() {
            return Err(format!(
                "Child task spawning is disabled for {engine}; allowed models: {choices}. Inspect task_list modelPolicy for available choices"
            ));
        }
        if let Some(model) = requested {
            if !allowed.iter().any(|id| id == model) {
                return Err(format!(
                    "Child task model is not allowed for {engine}; allowed models: {choices}. Choose an exact ID from task_list modelPolicy"
                ));
            }
            return Ok(Some(model.to_owned()));
        }
        Ok(self.default_model.clone())
    }
}

pub(super) fn snapshot(settings: &AppSettings) -> Result<ModelPolicy, String> {
    let policy = normalize_leader_allowed_models(&settings.leader_allowed_models)?;
    let engine = |id: &str| {
        let app_default = settings
            .default_models
            .get(id)
            .filter(|model| !model.trim().is_empty())
            .cloned();
        let allowed_models = policy.get(id).cloned();
        let default_model = match &allowed_models {
            None => app_default,
            Some(allowed) => app_default
                .map(|model| model.trim().to_owned())
                .filter(|model| allowed.contains(model))
                .or_else(|| allowed.first().cloned()),
        };
        EngineModelPolicy {
            allowed_models,
            default_model,
        }
    };
    Ok(ModelPolicy {
        claude: engine("claude"),
        codex: engine("codex"),
        agy: engine("agy"),
        cursor: engine("cursor"),
    })
}

pub(super) fn resolve(
    settings: &AppSettings,
    engine: &str,
    requested: Option<&str>,
) -> Result<Option<String>, String> {
    let policy = snapshot(settings)?;
    match engine {
        "claude" => policy.claude.resolve(engine, requested),
        "codex" => policy.codex.resolve(engine, requested),
        "agy" => policy.agy.resolve(engine, requested),
        "cursor" => policy.cursor.resolve(engine, requested),
        _ => Err("Child tasks support local Claude, Codex, AGY and Cursor chats only".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings(policy: serde_json::Value, defaults: serde_json::Value) -> AppSettings {
        serde_json::from_value(json!({"leaderAllowedModels":policy,"defaultModels":defaults}))
            .unwrap()
    }

    #[test]
    fn legacy_policy_preserves_explicit_and_engine_defaults() {
        let settings = settings(json!({}), json!({"claude":"sonnet","codex":" "}));
        assert_eq!(
            resolve(&settings, "claude", Some("custom-id"))
                .unwrap()
                .as_deref(),
            Some("custom-id")
        );
        assert_eq!(
            resolve(&settings, "claude", None).unwrap().as_deref(),
            Some("sonnet")
        );
        assert_eq!(resolve(&settings, "codex", None).unwrap(), None);
        assert_eq!(
            serde_json::to_value(snapshot(&settings).unwrap()).unwrap(),
            json!({
                "claude":{"allowedModels":null,"defaultModel":"sonnet"},
                "codex":{"allowedModels":null,"defaultModel":null},
                "agy":{"allowedModels":null,"defaultModel":null},
                "cursor":{"allowedModels":null,"defaultModel":null}
            })
        );
    }

    #[test]
    fn restricted_policy_permits_exact_ids_and_rejects_alias_equivalence() {
        let settings = settings(json!({"claude":["sonnet","claude-opus-4-6"]}), json!({}));
        assert_eq!(
            resolve(&settings, "claude", Some("sonnet"))
                .unwrap()
                .as_deref(),
            Some("sonnet")
        );
        for denied in ["claude-sonnet-4-6", "Sonnet", " sonnet ", "opus"] {
            let error = resolve(&settings, "claude", Some(denied)).unwrap_err();
            assert!(error.contains("not allowed"));
            assert!(error.contains("[\"sonnet\",\"claude-opus-4-6\"]"));
        }
    }

    #[test]
    fn omitted_model_uses_allowed_default_then_ordered_fallback() {
        let mut settings = settings(
            json!({"codex":["gpt-first","gpt-default"]}),
            json!({"codex":"gpt-default"}),
        );
        assert_eq!(
            resolve(&settings, "codex", None).unwrap().as_deref(),
            Some("gpt-default")
        );
        settings.default_models.insert("codex".into(), " gpt-default\n".into());
        assert_eq!(
            resolve(&settings, "codex", None).unwrap().as_deref(),
            Some("gpt-default")
        );
        settings
            .default_models
            .insert("codex".into(), "denied".into());
        assert_eq!(
            resolve(&settings, "codex", None).unwrap().as_deref(),
            Some("gpt-first")
        );
        settings.default_models.clear();
        assert_eq!(
            resolve(&settings, "codex", None).unwrap().as_deref(),
            Some("gpt-first")
        );
    }

    #[test]
    fn disabled_engine_rejects_explicit_and_omitted_models() {
        let settings = settings(json!({"claude":[]}), json!({"claude":"sonnet"}));
        for requested in [None, Some("sonnet")] {
            let error = resolve(&settings, "claude", requested).unwrap_err();
            assert!(error.contains("disabled for claude"));
            assert!(error.contains("allowed models: []"));
        }
        assert_eq!(
            resolve(&settings, "codex", Some("custom-id"))
                .unwrap()
                .as_deref(),
            Some("custom-id")
        );
    }

    #[test]
    fn agy_policy_preserves_exact_variants_defaults_and_disable() {
        let mut settings = settings(
            json!({"agy":["gemini-3.8-flash-high","claude-opus-4-6"]}),
            json!({"agy":"claude-opus-4-6"}),
        );
        assert_eq!(resolve(&settings, "agy", None).unwrap().as_deref(), Some("claude-opus-4-6"));
        assert_eq!(resolve(&settings, "agy", Some("gemini-3.8-flash-high")).unwrap().as_deref(), Some("gemini-3.8-flash-high"));
        assert!(resolve(&settings, "agy", Some("gemini-3.8-flash")).unwrap_err().contains("not allowed"));
        settings.default_models.insert("agy".into(), "outside-policy".into());
        assert_eq!(resolve(&settings, "agy", None).unwrap().as_deref(), Some("gemini-3.8-flash-high"));
        settings.leader_allowed_models.insert("agy".into(), vec![]);
        assert!(resolve(&settings, "agy", None).unwrap_err().contains("disabled for agy"));
        assert!(resolve(&settings, "agy", Some("claude-opus-4-6")).is_err());
        settings.leader_allowed_models.remove("agy");
        assert_eq!(resolve(&settings, "agy", Some("custom-model")).unwrap().as_deref(), Some("custom-model"));
    }

    #[test]
    fn response_defaults_match_resolver_and_fail_closed_on_invalid_policy() {
        for (models, app_default) in [
            (json!({}), json!({})),
            (json!({}), json!({"claude":"sonnet"})),
            (json!({"claude":[],"codex":[]}), json!({"claude":"sonnet"})),
            (
                json!({"claude":["sonnet","opus"],"codex":["gpt-first"]}),
                json!({"claude":"opus","codex":"denied"}),
            ),
        ] {
            let settings = settings(models, app_default);
            let response = serde_json::to_value(snapshot(&settings).unwrap()).unwrap();
            for engine in ["claude", "codex", "agy", "cursor"] {
                let expected = resolve(&settings, engine, None).ok().flatten();
                assert_eq!(response[engine]["defaultModel"], json!(expected));
            }
        }
        let invalid = settings(json!({"claude":["valid", ""]}), json!({}));
        assert!(snapshot(&invalid).is_err());
        assert!(resolve(&invalid, "codex", Some("anything")).is_err());
    }
}
