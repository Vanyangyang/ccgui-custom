//! Host-native provenance and admission for the `session_create` MCP tool.
//!
//! `session_create` starts an independent root chat (no parent/child task
//! relation, no deadline). To keep agents from chaining or ping-ponging new
//! chats, every decision here is made from the authenticated relay admission
//! and this durable ledger, never from tool arguments:
//!
//! * only a saved, human-origin root chat may create (managed children,
//!   workers and sidechats are refused): an effective creation depth of 1;
//! * a created chat and every managed child below it may neither create chats
//!   nor `send_message` other chats until the human sends a message in it;
//! * per-creator rate and active-run limits bound accidental loops;
//! * a settings switch disables the tool entirely.

use std::sync::{Arc, OnceLock};

use rusqlite::{params, Connection, OptionalExtension};
use rmcp::schemars;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::db::Db;

pub(crate) const RATE_WINDOW_MS: i64 = 60_000;
pub(crate) const RATE_LIMIT: i64 = 3;
pub(crate) const ACTIVE_LIMIT: usize = 5;
/// A reservation whose run never registered stops counting as active after this.
const STARTING_GRACE_MS: i64 = 120_000;
const MAX_CHAIN: usize = 32;

static DB: OnceLock<Arc<Db>> = OnceLock::new();

pub fn init(db: Arc<Db>) -> Result<(), String> {
    ensure_schema(&db.0.lock())?;
    let _ = DB.set(db);
    Ok(())
}

fn store() -> Result<&'static Arc<Db>, String> {
    DB.get().ok_or_else(|| "SESSION_CREATE_UNAVAILABLE: the session provenance store is not initialized".to_string())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn ensure_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS session_spawn_requests (
            creator_engine TEXT NOT NULL, creator_session_id TEXT NOT NULL, request_id TEXT NOT NULL,
            creator_workspace_path TEXT NOT NULL, fingerprint TEXT NOT NULL,
            run_id TEXT NOT NULL UNIQUE, engine TEXT NOT NULL, workspace_path TEXT NOT NULL,
            session_id TEXT, state TEXT NOT NULL, error TEXT,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            PRIMARY KEY(creator_engine, creator_session_id, request_id));
         CREATE INDEX IF NOT EXISTS session_spawn_requests_creator_time
            ON session_spawn_requests(creator_engine, creator_session_id, created_at);
         CREATE TABLE IF NOT EXISTS session_spawn_origins (
            engine TEXT NOT NULL, session_id TEXT NOT NULL, workspace_path TEXT NOT NULL,
            creator_engine TEXT NOT NULL, creator_session_id TEXT NOT NULL,
            creator_workspace_path TEXT NOT NULL, run_id TEXT NOT NULL, request_id TEXT NOT NULL,
            created_at INTEGER NOT NULL, promoted_at INTEGER,
            PRIMARY KEY(engine, session_id));",
    )
    .map_err(|e| e.to_string())
}

/// Tool arguments. Identity and provenance never come from here.
#[derive(Debug, Clone, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SessionCreateArgs {
    /// Registered, local, non-archived workspace that becomes the new chat's cwd.
    #[schemars(length(min = 1, max = 4096))]
    pub workspace_path: String,
    /// "claude", "codex", "agy" or "cursor"; must be installed and enabled.
    #[schemars(length(min = 1, max = 64))]
    pub engine: String,
    /// First task message for the new chat, at most 130000 Unicode characters.
    #[schemars(length(min = 1, max = 130000))]
    pub message: String,
    /// Stable idempotency key [A-Za-z0-9._:-]{1,64}. Calling again with the same
    /// request_id and identical arguments returns the current status instead of
    /// creating another chat.
    #[schemars(length(min = 1, max = 64), pattern("^[A-Za-z0-9._:-]{1,64}$"))]
    pub request_id: String,
    /// Optional exact model id; omitted uses the engine's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 256))]
    pub model: Option<String>,
    /// Optional reasoning effort; omitted uses the user's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 32))]
    pub effort: Option<String>,
    /// Optional sidebar title for the new chat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(length(min = 1, max = 120))]
    pub title: Option<String>,
}

