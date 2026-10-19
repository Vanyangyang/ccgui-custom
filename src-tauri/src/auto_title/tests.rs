use super::*;
use crate::event_sink::Emit;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Default)]
struct CountChanges(AtomicUsize);
impl Emit for CountChanges {
    fn emit_json(&self, name: &str, _raw_json: &str) {
        if name == crate::event_sink::SESSIONS_CHANGED_EVENT {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }
}

struct Fixture {
    dir: std::path::PathBuf,
    db: Arc<Db>,
    sink: Arc<EventSink>,
    changes: Arc<CountChanges>,
    transcript: std::path::PathBuf,
    lines: Vec<String>,
}

const WS: &str = "/ws/maple";

impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("ccgui-auto-title-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Arc::new(Db::open_at(&dir.join("app.db")).unwrap());
        let changes = Arc::new(CountChanges::default());
        let sink = EventSink::new(Arc::clone(&changes) as Arc<dyn Emit>);
        let transcript = dir.join("s1.jsonl");
        db.0.lock()
            .execute(
                "INSERT INTO workspaces(id, path, name) VALUES('w1', ?1, 'maple')",
                [WS],
            )
            .unwrap();
        let mut fixture = Self {
            dir,
            db,
            sink,
            changes,
            transcript,
            lines: Vec::new(),
        };
        fixture.user("修复登录表单的报错提示样式");
        fixture.assistant("已调整报错提示的颜色和间距");
        let stat = fixture.stat();
        fixture
            .db
            .0
            .lock()
            .execute(
                "INSERT INTO sessions(engine, session_id, workspace_path, file_path, file_size, file_mtime_ms, title, updated_at)
                 VALUES('claude', 's1', ?1, ?2, ?3, ?4, '修复登录表单的报错提示样式', 10)",
                rusqlite::params![WS, fixture.transcript.to_string_lossy(), stat.0, stat.1],
            )
            .unwrap();
        fixture
    }

