//! User-adjustable completion audio preferences.
//!
//! Stored apart from `assistant-notices.json`: that file rejects unknown fields,
//! so adding these there would make an older build lose every notice setting
//! after a rollback. Reads here are lenient for the same reason; writes are
//! validated strictly.
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::Path};

use super::ENGINES;

/// Built-in chimes, including the unknown-engine fallback.
pub(crate) const CHIME_COUNT: u8 = 13;
const MAX_REVISION: u64 = 9_007_199_254_740_991;

/// (Chinese voice, English voice, pitch %, rate %), indexed like `ENGINES`
/// with the unknown-engine fallback last. Names match installed voices by
/// substring, e.g. "Kangkang" matches "Microsoft Kangkang".
pub(crate) const VOICE_DEFAULTS: [(&str, &str, u16, u16); 13] = [
    ("Huihui", "Zira", 100, 100),    // claude
    ("Kangkang", "David", 100, 105), // codex
    ("Kangkang", "Mark", 85, 100),   // grok
    ("Yaoyao", "Zira", 120, 110),    // kimi
    ("Yaoyao", "Zira", 110, 100),    // pi
    ("Kangkang", "Mark", 110, 100),  // omp
    ("Huihui", "David", 90, 95),     // dsh
    ("Yaoyao", "Zira", 115, 100),    // agy
    ("Kangkang", "Mark", 80, 110),   // cursor
    ("Huihui", "David", 105, 100),   // opencode
    ("Yaoyao", "Zira", 95, 100),     // qoder
    ("Huihui", "Zira", 110, 100),    // qoder-cn
    ("Huihui", "Zira", 100, 100),    // unknown
];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackMode {
    #[default]
    ChimeAndVoice,
    ChimeOnly,
    VoiceOnly,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EngineAudio {
    pub chime: u8,
    /// Installed voice display name; empty follows the engine's default for the UI language.
    pub voice: String,
    pub pitch: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AudioSettings {
    pub mode: PlaybackMode,
    pub chime_volume: u16,
    pub voice_volume: u16,
    pub quiet_hours: bool,
    pub quiet_start: u16,
    pub quiet_end: u16,
    pub engines: BTreeMap<String, EngineAudio>,
}

pub(crate) fn engine_default(index: usize) -> EngineAudio {
    EngineAudio {
        chime: index.min(CHIME_COUNT as usize - 1) as u8,
        voice: String::new(),
        pitch: VOICE_DEFAULTS[index.min(12)].2,
    }
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            mode: PlaybackMode::ChimeAndVoice,
            chime_volume: 40,
            voice_volume: 80,
            quiet_hours: true,
            quiet_start: 22,
            quiet_end: 8,
            engines: ENGINES
                .iter()
                .enumerate()
                .map(|(index, engine)| (engine.to_string(), engine_default(index)))
                .collect(),
        }
    }
}

/// Voice names reach PowerShell only through environment variables and are
/// compared as data, never evaluated. The charset still excludes separators
/// and wildcard characters so matching stays exact and unambiguous.
pub(crate) fn valid_voice_name(name: &str) -> bool {
    name.chars().count() <= 96
        && name.trim() == name
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '.' | '_' | '(' | ')' | '-'))
}

fn valid_engine(audio: &EngineAudio) -> bool {
    audio.chime < CHIME_COUNT
        && (50..=150).contains(&audio.pitch)
        && audio.pitch.is_multiple_of(5)
        && valid_voice_name(&audio.voice)
}

impl AudioSettings {
    pub(crate) fn validate(&self) -> Result<(), String> {
        let volume = |value: u16| value <= 100 && value.is_multiple_of(5);
        if !volume(self.chime_volume)
            || !volume(self.voice_volume)
            || self.quiet_start > 23
            || self.quiet_end > 23
            || self.quiet_start == self.quiet_end
            || self
                .engines
                .iter()
                .any(|(engine, audio)| !ENGINES.contains(&engine.as_str()) || !valid_engine(audio))
        {
            return Err("invalid_audio_settings".into());
        }
        Ok(())
    }

    /// Engines omitted from a saved or submitted file keep their defaults.
    pub(crate) fn engine(&self, index: usize) -> EngineAudio {
        ENGINES
            .get(index)
            .and_then(|engine| self.engines.get(*engine))
            .cloned()
            .unwrap_or_else(|| engine_default(index))
    }

