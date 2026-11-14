//! Resolve user-selected child chats for full-history session handoff compression.

use super::full_handoff::{self, SourceStamp, MAX_TEXT_BYTES};
use crate::db::Db;
use crate::leader::{same_workspace, LeaderArchivedGroup, LeaderBranch, LeaderIdentity, LeaderSnapshot};
use std::collections::{HashMap, HashSet};

const MAX_SELECTED_CHILD_BRANCHES: usize = 64;

#[derive(Debug)]
pub(super) struct VerifiedChildStamp {
    engine: String,
    session_id: String,
    stamp: SourceStamp,
}

fn same_identity(a: &LeaderIdentity, b: &LeaderIdentity) -> bool {
    a.engine == b.engine
        && a.session_id == b.session_id
        && same_workspace(&a.workspace_path, &b.workspace_path)
}

fn is_direct_child(branch: &LeaderBranch, parent: &LeaderIdentity) -> bool {
    branch.parent_engine == parent.engine
        && branch.parent_session_id == parent.session_id
        && same_workspace(branch.parent_workspace(), &parent.workspace_path)
}

fn resolve_source_identity(
    snapshot: &LeaderSnapshot,
    source_engine: &str,
    source_session_id: &str,
    source_workspace_path: Option<&str>,
) -> Result<LeaderIdentity, String> {
    if let Some(ws) = source_workspace_path.map(str::trim).filter(|s| !s.is_empty()) {
        return Ok(LeaderIdentity {
            engine: source_engine.to_owned(),
            session_id: source_session_id.to_owned(),
            workspace_path: ws.to_owned(),
        });
    }
    let mut candidates: Vec<&str> = Vec::new();
    for branch in &snapshot.branches {
        if branch.state == "reclaimed" {
            continue;
        }
        if branch.parent_engine == source_engine && branch.parent_session_id == source_session_id {
            let ws = branch.parent_workspace();
            if !candidates.iter().any(|existing| same_workspace(existing, ws)) {
                candidates.push(ws);
            }
        }
        if branch.engine == source_engine && branch.session_id.as_deref() == Some(source_session_id) {
            let ws = branch.workspace_path.as_str();
            if !candidates.iter().any(|existing| same_workspace(existing, ws)) {
                candidates.push(ws);
            }
        }
    }
    match candidates.as_slice() {
        [single] => Ok(LeaderIdentity {
            engine: source_engine.to_owned(),
            session_id: source_session_id.to_owned(),
            workspace_path: (*single).to_owned(),
        }),
        [] => Err("source session has no associated task group".into()),
        _ => Err("ambiguous source session workspace for child handoff selection".into()),
    }
}

fn group_root(snapshot: &LeaderSnapshot, start: &LeaderIdentity) -> LeaderIdentity {
    let mut current = start.clone();
    let mut visited: Vec<LeaderIdentity> = Vec::new();
    loop {
        if visited.iter().any(|item| same_identity(item, &current)) {
            return current;
        }
        visited.push(current.clone());
        let Some(branch) = snapshot.branches.iter().find(|b| {
            b.state != "reclaimed"
                && b.engine == current.engine
                && b.session_id.as_deref() == Some(current.session_id.as_str())
                && same_workspace(&b.workspace_path, &current.workspace_path)
        }) else {
            return current;
        };
        current = LeaderIdentity {
            engine: branch.parent_engine.clone(),
            session_id: branch.parent_session_id.clone(),
            workspace_path: branch.parent_workspace().to_owned(),
        };
    }
}

fn archived_group_branch_ids<'a>(
    snapshot: &'a LeaderSnapshot,
    group: &'a LeaderArchivedGroup,
) -> Vec<&'a str> {
    let mut ids: Vec<&'a str> = group.branch_ids.iter().map(String::as_str).collect();
    if let Some(top) = snapshot.branches.iter().find(|b| {
        b.state != "reclaimed"
            && b.session_id.is_some()
            && b.engine == group.root.engine
            && b.session_id.as_deref() == Some(group.root.session_id.as_str())
            && same_workspace(&b.workspace_path, &group.root.workspace_path)
    }) {
        if !ids.contains(&top.id.as_str()) {
            ids.push(top.id.as_str());
        }
    }
    ids
}

