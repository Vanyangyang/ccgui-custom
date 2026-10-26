//! Reserved host KV state; no additions to the shared V2 SQLite schema.
use super::ImagePreviewGrant;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, path::Path};

// `$` cannot be registered as an ordinary plugin ID.
pub(super) const NAMESPACE: &str = "$ccgui-image-preview";
pub(super) const KEY: &str = "state-v1";

#[derive(Deserialize, Serialize)]
struct State {
    version: u32,
    grants: Vec<ImagePreviewGrant>,
}

fn invalid(reason: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            reason.into(),
        )),
    )
}

fn validate(grants: &[ImagePreviewGrant]) -> rusqlite::Result<()> {
    let mut seen = HashSet::new();
    for grant in grants {
        if !matches!(grant.scope.as_str(), "file" | "directory")
            || !Path::new(&grant.path).is_absolute()
            || grant.path.chars().any(char::is_control)
            || !seen.insert((&grant.path, &grant.scope))
        {
            return Err(invalid("invalid image preview KV grant"));
        }
    }
    Ok(())
}

fn raw(conn: &Connection) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT value FROM plugin_kv WHERE plugin_id=?1 AND key=?2",
        params![NAMESPACE, KEY],
        |r| r.get(0),
    )
    .optional()
}

pub(super) fn read(conn: &Connection) -> rusqlite::Result<Vec<ImagePreviewGrant>> {
    let Some(raw) = raw(conn)? else {
        return Ok(Vec::new());
    };
    let state: State =
        serde_json::from_str(&raw).map_err(|e| invalid(format!("image preview KV: {e}")))?;
    if state.version != 1 {
        return Err(invalid("unsupported image preview KV version"));
    }
    validate(&state.grants)?;
    Ok(state.grants)
}

pub(super) fn write(conn: &Connection, grants: &[ImagePreviewGrant]) -> rusqlite::Result<()> {
    validate(grants)?;
    let raw = serde_json::to_string(&State {
        version: 1,
        grants: grants.to_vec(),
    })
    .map_err(|e| invalid(e.to_string()))?;
    conn.execute(
        "INSERT INTO plugin_kv(plugin_id,key,value) VALUES(?1,?2,?3)
        ON CONFLICT(plugin_id,key) DO UPDATE SET value=excluded.value",
        params![NAMESPACE, KEY, raw],
    )?;
    Ok(())
}

/// Old development tables remain untouched. The complete KV row, even empty,
/// is the import marker, so a revoked grant cannot be resurrected on reopen.
pub(crate) fn migrate_legacy(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    if raw(&tx)?.is_some() {
        return tx.commit();
    }
    let exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='image_preview_grants')", [], |r| r.get(0))?;
    if !exists {
        return tx.commit();
    }
    let grants = {
        let mut stmt =
            tx.prepare("SELECT path,scope FROM image_preview_grants ORDER BY path,scope")?;
        let rows = stmt.query_map([], |r| {
            Ok(ImagePreviewGrant {
                path: r.get(0)?,
                scope: r.get(1)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    write(&tx, &grants)?;
    tx.commit()
}
