//! Native launch provenance for background naming. A public event shape is
//! insufficient: only admitted local GUI runs with an adopted native id qualify.
use crate::db::Db;
use parking_lot::Mutex;
use rusqlite::OptionalExtension;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};

#[derive(Clone)]
pub(super) struct SettledOrigin {
    pub(super) engine: String,
    pub(super) session_id: String,
    pub(super) workspace_path: String,
    killed: Arc<AtomicBool>,
    interrupted: Arc<AtomicBool>,
}

impl SettledOrigin {
    pub(super) fn is_cancelled(&self) -> bool {
        self.killed.load(Ordering::SeqCst) || self.interrupted.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    pub(super) fn new_for_test(
        engine: &str,
        session_id: &str,
        workspace_path: &str,
        killed: Arc<AtomicBool>,
        interrupted: Arc<AtomicBool>,
    ) -> Self {
        Self {
            engine: engine.into(),
            session_id: session_id.into(),
            workspace_path: workspace_path.into(),
            killed,
            interrupted,
        }
    }
}

struct RunOrigin {
    engine: String,
    workspace_path: String,
    session_id: Option<String>,
    killed: Arc<AtomicBool>,
    interrupted: Arc<AtomicBool>,
    turn_id: String,
}

#[derive(Default)]
struct Origins(HashMap<String, RunOrigin>);
static ORIGINS: LazyLock<Mutex<Origins>> = LazyLock::new(|| Mutex::new(Origins::default()));

pub(crate) fn local_workspace(db: &Db, workspace: &str) -> bool {
    if workspace.contains("://") || !std::path::Path::new(workspace).is_dir() {
        return false;
    }
    let conn = db.0.lock();
    let row: Result<Option<Option<String>>, _> = conn
        .query_row(
            "SELECT meta FROM workspaces WHERE path=?1",
            [workspace],
            |r| r.get(0),
        )
        .optional();
    match row {
        Ok(Some(None)) => true,
        Ok(Some(Some(raw))) => serde_json::from_str::<Value>(&raw)
            .is_ok_and(|meta| meta.is_object() && meta.get("wsl").is_none()),
        _ => false,
    }
}

impl Origins {
    fn register(
        &mut self,
        run: &str,
        engine: &str,
        workspace: &str,
        session: Option<&str>,
        killed: &Arc<AtomicBool>,
    ) {
        self.0.insert(
            run.into(),
            RunOrigin {
                engine: engine.into(),
                workspace_path: workspace.into(),
                session_id: session.map(str::to_string),
                killed: Arc::clone(killed),
                interrupted: Arc::new(AtomicBool::new(false)),
                turn_id: run.into(),
            },
        );
    }

    fn settle(&mut self, event: &Value) -> Option<SettledOrigin> {
        let base = event.get("sourceRunId")?.as_str()?;
        let run_id = event.get("runId")?.as_str()?;
        let run = self.0.get_mut(base)?;
        // Continuation ids are assigned by TurnCore, not by native model output.
        if run_id != base
            && !run_id
                .strip_prefix(&format!("{base}-c"))
                .is_some_and(|suffix| {
                    !suffix.is_empty() && suffix.parse::<u32>().is_ok_and(|n| n > 0)
                })
        {
            return None;
        }
        if event.get("engine")?.as_str()? != run.engine {
            return None;
        }
        if run.turn_id != run_id {
            run.turn_id = run_id.into();
            run.interrupted = Arc::new(AtomicBool::new(false));
        }
        let rejected = event.pointer("/leader/identityRejected") == Some(&Value::Bool(true))
            || event.pointer("/leader/reclaimed") == Some(&Value::Bool(true));
        let kind = event.get("kind")?.as_str()?;
        if rejected
            || kind == "error"
            || event.pointer("/data/interrupted") == Some(&Value::Bool(true))
        {
            run.interrupted.store(true, Ordering::SeqCst);
            return None;
        }
        if !matches!(kind, "done" | "turn_complete") || run.killed.load(Ordering::SeqCst) {
            return None;
        }
        if kind == "turn_complete" && run.interrupted.load(Ordering::SeqCst) {
            // A later successfully completed response can start a new naming
            // attempt, while old cancelled attempts retain their own token.
            run.interrupted = Arc::new(AtomicBool::new(false));
        }
        if run.interrupted.load(Ordering::SeqCst) {
            return None;
        }
        let session = event.get("sessionId")?.as_str()?;
        if run.session_id.as_deref() != Some(session) {
            return None;
        }
        Some(SettledOrigin {
            engine: run.engine.clone(),
            session_id: session.into(),
            workspace_path: run.workspace_path.clone(),
            killed: Arc::clone(&run.killed),
            interrupted: Arc::clone(&run.interrupted),
        })
    }
}

pub(crate) fn register_run(
    run: &str,
    engine: &str,
    workspace: &str,
    session: Option<&str>,
    killed: &Arc<AtomicBool>,
) {
    ORIGINS
        .lock()
        .register(run, engine, workspace, session, killed);
}
pub(crate) fn adopt_session(run: &str, engine: &str, session: &str) {
    if let Some(origin) = ORIGINS.lock().0.get_mut(run) {
        if origin.engine == engine && !origin.killed.load(Ordering::SeqCst) {
            origin.session_id = Some(session.into());
        }
    }
}
pub(crate) fn finish_run(run: &str) {
    ORIGINS.lock().0.remove(run);
}
pub(super) fn settled(event: &Value) -> Option<SettledOrigin> {
    ORIGINS.lock().settle(event)
}

/// Read-only integration diagnostics; no registration or settle entry points
/// are exposed, and the feature is forbidden in release builds.
#[cfg(feature = "test-harness")]
pub mod test_support {
    use super::*;

