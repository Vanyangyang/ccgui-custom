//! Project membership is independent of workspace registration and session storage.
use crate::event_sink::Emit;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, path::Path};

mod storage;
pub(crate) mod management;
pub(crate) use storage::migrate_legacy;
use storage::{StoredMember, StoredProject};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum MemberRole {
    Development,
    Reference,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum MemberStatus {
    Available,
    Missing,
    Changed,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMember {
    pub id: String,
    pub path: String,
    pub label: String,
    pub role: MemberRole,
    pub status: MemberStatus,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceProject {
    pub id: String,
    pub name: String,
    pub default_path: String,
    pub members: Vec<ProjectMember>,
    pub source_plugin_id: Option<String>,
    pub source_key: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMemberInput {
    pub id: String,
    pub path: String,
    pub label: String,
    pub role: MemberRole,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInput {
    pub id: Option<String>,
    pub name: String,
    pub default_path: String,
    pub members: Vec<ProjectMemberInput>,
}

fn valid_text(value: &str, max: usize, field: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.chars().count() > max || value.chars().any(char::is_control)
    {
        return Err(format!("invalid {field}"));
    }
    Ok(())
}

fn local_path(value: &str) -> Result<&Path, String> {
    let slash = value.replace('\\', "/");
    if value.trim() != value
        || value.chars().any(char::is_control)
        || slash.starts_with("//")
        || slash.contains("://")
        || !Path::new(value).is_absolute()
    {
        return Err("project member must be an absolute local directory".into());
    }
    Ok(Path::new(value))
}

fn identity(path: &Path) -> Result<String, String> {
    if !path.is_dir() {
        return Err("project member directory is missing".into());
    }
    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    let value = canonical.to_str().ok_or("directory path is not Unicode")?;
    #[cfg(windows)]
    let value = value
        .strip_prefix("\\\\?\\")
        .unwrap_or(value)
        .replace('\\', "/")
        .to_lowercase();
    #[cfg(not(windows))]
    let value = value.to_owned();
    if value.starts_with("UNC/") || value.starts_with("unc/") || value.starts_with("//") {
        return Err("remote directories are not project members".into());
    }
    Ok(value.trim_end_matches('/').to_owned())
}

fn registered_roots(conn: &Connection) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT path,meta FROM workspaces")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut roots = Vec::new();
    for row in rows {
        let (path, meta) = row.map_err(|e| e.to_string())?;
        if let Some(meta) = meta {
            // Unreadable transport metadata cannot establish local authorization.
            let Ok(meta) = serde_json::from_str::<serde_json::Value>(&meta) else {
                continue;
            };
            if meta.get("wsl").is_some() || meta.get("remote").is_some() {
                continue;
            }
        }
        if let Ok(path) = local_path(&path) {
            if let Ok(root) = identity(path) {
                roots.push(root);
            }
        }
    }
    Ok(roots)
}

fn covered(path: &str, roots: &[String]) -> bool {
    roots.iter().any(|root| {
        path == root
            || path
                .strip_prefix(root)
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

fn member_status(path: &str, stored: &str, roots: &[String]) -> MemberStatus {
    let Ok(path) = local_path(path) else {
        return MemberStatus::Changed;
    };
    if !path.exists() {
        return MemberStatus::Missing;
    }
    match identity(path) {
        Ok(current) if current == stored && covered(&current, roots) => MemberStatus::Available,
        _ => MemberStatus::Changed,
    }
}

pub(crate) fn list_inner(conn: &Connection) -> Result<Vec<WorkspaceProject>, String> {
    let roots = registered_roots(conn)?;
    Ok(storage::read(conn)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|project| materialize(project, &roots))
        .collect())
}

/// Exact project membership for background extraction; never infer a project
/// from an ancestor directory or from sidebar placement.
pub(crate) fn authorize_memory_source(
    conn: &Connection, plugin: &str, project_id: &str, workspace: &str, development: bool,
) -> Result<String, String> {
    let archived = crate::settings::read_settings().map_err(|_| "workspace_settings_unavailable")?.archived_workspaces;
    authorize_memory_source_with_archives(conn, plugin, project_id, workspace, development, &archived)
}

fn authorize_memory_source_with_archives(
    conn: &Connection, plugin: &str, project_id: &str, workspace: &str, development: bool,
    archived: &[String],
) -> Result<String, String> {
    let current = identity(local_path(workspace)?)?;
    let host_source = Path::new(env!("CARGO_MANIFEST_DIR")).parent().ok_or("host_source_unavailable")?;
    if identity(host_source).is_ok_and(|host| host == current) {
        return Err("host_source_project_excluded".into());
    }
    let project = storage::read(conn).map_err(|_| "project_storage_unavailable")?.into_iter()
        .find(|p| p.id == project_id).ok_or("project_not_registered")?;
    if project.source_plugin_id.as_deref().is_some_and(|owner| owner != plugin) {
        return Err("foreign_project_owner".into());
    }
    let roots = registered_roots(conn)?;
    let same_spelling = |a: &str, b: &str| {
        #[cfg(windows)] { a.replace('\\', "/").trim_end_matches('/').to_lowercase() == b.replace('\\', "/").trim_end_matches('/').to_lowercase() }
        #[cfg(not(windows))] { a.trim_end_matches('/') == b.trim_end_matches('/') }
    };
    let member = project.members.iter().find(|m| same_spelling(&m.path, workspace) && m.canonical_identity == current
        && member_status(&m.path, &m.canonical_identity, &roots) == MemberStatus::Available
        && (!development || m.role == MemberRole::Development)).ok_or("exact_project_member_required")?;
    // Membership alone does not prove an executable/local workspace registration.
    let mut query = conn.prepare("SELECT id,path,meta FROM workspaces").map_err(|_|"workspace_storage_unavailable")?;
    let rows = query.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,Option<String>>(2)?))).map_err(|_|"workspace_storage_unavailable")?.collect::<Result<Vec<_>,_>>().map_err(|_|"workspace_storage_unavailable")?;
    let rows: Vec<_> = rows.into_iter().filter(|(_,path,_)| same_spelling(path,workspace)).collect();
    if rows.is_empty() || rows.iter().any(|(id,_,meta)| archived.contains(id) || meta.as_ref().is_some_and(|s| serde_json::from_str::<serde_json::Value>(s).map_or(true,|v|v.get("wsl").is_some() || v.get("remote").is_some()))) {
        return Err("workspace_not_local_or_archived".into());
    }
    Ok(format!("{}:{}:{}:{:?}", project.id, member.id, current, member.role))
}

/// Read-only native authorization. Both paths must still name their recorded
/// local identities; a retargeted symlink cannot inherit the old membership.
/// Exact executable workspace registration/archive checks belong to the caller.
pub(crate) fn authorize_task_target(
    conn: &Connection, parent: &str, target: &str, same_path: fn(&str, &str) -> bool,
) -> Result<(), String> {
    let parent_identity = identity(local_path(parent)?)?;
    let target_identity = identity(local_path(target)?)?;
    let roots = registered_roots(conn)?;
    let projects = storage::read(conn).map_err(|e| e.to_string())?;
    let available = |member: &StoredMember, path: &str, expected: &str| {
        // Use the caller's established workspace spelling equivalence. Canonical
        // identity detects retargeting; it must not grant an unlisted alias a role.
        same_path(&member.path, path) && member.canonical_identity == expected
            && member_status(&member.path, &member.canonical_identity, &roots) == MemberStatus::Available
    };
    if projects.iter().any(|project| {
        project.members.iter().any(|m| available(m, parent, &parent_identity))
            && project.members.iter().any(|m| m.role == MemberRole::Development && available(m, target, &target_identity))
    }) {
        Ok(())
    } else {
        Err("Cross-workspace child must target an available development member of the parent's registered project".into())
    }
}

fn materialize(project: StoredProject, roots: &[String]) -> WorkspaceProject {
    WorkspaceProject {
        id: project.id,
        name: project.name,
        default_path: project.default_path,
        source_plugin_id: project.source_plugin_id,
        source_key: project.source_key,
        members: project
            .members
            .into_iter()
            .map(|m| ProjectMember {
                status: member_status(&m.path, &m.canonical_identity, roots),
                id: m.id,
                path: m.path,
                label: m.label,
                role: m.role,
            })
            .collect(),
    }
}

pub(crate) fn save_inner(
    conn: &mut Connection,
    input: ProjectInput,
    owner: Option<(&str, &str)>,
) -> Result<WorkspaceProject, String> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let result = save_in_transaction(&tx, input, owner)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

// Callers own an immediate transaction, including AI optimistic concurrency checks.
fn save_in_transaction(
    conn: &Connection,
    input: ProjectInput,
    owner: Option<(&str, &str)>,
) -> Result<WorkspaceProject, String> {
    valid_text(&input.name, 120, "project name")?;
    if input.members.is_empty() || input.members.len() > 32 {
        return Err("projects require 1 to 32 members".into());
    }
    if !input.members.iter().any(|m| m.path == input.default_path) {
        return Err("defaultPath must exactly match a member path".into());
    }
    let mut projects = storage::read(conn).map_err(|e| e.to_string())?;
    let id = if let Some((plugin, key)) = owner {
        valid_text(plugin, 200, "source plugin")?;
        valid_text(key, 200, "source key")?;
        let existing = projects
            .iter()
            .find(|p| {
                p.source_plugin_id.as_deref() == Some(plugin)
                    && p.source_key.as_deref() == Some(key)
            })
            .map(|p| p.id.clone());
        if input.id.is_some() && input.id != existing {
            return Err("project source ownership mismatch".into());
        }
        existing.unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
    } else {
        input
            .id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
    };
    let previous = projects.iter().find(|p| p.id == id);
    if let Some(previous) = previous {
        if previous
            .source_plugin_id
            .as_deref()
            .zip(previous.source_key.as_deref())
            != owner
        {
            return Err("plugin-owned projects must be updated by their source".into());
        }
    } else if input.id.is_some() {
        return Err("unknown project".into());
    }
    let roots = registered_roots(conn)?;
    let mut ids = HashSet::new();
    let mut identities = HashSet::new();
    let mut validated = Vec::new();
    for member in &input.members {
        valid_text(&member.id, 200, "member id")?;
        valid_text(&member.label, 120, "member label")?;
        let path = local_path(&member.path)?;
        if !ids.insert(&member.id) {
            return Err("duplicate member id".into());
        }
        let old = previous.and_then(|p| p.members.iter().find(|m| m.id == member.id));
        // Preserve the recorded identity for an unchanged member even while offline or
        // retargeted. Editing a label must never silently accept a different link target.
        let canonical = match old {
            Some(old) if old.path == member.path => old.canonical_identity.clone(),
            _ => {
                let canonical = identity(path)?;
                if !covered(&canonical, &roots) {
                    return Err("member is outside registered local workspaces".into());
                }
                canonical
            }
        };
        if !identities.insert(canonical.clone()) {
            return Err("duplicate member directory".into());
        }
        validated.push(canonical);
    }
    let saved = StoredProject {
        id: id.clone(),
        name: input.name,
        default_path: input.default_path,
        source_plugin_id: owner.map(|o| o.0.to_owned()),
        source_key: owner.map(|o| o.1.to_owned()),
        members: input
            .members
            .into_iter()
            .zip(validated)
            .map(|(m, canonical_identity)| StoredMember {
                id: m.id,
                path: m.path,
                label: m.label,
                role: m.role,
                canonical_identity,
            })
            .collect(),
    };
    if let Some(index) = projects.iter().position(|p| p.id == id) {
        projects[index] = saved.clone();
    } else {
        projects.push(saved.clone());
    }
    storage::write(conn, &projects).map_err(|e| e.to_string())?;
    Ok(materialize(saved, &roots))
}

pub(crate) fn remove_inner(conn: &Connection, id: &str) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut projects = storage::read(&tx).map_err(|e| e.to_string())?;
    projects.retain(|p| p.id != id);
    // Retain the empty snapshot; it also records completion of legacy import.
    storage::write(&tx, &projects).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_workspace_projects(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<WorkspaceProject>, String> {
    list_inner(&state.db.0.lock())
}

#[tauri::command]
pub fn save_workspace_project(
    state: tauri::State<'_, crate::AppState>,
    input: ProjectInput,
) -> Result<WorkspaceProject, String> {
    let result = save_inner(&mut state.db.0.lock(), input, None)?;
    state
        .emitters
        .emit_json("workspace-projects://changed", "null");
    Ok(result)
}

#[tauri::command]
pub fn remove_workspace_project(
    state: tauri::State<'_, crate::AppState>,
    id: String,
) -> Result<(), String> {
    remove_inner(&state.db.0.lock(), &id)?;
    state
        .emitters
        .emit_json("workspace-projects://changed", "null");
    Ok(())
}

pub(crate) fn publish_workspace_project(
    state: &crate::AppState,
    source_plugin_id: &str,
    source_key: &str,
    input: ProjectInput,
) -> Result<WorkspaceProject, String> {
    let result = save_inner(
        &mut state.db.0.lock(),
        input,
        Some((source_plugin_id, source_key)),
    )?;
    state
        .emitters
        .emit_json("workspace-projects://changed", "null");
    Ok(result)
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod memory_tests;
