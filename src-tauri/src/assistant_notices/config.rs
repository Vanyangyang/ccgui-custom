//! Persisted, app-owned notice preferences. Old four-switch files remain valid.
use serde::{Deserialize, Deserializer, Serialize};
use std::path::Path;

pub(super) const MAX_GENERATION: u64 = 9_007_199_254_740_991;
pub(super) const VERTEX_ENGINE: &str = "agy_vertex";
pub(super) const VERTEX_MODEL: &str = "gemini-4-argon";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum DisplayTarget {
    #[default]
    Active,
    Fixed {
        id: String,
        label: String,
    },
}

impl<'de> Deserialize<'de> for DisplayTarget {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // Internally tagged unit variants otherwise accept extra fields. A display
        // target is an exact wire shape, including for the fieldless active mode.
        let value = serde_json::Value::deserialize(deserializer)?;
        let invalid = || serde::de::Error::custom("invalid display target");
        let object = value.as_object().ok_or_else(invalid)?;
        match object.get("mode").and_then(|value| value.as_str()) {
            Some("active") if object.len() == 1 => Ok(Self::Active),
            Some("fixed") if object.len() == 3 => Ok(Self::Fixed {
                id: object
                    .get("id")
                    .and_then(|value| value.as_str())
                    .ok_or_else(invalid)?
                    .into(),
                label: object
                    .get("label")
                    .and_then(|value| value.as_str())
                    .ok_or_else(invalid)?
                    .into(),
            }),
            _ => Err(invalid()),
        }
    }
}

fn enabled() -> bool {
    true
}
fn percent() -> u16 {
    100
}
fn observer_engine() -> String {
    VERTEX_ENGINE.into()
}
fn observer_model() -> String {
    VERTEX_MODEL.into()
}
fn observer_effort() -> String {
    "medium".into()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub enabled: bool,
    pub observer_enabled: bool,
    pub paused: bool,
    pub focus_mode: bool,
    #[serde(default = "enabled")]
    pub voice_enabled: bool,
    #[serde(default)]
    pub display_target: DisplayTarget,
    #[serde(default = "percent")]
    pub body_text_percent: u16,
    #[serde(default = "percent")]
    pub title_text_percent: u16,
    #[serde(default = "percent")]
    pub interface_text_percent: u16,
    #[serde(default = "observer_engine")]
    pub observer_engine: String,
    #[serde(default = "observer_model")]
    pub observer_model: String,
    #[serde(default = "observer_effort")]
    pub observer_effort: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: true,
            observer_enabled: false,
            paused: false,
            focus_mode: false,
            voice_enabled: true,
            display_target: DisplayTarget::Active,
            body_text_percent: 100,
            title_text_percent: 100,
            interface_text_percent: 100,
            observer_engine: observer_engine(),
            observer_model: observer_model(),
            observer_effort: observer_effort(),
        }
    }
}

pub(super) fn valid_model(model: &str) -> bool {
    model.len() <= 256
        && !model.starts_with('-')
        && !model.chars().any(|c| c.is_control() || c.is_whitespace())
}

impl Config {
    pub(super) fn validate(&self) -> Result<(), String> {
        let valid_percent = |value, max| (80..=max).contains(&value) && value % 10 == 0;
        if !valid_percent(self.body_text_percent, 300)
            || !valid_percent(self.title_text_percent, 200)
            || !valid_percent(self.interface_text_percent, 200)
            || !valid_model(&self.observer_model)
        {
            return Err("invalid_config".into());
        }
        if let DisplayTarget::Fixed { id, label } = &self.display_target {
            if id.trim().is_empty()
                || id.len() > 512
                || id.chars().any(char::is_control)
                || label.chars().count() > 200
                || label.chars().any(char::is_control)
            {
                return Err("invalid_config".into());
            }
        }
        let valid_observer = match self.observer_engine.as_str() {
            VERTEX_ENGINE => {
                self.observer_model == VERTEX_MODEL && self.observer_effort == "medium"
            }
            "claude" => matches!(
                self.observer_effort.as_str(),
                "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
            ),
            "codex" => matches!(
                self.observer_effort.as_str(),
                "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
            ),
            "pi" => matches!(
                self.observer_effort.as_str(),
                "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
            ),
            _ => false,
        };
        if !valid_observer {
            return Err("invalid_observer_config".into());
        }
        Ok(())
    }
}

#[derive(Serialize)]
pub(super) struct Persisted {
    #[serde(flatten)]
    config: Config,
    pub(super) generation: u64,
}

