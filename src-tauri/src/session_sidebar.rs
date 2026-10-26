//! Presentation-only placement of saved chats. Never changes execution identity.
use crate::db::Db;
use rmcp::schemars;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub(crate) mod storage;

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Assignment {
    pub engine: String,
    pub session_id: String,
    pub expected_workspace_path: String,
    #[serde(deserialize_with = "nullable_path")]
    #[schemars(with = "Option<String>", required)]
    pub expected_sidebar_workspace_path: Option<String>,
    #[serde(deserialize_with = "nullable_path")]
    #[schemars(with = "Option<String>", required)]
    pub sidebar_workspace_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssignArgs {
    pub request_id: String,
    pub assignments: Vec<Assignment>,
}

impl AssignArgs {
    pub(crate) fn validate(&self) -> Result<(), String> {
        validate(&self.request_id, &self.assignments)
    }
}

fn nullable_path<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(d)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdentity {
    pub engine: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidebarSession {
    pub engine: String,
    pub session_id: String,
    pub title: String,
    pub workspace_path: String,
    pub sidebar_workspace_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignmentResult {
    pub request_id: String,
    pub replayed: bool,
    /// Current database values, including on receipt replay. Deleted rows are in `missing`.
    pub assignments: Vec<SidebarSession>,
    pub missing: Vec<SessionIdentity>,
}

// Match workspaceCatalogPathKey in src/lib/workspace-path.ts. Directory case,
// POSIX spelling and dot segments are significant; only drive aliases fold.
pub(crate) fn path_key(path: &str) -> String {
    let b = path.as_bytes();
    if !(b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'/' | b'\\'))
    {
        return path.to_owned();
    }
    let mut key = String::new();
    for c in path.chars() {
        if matches!(c, '/' | '\\') {
            if !key.ends_with('/') {
                key.push('/');
            }
        } else if key.is_empty() {
            key.push(c.to_ascii_uppercase());
        } else {
            key.push(c);
        }
    }
    while key.len() > 3 && key.ends_with('/') {
        key.pop();
    }
    key
}

fn local_workspace(path: &str, meta: Option<&str>) -> bool {
    let b = path.as_bytes();
    let absolute = (b.len() >= 3
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && matches!(b[2], b'/' | b'\\'))
        || (path.starts_with('/') && !path.starts_with("//"));
    if !absolute || path.starts_with("\\\\") || path.contains("://") {
        return false;
    }
    match meta {
        None => true,
        Some(raw) => serde_json::from_str::<serde_json::Value>(raw)
            .ok()
            .is_some_and(|v| {
                v.get("wsl").is_none() && v.get("ssh").is_none() && v.get("remote").is_none()
            }),
    }
}

fn conflict(
    a: &Assignment,
    code: &str,
    message: &str,
    current: Option<(&str, Option<&str>)>,
) -> serde_json::Value {
    let mut value = serde_json::json!({"engine":a.engine,"sessionId":a.session_id,"code":code,"message":message});
    if let Some((cwd, sidebar)) = current {
        value["currentWorkspacePath"] = serde_json::json!(cwd);
        value["currentSidebarWorkspacePath"] = serde_json::json!(sidebar);
    }
    value
}

fn conflicts_error(conflicts: Vec<serde_json::Value>) -> String {
    let mut report =
        serde_json::json!({"code":"SESSION_SIDEBAR_ASSIGNMENT_CONFLICT","conflicts":conflicts});
    let encoded = report.to_string();
    if encoded.len() <= 512 * 1024 {
        return encoded;
    }
    // IDs and reasons are mandatory and bounded by the 100-item input contract.
    // Very long optional path metadata must not crowd them out of the host's
    // 1 MiB response envelope. Omit whole fields explicitly, never truncate JSON.
    for item in report["conflicts"].as_array_mut().expect("conflict array") {
        if let Some(item) = item.as_object_mut() {
            item.remove("currentWorkspacePath");
            item.remove("currentSidebarWorkspacePath");
        }
    }
    report["currentPathsOmitted"] = serde_json::Value::Bool(true);
    report.to_string()
}

fn excluded(conn: &Connection, engine: &str, session: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM leader_branches WHERE engine=?1 AND session_id=?2)
        OR EXISTS(SELECT 1 FROM leader_archived_members WHERE engine=?1 AND session_id=?2)
        OR EXISTS(SELECT 1 FROM plugin_kv WHERE plugin_id=?3 AND key=?1 || ':' || ?2)",
        params![engine, session, crate::db::session_auxiliary::NAMESPACE],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

fn same_optional(a: Option<&str>, b: Option<&str>) -> bool {
    a.map(path_key) == b.map(path_key)
}

fn bounded(value: &str, name: &str, max: usize) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > max || value.chars().any(char::is_control) {
        return Err(format!("Invalid {name}"));
    }
    Ok(())
}

fn rows(conn: &Connection) -> Result<Vec<SidebarSession>, String> {
    let mut placements = storage::load_all(conn)?;
    let mut stmt = conn.prepare("SELECT s.engine,s.session_id,COALESCE(s.custom_title,at.title,s.title),s.workspace_path
        FROM sessions s
        LEFT JOIN session_auto_titles at ON at.engine=s.engine AND at.session_id=s.session_id
        WHERE NOT EXISTS(SELECT 1 FROM session_archives a WHERE a.engine=s.engine AND a.session_id=s.session_id)
        ORDER BY s.engine,s.session_id").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(SidebarSession {
                engine: r.get(0)?,
                session_id: r.get(1)?,
                title: r.get(2)?,
                workspace_path: r.get(3)?,
                sidebar_workspace_path: None,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        let mut row = row.map_err(|e| e.to_string())?;
        row.sidebar_workspace_path =
            placements.remove(&(row.engine.clone(), row.session_id.clone()));
        Ok(row)
    })
    .collect()
}

