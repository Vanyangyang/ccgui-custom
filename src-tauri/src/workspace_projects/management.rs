//! Narrow, request-bound organization tools. No workspace registration or grants.
use super::*;
use rusqlite::{params, OptionalExtension};
use rmcp::schemars::{self, JsonSchema};
use sha2::{Digest, Sha256};

#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReadArgs {}

#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MemberInput {
    pub id: Option<String>,
    pub path: String,
    pub label: String,
}

#[derive(Clone, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SaveArgs {
    /// Stable business request ID. Reuse only for the exact same operation.
    pub request_id: String,
    pub id: Option<String>,
    /// Required for edits: copy the project's expectedCurrent from the read tool.
    pub expected_current: Option<String>,
    pub name: String,
    pub default_path: String,
    /// Complete replacement membership, not a patch.
    pub members: Vec<MemberInput>,
}

impl SaveArgs {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.request_id.is_empty() || self.request_id.len() > 64
            || !self.request_id.bytes().all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b)) {
            return Err("requestId must match [A-Za-z0-9._:-]{1,64}".into());
        }
        if let Some(id) = &self.id { valid_text(id, 200, "project id")?; }
        match (&self.id, &self.expected_current) {
            (None, None) => {},
            (Some(_), Some(hash)) if hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) => {},
            _ => return Err("edits require expectedCurrent from get_workspace_organization; creates must omit it".into()),
        }
        valid_text(&self.name, 120, "project name")?;
        if self.members.is_empty() || self.members.len() > 32 { return Err("projects require 1 to 32 members".into()); }
        if !self.members.iter().any(|m| m.path == self.default_path) { return Err("defaultPath must exactly match a member path".into()); }
        let mut ids = HashSet::new();
        for member in &self.members {
            if let Some(id) = &member.id {
                valid_text(id, 200, "member id")?;
                if self.id.is_none() { return Err("member ids are only accepted for existing projects".into()); }
                if !ids.insert(id) { return Err("duplicate member id".into()); }
            }
            if member.path.len() > 4096 { return Err("member path exceeds 4096 bytes".into()); }
            local_path(&member.path)?;
            valid_text(&member.label, 120, "member label")?;
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectSnapshot {
    #[serde(flatten)]
    project: WorkspaceProject,
    expected_current: String,
}

fn digest(value: &impl Serialize) -> Result<String, String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value).map_err(|e| e.to_string())?)))
}

fn snapshots(conn: &Connection) -> Result<Vec<ProjectSnapshot>, String> {
    let roots = registered_roots(conn)?;
    storage::read(conn).map_err(|e| e.to_string())?.into_iter().map(|stored| {
        Ok(ProjectSnapshot { expected_current: digest(&stored)?, project: materialize(stored, &roots) })
    }).collect()
}

fn workspace_metadata(workspaces: Vec<crate::history::reader::Workspace>) -> Vec<serde_json::Value> {
    // Opaque transport/plugin meta is deliberately not part of the AI view.
    workspaces.into_iter().map(|w|
        serde_json::json!({"id": w.id, "path": w.path, "name": w.name,
            "groupId": w.group_id, "sortOrder": w.sort_order, "kind": w.kind, "parentId": w.parent_id})
    ).collect()
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt { version: u32, fingerprint: String, project_id: String }

fn save(conn: &mut Connection, scope: &str, args: SaveArgs) -> Result<ProjectSnapshot, String> {
    args.validate()?;
    let fingerprint = digest(&args)?;
    // Separate keys in the existing reserved KV namespace: no V2 DDL changes.
    let receipt_key = format!("management-request-v1:{}", digest(&(scope, &args.request_id))?);
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    let projects = storage::read(&tx).map_err(|e| e.to_string())?;
    let previous_receipt: Option<String> = tx.query_row(
        "SELECT value FROM plugin_kv WHERE plugin_id=?1 AND key=?2",
        params![storage::NAMESPACE, receipt_key], |row| row.get(0),
    ).optional().map_err(|e| e.to_string())?;
    if let Some(raw) = previous_receipt {
        let receipt: Receipt = serde_json::from_str(&raw).map_err(|_| "invalid organization request receipt")?;
        if receipt.version != 1 || receipt.fingerprint != fingerprint {
            return Err("requestId conflicts with its original operation; read current organization".into());
        }
        let current = snapshots(&tx)?.into_iter().find(|p| p.project.id == receipt.project_id)
            .ok_or("previously saved project was removed; read current organization, do not replay creation")?;
        // Return current truth, never restore an older saved snapshot on replay.
        return Ok(current);
    }
    let old = args.id.as_ref().map(|id| projects.iter().find(|p| &p.id == id).ok_or("unknown project")).transpose()?;
    if let Some(old) = old {
        if old.source_plugin_id.is_some() || old.source_key.is_some() {
            return Err("plugin-owned projects must be updated by their source".into());
        }
        if args.expected_current.as_deref() != Some(digest(old)?.as_str()) {
            return Err("project changed since read; read current organization before saving".into());
        }
    }
    let members = args.members.iter().map(|member| {
        let previous = if let Some(id) = &member.id {
            Some(old.and_then(|p| p.members.iter().find(|m| &m.id == id)).ok_or("unknown member id")?)
        } else {
            old.and_then(|p| p.members.iter().find(|m| m.path == member.path))
        };
        Ok(ProjectMemberInput {
            id: previous.map(|m| m.id.clone()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            path: member.path.clone(), label: member.label.clone(),
            role: previous.map(|m| m.role.clone()).unwrap_or(MemberRole::Development),
        })
    }).collect::<Result<Vec<_>, String>>()?;
    let saved = save_in_transaction(&tx, ProjectInput { id: args.id, name: args.name, default_path: args.default_path, members }, None)?;
    let receipt = Receipt { version: 1, fingerprint, project_id: saved.id.clone() };
    tx.execute("INSERT INTO plugin_kv(plugin_id,key,value) VALUES(?1,?2,?3)",
        params![storage::NAMESPACE, receipt_key, serde_json::to_string(&receipt).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
    let result = snapshots(&tx)?.into_iter().find(|p| p.project.id == saved.id).ok_or("saved project unavailable")?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

#[tauri::command]
pub(crate) fn host_get_workspace_organization(
    window: tauri::WebviewWindow, state: tauri::State<'_, crate::AppState>, request_id: String,
) -> Result<serde_json::Value, String> {
    crate::host_chat::with_workspace_request(window.label(), &request_id, "get_workspace_organization", |_, _| {
        let workspaces = workspace_metadata(crate::history::reader::list_workspaces(state.clone())?);
        let settings = crate::settings::read_settings()?;
        let conn = state.db.0.lock();
        Ok(serde_json::json!({ "workspaces": workspaces, "groups": settings.workspace_groups,
            "aliases": settings.workspace_aliases, "projects": snapshots(&conn)?,
            "allowedLocalRoots": registered_roots(&conn)? }))
    })
}

#[tauri::command]
pub(crate) fn host_save_workspace_project(
    window: tauri::WebviewWindow, state: tauri::State<'_, crate::AppState>, request_id: String,
) -> Result<ProjectSnapshot, String> {
    let result = crate::host_chat::with_workspace_request(window.label(), &request_id, "save_workspace_project", |scope, arguments| {
        let args = serde_json::from_value(arguments.clone()).map_err(|_| "invalid project arguments")?;
        save(&mut state.db.0.lock(), scope, args)
    })?;
    state.emitters.emit_json("workspace-projects://changed", "null");
    Ok(result)
}

#[cfg(test)]
mod tests;
