use super::*;
use crate::engine::ChildEntry;
use std::sync::atomic::{AtomicI64, Ordering};

#[derive(Default)]
struct FakeEmitter(Mutex<Vec<String>>);
impl Emit for FakeEmitter {
    fn emit_json(&self, name: &str, _payload: &str) {
        self.0.lock().push(name.into());
    }
}

struct Fixture {
    manager: Arc<LeaderManager>,
    clock: Arc<AtomicI64>,
    emitter: Arc<FakeEmitter>,
    caller: Caller,
    parent: LeaderIdentity,
}

fn reservation(run_id: &str) -> ChildEntry {
    ChildEntry {
        child: None,
        pid: 0,
        run_id: run_id.into(),
        killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        reader_abort: Arc::new(OnceLock::new()),
        stdin: None,
        questions: Arc::new(std::sync::Mutex::new(HashMap::new())),
        plans: Arc::new(std::sync::Mutex::new(HashMap::new())),
        native_tasks: Default::default(),
        codex_control: None,
    }
}

fn fixture(delete: Arc<Delete>) -> Fixture {
    fixture_with_engine(delete, "claude")
}

fn fixture_with_engine(delete: Arc<Delete>, engine: &str) -> Fixture {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE workspaces(id TEXT,path TEXT,meta TEXT);
        CREATE TABLE sessions(engine TEXT,session_id TEXT,workspace_path TEXT,file_path TEXT NOT NULL DEFAULT '',
            file_size INTEGER NOT NULL DEFAULT 0,file_mtime_ms INTEGER NOT NULL DEFAULT 0,title TEXT NOT NULL DEFAULT '',preview TEXT NOT NULL DEFAULT '',
            created_at INTEGER,updated_at INTEGER,message_count INTEGER NOT NULL DEFAULT 0,pinned INTEGER NOT NULL DEFAULT 0,custom_title TEXT,
            PRIMARY KEY(engine,session_id));
        CREATE TABLE session_archives(engine TEXT,session_id TEXT,workspace_path TEXT NOT NULL DEFAULT '',snapshot_json TEXT NOT NULL DEFAULT '{}',archived_at INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(engine,session_id));
        CREATE TABLE session_models(engine TEXT,session_id TEXT,model TEXT);
        CREATE TABLE session_efforts(engine TEXT,session_id TEXT,effort TEXT);
        CREATE TABLE session_claude_options(session_id TEXT PRIMARY KEY,ultracode INTEGER,updated_at INTEGER);
        CREATE TABLE session_providers(engine TEXT,session_id TEXT,provider_id TEXT);
        CREATE TABLE plugin_kv(plugin_id TEXT,key TEXT,value TEXT,PRIMARY KEY(plugin_id,key));
        CREATE TABLE session_auto_titles(engine TEXT,session_id TEXT,title TEXT);",
    )
    .unwrap();
    let db = Arc::new(Db(Mutex::new(conn)));
    ensure_schema(&db).unwrap();
    let parent = identity(engine, "parent-session", "known-local-workspace");
    db.0.lock()
        .execute(
            "INSERT INTO leader_roles(engine,session_id,workspace_path) VALUES(?1,?2,?3)",
            params![parent.engine, parent.session_id, parent.workspace_path],
        )
        .unwrap();
    let clock = Arc::new(AtomicI64::new(1_000_000));
    let clock_read = Arc::clone(&clock);
    let emitter = Arc::new(FakeEmitter::default());
    let processes = Arc::new(crate::engine::ProcessRegistry::default());
    let manager = Arc::new(
        LeaderManager::with_services(
            db,
            processes,
            emitter.clone(),
            Arc::new(move || clock_read.load(Ordering::SeqCst)),
            delete,
        )
        .unwrap(),
    );
    let caller = Caller {
        run_id: "parent-run".into(),
        engine: parent.engine.clone(),
        session_id: parent.session_id.clone(),
        workspace_path: parent.workspace_path.clone(),
    };
    manager
        .processes
        .insert(caller.run_id.clone(), reservation(&caller.run_id));
    assert!(manager
        .prepare(
            &caller.run_id,
            &caller.engine,
            Some(&caller.session_id),
            &caller.workspace_path,
            Some("manual")
        )
        .unwrap()
        .is_some());
    Fixture {
        manager,
        clock,
        emitter,
        caller,
        parent,
    }
}

fn basic() -> Fixture {
    fixture(Arc::new(|_, _, _| Ok(())))
}

fn user_delete_tree(f: &Fixture) -> (String, String, String, String) {
    save_group_session(f, &f.parent, "Root", "");
    let (child, run) = spawn(f, "delete-child");
    observe(f, &run, "delete-child-session", "session", json!("delete-child-session"), 1);
    f.manager.processes.insert(run.clone(), reservation(&run));
    let caller = Caller {
        run_id: run.clone(), engine: "codex".into(), session_id: "delete-child-session".into(),
        workspace_path: f.parent.workspace_path.clone(),
    };
    let parent = identity("codex", "delete-child-session", &f.parent.workspace_path);
    let args = args("delete-grandchild");
    let Reservation::Start((grand, grand_run)) = f.manager.reserve_spawn(
        &caller, &parent, "manual", &args, encoded(&args).unwrap(), None, None,
    ).unwrap() else { panic!("unexpected replay"); };
    settle(f, &grand, &grand_run, "delete-grand-session");
    f.manager.processes.remove_reservation(&run);
    settle(f, &child, &run, "delete-child-session");
    let (sibling, sibling_run) = spawn(f, "delete-sibling");
    settle(f, &sibling, &sibling_run, "delete-sibling-session");
    (child, grand, sibling, run)
}

#[tokio::test]
async fn user_branch_delete_leaf_and_subtree_preserve_parent_and_siblings() {
    for leaf in [true, false] {
        let (f, deleted) = recording_fixture();
        let (child, grand, sibling, _) = user_delete_tree(&f);
        let (parent, target, expected) = if leaf {
            (identity("codex", "delete-child-session", &f.parent.workspace_path), grand.clone(), vec![grand.clone()])
        } else {
            (f.parent.clone(), child.clone(), vec![child.clone(), grand.clone()])
        };
        // Root remains running; it is not part of the selected subtree.
        let snapshot = f.manager.delete_branch_for_user(&parent, &target, &expected).await.unwrap();
        assert_eq!(branch(&f, &grand).state, "reclaimed");
        assert_eq!(branch(&f, &child).state, if leaf { "completed" } else { "reclaimed" });
        assert_eq!(branch(&f, &sibling).state, "completed");
        assert!(snapshot.leaders.iter().any(|root| root == &f.parent));
        assert!(f.manager.processes.get(&f.caller.run_id).is_some());
        assert_eq!(*deleted.lock(), if leaf { vec!["delete-grand-session"] } else { vec!["delete-grand-session", "delete-child-session"] });
        assert!(f.manager.inner.lock().retiring.is_empty());
    }
}

#[tokio::test]
async fn user_branch_delete_rejects_wrong_owner_workspace_and_confirmation_scope() {
    let (f, deleted) = recording_fixture();
    let (child, grand, _, _) = user_delete_tree(&f);
    let ids = vec![child.clone(), grand.clone()];
    for parent in [identity("codex", "foreign", &f.parent.workspace_path), identity("claude", &f.parent.session_id, "other-workspace")] {
        assert!(f.manager.delete_branch_for_user(&parent, &child, &ids).await.is_err());
    }
    for expected in [vec![child.clone()], vec![child.clone(), grand.clone(), "extra".into()], vec![child.clone(), grand.clone(), grand.clone()]] {
        assert!(f.manager.delete_branch_for_user(&f.parent, &child, &expected).await.unwrap_err().contains("confirmation"));
    }
    save_group_session(&f, &identity("codex", "delete-grand-session", "wrong-workspace"), "Foreign", "");
    assert!(f.manager.delete_branch_for_user(&f.parent, &child, &ids).await.unwrap_err().contains("workspace"));
    assert!(deleted.lock().is_empty());
    assert_eq!(branch(&f, &child).state, "completed");
}

#[tokio::test]
async fn user_branch_delete_rejects_active_pending_binding_launch_and_retirement() {
    for fence in ["running", "waiting", "stopping", "reclaiming", "process", "launch", "binding", "retiring", "shutdown"] {
        let (f, deleted) = recording_fixture();
        let (child, grand, _, _) = user_delete_tree(&f);
        let run = branch(&f, &grand).run_id.unwrap();
        {
            let mut inner = f.manager.inner.lock();
            match fence {
                "running" | "waiting" | "reclaiming" => inner.branches.get_mut(&grand).unwrap().branch.state = fence.into(),
                "stopping" => inner.branches.get_mut(&grand).unwrap().stopping = true,
                "process" => { f.manager.processes.insert(run.clone(), reservation(&run)); },
                "launch" => { let run = inner.runs.get_mut(&run).unwrap(); run.retired = false; run.launch_pending = true; },
                "binding" => { inner.pending_bindings.insert(run.clone(), ("codex".into(), "uncommitted".into())); },
                "retiring" => { inner.retiring.insert(("codex".into(), "delete-grand-session".into())); },
                "shutdown" => inner.shutdown = true,
                _ => unreachable!(),
            }
        }
        assert!(f.manager.delete_branch_for_user(&f.parent, &child, &[child.clone(), grand]).await.is_err(), "{fence}");
        assert!(deleted.lock().is_empty(), "{fence}");
        if fence == "process" {
            assert!(!f.manager.processes.get(&run).unwrap().killed.load(Ordering::SeqCst));
        }
    }
}

#[tokio::test]
async fn user_branch_delete_rejects_archived_group_and_corrupt_ownership() {
    for corrupt in ["archive", "duplicate", "cycle", "cross-workspace"] {
        let (f, deleted) = recording_fixture();
        let (child, grand, sibling, _) = user_delete_tree(&f);
        if corrupt == "archive" {
            idle_group_root(&f);
            f.manager.archive_group(&f.parent).unwrap();
        } else {
            let mut inner = f.manager.inner.lock();
            match corrupt {
                "duplicate" => inner.branches.get_mut(&sibling).unwrap().branch.session_id = Some("delete-grand-session".into()),
                "cycle" => inner.branches.get_mut(&grand).unwrap().branch.session_id = Some(f.parent.session_id.clone()),
                "cross-workspace" => inner.branches.get_mut(&grand).unwrap().branch.workspace_path = "foreign".into(),
                _ => unreachable!(),
            }
            if corrupt == "cycle" { inner.branches.get_mut(&grand).unwrap().branch.engine = f.parent.engine.clone(); }
        }
        assert!(f.manager.delete_branch_for_user(&f.parent, &child, &[child.clone(), grand]).await.is_err(), "{corrupt}");
        assert!(deleted.lock().is_empty());
    }
}

#[tokio::test]
async fn user_branch_delete_partial_failure_retries_and_late_events_cannot_revive() {
    let deleted = Arc::new(Mutex::new(Vec::new()));
    let seen = deleted.clone();
    let fail = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let fail_delete = fail.clone();
    let f = fixture(Arc::new(move |_, _, session| {
        if session == "delete-child-session" && fail_delete.load(Ordering::SeqCst) {
            return Err("transcript locked".into());
        }
        seen.lock().push(session.to_string());
        Ok(())
    }));
    let (child, grand, sibling, run) = user_delete_tree(&f);
    assert!(f.manager.delete_branch_for_user(&f.parent, &child, &[child.clone(), grand.clone()]).await.unwrap_err().contains("locked"));
    assert_eq!(branch(&f, &grand).state, "reclaimed");
    assert_eq!(branch(&f, &child).state, "unknown");
    assert_eq!(branch(&f, &sibling).state, "completed");
    assert!(f.manager.inner.lock().retiring.is_empty());
    observe(&f, &run, "delete-child-session", "delta", json!("late content"), 100);
    assert_eq!(branch(&f, &child).state, "unknown");
    assert!(!branch(&f, &child).result.contains("late content"));
    fail.store(false, Ordering::SeqCst);
    f.manager.delete_branch_for_user(&f.parent, &child, &[child.clone()]).await.unwrap();
    observe(&f, &run, "delete-child-session", "question", json!({"requestId":"late"}), 101);
    assert_eq!(branch(&f, &child).state, "reclaimed");
    assert_eq!(*deleted.lock(), vec!["delete-grand-session", "delete-child-session"]);
    assert_eq!(reload(&f).unwrap().inner.lock().branches[&child].branch.state, "reclaimed");
}

#[tokio::test]
async fn user_branch_delete_atomic_fence_blocks_resume_descendants_and_group_actions() {
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let started = Mutex::new(Some(started_tx));
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let release = Mutex::new(release_rx);
    let f = fixture(Arc::new(move |_, _, _| {
        if let Some(started) = started.lock().take() {
            let _ = started.send(());
            release.lock().recv_timeout(Duration::from_secs(10)).map_err(|e| e.to_string())?;
        }
        Ok(())
    }));
    let (child, grand, _, run) = user_delete_tree(&f);
    let manager = f.manager.clone();
    let parent = f.parent.clone();
    let target = child.clone();
    let expected = vec![child.clone(), grand.clone()];
    let deleting = tokio::spawn(async move { manager.delete_branch_for_user(&parent, &target, &expected).await });
    tokio::time::timeout(Duration::from_secs(10), started_rx).await.unwrap().unwrap();
    assert!(f.manager.prepare("concurrent-resume", "codex", Some("delete-grand-session"), &f.parent.workspace_path, None).is_err());
    assert!(f.manager.prepare_isolated("isolated-resume", "codex", Some("delete-grand-session"), &f.parent.workspace_path, &launch_marker()).is_err());
    assert!(f.manager.delete_branch_for_user(&f.parent, &child, &[child.clone(), grand]).await.is_err());
    idle_group_root(&f);
    assert!(f.manager.archive_group(&f.parent).is_err());
    let caller = Caller { run_id: run, engine: "codex".into(), session_id: "delete-child-session".into(), workspace_path: f.parent.workspace_path.clone() };
    let args = args("concurrent-descendant");
    assert!(f.manager.reserve_spawn(&caller, &identity("codex", "delete-child-session", &f.parent.workspace_path), "manual", &args, encoded(&args).unwrap(), None, None).is_err());
    release_tx.send(()).unwrap();
    deleting.await.unwrap().unwrap();
    assert!(f.manager.inner.lock().retiring.is_empty());
}

#[test]
fn ordinary_task_parents_ignore_legacy_flags_but_cannot_manage_each_others_children() {
    let f = basic();
    f.manager.db.0.lock().execute("UPDATE leader_roles SET enabled=0", []).unwrap();
    let other = Caller { run_id: "ordinary-other".into(), engine: "claude".into(),
        session_id: "ordinary-other-session".into(), workspace_path: f.parent.workspace_path.clone() };
    f.manager.processes.insert(other.run_id.clone(), reservation(&other.run_id));
    assert_eq!(f.manager.prepare(&other.run_id, &other.engine, Some(&other.session_id),
        &other.workspace_path, Some("plan")).unwrap(), Some(role(false)));
    let (other_parent, permission) = f.manager.authorize(&f.manager.inner.lock(), &other).unwrap();
    assert_eq!(permission, "plan");
    let (parent, permission) = f.manager.authorize(&f.manager.inner.lock(), &f.caller).unwrap();
    assert_eq!(permission, "manual");
    let (id, _) = spawn(&f, "disabled-flag-child");
    let child_args = args("ordinary-child");
    let Reservation::Start((other_id, _)) = f.manager.reserve_spawn(&other, &other_parent, "plan",
        &child_args, encoded(&child_args).unwrap(), None, None).unwrap() else { panic!("unexpected replay") };
    let inner = f.manager.inner.lock();
    assert!(f.manager.child(&inner, &parent, &id).is_ok());
    assert!(f.manager.child(&inner, &other_parent, &other_id).is_ok());
    assert!(f.manager.child(&inner, &parent, &other_id).err().unwrap().contains("direct parent"));
    assert!(f.manager.child(&inner, &other_parent, &id).err().unwrap().contains("direct parent"));
    let mut forged = other.clone();
    forged.session_id = f.caller.session_id.clone();
    assert!(f.manager.authorize(&inner, &forged).is_err());
}

#[test]
fn legacy_empty_role_creates_neither_task_group_nor_deletion_protection() {
    let f = basic();
    assert!(f.manager.snapshot().unwrap().leaders.is_empty());
    assert!(ensure_unmanaged(&f.manager.db, &f.parent.engine, &f.parent.session_id).is_ok());
    f.manager.finish(&f.caller.run_id);
    f.manager.processes.remove_reservation(&f.caller.run_id);
    let guard = f.manager.begin_retirement(&f.parent.engine, &f.parent.session_id).unwrap();
    drop(guard);
    let restarted = reload(&f).unwrap();
    assert!(restarted.snapshot().unwrap().leaders.is_empty());
}

#[test]
fn task_methods_preserve_idempotency_and_reject_retired_leader_tools() {
    let f = basic();
    let a = args("task-shared");
    let raw = encoded(&a).unwrap();
    assert_eq!(validate_arguments("task_spawn", raw.clone()).unwrap(), raw);
    let (id, _) = spawn_with_args(&f, &a);
    for _ in 0..2 {
        let inner = f.manager.inner.lock();
        let replay = f.manager.replay(&inner, &f.parent, &a.request_id,
            "task_spawn", &raw).unwrap().unwrap();
        assert_eq!(replay["branch"]["id"], id);
    }
    assert_eq!(f.manager.inner.lock().branches.len(), 1);
    let mut changed = raw.clone(); changed["task"] = json!("Different task");
    assert!(f.manager.replay(&f.manager.inner.lock(), &f.parent, &a.request_id,
        "task_spawn", &changed).is_err());
    for suffix in ["spawn", "list", "wait", "send", "renew", "stop"] {
        assert!(is_method(&format!("task_{suffix}")));
        let retired = format!("leader_{suffix}");
        assert!(!is_method(&retired));
        assert!(validate_arguments(&retired, raw.clone()).is_err());
    }
    assert!(!is_method("leader_reclaim"));
}

#[test]
fn legacy_request_methods_migrate_durably_without_restarting_spawn_or_send() {
    let f = basic();
    let spawn_args = args("migrated-spawn");
    let (id, run) = spawn_with_args(&f, &spawn_args);
    settle(&f, &id, &run, "migrated-child");
    f.manager.acknowledge(&f.parent, &spawn_args.request_id, &run,
        Ok(crate::engine::SendResult { run_id: run.clone(), session_id: Some("migrated-child".into()) })).unwrap();
    let send_args = SendArgs { branch_id: id.clone(), request_id: "migrated-send".into(), message: "Continue the same task".into() };
    hot_send_cache(&f, &id);
    let Reservation::Start((_, send_run)) = f.manager.reserve_send(&f.caller, &f.parent, "manual",
        &send_args, encoded(&send_args).unwrap()).unwrap() else { panic!("unexpected replay") };
    observe(&f, &send_run, "migrated-child", "message", json!({"role":"assistant","text":"Retained migration result"}), 1);
    observe(&f, &send_run, "migrated-child", "done", json!({}), 2);
    f.manager.finish(&send_run);
    f.manager.acknowledge(&f.parent, &send_args.request_id, &send_run,
        Ok(crate::engine::SendResult { run_id: send_run.clone(), session_id: Some("migrated-child".into()) })).unwrap();
    let expected: Vec<_> = {
        let inner = f.manager.inner.lock();
        [(&spawn_args.request_id, "leader_spawn"), (&send_args.request_id, "leader_send")]
            .into_iter().map(|(request_id, legacy_method)| {
                let request = inner.requests[&(key(&f.parent), request_id.clone())].clone();
                let mut legacy = request.clone();
                legacy.method = legacy_method.into();
                write_request(&f.manager.db.0.lock(), &legacy).unwrap();
                request
            }).collect()
    };
    let recovered = reload(&f).unwrap();
    for request in &expected {
        let actual = recovered.inner.lock().requests[&(key(&f.parent), request.request_id.clone())].clone();
        assert_eq!(encoded(&actual).unwrap(), encoded(request).unwrap(), "migration must only rename the persisted method");
        let stored: String = f.manager.db.0.lock().query_row(
            "SELECT record_json FROM leader_requests WHERE request_id=?1", [&request.request_id], |row| row.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(), encoded(request).unwrap());
    }
    recovered.processes.insert(f.caller.run_id.clone(), reservation(&f.caller.run_id));
    recovered.prepare(&f.caller.run_id, &f.caller.engine, Some(&f.caller.session_id),
        &f.caller.workspace_path, Some("manual")).unwrap();
    assert!(matches!(recovered.reserve_spawn(&f.caller, &f.parent, "manual", &spawn_args,
        encoded(&spawn_args).unwrap(), None, None).unwrap(), Reservation::Replay(_)));
    let Reservation::Replay(reply) = recovered.reserve_send(&f.caller, &f.parent, "manual",
        &send_args, encoded(&send_args).unwrap()).unwrap() else { panic!("migrated send relaunched") };
    assert_eq!(reply["branch"]["result"], "Retained migration result");
    let inner = recovered.inner.lock();
    assert_eq!(inner.branches.len(), 1);
    assert_eq!(inner.requests.len(), 2);
    assert_eq!(inner.branches[&id].branch.run_id.as_deref(), Some(send_run.as_str()));
    drop(inner);
    let restarted = reload(&f).unwrap();
    for request in &expected {
        assert_eq!(encoded(&restarted.inner.lock().requests[&(key(&f.parent), request.request_id.clone())]).unwrap(),
            encoded(request).unwrap());
    }
}

fn worker_proxy(manager: &LeaderManager, run_id: &str) {
    let mut entry = reservation(run_id);
    entry.pid = 42;
    manager.processes.insert(run_id.into(), entry);
}

