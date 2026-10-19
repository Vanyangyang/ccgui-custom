//! Sidechat (`/sidechat`) and ephemeral side-question (`/btw`) support across
//! the four primary local engines (`claude`, `codex`, `agy`, `cursor`).
//!
//! Native forks preserve available conversation history. Cache reuse is best
//! effort: permission/tool changes and provider behavior can invalidate it.
//! Side-session ownership is checked before resuming, promoting or deleting.

use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

pub const SUPPORTED_ENGINES: &[&str] = &["claude", "codex", "agy", "cursor"];
pub const BTW_RUN_PREFIX: &str = "btw-";
pub const SIDECHAT_RUN_PREFIX: &str = "sidechat-";
const HIDDEN_META_KEY: &str = "hidden_side_sessions";
const OWNERS_META_KEY: &str = "side_session_owners";

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SideSessionOwner {
    pub engine: String,
    pub workspace_path: String,
    pub parent_session_id: Option<String>,
}

static SESSION_OWNERS: LazyLock<Mutex<HashMap<(String, String), SideSessionOwner>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
struct SideRun {
    owner: SideSessionOwner,
    cancelled: bool,
    sessions: HashSet<String>,
    db: Option<Arc<crate::db::Db>>,
}
static SIDE_RUNS: LazyLock<Mutex<HashMap<String, SideRun>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn begin_run(
    run_id: &str,
    owner: SideSessionOwner,
    db: Option<Arc<crate::db::Db>>,
) -> Result<(), String> {
    let mut runs = SIDE_RUNS.lock().unwrap_or_else(|p| p.into_inner());
    if runs.contains_key(run_id) {
        return Err("Sidechat run ID is already in use".into());
    }
    runs.insert(
        run_id.to_string(),
        SideRun {
            owner,
            cancelled: false,
            sessions: HashSet::new(),
            db,
        },
    );
    Ok(())
}

pub fn cancel_run(key: &str) {
    for (run_id, run) in SIDE_RUNS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter_mut()
    {
        if run_id == key || run.sessions.contains(key) {
            run.cancelled = true;
        }
    }
}

pub fn finish_run(run_id: &str) {
    SIDE_RUNS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(run_id);
    remove_codex_spec(run_id);
}

/// Abort/panic backstop; normal settlement already retires this registration.
pub fn abort_run(run_id: &str) {
    let run = SIDE_RUNS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(run_id);
    remove_codex_spec(run_id);
    if is_ephemeral_run_id(run_id) {
        if let Some(run) = run {
            for sid in run.sessions {
                spawn_ephemeral_cleanup(run.db.clone(), run.owner.engine.clone(), Some(sid));
            }
        }
    }
}

pub fn run_owner(run_id: &str) -> Result<SideSessionOwner, String> {
    let runs = SIDE_RUNS.lock().unwrap_or_else(|p| p.into_inner());
    match runs.get(run_id) {
        Some(run) if !run.cancelled => Ok(run.owner.clone()),
        Some(_) => Err("Sidechat request was cancelled".into()),
        None => Err("Sidechat run has no ownership registration".into()),
    }
}

fn persist_owners(db: &crate::db::Db, owners: &HashMap<(String, String), SideSessionOwner>) {
    let entries: Vec<_> = owners
        .iter()
        .map(|((engine, sid), owner)| (engine, sid, owner))
        .collect();
    if let Ok(value) = serde_json::to_string(&entries) {
        let _ = db.0.lock().execute("INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", rusqlite::params![OWNERS_META_KEY, value]);
    }
}

pub fn register_owned_session(
    run_id: &str,
    session_id: &str,
    db: Option<&crate::db::Db>,
) -> Result<(), String> {
    // A launch acknowledgement may arrive after Stop. Still record its new
    // identity so abort cleanup can remove it, without permitting another turn.
    let owner = SIDE_RUNS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(run_id)
        .map(|run| run.owner.clone())
        .ok_or("Sidechat run has no ownership registration")?;
    if !is_safe_session_id(session_id) || owner.parent_session_id.as_deref() == Some(session_id) {
        return Err("Engine returned an invalid or parent Sidechat session identity".into());
    }
    if let Some(db) = db {
        ensure_hidden_loaded(db);
    }
    let mut owners = SESSION_OWNERS.lock().unwrap_or_else(|p| p.into_inner());
    let key = (owner.engine.clone(), session_id.to_string());
    if owners.get(&key).is_some_and(|existing| existing != &owner) {
        return Err("Sidechat session belongs to a different conversation".into());
    }
    {
        let mut runs = SIDE_RUNS.lock().unwrap_or_else(|p| p.into_inner());
        if runs.iter().any(|(other_id, run)| {
            other_id != run_id
                && !run.cancelled
                && run.owner.engine == owner.engine
                && run.sessions.contains(session_id)
        }) {
            return Err("Sidechat session already has an active writer".into());
        }
        runs.get_mut(run_id)
            .ok_or("Sidechat run was retired")?
            .sessions
            .insert(session_id.to_string());
    }
    owners.insert(key, owner.clone());
    if let Some(db) = db {
        persist_owners(db, &owners);
    }
    drop(owners);
    register_hidden_session(&owner.engine, session_id, db);
    Ok(())
}

