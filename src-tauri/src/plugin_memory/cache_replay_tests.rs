//! Real in-memory host ledgers and temporary native history; no configured
//! plugins, user settings, provider target, countTokens or generation is used.
use super::*;
use crate::plugin_memory::{automation, replay_cached};
use serde_json::json;

struct Fixture {
    db: crate::db::Db,
    root: std::path::PathBuf,
    project: String,
    source: Source,
    session: SessionRef,
    raw: Value,
    file: std::path::PathBuf,
    gate: Arc<Gate>,
}
impl Fixture {
    fn new() -> Self {
        use crate::workspace_projects::{MemberRole, ProjectInput, ProjectMemberInput};
        let db = crate::db::Db::open_in_memory().unwrap();
        let root =
            std::env::temp_dir().join(format!("ccgui-memory-replay-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.to_str().unwrap().to_owned();
        let project = {
            let mut conn = db.0.lock();
            conn.execute(
                "INSERT INTO workspaces(id,path,name) VALUES('fixture-workspace',?1,'fixture')",
                [&path],
            )
            .unwrap();
            crate::workspace_projects::save_inner(
                &mut conn,
                ProjectInput {
                    id: None,
                    name: "Fixture".into(),
                    default_path: path.clone(),
                    members: vec![ProjectMemberInput {
                        id: "member".into(),
                        path: path.clone(),
                        label: "member".into(),
                        role: MemberRole::Development,
                    }],
                },
                Some(("plugin", "game")),
            )
            .unwrap()
            .id
        };
        let source = Source {
            kind: SourceKind::Conversation,
            id: "owned-chat".into(),
        };
        let session = SessionRef {
            engine: "codex".into(),
            session_id: format!("fixture-{}", uuid::Uuid::new_v4()),
            workspace_path: path,
        };
        let raw = json!({"cancelled":false,"memoryFloorSeq":-1,
            "snapshot":{"threadId":source.id,"status":"completed","workspacePath":session.workspace_path,"sessionRef":session,"selection":{"engine":"codex"}},
            "state":{"streaming":false,"mode":"read-only","sideSessionId":session.session_id,"engine":"codex","workspacePath":session.workspace_path,
                "messages":[{"seq":0,"role":"user","text":"Use three lives."},{"seq":1,"role":"assistant","text":"Recorded."}]}});
        let file = root.join("rollout-fixture.jsonl");
        let fixture = Self {
            db,
            root,
            project,
            source,
            session,
            raw,
            file,
            gate: Arc::new(Gate::new()),
        };
        fixture.write_history(&["Use three lives.", "Recorded."]);
        fixture.db.0.lock().execute("INSERT INTO sessions(engine,session_id,workspace_path,file_path,file_size,file_mtime_ms) VALUES('codex',?1,?2,?3,0,0)",
            rusqlite::params![fixture.session.session_id,fixture.session.workspace_path,fixture.file.to_str().unwrap()]).unwrap();
        fixture.save();
        fixture
    }
    fn save(&self) {
        self.db
            .plugin_kv_set(
                "plugin",
                &format!("__host_conversations_v1:{}", self.source.id),
                &self.raw,
            )
            .unwrap();
    }
    fn write_history(&self, texts: &[&str]) {
        let mut lines=vec![json!({"type":"session_meta","payload":{"id":self.session.session_id,"cwd":self.session.workspace_path,"source":"vscode"}}).to_string()];
        for (n, text) in texts.iter().enumerate() {
            lines.push(json!({"timestamp":format!("2026-10-27T00:{:02}:{:02}Z",n/60,n%60),"type":"response_item","payload":{"type":"message","role":if n%2==0 {"user"} else {"assistant"},
                "content":[{"type":if n%2==0 {"input_text"} else {"output_text"},"text":text}]}}).to_string());
        }
        std::fs::write(&self.file, lines.join("\n")).unwrap();
    }
    fn load(&self, range: Option<&ReplayRange>) -> Result<Loaded, String> {
        load_inner(
            &self.db,
            "plugin",
            &self.project,
            &self.source,
            range.and_then(|r| r.from.as_ref()),
            false,
            &self.gate,
            self.gate.epoch(),
            range.map(|r| &r.next),
            || Ok(crate::workspace_projects::MemorySourceContext::default()),
        )
    }
    fn journal(&self) -> Vec<(String, String)> {
        let conn = self.db.0.lock();
        let mut stmt=conn.prepare("SELECT key,value FROM plugin_kv WHERE plugin_id='$ccgui-memory-automation' ORDER BY key").unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[tokio::test]
async fn cached_extract_rechecks_owned_original_range_and_never_admits_provider() {
    let mut f = Fixture::new();
    let loaded = f.load(None).unwrap();
    let selected = select(&loaded.rows, &loaded.session.session_id, None, false).unwrap();
    let range = replay_range(&loaded, None, &selected.next).unwrap();
    let identity = automation::Identity::new(
        "plugin",
        &f.project,
        "extract",
        "cached",
        json!({"source":f.source}),
    );
    automation::begin(&f.db, &identity).unwrap();
    automation::save_replay(&f.db, &identity, serde_json::to_value(&range).unwrap()).unwrap();
    let completed = json!({"status":"completed","batch":{"notes":["old proven result"]}});
    automation::complete(&f.db, &identity, &completed).unwrap();
    let journal = f.journal();
    async fn replay(f: &Fixture, id: &automation::Identity) -> Value {
        let cached = automation::lookup(&f.db, id, || Ok(())).unwrap().unwrap();
        replay_cached(cached, |snapshot| async move {
            let range: ReplayRange = serde_json::from_value(snapshot).unwrap();
            bind_replay_range(f.load(Some(&range))?, &range).map(|_| ())
        })
        .await
    }
    assert_eq!(replay(&f, &identity).await, completed);
    // A new complete turn changes the live floor/full source fence, but cannot
    // invalidate the already proven old range or consume another model call.
    f.raw["state"]["messages"].as_array_mut().unwrap().extend([
        json!({"seq":2,"role":"user","text":"Later unrelated question"}),
        json!({"seq":3,"role":"assistant","text":"Later answer"}),
    ]);
    f.raw["memoryFloorSeq"] = 1.into();
    f.save();
    assert_eq!(replay(&f, &identity).await, completed);
    let appended = f.raw.clone();
    f.raw["state"]["messages"][0]["text"] = "Use five lives instead.".into();
    f.save();
    assert_eq!(
        replay(&f, &identity).await["reason"],
        "cached_source_changed"
    );
    f.raw = appended.clone();
    f.raw["snapshot"]["sessionRef"]["sessionId"] = "rebound".into();
    f.raw["state"]["sideSessionId"] = "rebound".into();
    f.save();
    assert_eq!(
        replay(&f, &identity).await["reason"],
        "cached_source_changed"
    );
    f.raw = appended.clone();
    f.raw["state"]["workspacePath"] = "/foreign-project".into();
    f.raw["snapshot"]["workspacePath"] = "/foreign-project".into();
    f.raw["snapshot"]["sessionRef"]["workspacePath"] = "/foreign-project".into();
    f.save();
    assert_eq!(
        replay(&f, &identity).await["reason"],
        "cached_source_changed"
    );
    f.db.0
        .lock()
        .execute(
            "DELETE FROM plugin_kv WHERE plugin_id='plugin' AND key=?1",
            [format!("__host_conversations_v1:{}", f.source.id)],
        )
        .unwrap();
    assert_eq!(
        replay(&f, &identity).await["reason"],
        "cached_source_changed"
    );
    assert_eq!(
        f.journal(),
        journal,
        "cache checks must not create/dispatch/reserve or rewrite request state"
    );
}

#[tokio::test]
async fn cached_review_checks_original_native_coordinates_not_new_tail_matches() {
    let mut f = Fixture::new();
    let loaded = f.load(None).unwrap();
    let p:super::super::review::Provenance=serde_json::from_value(json!({"version":2,"scope":"game_project","hostProjectId":f.project,"memoryProjectId":"game",
        "source":f.source,"sessionRef":f.session,"fromCursor":null,"nextCursor":loaded.rows[1].cursor(&f.session.session_id,0),
        "inputDigest":"a".repeat(64),"sourceDigest":"b".repeat(64),"partial":false,"model":MODEL,
        "evidence":[{"seq":0,"role":"user","quote":"Use three lives."}]})).unwrap();
    let page = crate::history::reader::load_session_page_blocking(
        &f.db,
        "codex",
        &f.session.session_id,
        Some(500),
        None,
    )
    .unwrap();
    let native = page
        .messages
        .iter()
        .find(|m| m.text == "Use three lives.")
        .unwrap();
    let replay = ReviewReplay {
        range: replay_range(&loaded, None, &p.next_cursor).unwrap(),
        native: vec![(native.seq, native_row_digest(native))],
    };
    let identity = automation::Identity::new(
        "plugin",
        &f.project,
        "review",
        "cached",
        json!({"source":f.source}),
    );
    automation::begin(&f.db, &identity).unwrap();
    automation::save_replay(&f.db, &identity, serde_json::to_value(&replay).unwrap()).unwrap();
    let completed = json!({"status":"completed","batch":{"judgments":["old proven result"]}});
    automation::complete(&f.db, &identity, &completed).unwrap();
    let journal = f.journal();
    async fn check(
        f: &Fixture,
        id: &automation::Identity,
        p: &super::super::review::Provenance,
    ) -> Value {
        let cached = automation::lookup(&f.db, id, || Ok(())).unwrap().unwrap();
        replay_cached(cached, |snapshot| async move {
            let replay: ReviewReplay = serde_json::from_value(snapshot).unwrap();
            let loaded = bind_replay_range(f.load(Some(&replay.range))?, &replay.range)?;
            verify_review_replay_loaded(&f.db, &loaded, p, &replay, &f.gate, f.gate.epoch())
        })
        .await
    }
    assert_eq!(check(&f, &identity, &p).await, completed);
    f.raw["state"]["messages"].as_array_mut().unwrap().extend([
        json!({"seq":2,"role":"user","text":"Use three lives."}),
        json!({"seq":3,"role":"assistant","text":"A repeated later discussion."}),
    ]);
    f.raw["memoryFloorSeq"] = 1.into();
    f.save();
    f.write_history(&[
        "Use three lives.",
        "Recorded.",
        "Use three lives.",
        "A repeated later discussion.",
    ]);
    assert_eq!(check(&f, &identity, &p).await, completed);
    // Host runtime is unchanged: the native original itself must still match.
    f.write_history(&[
        "Actually use six lives.",
        "Recorded.",
        "Use three lives.",
        "A repeated later discussion.",
    ]);
    assert_eq!(
        check(&f, &identity, &p).await["reason"],
        "cached_source_changed"
    );
    f.write_history(&[
        "Use three lives.",
        "Recorded.",
        "Use three lives.",
        "A repeated later discussion.",
    ]);
    f.raw["snapshot"]["sessionRef"]["sessionId"] = "rebound".into();
    f.raw["state"]["sideSessionId"] = "rebound".into();
    f.save();
    assert_eq!(
        check(&f, &identity, &p).await["reason"],
        "cached_source_changed"
    );
    f.db.0
        .lock()
        .execute(
            "DELETE FROM plugin_kv WHERE plugin_id='plugin' AND key=?1",
            [format!("__host_conversations_v1:{}", f.source.id)],
        )
        .unwrap();
    assert_eq!(
        check(&f, &identity, &p).await["reason"],
        "cached_source_changed"
    );
    assert_eq!(f.journal(), journal);
}

#[tokio::test]
async fn preempted_cache_validation_is_pending_and_legacy_cache_is_unknown() {
    let completed = json!({"status":"completed","batch":{"secret":"must not escape"}});
    let result = replay_cached(
        automation::Cached {
            result: completed.clone(),
            replay: Some(json!({})),
        },
        |_| async { Err("preempted".into()) },
    )
    .await;
    assert_eq!(result["reason"], "cache_validation_pending");
    assert!(result.get("batch").is_none());
    let result = replay_cached(
        automation::Cached {
            result: completed,
            replay: None,
        },
        |_| async { panic!("legacy cache must not dispatch anything") },
    )
    .await;
    assert_eq!(result["reason"], "request_outcome_unknown");
}

#[test]
fn native_original_range_is_stable_when_appends_shift_page_boundaries() {
    let f = Fixture::new();
    let original: Vec<String> = (0..650)
        .map(|i| format!("Original native message {i}"))
        .collect();
    f.write_history(&original.iter().map(String::as_str).collect::<Vec<_>>());
    let page = crate::history::reader::load_session_page_blocking(
        &f.db,
        "codex",
        &f.session.session_id,
        Some(500),
        None,
    )
    .unwrap();
    let last = page.messages.last().unwrap();
    let end = Row {
        seq: last.seq,
        role: last.role.clone(),
        text: last.text.clone(),
        display_text: None,
    }
    .cursor(&f.session.session_id, 0);
    let before =
        native_range_rows(&f.db, &f.session, None, &end, &[], &f.gate, f.gate.epoch()).unwrap();
    assert_eq!(before.len(), 650);
    let expanded: Vec<String> = original
        .into_iter()
        .chain((0..500).map(|i| format!("Appended native message {i}")))
        .collect();
    f.write_history(&expanded.iter().map(String::as_str).collect::<Vec<_>>());
    let after =
        native_range_rows(&f.db, &f.session, None, &end, &[], &f.gate, f.gate.epoch()).unwrap();
    assert_eq!(
        before.iter().map(Row::digest).collect::<Vec<_>>(),
        after.iter().map(Row::digest).collect::<Vec<_>>()
    );
}
