use super::*;
use std::io::Write;

#[test]
#[ignore = "explicit read-only verification of user-selected saved sources; no model calls"]
fn live_saved_sources_verify_without_model_calls() {
    let path = std::env::var("CCGUI_HANDOFF_VERIFY_DB").expect("explicit database path required");
    let sources: Vec<(String, String)> = serde_json::from_str(
        &std::env::var("CCGUI_HANDOFF_VERIFY_SOURCES")
            .expect("explicit source identities required"),
    )
    .unwrap();
    assert!(!sources.is_empty());
    let conn =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    let db = crate::db::Db(parking_lot::Mutex::new(conn));
    for (engine, session) in sources {
        // Never invoke discovery or a database mutation for an unindexed source.
        assert!(
            crate::history::reader::find_session_file_path(&db, &engine, &session)
                .unwrap()
                .is_some()
        );
        let (text, stamp) = read_saved_history(&db, &engine, &session).unwrap();
        ensure_saved_history_unchanged(&db, &engine, &session, &stamp).unwrap();
        println!(
            "verified saved {engine} history: {} visible bytes; no model calls",
            text.len()
        );
    }
}

struct Fixture {
    root: PathBuf,
    path: PathBuf,
    db: crate::db::Db,
}

impl Fixture {
    fn new(engine: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "ccgui-source-verification-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(root.join("conversations")).unwrap();
        let path = if engine == "agy" {
            root.join("conversations/quiet.db")
        } else {
            root.join("quiet.jsonl")
        };
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE sessions(engine TEXT, session_id TEXT, file_path TEXT)")
            .unwrap();
        conn.execute(
            "INSERT INTO sessions VALUES(?1, 'quiet', ?2)",
            rusqlite::params![engine, path.to_string_lossy()],
        )
        .unwrap();
        Self {
            root,
            path,
            db: crate::db::Db(parking_lot::Mutex::new(conn)),
        }
    }

    fn agy() -> Self {
        let fixture = Self::new("agy");
        let conn = rusqlite::Connection::open(&fixture.path).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER, step_type INTEGER, step_payload BLOB)").unwrap();
        let reply = b"unchanged assistant reply";
        let mut payload = vec![0xa2, 0x01, (reply.len() + 2) as u8, 0x0a, reply.len() as u8];
        payload.extend(reply);
        conn.execute("INSERT INTO steps VALUES(0, 15, ?1)", [payload])
            .unwrap();
        drop(conn);
        fixture
    }

    fn write(&self, text: &str) {
        std::fs::write(&self.path, text).unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if self.root.parent() == Some(std::env::temp_dir().as_path())
            && self
                .root
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("ccgui-source-verification-")
        {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }
}

fn message_json(text: &str) -> String {
    serde_json::json!({"type":"user", "message":{"role":"user", "content":text}}).to_string()
}

#[test]
fn moving_source_is_retried_before_an_empty_projection_can_become_child_fallback() {
    let fixture = Fixture::new("claude");
    fixture.write(&message_json("original visible request"));
    let before = source_stamp(&fixture.db, "claude", "quiet").unwrap();
    fixture.write("");
    let result = finish_snapshot_read(
        before,
        source_stamp(&fixture.db, "claude", "quiet").unwrap(),
        Err("full handoff saved visible history is empty".into()),
    );
    assert!(matches!(result, Err(SnapshotReadError::Changed)));
    let stable = finish_snapshot_read(
        source_stamp(&fixture.db, "claude", "quiet").unwrap(),
        source_stamp(&fixture.db, "claude", "quiet").unwrap(),
        Err("full handoff saved visible history is empty".into()),
    );
    assert!(matches!(stable, Err(SnapshotReadError::Failed(_))));
}

#[test]
fn quiet_agy_empty_wal_creation_and_removal_do_not_invalidate_summary() {
    let fixture = Fixture::agy();
    let (text, stamp) = read_saved_history(&fixture.db, "agy", "quiet").unwrap();
    let wal = fixture.path.with_extension("db-wal");
    // No writer is open: only the empty companion that read-only WAL access can
    // create is touched. No database row or compressed input changes.
    std::fs::write(&wal, []).unwrap();
    ensure_saved_history_unchanged(&fixture.db, "agy", "quiet", &stamp).unwrap();
    if wal.exists() {
        std::fs::remove_file(&wal).unwrap();
    }
    ensure_saved_history_unchanged(&fixture.db, "agy", "quiet", &stamp).unwrap();
    assert_eq!(
        read_saved_history(&fixture.db, "agy", "quiet").unwrap().0,
        text
    );
}

#[test]
fn shared_agy_prompt_log_changes_only_invalidate_the_selected_conversation() {
    let fixture = Fixture::agy();
    let history = fixture.root.join("history.jsonl");
    std::fs::write(
        &history,
        "{\"conversationId\":\"quiet\",\"display\":\"original user request\"}\n",
    )
    .unwrap();
    let (_, stamp) = read_saved_history(&fixture.db, "agy", "quiet").unwrap();
    let mut append = std::fs::OpenOptions::new()
        .append(true)
        .open(&history)
        .unwrap();
    writeln!(
        append,
        "{{\"conversationId\":\"other-chat\",\"display\":\"unrelated activity\"}}"
    )
    .unwrap();
    drop(append);
    ensure_saved_history_unchanged(&fixture.db, "agy", "quiet", &stamp).unwrap();
    std::fs::write(
        &history,
        "{\"conversationId\":\"quiet\",\"display\":\"changed user request\"}\n",
    )
    .unwrap();
    assert!(ensure_saved_history_unchanged(&fixture.db, "agy", "quiet", &stamp).is_err());
}

