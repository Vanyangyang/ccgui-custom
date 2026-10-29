use super::*;

#[test]
fn managed_parent_message_requires_the_unique_actual_parent() {
    let f = basic();
    let (id, _, sender) = child(&f);
    for target in [f.parent.session_id.as_str(), "parent-s"] {
        let route = f.manager.managed_parent_message(&sender, target, None, None).unwrap();
        assert_eq!(route.branch_id, id);
        assert_eq!(route.session_id, f.parent.session_id);
        assert_eq!(route.engine, f.parent.engine);
        assert_eq!(route.workspace_path, f.parent.workspace_path);
    }
    for target in ["other-session", "child-session", "parent"] {
        assert!(f.manager.managed_parent_message(&sender, target, None, None).is_none());
    }
    assert!(f.manager.managed_parent_message(&sender, &f.parent.session_id, Some("agy"), None).is_none());
    assert!(f.manager.managed_parent_message(&sender, &f.parent.session_id, None, Some("elsewhere")).is_none());
    for impostor in [f.parent.clone(), identity("claude", "child-session", &sender.workspace_path),
        identity("codex", "sibling-session", &sender.workspace_path), identity("codex", "child-session", "elsewhere")] {
        assert!(f.manager.managed_parent_message(&impostor, &f.parent.session_id, None, None).is_none());
    }
}

#[test]
fn managed_parent_message_rejects_retired_duplicate_and_ambiguous_relationships() {
    let f = basic();
    let (id, _, sender) = child(&f);
    for state in ["reclaimed", "handed_off"] {
        f.manager.inner.lock().branches.get_mut(&id).unwrap().branch.state = state.into();
        assert!(f.manager.managed_parent_message(&sender, &f.parent.session_id, None, None).is_none());
    }
    f.manager.inner.lock().branches.get_mut(&id).unwrap().branch.state = "running".into();
    let (other, _) = spawn(&f, "other-child");
    {
        let mut inner = f.manager.inner.lock();
        inner.branches.get_mut(&other).unwrap().branch.parent_session_id = "parent-something-else".into();
    }
    assert!(f.manager.managed_parent_message(&sender, "parent-s", None, None).is_none());
    assert!(f.manager.managed_parent_message(&sender, &f.parent.session_id, None, None).is_some());
    {
        let mut inner = f.manager.inner.lock();
        inner.branches.get_mut(&other).unwrap().branch.session_id = Some(sender.session_id.clone());
    }
    assert!(f.manager.managed_parent_message(&sender, &f.parent.session_id, None, None).is_none());
}

#[test]
fn managed_parent_message_uses_durable_parent_workspace_and_aliases() {
    let f = basic();
    let (id, run, sender) = child(&f);
    f.manager.inner.lock().branches.get_mut(&id).unwrap().branch.parent_workspace_path = Some("G:/Parent/Workspace".into());
    let alias = if cfg!(windows) { "G:\\Parent\\Workspace" } else { "G:/Parent/Workspace" };
    let route = f.manager.managed_parent_message(&sender, &f.parent.session_id, Some(&f.parent.engine), Some(alias)).unwrap();
    assert_eq!(route.workspace_path, "G:/Parent/Workspace");
    assert!(f.manager.managed_parent_message(&sender, &f.parent.session_id, None, Some(&sender.workspace_path)).is_none());
    observe(&f, &run, "child-session", "done", json!({}), 2);
    let restored = LeaderManager::with_services(f.manager.db.clone(),
        Arc::new(crate::engine::ProcessRegistry::default()), f.emitter.clone(),
        Arc::new(|| 1_000_100), Arc::new(|_, _, _| Ok(()))).unwrap();
    assert!(restored.managed_parent_message(&sender, &f.parent.session_id, None, Some(alias)).is_some());
}

fn child(f: &Fixture) -> (String, String, LeaderIdentity) {
    let (id, run) = spawn(f, "message-child");
    observe(f, &run, "child-session", "session", json!("child-session"), 1);
    (id, run, identity("codex", "child-session", &f.parent.workspace_path))
}