pub(crate) fn list(db: &Db) -> Result<Vec<SidebarSession>, String> {
    crate::leader::ensure_schema(db)?;
    crate::engine::sidechat::ensure_hidden_loaded(db);
    let conn = db.0.lock();
    let workspaces = storage::workspaces(&conn)?;
    let mut eligible = Vec::new();
    for row in rows(&conn)? {
        if !excluded(&conn, &row.engine, &row.session_id)?
            && !crate::engine::sidechat::is_hidden_session(&row.engine, &row.session_id)
            && workspaces
                .get(&path_key(&row.workspace_path))
                .is_some_and(|w| w.local)
        {
            eligible.push(row);
        }
    }
    Ok(eligible)
}

fn result(
    conn: &Connection,
    request_id: String,
    assignments: &[Assignment],
    replayed: bool,
) -> Result<AssignmentResult, String> {
    let all = rows(conn)?;
    let mut current = Vec::new();
    let mut missing = Vec::new();
    for a in assignments {
        if let Some(row) = all
            .iter()
            .find(|r| r.engine == a.engine && r.session_id == a.session_id)
            .filter(|r| !crate::engine::sidechat::is_hidden_session(&r.engine, &r.session_id))
        {
            current.push(row.clone());
        } else {
            missing.push(SessionIdentity {
                engine: a.engine.clone(),
                session_id: a.session_id.clone(),
            });
        }
    }
    Ok(AssignmentResult {
        request_id,
        replayed,
        assignments: current,
        missing,
    })
}

pub(crate) fn validate(request_id: &str, assignments: &[Assignment]) -> Result<(), String> {
    bounded(request_id, "requestId", 200)?;
    if assignments.is_empty() || assignments.len() > 100 {
        return Err("Expected 1..100 assignments".into());
    }
    let mut identities = HashSet::new();
    for a in assignments {
        bounded(&a.engine, "engine", 64)?;
        bounded(&a.session_id, "sessionId", 512)?;
        bounded(&a.expected_workspace_path, "expectedWorkspacePath", 4096)?;
        for path in [
            &a.expected_sidebar_workspace_path,
            &a.sidebar_workspace_path,
        ]
        .into_iter()
        .flatten()
        {
            bounded(path, "sidebarWorkspacePath", 4096)?;
        }
        if !identities.insert((&a.engine, &a.session_id)) {
            return Err(conflicts_error(vec![conflict(
                a,
                "DUPLICATE_IDENTITY",
                "Duplicate session identity",
                None,
            )]));
        }
    }
    Ok(())
}