    fn write(&mut self, line: serde_json::Value) {
        self.lines.push(line.to_string());
        std::fs::write(&self.transcript, self.lines.join("\n") + "\n").unwrap();
    }
    fn user(&mut self, text: &str) {
        self.write(serde_json::json!({
            "type": "user", "timestamp": "2026-10-04T10:00:00.000Z",
            "message": { "role": "user", "content": text }
        }));
    }
    fn assistant(&mut self, text: &str) {
        self.write(serde_json::json!({
            "type": "assistant", "timestamp": "2026-10-04T10:00:01.000Z",
            "message": { "role": "assistant", "content": [{ "type": "text", "text": text }] }
        }));
    }
    fn stat(&self) -> (i64, i64) {
        crate::history::stat_signature(&self.transcript).unwrap()
    }
    /// What a scanner pass would record for the grown transcript.
    fn rescan_row(&self) {
        let (size, mtime) = self.stat();
        self.db
            .0
            .lock()
            .execute(
                "UPDATE sessions SET file_size = ?1, file_mtime_ms = ?2 WHERE session_id = 's1'",
                rusqlite::params![size, mtime],
            )
            .unwrap();
    }
    fn prepare(&self, mode: Mode) -> Result<Prepared, Stop> {
        let aliases = HashMap::from([("w1".to_string(), "Maple 主站".to_string())]);
        prepare(&self.db, &self.sink, "claude", "s1", mode, &aliases)
    }
    fn commit(&self, prepared: &Prepared, title: Option<&str>) -> Result<(), Stop> {
        // Keep test configuration local; never toggle the user's settings.
        commit_with_enabled(
            &self.db,
            &self.sink,
            "claude",
            "s1",
            prepared,
            title,
            || true,
        )
    }
    fn add_session(&self, id: &str, title: &str, updated_at: i64) {
        let transcript = self.dir.join(format!("{id}.jsonl"));
        std::fs::write(&transcript, self.lines.join("\n") + "\n").unwrap();
        let stat = crate::history::stat_signature(&transcript).unwrap();
        self.db.0.lock().execute(
            "INSERT INTO sessions(engine, session_id, workspace_path, file_path, file_size, file_mtime_ms, title, updated_at)
             VALUES('claude', ?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![id, WS, transcript.to_string_lossy(), stat.0, stat.1, title, updated_at],
        ).unwrap();
    }
    fn displayed(&self) -> String {
        crate::history::reader::list_sessions_from(&self.db)
            .unwrap()
            .into_iter()
            .find(|s| s.session_id == "s1")
            .unwrap()
            .title
    }
    fn auto_row(&self) -> (Option<String>, i64, i64) {
        self.db
            .0
            .lock()
            .query_row(
                "SELECT title, user_turns, ack_skips FROM session_auto_titles WHERE session_id = 's1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn skipped(result: Result<Prepared, Stop>) -> &'static str {
    match result {
        Err(Stop::Skipped(reason)) => reason,
        Err(Stop::Failed(code)) => panic!("failed: {code}"),
        Ok(_) => panic!("expected a skip"),
    }
}

#[test]
fn input_carries_the_excerpt_alias_and_structured_sibling_titles() {
    let fx = Fixture::new();
    {
        let conn = fx.db.0.lock();
        for (id, title, custom) in [
            ("s2", "随便聊聊", None),
            ("s3", "first message", Some("🧩 支付回调｜重复发货修复")),
        ] {
            conn.execute(
                "INSERT INTO sessions(engine, session_id, workspace_path, file_path, file_size, file_mtime_ms, title, custom_title)
                 VALUES('claude', ?1, ?2, ?1, 1, 1, ?3, ?4)",
                rusqlite::params![id, WS, title, custom],
            )
            .unwrap();
        }
    }
    let prepared = fx.prepare(Mode::Auto).unwrap();
    let input: Value = serde_json::from_str(&prepared.input).unwrap();
    assert_eq!(input["current_title"], "修复登录表单的报错提示样式");
    assert_eq!(
        input["project_hint"], "Maple 主站",
        "the sidebar alias, not the folder"
    );
    assert_eq!(
        input["recent_turns"][0]["user"],
        "修复登录表单的报错提示样式"
    );
    assert_eq!(
        input["recent_turns"][0]["assistant"],
        "已调整报错提示的颜色和间距"
    );
    assert_eq!(
        input["existing_titles"],
        serde_json::json!(["🧩 支付回调｜重复发货修复"])
    );
    assert!(input.get("original_goal").is_none());
}

#[test]
fn compressed_codex_title_input_can_commit_and_rejects_a_newer_plain_rollout() {
    let fx = Fixture::new();
    let input = [
        serde_json::json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "修复登录表单的报错提示样式"}]}}),
        serde_json::json!({"type": "response_item", "payload": {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "已调整报错提示的颜色和间距"}]}}),
    ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\n";
    let compressed = fx.transcript.with_extension("jsonl.zst");
    std::fs::write(&compressed, zstd::stream::encode_all(input.as_bytes(), 1).unwrap()).unwrap();
    std::fs::remove_file(&fx.transcript).unwrap();
    let stat = crate::history::stat_signature(&compressed).unwrap();
    fx.db.0.lock().execute(
        "UPDATE sessions SET engine = 'codex', file_size = ?1, file_mtime_ms = ?2 WHERE session_id = 's1'",
        rusqlite::params![stat.0, stat.1],
    ).unwrap();
    // The persisted path still names the absent .jsonl.
    let prepared = prepare(&fx.db, &fx.sink, "codex", "s1", Mode::Auto, &HashMap::new()).unwrap();
    let naming_input: Value = serde_json::from_str(&prepared.input).unwrap();
    assert_eq!(naming_input["recent_turns"][0]["user"], "修复登录表单的报错提示样式");
    assert_eq!(naming_input["recent_turns"][0]["assistant"], "已调整报错提示的颜色和间距");
    commit_with_enabled(&fx.db, &fx.sink, "codex", "s1", &prepared, None, || true).unwrap();
    assert_eq!(fx.auto_row(), (None, 1, 0));

    // A resumed writer can materialize raw while the old .zst still exists.
    let newer = serde_json::json!({"type": "response_item", "payload": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "接着修复支付回调的重复发货问题"}]}});
    std::fs::write(&fx.transcript, input + &newer.to_string() + "\n").unwrap();
    assert!(matches!(
        commit_with_enabled(&fx.db, &fx.sink, "codex", "s1", &prepared, Some("🎨 登录表单｜报错提示样式"), || true),
        Err(Stop::Skipped("stale"))
    ));
    assert_eq!(fx.auto_row().0, None);
}

#[test]
fn a_committed_title_displays_and_an_unchanged_conversation_is_not_resent() {
    let fx = Fixture::new();
    let prepared = fx.prepare(Mode::Auto).unwrap();
    fx.commit(&prepared, Some("🎨 登录表单｜报错提示样式"))
        .unwrap();
    assert_eq!(fx.displayed(), "🎨 登录表单｜报错提示样式");
    assert_eq!(
        fx.changes.0.load(Ordering::SeqCst),
        1,
        "the sidebar refreshes once"
    );
    assert_eq!(skipped(fx.prepare(Mode::Auto)), "unchanged");
}

