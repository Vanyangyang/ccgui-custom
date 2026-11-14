//! Host-observed reply throughput. Never reconstruct timing from history/usage.
//!
//! Extended per-turn metadata (`model`, `reason`, `status`, `breakdown`, `ts`)
//! and the one-time historical plausibility cleanup marker live in `plugin_kv`
//! under system `$ccgui-*` namespaces so `app.db`'s DDL contract hash remains
//! untouched.
use crate::db::Db;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MIN_MODEL_WINDOW_MS: f64 = 1000.0;
const MAX_PLAUSIBLE_TPS: f64 = 1000.0;

const TURNS_NAMESPACE: &str = "$ccgui-throughput-turns";
const META_NAMESPACE: &str = "$ccgui-throughput-meta";
const MIGRATION_KEY: &str = "migration-v2";

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub output_tokens: u64,
    pub elapsed_ms: f64,
    pub completed_turns: u64,
    pub excluded_turns: u64,
    pub interrupted_turns: u64,
    pub missing_turns: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub median_tps: Option<f64>,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThroughputStats {
    pub global: Totals,
    pub session: Totals,
    pub by_engine: BTreeMap<String, Totals>,
    pub by_model: BTreeMap<String, Totals>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
}

fn is_supported_source(engine: &str, source: Option<&str>) -> bool {
    matches!(
        (engine, source),
        ("claude", Some("claude"))
            | ("codex", Some("codex_app_server"))
            | ("agy", Some("agy"))
            | ("cursor", Some("cursor"))
    )
}

fn gate_reason(tokens: Option<u64>, elapsed: Option<f64>) -> Option<&'static str> {
    let Some(t) = tokens else {
        return Some("missing_usage");
    };
    let Some(ms) = elapsed.filter(|n| n.is_finite() && *n > 0.0) else {
        return Some("missing_timing");
    };
    if t == 0 {
        return Some("missing_usage");
    }
    if ms < MIN_MODEL_WINDOW_MS {
        return Some("insufficient_timing");
    }
    let tps = (t as f64) * 1000.0 / ms;
    if !tps.is_finite() || tps > MAX_PLAUSIBLE_TPS {
        return Some("implausible");
    }
    None
}

fn turn_kv_key(run_id: &str, terminal_seq: u64) -> String {
    format!("{run_id}:{terminal_seq}")
}

/// Idempotent one-time historical cleanup (`migration-v2`): marks existing
/// `completed = 1` rows that violate the unified active-time plausibility gate
/// (`output_tokens <= 0`, `elapsed_ms < 1000ms`, or `rate > 1000 tok/s`, such
/// as legacy Codex `thread/fork` cumulative-token spikes) as excluded
/// (`completed = 0`, `output_tokens = 0`, `elapsed_ms = 0.0`) and records their
/// exclusion reason in `$ccgui-throughput-turns`.
fn ensure_migrated(conn: &Connection) -> rusqlite::Result<()> {
    let done: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM plugin_kv WHERE plugin_id=?1 AND key=?2",
            params![META_NAMESPACE, MIGRATION_KEY],
            |row| row.get(0),
        )
        .optional()?;
    if done.is_some() {
        return Ok(());
    }

    let mut dirty: Vec<(String, i64, i64, f64, &'static str)> = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT run_id, terminal_seq, output_tokens, elapsed_ms
             FROM throughput_turns
             WHERE completed = 1",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, f64>(3)?,
            ))
        })?;
        for item in rows {
            let (run_id, seq, tokens, elapsed) = item?;
            let tok_u64 = u64::try_from(tokens).ok().filter(|n| *n <= MAX_SAFE_INTEGER);
            let ms_opt = (elapsed.is_finite() && elapsed > 0.0).then_some(elapsed);
            if let Some(reason) = gate_reason(tok_u64, ms_opt) {
                dirty.push((run_id, seq, tokens, elapsed, reason));
            }
        }
    }

    let mut cleaned = 0_u64;
    for (run_id, seq, tokens, elapsed, reason) in dirty {
        conn.execute(
            "UPDATE throughput_turns
             SET completed = 0, output_tokens = 0, elapsed_ms = 0.0
             WHERE run_id = ?1 AND terminal_seq = ?2",
            params![run_id, seq],
        )?;
        let kv_key = format!("{run_id}:{seq}");
        let existing: Option<String> = conn
            .query_row(
                "SELECT value FROM plugin_kv WHERE plugin_id=?1 AND key=?2",
                params![TURNS_NAMESPACE, kv_key],
                |row| row.get(0),
            )
            .optional()?;
        let mut obj = existing
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default();
        obj.entry("status".to_string())
            .or_insert_with(|| Value::String("complete".to_string()));
        obj.insert("reason".to_string(), Value::String(reason.to_string()));
        obj.insert(
            "migratedFrom".to_string(),
            json!({ "outputTokens": tokens, "elapsedMs": elapsed }),
        );
        conn.execute(
            "INSERT INTO plugin_kv(plugin_id, key, value) VALUES (?1, ?2, ?3)
             ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value",
            params![TURNS_NAMESPACE, kv_key, Value::Object(obj).to_string()],
        )?;
        cleaned += 1;
    }

    let marker = json!({
        "version": 2,
        "cleanedRows": cleaned,
    });
    conn.execute(
        "INSERT INTO plugin_kv(plugin_id, key, value) VALUES (?1, ?2, ?3)
         ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value",
        params![META_NAMESPACE, MIGRATION_KEY, marker.to_string()],
    )?;
    Ok(())
}

