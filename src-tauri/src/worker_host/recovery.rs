//! Read-only validation of a completed orphaned coordinator's worker stream.
//! This proves a terminal run, never a task capability or delivery of an input.
use crate::runtime_events::EventEnvelope;
use serde_json::Value;

const MAX_EVENTS: u64 = 1_000_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct RecoveryIdentity {
    pub run_id: String,
    pub engine: String,
    pub session_id: String,
    pub workspace_path: String,
}

pub(super) fn orphan_root(
    status: &Value,
    run_id: &str,
    owns_children: bool,
) -> Option<RecoveryIdentity> {
    if !owns_children || status["managedTask"] != false || status["runId"].as_str()? != run_id {
        return None;
    }
    let engine = status["engine"].as_str()?.to_owned();
    let session_id = status["sessionId"].as_str()?.to_owned();
    let workspace_path = status["workspacePath"].as_str()?.to_owned();
    if !matches!(engine.as_str(), "claude" | "codex" | "agy" | "cursor")
        || session_id.is_empty()
        || workspace_path.is_empty()
    {
        return None;
    }
    Some(RecoveryIdentity {
        run_id: run_id.into(),
        engine,
        session_id,
        workspace_path,
    })
}

/// This ledger check only narrows a read-only recovery; it grants no task authority.
pub(super) fn owns_children(
    db: &crate::db::Db,
    engine: &str,
    session: &str,
    workspace: &str,
) -> Result<bool, String> {
    let connection = db.0.lock();
    let ledger_exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='leader_branches')",
        [], |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    if !ledger_exists {
        return Ok(false);
    }
    let is_child: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM leader_branches WHERE engine=?1 AND session_id=?2)",
            rusqlite::params![engine, session],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if is_child {
        return Ok(false);
    }
    let mut statement = connection.prepare(
        "SELECT workspace_path,record_json FROM leader_branches WHERE parent_engine=?1 AND parent_session_id=?2 AND state!='reclaimed'"
    ).map_err(|error| error.to_string())?;
    let mut rows = statement
        .query(rusqlite::params![engine, session])
        .map_err(|error| error.to_string())?;
    while let Some(row) = rows.next().map_err(|error| error.to_string())? {
        let child_workspace: String = row.get(0).map_err(|error| error.to_string())?;
        let record: String = row.get(1).map_err(|error| error.to_string())?;
        let record: Value =
            serde_json::from_str(&record).map_err(|_| "Invalid child ownership record")?;
        let parent_workspace = match record
            .as_object()
            .ok_or("Invalid child ownership record")?
            .get("parentWorkspacePath")
        {
            None | Some(Value::Null) => child_workspace.as_str(),
            Some(Value::String(value)) if !value.is_empty() => value.as_str(),
            _ => return Err("Invalid child parent workspace".into()),
        };
        if crate::leader::same_workspace(parent_workspace, workspace) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) fn finished_head(status: &Value, identity: &RecoveryIdentity) -> Option<u64> {
    let head = status["head"].as_u64()?;
    (head > 0
        && head <= MAX_EVENTS
        && status["durableThrough"].as_u64() == Some(head)
        && status["runId"].as_str() == Some(&identity.run_id)
        && status["engine"].as_str() == Some(&identity.engine)
        && status["sessionId"].as_str() == Some(&identity.session_id)
        && status["workspacePath"].as_str() == Some(&identity.workspace_path)
        && status["managedTask"] == false
        && status["nativeComplete"] == true
        && status["physicalComplete"] == true
        && status["journalFault"] == false
        && status["receiptFault"] == false)
        .then_some(head)
}

pub(super) struct OrphanAudit<'a> {
    stream: &'a str,
    identity: &'a RecoveryIdentity,
    next_envelope: u64,
    last_event: u64,
    terminal: Option<&'static str>,
}

impl<'a> OrphanAudit<'a> {
    pub(super) fn new(stream: &'a str, identity: &'a RecoveryIdentity) -> Self {
        Self {
            stream,
            identity,
            next_envelope: 1,
            last_event: 0,
            terminal: None,
        }
    }