fn hidden_archived_ids<'a>(
    snapshot: &'a LeaderSnapshot,
    source: &LeaderIdentity,
) -> HashSet<&'a str> {
    let mut hidden = HashSet::new();
    for group in &snapshot.archived_groups {
        if same_identity(&group.root, source)
            || group.members.iter().any(|member| same_identity(member, source))
        {
            continue;
        }
        for id in archived_group_branch_ids(snapshot, group) {
            hidden.insert(id);
        }
    }
    hidden
}

fn allowed_group_branches<'a>(
    snapshot: &'a LeaderSnapshot,
    source: &LeaderIdentity,
) -> HashMap<&'a str, &'a LeaderBranch> {
    let hidden = hidden_archived_ids(snapshot, source);
    let root = group_root(snapshot, source);
    let mut parents = vec![root];
    let mut seen_ids = HashSet::new();
    let mut allowed = HashMap::new();
    let mut index = 0;
    while index < parents.len() {
        let parent = parents[index].clone();
        index += 1;
        for branch in &snapshot.branches {
            if branch.state == "reclaimed"
                || seen_ids.contains(branch.id.as_str())
                || !is_direct_child(branch, &parent)
            {
                continue;
            }
            seen_ids.insert(branch.id.as_str());
            if let Some(sid) = branch.session_id.as_deref() {
                parents.push(LeaderIdentity {
                    engine: branch.engine.clone(),
                    session_id: sid.to_owned(),
                    workspace_path: branch.workspace_path.clone(),
                });
            }
            if hidden.contains(branch.id.as_str()) {
                continue;
            }
            let is_self = branch.engine == source.engine
                && branch.session_id.as_deref() == Some(source.session_id.as_str())
                && same_workspace(&branch.workspace_path, &source.workspace_path);
            if !is_self {
                allowed.insert(branch.id.as_str(), branch);
            }
        }
    }
    allowed
}

fn normalize_branch_ids(raw_ids: &[String]) -> Result<Vec<&str>, String> {
    if raw_ids.len() > MAX_SELECTED_CHILD_BRANCHES {
        return Err(format!(
            "selected handoff child task count exceeds limit ({MAX_SELECTED_CHILD_BRANCHES})"
        ));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(raw_ids.len());
    for raw in raw_ids {
        let trimmed = raw.trim();
        if trimmed.is_empty() || trimmed.len() > 256 || trimmed.chars().any(char::is_control) {
            return Err("invalid handoff child branch identifier".into());
        }
        if seen.insert(trimmed) {
            out.push(trimmed);
        }
    }
    Ok(out)
}

fn format_branch_state(branch: &LeaderBranch) -> &'static str {
    match branch.state.as_str() {
        "completed" => "子任务报告完成（尚未验收）",
        "running" | "starting" => "运行中快照（过程内容）",
        "waiting" => "等待输入或审批",
        "awaiting_cost_approval" => "等待成本确认",
        "failed" => "失败",
        "stopped" => "已停止",
        "handed_off" => "已交接",
        "reclaiming" => "回收中",
        _ => "需要检查",
    }
}

fn format_fallback_section(index: usize, branch: &LeaderBranch) -> String {
    let ref_label = branch
        .session_id
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(|sid| format!("{}/{sid}", branch.engine))
        .unwrap_or_else(|| format!("branch:{}", branch.id));
    let title = if branch.title.trim().is_empty() {
        ref_label.as_str()
    } else {
        branch.title.trim()
    };
    let expired = if branch.expired { " | 已到检查期限" } else { "" };
    let mut section = format!(
        "### 所选子对话 {}：{}（{} | 状态：{}{} | 任务账本记录）\n",
        index + 1,
        title,
        ref_label,
        format_branch_state(branch),
        expired,
    );
    if !branch.task.trim().is_empty() {
        section.push_str("任务说明：\n");
        section.push_str(branch.task.trim());
        section.push('\n');
    }
    if let Some(error) = branch.error.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        section.push_str("任务错误：");
        section.push_str(error);
        section.push('\n');
    }
    if !branch.result.trim().is_empty() {
        section.push_str("任务报告：\n");
        section.push_str(branch.result.trim());
        section.push('\n');
    } else {
        section.push_str("无结果文本\n");
    }
    section
}

