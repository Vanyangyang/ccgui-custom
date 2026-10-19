//! Background session naming (设置 → 通用 → 自动命名会话).
//!
//! After a chat turn settles, an isolated Claude call (engine::side_call)
//! reads the last few turns and either keeps the session's title or proposes
//! a 「类别emoji 对象｜目标」 one; validate.rs decides what is accepted. The
//! result lives in `session_auto_titles`, between the user's custom title
//! (which always wins and locks naming) and the scanner's first-message
//! title. Naming rules are adapted from oil-codex-title (see auto_title/NOTICE).
//!
//! What keeps this cheap and safe:
//! - Only turns of this app's chat stream trigger it; plugin and mission runs
//!   use their own streams, and the side call itself writes no session.
//! - An unchanged conversation (same fingerprint) is never re-sent; up to two
//!   bare acknowledgements after an evaluated title are skipped.
//! - The write is conditional, in one transaction: a custom title set, the
//!   session archived, or its transcript moved on since the read discards it.

pub(crate) mod config;
mod excerpt;
pub(crate) mod origin;
mod validate;
mod permit;

#[cfg(feature = "test-harness")]
pub use origin::test_support;

use crate::db::Db;
use crate::engine::side_call::{self, SideCallError};
use crate::event_sink::EventSink;
use config::NamingConfig;
#[cfg(test)]
use config::{DEFAULT_EFFORT, DEFAULT_MODEL};
use rusqlite::OptionalExtension;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, OnceLock};
use std::time::Duration;

/// Bump when naming.md or the excerpt shape changes: stored fingerprints then
/// stop matching and the next real turn re-evaluates (history is not
/// re-named in bulk).
const POLICY_VERSION: i64 = 1;
const PROMPT: &str = include_str!("auto_title/naming.md");
/// Lets the CLI flush the transcript and coalesces Claude's per-response
/// `turn_complete` with the run's final `done`.
const DEBOUNCE: Duration = Duration::from_secs(4);
const MODEL_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_ACK_SKIPS: i64 = 2;
const EXISTING_TITLES: usize = 30;

/// Concurrent namer processes across all sessions, including user-requested
/// suggestions.
static PERMITS: LazyLock<tokio::sync::Semaphore> = LazyLock::new(|| tokio::sync::Semaphore::new(2));
static TITLER: OnceLock<Arc<Titler>> = OnceLock::new();
static EVALUATIONS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

pub(crate) fn has_pending() -> bool {
    EVALUATIONS.load(std::sync::atomic::Ordering::SeqCst) != 0
        || TITLER.get().is_some_and(|titler| !titler.slots.lock().0.is_empty())
}

struct EvaluationLifetime;
impl Drop for EvaluationLifetime {
    fn drop(&mut self) { EVALUATIONS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst); }
}

pub fn init(db: Arc<Db>, sink: Arc<EventSink>) {
    let _ = TITLER.set(Arc::new(Titler {
        db,
        sink,
        slots: parking_lot::Mutex::new(Slots::default()),
    }));
}

/// Engine-stream tap (EventSink::push, chat stream only). Cheap on every
/// event: only a settled, uninterrupted response with a native id schedules.
pub fn observe_event(event: &Value) {
    let Some(source) = origin::settled(event) else {
        return;
    };
    if crate::settings::read_settings()
        .unwrap_or_default()
        .auto_title_enabled
        != Some(true)
    {
        return;
    }
    if let Some(titler) = TITLER.get() {
        titler.schedule(source);
    }
}

type SlotKey = (String, String);

/// Per-session scheduling: one evaluation at a time, a turn that settles
/// mid-evaluation re-runs it afterwards instead of racing it.
#[derive(Default)]
struct Slot {
    generation: u64,
    running: bool,
    dirty: bool,
    ready_generation: u64,
    source: Option<origin::SettledOrigin>,
}

#[derive(Default)]
struct Slots(HashMap<SlotKey, Slot>, u64);