#[test]
fn a_keep_records_the_basis_without_a_title() {
    let fx = Fixture::new();
    let prepared = fx.prepare(Mode::Auto).unwrap();
    fx.commit(&prepared, None).unwrap();
    assert_eq!(fx.auto_row(), (None, 1, 0));
    assert_eq!(fx.displayed(), "修复登录表单的报错提示样式");
    assert_eq!(
        fx.changes.0.load(Ordering::SeqCst),
        0,
        "nothing visible changed"
    );
    assert_eq!(skipped(fx.prepare(Mode::Auto)), "unchanged");
}

#[test]
fn bare_acknowledgements_skip_twice_then_reevaluate() {
    let mut fx = Fixture::new();
    let prepared = fx.prepare(Mode::Auto).unwrap();
    fx.commit(&prepared, Some("🎨 登录表单｜报错提示样式"))
        .unwrap();
    for skips in 1..=2 {
        fx.user("好的");
        fx.assistant("好");
        fx.rescan_row();
        assert_eq!(skipped(fx.prepare(Mode::Auto)), "ack");
        assert_eq!(
            fx.auto_row(),
            (Some("🎨 登录表单｜报错提示样式".into()), 1 + skips, skips)
        );
    }
    fx.user("继续");
    fx.rescan_row();
    assert!(
        fx.prepare(Mode::Auto).is_ok(),
        "a third bare ack is evaluated again"
    );
}

#[test]
fn a_substantive_turn_or_two_missed_turns_are_never_ack_skipped() {
    let mut fx = Fixture::new();
    let prepared = fx.prepare(Mode::Auto).unwrap();
    fx.commit(&prepared, Some("🎨 登录表单｜报错提示样式"))
        .unwrap();
    fx.user("再加一个导出按钮");
    fx.user("好的");
    fx.rescan_row();
    assert!(fx.prepare(Mode::Auto).is_ok());
}

#[test]
fn greetings_alone_are_never_sent() {
    let mut fx = Fixture::new();
    fx.lines.clear();
    fx.user("你好");
    fx.assistant("你好！有什么可以帮你？");
    fx.rescan_row();
    assert_eq!(skipped(fx.prepare(Mode::Auto)), "no_substance");
}

#[test]
fn a_custom_title_locks_auto_naming_but_not_suggestions() {
    let fx = Fixture::new();
    fx.db
        .0
        .lock()
        .execute(
            "UPDATE sessions SET custom_title = '我的标题' WHERE session_id = 's1'",
            [],
        )
        .unwrap();
    assert_eq!(skipped(fx.prepare(Mode::Auto)), "locked");
    let suggestion = fx.prepare(Mode::Suggest).unwrap();
    assert_eq!(
        suggestion.current, "我的标题",
        "the suggestion starts from what the user sees"
    );
}

#[test]
fn archived_sessions_are_not_named() {
    let fx = Fixture::new();
    fx.db
        .0
        .lock()
        .execute(
            "INSERT INTO session_archives(engine, session_id, workspace_path, snapshot_json, archived_at)
             VALUES('claude', 's1', ?1, '{}', 1)",
            [WS],
        )
        .unwrap();
    assert_eq!(skipped(fx.prepare(Mode::Auto)), "archived");
}

#[test]
fn commit_is_discarded_when_the_user_renames_meanwhile() {
    let fx = Fixture::new();
    let prepared = fx.prepare(Mode::Auto).unwrap();
    fx.db
        .0
        .lock()
        .execute(
            "UPDATE sessions SET custom_title = '手动' WHERE session_id = 's1'",
            [],
        )
        .unwrap();
    assert!(matches!(
        fx.commit(&prepared, Some("🎨 登录表单｜报错提示样式")),
        Err(Stop::Skipped("locked_meanwhile"))
    ));
    let count: i64 = fx
        .db
        .0
        .lock()
        .query_row("SELECT COUNT(*) FROM session_auto_titles", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0, "nothing written");
}

