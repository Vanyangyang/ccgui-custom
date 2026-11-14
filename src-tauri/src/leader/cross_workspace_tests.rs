use super::*;
use crate::workspace_projects::{MemberRole, ProjectInput, ProjectMemberInput};

fn project_fixture() -> (Fixture, CostContextScratch, String, String) {
    project_fixture_with_engine("claude")
}

fn project_fixture_with_engine(engine: &str) -> (Fixture, CostContextScratch, String, String) {
    let scratch = CostContextScratch::new();
    let parent = scratch.0.join("host").to_string_lossy().into_owned();
    let target = scratch.0.join("game").to_string_lossy().into_owned();
    let reference = scratch.0.join("reference").to_string_lossy().into_owned();
    let mut f = fixture_with_engine(Arc::new(|_, _, _| Ok(())), engine);
    for (index, path) in [&parent, &target, &reference].into_iter().enumerate() {
        std::fs::create_dir(path).unwrap();
        f.manager.db.0.lock().execute("INSERT INTO workspaces(id,path) VALUES(?1,?2)",
            params![format!("cross-{}-{index}", uuid::Uuid::new_v4()), path]).unwrap();
    }
    f.parent.workspace_path = parent.clone();
    f.caller.workspace_path = parent.clone();
    f.manager.inner.lock().runs.get_mut(&f.caller.run_id).unwrap().workspace_path = parent.clone();
    save_group_session(&f, &f.parent, "Host", "");
    crate::workspace_projects::save_inner(&mut f.manager.db.0.lock(), ProjectInput {
        id: None, name: "Game project".into(), default_path: parent.clone(),
        members: [&parent, &target, &reference].into_iter().enumerate().map(|(index, path)| ProjectMemberInput {
            id: index.to_string(), path: path.clone(), label: index.to_string(),
            role: if index == 2 { MemberRole::Reference } else { MemberRole::Development },
        }).collect(),
    }, None).unwrap();
    (f, scratch, target, reference)
}

fn cross_args(target: &str) -> SpawnArgs {
    SpawnArgs { workspace_path: Some(target.into()), ..args("cross-spawn") }
}

#[tokio::test]
async fn external_workspace_dispatch_ignores_legacy_grants_and_preserves_ownership_and_cost_approval() {
    let (f, scratch, _, _) = project_fixture();
    let target = scratch.0.join("external-workbench").to_string_lossy().into_owned();
    std::fs::create_dir(&target).unwrap();
    f.manager.db.0.lock().execute("INSERT INTO workspaces(id,path) VALUES('external-workbench',?1)", [&target]).unwrap();
    let (id, run) = spawn_with_args(&f, &cross_args(&target));
    assert_eq!(branch(&f, &id).workspace_path, target);
    assert_eq!(branch(&f, &id).parent_workspace(), f.parent.workspace_path);
    assert_eq!(f.manager.inner.lock().runs[&run].permission, "manual");
    f.manager.db.0.lock().execute("INSERT INTO plugin_kv(plugin_id,key,value) VALUES('$ccgui-task-workspace-access','obsolete','bad-json')", []).unwrap();
    f.manager.prepare(&run, "codex", None, &target, Some("manual")).unwrap();
    crate::task_workspace_access::recheck_managed_launch(&f.manager.db, &run, "codex", &target).unwrap();
    for (run_id, engine, cwd) in [("wrong-run", "codex", target.as_str()),
        (run.as_str(), "claude", target.as_str()), (run.as_str(), "codex", f.parent.workspace_path.as_str())] {
        assert!(crate::task_workspace_access::recheck_managed_launch(&f.manager.db, run_id, engine, cwd).is_err());
    }
    // Removing old permissions during asynchronous preparation has no effect.
    f.manager.db.0.lock().execute("DELETE FROM plugin_kv WHERE plugin_id='$ccgui-task-workspace-access'", []).unwrap();
    crate::task_workspace_access::recheck_managed_launch(&f.manager.db, &run, "codex", &target).unwrap();
    settle(&f, &id, &run, "external-child");
    let held = held_send(&f, &id, "external-held");
    assert_eq!(branch(&f, &id).state, "awaiting_cost_approval");
    assert!(f.manager.prepare(&run, "codex", Some("external-child"), &target, Some("manual")).unwrap_err().contains("cost approval"));
    assert!(crate::task_workspace_access::recheck_managed_launch(&f.manager.db, &run, "codex", &target).is_err());
    let wrong_parent = identity(&f.parent.engine, &f.parent.session_id, &target);
    assert!(f.manager.reserve_send(&f.caller, &wrong_parent, "manual", &held, encoded(&held).unwrap()).is_err());
    assert!(f.manager.stop(&wrong_parent, &id).await.is_err());
    assert_eq!(f.manager.stop(&f.parent, &id).await.unwrap().state, "stopped");
    hot_send_cache(&f, &id);
    let followup = SendArgs { images: vec![], branch_id: id.clone(), request_id: "external-followup".into(), message: "continue".into() };
    let Reservation::Start((resumed, next_run)) = f.manager.reserve_send(&f.caller, &f.parent, "manual", &followup, encoded(&followup).unwrap()).unwrap()
        else { panic!("follow-up should start without a workspace grant"); };
    assert_eq!(resumed.workspace_path, target);
    assert_eq!(resumed.parent_workspace(), f.parent.workspace_path);
    crate::task_workspace_access::recheck_managed_launch(&f.manager.db, &next_run, "codex", &target).unwrap();
    assert!(f.manager.processes.get(&f.caller.run_id).is_some());
}

