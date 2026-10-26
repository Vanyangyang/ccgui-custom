//! Sidebar attribution and receipts use reserved v3 KV namespaces, never DDL.
//! Workspace registration IDs fence remove/re-add; native history identity fences
//! replacement files. Current deletion paths clear records in the same transaction.
use super::{local_workspace, path_key};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub(crate) const NAMESPACE: &str = "$ccgui-session-sidebar";
pub(crate) const RECEIPT_NAMESPACE: &str = "$ccgui-session-sidebar-requests";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Placement {
    engine: String,
    session_id: String,
    source_workspace_path: String,
    source_workspace_id: String,
    file_path: String,
    created_at: Option<i64>,
    target_workspace_id: String,
    target_workspace_path: String,
}

struct NativeIdentity {
    workspace_path: String,
    file_path: String,
    created_at: Option<i64>,
}

pub(crate) struct Workspace {
    pub id: String,
    pub path: String,
    pub local: bool,
    pub ambiguous: bool,
}

fn workspace_rows(conn: &Connection) -> Result<Vec<Workspace>, String> {
    let mut stmt = conn
        .prepare("SELECT id,path,meta FROM workspaces")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (id, path, meta) = row.map_err(|e| e.to_string())?;
        let local = local_workspace(&path, meta.as_deref());
        out.push(Workspace {
            id,
            path,
            local,
            ambiguous: false,
        });
    }
    Ok(out)
}

pub(crate) fn workspaces(conn: &Connection) -> Result<HashMap<String, Workspace>, String> {
    let mut out: HashMap<String, Workspace> = HashMap::new();
    for workspace in workspace_rows(conn)? {
        let key = path_key(&workspace.path);
        // Legacy exact-path UNIQUE permits equivalent Windows spellings. Fence
        // only that path; an unrelated duplicate must not break all history.
        if let Some(existing) = out.get_mut(&key) {
            existing.local = false;
            existing.ambiguous = true;
            continue;
        }
        out.insert(key, workspace);
    }
    Ok(out)
}

fn key(engine: &str, session: &str) -> String {
    serde_json::to_string(&(engine, session)).expect("string pair serialization")
}

fn native_identities(conn: &Connection) -> Result<HashMap<String, NativeIdentity>, String> {
    let mut stmt = conn
        .prepare("SELECT engine,session_id,workspace_path,file_path,created_at FROM sessions")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                NativeIdentity {
                    workspace_path: r.get(2)?,
                    file_path: r.get(3)?,
                    created_at: r.get(4)?,
                },
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = HashMap::new();
    for row in rows {
        let (engine, session, identity) = row.map_err(|e| e.to_string())?;
        out.insert(key(&engine, &session), identity);
    }
    Ok(out)
}

fn stored(conn: &Connection) -> Result<Vec<(String, Placement)>, String> {
    let mut stmt = conn
        .prepare("SELECT key,value FROM plugin_kv WHERE plugin_id=?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([NAMESPACE], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let (key, raw) = row.map_err(|e| e.to_string())?;
        let value = serde_json::from_str(&raw)
            .map_err(|e| format!("Invalid sidebar placement record: {e}"))?;
        out.push((key, value));
    }
    Ok(out)
}