#[test]
fn commit_is_discarded_when_the_session_is_archived_meanwhile() {
    let fx = Fixture::new();
    let prepared = fx.prepare(Mode::Auto).unwrap();
    fx.db.0.lock().execute(
        "INSERT INTO session_archives(engine, session_id, workspace_path, snapshot_json, archived_at)
         VALUES('claude', 's1', ?1, '{}', 1)",
        [WS],
    ).unwrap();
    assert!(matches!(
        fx.commit(&prepared, Some("🎨 登录表单｜报错提示样式")),
        Err(Stop::Skipped("locked_meanwhile"))
    ));
    let count: i64 = fx
        .db
        .0
        .lock()
        .query_row("SELECT COUNT(*) FROM session_auto_titles", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn commit_reads_unscanned_content_and_tolerates_only_bookkeeping_changes() {
    let mut fx = Fixture::new();
    let prepared = fx.prepare(Mode::Auto).unwrap();
    fx.write(serde_json::json!({ "type": "last-prompt", "lastPrompt": "x" }));
    // No rescan: the real file, rather than sessions.file_size, is authoritative.
    fx.commit(&prepared, Some("🎨 登录表单｜报错提示样式"))
        .unwrap();

    fx.rescan_row();
    let prepared = fx.prepare(Mode::Suggest).unwrap();
    fx.user("转而修复付款失败的问题");
    fx.assistant("已修复付款失败");
    assert!(matches!(
        fx.commit(&prepared, Some("🧩 付款流程｜失败修复")),
        Err(Stop::Skipped("stale"))
    ));
    assert_eq!(fx.displayed(), "🎨 登录表单｜报错提示样式");
}

#[test]
fn commit_rechecks_the_file_and_workspace_identity() {
    let fx = Fixture::new();
    let prepared = fx.prepare(Mode::Auto).unwrap();
    fx.add_session("replacement", "same content", 1);
    let replacement = fx
        .dir
        .join("replacement.jsonl")
        .to_string_lossy()
        .into_owned();
    fx.db
        .0
        .lock()
        .execute(
            "UPDATE sessions SET file_path = ?1 WHERE session_id = 's1'",
            [replacement],
        )
        .unwrap();
    assert!(matches!(
        fx.commit(&prepared, Some("🎨 登录表单｜报错提示样式")),
        Err(Stop::Skipped("stale"))
    ));
    fx.db.0.lock().execute(
        "UPDATE sessions SET file_path = ?1, workspace_path = '/ws/other' WHERE session_id = 's1'",
        [fx.transcript.to_string_lossy().as_ref()],
    ).unwrap();
    assert!(matches!(
        fx.commit(&prepared, Some("🎨 登录表单｜报错提示样式")),
        Err(Stop::Skipped("stale"))
    ));
}

#[test]
fn commit_discards_a_deleted_transcript_even_before_rescan() {
    let fx = Fixture::new();
    let prepared = fx.prepare(Mode::Auto).unwrap();
    std::fs::remove_file(&fx.transcript).unwrap();
    assert!(matches!(
        fx.commit(&prepared, Some("🎨 登录表单｜报错提示样式")),
        Err(Stop::Skipped("stale"))
    ));
}

#[test]
fn turning_off_naming_while_the_model_runs_prevents_commit() {
    let fx = Fixture::new();
    let prepared = fx.prepare(Mode::Auto).unwrap();
    let enabled = std::sync::atomic::AtomicBool::new(true);
    enabled.store(false, Ordering::SeqCst);
    assert!(matches!(
        commit_with_enabled(
            &fx.db,
            &fx.sink,
            "claude",
            "s1",
            &prepared,
            Some("🎨 登录表单｜报错提示样式"),
            || enabled.load(Ordering::SeqCst)
        ),
        Err(Stop::Skipped("disabled"))
    ));
    let count: i64 = fx
        .db
        .0
        .lock()
        .query_row("SELECT COUNT(*) FROM session_auto_titles", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn turning_off_naming_during_commit_validation_rolls_back_the_title() {
    let fx = Fixture::new();
    let prepared = fx.prepare(Mode::Auto).unwrap();
    let checks = AtomicUsize::new(0);
    assert!(matches!(
        commit_with_enabled(
            &fx.db,
            &fx.sink,
            "claude",
            "s1",
            &prepared,
            Some("🎨 登录表单｜报错提示样式"),
            || checks.fetch_add(1, Ordering::SeqCst) == 0,
        ),
        Err(Stop::Skipped("disabled"))
    ));
    assert_eq!(checks.load(Ordering::SeqCst), 2);
    let count: i64 = fx
        .db
        .0
        .lock()
        .query_row("SELECT COUNT(*) FROM session_auto_titles", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0, "the transaction must roll back its staged write");
    assert_eq!(fx.changes.0.load(Ordering::SeqCst), 0);
}

#[test]
fn preparing_a_suggestion_does_not_write_a_title_or_ack_basis() {
    let mut fx = Fixture::new();
    let prepared = fx.prepare(Mode::Auto).unwrap();
    fx.commit(&prepared, Some("🎨 登录表单｜报错提示样式"))
        .unwrap();
    fx.db
        .0
        .lock()
        .execute(
            "UPDATE sessions SET custom_title = '手动' WHERE session_id = 's1'",
            [],
        )
        .unwrap();
    let before = fx.auto_row();
    fx.user("好的");
    fx.rescan_row();
    let suggestion = fx.prepare(Mode::Suggest).unwrap();
    assert_eq!(suggestion.current, "手动");
    assert_eq!(
        fx.auto_row(),
        before,
        "suggestions must not commit a title or fingerprint"
    );
    let custom: Option<String> = fx
        .db
        .0
        .lock()
        .query_row(
            "SELECT custom_title FROM sessions WHERE session_id = 's1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(custom.as_deref(), Some("手动"));
}

#[test]
fn a_cancelled_evaluation_cannot_commit_its_late_title() {
    let fx = Fixture::new();
    let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let prepared = fx.prepare(Mode::Auto).unwrap();
    // The turn was eligible at prepare, then Stop arrived before its answer.
    cancelled.store(true, Ordering::SeqCst);
    assert!(matches!(
        commit_with_checks(
            &fx.db,
            &fx.sink,
            "claude",
            "s1",
            &prepared,
            Some("🎨 登录表单｜报错提示样式"),
            || true,
            || cancelled.load(Ordering::SeqCst),
        ),
        Err(Stop::Skipped("cancelled"))
    ));
    let count: i64 = fx
        .db
        .0
        .lock()
        .query_row("SELECT COUNT(*) FROM session_auto_titles", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(fx.changes.0.load(Ordering::SeqCst), 0);
}

#[test]
fn cancellation_during_commit_validation_rolls_back_the_title_and_basis() {
    let fx = Fixture::new();
    let prepared = fx.prepare(Mode::Auto).unwrap();
    let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let checks = AtomicUsize::new(0);
    assert!(matches!(
        commit_with_checks(
            &fx.db,
            &fx.sink,
            "claude",
            "s1",
            &prepared,
            Some("🎨 登录表单｜报错提示样式"),
            || {
                if checks.fetch_add(1, Ordering::SeqCst) == 1 {
                    cancelled.store(true, Ordering::SeqCst);
                }
                true
            },
            || cancelled.load(Ordering::SeqCst),
        ),
        Err(Stop::Skipped("cancelled"))
    ));
    assert_eq!(checks.load(Ordering::SeqCst), 2);
    let count: i64 = fx
        .db
        .0
        .lock()
        .query_row("SELECT COUNT(*) FROM session_auto_titles", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        count, 0,
        "cancelled writes must roll back, including the fingerprint"
    );
    assert_eq!(fx.changes.0.load(Ordering::SeqCst), 0);
}

#[test]
fn concurrent_sessions_cannot_commit_the_same_workspace_title() {
    let fx = Fixture::new();
    fx.add_session("s2", "another first message", 1);
    let first = fx.prepare(Mode::Auto).unwrap();
    let second = prepare(
        &fx.db,
        &fx.sink,
        "claude",
        "s2",
        Mode::Auto,
        &HashMap::new(),
    )
    .unwrap();
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let handles: Vec<_> = [("s1", first), ("s2", second)]
        .into_iter()
        .map(|(session, prepared)| {
            let (db, sink, barrier) = (
                Arc::clone(&fx.db),
                Arc::clone(&fx.sink),
                Arc::clone(&barrier),
            );
            std::thread::spawn(move || {
                barrier.wait();
                commit_with_enabled(
                    &db,
                    &sink,
                    "claude",
                    session,
                    &prepared,
                    Some("🎨 登录表单｜报错提示样式"),
                    || true,
                )
            })
        })
        .collect();
    barrier.wait();
    let outcomes: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect();
    assert_eq!(outcomes.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        outcomes
            .iter()
            .filter(|result| matches!(result, Err(Stop::Skipped("duplicate"))))
            .count(),
        1
    );
    let count: i64 = fx
        .db
        .0
        .lock()
        .query_row(
            "SELECT COUNT(*) FROM session_auto_titles WHERE title = '🎨 登录表单｜报错提示样式'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
    assert_eq!(fx.changes.0.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn cancelled_origins_are_rejected_at_the_evaluator_entry() {
    for (process_stopped, turn_interrupted) in [(true, false), (false, true)] {
        let fx = Fixture::new();
        // If cancellation regresses, this fixture lock still prevents a real
        // model call; the expected cancellation assertion must fail instead.
        fx.db
            .0
            .lock()
            .execute(
                "UPDATE sessions SET custom_title = 'fixture lock' WHERE session_id = 's1'",
                [],
            )
            .unwrap();
        let killed = Arc::new(std::sync::atomic::AtomicBool::new(process_stopped));
        let interrupted = Arc::new(std::sync::atomic::AtomicBool::new(turn_interrupted));
        let origin = origin::SettledOrigin::new_for_test("claude", "s1", WS, killed, interrupted);
        assert!(matches!(
            evaluate_for_origin(&fx.db, &fx.sink, &origin, &NamingConfig::from_settings(&Default::default())).await,
            Err(Stop::Skipped("cancelled"))
        ));
        let count: i64 = fx
            .db
            .0
            .lock()
            .query_row("SELECT COUNT(*) FROM session_auto_titles", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        assert_eq!(fx.changes.0.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn an_origin_for_another_workspace_is_rejected_at_the_evaluator_entry() {
    let fx = Fixture::new();
    fx.db
        .0
        .lock()
        .execute(
            "UPDATE sessions SET custom_title = 'fixture lock' WHERE session_id = 's1'",
            [],
        )
        .unwrap();
    let origin = origin::SettledOrigin::new_for_test(
        "claude",
        "s1",
        "/ws/another-workspace",
        Arc::new(std::sync::atomic::AtomicBool::new(false)),
        Arc::new(std::sync::atomic::AtomicBool::new(false)),
    );
    assert!(matches!(
        evaluate_for_origin(&fx.db, &fx.sink, &origin, &NamingConfig::from_settings(&Default::default())).await,
        Err(Stop::Skipped("stale"))
    ));
    let count: i64 = fx
        .db
        .0
        .lock()
        .query_row("SELECT COUNT(*) FROM session_auto_titles", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(fx.changes.0.load(Ordering::SeqCst), 0);
}

#[test]
fn a_cancelled_ack_cannot_update_the_evaluated_basis() {
    let mut fx = Fixture::new();
    let prepared = fx.prepare(Mode::Auto).unwrap();
    fx.commit(&prepared, Some("🎨 登录表单｜报错提示样式"))
        .unwrap();
    let before = fx.auto_row();
    let fingerprint: String = fx
        .db
        .0
        .lock()
        .query_row(
            "SELECT fingerprint FROM session_auto_titles WHERE session_id = 's1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let before_changes = fx.changes.0.load(Ordering::SeqCst);
    fx.user("好的");
    fx.assistant("好");
    fx.rescan_row();
    let parsed = crate::history::parse_session_file("claude", &fx.transcript).unwrap();
    let excerpt = excerpt::build(&excerpt::turns(&parsed.messages), POLICY_VERSION);
    let interrupted = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let origin = origin::SettledOrigin::new_for_test(
        "claude",
        "s1",
        WS,
        Arc::new(std::sync::atomic::AtomicBool::new(false)),
        Arc::clone(&interrupted),
    );
    // Stop lands while the ACK is being evaluated, before its early write.
    interrupted.store(true, Ordering::SeqCst);
    assert!(matches!(
        record_ack_skip(&fx.db, "claude", "s1", &excerpt, 1, Some(&origin)),
        Err(Stop::Skipped("cancelled"))
    ));
    assert!(matches!(
        prepare_with_origin(
            &fx.db,
            &fx.sink,
            "claude",
            "s1",
            Mode::Auto,
            &HashMap::new(),
            Some(&origin)
        ),
        Err(Stop::Skipped("cancelled"))
    ));
    let after_fingerprint: String = fx
        .db
        .0
        .lock()
        .query_row(
            "SELECT fingerprint FROM session_auto_titles WHERE session_id = 's1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(fx.auto_row(), before);
    assert_eq!(after_fingerprint, fingerprint);
    assert_eq!(fx.changes.0.load(Ordering::SeqCst), before_changes);
}

#[test]
fn duplicate_check_is_not_limited_to_the_thirty_prompt_titles() {
    let fx = Fixture::new();
    let candidate = "🎨 登录表单｜报错提示样式";
    fx.add_session("old-sibling", candidate, -1);
    for i in 0..EXISTING_TITLES {
        fx.add_session(
            &format!("recent-{i}"),
            &format!("🧩 模块{i}｜修复"),
            i as i64,
        );
    }
    let prepared = fx.prepare(Mode::Auto).unwrap();
    let input: Value = serde_json::from_str(&prepared.input).unwrap();
    let existing = input["existing_titles"].as_array().unwrap();
    assert_eq!(existing.len(), EXISTING_TITLES);
    assert!(!existing
        .iter()
        .any(|title| title.as_str() == Some(candidate)));
    assert!(matches!(
        fx.commit(&prepared, Some(candidate)),
        Err(Stop::Skipped("duplicate"))
    ));
    assert_eq!(fx.displayed(), "修复登录表单的报错提示样式");
    assert_eq!(
        skipped(fx.prepare(Mode::Auto)),
        "unchanged",
        "record the rejected basis"
    );
}

#[test]
fn commit_tolerates_bookkeeping_appends_but_not_a_new_turn() {
    let mut fx = Fixture::new();
    let prepared = fx.prepare(Mode::Auto).unwrap();
    // A non-message line (CLI bookkeeping) moves the stat, not the excerpt.
    fx.write(serde_json::json!({ "type": "last-prompt", "lastPrompt": "x" }));
    fx.rescan_row();
    fx.commit(&prepared, Some("🎨 登录表单｜报错提示样式"))
        .unwrap();

    let prepared = {
        fx.user("顺便把按钮改成圆角");
        fx.rescan_row();
        fx.prepare(Mode::Auto).unwrap()
    };
    fx.user("还有暗色模式");
    fx.rescan_row();
    assert!(matches!(
        fx.commit(&prepared, Some("🎨 登录表单｜按钮圆角")),
        Err(Stop::Skipped("stale"))
    ));
    assert_eq!(
        fx.displayed(),
        "🎨 登录表单｜报错提示样式",
        "the newer turn re-evaluates"
    );
}

#[test]
fn a_policy_bump_reevaluates_unchanged_conversations() {
    let fx = Fixture::new();
    let prepared = fx.prepare(Mode::Auto).unwrap();
    fx.commit(&prepared, Some("🎨 登录表单｜报错提示样式"))
        .unwrap();
    fx.db
        .0
        .lock()
        .execute("UPDATE session_auto_titles SET policy_version = 0", [])
        .unwrap();
    assert!(fx.prepare(Mode::Auto).is_ok());
}

#[test]
fn custom_title_still_outranks_the_auto_title_in_listings() {
    let fx = Fixture::new();
    let prepared = fx.prepare(Mode::Auto).unwrap();
    fx.commit(&prepared, Some("🎨 登录表单｜报错提示样式"))
        .unwrap();
    fx.db
        .0
        .lock()
        .execute(
            "UPDATE sessions SET custom_title = '手动' WHERE session_id = 's1'",
            [],
        )
        .unwrap();
    let meta = crate::history::reader::list_sessions_from(&fx.db)
        .unwrap()
        .into_iter()
        .find(|s| s.session_id == "s1")
        .unwrap();
    assert_eq!(meta.custom_title.as_deref(), Some("手动"));
    assert_eq!(meta.title, "🎨 登录表单｜报错提示样式");
}

#[test]
fn removing_the_session_row_drops_its_auto_title() {
    let fx = Fixture::new();
    let prepared = fx.prepare(Mode::Auto).unwrap();
    fx.commit(&prepared, Some("🎨 登录表单｜报错提示样式"))
        .unwrap();
    fx.db
        .0
        .lock()
        .execute("DELETE FROM sessions WHERE session_id = 's1'", [])
        .unwrap();
    let count: i64 = fx
        .db
        .0
        .lock()
        .query_row("SELECT COUNT(*) FROM session_auto_titles", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn a_burst_of_settles_runs_once_after_the_last_debounce() {
    let mut slots = Slots::default();
    let key = ("claude".to_string(), "s1".to_string());
    // Claude: turn_complete, then the run's done shortly after.
    let first = slots.arm(&key);
    let second = slots.arm(&key);
    assert_eq!(
        slots.begin(&key, first),
        None,
        "superseded by the later settle"
    );
    let started = slots.begin(&key, second).expect("the last trigger runs");
    assert_eq!(slots.end(&key, started), None);
    assert!(slots.0.is_empty(), "idle sessions hold no state");
}

#[test]
fn an_older_ready_turn_cannot_skip_the_newest_debounce() {
    let mut slots = Slots::default();
    let key = ("claude".into(), "s1".into());
    let first = slots.arm(&key);
    let active = slots.begin(&key, first).unwrap();
    let ready = slots.arm(&key);
    assert_eq!(slots.begin(&key, ready), None);
    let newest = slots.arm(&key);
    assert_eq!(slots.end(&key, active), None);
    let next = slots.begin(&key, newest).expect("latest timer starts it");
    assert_eq!(slots.end(&key, next), None);
    assert!(slots.0.is_empty());
}

#[test]
fn a_late_timer_cannot_adopt_a_recreated_session_slot() {
    let key = ("claude".into(), "sid".into());
    let mut slots = Slots::default();
    let late_timer = slots.arm(&key);
    let settled = slots.arm(&key);
    let active = slots.begin(&key, settled).unwrap();
    assert_eq!(slots.end(&key, active), None);
    assert!(slots.0.is_empty());

    let fresh = slots.arm(&key);
    assert_ne!(
        fresh, late_timer,
        "removing a slot must not reuse its generation"
    );
    assert_eq!(slots.begin(&key, late_timer), None);
    let active = slots
        .begin(&key, fresh)
        .expect("only the fresh timer may begin");
    assert_eq!(slots.end(&key, active), None);
    assert!(slots.0.is_empty());
}

#[test]
fn a_turn_settling_mid_run_runs_once_more_afterwards() {
    let mut slots = Slots::default();
    let key = ("codex".to_string(), "s1".to_string());
    let armed = slots.arm(&key);
    let started = slots.begin(&key, armed).unwrap();
    let late = slots.arm(&key);
    assert_eq!(slots.begin(&key, late), None, "never two runs at once");
    let again = slots.end(&key, started).expect("re-runs for the late turn");
    assert_eq!(slots.end(&key, again), None);
    assert!(slots.0.is_empty());
}

#[test]
fn a_turn_still_debouncing_when_a_run_ends_starts_the_next_run() {
    let mut slots = Slots::default();
    let key = ("claude".to_string(), "s1".to_string());
    let armed = slots.arm(&key);
    let started = slots.begin(&key, armed).unwrap();
    let pending = slots.arm(&key); // its debounce has not elapsed yet
    assert_eq!(
        slots.end(&key, started),
        None,
        "the pending trigger owns the next run"
    );
    let next = slots
        .begin(&key, pending)
        .expect("the slot survived for it");
    assert_eq!(slots.end(&key, next), None);
    assert!(slots.0.is_empty());
}

/// Opt-in real model smoke (a few Claude requests through the production
/// side-call path and naming rules):
/// `cargo test --lib auto_title::tests::real_namer -- --ignored --nocapture`
#[tokio::test]
#[ignore = "real Claude requests; run explicitly"]
async fn real_namer_follows_the_naming_rules() {
    let schema = answer_schema();
    let cases = [
        (
            "first turn, unstructured title",
            serde_json::json!({
                "current_title": "修复登录表单的报错提示样式",
                "project_hint": "maple",
                "recent_turns": [{ "user": "修复登录表单的报错提示样式，错误文字太挤了", "assistant": "已调整报错提示的颜色和间距" }]
            }),
            None,
        ),
        (
            "stable mainline with a test/push follow-up",
            serde_json::json!({
                "current_title": "🧩 邮箱注册｜验证码过期修复",
                "recent_turns": [
                    { "user": "邮箱注册的验证码过期后还能用，帮我修一下", "assistant": "已修复过期校验" },
                    { "user": "补一个过期边界的测试", "assistant": "已添加测试" },
                    { "user": "提交并推送", "assistant": "已推送" }
                ]
            }),
            Some(validate::Decision::Keep),
        ),
        (
            "english request",
            serde_json::json!({
                "current_title": "the export button crashes when the table is empty",
                "recent_turns": [{ "user": "The CSV export button crashes when the table is empty, please fix it", "assistant": "Fixed the empty-table guard" }]
            }),
            None,
        ),
    ];
    for (name, input, expected) in cases {
        let current = input["current_title"].as_str().unwrap().to_string();
        let answer = side_call::claude_structured(side_call::StructuredCall {
            system_prompt: PROMPT,
            input: &input.to_string(),
            json_schema: &schema,
            model: DEFAULT_MODEL,
            effort: DEFAULT_EFFORT,
            timeout: MODEL_TIMEOUT,
        })
        .await
        .unwrap_or_else(|e| panic!("{name}: side call failed: {e:?}"));
        let decision = validate::decide(&answer.structured, &current);
        println!(
            "{name}: {:?} -> {decision:?} (reason: {})",
            answer.structured["action"], answer.structured["reason"]
        );
        let decision =
            decision.unwrap_or_else(|e| panic!("{name}: rejected {:?}: {e:?}", answer.structured));
        match expected {
            Some(expected) => assert_eq!(decision, expected, "{name}"),
            None => assert!(
                matches!(decision, validate::Decision::Rename(_)),
                "{name}: expected a rename"
            ),
        }
    }
}