impl<'de> Deserialize<'de> for Persisted {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // Flatten + deny_unknown_fields cannot enforce this envelope reliably. Remove only
        // our generation field, then let Config reject every unknown preference explicitly.
        let mut fields = serde_json::Map::<String, serde_json::Value>::deserialize(deserializer)?;
        let generation = fields
            .remove("generation")
            .and_then(|v| v.as_u64())
            .filter(|v| (1..=MAX_GENERATION).contains(v))
            .ok_or_else(|| serde::de::Error::custom("invalid_config"))?;
        let config: Config = serde_json::from_value(serde_json::Value::Object(fields))
            .map_err(serde::de::Error::custom)?;
        config.validate().map_err(serde::de::Error::custom)?;
        Ok(Self { config, generation })
    }
}

impl Persisted {
    pub(super) fn new(config: Config, generation: u64) -> Self {
        Self { config, generation }
    }
    pub(super) fn config(&self) -> Config {
        self.config.clone()
    }
}

pub(super) fn read_config(path: &Path) -> Result<Persisted, String> {
    read_config_with(path, super::legacy_preferences::read, |engine| {
        let settings =
            crate::settings::read_settings().map_err(|_| "legacy_preferences_unavailable")?;
        let model = settings
            .default_models
            .get(engine)
            .cloned()
            .unwrap_or_default();
        let effort = settings
            .default_efforts
            .get(engine)
            .cloned()
            .unwrap_or_else(|| "medium".into());
        Ok((model, effort))
    })
}

fn read_config_with(
    path: &Path,
    legacy: impl FnOnce() -> Result<Option<super::legacy_preferences::LegacyPreferences>, String>,
    defaults: impl FnOnce(&str) -> Result<(String, String), String>,
) -> Result<Persisted, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut config = Config::default();
            if let Some(legacy) = legacy()? {
                if let Some(enabled) = legacy.observer_enabled {
                    config.observer_enabled = enabled;
                }
                if let Some(paused) = legacy.paused {
                    config.paused = paused;
                }
                if let Some(enabled) = legacy.voice_enabled {
                    config.voice_enabled = enabled;
                }
                if let Some(target) = legacy.display_target {
                    config.display_target = match target {
                        super::legacy_preferences::LegacyDisplayTarget::Active => {
                            DisplayTarget::Active
                        }
                        super::legacy_preferences::LegacyDisplayTarget::Fixed { id, label } => {
                            DisplayTarget::Fixed { id, label }
                        }
                    };
                }
                if let Some(engine) = legacy.observer_engine {
                    if !matches!(engine.as_str(), "claude" | "codex") {
                        return Err("legacy_preferences_unavailable".into());
                    }
                    let (model, effort) = defaults(&engine)?;
                    config.observer_engine = engine;
                    config.observer_model = model;
                    config.observer_effort = effort;
                }
                config
                    .validate()
                    .map_err(|_| "legacy_preferences_unavailable")?;
                // A new native file is authoritative, including one saved while import was reading.
                if path.exists() {
                    let bytes = std::fs::read(path).map_err(|_| "storage_unavailable")?;
                    return decode_config(&bytes);
                }
                save_config(path, &config, 1)?;
            }
            return Ok(Persisted::new(config, 1));
        }
        Err(_) => return Err("storage_unavailable".into()),
    };
    decode_config(&bytes)
}

fn decode_config(bytes: &[u8]) -> Result<Persisted, String> {
    if bytes.len() > 8192 {
        return Err("invalid_config".into());
    }
    serde_json::from_slice(bytes).map_err(|_| "invalid_config".into())
}

