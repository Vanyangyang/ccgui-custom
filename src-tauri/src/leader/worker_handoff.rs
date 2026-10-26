//! Trusted worker checkpoints carry a consistent Leader projection. The
//! durable branch ledger alone is deliberately insufficient to revive a run.
use super::*;

const MAX_CHECKPOINT_TURNS: usize = 4096;
const MAX_CHECKPOINT_APPROVALS: usize = 4096;
const MAX_CHECKPOINT_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ManagedWorkerRegistration {
    branch: LeaderBranch,
    output: Output,
    questions: HashSet<String>,
    plans: HashSet<String>,
    stopping: bool,
    launch_pending: bool,
    last_seq: HashMap<String, u64>,
    settled_turns: HashSet<String>,
}

impl ManagedWorkerRegistration {
    pub(super) fn branch_id(&self) -> &str {
        &self.branch.id
    }

    fn validate(&self, saved: &WorkerTaskRegistration) -> Result<(), String> {
        let branch = &self.branch;
        if branch.delegation.is_some() {
            return Err("Worker task capsules cannot supply a host delegation projection".into());
        }
        supported(&branch.parent_engine)?;
        text_limit(&branch.id, "worker branch_id", 128)?;
        text_limit(&branch.parent_session_id, "worker parent session_id", 256)?;
        text_limit(&branch.title, "worker branch title", 256)?;
        text_limit(&branch.task, "worker branch task", MAX_INPUT_CHARS)?;
        if branch.run_id.as_deref() != Some(&saved.run_id)
            || branch.engine != saved.engine
            || branch.session_id != saved.session_id
            || !same_workspace(&branch.workspace_path, &saved.workspace_path)
            || saved.root_on_start
            || saved.root_identity_bound
            || saved.root_saved_baseline.is_some()
            || saved.root_foreign_claims.is_some()
            || saved.verified_new_root
            || branch.cost_approval.is_some()
            || !matches!(
                branch.state.as_str(),
                "starting" | "running" | "waiting" | "completed" | "failed" | "stopped" | "unknown"
            )
        {
            return Err("Invalid managed worker task registration".into());
        }
        for value in [&branch.model, &branch.effort] {
            if let Some(value) = value {
                text_limit(value, "worker branch setting", 256)?;
            }
        }
        if branch.result.chars().count() > MAX_RESULT_CHARS
            || branch
                .error
                .as_ref()
                .is_some_and(|error| error.chars().count() > MAX_INPUT_CHARS)
            || self
                .output
                .stream_start
                .is_some_and(|start| !branch.result.is_char_boundary(start))
            || self
                .output
                .active_tool
                .as_ref()
                .is_some_and(|tool| tool.chars().count() > 64)
            || self.questions.len() > MAX_CHECKPOINT_APPROVALS
            || self.plans.len() > MAX_CHECKPOINT_APPROVALS
            || self.last_seq.len() > MAX_CHECKPOINT_TURNS
            || self.settled_turns.len() > MAX_CHECKPOINT_TURNS
            || self
                .questions
                .iter()
                .chain(&self.plans)
                .any(|id| id.is_empty() || id.len() > 4096)
            || self
                .last_seq
                .keys()
                .chain(&self.settled_turns)
                .any(|id| id.len() > 256 || !worker_turn(&saved.run_id, id))
            || serde_json::to_vec(self)
                .map_err(|error| error.to_string())?
                .len()
                > MAX_CHECKPOINT_BYTES
        {
            return Err("Invalid or oversized managed worker projection".into());
        }
        Ok(())
    }
}

fn worker_turn(base: &str, turn: &str) -> bool {
    turn == base
        || turn
            .strip_prefix(base)
            .and_then(|tail| tail.strip_prefix("-c"))
            .is_some_and(|suffix| {
                !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
            })
}

pub(super) fn validate_host_worker_session(
    db: &Db,
    engine: &str,
    session_id: Option<&str>,
) -> Result<(), String> {
    if !matches!(engine, "claude" | "codex" | "agy" | "cursor") {
        return Ok(());
    }
    let conn = db.0.lock();
    for sql in [
        "SELECT engine,session_id,workspace_path,enabled FROM leader_roles LIMIT 0",
        "SELECT id,parent_engine,parent_session_id,workspace_path,engine,session_id,state,record_json,permission FROM leader_branches LIMIT 0",
        "SELECT engine,session_id,workspace_path,root_engine,root_session_id,root_workspace_path FROM leader_archived_members LIMIT 0",
    ] {
        conn.prepare(sql).map_err(|_| "Detached worker requires the host's initialized compatible Leader schema".to_string())?;
    }
    if let Some(session) = session_id {
        archive::ensure_not_archived(&conn, engine, session)?;
    }
    Ok(())
}

