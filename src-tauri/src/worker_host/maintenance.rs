//! Explicit native maintenance for a physically finished, orphaned root worker.
//! Does not start a GUI, restore task authority, write SQLite, or change update state.
use super::recovery::{self, OrphanAudit, RecoveryIdentity};
use crate::task_worker::{self, Command, EventsPage, WorkerClient};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{io::Read, path::PathBuf, time::Duration};

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Action { Inspect, Retire }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    action: Action,
    worker_id: String,
    run_id: String,
    engine: String,
    session_id: String,
    workspace_path: String,
    expected_head: Option<u64>,
    expected_terminal: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Proof { head: u64, terminal: String }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    worker_id: String,
    run_id: String,
    session_id: String,
    #[serde(flatten)]
    proof: Proof,
    archived: bool,
}

impl Request {
    fn identity(&self) -> Result<RecoveryIdentity, String> {
        if uuid::Uuid::parse_str(&self.worker_id).is_err()
            || self.run_id.is_empty() || self.run_id.len() > 96
            || !self.run_id.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
            || !matches!(self.engine.as_str(), "agy" | "claude" | "codex" | "cursor")
            || self.session_id.is_empty() || self.session_id.len() > 256
            || self.workspace_path.is_empty() || self.workspace_path.len() > 32768
            || self.session_id.contains('\0') || self.workspace_path.contains('\0')
        { return Err("Invalid exact worker recovery identity".into()); }
        match self.action {
            Action::Inspect if self.expected_head.is_none() && self.expected_terminal.is_none() => {},
            Action::Retire if self.expected_head.is_some_and(|h| h > 0 && h <= 1_000_000)
                && self.expected_terminal.as_deref().is_some_and(|s| matches!(s, "completed" | "failed" | "cancelled")) => {},
            _ => return Err("Inspect must have no expected proof; retire requires the inspected head and terminal".into()),
        }
        Ok(RecoveryIdentity { run_id: self.run_id.clone(), engine: self.engine.clone(),
            session_id: self.session_id.clone(), workspace_path: self.workspace_path.clone() })
    }

    fn check_proof(&self, proof: &Proof) -> Result<(), String> {
        if self.action == Action::Retire && (self.expected_head != Some(proof.head)
            || self.expected_terminal.as_deref() != Some(&proof.terminal)) {
            return Err("Worker proof changed since inspection; no retirement was requested".into());
        }
        Ok(())
    }
}

trait Io {
    async fn status(&self) -> Result<Value, String>;
    async fn events(&self, after: u64) -> Result<EventsPage, String>;
    async fn retire(&self, id: &str, through: u64) -> Result<(), String>;
    async fn archived(&self) -> Result<Option<Proof>, String>;
}