impl SessionCreateArgs {
    pub fn validate(&self) -> Result<(), String> {
        let id_ok = !self.request_id.is_empty() && self.request_id.len() <= 64
            && self.request_id.bytes().all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b));
        if !id_ok { return Err("request_id must match [A-Za-z0-9._:-]{1,64}".into()); }
        if self.workspace_path.trim().is_empty() || self.workspace_path.len() > 4096 {
            return Err("workspace_path must be a nonblank path of at most 4096 bytes".into());
        }
        if !matches!(self.engine.as_str(), "claude" | "codex" | "agy" | "cursor") {
            return Err("engine must be claude, codex, agy or cursor".into());
        }
        if self.message.trim().is_empty() || self.message.chars().count() > 130_000 {
            return Err("message must be nonblank and at most 130000 characters".into());
        }
        let bounded = |value: &Option<String>, max: usize, name: &str| -> Result<(), String> {
            match value {
                Some(v) if v.trim().is_empty() || v.chars().count() > max || v.chars().any(char::is_control) =>
                    Err(format!("{name} must be nonblank, at most {max} characters, without control characters")),
                _ => Ok(()),
            }
        };
        bounded(&self.model, 256, "model")?;
        bounded(&self.effort, 32, "effort")?;
        bounded(&self.title, 120, "title")?;
        Ok(())
    }

    fn fingerprint(&self) -> Result<String, String> {
        let encoded = serde_json::to_vec(self).map_err(|e| e.to_string())?;
        Ok(format!("{:x}", Sha256::digest(encoded)))
    }
}

/// Authenticated relay origin of a `session_create` or `send_message` call.
#[derive(Debug, Clone)]
pub(crate) struct Caller {
    pub run_id: String,
    pub engine: String,
    pub session_id: String,
    pub workspace_path: String,
}

/// Native admission attached to the request forwarded to the desktop host.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Grant {
    /// "start" launches the reserved run; "replay" only reports status.
    pub mode: &'static str,
    pub run_id: String,
    pub request_id: String,
    pub engine: String,
    pub workspace_path: String,
    pub session_id: Option<String>,
    pub state: String,
    pub error: Option<String>,
}

#[derive(Debug)]
struct RequestRow {
    fingerprint: String,
    run_id: String,
    engine: String,
    workspace_path: String,
    session_id: Option<String>,
    state: String,
    error: Option<String>,
}