#[test]
fn non_conversation_claude_rows_are_allowed_but_new_visible_messages_are_rejected() {
    let fixture = Fixture::new("claude");
    let original = message_json("original visible request 中文😀");
    fixture.write(&original);
    let (_, stamp) = read_saved_history(&fixture.db, "claude", "quiet").unwrap();
    fixture.write(&format!(
        "{original}\n{{\"type\":\"progress\",\"data\":{{\"type\":\"hook_progress\"}}}}\n"
    ));
    ensure_saved_history_unchanged(&fixture.db, "claude", "quiet", &stamp).unwrap();
    fixture.write(&format!(
        "{original}\n{}\n",
        message_json("a genuinely new user request")
    ));
    assert!(ensure_saved_history_unchanged(&fixture.db, "claude", "quiet", &stamp).is_err());
}

#[test]
fn initial_and_final_history_reads_bypass_same_size_same_timestamp_timeline_cache() {
    let fixture = Fixture::new("claude");
    let original = message_json("old visible decision");
    let changed = message_json("new visible decision");
    assert_eq!(original.len(), changed.len());
    fixture.write(&original);
    let modified = std::fs::metadata(&fixture.path)
        .unwrap()
        .modified()
        .unwrap();
    let cached = crate::history::reader::load_session_page_blocking(
        &fixture.db,
        "claude",
        "quiet",
        Some(500),
        None,
    )
    .unwrap();
    assert!(cached.messages[0].text.contains("old visible decision"));
    let (_, stamp) = read_saved_history(&fixture.db, "claude", "quiet").unwrap();
    fixture.write(&changed);
    std::fs::File::options()
        .write(true)
        .open(&fixture.path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(modified))
        .unwrap();
    let (fresh, _) = read_saved_history(&fixture.db, "claude", "quiet").unwrap();
    assert!(fresh.contains("new visible decision"));
    assert!(!fresh.contains("old visible decision"));
    assert!(ensure_saved_history_unchanged(&fixture.db, "claude", "quiet", &stamp).is_err());
}

#[test]
fn replacing_the_source_path_or_losing_the_source_is_not_a_metadata_only_change() {
    let fixture = Fixture::new("claude");
    let text = message_json("unchanged visible text");
    fixture.write(&text);
    let (_, stamp) = read_saved_history(&fixture.db, "claude", "quiet").unwrap();
    let other = fixture.root.join("replacement.jsonl");
    std::fs::write(&other, text).unwrap();
    fixture
        .db
        .0
        .lock()
        .execute(
            "UPDATE sessions SET file_path=?1",
            [other.to_string_lossy()],
        )
        .unwrap();
    assert!(ensure_saved_history_unchanged(&fixture.db, "claude", "quiet", &stamp).is_err());
    std::fs::remove_file(other).unwrap();
    assert!(ensure_saved_history_unchanged(&fixture.db, "claude", "quiet", &stamp).is_err());
}

#[test]
fn tool_arguments_and_results_are_part_of_the_verified_visible_input() {
    let fixture = Fixture::new("claude");
    let rows = [
        serde_json::json!({"type":"assistant", "message":{"role":"assistant", "content":[
            {"type":"tool_use", "id":"read-fixture", "name":"Read", "input":{"file_path":"old.txt"}}
        ]}}),
        serde_json::json!({"type":"user", "message":{"role":"user", "content":[
            {"type":"tool_result", "tool_use_id":"read-fixture", "content":"old result"}
        ]}}),
    ];
    let encode = |rows: &[serde_json::Value]| {
        rows.iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("\n")
    };
    fixture.write(&encode(&rows));
    let (_, stamp) = read_saved_history(&fixture.db, "claude", "quiet").unwrap();
    for (row, field, value) in [
        (0, "input", serde_json::json!({"file_path":"new.txt"})),
        (1, "content", serde_json::json!("new result")),
    ] {
        let mut changed = rows.clone();
        changed[row]["message"]["content"][0][field] = value;
        fixture.write(&encode(&changed));
        let error =
            ensure_saved_history_unchanged(&fixture.db, "claude", "quiet", &stamp).unwrap_err();
        assert!(error.contains("visible history changed"));
    }
}

#[tokio::test]
async fn finished_summary_survives_storage_bookkeeping_without_another_model_call() {
    let fixture = Fixture::agy();
    let (text, stamp) = read_saved_history(&fixture.db, "agy", "quiet").unwrap();
    let calls = std::cell::Cell::new(0usize);
    let summary = compress("agy", "quiet", None, &text, None, |_| {
        calls.set(calls.get() + 1);
        std::fs::write(fixture.path.with_extension("db-wal"), []).unwrap();
        std::future::ready(Ok(
            "完整交接摘要：已保留原任务、已完成工作和下一步验证事项。".into(),
        ))
    })
    .await
    .unwrap();
    ensure_saved_history_unchanged(&fixture.db, "agy", "quiet", &stamp).unwrap();
    assert!(summary.contains("完整交接摘要"));
    assert_eq!(calls.get(), 1);
}