/// One native terminal sample, keyed by its host event identity. Replayed
/// delivery and frontend readers cannot append another copy of this turn.
pub(crate) fn record_terminal(
    db: &Db,
    engine: &str,
    source_run_id: &str,
    run_id: &str,
    terminal_seq: u64,
    session_id: Option<&str>,
    sample: &Value,
) -> rusqlite::Result<bool> {
    let status = sample.get("status").and_then(Value::as_str);
    let source = sample.get("source").and_then(Value::as_str);
    if sample.get("version").and_then(Value::as_u64) != Some(1)
        || !matches!(status, Some("complete" | "partial"))
        || !is_supported_source(engine, source)
    {
        return Ok(false);
    }
    let tokens = sample
        .get("outputTokens")
        .and_then(Value::as_u64)
        .filter(|n| *n <= MAX_SAFE_INTEGER);
    let elapsed = sample
        .get("elapsedMs")
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n > 0.0 && *n <= MAX_SAFE_INTEGER as f64);
    let explicit_reason = sample
        .get("turnReason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let effective_reason: Option<&str> = if status == Some("partial") {
        Some(explicit_reason.unwrap_or("interrupted"))
    } else {
        explicit_reason.or_else(|| gate_reason(tokens, elapsed))
    };
    let valid = status == Some("complete") && effective_reason.is_none();
    let inserted = {
        let conn = db.0.lock();
        ensure_migrated(&conn)?;
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO throughput_turns
             (run_id, terminal_seq, source_run_id, engine, session_id, completed, output_tokens, elapsed_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                run_id,
                terminal_seq,
                source_run_id,
                engine,
                session_id,
                valid,
                if valid { tokens.unwrap_or(0) } else { 0 },
                if valid { elapsed.unwrap_or(0.0) } else { 0.0 }
            ],
        )? > 0;
        if inserted {
            let mut meta = serde_json::Map::new();
            if let Some(s) = status {
                meta.insert("status".into(), Value::String(s.to_string()));
            }
            if let Some(r) = effective_reason {
                meta.insert("reason".into(), Value::String(r.to_string()));
            }
            if let Some(m) = sample
                .get("model")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|m| !m.is_empty() && *m != "<synthetic>")
            {
                meta.insert("model".into(), Value::String(m.to_string()));
            }
            if let Some(b) = sample.get("breakdown").filter(|v| v.is_object()) {
                meta.insert("breakdown".into(), b.clone());
            }
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            meta.insert("ts".into(), Value::from(ts));
            let kv_key = turn_kv_key(run_id, terminal_seq);
            conn.execute(
                "INSERT INTO plugin_kv(plugin_id, key, value) VALUES (?1, ?2, ?3)
                 ON CONFLICT(plugin_id, key) DO UPDATE SET value = excluded.value",
                params![TURNS_NAMESPACE, kv_key, Value::Object(meta).to_string()],
            )?;
        }
        inserted
    };
    Ok(inserted)
}