#[test]
fn all_supported_parent_and_child_engines_dispatch_across_projects_without_grants() {
    for parent_engine in ["claude", "codex", "agy", "cursor"] {
        for child_engine in ["claude", "codex", "agy", "cursor"] {
            let (f, _scratch, target, _) = project_fixture_with_engine(parent_engine);
            {
                let mut conn = f.manager.db.0.lock();
                conn.execute("DELETE FROM plugin_kv WHERE plugin_id='$ccgui-workspace-projects'", []).unwrap();
                for (index, path) in [&f.parent.workspace_path, &target].into_iter().enumerate() {
                    crate::workspace_projects::save_inner(&mut conn, ProjectInput {
                        id: None, name: format!("Independent project {index}"), default_path: path.clone(),
                        members: vec![ProjectMemberInput { id: index.to_string(), path: path.clone(),
                            label: index.to_string(), role: MemberRole::Development }],
                    }, None).unwrap();
                }
            }
            let args = SpawnArgs { engine: child_engine.into(), ..cross_args(&target) };
            let (id, run) = spawn_with_args(&f, &args);
            f.manager.prepare(&run, child_engine, None, &target, Some("manual")).unwrap();
            crate::task_workspace_access::recheck_managed_launch(&f.manager.db, &run, child_engine, &target).unwrap();
            assert_eq!(branch(&f, &id).parent_engine, parent_engine);
            assert_eq!(branch(&f, &id).engine, child_engine);
            assert_eq!(f.manager.inner.lock().runs[&run].permission, "manual");
        }
    }
}

#[test]
fn native_handoff_cross_workspace_preserves_parent_and_execution_cwd() {
    let (f, _scratch, target, _) = project_fixture();
    f.manager.db.0.lock().execute("DELETE FROM plugin_kv WHERE plugin_id='$ccgui-workspace-projects'", []).unwrap();
    let args = cross_args(&target);
    let Reservation::Start((id, run)) = f.manager.reserve_spawn(&f.caller, &f.parent, "manual",
        &args, encoded(&args).unwrap(), Some("test-model".into()), Some("high".into())).unwrap()
        else { panic!("new child expected"); };
    settle(&f, &id, &run, "cross-handoff-source");
    let held = held_send(&f, &id, "cross-held");
    let (successor, _, _, _) = handoff(&f, &id, &held.request_id, "cross-op", "Cross-workspace summary").unwrap().unwrap();
    assert_eq!(successor.workspace_path, target);
    assert_eq!(successor.parent_workspace_path.as_deref(), Some(f.parent.workspace_path.as_str()));
    assert_eq!(successor.parent_session_id, f.parent.session_id);
    let wrong_parent = identity(&f.parent.engine, &f.parent.session_id, &target);
    assert!(f.manager.resolve_child_id(&f.manager.inner.lock(), &wrong_parent, &id).is_err());
    assert_eq!(f.manager.resolve_child_id(&f.manager.inner.lock(), &f.parent, &id).unwrap(), successor.id);
}

