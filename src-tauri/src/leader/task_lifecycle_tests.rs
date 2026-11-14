use super::*;

fn local(f: &Fixture) {
    f.manager
        .db
        .0
        .lock()
        .execute(
            "INSERT INTO workspaces(id,path) VALUES('lifecycle',?1)",
            [&f.parent.workspace_path],
        )
        .unwrap();
    save_group_session(f, &f.parent, "fixture", "");
}

#[test]
fn task_lifecycle_requires_saved_directory_spelling_not_a_lowercase_comparison_key() {
    let f = basic();
    let source = identity("codex", "case-native-source", "C:/Projects/ExampleProject");
    f.manager.db.0.lock().execute("INSERT INTO workspaces(id,path) VALUES('mixed-case',?1)", [&source.workspace_path]).unwrap();
    save_group_session(&f, &source, "case fixture", "");
    let lowered = identity(&source.engine, &source.session_id, &source.workspace_path.to_lowercase());
    let error = f.manager.session_lifecycle(&lowered).err().expect("comparison key must not replace native path");
    assert_eq!(error, "Task lifecycle workspace is missing or ambiguous");
    let observed = f.manager.session_lifecycle(&source).unwrap();
    assert!(!observed.archived && observed.idle);
}

#[test]
fn task_lifecycle_archive_is_readonly_and_survives_cold_manager() {
    let f = basic();
    local(&f);
    let (child, run) = spawn(&f, "archived-child");
    settle(&f, &child, &run, "archived-native-child");
    save_group_session(
        &f,
        &identity("codex", "archived-native-child", &f.parent.workspace_path),
        "child",
        "",
    );
    idle_group_root(&f);
    assert!(f.manager.session_lifecycle(&f.parent).unwrap().idle);
    let group = f.manager.archive_group(&f.parent).unwrap();
    let result = f.manager.session_lifecycle(&f.parent).unwrap();
    assert!(result.archived && result.idle);
    assert_eq!(
        f.manager.inner.lock().archived_groups.get(&key(&f.parent)),
        Some(&group)
    );
    let cold = LeaderManager::new(
        f.manager.db.clone(),
        Arc::new(crate::engine::ProcessRegistry::default()),
        f.emitter.clone(),
    )
    .unwrap();
    let result = cold.session_lifecycle(&f.parent).unwrap();
    assert!(result.archived && result.idle);
    assert_eq!(
        f.manager
            .db
            .0
            .lock()
            .query_row("SELECT COUNT(*) FROM session_archives", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn task_lifecycle_checks_reservations_pending_bindings_isolated_launch_and_retirement() {
    let f = basic();
    local(&f);
    assert!(!f.manager.session_lifecycle(&f.parent).unwrap().idle); // pid 0 still owns a launch
    idle_group_root(&f);
    f.manager.inner.lock().pending_bindings.insert(
        "binding".into(),
        (f.parent.engine.clone(), f.parent.session_id.clone()),
    );
    assert!(!f.manager.session_lifecycle(&f.parent).unwrap().idle);
    f.manager.inner.lock().pending_bindings.clear();
    {
        let mut inner = f.manager.inner.lock();
        let run = inner.runs.get_mut(&f.caller.run_id).unwrap();
        run.session_id = None;
        run.isolated_resume_session = Some(f.parent.session_id.clone());
        run.retired = false;
        run.launch_pending = true;
    }
    assert!(!f.manager.session_lifecycle(&f.parent).unwrap().idle);
    f.manager.finish(&f.caller.run_id);
    f.manager
        .inner
        .lock()
        .retiring
        .insert((f.parent.engine.clone(), f.parent.session_id.clone()));
    assert!(!f.manager.session_lifecycle(&f.parent).unwrap().idle);
    f.manager.inner.lock().retiring.clear();
    f.manager
        .processes
        .insert(f.parent.session_id.clone(), reservation("virtual-run"));
    assert!(!f.manager.session_lifecycle(&f.parent).unwrap().idle);
}

#[test]
fn task_lifecycle_rechecks_late_children_and_refuses_unknown_children() {
    let f = basic();
    local(&f);
    let (id, run) = spawn(&f, "lifecycle-child");
    idle_group_root(&f);
    assert!(!f.manager.session_lifecycle(&f.parent).unwrap().idle);
    settle(&f, &id, &run, "lifecycle-native-child");
    f.manager.processes.remove_run_if_pid(&run, 0);
    assert!(f.manager.session_lifecycle(&f.parent).unwrap().idle);
    f.manager
        .inner
        .lock()
        .branches
        .get_mut(&id)
        .unwrap()
        .branch
        .state = "unknown".into();
    assert!(!f.manager.session_lifecycle(&f.parent).unwrap().idle);
}

#[test]
fn task_lifecycle_rejects_missing_remote_and_conflicting_source_identity() {
    for case in [
        "missing",
        "saved-workspace",
        "archive-workspace",
        "archive-engine",
        "remote",
        "remote-workspace",
        "duplicate-workspace",
    ] {
        let f = basic();
        local(&f);
        idle_group_root(&f);
        let conn = f.manager.db.0.lock();
        match case {
            "missing" => {
                conn.execute("DELETE FROM sessions", []).unwrap();
            }
            "saved-workspace" => {
                conn.execute("UPDATE sessions SET workspace_path='elsewhere'", [])
                    .unwrap();
            }
            "remote-workspace" => {
                conn.execute("UPDATE workspaces SET meta='{\"wsl\":{}}'", [])
                    .unwrap();
            }
            "duplicate-workspace" => {
                conn.execute(
                    "INSERT INTO workspaces(id,path) VALUES('duplicate',?1)",
                    [&f.parent.workspace_path],
                )
                .unwrap();
            }
            _ => {
                let snapshot = json!({"engine":if case == "archive-engine" {"agy"} else {"claude"}, "sessionId":f.parent.session_id,
                    "workspacePath":f.parent.workspace_path, "remote":case == "remote"});
                conn.execute("INSERT INTO session_archives(engine,session_id,workspace_path,snapshot_json) VALUES(?1,?2,?3,?4)",
                    params![f.parent.engine, f.parent.session_id, if case == "archive-workspace" {"elsewhere"} else {&f.parent.workspace_path}, snapshot.to_string()]).unwrap();
            }
        }
        drop(conn);
        assert!(f.manager.session_lifecycle(&f.parent).is_err(), "{case}");
    }
}

#[test]
fn task_lifecycle_registry_failure_is_not_idle_evidence() {
    let f = basic();
    local(&f);
    idle_group_root(&f);
    let processes = f.manager.processes.clone();
    let _ = std::thread::spawn(move || {
        let _guard = processes.0.lock().unwrap();
        panic!("fixture poisoned registry");
    })
    .join();
    assert!(f.manager.session_lifecycle(&f.parent).is_err());
}