/// A final result can precede the native session announcement. Bind only
/// unbound rows from this launch; never move another conversation's history.
pub(crate) fn bind_session(
    db: &Db,
    engine: &str,
    source_run_id: &str,
    session_id: &str,
) -> rusqlite::Result<bool> {
    let count = db.0.lock().execute(
        "UPDATE throughput_turns SET session_id=?1 WHERE engine=?2 AND source_run_id=?3 AND session_id IS NULL",
        params![session_id, engine, source_run_id],
    )?;
    Ok(count > 0)
}

#[derive(Default)]
struct Bucket {
    totals: Totals,
    rates: Vec<f64>,
}

impl Bucket {
    fn push(&mut self, completed: bool, tokens: u64, elapsed: f64, interrupted: bool) {
        if completed && tokens > 0 && elapsed > 0.0 && elapsed.is_finite() {
            self.totals.output_tokens = self.totals.output_tokens.saturating_add(tokens);
            self.totals.elapsed_ms += elapsed;
            self.totals.completed_turns = self.totals.completed_turns.saturating_add(1);
            let rate = (tokens as f64) * 1000.0 / elapsed;
            if rate.is_finite() {
                self.rates.push(rate);
            }
        } else {
            self.totals.excluded_turns = self.totals.excluded_turns.saturating_add(1);
            if interrupted {
                self.totals.interrupted_turns = self.totals.interrupted_turns.saturating_add(1);
            } else {
                self.totals.missing_turns = self.totals.missing_turns.saturating_add(1);
            }
        }
    }

    fn finish(mut self) -> Totals {
        if !self.rates.is_empty() {
            self.rates.sort_by(|a, b| a.total_cmp(b));
            let mid = self.rates.len() / 2;
            let raw = if self.rates.len() % 2 == 1 {
                self.rates[mid]
            } else {
                (self.rates[mid - 1] + self.rates[mid]) / 2.0
            };
            self.totals.median_tps = Some((raw * 10.0).round() / 10.0);
        }
        self.totals
    }
}

fn parse_kv_meta(raw: Option<&str>) -> (Option<String>, bool) {
    let Some(raw) = raw else {
        return (None, false);
    };
    let Ok(val) = serde_json::from_str::<Value>(raw) else {
        return (None, false);
    };
    let model = val
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|m| !m.is_empty() && *m != "<synthetic>")
        .map(str::to_string);
    let status = val.get("status").and_then(Value::as_str);
    let reason = val.get("reason").and_then(Value::as_str);
    let interrupted = status == Some("partial") || reason == Some("interrupted");
    (model, interrupted)
}

