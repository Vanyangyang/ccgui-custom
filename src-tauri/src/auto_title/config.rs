use crate::settings::AppSettings;
use serde::{Deserialize, Deserializer, Serialize};

pub(super) const DEFAULT_MODEL: &str = "sonnet";
pub(super) const DEFAULT_EFFORT: &str = "xhigh";
pub(super) const DEFAULT_ENGINE: &str = "claude";

/// A malformed naming field must not discard unrelated application settings.
pub(crate) fn optional_string<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    let value = serde_json::Value::deserialize(d)?;
    Ok(value.as_str().map(str::to_string))
}

pub(crate) fn normalize(settings: &mut AppSettings) {
    if let Some(engine) = settings.auto_title_engine.take() {
        let engine = engine.trim();
        // Preserve a saved source even if this version cannot call it. The
        // dispatcher must refuse it, rather than send its data to Claude.
        settings.auto_title_engine = (!engine.is_empty()).then(|| engine.to_string());
    }
    let engine = settings.auto_title_engine.as_deref().unwrap_or(DEFAULT_ENGINE);
    if let Some(model) = settings.auto_title_model.take() {
        let model = model.trim();
        let known = if engine == "claude" {
            crate::engine::models::is_claude_alias(model)
            || settings.custom_models.get(engine).is_some_and(|ids| {
                ids.iter()
                    .any(|id| id.trim() == model && valid_custom_id(model))
            })
        } else {
            valid_custom_id(model)
        };
        settings.auto_title_model = if known {
            Some(model.to_string())
        } else if engine == "claude" {
            Some(DEFAULT_MODEL.to_string())
        } else {
            None
        };
    }
    if let Some(effort) = settings.auto_title_effort.take() {
        let effort = effort.trim();
        let effort = if engine == "claude" {
            crate::engine::claude::normalize_effort(effort).unwrap_or(DEFAULT_EFFORT)
        } else if engine == "pi" && effort == "ultra" {
            "max"
        } else if matches!(effort, "low" | "medium" | "high" | "xhigh" | "max" | "ultra") {
            effort
        } else {
            "low"
        };
        settings.auto_title_effort = Some(effort.to_string());
    }
}

fn valid_custom_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && !id.chars().any(char::is_whitespace)
        && !id.chars().any(char::is_control)
        && !id.starts_with('-')
}

#[derive(Clone, Debug)]
pub(crate) struct NamingConfig {
    pub engine: String,
    pub model: String,
    pub effort: String,
}

impl NamingConfig {
    pub fn from_settings(settings: &AppSettings) -> Self {
        // Also validate at the request boundary, for callers holding a snapshot.
        let mut settings = settings.clone();
        normalize(&mut settings);
        let engine = settings.auto_title_engine.unwrap_or_else(|| DEFAULT_ENGINE.into());
        Self {
            model: settings
                .auto_title_model
                .unwrap_or_else(|| if engine == "claude" { DEFAULT_MODEL.into() } else { String::new() }),
            effort: settings
                .auto_title_effort
                .unwrap_or_else(|| if engine == "claude" { DEFAULT_EFFORT.into() } else { "low".into() }),
            engine,
        }
    }

