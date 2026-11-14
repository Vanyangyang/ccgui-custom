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
    /// Exact reviewed attachment identities, never filesystem paths.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub image_refs: Vec<String>,
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

fn handoff_pair(source: &LeaderBranch, successor: &LeaderBranch) -> bool {
    let (Some(to), Some(from)) = (&source.handoff_to, &successor.handoff_from) else { return false; };
    source.state == "handed_off" && to.branch_id == successor.id && from.branch_id == source.id
        && to.request_id == from.request_id && to.operation_id == from.operation_id
        && to.payload_fingerprint == from.payload_fingerprint
        && source.parent_engine == successor.parent_engine && source.parent_session_id == successor.parent_session_id
        && same_workspace(source.parent_workspace(), successor.parent_workspace())
        // A confirmed target selection may change engines. Ownership belongs to
        // the parent and the mutually bound durable links, not the child engine.
        && same_workspace(&source.workspace_path, &successor.workspace_path)
}

impl LeaderManager {
    /// Resolve public predecessor selectors without weakening direct-parent
    /// authorization. Both ends of every hop are durable and must agree.
    pub(super) fn resolve_child_id(&self, inner: &Inner, parent: &LeaderIdentity, id: &str) -> Result<String, String> {
        let mut current = id.to_string();
        let mut visited = HashSet::new();
        loop {
            if visited.len() >= MAX_DIRECT_BRANCHES {
                return Err("Task handoff chain exceeds the direct-child limit".into());
            }
            if !visited.insert(current.clone()) {
                return Err("Task handoff chain contains a cycle".into());
            }
            let branch = &self.child(inner, parent, &current)?.branch;
            if let Some(back) = &branch.handoff_from {
                let predecessor = &self.child(inner, parent, &back.branch_id)?.branch;
                if !handoff_pair(predecessor, branch) {
                    return Err("Task handoff relationship is inconsistent".into());
                }
            }
            let Some(link) = &branch.handoff_to else { return Ok(current); };
            let successor = &self.child(inner, parent, &link.branch_id)?.branch;
            if !handoff_pair(branch, successor) {
                return Err("Task handoff relationship is inconsistent".into());
            }
            current = successor.id.clone();
        }
    }

    pub(super) fn handoff_response(&self, inner: &Inner, request: &Request) -> Result<Value, String> {
        let actual = self.resolve_child_id(inner, &request.parent, &request.branch_id)?;
        let original = &self.child(inner, &request.parent, &request.branch_id)?.branch;
        let successor = &self.child(inner, &request.parent, &actual)?.branch;
        let mut chain = Vec::new();
        let mut current = original;
        while let Some(link) = &current.handoff_to {
            chain.push(link.clone());
            current = &inner.branches.get(&link.branch_id).ok_or("Missing handoff successor")?.branch;
        }
        Ok(json!({
            "requestId": request.request_id, "requestState": "handed_off", "status": "handed_off",
            "originalSubmittedToModel": false, "mayHaveStarted": true,
            "branch": tool_branch(original, MAX_TOOL_RESPONSE_BYTES / 3)?,
            "actualBranchId": actual, "handoffChain": chain,
            "successor": tool_branch(successor, MAX_TOOL_RESPONSE_BYTES / 3)?,
        }))
    }

    /// A live process can outlast its delegated reply. Check all identity and
    /// run reservations, not just the held branch's (deliberately empty) run id.
    fn handoff_idle(&self, inner: &Inner, record: &BranchRecord) -> Result<(), String> {
        let branch = &record.branch;
        let session = branch.session_id.as_deref().ok_or("Task handoff requires a known native session")?;
        archive::ensure_available(inner, &branch.engine, session, Some(&branch.id))?;
        if record.stopping || fenced(&branch.state) || self.active(inner, branch)
            || inner.retiring.contains(&(branch.engine.clone(), session.into()))
            || self.processes.get(session).is_some()
            || pending_claim(inner, &branch.engine, session, "")
            || inner.runs.iter().any(|(id, run)| {
                (run.branch_id.as_deref() == Some(&branch.id)
                    || run.engine == branch.engine && run.session_id.as_deref() == Some(session))
                    && ((!run.retired && run.launch_pending) || self.processes.get(id).is_some()
                        || inner.pending_bindings.contains_key(id))
            })
        {
            return Err("Task handoff requires the child and descendants to be fully idle".into());
        }
        Ok(())
    }