fn read_request(conn: &Connection, engine: &str, session: &str, request_id: &str) -> Result<Option<RequestRow>, String> {
    conn.query_row(
        "SELECT fingerprint, run_id, engine, workspace_path, session_id, state, error FROM session_spawn_requests
         WHERE creator_engine=?1 AND creator_session_id=?2 AND request_id=?3",
        params![engine, session, request_id],
        |r| Ok(RequestRow { fingerprint: r.get(0)?, run_id: r.get(1)?, engine: r.get(2)?, workspace_path: r.get(3)?,
            session_id: r.get(4)?, state: r.get(5)?, error: r.get(6)? }),
    ).optional().map_err(|e| e.to_string())
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool, String> {
    conn.query_row("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1", [name], |_| Ok(()))
        .optional().map(|row| row.is_some()).map_err(|e| e.to_string())
}

/// Direct managed parent of a saved chat, when it is a live task branch.
fn branch_parent(conn: &Connection, engine: &str, session: &str) -> Result<Option<(String, String)>, String> {
    if !table_exists(conn, "leader_branches")? { return Ok(None); }
    conn.query_row(
        "SELECT parent_engine, parent_session_id FROM leader_branches
         WHERE engine=?1 AND session_id=?2 AND state != 'reclaimed' LIMIT 1",
        params![engine, session],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).optional().map_err(|e| e.to_string())
}

/// Whether this saved chat was created by `session_create` and the human has
/// not yet taken it over.
fn restricted_origin(conn: &Connection, engine: &str, session: &str) -> Result<bool, String> {
    let promoted: Option<Option<i64>> = conn.query_row(
        "SELECT promoted_at FROM session_spawn_origins WHERE engine=?1 AND session_id=?2",
        params![engine, session],
        |row| row.get(0),
    ).optional().map_err(|e| e.to_string())?;
    if let Some(promoted) = promoted { return Ok(promoted.is_none()); }
    // A pending binding is itself authoritative provenance. Failure to write
    // the richer origin row must not turn a resumed chat into a human root.
    // If even the identity claim could not be written, conservatively hold
    // unclassified chats of that engine until binding/recovery or human input.
    conn.query_row(
        "SELECT 1 FROM session_spawn_requests WHERE engine=?1 AND
         (session_id=?2 OR (session_id IS NULL AND state IN ('starting','unknown'))) LIMIT 1",
        params![engine, session], |_| Ok(()),
    ).optional().map(|row| row.is_some()).map_err(|e| e.to_string())
}

/// Root of the managed task tree that contains this chat.
fn task_root(conn: &Connection, engine: &str, session: &str) -> Result<(String, String), String> {
    let mut current = (engine.to_string(), session.to_string());
    for _ in 0..MAX_CHAIN {
        match branch_parent(conn, &current.0, &current.1)? {
            Some(parent) if parent != current => current = parent,
            _ => return Ok(current),
        }
    }
    Err("Managed task ancestry is too deep to verify".into())
}

fn grant(mode: &'static str, request_id: &str, row: RequestRow) -> Grant {
    Grant { mode, run_id: row.run_id, request_id: request_id.into(), engine: row.engine,
        workspace_path: row.workspace_path, session_id: row.session_id, state: row.state, error: row.error }
}

/// Admit a `session_create` call. A replay of an existing request id returns
/// its stored status without re-checking admission.
pub(crate) fn admit_with(
    conn: &Connection,
    caller: &Caller,
    args: &SessionCreateArgs,
    enabled: bool,
    now: i64,
    run_is_live: &dyn Fn(&str) -> bool,
) -> Result<Grant, String> {
    args.validate()?;
    let fingerprint = args.fingerprint()?;
    if let Some(row) = read_request(conn, &caller.engine, &caller.session_id, &args.request_id)? {
        if row.fingerprint != fingerprint {
            return Err("REQUEST_ID_CONFLICT: this request_id already belongs to a different session_create call; reuse it only with identical arguments to read its status".into());
        }
        return Ok(grant("replay", &args.request_id, row));
    }
    if !enabled {
        return Err("SESSION_CREATE_DISABLED: the user has turned off independent chat creation in Settings".into());
    }
    // Worker-hosted runs are ordinary chats kept alive across host updates;
    // managed task workers are refused below through their branch record.
    if branch_parent(conn, &caller.engine, &caller.session_id)?.is_some() {
        return Err("SPAWN_CALLER_NOT_ROOT: managed task chats cannot create independent chats; report back to the parent instead".into());
    }
    if restricted_origin(conn, &caller.engine, &caller.session_id)? {
        return Err("SPAWN_ORIGIN_NOT_HUMAN: this chat was itself created by session_create and cannot create further chats until the human sends a message in it".into());
    }
    let recent: i64 = conn.query_row(
        "SELECT COUNT(*) FROM session_spawn_requests WHERE creator_engine=?1 AND creator_session_id=?2 AND created_at>?3",
        params![caller.engine, caller.session_id, now - RATE_WINDOW_MS],
        |r| r.get(0),
    ).map_err(|e| e.to_string())?;
    if recent >= RATE_LIMIT {
        return Err(format!("SPAWN_RATE_LIMITED: at most {RATE_LIMIT} independent chats per minute from one chat; retry later"));
    }
    let active = {
        let mut query = conn.prepare(
            "SELECT run_id, state, created_at FROM session_spawn_requests
             WHERE creator_engine=?1 AND creator_session_id=?2 AND state IN ('starting','running')",
        ).map_err(|e| e.to_string())?;
        let rows = query.query_map(params![caller.engine, caller.session_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
        }).map_err(|e| e.to_string())?;
        let mut count = 0usize;
        for row in rows {
            let (run_id, state, created_at) = row.map_err(|e| e.to_string())?;
            if run_is_live(&run_id) || (state == "starting" && now - created_at < STARTING_GRACE_MS) { count += 1; }
        }
        count
    };
    if active >= ACTIVE_LIMIT {
        return Err(format!("SPAWN_ACTIVE_LIMIT: this chat already has {ACTIVE_LIMIT} running independent chats; wait for them to finish"));
    }
    let run_id = format!("run-{}", uuid::Uuid::new_v4());
    conn.execute(
        "INSERT INTO session_spawn_requests(creator_engine, creator_session_id, request_id, creator_workspace_path,
            fingerprint, run_id, engine, workspace_path, session_id, state, error, created_at, updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,NULL,'starting',NULL,?9,?9)",
        params![caller.engine, caller.session_id, args.request_id, caller.workspace_path, fingerprint,
            run_id, args.engine, args.workspace_path, now],
    ).map_err(|e| e.to_string())?;
    Ok(Grant { mode: "start", run_id, request_id: args.request_id.clone(), engine: args.engine.clone(),
        workspace_path: args.workspace_path.clone(), session_id: None, state: "starting".into(), error: None })
}