pub(super) fn detached_worker_presentation(
    db: &Db,
    run_id: &str,
    engine: &str,
    session_id: Option<&str>,
    workspace_path: &str,
    managed_branch_id: Option<&str>,
) -> Result<Option<Value>, String> {
    let Some(branch_id) = managed_branch_id else {
        return validate_worker_session(db, engine, session_id).map(|_| None);
    };
    supported(engine)?;
    text_limit(run_id, "worker run_id", 128)?;
    text_limit(branch_id, "worker branch_id", 128)?;
    validate_host_worker_session(db, engine, session_id)?;
    let conn = db.0.lock();
    let row: Option<(String, String, String, String, String, Option<String>, String)> = conn.query_row(
        "SELECT record_json,parent_engine,parent_session_id,workspace_path,engine,session_id,state FROM leader_branches WHERE id=?1",
        [branch_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
    ).optional().map_err(|error| error.to_string())?;
    let (raw, parent_engine, parent_session, workspace, stored_engine, stored_session, state) =
        row.ok_or("Managed worker branch is missing")?;
    let branch: LeaderBranch = serde_json::from_str(&raw)
        .map_err(|error| format!("Invalid managed worker branch: {error}"))?;
    if branch.id != branch_id
        || branch.run_id.as_deref() != Some(run_id)
        || branch.engine != engine
        || stored_engine != engine
        || branch.session_id.as_deref() != session_id
        || stored_session != branch.session_id
        || !same_workspace(&branch.workspace_path, workspace_path)
        || !same_workspace(&workspace, workspace_path)
        || branch.parent_engine != parent_engine
        || branch.parent_session_id != parent_session
        || branch.state != state
        || !matches!(state.as_str(), "starting" | "running" | "waiting")
        || branch.cost_approval.is_some()
    {
        return Err("Managed worker launch does not match its trusted branch reservation".into());
    }
    archive::ensure_not_archived(&conn, &parent_engine, &parent_session)?;
    let archived: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM leader_archived_groups WHERE EXISTS(SELECT 1 FROM json_each(record_json, '$.branchIds') WHERE value=?1))",
        [branch_id], |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    if archived {
        return Err("Managed worker branch belongs to an archived task group".into());
    }
    Ok(Some(json!({
        "branchId": branch.id,
        "workspacePath": branch.workspace_path,
        "title": branch.title,
        "assignment": branch.task,
    })))
}

impl LeaderManager {
    pub(super) fn managed_worker_is_starting(&self, run_id: &str) -> bool {
        let inner = self.inner.lock();
        let Some(run) = inner.runs.get(run_id) else {
            return false;
        };
        let Some(branch_id) = &run.branch_id else {
            return false;
        };
        run.session_id.is_none()
            || inner
                .branches
                .get(branch_id)
                .is_none_or(|record| record.branch.session_id.is_none())
            || run.launch_pending
            || inner.pending_bindings.contains_key(run_id)
    }

    // Existing coordinator unit fixtures use the optional view. Production
    // checkpoint callers must receive errors, especially mid-binding states.
    #[cfg(test)]
    pub(super) fn capture_worker_registration(
        &self,
        run_id: &str,
    ) -> Option<WorkerTaskRegistration> {
        self.try_capture_worker_registration(run_id).ok().flatten()
    }

    pub(super) fn try_capture_worker_registration(
        &self,
        run_id: &str,
    ) -> Result<Option<WorkerTaskRegistration>, String> {
        let inner = self.inner.lock();
        let Some(run) = inner.runs.get(run_id) else {
            return Ok(None);
        };
        if run.retired || !run.leader_eligible {
            return Ok(None);
        }
        if inner.shutdown {
            return Err("Task coordinator is shutting down; checkpoint refused".into());
        }
        if inner.pending_bindings.contains_key(run_id) {
            return Err(
                "Worker native identity binding has not committed; checkpoint refused".into(),
            );
        }
        let entry = self.processes.get(run_id);
        if entry
            .as_ref()
            .is_none_or(|entry| entry.killed.load(std::sync::atomic::Ordering::SeqCst))
        {
            if run.branch_id.is_some() {
                return Err(
                    "Managed worker has no active routing proxy; checkpoint refused".into(),
                );
            }
            return Ok(None);
        }
        let managed = if let Some(branch_id) = &run.branch_id {
            let record = inner
                .branches
                .get(branch_id)
                .ok_or("Managed worker branch is missing")?;
            if record.branch.run_id.as_deref() != Some(run_id)
                || record.permission != run.permission
                || run.isolated_resume_session.is_some()
            {
                return Err("Managed worker projection no longer owns its branch".into());
            }
            let mut branch = record.branch.clone();
            branch.delegation = None;
            Some(ManagedWorkerRegistration {
                branch,
                output: record.output.clone(),
                questions: record.questions.clone(),
                plans: record.plans.clone(),
                stopping: record.stopping,
                launch_pending: run.launch_pending,
                last_seq: run.last_seq.clone(),
                settled_turns: run.settled_turns.clone(),
            })
        } else {
            None
        };
        let saved = WorkerTaskRegistration {
            run_id: run_id.into(),
            engine: run.engine.clone(),
            session_id: run.session_id.clone(),
            workspace_path: run.workspace_path.clone(),
            permission: run.permission.clone(),
            root_on_start: run.root_on_start,
            root_identity_bound: run.root_identity_bound,
            root_saved_baseline: run.root_saved_baseline.as_deref().cloned(),
            root_foreign_claims: run.root_foreign_claims.clone(),
            verified_new_root: run.branch_id.is_none()
                && run.session_id.as_deref().is_some_and(|session| {
                    inner.verified_new_roots.contains_key(&key(&identity(
                        &run.engine,
                        session,
                        &run.workspace_path,
                    )))
                }),
            managed,
        };
        if let Some(managed) = &saved.managed {
            managed.validate(&saved)?;
        }
        Ok(Some(saved))
    }