    /// One durable transition consumes the human-reviewed held assignment and
    /// reserves its fresh sibling. Returning None is a read-only operation retry.
    #[cfg(test)]
    pub(super) fn reserve_handoff(
        &self, parent: &LeaderIdentity, branch_id: &str, request_id: &str,
        source_session_id: &str, reviewed_model: Option<&str>, operation_id: &str, summary: &str,
    ) -> Result<Option<(LeaderBranch, String, String, String)>, String> {
        self.reserve_handoff_with_selection(parent, branch_id, request_id, source_session_id,
            reviewed_model, operation_id, summary, None)
    }

    pub(super) fn reserve_handoff_with_selection(
        &self, parent: &LeaderIdentity, branch_id: &str, request_id: &str,
        source_session_id: &str, reviewed_model: Option<&str>, operation_id: &str, summary: &str,
        target: Option<&crate::plugin_conversations::Selection>,
    ) -> Result<Option<(LeaderBranch, String, String, String)>, String> {
        if let Some(target) = target { crate::plugin_conversations::validate_selection(target)?; }
        text_limit(branch_id, "branch_id", 128)?;
        text_limit(request_id, "request_id", 128)?;
        text_limit(source_session_id, "source_session_id", 256)?;
        text_limit(operation_id, "operation_id", 128)?;
        if summary.trim().is_empty() || summary.contains('\0') || summary.encode_utf16().count() > 8_000 {
            return Err("Handoff summary must contain 1-8000 UTF-16 code units and no NUL".into());
        }
        let mut inner = self.inner.lock();
        if inner.shutdown || inner.retiring.contains(&(parent.engine.clone(), parent.session_id.clone())) {
            return Err("Task handoff is unavailable while the coordinator or parent is retiring".into());
        }
        let source = self.child(&inner, parent, branch_id)?.clone();
        let mut handoff_identity = json!([
            legacy_key(parent), branch_id, request_id, source_session_id, reviewed_model, operation_id, summary,
        ]);
        if !source.branch.images.is_empty() {
            handoff_identity.as_array_mut().expect("handoff identity").push(encoded(&source.branch.images)?);
        }
        // Omission preserves the legacy durable fingerprint exactly.
        if let Some(target) = target {
            handoff_identity.as_array_mut().expect("handoff identity").push(json!({ "targetSelection": target }));
        }
        let fingerprint = arguments_fingerprint(&handoff_identity)?;
        if let Some((_, existing)) = inner.branches.iter().find(|(_, record)| {
            record.branch.handoff_to.as_ref().is_some_and(|link| link.operation_id == operation_id)
        }) {
            let link = existing.branch.handoff_to.as_ref().expect("matched handoff");
            if existing.branch.id != branch_id || !belongs(&existing.branch, parent)
                || link.payload_fingerprint != fingerprint || link.request_id != request_id
            {
                return Err("Handoff operation_id was already used with different approval details".into());
            }
            self.resolve_child_id(&inner, parent, branch_id)?;
            let request = inner.requests.get(&(key(parent), request_id.into()))
                .ok_or("Handoff request receipt is missing")?;
            if request.state != "handed_off" || request.branch_id != branch_id {
                return Err("Handoff operation does not match its durable receipt".into());
            }
            return Ok(None);
        }
        if source.branch.handoff_to.is_some() {
            return Err("This child was already handed off by another operation".into());
        }
        // This also verifies any predecessor link when handing off a successor.
        if self.resolve_child_id(&inner, parent, branch_id)? != branch_id {
            return Err("Handoff must identify the currently held physical child".into());
        }
        let request_key = (key(parent), request_id.into());
        let mut held_request = inner.requests.get(&request_key).cloned()
            .ok_or("Task cost approval request is missing")?;
        let approval = source.branch.cost_approval.as_ref().ok_or("Task cost approval is unavailable")?;
        if held_request.method != "task_send" || held_request.branch_id != branch_id
            || held_request.state != "awaiting_cost_approval" || approval.request_id != request_id
            || source.branch.state != "awaiting_cost_approval"
            || source.branch.run_id.is_some()
            || source.branch.delegation.as_ref().is_none_or(|delegation| {
                delegation.request_id != request_id || delegation.state != "awaiting_cost_approval"
                    || delegation.run_id.is_some() || delegation.task != source.branch.task
                    || delegation.images != source.branch.images
            })
        {
            return Err("Task cost approval request does not match this child".into());
        }
        if source.branch.session_id.as_deref() != Some(source_session_id)
            || source.branch.model.as_deref() != reviewed_model || approval.model.as_deref() != reviewed_model
        {
            return Err("Task handoff source session or reviewed model changed".into());
        }
        if approval.image_refs != attachments::refs(&source.branch.images) {
            return Err("Task handoff reviewed images changed".into());
        }
        if approval.model.is_none() && crate::settings::read_settings()?.default_models
            .get(&source.branch.engine).is_some_and(|model| !model.trim().is_empty())
        {
            return Err("Host chat target model changed before task handoff".into());
        }
        let original_args = SendArgs {
            branch_id: held_request.requested_branch_id.clone().unwrap_or_else(|| branch_id.into()),
            request_id: request_id.into(), message: source.branch.task.clone(),
            images: source.branch.images.iter().map(|image| image.source.clone()).collect(),
        };
        if held_request.arguments_fingerprint.as_deref() != Some(arguments_fingerprint(&encoded(&original_args)?)?.as_str()) {
            return Err("Held task message no longer matches the approved request".into());
        }
        self.handoff_idle(&inner, &source)?;
        if let Some(target) = target {
            let engine = crate::engine::engine_by_id(&target.engine).ok_or("Unsupported handoff target engine")?;
            if !engine.supported_permissions().contains(&source.permission.as_str()) {
                return Err("Handoff target cannot honor the inherited permission mode".into());
            }
            if source.permission == "plan" && matches!(engine.plan_approval(), crate::engine::PlanApproval::Unavailable { .. }) {
                return Err("Handoff target cannot honor the inherited plan permission mode".into());
            }
            if !source.branch.images.is_empty() && !engine.supports_images() {
                return Err("Handoff target does not support the held images".into());
            }
        }
        // Validate the durable copies before consuming the held request. Never
        // reread the source files, which may have changed since review began.
        attachments::paths(&source.branch.images)?;
        let mut descendants = Vec::new();
        Self::subtree(&inner, branch_id, &mut HashSet::new(), &mut descendants)?;
        self.subtree_members(&inner, parent, &descendants, false)?;
        for id in descendants.iter().filter(|id| id.as_str() != branch_id) {
            let descendant = inner.branches.get(id).ok_or("Missing descendant")?;
            if !matches!(descendant.branch.state.as_str(), "completed" | "failed" | "stopped" | "handed_off")
                || descendant.branch.cost_approval.is_some()
                || descendant.branch.delegation.as_ref().is_some_and(|d| {
                    !matches!(d.state.as_str(), "completed" | "failed" | "stopped" | "handed_off")
                })
            {
                return Err("Task handoff requires all descendants to have a known settled outcome".into());
            }
            self.handoff_idle(&inner, descendant)?;
        }
        if inner.branches.values().filter(|r| belongs(&r.branch, parent) && r.branch.state != "reclaimed").count() >= MAX_DIRECT_BRANCHES {
            return Err("Task handoff would exceed the retained direct-child limit".into());
        }
        self.spawn_workspace(parent, Some(&source.branch.workspace_path))?;
        let task = format!("[Handoff summary]\n{summary}\n\n[Original pending assignment — preserve all requirements]\n{}", source.branch.task);
        text_limit(&task, "handoff task", MAX_INPUT_CHARS)?;
        let id = uuid::Uuid::new_v4().to_string();
        let run_id = uuid::Uuid::new_v4().to_string();
        let spawn_request_id = loop {
            let candidate = format!("handoff:{}", uuid::Uuid::new_v4());
            if !inner.requests.contains_key(&(key(parent), candidate.clone())) { break candidate; }
        };
        let now = (self.clock)();
        let mut successor = source.clone();
        if let Some(target) = target {
            successor.branch.engine = target.engine.clone();
            successor.branch.model = Some(target.model.clone());
            successor.branch.effort = target.effort.clone();
            successor.branch.provider_id = Some(target.provider_id.clone());
        }
        successor.branch.id = id.clone();
        successor.branch.session_id = None;
        successor.branch.run_id = Some(run_id.clone());
        successor.branch.task = task.clone();
        successor.branch.state = "starting".into();
        successor.branch.created_at = now;
        successor.branch.updated_at = now;
        successor.branch.last_activity_at = now;
        successor.branch.deadline_at = now + default_ttl(&successor.branch.engine) as i64 * 1000;
        successor.branch.expired = false;
        successor.branch.result.clear();
        successor.branch.result_truncated = false;
        successor.branch.error = None;
        successor.branch.cost_approval = None;
        successor.branch.delegation = None;
        successor.branch.handoff_to = None;
        successor.branch.handoff_from = Some(TaskHandoffLink {
            branch_id: branch_id.into(), request_id: request_id.into(), operation_id: operation_id.into(),
            payload_fingerprint: fingerprint.clone(),
        });
        successor.output = Output::default();
        successor.questions.clear();
        successor.plans.clear();
        successor.stopping = false;
        successor.dirty = false;
        delegation::begin(&mut successor.branch, &spawn_request_id);
        let spawn_args = SpawnArgs {
            workspace_path: Some(successor.branch.workspace_path.clone()), request_id: spawn_request_id.clone(),
            engine: successor.branch.engine.clone(), title: successor.branch.title.clone(), task,
            model: successor.branch.model.clone(), effort: successor.branch.effort.clone(), ttl_seconds: None,
            images: successor.branch.images.iter().map(|image| image.source.clone()).collect(),
        };
        let spawn_request = Request {
            parent: parent.clone(), request_id: spawn_request_id.clone(), method: "task_spawn".into(),
            arguments: Value::Null, arguments_fingerprint: Some(arguments_fingerprint(&encoded(&spawn_args)?)?),
            branch_id: id.clone(), requested_branch_id: None, state: "starting".into(), response: None,
            error: None, projection: None, projection_invalid: false,
        };
        let mut source = source;
        source.branch.handoff_to = Some(TaskHandoffLink {
            branch_id: id.clone(), request_id: request_id.into(), operation_id: operation_id.into(),
            payload_fingerprint: fingerprint,
        });
        source.branch.state = "handed_off".into();
        source.branch.cost_approval = None;
        source.branch.run_id = None;
        source.branch.updated_at = now;
        delegation::sync(&mut source.branch);
        source.dirty = false;
        held_request.state = "handed_off".into();
        held_request.error = None;
        held_request.response = Some(json!({
            "requestId": request_id, "requestState": "handed_off", "status": "handed_off",
            "originalSubmittedToModel": false, "mayHaveStarted": true,
            "actualBranchId": id, "branch": tool_branch(&source.branch, MAX_TOOL_RESPONSE_BYTES - 8192)?,
        }));
        let mut conn = self.db.0.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        write_request(&tx, &held_request)?;
        write_request(&tx, &spawn_request)?;
        write_branch(&tx, &source)?;
        write_branch(&tx, &successor)?;
        tx.commit().map_err(|e| e.to_string())?;
        let branch = successor.branch.clone();
        let permission = successor.permission.clone();
        inner.branches.insert(branch_id.into(), source);
        inner.branches.insert(id.clone(), successor);
        inner.requests.insert(request_key, held_request);
        inner.requests.insert((key(parent), spawn_request_id.clone()), spawn_request);
        inner.runs.insert(run_id.clone(), Run {
            engine: branch.engine.clone(), session_id: None, workspace_path: branch.workspace_path.clone(),
            permission: permission.clone(), branch_id: Some(id), leader_eligible: true,
            root_on_start: false, root_identity_bound: false, root_saved_baseline: None,
            root_foreign_claims: None, isolated_resume_session: None, launch_pending: true, retired: false,
            last_seq: HashMap::new(), settled_turns: HashSet::new(),
        });
        drop(conn);
        drop(inner);
        self.emit();
        Ok(Some((branch, run_id, spawn_request_id, permission)))
    }

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
        images: Vec<TaskImage>,
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
        record.branch.images = images;
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
            image_refs: attachments::refs(&record.branch.images),
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
            requested_branch_id: arguments.get("branch_id").and_then(Value::as_str)
                .filter(|id| *id != args.branch_id).map(str::to_owned),
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
        if request.state == "handed_off" {
            return Err("This cost approval was already handed off to a new child".into());
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
        if approval.image_refs != attachments::refs(&record.branch.images)
            || record.branch.delegation.as_ref().is_none_or(|delegation|
                delegation.task != record.branch.task || delegation.images != record.branch.images)
        {
            return Err("Host task images changed before cost approval".into());
        }
        attachments::paths(&record.branch.images)?;
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
            images: record.branch.images.iter().map(|image| image.source.clone()).collect(),
        };
        let arguments = encoded(&SendArgs {
            branch_id: request.requested_branch_id.clone().unwrap_or_else(|| branch_id.into()),
            ..args.clone()
        })?;
        if request.arguments_fingerprint.as_deref()
            != Some(arguments_fingerprint(&arguments)?.as_str())
        {
            return Err("Held task message no longer matches the approved request".into());
        }
        let images = record.branch.images.clone();
        let Reservation::Start((branch, run_id)) =
            self.start_send(&mut inner, parent, &permission, &args, arguments, images)?
        else {
            return Err("Task cost approval did not reserve a launch".into());
        };
        drop(inner);
        self.emit();
        Ok(Some((branch, run_id, permission)))
    }
}