#[test]
fn parent_message_reports_are_rejected_but_explicit_questions_are_allowed() {
    let f = basic();
    let (_, run, sender) = child(&f);
    for target in [f.parent.session_id.as_str(), "parent-s"] {
        let error = f.manager.validate_parent_message(&sender, target, None, None, false).unwrap_err();
        assert!(error.starts_with("TASK_REPORT_REQUIRES_TASK_CHANNEL"));
        assert!(error.contains("No consultation was queued"));
        assert!(error.contains("task_list/task_wait"));
        assert!(f.manager.validate_parent_message(&sender, target, None, None, true).is_ok());
    }
    // Progress and completion already reach the parent's task result without a
    // saved-chat consultation; rejecting the duplicate must not mutate them.
    observe(&f, &run, "child-session", "delta", json!("已完成 ✅"), 2);
    observe(&f, &run, "child-session", "done", json!({}), 3);
    let result = f.manager.list_response(&f.manager.inner.lock(), &f.parent).unwrap();
    assert_eq!(result["branches"][0]["delegation"]["state"], "completed");
    assert_eq!(result["branches"][0]["delegation"]["result"], "已完成 ✅");
}

#[test]
fn parent_message_identity_preserves_unrelated_consultations() {
    let f = basic();
    let (_, _, sender) = child(&f);
    assert!(f.manager.validate_parent_message(&sender, "other-session", None, None, false).is_ok());
    assert!(f.manager.validate_parent_message(&sender, &f.parent.session_id, Some("agy"), None, false).is_ok());
    assert!(f.manager.validate_parent_message(&sender, &f.parent.session_id, None, Some("other-workspace"), false).is_ok());
    for unrelated in [identity("claude", &sender.session_id, &sender.workspace_path),
        identity(&sender.engine, &sender.session_id, "other-workspace"),
        identity(&sender.engine, "other-session", &sender.workspace_path), f.parent.clone()] {
        assert!(f.manager.validate_parent_message(&unrelated, &f.parent.session_id, None, None, false).is_ok());
    }
}

#[test]
fn parent_message_guard_survives_completion_and_reload_without_live_run() {
    let f = basic();
    let (id, run, sender) = child(&f);
    observe(&f, &run, "child-session", "done", json!({}), 2);
    let restored = LeaderManager::with_services(f.manager.db.clone(),
        Arc::new(crate::engine::ProcessRegistry::default()), f.emitter.clone(),
        Arc::new(|| 1_000_100), Arc::new(|_, _, _| Ok(()))).unwrap();
    assert!(restored.validate_parent_message(&sender, &f.parent.session_id, None, None, false).is_err());
    assert_eq!(branch(&f, &id).state, "completed");
}

#[test]
fn parent_message_uses_parent_workspace_and_legacy_fallback() {
    let f = basic();
    let (id, _, sender) = child(&f);
    {
        let mut inner = f.manager.inner.lock();
        let b = &mut inner.branches.get_mut(&id).unwrap().branch;
        b.parent_workspace_path = Some("G:/Parent/Workspace".into());
    }
    let parent_path = if cfg!(windows) { "G:\\Parent\\Workspace" } else { "G:/Parent/Workspace" };
    assert!(f.manager.validate_parent_message(&sender, &f.parent.session_id,
        Some(&f.parent.engine), Some(parent_path), false).is_err());
    assert!(f.manager.validate_parent_message(&sender, &f.parent.session_id,
        None, Some(&sender.workspace_path), false).is_ok());
    {
        let mut inner = f.manager.inner.lock();
        inner.branches.get_mut(&id).unwrap().branch.parent_workspace_path = None;
    }
    assert!(f.manager.validate_parent_message(&sender, &f.parent.session_id,
        None, Some(&sender.workspace_path), false).is_err());
}

#[test]
fn parent_message_child_instructions_explain_the_existing_result_channel() {
    let instructions = managed_child_instructions();
    for required in ["normal assistant output", "task_list/task_wait", "Do not call send_message", "intent=\"question\"", "task_send is parent-to-child"] {
        assert!(instructions.contains(required));
    }
}