pub fn validate_session_owner(
    owner: &SideSessionOwner,
    session_id: &str,
    db: Option<&crate::db::Db>,
) -> Result<(), String> {
    if let Some(db) = db {
        ensure_hidden_loaded(db);
    }
    if !is_safe_session_id(session_id)
        || owner.parent_session_id.as_deref() == Some(session_id)
        || !is_hidden_session(&owner.engine, session_id)
        || SESSION_OWNERS
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(&(owner.engine.clone(), session_id.to_string()))
            != Some(owner)
    {
        return Err(
            "Sidechat session does not belong to this workspace and parent conversation".into(),
        );
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub struct CodexSideSpec {
    pub fork_from: Option<String>,
    pub ephemeral: bool,
    pub fallback_prompt: Option<String>,
}

static HIDDEN_SESSIONS: LazyLock<Mutex<HashSet<(String, String)>>> =
    LazyLock::new(|| Mutex::new(HashSet::new()));
static HIDDEN_LOADED: LazyLock<Mutex<bool>> = LazyLock::new(|| Mutex::new(false));
static CODEX_SPECS: LazyLock<Mutex<HashMap<String, CodexSideSpec>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static AGY_PARENT_MAP: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn is_supported_engine(engine: &str) -> bool {
    SUPPORTED_ENGINES.contains(&engine)
}

pub fn is_side_run_id(run_id: &str) -> bool {
    run_id.starts_with(BTW_RUN_PREFIX) || run_id.starts_with(SIDECHAT_RUN_PREFIX)
}

pub fn is_ephemeral_run_id(run_id: &str) -> bool {
    run_id.starts_with(BTW_RUN_PREFIX)
}

pub fn is_safe_session_id(session_id: &str) -> bool {
    let trimmed = session_id.trim();
    trimmed == session_id
        && !trimmed.is_empty()
        && trimmed.len() <= 128
        && trimmed
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn set_codex_spec(run_id: &str, spec: CodexSideSpec) {
    CODEX_SPECS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(run_id.to_string(), spec);
}

pub fn codex_spec(run_id: &str) -> Option<CodexSideSpec> {
    CODEX_SPECS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(run_id)
        .cloned()
}

pub fn remove_codex_spec(run_id: &str) {
    CODEX_SPECS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(run_id);
}

pub fn ensure_hidden_loaded(db: &crate::db::Db) {
    let mut loaded = HIDDEN_LOADED.lock().unwrap_or_else(|p| p.into_inner());
    if *loaded {
        return;
    }
    *loaded = true;
    let raw: Option<String> = {
        let conn = db.0.lock();
        conn.query_row(
            "SELECT value FROM meta WHERE key = ?1",
            [HIDDEN_META_KEY],
            |r| r.get(0),
        )
        .ok()
    };
    if let Some(raw) = raw {
        if let Ok(items) = serde_json::from_str::<Vec<(String, String)>>(&raw) {
            let mut set = HIDDEN_SESSIONS.lock().unwrap_or_else(|p| p.into_inner());
            for (engine, sid) in items {
                if is_supported_engine(&engine) && is_safe_session_id(&sid) {
                    set.insert((engine, sid));
                }
            }
        }
    }
    let owners_raw: Option<String> =
        db.0.lock()
            .query_row(
                "SELECT value FROM meta WHERE key = ?1",
                [OWNERS_META_KEY],
                |r| r.get(0),
            )
            .ok();
    if let Some(entries) = owners_raw
        .and_then(|raw| serde_json::from_str::<Vec<(String, String, SideSessionOwner)>>(&raw).ok())
    {
        let mut owners = SESSION_OWNERS.lock().unwrap_or_else(|p| p.into_inner());
        for (engine, sid, owner) in entries {
            if is_supported_engine(&engine)
                && is_safe_session_id(&sid)
                && engine == owner.engine
                && owner.parent_session_id.as_deref() != Some(&sid)
            {
                owners.insert((engine, sid), owner);
            }
        }
    }
}

fn persist_hidden_sessions(db: &crate::db::Db, set: &HashSet<(String, String)>) {
    let list: Vec<(&str, &str)> = set.iter().map(|(e, s)| (e.as_str(), s.as_str())).collect();
    if let Ok(serialized) = serde_json::to_string(&list) {
        let conn = db.0.lock();
        let _ = conn.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![HIDDEN_META_KEY, serialized],
        );
    }
}

pub fn register_hidden_session(engine: &str, session_id: &str, db: Option<&crate::db::Db>) {
    let sid = session_id.trim();
    if !is_supported_engine(engine) || !is_safe_session_id(sid) {
        return;
    }
    if let Some(db) = db {
        ensure_hidden_loaded(db);
    }
    let mut set = HIDDEN_SESSIONS.lock().unwrap_or_else(|p| p.into_inner());
    if set.insert((engine.to_string(), sid.to_string())) {
        if let Some(db) = db {
            persist_hidden_sessions(db, &set);
        }
    }
}

pub fn unregister_hidden_session(
    engine: &str,
    session_id: &str,
    db: Option<&crate::db::Db>,
) -> bool {
    let sid = session_id.trim();
    if let Some(db) = db {
        ensure_hidden_loaded(db);
    }
    let mut set = HIDDEN_SESSIONS.lock().unwrap_or_else(|p| p.into_inner());
    let removed = set.remove(&(engine.to_string(), sid.to_string()));
    if removed {
        if let Some(db) = db {
            persist_hidden_sessions(db, &set);
        }
    }
    drop(set);
    let mut owners = SESSION_OWNERS.lock().unwrap_or_else(|p| p.into_inner());
    owners.remove(&(engine.to_string(), sid.to_string()));
    if let Some(db) = db {
        persist_owners(db, &owners);
    }
    removed
}

pub fn is_hidden_session(engine: &str, session_id: &str) -> bool {
    let sid = session_id.trim();
    if sid.is_empty() {
        return false;
    }
    HIDDEN_SESSIONS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .contains(&(engine.to_string(), sid.to_string()))
}

/// Format the prompt for `/btw` (`ephemeral = true`) or `/sidechat` (`ephemeral = false`).
/// Appends a trailing `<system-reminder>` after the user's message so the entire
/// prior conversation history can be reused where the provider permits it.
pub fn format_side_prompt(
    prompt: &str,
    ephemeral: bool,
    fallback_transcript: Option<&str>,
) -> String {
    let mut out = String::new();
    if let Some(transcript) = fallback_transcript.map(str::trim).filter(|t| !t.is_empty()) {
        out.push_str("<conversation-context>\n");
        out.push_str(transcript);
        out.push_str("\n</conversation-context>\n\n");
    }
    out.push_str(prompt.trim());
    if ephemeral {
        out.push_str(
            "\n\n<system-reminder>\n\
             The user is asking a quick side question (/btw) about the conversation so far. \
             Answer directly and concisely based on the existing context. \
             Do not edit files, run commands, or modify workspace state; only use read-only inspection if strictly necessary to answer the question.\n\
             </system-reminder>",
        );
    } else {
        out.push_str(
            "\n\n<system-reminder>\n\
             This turn is in a forked Sidechat branch (/sidechat) alongside the main conversation. \
             Answer the user's question or explore the topic directly in read-only mode without modifying files or workspace state.\n\
             </system-reminder>",
        );
    }
    out
}

/// Add `--fork-session` and/or `--no-session-persistence` to a Claude command.
pub fn apply_claude_flags(
    command: &mut tokio::process::Command,
    fork_session: bool,
    ephemeral: bool,
) {
    // A user-configured permission allow rule must not turn a side question
    // into a write. Restrict built-ins and disable ambient MCP capabilities.
    command.args([
        "--tools",
        "Read,Grep,Glob",
        "--strict-mcp-config",
        "--mcp-config",
        "{\"mcpServers\":{}}",
    ]);
    if fork_session {
        command.arg("--fork-session");
    }
    if ephemeral {
        command.arg("--no-session-persistence");
    }
}

/// Check if a Claude parent session `.jsonl` file exists and is non-empty on disk.
pub fn claude_session_exists(
    claude_home: &Path,
    workspace: &Path,
    session_id: &str,
    db: Option<&crate::db::Db>,
) -> bool {
    if !is_safe_session_id(session_id) {
        return false;
    }
    if let Some(db) = db {
        if let Ok(Some(path)) =
            crate::history::reader::find_session_file_path(db, "claude", session_id)
        {
            if std::fs::metadata(&path).is_ok_and(|m| m.is_file() && m.len() > 0) {
                return true;
            }
        }
    }
    let projects = claude_home.join("projects");
    let raw = workspace.to_string_lossy().to_string();
    let trimmed = raw.trim_end_matches(['/', '\\']).to_string();
    let mut spellings = vec![raw.clone(), trimmed.clone()];
    for s in [&raw, &trimmed] {
        if let Ok(canon) = std::fs::canonicalize(s) {
            let canon_str = canon.to_string_lossy();
            let stripped = canon_str
                .strip_prefix(r"\\?\")
                .unwrap_or(&canon_str)
                .to_string();
            if !spellings.contains(&stripped) {
                spellings.push(stripped);
            }
        }
    }
    for spelling in spellings {
        if spelling.is_empty() {
            continue;
        }
        let candidate = projects
            .join(crate::history::claude_encode_project_path(&spelling))
            .join(format!("{session_id}.jsonl"));
        if std::fs::metadata(&candidate).is_ok_and(|m| m.is_file() && m.len() > 0) {
            return true;
        }
    }
    // Fallback: scan immediate subdirectories of `projects` in case the session
    // was started from a parent or worktree path.
    if let Ok(entries) = std::fs::read_dir(&projects) {
        for entry in entries.flatten() {
            let candidate = entry.path().join(format!("{session_id}.jsonl"));
            if std::fs::metadata(&candidate).is_ok_and(|m| m.is_file() && m.len() > 0) {
                return true;
            }
        }
    }
    false
}

fn matches_codex_session_file(path: &Path, session_id: &str) -> bool {
    let plain = crate::history::codex_rollout::plain_path(path);
    let suffix = format!("{session_id}.jsonl");
    plain
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == suffix || name.ends_with(&format!("-{suffix}")))
}

/// Check if a Codex parent session rollout exists in either disk representation.
pub fn codex_session_exists(session_id: &str, db: Option<&crate::db::Db>) -> bool {
    if !is_safe_session_id(session_id) {
        return false;
    }
    if let Some(db) = db {
        if let Ok(Some(path)) =
            crate::history::reader::find_session_file_path(db, "codex", session_id)
        {
            if std::fs::metadata(&path).is_ok_and(|m| m.is_file() && m.len() > 0) {
                return true;
            }
        }
    }
    crate::history::discovery::codex_candidates()
        .into_iter()
        .any(|cand| matches_codex_session_file(&cand, session_id))
}

fn replace_bytes(haystack: &[u8], needle: &[u8], replacement: &[u8]) -> Option<Vec<u8>> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    let mut out = Vec::with_capacity(haystack.len());
    let mut i = 0;
    let mut changed = false;
    while i <= haystack.len() - needle.len() {
        if &haystack[i..i + needle.len()] == needle {
            out.extend_from_slice(replacement);
            i += needle.len();
            changed = true;
        } else {
            out.push(haystack[i]);
            i += 1;
        }
    }
    if !changed {
        return None;
    }
    out.extend_from_slice(&haystack[i..]);
    Some(out)
}

pub fn fork_agy_conversation(parent_id: &str) -> Result<String, String> {
    let home = agy_session_home(parent_id)?.ok_or("AGY parent conversation was not found")?;
    fork_agy_conversation_in(&home, parent_id)
}

fn agy_session_home(session_id: &str) -> Result<Option<PathBuf>, String> {
    Ok(crate::engine::agy::session_db(session_id)?
        .and_then(|path| path.parent().and_then(Path::parent).map(Path::to_path_buf)))
}

/// Fork an Antigravity (`agy`) SQLite conversation `<parent_id>.db` into a new
/// `<fork_id>.db` using SQLite `VACUUM INTO` (safe while the parent conversation
/// is open/streaming in WAL mode), rewriting the 36-byte `cascade_id` and
/// `trajectory_id` so `agy --conversation <fork_id> --mode plan` reuses the
/// warm prompt cache without mutating the parent trajectory.
pub fn fork_agy_conversation_in(home: &Path, parent_id: &str) -> Result<String, String> {
    let parent_uuid = uuid::Uuid::parse_str(parent_id.trim())
        .map_err(|_| format!("invalid AGY conversation UUID: {parent_id}"))?;
    let parent_canonical = parent_uuid.to_string();
    let conv_dir = home.join("conversations");
    let src_path = conv_dir.join(format!("{parent_canonical}.db"));
    if !src_path.is_file() {
        return Err(format!(
            "AGY parent conversation file not found: {}",
            src_path.display()
        ));
    }
    let fork_id = uuid::Uuid::new_v4().to_string();
    let new_tid = uuid::Uuid::new_v4().to_string();
    let dst_path = conv_dir.join(format!("{fork_id}.db"));

    let rewrite_result = (|| -> Result<(), String> {
        let src_conn = rusqlite::Connection::open_with_flags(
            &src_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|e| format!("open AGY parent db: {e}"))?;
        src_conn
            .execute(
                "VACUUM INTO ?1",
                rusqlite::params![dst_path.to_string_lossy().as_ref()],
            )
            .map_err(|e| format!("vacuum AGY parent db into fork: {e}"))?;
        drop(src_conn);
        let mut dst_conn =
            rusqlite::Connection::open(&dst_path).map_err(|e| format!("open AGY fork db: {e}"))?;

        let old_tid: Option<String> = dst_conn
            .query_row(
                "SELECT trajectory_id FROM trajectory_meta LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| format!("read AGY trajectory_meta: {e}"))?;
        if old_tid
            .as_deref()
            .is_none_or(|id| uuid::Uuid::parse_str(id).is_err())
        {
            return Err("AGY parent trajectory metadata is missing or invalid".into());
        }

        let tx = dst_conn
            .transaction()
            .map_err(|e| format!("begin AGY fork rewrite tx: {e}"))?;

        tx.execute(
            "UPDATE trajectory_meta SET cascade_id = ?1, trajectory_id = ?2",
            rusqlite::params![&fork_id, &new_tid],
        )
        .map_err(|e| format!("update AGY trajectory_meta: {e}"))?;

        tx.execute(
            "UPDATE steps SET trajectory_id = ?1",
            rusqlite::params![&new_tid],
        )
        .map_err(|e| format!("update AGY steps: {e}"))?;
        tx.execute(
            "UPDATE gen_metadata SET trajectory_id = ?1",
            rusqlite::params![&new_tid],
        )
        .map_err(|e| format!("update AGY generation metadata: {e}"))?;
        tx.execute(
            "UPDATE trajectory_metadata_blob SET trajectory_id = ?1",
            rusqlite::params![&new_tid],
        )
        .map_err(|e| format!("update AGY trajectory metadata: {e}"))?;

        let old_cid_bytes = parent_canonical.as_bytes();
        let new_cid_bytes = fork_id.as_bytes();
        let old_tid_bytes = old_tid
            .as_deref()
            .filter(|s| s.len() == new_tid.len())
            .map(str::as_bytes);
        let new_tid_bytes = new_tid.as_bytes();

        // Rewrite embedded cascade_id / trajectory_id inside steps.step_blob
        if let Ok(mut stmt) = tx.prepare("SELECT rowid, step_blob FROM steps") {
            let updates: Vec<(i64, Vec<u8>)> = stmt
                .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))
                .ok()
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .filter_map(|(rowid, blob)| {
                    let mut current = replace_bytes(&blob, old_cid_bytes, new_cid_bytes);
                    if let Some(old_t) = old_tid_bytes {
                        let base = current.as_deref().unwrap_or(&blob);
                        if let Some(replaced) = replace_bytes(base, old_t, new_tid_bytes) {
                            current = Some(replaced);
                        }
                    }
                    current.map(|b| (rowid, b))
                })
                .collect();
            for (rowid, new_blob) in updates {
                let _ = tx.execute(
                    "UPDATE steps SET step_blob = ?1 WHERE rowid = ?2",
                    rusqlite::params![new_blob, rowid],
                );
            }
        }

        // Rewrite embedded cascade_id / trajectory_id inside trajectory_metadata_blob.metadata_blob
        if let Ok(mut stmt) =
            tx.prepare("SELECT rowid, metadata_blob FROM trajectory_metadata_blob")
        {
            let updates: Vec<(i64, Vec<u8>)> = stmt
                .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))
                .ok()
                .into_iter()
                .flatten()
                .filter_map(Result::ok)
                .filter_map(|(rowid, blob)| {
                    let mut current = replace_bytes(&blob, old_cid_bytes, new_cid_bytes);
                    if let Some(old_t) = old_tid_bytes {
                        let base = current.as_deref().unwrap_or(&blob);
                        if let Some(replaced) = replace_bytes(base, old_t, new_tid_bytes) {
                            current = Some(replaced);
                        }
                    }
                    current.map(|b| (rowid, b))
                })
                .collect();
            for (rowid, new_blob) in updates {
                let _ = tx.execute(
                    "UPDATE trajectory_metadata_blob SET metadata_blob = ?1 WHERE rowid = ?2",
                    rusqlite::params![new_blob, rowid],
                );
            }
        }

        tx.commit()
            .map_err(|e| format!("commit AGY fork rewrite: {e}"))?;
        Ok(())
    })();
    if let Err(error) = rewrite_result {
        cleanup_agy_session_in(home, &fork_id);
        return Err(error);
    }

    AGY_PARENT_MAP
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(fork_id.clone(), parent_canonical);

    Ok(fork_id)
}

