//! Human-only subtree deletion. Never routed through agent tools or remote actions.
use super::*;

struct HandoffDeletionBranch<'a> {
    id: &'a str,
    parent_engine: &'a str,
    parent_session: &'a str,
    parent_workspace: &'a str,
    from: Option<&'a str>,
    to: Option<&'a str>,
}

fn handoff_deletion_error(reason: &str) -> String {
    format!("Task handoff chain {reason}; use whole-group deletion instead of deleting this subtree")
}

// Check incoming links too: a damaged one-way link must not make its target
// appear unrelated. This validates the selection without expanding its scope.
fn validate_handoff_deletion(
    branches: &[HandoffDeletionBranch<'_>],
    ids: &[String],
) -> Result<(), String> {
    let selected: HashSet<_> = ids.iter().map(String::as_str).collect();
    let by_id: HashMap<_, _> = branches.iter().map(|branch| (branch.id, branch)).collect();
    for id in &selected {
        if !by_id.contains_key(id) {
            return Err(handoff_deletion_error("contains a missing branch"));
        }
    }
    for branch in branches {
        if !selected.contains(branch.id)
            && !branch.from.is_some_and(|id| selected.contains(id))
            && !branch.to.is_some_and(|id| selected.contains(id))
        {
            continue;
        }
        for (target_id, forward) in [(branch.from, false), (branch.to, true)] {
            let Some(target_id) = target_id else { continue };
            let target = by_id.get(target_id)
                .ok_or_else(|| handoff_deletion_error("contains a missing branch"))?;
            if target.id == branch.id {
                return Err(handoff_deletion_error("contains a cycle"));
            }
            if branch.parent_engine != target.parent_engine
                || branch.parent_session != target.parent_session
                || !same_workspace(branch.parent_workspace, target.parent_workspace)
            {
                return Err(handoff_deletion_error("crosses parent ownership"));
            }
            let reverse = if forward { target.from } else { target.to };
            if reverse != Some(branch.id) {
                return Err(handoff_deletion_error("has inconsistent reciprocal links"));
            }
            if !selected.contains(branch.id) || !selected.contains(target.id) {
                return Err(handoff_deletion_error("is not fully included in the selected subtree"));
            }
        }
    }
    let mut checked = HashSet::new();
    for id in selected {
        let mut path = HashSet::new();
        let mut cursor = Some(id);
        while let Some(id) = cursor {
            if checked.contains(id) { break; }
            if !path.insert(id) {
                return Err(handoff_deletion_error("contains a cycle"));
            }
            cursor = by_id.get(id)
                .ok_or_else(|| handoff_deletion_error("contains a missing branch"))?.to;
        }
        checked.extend(path);
    }
    Ok(())
}

impl LeaderManager {
    pub(super) fn validate_branch_deletion(
        &self,
        inner: &Inner,
        parent: &LeaderIdentity,
        ids: &[String],
    ) -> Result<Vec<LeaderIdentity>, String> {
        if inner.retiring.contains(&(parent.engine.clone(), parent.session_id.clone())) {
            return Err("Parent chat is being archived or deleted".into());
        }
        let parent_branch = inner.branches.values().find(|r| {
            r.branch.engine == parent.engine
                && r.branch.session_id.as_deref() == Some(&parent.session_id)
        });
        if parent_branch.is_some_and(|r| {
            fenced(&r.branch.state) || r.stopping
                || !same_workspace(&r.branch.workspace_path, &parent.workspace_path)
        }) {
            return Err("Parent chat is unavailable or belongs to another workspace".into());
        }
        let handoffs: Vec<_> = inner.branches.values().map(|record| {
            let branch = &record.branch;
            HandoffDeletionBranch {
                id: &branch.id,
                parent_engine: &branch.parent_engine,
                parent_session: &branch.parent_session_id,
                parent_workspace: branch.parent_workspace(),
                from: branch.handoff_from.as_ref().map(|link| link.branch_id.as_str()),
                to: branch.handoff_to.as_ref().map(|link| link.branch_id.as_str()),
            }
        }).collect();
        validate_handoff_deletion(&handoffs, ids)?;
        let members = self.subtree_members(inner, parent, ids, false)?;
        self.group_idle(inner, &members, ids).map_err(|_| {
            "The selected task subtree must be idle. Resolve active runs, pending questions, launches, bindings or retirement before deleting".to_string()
        })?;
        let conn = self.db.0.lock();
        archive::ensure_not_archived(&conn, &parent.engine, &parent.session_id)?;
        archive::session_meta(&conn, parent, parent_branch.map(|r| &r.branch))?;
        for id in ids {
            let branch = &inner.branches.get(id).ok_or("Subtree branch is missing")?.branch;
            archive::ensure_available(inner, &branch.engine, branch.session_id.as_deref().unwrap_or_default(), Some(id))?;
            if let Some(session) = &branch.session_id {
                archive::ensure_not_archived(&conn, &branch.engine, session)?;
                archive::session_meta(&conn, &identity(&branch.engine, session, &branch.workspace_path), Some(branch))?;
            }
        }
        Ok(members)
    }

    pub(super) async fn delete_branch_for_user(
        self: &Arc<Self>,
        parent: &LeaderIdentity,
        id: &str,
        expected_branch_ids: &[String],
    ) -> Result<LeaderSnapshot, String> {
        self.reclaim_owned(parent, id, None, Some(expected_branch_ids)).await?;
        Ok(self.snapshot_memory())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn branch<'a>(id: &'a str, from: Option<&'a str>, to: Option<&'a str>) -> HandoffDeletionBranch<'a> {
        HandoffDeletionBranch {
            id, from, to, parent_engine: "codex", parent_session: "parent",
            parent_workspace: "G:/workspace",
        }
    }

    fn check(branches: &[HandoffDeletionBranch<'_>], ids: &[&str]) -> Result<(), String> {
        validate_handoff_deletion(branches, &ids.iter().map(|id| (*id).to_owned()).collect::<Vec<_>>())
    }

    fn rejected(branches: &[HandoffDeletionBranch<'_>], ids: &[&str], reason: &str) {
        let error = check(branches, ids).unwrap_err();
        assert!(error.contains(reason), "{error}");
        assert!(error.contains("whole-group deletion"), "{error}");
    }

    #[test]
    fn handoff_deletion_requires_both_old_and_new_endpoints() {
        let branches = [branch("old", None, Some("new")), branch("new", Some("old"), None)];
        rejected(&branches, &["old"], "not fully included");
        rejected(&branches, &["new"], "not fully included");
        assert!(check(&branches, &["old", "new"]).is_ok());
    }

    #[test]
    fn handoff_deletion_requires_entire_multihop_chain() {
        let branches = [
            branch("old", None, Some("middle")),
            branch("middle", Some("old"), Some("new")),
            branch("new", Some("middle"), None),
        ];
        rejected(&branches, &["old", "middle"], "not fully included");
        rejected(&branches, &["middle", "new"], "not fully included");
        assert!(check(&branches, &["old", "middle", "new"]).is_ok());
    }

    #[test]
    fn handoff_deletion_rejects_missing_and_nonreciprocal_links() {
        rejected(&[branch("old", None, Some("missing"))], &["old"], "missing branch");
        rejected(&[branch("new", Some("missing"), None)], &["new"], "missing branch");
        let forward_only = [branch("old", None, Some("new")), branch("new", None, None)];
        rejected(&forward_only, &["new"], "reciprocal");
        rejected(&forward_only, &["old", "new"], "reciprocal");
        let backward_only = [branch("old", None, None), branch("new", Some("old"), None)];
        rejected(&backward_only, &["old"], "reciprocal");
        rejected(&backward_only, &["old", "new"], "reciprocal");
    }

    #[test]
    fn handoff_deletion_rejects_each_cross_parent_identity_component() {
        for component in ["engine", "session", "workspace"] {
            let mut successor = branch("new", Some("old"), None);
            match component {
                "engine" => successor.parent_engine = "claude",
                "session" => successor.parent_session = "other-parent",
                _ => successor.parent_workspace = "G:/other-workspace",
            }
            rejected(&[branch("old", None, Some("new")), successor], &["old", "new"], "parent ownership");
        }
    }

    #[test]
    fn handoff_deletion_rejects_reciprocal_cycles() {
        rejected(&[branch("self", Some("self"), Some("self"))], &["self"], "cycle");
        let branches = [
            branch("a", Some("c"), Some("b")),
            branch("b", Some("a"), Some("c")),
            branch("c", Some("b"), Some("a")),
        ];
        rejected(&branches, &["a", "b", "c"], "cycle");
    }

    #[test]
    fn handoff_deletion_leaves_unrelated_branches_outside_selection() {
        let branches = [branch("plain", None, None), branch("unrelated", None, Some("missing"))];
        assert!(check(&branches, &["plain"]).is_ok());
    }
}