pub(super) fn save_config(path: &Path, config: &Config, generation: u64) -> Result<(), String> {
    config.validate()?;
    if !(1..=MAX_GENERATION).contains(&generation) {
        return Err("invalid_config".into());
    }
    let json = serde_json::to_string(&Persisted::new(config.clone(), generation))
        .map_err(|_| "invalid_config")?;
    crate::settings::atomic_write(path, &json).map_err(|_| "storage_unavailable".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_switches_are_preserved_and_new_preferences_get_defaults() {
        let stored: Persisted = serde_json::from_str(r#"{"enabled":false,"observerEnabled":true,"paused":true,"focusMode":true,"generation":7}"#).unwrap();
        let config = stored.config();
        assert!(!config.enabled);
        assert!(config.observer_enabled && config.paused && config.focus_mode);
        assert!(config.voice_enabled);
        assert_eq!(config.display_target, DisplayTarget::Active);
        assert_eq!(
            (
                config.body_text_percent,
                config.title_text_percent,
                config.interface_text_percent
            ),
            (100, 100, 100)
        );
        assert_eq!(
            (
                &*config.observer_engine,
                &*config.observer_model,
                &*config.observer_effort
            ),
            (VERTEX_ENGINE, VERTEX_MODEL, "medium")
        );
        assert_eq!(stored.generation, 7);
    }

    #[test]
    fn new_preferences_round_trip_without_losing_revision() {
        let config = Config {
            voice_enabled: false,
            display_target: DisplayTarget::Fixed {
                id: "monitor-2".into(),
                label: "副屏".into(),
            },
            body_text_percent: 300,
            title_text_percent: 80,
            interface_text_percent: 170,
            observer_engine: "pi".into(),
            observer_model: String::new(),
            observer_effort: "high".into(),
            ..Config::default()
        };
        let encoded = serde_json::to_string(&Persisted::new(config.clone(), 13)).unwrap();
        let decoded: Persisted = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.config(), config);
        assert_eq!(decoded.generation, 13);
    }

    #[test]
    fn preferences_reject_wrong_types_unknown_fields_and_invalid_bounds() {
        let baseline = serde_json::to_value(Persisted::new(Config::default(), 1)).unwrap();
        for (key, value) in [
            ("voiceEnabled", serde_json::json!("true")),
            ("bodyTextPercent", serde_json::json!(79)),
            ("bodyTextPercent", serde_json::json!(310)),
            ("titleTextPercent", serde_json::json!(210)),
            ("interfaceTextPercent", serde_json::json!(105)),
            ("observerEngine", serde_json::json!("cursor")),
            ("observerModel", serde_json::json!("other-vertex-model")),
            ("observerEffort", serde_json::json!("high")),
            (
                "displayTarget",
                serde_json::json!({"mode":"fixed","id":"","label":"x"}),
            ),
            (
                "displayTarget",
                serde_json::json!({"mode":"active","id":"unexpected"}),
            ),
            ("generation", serde_json::json!(0)),
            ("endpoint", serde_json::json!("https://unexpected.invalid")),
        ] {
            let mut input = baseline.clone();
            input[key] = value;
            assert!(serde_json::from_value::<Persisted>(input).is_err(), "{key}");
        }
        for model in ["bad model".into(), "x".repeat(257), "--inject".into()] {
            let config = Config {
                observer_engine: "claude".into(),
                observer_model: model,
                ..Config::default()
            };
            assert!(config.validate().is_err());
        }
    }

    #[test]
    fn import_runs_once_and_existing_native_settings_always_win() {
        let root = std::env::temp_dir().join(format!("notice-config-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("config.json");
        let legacy = super::super::legacy_preferences::LegacyPreferences {
            observer_enabled: Some(true),
            observer_engine: Some("claude".into()),
            paused: Some(true),
            voice_enabled: Some(false),
            display_target: Some(
                super::super::legacy_preferences::LegacyDisplayTarget::Fixed {
                    id: "screen".into(),
                    label: "副屏".into(),
                },
            ),
        };
        let stored = read_config_with(
            &path,
            || Ok(Some(legacy)),
            |engine| {
                assert_eq!(engine, "claude");
                Ok(("sonnet".into(), "high".into()))
            },
        )
        .unwrap();
        assert!(stored.config().observer_enabled && stored.config().paused);
        assert!(!stored.config().voice_enabled);
        assert_eq!(stored.config().observer_model, "sonnet");
        assert_eq!(stored.config().observer_effort, "high");
        assert_eq!(stored.config().body_text_percent, 100);
        assert!(path.is_file());
        let reread = read_config_with(
            &path,
            || panic!("native settings must win"),
            |_| panic!("no import"),
        )
        .unwrap();
        assert_eq!(reread.config(), stored.config());
        std::fs::write(&path, r#"{"enabled":false,"observerEnabled":false,"paused":false,"focusMode":true,"generation":9}"#).unwrap();
        let old_native = read_config_with(
            &path,
            || panic!("old native switches must win too"),
            |_| panic!("no import"),
        )
        .unwrap();
        assert!(!old_native.config().enabled && old_native.config().focus_mode);
        assert_eq!(old_native.generation, 9);
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn failed_import_does_not_create_a_native_file_or_erase_retryability() {
        let root =
            std::env::temp_dir().join(format!("notice-import-failure-{}", uuid::Uuid::new_v4()));
        let path = root.join("config.json");
        let result = read_config_with(
            &path,
            || Err("legacy_preferences_unavailable".into()),
            |_| panic!("no defaults"),
        );
        assert!(matches!(result, Err(reason) if reason == "legacy_preferences_unavailable"));
        assert!(!path.exists());
        assert!(!root.exists());
    }
}
