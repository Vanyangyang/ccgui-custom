//! App-owned, parameter-only Intelligence UI snapshots. Never stores program source.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerSnapshot {
    pub revision: u64,
    pub values: Map<String, Value>,
    pub source_hash: String,
}

fn key(identity: &str, source: &str) -> Result<String, String> {
    if identity.trim().is_empty()
        || identity.encode_utf16().count() > 1024
        || identity.chars().any(char::is_control)
        || source.is_empty()
        || source.len() > 32_768
    {
        return Err("interactive_answer_invalid_key".into());
    }
    Ok(format!("{:x}", Sha256::digest(source.as_bytes())))
}

fn validate(values: &Map<String, Value>) -> Result<(), String> {
    if values.len() > 128
        || values.iter().any(|(key, value)| {
            key.is_empty()
                || key.encode_utf16().count() > 65
                || key.chars().any(char::is_control)
                || !match value {
                    Value::Bool(_) => true,
                    Value::Number(value) => value
                        .as_f64()
                        .is_some_and(|n| n.is_finite() && n.abs() <= 1e12),
                    Value::String(value) => value.encode_utf16().count() <= 256,
                    _ => false,
                }
        })
    {
        return Err("interactive_answer_invalid_values".into());
    }
    Ok(())
}

fn storage_error(_: impl std::fmt::Display) -> String {
    "interactive_answer_storage_error".into()
}

fn open(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(storage_error)?;
    }
    let mut db = Connection::open(path).map_err(storage_error)?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(storage_error)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    let version: u32 = tx
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(storage_error)?;
    if version > 1 {
        return Err("interactive_answer_schema_version".into());
    }
    tx.execute_batch("CREATE TABLE IF NOT EXISTS answer_state (identity TEXT NOT NULL, source_hash TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), values_json TEXT NOT NULL, PRIMARY KEY(identity, source_hash)); PRAGMA user_version = 1;").map_err(storage_error)?;
    tx.commit().map_err(storage_error)?;
    Ok(db)
}