pub(crate) fn read(
    db: &Db,
    engine: Option<&str>,
    session_id: Option<&str>,
) -> rusqlite::Result<ThroughputStats> {
    let conn = db.0.lock();
    ensure_migrated(&conn)?;
    let target_session = match (
        engine.filter(|s| !s.is_empty()),
        session_id.filter(|s| !s.is_empty()),
    ) {
        (Some(e), Some(s)) => Some((e, s)),
        _ => None,
    };

    let mut global_bucket = Bucket::default();
    let mut session_bucket = Bucket::default();
    let mut engine_buckets: BTreeMap<String, Bucket> = BTreeMap::new();
    let mut model_buckets: BTreeMap<String, Bucket> = BTreeMap::new();

    let mut stmt = conn.prepare(
        "SELECT t.engine,
                t.session_id,
                t.completed,
                t.output_tokens,
                t.elapsed_ms,
                kv.value,
                sm.model
         FROM throughput_turns t
         LEFT JOIN plugin_kv kv
           ON kv.plugin_id = ?1
          AND kv.key = t.run_id || ':' || CAST(t.terminal_seq AS TEXT)
         LEFT JOIN session_models sm
           ON sm.engine = t.engine
          AND sm.session_id = t.session_id",
    )?;
    let rows = stmt.query_map(params![TURNS_NAMESPACE], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, f64>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<String>>(6)?,
        ))
    })?;

    for item in rows {
        let (row_engine, row_session, completed_raw, tokens_raw, elapsed, kv_raw, sm_model) =
            item?;
        let completed = completed_raw == 1;
        let tokens = u64::try_from(tokens_raw).unwrap_or(0);
        let (kv_model, interrupted) = parse_kv_meta(kv_raw.as_deref());
        let effective_model = kv_model.or_else(|| {
            sm_model
                .as_deref()
                .map(str::trim)
                .filter(|m| !m.is_empty() && *m != "<synthetic>")
                .map(str::to_string)
        });

        global_bucket.push(completed, tokens, elapsed, interrupted);
        engine_buckets
            .entry(row_engine.clone())
            .or_default()
            .push(completed, tokens, elapsed, interrupted);
        if let Some((te, ts)) = target_session {
            if row_engine == te && row_session.as_deref() == Some(ts) {
                session_bucket.push(completed, tokens, elapsed, interrupted);
            }
        }
        if let Some(model_id) = effective_model {
            model_buckets
                .entry(model_id)
                .or_default()
                .push(completed, tokens, elapsed, interrupted);
        }
    }

    let by_engine = engine_buckets
        .into_iter()
        .map(|(k, b)| (k, b.finish()))
        .collect();
    let by_model = model_buckets
        .into_iter()
        .map(|(k, b)| (k, b.finish()))
        .collect();
    let started_at = conn.query_row(
        "SELECT started_at FROM throughput_stats_meta WHERE id=1",
        [],
        |row| row.get(0),
    )?;
    Ok(ThroughputStats {
        global: global_bucket.finish(),
        session: session_bucket.finish(),
        by_engine,
        by_model,
        started_at,
    })
}