impl Slots {
    /// A turn settled: (re)arm the debounce. Returns this trigger's generation.
    fn arm(&mut self, key: &SlotKey) -> u64 {
        // Delayed tasks can outlive a removed slot. Never reuse its generation,
        // or an old timer could adopt a newly created slot for the same chat.
        self.1 += 1;
        let slot = self.0.entry(key.clone()).or_default();
        slot.generation = self.1;
        slot.generation
    }

    /// The debounce elapsed. Some(started) when this trigger should run now;
    /// None when a later turn re-armed it or a run is in flight (which then
    /// runs once more).
    fn begin(&mut self, key: &SlotKey, generation: u64) -> Option<u64> {
        let slot = self.0.get_mut(key)?;
        if slot.generation != generation {
            return None;
        }
        if slot.running {
            slot.dirty = true;
            slot.ready_generation = generation;
            return None;
        }
        slot.running = true;
        Some(generation)
    }

    /// A run finished. Some(started) to run again for turns that settled
    /// meanwhile; the slot is dropped once nothing newer is pending.
    fn end(&mut self, key: &SlotKey, started: u64) -> Option<u64> {
        let slot = self.0.get_mut(key)?;
        if slot.dirty && slot.ready_generation == slot.generation {
            slot.dirty = false;
            return Some(slot.generation);
        }
        if slot.generation == started {
            self.0.remove(key);
        } else {
            // A newer turn is still debouncing; it starts the next run.
            slot.running = false;
            slot.dirty = false;
        }
        None
    }
}

struct Titler {
    db: Arc<Db>,
    sink: Arc<EventSink>,
    slots: parking_lot::Mutex<Slots>,
}

impl Titler {
    fn schedule(self: &Arc<Self>, source: origin::SettledOrigin) {
        let key = (source.engine.clone(), source.session_id.clone());
        let generation = {
            let mut slots = self.slots.lock();
            let generation = slots.arm(&key);
            slots.0.get_mut(&key).expect("just armed").source = Some(source.clone());
            generation
        };
        let this = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(DEBOUNCE).await;
            let Some(mut started) = this.slots.lock().begin(&key, generation) else {
                return;
            };
            let mut source = source;
            loop {
                this.run_auto(&source).await;
                let next = {
                    let mut slots = this.slots.lock();
                    slots.end(&key, started).and_then(|generation| {
                        slots
                            .0
                            .get(&key)
                            .and_then(|slot| slot.source.clone())
                            .map(|source| (generation, source))
                    })
                };
                match next {
                    Some((generation, latest_source)) => {
                        started = generation;
                        source = latest_source;
                    }
                    None => return,
                }
            }
        });
    }

    async fn run_auto(&self, source: &origin::SettledOrigin) {
        let engine = &source.engine;
        let session_id = &source.session_id;
        let settings = crate::settings::read_settings().unwrap_or_default();
        if settings.auto_title_enabled != Some(true) {
            return;
        }
        let config = NamingConfig::from_settings(&settings);
        let short: String = session_id.chars().take(8).collect();
        match evaluate_for_origin(&self.db, &self.sink, source, &config).await {
            Ok(Evaluation { decision, .. }) => {
                let outcome = match decision {
                    validate::Decision::Keep => "kept",
                    validate::Decision::Rename(_) => "renamed",
                };
                eprintln!("[auto-title] {engine}/{short}: {outcome}");
            }
            Err(Stop::Skipped(reason)) => {
                if matches!(reason, "stale" | "locked_meanwhile" | "duplicate") {
                    eprintln!("[auto-title] {engine}/{short}: discarded ({reason})");
                }
            }
            Err(Stop::Failed(code)) => eprintln!("[auto-title] {engine}/{short}: failed ({code})"),
        }
    }
}

#[tauri::command]
pub async fn auto_title_models() -> Result<Vec<config::NamingModel>, String> {
    config::models(&crate::settings::read_settings()?).await
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// After a turn: honours the switch, locks, fingerprints; writes.
    Auto,
    /// The rename dialog asked: always asks the model, never commits a title.
    /// Preparing may refresh the transcript's derived history index.
    Suggest,
}