pub(crate) fn find_cursor_chat_dir(home: &Path, session_id: &str) -> Option<PathBuf> {
    if !is_safe_session_id(session_id) {
        return None;
    }
    let chats_root = home.join("chats");
    let entries = std::fs::read_dir(&chats_root).ok()?;
    for entry in entries.flatten() {
        let ws_dir = entry.path();
        if !ws_dir.is_dir() {
            continue;
        }
        let candidate = ws_dir.join(session_id);
        if candidate.join("store.db").is_file() {
            return Some(candidate);
        }
    }
    None
}

pub(crate) fn hex_decode(hex: &str) -> Option<Vec<u8>> {
    let bytes = hex.trim().as_bytes();
    if bytes.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for chunk in bytes.chunks_exact(2) {
        let hi = (chunk[0] as char).to_digit(16)? as u8;
        let lo = (chunk[1] as char).to_digit(16)? as u8;
        out.push((hi << 4) | lo);
    }
    Some(out)
}

pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

pub fn fork_cursor_conversation(parent_id: &str) -> Result<String, String> {
    fork_cursor_conversation_in(&crate::engine::cursor::cursor_home(), parent_id)
}

/// Fork a Cursor CLI (`cursor-agent`) chat `<parent_id>/store.db` into a sibling
/// `<fork_id>/store.db` using SQLite `VACUUM INTO`, updating `agentId` inside
/// the hex-encoded `meta` (`key = '0'`) JSON while keeping all content-addressed
/// Merkle blobs and `latestRootBlobId` intact.
pub fn fork_cursor_conversation_in(home: &Path, parent_id: &str) -> Result<String, String> {
    if !is_safe_session_id(parent_id) {
        return Err(format!("invalid Cursor session id: {parent_id}"));
    }
    let parent_dir = find_cursor_chat_dir(home, parent_id.trim())
        .ok_or_else(|| format!("Cursor parent chat store.db not found for {parent_id}"))?;
    let ws_dir = parent_dir
        .parent()
        .ok_or_else(|| "Cursor parent chat directory has no workspace parent".to_string())?;
    let fork_id = uuid::Uuid::new_v4().to_string();
    let fork_dir = ws_dir.join(&fork_id);
    std::fs::create_dir_all(&fork_dir)
        .map_err(|e| format!("create Cursor fork dir {}: {e}", fork_dir.display()))?;

    let src_meta_json = parent_dir.join("meta.json");
    if src_meta_json.is_file() {
        let _ = std::fs::copy(&src_meta_json, fork_dir.join("meta.json"));
    }

    let src_db = parent_dir.join("store.db");
    let dst_db = fork_dir.join("store.db");
    let rewrite_result = (|| -> Result<(), String> {
        let src_conn = rusqlite::Connection::open_with_flags(
            &src_db,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|e| format!("open Cursor parent store.db: {e}"))?;
        src_conn
            .execute(
                "VACUUM INTO ?1",
                rusqlite::params![dst_db.to_string_lossy().as_ref()],
            )
            .map_err(|e| format!("vacuum Cursor parent store.db into fork: {e}"))?;
        drop(src_conn);
        let dst_conn = rusqlite::Connection::open(&dst_db)
            .map_err(|e| format!("open Cursor fork store.db: {e}"))?;
        let raw_hex: Option<String> = dst_conn
            .query_row("SELECT value FROM meta WHERE key = '0'", [], |r| r.get(0))
            .optional()
            .map_err(|e| format!("read Cursor store.db meta: {e}"))?;
        let raw_hex = raw_hex.ok_or("Cursor fork metadata is missing")?;
        let decoded = hex_decode(&raw_hex).ok_or("Cursor fork metadata is not valid hex")?;
        let mut meta_val: Value = serde_json::from_slice(&decoded)
            .map_err(|_| "Cursor fork metadata is not valid JSON")?;
        {
            let obj = meta_val
                .as_object_mut()
                .ok_or("Cursor fork metadata is not an object")?;
            if obj.get("agentId").and_then(Value::as_str) != Some(parent_id.trim()) {
                return Err("Cursor fork metadata does not identify the parent session".into());
            }
            obj.insert("agentId".to_string(), json!(&fork_id));
            let encoded_json = serde_json::to_vec(&meta_val)
                .map_err(|e| format!("encode Cursor meta JSON: {e}"))?;
            let new_hex = hex_encode(&encoded_json);
            dst_conn
                .execute(
                    "UPDATE meta SET value = ?1 WHERE key = '0'",
                    rusqlite::params![new_hex],
                )
                .map_err(|e| format!("update Cursor store.db meta: {e}"))?;
        }
        Ok(())
    })();

    if let Err(err) = rewrite_result {
        let _ = std::fs::remove_dir_all(&fork_dir);
        return Err(err);
    }

    Ok(fork_id)
}

