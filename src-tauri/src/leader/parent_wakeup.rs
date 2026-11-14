//! A completion notice is committed with the result, never inferred from GUI
//! snapshots. Claim-before-send makes a lost native ACK non-replayable.
use super::*;

const NAMESPACE: &str = "$ccgui-task-parent-wakeup";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParentWakeup {
    pub id: String,
    pub branch_id: String,
    pub parent: LeaderIdentity,
    pub request_id: String,
    pub child_run_id: String,
    pub state: String,
    /// Unique send-attempt reservation; a persistent CLI can use another native run id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
}

fn notice_id(
    branch: &str,
    parent: &LeaderIdentity,
    request: &str,
    run: &str,
) -> Result<String, String> {
    arguments_fingerprint(&json!([branch, legacy_key(parent), request, run]))
}

fn save(conn: &rusqlite::Connection, notice: &ParentWakeup) -> Result<(), String> {
    conn.execute(
        "INSERT INTO plugin_kv(plugin_id,key,value) VALUES(?1,?2,?3)
        ON CONFLICT(plugin_id,key) DO UPDATE SET value=excluded.value",
        params![
            NAMESPACE,
            notice.branch_id,
            serde_json::to_string(notice).map_err(|e| e.to_string())?
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn load(conn: &rusqlite::Connection) -> Result<Vec<ParentWakeup>, String> {
    let mut statement = conn
        .prepare("SELECT key,value FROM plugin_kv WHERE plugin_id=?1")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([NAMESPACE], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        let (branch, raw) = row.map_err(|e| e.to_string())?;
        let notice: ParentWakeup =
            serde_json::from_str(&raw).map_err(|_| "Invalid task completion outbox".to_string())?;
        if branch != notice.branch_id
            || notice.id
                != notice_id(
                    &notice.branch_id,
                    &notice.parent,
                    &notice.request_id,
                    &notice.child_run_id,
                )?
            || !matches!(
                notice.state.as_str(),
                "pending" | "starting" | "delivered" | "consumed" | "unknown" | "cancelled"
            )
        {
            return Err("Task completion outbox identity is invalid".into());
        }
        Ok(notice)
    })
    .collect()
}

/// Before replacing the delegation projection, prove a genuine completion
/// transition. Merely hydrating/saving an old completed task creates no notice.
pub(super) fn persist(conn: &rusqlite::Connection, branch: &LeaderBranch) -> Result<(), String> {
    let Some(delegation) = &branch.delegation else {
        return Ok(());
    };
    if delegation.state != "completed" {
        return Ok(());
    }
    let Some(run) = delegation.run_id.as_deref() else {
        return Ok(());
    };
    let mut requests = delegation_storage::branch_requests(conn, branch)?
        .into_iter()
        .filter(|request| request.request_id == delegation.request_id);
    let Some(request) = requests.next() else {
        return Ok(());
    };
    if requests.next().is_some() {
        return Err("Ambiguous task completion request identity".into());
    }
    let Some(previous) = request.projection.as_ref().map(|p| &p.delegation) else {
        return Ok(());
    };
    if request.branch_id != branch.id
        || previous.request_id != delegation.request_id
        || previous.run_id.as_deref() != Some(run)
        || terminal(&previous.state)
    {
        return Ok(());
    }
    let parent = identity(
        &branch.parent_engine,
        &branch.parent_session_id,
        branch.parent_workspace(),
    );
    let notice = ParentWakeup {
        id: notice_id(&branch.id, &parent, &delegation.request_id, run)?,
        branch_id: branch.id.clone(),
        parent,
        request_id: delegation.request_id.clone(),
        child_run_id: run.into(),
        state: "pending".into(),
        run_id: None,
    };
    save(conn, &notice)
}

pub(super) fn recover(conn: &rusqlite::Connection) -> Result<(), String> {
    for mut notice in load(conn)? {
        if notice.state == "starting" {
            notice.state = "unknown".into();
            save(conn, &notice)?;
        }
    }
    Ok(())
}

/// A held parent retains the notice; a replaced/retired identity cannot own it.
fn disposition(inner: &Inner, notice: &ParentWakeup) -> &'static str {
    let Some(record) = inner.branches.get(&notice.branch_id) else {
        return "cancelled";
    };
    let branch = &record.branch;
    let same = belongs(branch, &notice.parent)
        && branch.delegation.as_ref().is_some_and(|d| {
            d.request_id == notice.request_id
                && d.run_id.as_deref() == Some(notice.child_run_id.as_str())
                && d.state == "completed"
        });
    if !same
        || fenced(&branch.state)
        || record.stopping
        || branch.handoff_to.is_some()
        || archive::ensure_available(
            inner,
            &branch.engine,
            branch.session_id.as_deref().unwrap_or(""),
            Some(&branch.id),
        )
        .is_err()
        || archive::ensure_available(
            inner,
            &notice.parent.engine,
            &notice.parent.session_id,
            None,
        )
        .is_err()
        || inner.retiring.contains(&(
            notice.parent.engine.clone(),
            notice.parent.session_id.clone(),
        ))
    {
        return "cancelled";
    }
    for parent in inner.branches.values().filter(|r| {
        r.branch.engine == notice.parent.engine
            && r.branch.session_id.as_deref() == Some(notice.parent.session_id.as_str())
            && same_workspace(&r.branch.workspace_path, &notice.parent.workspace_path)
    }) {
        if parent.stopping
            || parent.branch.handoff_to.is_some()
            || matches!(
                parent.branch.state.as_str(),
                "stopped" | "failed" | "unknown" | "reclaiming" | "reclaimed" | "handed_off"
            )
        {
            return "cancelled";
        }
        if matches!(
            parent.branch.state.as_str(),
            "waiting" | "awaiting_cost_approval"
        ) {
            return "held";
        }
    }
    if inner.shutdown {
        "held"
    } else {
        "ready"
    }
}

impl LeaderManager {
    pub(super) fn parent_wakeups(&self) -> Result<Vec<ParentWakeup>, String> {
        self.checkpoint()?;
        let inner = self.inner.lock();
        let mut conn = self.db.0.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        for mut notice in load(&tx)? {
            // Keep at most one slot per retained branch, including after the
            // user permanently deletes a task group or an individual branch.
            if inner
                .branches
                .get(&notice.branch_id)
                .is_none_or(|record| record.branch.state == "reclaimed")
            {
                tx.execute(
                    "DELETE FROM plugin_kv WHERE plugin_id=?1 AND key=?2",
                    params![NAMESPACE, notice.branch_id],
                )
                .map_err(|e| e.to_string())?;
                continue;
            }
            if notice.state == "pending" && disposition(&inner, &notice) == "cancelled" {
                notice.state = "cancelled".into();
                save(&tx, &notice)?;
            }
            if matches!(notice.state.as_str(), "pending" | "starting" | "unknown") {
                result.push(notice);
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(result)
    }

    pub(super) fn claim_parent_wakeup(&self, id: &str, run_id: &str) -> Result<bool, String> {
        text_limit(id, "id", 128)?;
        text_limit(run_id, "run_id", 128)?;
        let inner = self.inner.lock();
        let mut conn = self.db.0.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let Some(mut notice) = load(&tx)?.into_iter().find(|n| n.id == id) else {
            return Ok(false);
        };
        if disposition(&inner, &notice) != "ready" {
            return Ok(false);
        }
        if notice.state == "starting" {
            return Ok(notice.run_id.as_deref() == Some(run_id));
        }
        if notice.state != "pending" {
            return Ok(false);
        }
        notice.state = "starting".into();
        notice.run_id = Some(run_id.into());
        save(&tx, &notice)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(true)
    }

    pub(super) fn resolve_parent_wakeup(
        &self,
        id: &str,
        run_id: &str,
        outcome: &str,
    ) -> Result<bool, String> {
        text_limit(id, "id", 128)?;
        text_limit(run_id, "run_id", 128)?;
        if !matches!(outcome, "delivered" | "retry" | "unknown" | "cancelled") {
            return Err("Invalid parent continuation outcome".into());
        }
        let inner = self.inner.lock();
        let mut conn = self.db.0.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let Some(mut notice) = load(&tx)?.into_iter().find(|n| n.id == id) else {
            return Ok(false);
        };
        if notice.state == "pending" && outcome == "cancelled" {
            notice.state = "cancelled".into();
        } else {
            if notice.run_id.as_deref() != Some(run_id) {
                return Ok(false);
            }
            if notice.state == outcome {
                return Ok(true);
            }
            if notice.state != "starting" {
                return Ok(false);
            }
            notice.state = if outcome == "retry" {
                if disposition(&inner, &notice) == "cancelled" {
                    "cancelled"
                } else {
                    "pending"
                }
            } else {
                outcome
            }
            .into();
            if notice.state == "pending" {
                notice.run_id = None;
            }
        }
        save(&tx, &notice)?;
        tx.commit().map_err(|e| e.to_string())?;
        drop(conn);
        drop(inner);
        self.emit();
        Ok(true)
    }

    pub(super) fn consume_parent_wakeups(
        &self,
        parent: &LeaderIdentity,
        views: &[Value],
    ) -> Result<(), String> {
        let inner = self.inner.lock();
        let mut conn = self.db.0.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for mut notice in load(&tx)? {
            if notice.state != "pending"
                || key(&notice.parent) != key(parent)
                || disposition(&inner, &notice) != "ready"
            {
                continue;
            }
            if views.iter().any(|view| {
                let id = view
                    .get("actualBranchId")
                    .or_else(|| view.get("id"))
                    .and_then(Value::as_str);
                id == Some(notice.branch_id.as_str())
                    && view["delegation"]["requestId"] == notice.request_id
                    && view["delegation"]["state"] == "completed"
                    && view["delegation"]["runId"] == notice.child_run_id
                    && view["delegation"]["resultPreview"] != true
            }) {
                notice.state = "consumed".into();
                save(&tx, &notice)?;
            }
        }
        tx.commit().map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn task_parent_wakeups(
    window: tauri::WebviewWindow,
) -> Result<Vec<ParentWakeup>, String> {
    require_main(&window)?;
    let _action = crate::worker_host::task_action_guard().await?;
    manager()?.parent_wakeups()
}

#[tauri::command]
pub async fn task_claim_parent_wakeup(
    window: tauri::WebviewWindow,
    id: String,
    run_id: String,
) -> Result<bool, String> {
    require_main(&window)?;
    let _action = crate::worker_host::task_action_guard().await?;
    manager()?.claim_parent_wakeup(&id, &run_id)
}

#[tauri::command]
pub async fn task_resolve_parent_wakeup(
    window: tauri::WebviewWindow,
    id: String,
    run_id: String,
    outcome: String,
) -> Result<bool, String> {
    require_main(&window)?;
    let _action = crate::worker_host::task_action_guard().await?;
    manager()?.resolve_parent_wakeup(&id, &run_id, &outcome)
}
