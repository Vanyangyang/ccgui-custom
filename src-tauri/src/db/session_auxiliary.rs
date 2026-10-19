//! Optional scan metadata in the existing v1 KV table; no shared-schema changes.
use rusqlite::{params, Connection, OptionalExtension};

// `$` is rejected by the ordinary plugin id validator, as for host-chat storage.
pub(crate) const NAMESPACE: &str = "$ccgui-session-auxiliary";
const LEGACY_MIGRATED: &str = "session_auxiliary_kv_migrated";

pub(crate) fn set(
    conn: &Connection,
    engine: &str,
    session_id: &str,
    kind: Option<&str>,
) -> rusqlite::Result<()> {
    let key = format!("{engine}:{session_id}");
    if let Some(kind) = kind {
        // Keep the same JSON encoding as Db::plugin_kv_set.
        conn.execute(
            "INSERT INTO plugin_kv(plugin_id,key,value) VALUES(?1,?2,?3)
             ON CONFLICT(plugin_id,key) DO UPDATE SET value=excluded.value",
            params![NAMESPACE, key, serde_json::json!(kind).to_string()],
        )?;
    } else {
        conn.execute(
            "DELETE FROM plugin_kv WHERE plugin_id=?1 AND key=?2",
            params![NAMESPACE, key],
        )?;
    }
    Ok(())
}

pub(crate) fn decode(raw: Option<String>) -> rusqlite::Result<Option<String>> {
    raw.map(|raw| {
        serde_json::from_str(&raw).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })
    })
    .transpose()
}

/// Call before deleting workspace sessions, inside the same transaction.
pub(crate) fn delete_for_workspace(conn: &Connection, path: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM plugin_kv WHERE plugin_id=?1 AND key IN (
             SELECT engine || ':' || session_id FROM sessions WHERE workspace_path=?2
         )",
        params![NAMESPACE, path],
    )?;
    Ok(())
}

/// Development builds may already have the abandoned column. Copy it once,
/// without changing DDL or overwriting newer KV data. The durable marker avoids
/// resurrecting stale column values after a later scan clears the KV entry.
pub(super) fn migrate_legacy(conn: &Connection) -> rusqlite::Result<()> {
    let migrated: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key=?1",
            [LEGACY_MIGRATED],
            |r| r.get(0),
        )
        .optional()?;
    if migrated.as_deref() == Some("1") {
        return Ok(());
    }
    let columns = conn
        .prepare("PRAGMA table_info(sessions)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !columns.iter().any(|name| name == "auxiliary_kind") {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO plugin_kv(plugin_id,key,value)
         SELECT ?1, engine || ':' || session_id, json_quote(auxiliary_kind)
         FROM sessions WHERE auxiliary_kind IS NOT NULL
         ON CONFLICT(plugin_id,key) DO NOTHING",
        [NAMESPACE],
    )?;
    tx.execute(
        "INSERT INTO meta(key,value) VALUES(?1,'1')
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [LEGACY_MIGRATED],
    )?;
    tx.commit()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_cleanup_is_scoped_and_transactional() {
        let db = crate::db::Db::open_in_memory().unwrap();
        db.plugin_kv_set("ordinary-plugin", "cursor:same", &serde_json::json!("keep"))
            .unwrap();
        let mut conn = db.0.lock();
        for (engine, workspace) in [("cursor", "/a"), ("codex", "/b")] {
            conn.execute(
                "INSERT INTO sessions(engine,session_id,workspace_path,file_path,file_size,file_mtime_ms)
                 VALUES(?1,'same',?2,?1,0,0)", params![engine, workspace],
            ).unwrap();
            set(&conn, engine, "same", Some("cursor_do")).unwrap();
        }
        {
            let tx = conn.transaction().unwrap();
            delete_for_workspace(&tx, "/a").unwrap();
            // A failed workspace deletion rolls back its metadata cleanup too.
        }
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM plugin_kv", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            3
        );
        delete_for_workspace(&conn, "/a").unwrap();
        drop(conn);
        assert_eq!(db.plugin_kv_get(NAMESPACE, "cursor:same").unwrap(), None);
        assert_eq!(
            db.plugin_kv_get(NAMESPACE, "codex:same").unwrap(),
            Some(serde_json::json!("cursor_do"))
        );
        assert_eq!(
            db.plugin_kv_get("ordinary-plugin", "cursor:same").unwrap(),
            Some(serde_json::json!("keep"))
        );
    }

    #[test]
    fn legacy_import_failure_does_not_leave_partial_metadata_or_marker() {
        let db = crate::db::Db::open_in_memory().unwrap();
        let conn = db.0.lock();
        conn.execute_batch(
            "ALTER TABLE sessions ADD COLUMN auxiliary_kind TEXT;
             INSERT INTO sessions(engine,session_id,workspace_path,file_path,file_size,file_mtime_ms,auxiliary_kind)
             VALUES('cursor','aux','/ws','/aux',0,0,'cursor_do');
             CREATE TEMP TRIGGER reject_auxiliary_marker BEFORE INSERT ON meta
             WHEN NEW.key='session_auxiliary_kv_migrated'
             BEGIN SELECT RAISE(ABORT,'injected marker failure'); END;",
        ).unwrap();
        assert!(migrate_legacy(&conn)
            .unwrap_err()
            .to_string()
            .contains("injected marker failure"));
        assert_eq!(
            conn.query_row(
                "SELECT COUNT(*) FROM plugin_kv WHERE plugin_id=?1",
                [NAMESPACE],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        conn.execute("DROP TRIGGER reject_auxiliary_marker", [])
            .unwrap();
        migrate_legacy(&conn).unwrap();
        drop(conn);
        assert_eq!(
            db.plugin_kv_get(NAMESPACE, "cursor:aux").unwrap(),
            Some(serde_json::json!("cursor_do"))
        );
    }
}