fn directory_alias(scratch: &CostContextScratch, alias: &std::path::Path, target: &str) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let script = scratch.0.join("create-junction.cmd");
        std::fs::write(&script, b"@echo off\r\nmklink /J \"%CCGUI_TEST_LINK%\" \"%CCGUI_TEST_TARGET%\"\r\n").unwrap();
        let status = std::process::Command::new("cmd.exe").args(["/d", "/c"])
            .arg(&script).env("CCGUI_TEST_LINK", alias).env("CCGUI_TEST_TARGET", target)
            .creation_flags(0x08000000).output().unwrap();
        assert!(status.status.success(), "junction creation failed: {}", String::from_utf8_lossy(&status.stderr));
    }
    #[cfg(not(windows))]
    {
        let _ = scratch;
        std::os::unix::fs::symlink(target, alias).unwrap();
    }
}

fn remove_alias(alias: &std::path::Path) {
    #[cfg(windows)]
    std::fs::remove_dir(alias).unwrap();
    #[cfg(not(windows))]
    std::fs::remove_file(alias).unwrap();
}

#[test]
fn registered_directory_alias_needs_no_project_role_and_missing_targets_still_fail() {
    let (f, scratch, target, reference) = project_fixture();
    let alias = scratch.0.join("game-alias");
    directory_alias(&scratch, &alias, &target);
    let alias_path = alias.to_string_lossy().into_owned();
    // Canonical equivalence alone cannot substitute for executable registration.
    assert!(f.manager.spawn_workspace(&f.parent, Some(&alias_path)).is_err());
    f.manager.db.0.lock().execute("INSERT INTO workspaces(id,path) VALUES('registered-alias',?1)", [&alias_path]).unwrap();
    assert_eq!(f.manager.spawn_workspace(&f.parent, Some(&alias_path)).unwrap(), alias_path);
    let (id, run) = spawn_with_args(&f, &cross_args(&alias_path));
    crate::task_workspace_access::recheck_managed_launch(&f.manager.db, &run, "codex", &alias_path).unwrap();
    remove_alias(&alias);
    assert!(crate::task_workspace_access::recheck_managed_launch(&f.manager.db, &run, "codex", &alias_path).is_err());
    directory_alias(&scratch, &alias, &reference);
    assert_eq!(f.manager.spawn_workspace(&f.parent, Some(&alias_path)).unwrap(), alias_path);
    crate::task_workspace_access::recheck_managed_launch(&f.manager.db, &run, "codex", &alias_path).unwrap();
    assert_eq!(branch(&f, &id).workspace_path, alias_path);
    assert!(crate::task_workspace_access::recheck_managed_launch(&f.manager.db, &run, "codex", &reference).is_err());
    remove_alias(&alias);
}

