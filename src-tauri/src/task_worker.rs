//! One native run per independently-lived process. The desktop owns admission;
//! this process owns all CLI pipes, parser state and kill-on-close job handles.
//! No Tauri window, singleton gate, migration, history scan or startup sweep runs
//! here. Losing every client connection never cancels an accepted command.

mod client;
mod protocol;
mod storage;
pub(crate) use client::launch_with_context;
pub use client::{discover, launch, WorkerClient};
pub use protocol::{
    Command, Outcome, Request, Response, StartArgs, WorkerConfig, WorkerError, WorkerManifest,
    PROTOCOL,
};
pub(crate) use storage::{private_directory, private_file};
pub use storage::{EventChunk, EventFragment, EventsPage};

use crate::event_sink::{BroadcastEmit, Emit, EventSink};
use protocol::{token_matches, valid_id, MAX_FRAME_BYTES};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::watch;

/// Pure compatibility probe: no filesystem/config/DB/profile/model access.
/// Host must compare before launching a candidate worker or migrating its DB.
pub fn probe() -> Value {
    json!({"protocol": PROTOCOL, "checkpointSchema":1, "schemaHash": schema_hash(), "capabilities": capabilities()})
}

/// Legacy source-byte schema hashes emitted by 1.1.1+protected.31 releases
/// (`proxyfooter` / `self-update-baseline` and `quotatpsagy`) whose actual
/// SQLite DDL and persisted JSON contracts are identical to v1.
pub const LEGACY_V1_SOURCE_SCHEMA_HASHES: &[&str] = &[
    "877aebe0038af9e7e722202c8e3bd2cb3d323c3e0203daa3869306acb8fb7931",
    "bf7114717718cc0dd8c59a259b3121ce5486c7f91788013531694fe2281fcd27",
];

pub const SCHEMA_CONTRACT_V1_HASH: &str =
    "93abdf288a9b3a7909507c5ede89c578be7976ba025e054d59160630db0f06fe";

/// Cost approval records and states require a full restart from the v1 worker.
pub const SCHEMA_CONTRACT_V2_HASH: &str =
    "9a17d672b37a0dec0ec7e5f1c1b8aee3ee1cea74619bfe88c86d4fcd17123a04";

static SCHEMA_HASH: std::sync::OnceLock<String> = std::sync::OnceLock::new();

pub fn schema_hash() -> String {
    SCHEMA_HASH
        .get_or_init(|| {
            let db = crate::db::Db::open_in_memory()
                .expect("in-memory schema contract database must initialize");
            crate::leader::ensure_schema(&db)
                .expect("in-memory leader schema contract must initialize");
            let conn = db.0.lock();
            compute_schema_contract_hash(
                &conn,
                &[
                    ("leader", &crate::leader::schema_contract_descriptor()),
                    (
                        "plan-review",
                        &crate::engine::plan_review::schema_contract_descriptor(),
                    ),
                ],
            )
            .expect("in-memory schema contract hash must succeed")
        })
        .clone()
}

fn canonical_schema_hash(hash: &str) -> &str {
    if LEGACY_V1_SOURCE_SCHEMA_HASHES.contains(&hash) {
        SCHEMA_CONTRACT_V1_HASH
    } else {
        hash
    }
}

pub fn schemas_compatible(a: &str, b: &str) -> bool {
    canonical_schema_hash(a) == canonical_schema_hash(b)
}

pub(crate) fn normalize_sql_ddl(sql: &str) -> String {
    let bytes = sql.as_bytes();
    let mut stripped = String::with_capacity(sql.len());
    let mut i = 0;
    let mut quote: Option<u8> = None;
    while i < bytes.len() {
        let ch = bytes[i];
        if let Some(q) = quote {
            let c = sql[i..].chars().next().unwrap();
            stripped.push(c);
            i += c.len_utf8();
            if ch == q {
                if i < bytes.len() && bytes[i] == q {
                    stripped.push(q as char);
                    i += 1;
                } else {
                    quote = None;
                }
            }
            continue;
        }
        if ch == b'\'' || ch == b'"' {
            quote = Some(ch);
            stripped.push(ch as char);
            i += 1;
            continue;
        }
        if ch == b'-' && i + 1 < bytes.len() && bytes[i + 1] == b'-' {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            stripped.push(' ');
            continue;
        }
        if ch == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
            stripped.push(' ');
            continue;
        }
        let c = sql[i..].chars().next().unwrap();
        stripped.push(c);
        i += c.len_utf8();
    }

    let mut out = String::with_capacity(stripped.len());
    let sbytes = stripped.as_bytes();
    let mut j = 0;
    let mut in_quote: Option<u8> = None;
    let mut pending_space = false;
    while j < sbytes.len() {
        let ch = sbytes[j];
        if let Some(q) = in_quote {
            let c = stripped[j..].chars().next().unwrap();
            out.push(c);
            j += c.len_utf8();
            if ch == q {
                if j < sbytes.len() && sbytes[j] == q {
                    out.push(q as char);
                    j += 1;
                } else {
                    in_quote = None;
                }
            }
            continue;
        }
        if ch.is_ascii_whitespace() {
            pending_space = !out.is_empty();
            j += 1;
            continue;
        }
        let is_punct = matches!(
            ch,
            b'(' | b')' | b',' | b';' | b'=' | b'<' | b'>' | b'+' | b'-' | b'*' | b'/'
        );
        if pending_space {
            let prev = out.as_bytes().last().copied().unwrap_or(b' ');
            let prev_punct = matches!(
                prev,
                b'(' | b')' | b',' | b';' | b'=' | b'<' | b'>' | b'+' | b'-' | b'*' | b'/'
            );
            if !is_punct && !prev_punct {
                out.push(' ');
            }
            pending_space = false;
        }
        if ch == b'\'' || ch == b'"' {
            in_quote = Some(ch);
        }
        let c = stripped[j..].chars().next().unwrap();
        out.push(c);
        j += c.len_utf8();
    }
    out
}