pub(super) fn resolve_selected_child_histories(
    db: &Db,
    snapshot: &LeaderSnapshot,
    source_engine: &str,
    source_session_id: &str,
    source_workspace_path: Option<&str>,
    selected_branch_ids: &[String],
    primary_text_bytes: usize,
) -> Result<(String, Vec<VerifiedChildStamp>), String> {
    let ordered_ids = normalize_branch_ids(selected_branch_ids)?;
    if ordered_ids.is_empty() {
        return Ok((String::new(), Vec::new()));
    }
    let source = resolve_source_identity(snapshot, source_engine, source_session_id, source_workspace_path)?;
    let allowed = allowed_group_branches(snapshot, &source);
    let mut chosen = Vec::with_capacity(ordered_ids.len());
    for id in ordered_ids {
        let Some(branch) = allowed.get(id).copied() else {
            return Err(format!(
                "selected handoff child task '{id}' does not belong to the source session group"
            ));
        };
        chosen.push(branch);
    }

    let mut sections = String::new();
    let mut stamps = Vec::new();
    for (idx, branch) in chosen.into_iter().enumerate() {
        if idx > 0 {
            sections.push_str("\n\n");
        }
        let section = match branch.session_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(child_sid) => match full_handoff::read_saved_history(db, &branch.engine, child_sid) {
                Ok((history_text, stamp)) => {
                    if !matches!(branch.state.as_str(), "starting" | "running") {
                        stamps.push(VerifiedChildStamp {
                            engine: branch.engine.clone(),
                            session_id: child_sid.to_owned(),
                            stamp,
                        });
                    }
                    let ref_label = format!("{}/{child_sid}", branch.engine);
                    let title = if branch.title.trim().is_empty() {
                        ref_label.as_str()
                    } else {
                        branch.title.trim()
                    };
                    let expired = if branch.expired { " | 已到检查期限" } else { "" };
                    let mut text = format!(
                        "### 所选子对话 {}：{}（{} | 状态：{}{}）\n",
                        idx + 1,
                        title,
                        ref_label,
                        format_branch_state(branch),
                        expired,
                    );
                    if let Some(error) = branch.error.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                        text.push_str("任务错误：");
                        text.push_str(error);
                        text.push('\n');
                    }
                    text.push_str(history_text.trim_end());
                    text.push('\n');
                    text
                }
                Err(err)
                    if err.contains("saved session not found")
                        || err.contains("saved visible history is empty") =>
                {
                    format_fallback_section(idx, branch)
                }
                Err(err)
                    if matches!(branch.state.as_str(), "starting" | "running")
                        && err.contains("kept changing") =>
                {
                    format_fallback_section(idx, branch)
                }
                Err(err) => return Err(err),
            },
            None => format_fallback_section(idx, branch),
        };
        sections.push_str(&section);
        let total = primary_text_bytes.saturating_add(sections.len());
        if total > MAX_TEXT_BYTES {
            return Err(format!("full handoff visible text exceeds 8 MiB ({total} bytes)"));
        }
    }

    Ok((sections, stamps))
}

