//! One-time, read-only preference import. Never open the old runtime or load its
//! conversations, canvas, memory, credentials, hooks, or completion records.
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

const UNAVAILABLE: &str = "legacy_preferences_unavailable";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum LegacyDisplayTarget {
    Active,
    Fixed { id: String, label: String },
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct LegacyPreferences {
    pub observer_enabled: Option<bool>,
    pub observer_engine: Option<String>,
    pub paused: Option<bool>,
    pub voice_enabled: Option<bool>,
    pub display_target: Option<LegacyDisplayTarget>,
}

fn open(path: &Path) -> Result<Option<Connection>, String> {
    match std::fs::metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(UNAVAILABLE.into()),
        Ok(metadata) if !metadata.is_file() => return Err(UNAVAILABLE.into()),
        Ok(_) => {}
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| UNAVAILABLE)?;
    connection
        .busy_timeout(Duration::from_millis(250))
        .map_err(|_| UNAVAILABLE)?;
    Ok(Some(connection))
}

fn table(connection: &Connection, name: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
            [name],
            |row| row.get(0),
        )
        .map_err(|_| UNAVAILABLE.into())
}

fn boolean(kind: Option<String>, value: Option<i64>) -> Result<Option<bool>, String> {
    match (kind.as_deref(), value) {
        (None, None) => Ok(None),
        (Some("true"), Some(1)) => Ok(Some(true)),
        (Some("false"), Some(0)) => Ok(Some(false)),
        _ => Err(UNAVAILABLE.into()),
    }
}

fn display(raw: &str) -> Result<LegacyDisplayTarget, String> {
    if raw.len() > 4096 {
        return Err(UNAVAILABLE.into());
    }
    let value: serde_json::Value = serde_json::from_str(raw).map_err(|_| UNAVAILABLE)?;
    match value.get("mode").and_then(|v| v.as_str()) {
        Some("active" | "default") => Ok(LegacyDisplayTarget::Active),
        Some("fixed") => {
            let id = value
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or(UNAVAILABLE)?;
            let label = value
                .get("label")
                .and_then(|v| v.as_str())
                .ok_or(UNAVAILABLE)?;
            if id.is_empty()
                || id.len() > 512
                || label.len() > 512
                || id.chars().any(char::is_control)
                || label.chars().any(char::is_control)
            {
                return Err(UNAVAILABLE.into());
            }
            Ok(LegacyDisplayTarget::Fixed {
                id: id.into(),
                label: label.into(),
            })
        }
        _ => Err(UNAVAILABLE.into()),
    }
}

fn read_paths(state: &Path, completions: &Path) -> Result<Option<LegacyPreferences>, String> {
    let mut preferences = LegacyPreferences::default();
    let mut found = false;
    if let Some(connection) = open(state)? {
        let snapshot = connection
            .unchecked_transaction()
            .map_err(|_| UNAVAILABLE)?;
        if table(&connection, "spellcast_state")? {
            let metadata = snapshot
                .query_row(
                    "SELECT schema_version,length(value) FROM spellcast_state WHERE id=1",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()
                .map_err(|_| UNAVAILABLE)?;
            if metadata
                .is_some_and(|(version, size)| !(1..=4).contains(&version) || size > 134217728)
            {
                return Err(UNAVAILABLE.into());
            }
            // Extract only the three scalar preferences inside SQLite. In particular,
            // never return the state document (which also contains private user content).
            let row = connection.query_row(
                "SELECT schema_version, length(value),
                    json_type(value,'$.observer_enabled'), json_extract(value,'$.observer_enabled'),
                    json_type(value,'$.observer_provider'), json_extract(value,'$.observer_provider'),
                    json_type(value,'$.paused'), json_extract(value,'$.paused')
                 FROM spellcast_state WHERE id=1 AND length(value)<=134217728",
                [], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?,
                    row.get::<_, Option<String>>(2)?, row.get::<_, Option<i64>>(3)?,
                    row.get::<_, Option<String>>(4)?, row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?, row.get::<_, Option<i64>>(7)?)),
            ).optional().map_err(|_| UNAVAILABLE)?;
            if let Some((
                version,
                _,
                enabled_kind,
                enabled,
                provider_kind,
                provider,
                paused_kind,
                paused,
            )) = row
            {
                if !(1..=4).contains(&version) {
                    return Err(UNAVAILABLE.into());
                }
                preferences.observer_enabled = boolean(enabled_kind, enabled)?;
                preferences.paused = boolean(paused_kind, paused)?;
                preferences.observer_engine = match (provider_kind.as_deref(), provider.as_deref())
                {
                    (None, None) => Some("codex".into()),
                    (Some("text"), Some("claude" | "codex")) => provider,
                    _ => return Err(UNAVAILABLE.into()),
                };
                found = preferences.observer_enabled.is_some()
                    || preferences.paused.is_some()
                    || preferences.observer_engine.is_some();
            }
        }
    }
    if let Some(connection) = open(completions)? {
        if table(&connection, "completion_preferences")? {
            let voice: Option<i64> = connection
                .query_row(
                    "SELECT value FROM completion_preferences WHERE key='voice_enabled'",
                    [],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|_| UNAVAILABLE)?;
            preferences.voice_enabled = match voice {
                None => None,
                Some(0) => Some(false),
                Some(1) => Some(true),
                _ => return Err(UNAVAILABLE.into()),
            };
            found |= voice.is_some();
        }
        if table(&connection, "completion_text")? {
            let raw: Option<String> = connection.query_row(
                "SELECT value FROM completion_text WHERE key='display_target' AND length(value)<=4096", [], |row| row.get(0),
            ).optional().map_err(|_| UNAVAILABLE)?;
            preferences.display_target = raw.as_deref().map(display).transpose()?;
            found |= preferences.display_target.is_some();
        }
    }
    Ok(found.then_some(preferences))
}