#[derive(Debug)]
enum Stop {
    /// Nothing to do, by design (reason for the log only).
    Skipped(&'static str),
    /// A user-facing failure code (see suggest_session_title).
    Failed(&'static str),
}

struct Evaluation {
    current: String,
    decision: validate::Decision,
}

/// Snapshot of what one evaluation read, re-checked at commit.
struct Prepared {
    workspace_path: String,
    file_path: String,
    stat: (i64, i64),
    current: String,
    current_auto: Option<String>,
    excerpt: excerpt::Excerpt,
    input: String,
}

#[derive(Serialize)]
struct NamerInput<'a> {
    current_title: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_hint: Option<&'a str>,
    #[serde(flatten)]
    excerpt: &'a excerpt::Excerpt,
    #[serde(skip_serializing_if = "<[String]>::is_empty")]
    existing_titles: &'a [String],
}

async fn evaluate(
    db: &Arc<Db>,
    sink: &Arc<EventSink>,
    engine: &str,
    session_id: &str,
    mode: Mode,
    config: &NamingConfig,
) -> Result<Evaluation, Stop> {
    evaluate_inner(db, sink, engine, session_id, mode, config, None).await
}

/// Automatic naming retains the trusted run identity and cancellation marker
/// across the debounce, permit queue, model call and conditional write.
async fn evaluate_for_origin(
    db: &Arc<Db>,
    sink: &Arc<EventSink>,
    origin: &origin::SettledOrigin,
    config: &NamingConfig,
) -> Result<Evaluation, Stop> {
    evaluate_inner(
        db,
        sink,
        &origin.engine,
        &origin.session_id,
        Mode::Auto,
        config,
        Some(origin),
    )
    .await
}

fn check_origin_cancelled(origin: Option<&origin::SettledOrigin>) -> Result<(), Stop> {
    if origin.is_some_and(origin::SettledOrigin::is_cancelled) {
        return Err(Stop::Skipped("cancelled"));
    }
    Ok(())
}

fn check_prepared_origin(
    prepared: &Prepared,
    origin: Option<&origin::SettledOrigin>,
) -> Result<(), Stop> {
    check_workspace_origin(&prepared.workspace_path, origin)
}

fn check_workspace_origin(
    workspace_path: &str,
    origin: Option<&origin::SettledOrigin>,
) -> Result<(), Stop> {
    check_origin_cancelled(origin)?;
    if origin.is_some_and(|origin| workspace_path != origin.workspace_path) {
        return Err(Stop::Skipped("stale"));
    }
    Ok(())
}

async fn evaluate_inner(
    db: &Arc<Db>,
    sink: &Arc<EventSink>,
    engine: &str,
    session_id: &str,
    mode: Mode,
    config: &NamingConfig,
    origin: Option<&origin::SettledOrigin>,
) -> Result<Evaluation, Stop> {
    EVALUATIONS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let _lifetime = EvaluationLifetime;
    check_origin_cancelled(origin)?;
    let prepared = {
        let (db, sink) = (Arc::clone(db), Arc::clone(sink));
        let (engine, session_id) = (engine.to_string(), session_id.to_string());
        let prepare_origin = origin.cloned();
        let aliases = crate::settings::read_settings()
            .unwrap_or_default()
            .workspace_aliases;
        tauri::async_runtime::spawn_blocking(move || match prepare_origin.as_ref() {
            Some(origin) => prepare_with_origin(
                &db,
                &sink,
                &engine,
                &session_id,
                mode,
                &aliases,
                Some(origin),
            ),
            None => prepare(&db, &sink, &engine, &session_id, mode, &aliases),
        })
        .await
        .map_err(|_| Stop::Failed("failed"))??
    };
    check_prepared_origin(&prepared, origin)?;
    let _permit = PERMITS
        .acquire()
        .await
        .map_err(|_| Stop::Failed("failed"))?;
    // Task workers have independent Rust statics. Keep the existing two-namer
    // ceiling across all of them, with OS-released file ownership on crashes.
    let global_permit = permit::acquire(&crate::paths::app_home()).await.map_err(|_| Stop::Failed("failed"))?;
    check_prepared_origin(&prepared, origin)?;
    // The switch may have been turned off while this waited for a permit.
    if mode == Mode::Auto
        && crate::settings::read_settings()
            .unwrap_or_default()
            .auto_title_enabled
            != Some(true)
    {
        return Err(Stop::Skipped("disabled"));
    }
    let schema = answer_schema();
    check_prepared_origin(&prepared, origin)?;
    let answer = side_call::structured(&config.engine, config.request(&prepared.input, &schema)).await;
    drop(_permit);
    drop(global_permit);
    check_prepared_origin(&prepared, origin)?;
    let answer = answer.map_err(|error| {
        Stop::Failed(match error {
            SideCallError::Unavailable => "engine_disabled",
            SideCallError::Timeout => "timeout",
            SideCallError::BadOutput => "invalid_output",
            SideCallError::Failed => "failed",
        })
    })?;
    let decision = validate::decide(&answer.structured, &prepared.current).map_err(|invalid| {
        eprintln!("[auto-title] rejected candidate: {}", invalid.0);
        Stop::Failed("invalid_output")
    })?;
    if mode == Mode::Suggest {
        return Ok(Evaluation {
            current: prepared.current,
            decision,
        });
    }
    let title = match &decision {
        validate::Decision::Rename(title) => Some(title.clone()),
        _ => prepared.current_auto.clone(),
    };
    let current = prepared.current.clone();
    let (db, sink) = (Arc::clone(db), Arc::clone(sink));
    let (engine, session_id) = (engine.to_string(), session_id.to_string());
    let origin = origin.cloned();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(origin) = origin {
            check_prepared_origin(&prepared, Some(&origin))?;
            commit_with_checks(
                &db,
                &sink,
                &engine,
                &session_id,
                &prepared,
                title.as_deref(),
                || {
                    crate::settings::read_settings()
                        .unwrap_or_default()
                        .auto_title_enabled
                        == Some(true)
                },
                || origin.is_cancelled(),
            )
        } else {
            commit(
                &db,
                &sink,
                &engine,
                &session_id,
                &prepared,
                title.as_deref(),
            )
        }
    })
    .await
    .map_err(|_| Stop::Failed("failed"))??;
    Ok(Evaluation { current, decision })
}