pub(super) fn verify_selected_child_stamps(
    db: &Db,
    stamps: &[VerifiedChildStamp],
) -> Result<(), String> {
    for item in stamps {
        full_handoff::ensure_saved_history_unchanged(db, &item.engine, &item.session_id, &item.stamp)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_branch(id: &str, parent_sid: &str, sid: Option<&str>, ws: &str) -> LeaderBranch {
        LeaderBranch {
            id: id.into(),
            parent_engine: "claude".into(),
            parent_session_id: parent_sid.into(),
            parent_workspace_path: Some("G:/Root".into()),
            workspace_path: ws.into(),
            engine: "codex".into(),
            session_id: sid.map(str::to_owned),
            title: format!("Title {id}"),
            task: format!("Task for {id}"),
            images: Vec::new(),
            model: None,
            effort: None,
            provider_id: None,
            run_id: None,
            state: "completed".into(),
            created_at: 1,
            updated_at: 2,
            last_activity_at: 2,
            deadline_at: 0,
            expired: false,
            result: format!("Ledger report for {id}"),
            result_truncated: false,
            error: None,
            cost_approval: None,
            delegation: None,
            handoff_to: None,
            handoff_from: None,
        }
    }

    #[test]
    fn allows_descendants_and_same_group_siblings_but_rejects_foreign_or_self_branches() {
        let db = Db::open_in_memory().unwrap();
        let b1 = sample_branch("b1", "root-session", Some("child-1"), "G:/Root");
        let b2 = sample_branch("b2", "root-session", Some("child-2"), "G:/Sub");
        let mut foreign = sample_branch("foreign", "other-root", Some("other-child"), "G:/Other");
        foreign.parent_workspace_path = Some("G:/Other".into());
        let snapshot = LeaderSnapshot {
            leaders: Vec::new(),
            branches: vec![b1, b2, foreign],
            archived_groups: Vec::new(),
        };

        // From parent session: select only b2
        let (from_parent, stamps) = resolve_selected_child_histories(
            &db,
            &snapshot,
            "claude",
            "root-session",
            Some("g:\\Root"),
            &["b2".into()],
            100,
        )
        .unwrap();
        assert!(stamps.is_empty());
        assert!(from_parent.contains("Title b2"));
        assert!(from_parent.contains("Ledger report for b2"));
        assert!(!from_parent.contains("Title b1"));

        // From child-1 session: can select sibling b2, cannot select self b1 or foreign
        let (from_sibling, _) = resolve_selected_child_histories(
            &db,
            &snapshot,
            "codex",
            "child-1",
            Some("G:/Root"),
            &["b2".into()],
            100,
        )
        .unwrap();
        assert!(from_sibling.contains("Title b2"));

        let self_err = resolve_selected_child_histories(
            &db,
            &snapshot,
            "codex",
            "child-1",
            Some("G:/Root"),
            &["b1".into()],
            100,
        )
        .unwrap_err();
        assert!(self_err.contains("does not belong"));

        let foreign_err = resolve_selected_child_histories(
            &db,
            &snapshot,
            "claude",
            "root-session",
            Some("G:/Root"),
            &["foreign".into()],
            100,
        )
        .unwrap_err();
        assert!(foreign_err.contains("does not belong"));
    }

    #[test]
    fn reads_full_saved_history_for_selected_child_sessions_and_verifies_stamps() {
        let dir = std::env::temp_dir().join(format!("ccgui-handoff-child-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let child_file = dir.join("rollout-child-saved.jsonl");
        std::fs::write(
            &child_file,
            concat!(
                r#"{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"请检查 src/engine/router.rs"}]}}"#,
                "\n",
                r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"已在 src/engine/router.rs:42 定位路由分派逻辑并通过单元测试。"}]}}"#,
                "\n"
            ),
        )
        .unwrap();

        let db = Db::open_in_memory().unwrap();
        {
            let conn = db.0.lock();
            conn.execute(
                "INSERT INTO sessions (engine, session_id, workspace_path, file_path, file_size, file_mtime_ms, title, preview, created_at, updated_at, message_count)
                 VALUES ('codex', 'child-saved', 'G:/Root', ?1, 100, 1, 'Saved Child', '', 1, 2, 2)",
                rusqlite::params![child_file.to_string_lossy().to_string()],
            )
            .unwrap();
        }

        let b_saved = sample_branch("b-saved", "root-session", Some("child-saved"), "G:/Root");
        let b_no_file = sample_branch("b-fallback", "root-session", None, "G:/Root");
        let snapshot = LeaderSnapshot {
            leaders: Vec::new(),
            branches: vec![b_saved, b_no_file],
            archived_groups: Vec::new(),
        };

        let (resolved, stamps) = resolve_selected_child_histories(
            &db,
            &snapshot,
            "claude",
            "root-session",
            Some("G:/Root"),
            &["b-saved".into(), "b-fallback".into()],
            0,
        )
        .unwrap();

        assert_eq!(stamps.len(), 1);
        assert!(resolved.contains("src/engine/router.rs:42"));
        assert!(!resolved.contains("Ledger report for b-saved"));
        assert!(resolved.contains("Ledger report for b-fallback"));
        verify_selected_child_stamps(&db, &stamps).unwrap();

        // Mutating the saved child session invalidates stamp verification
        std::fs::write(&child_file, "{}\n").unwrap();
        assert!(verify_selected_child_stamps(&db, &stamps).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