pub(crate) fn load_all(conn: &Connection) -> Result<HashMap<(String, String), String>, String> {
    let entries = stored(conn)?;
    if entries.is_empty() {
        return Ok(HashMap::new());
    }
    // Existing placements select registrations by stable ID. A subsequently
    // added path alias must neither shadow nor erase the original registration.
    let workspaces: HashMap<String, Workspace> = workspace_rows(conn)?
        .into_iter()
        .map(|w| (w.id.clone(), w))
        .collect();
    let sessions = native_identities(conn)?;
    let mut out = HashMap::new();
    for (stored_key, mut placement) in entries {
        let source = workspaces.get(&placement.source_workspace_id);
        let target = workspaces.get(&placement.target_workspace_id);
        let native = sessions.get(&stored_key);
        let valid = stored_key == key(&placement.engine, &placement.session_id)
            && source.is_some_and(|w| {
                w.local && path_key(&w.path) == path_key(&placement.source_workspace_path)
            })
            && target.is_some_and(|w| {
                w.local && path_key(&w.path) == path_key(&placement.target_workspace_path)
            })
            && native.is_some_and(|n| {
                path_key(&n.workspace_path) == path_key(&placement.source_workspace_path)
                    && path_key(&n.file_path) == path_key(&placement.file_path)
                    && !matches!((placement.created_at,n.created_at),(Some(a),Some(b)) if a!=b)
            });
        if !valid {
            conn.execute(
                "DELETE FROM plugin_kv WHERE plugin_id=?1 AND key=?2",
                params![NAMESPACE, stored_key],
            )
            .map_err(|e| e.to_string())?;
            continue;
        }
        // Initial scans may not know the timestamp yet. Capture it once it is
        // available, rather than treating normal metadata enrichment as replacement.
        if placement.created_at.is_none() && native.is_some_and(|n| n.created_at.is_some()) {
            placement.created_at = native.and_then(|n| n.created_at);
            put(conn, &stored_key, &placement)?;
        }
        let target = target.expect("validated target");
        out.insert(
            (placement.engine, placement.session_id),
            target.path.clone(),
        );
    }
    Ok(out)
}

fn put(conn: &Connection, key: &str, placement: &Placement) -> Result<(), String> {
    let raw = serde_json::to_string(placement).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO plugin_kv(plugin_id,key,value) VALUES(?1,?2,?3)
        ON CONFLICT(plugin_id,key) DO UPDATE SET value=excluded.value",
        params![NAMESPACE, key, raw],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn set(
    conn: &Connection,
    engine: &str,
    session: &str,
    target: Option<&str>,
    workspaces: &HashMap<String, Workspace>,
) -> Result<(), String> {
    let Some(target) = target else {
        return delete_session(conn, engine, session);
    };
    let (workspace_path,file_path,created_at): (String,String,Option<i64>)=conn.query_row(
        "SELECT workspace_path,file_path,created_at FROM sessions WHERE engine=?1 AND session_id=?2",params![engine,session],
        |r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).map_err(|e|e.to_string())?;
    let source = workspaces
        .get(&path_key(&workspace_path))
        .filter(|w| w.local)
        .ok_or("Source workspace disappeared")?;
    let target = workspaces
        .get(&path_key(target))
        .filter(|w| w.local)
        .ok_or("Target workspace disappeared")?;
    let placement = Placement {
        engine: engine.into(),
        session_id: session.into(),
        source_workspace_path: workspace_path,
        source_workspace_id: source.id.clone(),
        file_path,
        created_at,
        target_workspace_id: target.id.clone(),
        target_workspace_path: target.path.clone(),
    };
    put(conn, &key(engine, session), &placement)
}

pub(crate) fn delete_session(conn: &Connection, engine: &str, session: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM plugin_kv WHERE plugin_id=?1 AND key=?2",
        params![NAMESPACE, key(engine, session)],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Call before deleting the workspace or its indexed sessions, in the same tx.
pub(crate) fn delete_workspace(conn: &Connection, id: &str) -> Result<(), String> {
    for (key, p) in stored(conn)? {
        if p.source_workspace_id == id || p.target_workspace_id == id {
            conn.execute(
                "DELETE FROM plugin_kv WHERE plugin_id=?1 AND key=?2",
                params![NAMESPACE, key],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub(crate) fn receipt(conn: &Connection, request: &str) -> Result<Option<String>, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM plugin_kv WHERE plugin_id=?1 AND key=?2",
            params![RECEIPT_NAMESPACE, request],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(|e| format!("Invalid sidebar receipt: {e}")))
        .transpose()
}

pub(crate) fn save_receipt(conn: &Connection, request: &str, hash: &str) -> Result<(), String> {
    let raw = serde_json::to_string(hash).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO plugin_kv(plugin_id,key,value) VALUES(?1,?2,?3)",
        params![RECEIPT_NAMESPACE, request, raw],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