#[test]
fn worker_task_capsule_restores_frozen_permissions_and_rejects_invalid_ownership() {
    for permission in ["plan", "manual", "bypass"] {
        let f = basic();
        let run_id = format!("worker-{permission}");
        worker_proxy(&f.manager, &run_id);
        f.manager.prepare(&run_id, "claude", Some("worker-session"), &f.parent.workspace_path, Some(permission)).unwrap();
        let saved = f.manager.capture_worker_registration(&run_id).unwrap();
        let recovered = reload(&f).unwrap();
        assert!(recovered.restore_worker_registration(&saved).unwrap_err().contains("no live routing proxy"));
        recovered.processes.insert(run_id.clone(), reservation(&run_id));
        assert!(recovered.restore_worker_registration(&saved).unwrap_err().contains("not active"));
        worker_proxy(&recovered, &run_id);
        recovered.restore_worker_registration(&saved).unwrap();
        let caller = Caller { run_id: run_id.clone(), engine: "claude".into(),
            session_id: "worker-session".into(), workspace_path: f.parent.workspace_path.clone() };
        assert_eq!(recovered.authorize(&recovered.inner.lock(), &caller).unwrap().1, permission);
        recovered.restore_worker_registration(&saved).unwrap();
        let mut changed = saved.clone(); changed.session_id = Some("different-session".into());
        assert!(recovered.restore_worker_registration(&changed).unwrap_err().contains("conflicts"));
        let mut changed = saved.clone(); changed.permission = if permission == "plan" { "bypass" } else { "plan" }.into();
        assert!(recovered.restore_worker_registration(&changed).unwrap_err().contains("conflicts"));
        assert!(!saved.matches_origin(&run_id, "codex", &caller.workspace_path, Some(&caller.session_id)));
        recovered.finish(&run_id);
        assert!(recovered.capture_worker_registration(&run_id).is_none());
        assert!(recovered.restore_worker_registration(&saved).unwrap_err().contains("conflicts"));
    }
}

#[test]
fn worker_task_capsule_preserves_first_root_baseline_and_unscanned_provenance() {
    let f = basic();
    let (_workspace, caller) = first_root_with_saved(&f, "worker-new-root", &["existing-before-worker"]);
    let saved = f.manager.capture_worker_registration(&caller.run_id).unwrap();
    let recovered = reload(&f).unwrap();
    worker_proxy(&recovered, &caller.run_id);
    recovered.restore_worker_registration(&saved).unwrap();
    assert!(recovered.bind_session(&caller.run_id, &caller.engine, "existing-before-worker").is_err());
    recovered.bind_session(&caller.run_id, &caller.engine, &caller.session_id).unwrap();
    recovered.processes.rekey(&caller.run_id, caller.session_id.clone()).unwrap();
    recovered.commit_binding(&caller.run_id, &caller.engine, &caller.session_id).unwrap();
    let bound = recovered.capture_worker_registration(&caller.run_id).unwrap();
    assert!(bound.verified_new_root);
    assert!(!bound.root_on_start);
    assert_eq!(f.manager.db.0.lock().query_row("SELECT COUNT(*) FROM sessions WHERE session_id=?1",
        [&caller.session_id], |r| r.get::<_, i64>(0)).unwrap(), 0);
    let next = reload(&f).unwrap();
    worker_proxy(&next, &caller.run_id);
    next.restore_worker_registration(&bound).unwrap();
    let (parent, permission) = next.authorize(&next.inner.lock(), &caller).unwrap();
    assert_eq!(permission, "manual");
    assert!(next.inner.lock().verified_new_roots.contains_key(&key(&parent)));
    validate_parent(&next.db, &parent, true).unwrap();
    assert!(next.snapshot().unwrap().leaders.is_empty());
}

#[test]
fn published_task_capability_uses_trusted_run_without_a_mode_flag() {
    let f = basic();
    assert!(f.manager.run_has_task_capability(&f.caller.run_id));
    assert!(!f.manager.run_has_task_capability("forged-run"));
    assert_eq!(f.manager.prepare("ordinary-mode", "claude", Some("ordinary-session"),
        &f.parent.workspace_path, Some("manual")).unwrap(), Some(role(false)));
    assert!(f.manager.inner.lock().runs["ordinary-mode"].leader_eligible);
    assert!(!f.manager.run_has_task_capability("ordinary-mode"));
    f.manager.processes.insert("ordinary-mode".into(), reservation("ordinary-mode"));
    assert!(f.manager.run_has_task_capability("ordinary-mode"));
    let ordinary = Caller { run_id: "ordinary-mode".into(), engine: "claude".into(),
        session_id: "ordinary-session".into(), workspace_path: f.parent.workspace_path.clone() };
    let (parent, permission) = f.manager.authorize(&f.manager.inner.lock(), &ordinary).unwrap();
    assert_eq!(parent.session_id, ordinary.session_id);
    assert_eq!(permission, "manual");

    let (_workspace, root) = first_root(&f, "unbound-mode-root");
    assert!(f.manager.inner.lock().runs[&root.run_id].session_id.is_none());
    assert!(f.manager.run_has_task_capability(&root.run_id));
    let (_, child_run) = spawn(&f, "mode-child");
    assert!(f.manager.run_has_task_capability(&child_run));
    f.manager.inner.lock().runs.get_mut(&child_run).unwrap().retired = true;
    assert!(!f.manager.run_has_task_capability(&child_run));
}

#[test]
fn workspace_separator_keys_preserve_authority_boundaries() {
    assert_eq!(same_workspace(r"G:\project\repo", "G:/project/repo"), cfg!(windows));
    assert_eq!(same_workspace(r"G:\\project\\repo", "G:/project/repo"), cfg!(windows));
    assert_eq!(same_workspace("G://project///repo", "G:/project/repo"), cfg!(windows));
    assert_eq!(same_workspace(r"G:\/project/\repo", "G:/project/repo"), cfg!(windows));
    assert_eq!(same_workspace("G:////", "G:/"), cfg!(windows));
    assert!(!same_workspace("G:/project/repo", "G:/project/repo/"));
    assert!(!same_workspace("/tmp/a//b", "/tmp/a/b"));
    assert!(!same_workspace(r"G:repo\\child", r"G:repo\child"));
    assert!(!same_workspace(r"\\server\share", r"\\server\\share"));
    assert!(!same_workspace(r"/tmp/a\b", "/tmp/a/b"));
    assert!(!same_workspace("G:/repo", "g:/repo"));
    assert!(!same_workspace("G:/repo", "G:/repo/child"));
    assert!(!same_workspace("G:/repo", "G:/other/../repo"));
    assert!(!same_workspace(r"G:repo\child", "G:repo/child"));
    assert!(!same_workspace(r"\\server\share", "//server/share"));
}

#[cfg(windows)]
#[test]
fn windows_saved_parent_accepts_separator_variants_but_not_other_directories() {
    let f = basic();
    let (_dir, caller) = first_root(&f, "separator-parent");
    let slash = caller.workspace_path.replace('\\', "/");
    f.manager.db.0.lock().execute("UPDATE workspaces SET path=?1", [&slash]).unwrap();
    f.manager.db.0.lock().execute("INSERT INTO sessions(engine,session_id,workspace_path) VALUES(?1,?2,?3)",
        params![caller.engine, caller.session_id, caller.workspace_path]).unwrap();
    for path in [&caller.workspace_path, &slash] {
        validate_parent(&f.manager.db, &identity(&caller.engine, &caller.session_id, path), false).unwrap();
    }
    for suffix in ["/child", "-other"] {
        let other = format!("{slash}{suffix}");
        f.manager.db.0.lock().execute("UPDATE sessions SET workspace_path=?1", [&other]).unwrap();
        assert!(validate_parent(&f.manager.db, &identity(&caller.engine, &caller.session_id, &slash), false).is_err());
    }
    assert!(validate_workspace(&f.manager.db, &format!("{slash}/child")).is_err());
}

#[cfg(windows)]
#[test]
fn windows_first_root_accepts_scanning_before_and_after_binding() {
    for before in [true, false] {
        let f = basic();
        let (_dir, mut caller) = first_root(&f, "separator-first");
        let native = caller.workspace_path.clone();
        caller.workspace_path = native.replace('\\', "/");
        f.manager.db.0.lock().execute("UPDATE workspaces SET path=?1", [&caller.workspace_path]).unwrap();
        f.manager.inner.lock().runs.get_mut(&caller.run_id).unwrap().workspace_path = caller.workspace_path.clone();
        let index = || f.manager.db.0.lock().execute("INSERT INTO sessions(engine,session_id,workspace_path) VALUES(?1,?2,?3)",
            params![caller.engine, caller.session_id, native]).unwrap();
        if before { index(); }
        f.manager.bind_session(&caller.run_id, &caller.engine, &caller.session_id).unwrap();
        f.manager.processes.rekey(&caller.run_id, caller.session_id.clone()).unwrap();
        f.manager.commit_binding(&caller.run_id, &caller.engine, &caller.session_id).unwrap();
        if !before { index(); }
        f.manager.checkpoint().unwrap();
        assert!(f.manager.inner.lock().verified_new_roots.is_empty());
        caller.workspace_path = native;
        let (parent, _) = f.manager.authorize(&f.manager.inner.lock(), &caller).unwrap();
        validate_parent(&f.manager.db, &parent, false).unwrap();
    }
}

#[cfg(windows)]
#[test]
fn windows_legacy_roles_deduplicate_but_neither_flag_restores_authority() {
    let f = basic();
    let slash = identity("codex", "variant-role", "G:/project/repo");
    let native = identity("codex", "variant-role", r"G:\project\repo");
    {
        let mut conn = f.manager.db.0.lock();
        write_role(&mut conn, &slash, true).unwrap();
        write_role(&mut conn, &native, false).unwrap();
        assert!(!role_enabled(&conn, &slash).unwrap());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM leader_roles WHERE session_id='variant-role'", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        conn.execute("INSERT INTO leader_roles VALUES(?1,?2,?3,1)", params![slash.engine, slash.session_id, slash.workspace_path]).unwrap();
        assert!(!role_enabled(&conn, &slash).unwrap());
    }
    let restarted = LeaderManager::with_services(f.manager.db.clone(), f.manager.processes.clone(),
        f.emitter.clone(), Arc::new(now_ms), Arc::new(|_, _, _| Ok(()))).unwrap();
    assert!(!restarted.inner.lock().leaders.contains_key(&key(&slash)));
    assert!(!restarted.inner.lock().disabled.contains(&key(&native)));
    assert!(restarted.snapshot().unwrap().leaders.is_empty());
    write_role(&mut f.manager.db.0.lock(), &slash, true).unwrap();
    assert!(role_enabled(&f.manager.db.0.lock(), &native).unwrap());
}