#[test]
fn omitted_cwd_preserves_legacy_fingerprint_and_record_identity() {
    let old = json!({"request_id":"old", "engine":"codex", "title":"Task", "task":"Work",
        "model":null, "effort":null, "ttl_seconds":null});
    let decoded: SpawnArgs = decode(old.clone()).unwrap();
    assert_eq!(encoded(&decoded).unwrap(), old);
    assert_eq!(validate_arguments("task_spawn", old.clone()).unwrap(), old);
    for field in ["parent_workspace_path", "parent_session_id", "project_id", "permission"] {
        let mut forged = old.clone();
        forged[field] = json!("claimed-by-model");
        assert!(validate_arguments("task_spawn", forged).is_err());
    }
    let f = basic();
    let (id, _) = spawn(&f, "legacy");
    let old_record = encoded(&branch(&f, &id)).unwrap();
    assert!(old_record.get("parentWorkspacePath").is_none());
    let restored: LeaderBranch = decode(old_record).unwrap();
    assert!(belongs(&restored, &f.parent));
    assert_eq!(restored.parent_workspace(), restored.workspace_path);
    assert_eq!(f.manager.spawn_workspace(&f.parent, Some(&f.parent.workspace_path)).unwrap(), f.parent.workspace_path);
}

#[test]
fn native_dispatch_accepts_reference_and_external_but_rejects_unavailable_workspaces() {
    let (f, scratch, target, reference) = project_fixture();
    assert_eq!(f.manager.spawn_workspace(&f.parent, Some(&target)).unwrap(), target);
    assert_eq!(f.manager.spawn_workspace(&f.parent, Some(&reference)).unwrap(), reference);
    let external = scratch.0.join("external").to_string_lossy().into_owned();
    std::fs::create_dir(&external).unwrap();
    f.manager.db.0.lock().execute("INSERT INTO workspaces(id,path) VALUES('external',?1)", [&external]).unwrap();
    assert_eq!(f.manager.spawn_workspace(&f.parent, Some(&external)).unwrap(), external);
    let other_parent = identity(&f.parent.engine, &f.parent.session_id, &external);
    assert!(validate_parent(&f.manager.db, &other_parent, false).is_err());
    let forged_caller = Caller { workspace_path: external.clone(), ..f.caller.clone() };
    let args = cross_args(&target);
    assert!(f.manager.reserve_spawn(&forged_caller, &other_parent, "manual", &args, encoded(&args).unwrap(), None, None).is_err());
    let nested = std::path::Path::new(&target).join("unregistered").to_string_lossy().into_owned();
    std::fs::create_dir(&nested).unwrap();
    assert!(f.manager.spawn_workspace(&f.parent, Some(&nested)).is_err());
    let id: String = f.manager.db.0.lock().query_row("SELECT id FROM workspaces WHERE path=?1", [&target], |r| r.get(0)).unwrap();
    assert!(validate_workspace_registration(&f.manager.db.0.lock(), &target, &[id], true).unwrap_err().contains("archived"));
    for meta in [r#"{"remote":{}}"#, r#"{"wsl":{}}"#, "invalid-json", "[]", "null"] {
        f.manager.db.0.lock().execute("UPDATE workspaces SET meta=?1 WHERE path=?2", params![meta, target]).unwrap();
        assert!(f.manager.spawn_workspace(&f.parent, Some(&target)).is_err());
    }
    f.manager.db.0.lock().execute("UPDATE workspaces SET meta=NULL WHERE path=?1", [&target]).unwrap();
    // Project metadata no longer controls registered local dispatch.
    f.manager.db.0.lock().execute("UPDATE plugin_kv SET value=json_set(value,'$.projects[0].members[1].canonicalIdentity','stale') WHERE plugin_id='$ccgui-workspace-projects'", []).unwrap();
    assert_eq!(f.manager.spawn_workspace(&f.parent, Some(&target)).unwrap(), target);
    std::fs::remove_dir(&nested).unwrap();
    std::fs::remove_dir(&target).unwrap();
    assert!(f.manager.spawn_workspace(&f.parent, Some(&target)).is_err());
    for path in ["//server/share", "ssh://host/game", "relative"] {
        assert!(f.manager.spawn_workspace(&f.parent, Some(path)).is_err());
    }
}