pub fn cleanup_agy_session_in(home: &Path, session_id: &str) {
    if !is_safe_session_id(session_id) {
        return;
    }
    let sid = session_id.trim();
    let conv_dir = home.join("conversations");
    for suffix in [".db", ".db-wal", ".db-shm"] {
        let _ = std::fs::remove_file(conv_dir.join(format!("{sid}{suffix}")));
    }
    let brain_dir = home.join("brain").join(sid);
    if brain_dir.is_dir() {
        let _ = std::fs::remove_dir_all(&brain_dir);
    }
    let summaries_db = home.join("conversation_summaries.db");
    if summaries_db.is_file() {
        if let Ok(conn) = rusqlite::Connection::open(&summaries_db) {
            let _ = conn.execute(
                "DELETE FROM conversation_summaries WHERE conversation_id = ?1",
                rusqlite::params![sid],
            );
        }
    }
    let parent_id = AGY_PARENT_MAP
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(sid);
    let last_conv_path = home.join("cache").join("last_conversations.json");
    if let Ok(text) = std::fs::read_to_string(&last_conv_path) {
        if let Ok(mut map) = serde_json::from_str::<serde_json::Map<String, Value>>(&text) {
            let mut changed = false;
            let keys: Vec<String> = map
                .iter()
                .filter_map(|(k, v)| (v.as_str() == Some(sid)).then(|| k.clone()))
                .collect();
            for key in keys {
                changed = true;
                if let Some(ref pid) = parent_id {
                    map.insert(key, json!(pid));
                } else {
                    map.remove(&key);
                }
            }
            if changed {
                if let Ok(updated) = serde_json::to_string_pretty(&map) {
                    let _ = std::fs::write(&last_conv_path, updated);
                }
            }
        }
    }
}