    pub(super) fn observe(&mut self, envelope: &EventEnvelope) -> Result<(), &'static str> {
        if envelope.stream_id != self.stream
            || envelope.seq != self.next_envelope
            || envelope.name.is_empty()
        {
            return Err("Orphan worker event stream is inconsistent");
        }
        self.next_envelope += 1;
        if envelope.name != crate::event_sink::ENGINE_EVENT_NAME {
            return Ok(());
        }
        let events = envelope
            .payload
            .as_array()
            .ok_or("Orphan worker event batch is invalid")?;
        for event in events {
            if event["runId"].as_str() != Some(&self.identity.run_id)
                || event["engine"].as_str() != Some(&self.identity.engine)
                || event
                    .get("sourceRunId")
                    .is_some_and(|source| source.as_str() != Some(&self.identity.run_id))
                || event
                    .get("sessionId")
                    .filter(|value| !value.is_null())
                    .is_some_and(|value| value.as_str() != Some(&self.identity.session_id))
            {
                return Err("Orphan worker event identity differs");
            }
            let seq = event["seq"]
                .as_u64()
                .filter(|seq| *seq > self.last_event)
                .ok_or("Orphan worker event sequence is invalid")?;
            self.last_event = seq;
            if event["kind"] == "session"
                && event["data"].as_str() != Some(&self.identity.session_id)
            {
                return Err("Orphan worker session announcement differs");
            }
            let terminal = match event["kind"].as_str() {
                Some("done") => {
                    let data = event["data"]
                        .as_object()
                        .ok_or("Orphan worker done event is invalid")?;
                    match data.get("interrupted") {
                        Some(Value::Bool(true)) => Some("cancelled"),
                        None | Some(Value::Bool(false)) => Some("completed"),
                        _ => return Err("Orphan worker interruption flag is invalid"),
                    }
                }
                Some("error") if event["data"].is_string() => Some("failed"),
                Some("error") => return Err("Orphan worker error event is invalid"),
                _ => None,
            };
            if let Some(status) = terminal {
                if event["sessionId"].as_str() != Some(&self.identity.session_id)
                    || self.terminal.replace(status).is_some()
                {
                    return Err("Orphan worker terminal identity is ambiguous");
                }
            }
        }
        Ok(())
    }

    pub(super) fn finish(&self, head: u64) -> Option<&'static str> {
        (self.next_envelope.checked_sub(1) == Some(head))
            .then_some(self.terminal)
            .flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn identity() -> RecoveryIdentity {
        RecoveryIdentity {
            run_id: "run-a".into(),
            engine: "agy".into(),
            session_id: "session".into(),
            workspace_path: "G:/workspace".into(),
        }
    }
    fn status() -> Value {
        json!({"runId":"run-a","engine":"agy","sessionId":"session","workspacePath":"G:/workspace","managedTask":false,
        "nativeComplete":true,"physicalComplete":true,"journalFault":false,"receiptFault":false,"head":2,"durableThrough":2})
    }
    fn envelope(seq: u64, events: Value) -> EventEnvelope {
        EventEnvelope {
            stream_id: "worker".into(),
            seq,
            name: crate::event_sink::ENGINE_EVENT_NAME.into(),
            payload: events,
        }
    }
    #[test]
    fn requires_a_physically_finished_exact_and_durable_root() {
        let identity = identity();
        assert_eq!(finished_head(&status(), &identity), Some(2));
        assert_eq!(
            orphan_root(&status(), "run-a", true),
            Some(identity.clone())
        );
        assert_eq!(orphan_root(&status(), "run-a", false), None);
        assert_eq!(orphan_root(&status(), "other", true), None);
        for (field, bad) in [
            ("managedTask", json!(true)),
            ("nativeComplete", json!(false)),
            ("physicalComplete", json!(false)),
            ("journalFault", json!(true)),
            ("receiptFault", json!(true)),
            ("durableThrough", json!(1)),
            ("sessionId", json!("other")),
            ("workspacePath", json!("G:/other")),
        ] {
            let mut value = status();
            value[field] = bad;
            assert_eq!(finished_head(&value, &identity), None, "{field}");
        }
    }
    #[test]
    fn accepts_only_the_complete_exact_terminal_stream() {
        let identity = identity();
        let mut audit = OrphanAudit::new("worker", &identity);
        audit.observe(&envelope(1,json!([{"runId":"run-a","engine":"agy","sessionId":"session","seq":1,"kind":"session","data":"session"}]))).unwrap();
        audit.observe(&envelope(2,json!([{"runId":"run-a","engine":"agy","sessionId":"session","seq":2,"kind":"done","data":{}}]))).unwrap();
        assert_eq!(audit.finish(2), Some("completed"));
        assert_eq!(audit.finish(3), None);
        let mut invalid = OrphanAudit::new("worker", &identity);
        assert!(invalid.observe(&envelope(1,json!([{"runId":"other","engine":"agy","sessionId":"session","seq":1,"kind":"done","data":{}}]))).is_err());
        for (field, value) in [
            ("engine", json!("codex")),
            ("sessionId", json!("other")),
            ("sourceRunId", json!("other")),
        ] {
            let mut event = json!({"runId":"run-a","engine":"agy","sessionId":"session","seq":1,"kind":"done","data":{}});
            event[field] = value;
            assert!(
                OrphanAudit::new("worker", &identity)
                    .observe(&envelope(1, json!([event])))
                    .is_err(),
                "{field}"
            );
        }
        assert!(OrphanAudit::new("worker", &identity)
            .observe(&envelope(2, json!([])))
            .is_err());
        let mut unterminated = OrphanAudit::new("worker", &identity);
        unterminated.observe(&envelope(1,json!([{"runId":"run-a","engine":"agy","sessionId":"session","seq":1,"kind":"model","data":"fixture"}]))).unwrap();
        assert_eq!(unterminated.finish(1), None);
        let mut cancelled = OrphanAudit::new("worker", &identity);
        cancelled.observe(&envelope(1,json!([{"runId":"run-a","engine":"agy","sessionId":"session","seq":1,"kind":"done","data":{"interrupted":true}}]))).unwrap();
        assert_eq!(cancelled.finish(1), Some("cancelled"));
        assert!(cancelled.observe(&envelope(2,json!([{"runId":"run-a","engine":"agy","sessionId":"session","seq":2,"kind":"done","data":{}}]))).is_err());
    }
    #[test]
    fn only_an_owned_root_is_eligible_for_read_only_recovery() {
        let db = crate::db::Db::open_in_memory().unwrap();
        assert!(!owns_children(&db, "agy", "session", "G:/workspace").unwrap());
        crate::leader::ensure_schema(&db).unwrap();
        db.0.lock().execute("INSERT INTO leader_branches(id,parent_engine,parent_session_id,workspace_path,engine,session_id,state,record_json,permission) VALUES ('child','agy','session','G:/workspace','codex','child-session','completed','{}','manual')",[]).unwrap();
        assert!(owns_children(&db, "agy", "session", "G:/workspace").unwrap());
        assert!(!owns_children(&db, "agy", "session", "G:/other").unwrap());
        assert!(!owns_children(&db, "codex", "child-session", "G:/workspace").unwrap());
        db.0.lock().execute("UPDATE leader_branches SET workspace_path='G:/member', record_json='{\"parentWorkspacePath\":\"G:/workspace\"}' WHERE id='child'", []).unwrap();
        assert!(owns_children(&db, "agy", "session", "G:/workspace").unwrap());
        assert!(!owns_children(&db, "agy", "session", "G:/member").unwrap());
        db.0.lock()
            .execute(
                "UPDATE leader_branches SET state='reclaimed' WHERE id='child'",
                [],
            )
            .unwrap();
        assert!(!owns_children(&db, "agy", "session", "G:/workspace").unwrap());
    }
}