#[tokio::test]
async fn cross_workspace_restart_retains_parent_controls_child_cwd_and_permission() {
    let (mut f, _scratch, target, _) = project_fixture();
    let spawn_args = cross_args(&target);
    let (id, run) = spawn_with_args(&f, &spawn_args);
    let child = branch(&f, &id);
    assert_eq!(child.workspace_path, target);
    assert_eq!(child.parent_workspace_path.as_deref(), Some(f.parent.workspace_path.as_str()));
    {
        let inner = f.manager.inner.lock();
        assert_eq!(inner.runs[&run].workspace_path, target);
        assert_eq!(inner.runs[&run].permission, "manual");
        assert_eq!(inner.branches[&id].permission, "manual");
    }
    assert!(f.manager.prepare(&run, "codex", None, &f.parent.workspace_path, Some("manual")).is_err());
    f.manager.prepare(&run, "codex", None, &target, Some("manual")).unwrap();
    settle(&f, &id, &run, "cross-child");
    f.manager.acknowledge(&f.parent, &spawn_args.request_id, &run,
        Ok(crate::engine::SendResult { run_id: run.clone(), session_id: Some("cross-child".into()) })).unwrap();
    let mut other_target = spawn_args.clone();
    other_target.workspace_path = Some(f.parent.workspace_path.clone());
    assert!(f.manager.reserve_spawn(&f.caller, &f.parent, "manual", &other_target,
        encoded(&other_target).unwrap(), None, None).is_err());
    hot_send_cache(&f, &id);
    let restarted = Arc::new(LeaderManager::with_services(f.manager.db.clone(),
        Arc::new(crate::engine::ProcessRegistry::default()), f.emitter.clone(),
        Arc::new(|| 1_000_001), Arc::new(|_, _, _| Ok(()))).unwrap());
    f.manager = restarted;
    f.manager.processes.insert(f.caller.run_id.clone(), reservation(&f.caller.run_id));
    f.manager.prepare(&f.caller.run_id, &f.caller.engine, Some(&f.caller.session_id),
        &f.caller.workspace_path, Some("manual")).unwrap();
    let impostor = identity(&f.parent.engine, &f.parent.session_id, &target);
    {
        let inner = f.manager.inner.lock();
        assert_eq!(inner.leaders[&key(&f.parent)], f.parent);
        assert_eq!(f.manager.views(&inner, &f.parent, Some(&[id.clone()])).unwrap().len(), 1);
        assert_eq!(f.manager.list_response(&inner, &f.parent).unwrap()["branches"][0]["workspacePath"], target);
        assert!(f.manager.child(&inner, &impostor, &id).is_err());
        assert!(f.manager.views(&inner, &impostor, Some(&[id.clone()])).is_err());
        let receipt = f.manager.replay(&inner, &f.parent, &spawn_args.request_id, "task_spawn", &encoded(&spawn_args).unwrap()).unwrap().unwrap();
        assert_eq!(receipt["branch"]["parentWorkspacePath"], f.parent.workspace_path);
    }
    assert!(f.manager.stop(&impostor, &id).await.is_err());
    let send = SendArgs { images: Vec::new(), branch_id: id.clone(), request_id: "follow-up".into(), message: "Continue".into() };
    assert!(f.manager.reserve_send(&f.caller, &impostor, "manual", &send, encoded(&send).unwrap()).is_err());
    let Reservation::Start((resumed, next_run)) = f.manager.reserve_send(&f.caller, &f.parent,
        "manual", &send, encoded(&send).unwrap()).unwrap() else { panic!("send did not start") };
    assert_eq!(resumed.workspace_path, target);
    assert_eq!(resumed.session_id.as_deref(), Some("cross-child"));
    assert_eq!(f.manager.inner.lock().runs[&next_run].workspace_path, target);
    assert_eq!(f.manager.inner.lock().runs[&next_run].permission, "manual");
    f.manager.finish(&next_run);
    assert_eq!(f.manager.stop(&f.parent, &id).await.unwrap().state, "stopped");
}