pub(crate) fn assign(
    db: &Db,
    request_id: String,
    assignments: Vec<Assignment>,
) -> Result<AssignmentResult, String> {
    validate(&request_id, &assignments)?;
    let payload = serde_json::to_vec(&assignments).map_err(|e| e.to_string())?;
    let hash = format!("{:x}", Sha256::digest(&payload));
    crate::leader::ensure_schema(db)?;
    crate::engine::sidechat::ensure_hidden_loaded(db);
    let mut conn = db.0.lock();
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let receipt = storage::receipt(&tx, &request_id)?;
    if let Some(receipt) = receipt {
        if receipt != hash {
            return Err("requestId already used with another payload".into());
        }
        let answer = result(&tx, request_id, &assignments, true)?;
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(answer);
    }
    // Keep compact request hashes durably. Evicting old receipts could replay
    // an old mutation; a global fixed count would permanently disable new edits.
    let mut targets = Vec::new();
    let mut conflicts = Vec::new();
    let placements = storage::load_all(&tx)?;
    let workspaces = storage::workspaces(&tx)?;
    for a in &assignments {
        let source: Option<String> = tx
            .query_row(
                "SELECT workspace_path FROM sessions WHERE engine=?1 AND session_id=?2",
                params![a.engine, a.session_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(cwd) = source else {
            conflicts.push(conflict(
                a,
                "SESSION_NOT_FOUND",
                "Saved session not found",
                None,
            ));
            targets.push(None);
            continue;
        };
        let current = placements
            .get(&(a.engine.clone(), a.session_id.clone()))
            .map(String::as_str);
        let current_values = Some((cwd.as_str(), current));
        if path_key(&cwd) != path_key(&a.expected_workspace_path) {
            conflicts.push(conflict(
                a,
                "EXECUTION_WORKSPACE_CHANGED",
                "Session execution workspace changed",
                current_values,
            ));
        }
        if workspaces.get(&path_key(&cwd)).is_some_and(|w| w.ambiguous) {
            conflicts.push(conflict(
                a,
                "AMBIGUOUS_SOURCE",
                "Source workspace has equivalent duplicate registrations",
                current_values,
            ));
        } else if !workspaces.get(&path_key(&cwd)).is_some_and(|w| w.local) {
            conflicts.push(conflict(
                a,
                "NONLOCAL_OR_UNREGISTERED_SOURCE",
                "Source workspace must be registered and local",
                current_values,
            ));
        }
        if !same_optional(current, a.expected_sidebar_workspace_path.as_deref()) {
            conflicts.push(conflict(
                a,
                "SIDEBAR_WORKSPACE_CHANGED",
                "Sidebar workspace changed; refresh before assigning",
                current_values,
            ));
        }
        if crate::engine::sidechat::is_hidden_session(&a.engine, &a.session_id) {
            conflicts.push(conflict(
                a,
                "HIDDEN_SESSION",
                "Hidden session cannot be assigned",
                None,
            ));
        }
        let archived: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM session_archives WHERE engine=?1 AND session_id=?2)",
                params![a.engine, a.session_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let (child, group_archived, auxiliary): (bool, bool, bool) = tx
            .query_row(
                "SELECT
            EXISTS(SELECT 1 FROM leader_branches WHERE engine=?1 AND session_id=?2),
            EXISTS(SELECT 1 FROM leader_archived_members WHERE engine=?1 AND session_id=?2),
            EXISTS(SELECT 1 FROM plugin_kv WHERE plugin_id=?3 AND key=?1 || ':' || ?2)",
                params![
                    a.engine,
                    a.session_id,
                    crate::db::session_auxiliary::NAMESPACE
                ],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|e| e.to_string())?;
        if archived || group_archived {
            conflicts.push(conflict(
                a,
                "ARCHIVED_SESSION",
                "Archived session cannot be assigned",
                None,
            ));
        }
        if child {
            conflicts.push(conflict(
                a,
                "MANAGED_CHILD",
                "Managed child follows its root sidebar placement",
                None,
            ));
        }
        if auxiliary {
            conflicts.push(conflict(
                a,
                "AUXILIARY_SESSION",
                "Auxiliary session cannot be assigned",
                None,
            ));
        }
        let target = match &a.sidebar_workspace_path {
            None => None,
            Some(path) => match workspaces.get(&path_key(path)) {
                Some(workspace) if workspace.local => Some(workspace.path.clone()),
                Some(workspace) if workspace.ambiguous => {
                    conflicts.push(conflict(
                        a,
                        "AMBIGUOUS_TARGET",
                        "Target workspace has equivalent duplicate registrations",
                        None,
                    ));
                    None
                }
                Some(_) => {
                    conflicts.push(conflict(
                        a,
                        "NONLOCAL_TARGET",
                        "Target workspace must be local",
                        None,
                    ));
                    None
                }
                None => {
                    conflicts.push(conflict(
                        a,
                        "UNREGISTERED_TARGET",
                        "Target workspace is not registered",
                        None,
                    ));
                    None
                }
            },
        };
        targets.push(target);
    }
    if !conflicts.is_empty() {
        return Err(conflicts_error(conflicts));
    }
    for (a, target) in assignments.iter().zip(targets) {
        storage::set(
            &tx,
            &a.engine,
            &a.session_id,
            target.as_deref(),
            &workspaces,
        )?;
    }
    storage::save_receipt(&tx, &request_id, &hash)?;
    let answer = result(&tx, request_id, &assignments, false)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(answer)
}

fn main_only(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Sidebar placement is restricted to the main window".into());
    }
    Ok(())
}

#[tauri::command]
pub fn get_session_sidebar_workspaces(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<SidebarSession>, String> {
    main_only(&window)?;
    list(&state.db)
}

#[tauri::command]
pub fn assign_session_sidebar_workspaces(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    request_id: String,
    assignments: Vec<Assignment>,
) -> Result<AssignmentResult, String> {
    main_only(&window)?;
    let result = assign(&state.db, request_id, assignments)?;
    if !result.replayed {
        state.sink.emit_sessions_changed();
    }
    Ok(result)
}

#[cfg(test)]
mod tests;