async fn recover(request: &Request, identity: &RecoveryIdentity, io: &impl Io) -> Result<Report, String> {
    let report = |proof, archived| Report { worker_id: request.worker_id.clone(),
        run_id: identity.run_id.clone(), session_id: identity.session_id.clone(), proof, archived };
    if let Some(proof) = io.archived().await? {
        request.check_proof(&proof)?;
        return Ok(report(proof, true));
    }
    let status = io.status().await?;
    let head = recovery::finished_head(&status, identity)
        .ok_or("Worker is not an exact, physically complete, durable root; no retirement was requested")?;
    let mut audit = OrphanAudit::new(&request.worker_id, identity);
    let mut cursor = 0;
    while cursor < head {
        let page = io.events(cursor).await?;
        if page.stream_id != request.worker_id || page.head != head || page.durable_through != head
            || page.events.is_empty() || page.through <= cursor || page.through > head
            || page.events.last().map(|e| e.seq) != Some(page.through)
        { return Err("Worker replay cursor changed; no retirement was requested".into()); }
        for event in &page.events { audit.observe(event)?; }
        cursor = page.through;
    }
    let proof = Proof { head, terminal: audit.finish(head).ok_or("Worker has no unambiguous terminal")?.into() };
    request.check_proof(&proof)?;
    if recovery::finished_head(&io.status().await?, identity) != Some(head) {
        return Err("Worker changed after audit; no retirement was requested".into());
    }
    if request.action == Action::Inspect { return Ok(report(proof, false)); }
    // Stable across command invocations, including an acknowledgement lost after
    // the worker persisted the archive. This is the only mutation in this mode.
    let id = format!("recover-{}-{head}", request.worker_id);
    let result = io.retire(&id, head).await;
    for _ in 0..20 {
        if let Some(saved) = io.archived().await? {
            if saved != proof { return Err("Retired archive differs from audited worker; keep fenced".into()); }
            return Ok(report(saved, true));
        }
        if result.is_err() { break; }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("Retirement archive is not confirmed; repeat the identical recovery request to reconcile, never resend the task".into())
}

struct NativeIo {
    profile: PathBuf,
    worker_id: String,
    identity: RecoveryIdentity,
    client: Option<WorkerClient>,
}

impl Io for NativeIo {
    async fn status(&self) -> Result<Value, String> {
        self.client.as_ref().ok_or("Original worker is unavailable; offline journal recovery is not authorized")?
            .request(&uuid::Uuid::new_v4().to_string(), Command::Status).await.map_err(super::error)
    }
    async fn events(&self, after: u64) -> Result<EventsPage, String> {
        self.client.as_ref().ok_or("Original worker is unavailable")?.events_after(after, 128).await.map_err(super::error)
    }
    async fn retire(&self, id: &str, through: u64) -> Result<(), String> {
        self.client.as_ref().ok_or("Original worker is unavailable")?.request(id,
            Command::Retire { stream_id: self.worker_id.clone(), through }).await.map_err(super::error)?;
        Ok(())
    }
    async fn archived(&self) -> Result<Option<Proof>, String> {
        let path = self.profile.join("runtime/task-workers").join(&self.worker_id).join("manifest.retired.json");
        match std::fs::symlink_metadata(path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("Cannot inspect existing worker archive".into()),
            Ok(_) => {},
        }
        let archive = crate::worker_archive::open(&self.profile, &self.worker_id)?;
        if archive.manifest().run_id != self.identity.run_id { return Err("Archive belongs to another run".into()); }
        let mut audit = OrphanAudit::new(&self.worker_id, &self.identity);
        let mut cursor = 0;
        while cursor < archive.head() {
            let page = archive.replay(cursor, 128)?;
            if page.events.is_empty() { return Err("Archive is incomplete".into()); }
            for event in &page.events { audit.observe(event)?; }
            cursor = page.through;
        }
        let terminal = audit.finish(archive.head()).ok_or("Archive terminal is ambiguous")?;
        if archive.terminal_outcome(&self.identity.run_id, &self.identity.engine, &self.identity.session_id)?
            .is_none_or(|proof| proof.status != terminal) { return Err("Archive terminal validation failed".into()); }
        Ok(Some(Proof { head: archive.head(), terminal: terminal.into() }))
    }
}

pub(crate) fn run_stdio() -> Result<(), String> {
    let mut input = Vec::new();
    std::io::stdin().lock().take(65537).read_to_end(&mut input).map_err(|_| "Read recovery request failed")?;
    if input.len() > 65536 { return Err("Recovery request exceeds its limit".into()); }
    let request: Request = serde_json::from_slice(&input).map_err(|_| "Invalid worker recovery request")?;
    let identity = request.identity()?;
    let profile = dunce::canonicalize(crate::paths::app_home()).map_err(|_| "Resolve recovery profile failed")?;
    // No migrations, task adoption, or writes: ledger ownership is a narrowing
    // precondition, not permission to manufacture a coordinator capability.
    let db = crate::db::Db(parking_lot::Mutex::new(rusqlite::Connection::open_with_flags(
        profile.join("app.db"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
    ).map_err(|_| "Open existing ownership ledger read-only failed")?));
    if !recovery::owns_children(&db, &identity.engine, &identity.session_id, &identity.workspace_path)? {
        return Err("Only a ledger-owned root coordinator is eligible for this maintenance mode".into());
    }
    drop(db);
    let manifest = task_worker::discover(&profile).map_err(super::error)?.into_iter()
        .find(|m| m.worker_id == request.worker_id && m.run_id == request.run_id);
    let io = NativeIo { profile, worker_id: request.worker_id.clone(), identity: identity.clone(),
        client: manifest.map(WorkerClient::new) };
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|_| "Create recovery runtime failed")?;
    let report = runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(90), recover(&request, &identity, &io)).await
            .map_err(|_| "Recovery timed out; reconcile the same request without resending the task")?
    })?;
    println!("{}", serde_json::to_string(&report).map_err(|_| "Encode recovery report failed")?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_events::EventEnvelope;
    use serde_json::json;
    use std::cell::RefCell;

    struct Fake {
        status: RefCell<Vec<Value>>,
        events: Vec<EventEnvelope>,
        retired: RefCell<Vec<String>>,
        archive: RefCell<Option<Proof>>,
        lose_ack: bool,
    }
    impl Io for Fake {
        async fn status(&self) -> Result<Value, String> { Ok(self.status.borrow_mut().remove(0)) }
        async fn events(&self, _: u64) -> Result<EventsPage, String> {
            Ok(EventsPage { stream_id: "11111111-1111-4111-8111-111111111111".into(), head: 1, durable_through: 1,
                through: 1, events: self.events.clone(), fragment: None })
        }
        async fn retire(&self, id: &str, _: u64) -> Result<(), String> {
            self.retired.borrow_mut().push(id.into());
            *self.archive.borrow_mut() = Some(Proof { head: 1, terminal: "completed".into() });
            if self.lose_ack { Err("lost acknowledgement".into()) } else { Ok(()) }
        }
        async fn archived(&self) -> Result<Option<Proof>, String> { Ok(self.archive.borrow().clone()) }
    }
    fn fixture(action: Action) -> (Request, Fake) {
        let retire = action == Action::Retire;
        let request = Request { action, worker_id: "11111111-1111-4111-8111-111111111111".into(), run_id: "run-a".into(),
            engine: "agy".into(), session_id: "session".into(), workspace_path: "G:/project".into(),
            expected_head: retire.then_some(1), expected_terminal: retire.then(|| "completed".into()) };
        let status = json!({"runId":"run-a","engine":"agy","sessionId":"session","workspacePath":"G:/project",
            "head":1,"durableThrough":1,"managedTask":false,"nativeComplete":true,"physicalComplete":true,"journalFault":false,"receiptFault":false});
        let event = EventEnvelope { stream_id: request.worker_id.clone(), seq: 1, name: "engine://event".into(),
            payload: json!([{"runId":"run-a","engine":"agy","sessionId":"session","seq":1,"kind":"done","data":{}}]) };
        (request, Fake { status: RefCell::new(vec![status.clone(), status]), events: vec![event],
            retired: RefCell::new(vec![]), archive: RefCell::new(None), lose_ack: false })
    }
    #[tokio::test]
    async fn inspection_never_mutates_and_retirement_requires_matching_prior_proof() {
        let (request, io) = fixture(Action::Inspect);
        assert!(!recover(&request, &request.identity().unwrap(), &io).await.unwrap().archived);
        assert!(io.retired.borrow().is_empty());
        let (mut request, io) = fixture(Action::Retire);
        request.expected_head = Some(2);
        assert!(recover(&request, &request.identity().unwrap(), &io).await.is_err());
        assert!(io.retired.borrow().is_empty());
    }
    #[tokio::test]
    async fn invalid_or_changed_worker_is_never_retired() {
        for key in ["nativeComplete", "physicalComplete", "journalFault", "receiptFault", "runId", "sessionId", "managedTask"] {
            let (request, io) = fixture(Action::Retire);
            let current = io.status.borrow()[0][key].clone();
            io.status.borrow_mut()[0][key] = match current { Value::Bool(v) => json!(!v), _ => json!("foreign") };
            assert!(recover(&request, &request.identity().unwrap(), &io).await.is_err(), "{key}");
            assert!(io.retired.borrow().is_empty());
        }
        let (request, io) = fixture(Action::Retire);
        io.status.borrow_mut()[1]["head"] = json!(2);
        assert!(recover(&request, &request.identity().unwrap(), &io).await.is_err());
        assert!(io.retired.borrow().is_empty());
    }
    #[tokio::test]
    async fn gaps_or_missing_or_foreign_terminals_never_retire() {
        for kind in ["gap", "missing", "foreign", "duplicate"] {
            let (request, mut io) = fixture(Action::Retire);
            match kind {
                "gap" => io.events[0].seq = 2,
                "missing" => io.events[0].payload[0]["kind"] = json!("delta"),
                "foreign" => io.events[0].payload[0]["sessionId"] = json!("another"),
                _ => { let mut event = io.events[0].payload[0].clone(); event["seq"] = json!(2); io.events[0].payload.as_array_mut().unwrap().push(event); },
            }
            assert!(recover(&request, &request.identity().unwrap(), &io).await.is_err(), "{kind}");
            assert!(io.retired.borrow().is_empty());
        }
    }
    #[tokio::test]
    async fn lost_ack_and_repeated_request_reconcile_archive_without_new_mutations() {
        let (request, mut io) = fixture(Action::Retire);
        io.lose_ack = true;
        let identity = request.identity().unwrap();
        assert!(recover(&request, &identity, &io).await.unwrap().archived);
        assert!(recover(&request, &identity, &io).await.unwrap().archived);
        assert_eq!(*io.retired.borrow(), ["recover-11111111-1111-4111-8111-111111111111-1"]);
    }
    #[test]
    fn invalid_targets_and_unreviewed_retirement_are_rejected() {
        let (mut request, _) = fixture(Action::Retire);
        request.expected_terminal = None;
        assert!(request.identity().is_err());
        let (mut request, _) = fixture(Action::Inspect);
        request.worker_id = "../other".into();
        assert!(request.identity().is_err());
        let (mut request, _) = fixture(Action::Inspect);
        request.run_id = "../other".into();
        assert!(request.identity().is_err());
    }
}
