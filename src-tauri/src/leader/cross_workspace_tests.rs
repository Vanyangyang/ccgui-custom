use super::*;
use crate::workspace_projects::{MemberRole, ProjectInput, ProjectMemberInput};

fn project_fixture() -> (Fixture, CostContextScratch, String, String) {
    let scratch = CostContextScratch::new();
    let parent = scratch.0.join("host").to_string_lossy().into_owned();
    let target = scratch.0.join("game").to_string_lossy().into_owned();
    let reference = scratch.0.join("reference").to_string_lossy().into_owned();
    let mut f = basic();
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
fn registered_directory_alias_uses_member_identity_but_retargeting_cannot_gain_authority() {
    let (f, scratch, target, reference) = project_fixture();
    let alias = scratch.0.join("game-alias");
    directory_alias(&scratch, &alias, &target);
    let alias_path = alias.to_string_lossy().into_owned();
    // Canonical equivalence alone cannot substitute for executable registration.
    assert!(f.manager.spawn_workspace(&f.parent, Some(&alias_path)).is_err());
    f.manager.db.0.lock().execute("INSERT INTO workspaces(id,path) VALUES('registered-alias',?1)", [&alias_path]).unwrap();
    // Workspace registration alone does not assign this new alias a project role.
    assert!(f.manager.spawn_workspace(&f.parent, Some(&alias_path)).is_err());
    let project = crate::workspace_projects::list_inner(&f.manager.db.0.lock()).unwrap().remove(0);
    crate::workspace_projects::save_inner(&mut f.manager.db.0.lock(), ProjectInput {
        id: Some(project.id), name: project.name, default_path: project.default_path,
        members: project.members.into_iter().map(|m| ProjectMemberInput {
            id: m.id, path: if m.path == target { alias_path.clone() } else { m.path }, label: m.label, role: m.role,
        }).collect(),
    }, None).unwrap();
    assert_eq!(f.manager.spawn_workspace(&f.parent, Some(&alias_path)).unwrap(), alias_path);
    remove_alias(&alias);
    directory_alias(&scratch, &alias, &reference);
    assert!(f.manager.spawn_workspace(&f.parent, Some(&alias_path)).is_err());
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
fn native_project_authorization_rejects_reference_external_archived_missing_and_remote() {
    let (f, scratch, target, reference) = project_fixture();
    assert_eq!(f.manager.spawn_workspace(&f.parent, Some(&target)).unwrap(), target);
    assert!(f.manager.spawn_workspace(&f.parent, Some(&reference)).is_err());
    let external = scratch.0.join("external").to_string_lossy().into_owned();
    std::fs::create_dir(&external).unwrap();
    f.manager.db.0.lock().execute("INSERT INTO workspaces(id,path) VALUES('external',?1)", [&external]).unwrap();
    assert!(f.manager.spawn_workspace(&f.parent, Some(&external)).is_err());
    let other_parent = identity(&f.parent.engine, &f.parent.session_id, &external);
    assert!(f.manager.spawn_workspace(&other_parent, Some(&target)).is_err());
    let nested = std::path::Path::new(&target).join("unregistered").to_string_lossy().into_owned();
    std::fs::create_dir(&nested).unwrap();
    assert!(f.manager.spawn_workspace(&f.parent, Some(&nested)).is_err());
    let id: String = f.manager.db.0.lock().query_row("SELECT id FROM workspaces WHERE path=?1", [&target], |r| r.get(0)).unwrap();
    assert!(validate_workspace_registration(&f.manager.db.0.lock(), &target, &[id], true).unwrap_err().contains("archived"));
    for meta in [r#"{"remote":{}}"#, r#"{"wsl":{}}"#, "invalid-json"] {
        f.manager.db.0.lock().execute("UPDATE workspaces SET meta=?1 WHERE path=?2", params![meta, target]).unwrap();
        assert!(f.manager.spawn_workspace(&f.parent, Some(&target)).is_err());
    }
    f.manager.db.0.lock().execute("UPDATE workspaces SET meta=NULL WHERE path=?1", [&target]).unwrap();
    // The recorded member identity must still agree with the live directory.
    f.manager.db.0.lock().execute("UPDATE plugin_kv SET value=json_set(value,'$.projects[0].members[1].canonicalIdentity','stale') WHERE plugin_id='$ccgui-workspace-projects'", []).unwrap();
    assert!(f.manager.spawn_workspace(&f.parent, Some(&target)).is_err());
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
    let send = SendArgs { branch_id: id.clone(), request_id: "follow-up".into(), message: "Continue".into() };
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