fn read_at(path: &Path, identity: &str, source: &str) -> Result<AnswerSnapshot, String> {
    let source_hash = key(identity, source)?;
    let db = open(path)?;
    let stored: Option<(u64, String)> = db
        .query_row(
            "SELECT revision, values_json FROM answer_state WHERE identity=?1 AND source_hash=?2",
            params![identity, source_hash],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(storage_error)?;
    let (revision, values) = match stored {
        Some((revision, json)) => (
            revision,
            serde_json::from_str(&json).map_err(storage_error)?,
        ),
        None => (0, Map::new()),
    };
    validate(&values)?;
    Ok(AnswerSnapshot {
        revision,
        values,
        source_hash,
    })
}

fn write_at(
    path: &Path,
    identity: &str,
    source: &str,
    expected_revision: u64,
    values: Map<String, Value>,
) -> Result<AnswerSnapshot, String> {
    let source_hash = key(identity, source)?;
    validate(&values)?;
    // Revisions must remain exactly representable by the JavaScript consumer.
    if expected_revision >= 9_007_199_254_740_991 {
        return Err("interactive_answer_invalid_revision".into());
    }
    let mut db = open(path)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    let current: Option<u64> = tx
        .query_row(
            "SELECT revision FROM answer_state WHERE identity=?1 AND source_hash=?2",
            params![identity, source_hash],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    if current.unwrap_or(0) != expected_revision {
        return Err("interactive_answer_conflict".into());
    }
    if current.is_none() {
        let count: u64 = tx
            .query_row("SELECT COUNT(*) FROM answer_state", [], |row| row.get(0))
            .map_err(storage_error)?;
        if count >= 10_000 {
            return Err("interactive_answer_capacity".into());
        }
    }
    let revision = expected_revision + 1;
    let json = serde_json::to_string(&values).map_err(storage_error)?;
    tx.execute("INSERT INTO answer_state(identity,source_hash,revision,values_json) VALUES(?1,?2,?3,?4) ON CONFLICT(identity,source_hash) DO UPDATE SET revision=excluded.revision, values_json=excluded.values_json", params![identity, source_hash, revision, json]).map_err(storage_error)?;
    tx.commit().map_err(storage_error)?;
    Ok(AnswerSnapshot {
        revision,
        values,
        source_hash,
    })
}

#[tauri::command]
pub fn interactive_answer_read(identity: String, source: String) -> Result<AnswerSnapshot, String> {
    read_at(
        &crate::paths::app_home().join("interactive-answers.sqlite"),
        &identity,
        &source,
    )
}

#[tauri::command]
pub fn interactive_answer_write(
    identity: String,
    source: String,
    expected_revision: u64,
    values: Map<String, Value>,
) -> Result<AnswerSnapshot, String> {
    write_at(
        &crate::paths::app_home().join("interactive-answers.sqlite"),
        &identity,
        &source,
        expected_revision,
        values,
    )
}

#[tauri::command]
pub fn interactive_answer_reset(
    identity: String,
    source: String,
    expected_revision: u64,
    values: Map<String, Value>,
) -> Result<AnswerSnapshot, String> {
    // Reset is a new revision: an old in-flight save cannot resurrect pre-reset data.
    interactive_answer_write(identity, source, expected_revision, values)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct TempDb(std::path::PathBuf);
    impl TempDb {
        fn new() -> Self {
            Self(
                std::env::temp_dir()
                    .join(format!("ccgui-answer-test-{}", uuid::Uuid::new_v4()))
                    .join("state.sqlite"),
            )
        }
    }
    impl Drop for TempDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
            if let Some(parent) = self.0.parent() {
                let _ = std::fs::remove_dir(parent);
            }
        }
    }
    fn values(n: i64) -> Map<String, Value> {
        serde_json::from_value(serde_json::json!({"$n":n})).unwrap()
    }
    #[test]
    fn reopens_and_isolates_source_and_identity() {
        let db = TempDb::new();
        assert_eq!(read_at(&db.0, "a", "source").unwrap().revision, 0);
        let saved = write_at(&db.0, "a", "source", 0, values(4)).unwrap();
        assert_eq!(saved.source_hash.len(), 64);
        assert_eq!(read_at(&db.0, "a", "source").unwrap().values, values(4));
        assert_eq!(read_at(&db.0, "b", "source").unwrap().revision, 0);
        assert_eq!(read_at(&db.0, "a", "changed").unwrap().revision, 0);
    }
    #[test]
    fn reset_and_late_writes_are_monotonic() {
        let db = TempDb::new();
        write_at(&db.0, "a", "s", 0, values(4)).unwrap();
        assert_eq!(
            write_at(&db.0, "a", "s", 1, Map::new()).unwrap().revision,
            2
        );
        assert_eq!(
            write_at(&db.0, "a", "s", 1, values(9)).unwrap_err(),
            "interactive_answer_conflict"
        );
        assert!(read_at(&db.0, "a", "s").unwrap().values.is_empty());
    }
    #[test]
    fn rejects_invalid_inputs_and_capacity_without_eviction() {
        let db = TempDb::new();
        for identity in ["", "a\nb"] {
            assert!(read_at(&db.0, identity, "s").is_err());
        }
        assert!(read_at(&db.0, &"x".repeat(1025), "s").is_err());
        assert!(read_at(&db.0, "a", &"x".repeat(32769)).is_err());
        for bad in [
            serde_json::json!({"a":null}),
            serde_json::json!({"a":{}}),
            serde_json::json!({"a":1e13}),
            serde_json::json!({"a":"x".repeat(257)}),
        ] {
            assert!(write_at(&db.0, "a", "s", 0, bad.as_object().unwrap().clone()).is_err());
        }
        let many = (0..129)
            .map(|n| (format!("k{n}"), Value::Bool(true)))
            .collect();
        assert!(write_at(&db.0, "a", "s", 0, many).is_err());
        assert!(write_at(
            &db.0,
            "a",
            "s",
            0,
            [("x".repeat(66), Value::Bool(true))].into_iter().collect()
        )
        .is_err());
        let conn = open(&db.0).unwrap();
        conn.execute_batch("WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO answer_state SELECT CAST(x AS TEXT),'hash',1,'{}' FROM n;").unwrap();
        assert_eq!(
            write_at(&db.0, "new", "s", 0, values(1)).unwrap_err(),
            "interactive_answer_capacity"
        );
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM answer_state", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 10000);
    }
}