#[cfg(not(test))]
pub(super) fn read() -> Result<Option<LegacyPreferences>, String> {
    let Some(home) = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
    else {
        return Ok(None);
    };
    let state = std::env::var_os("SPELLCAST_STATE_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".spellcast/spellcast.sqlite3"));
    let completions = std::env::var_os("SPELLCAST_COMPLETIONS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".codex"))
                .join("spellcast/completions")
        })
        .join("inbox.sqlite3");
    if !state.is_absolute() || !completions.is_absolute() {
        return Err(UNAVAILABLE.into());
    }
    read_paths(&state, &completions)
}

#[cfg(test)]
pub(super) fn read() -> Result<Option<LegacyPreferences>, String> {
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("ccgui-preference-import-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn imports_only_preferences_and_does_not_write_old_databases() {
        let scratch = Scratch::new();
        let state = scratch.0.join("state.sqlite");
        let completion = scratch.0.join("completion.sqlite");
        let connection = Connection::open(&state).unwrap();
        connection.execute_batch("CREATE TABLE spellcast_state(id INTEGER PRIMARY KEY, schema_version INTEGER, value TEXT);").unwrap();
        connection.execute("INSERT INTO spellcast_state VALUES(1,4,?1)", [r#"{"observer_enabled":true,"observer_provider":"claude","paused":false,"private_user_content":"not imported"}"#]).unwrap();
        drop(connection);
        let connection = Connection::open(&completion).unwrap();
        connection.execute_batch("CREATE TABLE completion_preferences(key TEXT PRIMARY KEY,value INTEGER); INSERT INTO completion_preferences VALUES('voice_enabled',0); CREATE TABLE completion_text(key TEXT PRIMARY KEY,value TEXT); INSERT INTO completion_text VALUES('display_target','{\"mode\":\"active\"}');").unwrap();
        drop(connection);
        let original = (
            std::fs::read(&state).unwrap(),
            std::fs::read(&completion).unwrap(),
        );
        let result = read_paths(&state, &completion).unwrap().unwrap();
        assert_eq!(
            result,
            LegacyPreferences {
                observer_enabled: Some(true),
                observer_engine: Some("claude".into()),
                paused: Some(false),
                voice_enabled: Some(false),
                display_target: Some(LegacyDisplayTarget::Active)
            }
        );
        assert!(!format!("{result:?}").contains("private_user_content"));
        assert_eq!(
            original,
            (
                std::fs::read(&state).unwrap(),
                std::fs::read(&completion).unwrap()
            )
        );
        assert!(open(&state)
            .unwrap()
            .unwrap()
            .execute("DELETE FROM spellcast_state", [])
            .is_err());
    }

    #[test]
    fn absent_databases_are_not_created_and_tests_never_read_production() {
        let scratch = Scratch::new();
        assert_eq!(
            read_paths(
                &scratch.0.join("missing-state"),
                &scratch.0.join("missing-inbox")
            )
            .unwrap(),
            None
        );
        assert_eq!(std::fs::read_dir(&scratch.0).unwrap().count(), 0);
        assert_eq!(read().unwrap(), None);
    }

    #[test]
    fn invalid_values_fail_without_guessing_or_losing_a_fixed_target() {
        assert!(boolean(Some("integer".into()), Some(1)).is_err());
        assert!(boolean(Some("null".into()), None).is_err());
        assert!(boolean(Some("true".into()), Some(0)).is_err());
        assert_eq!(display(r#"{"mode":"fixed","id":"screen-2","label":"Office","number":2,"width":1920,"height":1080}"#).unwrap(), LegacyDisplayTarget::Fixed {id:"screen-2".into(),label:"Office".into()});
        assert!(display(r#"{"mode":"fixed","id":"","label":"Office"}"#).is_err());
        assert!(display(r#"{"mode":"unknown"}"#).is_err());
    }
}