pub(crate) fn admit(caller: &Caller, args: &SessionCreateArgs, run_is_live: &dyn Fn(&str) -> bool) -> Result<Grant, String> {
    let enabled = crate::settings::read_settings()
        .map(|settings| settings.session_create_enabled != Some(false))
        .unwrap_or(true);
    let db = store()?;
    let conn = db.0.lock();
    admit_with(&conn, caller, args, enabled, now_ms(), run_is_live)
}

/// Record the native session id announced for a reserved run. Writes the
/// provenance row that restricts the new chat; a no-op for other runs.
pub(crate) fn bind_with(conn: &Connection, run_id: &str, session_id: &str, now: i64) -> Result<bool, String> {
    let row = conn.query_row(
        "SELECT creator_engine, creator_session_id, creator_workspace_path, request_id, engine, workspace_path, session_id
         FROM session_spawn_requests WHERE run_id=?1",
        [run_id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?,
            r.get::<_, String>(4)?, r.get::<_, String>(5)?, r.get::<_, Option<String>>(6)?)),
    ).optional().map_err(|e| e.to_string())?;
    let Some((creator_engine, creator_session, creator_workspace, request_id, engine, workspace, bound)) = row else {
        return Ok(false);
    };
    if bound.as_deref().is_some_and(|current| current != session_id) {
        return Err("Reserved session_create run announced a different session id".into());
    }
    // Persist a restrictive, uncertain identity claim BEFORE completing the
    // binding transaction. A failed origin INSERT leaves this durable claim
    // available to later runs and host restarts, never a false running ACK.
    if bound.is_none() {
        conn.execute(
            "UPDATE session_spawn_requests SET session_id=?2, state='unknown',
             error='SESSION_ORIGIN_BIND_PENDING: session provenance binding is incomplete', updated_at=?3
             WHERE run_id=?1 AND session_id IS NULL",
            params![run_id, session_id, now],
        ).map_err(|e| e.to_string())?;
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE session_spawn_requests SET session_id=?2, state=CASE WHEN state IN ('starting','unknown') THEN 'running' ELSE state END,
            error=NULL, updated_at=?3 WHERE run_id=?1",
        params![run_id, session_id, now],
    ).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT OR IGNORE INTO session_spawn_origins(engine, session_id, workspace_path, creator_engine, creator_session_id,
            creator_workspace_path, run_id, request_id, created_at, promoted_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,NULL)",
        params![engine, session_id, workspace, creator_engine, creator_session, creator_workspace, run_id, request_id, now],
    ).map_err(|e| e.to_string())?;
    let (origin_run, promoted, origin_request, origin_creator): (String, Option<i64>, String, String) = tx.query_row(
        "SELECT run_id, promoted_at, request_id, creator_session_id FROM session_spawn_origins WHERE engine=?1 AND session_id=?2",
        params![engine, session_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    ).map_err(|e| e.to_string())?;
    let human_recovered = promoted.is_some() && origin_request == "human-takeover" && origin_creator == session_id;
    if origin_run != run_id && !human_recovered {
        return Err("Reserved session_create run conflicts with an existing session origin".into());
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(true)
}

/// The caller must revoke relay authority when provenance cannot be persisted.
pub(crate) fn bind(run_id: &str, session_id: &str) -> Result<bool, String> {
    let db = store()?;
    bind_with(&db.0.lock(), run_id, session_id, now_ms())
}

/// Desktop-host outcome of a reserved launch. Only forward transitions apply.
pub(crate) fn report_with(conn: &Connection, run_id: &str, state: &str, session_id: Option<&str>, error: Option<&str>, now: i64) -> Result<(), String> {
    match state {
        "running" => {
            let session = session_id.ok_or("A running session_create report requires its session id")?;
            if !bind_with(conn, run_id, session, now)? { return Err("Unknown session_create run".into()); }
            Ok(())
        }
        "failed" | "unknown" => {
            let error = error.map(|e| e.chars().take(2000).collect::<String>());
            conn.execute(
                "UPDATE session_spawn_requests SET state=?2, error=?3, updated_at=?4
                 WHERE run_id=?1 AND state='starting' AND session_id IS NULL",
                params![run_id, state, error, now],
            ).map_err(|e| e.to_string())?;
            Ok(())
        }
        _ => Err("Invalid session_create report state".into()),
    }
}

pub(crate) fn report(run_id: &str, state: &str, session_id: Option<&str>, error: Option<&str>) {
    let Some(db) = DB.get() else { return; };
    if let Err(error) = report_with(&db.0.lock(), run_id, state, session_id, error, now_ms()) {
        eprintln!("[session-spawn] report failed: {error}");
    }
}

/// The human sent a message in this chat: lift the created-chat restrictions.
pub(crate) fn promote_with(conn: &Connection, engine: &str, session_id: &str, now: i64) -> Result<bool, String> {
    let changed = conn.execute(
        "UPDATE session_spawn_origins SET promoted_at=?3 WHERE engine=?1 AND session_id=?2 AND promoted_at IS NULL",
        params![engine, session_id, now],
    ).map_err(|e| e.to_string())?;
    if changed > 0 { return Ok(true); }
    if !restricted_origin(conn, engine, session_id)? { return Ok(false); }
    // The trusted main-window composer can recover a chat whose binding did
    // not finish. Do not infer this authority from a model message or history.
    conn.execute(
        "INSERT INTO session_spawn_origins(engine,session_id,workspace_path,creator_engine,creator_session_id,
         creator_workspace_path,run_id,request_id,created_at,promoted_at)
         VALUES(?1,?2,'',?1,?2,'',?3,'human-takeover',?4,?4)",
        params![engine, session_id, format!("human-{}", uuid::Uuid::new_v4()), now],
    ).map(|changed| changed > 0).map_err(|e| e.to_string())
}