pub(crate) fn compute_schema_contract_hash(
    conn: &rusqlite::Connection,
    descriptors: &[(&str, &Value)],
) -> Result<String, String> {
    fn feed_str(digest: &mut Sha256, value: &str) {
        digest.update((value.len() as u64).to_le_bytes());
        digest.update(value.as_bytes());
    }
    let mut digest = Sha256::new();
    feed_str(&mut digest, "ccgui-schema-contract-v1");

    let mut master = conn
        .prepare(
            "SELECT type, name, tbl_name, COALESCE(sql, '')
             FROM sqlite_master
             WHERE name NOT LIKE 'sqlite_%'
             ORDER BY type, name, tbl_name",
        )
        .map_err(|e| e.to_string())?;
    let entries = master
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(master);

    digest.update((entries.len() as u64).to_le_bytes());
    let mut tables = Vec::new();
    for (kind, name, tbl_name, sql) in &entries {
        feed_str(&mut digest, kind);
        feed_str(&mut digest, name);
        feed_str(&mut digest, tbl_name);
        feed_str(&mut digest, &normalize_sql_ddl(sql));
        if kind == "table" {
            tables.push(name.clone());
        }
    }

    for table in &tables {
        feed_str(&mut digest, "table-meta");
        feed_str(&mut digest, table);
        let escaped = table.replace('"', "\"\"");

        let mut cols_stmt = conn
            .prepare(&format!("PRAGMA table_info(\"{escaped}\")"))
            .map_err(|e| e.to_string())?;
        let cols = cols_stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    row.get::<_, i64>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        digest.update((cols.len() as u64).to_le_bytes());
        for (cid, col_name, col_type, notnull, dflt, pk) in cols {
            digest.update(cid.to_le_bytes());
            feed_str(&mut digest, &col_name);
            feed_str(&mut digest, &col_type.to_ascii_uppercase());
            digest.update(notnull.to_le_bytes());
            feed_str(&mut digest, &normalize_sql_ddl(&dflt));
            digest.update(pk.to_le_bytes());
        }

        let mut fk_stmt = conn
            .prepare(&format!("PRAGMA foreign_key_list(\"{escaped}\")"))
            .map_err(|e| e.to_string())?;
        let mut fks = fk_stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        fks.sort();
        digest.update((fks.len() as u64).to_le_bytes());
        for (id, seq, target_table, from_col, to_col, on_update, on_delete, r#match) in fks {
            digest.update(id.to_le_bytes());
            digest.update(seq.to_le_bytes());
            feed_str(&mut digest, &target_table);
            feed_str(&mut digest, &from_col);
            feed_str(&mut digest, &to_col);
            feed_str(&mut digest, &on_update);
            feed_str(&mut digest, &on_delete);
            feed_str(&mut digest, &r#match);
        }

        let mut idx_stmt = conn
            .prepare(&format!("PRAGMA index_list(\"{escaped}\")"))
            .map_err(|e| e.to_string())?;
        let mut idxs = idx_stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        idxs.sort();
        digest.update((idxs.len() as u64).to_le_bytes());
        for (idx_name, unique, origin, partial) in idxs {
            feed_str(&mut digest, &idx_name);
            digest.update(unique.to_le_bytes());
            feed_str(&mut digest, &origin);
            digest.update(partial.to_le_bytes());
            let escaped_idx = idx_name.replace('"', "\"\"");
            let mut info_stmt = conn
                .prepare(&format!("PRAGMA index_info(\"{escaped_idx}\")"))
                .map_err(|e| e.to_string())?;
            let info = info_stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    ))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            digest.update((info.len() as u64).to_le_bytes());
            for (seqno, cid, col_name) in info {
                digest.update(seqno.to_le_bytes());
                digest.update(cid.to_le_bytes());
                feed_str(&mut digest, &col_name);
            }
        }
    }

    digest.update((descriptors.len() as u64).to_le_bytes());
    for (name, value) in descriptors {
        feed_str(&mut digest, name);
        let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(&bytes);
    }

    Ok(format!("{:x}", digest.finalize()))
}

fn capabilities() -> Value {
    json!({"oneRun": true, "eventReplay": true, "eventChunks":true,
        "eventChunkBytes":protocol::EVENT_CHUNK_BYTES,
        "maxReassembledEventBytes":protocol::MAX_REASSEMBLED_EVENT_BYTES,
        "commandDeduplication": true,
        "hostChat": true, "hostChatRequiresContext":true, "leader": false, "computerUse": false,
        "launchProtection": 1, "frontendAssets": 1,
        "frontendFingerprint": crate::frontend_assets::compiled_fingerprint()})
}

/// Call after ordinary profile selection, but BEFORE GUI ownership and startup.
/// One private JSON configuration line is read from stdin, not from argv/env.
pub fn run_worker_stdio() -> Result<(), String> {
    let stdin = std::io::stdin();
    let mut input = std::io::Read::take(stdin.lock(), 64 * 1024 + 1);
    let mut line = String::new();
    input
        .read_line(&mut line)
        .map_err(|_| "Read task worker configuration failed")?;
    if line.len() > 64 * 1024 || !line.ends_with('\n') {
        return Err("Invalid task worker configuration frame".into());
    }
    let config: WorkerConfig =
        serde_json::from_str(&line).map_err(|_| "Invalid task worker configuration")?;
    drop(input);
    drop(stdin);
    // Engines spawn their reader onto the current runtime. A single-thread
    // runtime lets start capture its abort/completion handle before that reader
    // can retire; no UI message loop or production startup is involved.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| "Create task worker runtime failed")?;
    runtime
        .block_on(run_worker(config))
        .map_err(|error| error.message)
}

pub async fn run_worker(config: WorkerConfig) -> Result<(), WorkerError> {
    let profile = validate_config(&config)?;
    if let Some(context) = config.host_context.clone() {
        crate::host_chat::install_worker_context(context, &config.run_id)
            .map_err(|error| WorkerError::new("host_context", error))?;
    }
    let directory = storage::create_directory(&profile, &config.worker_id)?;
    let journal = Arc::new(storage::Journal::new(&directory, config.worker_id.clone())?);
    let receipts = storage::ReceiptLog::new(&directory)?;
    let db = Arc::new(
        crate::db::Db::open_existing(&crate::paths::db_path()).map_err(|_| {
            WorkerError::new(
                "database_unavailable",
                "Worker requires the compatible existing profile database",
            )
        })?,
    );
    let app = app_state(db, journal.clone());
    // Observe only original worker events. Host replay forwards envelopes and
    // must not schedule this observer again.
    crate::auto_title::init(app.db.clone(), app.sink.clone());
    if crate::assistant_notices::completion_outbox::init().is_err() { eprintln!("[assistant-notices] completion outbox unavailable"); }
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| WorkerError::new("listener_failed", "Bind private worker listener failed"))?;
    let port = listener
        .local_addr()
        .map_err(|_| WorkerError::new("listener_failed", "Read worker listener address failed"))?
        .port();
    let pid = std::process::id();
    let (executable, process_start_time) = client::process_identity(pid)?;
    let manifest = WorkerManifest {
        protocol: PROTOCOL,
        worker_id: config.worker_id.clone(),
        run_id: config.run_id.clone(),
        profile,
        executable,
        pid,
        process_start_time,
        port,
        token: config.token.clone(),
        schema_hash: schema_hash(),
    };
    storage::publish_manifest(&directory, &manifest)?;
    let (shutdown, mut stopped) = watch::channel(false);
    let worker = Arc::new(Worker {
        config,
        directory,
        app,
        journal,
        receipts,
        commands: Mutex::new(HashMap::new()),
        start: Mutex::new(StartState::Waiting),
        shutdown,
        receipt_fault: Mutex::new(false),
        retiring: std::sync::atomic::AtomicBool::new(false),
        #[cfg(test)]
        execution_gate: Mutex::new(None),
    });
    // The ready frame intentionally excludes the bearer token.
    let ready =
        json!({"protocol":PROTOCOL,"workerId":worker.config.worker_id,"pid":pid,"port":port});
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, &ready)
        .map_err(|_| WorkerError::new("ready_failed", "Encode worker readiness failed"))?;
    stdout
        .write_all(b"\n")
        .and_then(|_| stdout.flush())
        .map_err(|_| WorkerError::new("ready_failed", "Publish worker readiness failed"))?;
    drop(stdout);
    let permits = Arc::new(tokio::sync::Semaphore::new(32));
    let mut idle = tokio::time::interval(Duration::from_secs(30));
    let born = tokio::time::Instant::now();
    loop {
        tokio::select! {
            changed = stopped.changed() => {
                if changed.is_err() || *stopped.borrow() { break; }
            }
            _ = idle.tick() => {
                if born.elapsed() > Duration::from_secs(120) {
                    match worker.retire_if_unstarted() {
                        Ok(true) => break,
                        Ok(false) => {},
                        // A failed archive transition leaves admission open;
                        // keep serving rather than terminating a later request.
                        Err(_) => eprintln!("[task-worker] idle manifest retirement failed"),
                    }
                }
            }
            accepted = listener.accept() => {
                let Ok((socket, peer)) = accepted else { continue; };
                if !peer.ip().is_loopback() { continue; }
                let Ok(permit) = permits.clone().try_acquire_owned() else { continue; };
                let owner = worker.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    serve_connection(owner, socket).await;
                });
            }
        }
    }
    Ok(())
}

