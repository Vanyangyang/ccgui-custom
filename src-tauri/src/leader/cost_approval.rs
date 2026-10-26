//! A held continuation belongs to the native task ledger. Only a local human
//! action can turn it into a launch; agent retries merely read its receipt.
use super::*;
use crate::history::prompt_cache::CacheWindow;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCostApproval {
    pub request_id: String,
    pub captured_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache: Option<CacheWindow>,
    pub model: Option<String>,
}

// Fixed safety allowance for starting the next request, not measured latency.
const CACHE_START_SAFETY_MARGIN_MS: i64 = 10_000;
const MIN_COST_APPROVAL_TOKENS: u64 = 50_000;

pub(super) struct SmallContextEvidence {
    source: (String, Option<String>),
}

// Only per-request/current-context counts can establish the small-context
// exemption. Session billing totals and missing/malformed counts cannot.
fn context_tokens(engine: &str, usage: &Value) -> Option<u64> {
    let counts = match engine {
        "claude" => usage,
        "codex" if usage["usage_scope"] == "last_request" => usage,
        "codex" => usage.get("info").unwrap_or(usage).get("last_token_usage")?,
        "cursor" if usage["context_usage_kind"] == "current_context" => {
            return usage["context_usage"]["used_tokens"].as_u64();
        }
        _ => return None,
    };
    let keys: &[&str] = if engine == "claude" {
        &[
            "input_tokens",
            "output_tokens",
            "cache_read_input_tokens",
            "cache_creation_input_tokens",
        ]
    } else {
        // Codex's cached input is already included in input_tokens.
        &["input_tokens", "output_tokens"]
    };
    // Output-only/error reports do not establish prompt occupancy.
    counts.get("input_tokens")?.as_u64()?;
    let mut total = 0u64;
    let mut reported = false;
    for key in keys {
        if let Some(value) = counts.get(*key) {
            total = total.checked_add(value.as_u64()?)?;
            reported = true;
        }
    }
    (reported && total > 0).then_some(total)
}

pub(super) fn requires_approval(cache: Option<&CacheWindow>, now: i64) -> bool {
    let Some(cache) = cache else {
        return true;
    };
    if cache.heat(now) != "hot" {
        return true;
    }
    // Use the earliest possible expiry, including advisory reference windows.
    let expires_at = cache
        .started_at
        .saturating_add(cache.ttl_seconds.saturating_mul(1000));
    expires_at.saturating_sub(now) <= CACHE_START_SAFETY_MARGIN_MS
}

fn held_response(request_id: &str, branch: &LeaderBranch) -> Result<Value, String> {
    Ok(json!({
        "requestId": request_id,
        "requestState": "awaiting_cost_approval",
        "status": "awaiting_cost_approval",
        "submitted_to_model": false,
        "mayHaveStarted": false,
        "branch": tool_branch(branch, MAX_TOOL_RESPONSE_BYTES - 8192)?,
        "next_action": "A human must approve or cancel in the chat's cost review card. Stop polling; do not resend with a new request_id."
    }))
}