/// `send_message` gate: a created chat (or its managed children) cannot start
/// turns in other chats until the human takes it over.
pub(crate) fn check_send_message_with(conn: &Connection, engine: &str, session_id: &str) -> Result<(), String> {
    let (root_engine, root_session) = task_root(conn, engine, session_id)?;
    if restricted_origin(conn, &root_engine, &root_session)? {
        return Err("SPAWN_ORIGIN_RESTRICTED: this chat was created by session_create (or belongs to such a chat's task tree) and cannot message other chats until the human sends a message in it. Put your result in your normal reply; the creating chat reads it with session_create and the same request_id.".into());
    }
    Ok(())
}

pub(crate) fn check_send_message(engine: &str, session_id: &str) -> Result<(), String> {
    let db = store()?;
    check_send_message_with(&db.0.lock(), engine, session_id)
}

fn require_main(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Session provenance controls are available only in the main local window".into());
    }
    Ok(())
}

#[tauri::command]
pub fn session_spawn_report(
    window: tauri::WebviewWindow,
    run_id: String,
    state: String,
    session_id: Option<String>,
    error: Option<String>,
) -> Result<(), String> {
    require_main(&window)?;
    let db = store()?;
    report_with(&db.0.lock(), &run_id, &state, session_id.as_deref(), error.as_deref(), now_ms())
}