pub fn cleanup_cursor_session_in(home: &Path, session_id: &str) {
    if !is_safe_session_id(session_id) {
        return;
    }
    let sid = session_id.trim();
    if let Ok(entries) = std::fs::read_dir(home.join("chats")) {
        for entry in entries.flatten() {
            let candidate = entry.path().join(sid);
            if candidate.is_dir() {
                let _ = std::fs::remove_dir_all(&candidate);
            }
        }
    }
    if let Ok(entries) = std::fs::read_dir(home.join("projects")) {
        for entry in entries.flatten() {
            let transcripts = entry.path().join("agent-transcripts");
            let dir_candidate = transcripts.join(sid);
            if dir_candidate.is_dir() {
                let _ = std::fs::remove_dir_all(&dir_candidate);
            }
            let file_candidate = transcripts.join(format!("{sid}.jsonl"));
            if file_candidate.is_file() {
                let _ = std::fs::remove_file(&file_candidate);
            }
        }
    }
}

pub fn cleanup_claude_session_in(home: &Path, session_id: &str) {
    if !is_safe_session_id(session_id) {
        return;
    }
    let sid = session_id.trim();
    if let Ok(entries) = std::fs::read_dir(home.join("projects")) {
        for entry in entries.flatten() {
            let proj = entry.path();
            if !proj.is_dir() {
                continue;
            }
            let file = proj.join(format!("{sid}.jsonl"));
            if file.is_file() {
                let _ = std::fs::remove_file(&file);
            }
            let sub_dir = proj.join(sid);
            if sub_dir.is_dir() {
                let _ = std::fs::remove_dir_all(&sub_dir);
            }
        }
    }
}