    #[derive(Debug, PartialEq, Eq)]
    pub struct Snapshot {
        pub engine: String,
        pub workspace_path: String,
        pub session_id: Option<String>,
        pub killed: bool,
        pub interrupted: bool,
    }

    pub fn snapshot(run: &str) -> Option<Snapshot> {
        let origins = ORIGINS.lock();
        let origin = origins.0.get(run)?;
        Some(Snapshot {
            engine: origin.engine.clone(),
            workspace_path: origin.workspace_path.clone(),
            session_id: origin.session_id.clone(),
            killed: origin.killed.load(Ordering::SeqCst),
            interrupted: origin.interrupted.load(Ordering::SeqCst),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(kind: &str) -> Value {
        json!({"sourceRunId":"run", "runId":"run", "engine":"claude", "sessionId":"sid", "kind":kind, "data":{}})
    }
    fn fixture() -> Origins {
        let mut origins = Origins::default();
        origins.register(
            "run",
            "claude",
            "/local",
            Some("sid"),
            &Arc::new(AtomicBool::new(false)),
        );
        origins
    }
    #[test]
    fn only_registered_matching_adopted_origins_settle() {
        let mut origins = Origins::default();
        assert!(origins.settle(&event("done")).is_none());
        origins.register(
            "run",
            "claude",
            "/local",
            None,
            &Arc::new(AtomicBool::new(false)),
        );
        assert!(origins.settle(&event("done")).is_none());
        origins.0.get_mut("run").unwrap().session_id = Some("sid".into());
        assert!(origins.settle(&event("done")).is_some());
        for field in ["engine", "sessionId", "sourceRunId", "runId"] {
            let mut forged = event("done");
            forged[field] = json!("foreign");
            assert!(origins.settle(&forged).is_none(), "{field}");
        }
        origins.0.remove("run");
        assert!(origins.settle(&event("done")).is_none());
    }
    #[test]
    fn interrupted_response_and_late_done_do_not_name() {
        let mut origins = fixture();
        let active = origins.settle(&event("turn_complete")).unwrap();
        let mut interrupted = event("turn_complete");
        interrupted["data"]["interrupted"] = json!(true);
        assert!(origins.settle(&interrupted).is_none());
        assert!(active.is_cancelled());
        assert!(origins.settle(&event("done")).is_none());
        let resumed = origins.settle(&event("turn_complete")).unwrap();
        assert!(!resumed.is_cancelled());
        assert!(active.is_cancelled());
    }
    #[test]
    fn rejected_reclaimed_failed_and_killed_runs_do_not_name() {
        for field in ["identityRejected", "reclaimed"] {
            let mut origins = fixture();
            let mut invalid = event("done");
            invalid["leader"] = json!({});
            invalid["leader"][field] = json!(true);
            assert!(origins.settle(&invalid).is_none());
        }
        let mut origins = fixture();
        assert!(origins.settle(&event("error")).is_none());
        assert!(origins.settle(&event("done")).is_none());
        origins = fixture();
        let source = origins.settle(&event("done")).unwrap();
        origins.0["run"].killed.store(true, Ordering::SeqCst);
        assert!(source.is_cancelled());
        assert!(origins.settle(&event("done")).is_none());
    }
    #[test]
    fn leader_children_and_native_continuations_keep_local_provenance() {
        let mut origins = fixture();
        let mut child = event("done");
        child["leader"] = json!({"branchId":"child"});
        assert!(origins.settle(&child).is_some());
        child["runId"] = json!("run-c1");
        assert!(origins.settle(&child).is_some());
        child["runId"] = json!("run-cjunk");
        assert!(origins.settle(&child).is_none());
    }
    #[test]
    fn local_workspace_rejects_remote_malformed_and_unregistered_sources() {
        let dir = std::env::temp_dir().join(format!("ccgui-title-origin-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        {
            let db = Db::open_at(&dir.join("app.db")).unwrap();
            let workspace = dir.to_string_lossy().to_string();
            assert!(!local_workspace(&db, &workspace));
            db.0.lock()
                .execute(
                    "INSERT INTO workspaces(id,path,name) VALUES('w',?1,'test')",
                    [&workspace],
                )
                .unwrap();
            assert!(local_workspace(&db, &workspace));
            for raw in [
                r#"{"wsl":false}"#,
                r#"{"wsl":{"distro":"Ubuntu"}}"#,
                "[]",
                "not-json",
            ] {
                db.0.lock()
                    .execute("UPDATE workspaces SET meta=?1 WHERE id='w'", [raw])
                    .unwrap();
                assert!(!local_workspace(&db, &workspace), "{raw}");
            }
            assert!(!local_workspace(&db, "ssh://remote/workspace"));
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