#[tauri::command]
pub fn throughput_stats_read(
    state: tauri::State<'_, crate::AppState>,
    engine: Option<String>,
    session_id: Option<String>,
    workspace_path: Option<String>,
) -> Result<ThroughputStats, String> {
    // Stable native identities are engine/sessionId, independent of workspace.
    // A pending tab has no session identity and must never see other drafts.
    let _ = workspace_path;
    read(&state.db, engine.as_deref(), session_id.as_deref()).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn db() -> Db {
        Db::open_at(std::path::Path::new(":memory:")).unwrap()
    }
    fn sample(status: &str, tokens: Value, elapsed: Value) -> Value {
        json!({"version":1,"source":"claude","status":status,"outputTokens":tokens,"elapsedMs":elapsed})
    }

    #[test]
    fn agy_and_cursor_samples_are_isolated_deduplicated_and_split_excluded_reasons() {
        let db = db();
        let mut terminal = sample("complete", json!(20), json!(1000));
        terminal["source"] = json!("agy");
        terminal["model"] = json!("gemini-3.8-flash-high");
        assert!(!record_terminal(&db, "claude", "run", "run", 1, None, &terminal).unwrap());
        assert!(record_terminal(&db, "agy", "run", "run", 1, None, &terminal).unwrap());
        assert!(!record_terminal(&db, "agy", "run", "run", 1, None, &terminal).unwrap());
        terminal["status"] = json!("partial");
        record_terminal(&db, "agy", "run", "run", 2, None, &terminal).unwrap();
        terminal["status"] = json!("complete");
        terminal["outputTokens"] = Value::Null;
        record_terminal(&db, "agy", "run", "run", 3, None, &terminal).unwrap();
        bind_session(&db, "agy", "run", "native").unwrap();

        let mut cursor_sample = sample("complete", json!(150), json!(3000));
        cursor_sample["source"] = json!("cursor");
        cursor_sample["model"] = json!("claude-4.6-sonnet");
        assert!(record_terminal(
            &db,
            "cursor",
            "c-run",
            "c-run",
            1,
            Some("c-sess"),
            &cursor_sample
        )
        .unwrap());

        let totals = read(&db, Some("agy"), Some("native")).unwrap();
        assert_eq!(
            totals.session,
            Totals {
                output_tokens: 20,
                elapsed_ms: 1000.0,
                completed_turns: 1,
                excluded_turns: 2,
                interrupted_turns: 1,
                missing_turns: 1,
                median_tps: Some(20.0),
            }
        );
        assert_eq!(totals.by_engine["agy"], totals.session);
        assert_eq!(totals.by_model["gemini-3.8-flash-high"], totals.session);
        assert_eq!(totals.by_engine["cursor"].output_tokens, 150);
        assert_eq!(totals.by_model["claude-4.6-sonnet"].median_tps, Some(50.0));
    }

    #[test]
    fn sums_numerators_and_durations_and_deduplicates_terminal_identity() {
        let db = db();
        let first = sample("complete", json!(100), json!(1000));
        assert!(record_terminal(&db, "claude", "run", "run", 2, Some("a"), &first).unwrap());
        assert!(!record_terminal(&db, "claude", "run", "run", 2, Some("a"), &first).unwrap());
        record_terminal(
            &db,
            "claude",
            "run",
            "run",
            8,
            Some("a"),
            &sample("complete", json!(100), json!(9000)),
        )
        .unwrap();
        record_terminal(&db, "claude", "other", "other", 2, Some("b"), &first).unwrap();
        let stats = read(&db, Some("claude"), Some("a")).unwrap();
        assert_eq!(
            stats.session,
            Totals {
                output_tokens: 200,
                elapsed_ms: 10000.0,
                completed_turns: 2,
                excluded_turns: 0,
                interrupted_turns: 0,
                missing_turns: 0,
                median_tps: Some(55.6),
            }
        );
        assert_eq!(stats.global.completed_turns, 3);
        assert_eq!(stats.by_engine["claude"], stats.global);
        assert!(stats.started_at.is_some());
    }

    #[test]
    fn excludes_partial_zero_short_implausible_and_explicit_turn_reason_samples() {
        let db = db();
        for (seq, status, tokens, elapsed) in [
            (1, "running", json!(10), json!(1500)),
            (2, "partial", json!(10), json!(1500)),
            (3, "complete", Value::Null, json!(1500)),
            (4, "complete", json!(10), json!(0)),
            (5, "complete", json!(-1), json!(1500)),
            (6, "complete", json!(0), json!(1500)),
            (7, "complete", json!(10), json!(500)),
            (8, "complete", json!(109_000), json!(4400)),
        ] {
            record_terminal(
                &db,
                "claude",
                "run",
                "run",
                seq,
                Some("s"),
                &sample(status, tokens, elapsed),
            )
            .unwrap();
        }
        let mut subagent = sample("complete", json!(200), json!(4000));
        subagent["turnReason"] = json!("subagent_mixed");
        record_terminal(&db, "claude", "run", "run", 9, Some("s"), &subagent).unwrap();

        let stats = read(&db, None, None).unwrap();
        assert_eq!(
            stats.global,
            Totals {
                output_tokens: 0,
                elapsed_ms: 0.0,
                completed_turns: 0,
                excluded_turns: 8,
                interrupted_turns: 1,
                missing_turns: 7,
                median_tps: None,
            }
        );
        assert_eq!(stats.session, Totals::default());
    }

    #[test]
    fn migration_v2_cleans_historical_codex_fork_spikes_and_falls_back_to_session_models() {
        let db = db();
        {
            let conn = db.0.lock();
            // Insert pre-upgrade dirty rows BEFORE migration-v2 runs.
            conn.execute(
                "INSERT INTO throughput_turns (run_id, terminal_seq, source_run_id, engine, session_id, completed, output_tokens, elapsed_ms)
                 VALUES ('fork-spike', 1, 'fork-spike', 'codex', 's-codex', 1, 109000, 4400.0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO throughput_turns (run_id, terminal_seq, source_run_id, engine, session_id, completed, output_tokens, elapsed_ms)
                 VALUES ('short-noise', 1, 'short-noise', 'codex', 's-codex', 1, 12, 250.0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO throughput_turns (run_id, terminal_seq, source_run_id, engine, session_id, completed, output_tokens, elapsed_ms)
                 VALUES ('real-turn', 1, 'real-turn', 'codex', 's-codex', 1, 450, 5000.0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO session_models (engine, session_id, model, updated_at)
                 VALUES ('codex', 's-codex', 'gpt-5.4', 1)",
                [],
            )
            .unwrap();
        }
        let stats = read(&db, Some("codex"), Some("s-codex")).unwrap();
        assert_eq!(stats.session.completed_turns, 1);
        assert_eq!(stats.session.output_tokens, 450);
        assert_eq!(stats.session.elapsed_ms, 5000.0);
        assert_eq!(stats.session.excluded_turns, 2);
        assert_eq!(stats.session.missing_turns, 2);
        assert_eq!(stats.by_model["gpt-5.4"].output_tokens, 450);
        assert_eq!(stats.by_model["gpt-5.4"].median_tps, Some(90.0));
    }

    #[test]
    fn binds_early_rows_without_reassigning_existing_sessions_or_engines() {
        let db = db();
        let terminal = sample("complete", json!(20), json!(1000));
        record_terminal(&db, "claude", "run", "run", 1, None, &terminal).unwrap();
        record_terminal(&db, "claude", "run", "run-c1", 2, Some("existing"), &terminal).unwrap();
        bind_session(&db, "codex", "run", "wrong").unwrap();
        bind_session(&db, "claude", "run", "native").unwrap();
        assert_eq!(
            read(&db, Some("claude"), Some("native"))
                .unwrap()
                .session
                .completed_turns,
            1
        );
        assert_eq!(
            read(&db, Some("claude"), Some("existing"))
                .unwrap()
                .session
                .completed_turns,
            1
        );
        assert_eq!(
            read(&db, Some("claude"), None)
                .unwrap()
                .session
                .completed_turns,
            0
        );
    }

    #[test]
    fn statistics_survive_reopening_the_profile_database_without_backfill() {
        let directory = std::env::temp_dir().join(format!(
            "ccgui-throughput-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("app.db");
        let started_at;
        {
            let db = Db::open_at(&path).unwrap();
            started_at = read(&db, None, None).unwrap().started_at;
            record_terminal(
                &db,
                "claude",
                "persisted-run",
                "persisted-run",
                1,
                Some("saved-session"),
                &sample("complete", json!(250), json!(5000)),
            )
            .unwrap();
            record_terminal(
                &db,
                "claude",
                "persisted-run",
                "persisted-run",
                2,
                Some("saved-session"),
                &sample("partial", json!(900), json!(100)),
            )
            .unwrap();
        }
        {
            let db = Db::open_at(&path).unwrap();
            let result = read(&db, Some("claude"), Some("saved-session")).unwrap();
            assert_eq!(result.started_at, started_at);
            assert_eq!(
                result.session,
                Totals {
                    output_tokens: 250,
                    elapsed_ms: 5000.0,
                    completed_turns: 1,
                    excluded_turns: 1,
                    interrupted_turns: 1,
                    missing_turns: 0,
                    median_tps: Some(50.0),
                }
            );
            assert_eq!(result.global, result.session);
            assert_eq!(
                read(&db, Some("codex"), Some("saved-session"))
                    .unwrap()
                    .session,
                Totals::default()
            );
        }
        std::fs::remove_dir_all(directory).unwrap();
    }
}