fn validate_config(config: &WorkerConfig) -> Result<PathBuf, WorkerError> {
    if config.protocol != PROTOCOL || !schemas_compatible(&config.schema_hash, &schema_hash()) {
        return Err(WorkerError::new(
            "incompatible_worker",
            "Worker protocol or database schema differs",
        ));
    }
    if !valid_id(&config.worker_id)
        || !valid_id(&config.run_id)
        || config.token.len() != 64
        || !config.token.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(WorkerError::new(
            "invalid_configuration",
            "Invalid worker identity or capability token",
        ));
    }
    let profile = dunce::canonicalize(&config.profile).map_err(|_| {
        WorkerError::new(
            "profile_mismatch",
            "Resolve configured worker profile failed",
        )
    })?;
    let actual = dunce::canonicalize(crate::paths::app_home()).map_err(|_| {
        WorkerError::new("profile_mismatch", "Resolve active worker profile failed")
    })?;
    if profile != actual {
        return Err(WorkerError::new(
            "profile_mismatch",
            "Worker configuration does not match the initialized profile",
        ));
    }
    Ok(profile)
}

fn app_state(db: Arc<crate::db::Db>, journal: Arc<storage::Journal>) -> Arc<crate::AppState> {
    let emitter: Arc<dyn Emit> = Arc::new(JournalEmitter(journal));
    let emitters = BroadcastEmit::new(emitter);
    // Quota writes happen in this process, not the desktop host. Journal the
    // same value-free invalidation so attached clients immediately re-read it.
    crate::claude_quota::install_events(emitters.clone());
    Arc::new(crate::AppState {
        db,
        sink: EventSink::new(emitters.clone()),
        terminal_sink: EventSink::with_name(
            emitters.clone(),
            crate::terminal::TERMINAL_OUTPUT_EVENT,
        ),
        plugin_sink: EventSink::with_name(
            emitters.clone(),
            crate::event_sink::PLUGIN_AGENT_EVENT_NAME,
        ),
        mission_sink: EventSink::with_name(
            emitters.clone(),
            crate::event_sink::MISSION_AGENT_EVENT_NAME,
        ),
        emitters,
        terminals: Default::default(),
        processes: Arc::new(Default::default()),
        web: Default::default(),
        relay: Default::default(),
        dsh_host: Arc::new(Default::default()),
        opencode_server: Arc::new(Default::default()),
        worktree_creations: Default::default(),
    })
}

struct JournalEmitter(Arc<storage::Journal>);
impl Emit for JournalEmitter {
    fn emit_json(&self, name: &str, raw_json: &str) {
        match serde_json::from_str(raw_json) {
            Ok(value) => self.0.append(name, value),
            Err(_) => self.0.append(
                "task-worker://invalid-event",
                json!({"name":name,"error":"invalid_event_json"}),
            ),
        }
    }
}

enum StartState {
    Waiting,
    Starting {
        request_id: String,
        args: StartArgs,
    },
    Started {
        request_id: String,
        args: StartArgs,
        reader: Option<tokio::task::AbortHandle>,
    },
    Failed {
        request_id: String,
    },
}

struct Receipt {
    fingerprint: String,
    result: watch::Sender<Option<Outcome>>,
}

struct Worker {
    config: WorkerConfig,
    directory: PathBuf,
    app: Arc<crate::AppState>,
    journal: Arc<storage::Journal>,
    receipts: storage::ReceiptLog,
    commands: Mutex<HashMap<String, Arc<Receipt>>>,
    start: Mutex<StartState>,
    shutdown: watch::Sender<bool>,
    receipt_fault: Mutex<bool>,
    retiring: std::sync::atomic::AtomicBool,
    #[cfg(test)]
    execution_gate: Mutex<Option<Arc<tokio::sync::Barrier>>>,
}

impl Worker {
    /// The commands mutex is the admission lock. An accepted Start can still be
    /// waiting for its execution task while StartState says Waiting; its pending
    /// receipt must prevent idle retirement in that scheduling window.
    fn retire_if_unstarted(&self) -> Result<bool, WorkerError> {
        let commands = self.commands.lock().unwrap_or_else(|p| p.into_inner());
        let start = self.start.lock().unwrap_or_else(|p| p.into_inner());
        if self.retiring.load(std::sync::atomic::Ordering::SeqCst)
            || !matches!(*start, StartState::Waiting)
            || commands
                .values()
                .any(|receipt| receipt.result.borrow().is_none())
        {
            return Ok(false);
        }
        self.retiring
            .store(true, std::sync::atomic::Ordering::SeqCst);
        // Both admission and start state remain locked through the final check
        // and manifest retirement. No newly accepted operation can slip between.
        if !matches!(*start, StartState::Waiting)
            || commands
                .values()
                .any(|receipt| receipt.result.borrow().is_none())
        {
            self.retiring
                .store(false, std::sync::atomic::Ordering::SeqCst);
            return Ok(false);
        }
        if let Err(error) = storage::retire_manifest(&self.directory) {
            self.retiring
                .store(false, std::sync::atomic::Ordering::SeqCst);
            return Err(error);
        }
        Ok(true)
    }