    pub(crate) fn quiet(&self, hour: u16) -> bool {
        if !self.quiet_hours {
            false
        } else if self.quiet_start < self.quiet_end {
            (self.quiet_start..self.quiet_end).contains(&hour)
        } else {
            hour >= self.quiet_start || hour < self.quiet_end
        }
    }

    pub(crate) fn speaks(&self) -> bool {
        self.mode != PlaybackMode::ChimeOnly && self.voice_volume > 0
    }
    pub(crate) fn chimes(&self) -> bool {
        self.mode != PlaybackMode::VoiceOnly && self.chime_volume > 0
    }

    /// Accept what a newer or hand-edited file can safely contribute, and fall
    /// back per field otherwise.
    fn from_lenient(value: &serde_json::Value) -> Self {
        let mut settings = Self::default();
        let Some(object) = value.as_object() else {
            return settings;
        };
        let number = |key: &str| {
            object
                .get(key)
                .and_then(|v| v.as_u64())
                .and_then(|v| u16::try_from(v).ok())
        };
        if let Some(mode) = object
            .get("mode")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
        {
            settings.mode = mode;
        }
        for (key, slot) in [
            ("chimeVolume", &mut settings.chime_volume),
            ("voiceVolume", &mut settings.voice_volume),
        ] {
            if let Some(value) = number(key).filter(|v| *v <= 100 && v.is_multiple_of(5)) {
                *slot = value;
            }
        }
        if let Some(enabled) = object.get("quietHours").and_then(|v| v.as_bool()) {
            settings.quiet_hours = enabled;
        }
        if let (Some(start), Some(end)) = (number("quietStart"), number("quietEnd")) {
            if start <= 23 && end <= 23 && start != end {
                settings.quiet_start = start;
                settings.quiet_end = end;
            }
        }
        if let Some(engines) = object.get("engines").and_then(|v| v.as_object()) {
            for (engine, value) in engines {
                let audio = serde_json::from_value::<EngineAudio>(value.clone());
                if let (true, Ok(audio)) = (ENGINES.contains(&engine.as_str()), audio) {
                    if valid_engine(&audio) {
                        settings.engines.insert(engine.clone(), audio);
                    }
                }
            }
        }
        settings
    }
}

#[derive(Serialize)]
struct PersistedRef<'a> {
    generation: u64,
    settings: &'a AudioSettings,
}

/// Missing or unreadable files yield defaults at revision 0, so the next
/// explicit save repairs them.
pub(crate) fn load(path: &Path) -> (AudioSettings, u64) {
    let Ok(bytes) = std::fs::read(path) else {
        return (AudioSettings::default(), 0);
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return (AudioSettings::default(), 0);
    };
    let generation = value
        .get("generation")
        .and_then(|v| v.as_u64())
        .filter(|v| *v <= MAX_REVISION)
        .unwrap_or(0);
    let settings = value
        .get("settings")
        .map(AudioSettings::from_lenient)
        .unwrap_or_default();
    (settings, generation)
}

