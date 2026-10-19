//! Host-observed reply throughput. Never reconstruct timing from history/usage.
use crate::db::Db;
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub output_tokens: u64,
    pub elapsed_ms: f64,
    pub completed_turns: u64,
    pub excluded_turns: u64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThroughputStats {
    pub global: Totals,
    pub session: Totals,
    pub by_engine: BTreeMap<String, Totals>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
}

/// One native terminal sample, keyed by its host event identity. Replayed
/// delivery and frontend readers cannot append another copy of this turn.
pub(crate) fn record_terminal(
    db: &Db, engine: &str, source_run_id: &str, run_id: &str, terminal_seq: u64,
    session_id: Option<&str>, sample: &Value,
) -> rusqlite::Result<bool> {
    let status = sample.get("status").and_then(Value::as_str);
    let source = sample.get("source").and_then(Value::as_str);
    if sample.get("version").and_then(Value::as_u64) != Some(1)
        || !matches!(status, Some("complete" | "partial"))
        || !matches!((engine, source), ("claude", Some("claude")) | ("codex", Some("codex_app_server")) | ("agy", Some("agy")))
    { return Ok(false); }
    let tokens = sample.get("outputTokens").and_then(Value::as_u64).filter(|n| *n <= MAX_SAFE_INTEGER);
    let elapsed = sample.get("elapsedMs").and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n > 0.0 && *n <= MAX_SAFE_INTEGER as f64);
    let valid = status == Some("complete") && tokens.is_some() && elapsed.is_some();
    let inserted = {
        let conn = db.0.lock();
        conn.execute(
            "INSERT OR IGNORE INTO throughput_turns
             (run_id, terminal_seq, source_run_id, engine, session_id, completed, output_tokens, elapsed_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![run_id, terminal_seq, source_run_id, engine, session_id, valid,
                if valid { tokens.unwrap_or(0) } else { 0 }, if valid { elapsed.unwrap_or(0.0) } else { 0.0 }],
        )? > 0
    };
    Ok(inserted)
}

/// A final result can precede the native session announcement. Bind only
/// unbound rows from this launch; never move another conversation's history.
pub(crate) fn bind_session(db: &Db, engine: &str, source_run_id: &str, session_id: &str) -> rusqlite::Result<bool> {
    let count = db.0.lock().execute(
        "UPDATE throughput_turns SET session_id=?1 WHERE engine=?2 AND source_run_id=?3 AND session_id IS NULL",
        params![session_id, engine, source_run_id],
    )?;
    Ok(count > 0)
}

fn totals(conn: &Connection, engine: Option<&str>, session_id: Option<&str>) -> rusqlite::Result<Totals> {
    conn.query_row(
        "SELECT COALESCE(SUM(output_tokens),0), COALESCE(SUM(elapsed_ms),0),
                COALESCE(SUM(completed),0), COALESCE(SUM(1-completed),0)
         FROM throughput_turns WHERE (?1 IS NULL OR engine=?1) AND (?2 IS NULL OR session_id=?2)",
        params![engine, session_id],
        |row| Ok(Totals { output_tokens: row.get(0)?, elapsed_ms: row.get(1)?, completed_turns: row.get(2)?, excluded_turns: row.get(3)? }),
    )
}

pub(crate) fn read(db: &Db, engine: Option<&str>, session_id: Option<&str>) -> rusqlite::Result<ThroughputStats> {
    let conn = db.0.lock();
    let global = totals(&conn, None, None)?;
    let session = match (engine.filter(|s| !s.is_empty()), session_id.filter(|s| !s.is_empty())) {
        (Some(engine), Some(session)) => totals(&conn, Some(engine), Some(session))?,
        _ => Totals::default(),
    };
    let mut by_engine = BTreeMap::new();
    let mut query = conn.prepare("SELECT DISTINCT engine FROM throughput_turns ORDER BY engine")?;
    for engine in query.query_map([], |row| row.get::<_, String>(0))? {
        let engine = engine?;
        by_engine.insert(engine.clone(), totals(&conn, Some(&engine), None)?);
    }
    let started_at = conn.query_row("SELECT started_at FROM throughput_stats_meta WHERE id=1", [], |row| row.get(0))?;
    Ok(ThroughputStats { global, session, by_engine, started_at })
}

