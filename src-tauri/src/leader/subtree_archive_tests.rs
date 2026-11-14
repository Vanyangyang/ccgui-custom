use super::*;

fn chat(f: &Fixture, session: &str) -> LeaderIdentity {
    identity("codex", session, &f.parent.workspace_path)
}

/// Live parent -> child -> grandchild, plus a sibling; every chat saved now.
fn tree(f: &Fixture) -> (String, String, String) {
    let (child, grand, sibling, _) = user_delete_tree(f);
    for session in ["delete-child-session", "delete-grand-session", "delete-sibling-session"] {
        save_group_session(f, &chat(f, session), session, "");
    }
    f.manager.db.0.lock().execute("UPDATE sessions SET updated_at=?1", [f.clock.load(Ordering::SeqCst)]).unwrap();
    (child, grand, sibling)
}

fn expectation(f: &Fixture, ids: &[&String], sessions: &[&str]) -> GroupCleanupExpectation {
    GroupCleanupExpectation {
        branch_ids: ids.iter().map(|id| (*id).clone()).collect(),
        members: sessions.iter().map(|session| chat(f, session)).collect(),
        last_activity_at: f.clock.load(Ordering::SeqCst),
    }
}

fn lapse_leases(f: &Fixture) {
    let latest = f.manager.inner.lock().branches.values().map(|r| r.branch.deadline_at).max().unwrap();
    f.clock.store(latest + 1, Ordering::SeqCst);
}

fn listed(manager: &LeaderManager, parent: &LeaderIdentity) -> Vec<String> {
    let response = manager.list_response(&manager.inner.lock(), parent).unwrap();
    response["branches"].as_array().unwrap().iter().map(|b| b["id"].as_str().unwrap().to_string()).collect()
}

#[test]
fn expired_child_subtree_archives_alone_beneath_its_live_parent_and_restores() {
    let f = basic();
    let (child, grand, sibling) = tree(&f);
    let expected = expectation(&f, &[&child, &grand], &["delete-child-session", "delete-grand-session"]);
    // An unexpired lease means the parent may still continue this child.
    let early = f.manager.archive_subtree_checked(&f.parent, &child, &expected).unwrap_err();
    assert!(early.contains("CLEANUP_GROUP_CHANGED"), "{early}");
    assert_eq!(archive_count(&f), 0);

    lapse_leases(&f);
    let group = f.manager.archive_subtree_checked(&f.parent, &child, &expected).unwrap();
    let child_chat = chat(&f, "delete-child-session");
    assert_eq!(group.root, child_chat);
    // The child's own branch is implied by its chat, keeping the record shape
    // that group-only readers already validate.
    assert_eq!(group.branch_ids, vec![grand.clone()]);
    assert_eq!(group.members, vec![child_chat.clone(), chat(&f, "delete-grand-session")]);
    assert_eq!(archive_count(&f), 2);
    assert!(f.manager.processes.get(&f.caller.run_id).is_some());
    assert_eq!(listed(&f.manager, &f.parent), vec![sibling.clone()]);
    assert!(f.manager.renew(&f.parent, &child, Some(60)).unwrap_err().contains("archived Leader group"));
    for session in ["delete-child-session", "delete-grand-session"] {
        assert!(ensure_session_not_group_archived(&f.manager.db.0.lock(), "codex", session).is_err());
    }
    assert!(f.manager.archive_group(&child_chat).is_err());

    let recovered = reload(&f).unwrap();
    assert_eq!(recovered.snapshot().unwrap().archived_groups, vec![group]);
    recovered.restore_group(&child_chat).unwrap();
    assert_eq!(archive_count(&f), 0);
    assert!(recovered.snapshot().unwrap().archived_groups.is_empty());
    assert_eq!(listed(&recovered, &f.parent).len(), 2);
}

#[test]
fn whole_group_archive_absorbs_an_archived_child_and_restores_it_once() {
    let f = basic();
    let (child, grand, sibling) = tree(&f);
    lapse_leases(&f);
    let subtree = expectation(&f, &[&child, &grand], &["delete-child-session", "delete-grand-session"]);
    f.manager.archive_subtree_checked(&f.parent, &child, &subtree).unwrap();
    idle_group_root(&f);
    let mut whole = expectation(&f, &[&child, &grand, &sibling],
        &["delete-child-session", "delete-grand-session", "delete-sibling-session"]);
    whole.members.insert(0, f.parent.clone());
    // An archived chat cannot have run since; a later scan time is not activity.
    f.manager.db.0.lock().execute("UPDATE sessions SET updated_at=?1 WHERE session_id='delete-grand-session'",
        [whole.last_activity_at + 1]).unwrap();

    let group = f.manager.archive_group_checked(&f.parent, Some(&whole)).unwrap();
    assert_eq!(f.manager.snapshot().unwrap().archived_groups, vec![group.clone()]);
    assert_eq!(group.members.len(), 4);
    assert_eq!(archive_count(&f), 4);
    let owner: String = f.manager.db.0.lock().query_row(
        "SELECT root_session_id FROM leader_archived_members WHERE session_id='delete-grand-session'", [], |r| r.get(0),
    ).unwrap();
    assert_eq!(owner, f.parent.session_id);
    assert_eq!(reload(&f).unwrap().snapshot().unwrap().archived_groups, vec![group]);
    f.manager.restore_group(&f.parent).unwrap();
    assert_eq!(archive_count(&f), 0);
    assert!(f.manager.snapshot().unwrap().archived_groups.is_empty());
}