fn answer_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "action": { "type": "string", "enum": ["keep", "rename"] },
            "title": { "type": "string" },
            "reason": { "type": "string" }
        },
        "required": ["action", "title", "reason"],
        "additionalProperties": false
    })
}

struct Row {
    workspace_path: String,
    file_path: String,
    stat: (i64, i64),
    title: String,
    custom_title: Option<String>,
    archived: bool,
    auto: Option<AutoRow>,
}

struct AutoRow {
    title: Option<String>,
    fingerprint: String,
    user_turns: i64,
    ack_skips: i64,
    policy_version: i64,
}

fn load_row(db: &Db, engine: &str, session_id: &str) -> Result<Option<Row>, Stop> {
    let conn = db.0.lock();
    conn.query_row(
        "SELECT s.workspace_path, s.file_path, s.file_size, s.file_mtime_ms, s.title, s.custom_title,
                EXISTS(SELECT 1 FROM session_archives a WHERE a.engine = s.engine AND a.session_id = s.session_id),
                at.title, at.fingerprint, at.user_turns, at.ack_skips, at.policy_version
         FROM sessions s
         LEFT JOIN session_auto_titles at ON at.engine = s.engine AND at.session_id = s.session_id
         WHERE s.engine = ?1 AND s.session_id = ?2",
        rusqlite::params![engine, session_id],
        |r| {
            let fingerprint: Option<String> = r.get(8)?;
            Ok(Row {
                workspace_path: r.get(0)?,
                file_path: r.get(1)?,
                stat: (r.get(2)?, r.get(3)?),
                title: r.get(4)?,
                custom_title: r.get::<_, Option<String>>(5)?.filter(|t| !t.trim().is_empty()),
                archived: r.get(6)?,
                auto: match fingerprint {
                    Some(fingerprint) => Some(AutoRow {
                        title: r.get(7)?,
                        fingerprint,
                        user_turns: r.get(9)?,
                        ack_skips: r.get(10)?,
                        policy_version: r.get(11)?,
                    }),
                    None => None,
                },
            })
        },
    )
    .optional()
    .map_err(|e| {
        eprintln!("[auto-title] read session row: {e}");
        Stop::Failed("failed")
    })
}