#[tauri::command]
pub fn throughput_stats_read(
    state: tauri::State<'_, crate::AppState>, engine: Option<String>, session_id: Option<String>, workspace_path: Option<String>,
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

    fn db() -> Db { Db::open_at(std::path::Path::new(":memory:")).unwrap() }
    fn sample(status: &str, tokens: Value, elapsed: Value) -> Value {
        json!({"version":1,"source":"claude","status":status,"outputTokens":tokens,"elapsedMs":elapsed})
    }
    #[test]
    fn agy_samples_are_isolated_deduplicated_and_missing_turns_excluded() {
        let db = db();
        let mut terminal = sample("complete", json!(20), json!(1000));
        terminal["source"] = json!("agy");
        assert!(!record_terminal(&db,"claude","run","run",1,None,&terminal).unwrap());
        assert!(record_terminal(&db,"agy","run","run",1,None,&terminal).unwrap());
        assert!(!record_terminal(&db,"agy","run","run",1,None,&terminal).unwrap());
        terminal["status"] = json!("partial");
        record_terminal(&db,"agy","run","run",2,None,&terminal).unwrap();
        terminal["status"] = json!("complete");
        terminal["outputTokens"] = Value::Null;
        record_terminal(&db,"agy","run","run",3,None,&terminal).unwrap();
        bind_session(&db,"agy","run","native").unwrap();
        let totals = read(&db,Some("agy"),Some("native")).unwrap();
        assert_eq!(totals.session, Totals { output_tokens:20, elapsed_ms:1000.0, completed_turns:1, excluded_turns:2 });
        assert_eq!(totals.by_engine["agy"],totals.session);
    }
    #[test]
    fn sums_numerators_and_durations_and_deduplicates_terminal_identity() {
        let db = db();
        let first = sample("complete", json!(100), json!(1000));
        assert!(record_terminal(&db, "claude", "run", "run", 2, Some("a"), &first).unwrap());
        assert!(!record_terminal(&db, "claude", "run", "run", 2, Some("a"), &first).unwrap());
        record_terminal(&db, "claude", "run", "run", 8, Some("a"), &sample("complete", json!(100), json!(9000))).unwrap();
        record_terminal(&db, "claude", "other", "other", 2, Some("b"), &first).unwrap();
        let stats = read(&db, Some("claude"), Some("a")).unwrap();
        assert_eq!(stats.session, Totals { output_tokens: 200, elapsed_ms: 10000.0, completed_turns: 2, excluded_turns: 0 });
        assert_eq!(stats.global.completed_turns, 3);
        assert_eq!(stats.by_engine["claude"], stats.global);
        assert!(stats.started_at.is_some());
    }
    #[test]
    fn excludes_partial_and_missing_measurements_but_never_records_running() {
        let db = db();
        for (seq, status, tokens, elapsed) in [
            (1, "running", json!(10), json!(100)), (2, "partial", json!(10), json!(100)),
            (3, "complete", Value::Null, json!(100)), (4, "complete", json!(10), json!(0)),
            (5, "complete", json!(-1), json!(100)), (6, "complete", json!(0), json!(100)),
        ] { record_terminal(&db, "claude", "run", "run", seq, Some("s"), &sample(status, tokens, elapsed)).unwrap(); }
        let stats = read(&db, None, None).unwrap();
        assert_eq!(stats.global, Totals { output_tokens: 0, elapsed_ms: 100.0, completed_turns: 1, excluded_turns: 4 });
        assert_eq!(stats.session, Totals::default());
    }
    #[test]
    fn binds_early_rows_without_reassigning_existing_sessions_or_engines() {
        let db = db();
        let terminal = sample("complete", json!(20), json!(1000));
        record_terminal(&db, "claude", "run", "run", 1, None, &terminal).unwrap();
        record_terminal(&db, "claude", "run", "run-c1", 2, Some("existing"), &terminal).unwrap();
        bind_session(&db, "codex", "run", "wrong").unwrap();
        bind_session(&db, "claude", "run", "native").unwrap();
        assert_eq!(read(&db, Some("claude"), Some("native")).unwrap().session.completed_turns, 1);
        assert_eq!(read(&db, Some("claude"), Some("existing")).unwrap().session.completed_turns, 1);
        assert_eq!(read(&db, Some("claude"), None).unwrap().session.completed_turns, 0);
    }

    #[test]
    fn statistics_survive_reopening_the_profile_database_without_backfill() {
        let directory = std::env::temp_dir().join(format!("ccgui-throughput-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("app.db");
        let started_at;
        {
            let db = Db::open_at(&path).unwrap();
            started_at = read(&db, None, None).unwrap().started_at;
            record_terminal(&db, "claude", "persisted-run", "persisted-run", 1, Some("saved-session"),
                &sample("complete", json!(250), json!(5000))).unwrap();
            record_terminal(&db, "claude", "persisted-run", "persisted-run", 2, Some("saved-session"),
                &sample("partial", json!(900), json!(100))).unwrap();
        }
        {
            let db = Db::open_at(&path).unwrap();
            let result = read(&db, Some("claude"), Some("saved-session")).unwrap();
            assert_eq!(result.started_at, started_at);
            assert_eq!(result.session, Totals {output_tokens:250, elapsed_ms:5000.0, completed_turns:1, excluded_turns:1});
            assert_eq!(result.global, result.session);
            assert_eq!(read(&db, Some("codex"), Some("saved-session")).unwrap().session, Totals::default());
        }
        std::fs::remove_dir_all(directory).unwrap();
    }
}