pub(crate) fn save(path: &Path, settings: &AudioSettings, generation: u64) -> Result<(), String> {
    settings.validate()?;
    if !(1..=MAX_REVISION).contains(&generation) {
        return Err("invalid_audio_settings".into());
    }
    let json = serde_json::to_string(&PersistedRef {
        generation,
        settings,
    })
    .map_err(|_| "invalid_audio_settings")?;
    crate::settings::atomic_write(path, &json).map_err(|_| "storage_unavailable".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_reproduce_the_fixed_policy_and_cover_every_engine() {
        let settings = AudioSettings::default();
        settings.validate().unwrap();
        assert_eq!(settings.engines.len(), ENGINES.len());
        for (index, engine) in ENGINES.iter().enumerate() {
            assert_eq!(settings.engines[*engine].chime as usize, index);
            assert_eq!(settings.engine(index).pitch, VOICE_DEFAULTS[index].2);
        }
        assert_eq!(settings.engine(12), engine_default(12));
        for hour in 0..24 {
            assert_eq!(
                settings.quiet(hour),
                !(8..22).contains(&hour),
                "hour {hour}"
            );
        }
        assert!(settings.speaks() && settings.chimes());
    }

    #[test]
    fn quiet_hours_handle_daytime_ranges_wraparound_and_off() {
        let mut settings = AudioSettings {
            quiet_start: 13,
            quiet_end: 14,
            ..AudioSettings::default()
        };
        assert!(!settings.quiet(12) && settings.quiet(13) && !settings.quiet(14));
        settings.quiet_start = 23;
        settings.quiet_end = 1;
        assert!(settings.quiet(23) && settings.quiet(0) && !settings.quiet(1));
        settings.quiet_hours = false;
        assert!((0..24).all(|hour| !settings.quiet(hour)));
    }

    #[test]
    fn writes_reject_out_of_range_values_unknown_engines_and_unsafe_voice_names() {
        let base = AudioSettings::default();
        let invalid = [
            AudioSettings {
                chime_volume: 101,
                ..base.clone()
            },
            AudioSettings {
                voice_volume: 33,
                ..base.clone()
            },
            AudioSettings {
                quiet_start: 8,
                quiet_end: 8,
                ..base.clone()
            },
            AudioSettings {
                quiet_end: 24,
                ..base.clone()
            },
        ];
        for settings in invalid {
            assert!(settings.validate().is_err(), "{settings:?}");
        }
        for (field, audio) in [
            (
                "chime",
                EngineAudio {
                    chime: 13,
                    ..engine_default(0)
                },
            ),
            (
                "pitch",
                EngineAudio {
                    pitch: 45,
                    ..engine_default(0)
                },
            ),
            (
                "pitch step",
                EngineAudio {
                    pitch: 101,
                    ..engine_default(0)
                },
            ),
        ] {
            let mut settings = base.clone();
            settings.engines.insert("claude".into(), audio);
            assert!(settings.validate().is_err(), "{field}");
        }
        for voice in [
            "a|b",
            "*",
            "Mi$crosoft",
            "x\ny",
            " lead",
            "[Huihui]",
            &"v".repeat(97),
        ] {
            let mut settings = base.clone();
            settings.engines.insert(
                "codex".into(),
                EngineAudio {
                    voice: voice.into(),
                    ..engine_default(1)
                },
            );
            assert!(settings.validate().is_err(), "{voice:?}");
        }
        let mut settings = base.clone();
        settings
            .engines
            .insert("unknown-engine".into(), engine_default(0));
        assert!(settings.validate().is_err());
        let mut settings = base;
        settings.engines.insert(
            "codex".into(),
            EngineAudio {
                voice: "Microsoft Kangkang".into(),
                chime: 12,
                pitch: 150,
            },
        );
        settings.engines.remove("grok");
        settings.validate().unwrap();
        assert_eq!(settings.engine(2), engine_default(2));
    }

    #[test]
    fn reads_keep_valid_fields_and_ignore_newer_or_damaged_ones() {
        let dir = std::env::temp_dir().join(format!("completion-audio-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("completion-audio.json");
        assert_eq!(load(&path), (AudioSettings::default(), 0));
        std::fs::write(&path, b"{not json").unwrap();
        assert_eq!(load(&path), (AudioSettings::default(), 0));
        std::fs::write(
            &path,
            r#"{"generation":4,"futureEnvelope":true,"settings":{"mode":"voiceOnly","chimeVolume":250,
            "voiceVolume":60,"quietHours":false,"quietStart":3,"quietEnd":3,"futureField":1,
            "engines":{"codex":{"chime":5,"voice":"Microsoft Mark","pitch":90},
            "claude":{"chime":99,"voice":"","pitch":100},"nope":{"chime":1,"voice":"","pitch":100}}}}"#,
        )
        .unwrap();
        let (settings, revision) = load(&path);
        assert_eq!(revision, 4);
        assert_eq!(settings.mode, PlaybackMode::VoiceOnly);
        assert_eq!((settings.chime_volume, settings.voice_volume), (40, 60));
        assert!(!settings.quiet_hours);
        assert_eq!((settings.quiet_start, settings.quiet_end), (22, 8));
        assert_eq!(settings.engine(1).voice, "Microsoft Mark");
        assert_eq!(settings.engine(0), engine_default(0));
        assert!(!settings.engines.contains_key("nope"));
        settings.validate().unwrap();
        assert!(!settings.chimes() && settings.speaks());

        save(&path, &settings, 5).unwrap();
        assert_eq!(load(&path), (settings.clone(), 5));
        assert!(save(&path, &settings, 0).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