pub fn cleanup_codex_session(session_id: &str) {
    if !is_safe_session_id(session_id) {
        return;
    }
    cleanup_codex_candidates(session_id, crate::history::discovery::codex_candidates());
}

fn cleanup_codex_candidates(session_id: &str, candidates: impl IntoIterator<Item = PathBuf>) {
    if !is_safe_session_id(session_id) {
        return;
    }
    let sid = session_id.trim();
    for path in candidates {
        if matches_codex_session_file(&path, sid) {
            let _ = crate::history::codex_rollout::remove_files(&path);
        }
    }
}

pub fn cleanup_side_session_blocking(
    db: Option<&crate::db::Db>,
    engine: &str,
    session_id: &str,
) -> Result<(), String> {
    let sid = session_id.trim();
    if !is_supported_engine(engine) || !is_safe_session_id(sid) {
        return Err("Invalid Sidechat session identity".into());
    }
    if let Some(db) = db {
        ensure_hidden_loaded(db);
    }
    // Never delete an arbitrary native conversation, even through an internal
    // delayed cleanup or an invalid engine identity announcement.
    if !is_hidden_session(engine, sid) {
        return Ok(());
    }
    let mut remains = false;
    match engine {
        "claude" => {
            let home = crate::engine::engine_home(Some("CLAUDE_CONFIG_DIR"), ".claude");
            cleanup_claude_session_in(&home, sid);
            remains = claude_session_exists(&home, Path::new(""), sid, None);
        }
        "codex" => {
            cleanup_codex_session(sid);
            remains = codex_session_exists(sid, None);
        }
        "agy" => {
            if let Some(home) = agy_session_home(sid)? {
                cleanup_agy_session_in(&home, sid);
                remains = home
                    .join("conversations")
                    .join(format!("{sid}.db"))
                    .exists()
                    || home.join("brain").join(sid).exists();
            }
        }
        "cursor" => {
            cleanup_cursor_session_in(&crate::engine::cursor::cursor_home(), sid);
            remains = find_cursor_chat_dir(&crate::engine::cursor::cursor_home(), sid).is_some();
        }
        _ => {}
    }
    if remains {
        return Err("Sidechat files are still in use; retry cleanup after the engine exits".into());
    }
    if let Some(db) = db {
        let conn = db.0.lock();
        for table in [
            "sessions",
            "session_models",
            "session_efforts",
            "session_providers",
            "session_archives",
        ] {
            let _ = conn.execute(
                &format!("DELETE FROM {table} WHERE engine=?1 AND session_id=?2"),
                rusqlite::params![engine, sid],
            );
        }
        if engine == "claude" {
            let _ = conn.execute(
                "DELETE FROM session_claude_options WHERE session_id=?1",
                [sid],
            );
        }
    }
    unregister_hidden_session(engine, sid, db);
    Ok(())
}