impl LeaderManager {
    pub(super) fn small_context_source(
        &self,
        branch: &LeaderBranch,
    ) -> Result<Option<(String, Option<String>)>, String> {
        self.db
            .0
            .lock()
            .query_row(
                "SELECT s.file_path,m.model FROM sessions s LEFT JOIN session_models m
             ON m.engine=s.engine AND m.session_id=s.session_id
             WHERE s.engine=?1 AND s.session_id=?2 AND s.workspace_path=?3",
                params![branch.engine, branch.session_id, branch.workspace_path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())
    }

    pub(super) fn small_context_still_matches(
        &self,
        branch: &LeaderBranch,
        evidence: &SmallContextEvidence,
    ) -> Result<bool, String> {
        Ok(self.small_context_source(branch)?.as_ref() == Some(&evidence.source))
    }

    /// Read the same native occupancy/history sources used by the conversation
    /// gauge. Called off the async runtime and without the task-ledger lock.
    pub(super) fn read_small_context(
        &self,
        branch: &LeaderBranch,
    ) -> Result<Option<SmallContextEvidence>, String> {
        let (Some(session), Some(model)) = (branch.session_id.as_deref(), branch.model.as_deref())
        else {
            return Ok(None);
        };
        let Some(source) = self.small_context_source(branch)? else {
            return Ok(None);
        };
        let (path, saved_model) = &source;
        // Native background tasks need not have a picker preference recorded.
        // A known conflicting model is not evidence for this continuation.
        if model.trim().is_empty() || saved_model.as_deref().is_some_and(|saved| saved != model) {
            return Ok(None);
        }
        let used = if branch.engine == "agy" {
            // AGY's native estimate is current occupancy; last-prompt/billing
            // counters are not. Reuse compaction handling from the gauge.
            crate::history::agy::read_native_context(std::path::Path::new(&path))
                .filter(|context| context.max_tokens.is_some())
                .and_then(|context| context.estimated_tokens)
        } else {
            // Unreadable history is unknown, not a zero-token exemption.
            let page = crate::history::reader::load_session_page_blocking(
                &self.db,
                &branch.engine,
                session,
                Some(500),
                None,
            )
            .ok();
            // Do not walk past a newer unknown/malformed sample to grant an
            // exemption using older, smaller occupancy.
            page.and_then(|page| {
                page.messages
                    .iter()
                    .rev()
                    .find(|message| message.usage.is_some())
                    .filter(|message| {
                        message
                            .model
                            .as_deref()
                            .is_none_or(|source| source == model)
                    })
                    .and_then(|message| context_tokens(&branch.engine, message.usage.as_ref()?))
            })
        };
        Ok(used
            .filter(|used| *used < MIN_COST_APPROVAL_TOKENS)
            .map(|_| SmallContextEvidence { source }))
    }

    pub(super) fn send_cache(&self, branch: &LeaderBranch) -> Result<Option<CacheWindow>, String> {
        let cache =
            crate::history::prompt_cache::load_all(&self.db.0.lock()).map_err(|e| e.to_string())?;
        Ok(branch
            .session_id
            .as_ref()
            .and_then(|session| cache.get(&format!("{}:{session}", branch.engine)).cloned()))
    }

    pub(super) fn hold_send(
        &self,
        inner: &mut Inner,
        parent: &LeaderIdentity,
        permission: &str,
        args: &SendArgs,
        arguments: &Value,
        cache: Option<CacheWindow>,
    ) -> Result<Value, String> {
        let mut record = self.child(inner, parent, &args.branch_id)?.clone();
        let frozen = delegation::freeze_request(inner, &record.branch, &args.request_id)?;
        if record
            .branch
            .model
            .as_ref()
            .is_none_or(|model| model.trim().is_empty())
        {
            record.branch.model = crate::settings::read_settings()?
                .default_models
                .get(&record.branch.engine)
                .filter(|model| !model.trim().is_empty())
                .cloned();
        }
        record.permission = permission.into();
        record.branch.task = args.message.clone();
        // No new run exists while waiting. Clearing the previous identity also
        // fences delayed output and finish notifications from that old turn.
        record.branch.run_id = None;
        record.branch.state = "awaiting_cost_approval".into();
        record.branch.updated_at = (self.clock)();
        record.branch.result.clear();
        record.branch.result_truncated = false;
        record.branch.error = None;
        record.branch.cost_approval = Some(TaskCostApproval {
            request_id: args.request_id.clone(),
            captured_at: record.branch.updated_at,
            cache,
            model: record.branch.model.clone(),
        });
        delegation::begin(&mut record.branch, &args.request_id);
        record.output = Output::default();
        record.questions.clear();
        record.plans.clear();
        record.dirty = false;
        let response = held_response(&args.request_id, &record.branch)?;
        let request = Request {
            parent: parent.clone(),
            request_id: args.request_id.clone(),
            method: "task_send".into(),
            arguments: Value::Null,
            arguments_fingerprint: Some(arguments_fingerprint(arguments)?),
            branch_id: args.branch_id.clone(),
            state: "awaiting_cost_approval".into(),
            response: Some(response.clone()),
            error: None,
            projection: None,
            projection_invalid: false,
        };
        let mut conn = self.db.0.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        if let Some(request) = &frozen { write_request(&tx, request)?; }
        write_request(&tx, &request)?;
        write_branch(&tx, &record)?;
        tx.commit().map_err(|e| e.to_string())?;
        inner.branches.insert(args.branch_id.clone(), record);
        if let Some(request) = frozen {
            inner.requests.insert((key(&request.parent), request.request_id.clone()), request);
        }
        inner
            .requests
            .insert((key(parent), args.request_id.clone()), request);
        Ok(response)
    }

    pub(super) fn cancel_held_send(
        &self,
        inner: &mut Inner,
        parent: &LeaderIdentity,
        branch_id: &str,
    ) -> Result<LeaderBranch, String> {
        let mut record = self.child(inner, parent, branch_id)?.clone();
        let approval = record
            .branch
            .cost_approval
            .as_ref()
            .ok_or("Task cost approval is unavailable")?;
        let request_key = (key(parent), approval.request_id.clone());
        let mut request = inner
            .requests
            .get(&request_key)
            .cloned()
            .ok_or("Task cost approval request is missing")?;
        if request.branch_id != branch_id || request.state != "awaiting_cost_approval" {
            return Err("Task cost approval request does not match this branch".into());
        }
        record.branch.cost_approval = None;
        record.branch.state = "stopped".into();
        record.branch.updated_at = (self.clock)();
        record.branch.error = Some("Cancelled by the user before delivery".into());
        delegation::sync(&mut record.branch);
        record.dirty = false;
        request.state = "cancelled".into();
        request.error = record.branch.error.clone();
        request.response = Some(json!({
            "requestId": request.request_id, "requestState": "cancelled",
            "status": "failed", "submitted_to_model": false, "mayHaveStarted": false,
            "error": request.error,
            "branch": tool_branch(&record.branch, MAX_TOOL_RESPONSE_BYTES - 8192)?
        }));
        let mut conn = self.db.0.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        write_request(&tx, &request)?;
        write_branch(&tx, &record)?;
        tx.commit().map_err(|e| e.to_string())?;
        let branch = record.branch.clone();
        inner.branches.insert(branch_id.into(), record);
        inner.requests.insert(request_key, request);
        Ok(branch)
    }

    /// Returns a launch only for the first successful approve. The transition
    /// and its idempotency receipt commit together before any engine call.
    pub(super) fn resolve_cost_approval(
        &self,
        parent: &LeaderIdentity,
        branch_id: &str,
        request_id: &str,
        approve: bool,
        reviewed_model: Option<&str>,
    ) -> Result<Option<(LeaderBranch, String, String)>, String> {
        let mut inner = self.inner.lock();
        if inner.shutdown {
            return Err("Leader coordinator is shutting down".into());
        }
        if inner
            .retiring
            .contains(&(parent.engine.clone(), parent.session_id.clone()))
        {
            return Err("Parent chat is being archived or deleted".into());
        }
        let record = self.child(&inner, parent, branch_id)?;
        let request = inner
            .requests
            .get(&(key(parent), request_id.into()))
            .ok_or("Task cost approval request is missing")?;
        if request.method != "task_send" || request.branch_id != branch_id {
            return Err("Task cost approval request does not match this branch".into());
        }
        if request.state != "awaiting_cost_approval" {
            return Ok(None);
        }
        let approval = record
            .branch
            .cost_approval
            .as_ref()
            .ok_or("Task cost approval is unavailable")?;
        if approval.request_id != request_id || record.branch.state != "awaiting_cost_approval" {
            return Err("Task cost approval request does not match this branch".into());
        }
        if fenced(&record.branch.state) || record.stopping {
            return Err("Child is being stopped or reclaimed".into());
        }
        if !approve {
            self.cancel_held_send(&mut inner, parent, branch_id)?;
            drop(inner);
            self.emit();
            return Ok(None);
        }
        if reviewed_model != approval.model.as_deref() || record.branch.model != approval.model {
            return Err("Host chat target model changed before cost approval".into());
        }
        if approval.model.is_none() {
            let model = crate::settings::read_settings()?
                .default_models
                .get(&record.branch.engine)
                .filter(|model| !model.trim().is_empty())
                .cloned();
            if let Some(model) = model {
                let mut record = record.clone();
                let mut request = request.clone();
                record.branch.model = Some(model.clone());
                record
                    .branch
                    .cost_approval
                    .as_mut()
                    .expect("held approval checked")
                    .model = Some(model);
                record.branch.updated_at = (self.clock)();
                delegation::sync(&mut record.branch);
                request.response = Some(held_response(request_id, &record.branch)?);
                let mut conn = self.db.0.lock();
                let tx = conn.transaction().map_err(|e| e.to_string())?;
                write_request(&tx, &request)?;
                write_branch(&tx, &record)?;
                tx.commit().map_err(|e| e.to_string())?;
                inner.branches.insert(branch_id.into(), record);
                inner
                    .requests
                    .insert((key(parent), request_id.into()), request);
                drop(conn);
                drop(inner);
                self.emit();
                return Err("Host chat target model changed before cost approval".into());
            }
        }
        let session = record
            .branch
            .session_id
            .as_deref()
            .ok_or("Child has no native session identity")?;
        archive::ensure_available(&inner, &record.branch.engine, session, Some(branch_id))?;
        if inner
            .retiring
            .contains(&(record.branch.engine.clone(), session.into()))
            || self.active(&inner, &record.branch)
            || self.processes.get(session).is_some()
            || pending_claim(&inner, &record.branch.engine, session, "")
            || inner.runs.iter().any(|(id, run)| {
                run.engine == record.branch.engine
                    && run.session_id.as_deref() == Some(session)
                    && ((!run.retired && run.launch_pending) || self.processes.get(id).is_some())
            })
        {
            return Err(
                "Child is still running or being reclaimed; wait or stop it before sending".into(),
            );
        }
        let permission = record.permission.clone();
        let args = SendArgs {
            branch_id: branch_id.into(),
            request_id: request_id.into(),
            message: record.branch.task.clone(),
        };
        let arguments = encoded(&args)?;
        if request.arguments_fingerprint.as_deref()
            != Some(arguments_fingerprint(&arguments)?.as_str())
        {
            return Err("Held task message no longer matches the approved request".into());
        }
        let Reservation::Start((branch, run_id)) =
            self.start_send(&mut inner, parent, &permission, &args, arguments)?
        else {
            return Err("Task cost approval did not reserve a launch".into());
        };
        drop(inner);
        self.emit();
        Ok(Some((branch, run_id, permission)))
    }
}