    pub(super) fn restore_worker_registration(
        &self,
        saved: &WorkerTaskRegistration,
    ) -> Result<(), String> {
        supported(&saved.engine)?;
        text_limit(&saved.run_id, "worker run_id", 128)?;
        text_limit(&saved.workspace_path, "worker workspace", 4096)?;
        if let Some(session) = &saved.session_id {
            text_limit(session, "worker session_id", 256)?;
        }
        if !matches!(
            saved.permission.as_str(),
            "auto" | "manual" | "plan" | "bypass"
        ) {
            return Err("Invalid worker task registration".into());
        }
        if let Some(managed) = &saved.managed {
            managed.validate(saved)?;
            validate_host_worker_session(&self.db, &saved.engine, saved.session_id.as_deref())?;
        } else {
            if saved.root_on_start != saved.session_id.is_none()
                || saved.root_identity_bound != saved.session_id.is_some()
                || saved.root_on_start != saved.root_saved_baseline.is_some()
                || saved.root_on_start != saved.root_foreign_claims.is_some()
                || (saved.verified_new_root && saved.session_id.is_none())
            {
                return Err("Invalid worker task registration".into());
            }
            validate_worker_session(&self.db, &saved.engine, saved.session_id.as_deref())?;
        }
        let entry = self
            .processes
            .get(&saved.run_id)
            .ok_or("Recovered worker has no live routing proxy")?;
        if entry.run_id != saved.run_id
            || entry.pid == 0
            || entry.child.is_some()
            || entry.killed.load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err("Recovered worker routing proxy is not active".into());
        }
        let mut inner = self.inner.lock();
        if inner.shutdown {
            return Err("Task coordinator is shutting down".into());
        }
        if let Some(managed) = &saved.managed {
            self.restore_managed_worker(&mut inner, saved, managed)?;
            drop(inner);
            self.emit();
            return Ok(());
        }
        if let Some(run) = inner.runs.get(&saved.run_id) {
            if run.retired
                || !run.leader_eligible
                || run.branch_id.is_some()
                || run.engine != saved.engine
                || run.session_id != saved.session_id
                || !same_workspace(&run.workspace_path, &saved.workspace_path)
                || run.permission != saved.permission
            {
                return Err("Recovered worker conflicts with an existing task registration".into());
            }
            return Ok(());
        }
        if let Some(session) = &saved.session_id {
            archive::ensure_available(&inner, &saved.engine, session, None)?;
            self.ensure_no_isolated_run(&inner, &saved.engine, session)?;
            if saved.verified_new_root {
                inner.verified_new_roots.insert(
                    key(&identity(&saved.engine, session, &saved.workspace_path)),
                    (self.clock)(),
                );
            }
        }
        inner.runs.insert(
            saved.run_id.clone(),
            Run {
                engine: saved.engine.clone(),
                session_id: saved.session_id.clone(),
                workspace_path: saved.workspace_path.clone(),
                permission: saved.permission.clone(),
                branch_id: None,
                leader_eligible: true,
                root_on_start: saved.root_on_start,
                root_identity_bound: saved.root_identity_bound,
                root_saved_baseline: saved.root_saved_baseline.clone().map(Arc::new),
                root_foreign_claims: saved.root_foreign_claims.clone(),
                isolated_resume_session: None,
                launch_pending: false,
                retired: false,
                last_seq: HashMap::new(),
                settled_turns: HashSet::new(),
            },
        );
        Ok(())
    }

    fn restore_managed_worker(
        &self,
        inner: &mut Inner,
        saved: &WorkerTaskRegistration,
        managed: &ManagedWorkerRegistration,
    ) -> Result<(), String> {
        let branch_id = &managed.branch.id;
        let current = inner
            .branches
            .get(branch_id)
            .ok_or("Recovered managed worker branch is missing")?;
        let branch = &current.branch;
        archive::ensure_available(
            inner,
            &saved.engine,
            branch.session_id.as_deref().unwrap_or_default(),
            Some(branch_id),
        )?;
        archive::ensure_available(
            inner,
            &branch.parent_engine,
            &branch.parent_session_id,
            None,
        )?;
        if branch.id != *branch_id
            || branch.run_id.as_deref() != Some(&saved.run_id)
            || branch.engine != saved.engine
            || !same_workspace(&branch.workspace_path, &saved.workspace_path)
            || branch.parent_engine != managed.branch.parent_engine
            || branch.parent_session_id != managed.branch.parent_session_id
            || !same_workspace(branch.parent_workspace(), managed.branch.parent_workspace())
            || current.permission != saved.permission
            || branch.created_at != managed.branch.created_at
            || branch.title != managed.branch.title
            || branch.task != managed.branch.task
            || branch.model != managed.branch.model
            || branch.effort != managed.branch.effort
            || saved.session_id.as_ref().is_some_and(|session| {
                branch
                    .session_id
                    .as_ref()
                    .is_some_and(|current| current != session)
            })
            || fenced(&branch.state)
            || branch.cost_approval.is_some()
            || branch.state == "awaiting_cost_approval"
            || (branch.state == "stopped" && managed.branch.state != "stopped" && !managed.stopping)
            || inner.pending_bindings.contains_key(&saved.run_id)
            || inner.retiring.contains(&(
                branch.parent_engine.clone(),
                branch.parent_session_id.clone(),
            ))
            || branch.session_id.as_ref().is_some_and(|session| {
                inner
                    .retiring
                    .contains(&(saved.engine.clone(), session.clone()))
            })
        {
            return Err("Recovered managed worker conflicts with its current branch".into());
        }
        let run = inner
            .runs
            .get(&saved.run_id)
            .ok_or("Recovered managed worker has no durable run reservation")?;
        if !run.leader_eligible
            || run.branch_id.as_ref() != Some(branch_id)
            || run.engine != saved.engine
            || !same_workspace(&run.workspace_path, &saved.workspace_path)
            || run.permission != saved.permission
            || run.session_id != branch.session_id
            || run.root_on_start
            || run.root_identity_bound
            || run.root_saved_baseline.is_some()
            || run.root_foreign_claims.is_some()
            || run.isolated_resume_session.is_some()
        {
            return Err("Recovered worker conflicts with an existing task registration".into());
        }
        if !run.retired {
            // A repeat restore must not rewind events already replayed in this
            // host. Only a startup tombstone accepts the saved projection.
            return Ok(());
        }
        if !inner.worker_recovery_runs.contains(&saved.run_id) {
            return Err("Recovered managed worker run was retired in this host".into());
        }
        let session = branch
            .session_id
            .clone()
            .or_else(|| saved.session_id.clone());
        if let Some(session) = &session {
            self.ensure_no_isolated_run(inner, &saved.engine, session)?;
            if pending_claim(inner, &saved.engine, session, &saved.run_id)
                || inner.branches.values().any(|record| {
                    record.branch.id != *branch_id
                        && record.branch.engine == saved.engine
                        && record.branch.session_id.as_ref() == Some(session)
                })
                || inner.runs.iter().any(|(id, other)| {
                    id != &saved.run_id
                        && other.engine == saved.engine
                        && other.session_id.as_ref() == Some(session)
                        && (!other.retired || self.processes.get(id).is_some())
                })
            {
                return Err("Recovered managed worker native identity has another owner".into());
            }
            if let Some(alias) = self.processes.get(session) {
                if alias.run_id != saved.run_id
                    || alias.killed.load(std::sync::atomic::Ordering::SeqCst)
                {
                    return Err("Recovered managed worker native alias has another owner".into());
                }
            }
        }
        let mut record = BranchRecord {
            branch: managed.branch.clone(),
            permission: saved.permission.clone(),
            output: managed.output.clone(),
            questions: managed.questions.clone(),
            plans: managed.plans.clone(),
            stopping: managed.stopping,
            dirty: false,
        };
        // A committed first identity and a user's TTL renewal are independent
        // of streamed output; never undo either when rewinding that projection.
        record.branch.session_id = session.clone();
        record.branch.deadline_at = branch.deadline_at;
        record.branch.expired = (self.clock)() >= branch.deadline_at;
        record.branch.delegation = delegation::restore_host_projection(inner, branch, &record.branch, &managed.last_seq, &managed.settled_turns);
        let restored_run = Run {
            engine: saved.engine.clone(),
            session_id: session.clone(),
            workspace_path: saved.workspace_path.clone(),
            permission: saved.permission.clone(),
            branch_id: Some(branch_id.clone()),
            leader_eligible: true,
            root_on_start: false,
            root_identity_bound: false,
            root_saved_baseline: None,
            root_foreign_claims: None,
            isolated_resume_session: None,
            launch_pending: managed.launch_pending,
            retired: false,
            last_seq: managed.last_seq.clone(),
            settled_turns: managed.settled_turns.clone(),
        };
        // Publish no restored authority unless its durable projection succeeds.
        // The authenticated checkpoint remains available for a retry on error.
        write_branch(&self.db.0.lock(), &record)?;
        inner.branches.insert(branch_id.clone(), record);
        inner.runs.insert(saved.run_id.clone(), restored_run);
        inner.worker_recovery_runs.remove(&saved.run_id);
        if let Some(session) = &session {
            record_pending_root_foreign_claim(inner, &saved.run_id, &saved.engine, session);
        }
        refresh_parents(inner);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::ChildEntry;

    struct NoopEmitter;
    impl Emit for NoopEmitter {
        fn emit_json(&self, _: &str, _: &str) {}
    }

    fn proxy(manager: &LeaderManager, run_id: &str) {
        manager.processes.insert(
            run_id.into(),
            ChildEntry {
                child: None,
                pid: 42,
                run_id: run_id.into(),
                killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                reader_abort: Arc::new(OnceLock::new()),
                stdin: None,
                questions: Arc::new(std::sync::Mutex::new(HashMap::new())),
                plans: Arc::new(std::sync::Mutex::new(HashMap::new())),
                native_tasks: Default::default(),
                codex_control: None,
            },
        );
    }

    fn reload(manager: &LeaderManager) -> LeaderManager {
        LeaderManager::with_services(
            manager.db.clone(),
            Arc::new(crate::engine::ProcessRegistry::default()),
            Arc::new(NoopEmitter),
            Arc::new(|| 2_000),
            Arc::new(|_, _, _| Ok(())),
        )
        .unwrap()
    }

    fn fixture() -> (LeaderManager, String, String) {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions(engine TEXT,session_id TEXT,workspace_path TEXT);
             CREATE TABLE session_archives(engine TEXT,session_id TEXT);",
        )
        .unwrap();
        let db = Arc::new(Db(Mutex::new(conn)));
        let manager = LeaderManager::with_services(
            db,
            Arc::new(crate::engine::ProcessRegistry::default()),
            Arc::new(NoopEmitter),
            Arc::new(|| 1_000),
            Arc::new(|_, _, _| Ok(())),
        )
        .unwrap();
        let parent = identity("claude", "parent", "workspace");
        proxy(&manager, "parent-run");
        manager
            .prepare(
                "parent-run",
                "claude",
                Some("parent"),
                "workspace",
                Some("manual"),
            )
            .unwrap();
        let caller = Caller {
            run_id: "parent-run".into(),
            engine: "claude".into(),
            session_id: "parent".into(),
            workspace_path: "workspace".into(),
        };
        let args = SpawnArgs {
            workspace_path: None,
            request_id: "spawn".into(),
            engine: "claude".into(),
            title: "Worker".into(),
            task: "Return a verified result".into(),
            model: None,
            effort: None,
            ttl_seconds: None,
        };
        let Reservation::Start((branch, run)) = manager
            .reserve_spawn(
                &caller,
                &parent,
                "manual",
                &args,
                encoded(&args).unwrap(),
                None,
                None,
            )
            .unwrap()
        else {
            panic!("new reservation was replayed");
        };
        proxy(&manager, &run);
        (manager, branch, run)
    }

    fn observe(manager: &LeaderManager, run: &str, kind: &str, data: Value, seq: u64) {
        manager.observe(&mut json!({
            "runId":run,"engine":"claude","sessionId":"child","kind":kind,"data":data,"seq":seq,
        }));
    }

    fn saved(manager: &LeaderManager, run: &str) -> WorkerTaskRegistration {
        manager
            .try_capture_worker_registration(run)
            .unwrap()
            .unwrap()
    }

    fn branch(manager: &LeaderManager, id: &str) -> LeaderBranch {
        manager.inner.lock().branches[id].branch.clone()
    }

    #[test]
    fn managed_checkpoint_restores_unicode_stream_boundary_and_replay_deduplication() {
        let (manager, id, run) = fixture();
        observe(&manager, &run, "delta", json!("中👩‍💻"), 1);
        let checkpoint = saved(&manager, &run);
        // The old host can have persisted beyond the authenticated checkpoint.
        observe(&manager, &run, "delta", json!("文"), 2);
        manager.checkpoint().unwrap();
        let recovered = reload(&manager);
        assert_eq!(branch(&recovered, &id).state, "unknown");
        assert_eq!(branch(&recovered, &id).delegation.unwrap().state, "unknown");
        proxy(&recovered, &run);
        recovered.restore_worker_registration(&checkpoint).unwrap();
        assert_eq!(branch(&recovered, &id).result, "中👩‍💻");
        assert_eq!(branch(&recovered, &id).delegation.unwrap().state, "running");
        assert_eq!(branch(&recovered, &id).delegation.unwrap().result, "中👩‍💻");
        observe(&recovered, &run, "delta", json!("中👩‍💻"), 1);
        observe(&recovered, &run, "delta", json!("文"), 2);
        observe(
            &recovered,
            &run,
            "message",
            json!({"role":"assistant","text":"中👩‍💻文"}),
            3,
        );
        observe(
            &recovered,
            &run,
            "message",
            json!({"role":"assistant","text":"duplicate"}),
            3,
        );
        recovered.restore_worker_registration(&checkpoint).unwrap();
        assert_eq!(branch(&recovered, &id).result, "中👩‍💻文");
        observe(&recovered, &run, "done", json!({}), 4);
        recovered.finish(&run);
        assert_eq!(branch(&recovered, &id).state, "completed");
        assert_eq!(branch(&recovered, &id).delegation.unwrap().result, "中👩‍💻文");
        assert!(recovered.restore_worker_registration(&checkpoint).is_err());
    }

    #[test]
    fn managed_checkpoint_preserves_question_and_plan_until_both_settle() {
        let (manager, id, run) = fixture();
        observe(&manager, &run, "question", json!({"requestId":"q"}), 1);
        observe(&manager, &run, "plan_review", json!({"planId":"p"}), 2);
        let checkpoint = saved(&manager, &run);
        let recovered = reload(&manager);
        proxy(&recovered, &run);
        recovered.restore_worker_registration(&checkpoint).unwrap();
        observe(&recovered, &run, "question", json!({"requestId":"q"}), 1);
        observe(&recovered, &run, "plan_review", json!({"planId":"p"}), 2);
        observe(&recovered, &run, "done", json!({}), 3);
        assert_eq!(branch(&recovered, &id).state, "waiting");
        observe(
            &recovered,
            &run,
            "question_settled",
            json!({"requestId":"q"}),
            4,
        );
        assert_eq!(branch(&recovered, &id).state, "waiting");
        observe(
            &recovered,
            &run,
            "plan_review_settled",
            json!({"planId":"p"}),
            5,
        );
        assert_eq!(branch(&recovered, &id).state, "running");
        observe(&recovered, &run, "delta", json!("Approved"), 6);
        observe(&recovered, &run, "done", json!({}), 7);
        assert_eq!(branch(&recovered, &id).state, "completed");
    }

    #[test]
    fn managed_checkpoint_keeps_completed_continuation_fenced_from_later_turn() {
        let (manager, id, run) = fixture();
        observe(&manager, &run, "delta", json!("Base."), 1);
        observe(&manager, &run, "done", json!({}), 2);
        let c1 = format!("{run}-c1");
        observe(&manager, &c1, "delta", json!("First."), 1);
        observe(&manager, &c1, "done", json!({}), 2);
        let c2 = format!("{run}-c2");
        observe(&manager, &c2, "delta", json!("Second."), 1);
        let checkpoint = saved(&manager, &run);
        let recovered = reload(&manager);
        proxy(&recovered, &run);
        recovered.restore_worker_registration(&checkpoint).unwrap();
        observe(&recovered, &c1, "done", json!({}), 3);
        observe(&recovered, &c1, "error", json!("late failure"), 4);
        observe(&recovered, &c2, "delta", json!("Second."), 1);
        assert_eq!(branch(&recovered, &id).state, "running");
        assert_eq!(branch(&recovered, &id).result, "Base.First.Second.");
        let delegated = branch(&recovered, &id).delegation.unwrap();
        assert_eq!(delegated.state, "completed");
        assert_eq!(delegated.result, "Base.");
        observe(&recovered, &c2, "done", json!({}), 2);
        assert_eq!(branch(&recovered, &id).state, "completed");
    }

    #[test]
    fn managed_checkpoint_keeps_cancellation_intent_through_reload() {
        let (manager, id, run) = fixture();
        observe(&manager, &run, "delta", json!("Partial"), 1);
        manager.inner.lock().branches.get_mut(&id).unwrap().stopping = true;
        let checkpoint = saved(&manager, &run);
        let recovered = reload(&manager);
        proxy(&recovered, &run);
        recovered.restore_worker_registration(&checkpoint).unwrap();
        assert!(recovered.inner.lock().branches[&id].stopping);
        observe(&recovered, &run, "done", json!({}), 2);
        recovered.finish(&run);
        assert_eq!(branch(&recovered, &id).state, "stopped");
        assert_eq!(branch(&recovered, &id).delegation.unwrap().state, "stopped");
    }

    #[test]
    fn managed_checkpoint_cannot_rewind_a_durably_completed_delegation() {
        let (manager, id, run) = fixture();
        observe(&manager, &run, "delta", json!("Original"), 1);
        let checkpoint = saved(&manager, &run);
        observe(&manager, &run, "message", json!({"role":"assistant","text":"Original final result"}), 2);
        observe(&manager, &run, "done", json!({}), 3);
        let completed = encoded(&branch(&manager, &id).delegation).unwrap();
        let recovered = reload(&manager);
        proxy(&recovered, &run);
        recovered.restore_worker_registration(&checkpoint).unwrap();
        assert_eq!(branch(&recovered, &id).state, "running");
        assert_eq!(encoded(&branch(&recovered, &id).delegation).unwrap(), completed);
        observe(&recovered, &run, "message", json!({"role":"assistant","text":"Original final result"}), 2);
        observe(&recovered, &run, "done", json!({}), 3);
        observe(&recovered, &format!("{run}-c1"), "delta", json!("Manual turn"), 1);
        assert_eq!(branch(&recovered, &id).state, "running");
        assert_eq!(encoded(&branch(&recovered, &id).delegation).unwrap(), completed);
    }

    #[test]
    fn managed_checkpoint_rejects_worker_supplied_host_projection() {
        let (manager, id, run) = fixture();
        observe(&manager, &run, "delta", json!("Partial"), 1);
        let checkpoint = saved(&manager, &run);
        let recovered = reload(&manager);
        proxy(&recovered, &run);
        assert!(encoded(&checkpoint).unwrap()["managed"]["branch"].get("delegation").is_none());
        let host_projection = branch(&manager, &id).delegation.unwrap();
        for mutation in ["request", "run", "task", "created", "updated", "state", "result", "error", "valid-but-untrusted"] {
            let mut invalid = checkpoint.clone();
            let branch = &mut invalid.managed.as_mut().unwrap().branch;
            branch.delegation = Some(host_projection.clone());
            {
                let d = branch.delegation.as_mut().unwrap();
                match mutation {
                    "request" => d.request_id = "different-request".into(),
                    "run" => d.run_id = Some("foreign-run".into()),
                    "task" => d.task = "another task".into(),
                    "created" => d.created_at += 1,
                    "updated" => d.updated_at = d.created_at - 1,
                    "state" => d.state = "awaiting_cost_approval".into(),
                    "result" => d.result = "中".repeat(MAX_RESULT_CHARS + 1),
                    "error" => d.error = Some("e".repeat(MAX_INPUT_CHARS + 1)),
                    "valid-but-untrusted" => {},
                    _ => unreachable!(),
                }
            }
            assert!(recovered.restore_worker_registration(&invalid).is_err(), "{mutation}");
        }
        assert_eq!(branch(&recovered, &id).state, "unknown");
        assert!(recovered.inner.lock().runs[&run].retired);
        recovered.restore_worker_registration(&checkpoint).unwrap();
        assert_eq!(branch(&recovered, &id).delegation.unwrap().state, "running");
    }

    #[test]
    fn v2_checkpoint_without_host_metadata_recovers_only_a_proven_original_base_turn() {
        for manual_continuation in [false, true] {
            let (manager, id, run) = fixture();
            observe(&manager, &run, "delta", json!("Original partial"), 1);
            manager.acknowledge(&identity("claude", "parent", "workspace"), "spawn", &run,
                Ok(crate::engine::SendResult { run_id:run.clone(),session_id:Some("child".into()) })).unwrap();
            if manual_continuation {
                observe(&manager, &run, "done", json!({}), 2);
                observe(&manager, &format!("{run}-c1"), "delta", json!("Later manual text"), 1);
            }
            let checkpoint = saved(&manager, &run);
            assert!(encoded(&checkpoint).unwrap()["managed"]["branch"].get("delegation").is_none());
            manager.checkpoint().unwrap();
            manager.db.0.lock().execute("UPDATE leader_requests SET record_json=json_remove(record_json,'$.response.branch.$ccguiDelegation')", []).unwrap();
            let recovered = reload(&manager);
            assert_eq!(branch(&recovered, &id).delegation.unwrap().state, "unknown");
            proxy(&recovered, &run);
            recovered.restore_worker_registration(&checkpoint).unwrap();
            let delegation = branch(&recovered, &id).delegation.unwrap();
            if manual_continuation {
                assert_eq!(delegation.state, "unknown");
                assert!(delegation.result.is_empty());
                assert!(branch(&recovered, &id).result.contains("Later manual text"));
            } else {
                assert_eq!(delegation.state, "running");
                assert_eq!(delegation.result, "Original partial");
                observe(&recovered, &run, "done", json!({}), 2);
                assert_eq!(branch(&recovered, &id).delegation.unwrap().state, "completed");
            }
        }
    }

    #[test]
    fn managed_checkpoint_rejects_missing_capsule_identity_mismatch_and_invalid_boundaries() {
        let (manager, id, run) = fixture();
        observe(&manager, &run, "delta", json!("中文"), 1);
        let checkpoint = saved(&manager, &run);
        let recovered = reload(&manager);
        proxy(&recovered, &run);
        let mut invalid = checkpoint.clone();
        invalid.managed = None;
        assert!(recovered.restore_worker_registration(&invalid).is_err());
        let mut invalid = checkpoint.clone();
        invalid.permission = "bypass".into();
        assert!(recovered.restore_worker_registration(&invalid).is_err());
        let mut invalid = checkpoint.clone();
        invalid.managed.as_mut().unwrap().branch.parent_session_id = "another-parent".into();
        assert!(recovered.restore_worker_registration(&invalid).is_err());
        let mut invalid = checkpoint.clone();
        invalid.managed.as_mut().unwrap().output.stream_start = Some(1);
        assert!(recovered.restore_worker_registration(&invalid).is_err());
        let mut invalid = checkpoint.clone();
        invalid
            .managed
            .as_mut()
            .unwrap()
            .last_seq
            .insert("foreign-run".into(), 1);
        assert!(recovered.restore_worker_registration(&invalid).is_err());
        let mut invalid = checkpoint.clone();
        invalid.managed.as_mut().unwrap().questions = (0..=MAX_CHECKPOINT_APPROVALS)
            .map(|n| n.to_string())
            .collect();
        assert!(recovered.restore_worker_registration(&invalid).is_err());
        assert_eq!(branch(&recovered, &id).state, "unknown");
        assert!(recovered.inner.lock().runs[&run].retired);
    }

    #[test]
    fn managed_checkpoint_failed_save_does_not_publish_restored_authority() {
        let (manager, id, run) = fixture();
        observe(&manager, &run, "delta", json!("Saved projection"), 1);
        let checkpoint = saved(&manager, &run);
        let recovered = reload(&manager);
        proxy(&recovered, &run);
        recovered.db.0.lock().execute_batch(
            "CREATE TRIGGER reject_restore BEFORE UPDATE ON leader_branches BEGIN SELECT RAISE(ABORT,'restore write failed'); END;",
        ).unwrap();
        assert!(recovered
            .restore_worker_registration(&checkpoint)
            .unwrap_err()
            .contains("restore write failed"));
        assert_eq!(branch(&recovered, &id).state, "unknown");
        assert!(recovered.inner.lock().runs[&run].retired);
        assert!(recovered.inner.lock().worker_recovery_runs.contains(&run));
        recovered
            .db
            .0
            .lock()
            .execute_batch("DROP TRIGGER reject_restore;")
            .unwrap();
        recovered.restore_worker_registration(&checkpoint).unwrap();
        assert_eq!(branch(&recovered, &id).result, "Saved projection");
    }

    #[test]
    fn managed_checkpoint_rejects_reclaimed_replaced_held_and_archived_branches() {
        for fence in ["reclaimed", "replaced", "held", "archived"] {
            let (manager, id, run) = fixture();
            observe(&manager, &run, "delta", json!("Checkpoint"), 1);
            let checkpoint = saved(&manager, &run);
            let recovered = reload(&manager);
            proxy(&recovered, &run);
            if fence == "reclaimed" {
                recovered.mark_reclaimed(&id).unwrap();
            } else if fence == "archived" {
                let root = identity("claude", "parent", "workspace");
                recovered.inner.lock().archived_groups.insert(
                    key(&root),
                    LeaderArchivedGroup {
                        root: root.clone(),
                        title: "Archived".into(),
                        archived_at: 2_000,
                        members: vec![root],
                        branch_ids: vec![id.clone()],
                        deletion_started: false,
                    },
                );
            } else {
                let mut inner = recovered.inner.lock();
                let record = inner.branches.get_mut(&id).unwrap();
                if fence == "replaced" {
                    record.branch.run_id = Some("new-run".into());
                } else {
                    record.branch.state = "awaiting_cost_approval".into();
                    record.branch.run_id = None;
                }
            }
            assert!(
                recovered.restore_worker_registration(&checkpoint).is_err(),
                "{fence}"
            );
            assert!(recovered.inner.lock().runs[&run].retired);
        }
    }

    #[test]
    fn managed_checkpoint_rejects_pending_binding_and_preserves_late_committed_identity() {
        let (manager, id, run) = fixture();
        manager
            .inner
            .lock()
            .pending_bindings
            .insert(run.clone(), ("claude".into(), "child".into()));
        assert!(manager.try_capture_worker_registration(&run).is_err());
        manager.inner.lock().pending_bindings.clear();
        let checkpoint = saved(&manager, &run);
        assert!(checkpoint.session_id.is_none());
        observe(&manager, &run, "session", json!("child"), 1);
        manager
            .db
            .0
            .lock()
            .execute(
                "INSERT INTO sessions VALUES('claude','child','workspace')",
                [],
            )
            .unwrap();
        let recovered = reload(&manager);
        proxy(&recovered, &run);
        recovered.restore_worker_registration(&checkpoint).unwrap();
        assert_eq!(branch(&recovered, &id).session_id.as_deref(), Some("child"));
        observe(&recovered, &run, "session", json!("child"), 1);
        observe(&recovered, &run, "delta", json!("Bound"), 2);
        assert_eq!(branch(&recovered, &id).state, "running");
        assert_eq!(branch(&recovered, &id).result, "Bound");
    }

    #[test]
    fn worker_admission_requires_exact_managed_reservation_without_mutating_ledger() {
        let (manager, id, run) = fixture();
        assert!(validate_detached_worker_session(
            &manager.db,
            &run,
            "claude",
            None,
            "workspace",
            Some(&id)
        )
        .is_ok());
        for (candidate_run, engine, session, workspace, candidate_branch) in [
            ("other", "claude", None, "workspace", id.as_str()),
            (run.as_str(), "codex", None, "workspace", id.as_str()),
            (
                run.as_str(),
                "claude",
                Some("other"),
                "workspace",
                id.as_str(),
            ),
            (run.as_str(), "claude", None, "other-workspace", id.as_str()),
            (run.as_str(), "claude", None, "workspace", "other-branch"),
        ] {
            assert!(validate_detached_worker_session(
                &manager.db,
                candidate_run,
                engine,
                session,
                workspace,
                Some(candidate_branch)
            )
            .is_err());
        }
        observe(&manager, &run, "session", json!("child"), 1);
        assert!(validate_host_worker_session(&manager.db, "claude", Some("child")).is_ok());
        assert!(validate_detached_worker_session(
            &manager.db,
            &run,
            "claude",
            Some("child"),
            "workspace",
            None
        )
        .is_err());
        assert!(validate_detached_worker_session(
            &manager.db,
            &run,
            "claude",
            Some("child"),
            "workspace",
            Some(&id)
        )
        .is_ok());
        assert_eq!(branch(&manager, &id).run_id.as_deref(), Some(run.as_str()));
    }

    #[test]
    fn worker_presentation_is_frozen_before_later_branch_changes_and_reclamation() {
        let (manager, id, run) = fixture();
        let presentation =
            detached_worker_presentation(&manager.db, &run, "claude", None, "workspace", Some(&id))
                .unwrap()
                .unwrap();
        let expected = json!({
            "branchId": id, "workspacePath": "workspace",
            "title": "Worker", "assignment": "Return a verified result",
        });
        assert_eq!(presentation, expected);
        {
            let mut inner = manager.inner.lock();
            let record = inner.branches.get_mut(&id).unwrap();
            record.branch.title = "Later title".into();
            record.branch.task = "Later assignment".into();
            manager.save(record).unwrap();
        }
        let later =
            detached_worker_presentation(&manager.db, &run, "claude", None, "workspace", Some(&id))
                .unwrap()
                .unwrap();
        assert_eq!(later["title"], "Later title");
        assert_eq!(later["assignment"], "Later assignment");
        manager.mark_reclaimed(&id).unwrap();
        assert!(detached_worker_presentation(
            &manager.db,
            &run,
            "claude",
            None,
            "workspace",
            Some(&id),
        )
        .is_err());
        assert_eq!(presentation, expected);
    }

    #[test]
    fn worker_presentation_rejects_wrong_identity_and_has_no_metadata_for_ordinary_chats() {
        let (manager, id, run) = fixture();
        assert!(detached_worker_presentation(
            &manager.db,
            "parent-run",
            "claude",
            Some("parent"),
            "workspace",
            None,
        )
        .unwrap()
        .is_none());
        for (candidate_run, engine, session, workspace) in [
            ("different-run", "claude", None, "workspace"),
            (run.as_str(), "codex", None, "workspace"),
            (
                run.as_str(),
                "claude",
                Some("different-session"),
                "workspace",
            ),
            (run.as_str(), "claude", None, "different-workspace"),
        ] {
            assert!(detached_worker_presentation(
                &manager.db,
                candidate_run,
                engine,
                session,
                workspace,
                Some(&id),
            )
            .is_err());
        }
        observe(&manager, &run, "session", json!("child"), 1);
        assert!(detached_worker_presentation(
            &manager.db,
            &run,
            "claude",
            Some("child"),
            "workspace",
            None,
        )
        .is_err());
    }

    #[test]
    fn ordinary_worker_checkpoint_wire_shape_remains_unchanged() {
        let (manager, _, _) = fixture();
        let checkpoint = saved(&manager, "parent-run");
        let wire = encoded(&checkpoint).unwrap();
        assert!(wire.get("managed").is_none());
        let decoded: WorkerTaskRegistration = serde_json::from_value(wire).unwrap();
        assert!(decoded.managed_branch_id().is_none());
    }

    #[test]
    fn managed_worker_starting_requires_both_identities_and_a_committed_launch() {
        let (manager, id, run) = fixture();
        assert!(!manager.managed_worker_is_starting("missing-run"));
        assert!(!manager.managed_worker_is_starting("parent-run"));
        assert!(manager.managed_worker_is_starting(&run));
        {
            let mut inner = manager.inner.lock();
            inner.runs.get_mut(&run).unwrap().session_id = Some("child".into());
        }
        assert!(manager.managed_worker_is_starting(&run));
        {
            let mut inner = manager.inner.lock();
            inner.branches.get_mut(&id).unwrap().branch.session_id = Some("child".into());
        }
        assert!(manager.managed_worker_is_starting(&run));
        manager
            .inner
            .lock()
            .runs
            .get_mut(&run)
            .unwrap()
            .launch_pending = false;
        assert!(!manager.managed_worker_is_starting(&run));
        manager
            .inner
            .lock()
            .pending_bindings
            .insert(run.clone(), ("claude".into(), "child".into()));
        assert!(manager.managed_worker_is_starting(&run));
        manager.inner.lock().pending_bindings.remove(&run);
        assert!(!manager.managed_worker_is_starting(&run));
        manager.inner.lock().runs.get_mut(&run).unwrap().session_id = None;
        assert!(manager.managed_worker_is_starting(&run));
        manager.inner.lock().runs.get_mut(&run).unwrap().session_id = Some("child".into());
        manager.inner.lock().branches.remove(&id);
        assert!(manager.managed_worker_is_starting(&run));
    }
}