/// Load the session as the transcript stands now. The frontend's post-turn
/// rescan usually landed during the debounce; when it has not, scan here so
/// a first turn's session row exists.
fn fresh_row(db: &Db, sink: &Arc<EventSink>, engine: &str, session_id: &str) -> Result<Row, Stop> {
    if let Some(row) = load_row(db, engine, session_id)? {
        if crate::history::stat_signature(&transcript_path(engine, &row.file_path)) == Some(row.stat) {
            return Ok(row);
        }
    }
    if let Err(error) = crate::history::scanner::scan_with(db, || sink.emit_sessions_changed()) {
        eprintln!("[auto-title] rescan failed: {error}");
    }
    load_row(db, engine, session_id)?.ok_or(Stop::Failed("not_found"))
}

fn prepare(
    db: &Db,
    sink: &Arc<EventSink>,
    engine: &str,
    session_id: &str,
    mode: Mode,
    aliases: &HashMap<String, String>,
) -> Result<Prepared, Stop> {
    prepare_with_origin(db, sink, engine, session_id, mode, aliases, None)
}

fn transcript_path(engine: &str, file_path: &str) -> PathBuf {
    let path = Path::new(file_path);
    if engine == "codex" {
        crate::history::codex_rollout::resolve_path(path)
    } else {
        path.to_path_buf()
    }
}

fn prepare_with_origin(
    db: &Db,
    sink: &Arc<EventSink>,
    engine: &str,
    session_id: &str,
    mode: Mode,
    aliases: &HashMap<String, String>,
    origin: Option<&origin::SettledOrigin>,
) -> Result<Prepared, Stop> {
    check_origin_cancelled(origin)?;
    let row = fresh_row(db, sink, engine, session_id)?;
    check_workspace_origin(&row.workspace_path, origin)?;
    if mode == Mode::Auto {
        if row.archived {
            return Err(Stop::Skipped("archived"));
        }
        if row.custom_title.is_some() {
            return Err(Stop::Skipped("locked"));
        }
    }
    let path = transcript_path(engine, &row.file_path);
    let stat = crate::history::stat_signature(&path).ok_or(Stop::Failed("not_found"))?;
    let parsed = crate::history::parse_session_file(engine, &path).map_err(|e| {
        eprintln!("[auto-title] parse transcript: {e}");
        Stop::Failed("not_found")
    })?;
    if crate::history::stat_signature(&transcript_path(engine, &row.file_path)) != Some(stat) {
        return Err(Stop::Skipped("stale"));
    }
    let turns = excerpt::turns(&parsed.messages);
    if turns.is_empty() {
        return Err(Stop::Failed("no_content"));
    }
    let excerpt = excerpt::build(&turns, POLICY_VERSION);
    let current_auto = row.auto.as_ref().and_then(|a| a.title.clone());
    if mode == Mode::Auto {
        if !excerpt::has_substance(&turns) {
            return Err(Stop::Skipped("no_substance"));
        }
        if let Some(auto) = row
            .auto
            .as_ref()
            .filter(|a| a.policy_version == POLICY_VERSION)
        {
            if auto.fingerprint == excerpt.fingerprint {
                return Err(Stop::Skipped("unchanged"));
            }
            let latest = turns.last().map(|t| t.user.as_str()).unwrap_or_default();
            if auto.ack_skips < MAX_ACK_SKIPS
                && excerpt.user_turns == auto.user_turns + 1
                && excerpt::is_ack(latest)
            {
                record_ack_skip(db, engine, session_id, &excerpt, auto.ack_skips + 1, origin)?;
                return Err(Stop::Skipped("ack"));
            }
        }
    }
    let current = row
        .custom_title
        .clone()
        .or_else(|| current_auto.clone())
        .unwrap_or_else(|| row.title.clone());
    let (project_hint, existing) = context(db, &row.workspace_path, engine, session_id, aliases)?;
    let input = serde_json::to_string(&NamerInput {
        current_title: &current,
        project_hint: project_hint.as_deref(),
        excerpt: &excerpt,
        existing_titles: &existing,
    })
    .map_err(|_| Stop::Failed("failed"))?;
    Ok(Prepared {
        workspace_path: row.workspace_path,
        file_path: row.file_path,
        stat,
        current,
        current_auto,
        excerpt,
        input,
    })
}

