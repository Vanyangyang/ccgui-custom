use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension};

pub(crate) mod session_auxiliary;

/// Folded into the scanner's stat signature so a schema/derivation change
/// still invalidates cached parse results.
pub const CACHE_VERSION: &str = "2";

pub struct Db(pub Mutex<Connection>);

impl Db {
    /// A task worker joins the owning host's database. It must neither create
    /// an empty profile nor run migrations while an older task still writes.
    pub(crate) fn open_existing(path: &std::path::Path) -> rusqlite::Result<Self> {
        let conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
                | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        Ok(Self(Mutex::new(conn)))
    }

    pub(crate) fn open_in_memory() -> rusqlite::Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        migrate(&conn)?;
        Ok(Self(Mutex::new(conn)))
    }

    pub fn open() -> rusqlite::Result<Self> {
        Self::open_at(&crate::paths::db_path())
    }
    pub fn open_at(path: &std::path::Path) -> rusqlite::Result<Self> {
        // The db sits next to config.json (provider API keys): owner-only.
        // Touch the file first so the permission lands before sqlite's own
        // lazy creation can pick a looser umask default.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .open(path);
            if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
                eprintln!("[db] chmod 0600 {}: {e}", path.display());
            }
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        // ON DELETE CASCADE keeps session_messages/messages_fts and
        // fts_state in step with every sessions-row delete path (session
        // delete, stale pruning, workspace removal) without each site
        // remembering the index tables. No pre-existing table declares an
        // FK, so enabling enforcement changes nothing else.
        conn.pragma_update(None, "foreign_keys", "ON")?;
        migrate(&conn)?;
        Ok(Self(Mutex::new(conn)))
    }

    /// All registered workspace roots (session attribution + path confinement).
    pub fn workspace_paths(&self) -> Result<Vec<String>, String> {
        let conn = self.0.lock();
        let mut stmt = conn
            .prepare("SELECT path FROM workspaces")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            match row {
                Ok(path) => out.push(path),
                Err(e) => eprintln!("[db] skipping undecodable workspace row: {e}"),
            }
        }
        Ok(out)
    }

    /// Directories the user explicitly granted file access to on top of the
    /// registered workspaces (the on-demand grant flow, files::grant_root).
    pub fn granted_roots(&self) -> Result<Vec<String>, String> {
        let conn = self.0.lock();
        let mut stmt = conn
            .prepare("SELECT path FROM granted_roots ORDER BY granted_at")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            match row {
                Ok(path) => out.push(path),
                Err(e) => eprintln!("[db] skipping undecodable granted_roots row: {e}"),
            }
        }
        Ok(out)
    }

    pub fn add_granted_root(&self, path: &str) -> Result<(), String> {
        let conn = self.0.lock();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        conn.execute(
            "INSERT OR IGNORE INTO granted_roots(path, granted_at) VALUES(?1, ?2)",
            rusqlite::params![path, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn remove_granted_root(&self, path: &str) -> Result<(), String> {
        let conn = self.0.lock();
        conn.execute("DELETE FROM granted_roots WHERE path=?1", [path])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    /// Per-plugin KV value (plugins::plugin_storage_get). Stored as JSON text;
    /// a corrupt row surfaces as an error instead of a silent `None` so the
    /// plugin host notices instead of losing state quietly.
    /// Devices that have reached the LAN bridge, newest first. `approved_at`
    /// being set is what lets a device through: the user approves each new
    /// device in the app before it can see or drive anything.
    pub fn web_devices(&self) -> Result<Vec<crate::web::WebDevice>, String> {
        let conn = self.0.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, user_agent, created_at, last_seen_at, approved_at, name, approval_generation
                 FROM web_devices ORDER BY COALESCE(approved_at, 0) DESC, last_seen_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(crate::web::WebDevice {
                    id: r.get(0)?,
                    user_agent: r.get(1)?,
                    created_at: r.get(2)?,
                    last_seen_at: r.get(3)?,
                    approved_at: r.get(4)?,
                    name: r.get(5)?,
                    approval_generation: r.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    pub fn web_device_get(&self, id: &str) -> Result<Option<crate::web::WebDevice>, String> {
        let conn = self.0.lock();
        conn.query_row(
            "SELECT id, user_agent, created_at, last_seen_at, approved_at, name, approval_generation
             FROM web_devices WHERE id=?1",
            rusqlite::params![id],
            |r| {
                Ok(crate::web::WebDevice {
                    id: r.get(0)?,
                    user_agent: r.get(1)?,
                    created_at: r.get(2)?,
                    last_seen_at: r.get(3)?,
                    approved_at: r.get(4)?,
                    name: r.get(5)?,
                    approval_generation: r.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    /// Remember a device that is asking for access (idempotent: a device that
    /// keeps polling just refreshes `last_seen_at`, and an approval survives).
    pub fn web_device_touch(&self, id: &str, user_agent: &str, now: i64) -> Result<(), String> {
        let conn = self.0.lock();
        conn.execute(
            "INSERT INTO web_devices (id, user_agent, created_at, last_seen_at)
             VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(id) DO UPDATE SET last_seen_at=?3,
               user_agent=CASE WHEN excluded.user_agent != '' THEN excluded.user_agent ELSE user_agent END",
            rusqlite::params![id, user_agent, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Remember the model id a session ran, spelled as the picker spells it
    /// ("provider/model"). The engine's own transcript keeps only the bare
    /// model name, so this row is the session's provider + model memory for
    /// every other client and for the next app start.
    pub fn remember_session_model(
        &self,
        engine: &str,
        session_id: &str,
        model: &str,
        now: i64,
    ) -> Result<(), String> {
        let conn = self.0.lock();
        conn.execute(
            "INSERT INTO session_models(engine, session_id, model, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(engine, session_id) DO UPDATE SET model=excluded.model, updated_at=excluded.updated_at",
            rusqlite::params![engine, session_id, model, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Remember the reasoning effort a session ran, beside its model. The
    /// picker follows the session, so a session reopened after a restart — or
    /// on the phone — keeps running the level it used instead of the engine
    /// default.
    pub fn remember_session_effort(
        &self,
        engine: &str,
        session_id: &str,
        effort: &str,
        now: i64,
    ) -> Result<(), String> {
        let conn = self.0.lock();
        conn.execute(
            "INSERT INTO session_efforts(engine, session_id, effort, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(engine, session_id) DO UPDATE SET effort=excluded.effort, updated_at=excluded.updated_at",
            rusqlite::params![engine, session_id, effort, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Remember the independent Claude switch, including an explicit false.
    pub fn remember_claude_ultracode(
        &self, session_id: &str, enabled: bool, now: i64,
    ) -> Result<(), String> {
        self.0.lock().execute(
            "INSERT INTO session_claude_options(session_id, ultracode, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(session_id) DO UPDATE SET ultracode=excluded.ultracode, updated_at=excluded.updated_at",
            rusqlite::params![session_id, enabled, now],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Remember the in-app channel a session ran. Spawn injects that channel's
    /// env onto the child and never rewrites the CLI's own files, so this row
    /// is what keeps two concurrent sessions of the same engine on different
    /// channels across restarts and other clients.
    pub fn remember_session_provider(
        &self,
        engine: &str,
        session_id: &str,
        provider_id: &str,
        now: i64,
    ) -> Result<(), String> {
        let conn = self.0.lock();
        conn.execute(
            "INSERT INTO session_providers(engine, session_id, provider_id, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(engine, session_id) DO UPDATE SET provider_id=excluded.provider_id, updated_at=excluded.updated_at",
            rusqlite::params![engine, session_id, provider_id, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Remember that this app handed a prompt (by digest) to Codex Desktop.
    pub fn remember_codex_desktop_prompt(
        &self,
        thread_id: &str,
        prompt_sha256: &str,
        now: i64,
    ) -> Result<(), String> {
        let conn = self.0.lock();
        conn.execute(
            "INSERT INTO codex_desktop_prompts(thread_id, prompt_sha256, handed_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(thread_id, prompt_sha256) DO UPDATE SET handed_at=excluded.handed_at",
            rusqlite::params![thread_id, prompt_sha256, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Digests of the prompts this app handed to Codex Desktop for a thread.
    pub fn codex_desktop_prompts(
        &self,
        thread_id: &str,
    ) -> Result<std::collections::HashSet<String>, String> {
        let conn = self.0.lock();
        let mut statement = conn
            .prepare("SELECT prompt_sha256 FROM codex_desktop_prompts WHERE thread_id=?1")
            .map_err(|e| e.to_string())?;
        let digests = statement
            .query_map([thread_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        Ok(digests)
    }

    /// Approve (or re-approve) a device. Unknown ids are ignored: the row is
    /// created by the device's own request, never by the UI.
    pub fn web_device_approve(&self, id: &str, now: i64) -> Result<bool, String> {
        let conn = self.0.lock();
        let changed = conn
            .execute(
                "UPDATE web_devices SET approved_at=?2,approval_generation=?3 WHERE id=?1",
                rusqlite::params![id, now, uuid::Uuid::new_v4().to_string()],
            )
            .map_err(|e| e.to_string())?;
        Ok(changed > 0)
    }

    /// Remember a name for a paired device. An empty name clears it, so the row
    /// falls back to the user-agent summary on its own.
    pub fn web_device_set_name(&self, id: &str, name: &str) -> Result<bool, String> {
        let conn = self.0.lock();
        let trimmed = name.trim();
        let changed = conn
            .execute(
                "UPDATE web_devices SET name=?2 WHERE id=?1",
                rusqlite::params![id, (!trimmed.is_empty()).then_some(trimmed)],
            )
            .map_err(|e| e.to_string())?;
        Ok(changed > 0)
    }

    /// Revoke a device; its cookie stops matching on the next request.
    pub fn web_device_revoke(&self, id: &str) -> Result<bool, String> {
        let conn = self.0.lock();
        let changed = conn
            .execute("DELETE FROM web_devices WHERE id=?1", rusqlite::params![id])
            .map_err(|e| e.to_string())?;
        Ok(changed > 0)
    }

    pub fn plugin_kv_get(
        &self,
        plugin_id: &str,
        key: &str,
    ) -> Result<Option<serde_json::Value>, String> {
        let conn = self.0.lock();
        let raw: Option<String> = conn
            .query_row(
                "SELECT value FROM plugin_kv WHERE plugin_id=?1 AND key=?2",
                rusqlite::params![plugin_id, key],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        match raw {
            None => Ok(None),
            Some(text) => serde_json::from_str(&text)
                .map(Some)
                .map_err(|e| format!("decode plugin_kv[{plugin_id}/{key}]: {e}")),
        }
    }

    pub fn plugin_kv_set(
        &self,
        plugin_id: &str,
        key: &str,
        value: &serde_json::Value,
    ) -> Result<(), String> {
        let text = serde_json::to_string(value).map_err(|e| e.to_string())?;
        let conn = self.0.lock();
        conn.execute(
            "INSERT INTO plugin_kv(plugin_id, key, value) VALUES(?1, ?2, ?3)
             ON CONFLICT(plugin_id, key) DO UPDATE SET value=excluded.value",
            rusqlite::params![plugin_id, key, text],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn plugin_kv_delete(&self, plugin_id: &str, key: &str) -> Result<(), String> {
        let conn = self.0.lock();
        conn.execute(
            "DELETE FROM plugin_kv WHERE plugin_id=?1 AND key=?2",
            rusqlite::params![plugin_id, key],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Whole-plugin wipe: uninstall with delete_data, and the tombstone purge
    /// after the 30-day retention window (plugins::KV_TOMBSTONE_TTL_SECS).
    pub fn plugin_kv_delete_all(&self, plugin_id: &str) -> Result<(), String> {
        let conn = self.0.lock();
        conn.execute(
            "DELETE FROM plugin_kv WHERE plugin_id=?1",
            rusqlite::params![plugin_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// One-time import of the legacy desktop-cc-gui workspace list
/// (`paths::legacy_workspaces_path`): old users open the upgrade and find
/// their sidebar intact. Rows already registered (same path) only adopt the
/// legacy order; new paths are inserted with their legacy id/name. Guarded
/// by a meta flag so a workspace removed in the new app is never
/// resurrected on the next launch.
pub fn import_legacy_workspaces_once(db: &Db) -> Result<(), String> {
    import_legacy_workspaces_from(db, &crate::paths::legacy_workspaces_path())
}

fn import_legacy_workspaces_from(db: &Db, path: &std::path::Path) -> Result<(), String> {
    let conn = db.0.lock();
    let done = conn
        .query_row(
            "SELECT value FROM meta WHERE key='legacy_workspaces_import_v1'",
            [],
            |r| r.get::<_, String>(0),
        )
        .ok();
    if done.is_some() {
        return Ok(());
    }

    if path.is_file() {
        let content =
            std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
        let legacy: Vec<serde_json::Value> =
            serde_json::from_str(&content).map_err(|e| format!("parse {}: {e}", path.display()))?;
        // Sidebar order: ungrouped workspaces first (file order), then each
        // group with its internal sortOrder. Worktree children (parentId)
        // import after their parents, once the parent's db id is known.
        let mut entries: Vec<(usize, &serde_json::Value)> = legacy
            .iter()
            .enumerate()
            .filter(|(_, w)| {
                w.get("parentId").and_then(|v| v.as_str()).is_none()
                    && w.get("path")
                        .and_then(|v| v.as_str())
                        .is_some_and(|p| !p.trim().is_empty())
            })
            .collect();
        entries.sort_by_key(|(i, w)| {
            let group = w
                .pointer("/settings/groupId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let sort = w
                .pointer("/settings/sortOrder")
                .and_then(|v| v.as_i64())
                .unwrap_or(i64::MAX);
            (u8::from(!group.is_empty()), group.to_string(), sort, *i)
        });

        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let mut index = 0i64;
        let mut imported_paths = std::collections::HashSet::new();
        for (_, w) in &entries {
            let path = w.get("path").and_then(|v| v.as_str()).unwrap_or("").trim();
            let name = w
                .get("name")
                .and_then(|v| v.as_str())
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| path.rsplit('/').next().unwrap_or(path));
            let id = w
                .get("id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            // Group assignment rides along with the row (legacy
            // `settings.groupId`); a conflict keeps any assignment the user
            // already made in the new app.
            let group_id = w
                .pointer("/settings/groupId")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty());
            tx.execute(
                "INSERT INTO workspaces(id, path, name, sort_order, group_id) VALUES(?1,?2,?3,?4,?5)
                 ON CONFLICT(path) DO UPDATE SET sort_order=excluded.sort_order,
                    group_id=COALESCE(workspaces.group_id, excluded.group_id)",
                rusqlite::params![id, path, name, index, group_id],
            )
            .map_err(|e| e.to_string())?;
            imported_paths.insert(path.to_string());
            index += 1;
        }

        // Worktree children (legacy kind:"worktree" + parentId). A child is
        // imported only when its parent made it into the db — resolved
        // parentId → parent's legacy row → path → db row (which may carry a
        // pre-existing new-app id after an ON CONFLICT keep) — and the
        // directory still exists on disk (stale worktree checkouts are
        // common; the parent rows above import unconditionally by design).
        {
            let mut id_stmt = tx
                .prepare("SELECT id, path FROM workspaces")
                .map_err(|e| e.to_string())?;
            let path_to_id: std::collections::HashMap<String, String> = id_stmt
                .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, String>(0)?)))
                .map_err(|e| e.to_string())?
                .flatten()
                .collect();
            drop(id_stmt);
            for w in &legacy {
                let Some(parent_legacy_id) = w.get("parentId").and_then(|v| v.as_str()) else {
                    continue;
                };
                let path = w.get("path").and_then(|v| v.as_str()).unwrap_or("").trim();
                if path.is_empty() {
                    continue;
                }
                let parent_path = legacy
                    .iter()
                    .find(|p| p.get("id").and_then(|v| v.as_str()) == Some(parent_legacy_id))
                    .and_then(|p| p.get("path").and_then(|v| v.as_str()))
                    .map(str::trim);
                let Some(parent_db_id) = parent_path.and_then(|p| path_to_id.get(p)) else {
                    eprintln!(
                        "[db] legacy import: worktree child {path} skipped (parent {parent_legacy_id} not imported)"
                    );
                    continue;
                };
                if !std::path::Path::new(path).is_dir() {
                    eprintln!(
                        "[db] legacy import: worktree child {path} skipped (directory gone)"
                    );
                    continue;
                }
                let name = w
                    .get("name")
                    .and_then(|v| v.as_str())
                    .filter(|n| !n.trim().is_empty())
                    .unwrap_or_else(|| path.rsplit('/').next().unwrap_or(path));
                let id = w
                    .get("id")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                tx.execute(
                    "INSERT INTO workspaces(id, path, name, sort_order, kind, parent_id)
                     VALUES(?1,?2,?3,?4,'worktree',?5)
                     ON CONFLICT(path) DO UPDATE SET
                        kind=COALESCE(workspaces.kind, excluded.kind),
                        parent_id=COALESCE(workspaces.parent_id, excluded.parent_id)",
                    rusqlite::params![id, path, name, index, parent_db_id],
                )
                .map_err(|e| e.to_string())?;
                imported_paths.insert(path.to_string());
                index += 1;
            }
        }
        // Rows the legacy list doesn't know (added in the new app before the
        // upgrade) keep their relative order, appended after the import.
        let mut stmt = tx
            .prepare(
                "SELECT id, path FROM workspaces
                 ORDER BY sort_order IS NULL, sort_order, COALESCE(last_opened_at, 0) DESC",
            )
            .map_err(|e| e.to_string())?;
        let remaining: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?
            .flatten()
            .collect();
        drop(stmt);
        for (id, row_path) in remaining {
            if imported_paths.contains(&row_path) {
                continue;
            }
            tx.execute(
                "UPDATE workspaces SET sort_order=?2 WHERE id=?1",
                rusqlite::params![id, index],
            )
            .map_err(|e| e.to_string())?;
            index += 1;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    // Flag set even without a legacy file (fresh machine): never re-probe.
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES('legacy_workspaces_import_v1', '1')",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS workspaces(
            id TEXT PRIMARY KEY,
            path TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            last_opened_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS sessions(
            engine TEXT NOT NULL,
            session_id TEXT NOT NULL,
            workspace_path TEXT NOT NULL,
            file_path TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            file_mtime_ms INTEGER NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            preview TEXT NOT NULL DEFAULT '',
            created_at INTEGER,
            updated_at INTEGER,
            message_count INTEGER NOT NULL DEFAULT 0,
            pinned INTEGER NOT NULL DEFAULT 0,
            custom_title TEXT,
            PRIMARY KEY(engine, session_id)
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_path);
        -- App-owned archive markers. CLI transcripts remain untouched; the
        -- independent marker survives scanner upserts and workspace re-adds.
        -- The snapshot also covers plugin-fed remote sessions, which have no
        -- local row in `sessions`.
        CREATE TABLE IF NOT EXISTS session_archives(
            engine TEXT NOT NULL,
            session_id TEXT NOT NULL,
            workspace_path TEXT NOT NULL,
            snapshot_json TEXT NOT NULL,
            archived_at INTEGER NOT NULL,
            PRIMARY KEY(engine, session_id)
        );
        CREATE INDEX IF NOT EXISTS idx_session_archives_workspace
            ON session_archives(workspace_path);
        CREATE TABLE IF NOT EXISTS meta(
            key TEXT PRIMARY KEY,
            value TEXT
        );
        CREATE TABLE IF NOT EXISTS granted_roots(
            path TEXT PRIMARY KEY,
            granted_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS web_devices(
            id TEXT PRIMARY KEY,
            user_agent TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            approved_at INTEGER,
            name TEXT
        );
        -- Independent host observations; never backfilled from usage/history.
        CREATE TABLE IF NOT EXISTS throughput_stats_meta(
            id INTEGER PRIMARY KEY CHECK(id=1),
            started_at INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO throughput_stats_meta(id, started_at)
            VALUES(1, CAST(strftime('%s','now') AS INTEGER) * 1000);
        CREATE TABLE IF NOT EXISTS throughput_turns(
            run_id TEXT NOT NULL,
            terminal_seq INTEGER NOT NULL,
            source_run_id TEXT NOT NULL,
            engine TEXT NOT NULL,
            session_id TEXT,
            completed INTEGER NOT NULL CHECK(completed IN (0,1)),
            output_tokens INTEGER NOT NULL DEFAULT 0,
            elapsed_ms REAL NOT NULL DEFAULT 0,
            PRIMARY KEY(run_id, terminal_seq)
        );
        CREATE INDEX IF NOT EXISTS idx_throughput_session ON throughput_turns(engine, session_id);
        CREATE INDEX IF NOT EXISTS idx_throughput_source ON throughput_turns(engine, source_run_id);

        CREATE TABLE IF NOT EXISTS usage_ledger(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            engine TEXT NOT NULL,
            model TEXT NOT NULL DEFAULT '',
            session_id TEXT,
            workspace_path TEXT,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read INTEGER NOT NULL DEFAULT 0,
            cache_write INTEGER NOT NULL DEFAULT 0,
            duration_ms INTEGER,
            reports INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX IF NOT EXISTS idx_usage_ledger_ts ON usage_ledger(ts);
        CREATE TABLE IF NOT EXISTS plugin_kv(
            plugin_id TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY(plugin_id, key)
        );
        CREATE TABLE IF NOT EXISTS session_models(
            engine TEXT NOT NULL,
            session_id TEXT NOT NULL,
            model TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(engine, session_id)
        );
        -- Reasoning effort the session last ran, same shape and same reason as
        -- the model row above: the transcript is not a reliable carrier, and a
        -- session reopened here must keep running the level it used.
        CREATE TABLE IF NOT EXISTS session_efforts(
            engine TEXT NOT NULL,
            session_id TEXT NOT NULL,
            effort TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(engine, session_id)
        );
        CREATE TABLE IF NOT EXISTS session_claude_options(
            session_id TEXT PRIMARY KEY NOT NULL,
            ultracode INTEGER NOT NULL CHECK(ultracode IN (0, 1)),
            updated_at INTEGER NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS delete_session_claude_options
        AFTER DELETE ON sessions WHEN OLD.engine = 'claude'
        BEGIN
            DELETE FROM session_claude_options WHERE session_id = OLD.session_id;
        END;
        -- Channel the session last ran. Spawn injects env from this id; the
        -- CLI's own files stay official so concurrent sessions can differ.
        CREATE TABLE IF NOT EXISTS session_providers(
            engine TEXT NOT NULL,
            session_id TEXT NOT NULL,
            provider_id TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(engine, session_id)
        );
        -- Model-written session title (auto_title). Apart from `sessions` so
        -- scanner upserts never touch it; listings show custom_title, then
        -- this title, then the scanner's first-message title. title is NULL
        -- while the namer has only ever kept the existing title. The basis
        -- columns record what the last evaluation saw, so an unchanged
        -- conversation is never sent to the model twice.
        CREATE TABLE IF NOT EXISTS session_auto_titles(
            engine TEXT NOT NULL,
            session_id TEXT NOT NULL,
            title TEXT,
            fingerprint TEXT NOT NULL,
            user_turns INTEGER NOT NULL,
            ack_skips INTEGER NOT NULL DEFAULT 0,
            policy_version INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(engine, session_id),
            FOREIGN KEY(engine, session_id)
                REFERENCES sessions(engine, session_id) ON DELETE CASCADE
        );
        -- Prompts this app handed to Codex Desktop for a thread it holds
        -- (engine::codex_desktop), as SHA-256 only. Desktop records them as a
        -- tool output, as it does other tools' deliveries; only these read
        -- back as the user's own rows.
        CREATE TABLE IF NOT EXISTS codex_desktop_prompts(
            thread_id TEXT NOT NULL,
            prompt_sha256 TEXT NOT NULL,
            handed_at INTEGER NOT NULL,
            PRIMARY KEY(thread_id, prompt_sha256)
        );
        -- Message bodies for full-text search. The transcript files stay
        -- the source of truth; this table is a derived index rebuilt by
        -- history::search::index_pending whenever a file's stat moves.
        CREATE TABLE IF NOT EXISTS session_messages(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            engine TEXT NOT NULL,
            session_id TEXT NOT NULL,
            seq INTEGER NOT NULL,
            role TEXT NOT NULL,
            text TEXT NOT NULL,
            ts_ms INTEGER,
            UNIQUE(engine, session_id, seq),
            FOREIGN KEY(engine, session_id)
                REFERENCES sessions(engine, session_id) ON DELETE CASCADE
        );
        -- External-content FTS5: text lives once in session_messages, the
        -- FTS table is index-only and the triggers sync both in the same
        -- transaction. trigram because unicode61 (agentsview's choice) has
        -- no CJK substring capability: a run of Chinese is one token there,
        -- while trigram gives substring match for Chinese and English alike.
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            text,
            content='session_messages',
            content_rowid='id',
            tokenize='trigram'
        );
        CREATE TRIGGER IF NOT EXISTS session_messages_ai AFTER INSERT ON session_messages BEGIN
            INSERT INTO messages_fts(rowid, text) VALUES(new.id, new.text);
        END;
        CREATE TRIGGER IF NOT EXISTS session_messages_ad AFTER DELETE ON session_messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.id, old.text);
        END;
        CREATE TRIGGER IF NOT EXISTS session_messages_au AFTER UPDATE ON session_messages BEGIN
            INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.id, old.text);
            INSERT INTO messages_fts(rowid, text) VALUES(new.id, new.text);
        END;
        -- Per-session index stamp: a session re-parses only when its file
        -- stat or the index derivation version moved. Cascade-kept with the
        -- sessions row like session_messages.
        CREATE TABLE IF NOT EXISTS fts_state(
            engine TEXT NOT NULL,
            session_id TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            file_mtime_ms INTEGER NOT NULL,
            version TEXT NOT NULL,
            indexed_at INTEGER NOT NULL,
            PRIMARY KEY(engine, session_id),
            FOREIGN KEY(engine, session_id)
                REFERENCES sessions(engine, session_id) ON DELETE CASCADE
        );
        -- 计划预览与人工审批的审批事实源(engine/plan_review.rs)。独立于
        -- session_messages 搜索索引,不声明 FK:sessions 行由扫描器从
        -- transcript 建立,可能晚于计划记录到达,删除由 sessions 的清理
        -- 路径显式级联(delete_reviews_for_session/_workspace)。
        CREATE TABLE IF NOT EXISTS plan_reviews(
            plan_id TEXT NOT NULL,
            engine TEXT NOT NULL,
            session_id TEXT NOT NULL,
            workspace_path TEXT NOT NULL,
            run_id TEXT,
            revision INTEGER NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            content TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            complete INTEGER NOT NULL DEFAULT 0,
            review_kind TEXT NOT NULL,
            native_plan_id TEXT,
            exec_permission TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL,
            execution TEXT NOT NULL DEFAULT 'not_started',
            decision TEXT,
            decision_intent_at INTEGER,
            applied_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            superseded_by INTEGER,
            PRIMARY KEY(plan_id, revision)
        );
        CREATE INDEX IF NOT EXISTS idx_plan_reviews_session
            ON plan_reviews(engine, session_id);
        ",
    )?;
    session_auxiliary::migrate_legacy(conn)?;
    crate::image_preview::migrate_legacy(conn)?;
    crate::workspace_projects::migrate_legacy(conn)?;
    // NB: no `cache_version` meta row — it was written but never read; cache
    // freshness is carried by the scanner's stat signature (see CACHE_VERSION).
    // Additive migration: usage rows gained a per-turn request count.
    let has_reports = conn
        .prepare("PRAGMA table_info(usage_ledger)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .filter_map(Result::ok)
        .any(|name| name == "reports");
    if !has_reports {
        conn.execute(
            "ALTER TABLE usage_ledger ADD COLUMN reports INTEGER NOT NULL DEFAULT 1",
            [],
        )?;
    }
    // Additive migration: a name the user gave a paired device, shown instead
    // of the user-agent summary.
    let has_device_name = conn
        .prepare("PRAGMA table_info(web_devices)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .flatten()
        .any(|name| name == "name");
    if !has_device_name {
        conn.execute("ALTER TABLE web_devices ADD COLUMN name TEXT", [])?;
    }
    let has_device_generation = conn.prepare("PRAGMA table_info(web_devices)")?
        .query_map([], |row| row.get::<_, String>(1))?.flatten().any(|name| name == "approval_generation");
    if !has_device_generation {
        conn.execute("ALTER TABLE web_devices ADD COLUMN approval_generation TEXT NOT NULL DEFAULT ''", [])?;
        // Keep existing approvals, adding a public nonce to invalidate stale sockets
        // even when revoke/reapprove timestamps happen to fall in one millisecond.
        conn.execute("UPDATE web_devices SET approval_generation=lower(hex(randomblob(16))) WHERE approved_at IS NOT NULL", [])?;
    }

    // Additive migration: user-defined workspace order (drag reorder).
    let has_sort_order = conn
        .prepare("PRAGMA table_info(workspaces)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .flatten()
        .any(|name| name == "sort_order");
    if !has_sort_order {
        conn.execute("ALTER TABLE workspaces ADD COLUMN sort_order INTEGER", [])?;
    }

    // Additive migration: sidebar group assignment (工作区分组), matching the
    // legacy app's per-workspace `settings.groupId` in workspaces.json.
    let has_group_id = conn
        .prepare("PRAGMA table_info(workspaces)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .flatten()
        .any(|name| name == "group_id");
    if !has_group_id {
        conn.execute("ALTER TABLE workspaces ADD COLUMN group_id TEXT", [])?;
    }

    // Additive migration: opaque per-workspace metadata from host-capability
    // callers (plugin `workspaces.add`, e.g. { wsl: { hostId, distro } } for
    // remote distro paths that do not exist on this machine).
    let has_meta = conn
        .prepare("PRAGMA table_info(workspaces)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .flatten()
        .any(|name| name == "meta");
    if !has_meta {
        conn.execute("ALTER TABLE workspaces ADD COLUMN meta TEXT", [])?;
    }

    // Additive migration: git worktree children hang under their parent
    // workspace row in the sidebar (kind="worktree"). Matches the legacy
    // app's per-workspace `kind` in workspaces.json.
    let has_kind = conn
        .prepare("PRAGMA table_info(workspaces)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .flatten()
        .any(|name| name == "kind");
    if !has_kind {
        conn.execute("ALTER TABLE workspaces ADD COLUMN kind TEXT", [])?;
    }

    // Additive migration: worktree child's parent workspace row
    // (parent_id → workspaces.id; only set when kind="worktree").
    let has_parent_id = conn
        .prepare("PRAGMA table_info(workspaces)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .flatten()
        .any(|name| name == "parent_id");
    if !has_parent_id {
        conn.execute("ALTER TABLE workspaces ADD COLUMN parent_id TEXT", [])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {

    #[test]
    fn auxiliary_kind_storage_keeps_v1_schema() {
        let db = Db::open_in_memory().unwrap();
        let conn = db.0.lock();
        conn.execute("INSERT INTO sessions(engine,session_id,workspace_path,file_path,file_size,file_mtime_ms,title,pinned,custom_title) VALUES('cursor','old','/ws','/old.jsonl',1,2,'old title',1,'用户标题')", []).unwrap();
        session_auxiliary::set(&conn, "cursor", "old", Some("cursor_do")).unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        let row: (String, i64, String) = conn.query_row("SELECT title,pinned,custom_title FROM sessions", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert_eq!(row, ("old title".into(), 1, "用户标题".into()));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name='auxiliary_kind'", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        drop(conn);
        assert_eq!(db.plugin_kv_get(session_auxiliary::NAMESPACE, "cursor:old").unwrap(), Some(serde_json::json!("cursor_do")));
    }

    #[test]
    fn auxiliary_kind_legacy_column_migrates_once_without_overwriting_kv() {
        let db = Db::open_in_memory().unwrap();
        let conn = db.0.lock();
        conn.execute("ALTER TABLE sessions ADD COLUMN auxiliary_kind TEXT", []).unwrap();
        for id in ["old", "newer"] {
            conn.execute("INSERT INTO sessions(engine,session_id,workspace_path,file_path,file_size,file_mtime_ms,title,pinned,custom_title,auxiliary_kind) VALUES('cursor',?1,'/ws',?1,1,2,'old title',1,'用户标题','cursor_do')", [id]).unwrap();
        }
        session_auxiliary::set(&conn, "cursor", "newer", Some("cursor_cce")).unwrap();
        migrate(&conn).unwrap();
        drop(conn);
        assert_eq!(db.plugin_kv_get(session_auxiliary::NAMESPACE, "cursor:old").unwrap(), Some(serde_json::json!("cursor_do")));
        assert_eq!(db.plugin_kv_get(session_auxiliary::NAMESPACE, "cursor:newer").unwrap(), Some(serde_json::json!("cursor_cce")));
        let conn = db.0.lock();
        session_auxiliary::set(&conn, "cursor", "old", None).unwrap();
        migrate(&conn).unwrap();
        let old: (String, String, i64, String) = conn.query_row("SELECT auxiliary_kind,title,pinned,custom_title FROM sessions WHERE session_id='old'", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
        assert_eq!(old, ("cursor_do".into(), "old title".into(), 1, "用户标题".into()));
        drop(conn);
        assert_eq!(db.plugin_kv_get(session_auxiliary::NAMESPACE, "cursor:old").unwrap(), None, "cleared metadata must not resurrect from the retained legacy column");
    }
    use super::*;

    #[test]
    fn claude_ultracode_round_trips_false_and_true_without_leaking_to_other_engines() {
        let scratch = Scratch::new();
        let db = Db::open_at(&scratch.path("app.db")).unwrap();
        for engine in ["claude", "codex"] {
            db.0.lock().execute(
                "INSERT INTO sessions(engine, session_id, workspace_path, file_path, file_size, file_mtime_ms)
                 VALUES(?1, 'shared-id', '/ws', 'f.jsonl', 1, 1)", [engine],
            ).unwrap();
        }
        let read = |engine: &str| -> Option<bool> {
            db.0.lock().query_row(
                "SELECT c.ultracode FROM sessions s LEFT JOIN session_claude_options c
                 ON s.engine='claude' AND c.session_id=s.session_id WHERE s.engine=?1",
                [engine], |r| r.get(0),
            ).unwrap()
        };
        assert_eq!(read("claude"), None);
        for (enabled, now) in [(false, 10), (true, 20), (false, 30)] {
            db.remember_claude_ultracode("shared-id", enabled, now).unwrap();
            assert_eq!(read("claude"), Some(enabled));
            assert_eq!(read("codex"), None);
            assert_eq!(db.0.lock().query_row(
                "SELECT updated_at FROM session_claude_options", [], |r| r.get::<_, i64>(0),
            ).unwrap(), now);
        }
        // Scanner/workspace cleanup may delete indexed rows directly.
        db.0.lock().execute("DELETE FROM sessions WHERE engine='codex'", []).unwrap();
        assert_eq!(read("claude"), Some(false));
        db.0.lock().execute("DELETE FROM sessions WHERE engine='claude'", []).unwrap();
        assert_eq!(db.0.lock().query_row(
            "SELECT COUNT(*) FROM session_claude_options", [], |r| r.get::<_, i64>(0),
        ).unwrap(), 0);
    }

    #[test]
    fn claude_ultracode_schema_is_additive_for_existing_databases() {
        let scratch = Scratch::new();
        let path = scratch.path("app.db");
        let db = Db::open_at(&path).unwrap();
        db.0.lock().execute("DROP TRIGGER delete_session_claude_options", []).unwrap();
        db.0.lock().execute("DROP TABLE session_claude_options", []).unwrap();
        drop(db);
        let db = Db::open_at(&path).unwrap();
        db.remember_claude_ultracode("legacy", false, 1).unwrap();
        assert_eq!(db.0.lock().query_row(
            "SELECT ultracode FROM session_claude_options WHERE session_id='legacy'", [],
            |r| r.get::<_, bool>(0),
        ).unwrap(), false);
    }

    struct Scratch(std::path::PathBuf);
    impl Scratch {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("ccgui-next-db-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn path(&self, name: &str) -> std::path::PathBuf {
            self.0.join(name)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn session_effort_record_round_trips_and_takes_the_newest() {
        let scratch = Scratch::new();
        let db = Db::open_at(&scratch.path("app.db")).unwrap();
        db.0.lock()
            .execute(
                "INSERT INTO sessions(engine, session_id, workspace_path, file_path, file_size, file_mtime_ms, title)
                 VALUES('omp', 's1', '/ws', 'f.jsonl', 1, 1, 'first message')",
                [],
            )
            .unwrap();
        // The join list_sessions runs: a session with no record has no effort.
        let read = || -> Option<String> {
            let conn = db.0.lock();
            conn.query_row(
                "SELECT e.effort FROM sessions s
                 LEFT JOIN session_efforts e ON e.engine = s.engine AND e.session_id = s.session_id
                 WHERE s.engine='omp' AND s.session_id='s1'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(read(), None, "no record yet");

        db.remember_session_effort("omp", "s1", "xhigh", 10)
            .unwrap();
        assert_eq!(read().as_deref(), Some("xhigh"), "the level survives");

        db.remember_session_effort("omp", "s1", "low", 20).unwrap();
        assert_eq!(read().as_deref(), Some("low"), "newest wins");
    }

    #[test]
    fn session_provider_record_round_trips_and_takes_the_newest() {
        let scratch = Scratch::new();
        let db = Db::open_at(&scratch.path("app.db")).unwrap();
        db.0.lock()
            .execute(
                "INSERT INTO sessions(engine, session_id, workspace_path, file_path, file_size, file_mtime_ms, title)
                 VALUES('claude', 's1', '/ws', 'f.jsonl', 1, 1, 'first message')",
                [],
            )
            .unwrap();
        let read = || -> Option<String> {
            let conn = db.0.lock();
            conn.query_row(
                "SELECT p.provider_id FROM sessions s
                 LEFT JOIN session_providers p ON p.engine = s.engine AND p.session_id = s.session_id
                 WHERE s.engine='claude' AND s.session_id='s1'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(read(), None, "no record yet");

        db.remember_session_provider("claude", "s1", "chan-a", 10)
            .unwrap();
        assert_eq!(read().as_deref(), Some("chan-a"), "the channel survives");

        db.remember_session_provider("claude", "s1", "__local_settings_json__", 20)
            .unwrap();
        assert_eq!(
            read().as_deref(),
            Some("__local_settings_json__"),
            "newest wins"
        );
    }

    #[test]
    fn session_model_record_round_trips_and_takes_the_newest() {
        let scratch = Scratch::new();
        let db = Db::open_at(&scratch.path("app.db")).unwrap();
        db.0.lock()
            .execute(
                "INSERT INTO sessions(engine, session_id, workspace_path, file_path, file_size, file_mtime_ms, title)
                 VALUES('omp', 's1', '/ws', 'f.jsonl', 1, 1, 'first message')",
                [],
            )
            .unwrap();
        // The join list_sessions runs: a session with no record has no model.
        let read = || -> Option<String> {
            let conn = db.0.lock();
            conn.query_row(
                "SELECT m.model FROM sessions s
                 LEFT JOIN session_models m ON m.engine = s.engine AND m.session_id = s.session_id
                 WHERE s.engine='omp' AND s.session_id='s1'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(read(), None, "no record yet");

        db.remember_session_model("omp", "s1", "agentrouter qunyou/deepseek-v4-flash", 10)
            .unwrap();
        assert_eq!(
            read().as_deref(),
            Some("agentrouter qunyou/deepseek-v4-flash"),
            "the provider-qualified id is what survives"
        );

        db.remember_session_model("omp", "s1", "薄荷/claude-opus-5", 20)
            .unwrap();
        assert_eq!(read().as_deref(), Some("薄荷/claude-opus-5"), "newest wins");
    }

    #[test]
    fn web_device_needs_approval_before_the_gate_lets_it_through() {
        let scratch = Scratch::new();
        let db = Db::open_at(&scratch.path("app.db")).unwrap();

        db.web_device_touch("d1", "iPhone Safari", 1_000).unwrap();
        let pending = db.web_device_get("d1").unwrap().unwrap();
        assert!(pending.approved_at.is_none(), "a fresh device is pending");
        assert_eq!(pending.user_agent, "iPhone Safari");

        assert!(db.web_device_approve("d1", 2_000).unwrap());
        let approved = db.web_device_get("d1").unwrap().unwrap();
        assert_eq!(approved.approved_at, Some(2_000));
        assert_eq!(
            approved.created_at, 1_000,
            "approval keeps the first-seen time"
        );

        assert!(db.web_device_revoke("d1").unwrap());
        assert!(
            db.web_device_get("d1").unwrap().is_none(),
            "revoked = forgotten"
        );
    }

    #[test]
    fn web_device_touch_keeps_approval_and_lists_approved_first() {
        let scratch = Scratch::new();
        let db = Db::open_at(&scratch.path("app.db")).unwrap();

        db.web_device_touch("old", "ua", 1).unwrap();
        db.web_device_approve("old", 2).unwrap();
        db.web_device_touch("new", "ua", 3).unwrap();

        // Polling again must not lose the approval, blank the UA, or reset
        // first-seen — the waiting page reloads every 2.5s.
        db.web_device_touch("old", "", 4).unwrap();
        let old = db.web_device_get("old").unwrap().unwrap();
        assert_eq!(old.approved_at, Some(2));
        assert_eq!(old.user_agent, "ua");
        assert_eq!(old.last_seen_at, 4);

        let listed = db.web_devices().unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, "old", "approved devices list first");
        assert_eq!(listed[1].id, "new");
    }

    fn list(db: &Db) -> Vec<(String, String, Option<i64>)> {
        let conn = db.0.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, path, sort_order FROM workspaces
                 ORDER BY sort_order IS NULL, sort_order",
            )
            .unwrap();
        stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<i64>>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
    }

    #[test]
    fn legacy_import_merges_order_and_runs_once() {
        let scratch = Scratch::new();
        let db = Db::open_at(&scratch.path("app.db")).unwrap();
        // Pre-existing registrations: one path shared with the legacy list
        // (keeps its new-app id), one the legacy list doesn't know.
        {
            let conn = db.0.lock();
            conn.execute(
                "INSERT INTO workspaces(id, path, name, last_opened_at, sort_order)
                 VALUES('new-id-shared', '/ws/shared', 'shared-new-name', 100, 0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO workspaces(id, path, name, last_opened_at, sort_order)
                 VALUES('new-id-extra', '/ws/extra', 'extra', 200, 1)",
                [],
            )
            .unwrap();
        }
        // Worktree children need real directories to survive the staleness
        // check: one valid, one orphaned (parent never imports).
        let child_dir = scratch.path("wt-child");
        let orphan_dir = scratch.path("wt-orphan");
        std::fs::create_dir_all(&child_dir).unwrap();
        std::fs::create_dir_all(&orphan_dir).unwrap();
        // Backslashes in a Windows path are invalid JSON escapes; serialize
        // the paths the way the legacy settings writer did so the fixture
        // parses on every platform.
        let json_path = |p: &std::path::Path| {
            serde_json::to_string(&p.display().to_string()).expect("json string")
        };
        let legacy = format!(
            r#"[
            {{"id":"legacy-grouped","name":"grouped-ws","path":"/ws/shared","kind":"main",
             "parentId":null,"settings":{{"sortOrder":2,"groupId":"g1"}}}},
            {{"id":"legacy-ungrouped","name":"ungrouped-ws","path":"/ws/ungrouped","kind":"main",
             "parentId":null,"settings":{{"sortOrder":null,"groupId":null}}}},
            {{"id":"legacy-child","name":"worktree-child","path":{child},"kind":"worktree",
             "parentId":"legacy-grouped","settings":{{"sortOrder":null,"groupId":null}}}},
            {{"id":"legacy-stale","name":"stale-child","path":"/ws/gone","kind":"worktree",
             "parentId":"legacy-grouped","settings":{{"sortOrder":null,"groupId":null}}}},
            {{"id":"legacy-orphan","name":"orphan-child","path":{orphan},"kind":"worktree",
             "parentId":"missing-parent","settings":{{"sortOrder":null,"groupId":null}}}}
        ]"#,
            child = json_path(&child_dir),
            orphan = json_path(&orphan_dir),
        );
        let legacy_path = scratch.path("workspaces.json");
        std::fs::write(&legacy_path, legacy).unwrap();

        import_legacy_workspaces_from(&db, &legacy_path).unwrap();
        let rows = list(&db);
        // Ungrouped first, then grouped, then the imported worktree child,
        // then new-app-only rows. Stale (dir gone) and orphan (parent
        // missing) children are skipped.
        assert_eq!(
            rows,
            vec![
                (
                    "legacy-ungrouped".to_string(),
                    "/ws/ungrouped".to_string(),
                    Some(0)
                ),
                (
                    "new-id-shared".to_string(),
                    "/ws/shared".to_string(),
                    Some(1)
                ),
                (
                    "legacy-child".to_string(),
                    child_dir.display().to_string(),
                    Some(2)
                ),
                ("new-id-extra".to_string(), "/ws/extra".to_string(), Some(3)),
            ]
        );
        // The child hangs under the parent's *db* id — the parent's legacy id
        // lost the ON CONFLICT keep to the pre-existing new-app row.
        {
            let conn = db.0.lock();
            let (kind, parent_id): (Option<String>, Option<String>) = conn
                .query_row(
                    "SELECT kind, parent_id FROM workspaces WHERE id='legacy-child'",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            assert_eq!(kind.as_deref(), Some("worktree"));
            assert_eq!(parent_id.as_deref(), Some("new-id-shared"));
        }

        // Second run is a no-op: a removal in the new app is not resurrected.
        {
            let conn = db.0.lock();
            conn.execute("DELETE FROM workspaces WHERE id='legacy-ungrouped'", [])
                .unwrap();
        }
        import_legacy_workspaces_from(&db, &legacy_path).unwrap();
        assert_eq!(list(&db).len(), 3);
    }

    #[test]
    fn legacy_import_without_legacy_file_only_sets_flag() {
        let scratch = Scratch::new();
        let db = Db::open_at(&scratch.path("app.db")).unwrap();
        import_legacy_workspaces_from(&db, &scratch.path("missing.json")).unwrap();
        assert!(list(&db).is_empty());
        let conn = db.0.lock();
        let flag: String = conn
            .query_row(
                "SELECT value FROM meta WHERE key='legacy_workspaces_import_v1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(flag, "1");
    }
    #[test]
    fn plugin_kv_roundtrip_and_wipe() {
        let scratch = Scratch::new();
        let db = Db::open_at(&scratch.path("app.db")).unwrap();
        assert_eq!(db.plugin_kv_get("p1", "k").unwrap(), None);

        db.plugin_kv_set("p1", "k", &serde_json::json!({"n": 1}))
            .unwrap();
        db.plugin_kv_set("p1", "other", &serde_json::json!("s"))
            .unwrap();
        db.plugin_kv_set("p2", "k", &serde_json::json!(true))
            .unwrap();
        // Same key under another plugin is an independent row; overwrite wins.
        db.plugin_kv_set("p1", "k", &serde_json::json!({"n": 2}))
            .unwrap();
        assert_eq!(
            db.plugin_kv_get("p1", "k").unwrap(),
            Some(serde_json::json!({"n": 2}))
        );
        assert_eq!(
            db.plugin_kv_get("p2", "k").unwrap(),
            Some(serde_json::json!(true))
        );

        db.plugin_kv_delete("p1", "other").unwrap();
        assert_eq!(db.plugin_kv_get("p1", "other").unwrap(), None);

        db.plugin_kv_delete_all("p1").unwrap();
        assert_eq!(db.plugin_kv_get("p1", "k").unwrap(), None);
        assert_eq!(
            db.plugin_kv_get("p2", "k").unwrap(),
            Some(serde_json::json!(true))
        );
    }
}
