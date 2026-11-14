use super::*;
use crate::session_spawn::{self, Caller, SessionCreateArgs};
use rusqlite::Connection;

#[test]
fn worker_without_local_relay_leaves_binding_to_parent_host() {
    adopt_session_with(None, "worker-run", "created", |_, _| {
        panic!("a worker has no local provenance store or relay identity to adopt")
    }).unwrap();
}

fn reservation(conn: &Connection, request_id: &str) -> session_spawn::Grant {
    session_spawn::ensure_schema(conn).unwrap();
    session_spawn::admit_with(conn, &Caller {
        run_id: "creator-run".into(), engine: "claude".into(),
        session_id: "creator-session".into(), workspace_path: "G:/creator".into(),
    }, &SessionCreateArgs {
        workspace_path: "G:/target".into(), engine: "codex".into(),
        message: "task".into(), request_id: request_id.into(),
        model: None, effort: None, title: None,
    }, true, 1_000, &|_| false).unwrap()
}

#[tokio::test]
async fn origin_insert_failure_keeps_restrictive_claim_and_revokes_only_its_relay() {
    let conn = Connection::open_in_memory().unwrap();
    let grant = reservation(&conn, "failed-origin");
    conn.execute_batch("CREATE TRIGGER reject_origin BEFORE INSERT ON session_spawn_origins
        BEGIN SELECT RAISE(ABORT, 'injected origin write failure'); END;").unwrap();
    let (relay, mut events, unrelated_token) = fixture(REQUEST_TIMEOUT);
    let token = relay.register(&grant.run_id, "codex", None, "G:/target").unwrap();

    let error = adopt_session_with(Some(&relay), &grant.run_id, "created", |run, session| {
        session_spawn::bind_with(&conn, run, session, 1_100)
    }).unwrap_err();
    assert!(error.contains("injected origin write failure"));
    let (session, state): (Option<String>, String) = conn.query_row(
        "SELECT session_id, state FROM session_spawn_requests WHERE run_id=?1",
        [&grant.run_id], |row| Ok((row.get(0)?, row.get(1)?)),
    ).unwrap();
    assert_eq!((session.as_deref(), state.as_str()), (Some("created"), "unknown"));
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM session_spawn_origins", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    assert!(!relay.inner.lock().runs.contains_key(&grant.run_id));
    assert!(!relay.inner.lock().tokens.contains_key(&token));
    assert!(relay.inner.lock().tokens.contains_key(&unrelated_token));
    match events.try_recv().unwrap() {
        RelayEvent::RunEnded(sender) => {
            assert_eq!(sender.run_id, grant.run_id);
            assert!(sender.session_id.is_none(), "failed binding must never adopt saved identity");
        }
        _ => panic!("expected capability invalidation"),
    }
    assert!(relay.dispatch(&token, "send_message".into(), json!({
        "session_id":"target", "message":"must not send"
    })).await.is_err());
    // Even after an uncertain outcome, replay only returns the original run.
    session_spawn::report_with(&conn, &grant.run_id, "unknown", None, Some("binding failed"), 1_200).unwrap();
    let replay = reservation(&conn, "failed-origin");
    assert_eq!(replay.mode, "replay");
    assert_eq!(replay.run_id, grant.run_id);
    assert_eq!(replay.state, "unknown");
    assert_eq!(replay.session_id.as_deref(), Some("created"));
    // A different run resuming the saved native session cannot regain either
    // cross-session capability just because the origin INSERT failed.
    let resumed = relay.register("resumed-created", "codex", Some("created"), "G:/target").unwrap();
    adopt_session_with(Some(&relay), "resumed-created", "created", |run, session| {
        session_spawn::bind_with(&conn, run, session, 1_300)
    }).unwrap();
    assert!(relay.inner.lock().tokens.contains_key(&resumed));
    assert!(session_spawn::check_send_message_with(&conn, "codex", "created").is_err());
    let caller = Caller { run_id:"resumed-created".into(), engine:"codex".into(),
        session_id:"created".into(), workspace_path:"G:/target".into() };
    let args = SessionCreateArgs { workspace_path:"G:/target".into(), engine:"claude".into(),
        message:"must not fan out".into(), request_id:"another".into(), model:None, effort:None, title:None };
    assert!(session_spawn::admit_with(&conn, &caller, &args, true, 1_300, &|_|false).is_err());
}

#[test]
fn successful_and_duplicate_bindings_adopt_without_resetting_human_promotion() {
    let conn = Connection::open_in_memory().unwrap();
    let grant = reservation(&conn, "success");
    let (relay, _events, _) = fixture(REQUEST_TIMEOUT);
    let token = relay.register(&grant.run_id, "codex", None, "G:/target").unwrap();
    for now in [1_100, 1_200] {
        adopt_session_with(Some(&relay), &grant.run_id, "created", |run, session| {
            session_spawn::bind_with(&conn, run, session, now)
        }).unwrap();
    }
    assert_eq!(relay.inner.lock().runs[&grant.run_id].sender.session_id.as_deref(), Some("created"));
    assert!(relay.inner.lock().tokens.contains_key(&token));
    assert!(session_spawn::check_send_message_with(&conn, "codex", "created").is_err());
    assert_eq!(reservation(&conn, "success").state, "running");
    session_spawn::promote_with(&conn, "codex", "created", 1_300).unwrap();
    session_spawn::bind_with(&conn, &grant.run_id, "created", 1_400).unwrap();
    session_spawn::check_send_message_with(&conn, "codex", "created").unwrap();
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM session_spawn_origins", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
}

#[test]
fn binding_cannot_reuse_another_runs_promoted_origin() {
    let conn = Connection::open_in_memory().unwrap();
    let first = reservation(&conn, "first");
    session_spawn::bind_with(&conn, &first.run_id, "created", 1_100).unwrap();
    session_spawn::promote_with(&conn, "codex", "created", 1_200).unwrap();
    let second = reservation(&conn, "second");
    assert!(session_spawn::bind_with(&conn, &second.run_id, "created", 1_300).unwrap_err().contains("conflicts"));
    assert_eq!(reservation(&conn, "second").session_id.as_deref(), Some("created"));
    assert_eq!(reservation(&conn, "second").state, "unknown");
    assert_eq!(reservation(&conn, "first").session_id.as_deref(), Some("created"));
}

#[test]
fn failed_origin_claim_survives_a_new_database_connection() {
    let path = std::env::temp_dir().join(format!("ccgui-origin-recovery-{}.db", uuid::Uuid::new_v4()));
    let conn = Connection::open(&path).unwrap();
    let grant = reservation(&conn, "restart");
    conn.execute_batch("CREATE TRIGGER reject_origin BEFORE INSERT ON session_spawn_origins
        BEGIN SELECT RAISE(ABORT, 'injected origin write failure'); END;").unwrap();
    assert!(session_spawn::bind_with(&conn, &grant.run_id, "saved-created", 1_100).is_err());
    drop(conn);
    let reopened = Connection::open(&path).unwrap();
    assert!(session_spawn::check_send_message_with(&reopened, "codex", "saved-created").is_err());
    // A recovered successful write preserves the restriction until explicit
    // human takeover; replaying a request never starts a second run.
    reopened.execute_batch("DROP TRIGGER reject_origin").unwrap();
    session_spawn::bind_with(&reopened, &grant.run_id, "saved-created", 1_200).unwrap();
    assert!(session_spawn::check_send_message_with(&reopened, "codex", "saved-created").is_err());
    session_spawn::promote_with(&reopened, "codex", "saved-created", 1_300).unwrap();
    session_spawn::check_send_message_with(&reopened, "codex", "saved-created").unwrap();
    drop(reopened);
    std::fs::remove_file(path).unwrap();
}

#[test]
fn failed_identity_claim_holds_unclassified_chats_until_recovery_or_human_input() {
    let conn = Connection::open_in_memory().unwrap();
    let grant = reservation(&conn, "failed-claim");
    conn.execute_batch("CREATE TRIGGER reject_claim BEFORE UPDATE ON session_spawn_requests
        BEGIN SELECT RAISE(ABORT, 'injected identity claim failure'); END;").unwrap();
    assert!(session_spawn::bind_with(&conn, &grant.run_id, "created", 1_100).is_err());
    assert!(session_spawn::check_send_message_with(&conn, "codex", "created").is_err());
    assert!(session_spawn::check_send_message_with(&conn, "codex", "unclassified").is_err());
    conn.execute_batch("DROP TRIGGER reject_claim").unwrap();
    session_spawn::promote_with(&conn, "codex", "created", 1_200).unwrap();
    session_spawn::check_send_message_with(&conn, "codex", "created").unwrap();
    assert!(session_spawn::check_send_message_with(&conn, "codex", "unclassified").is_err());
    session_spawn::bind_with(&conn, &grant.run_id, "created", 1_300).unwrap();
    session_spawn::check_send_message_with(&conn, "codex", "created").unwrap();
    session_spawn::check_send_message_with(&conn, "codex", "unclassified").unwrap();
}