#[test]
fn cross_workspace_archive_restart_restore_uses_each_members_own_identity() {
    let (f, _scratch, target, _) = project_fixture();
    let (id, run) = spawn_with_args(&f, &cross_args(&target));
    settle(&f, &id, &run, "archive-cross-child");
    let child = identity("codex", "archive-cross-child", &target);
    save_group_session(&f, &child, "Game child", "");
    idle_group_root(&f);
    f.manager.archive_group(&f.parent).unwrap();
    let restarted = LeaderManager::with_services(f.manager.db.clone(),
        Arc::new(crate::engine::ProcessRegistry::default()), f.emitter.clone(),
        Arc::new(|| 1_000_001), Arc::new(|_, _, _| Ok(()))).unwrap();
    let snapshot = restarted.snapshot_memory();
    assert!(snapshot.archived_groups[0].members.contains(&f.parent));
    assert!(snapshot.archived_groups[0].members.contains(&child));
    restarted.restore_group(&f.parent).unwrap();
    assert!(restarted.child(&restarted.inner.lock(), &f.parent, &id).is_ok());
}

#[test]
fn cross_workspace_worker_handoff_keeps_both_identities_and_rejects_forged_parent_path() {
    let (f, _scratch, target, _) = project_fixture();
    let (id, run) = spawn_with_args(&f, &cross_args(&target));
    f.manager.processes.insert(run.clone(), reservation(&run));
    observe(&f, &run, "worker-cross-child", "session", json!("worker-cross-child"), 1);
    observe(&f, &run, "worker-cross-child", "delta", json!("Partial 中文"), 2);
    f.manager.acknowledge(&f.parent, "cross-spawn", &run,
        Ok(crate::engine::SendResult { run_id: run.clone(), session_id: Some("worker-cross-child".into()) })).unwrap();
    let saved = f.manager.try_capture_worker_registration(&run).unwrap().unwrap();
    f.manager.checkpoint().unwrap();
    let restarted = LeaderManager::with_services(f.manager.db.clone(),
        Arc::new(crate::engine::ProcessRegistry::default()), f.emitter.clone(),
        Arc::new(|| 1_000_001), Arc::new(|_, _, _| Ok(()))).unwrap();
    let mut proxy = reservation(&run);
    proxy.pid = 42; // Same live-routing fixture contract as worker_handoff tests.
    restarted.processes.insert(run.clone(), proxy);
    let mut forged = encoded(&saved).unwrap();
    forged["managed"]["branch"]["parentWorkspacePath"] = json!(target);
    assert!(restarted.restore_worker_registration(&decode(forged).unwrap()).unwrap_err().contains("conflicts with its current branch"));
    restarted.restore_worker_registration(&saved).unwrap();
    let inner = restarted.inner.lock();
    let child = &inner.branches[&id].branch;
    assert!(belongs(child, &f.parent));
    assert_eq!(child.workspace_path, target);
    assert_eq!(inner.runs[&run].workspace_path, target);
    assert_eq!(child.delegation.as_ref().unwrap().result, "Partial 中文");
}

#[tokio::test]
async fn cross_workspace_subtree_deletion_preserves_parent_and_receipt_ownership() {
    let (f, _scratch, target, _) = project_fixture();
    let args = cross_args(&target);
    let (id, run) = spawn_with_args(&f, &args);
    settle(&f, &id, &run, "delete-cross-child");
    save_group_session(&f, &identity("codex", "delete-cross-child", &target), "Child", "");
    f.manager.delete_branch_for_user(&f.parent, &id, &[id.clone()]).await.unwrap();
    let inner = f.manager.inner.lock();
    assert_eq!(inner.branches[&id].branch.state, "reclaimed");
    let receipt = f.manager.replay(&inner, &f.parent, &args.request_id, "task_spawn", &encoded(&args).unwrap()).unwrap().unwrap();
    assert_eq!(receipt["requestState"], "reclaimed");
    assert_eq!(receipt["branch"]["parentWorkspacePath"], f.parent.workspace_path);
    assert!(f.manager.processes.get(&f.caller.run_id).is_some());
}
