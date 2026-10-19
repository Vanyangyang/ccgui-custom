//! Explicit isolated inference routes. Configuration probes never start a process or network request.
use super::{
    config::{self, Config},
    policy::Snapshot,
};
use crate::engine::{
    agy_vertex::observer as vertex,
    side_call::{self, SideCallError, StructuredCall},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path, time::Duration};

pub(super) struct Selection {
    pub engine: String,
    pub model: String,
    pub effort: String,
    pub fingerprint: [u8; 32],
}

pub(super) fn source_engines() -> Vec<String> {
    crate::config::read_config()
        .map(|config| enabled_sources(&config))
        .unwrap_or_default()
}

fn enabled_sources(config: &crate::config::CliConfig) -> Vec<String> {
    crate::config::ENGINES
        .iter()
        .filter(|engine| {
            config.section(engine).is_some_and(|section| {
                section.current.as_deref() != Some(crate::config::DISABLED_PROVIDER_ID)
            })
        })
        .map(|engine| (*engine).to_string())
        .collect()
}

/// Follow CCGUI's current channel, without invoking resolve_provider's native-file migration.
fn selected_channel<'a>(
    config: &'a crate::config::CliConfig,
    engine: &str,
) -> Result<Option<&'a Value>, SideCallError> {
    let section = config.section(engine).ok_or(SideCallError::Unavailable)?;
    let selected = section.current.as_deref().unwrap_or("").trim();
    match selected {
        crate::config::DISABLED_PROVIDER_ID => Err(SideCallError::Unavailable),
        "" | crate::config::LOCAL_PROVIDER_ID | crate::config::LEGACY_LOCAL_CONFIG_TOML_ID => {
            Ok(None)
        }
        _ => crate::config::find_provider(section, selected)
            .map_err(|_| SideCallError::Unavailable)?
            .map(|(_, provider)| Some(provider))
            .ok_or(SideCallError::Unavailable),
    }
}

pub(super) fn configured(config: &Config) -> bool {
    selection(config).is_ok()
}

pub(super) fn selection(config: &Config) -> Result<Selection, SideCallError> {
    config.validate().map_err(|_| SideCallError::Unavailable)?;
    if config.observer_engine == config::VERTEX_ENGINE {
        return Ok(Selection {
            engine: config.observer_engine.clone(),
            model: config.observer_model.clone(),
            effort: config.observer_effort.clone(),
            fingerprint: vertex::configuration_fingerprint().ok_or(SideCallError::Unavailable)?,
        });
    }
    let app_config = crate::config::read_config().map_err(|_| SideCallError::Unavailable)?;
    let provider = selected_channel(&app_config, &config.observer_engine)?;
    let settings = crate::settings::read_settings().map_err(|_| SideCallError::Unavailable)?;
    let bin = crate::engine::engine_bin(&settings, &config.observer_engine);
    // Bare names may resolve from the app's normal CLI search paths. Explicit paths
    // never fall through to another installed executable when their file disappears.
    let executable = if Path::new(&bin).components().count() > 1 || Path::new(&bin).is_absolute() {
        Path::new(&bin).is_file()
    } else {
        crate::engine::resolve::find_cli_binary(&bin, None).is_some()
    };
    if !executable {
        return Err(SideCallError::Unavailable);
    }
    let env: BTreeMap<_, _> = provider
        .map(|value| crate::provider_files::channel_env(&config.observer_engine, value))
        .transpose()
        .map_err(|_| SideCallError::Unavailable)?
        .unwrap_or_default()
        .into_iter()
        .collect();
    let model = if config.observer_model.is_empty() {
        settings
            .default_models
            .get(&config.observer_engine)
            .cloned()
            .unwrap_or_default()
    } else {
        config.observer_model.clone()
    };
    if !config::valid_model(&model) {
        return Err(SideCallError::Unavailable);
    }
    let effort = if config.observer_engine == "claude" && config.observer_effort == "ultra" {
        "max".to_string()
    } else {
        config.observer_effort.clone()
    };
    let routing = serde_json::to_vec(&(
        &config.observer_engine,
        &model,
        &effort,
        &bin,
        provider,
        env,
        &settings.codex_home,
        &settings.system_proxy_enabled,
        &settings.system_proxy_url,
    ))
    .map_err(|_| SideCallError::Unavailable)?;
    Ok(Selection {
        engine: config.observer_engine.clone(),
        model,
        effort,
        fingerprint: Sha256::digest(routing).into(),
    })
}

