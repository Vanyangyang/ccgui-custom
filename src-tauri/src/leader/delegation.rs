//! The latest parent assignment is distinct from the child's current chat turn.
//! Native terminal evidence seals it until an explicit task_spawn/task_send.
use super::*;

const RESTART_UNKNOWN: &str = "DELEGATION_RESTART_UNKNOWN: Application restarted; the previous delegated run's outcome is unknown. Inspect before sending again.";
const LEGACY_UNKNOWN: &str = "DELEGATION_LEGACY_UNKNOWN: The original delegated run or its final result cannot be reliably recovered from this older task record. Inspect the chat history; later manual replies are not the delegated result.";

fn error_preview(error: &Option<String>) -> Option<String> {
    const MARKER: &str = "\n[truncated]";
    error.as_ref().map(|error| {
        if error.chars().count() <= MAX_INPUT_CHARS {
            return error.clone();
        }
        let mut preview: String = error
            .chars()
            .take(MAX_INPUT_CHARS - MARKER.chars().count())
            .collect();
        preview.push_str(MARKER);
        preview
    })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDelegation {
    pub request_id: String,
    pub run_id: Option<String>,
    pub task: String,
    pub state: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub result: String,
    pub result_truncated: bool,
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_approval: Option<TaskCostApproval>,
}

impl TaskDelegation {
    pub(super) fn new(request_id: &str, branch: &LeaderBranch, created_at: i64) -> Self {
        Self {
            request_id: request_id.into(),
            run_id: branch.run_id.clone(),
            task: branch.task.clone(),
            state: branch.state.clone(),
            created_at,
            updated_at: branch.updated_at,
            result: branch.result.clone(),
            result_truncated: branch.result_truncated,
            error: error_preview(&branch.error),
            cost_approval: branch.cost_approval.clone(),
        }
    }

    fn unknown(&mut self, now: i64, reason: &str) {
        self.state = "unknown".into();
        self.updated_at = self.updated_at.max(self.created_at).max(now);
        self.error = Some(reason.into());
        self.cost_approval = None;
    }
}

/// Call for every accepted native event, including deltas before checkpoint.
/// A manual continuation can share the base process id; terminality, rather
/// than run identity alone, is therefore the authoritative fence.
pub(super) fn sync(branch: &mut LeaderBranch) {
    let Some(delegation) = &mut branch.delegation else {
        return;
    };
    if terminal(&delegation.state) || delegation.run_id != branch.run_id {
        return;
    }
    delegation.state = branch.state.clone();
    delegation.updated_at = delegation.updated_at.max(branch.updated_at);
    delegation.result = branch.result.clone();
    delegation.result_truncated = branch.result_truncated;
    delegation.error = error_preview(&branch.error);
    delegation.cost_approval = branch.cost_approval.clone();
}

pub(super) fn begin(branch: &mut LeaderBranch, request_id: &str) {
    let previous = branch.delegation.as_ref();
    let same_request = previous.filter(|previous| previous.request_id == request_id);
    let updated_at = previous.map_or(branch.updated_at, |previous| {
        branch.updated_at.max(if same_request.is_some() {
            previous.updated_at
        } else {
            previous.updated_at.saturating_add(1)
        })
    });
    let created_at = same_request.map_or(updated_at, |previous| previous.created_at);
    let mut delegation = TaskDelegation::new(request_id, branch, created_at);
    delegation.updated_at = updated_at;
    branch.delegation = Some(delegation);
}

pub(super) fn transfer_pending(branch: &mut LeaderBranch, run_id: &str) {
    if let Some(delegation) = branch.delegation.as_mut().filter(|delegation| {
        !terminal(&delegation.state)
            && delegation.run_id == branch.run_id
            && matches!(
                delegation.state.as_str(),
                "starting" | "running" | "waiting"
            )
    }) {
        delegation.run_id = Some(run_id.into());
    }
}

pub(super) fn interrupted_turn(branch: &mut LeaderBranch, now: i64) {
    sync(branch);
    if let Some(d) = branch
        .delegation
        .as_mut()
        .filter(|d| !terminal(&d.state) && d.run_id == branch.run_id)
    {
        d.state = "stopped".into();
        d.updated_at = d.updated_at.max(now);
        d.error = Some("Original GUI turn was interrupted".into());
        d.cost_approval = None;
    }
}

pub(super) fn cold_restart(branch: &mut LeaderBranch, now: i64) {
    if let Some(delegation) = &mut branch.delegation {
        if matches!(
            delegation.state.as_str(),
            "starting" | "running" | "waiting" | "reclaiming"
        ) {
            delegation.unknown(now, RESTART_UNKNOWN);
        }
    }
}

pub(super) fn unknown_projection(
    branch: &LeaderBranch,
    request_id: Option<&str>,
    now: i64,
) -> TaskDelegation {
    let id = request_id
        .map(str::to_owned)
        .unwrap_or_else(|| format!("legacy-unknown:{}", branch.id));
    let mut d = TaskDelegation::new(&id, branch, branch.created_at);
    d.run_id = None;
    d.task.clear();
    d.result.clear();
    d.result_truncated = false;
    d.unknown(now, LEGACY_UNKNOWN);
    d
}

/// Preserve the previous assignment before replacing the branch's one latest
/// delegation. This is a reply cache only: it never authorizes another launch.
pub(super) fn freeze_request(
    inner: &Inner,
    branch: &LeaderBranch,
    next_request: &str,
) -> Result<Option<Request>, String> {
    let Some(delegation) = branch
        .delegation
        .as_ref()
        .filter(|d| d.request_id != next_request)
    else {
        return Ok(None);
    };
    let parent = identity(
        &branch.parent_engine,
        &branch.parent_session_id,
        branch.parent_workspace(),
    );
    let Some(mut request) = inner
        .requests
        .get(&(key(&parent), delegation.request_id.clone()))
        .cloned()
    else {
        return Ok(None);
    };
    if let Some(response) = &mut request.response {
        response["branch"] = tool_branch(branch, MAX_TOOL_RESPONSE_BYTES - 8192)?;
    }
    delegation_storage::attach(
        &mut request,
        delegation,
        delegation_storage::digest_for_branch(inner, branch)?,
    )?;
    Ok(Some(request))
}

pub(super) fn response_branch(request: &Request, branch: &LeaderBranch) -> Result<Value, String> {
    if request.projection_invalid {
        let mut view = branch.clone();
        view.delegation = Some(unknown_projection(
            branch,
            Some(&request.request_id),
            branch.updated_at,
        ));
        return tool_branch(&view, MAX_TOOL_RESPONSE_BYTES - 8192);
    }
    if branch
        .delegation
        .as_ref()
        .is_none_or(|d| d.request_id == request.request_id)
    {
        return tool_branch(branch, MAX_TOOL_RESPONSE_BYTES - 8192);
    }
    if let Some(metadata) = &request.projection {
        let mut view = branch.clone();
        view.delegation = Some(metadata.delegation.clone());
        return tool_branch(&view, MAX_TOOL_RESPONSE_BYTES - 8192);
    }
    if let Some(saved) = request
        .response
        .as_ref()
        .and_then(|response| response.get("branch"))
    {
        // This cache was bounded at capture time; run it through the same
        // preview limiter again for old persisted records.
        if let Ok(mut saved) = serde_json::from_value::<LeaderBranch>(saved.clone()) {
            if saved.id == request.branch_id
                && saved.parent_engine == request.parent.engine
                && saved.parent_session_id == request.parent.session_id
                && same_workspace(saved.parent_workspace(), &request.parent.workspace_path)
                && same_workspace(&saved.workspace_path, &branch.workspace_path)
            {
                if saved
                    .delegation
                    .as_ref()
                    .is_some_and(|d| d.request_id == request.request_id)
                {
                    return tool_branch(&saved, MAX_TOOL_RESPONSE_BYTES - 8192);
                }
                let legacy_terminal =
                    saved.delegation.is_none() && terminal(&saved.state) && !fenced(&saved.state);
                let mut delegation =
                    TaskDelegation::new(&request.request_id, &saved, saved.updated_at);
                if !legacy_terminal {
                    delegation.result.clear();
                    delegation.result_truncated = false;
                    delegation.unknown(branch.updated_at, LEGACY_UNKNOWN);
                }
                saved.delegation = Some(delegation);
                return tool_branch(&saved, MAX_TOOL_RESPONSE_BYTES - 8192);
            }
        }
    }
    // Legacy receipts without a final snapshot must not acquire another
    // request's result through replay. Keep current activity as context but
    // explicitly mark this request's delegated result as unknown.
    let mut view = branch.clone();
    let mut delegation = TaskDelegation::new(&request.request_id, branch, branch.created_at);
    delegation.run_id = None;
    delegation.task.clear();
    delegation.result.clear();
    delegation.result_truncated = false;
    delegation.unknown(branch.updated_at, LEGACY_UNKNOWN);
    view.delegation = Some(delegation);
    tool_branch(&view, MAX_TOOL_RESPONSE_BYTES - 8192)
}

/// Legacy ACK snapshots are the only durable evidence tied to a request.
/// Even an unchanged base run may have served later Claude -cN turns, so the
/// branch's latest terminal text alone cannot prove the original result.
pub(super) fn migrate(inner: &mut Inner, now: i64) {
    let requests = &inner.requests;
    for record in inner.branches.values_mut() {
        let branch = &mut record.branch;
        if branch.delegation.is_some() || branch.state == "reclaimed" {
            continue;
        }
        let parent = identity(
            &branch.parent_engine,
            &branch.parent_session_id,
            branch.parent_workspace(),
        );
        let matching: Vec<_> = requests
            .values()
            .filter(|request| {
                request.branch_id == branch.id
                    && key(&request.parent) == key(&parent)
                    && matches!(request.method.as_str(), "task_spawn" | "task_send")
                    && request.state != "reclaimed"
            })
            .collect();
        let held = branch.cost_approval.as_ref().and_then(|approval| {
            matching.iter().copied().find(|request| {
                request.request_id == approval.request_id
                    && request.state == "awaiting_cost_approval"
            })
        });
        if let Some(request) = held {
            branch.delegation = Some(TaskDelegation::new(
                &request.request_id,
                branch,
                branch.cost_approval.as_ref().unwrap().captured_at,
            ));
            record.dirty = true;
            continue;
        }
        let candidates: Vec<_> = matching
            .iter()
            .filter_map(|request| {
                let saved: LeaderBranch =
                    serde_json::from_value(request.response.as_ref()?.get("branch")?.clone())
                        .ok()?;
                (saved.id == branch.id
                    && saved.engine == branch.engine
                    && saved.parent_engine == branch.parent_engine
                    && saved.parent_session_id == branch.parent_session_id
                    && same_workspace(saved.parent_workspace(), branch.parent_workspace())
                    && same_workspace(&saved.workspace_path, &branch.workspace_path))
                .then_some((*request, saved))
            })
            .collect();
        // Missing ACKs have no dispatch ordering evidence. Do not choose a
        // different acknowledged request as if it were necessarily the latest.
        let latest = if matching.len() == 1 {
            matching
                .first()
                .copied()
                .map(|request| (request, candidates.first().map(|(_, saved)| saved)))
        } else if candidates.len() == matching.len() {
            candidates
                .iter()
                .map(|(_, saved)| saved.updated_at)
                .max()
                .and_then(|at| {
                    let mut newest = candidates
                        .iter()
                        .filter(|(_, saved)| saved.updated_at == at);
                    let first = newest.next()?;
                    newest.next().is_none().then_some((first.0, Some(&first.1)))
                })
        } else {
            None
        };
        let mut delegation = if let Some((request, Some(saved))) = latest {
            let proven = saved.delegation.as_ref().filter(|d| {
                d.request_id == request.request_id
                    && d.task == saved.task
                    && terminal(&d.state)
                    && !fenced(&d.state)
                    && validate_worker(saved).is_ok()
            });
            let mut restored = proven.cloned().unwrap_or_else(|| {
                TaskDelegation::new(&request.request_id, saved, saved.updated_at)
            });
            if proven.is_none() && (!terminal(&saved.state) || saved.delegation.is_some()) {
                restored.result.clear();
                restored.result_truncated = false;
                restored.unknown(now, LEGACY_UNKNOWN);
            }
            restored
        } else {
            let id = latest.map_or_else(
                || format!("legacy-unknown:{}", branch.id),
                |(request, _)| request.request_id.clone(),
            );
            let mut unknown = TaskDelegation::new(&id, branch, branch.created_at);
            unknown.run_id = None;
            unknown.result.clear();
            unknown.result_truncated = false;
            // A missing/ambiguous ACK also has no reliable assignment text.
            unknown.task.clear();
            unknown.unknown(now, LEGACY_UNKNOWN);
            unknown
        };
        // Reclaimed/fenced snapshots are not reusable task results.
        if fenced(&delegation.state) {
            delegation.unknown(now, LEGACY_UNKNOWN);
        }
        branch.delegation = Some(delegation);
        record.dirty = true;
    }
}

pub(super) fn validate_worker(branch: &LeaderBranch) -> Result<(), String> {
    let Some(d) = &branch.delegation else {
        return Ok(());
    };
    text_limit(&d.request_id, "worker delegation request_id", 180)?;
    if let Some(run) = &d.run_id {
        text_limit(run, "worker delegation run_id", 128)?;
    }
    if !matches!(
        d.state.as_str(),
        "starting" | "running" | "waiting" | "completed" | "failed" | "stopped" | "unknown"
    ) || d.task.chars().count() > MAX_INPUT_CHARS
        || d.result.chars().count() > MAX_RESULT_CHARS
        || d.error
            .as_ref()
            .is_some_and(|error| error.chars().count() > MAX_INPUT_CHARS)
        || d.created_at < 0
        || d.updated_at < d.created_at
        || d.cost_approval.is_some()
        || (!terminal(&d.state)
            && (d.run_id.is_none() || d.run_id != branch.run_id || d.task != branch.task))
    {
        return Err("Invalid managed worker delegation projection".into());
    }
    Ok(())
}

pub(super) fn restore_host_projection(
    inner: &Inner,
    current: &LeaderBranch,
    restored: &LeaderBranch,
    last_seq: &HashMap<String, u64>,
    settled_turns: &HashSet<String>,
) -> Option<TaskDelegation> {
    let mut d = current.delegation.clone()?;
    let uncertain_recovery = d.state == "unknown"
        && matches!(d.error.as_deref(), Some(RESTART_UNKNOWN | LEGACY_UNKNOWN));
    if terminal(&d.state) && !uncertain_recovery {
        return Some(d);
    }
    let Some(base) = restored.run_id.as_deref() else {
        return Some(d);
    };
    let parent = identity(
        &current.parent_engine,
        &current.parent_session_id,
        current.parent_workspace(),
    );
    let proven = inner
        .requests
        .get(&(key(&parent), d.request_id.clone()))
        .is_some_and(|request| delegation_storage::request_proves_run(request, current, base));
    // A V2 branch can combine the base reply with later manual -cN replies.
    // Such an aggregate cannot reconstruct the first assignment's final text.
    let only_base =
        last_seq.keys().all(|run| run == base) && settled_turns.iter().all(|run| run == base);
    let base_settled = settled_turns.contains(base);
    let state_proven = if terminal(&restored.state) {
        base_settled
    } else {
        !base_settled
    };
    if !proven || d.run_id.as_deref() != Some(base) || !only_base || !state_proven {
        if !terminal(&d.state) {
            d.unknown(restored.updated_at, LEGACY_UNKNOWN);
        }
        return Some(d);
    }
    d.state = restored.state.clone();
    d.updated_at = d.updated_at.max(restored.updated_at);
    d.task = restored.task.clone();
    d.result = restored.result.clone();
    d.result_truncated = restored.result_truncated;
    d.error = error_preview(&restored.error);
    d.cost_approval = None;
    Some(d)
}
