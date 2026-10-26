//! Project records live in an existing reserved KV namespace, leaving V2 DDL intact.
use super::{local_path, valid_text, MemberRole};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub(super) const NAMESPACE: &str = "$ccgui-workspace-projects";
pub(super) const KEY: &str = "state-v1";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StoredMember {
    pub id: String,
    pub path: String,
    pub canonical_identity: String,
    pub label: String,
    pub role: MemberRole,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StoredProject {
    pub id: String,
    pub name: String,
    pub default_path: String,
    pub members: Vec<StoredMember>,
    pub source_plugin_id: Option<String>,
    pub source_key: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct State {
    version: u32,
    projects: Vec<StoredProject>,
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

fn validate(projects: &[StoredProject]) -> rusqlite::Result<()> {
    let mut ids = HashSet::new();
    let mut sources = HashSet::new();
    for project in projects {
        valid_text(&project.id, 200, "project id").map_err(invalid)?;
        valid_text(&project.name, 120, "project name").map_err(invalid)?;
        if !ids.insert(&project.id) {
            return Err(invalid("duplicate project id"));
        }
        match (&project.source_plugin_id, &project.source_key) {
            (None, None) => {}
            (Some(plugin), Some(key)) => {
                valid_text(plugin, 200, "source plugin").map_err(invalid)?;
                valid_text(key, 200, "source key").map_err(invalid)?;
                if !sources.insert((plugin, key)) {
                    return Err(invalid("duplicate project source"));
                }
            }
            _ => return Err(invalid("incomplete project source ownership")),
        }
        if project.members.is_empty()
            || project.members.len() > 32
            || !project
                .members
                .iter()
                .any(|m| m.path == project.default_path)
        {
            return Err(invalid("invalid project members or defaultPath"));
        }
        let mut member_ids = HashSet::new();
        let mut identities = HashSet::new();
        for member in &project.members {
            valid_text(&member.id, 200, "member id").map_err(invalid)?;
            valid_text(&member.label, 120, "member label").map_err(invalid)?;
            local_path(&member.path).map_err(invalid)?;
            if member.canonical_identity.chars().any(char::is_control)
                || !member_ids.insert(&member.id)
                || !identities.insert(&member.canonical_identity)
            {
                return Err(invalid("invalid or duplicate project member identity"));
            }
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

pub(super) fn read(conn: &Connection) -> rusqlite::Result<Vec<StoredProject>> {
    let Some(raw) = raw(conn)? else {
        return Ok(Vec::new());
    };
    let state: State =
        serde_json::from_str(&raw).map_err(|e| invalid(format!("workspace projects KV: {e}")))?;
    if state.version != 1 {
        return Err(invalid("unsupported workspace projects KV version"));
    }
    validate(&state.projects)?;
    Ok(state.projects)
}

pub(super) fn write(conn: &Connection, projects: &[StoredProject]) -> rusqlite::Result<()> {
    validate(projects)?;
    let raw = serde_json::to_string(&State {
        version: 1,
        projects: projects.to_vec(),
    })
    .map_err(|e| invalid(e.to_string()))?;
    conn.execute(
        "INSERT INTO plugin_kv(plugin_id,key,value) VALUES(?1,?2,?3)
        ON CONFLICT(plugin_id,key) DO UPDATE SET value=excluded.value",
        params![NAMESPACE, KEY, raw],
    )?;
    Ok(())
}

/// Import development-only tables exactly once, preserving stored identities,
/// owner tuples, member ordering and offline paths. Never modify the source tables.
pub(crate) fn migrate_legacy(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    if raw(&tx)?.is_some() {
        return tx.commit();
    }
    let exists = |name: &str| {
        tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?1)",
            [name],
            |r| r.get::<_, bool>(0),
        )
    };
    match (
        exists("workspace_projects")?,
        exists("workspace_project_members")?,
    ) {
        (false, false) => return tx.commit(),
        (true, true) => {}
        _ => return Err(invalid("incomplete legacy workspace project tables")),
    }
    let mut projects = {
        let mut stmt = tx.prepare("SELECT id,name,default_path,source_plugin_id,source_key FROM workspace_projects ORDER BY rowid")?;
        let rows = stmt.query_map([], |r| {
            Ok(StoredProject {
                id: r.get(0)?,
                name: r.get(1)?,
                default_path: r.get(2)?,
                members: Vec::new(),
                source_plugin_id: r.get(3)?,
                source_key: r.get(4)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for project in &mut projects {
        let mut stmt = tx.prepare("SELECT id,path,canonical_identity,label,role FROM workspace_project_members WHERE project_id=?1 ORDER BY position")?;
        let rows = stmt.query_map([&project.id], |r| {
            let role: String = r.get(4)?;
            Ok(StoredMember {
                id: r.get(0)?,
                path: r.get(1)?,
                canonical_identity: r.get(2)?,
                label: r.get(3)?,
                role: match role.as_str() {
                    "development" => MemberRole::Development,
                    "reference" => MemberRole::Reference,
                    _ => return Err(invalid("invalid legacy member role")),
                },
            })
        })?;
        project.members = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    }
    let orphan: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM workspace_project_members m LEFT JOIN workspace_projects p ON p.id=m.project_id WHERE p.id IS NULL)", [], |r| r.get(0))?;
    if orphan {
        return Err(invalid("orphaned legacy project members"));
    }
    write(&tx, &projects)?;
    tx.commit()
}