#[tauri::command]
pub fn session_origin_promote(window: tauri::WebviewWindow, engine: String, session_id: String) -> Result<bool, String> {
    require_main(&window)?;
    let Some(db) = DB.get() else { return Ok(false); };
    promote_with(&db.0.lock(), &engine, &session_id, now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        ensure_schema(&conn).unwrap();
        conn.execute_batch(
            "CREATE TABLE leader_branches (id TEXT PRIMARY KEY, parent_engine TEXT NOT NULL, parent_session_id TEXT NOT NULL,
                workspace_path TEXT NOT NULL, engine TEXT NOT NULL, session_id TEXT, state TEXT NOT NULL,
                record_json TEXT NOT NULL, permission TEXT NOT NULL);",
        ).unwrap();
        conn
    }

    fn caller(session: &str) -> Caller {
        Caller { run_id: "creator-run".into(), engine: "agy".into(), session_id: session.into(),
            workspace_path: "G:/human".into() }
    }

    fn args(id: &str) -> SessionCreateArgs {
        SessionCreateArgs { workspace_path: "G:/target".into(), engine: "codex".into(), message: "fix it".into(),
            request_id: id.into(), model: None, effort: None, title: None }
    }

    fn dead(_: &str) -> bool { false }

    fn code(result: Result<Grant, String>) -> String {
        result.unwrap_err().split(':').next().unwrap().to_string()
    }

    #[test]
    fn human_root_creates_and_created_chat_is_restricted_until_promoted() {
        let conn = conn();
        let grant = admit_with(&conn, &caller("human"), &args("a"), true, 1_000, &dead).unwrap();
        assert_eq!(grant.mode, "start");
        assert!(grant.run_id.starts_with("run-"));
        assert!(bind_with(&conn, &grant.run_id, "created", 1_100).unwrap());
        // The created chat can neither create nor message other chats.
        let created = Caller { engine: "codex".into(), ..caller("created") };
        assert_eq!(code(admit_with(&conn, &created, &args("b"), true, 2_000, &dead)), "SPAWN_ORIGIN_NOT_HUMAN");
        assert!(check_send_message_with(&conn, "codex", "created").unwrap_err().starts_with("SPAWN_ORIGIN_RESTRICTED"));
        // The creating human chat keeps messaging.
        check_send_message_with(&conn, "agy", "human").unwrap();
        // Human takeover lifts both restrictions.
        assert!(promote_with(&conn, "codex", "created", 3_000).unwrap());
        assert!(!promote_with(&conn, "codex", "created", 3_001).unwrap());
        check_send_message_with(&conn, "codex", "created").unwrap();
        assert_eq!(admit_with(&conn, &created, &args("c"), true, 4_000, &dead).unwrap().mode, "start");
    }

    #[test]
    fn replay_returns_status_and_conflicting_arguments_are_refused() {
        let conn = conn();
        let first = admit_with(&conn, &caller("human"), &args("same"), true, 1_000, &dead).unwrap();
        bind_with(&conn, &first.run_id, "created", 1_001).unwrap();
        let replay = admit_with(&conn, &caller("human"), &args("same"), false, 2_000, &dead).unwrap();
        assert_eq!((replay.mode, replay.run_id.as_str(), replay.session_id.as_deref(), replay.state.as_str()),
            ("replay", first.run_id.as_str(), Some("created"), "running"));
        let mut changed = args("same");
        changed.message = "different".into();
        assert_eq!(code(admit_with(&conn, &caller("human"), &changed, true, 2_000, &dead)), "REQUEST_ID_CONFLICT");
    }

    #[test]
    fn disabled_and_managed_children_are_refused() {
        let conn = conn();
        assert_eq!(code(admit_with(&conn, &caller("human"), &args("a"), false, 1, &dead)), "SESSION_CREATE_DISABLED");
        conn.execute("INSERT INTO leader_branches VALUES('b','agy','human','G:/human','agy','child','running','{}','default')", []).unwrap();
        assert_eq!(code(admit_with(&conn, &caller("child"), &args("a"), true, 1, &dead)), "SPAWN_CALLER_NOT_ROOT");
    }

    #[test]
    fn task_children_of_a_created_chat_inherit_the_message_restriction() {
        let conn = conn();
        let grant = admit_with(&conn, &caller("human"), &args("a"), true, 1, &dead).unwrap();
        bind_with(&conn, &grant.run_id, "created", 2).unwrap();
        conn.execute("INSERT INTO leader_branches VALUES('b1','codex','created','G:/target','claude','child','running','{}','default')", []).unwrap();
        conn.execute("INSERT INTO leader_branches VALUES('b2','claude','child','G:/target','codex','grandchild','running','{}','default')", []).unwrap();
        assert!(check_send_message_with(&conn, "codex", "grandchild").is_err());
        // Reclaimed branches no longer link a chat to the restricted root.
        conn.execute("UPDATE leader_branches SET state='reclaimed' WHERE id='b1'", []).unwrap();
        check_send_message_with(&conn, "claude", "child").unwrap();
    }

    #[test]
    fn rate_and_active_limits_bound_one_creator() {
        let conn = conn();
        for (i, id) in ["a", "b", "c"].iter().enumerate() {
            admit_with(&conn, &caller("human"), &args(id), true, 1_000 + i as i64, &dead).unwrap();
        }
        assert_eq!(code(admit_with(&conn, &caller("human"), &args("d"), true, 2_000, &dead)), "SPAWN_RATE_LIMITED");
        // After the window, five still-live runs hit the active cap.
        let live = |_: &str| true;
        admit_with(&conn, &caller("human"), &args("d"), true, 70_000, &live).unwrap();
        admit_with(&conn, &caller("human"), &args("e"), true, 70_001, &live).unwrap();
        assert_eq!(code(admit_with(&conn, &caller("human"), &args("f"), true, 140_000, &live)), "SPAWN_ACTIVE_LIMIT");
        // Finished runs (not live) and stale reservations stop counting.
        assert_eq!(admit_with(&conn, &caller("human"), &args("f"), true, 400_000, &dead).unwrap().mode, "start");
    }

    #[test]
    fn reports_only_move_forward_and_bindings_cannot_switch_sessions() {
        let conn = conn();
        let grant = admit_with(&conn, &caller("human"), &args("a"), true, 1, &dead).unwrap();
        report_with(&conn, &grant.run_id, "failed", None, Some("nothing was sent"), 2).unwrap();
        let replay = admit_with(&conn, &caller("human"), &args("a"), true, 3, &dead).unwrap();
        assert_eq!((replay.state.as_str(), replay.error.as_deref()), ("failed", Some("nothing was sent")));
        let other = admit_with(&conn, &caller("human"), &args("b"), true, 4, &dead).unwrap();
        bind_with(&conn, &other.run_id, "s1", 5).unwrap();
        report_with(&conn, &other.run_id, "failed", None, None, 6).unwrap();
        assert_eq!(admit_with(&conn, &caller("human"), &args("b"), true, 7, &dead).unwrap().state, "running");
        assert!(bind_with(&conn, &other.run_id, "s2", 8).is_err());
        assert!(!bind_with(&conn, "unrelated-run", "s3", 9).unwrap());
        assert!(report_with(&conn, &other.run_id, "completed", None, None, 10).is_err());
    }

    #[test]
    fn arguments_are_validated() {
        let mut bad = args("bad id!");
        assert!(bad.validate().is_err());
        bad = args("ok");
        bad.engine = "other".into();
        assert!(bad.validate().is_err());
        bad = args("ok");
        bad.message = "   ".into();
        assert!(bad.validate().is_err());
        bad = args("ok");
        bad.title = Some("a\nb".into());
        assert!(bad.validate().is_err());
        args("ok").validate().unwrap();
    }
}