fn schema() -> Value {
    json!({"type":"object","properties":{"thought":{"anyOf":[{"type":"null"},{"type":"object","properties":{"tease":{"type":"string"},"body":{"type":"string"}},"required":["tease","body"],"additionalProperties":false}]}},"required":["thought"],"additionalProperties":false})
}

pub(super) async fn generate(
    selection: &Selection,
    locale: &str,
    snapshot: &Snapshot,
) -> Result<Option<Value>, SideCallError> {
    if !matches!(locale, "zh-CN" | "en") {
        return Err(SideCallError::BadOutput);
    }
    let brief = json!({"provider":selection.engine,"locale":locale,"snapshot":snapshot});
    match selection.engine.as_str() {
        config::VERTEX_ENGINE => vertex::generate(&brief).await,
        "claude" | "codex" | "pi" => {
            // Source IDs, tickets, routing and credentials are never sent as model input.
            let input = serde_json::to_string(&json!({"locale":locale,"snapshot":snapshot}))
                .map_err(|_| SideCallError::BadOutput)?;
            if input.len() > 16 * 1024 {
                return Err(SideCallError::BadOutput);
            }
            let schema = schema();
            let output = side_call::structured(
                &selection.engine,
                StructuredCall {
                    provider_id: None,
                    system_prompt: vertex::INSTRUCTIONS,
                    input: &input,
                    json_schema: &schema,
                    model: &selection.model,
                    effort: &selection.effort,
                    timeout: Duration::from_secs(60),
                },
            )
            .await?;
            vertex::parse_decision(&output.structured)
        }
        _ => Err(SideCallError::Unavailable),
    }
}

pub(super) fn failure_code(error: SideCallError) -> &'static str {
    match error {
        SideCallError::Unavailable => "observer_unavailable",
        SideCallError::Timeout => "observer_timeout",
        SideCallError::BadOutput => "observer_bad_output",
        SideCallError::Failed => "observer_failed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_enabled_source_engines_are_reported_independently_of_inference_support() {
        let mut config = crate::config::CliConfig::default();
        assert_eq!(
            enabled_sources(&config),
            crate::config::ENGINES
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
        );
        for engine in crate::config::ENGINES {
            config.section_mut(engine).unwrap().current =
                Some(crate::config::DISABLED_PROVIDER_ID.into());
            assert!(!enabled_sources(&config).iter().any(|s| s == engine));
        }
        assert!(enabled_sources(&config).is_empty());
    }

    #[test]
    fn selected_channels_never_fall_back_from_a_disabled_missing_or_unknown_route() {
        let mut config = crate::config::CliConfig::default();
        assert!(selected_channel(&config, "claude").unwrap().is_none());
        for current in ["missing", crate::config::DISABLED_PROVIDER_ID] {
            config.claude.current = Some(current.into());
            assert!(selected_channel(&config, "claude").is_err());
        }
        assert!(selected_channel(&config, "unknown").is_err());
        config.claude.current = Some("chosen".into());
        config
            .claude
            .providers
            .insert("chosen".into(), json!({"name":"selected"}));
        assert_eq!(
            selected_channel(&config, "claude").unwrap().unwrap()["name"],
            "selected"
        );
    }

    #[tokio::test]
    async fn unsupported_inference_source_is_rejected_without_fallback() {
        let snapshot = Snapshot {
            checkpoint_id: "c".into(),
            project: "p".into(),
            goal: "g".into(),
            change: "x".into(),
            facts: vec![],
        };
        let selection = Selection {
            engine: "cursor".into(),
            model: "m".into(),
            effort: "medium".into(),
            fingerprint: [0; 32],
        };
        assert!(matches!(
            generate(&selection, "en", &snapshot).await,
            Err(SideCallError::Unavailable)
        ));
    }
}