    async fn request(self: &Arc<Self>, request: Request) -> Outcome {
        if request.protocol != PROTOCOL
            || request.worker_id != self.config.worker_id
            || !token_matches(&self.config.token, &request.token)
        {
            return Err(WorkerError::new(
                "unauthorized",
                "Worker capability authentication failed",
            ));
        }
        if !valid_id(&request.id) {
            return Err(WorkerError::new(
                "invalid_request_id",
                "Request ID must be a bounded stable identifier",
            ));
        }
        // Explicit host quit is idempotent and must remain available when disk
        // or receipt capacity is exhausted. Authentication above still applies.
        if matches!(request.command, Command::Shutdown) {
            self.app.processes.kill_all();
            let shutdown = self.shutdown.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(250)).await;
                shutdown.send_replace(true);
            });
            return Ok(json!({"stopping":true}));
        }
        if !request.command.is_mutation() {
            return self.read(request.command);
        }
        let bytes = serde_json::to_vec(&request.command)
            .map_err(|_| WorkerError::new("invalid_command", "Encode worker command failed"))?;
        let fingerprint = format!("{:x}", Sha256::digest(bytes));
        let (receipt, fresh) = {
            let mut commands = self.commands.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(receipt) = commands.get(&request.id) {
                if receipt.fingerprint != fingerprint {
                    return Err(WorkerError::new(
                        "request_conflict",
                        "Request ID was already used with different parameters",
                    ));
                }
                (receipt.clone(), false)
            } else {
                if self.retiring.load(std::sync::atomic::Ordering::SeqCst) {
                    return Err(WorkerError::new(
                        "worker_retiring",
                        "Worker has acknowledged its final delivery cursor",
                    ));
                }
                // Never evict deduplication state for a live worker.
                if commands.len() >= 8192 {
                    return Err(WorkerError::new(
                        "receipt_capacity",
                        "Worker command receipt capacity reached",
                    ));
                }
                if *self.receipt_fault.lock().unwrap_or_else(|p| p.into_inner()) {
                    return Err(WorkerError::new(
                        "receipt_storage",
                        "Worker receipt persistence is unavailable",
                    ));
                }
                self.receipts.append(
                    &json!({"id":request.id,"fingerprint":fingerprint,"phase":"accepted"}),
                )?;
                let (result, _) = watch::channel(None);
                let receipt = Arc::new(Receipt {
                    fingerprint,
                    result,
                });
                commands.insert(request.id.clone(), receipt.clone());
                (receipt, true)
            }
        };
        if fresh {
            let owner = self.clone();
            let entry = receipt.clone();
            tokio::spawn(async move {
                // Separate task: cancelling the socket future cannot cancel an
                // accepted command between pipe write and receipt publication.
                let execution_owner = owner.clone();
                let operation_id = request.id.clone();
                let execution = tokio::spawn(async move {
                    #[cfg(test)]
                    {
                        let gate = execution_owner.execution_gate.lock().unwrap().clone();
                        if let Some(gate) = gate {
                            gate.wait().await;
                        }
                    }
                    execution_owner
                        .execute(&operation_id, request.command)
                        .await
                });
                let outcome = execution.await.unwrap_or_else(|_| {
                    Err(WorkerError::unknown(
                        "execution_unknown",
                        "Worker command task failed; do not issue a new request ID",
                    ))
                });
                if owner
                    .receipts
                    .append(&json!({"id":request.id,"phase":"completed","outcome":outcome}))
                    .is_err()
                {
                    *owner
                        .receipt_fault
                        .lock()
                        .unwrap_or_else(|p| p.into_inner()) = true;
                }
                entry.result.send_replace(Some(outcome));
            });
        }
        let mut result = receipt.result.subscribe();
        loop {
            if let Some(outcome) = result.borrow().clone() {
                return outcome;
            }
            if result.changed().await.is_err() {
                return Err(WorkerError::unknown(
                    "outcome_unknown",
                    "Command completion is unavailable; do not issue a new request ID",
                ));
            }
        }
    }

    fn read(&self, command: Command) -> Outcome {
        match command {
            Command::Status => {
                self.flush();
                let (head, durable, fault) = self.journal.watermarks();
                let auto_title_pending = crate::auto_title::has_pending();
                let start = self.start.lock().unwrap_or_else(|p| p.into_inner());
                let (phase, request_id, engine) = match &*start {
                    StartState::Waiting => ("waiting", None, None),
                    StartState::Starting { request_id, args } => {
                        ("starting", Some(request_id), Some(&args.engine))
                    }
                    StartState::Started {
                        request_id,
                        args,
                        reader,
                    } => {
                        let phase = if !auto_title_pending
                            && self.app.processes.active_run_count() == 0
                            && reader.as_ref().is_some_and(|reader| reader.is_finished())
                        {
                            "retired"
                        } else if reader.is_none() {
                            "lifetime_unknown"
                        } else {
                            "running"
                        };
                        (phase, Some(request_id), Some(&args.engine))
                    }
                    StartState::Failed { request_id } => ("failed", Some(request_id), None),
                };
                let start_args = match &*start {
                    StartState::Starting { args, .. } | StartState::Started { args, .. } => {
                        Some(args)
                    }
                    _ => None,
                };
                let native_complete = self.app.processes.active_run_count() == 0
                    && match &*start {
                        StartState::Failed { .. } => true,
                        StartState::Started {
                            reader: Some(reader),
                            ..
                        } => reader.is_finished(),
                        _ => false,
                    };
                let session_id = self
                    .journal
                    .session_id()
                    .or_else(|| {
                        self.app.processes.0.lock().ok().and_then(|entries| {
                            entries
                                .iter()
                                .find(|(key, entry)| {
                                    *key != &self.config.run_id
                                        && entry.run_id == self.config.run_id
                                })
                                .map(|(key, _)| key.clone())
                        })
                    })
                    .or_else(|| start_args.and_then(|args| args.session_id.clone()));
                Ok(
                    json!({"workerId":self.config.worker_id,"runId":self.config.run_id,"phase":phase,
                    "startRequestId":request_id,"engine":engine,"activeRuns":self.app.processes.active_run_count(),
                    "workspacePath":start_args.map(|args| &args.workspace_path),"sessionId":session_id,
                    "physicalComplete":!auto_title_pending && matches!(phase, "retired" | "failed") && self.app.processes.active_run_count() == 0,
                    "autoTitlePending":auto_title_pending,"schemaHash":schema_hash(),
                    "nativeComplete":native_complete,
                    "streamId":self.config.worker_id,"head":head,"durableThrough":durable,
                    "journalFault":fault,"receiptFault":*self.receipt_fault.lock().unwrap_or_else(|p| p.into_inner()),
                    "capabilities":capabilities()}),
                )
            }
            Command::Events {
                stream_id,
                after,
                limit,
            } => {
                self.flush();
                serde_json::to_value(self.journal.replay(&stream_id, after, limit)?)
                    .map_err(|_| WorkerError::new("event_encode", "Encode event page failed"))
            }
            Command::EventChunk {
                stream_id,
                seq,
                offset,
                limit,
            } => serde_json::to_value(self.journal.chunk(&stream_id, seq, offset, limit)?)
                .map_err(|_| WorkerError::new("event_encode", "Encode event chunk failed")),
            Command::Receipt { request_id } => {
                let commands = self.commands.lock().unwrap_or_else(|p| p.into_inner());
                let Some(receipt) = commands.get(&request_id) else {
                    return Ok(json!({"phase":"unknown"}));
                };
                let outcome = receipt.result.borrow().clone();
                Ok(
                    json!({"phase":if outcome.is_some() { "completed" } else { "accepted" },"outcome":outcome}),
                )
            }
            _ => Err(WorkerError::new(
                "invalid_command",
                "Expected a read-only command",
            )),
        }
    }

    fn flush(&self) {
        self.app.sink.flush();
        self.app.terminal_sink.flush();
        self.app.plugin_sink.flush();
        self.app.mission_sink.flush();
    }

    fn start_args(&self) -> Result<StartArgs, WorkerError> {
        match &*self.start.lock().unwrap_or_else(|p| p.into_inner()) {
            StartState::Started { args, .. } => Ok(args.clone()),
            _ => Err(WorkerError::new(
                "run_unavailable",
                "Worker has not accepted a native run",
            )),
        }
    }

    async fn execute(&self, request_id: &str, command: Command) -> Outcome {
        // Some adapters can fail after transmitting a control frame. Preserve
        // the stable request ID and never imply that a new-ID retry is safe.
        let engine_error = |message: String| WorkerError::unknown("engine_error", message);
        match command {
            Command::Start { args } => {
                {
                    let mut start = self.start.lock().unwrap_or_else(|p| p.into_inner());
                    if !matches!(*start, StartState::Waiting) {
                        return Err(WorkerError::new(
                            "start_already_claimed",
                            "Worker accepts exactly one start request; retry the original ID",
                        ));
                    }
                    *start = StartState::Starting {
                        request_id: request_id.into(),
                        args: args.clone(),
                    };
                }
                let result = self.start_native(&args).await;
                let reader = self
                    .app
                    .processes
                    .get(&self.config.run_id)
                    .and_then(|entry| entry.reader_abort.get().cloned());
                *self.start.lock().unwrap_or_else(|p| p.into_inner()) = if result.is_ok() {
                    StartState::Started {
                        request_id: request_id.into(),
                        args,
                        reader,
                    }
                } else {
                    StartState::Failed {
                        request_id: request_id.into(),
                    }
                };
                result
            }
            Command::Interrupt => {
                let registry = self.app.processes.clone();
                let id = self.config.run_id.clone();
                let killed = tokio::task::spawn_blocking(move || registry.kill(&id))
                    .await
                    .map_err(|_| {
                        WorkerError::unknown("interrupt_unknown", "Worker interrupt task failed")
                    })?;
                Ok(json!(killed))
            }
            Command::InterruptTurn => Ok(json!(crate::engine::interrupt_turn_inner(
                &self.app.processes,
                &self.config.run_id
            )
            .await
            .map_err(engine_error)?)),
            Command::Followup {
                prompt,
                image_paths,
            } => {
                let args = self.start_args()?;
                Ok(json!(crate::engine::send_follow_up_inner(
                    &self.app.processes,
                    &self.config.run_id,
                    &args.engine,
                    Path::new(&args.workspace_path),
                    &prompt,
                    image_paths.as_deref().unwrap_or(&[])
                )
                .await
                .map_err(engine_error)?))
            }
            Command::StopTask { task_id } => serde_json::to_value(
                crate::engine::stop_native_task_inner(
                    &self.app.processes,
                    &self.config.run_id,
                    &task_id,
                )
                .await
                .map_err(engine_error)?,
            )
            .map_err(|_| WorkerError::new("response_encode", "Encode task stop result failed")),
            Command::AnswerQuestion {
                question_id,
                answers,
            } => {
                crate::engine::answer_question_inner(
                    &self.app,
                    self.config.run_id.clone(),
                    question_id,
                    answers,
                )
                .await
                .map_err(engine_error)?;
                Ok(Value::Null)
            }
            Command::Plan {
                plan_id,
                expected_revision,
                decision,
                feedback,
            } => {
                let entry = self.app.processes.get(&self.config.run_id).ok_or_else(|| {
                    WorkerError::new("run_unavailable", "Plan has no live worker run")
                })?;
                if !entry
                    .plans
                    .lock()
                    .map_err(|_| WorkerError::new("plan_state", "Plan state unavailable"))?
                    .contains_key(&plan_id)
                {
                    return Err(WorkerError::new(
                        "plan_scope",
                        "Plan is not owned by this worker run",
                    ));
                }
                let decision = serde_json::from_value::<crate::engine::plan_review::PlanDecision>(
                    json!(decision),
                )
                .map_err(|_| WorkerError::new("invalid_decision", "Invalid plan decision"))?;
                serde_json::to_value(
                    crate::engine::worker_respond_plan_review(
                        &self.app,
                        &self.config.run_id,
                        plan_id,
                        expected_revision,
                        decision,
                        feedback,
                    )
                    .await
                    .map_err(engine_error)?,
                )
                .map_err(|_| WorkerError::new("response_encode", "Encode plan result failed"))
            }
            Command::Retire { stream_id, through } => {
                let physically_finished =
                    match &*self.start.lock().unwrap_or_else(|p| p.into_inner()) {
                        StartState::Failed { .. } => true,
                        StartState::Started {
                            reader: Some(reader),
                            ..
                        } => reader.is_finished(),
                        _ => false,
                    };
                if !physically_finished || self.app.processes.active_run_count() != 0 {
                    return Err(WorkerError::new(
                        "run_active",
                        "Worker reader or native process is still active",
                    ));
                }
                if crate::auto_title::has_pending() {
                    return Err(WorkerError::new(
                        "auxiliary_pending",
                        "Automatic title work has not finished",
                    ));
                }
                self.flush();
                let (head, durable, fault) = self.journal.watermarks();
                if stream_id != self.config.worker_id || through != head || head != durable || fault
                {
                    return Err(WorkerError::new(
                        "delivery_unconfirmed",
                        "Retirement requires the complete durable event cursor",
                    ));
                }
                if *self.receipt_fault.lock().unwrap_or_else(|p| p.into_inner()) {
                    return Err(WorkerError::new(
                        "receipt_storage",
                        "Receipt archive must be durable before retirement",
                    ));
                }
                {
                    let commands = self.commands.lock().unwrap_or_else(|p| p.into_inner());
                    if commands
                        .iter()
                        .any(|(id, receipt)| id != request_id && receipt.result.borrow().is_none())
                    {
                        return Err(WorkerError::new(
                            "commands_pending",
                            "Accepted worker commands have not finished",
                        ));
                    }
                    self.retiring
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                }
                let outcome = json!({"retired":true,"through":through});
                // Persist this final receipt before removing the live manifest.
                // The generic command recorder repeats it harmlessly afterwards.
                let archived = self.receipts.append(&json!({"id":request_id,"phase":"completed","outcome":Ok::<_, WorkerError>(outcome.clone())}))
                    .and_then(|_| storage::retire_manifest(&self.directory));
                if let Err(error) = archived {
                    self.retiring
                        .store(false, std::sync::atomic::Ordering::SeqCst);
                    return Err(error);
                }
                // Grace for the final acknowledgement; the archive is retained
                // if the response is lost after the manifest has been retired.
                let shutdown = self.shutdown.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    shutdown.send_replace(true);
                });
                Ok(outcome)
            }
            _ => Err(WorkerError::new(
                "invalid_command",
                "Expected a mutating command",
            )),
        }
    }

    async fn start_native(&self, args: &StartArgs) -> Outcome {
        if args.require_leader || args.computer_use == Some(true) {
            return Err(WorkerError::new(
                "unsupported_capability",
                "This worker does not yet host Leader or computer-use services",
            ));
        }
        if args.require_host_chat
            || matches!(args.engine.as_str(), "claude" | "codex" | "agy" | "cursor")
        {
            let context = self.config.host_context.as_ref().ok_or_else(|| {
                WorkerError::new(
                    "unsupported_capability",
                    "A host-registered chat capability is required; worker must not omit Claude/Codex/AGY/Cursor tools",
                )
            })?;
            context
                .validate_for(
                    &self.config.run_id,
                    &args.engine,
                    args.session_id.as_deref(),
                    &args.workspace_path,
                )
                .map_err(|error| WorkerError::new("host_context", error))?;
            if let Ok(settings) = crate::settings::read_settings() {
                let _ = crate::proxy::apply_app_proxy_settings(&settings);
            }
        }
        serde_json::to_value(
            crate::engine::worker_send_message(
                &self.app,
                args.engine.clone(),
                args.workspace_path.clone(),
                args.session_id.clone(),
                args.prompt.clone(),
                args.image_paths.clone(),
                args.model.clone(),
                args.effort.clone(),
                args.permission.clone(),
                args.provider_id.clone(),
                Some(self.config.run_id.clone()),
                args.computer_use,
                args.claude_ultracode,
                args.claude_haiku_assist,
            )
            .await
            .map_err(|error| WorkerError::new("engine_error", error))?,
        )
        .map_err(|_| {
            WorkerError::unknown(
                "response_encode",
                "Native run started but its response could not be encoded",
            )
        })
    }
}