#[test]
fn child_archive_rejects_unsettled_changed_or_foreign_subtrees_atomically() {
    for case in ["running", "failed-live-lease", "member-set", "branch-activity", "session-activity", "pinned", "wrong-parent"] {
        let f = basic();
        let (child, grand, _) = tree(&f);
        let mut expected = expectation(&f, &[&child, &grand], &["delete-child-session", "delete-grand-session"]);
        let mut parent = f.parent.clone();
        if case != "failed-live-lease" {
            lapse_leases(&f);
        }
        match case {
            "running" => f.manager.inner.lock().branches.get_mut(&grand).unwrap().branch.state = "running".into(),
            "failed-live-lease" => {
                let mut inner = f.manager.inner.lock();
                let branch = &mut inner.branches.get_mut(&child).unwrap().branch;
                branch.state = "failed".into();
                branch.error = Some("quota reached".into());
            }
            "member-set" => { expected.members.pop(); }
            "branch-activity" => f.manager.inner.lock().branches.get_mut(&grand).unwrap().branch.last_activity_at = expected.last_activity_at + 1,
            "session-activity" => { f.manager.db.0.lock().execute("UPDATE sessions SET updated_at=?1 WHERE session_id='delete-grand-session'", [expected.last_activity_at + 1]).unwrap(); }
            "pinned" => { f.manager.db.0.lock().execute("UPDATE sessions SET pinned=1 WHERE session_id='delete-grand-session'", []).unwrap(); }
            "wrong-parent" => parent = chat(&f, "delete-sibling-session"),
            _ => unreachable!(),
        }
        let error = f.manager.archive_subtree_checked(&parent, &child, &expected).unwrap_err();
        assert!(error.contains("CLEANUP_GROUP_CHANGED") || error.contains("must be idle"), "{case}: {error}");
        assert_eq!(archive_count(&f), 0, "{case}");
        assert!(f.manager.snapshot().unwrap().archived_groups.is_empty(), "{case}");
    }
}

#[test]
fn lapsed_unsuccessful_children_settle_for_cleanup_but_live_work_never_does() {
    for state in ["failed", "stopped", "unknown"] {
        let (f, expected) = cleanup_checked_fixture();
        {
            let mut inner = f.manager.inner.lock();
            let branch = &mut inner.branches.get_mut(&expected.branch_ids[0]).unwrap().branch;
            branch.state = state.into();
            branch.error = Some("ended without a result".into());
        }
        assert!(f.manager.archive_group_checked(&f.parent, Some(&expected)).is_err(), "{state}");
        lapse_leases(&f);
        f.manager.archive_group_checked(&f.parent, Some(&expected)).unwrap();
        assert_eq!(archive_count(&f), 2, "{state}");
    }
    let (f, expected) = cleanup_checked_fixture();
    f.manager.inner.lock().branches.get_mut(&expected.branch_ids[0]).unwrap().branch.state = "waiting".into();
    lapse_leases(&f);
    assert!(f.manager.archive_group_checked(&f.parent, Some(&expected)).is_err());
    assert_eq!(archive_count(&f), 0);
}

#[tokio::test]
async fn deleting_an_archived_child_removes_only_its_subtree_and_reclaim_cannot_erase_it() {
    let (f, deleted) = recording_fixture();
    let (child, grand, sibling) = tree(&f);
    lapse_leases(&f);
    // Archive only the grandchild; its parent chat (the child) stays live.
    let child_chat = chat(&f, "delete-child-session");
    f.manager.archive_subtree_checked(&child_chat, &grand, &expectation(&f, &[&grand], &["delete-grand-session"])).unwrap();
    // Reclaiming the child would erase user-retained history beneath it.
    assert!(f.manager.reclaim(&f.parent, &child).await.unwrap_err().contains("archived Leader group"));
    assert!(deleted.lock().is_empty());
    assert_eq!(branch(&f, &child).state, "completed");

    f.manager.delete_group(&chat(&f, "delete-grand-session")).await.unwrap();
    assert_eq!(*deleted.lock(), vec!["delete-grand-session"]);
    assert_eq!(branch(&f, &grand).state, "reclaimed");
    assert_eq!(branch(&f, &child).state, "completed");
    assert_eq!(branch(&f, &sibling).state, "completed");
    assert!(f.manager.snapshot().unwrap().archived_groups.is_empty());
    assert!(f.manager.inner.lock().retiring.is_empty());
    assert!(f.manager.processes.get(&f.caller.run_id).is_some());
}