pub fn spawn_ephemeral_cleanup(
    db: Option<Arc<crate::db::Db>>,
    engine: String,
    session_id: Option<String>,
) {
    let Some(sid) = session_id.filter(|s| is_safe_session_id(s)) else {
        return;
    };
    tokio::task::spawn_blocking(move || {
        if let Err(error) = cleanup_side_session_blocking(db.as_deref(), &engine, &sid) {
            eprintln!("[sidechat] temporary session cleanup failed: {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compressed_codex_session_is_found_through_a_stale_plain_index() {
        let dir = std::env::temp_dir().join(format!("ccgui-sidechat-zstd-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = crate::db::Db::open_at(&dir.join("app.db")).unwrap();
        let sid = uuid::Uuid::new_v4().to_string();
        let raw = dir.join(format!("rollout-2026-10-01T00-00-00-{sid}.jsonl"));
        let compressed = raw.with_extension("jsonl.zst");
        std::fs::write(&compressed, zstd::stream::encode_all(b"{}\n".as_slice(), 1).unwrap()).unwrap();
        db.0.lock().execute(
            "INSERT INTO sessions(engine, session_id, workspace_path, file_path, file_size, file_mtime_ms, title)
             VALUES('codex', ?1, '/workspace', ?2, 1, 1, 'compressed')",
            rusqlite::params![sid, raw.to_string_lossy()],
        ).unwrap();
        assert!(codex_session_exists(&sid, Some(&db)));
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn codex_cleanup_removes_both_representations_of_only_the_owned_session() {
        let dir = std::env::temp_dir().join(format!("ccgui-sidechat-clean-zstd-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let sid = uuid::Uuid::new_v4().to_string();
        let raw = dir.join(format!("rollout-2026-10-01T00-00-00-{sid}.jsonl"));
        let compressed = raw.with_extension("jsonl.zst");
        let foreign = dir.join(format!("rollout-2026-10-01T00-00-00-foreign{sid}.jsonl.zst"));
        let backup = dir.join(format!("rollout-2026-10-01T00-00-00-{sid}.jsonl.zst.tmp"));
        for path in [&raw, &compressed, &foreign, &backup] {
            std::fs::write(path, b"test fixture").unwrap();
        }
        // Discovery prefers raw when both representations exist.
        cleanup_codex_candidates(&sid, [raw.clone(), foreign.clone(), backup.clone()]);
        assert!(!raw.exists());
        assert!(!compressed.exists());
        assert!(foreign.exists());
        assert!(backup.exists());
        // A compressed-only candidate has the same exact session identity.
        std::fs::write(&compressed, b"test fixture").unwrap();
        cleanup_codex_candidates(&sid, [compressed.clone()]);
        assert!(!compressed.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn session_ownership_rejects_parent_foreign_workspace_and_cancelled_runs() {
        let run_id = format!("sidechat-{}", uuid::Uuid::new_v4());
        let parent = uuid::Uuid::new_v4().to_string();
        let sid = uuid::Uuid::new_v4().to_string();
        let owner = SideSessionOwner {
            engine: "claude".into(),
            workspace_path: "/workspace".into(),
            parent_session_id: Some(parent.clone()),
        };
        begin_run(&run_id, owner.clone(), None).unwrap();
        assert!(begin_run(&run_id, owner.clone(), None).is_err());
        assert!(register_owned_session(&run_id, &parent, None).is_err());
        assert!(!is_hidden_session("claude", &parent));
        register_owned_session(&run_id, &sid, None).unwrap();
        assert!(validate_session_owner(&owner, &sid, None).is_ok());
        let competing_run = format!("sidechat-{}", uuid::Uuid::new_v4());
        begin_run(&competing_run, owner.clone(), None).unwrap();
        assert!(register_owned_session(&competing_run, &sid, None).is_err());
        finish_run(&competing_run);
        let mut foreign = owner.clone();
        foreign.workspace_path = "/elsewhere".into();
        assert!(validate_session_owner(&foreign, &sid, None).is_err());
        foreign = owner.clone();
        foreign.parent_session_id = None;
        assert!(validate_session_owner(&foreign, &sid, None).is_err());
        cancel_run(&run_id);
        assert!(run_owner(&run_id).is_err());
        abort_run(&run_id);
        assert!(run_owner(&run_id).is_err());
        unregister_hidden_session("claude", &sid, None);
    }

    #[test]
    fn malformed_cursor_metadata_never_produces_a_resumable_fork() {
        let temp =
            std::env::temp_dir().join(format!("ccgui-cursor-invalid-{}", uuid::Uuid::new_v4()));
        let parent_id = uuid::Uuid::new_v4().to_string();
        let parent_dir = temp.join("chats").join("workspace").join(&parent_id);
        std::fs::create_dir_all(&parent_dir).unwrap();
        let conn = rusqlite::Connection::open(parent_dir.join("store.db")).unwrap();
        conn.execute_batch("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('0', 'not-hex');").unwrap();
        drop(conn);
        assert!(fork_cursor_conversation_in(&temp, &parent_id).is_err());
        assert_eq!(
            std::fs::read_dir(temp.join("chats/workspace"))
                .unwrap()
                .count(),
            1
        );
        std::fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn malformed_agy_schema_does_not_leave_a_partial_fork() {
        let temp = std::env::temp_dir().join(format!("ccgui-agy-invalid-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(temp.join("conversations")).unwrap();
        let parent_id = uuid::Uuid::new_v4().to_string();
        let conn =
            rusqlite::Connection::open(temp.join("conversations").join(format!("{parent_id}.db")))
                .unwrap();
        conn.execute_batch("CREATE TABLE unexpected (id TEXT);")
            .unwrap();
        drop(conn);
        assert!(fork_agy_conversation_in(&temp, &parent_id).is_err());
        assert_eq!(
            std::fs::read_dir(temp.join("conversations"))
                .unwrap()
                .count(),
            1
        );
        std::fs::remove_dir_all(temp).unwrap();
    }

    #[test]
    fn claude_side_runs_disable_mutating_tools_and_ambient_mcp() {
        let mut command = tokio::process::Command::new("claude");
        apply_claude_flags(&mut command, true, true);
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|a| a.to_string_lossy().to_string())
            .collect();
        assert!(args.windows(2).any(|a| a == ["--tools", "Read,Grep,Glob"]));
        assert!(args.contains(&"--strict-mcp-config".into()));
        assert!(args.contains(&"--fork-session".into()));
        assert!(args.contains(&"--no-session-persistence".into()));
    }

    #[test]
    fn supported_engines_and_run_id_prefixes_are_strict() {
        for engine in ["claude", "codex", "agy", "cursor"] {
            assert!(is_supported_engine(engine));
        }
        for unsupported in ["kimi", "grok", "opencode", "pi", "omp", "dsh", "qoder"] {
            assert!(!is_supported_engine(unsupported));
        }
        assert!(is_side_run_id("btw-123"));
        assert!(is_ephemeral_run_id("btw-123"));
        assert!(is_side_run_id("sidechat-456"));
        assert!(!is_ephemeral_run_id("sidechat-456"));
        assert!(!is_side_run_id("ordinary-run-789"));
    }

    #[test]
    fn format_side_prompt_appends_reminder_after_user_prompt() {
        let btw = format_side_prompt("what does foo do?", true, None);
        assert!(btw.starts_with("what does foo do?"));
        assert!(btw.contains("<system-reminder>"));
        assert!(btw.contains("(/btw)"));

        let with_ctx = format_side_prompt("explain bar", false, Some("User: hi\nAssistant: hello"));
        assert!(with_ctx.starts_with("<conversation-context>\nUser: hi\nAssistant: hello\n</conversation-context>\n\nexplain bar"));
        assert!(with_ctx.contains("(/sidechat)"));
    }

    #[test]
    fn fork_and_cleanup_agy_conversation_rewrites_ids_and_cleans_up() {
        let temp =
            std::env::temp_dir().join(format!("ccgui-agy-fork-test-{}", uuid::Uuid::new_v4()));
        let conv_dir = temp.join("conversations");
        let cache_dir = temp.join("cache");
        std::fs::create_dir_all(&conv_dir).unwrap();
        std::fs::create_dir_all(&cache_dir).unwrap();

        let parent_id = uuid::Uuid::new_v4().to_string();
        let old_tid = uuid::Uuid::new_v4().to_string();
        let parent_db = conv_dir.join(format!("{parent_id}.db"));
        {
            let conn = rusqlite::Connection::open(&parent_db).unwrap();
            conn.execute_batch(
                "CREATE TABLE trajectory_meta (trajectory_id TEXT, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
                 CREATE TABLE steps (trajectory_id TEXT, step_index INTEGER, step_blob BLOB);
                 CREATE TABLE gen_metadata (trajectory_id TEXT, step_index INTEGER, metadata_blob BLOB);
                 CREATE TABLE trajectory_metadata_blob (trajectory_id TEXT, metadata_blob BLOB);",
            ).unwrap();
            conn.execute(
                "INSERT INTO trajectory_meta VALUES (?1, ?2, 1, 1)",
                rusqlite::params![&old_tid, &parent_id],
            )
            .unwrap();
            let blob = format!("prefix:{parent_id}:mid:{old_tid}:suffix").into_bytes();
            conn.execute(
                "INSERT INTO steps VALUES (?1, 0, ?2)",
                rusqlite::params![&old_tid, &blob],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO trajectory_metadata_blob VALUES (?1, ?2)",
                rusqlite::params![&old_tid, &blob],
            )
            .unwrap();
        }

        let fork_id = fork_agy_conversation_in(&temp, &parent_id).unwrap();
        assert_ne!(fork_id, parent_id);
        let fork_db = conv_dir.join(format!("{fork_id}.db"));
        assert!(fork_db.is_file());

        {
            let conn = rusqlite::Connection::open(&fork_db).unwrap();
            let (new_tid, cid): (String, String) = conn
                .query_row(
                    "SELECT trajectory_id, cascade_id FROM trajectory_meta",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(cid, fork_id);
            assert_ne!(new_tid, old_tid);

            let step_blob: Vec<u8> = conn
                .query_row("SELECT step_blob FROM steps", [], |r| r.get(0))
                .unwrap();
            let step_str = String::from_utf8(step_blob).unwrap();
            assert!(step_str.contains(&fork_id));
            assert!(step_str.contains(&new_tid));
            assert!(!step_str.contains(&parent_id));
            assert!(!step_str.contains(&old_tid));
        }

        // Simulate AGY writing fork_id into last_conversations.json
        let last_conv = cache_dir.join("last_conversations.json");
        std::fs::write(
            &last_conv,
            serde_json::json!({ "/tmp/ws": &fork_id }).to_string(),
        )
        .unwrap();

        cleanup_agy_session_in(&temp, &fork_id);
        assert!(!fork_db.exists());
        let restored: Value =
            serde_json::from_str(&std::fs::read_to_string(&last_conv).unwrap()).unwrap();
        assert_eq!(restored["/tmp/ws"], json!(parent_id));

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn fork_and_cleanup_cursor_conversation_rewrites_meta_agent_id() {
        let temp =
            std::env::temp_dir().join(format!("ccgui-cursor-fork-test-{}", uuid::Uuid::new_v4()));
        let parent_id = uuid::Uuid::new_v4().to_string();
        let parent_dir = temp.join("chats").join("ws-hash").join(&parent_id);
        std::fs::create_dir_all(&parent_dir).unwrap();

        let parent_db = parent_dir.join("store.db");
        {
            let conn = rusqlite::Connection::open(&parent_db).unwrap();
            conn.execute_batch(
                "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
                 CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);",
            )
            .unwrap();
            let meta_json = serde_json::to_vec(&json!({
                "agentId": parent_id,
                "latestRootBlobId": "sha256-root-123",
                "blobEncryptionKey": "deadbeef"
            }))
            .unwrap();
            conn.execute(
                "INSERT INTO meta VALUES ('0', ?1)",
                rusqlite::params![hex_encode(&meta_json)],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO blobs VALUES ('sha256-root-123', ?1)",
                rusqlite::params![vec![1u8, 2, 3, 4]],
            )
            .unwrap();
        }

        let fork_id = fork_cursor_conversation_in(&temp, &parent_id).unwrap();
        assert_ne!(fork_id, parent_id);
        let fork_dir = temp.join("chats").join("ws-hash").join(&fork_id);
        let fork_db = fork_dir.join("store.db");
        assert!(fork_db.is_file());

        {
            let conn = rusqlite::Connection::open(&fork_db).unwrap();
            let raw_hex: String = conn
                .query_row("SELECT value FROM meta WHERE key = '0'", [], |r| r.get(0))
                .unwrap();
            let decoded: Value = serde_json::from_slice(&hex_decode(&raw_hex).unwrap()).unwrap();
            assert_eq!(decoded["agentId"], json!(fork_id));
            assert_eq!(decoded["latestRootBlobId"], json!("sha256-root-123"));
            assert_eq!(decoded["blobEncryptionKey"], json!("deadbeef"));
            let blob: Vec<u8> = conn
                .query_row(
                    "SELECT data FROM blobs WHERE id = 'sha256-root-123'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(blob, vec![1u8, 2, 3, 4]);
        }

        cleanup_cursor_session_in(&temp, &fork_id);
        assert!(!fork_dir.exists());
        assert!(parent_db.is_file());

        let _ = std::fs::remove_dir_all(&temp);
    }
}