#[cfg(windows)]
#[tokio::test]
async fn windows_archive_restore_and_delete_use_persisted_spelling() {
    let mut f = basic();
    idle_group_root(&f);
    f.manager.inner.lock().leaders.remove(&key(&f.parent));
    f.parent.workspace_path = r"G:\project\repo".into();
    f.manager.inner.lock().leaders.insert(key(&f.parent), f.parent.clone());
    write_role(&mut f.manager.db.0.lock(), &f.parent, true).unwrap();
    let slash = identity(&f.parent.engine, &f.parent.session_id, "G:/project/repo");
    save_group_session(&f, &slash, "root", "fixture-root.jsonl");
    f.manager.archive_group(&f.parent).unwrap();
    f.manager.restore_group(&slash).unwrap();
    assert_eq!(f.manager.db.0.lock().query_row("SELECT COUNT(*) FROM leader_archived_groups", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    f.manager.archive_group(&f.parent).unwrap();
    f.manager.delete_group(&slash).await.unwrap();
    for table in ["leader_archived_groups", "leader_archived_members"] {
        assert_eq!(f.manager.db.0.lock().query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }
    let restarted = LeaderManager::with_services(f.manager.db.clone(), f.manager.processes.clone(),
        f.emitter.clone(), Arc::new(now_ms), Arc::new(|_, _, _| Ok(()))).unwrap();
    assert!(restarted.inner.lock().archived_groups.is_empty());
}

#[cfg(windows)]
#[test]
fn windows_request_replay_and_branch_authority_survive_separator_changes() {
    let f = basic();
    let (_dir, mut caller) = first_root(&f, "separator-replay");
    f.manager.bind_session(&caller.run_id, &caller.engine, &caller.session_id).unwrap();
    f.manager.processes.rekey(&caller.run_id, caller.session_id.clone()).unwrap();
    f.manager.commit_binding(&caller.run_id, &caller.engine, &caller.session_id).unwrap();
    let parent = identity(&caller.engine, &caller.session_id, &caller.workspace_path);
    let args = args("separator-request");
    let Reservation::Start((id, _)) = f.manager.reserve_spawn(&caller, &parent, "manual", &args, encoded(&args).unwrap(), None, None).unwrap()
        else { panic!("first request did not launch"); };
    caller.workspace_path = caller.workspace_path.replace('\\', "/");
    let alias = identity(&caller.engine, &caller.session_id, &caller.workspace_path);
    let Reservation::Replay(response) = f.manager.reserve_spawn(&caller, &alias, "manual", &args, encoded(&args).unwrap(), None, None).unwrap()
        else { panic!("separator variant launched twice"); };
    assert_eq!(response["branch"]["id"], id);
    assert!(f.manager.child(&f.manager.inner.lock(), &alias, &id).is_ok());
    let restarted = LeaderManager::with_services(f.manager.db.clone(), f.manager.processes.clone(),
        f.emitter.clone(), Arc::new(now_ms), Arc::new(|_, _, _| Ok(()))).unwrap();
    assert_eq!(restarted.inner.lock().requests.len(), 1);
    assert!(restarted.replay(&restarted.inner.lock(), &alias, &args.request_id, "task_spawn", &encoded(&args).unwrap()).unwrap().is_some());
}

struct FirstRootWorkspace(std::path::PathBuf);
impl Drop for FirstRootWorkspace {
    fn drop(&mut self) { let _ = std::fs::remove_dir(&self.0); }
}

fn first_root(f: &Fixture, run_id: &str) -> (FirstRootWorkspace, Caller) {
    first_root_with_saved(f, run_id, &[])
}

fn first_root_with_saved(f: &Fixture, run_id: &str, saved: &[&str]) -> (FirstRootWorkspace, Caller) {
    let path = std::env::temp_dir().join(format!("ccgui-first-root-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&path).unwrap();
    let workspace = path.to_string_lossy().to_string();
    f.manager.db.0.lock().execute("INSERT INTO workspaces(id,path) VALUES(?1,?2)",
        params![uuid::Uuid::new_v4().to_string(), workspace]).unwrap();
    for session in saved {
        f.manager.db.0.lock().execute("INSERT INTO sessions(engine,session_id,workspace_path) VALUES('claude',?1,?2)",
            params![session, workspace]).unwrap();
    }
    let entry = reservation(run_id);
    let marker = Arc::clone(&entry.killed);
    f.manager.processes.insert(run_id.into(), entry);
    assert_eq!(f.manager.prepare_first_root(run_id, "claude", &workspace, Some("manual"), &marker).unwrap(), role(false));
    (FirstRootWorkspace(path), Caller {
        run_id: run_id.into(), engine: "claude".into(), session_id: "genuine-first-root".into(), workspace_path: workspace,
    })
}

#[test]
fn first_root_binds_transactionally_and_preserves_same_run_guidance() {
    let f = basic();
    let (_workspace, caller) = first_root(&f, "first-root");
    assert!(f.manager.authorize(&f.manager.inner.lock(), &caller).is_err());
    assert_eq!(f.manager.prepare(&caller.run_id, "claude", None, &caller.workspace_path, Some("manual")).unwrap(), Some(role(false)));
    assert!(f.manager.inner.lock().runs[&caller.run_id].root_on_start);
    f.manager.bind_session(&caller.run_id, "claude", &caller.session_id).unwrap();
    assert!(f.manager.prepare("competing-gui-resume", "claude", Some(&caller.session_id), &caller.workspace_path, None).is_err(),
        "a root's pending first identity fences other GUI resumes");
    assert!(f.manager.commit_binding(&caller.run_id, "claude", &caller.session_id).is_err(), "alias ownership is mandatory");
    f.manager.processes.rekey(&caller.run_id, caller.session_id.clone()).unwrap();
    f.manager.commit_binding(&caller.run_id, "claude", &caller.session_id).unwrap();
    let (parent, permission) = f.manager.authorize(&f.manager.inner.lock(), &caller).unwrap();
    assert_eq!(permission, "manual");
    assert!(validate_parent(&f.manager.db, &parent, false).is_err());
    validate_parent(&f.manager.db, &parent, true).unwrap();
    assert!(f.manager.inner.lock().verified_new_roots.contains_key(&key(&parent)));
    assert!(f.manager.bind_session(&caller.run_id, "claude", "changed-id").is_err());
    assert_eq!(f.manager.db.0.lock().query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    assert_eq!(f.manager.db.0.lock().query_row("SELECT COUNT(*) FROM leader_roles WHERE session_id=?1", [&caller.session_id], |r| r.get::<_, i64>(0)).unwrap(), 0);
    let restarted = LeaderManager::with_services(Arc::clone(&f.manager.db), Arc::clone(&f.manager.processes),
        f.emitter.clone(), Arc::new(now_ms), Arc::new(|_, _, _| Ok(()))).unwrap();
    assert!(restarted.inner.lock().verified_new_roots.is_empty());
    assert!(restarted.snapshot().unwrap().leaders.is_empty());
    f.manager.db.0.lock().execute("INSERT INTO sessions(engine,session_id,workspace_path) VALUES(?1,?2,?3)",
        params![parent.engine, parent.session_id, "different-workspace"]).unwrap();
    assert!(validate_parent(&f.manager.db, &parent, true).is_err(), "provenance never bypasses a real wrong-workspace row");
    f.manager.checkpoint().unwrap();
    assert!(f.manager.inner.lock().verified_new_roots.is_empty());
}

#[test]
fn unscanned_retired_root_identity_cannot_be_adopted_by_another_child_or_root() {
    let f = basic();
    let (_workspace, owner) = first_root(&f, "unscanned-owner");
    f.manager.bind_session(&owner.run_id, &owner.engine, &owner.session_id).unwrap();
    f.manager.processes.rekey(&owner.run_id, owner.session_id.clone()).unwrap();
    f.manager.commit_binding(&owner.run_id, &owner.engine, &owner.session_id).unwrap();
    f.manager.finish(&owner.run_id);
    f.manager.processes.remove_run_if_pid(&owner.run_id, 0);
    let mut request = args("foreign-child"); request.engine = "claude".into();
    let Reservation::Start((_, child_run)) = f.manager.reserve_spawn(&f.caller, &f.parent, "manual",
        &request, encoded(&request).unwrap(), None, None).unwrap() else { panic!("expected new child"); };
    assert!(f.manager.bind_session(&child_run, "claude", &owner.session_id).unwrap_err().contains("owned by another chat"));
    // The verified identity still fences a later first launch after the retired
    // run cache is pruned and before the history scanner creates its row.
    f.manager.inner.lock().runs.remove(&owner.run_id);
    let (_later_workspace, later) = first_root(&f, "later-unscanned-root");
    assert!(f.manager.bind_session(&later.run_id, "claude", &owner.session_id).unwrap_err().contains("owned by another chat"));
    assert_eq!(f.manager.db.0.lock().query_row("SELECT COUNT(*) FROM sessions WHERE session_id=?1", [&owner.session_id], |r| r.get::<_, i64>(0)).unwrap(), 0);
}

#[test]
fn agy_first_root_binds_only_its_owned_native_identity() {
    let f = fixture_with_engine(Arc::new(|_, _, _| Ok(())), "agy");
    let path = std::env::temp_dir().join(format!("ccgui-agy-first-root-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&path).unwrap();
    let _cleanup = FirstRootWorkspace(path.clone());
    let workspace = path.to_string_lossy().to_string();
    f.manager.db.0.lock().execute("INSERT INTO workspaces(id,path) VALUES(?1,?2)",
        params![uuid::Uuid::new_v4().to_string(), workspace]).unwrap();
    let entry = reservation("agy-root-run");
    let killed = Arc::clone(&entry.killed);
    f.manager.processes.insert("agy-root-run".into(), entry);
    assert_eq!(f.manager.prepare_first_root("agy-root-run", "agy", &workspace, Some("auto"), &killed).unwrap(), role(false));
    let caller = Caller { run_id: "agy-root-run".into(), engine: "agy".into(),
        session_id: "agy-native-root".into(), workspace_path: workspace };
    assert!(f.manager.authorize(&f.manager.inner.lock(), &caller).is_err());
    f.manager.bind_session(&caller.run_id, "agy", &caller.session_id).unwrap();
    assert!(f.manager.commit_binding(&caller.run_id, "agy", &caller.session_id).is_err());
    f.manager.processes.rekey(&caller.run_id, caller.session_id.clone()).unwrap();
    f.manager.commit_binding(&caller.run_id, "agy", &caller.session_id).unwrap();
    let (parent, permission) = f.manager.authorize(&f.manager.inner.lock(), &caller).unwrap();
    assert_eq!(permission, "auto");
    assert_eq!(parent.engine, "agy");
    assert!(f.manager.bind_session(&caller.run_id, "agy", "foreign-id").is_err());
    assert!(f.manager.bind_session(&caller.run_id, "claude", &caller.session_id).is_err());
}

#[test]
fn first_root_commit_does_not_write_legacy_roles_and_stop_still_fences_binding() {
    let f = basic();
    let (_workspace, caller) = first_root(&f, "first-root-failure");
    f.manager.bind_session(&caller.run_id, "claude", &caller.session_id).unwrap();
    f.manager.processes.rekey(&caller.run_id, caller.session_id.clone()).unwrap();
    f.manager.db.0.lock().execute_batch("CREATE TRIGGER fail_first_role BEFORE INSERT ON leader_roles BEGIN SELECT RAISE(ABORT, 'fixture role failure'); END;").unwrap();
    f.manager.commit_binding(&caller.run_id, "claude", &caller.session_id).unwrap();
    {
        let inner = f.manager.inner.lock();
        assert_eq!(inner.runs[&caller.run_id].session_id.as_deref(), Some(caller.session_id.as_str()));
        assert!(inner.verified_new_roots.contains_key(&key(&identity("claude", &caller.session_id, &caller.workspace_path))));
        assert!(!inner.leaders.contains_key(&key(&identity("claude", &caller.session_id, &caller.workspace_path))));
    }
    f.manager.finish(&caller.run_id);
    assert!(f.manager.inner.lock().pending_bindings.is_empty());
    assert!(!f.manager.inner.lock().runs[&caller.run_id].root_on_start);
    assert!(f.manager.bind_session(&caller.run_id, "claude", &caller.session_id).is_err());
    f.manager.db.0.lock().execute_batch("DROP TRIGGER fail_first_role").unwrap();
    let (_retry_workspace, retry) = first_root(&f, "first-root-retry");
    f.manager.processes.get(&retry.run_id).unwrap().killed.store(true, Ordering::SeqCst);
    assert!(f.manager.bind_session(&retry.run_id, "claude", &retry.session_id).unwrap_err().contains("stopped"));
    f.manager.finish(&retry.run_id);
    assert!(f.manager.authorize(&f.manager.inner.lock(), &retry).is_err());
}

#[test]
fn first_root_rejects_foreign_saved_pending_and_isolated_identity_but_ignores_legacy_role() {
    let f = basic();
    let (_workspace, caller) = first_root(&f, "first-root-foreign");
    let db = f.manager.db.0.lock();
    db.execute("INSERT INTO sessions(engine,session_id,workspace_path) VALUES('claude','saved','foreign')", []).unwrap();
    db.execute("INSERT INTO session_archives(engine,session_id) VALUES('claude','archived')", []).unwrap();
    db.execute("INSERT INTO leader_roles(engine,session_id,workspace_path,enabled) VALUES('claude','disabled','foreign',0)", []).unwrap();
    drop(db);
    f.manager.bind_session(&caller.run_id, "claude", "disabled").unwrap();
    f.manager.release_binding(&caller.run_id, "claude", "disabled");
    for foreign in ["parent-session", "saved", "archived"] {
        assert!(f.manager.bind_session(&caller.run_id, "claude", foreign).is_err(), "accepted {foreign}");
    }
    let isolated = reservation("isolated-owner");
    let marker = Arc::clone(&isolated.killed);
    f.manager.processes.insert("isolated-owner".into(), isolated);
    f.manager.prepare_isolated("isolated-owner", "claude", Some("isolated-owned"), "foreign", &marker).unwrap();
    assert!(f.manager.bind_session(&caller.run_id, "claude", "isolated-owned").is_err());
    f.manager.bind_session("isolated-owner", "claude", "pending-owned").unwrap();
    assert!(f.manager.bind_session(&caller.run_id, "claude", "pending-owned").is_err());
    assert!(f.manager.bind_session(&caller.run_id, "codex", "wrong-engine").is_err());
    let mut child_args = args("owned-child-for-root");
    child_args.engine = "claude".into();
    let Reservation::Start((child_id, child_run)) = f.manager.reserve_spawn(&f.caller, &f.parent,
        "manual", &child_args, encoded(&child_args).unwrap(), None, None).unwrap() else { panic!("new child was replayed"); };
    f.manager.processes.insert(child_run.clone(), reservation(&child_run));
    f.manager.bind_session(&child_run, "claude", "owned-child-tombstone").unwrap();
    f.manager.commit_binding(&child_run, "claude", "owned-child-tombstone").unwrap();
    f.manager.inner.lock().branches.get_mut(&child_id).unwrap().branch.state = "reclaimed".into();
    assert!(f.manager.bind_session(&caller.run_id, "claude", "owned-child-tombstone").is_err());
    let ordinary = reservation("ordinary-draft");
    let marker = Arc::clone(&ordinary.killed);
    f.manager.processes.insert("ordinary-draft".into(), ordinary);
    assert_eq!(f.manager.prepare("ordinary-draft", "claude", None, &caller.workspace_path, None).unwrap(), Some(role(false)));
    assert!(f.manager.prepare_first_root("ordinary-draft", "claude", &caller.workspace_path, None, &marker).is_err());
    assert!(f.manager.inner.lock().runs["ordinary-draft"].root_on_start);
}

#[test]
fn first_root_saved_baseline_allows_only_new_exact_workspace_rows() {
    let f = basic();
    f.manager.db.0.lock().execute("INSERT INTO session_archives(engine,session_id) VALUES('claude','old-archive')", []).unwrap();
    let (_workspace, caller) = first_root_with_saved(&f, "first-root-scan-race", &["old-saved"]);
    f.manager.prepare(&caller.run_id, "claude", None, &caller.workspace_path, None).unwrap();
    f.manager.db.0.lock().execute_batch("DELETE FROM sessions WHERE session_id='old-saved'; DELETE FROM session_archives WHERE session_id='old-archive';").unwrap();
    for prior in ["old-saved", "old-archive"] {
        assert!(f.manager.bind_session(&caller.run_id, "claude", prior).unwrap_err().contains("before this launch"));
    }
    f.manager.db.0.lock().execute("INSERT INTO sessions(engine,session_id,workspace_path) VALUES('claude',?1,?2)",
        params![caller.session_id, caller.workspace_path]).unwrap();
    f.manager.bind_session(&caller.run_id, "claude", &caller.session_id).unwrap();
    f.manager.processes.rekey(&caller.run_id, caller.session_id.clone()).unwrap();
    f.manager.commit_binding(&caller.run_id, "claude", &caller.session_id).unwrap();
    assert!(f.manager.inner.lock().runs[&caller.run_id].root_saved_baseline.is_none());
    f.manager.authorize(&f.manager.inner.lock(), &caller).unwrap();
    let (_later_workspace, later) = first_root(&f, "first-root-commit-interleave");
    let later_session = "fresh-at-reserve-new-at-commit";
    f.manager.bind_session(&later.run_id, "claude", later_session).unwrap();
    f.manager.db.0.lock().execute("INSERT INTO sessions(engine,session_id,workspace_path) VALUES('claude',?1,?2)",
        params![later_session, later.workspace_path]).unwrap();
    f.manager.processes.rekey(&later.run_id, later_session.into()).unwrap();
    f.manager.commit_binding(&later.run_id, "claude", later_session).unwrap();
    assert!(f.manager.inner.lock().runs[&later.run_id].root_saved_baseline.is_none());
}

#[test]
fn first_root_new_cache_rows_do_not_bypass_archive_or_other_run_ownership() {
    let f = basic();
    let (_workspace, caller) = first_root(&f, "first-root-new-foreign");
    let conn = f.manager.db.0.lock();
    conn.execute("INSERT INTO sessions(engine,session_id,workspace_path) VALUES('claude','new-wrong-workspace','foreign')", []).unwrap();
    conn.execute("INSERT INTO session_archives(engine,session_id) VALUES('claude','newly-archived')", []).unwrap();
    conn.execute("INSERT INTO sessions(engine,session_id,workspace_path) VALUES('claude','new-other-run',?1)", [&caller.workspace_path]).unwrap();
    drop(conn);
    assert!(f.manager.bind_session(&caller.run_id, "claude", "new-wrong-workspace").is_err());
    assert!(f.manager.bind_session(&caller.run_id, "claude", "newly-archived").is_err());
    f.manager.prepare("another-admitted-run", "claude", Some("new-other-run"), &caller.workspace_path, None).unwrap();
    f.manager.finish("another-admitted-run");
    assert!(f.manager.bind_session(&caller.run_id, "claude", "new-other-run").is_err(), "a retired admitted run still owns its announced identity");
    assert!(f.manager.inner.lock().leaders.keys().all(|(_, id, _)| id != "new-other-run"));
    f.manager.bind_session(&caller.run_id, "claude", "archived-after-reserve").unwrap();
    f.manager.processes.rekey(&caller.run_id, "archived-after-reserve".into()).unwrap();
    f.manager.db.0.lock().execute("INSERT INTO session_archives(engine,session_id) VALUES('claude','archived-after-reserve')", []).unwrap();
    assert!(f.manager.commit_binding(&caller.run_id, "claude", "archived-after-reserve").is_err());
    f.manager.finish(&caller.run_id);
    assert!(f.manager.inner.lock().runs[&caller.run_id].root_saved_baseline.is_none());
}

#[test]
fn resumed_enabled_roots_reject_native_identity_changes_without_new_grants() {
    let f = basic();
    assert!(f.manager.inner.lock().runs[&f.caller.run_id].root_identity_bound);
    assert!(f.manager.bind_session(&f.caller.run_id, "claude", "foreign-changed-root").is_err());
    f.manager.bind_session(&f.caller.run_id, "claude", &f.caller.session_id).unwrap();
    assert!(!f.manager.inner.lock().runs[&f.caller.run_id].root_on_start);
    assert!(f.manager.inner.lock().runs[&f.caller.run_id].root_saved_baseline.is_none());
}

#[test]
fn pending_first_root_keeps_foreign_claims_after_retired_run_pruning() {
    let f = basic();
    f.manager.prepare("owner-before-root", "claude", Some("known-owner-before-launch"), &f.parent.workspace_path, None).unwrap();
    f.manager.finish("owner-before-root");
    let (_workspace, caller) = first_root(&f, "root-waits-through-pruning");
    f.manager.prepare("foreign-retired-owner", "claude", Some("post-baseline-foreign"), &caller.workspace_path, None).unwrap();
    f.manager.finish("foreign-retired-owner");
    {
        let mut inner = f.manager.inner.lock();
        let retired = inner.runs["foreign-retired-owner"].clone();
        for index in 0..2050 {
            inner.runs.insert(format!("retired-pruning-fixture-{index}"), retired.clone());
        }
    }
    // Exercise the real size-triggered pruning path, rather than removing
    // the original owner records directly in the test.
    f.manager.prepare("triggers-ordinary-prune", "claude", None, &caller.workspace_path, None).unwrap();
    assert!(!f.manager.inner.lock().runs.contains_key("foreign-retired-owner"));
    assert!(!f.manager.inner.lock().runs.contains_key("owner-before-root"));
    f.manager.db.0.lock().execute("INSERT INTO sessions(engine,session_id,workspace_path) VALUES('claude','post-baseline-foreign',?1)", [&caller.workspace_path]).unwrap();
    for foreign in ["known-owner-before-launch", "post-baseline-foreign"] {
        assert!(f.manager.bind_session(&caller.run_id, "claude", foreign).is_err(), "accepted pruned foreign ownership for {foreign}");
    }
    f.manager.finish(&caller.run_id);
    assert!(f.manager.inner.lock().runs[&caller.run_id].root_foreign_claims.is_none());
    assert!(f.manager.inner.lock().runs[&caller.run_id].root_saved_baseline.is_none());
}

fn args(request_id: &str) -> SpawnArgs {
    SpawnArgs {
        request_id: request_id.into(),
        engine: "codex".into(),
        title: "Inspect parsing".into(),
        task: "Check the parser and report concrete evidence.".into(),
        model: None,
        effort: None,
        ttl_seconds: Some(60),
    }
}

fn spawn(f: &Fixture, request_id: &str) -> (String, String) {
    spawn_with_args(f, &args(request_id))
}

fn spawn_with_args(f: &Fixture, args: &SpawnArgs) -> (String, String) {
    match f
        .manager
        .reserve_spawn(
            &f.caller,
            &f.parent,
            "manual",
            args,
            encoded(args).unwrap(),
            None,
            None,
        )
        .unwrap()
    {
        Reservation::Start(start) => start,
        Reservation::Replay(_) => panic!("unexpected replay"),
    }
}

#[test]
fn leader_model_policy_changes_do_not_interfere_with_send_settings() {
    let f = basic();
    let spawn_args = args("policy-existing-child");
    let Reservation::Start((id, run)) = f.manager.reserve_spawn(
        &f.caller, &f.parent, "manual", &spawn_args, encoded(&spawn_args).unwrap(),
        Some("saved-model".into()), Some("high".into()),
    ).unwrap() else { panic!("unexpected spawn replay"); };
    observe(&f, &run, "policy-existing-session", "session", json!("policy-existing-session"), 1);
    observe(&f, &run, "policy-existing-session", "done", json!({}), 2);
    f.manager.finish(&run);
    let settings: crate::settings::AppSettings = serde_json::from_value(json!({"leaderAllowedModels":{"codex":[]}})).unwrap();
    assert!(model_policy::resolve(&settings, "codex", Some("saved-model")).is_err());
    let send = SendArgs { branch_id: id, request_id: "policy-followup".into(), message: "Continue the existing task".into() };
    hot_send_cache(&f, &send.branch_id);
    let Reservation::Start((branch, _)) = f.manager.reserve_send(
        &f.caller, &f.parent, "manual", &send, encoded(&send).unwrap(),
    ).unwrap() else { panic!("unexpected send replay"); };
    assert_eq!(branch.model.as_deref(), Some("saved-model"));
    assert_eq!(branch.effort.as_deref(), Some("high"));
    assert_eq!(branch.session_id.as_deref(), Some("policy-existing-session"));
}

#[test]
fn leader_task_list_reports_branches_without_eager_model_policy() {
    let f = basic();
    for index in 0..9 {
        let (id, _) = spawn(&f, &format!("policy-large-{index}"));
        f.manager.inner.lock().branches.get_mut(&id).unwrap().branch.result = "😀".repeat(MAX_RESULT_CHARS);
    }
    let response = f.manager.list_response(&f.manager.inner.lock(), &f.parent).unwrap();
    assert!(response.get("modelPolicy").is_none());
    assert_eq!(response.as_object().unwrap().len(), 1);
    assert_eq!(response["branches"].as_array().unwrap().len(), 9);
    assert!(serde_json::to_vec(&response).unwrap().len() < MAX_TOOL_RESPONSE_BYTES);
    assert!(f.manager.inner.lock().branches.values().all(|record| record.branch.result.chars().count() == MAX_RESULT_CHARS));
}

#[test]
fn leader_role_guidance_does_not_require_model_policy_preflight() {
    for child in [false, true] {
        let guidance = role(child);
        assert!(!guidance.contains("modelPolicy"));
        assert!(!guidance.contains("before choosing"));
        assert!(guidance.contains("shares workspace files"));
    }
}

fn event(run: &str, session: Option<&str>, kind: &str, data: Value, seq: u64) -> Value {
    json!({"runId":run,"engine":"codex","sessionId":session,"kind":kind,"data":data,"seq":seq,"ts":0})
}

fn observe(f: &Fixture, run: &str, session: &str, kind: &str, data: Value, seq: u64) -> Value {
    let mut event = event(run, Some(session), kind, data, seq);
    f.manager.observe(&mut event);
    event
}

fn branch(f: &Fixture, id: &str) -> LeaderBranch {
    f.manager
        .inner
        .lock()
        .branches
        .get(id)
        .unwrap()
        .branch
        .clone()
}

fn settle(f: &Fixture, id: &str, run: &str, session: &str) {
    observe(f, run, session, "session", json!(session), 1);
    observe(f, run, session, "done", json!({}), 2);
    f.manager.finish(run);
    assert_eq!(branch(f, id).state, "completed");
}

fn hot_send_cache(f: &Fixture, id: &str) {
    let branch = branch(f, id);
    let now = f.clock.load(Ordering::SeqCst);
    crate::history::prompt_cache::set(&f.manager.db.0.lock(), &branch.engine,
        branch.session_id.as_deref().unwrap(), Some(&crate::history::prompt_cache::CacheWindow {
            ttl_seconds: 300, started_at: now, observed_at: now,
            source: "test-observed".into(), reference: None,
        })).unwrap();
}

fn held_send(f: &Fixture, id: &str, request_id: &str) -> SendArgs {
    let args = SendArgs {
        branch_id: id.into(), request_id: request_id.into(), message: "Continue 中文 😀".into(),
    };
    let Reservation::Replay(receipt) = f.manager.reserve_send(
        &f.caller, &f.parent, "manual", &args, encoded(&args).unwrap(),
    ).unwrap() else { panic!("cold task continuation started without approval"); };
    assert_eq!(receipt["status"], "awaiting_cost_approval");
    assert_eq!(receipt["submitted_to_model"], false);
    assert_eq!(receipt["mayHaveStarted"], false);
    args
}

#[test]
fn task_cost_approval_cache_evidence_uses_ten_second_start_margin() {
    use crate::history::prompt_cache::{CacheReference, CacheWindow};
    let mut cache = CacheWindow {
        ttl_seconds: 100, started_at: 1_000, observed_at: 1_000,
        source: "test-observed".into(), reference: None,
    };
    assert!(cost_approval::requires_approval(None, 1_000));
    assert!(!cost_approval::requires_approval(Some(&cache), 1_000));
    assert!(!cost_approval::requires_approval(Some(&cache), 90_999)); // 10,001 ms remain.
    assert!(cost_approval::requires_approval(Some(&cache), 91_000));
    assert!(cost_approval::requires_approval(Some(&cache), 100_999)); // 1 ms remains.
    assert_eq!(cache.heat(101_000), "cold");
    assert!(cost_approval::requires_approval(Some(&cache), 101_000));
    for ttl_seconds in [1800, 3600] {
        let long_cache = CacheWindow { ttl_seconds, ..cache.clone() };
        let expires_at = long_cache.started_at + ttl_seconds * 1000;
        for remaining_ms in [60_000, 120_000, 180_000] {
            assert!(!cost_approval::requires_approval(Some(&long_cache), expires_at - remaining_ms));
        }
        assert!(!cost_approval::requires_approval(Some(&long_cache), expires_at - 10_001));
        assert!(cost_approval::requires_approval(Some(&long_cache), expires_at - 10_000));
    }
    cache.observed_at = 11_000;
    assert_eq!(cache.heat(105_000), "unknown");
    assert!(cost_approval::requires_approval(Some(&cache), 105_000));
    cache.reference = Some(CacheReference { max_ttl_seconds: 200, cache_read_tokens: 10, prompt_tokens: 20 });
    assert_eq!(cache.heat(91_000), "hot");
    assert!(!cost_approval::requires_approval(Some(&cache), 90_999));
    assert!(cost_approval::requires_approval(Some(&cache), 91_000)); // Minimum TTL, not maximum.
    assert_eq!(cache.heat(105_000), "unknown");
    assert!(cost_approval::requires_approval(Some(&cache), 105_000));
    cache.reference.as_mut().unwrap().cache_read_tokens = 0;
    assert!(cost_approval::requires_approval(Some(&cache), 11_000));
    cache.started_at = 0;
    assert!(cost_approval::requires_approval(Some(&cache), 11_000));
}

#[test]
fn task_cost_approval_cache_expiry_saturates_without_overflow() {
    use crate::history::prompt_cache::CacheWindow;
    let cache = CacheWindow {
        ttl_seconds: i64::MAX, started_at: 1_000, observed_at: 1_000,
        source: "test-observed".into(), reference: None,
    };
    assert!(!cost_approval::requires_approval(Some(&cache), 1_000));
    assert!(!cost_approval::requires_approval(Some(&cache), i64::MAX - 10_001));
    assert!(cost_approval::requires_approval(Some(&cache), i64::MAX - 10_000));
    let cache = CacheWindow {
        ttl_seconds: 100, started_at: i64::MAX - 20_000,
        observed_at: i64::MAX - 20_000, ..cache
    };
    assert!(!cost_approval::requires_approval(Some(&cache), i64::MAX - 10_001));
    assert!(cost_approval::requires_approval(Some(&cache), i64::MAX - 10_000));
}

#[test]
fn task_cost_approval_holds_unknown_without_launch_and_retries_cannot_bypass() {
    let f = basic();
    let (id, run) = spawn(&f, "approval-spawn");
    settle(&f, &id, &run, "approval-session");
    let before = branch(&f, &id);
    let runs = f.manager.inner.lock().runs.len();
    let args = held_send(&f, &id, "approval-send");
    let held = branch(&f, &id);
    assert_eq!(held.state, "awaiting_cost_approval");
    assert_eq!(held.run_id, None);
    assert_eq!(held.deadline_at, before.deadline_at);
    assert_eq!(held.last_activity_at, before.last_activity_at);
    assert_eq!(f.manager.inner.lock().runs.len(), runs);
    assert!(held.cost_approval.as_ref().unwrap().cache.is_none());
    let Reservation::Replay(receipt) = f.manager.reserve_send(
        &f.caller, &f.parent, "bypass", &args, encoded(&args).unwrap(),
    ).unwrap() else { panic!("retry bypassed approval"); };
    assert_eq!(receipt["status"], "awaiting_cost_approval");
    assert_eq!(f.manager.inner.lock().branches[&id].permission, "manual");
    let mut changed = args.clone();
    changed.message.push('!');
    assert!(f.manager.reserve_send(&f.caller, &f.parent, "manual", &changed,
        encoded(&changed).unwrap()).is_err());
    changed = args.clone();
    changed.request_id = "fresh-id".into();
    assert!(f.manager.reserve_send(&f.caller, &f.parent, "manual", &changed,
        encoded(&changed).unwrap()).is_err());
    assert!(f.manager.prepare("unapproved-gui-send", "codex", Some("approval-session"),
        &f.parent.workspace_path, Some("manual")).unwrap_err().contains("cost approval"));
    observe(&f, &run, "approval-session", "delta", json!("late tail"), 99);
    f.manager.finish(&run);
    assert_eq!(encoded(&branch(&f, &id)).unwrap(), encoded(&held).unwrap());
    let views = f.manager.views(&f.manager.inner.lock(), &f.parent, Some(&[id])).unwrap();
    assert_eq!(views[0]["needsAttention"], true);
    assert_eq!(views[0]["processAlive"], false);
    assert!(wait_mark(&views[0]).0);
}

#[test]
fn task_cost_approval_hot_sends_but_cold_and_expiring_evidence_hold() {
    for (elapsed, holds) in [
        (0, false), (280_000, false), (289_999, false),
        (290_000, true), (299_999, true), (300_000, true),
    ] {
        let f = basic();
        let (id, run) = spawn(&f, "cache-spawn");
        settle(&f, &id, &run, "cache-session");
        hot_send_cache(&f, &id);
        f.clock.fetch_add(elapsed, Ordering::SeqCst);
        let args = SendArgs { branch_id: id.clone(), request_id: "cache-send".into(), message: "Next".into() };
        let result = f.manager.reserve_send(&f.caller, &f.parent, "manual", &args, encoded(&args).unwrap()).unwrap();
        assert_eq!(matches!(result, Reservation::Replay(_)), holds);
        assert_eq!(branch(&f, &id).cost_approval.is_some(), holds);
    }
}

#[test]
fn task_cost_approval_restores_pending_and_approves_once_without_live_parent() {
    let f = basic();
    let (id, run) = spawn(&f, "restore-approval-spawn");
    settle(&f, &id, &run, "restore-approval-session");
    let args = held_send(&f, &id, "restore-approval-send");
    let held = branch(&f, &id);
    let restored = Arc::new(reload(&f).unwrap());
    assert_eq!(encoded(&restored.snapshot().unwrap().branches[0]).unwrap(), encoded(&held).unwrap());
    assert!(restored.processes.get(&f.caller.run_id).is_none());
    assert!(restored.inner.lock().runs.values().all(|r| r.retired));
    let reviewed = held.cost_approval.unwrap().model;
    let launches = std::thread::scope(|scope| {
        let attempts: Vec<_> = (0..2).map(|_| {
            let manager = restored.clone();
            let parent = &f.parent;
            let id = &id;
            let args = &args;
            let reviewed = &reviewed;
            scope.spawn(move || manager.resolve_cost_approval(parent, id, &args.request_id, true, reviewed.as_deref()).unwrap())
        }).collect();
        attempts.into_iter().filter_map(|attempt| attempt.join().unwrap()).collect::<Vec<_>>()
    });
    assert_eq!(launches.len(), 1);
    let (started, run_id, permission) = &launches[0];
    assert_eq!(started.task, args.message);
    assert_eq!(started.model, reviewed);
    assert_eq!(permission, "manual");
    assert_eq!(started.state, "starting");
    assert!(started.cost_approval.is_none());
    assert!(restored.inner.lock().runs[run_id].launch_pending);
    assert!(restored.resolve_cost_approval(&f.parent, &id, &args.request_id, true, reviewed.as_deref()).unwrap().is_none());
    let recovered_again = reload(&f).unwrap();
    assert_eq!(recovered_again.inner.lock().requests[&(key(&f.parent), args.request_id.clone())].state, "unknown");
    assert!(recovered_again.resolve_cost_approval(&f.parent, &id, &args.request_id, true, reviewed.as_deref()).unwrap().is_none());
}

#[tokio::test]
async fn task_cost_approval_cancel_stop_and_wrong_identity_never_launch() {
    for stop in [false, true] {
        let f = basic();
        let (id, run) = spawn(&f, "cancel-approval-spawn");
        settle(&f, &id, &run, "cancel-approval-session");
        let args = held_send(&f, &id, "cancel-approval-send");
        let reviewed = branch(&f, &id).model;
        let wrong_parent = identity("codex", "sibling", &f.parent.workspace_path);
        assert!(f.manager.resolve_cost_approval(&wrong_parent, &id, &args.request_id, true, reviewed.as_deref()).is_err());
        let (sibling, sibling_run) = spawn(&f, "approval-sibling");
        settle(&f, &sibling, &sibling_run, "approval-sibling-session");
        assert!(f.manager.resolve_cost_approval(&f.parent, &sibling, &args.request_id, true, reviewed.as_deref()).is_err());
        assert!(f.manager.resolve_cost_approval(&f.parent, &id, &args.request_id, true, Some("different-review-model")).is_err());
        if stop {
            assert_eq!(f.manager.stop(&f.parent, &id).await.unwrap().state, "stopped");
        } else {
            assert!(f.manager.resolve_cost_approval(&f.parent, &id, &args.request_id, false, None).unwrap().is_none());
        }
        assert!(branch(&f, &id).cost_approval.is_none());
        assert_eq!(branch(&f, &id).state, "stopped");
        assert!(f.manager.resolve_cost_approval(&f.parent, &id, &args.request_id, true, reviewed.as_deref()).unwrap().is_none());
        let replay = f.manager.replay(&f.manager.inner.lock(), &f.parent, &args.request_id,
            "task_send", &encoded(&args).unwrap()).unwrap().unwrap();
        assert_eq!(replay["requestState"], "cancelled");
        assert_eq!(replay["submitted_to_model"], false);
        assert!(reload(&f).unwrap().inner.lock().branches[&id].branch.cost_approval.is_none());
    }
}

#[test]
fn task_cost_approval_busy_and_failed_persistence_keep_request_held() {
    let f = basic();
    let (id, run) = spawn(&f, "busy-approval-spawn");
    let args = SendArgs { branch_id: id.clone(), request_id: "busy-approval-send".into(), message: "Next".into() };
    assert!(f.manager.reserve_send(&f.caller, &f.parent, "manual", &args, encoded(&args).unwrap()).is_err());
    settle(&f, &id, &run, "busy-approval-session");
    let args = held_send(&f, &id, "busy-approval-send");
    let held = branch(&f, &id);
    f.manager.processes.insert("busy-approval-session".into(), reservation("foreign"));
    assert!(f.manager.resolve_cost_approval(&f.parent, &id, &args.request_id, true, held.model.as_deref()).unwrap_err().contains("still running"));
    f.manager.processes.remove_reservation("busy-approval-session");
    f.manager.db.0.lock().execute_batch(
        "CREATE TRIGGER reject_approval BEFORE UPDATE ON leader_requests BEGIN SELECT RAISE(ABORT,'approval write failed'); END;"
    ).unwrap();
    assert!(f.manager.resolve_cost_approval(&f.parent, &id, &args.request_id, true, held.model.as_deref()).is_err());
    assert_eq!(encoded(&branch(&f, &id)).unwrap(), encoded(&held).unwrap());
    assert!(f.manager.resolve_cost_approval(&f.parent, &id, &args.request_id, false, None).is_err());
    assert_eq!(encoded(&branch(&f, &id)).unwrap(), encoded(&held).unwrap());
}

#[test]
fn task_cost_approval_old_card_cannot_approve_a_new_held_request() {
    let f = basic();
    let (id, run) = spawn(&f, "old-card-spawn");
    settle(&f, &id, &run, "old-card-session");
    let first = held_send(&f, &id, "old-card-send");
    let old_model = branch(&f, &id).model;
    f.manager.resolve_cost_approval(&f.parent, &id, &first.request_id, false, None).unwrap();
    let second = held_send(&f, &id, "new-card-send");
    let before = branch(&f, &id);
    assert!(f.manager.resolve_cost_approval(&f.parent, &id, &first.request_id, true, old_model.as_deref()).unwrap().is_none());
    assert!(f.manager.resolve_cost_approval(&f.parent, &id, &first.request_id, false, None).unwrap().is_none());
    assert_eq!(encoded(&branch(&f, &id)).unwrap(), encoded(&before).unwrap());
    assert!(f.manager.resolve_cost_approval(&f.parent, &id, &second.request_id, true, before.model.as_deref()).unwrap().is_some());
}

#[tokio::test]
async fn task_cost_approval_blocks_group_archive_and_deletion_until_cancelled() {
    let (f, deleted) = recording_fixture();
    let (child, grand, _sibling, _) = user_delete_tree(&f);
    let args = held_send(&f, &child, "delete-held-send");
    f.manager.processes.remove_reservation(&f.caller.run_id);
    f.manager.finish(&f.caller.run_id);
    assert!(f.manager.archive_group(&f.parent).unwrap_err().contains("idle"));
    assert!(f.manager.delete_branch_for_user(&f.parent, &child, &[child.clone(), grand.clone()])
        .await.unwrap_err().contains("idle"));
    assert!(deleted.lock().is_empty());
    f.manager.resolve_cost_approval(&f.parent, &child, &args.request_id, false, None).unwrap();
    f.manager.delete_branch_for_user(&f.parent, &child, &[child.clone(), grand]).await.unwrap();
    assert_eq!(branch(&f, &child).state, "reclaimed");
    assert!(branch(&f, &child).cost_approval.is_none());
    assert!(f.manager.resolve_cost_approval(&f.parent, &child, &args.request_id, true, None).is_err());
}

fn reload(f: &Fixture) -> Result<LeaderManager, String> {
    let clock = f.clock.clone();
    LeaderManager::with_services(
        f.manager.db.clone(),
        Arc::new(crate::engine::ProcessRegistry::default()),
        f.emitter.clone(),
        Arc::new(move || clock.load(Ordering::SeqCst)),
        Arc::new(|_, _, _| Ok(())),
    )
}

fn content_rows(f: &Fixture) -> Vec<String> {
    let conn = f.manager.db.0.lock();
    let mut stmt = conn
        .prepare("SELECT record_json FROM leader_branches UNION ALL SELECT record_json FROM leader_requests ORDER BY record_json")
        .unwrap();
    let rows = stmt
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    rows
}

fn assert_erased(record: &BranchRecord) {
    assert_eq!(record.branch.state, "reclaimed");
    assert!(record.branch.title.is_empty());
    assert!(record.branch.task.is_empty());
    assert!(record.branch.model.is_none());
    assert!(record.branch.effort.is_none());
    assert!(record.branch.result.is_empty());
    assert!(!record.branch.result_truncated);
    assert!(record.branch.error.is_none());
    assert!(record.output.stream_start.is_none());
    assert!(!record.output.stream_prefix_truncated);
    assert!(record.questions.is_empty());
    assert!(record.plans.is_empty());
}

// Emulate the on-disk format predating fingerprints without changing the
// running manager. The next manager must migrate it before becoming usable.
fn legacy_request(f: &Fixture, request_id: &str, arguments: Value, state: &str) {
    let mut raw = encoded(
        f.manager
            .inner
            .lock()
            .requests
            .get(&(key(&f.parent), request_id.into()))
            .unwrap(),
    )
    .unwrap();
    raw.as_object_mut().unwrap().remove("arguments_fingerprint");
    raw["arguments"] = arguments;
    raw["state"] = json!(state);
    raw["error"] = json!("legacy-private-request-error");
    raw["response"] = json!({"requestId":request_id,"requestState":state,
        "branch":{"task":"legacy-private-cached-task","result":"legacy-private-cached-result"},
        "error":"legacy-private-cached-error"});
    f.manager.db.0.lock().execute(
        "UPDATE leader_requests SET record_json=?1 WHERE parent_engine=?2 AND parent_session_id=?3 AND workspace_path=?4 AND request_id=?5",
        params![raw.to_string(), f.parent.engine, f.parent.session_id, f.parent.workspace_path, request_id],
    ).unwrap();
}

#[test]
fn argument_schemas_reject_parent_spoofing_permission_and_invalid_ttl() {
    assert!(
        validate_arguments("leader_reclaim", json!({"branch_id":"cached-old-tool"}))
            .unwrap_err()
            .contains("Unknown task method")
    );
    let mut args = encoded(&args("one")).unwrap();
    args["parent_session_id"] = json!("someone-else");
    assert!(validate_arguments("task_spawn", args).is_err());
    let mut args = encoded(&super::SpawnArgs {
        ttl_seconds: Some(59),
        ..self::args("two")
    })
    .unwrap();
    assert!(validate_arguments("task_spawn", args.clone()).is_err());
    args["ttl_seconds"] = json!(60);
    args["permission"] = json!("bypass");
    assert!(validate_arguments("task_spawn", args).is_err());
    assert!(validate_arguments("task_wait", json!({"timeout_seconds":21})).is_err());
    assert!(validate_arguments("task_wait", json!({"timeout_seconds":20})).is_ok());
}

#[test]
fn spawn_ttl_uses_child_engine_defaults_and_preserves_explicit_overrides() {
    for parent_engine in ["claude", "codex", "agy"] {
        let f = fixture_with_engine(Arc::new(|_, _, _| Ok(())), parent_engine);
        for (child_engine, default_seconds) in [("claude", 3600), ("codex", 1800), ("agy", 1800)] {
            for seconds in [None, Some(60), Some(120), Some(86_400)] {
                let args = SpawnArgs {
                    request_id: format!("{child_engine}-{seconds:?}"),
                    engine: child_engine.into(),
                    ttl_seconds: seconds,
                    ..self::args("unused")
                };
                let arguments = encoded(&args).unwrap();
                assert_eq!(validate_arguments("task_spawn", arguments.clone()).unwrap(), arguments,
                    "validation must not resolve omitted TTL into the request fingerprint");
                let (id, _) = spawn_with_args(&f, &args);
                let child = branch(&f, &id);
                assert_eq!(child.deadline_at - child.created_at,
                    seconds.unwrap_or(default_seconds) as i64 * 1000,
                    "parent={parent_engine}, child={child_engine}, override={seconds:?}");
            }
            for seconds in [59, 86_401] {
                let args = SpawnArgs {
                    engine: child_engine.into(),
                    ttl_seconds: Some(seconds),
                    ..self::args("invalid")
                };
                assert!(validate_arguments("task_spawn", encoded(&args).unwrap()).is_err());
            }
        }
    }
}

#[test]
fn renewal_without_ttl_uses_target_child_engine_and_validates_overrides() {
    for parent_engine in ["claude", "codex", "agy"] {
        let f = fixture_with_engine(Arc::new(|_, _, _| Ok(())), parent_engine);
        for (child_engine, default_seconds) in [("claude", 3600), ("codex", 1800), ("agy", 1800)] {
            let args = SpawnArgs { engine: child_engine.into(), ..self::args(child_engine) };
            let (id, _) = spawn_with_args(&f, &args);
            f.clock.fetch_add(61_000, Ordering::SeqCst);
            f.manager.checkpoint().unwrap();
            assert!(branch(&f, &id).expired);
            let renewed = f.manager.renew(&f.parent, &id, None).unwrap();
            assert_eq!(renewed.deadline_at, f.clock.load(Ordering::SeqCst) + default_seconds * 1000);
            assert!(!renewed.expired);
            assert_eq!(renewed.state, "starting");
            for seconds in [60, 120, 86_400] {
                let renewed = f.manager.renew(&f.parent, &id, Some(seconds)).unwrap();
                assert_eq!(renewed.deadline_at, f.clock.load(Ordering::SeqCst) + seconds as i64 * 1000);
            }
            let before = encoded(&branch(&f, &id)).unwrap();
            for seconds in [59, 86_401] {
                assert!(f.manager.renew(&f.parent, &id, Some(seconds)).is_err());
                assert_eq!(encoded(&branch(&f, &id)).unwrap(), before);
            }
            let stranger = identity(parent_engine, "other-parent", &f.parent.workspace_path);
            assert!(f.manager.renew(&stranger, &id, None).is_err());
            assert_eq!(encoded(&branch(&f, &id)).unwrap(), before);
        }
    }
}

#[test]
fn existing_claude_deadline_survives_restart_and_omitted_ttl_replay() {
    let f = basic();
    let args = SpawnArgs { engine: "claude".into(), ttl_seconds: None, ..self::args("legacy-default") };
    let arguments = validate_arguments("task_spawn", encoded(&args).unwrap()).unwrap();
    let (id, _) = spawn_with_args(&f, &args);
    let old_deadline = {
        let mut inner = f.manager.inner.lock();
        let record = inner.branches.get_mut(&id).unwrap();
        // Emulate a persisted branch created with the previous 30-minute Claude default.
        record.branch.deadline_at = record.branch.created_at + 1_800_000;
        f.manager.save(record).unwrap();
        record.branch.deadline_at
    };
    let recovered = reload(&f).unwrap();
    assert_eq!(recovered.inner.lock().branches[&id].branch.deadline_at, old_deadline);
    let response = recovered.replay(&recovered.inner.lock(), &f.parent, &args.request_id,
        "task_spawn", &arguments).unwrap().unwrap();
    assert_eq!(response["branch"]["id"], id);
    assert_eq!(response["branch"]["deadlineAt"], old_deadline);
    assert_eq!(recovered.inner.lock().branches.len(), 1);
    let mut explicit = arguments;
    explicit["ttl_seconds"] = json!(3600);
    assert!(recovered.replay(&recovered.inner.lock(), &f.parent, &args.request_id,
        "task_spawn", &explicit).is_err(), "an explicit TTL is still a different request");
}

#[test]
fn direct_parent_authority_rejects_forged_identity_self_and_siblings() {
    let f = basic();
    let (id, run) = spawn(&f, "one");
    observe(
        &f,
        &run,
        "child-session",
        "session",
        json!("child-session"),
        1,
    );
    let forged = Caller {
        session_id: "forged-session".into(),
        ..f.caller.clone()
    };
    assert!(f
        .manager
        .authorize(&f.manager.inner.lock(), &forged)
        .is_err());
    let child = identity("codex", "child-session", &f.parent.workspace_path);
    assert!(f
        .manager
        .child(&f.manager.inner.lock(), &child, &id)
        .is_err());
    let sibling = identity("codex", "sibling-session", &f.parent.workspace_path);
    assert!(f
        .manager
        .child(&f.manager.inner.lock(), &sibling, &id)
        .is_err());
    let wrong_workspace = LeaderIdentity {
        workspace_path: "different-local-workspace".into(),
        ..f.parent.clone()
    };
    assert!(f
        .manager
        .child(&f.manager.inner.lock(), &wrong_workspace, &id)
        .is_err());
    assert!(f
        .manager
        .child(&f.manager.inner.lock(), &f.parent, &id)
        .is_ok());
}

#[test]
fn child_may_delegate_and_cannot_reclaim_itself() {
    let f = basic();
    let (id, run) = spawn(&f, "one");
    observe(
        &f,
        &run,
        "child-session",
        "session",
        json!("child-session"),
        1,
    );
    f.manager.processes.insert(run.clone(), reservation(&run));
    let caller = Caller {
        run_id: run,
        engine: "codex".into(),
        session_id: "child-session".into(),
        workspace_path: f.parent.workspace_path.clone(),
    };
    let (parent, permission) = f
        .manager
        .authorize(&f.manager.inner.lock(), &caller)
        .unwrap();
    assert_eq!(permission, "manual");
    let mut args = args("nested");
    args.engine = "claude".into();
    let nested = f
        .manager
        .reserve_spawn(
            &caller,
            &parent,
            &permission,
            &args,
            encoded(&args).unwrap(),
            None,
            None,
        )
        .unwrap();
    let Reservation::Start((nested_id, _)) = nested else {
        panic!("expected child");
    };
    assert!(f
        .manager
        .child(&f.manager.inner.lock(), &parent, &nested_id)
        .is_ok());
    assert!(f
        .manager
        .child(&f.manager.inner.lock(), &parent, &id)
        .is_err());
}

#[test]
fn duplicate_requests_launch_once_and_conflicts_fail() {
    let f = basic();
    let (id, _run) = spawn(&f, "stable-key");
    let args = args("stable-key");
    let duplicate = f
        .manager
        .reserve_spawn(
            &f.caller,
            &f.parent,
            "manual",
            &args,
            encoded(&args).unwrap(),
            None,
            None,
        )
        .unwrap();
    let Reservation::Replay(response) = duplicate else {
        panic!("duplicate launched again");
    };
    assert_eq!(response["branch"]["id"], id);
    assert_eq!(response["mayHaveStarted"], true);
    assert_eq!(f.manager.inner.lock().branches.len(), 1);
    let mut changed = args.clone();
    changed.task = "A different assignment".into();
    assert!(f
        .manager
        .reserve_spawn(
            &f.caller,
            &f.parent,
            "manual",
            &changed,
            encoded(&changed).unwrap(),
            None,
            None
        )
        .is_err());
    let send = SendArgs {
        branch_id: id,
        request_id: "stable-key".into(),
        message: "next turn".into(),
    };
    assert!(f
        .manager
        .replay(
            &f.manager.inner.lock(),
            &f.parent,
            &send.request_id,
            "task_send",
            &encoded(&send).unwrap()
        )
        .is_err());
}

#[test]
fn terminal_before_launch_ack_is_not_overwritten_and_wire_assignment_is_nested() {
    let f = basic();
    let (id, run) = spawn(&f, "one");
    let session = observe(
        &f,
        &run,
        "child-session",
        "session",
        json!("child-session"),
        1,
    );
    assert_eq!(session["leader"]["branchId"], id);
    assert_eq!(session["leader"]["workspacePath"], f.parent.workspace_path);
    assert_eq!(session["leader"]["assignment"], args("one").task);
    assert!(session.get("assignment").is_none());
    let delta = observe(&f, &run, "child-session", "delta", json!("ready"), 2);
    assert!(delta["leader"].get("assignment").is_none());
    observe(&f, &run, "child-session", "done", json!({}), 3);
    let reply = f
        .manager
        .acknowledge(
            &f.parent,
            "one",
            &run,
            Ok(crate::engine::SendResult {
                run_id: run.clone(),
                session_id: Some("child-session".into()),
            }),
        )
        .unwrap();
    assert_eq!(reply["branch"]["state"], "completed");
    assert_eq!(branch(&f, &id).result, "ready");
    f.manager.finish(&run);
    assert_eq!(branch(&f, &id).state, "completed");
}

#[test]
fn ttl_marks_attention_without_deleting_retrying_or_changing_waiting() {
    let f = basic();
    let (id, run) = spawn(&f, "one");
    let entry = reservation(&run);
    let killed = Arc::clone(&entry.killed);
    f.manager.processes.insert(run.clone(), entry);
    observe(
        &f,
        &run,
        "child-session",
        "question",
        json!({"requestId":"q1"}),
        1,
    );
    observe(&f, &run, "child-session", "delta", json!("保留已有结果 🧭"), 2);
    assert_eq!(branch(&f, &id).state, "waiting");
    let before = branch(&f, &id);
    let request_before = encoded(&f.manager.inner.lock().requests[&(key(&f.parent), "one".into())]).unwrap();
    f.clock.fetch_add(61_000, Ordering::SeqCst);
    f.manager.checkpoint().unwrap();
    let waiting = branch(&f, &id);
    assert!(waiting.expired);
    assert_eq!(waiting.state, "waiting");
    assert_eq!(waiting.deadline_at, before.deadline_at);
    assert_eq!(waiting.task, before.task);
    assert_eq!(waiting.result, before.result);
    assert_eq!(waiting.run_id, before.run_id);
    assert!(!killed.load(Ordering::SeqCst));
    assert!(f.manager.processes.get(&run).is_some());
    assert_eq!(encoded(&f.manager.inner.lock().requests[&(key(&f.parent), "one".into())]).unwrap(), request_before);
    assert_eq!(f.manager.inner.lock().branches.len(), 1);
    assert_eq!(f.manager.inner.lock().requests.len(), 1);
    assert!(f.manager.inner.lock().branches[&id].questions.contains("q1"));
    let views = f.manager.views(&f.manager.inner.lock(), &f.parent, Some(&[id.clone()])).unwrap();
    assert_eq!(views[0]["needsAttention"], true);
    assert_eq!(views[0]["processAlive"], true);
    assert_eq!(views[0]["cacheWarmth"], "unknown");
    observe(
        &f,
        &run,
        "child-session",
        "question_settled",
        json!({"requestId":"q1"}),
        3,
    );
    observe(&f, &run, "child-session", "done", json!({}), 4);
    f.manager.finish(&run);
    f.clock.fetch_add(300_000, Ordering::SeqCst);
    f.manager.checkpoint().unwrap();
    assert_eq!(branch(&f, &id).state, "completed");
    assert!(branch(&f, &id).expired);
    f.manager.renew(&f.parent, &id, Some(120)).unwrap();
    assert!(!branch(&f, &id).expired);
}

#[test]
fn wait_ignores_children_already_ready_and_reports_new_ones() {
    let f = basic();
    let views = |f: &Fixture| {
        let inner = f.manager.inner.lock();
        f.manager.views(&inner, &f.parent, None).unwrap()
    };
    let marks = |views: &[Value]| -> HashMap<String, Value> {
        views
            .iter()
            .map(|v| (v["id"].as_str().unwrap().to_string(), wait_mark(v).1))
            .collect()
    };
    let (done, done_run) = spawn(&f, "done");
    let (running, running_run) = spawn(&f, "running");
    settle(&f, &done, &done_run, "done-session");
    observe(
        &f,
        &running_run,
        "running-session",
        "session",
        json!("running-session"),
        1,
    );
    // One child finished before the wait began: it must not end the wait.
    let start = marks(&views(&f));
    assert_eq!(wait_news(&start, &views(&f)), (vec![], true));
    observe(&f, &running_run, "running-session", "done", json!({}), 2);
    f.manager.finish(&running_run);
    assert_eq!(
        wait_news(&start, &views(&f)),
        (vec![running.clone()], false)
    );
    // Nothing left to wait for: return at once, without inventing news.
    let settled = marks(&views(&f));
    assert_eq!(wait_news(&settled, &views(&f)), (vec![], false));
    // Expiry during the wait is attention-worthy news.
    f.manager.renew(&f.parent, &done, Some(3600)).unwrap();
    f.manager.renew(&f.parent, &running, Some(3600)).unwrap();
    let (late, _late_run) = spawn(&f, "late");
    let start = marks(&views(&f));
    assert_eq!(wait_news(&start, &views(&f)), (vec![], true));
    f.clock.fetch_add(61_000, Ordering::SeqCst);
    f.manager.checkpoint().unwrap();
    assert_eq!(wait_news(&start, &views(&f)), (vec![late], false));
}

#[test]
fn restart_makes_inflight_unknown_and_never_replays_unacknowledged_launch() {
    let f = basic();
    let (id, _run) = spawn(&f, "stable-key");
    let recovered = LeaderManager::with_services(
        f.manager.db.clone(),
        Arc::new(crate::engine::ProcessRegistry::default()),
        f.emitter.clone(),
        Arc::new(|| 2_000_000),
        Arc::new(|_, _, _| Ok(())),
    )
    .unwrap();
    assert_eq!(
        recovered
            .inner
            .lock()
            .branches
            .get(&id)
            .unwrap()
            .branch
            .state,
        "unknown"
    );
    let args = args("stable-key");
    let reply = recovered
        .replay(
            &recovered.inner.lock(),
            &f.parent,
            &args.request_id,
            "task_spawn",
            &encoded(&args).unwrap(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(reply["requestState"], "unknown");
    assert_eq!(reply["replayed"], false);
    assert_eq!(recovered.processes.active_run_count(), 0);
}

#[test]
fn unicode_stream_snapshot_duplicates_and_result_bounds_preserve_text() {
    let f = basic();
    let (id, run) = spawn(&f, "one");
    observe(&f, &run, "child-session", "delta", json!("中👩‍💻文"), 1);
    observe(
        &f,
        &run,
        "child-session",
        "message",
        json!({"role":"assistant","text":"中👩‍💻文"}),
        2,
    );
    observe(
        &f,
        &run,
        "child-session",
        "message",
        json!({"role":"assistant","text":"中👩‍💻文"}),
        2,
    );
    assert_eq!(branch(&f, &id).result, "中👩‍💻文");
    observe(
        &f,
        &run,
        "child-session",
        "message",
        json!({"role":"tool","text":"tool"}),
        4,
    );
    observe(&f, &run, "child-session", "delta", json!("第二段🙂"), 5);
    observe(
        &f,
        &run,
        "child-session",
        "message",
        json!({"role":"assistant","text":"第二段🙂"}),
        6,
    );
    assert_eq!(branch(&f, &id).result, "中👩‍💻文第二段🙂");
    // Duplicate sequence is ignored even if content differs.
    observe(&f, &run, "child-session", "delta", json!("重复"), 6);
    assert_eq!(branch(&f, &id).result, "中👩‍💻文第二段🙂");
    let large = "界🙂".repeat(MAX_RESULT_CHARS);
    observe(&f, &run, "child-session", "delta", json!(large), 7);
    observe(
        &f,
        &run,
        "child-session",
        "message",
        json!({"role":"assistant","text":large}),
        8,
    );
    let result = branch(&f, &id);
    assert_eq!(result.result.chars().count(), MAX_RESULT_CHARS);
    assert!(result.result_truncated);
    assert!(result.result.starts_with("中👩‍💻文第二段🙂"));
}

#[test]
fn deltas_remain_in_memory_until_checkpoint_and_unrelated_events_unchanged() {
    let f = basic();
    let (id, run) = spawn(&f, "one");
    observe(
        &f,
        &run,
        "child-session",
        "session",
        json!("child-session"),
        1,
    );
    let emissions = f.emitter.0.lock().len();
    observe(
        &f,
        &run,
        "child-session",
        "delta",
        json!("unsaved stream"),
        2,
    );
    assert_eq!(f.emitter.0.lock().len(), emissions);
    let raw: String = f
        .manager
        .db
        .0
        .lock()
        .query_row(
            "SELECT record_json FROM leader_branches WHERE id=?1",
            [&id],
            |r| r.get(0),
        )
        .unwrap();
    assert!(serde_json::from_str::<LeaderBranch>(&raw)
        .unwrap()
        .result
        .is_empty());
    f.manager.checkpoint().unwrap();
    let raw: String = f
        .manager
        .db
        .0
        .lock()
        .query_row(
            "SELECT record_json FROM leader_branches WHERE id=?1",
            [&id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<LeaderBranch>(&raw).unwrap().result,
        "unsaved stream"
    );
    let mut unrelated = event("unrelated", Some("ordinary"), "delta", json!("content"), 1);
    let before = unrelated.clone();
    f.manager.observe(&mut unrelated);
    assert_eq!(unrelated, before);
}

#[tokio::test]
async fn reclaim_walks_descendants_postorder_and_keeps_other_roots() {
    let deletions = Arc::new(Mutex::new(Vec::new()));
    let collected = deletions.clone();
    let f = fixture(Arc::new(move |_, _, session| {
        collected.lock().push(session.to_string());
        Ok(())
    }));
    let (id, run) = spawn(&f, "one");
    observe(
        &f,
        &run,
        "child-session",
        "session",
        json!("child-session"),
        1,
    );
    f.manager.processes.insert(run.clone(), reservation(&run));
    let child_caller = Caller {
        run_id: run.clone(),
        engine: "codex".into(),
        session_id: "child-session".into(),
        workspace_path: f.parent.workspace_path.clone(),
    };
    let child_parent = identity("codex", "child-session", &f.parent.workspace_path);
    let nested = args("nested");
    let Reservation::Start((nested_id, nested_run)) = f
        .manager
        .reserve_spawn(
            &child_caller,
            &child_parent,
            "manual",
            &nested,
            encoded(&nested).unwrap(),
            None,
            None,
        )
        .unwrap()
    else {
        panic!("expected start");
    };
    settle(&f, &nested_id, &nested_run, "grandchild-session");
    f.manager.processes.remove_reservation(&run);
    settle(&f, &id, &run, "child-session");
    let (other_id, other_run) = spawn(&f, "other");
    settle(&f, &other_id, &other_run, "other-session");
    let result = f.manager.reclaim(&f.parent, &id).await.unwrap();
    assert_eq!(result.state, "reclaimed");
    assert_eq!(
        *deletions.lock(),
        vec!["grandchild-session", "child-session"]
    );
    assert_eq!(branch(&f, &nested_id).state, "reclaimed");
    {
        let inner = f.manager.inner.lock();
        assert_erased(inner.branches.get(&id).unwrap());
        assert_erased(inner.branches.get(&nested_id).unwrap());
        let nested_request = inner
            .requests
            .get(&(key(&child_parent), "nested".into()))
            .unwrap();
        assert_eq!(nested_request.state, "reclaimed");
        assert!(nested_request.arguments.is_null());
        assert_eq!(
            nested_request.response.as_ref().unwrap()["branch"]["task"],
            ""
        );
    }
    assert_eq!(branch(&f, &other_id).state, "completed");
    assert!(f.manager.inner.lock().leaders.contains_key(&key(&f.parent)));
    assert_eq!(f.manager.snapshot().unwrap().branches.len(), 1);
}

#[tokio::test]
async fn reclaimed_and_retired_continuation_events_keep_envelope_without_revival() {
    let f = basic();
    let (id, run) = spawn(&f, "one");
    settle(&f, &id, &run, "child-session");
    f.manager.reclaim(&f.parent, &id).await.unwrap();
    let mut late = event(
        &format!("{run}-c1"),
        Some("child-session"),
        "delta",
        json!("late"),
        50,
    );
    f.manager.observe(&mut late);
    assert_eq!(late["leader"]["reclaimed"], true);
    assert_eq!(late["leader"]["branchId"], id);
    assert_eq!(branch(&f, &id).state, "reclaimed");
    assert_eq!(branch(&f, &id).result, "");
    assert!(f
        .manager
        .prepare(
            "new-run",
            "codex",
            Some("child-session"),
            &f.parent.workspace_path,
            Some("manual")
        )
        .is_err());
}

#[tokio::test]
async fn deletion_failure_preserves_identity_and_allows_explicit_reclaim_retry() {
    let fail = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let switch = fail.clone();
    let f = fixture(Arc::new(move |_, _, _| {
        if switch.load(Ordering::SeqCst) {
            Err("disk is unavailable".into())
        } else {
            Ok(())
        }
    }));
    let (id, run) = spawn(&f, "one");
    settle(&f, &id, &run, "child-session");
    assert!(f.manager.reclaim(&f.parent, &id).await.is_err());
    let failed = branch(&f, &id);
    assert_eq!(failed.session_id.as_deref(), Some("child-session"));
    assert_eq!(failed.state, "unknown");
    assert!(!f.manager.inner.lock().branches.get(&id).unwrap().stopping);
    assert!(ensure_unmanaged(&f.manager.db, "codex", "child-session").is_err());
    fail.store(false, Ordering::SeqCst);
    assert_eq!(
        f.manager.reclaim(&f.parent, &id).await.unwrap().state,
        "reclaimed"
    );
}

#[tokio::test(start_paused = true)]
async fn pending_launch_stop_timeout_releases_latch_for_retirement_and_retry() {
    let f = basic();
    let (id, run) = spawn(&f, "one");
    let manager = f.manager.clone();
    let parent = f.parent.clone();
    let branch_id = id.clone();
    let stop = tokio::spawn(async move { manager.stop(&parent, &branch_id).await });
    tokio::task::yield_now().await;
    tokio::time::advance(RETIRE_TIMEOUT + Duration::from_secs(1)).await;
    assert!(stop.await.unwrap().is_err());
    assert_eq!(branch(&f, &id).state, "unknown");
    assert!(!f.manager.inner.lock().branches.get(&id).unwrap().stopping);
    f.manager.finish(&run);
    assert_eq!(
        f.manager.stop(&f.parent, &id).await.unwrap().state,
        "stopped"
    );
    assert_eq!(
        f.manager.reclaim(&f.parent, &id).await.unwrap().state,
        "reclaimed"
    );
}

#[test]
fn ordinary_retirement_atomically_fences_new_runs_and_clears_on_drop() {
    let f = basic();
    // Ordinary retirement covers disabled/non-Leader chats; enabled roots use group actions.
    f.manager
        .db
        .0
        .lock()
        .execute("UPDATE leader_roles SET enabled=0", [])
        .unwrap();
    {
        let mut inner = f.manager.inner.lock();
        inner.leaders.remove(&key(&f.parent));
        inner.disabled.insert(key(&f.parent));
    }
    f.manager.finish(&f.caller.run_id);
    f.manager.processes.remove_reservation(&f.caller.run_id);
    let guard = f
        .manager
        .begin_retirement("claude", "parent-session")
        .unwrap();
    assert!(f
        .manager
        .prepare(
            "new-parent",
            "claude",
            Some("parent-session"),
            &f.parent.workspace_path,
            Some("manual")
        )
        .is_err());
    assert!(f
        .manager
        .begin_retirement("claude", "parent-session")
        .is_err());
    drop(guard);
    assert!(f
        .manager
        .prepare(
            "new-parent",
            "claude",
            Some("parent-session"),
            &f.parent.workspace_path,
            Some("manual")
        )
        .is_ok());
}

#[test]
fn disabled_legacy_role_does_not_disable_task_capability_after_restart() {
    let f = basic();
    {
        let mut inner = f.manager.inner.lock();
        inner.leaders.remove(&key(&f.parent));
        inner.disabled.insert(key(&f.parent));
    }
    f.manager
        .db
        .0
        .lock()
        .execute("UPDATE leader_roles SET enabled=0", [])
        .unwrap();
    assert_eq!(
        f.manager
            .prepare(
                "disabled-root",
                "claude",
                Some("parent-session"),
                &f.parent.workspace_path,
                Some("manual")
            )
            .unwrap(),
        Some(role(false))
    );
    f.manager.processes.insert("disabled-root".into(), reservation("disabled-root"));
    assert!(f.manager.run_has_task_capability("disabled-root"));
    assert!(f.manager.run_has_task_capability(&f.caller.run_id));
    assert_eq!(
        f.manager
            .prepare(
                "ordinary-root",
                "claude",
                Some("never-managed"),
                &f.parent.workspace_path,
                Some("manual")
            )
            .unwrap(),
        Some(role(false))
    );
    let recovered = LeaderManager::with_services(
        f.manager.db.clone(),
        Arc::new(crate::engine::ProcessRegistry::default()),
        f.emitter.clone(),
        Arc::new(|| 2_000_000),
        Arc::new(|_, _, _| Ok(())),
    )
    .unwrap();
    assert!(recovered.snapshot().unwrap().leaders.is_empty());
    assert_eq!(
        recovered
            .prepare(
                "disabled-root-after-restart",
                "claude",
                Some("parent-session"),
                &f.parent.workspace_path,
                Some("manual")
            )
            .unwrap(),
        Some(role(false))
    );
}

#[test]
fn unmanaged_guard_rejects_parent_with_children_and_child_even_when_idle() {
    let f = basic();
    let (id, run) = spawn(&f, "one");
    settle(&f, &id, &run, "child-session");
    assert!(ensure_unmanaged(&f.manager.db, "claude", "parent-session").is_err());
    assert!(ensure_unmanaged(&f.manager.db, "codex", "child-session").is_err());
    assert!(ensure_unmanaged(&f.manager.db, "claude", "unrelated-session").is_ok());
    assert!(f
        .manager
        .begin_retirement("claude", "parent-session")
        .is_err());
}

#[test]
fn unknown_run_cannot_bind_to_managed_identity() {
    let f = basic();
    let (id, run) = spawn(&f, "one");
    settle(&f, &id, &run, "child-session");
    for (engine, session) in [("claude", "parent-session"), ("codex", "child-session")] {
        assert!(
            f.manager
                .check_binding(&f.manager.inner.lock(), "isolated-unknown", engine, session)
                .is_err(),
            "an unregistered run adopted managed identity {engine}/{session}"
        );
    }
}

#[test]
fn isolated_launch_rejects_roots_children_and_tombstones_across_workspace_aliases() {
    let f = basic();
    let (id, run) = spawn(&f, "one");
    settle(&f, &id, &run, "child-session");
    assert!(f
        .manager
        .prepare_isolated(
            "plugin-root",
            "claude",
            Some("parent-session"),
            "WORKSPACE-ALIAS",
            &Arc::new(std::sync::atomic::AtomicBool::new(false))
        )
        .is_err());
    f.manager.inner.lock().leaders.remove(&key(&f.parent));
    for state in ["completed", "running", "waiting", "reclaiming", "reclaimed"] {
        f.manager
            .inner
            .lock()
            .branches
            .get_mut(&id)
            .unwrap()
            .branch
            .state = state.into();
        assert!(
            f.manager
                .prepare_isolated(
                    "mission-child",
                    "codex",
                    Some("child-session"),
                    "WORKSPACE-ALIAS",
                    &Arc::new(std::sync::atomic::AtomicBool::new(false))
                )
                .is_err(),
            "allowed child in {state}"
        );
        assert_eq!(
            f.manager
                .prepare_isolated(
                    "plugin-disabled-root",
                    "claude",
                    Some("parent-session"),
                    "WORKSPACE-ALIAS",
                    &Arc::new(std::sync::atomic::AtomicBool::new(false))
                )
                .is_err(),
            state != "reclaimed"
        );
        f.manager.finish("plugin-disabled-root");
    }
    assert!(f
        .manager
        .prepare_isolated(
            "ordinary-isolated",
            "claude",
            Some("unrelated"),
            "WORKSPACE-ALIAS",
            &Arc::new(std::sync::atomic::AtomicBool::new(false))
        )
        .is_ok());
    assert_eq!(branch(&f, &id).run_id.as_deref(), Some(run.as_str()));
}

#[test]
fn isolated_reservation_and_retirement_fence_each_other_until_finish() {
    let f = basic();
    f.manager
        .prepare_isolated(
            "isolated-pending",
            "claude",
            Some("unrelated"),
            &f.parent.workspace_path,
            &Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
        .unwrap();
    assert!(f.manager.begin_retirement("claude", "unrelated").is_err());
    assert!(f
        .manager
        .ensure_no_isolated_run(&f.manager.inner.lock(), "claude", "unrelated")
        .is_err());
    f.manager.finish("isolated-pending");
    let retirement = f.manager.begin_retirement("claude", "unrelated").unwrap();
    assert!(f
        .manager
        .prepare_isolated(
            "isolated-late",
            "claude",
            Some("unrelated"),
            &f.parent.workspace_path,
            &Arc::new(std::sync::atomic::AtomicBool::new(false))
        )
        .is_err());
    f.manager
        .prepare_isolated(
            "isolated-fresh",
            "claude",
            None,
            &f.parent.workspace_path,
            &Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
        .unwrap();
    assert!(f
        .manager
        .bind_session("isolated-fresh", "claude", "unrelated")
        .is_err());
    drop(retirement);
    f.manager
        .bind_session("isolated-fresh", "claude", "unrelated")
        .unwrap();
    assert!(f.manager.begin_retirement("claude", "unrelated").is_err());
    f.manager.finish("isolated-fresh");
    assert!(f.manager.begin_retirement("claude", "unrelated").is_ok());
}

#[test]
fn isolated_runs_never_acquire_caller_authority_or_rebind_managed_sessions() {
    let f = basic();
    let (id, run) = spawn(&f, "one");
    settle(&f, &id, &run, "child-session");
    f.manager
        .prepare_isolated(
            "isolated-fresh",
            "codex",
            None,
            &f.parent.workspace_path,
            &Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
        .unwrap();
    for state in ["completed", "reclaiming", "reclaimed"] {
        f.manager
            .inner
            .lock()
            .branches
            .get_mut(&id)
            .unwrap()
            .branch
            .state = state.into();
        assert!(f
            .manager
            .bind_session("isolated-fresh", "codex", "child-session")
            .is_err());
        assert!(f
            .manager
            .inner
            .lock()
            .runs
            .get("isolated-fresh")
            .unwrap()
            .session_id
            .is_none());
    }
    f.manager
        .bind_session("isolated-fresh", "codex", "fresh-isolated-session")
        .unwrap();
    f.manager
        .processes
        .insert("isolated-fresh".into(), reservation("isolated-fresh"));
    let caller = Caller {
        run_id: "isolated-fresh".into(),
        engine: "codex".into(),
        session_id: "fresh-isolated-session".into(),
        workspace_path: f.parent.workspace_path.clone(),
    };
    // Even a later role change cannot convert this run's launch bookkeeping
    // into the trusted ordinary-chat capability.
    let root = identity(&caller.engine, &caller.session_id, &caller.workspace_path);
    f.manager.inner.lock().leaders.insert(key(&root), root);
    assert!(f
        .manager
        .authorize(&f.manager.inner.lock(), &caller)
        .is_err());
    assert!(f
        .manager
        .prepare(
            &caller.run_id,
            &caller.engine,
            Some(&caller.session_id),
            &caller.workspace_path,
            None
        )
        .is_err());
    assert_eq!(branch(&f, &id).run_id.as_deref(), Some(run.as_str()));
}

#[test]
fn managed_first_binding_cannot_take_an_isolated_launch_identity() {
    let f = basic();
    let (_, managed_run) = spawn(&f, "one");
    f.manager
        .prepare_isolated(
            "isolated-pending",
            "codex",
            Some("still-unmanaged"),
            &f.parent.workspace_path,
            &Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
        .unwrap();
    assert!(f
        .manager
        .check_binding(
            &f.manager.inner.lock(),
            &managed_run,
            "codex",
            "still-unmanaged"
        )
        .is_err());
    f.manager.finish("isolated-pending");
    assert!(f
        .manager
        .check_binding(
            &f.manager.inner.lock(),
            &managed_run,
            "codex",
            "still-unmanaged"
        )
        .is_ok());
}

#[test]
fn isolated_resume_and_announced_id_both_remain_fenced() {
    let f = basic();
    f.manager
        .prepare_isolated(
            "isolated-resume",
            "claude",
            Some("resume-id"),
            &f.parent.workspace_path,
            &Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
        .unwrap();
    f.manager
        .bind_session("isolated-resume", "claude", "announced-id")
        .unwrap();
    for session in ["resume-id", "announced-id"] {
        assert!(f.manager.begin_retirement("claude", session).is_err());
        assert!(f
            .manager
            .ensure_no_isolated_run(&f.manager.inner.lock(), "claude", session)
            .is_err());
    }
    f.manager.finish("isolated-resume");
    for session in ["resume-id", "announced-id"] {
        assert!(f.manager.begin_retirement("claude", session).is_ok());
        assert!(f
            .manager
            .ensure_no_isolated_run(&f.manager.inner.lock(), "claude", session)
            .is_ok());
    }
}

#[test]
fn completed_isolated_request_ids_can_retry_without_reusing_trusted_run_ids() {
    let f = basic();
    f.manager
        .prepare_isolated(
            "isolated-request",
            "claude",
            Some("unrelated"),
            &f.parent.workspace_path,
            &Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
        .unwrap();
    f.manager.finish("isolated-request");
    f.manager
        .prepare_isolated(
            "isolated-request",
            "codex",
            None,
            &f.parent.workspace_path,
            &Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
        .unwrap();
    assert!(
        !f.manager
            .inner
            .lock()
            .runs
            .get("isolated-request")
            .unwrap()
            .retired
    );
    f.manager.finish(&f.caller.run_id);
    f.manager.processes.remove_reservation(&f.caller.run_id);
    assert!(f
        .manager
        .prepare_isolated(
            &f.caller.run_id,
            "codex",
            None,
            &f.parent.workspace_path,
            &Arc::new(std::sync::atomic::AtomicBool::new(false))
        )
        .is_err());
}

#[test]
fn isolated_retry_waits_for_old_finish_and_owns_the_new_placeholder() {
    let f = basic();
    let run = "isolated-request";
    let old_marker = Arc::new(std::sync::atomic::AtomicBool::new(false));
    f.manager
        .prepare_isolated(
            run,
            "claude",
            Some("unrelated"),
            &f.parent.workspace_path,
            &old_marker,
        )
        .unwrap();
    // Model RunContext::drop after removing registry entries, before finish.
    let new_entry = reservation(run);
    let new_marker = Arc::clone(&new_entry.killed);
    f.manager.processes.insert(run.into(), new_entry);
    assert!(f
        .manager
        .prepare_isolated(
            run,
            "claude",
            Some("unrelated"),
            &f.parent.workspace_path,
            &new_marker
        )
        .is_err());
    f.manager.finish(run);
    assert!(f
        .manager
        .prepare_isolated(
            run,
            "claude",
            Some("unrelated"),
            &f.parent.workspace_path,
            &old_marker
        )
        .is_err());
    f.manager
        .prepare_isolated(
            run,
            "claude",
            Some("unrelated"),
            &f.parent.workspace_path,
            &new_marker,
        )
        .unwrap();
    assert!(!f.manager.inner.lock().runs.get(run).unwrap().retired);
}

fn launch_marker() -> Arc<std::sync::atomic::AtomicBool> {
    Arc::new(std::sync::atomic::AtomicBool::new(false))
}

fn durable_session(f: &Fixture, id: &str) -> Option<String> {
    f.manager
        .db
        .0
        .lock()
        .query_row(
            "SELECT session_id FROM leader_branches WHERE id=?1",
            [id],
            |row| row.get(0),
        )
        .unwrap()
}

// The reader validates, then claims the registry alias, then commits. Between
// those steps the child's identity is not yet in its branch.
#[test]
fn managed_first_binding_fences_isolated_launch_and_retirement_before_commit() {
    let f = basic();
    let (id, run) = spawn(&f, "one");
    f.manager.bind_session(&run, "codex", "child-new").unwrap();
    assert!(
        branch(&f, &id).session_id.is_none(),
        "identity attributed before the alias claim"
    );
    let ws = f.parent.workspace_path.clone();
    assert!(f
        .manager
        .prepare_isolated(
            "plugin-race",
            "codex",
            Some("child-new"),
            &ws,
            &launch_marker()
        )
        .is_err());
    f.manager
        .prepare_isolated("plugin-fresh", "codex", None, &ws, &launch_marker())
        .unwrap();
    assert!(f
        .manager
        .bind_session("plugin-fresh", "codex", "child-new")
        .is_err());
    assert!(f.manager.begin_retirement("codex", "child-new").is_err());
    f.manager
        .processes
        .insert("gui-resume".into(), reservation("gui-resume"));
    assert!(f
        .manager
        .prepare("gui-resume", "codex", Some("child-new"), &ws, None)
        .is_err());
}

#[test]
fn concurrent_children_cannot_reserve_one_first_identity() {
    let f = basic();
    let (_, first) = spawn(&f, "a");
    let (second_id, second) = spawn(&f, "b");
    f.manager
        .bind_session(&first, "codex", "same-session")
        .unwrap();
    assert!(f
        .manager
        .bind_session(&second, "codex", "same-session")
        .is_err());
    f.manager.commit_binding(&first, "codex", "same-session").unwrap();
    assert!(f
        .manager
        .bind_session(&second, "codex", "same-session")
        .is_err());
    assert!(branch(&f, &second_id).session_id.is_none());
}

#[test]
fn managed_binding_commits_durably_only_after_the_alias_claim() {
    let f = basic();
    let (id, run) = spawn(&f, "one");
    assert_eq!(
        f.manager.bind_session(&run, "codex", "child-new").unwrap(),
        SessionBinding::Adopt
    );
    // Mismatched or foreign commits cannot attribute an identity.
    f.manager.commit_binding(&run, "codex", "other-session").unwrap();
    f.manager
        .commit_binding("someone-else", "codex", "child-new").unwrap();
    assert!(branch(&f, &id).session_id.is_none());
    f.manager.commit_binding(&run, "codex", "child-new").unwrap();
    assert_eq!(branch(&f, &id).session_id.as_deref(), Some("child-new"));
    assert_eq!(durable_session(&f, &id).as_deref(), Some("child-new"));
    assert!(f.manager.inner.lock().pending_bindings.is_empty());
    let event = observe(&f, &run, "child-new", "session", json!("child-new"), 1);
    assert!(event["leader"].get("identityRejected").is_none());
    assert_eq!(branch(&f, &id).state, "running");
    let error = f
        .manager
        .prepare_isolated(
            "plugin-late",
            "codex",
            Some("child-new"),
            &f.parent.workspace_path,
            &launch_marker(),
        )
        .unwrap_err();
    assert!(error.contains("managed"), "{error}");
}

#[test]
fn failed_alias_claim_releases_the_reservation_without_attribution() {
    let f = basic();
    let (id, run) = spawn(&f, "one");
    f.manager
        .bind_session(&run, "codex", "foreign-session")
        .unwrap();
    f.manager.release_binding(&run, "codex", "foreign-session");
    // A commit after release (or a replay) is not an ownership claim.
    f.manager.commit_binding(&run, "codex", "foreign-session").unwrap();
    assert!(branch(&f, &id).session_id.is_none());
    assert!(durable_session(&f, &id).is_none());
    assert!(f
        .manager
        .inner
        .lock()
        .runs
        .get(&run)
        .unwrap()
        .session_id
        .is_none());
    assert!(f
        .manager
        .begin_retirement("codex", "foreign-session")
        .is_ok());
}

#[test]
fn pending_isolated_binding_fences_managed_identity_until_released_or_finished() {
    let f = basic();
    let (_, run) = spawn(&f, "one");
    let ws = f.parent.workspace_path.clone();
    f.manager
        .prepare_isolated("plugin-fresh", "codex", None, &ws, &launch_marker())
        .unwrap();
    f.manager
        .bind_session("plugin-fresh", "codex", "contested")
        .unwrap();
    assert!(f.manager.bind_session(&run, "codex", "contested").is_err());
    assert!(f
        .manager
        .ensure_no_isolated_run(&f.manager.inner.lock(), "codex", "contested")
        .is_err());
    f.manager
        .release_binding("plugin-fresh", "codex", "contested");
    assert!(f
        .manager
        .ensure_no_isolated_run(&f.manager.inner.lock(), "codex", "contested")
        .is_ok());
    f.manager
        .bind_session("plugin-fresh", "codex", "contested-again")
        .unwrap();
    f.manager.finish("plugin-fresh");
    assert!(f.manager.inner.lock().pending_bindings.is_empty());
    assert!(f
        .manager
        .begin_retirement("codex", "contested-again")
        .is_ok());
}

async fn wait_for_state(f: &Fixture, id: &str, state: &str) {
    for _ in 0..200 {
        if branch(f, id).state == state {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("branch never reached {state}");
}

fn recording_fixture() -> (Fixture, Arc<Mutex<Vec<String>>>) {
    let deleted = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&deleted);
    let f = fixture(Arc::new(move |_, _, session| {
        seen.lock().push(session.to_string());
        Ok(())
    }));
    (f, deleted)
}

#[tokio::test]
async fn reclaim_deletes_only_identities_the_child_actually_claimed() {
    let (f, deleted) = recording_fixture();
    let (failed, failed_run) = spawn(&f, "failed-claim");
    f.manager
        .bind_session(&failed_run, "codex", "foreign-session")
        .unwrap();
    f.manager
        .release_binding(&failed_run, "codex", "foreign-session");
    f.manager.finish(&failed_run);
    let (claimed, claimed_run) = spawn(&f, "claimed");
    f.manager
        .bind_session(&claimed_run, "codex", "child-claimed")
        .unwrap();
    f.manager
        .commit_binding(&claimed_run, "codex", "child-claimed").unwrap();
    f.manager.finish(&claimed_run);
    f.manager.reclaim(&f.parent, &failed).await.unwrap();
    f.manager.reclaim(&f.parent, &claimed).await.unwrap();
    assert_eq!(*deleted.lock(), vec!["child-claimed".to_string()]);
}

#[tokio::test]
async fn identity_claimed_while_reclaim_waits_is_still_cleaned_up() {
    let (f, deleted) = recording_fixture();
    let (id, run) = spawn(&f, "one");
    f.manager.bind_session(&run, "codex", "child-late").unwrap();
    let manager = Arc::clone(&f.manager);
    let parent = f.parent.clone();
    let branch_id = id.clone();
    let reclaim = tokio::spawn(async move { manager.reclaim(&parent, &branch_id).await });
    wait_for_state(&f, &id, "reclaiming").await;
    f.manager.commit_binding(&run, "codex", "child-late").unwrap();
    f.manager.finish(&run);
    let reclaimed = reclaim.await.unwrap().unwrap();
    assert_eq!(reclaimed.state, "reclaimed");
    assert_eq!(*deleted.lock(), vec!["child-late".to_string()]);
}

#[tokio::test]
async fn first_identity_after_reclaim_began_is_recorded_only_for_cleanup() {
    let (f, deleted) = recording_fixture();
    let (id, run) = spawn(&f, "one");
    let manager = Arc::clone(&f.manager);
    let parent = f.parent.clone();
    let branch_id = id.clone();
    let reclaim = tokio::spawn(async move { manager.reclaim(&parent, &branch_id).await });
    wait_for_state(&f, &id, "reclaiming").await;
    assert_eq!(
        f.manager
            .bind_session(&run, "codex", "child-cleanup")
            .unwrap(),
        SessionBinding::CleanupOnly
    );
    // Never adopted: events and acknowledgements still see an inactive run.
    assert!(f
        .manager
        .check_binding(&f.manager.inner.lock(), &run, "codex", "child-cleanup")
        .is_err());
    f.manager.commit_binding(&run, "codex", "child-cleanup").unwrap();
    f.manager.finish(&run);
    reclaim.await.unwrap().unwrap();
    assert_eq!(*deleted.lock(), vec!["child-cleanup".to_string()]);
    // A tombstone accepts no further identity.
    assert!(f
        .manager
        .bind_session(&run, "codex", "after-tombstone")
        .is_err());
}

#[test]
fn overlapping_managed_gui_send_is_fenced_until_real_retirement() {
    let f = basic();
    let (id, run) = spawn(&f, "one");
    observe(
        &f,
        &run,
        "child-session",
        "session",
        json!("child-session"),
        1,
    );
    f.manager.processes.insert(run.clone(), reservation(&run));
    observe(&f, &run, "child-session", "done", json!({}), 2);
    assert!(f
        .manager
        .prepare(
            "overlap",
            "codex",
            Some("child-session"),
            &f.parent.workspace_path,
            Some("manual")
        )
        .is_err());
    f.manager.finish(&run);
    f.manager.processes.remove_reservation(&run);
    assert!(f
        .manager
        .prepare(
            "next-run",
            "codex",
            Some("child-session"),
            &f.parent.workspace_path,
            Some("manual")
        )
        .unwrap()
        .is_some());
    assert_eq!(branch(&f, &id).run_id.as_deref(), Some("next-run"));
}

#[test]
fn distinct_identical_assistant_messages_are_preserved_but_event_replay_is_ignored() {
    let f = basic();
    let (id, run) = spawn(&f, "one");
    observe(
        &f,
        &run,
        "child-session",
        "message",
        json!({"role":"assistant","text":"OK🙂"}),
        1,
    );
    observe(
        &f,
        &run,
        "child-session",
        "message",
        json!({"role":"assistant","text":"OK🙂"}),
        2,
    );
    observe(
        &f,
        &run,
        "child-session",
        "message",
        json!({"role":"assistant","text":"OK🙂"}),
        2,
    );
    assert_eq!(branch(&f, &id).result, "OK🙂OK🙂");
}

#[test]
fn forged_parent_sibling_and_saved_chat_bindings_do_not_grant_child_authority() {
    let f = basic();
    let mut same_engine = args("parent-collision");
    same_engine.engine = "claude".into();
    let Reservation::Start((id, run)) = f
        .manager
        .reserve_spawn(
            &f.caller,
            &f.parent,
            "manual",
            &same_engine,
            encoded(&same_engine).unwrap(),
            None,
            None,
        )
        .unwrap()
    else {
        panic!("expected start");
    };
    assert!(f
        .manager
        .check_binding(&f.manager.inner.lock(), &run, "claude", "parent-session")
        .is_err());
    let mut malicious = json!({"runId":run,"engine":"claude","sessionId":"parent-session","kind":"session","data":"parent-session","seq":1});
    f.manager.observe(&mut malicious);
    assert_eq!(malicious["leader"]["identityRejected"], true);
    assert!(f
        .manager
        .inner
        .lock()
        .runs
        .get(&run)
        .unwrap()
        .session_id
        .is_none());
    assert!(branch(&f, &id).session_id.is_none());
    f.manager.processes.insert(run.clone(), reservation(&run));
    let impersonation = Caller {
        run_id: run,
        engine: "claude".into(),
        session_id: "parent-session".into(),
        workspace_path: f.parent.workspace_path.clone(),
    };
    assert!(f
        .manager
        .authorize(&f.manager.inner.lock(), &impersonation)
        .is_err());
    let (sibling, sibling_run) = spawn(&f, "sibling");
    observe(
        &f,
        &sibling_run,
        "sibling-session",
        "session",
        json!("sibling-session"),
        1,
    );
    let (_other, other_run) = spawn(&f, "other");
    assert!(f
        .manager
        .check_binding(
            &f.manager.inner.lock(),
            &other_run,
            "codex",
            "sibling-session"
        )
        .is_err());
    let rejected = observe(
        &f,
        &other_run,
        "sibling-session",
        "session",
        json!("sibling-session"),
        1,
    );
    assert_eq!(rejected["leader"]["identityRejected"], true);
    assert_eq!(
        branch(&f, &sibling).session_id.as_deref(),
        Some("sibling-session")
    );
    let (_cached, cached_run) = spawn(&f, "cached");
    f.manager
        .db
        .0
        .lock()
        .execute(
            "INSERT INTO sessions(engine,session_id,workspace_path) VALUES('codex','existing-session','known-local-workspace')",
            [],
        )
        .unwrap();
    assert!(f
        .manager
        .check_binding(
            &f.manager.inner.lock(),
            &cached_run,
            "codex",
            "existing-session"
        )
        .is_err());
}

#[test]
fn tool_views_and_acknowledgements_fit_relay_budget_without_mutating_records() {
    let f = basic();
    for index in 0..9 {
        let (id, _run) = spawn(&f, &format!("branch-{index}"));
        let mut inner = f.manager.inner.lock();
        let record = inner.branches.get_mut(&id).unwrap();
        record.branch.task = "界".repeat(MAX_INPUT_CHARS);
        record.branch.result = "🙂".repeat(MAX_RESULT_CHARS);
        record.branch.error = Some("native failure ".repeat(100_000));
    }
    let inner = f.manager.inner.lock();
    let views = f.manager.views(&inner, &f.parent, None).unwrap();
    let bytes = serde_json::to_vec(&json!({"branches":views})).unwrap();
    assert!(bytes.len() < MAX_TOOL_RESPONSE_BYTES);
    assert_eq!(
        inner
            .branches
            .values()
            .next()
            .unwrap()
            .branch
            .task
            .chars()
            .count(),
        MAX_INPUT_CHARS
    );
    assert_eq!(
        inner
            .branches
            .values()
            .next()
            .unwrap()
            .branch
            .result
            .chars()
            .count(),
        MAX_RESULT_CHARS
    );
    drop(inner);
    let (id, run) = spawn(&f, "large-ack");
    {
        let mut inner = f.manager.inner.lock();
        let record = inner.branches.get_mut(&id).unwrap();
        record.branch.task = "\u{1}".repeat(MAX_INPUT_CHARS);
        record.branch.error = Some("x".repeat(2 * 1024 * 1024));
    }
    let reply = f
        .manager
        .acknowledge(
            &f.parent,
            "large-ack",
            &run,
            Ok(crate::engine::SendResult {
                run_id: run.clone(),
                session_id: None,
            }),
        )
        .unwrap();
    assert!(serde_json::to_vec(&reply).unwrap().len() < MAX_TOOL_RESPONSE_BYTES);
    assert_eq!(reply["branch"]["taskTruncated"], true);
    assert_eq!(reply["branch"]["errorTruncated"], true);
}

#[tokio::test]
async fn tombstone_checkpoint_failure_clears_reclaim_fences_and_preserves_identity() {
    let f = basic();
    let (id, run) = spawn(&f, "one");
    settle(&f, &id, &run, "child-session");
    f.manager
        .db
        .0
        .lock()
        .execute_batch(
            "CREATE TRIGGER reject_tombstone BEFORE UPDATE ON leader_branches
        WHEN NEW.state='reclaimed' BEGIN SELECT RAISE(ABORT,'checkpoint unavailable'); END;",
        )
        .unwrap();
    assert!(f.manager.reclaim(&f.parent, &id).await.is_err());
    assert_eq!(branch(&f, &id).state, "unknown");
    assert_eq!(branch(&f, &id).session_id.as_deref(), Some("child-session"));
    assert!(!f.manager.inner.lock().branches.get(&id).unwrap().stopping);
    f.manager
        .db
        .0
        .lock()
        .execute_batch("DROP TRIGGER reject_tombstone;")
        .unwrap();
    assert_eq!(
        f.manager.reclaim(&f.parent, &id).await.unwrap().state,
        "reclaimed"
    );
}

#[test]
fn request_fingerprints_match_json_equality_and_validated_arguments() {
    let first: Value = serde_json::from_str(
        r#"{"nested":{"第二":"🙂","first":[null,true,{"b":2,"a":1}]},"numbers":[0,18446744073709551615,-1,1.0,-0.0]}"#,
    )
    .unwrap();
    let reordered: Value = serde_json::from_str(
        r#"{"numbers":[0,18446744073709551615,-1,1.0,0.0],"nested":{"first":[null,true,{"a":1,"b":2}],"第二":"🙂"}}"#,
    )
    .unwrap();
    assert_eq!(first, reordered);
    let fingerprint = arguments_fingerprint(&first).unwrap();
    assert_eq!(fingerprint, arguments_fingerprint(&reordered).unwrap());
    assert_eq!(fingerprint.len(), 64);
    assert!(fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let mut different = reordered.clone();
    different["numbers"][3] = json!(1);
    assert_ne!(first, different);
    assert_ne!(fingerprint, arguments_fingerprint(&different).unwrap());
    different = reordered.clone();
    different["nested"]["first"]
        .as_array_mut()
        .unwrap()
        .reverse();
    assert_ne!(fingerprint, arguments_fingerprint(&different).unwrap());

    let validated = validate_arguments("task_spawn", encoded(&args("one")).unwrap()).unwrap();
    let reordered: Value = serde_json::from_str(
        r#"{"ttl_seconds":60,"effort":null,"task":"Check the parser and report concrete evidence.","model":null,"title":"Inspect parsing","engine":"codex","request_id":"one"}"#,
    )
    .unwrap();
    assert_eq!(
        arguments_fingerprint(&validated).unwrap(),
        arguments_fingerprint(&validate_arguments("task_spawn", reordered).unwrap()).unwrap()
    );
}

#[tokio::test]
async fn reclamation_erases_branch_and_all_requests_without_touching_sibling() {
    let f = basic();
    let mut spawn_args = args("private-spawn");
    spawn_args.title = "private-title-sentinel".into();
    spawn_args.task = "private-task-sentinel".into();
    spawn_args.model = Some("private-model-sentinel".into());
    spawn_args.effort = Some("private-effort-sentinel".into());
    let Reservation::Start((id, run)) = f
        .manager
        .reserve_spawn(
            &f.caller,
            &f.parent,
            "manual",
            &spawn_args,
            encoded(&spawn_args).unwrap(),
            spawn_args.model.clone(),
            spawn_args.effort.clone(),
        )
        .unwrap()
    else {
        panic!("expected start")
    };
    {
        let inner = f.manager.inner.lock();
        let request = inner
            .requests
            .get(&(key(&f.parent), "private-spawn".into()))
            .unwrap();
        assert!(request.arguments.is_null());
        assert_eq!(
            request.arguments_fingerprint.as_deref(),
            Some(
                arguments_fingerprint(&encoded(&spawn_args).unwrap())
                    .unwrap()
                    .as_str()
            )
        );
        let serialized = serde_json::to_string(request).unwrap();
        assert!(!serialized.contains("private-task-sentinel"));
        assert!(!serialized.contains("private-title-sentinel"));
    }
    observe(
        &f,
        &run,
        "private-session",
        "session",
        json!("private-session"),
        1,
    );
    observe(
        &f,
        &run,
        "private-session",
        "delta",
        json!("private-first-result-sentinel"),
        2,
    );
    observe(
        &f,
        &run,
        "private-session",
        "permission_denied",
        json!({"message":"private-first-error-sentinel"}),
        3,
    );
    observe(&f, &run, "private-session", "done", json!({}), 4);
    f.manager.finish(&run);
    let cached = f
        .manager
        .acknowledge(
            &f.parent,
            "private-spawn",
            &run,
            Ok(crate::engine::SendResult {
                run_id: run.clone(),
                session_id: Some("private-session".into()),
            }),
        )
        .unwrap();
    assert_eq!(cached["branch"]["result"], "private-first-result-sentinel");

    let send_args = SendArgs {
        branch_id: id.clone(),
        request_id: "private-send".into(),
        message: "private-message-sentinel".into(),
    };
    hot_send_cache(&f, &id);
    let Reservation::Start((_, send_run)) = f
        .manager
        .reserve_send(
            &f.caller,
            &f.parent,
            "manual",
            &send_args,
            encoded(&send_args).unwrap(),
        )
        .unwrap()
    else {
        panic!("expected send")
    };
    observe(
        &f,
        &send_run,
        "private-session",
        "delta",
        json!("private-second-result-sentinel"),
        1,
    );
    observe(
        &f,
        &send_run,
        "private-session",
        "question",
        json!({"requestId":"private-question-sentinel"}),
        2,
    );
    observe(
        &f,
        &send_run,
        "private-session",
        "plan_review",
        json!({"planId":"private-plan-sentinel"}),
        3,
    );
    observe(
        &f,
        &send_run,
        "private-session",
        "permission_denied",
        json!({"message":"private-second-error-sentinel"}),
        4,
    );
    f.manager.finish(&send_run);
    assert!(f
        .manager
        .acknowledge(
            &f.parent,
            "private-send",
            &send_run,
            Err("private-request-error-sentinel".into())
        )
        .is_err());
    {
        let mut inner = f.manager.inner.lock();
        let record = inner.branches.get_mut(&id).unwrap();
        assert!(record.output.stream_start.is_some());
        assert!(!record.questions.is_empty());
        assert!(!record.plans.is_empty());
        record.branch.result_truncated = true;
        record.output.stream_prefix_truncated = true;
        record.dirty = true;
    }
    f.manager.checkpoint().unwrap();
    let (sibling_id, sibling_run) = spawn(&f, "sibling");
    observe(
        &f,
        &sibling_run,
        "sibling-session",
        "delta",
        json!("sibling-result-preserved"),
        1,
    );
    observe(&f, &sibling_run, "sibling-session", "done", json!({}), 2);
    f.manager.finish(&sibling_run);
    f.manager
        .acknowledge(
            &f.parent,
            "sibling",
            &sibling_run,
            Ok(crate::engine::SendResult {
                run_id: sibling_run.clone(),
                session_id: Some("sibling-session".into()),
            }),
        )
        .unwrap();
    let sibling_before = encoded(&branch(&f, &sibling_id)).unwrap();
    let sibling_request_before = encoded(
        f.manager
            .inner
            .lock()
            .requests
            .get(&(key(&f.parent), "sibling".into()))
            .unwrap(),
    )
    .unwrap();
    let count_before = f.manager.inner.lock().runs.len();
    let sentinels = [
        "private-title-sentinel",
        "private-task-sentinel",
        "private-model-sentinel",
        "private-effort-sentinel",
        "private-first-result-sentinel",
        "private-first-error-sentinel",
        "private-message-sentinel",
        "private-second-result-sentinel",
        "private-second-error-sentinel",
        "private-request-error-sentinel",
        "private-question-sentinel",
        "private-plan-sentinel",
    ];
    let before = content_rows(&f).join("\n");
    assert!(before.contains("private-first-result-sentinel"));
    assert!(before.contains("private-second-result-sentinel"));
    assert!(before.contains("private-request-error-sentinel"));
    let reclaimed = f.manager.reclaim(&f.parent, &id).await.unwrap();
    assert_eq!(reclaimed.session_id.as_deref(), Some("private-session"));
    assert_eq!(reclaimed.run_id.as_deref(), Some(send_run.as_str()));
    {
        let inner = f.manager.inner.lock();
        assert_erased(inner.branches.get(&id).unwrap());
        for request in inner
            .requests
            .values()
            .filter(|request| request.branch_id == id)
        {
            assert!(request.arguments.is_null());
            assert!(request.arguments_fingerprint.is_some());
            assert_eq!(request.state, "reclaimed");
            assert!(request.error.is_none());
            assert_eq!(
                request.response.as_ref().unwrap()["requestState"],
                "reclaimed"
            );
            let raw = serde_json::to_string(request).unwrap();
            for sentinel in sentinels {
                assert!(!raw.contains(sentinel), "retained {sentinel}");
            }
        }
    }
    for raw in content_rows(&f) {
        for sentinel in sentinels {
            assert!(!raw.contains(sentinel), "retained {sentinel}");
        }
    }
    assert_eq!(encoded(&branch(&f, &sibling_id)).unwrap(), sibling_before);
    assert_eq!(
        encoded(
            f.manager
                .inner
                .lock()
                .requests
                .get(&(key(&f.parent), "sibling".into()))
                .unwrap()
        )
        .unwrap(),
        sibling_request_before
    );
    let Reservation::Replay(reply) = f
        .manager
        .reserve_spawn(
            &f.caller,
            &f.parent,
            "manual",
            &spawn_args,
            encoded(&spawn_args).unwrap(),
            spawn_args.model.clone(),
            spawn_args.effort.clone(),
        )
        .unwrap()
    else {
        panic!("reclaimed spawn was launched again")
    };
    assert_eq!(reply["requestState"], "reclaimed");
    let Reservation::Replay(reply) = f
        .manager
        .reserve_send(
            &f.caller,
            &f.parent,
            "manual",
            &send_args,
            encoded(&send_args).unwrap(),
        )
        .unwrap()
    else {
        panic!("reclaimed send was launched again")
    };
    assert_eq!(reply["requestState"], "reclaimed");
    assert_eq!(f.manager.inner.lock().runs.len(), count_before);
    assert_eq!(f.manager.inner.lock().branches.len(), 2);
    let mut changed_spawn = spawn_args.clone();
    changed_spawn.task.push_str(" changed");
    assert!(f
        .manager
        .reserve_spawn(
            &f.caller,
            &f.parent,
            "manual",
            &changed_spawn,
            encoded(&changed_spawn).unwrap(),
            None,
            None
        )
        .is_err());
    let mut changed_send = send_args.clone();
    changed_send.message.push_str(" changed");
    assert!(f
        .manager
        .reserve_send(
            &f.caller,
            &f.parent,
            "manual",
            &changed_send,
            encoded(&changed_send).unwrap()
        )
        .is_err());

    let recovered = reload(&f).unwrap();
    let inner = recovered.inner.lock();
    assert_erased(inner.branches.get(&id).unwrap());
    assert_eq!(
        encoded(&inner.branches.get(&sibling_id).unwrap().branch).unwrap(),
        sibling_before
    );
    for (request_id, method, arguments) in [
        (
            "private-spawn",
            "task_spawn",
            encoded(&spawn_args).unwrap(),
        ),
        ("private-send", "task_send", encoded(&send_args).unwrap()),
    ] {
        let reply = recovered
            .replay(&inner, &f.parent, request_id, method, &arguments)
            .unwrap()
            .unwrap();
        assert_eq!(reply["requestState"], "reclaimed");
        assert_eq!(reply["branch"]["state"], "reclaimed");
        let raw = reply.to_string();
        for sentinel in sentinels {
            assert!(!raw.contains(sentinel), "replayed {sentinel}");
        }
    }
    assert_eq!(recovered.processes.active_run_count(), 0);
}

#[test]
fn legacy_arguments_and_already_reclaimed_content_are_migrated_on_load() {
    let f = basic();
    let (active_id, active_run) = spawn(&f, "legacy-active");
    settle(&f, &active_id, &active_run, "active-session");
    legacy_request(
        &f,
        "legacy-active",
        encoded(&args("legacy-active")).unwrap(),
        "acknowledged",
    );
    let (deleted_id, _) = spawn(&f, "legacy-deleted");
    let mut legacy_branch = f
        .manager
        .inner
        .lock()
        .branches
        .get(&deleted_id)
        .unwrap()
        .clone();
    legacy_branch.branch.state = "reclaimed".into();
    legacy_branch.branch.title = "legacy-private-title".into();
    legacy_branch.branch.task = "legacy-private-task".into();
    legacy_branch.branch.result = "legacy-private-result".into();
    legacy_branch.branch.result_truncated = true;
    legacy_branch.branch.error = Some("legacy-private-error".into());
    write_branch(&f.manager.db.0.lock(), &legacy_branch).unwrap();
    legacy_request(
        &f,
        "legacy-deleted",
        encoded(&args("legacy-deleted")).unwrap(),
        "acknowledged",
    );

    let recovered = reload(&f).unwrap();
    let inner = recovered.inner.lock();
    assert_erased(inner.branches.get(&deleted_id).unwrap());
    assert_eq!(
        inner.branches.get(&active_id).unwrap().branch.task,
        args("legacy-active").task
    );
    for request_id in ["legacy-active", "legacy-deleted"] {
        let request = inner
            .requests
            .get(&(key(&f.parent), request_id.into()))
            .unwrap();
        assert!(request.arguments.is_null());
        assert_eq!(
            request.arguments_fingerprint.as_deref(),
            Some(
                arguments_fingerprint(&encoded(&args(request_id)).unwrap())
                    .unwrap()
                    .as_str()
            )
        );
    }
    let active_reply = recovered
        .replay(
            &inner,
            &f.parent,
            "legacy-active",
            "task_spawn",
            &encoded(&args("legacy-active")).unwrap(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(active_reply["requestState"], "acknowledged");
    assert_eq!(active_reply["branch"]["task"], args("legacy-active").task);
    let deleted_reply = recovered
        .replay(
            &inner,
            &f.parent,
            "legacy-deleted",
            "task_spawn",
            &encoded(&args("legacy-deleted")).unwrap(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(deleted_reply["requestState"], "reclaimed");
    assert!(!deleted_reply.to_string().contains("legacy-private"));
    let mut changed = args("legacy-deleted");
    changed.task.push_str(" changed");
    assert!(recovered
        .replay(
            &inner,
            &f.parent,
            "legacy-deleted",
            "task_spawn",
            &encoded(&changed).unwrap()
        )
        .is_err());
    let raw = serde_json::to_string(
        inner
            .requests
            .get(&(key(&f.parent), "legacy-deleted".into()))
            .unwrap(),
    )
    .unwrap();
    assert!(!raw.contains("legacy-private"));
    drop(inner);
    for raw in content_rows(&f) {
        let value: Value = serde_json::from_str(&raw).unwrap();
        if value.get("arguments").is_some() {
            assert!(value["arguments"].is_null());
            assert!(value["arguments_fingerprint"].is_string());
        }
        if value["id"] == deleted_id || value["branch_id"] == deleted_id {
            assert!(!raw.contains("legacy-private"));
        }
    }
    assert_eq!(recovered.processes.active_run_count(), 0);
}

#[test]
fn legacy_reclaimed_request_never_replays_cached_or_live_content() {
    let f = basic();
    let (id, run) = spawn(&f, "legacy-request-tombstone");
    settle(&f, &id, &run, "child-session");
    legacy_request(
        &f,
        "legacy-request-tombstone",
        encoded(&args("legacy-request-tombstone")).unwrap(),
        "reclaimed",
    );
    let recovered = reload(&f).unwrap();
    let reply = recovered
        .replay(
            &recovered.inner.lock(),
            &f.parent,
            "legacy-request-tombstone",
            "task_spawn",
            &encoded(&args("legacy-request-tombstone")).unwrap(),
        )
        .unwrap()
        .unwrap();
    assert_eq!(reply["requestState"], "reclaimed");
    assert!(reply["branch"].is_null());
    assert!(!reply.to_string().contains("legacy-private"));
    let reply = recovered
        .acknowledge(
            &f.parent,
            "legacy-request-tombstone",
            &run,
            Err("private-late-legacy-error".into()),
        )
        .unwrap();
    assert_eq!(reply["requestState"], "reclaimed");
    assert!(reply["branch"].is_null());
    let request = recovered
        .inner
        .lock()
        .requests
        .get(&(key(&f.parent), "legacy-request-tombstone".into()))
        .unwrap()
        .clone();
    assert!(request.arguments.is_null());
    assert!(request.error.is_none());
    assert!(!serde_json::to_string(&request)
        .unwrap()
        .contains("legacy-private"));
}

#[test]
fn failed_legacy_scrub_rolls_back_migration_and_does_not_publish_manager() {
    let f = basic();
    let (id, _) = spawn(&f, "legacy-failed");
    let mut record = f.manager.inner.lock().branches.get(&id).unwrap().clone();
    record.branch.state = "reclaimed".into();
    record.branch.result = "legacy-private-persisted-result".into();
    write_branch(&f.manager.db.0.lock(), &record).unwrap();
    legacy_request(
        &f,
        "legacy-failed",
        encoded(&args("legacy-failed")).unwrap(),
        "acknowledged",
    );
    let before = content_rows(&f);
    f.manager.db.0.lock().execute_batch(
        "CREATE TRIGGER reject_legacy_scrub BEFORE UPDATE ON leader_branches WHEN NEW.state='reclaimed' BEGIN SELECT RAISE(ABORT,'legacy scrub unavailable'); END;",
    ).unwrap();
    let error = reload(&f).err().expect("failed scrub published a manager");
    assert!(error.contains("legacy scrub unavailable"));
    assert_eq!(content_rows(&f), before);
    assert!(before
        .join("\n")
        .contains("legacy-private-persisted-result"));
    assert!(before.join("\n").contains("\"arguments\":{\""));
    f.manager
        .db
        .0
        .lock()
        .execute_batch("DROP TRIGGER reject_legacy_scrub;")
        .unwrap();
    let recovered = reload(&f).unwrap();
    assert_erased(recovered.inner.lock().branches.get(&id).unwrap());
}

#[tokio::test]
async fn request_scrub_failure_preserves_recoverable_content_and_reclaim_retry() {
    let deletes = Arc::new(AtomicI64::new(0));
    let count = deletes.clone();
    let f = fixture(Arc::new(move |_, _, _| {
        count.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }));
    let (id, run) = spawn(&f, "failed-scrub");
    observe(
        &f,
        &run,
        "child-session",
        "delta",
        json!("recoverable-private-result"),
        1,
    );
    observe(&f, &run, "child-session", "done", json!({}), 2);
    f.manager.finish(&run);
    f.manager
        .acknowledge(
            &f.parent,
            "failed-scrub",
            &run,
            Ok(crate::engine::SendResult {
                run_id: run.clone(),
                session_id: Some("child-session".into()),
            }),
        )
        .unwrap();
    let request_key = (key(&f.parent), "failed-scrub".into());
    let request_before =
        encoded(f.manager.inner.lock().requests.get(&request_key).unwrap()).unwrap();
    f.manager.db.0.lock().execute_batch(
        "CREATE TRIGGER reject_request_scrub BEFORE UPDATE ON leader_requests WHEN json_extract(NEW.record_json,'$.state')='reclaimed' BEGIN SELECT RAISE(ABORT,'request scrub unavailable'); END;",
    ).unwrap();
    let error = f.manager.reclaim(&f.parent, &id).await.unwrap_err();
    assert!(error.contains("transcript may already have been removed"));
    assert!(error.contains("request scrub unavailable"));
    assert_eq!(deletes.load(Ordering::SeqCst), 1);
    let record = branch(&f, &id);
    assert_eq!(record.state, "unknown");
    assert_eq!(record.session_id.as_deref(), Some("child-session"));
    assert_eq!(record.title, args("failed-scrub").title);
    assert_eq!(record.task, args("failed-scrub").task);
    assert_eq!(record.result, "recoverable-private-result");
    assert!(record
        .error
        .as_deref()
        .unwrap()
        .contains("request scrub unavailable"));
    assert!(!f.manager.inner.lock().branches.get(&id).unwrap().stopping);
    assert_eq!(
        encoded(f.manager.inner.lock().requests.get(&request_key).unwrap()).unwrap(),
        request_before
    );
    let persisted = content_rows(&f);
    assert!(persisted
        .iter()
        .any(|raw| raw.contains("recoverable-private-result")));
    assert!(!persisted
        .iter()
        .any(|raw| serde_json::from_str::<Value>(raw).unwrap()["state"] == "reclaimed"));
    let persisted_request: String = f
        .manager
        .db
        .0
        .lock()
        .query_row(
            "SELECT record_json FROM leader_requests WHERE request_id='failed-scrub'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&persisted_request).unwrap(),
        request_before
    );
    assert!(ensure_unmanaged(&f.manager.db, "codex", "child-session").is_err());
    f.manager
        .db
        .0
        .lock()
        .execute_batch("DROP TRIGGER reject_request_scrub;")
        .unwrap();
    f.manager.reclaim(&f.parent, &id).await.unwrap();
    assert_eq!(deletes.load(Ordering::SeqCst), 2);
    assert_erased(f.manager.inner.lock().branches.get(&id).unwrap());
    assert!(!content_rows(&f)
        .join("\n")
        .contains("recoverable-private-result"));
}

#[tokio::test]
async fn late_acknowledgements_errors_and_events_cannot_repopulate_reclaimed_content() {
    let f = basic();
    let (id, run) = spawn(&f, "late-ack");
    settle(&f, &id, &run, "child-session");
    f.manager.reclaim(&f.parent, &id).await.unwrap();
    let before = content_rows(&f);
    let request_before = encoded(
        f.manager
            .inner
            .lock()
            .requests
            .get(&(key(&f.parent), "late-ack".into()))
            .unwrap(),
    )
    .unwrap();
    let reply = f
        .manager
        .acknowledge(
            &f.parent,
            "late-ack",
            &run,
            Ok(crate::engine::SendResult {
                run_id: run.clone(),
                session_id: Some("unexpected-late-session".into()),
            }),
        )
        .unwrap();
    assert_eq!(reply["requestState"], "reclaimed");
    assert_eq!(reply["branch"]["sessionId"], "child-session");
    let reply = f
        .manager
        .acknowledge(
            &f.parent,
            "late-ack",
            &run,
            Err("private-late-ack-error".into()),
        )
        .unwrap();
    assert_eq!(reply["requestState"], "reclaimed");
    assert!(!reply.to_string().contains("private-late"));
    for (index, (kind, data)) in [
        ("session", json!("unexpected-late-session")),
        ("delta", json!("private-late-text")),
        (
            "message",
            json!({"role":"assistant","text":"private-late-message"}),
        ),
        ("error", json!("private-late-error")),
        ("question", json!({"requestId":"private-late-question"})),
        ("plan_review", json!({"planId":"private-late-plan"})),
    ]
    .into_iter()
    .enumerate()
    {
        let mut late = event(
            &format!("{run}-c1"),
            Some("child-session"),
            kind,
            data,
            index as u64 + 50,
        );
        f.manager.observe(&mut late);
        assert_eq!(late["leader"]["reclaimed"], true);
        assert_eq!(late["leader"]["title"], "");
        assert!(late["leader"].get("assignment").is_none());
    }
    f.manager.finish(&run);
    f.manager.checkpoint().unwrap();
    assert_erased(f.manager.inner.lock().branches.get(&id).unwrap());
    assert_eq!(
        encoded(
            f.manager
                .inner
                .lock()
                .requests
                .get(&(key(&f.parent), "late-ack".into()))
                .unwrap()
        )
        .unwrap(),
        request_before
    );
    assert_eq!(content_rows(&f), before);
    let recovered = reload(&f).unwrap();
    let reply = recovered
        .acknowledge(
            &f.parent,
            "late-ack",
            &run,
            Err("private-late-after-restart".into()),
        )
        .unwrap();
    assert_eq!(reply["requestState"], "reclaimed");
    assert_erased(recovered.inner.lock().branches.get(&id).unwrap());
    assert_eq!(content_rows(&f), before);
}

fn save_group_session(f: &Fixture, member: &LeaderIdentity, title: &str, file: &str) {
    f.manager.db.0.lock().execute(
        "INSERT INTO sessions(engine,session_id,workspace_path,title,file_path) VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(engine,session_id) DO UPDATE SET title=excluded.title,file_path=excluded.file_path,workspace_path=excluded.workspace_path",
        params![member.engine,member.session_id,member.workspace_path,title,file],
    ).unwrap();
}

fn idle_group_root(f: &Fixture) {
    save_group_session(f, &f.parent, "Saved Leader title", "");
    f.manager.processes.remove_run_if_pid(&f.caller.run_id, 0);
    f.manager.finish(&f.caller.run_id);
}

fn archive_count(f: &Fixture) -> i64 {
    f.manager
        .db
        .0
        .lock()
        .query_row("SELECT COUNT(*) FROM session_archives", [], |r| r.get(0))
        .unwrap()
}

#[test]
fn group_archive_restart_restore_preserves_recursive_mixed_engines_and_transcripts() {
    let f = basic();
    let (child, child_run) = spawn(&f, "child");
    settle(&f, &child, &child_run, "codex-child");
    f.manager
        .acknowledge(
            &f.parent,
            "child",
            &child_run,
            Ok(crate::engine::SendResult {
                run_id: child_run.clone(),
                session_id: Some("codex-child".into()),
            }),
        )
        .unwrap();
    let child_identity = identity("codex", "codex-child", &f.parent.workspace_path);
    let child_caller = Caller {
        run_id: "child-resume".into(),
        engine: "codex".into(),
        session_id: "codex-child".into(),
        workspace_path: f.parent.workspace_path.clone(),
    };
    f.manager.processes.insert(
        child_caller.run_id.clone(),
        reservation(&child_caller.run_id),
    );
    f.manager
        .prepare(
            &child_caller.run_id,
            "codex",
            Some("codex-child"),
            &f.parent.workspace_path,
            Some("manual"),
        )
        .unwrap();
    let mut grand_args = args("grandchild");
    grand_args.engine = "claude".into();
    let (grand, grand_run) = match f
        .manager
        .reserve_spawn(
            &child_caller,
            &child_identity,
            "manual",
            &grand_args,
            encoded(&grand_args).unwrap(),
            None,
            None,
        )
        .unwrap()
    {
        Reservation::Start(start) => start,
        _ => panic!("unexpected replay"),
    };
    for (seq, kind, data) in [
        (1, "session", json!("claude-grand")),
        (2, "delta", json!("孙分支 evidence 🧭")),
        (3, "done", json!({})),
    ] {
        let mut e = event(&grand_run, Some("claude-grand"), kind, data, seq);
        e["engine"] = json!("claude");
        f.manager.observe(&mut e);
    }
    f.manager.finish(&grand_run);
    f.manager
        .acknowledge(
            &child_identity,
            "grandchild",
            &grand_run,
            Ok(crate::engine::SendResult {
                run_id: grand_run.clone(),
                session_id: Some("claude-grand".into()),
            }),
        )
        .unwrap();
    observe(
        &f,
        &child_caller.run_id,
        "codex-child",
        "delta",
        json!("child final"),
        1,
    );
    observe(
        &f,
        &child_caller.run_id,
        "codex-child",
        "done",
        json!({}),
        2,
    );
    f.manager
        .processes
        .remove_run_if_pid(&child_caller.run_id, 0);
    f.manager.finish(&child_caller.run_id);
    let (failed, failed_run) = spawn(&f, "failed-launch");
    assert!(f
        .manager
        .acknowledge(
            &f.parent,
            "failed-launch",
            &failed_run,
            Err("CLI failed before identity".into())
        )
        .is_err());
    idle_group_root(&f);
    let dir = std::env::temp_dir().join(format!("leader-group-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let members = [
        f.parent.clone(),
        child_identity.clone(),
        identity("claude", "claude-grand", &f.parent.workspace_path),
    ];
    let mut files = Vec::new();
    for (i, member) in members.iter().enumerate() {
        let file = dir.join(format!("{i}.jsonl"));
        std::fs::write(&file, format!("native transcript {i}\n")).unwrap();
        save_group_session(
            &f,
            member,
            if i == 0 {
                "Saved Leader title"
            } else {
                "Native title"
            },
            &file.to_string_lossy(),
        );
        files.push(file);
    }
    let before = encoded(&f.manager.snapshot().unwrap()).unwrap();
    let rows_before = content_rows(&f);
    f.manager.db.remember_claude_ultracode("claude-grand", false, 1).unwrap();
    let group = f.manager.archive_group(&f.parent).unwrap();
    assert!(!group.deletion_started);
    assert_eq!(group.title, "Saved Leader title");
    assert_eq!(group.members.len(), 3);
    assert_eq!(group.branch_ids.len(), 3);
    assert!(group.branch_ids.contains(&failed));
    assert!(!group.members.iter().any(|m| m.session_id == failed));
    assert_eq!(archive_count(&f), 3);
    assert_eq!(content_rows(&f), rows_before);
    let archived = encoded(&f.manager.snapshot().unwrap()).unwrap();
    assert_eq!(archived["branches"], before["branches"]);
    assert_eq!(archived["leaders"], before["leaders"]);
    assert_eq!(archived["archivedGroups"].as_array().unwrap().len(), 1);
    for member in &group.members {
        assert!(crate::history::reader::restore_session_in(
            &f.manager.db,
            &member.engine,
            &member.session_id
        )
        .unwrap_err()
        .contains("whole-group restore"));
        assert!(crate::history::reader::delete_session_blocking(
            &f.manager.db,
            &member.engine,
            &member.session_id
        )
        .unwrap_err()
        .contains("archived Leader group"));
        assert!(f
            .manager
            .prepare(
                "late-resume",
                &member.engine,
                Some(&member.session_id),
                &member.workspace_path,
                Some("manual")
            )
            .is_err());
    }
    assert!(f.manager.renew(&f.parent, &child, Some(60)).is_err());
    let snapshot: String = f.manager.db.0.lock().query_row(
        "SELECT snapshot_json FROM session_archives WHERE engine='claude' AND session_id='claude-grand'", [],
        |r| r.get(0),
    ).unwrap();
    assert_eq!(serde_json::from_str::<crate::history::SessionMeta>(&snapshot).unwrap().claude_ultracode, Some(false));
    f.manager.db.0.lock().execute("DELETE FROM session_claude_options", []).unwrap();
    let recovered = reload(&f).unwrap();
    assert_eq!(recovered.snapshot().unwrap().archived_groups, vec![group]);
    assert_eq!(
        encoded(&recovered.snapshot().unwrap()).unwrap()["branches"],
        before["branches"]
    );
    recovered.restore_group(&f.parent).unwrap();
    assert_eq!(f.manager.db.0.lock().query_row(
        "SELECT ultracode FROM session_claude_options WHERE session_id='claude-grand'", [],
        |r| r.get::<_, bool>(0),
    ).unwrap(), false);
    assert_eq!(archive_count(&f), 0);
    let restored = encoded(&recovered.snapshot().unwrap()).unwrap();
    assert_eq!(restored["branches"], before["branches"]);
    assert_eq!(restored["leaders"], before["leaders"]);
    assert_eq!(restored["archivedGroups"], json!([]));
    assert_eq!(
        restored["branches"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["id"] == grand)
            .unwrap()["result"],
        "孙分支 evidence 🧭"
    );
    assert_eq!(content_rows(&f), rows_before);
    assert_eq!(recovered.processes.active_run_count(), 0);
    for (i, file) in files.iter().enumerate() {
        assert_eq!(
            std::fs::read_to_string(file).unwrap(),
            format!("native transcript {i}\n")
        );
        std::fs::remove_file(file).unwrap();
    }
    std::fs::remove_dir(dir).unwrap();
}

#[test]
fn group_actions_reject_active_waiting_pending_aliases_and_wrong_ownership() {
    let f = basic();
    let (child, run) = spawn(&f, "child");
    settle(&f, &child, &run, "child-session");
    save_group_session(&f, &f.parent, "Saved Leader title", "");
    assert!(f
        .manager
        .archive_group(&f.parent)
        .unwrap_err()
        .contains("idle"));
    idle_group_root(&f);
    for state in ["starting", "running", "waiting", "reclaiming"] {
        f.manager
            .inner
            .lock()
            .branches
            .get_mut(&child)
            .unwrap()
            .branch
            .state = state.into();
        assert!(
            f.manager
                .archive_group(&f.parent)
                .unwrap_err()
                .contains("idle"),
            "{state}"
        );
        assert_eq!(archive_count(&f), 0);
    }
    f.manager
        .inner
        .lock()
        .branches
        .get_mut(&child)
        .unwrap()
        .branch
        .state = "completed".into();
    f.manager
        .inner
        .lock()
        .branches
        .get_mut(&child)
        .unwrap()
        .stopping = true;
    assert!(f.manager.archive_group(&f.parent).is_err());
    f.manager
        .inner
        .lock()
        .branches
        .get_mut(&child)
        .unwrap()
        .stopping = false;
    f.manager.inner.lock().runs.get_mut(&run).unwrap().retired = false;
    f.manager
        .inner
        .lock()
        .runs
        .get_mut(&run)
        .unwrap()
        .launch_pending = true;
    assert!(f
        .manager
        .archive_group(&f.parent)
        .unwrap_err()
        .contains("idle"));
    f.manager.inner.lock().runs.get_mut(&run).unwrap().retired = true;
    f.manager.inner.lock().pending_bindings.insert(
        run.clone(),
        ("codex".into(), "uncommitted-native-id".into()),
    );
    assert!(f
        .manager
        .archive_group(&f.parent)
        .unwrap_err()
        .contains("idle"));
    f.manager.inner.lock().pending_bindings.clear();
    f.manager
        .processes
        .insert_alias("parent-session".into(), reservation("untracked-root-run"));
    assert!(f
        .manager
        .archive_group(&f.parent)
        .unwrap_err()
        .contains("idle"));
    f.manager
        .processes
        .remove_run_if_pid("untracked-root-run", 0);
    assert!(f
        .manager
        .archive_group(&identity(
            "codex",
            "child-session",
            &f.parent.workspace_path
        ))
        .unwrap_err()
        .contains("topmost"));
    assert!(f
        .manager
        .archive_group(&identity("claude", "parent-session", "another-workspace"))
        .is_err());
    save_group_session(
        &f,
        &identity("codex", "child-session", "another-workspace"),
        "Foreign chat",
        "",
    );
    assert!(f
        .manager
        .archive_group(&f.parent)
        .unwrap_err()
        .contains("another workspace"));
    assert_eq!(archive_count(&f), 0);
    assert!(f.manager.snapshot().unwrap().archived_groups.is_empty());
}

#[test]
fn group_archive_sql_failure_rolls_back_every_marker_and_memory_fence() {
    let f = basic();
    let (child, run) = spawn(&f, "child");
    settle(&f, &child, &run, "child-session");
    idle_group_root(&f);
    let before = content_rows(&f);
    f.manager.db.0.lock().execute_batch("CREATE TRIGGER reject_group_members BEFORE INSERT ON leader_archived_members BEGIN SELECT RAISE(ABORT,'archive transaction unavailable'); END;").unwrap();
    assert!(f
        .manager
        .archive_group(&f.parent)
        .unwrap_err()
        .contains("archive transaction unavailable"));
    assert_eq!(archive_count(&f), 0);
    assert!(f.manager.snapshot().unwrap().archived_groups.is_empty());
    assert_eq!(content_rows(&f), before);
    assert!(f.manager.renew(&f.parent, &child, Some(60)).is_ok());
    f.manager
        .db
        .0
        .lock()
        .execute_batch("DROP TRIGGER reject_group_members;")
        .unwrap();
    f.manager.archive_group(&f.parent).unwrap();
    // Restoration is one transaction as well: no member can become visible alone.
    f.manager.db.0.lock().execute_batch("CREATE TRIGGER reject_group_restore BEFORE DELETE ON leader_archived_members BEGIN SELECT RAISE(ABORT,'restore unavailable'); END;").unwrap();
    assert!(f
        .manager
        .restore_group(&f.parent)
        .unwrap_err()
        .contains("restore unavailable"));
    assert_eq!(archive_count(&f), 2);
    assert_eq!(f.manager.snapshot().unwrap().archived_groups.len(), 1);
}

#[test]
fn restore_between_delete_stages_cannot_leave_a_stale_deleting_fence() {
    let f = basic();
    let (child, run) = spawn(&f, "archive-child");
    settle(&f, &child, &run, "archive-child-session");
    idle_group_root(&f);
    let expected = f.manager.archive_group(&f.parent).unwrap();
    f.manager.restore_group(&f.parent).unwrap();
    assert!(f
        .manager
        .begin_group_delete(&expected)
        .err()
        .unwrap()
        .contains("changed before deletion"));
    assert!(f.manager.inner.lock().deleting_groups.is_empty());
    assert!(f.manager.inner.lock().retiring.is_empty());
    let group = f.manager.archive_group(&f.parent).unwrap();
    f.manager
        .db
        .0
        .lock()
        .execute("DELETE FROM leader_archived_groups", [])
        .unwrap();
    assert!(f
        .manager
        .begin_group_delete(&group)
        .err()
        .unwrap()
        .contains("disappeared"));
    assert!(f.manager.inner.lock().deleting_groups.is_empty());
    assert!(f.manager.inner.lock().retiring.is_empty());
    // The first interleaving alone must also permit a fresh archive and restore.
    let second = basic();
    let (child, run) = spawn(&second, "archive-child");
    settle(&second, &child, &run, "archive-child-session");
    idle_group_root(&second);
    let stale = second.manager.archive_group(&second.parent).unwrap();
    second.manager.restore_group(&second.parent).unwrap();
    assert!(second.manager.begin_group_delete(&stale).is_err());
    second.manager.archive_group(&second.parent).unwrap();
    second.manager.restore_group(&second.parent).unwrap();
}

#[test]
fn dirty_terminal_branch_must_commit_with_archive_and_restore_visibility() {
    let f = basic();
    let (child, run) = spawn(&f, "child");
    settle(&f, &child, &run, "child-session");
    idle_group_root(&f);
    {
        let mut inner = f.manager.inner.lock();
        let record = inner.branches.get_mut(&child).unwrap();
        record.branch.result = "last terminal result still pending persistence".into();
        record.dirty = true;
    }
    f.manager.db.0.lock().execute_batch("CREATE TRIGGER reject_final_ledger BEFORE UPDATE ON leader_branches BEGIN SELECT RAISE(ABORT,'terminal ledger unavailable'); END;").unwrap();
    assert!(f
        .manager
        .archive_group(&f.parent)
        .unwrap_err()
        .contains("terminal ledger unavailable"));
    assert_eq!(archive_count(&f), 0);
    assert!(f.manager.inner.lock().archived_groups.is_empty());
    assert!(f.manager.inner.lock().branches.get(&child).unwrap().dirty);
    f.manager
        .db
        .0
        .lock()
        .execute_batch("DROP TRIGGER reject_final_ledger;")
        .unwrap();
    f.manager.archive_group(&f.parent).unwrap();
    assert!(!f.manager.inner.lock().branches.get(&child).unwrap().dirty);
    assert_eq!(
        reload(&f).unwrap().snapshot().unwrap().branches[0].result,
        "last terminal result still pending persistence"
    );
    {
        let mut inner = f.manager.inner.lock();
        let record = inner.branches.get_mut(&child).unwrap();
        record.dirty = true;
    }
    f.manager.db.0.lock().execute_batch("CREATE TRIGGER reject_restore_ledger BEFORE UPDATE ON leader_branches BEGIN SELECT RAISE(ABORT,'restore ledger unavailable'); END;").unwrap();
    assert!(f
        .manager
        .restore_group(&f.parent)
        .unwrap_err()
        .contains("restore ledger unavailable"));
    assert_eq!(archive_count(&f), 2);
    assert_eq!(f.manager.inner.lock().archived_groups.len(), 1);
    assert!(f.manager.inner.lock().branches.get(&child).unwrap().dirty);
    f.manager
        .db
        .0
        .lock()
        .execute_batch("DROP TRIGGER reject_restore_ledger;")
        .unwrap();
    f.manager.restore_group(&f.parent).unwrap();
    assert_eq!(archive_count(&f), 0);
    assert!(!f.manager.inner.lock().branches.get(&child).unwrap().dirty);
    // Response rendering is memory-only even when an unrelated dirty ledger cannot flush.
    {
        let mut inner = f.manager.inner.lock();
        inner.branches.get_mut(&child).unwrap().dirty = true;
    }
    f.manager.db.0.lock().execute_batch("CREATE TRIGGER reject_snapshot_ledger BEFORE UPDATE ON leader_branches BEGIN SELECT RAISE(ABORT,'snapshot ledger unavailable'); END;").unwrap();
    assert_eq!(
        f.manager.snapshot_memory().branches[0].result,
        "last terminal result still pending persistence"
    );
    assert!(f
        .manager
        .snapshot()
        .unwrap_err()
        .contains("snapshot ledger unavailable"));
}

#[tokio::test]
async fn group_delete_checkpoints_partial_failure_and_never_deletes_foreign_chat() {
    let deleted = Arc::new(Mutex::new(Vec::<String>::new()));
    let seen = deleted.clone();
    let reject_root = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let fail = reject_root.clone();
    let f = fixture(Arc::new(move |db, engine, session| {
        if session == "parent-session" && fail.load(Ordering::SeqCst) {
            return Err("root transcript is locked".into());
        }
        seen.lock().push(session.into());
        let conn = db.0.lock();
        for table in ["sessions", "session_archives"] {
            conn.execute(
                &format!("DELETE FROM {table} WHERE engine=?1 AND session_id=?2"),
                params![engine, session],
            )
            .unwrap();
        }
        Ok(())
    }));
    let (child, run) = spawn(&f, "child");
    settle(&f, &child, &run, "child-session");
    idle_group_root(&f);
    let foreign = identity("codex", "foreign-session", &f.parent.workspace_path);
    save_group_session(&f, &foreign, "Foreign title", "");
    assert!(f
        .manager
        .delete_group(&identity("claude", "parent-session", "wrong-workspace"))
        .await
        .is_err());
    assert!(deleted.lock().is_empty());
    let error = f.manager.delete_group(&f.parent).await.unwrap_err();
    assert!(error.contains("root transcript is locked"));
    assert_eq!(deleted.lock().as_slice(), ["child-session"]);
    assert_eq!(branch(&f, &child).state, "reclaimed");
    assert_eq!(f.manager.snapshot().unwrap().archived_groups.len(), 1);
    assert!(f.manager.snapshot().unwrap().archived_groups[0].deletion_started);
    assert!(f
        .manager
        .archive_group_for_user(&f.parent)
        .unwrap_err()
        .contains("Deletion incomplete"));
    assert!(f
        .manager
        .restore_group(&f.parent)
        .unwrap_err()
        .contains("partially deleted"));
    assert!(
        crate::history::reader::restore_session_in(&f.manager.db, "codex", "child-session")
            .is_err()
    );
    let recovered = reload(&f).unwrap();
    assert!(recovered
        .restore_group(&f.parent)
        .unwrap_err()
        .contains("partially deleted"));
    assert!(recovered.snapshot().unwrap().archived_groups[0].deletion_started);
    assert!(!f
        .manager
        .inner
        .lock()
        .retiring
        .contains(&("claude".into(), "parent-session".into())));
    reject_root.store(false, Ordering::SeqCst);
    f.manager.delete_group(&f.parent).await.unwrap();
    assert_eq!(
        deleted.lock().as_slice(),
        ["child-session", "parent-session"]
    );
    assert!(f.manager.snapshot().unwrap().archived_groups.is_empty());
    assert!(f.manager.snapshot().unwrap().leaders.is_empty());
    assert_eq!(archive_count(&f), 0);
    let foreign_count: i64 = f
        .manager
        .db
        .0
        .lock()
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE session_id='foreign-session'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(foreign_count, 1);
}

#[tokio::test]
async fn gui_group_delete_uses_owned_native_deletion_and_keeps_foreign_transcripts() {
    let f = basic();
    let (child, run) = spawn(&f, "child");
    settle(&f, &child, &run, "child-session");
    idle_group_root(&f);
    let db = Arc::new(Db::open_at(std::path::Path::new(":memory:")).unwrap());
    ensure_schema(&db).unwrap();
    let record = f.manager.inner.lock().branches.get(&child).unwrap().clone();
    write_branch(&db.0.lock(), &record).unwrap();
    db.0.lock()
        .execute(
            "INSERT INTO leader_roles(engine,session_id,workspace_path) VALUES(?1,?2,?3)",
            params![
                f.parent.engine,
                f.parent.session_id,
                f.parent.workspace_path
            ],
        )
        .unwrap();
    let dir = std::env::temp_dir().join(format!("leader-delete-owned-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    let root_file = dir.join("root.jsonl");
    let child_file = dir.join("child.jsonl");
    let foreign_file = dir.join("foreign.jsonl");
    for (engine, session, file) in [
        ("claude", "parent-session", &root_file),
        ("codex", "child-session", &child_file),
        ("codex", "foreign-session", &foreign_file),
    ] {
        std::fs::write(file, "native transcript\n").unwrap();
        db.0.lock().execute("INSERT INTO sessions(engine,session_id,workspace_path,file_path,file_size,file_mtime_ms,title) VALUES(?1,?2,?3,?4,18,0,'Native title')",
            params![engine,session,f.parent.workspace_path,file.to_string_lossy()]).unwrap();
    }
    let manager = Arc::new(
        LeaderManager::with_services(
            db.clone(),
            Arc::new(crate::engine::ProcessRegistry::default()),
            f.emitter.clone(),
            Arc::new(|| 1_000_000),
            Arc::new(crate::history::reader::delete_leader_session_blocking),
        )
        .unwrap(),
    );
    assert!(crate::history::reader::delete_leader_session_blocking(
        &db,
        "codex",
        "foreign-session"
    )
    .unwrap_err()
    .contains("confirmed deletion"));
    manager.delete_group(&f.parent).await.unwrap();
    assert!(!root_file.exists());
    assert!(!child_file.exists());
    assert_eq!(
        std::fs::read_to_string(&foreign_file).unwrap(),
        "native transcript\n"
    );
    assert_eq!(
        db.0.lock()
            .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(manager.snapshot().unwrap().archived_groups.is_empty());
    assert!(manager.snapshot().unwrap().branches.is_empty());
    std::fs::remove_file(foreign_file).unwrap();
    std::fs::remove_dir(dir).unwrap();
}