    pub fn request<'a>(
        &'a self,
        input: &'a str,
        schema: &'a serde_json::Value,
    ) -> crate::engine::side_call::StructuredCall<'a> {
        crate::engine::side_call::StructuredCall {
            system_prompt: super::PROMPT,
            input,
            json_schema: schema,
            model: &self.model,
            effort: &self.effort,
            timeout: super::MODEL_TIMEOUT,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamingModel {
    pub engine: String,
    pub provider: String,
    pub id: String,
    pub name: String,
    pub resolved_model: Option<String>,
    pub supports_effort: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort_levels: Option<Vec<String>>,
}

pub(super) async fn models(settings: &AppSettings) -> Result<Vec<NamingModel>, String> {
    let engines = crate::engine::list_engines().await?;
    let available = |id: &str| engines.iter().any(|engine| engine.id == id && engine.available && engine.enabled);
    let mut models = Vec::new();
    if available("claude") {
        models.extend(claude_models(settings)?);
    }
    if available("codex") {
        let catalog = crate::engine::models::local_catalog("codex").await?;
        for model in catalog.models {
            if !valid_custom_id(&model.id) { continue; }
            models.push(NamingModel {
                engine: "codex".into(),
                provider: if model.id.starts_with("gpt-") { "OpenAI" } else { "codex" }.into(),
                name: model.name.unwrap_or_else(|| model.id.clone()),
                resolved_model: Some(model.id.clone()),
                id: model.id,
                supports_effort: true,
                effort_levels: None,
            });
        }
    }
    if available("pi") {
        // A failed optional probe cannot erase the other sources' directory.
        match crate::engine::models::pi_naming_catalog().await {
            Ok(catalog) => {
                models.extend(catalog.into_iter().filter_map(|(model, supports_effort)| {
                    valid_custom_id(&model.id).then(|| NamingModel {
                        engine: "pi".into(),
                        provider: model.provider,
                        name: model.name.unwrap_or_else(|| model.id.clone()),
                        resolved_model: Some(model.id.clone()),
                        id: model.id,
                        supports_effort,
                        effort_levels: Some(["low", "medium", "high", "xhigh", "max"].into_iter().map(str::to_string).collect()),
                    })
                }));
            }
            Err(_) => eprintln!("[auto-title] pi naming catalog unavailable"),
        }
    }
    Ok(models)
}

fn claude_models(settings: &AppSettings) -> Result<Vec<NamingModel>, String> {
    let provider = crate::config::resolve_provider("claude", None)?;
    let env = provider
        .as_ref()
        .map(|p| crate::provider_files::channel_env("claude", p))
        .transpose()?
        .unwrap_or_default();
    let mut catalog = crate::engine::models::claude_catalog().models;
    for id in settings.custom_models.get("claude").into_iter().flatten() {
        let id = id.trim();
        if valid_custom_id(id) && !catalog.iter().any(|m| m.id == id) {
            catalog.push(crate::engine::models::EngineModel {
                id: id.into(),
                name: None,
                description: None,
                provider: "claude".into(),
                context_window: None,
            });
        }
    }
    Ok(catalog
        .into_iter()
        .map(|model| {
            let resolved =
                crate::engine::side_call::resolve_model(&model.id, provider.as_ref(), &env);
            let name = model.name.unwrap_or_else(|| model.id.clone());
            let name = match resolved.as_deref() {
                Some(actual) if actual != model.id && actual != name => {
                    format!("{name} · {actual}")
                }
                _ => name,
            };
            NamingModel {
                engine: "claude".into(),
                provider: model.provider,
                supports_effort: resolved
                    .as_deref()
                    .is_some_and(crate::engine::side_call::model_supports_effort),
                name,
                id: model.id,
                resolved_model: resolved,
                effort_levels: None,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effort_defaults_are_engine_specific_and_preserve_explicit_choices() {
        for engine in ["claude", "codex", "pi"] {
            for saved in [None, Some("invalid"), Some("low"), Some("high")] {
                let settings = AppSettings {
                    auto_title_engine: Some(engine.into()),
                    auto_title_effort: saved.map(str::to_string),
                    ..Default::default()
                };
                let expected = match saved {
                    Some("low") => "low",
                    Some("high") => "high",
                    _ if engine == "claude" => "xhigh",
                    _ => "low",
                };
                assert_eq!(NamingConfig::from_settings(&settings).effort, expected);
            }
        }
    }

    #[test]
    fn legacy_invalid_and_explicit_disabled_settings_keep_chat_preferences() {
        for raw in [
            serde_json::json!({}),
            serde_json::json!({"autoTitleEnabled": false}),
            serde_json::json!({"autoTitleEnabled": false, "autoTitleModel": "bogus", "autoTitleEffort": "bogus"}),
            serde_json::json!({"autoTitleEnabled": false, "autoTitleModel": 42, "autoTitleEffort": []}),
            serde_json::json!({"autoTitleEnabled": false, "autoTitleModel": null, "autoTitleEffort": null}),
        ] {
            let mut raw = raw;
            raw["defaultModels"] = serde_json::json!({"claude": "opus"});
            raw["defaultEfforts"] = serde_json::json!({"claude": "max"});
            let mut settings: AppSettings = serde_json::from_value(raw).unwrap();
            normalize(&mut settings);
            let config = NamingConfig::from_settings(&settings);
            assert_eq!(config.model, "sonnet");
            assert_eq!(config.effort, "xhigh");
            assert_ne!(settings.auto_title_enabled, Some(true));
            assert_eq!(settings.default_models["claude"], "opus");
            assert_eq!(settings.default_efforts["claude"], "max");
        }
    }

    #[test]
    fn valid_custom_models_and_legacy_ultra_survive_round_trip() {
        let mut settings = AppSettings {
            auto_title_enabled: Some(false),
            auto_title_model: Some(" relay-model ".into()),
            auto_title_effort: Some(" ultra ".into()),
            custom_models: std::collections::HashMap::from([(
                "claude".into(),
                vec!["relay-model".into()],
            )]),
            ..Default::default()
        };
        normalize(&mut settings);
        let reopened: AppSettings =
            serde_json::from_str(&serde_json::to_string(&settings).unwrap()).unwrap();
        let config = NamingConfig::from_settings(&reopened);
        assert_eq!(config.model, "relay-model");
        assert_eq!(config.effort, "max");
        assert_eq!(reopened.auto_title_enabled, Some(false));
        settings.auto_title_model = Some("--bad-flag".into());
        settings
            .custom_models
            .get_mut("claude")
            .unwrap()
            .push("--bad-flag".into());
        assert_eq!(NamingConfig::from_settings(&settings).model, "sonnet");
    }

    #[test]
    fn source_and_model_round_trip_without_changing_chat_preferences() {
        let settings = AppSettings {
            auto_title_enabled: Some(false),
            auto_title_engine: Some("codex".into()),
            auto_title_model: Some("gpt-6.1-sol".into()),
            auto_title_effort: Some("ultra".into()),
            default_models: std::collections::HashMap::from([("claude".into(), "opus".into())]),
            default_efforts: std::collections::HashMap::from([("codex".into(), "high".into())]),
            ..Default::default()
        };
        let reopened: AppSettings = serde_json::from_str(&serde_json::to_string(&settings).unwrap()).unwrap();
        let config = NamingConfig::from_settings(&reopened);
        assert_eq!(config.engine, "codex");
        assert_eq!(config.model, "gpt-6.1-sol");
        assert_eq!(config.effort, "ultra");
        assert_eq!(reopened.auto_title_enabled, Some(false));
        assert_eq!(reopened.default_models["claude"], "opus");
        assert_eq!(reopened.default_efforts["codex"], "high");
    }

    #[test]
    fn malformed_source_fields_preserve_unrelated_settings() {
        let mut settings: AppSettings = serde_json::from_value(serde_json::json!({
            "autoTitleEngine": ["codex"], "autoTitleModel": 7,
            "defaultModels": {"codex": "gpt-6.1-sol"}
        })).unwrap();
        normalize(&mut settings);
        assert_eq!(NamingConfig::from_settings(&settings).engine, "claude");
        assert_eq!(settings.default_models["codex"], "gpt-6.1-sol");
        settings.auto_title_engine = Some("codex".into());
        settings.auto_title_model = Some("--unsafe".into());
        normalize(&mut settings);
        assert_eq!(settings.auto_title_engine.as_deref(), Some("codex"));
        assert!(settings.auto_title_model.is_none());
        settings.auto_title_engine = Some("retired-source".into());
        settings.auto_title_model = Some("saved-model".into());
        let config = NamingConfig::from_settings(&settings);
        assert_eq!(config.engine, "retired-source");
        assert_eq!(config.model, "saved-model");
        settings.auto_title_engine = Some("pi".into());
        settings.auto_title_effort = Some("ultra".into());
        assert_eq!(NamingConfig::from_settings(&settings).effort, "max");
    }
}