/// Workspace label as the sidebar shows it (alias, else folder name) and the
/// already-structured titles of its other sessions.
fn context(
    db: &Db,
    workspace_path: &str,
    engine: &str,
    session_id: &str,
    aliases: &HashMap<String, String>,
) -> Result<(Option<String>, Vec<String>), Stop> {
    let failed = |e: rusqlite::Error| {
        eprintln!("[auto-title] read workspace context: {e}");
        Stop::Failed("failed")
    };
    let conn = db.0.lock();
    let workspace: Option<(String, String)> = conn
        .query_row(
            "SELECT id, name FROM workspaces WHERE path = ?1",
            [workspace_path],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(failed)?;
    let mut stmt = conn
        .prepare(
            "SELECT COALESCE(s.custom_title, at.title, s.title) FROM sessions s
             LEFT JOIN session_auto_titles at ON at.engine = s.engine AND at.session_id = s.session_id
             WHERE s.workspace_path = ?1 AND NOT (s.engine = ?2 AND s.session_id = ?3)
               AND NOT EXISTS (SELECT 1 FROM session_archives a
                               WHERE a.engine = s.engine AND a.session_id = s.session_id)
             ORDER BY COALESCE(s.updated_at, 0) DESC LIMIT 200",
        )
        .map_err(failed)?;
    let existing: Vec<String> = stmt
        .query_map(rusqlite::params![workspace_path, engine, session_id], |r| {
            r.get::<_, String>(0)
        })
        .map_err(failed)?
        .filter_map(Result::ok)
        .filter(|t| t.contains('｜') && t.chars().count() <= validate::MAX_TITLE_CHARS)
        .take(EXISTING_TITLES)
        .collect();
    let hint = workspace.map(|(id, name)| {
        aliases
            .get(&id)
            .map(|alias| alias.trim().to_string())
            .filter(|alias| !alias.is_empty())
            .unwrap_or(name)
    });
    Ok((hint, existing))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn record_ack_skip(
    db: &Db,
    engine: &str,
    session_id: &str,
    excerpt: &excerpt::Excerpt,
    ack_skips: i64,
    origin: Option<&origin::SettledOrigin>,
) -> Result<(), Stop> {
    check_origin_cancelled(origin)?;
    let failed = |e: rusqlite::Error| {
        eprintln!("[auto-title] record ack skip: {e}");
        Stop::Failed("failed")
    };
    let mut conn = db.0.lock();
    let tx = conn.transaction().map_err(failed)?;
    check_origin_cancelled(origin)?;
    tx.execute(
            "UPDATE session_auto_titles SET fingerprint = ?3, user_turns = ?4, ack_skips = ?5, updated_at = ?6
             WHERE engine = ?1 AND session_id = ?2",
            rusqlite::params![engine, session_id, excerpt.fingerprint, excerpt.user_turns, ack_skips, now_ms()],
        ).map_err(failed)?;
    check_origin_cancelled(origin)?;
    tx.commit().map_err(failed)
}

/// Read the actual transcript, independently of the scanner's cached stat.
/// Bookkeeping appends are harmless when the naming input remains identical.
/// A stat around the parse guards against consuming a file while it changes.
fn still_current(engine: &str, prepared: &Prepared, cached_stat: (i64, i64)) -> Option<(i64, i64)> {
    let path = transcript_path(engine, &prepared.file_path);
    let stat = crate::history::stat_signature(&path)?;
    // A cache hit alone is insufficient. The actual file must also retain
    // the metadata of the stable parse captured at prepare.
    if stat == prepared.stat && cached_stat == prepared.stat {
        return Some(stat);
    }
    let parsed = crate::history::parse_session_file(engine, &path).ok()?;
    let fingerprint = excerpt::build(&excerpt::turns(&parsed.messages), POLICY_VERSION).fingerprint;
    (fingerprint == prepared.excerpt.fingerprint
        && crate::history::stat_signature(&transcript_path(engine, &prepared.file_path)) == Some(stat))
    .then_some(stat)
}

/// Conditional write. Discarded when, since prepare: the user set a custom
/// title, the session was archived or removed, or the conversation moved on
/// (that newer turn schedules its own evaluation).
fn commit(
    db: &Db,
    sink: &EventSink,
    engine: &str,
    session_id: &str,
    prepared: &Prepared,
    title: Option<&str>,
) -> Result<(), Stop> {
    commit_with_enabled(db, sink, engine, session_id, prepared, title, || {
        crate::settings::read_settings()
            .unwrap_or_default()
            .auto_title_enabled
            == Some(true)
    })
}

/// SQLite serializes the identity/lock/duplicate checks with the title write.
/// The filesystem cannot join that transaction: validate its content and stat
/// inside the transaction, then check the stat again immediately before commit.
/// An append after that final check remains a narrow filesystem/DB race.
fn commit_with_enabled(
    db: &Db,
    sink: &EventSink,
    engine: &str,
    session_id: &str,
    prepared: &Prepared,
    title: Option<&str>,
    enabled: impl Fn() -> bool,
) -> Result<(), Stop> {
    commit_with_checks(
        db,
        sink,
        engine,
        session_id,
        prepared,
        title,
        enabled,
        || false,
    )
}

fn commit_with_checks(
    db: &Db,
    sink: &EventSink,
    engine: &str,
    session_id: &str,
    prepared: &Prepared,
    title: Option<&str>,
    enabled: impl Fn() -> bool,
    cancelled: impl Fn() -> bool,
) -> Result<(), Stop> {
    if cancelled() {
        return Err(Stop::Skipped("cancelled"));
    }
    let failed = |e: rusqlite::Error| {
        eprintln!("[auto-title] commit: {e}");
        Stop::Failed("failed")
    };
    let mut conn = db.0.lock();
    let tx = conn.transaction().map_err(failed)?;
    if cancelled() {
        return Err(Stop::Skipped("cancelled"));
    }
    if !enabled() {
        return Err(Stop::Skipped("disabled"));
    }
    let now: Option<(String, String, (i64, i64), Option<String>, bool)> = tx
        .query_row(
            "SELECT s.workspace_path, s.file_path, s.file_size, s.file_mtime_ms, s.custom_title,
                    EXISTS(SELECT 1 FROM session_archives a WHERE a.engine = s.engine AND a.session_id = s.session_id)
             FROM sessions s WHERE s.engine = ?1 AND s.session_id = ?2",
            rusqlite::params![engine, session_id],
            |r| Ok((r.get(0)?, r.get(1)?, (r.get(2)?, r.get(3)?), r.get(4)?, r.get(5)?)),
        )
        .optional()
        .map_err(failed)?;
    let Some((workspace_path, file_path, cached_stat, custom, archived)) = now else {
        return Err(Stop::Skipped("stale"));
    };
    if workspace_path != prepared.workspace_path || file_path != prepared.file_path {
        return Err(Stop::Skipped("stale"));
    }
    if custom.is_some_and(|t| !t.trim().is_empty()) || archived {
        return Err(Stop::Skipped("locked_meanwhile"));
    }
    // Both changed and unchanged cache entries need real content validation:
    // a new message may already be on disk while the scanner still has the old
    // stat, and a cache update may contain only CLI bookkeeping.
    let stat = still_current(engine, prepared, cached_stat).ok_or(Stop::Skipped("stale"))?;
    let duplicate = if title != prepared.current_auto.as_deref() {
        if let Some(candidate) = title {
            let mut stmt = tx.prepare(
                "SELECT COALESCE(NULLIF(s.custom_title, ''), at.title, s.title) FROM sessions s
                 LEFT JOIN session_auto_titles at ON at.engine = s.engine AND at.session_id = s.session_id
                 WHERE s.workspace_path = ?1 AND NOT (s.engine = ?2 AND s.session_id = ?3)
                   AND NOT EXISTS (SELECT 1 FROM session_archives a
                                   WHERE a.engine = s.engine AND a.session_id = s.session_id)",
            ).map_err(failed)?;
            let mut rows = stmt
                .query(rusqlite::params![workspace_path, engine, session_id])
                .map_err(failed)?;
            let mut duplicate = false;
            while let Some(row) = rows.next().map_err(failed)? {
                if row
                    .get::<_, String>(0)
                    .map_err(failed)?
                    .eq_ignore_ascii_case(candidate)
                {
                    duplicate = true;
                    break;
                }
            }
            duplicate
        } else {
            false
        }
    } else {
        false
    };
    // Even a rejected duplicate records this basis, avoiding another model
    // request for the exact same conversation. Retain any prior auto title.
    let title = if duplicate {
        prepared.current_auto.as_deref()
    } else {
        title
    };
    let changed = title != prepared.current_auto.as_deref();
    tx.execute(
        "INSERT INTO session_auto_titles(engine, session_id, title, fingerprint, user_turns, ack_skips, policy_version, updated_at)
         VALUES(?1, ?2, ?3, ?4, ?5, 0, ?6, ?7)
         ON CONFLICT(engine, session_id) DO UPDATE SET
             title = excluded.title, fingerprint = excluded.fingerprint, user_turns = excluded.user_turns,
             ack_skips = 0, policy_version = excluded.policy_version, updated_at = excluded.updated_at",
        rusqlite::params![
            engine,
            session_id,
            title,
            prepared.excerpt.fingerprint,
            prepared.excerpt.user_turns,
            POLICY_VERSION,
            now_ms()
        ],
    )
    .map_err(failed)?;
    if crate::history::stat_signature(&transcript_path(engine, &file_path)) != Some(stat) {
        return Err(Stop::Skipped("stale"));
    }
    if !enabled() {
        return Err(Stop::Skipped("disabled"));
    }
    if cancelled() {
        return Err(Stop::Skipped("cancelled"));
    }
    tx.commit().map_err(failed)?;
    drop(conn);
    if changed {
        sink.emit_sessions_changed();
    }
    if duplicate {
        return Err(Stop::Skipped("duplicate"));
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TitleSuggestion {
    title: String,
    /// False when the model judged the current title fine (`title` is it).
    changed: bool,
}

/// The rename dialog's 生成标题: a suggestion for the user to accept or edit.
/// Works with automatic naming off and on locked sessions; commits no title.
/// It may refresh the transcript's derived history index while preparing.
/// Errors are codes: engine_disabled, not_found, no_content, timeout,
/// invalid_output, failed.
#[tauri::command]
pub async fn suggest_session_title(
    state: tauri::State<'_, crate::AppState>,
    engine: String,
    session_id: String,
) -> Result<TitleSuggestion, String> {
    let settings = crate::settings::read_settings().unwrap_or_default();
    let config = NamingConfig::from_settings(&settings);
    match evaluate(
        &state.db,
        &state.sink,
        &engine,
        &session_id,
        Mode::Suggest,
        &config,
    )
    .await
    {
        Ok(Evaluation { current, decision }) => Ok(match decision {
            validate::Decision::Rename(title) => TitleSuggestion {
                title,
                changed: true,
            },
            validate::Decision::Keep => TitleSuggestion {
                title: current,
                changed: false,
            },
        }),
        Err(Stop::Failed(code)) => Err(code.to_string()),
        Err(Stop::Skipped(_)) => Err("failed".to_string()),
    }
}

#[cfg(test)]
mod tests;