pub(crate) async fn read_frame<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
) -> Result<Vec<u8>, WorkerError> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_FRAME_BYTES + 1) as u64)
        .read_until(b'\n', &mut bytes)
        .await
        .map_err(|_| WorkerError::unknown("transport_read", "Read worker protocol frame failed"))?;
    if bytes.is_empty() {
        return Err(WorkerError::unknown(
            "transport_closed",
            "Worker connection closed",
        ));
    }
    if bytes.len() > MAX_FRAME_BYTES || !bytes.ends_with(b"\n") {
        return Err(WorkerError::new(
            "invalid_frame",
            "Worker frame exceeds limit or is incomplete",
        ));
    }
    Ok(bytes)
}

async fn serve_connection(worker: Arc<Worker>, socket: tokio::net::TcpStream) {
    let (reader, mut writer) = socket.into_split();
    let mut reader = BufReader::new(reader);
    loop {
        let frame =
            match tokio::time::timeout(Duration::from_secs(30), read_frame(&mut reader)).await {
                Ok(Ok(frame)) => frame,
                _ => return,
            };
        let request = match serde_json::from_slice::<Request>(&frame) {
            Ok(request) => request,
            Err(_) => return,
        };
        let id = request.id.clone();
        let outcome = worker.request(request).await;
        let unauthorized = outcome
            .as_ref()
            .err()
            .is_some_and(|error| error.code == "unauthorized");
        let response = Response {
            protocol: PROTOCOL,
            worker_id: worker.config.worker_id.clone(),
            id,
            outcome,
        };
        let Ok(mut bytes) = serde_json::to_vec(&response) else {
            return;
        };
        if bytes.len() >= MAX_FRAME_BYTES {
            return;
        }
        bytes.push(b'\n');
        if writer.write_all(&bytes).await.is_err() || unauthorized {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_quota_invalidation_is_journaled_without_account_or_usage_payload() {
        let (worker, directory) = fixture();
        // A private state avoids cross-test interference with the process-wide
        // notifier while using the production BroadcastEmit -> JournalEmitter.
        let quota = crate::claude_quota::ClaudeQuotaState::default();
        quota.install_events(worker.app.emitters.clone());
        quota.ingest_bound("synthetic-account", crate::claude_quota::QuotaWindows {
            five_hour: Some(crate::claude_quota::QuotaWindow {
                used_percentage: 42.0,
                resets_at: None,
            }),
            seven_day: None,
        });
        let page = worker.journal.replay("worker-test", 0, 64).unwrap();
        assert_eq!(page.events.len(), 1);
        assert_eq!(page.events[0].name, "claude-quota://changed");
        assert_eq!(page.events[0].payload, Value::Null);
        drop(quota);
        drop(worker);
        let _ = std::fs::remove_dir_all(directory);
    }

    fn fixture() -> (Arc<Worker>, PathBuf) {
        let directory =
            std::env::temp_dir().join(format!("ccgui-worker-protocol-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let config = WorkerConfig {
            protocol: PROTOCOL,
            worker_id: "worker-test".into(),
            run_id: "run-test".into(),
            profile: directory.clone(),
            token: "a".repeat(64),
            schema_hash: schema_hash(),
            host_context: None,
        };
        let journal =
            Arc::new(storage::Journal::new(&directory, config.worker_id.clone()).unwrap());
        let app = app_state(
            Arc::new(crate::db::Db::open_at(Path::new(":memory:")).unwrap()),
            journal.clone(),
        );
        let (shutdown, _) = watch::channel(false);
        let worker = Arc::new(Worker {
            config,
            directory: directory.clone(),
            app,
            journal,
            receipts: storage::ReceiptLog::new(&directory).unwrap(),
            commands: Mutex::new(HashMap::new()),
            start: Mutex::new(StartState::Waiting),
            shutdown,
            receipt_fault: Mutex::new(false),
            retiring: std::sync::atomic::AtomicBool::new(false),
            execution_gate: Mutex::new(None),
        });
        (worker, directory)
    }

    fn request(worker: &Worker, id: &str, command: Command) -> Request {
        Request {
            protocol: PROTOCOL,
            worker_id: worker.config.worker_id.clone(),
            token: worker.config.token.clone(),
            id: id.into(),
            command,
        }
    }

    fn finish(worker: Arc<Worker>, directory: PathBuf) {
        drop(worker);
        // Only known fixture-owned files; no recursive cleanup of computed roots.
        for name in [
            "events.jsonl",
            "receipts.jsonl",
            "manifest.json",
            "manifest.retired.json",
        ] {
            let path = directory.join(name);
            if path.exists() {
                std::fs::remove_file(path).unwrap();
            }
        }
        std::fs::remove_dir(directory).unwrap();
    }

    fn args() -> StartArgs {
        StartArgs {
            engine: "claude".into(),
            workspace_path: "fixture-only".into(),
            session_id: None,
            prompt: "fixture".into(),
            image_paths: None,
            model: None,
            effort: None,
            permission: None,
            provider_id: None,
            computer_use: None,
            claude_ultracode: None,
            claude_haiku_assist: None,
            require_host_chat: true,
            require_leader: false,
        }
    }

    #[test]
    fn compatibility_probe_never_initializes_profile_or_runtime() {
        let probe = probe();
        assert_eq!(probe["protocol"], PROTOCOL);
        assert_eq!(probe["schemaHash"].as_str().unwrap().len(), 64);
        assert_eq!(probe["capabilities"]["hostChatRequiresContext"], true);
        assert!(token_matches(&"a".repeat(64), &"a".repeat(64)));
        assert!(!token_matches(&"a".repeat(64), &"b".repeat(64)));
    }

    #[tokio::test]
    async fn authentication_precedes_receipt_or_engine_state_changes() {
        let (worker, directory) = fixture();
        let mut invalid = request(&worker, "request-1", Command::Interrupt);
        invalid.token = "b".repeat(64);
        assert_eq!(
            worker.request(invalid).await.unwrap_err().code,
            "unauthorized"
        );
        let mut wrong_worker = request(&worker, "request-1", Command::Status);
        wrong_worker.worker_id = "somebody-else".into();
        assert_eq!(
            worker.request(wrong_worker).await.unwrap_err().code,
            "unauthorized"
        );
        assert!(worker.commands.lock().unwrap().is_empty());
        assert_eq!(
            std::fs::metadata(directory.join("receipts.jsonl"))
                .unwrap()
                .len(),
            0
        );
        finish(worker, directory);
    }

    #[tokio::test]
    async fn ordinary_quit_still_stops_when_receipt_storage_and_capacity_are_exhausted() {
        let (worker, directory) = fixture();
        *worker.receipt_fault.lock().unwrap() = true;
        for index in 0..8192 {
            let (result, _) = watch::channel(None);
            worker.commands.lock().unwrap().insert(
                format!("full-{index}"),
                Arc::new(Receipt {
                    fingerprint: String::new(),
                    result,
                }),
            );
        }
        worker.app.processes.0.lock().unwrap().insert(
            "run-test".into(),
            crate::engine::ChildEntry::worker_proxy("run-test", 0),
        );
        let mut unauthorized = request(&worker, "quit-wrong", Command::Shutdown);
        unauthorized.token = "b".repeat(64);
        assert_eq!(
            worker.request(unauthorized).await.unwrap_err().code,
            "unauthorized"
        );
        assert_eq!(worker.app.processes.active_run_count(), 1);
        assert_eq!(
            worker
                .request(request(&worker, "quit", Command::Shutdown))
                .await
                .unwrap()["stopping"],
            true
        );
        assert_eq!(worker.app.processes.active_run_count(), 0);
        assert_eq!(
            std::fs::metadata(directory.join("receipts.jsonl"))
                .unwrap()
                .len(),
            0
        );
        finish(worker, directory);
    }

    #[tokio::test]
    async fn repeated_control_id_returns_original_result_and_different_parameters_conflict() {
        let (worker, directory) = fixture();
        worker.app.processes.0.lock().unwrap().insert(
            "run-test".into(),
            crate::engine::ChildEntry {
                child: None,
                pid: 0,
                run_id: "run-test".into(),
                killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                reader_abort: Arc::new(std::sync::OnceLock::new()),
                stdin: None,
                questions: Default::default(),
                plans: Default::default(),
                native_tasks: Default::default(),
                codex_control: None,
            },
        );
        let original = worker
            .request(request(&worker, "stop-1", Command::Interrupt))
            .await
            .unwrap();
        assert_eq!(original, true);
        // The real registry has retired since the first result. Re-executing
        // kill would now return false; replay must return its original true.
        worker.app.processes.0.lock().unwrap().clear();
        let (one, two) = tokio::join!(
            worker.request(request(&worker, "stop-1", Command::Interrupt)),
            worker.request(request(&worker, "stop-1", Command::Interrupt))
        );
        assert_eq!(one.unwrap(), original);
        assert_eq!(two.unwrap(), original);
        assert_eq!(
            worker
                .request(request(&worker, "stop-1", Command::InterruptTurn))
                .await
                .unwrap_err()
                .code,
            "request_conflict"
        );
        assert_eq!(
            worker
                .request(request(&worker, "stop-2", Command::Interrupt))
                .await
                .unwrap(),
            false
        );
        let lines = std::fs::read_to_string(directory.join("receipts.jsonl")).unwrap();
        assert_eq!(
            lines
                .lines()
                .filter(|line| line.contains("\"phase\":\"accepted\""))
                .count(),
            2
        );
        finish(worker, directory);
    }

    #[tokio::test]
    async fn unsupported_start_is_explicit_and_cannot_be_replaced_by_second_start() {
        let (worker, directory) = fixture();
        let first = Command::Start { args: args() };
        let error = worker
            .request(request(&worker, "start-1", first.clone()))
            .await
            .unwrap_err();
        assert_eq!(error.code, "unsupported_capability");
        assert_eq!(
            worker
                .request(request(&worker, "start-1", first))
                .await
                .unwrap_err(),
            error
        );
        let mut changed = args();
        changed.prompt = "changed".into();
        assert_eq!(
            worker
                .request(request(
                    &worker,
                    "start-1",
                    Command::Start { args: changed }
                ))
                .await
                .unwrap_err()
                .code,
            "request_conflict"
        );
        assert_eq!(
            worker
                .request(request(&worker, "start-2", Command::Start { args: args() }))
                .await
                .unwrap_err()
                .code,
            "start_already_claimed"
        );
        assert_eq!(worker.app.processes.active_run_count(), 0);
        finish(worker, directory);
    }

    #[tokio::test]
    async fn client_disconnect_does_not_cancel_accepted_command_or_discard_events() {
        let (worker, directory) = fixture();
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let owner = worker.clone();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            serve_connection(owner, socket).await;
        });
        let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
        let mut frame =
            serde_json::to_vec(&request(&worker, "disconnect-stop", Command::Interrupt)).unwrap();
        frame.push(b'\n');
        socket.write_all(&frame).await.unwrap();
        drop(socket);
        tokio::time::timeout(Duration::from_secs(2), server)
            .await
            .unwrap()
            .unwrap();
        let receipt = worker
            .read(Command::Receipt {
                request_id: "disconnect-stop".into(),
            })
            .unwrap();
        assert_eq!(receipt["phase"], "completed");
        worker.journal.append(
            "engine://event",
            json!([{"kind":"delta","text":"still running 中文🦀"}]),
        );
        let replay = worker
            .read(Command::Events {
                stream_id: "worker-test".into(),
                after: 0,
                limit: 64,
            })
            .unwrap();
        assert_eq!(
            replay["events"][0]["payload"][0]["text"],
            "still running 中文🦀"
        );
        assert_eq!(
            worker
                .read(Command::Events {
                    stream_id: "worker-test".into(),
                    after: 1,
                    limit: 64
                })
                .unwrap()["events"],
            json!([])
        );
        finish(worker, directory);
    }

    #[tokio::test]
    async fn done_event_and_empty_registry_cannot_retire_unfinished_reader() {
        let (worker, directory) = fixture();
        let (end, pending) = tokio::sync::oneshot::channel::<()>();
        let reader = tokio::spawn(async move {
            let _ = pending.await;
        });
        *worker.start.lock().unwrap() = StartState::Started {
            request_id: "synthetic-start".into(),
            args: args(),
            reader: Some(reader.abort_handle()),
        };
        worker
            .journal
            .append("engine://event", json!([{"kind":"done"}]));
        assert_eq!(worker.read(Command::Status).unwrap()["phase"], "running");
        assert_eq!(
            worker
                .request(request(
                    &worker,
                    "retire-early",
                    Command::Retire {
                        stream_id: "worker-test".into(),
                        through: 1
                    }
                ))
                .await
                .unwrap_err()
                .code,
            "run_active"
        );
        end.send(()).unwrap();
        reader.await.unwrap();
        assert_eq!(worker.read(Command::Status).unwrap()["phase"], "retired");
        assert_eq!(
            worker
                .request(request(
                    &worker,
                    "retire-gap",
                    Command::Retire {
                        stream_id: "worker-test".into(),
                        through: 0
                    }
                ))
                .await
                .unwrap_err()
                .code,
            "delivery_unconfirmed"
        );
        finish(worker, directory);
    }

    #[tokio::test]
    async fn idle_reclamation_cannot_overtake_an_accepted_start_waiting_at_execution_barrier() {
        let (worker, directory) = fixture();
        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        *worker.execution_gate.lock().unwrap() = Some(barrier.clone());
        let owner = worker.clone();
        let pending = tokio::spawn(async move {
            owner
                .request(request(
                    &owner,
                    "barrier-start",
                    Command::Start { args: args() },
                ))
                .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while !worker
                .commands
                .lock()
                .unwrap()
                .contains_key("barrier-start")
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(matches!(*worker.start.lock().unwrap(), StartState::Waiting));
        assert_eq!(
            worker
                .read(Command::Receipt {
                    request_id: "barrier-start".into()
                })
                .unwrap()["phase"],
            "accepted"
        );
        // Exercise exactly the same reclaim branch the 120-second timer calls.
        assert!(!worker.retire_if_unstarted().unwrap());
        assert!(!worker.retiring.load(std::sync::atomic::Ordering::SeqCst));
        barrier.wait().await;
        assert_eq!(
            pending.await.unwrap().unwrap_err().code,
            "unsupported_capability"
        );
        finish(worker, directory);
    }

    #[tokio::test]
    async fn idle_reclamation_closes_admission_before_removing_the_manifest() {
        let (worker, directory) = fixture();
        std::fs::write(directory.join("manifest.json"), b"{}").unwrap();
        assert!(worker.retire_if_unstarted().unwrap());
        assert!(directory.join("manifest.retired.json").is_file());
        assert_eq!(
            worker
                .request(request(
                    &worker,
                    "too-late-start",
                    Command::Start { args: args() }
                ))
                .await
                .unwrap_err()
                .code,
            "worker_retiring"
        );
        assert!(worker.commands.lock().unwrap().is_empty());
        finish(worker, directory);
    }

    #[tokio::test]
    async fn nine_mib_event_reassembles_before_done_and_final_cursor_can_be_acknowledged() {
        let (worker, directory) = fixture();
        std::fs::write(directory.join("manifest.json"), b"{}").unwrap();
        let text = "中🙂a".repeat(9 * 1024 * 1024 / 8);
        assert_eq!(text.len(), 9 * 1024 * 1024);
        worker
            .journal
            .append("engine://event", json!([{"kind":"delta","text":text}]));
        worker
            .journal
            .append("engine://event", json!([{"kind":"done"}]));
        let raw = worker.journal.replay("worker-test", 0, 64).unwrap();
        assert_eq!((raw.through, raw.head), (0, 2));
        assert!(raw.events.is_empty());
        assert_eq!(raw.fragment.unwrap().seq, 1);
        let mut chunks = 0;
        let first = client::replay_with("worker-test", 0, 64, |command| {
            if matches!(command, Command::EventChunk { .. }) {
                chunks += 1;
            }
            let reply = worker.read(command);
            if let Ok(value) = &reply {
                // Every response remains bounded; the 9 MiB event is never put
                // into a single protocol frame or silently truncated.
                assert!(serde_json::to_vec(value).unwrap().len() < 400 * 1024);
            }
            std::future::ready(reply)
        })
        .await
        .unwrap();
        assert!(chunks >= 36);
        assert_eq!(first.through, 1);
        assert!(first.fragment.is_none());
        assert_eq!(
            first.events[0].payload[0]["text"].as_str(),
            Some(text.as_str())
        );
        let second = client::replay_with("worker-test", first.through, 64, |command| {
            std::future::ready(worker.read(command))
        })
        .await
        .unwrap();
        assert_eq!(
            (second.through, second.head, second.durable_through),
            (2, 2, 2)
        );
        assert_eq!(second.events[0].seq, 2);
        assert_eq!(second.events[0].payload[0]["kind"], "done");
        *worker.start.lock().unwrap() = StartState::Failed {
            request_id: "fixture-finished".into(),
        };
        let acknowledged = worker
            .request(request(
                &worker,
                "ack-complete",
                Command::Retire {
                    stream_id: "worker-test".into(),
                    through: second.through,
                },
            ))
            .await
            .unwrap();
        assert_eq!(acknowledged, json!({"retired":true,"through":2}));
        assert!(directory.join("manifest.retired.json").is_file());
        finish(worker, directory);
    }

    #[tokio::test]
    async fn corrupted_chunk_or_offset_never_returns_an_advanced_replay_cursor() {
        let (worker, directory) = fixture();
        worker
            .journal
            .append("engine://event", json!("x".repeat(3 * 1024 * 1024)));
        let bad_offset = client::replay_with("worker-test", 0, 64, |command| {
            let chunk = matches!(command, Command::EventChunk { .. });
            let mut reply = worker.read(command).unwrap();
            if chunk {
                reply["offset"] = json!(1);
            }
            std::future::ready(Ok(reply))
        })
        .await
        .unwrap_err();
        assert_eq!(bad_offset.code, "invalid_event_replay");
        let corrupted = client::replay_with("worker-test", 0, 64, |command| {
            let first_chunk = matches!(command, Command::EventChunk { offset: 0, .. });
            let mut reply = worker.read(command).unwrap();
            if first_chunk {
                // Alter a valid base64 character, retaining length and framing.
                let data = reply["dataBase64"].as_str().unwrap();
                reply["dataBase64"] = json!(format!("A{}", &data[1..]));
            }
            std::future::ready(Ok(reply))
        })
        .await
        .unwrap_err();
        assert_eq!(corrupted.code, "event_integrity");
        assert_eq!(
            worker.journal.replay("worker-test", 0, 64).unwrap().through,
            0
        );
        finish(worker, directory);
    }

    #[test]
    fn schema_hash_matches_v2_contract_and_isolates_v1_legacy_equivalents() {
        let current = schema_hash();
        assert_eq!(
            current, SCHEMA_CONTRACT_V2_HASH,
            "current schema_hash()={current}"
        );
        for legacy in LEGACY_V1_SOURCE_SCHEMA_HASHES {
            assert!(schemas_compatible(SCHEMA_CONTRACT_V1_HASH, legacy));
            assert!(schemas_compatible(legacy, SCHEMA_CONTRACT_V1_HASH));
            assert!(!schemas_compatible(&current, legacy));
            assert!(!schemas_compatible(legacy, &current));
            for other in LEGACY_V1_SOURCE_SCHEMA_HASHES {
                assert!(schemas_compatible(legacy, other));
            }
            assert!(!schemas_compatible(legacy, &"0".repeat(64)));
        }
        assert!(!schemas_compatible(&current, &"0".repeat(64)));
        assert!(!schemas_compatible(&"0".repeat(64), &current));
        assert!(!schemas_compatible(&current, SCHEMA_CONTRACT_V1_HASH));
        assert!(!schemas_compatible(SCHEMA_CONTRACT_V1_HASH, &current));
        assert!(schemas_compatible(&current, &current));
    }

    #[test]
    fn schema_contract_hash_detects_cost_approval_fields_and_states() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        let descriptor = crate::leader::schema_contract_descriptor();
        assert_eq!(descriptor["branchRecord"]["costApproval"], json!({
            "requestId": "", "capturedAt": 0, "model": "",
            "cache": {
                "ttlSeconds": 0, "startedAt": 0, "observedAt": 0, "source": "",
                "reference": { "maxTtlSeconds": 0, "cacheReadTokens": 0, "promptTokens": 0 }
            }
        }));
        let baseline = compute_schema_contract_hash(&conn, &[("leader", &descriptor)]).unwrap();
        for pointer in [
            "/branchRecord/costApproval",
            "/branchRecord/costApproval/cache",
            "/branchRecord/costApproval/cache/reference",
        ] {
            for field in descriptor.pointer(pointer).unwrap().as_object().unwrap().keys() {
                let mut changed = descriptor.clone();
                changed.pointer_mut(pointer).unwrap().as_object_mut().unwrap().remove(field);
                assert_ne!(compute_schema_contract_hash(&conn, &[("leader", &changed)]).unwrap(), baseline, "{pointer}/{field}");
            }
        }
        for states in ["branchStates", "requestStates"] {
            let mut changed = descriptor.clone();
            let values = changed[states].as_array_mut().unwrap();
            assert!(values.iter().any(|value| value == "awaiting_cost_approval"));
            values.retain(|value| value != "awaiting_cost_approval");
            assert_ne!(compute_schema_contract_hash(&conn, &[("leader", &changed)]).unwrap(), baseline, "{states}");
        }
    }

    #[test]
    fn schema_contract_hash_ignores_sql_comments_and_whitespace_but_detects_ddl_or_record_changes() {
        let conn_a = rusqlite::Connection::open_in_memory().unwrap();
        conn_a
            .execute_batch(
                "-- header comment\nCREATE TABLE items (\n    id TEXT PRIMARY KEY,\n    /* inline block comment */\n    count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0)\n);\nCREATE INDEX idx_items_count ON items (count);",
            )
            .unwrap();
        let conn_b = rusqlite::Connection::open_in_memory().unwrap();
        conn_b
            .execute_batch(
                "CREATE TABLE items(id TEXT PRIMARY KEY,count INTEGER NOT NULL DEFAULT 0 CHECK(count>=0));CREATE INDEX idx_items_count ON items(count);",
            )
            .unwrap();
        let descriptors = [("leader", &json!({"version": 1}))];
        let hash_a = compute_schema_contract_hash(&conn_a, &descriptors).unwrap();
        let hash_b = compute_schema_contract_hash(&conn_b, &descriptors).unwrap();
        assert_eq!(hash_a, hash_b);

        let conn_col = rusqlite::Connection::open_in_memory().unwrap();
        conn_col
            .execute_batch(
                "CREATE TABLE items(id TEXT PRIMARY KEY,count INTEGER NOT NULL DEFAULT 0 CHECK(count>=0),extra TEXT);CREATE INDEX idx_items_count ON items(count);",
            )
            .unwrap();
        assert_ne!(
            compute_schema_contract_hash(&conn_col, &descriptors).unwrap(),
            hash_a
        );

        let conn_check = rusqlite::Connection::open_in_memory().unwrap();
        conn_check
            .execute_batch(
                "CREATE TABLE items(id TEXT PRIMARY KEY,count INTEGER NOT NULL DEFAULT 0 CHECK(count>0));CREATE INDEX idx_items_count ON items(count);",
            )
            .unwrap();
        assert_ne!(
            compute_schema_contract_hash(&conn_check, &descriptors).unwrap(),
            hash_a
        );

        let changed_descriptors = [("leader", &json!({"version": 2}))];
        assert_ne!(
            compute_schema_contract_hash(&conn_a, &changed_descriptors).unwrap(),
            hash_a
        );
    }
}
