//! Read-only update diagnostics. Registration and reader state are observations,
//! not OS liveness checks or permission to retire a run.
use super::*;
use crate::engine::{ChildEntry, ProcessRegistry};
use crate::live_update::channel::Owner;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BlockerDetail {
    reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    engine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    plugin_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<&'static str>,
}

#[derive(Debug, Default)]
pub(crate) struct BlockerSnapshot {
    pub(crate) blockers: Vec<String>,
    pub(crate) details: Vec<BlockerDetail>,
}

impl BlockerSnapshot {
    fn add(&mut self, reason: &str, run_id: Option<&str>, state: Option<&'static str>, owners: &[Owner]) {
        let owner = run_id.and_then(|id| owners.iter().find(|owner| owner.run_id == id));
        self.blockers.push(reason.into());
        self.details.push(BlockerDetail {
            reason: reason.into(), run_id: run_id.map(str::to_owned),
            engine: owner.map(|owner| owner.engine.clone()),
            session_id: owner.and_then(|owner| owner.session_id.clone()), plugin_id: None, state,
        });
    }

    pub(crate) fn add_plugin_process(&mut self, plugin_id: Option<&str>) {
        self.blockers.push("plugin-processes".into());
        self.details.push(BlockerDetail {
            reason: "plugin-processes".into(), plugin_id: plugin_id.map(str::to_owned),
            run_id: None, engine: None, session_id: None, state: None,
        });
    }

    fn normalize(&mut self) {
        self.blockers.sort();
        self.blockers.dedup();
        self.details.sort_by(|a, b| (&a.reason, &a.run_id, &a.plugin_id).cmp(&(&b.reason, &b.run_id, &b.plugin_id)));
        self.details.dedup_by(|a, b| a.reason == b.reason && a.run_id == b.run_id && a.plugin_id == b.plugin_id);
    }
}

fn registry_snapshot(
    entries: Result<&HashMap<String, ChildEntry>, ()>,
    managed: &HashSet<String>,
    owners: &[Owner],
) -> BlockerSnapshot {
    let mut snapshot = BlockerSnapshot::default();
    match entries {
        Ok(entries) => {
            for entry in entries.values().filter(|entry| !managed.contains(&entry.run_id)) {
                let state = if entry.reader_abort.get().is_some_and(|reader| reader.is_finished()) {
                    "reader-finished"
                } else if entry.killed.load(Ordering::SeqCst) {
                    "stopping"
                } else if entry.pid == 0 {
                    "starting"
                } else {
                    "registered"
                };
                snapshot.add("legacy-runs", Some(&entry.run_id), Some(state), owners);
            }
        }
        Err(()) => snapshot.add("legacy-runs", None, Some("registry-unavailable"), owners),
    }
    snapshot.normalize();
    snapshot
}

pub(crate) async fn blocker_snapshot(registry: &ProcessRegistry) -> BlockerSnapshot {
    let Some(owner) = host() else {
        let mut snapshot = BlockerSnapshot::default();
        snapshot.add("worker-unavailable", None, None, &[]);
        return snapshot;
    };
    let routes: Vec<_> = owner.workers.lock().unwrap_or_else(|p| p.into_inner())
        .values().cloned().collect();
    let managed = routes.iter().map(|route| route.client.manifest().run_id.clone()).collect();
    let owners = crate::host_chat::active_runs_snapshot().map(|snapshot| snapshot.owners).unwrap_or_default();
    // Release the registry lock before asking workers for status.
    let mut snapshot = match registry.0.lock() {
        Ok(entries) => registry_snapshot(Ok(&entries), &managed, &owners),
        Err(_) => registry_snapshot(Err(()), &managed, &owners),
    };
    for route in routes {
        if !route.native_complete.load(Ordering::SeqCst)
            && crate::leader::managed_worker_is_starting(&route.client.manifest().run_id)
        {
            snapshot.add("worker-task-starting", Some(&route.client.manifest().run_id), Some("starting"), &owners);
        }
        if route.observation_fault.load(Ordering::SeqCst) {
            snapshot.add("worker-coordinator-fault", Some(&route.client.manifest().run_id), None, &owners);
        }
        if !route.native_complete.load(Ordering::SeqCst)
            && crate::leader::is_managed_child(&route.client.manifest().run_id)
            && registry.get(&route.client.manifest().run_id).is_some_and(|entry| entry.killed.load(Ordering::SeqCst))
        {
            // Cancellation revokes the relay capability immediately. Until its
            // final tail is projected, there is intentionally no authority to
            // restore into a replacement coordinator.
            snapshot.add("worker-stop-pending", Some(&route.client.manifest().run_id), Some("stopping"), &owners);
        }
        if route.archived.load(Ordering::SeqCst) { continue; }
        let run_id = &route.client.manifest().run_id;
        match tokio::time::timeout(Duration::from_secs(3),
            route.client.request(&uuid::Uuid::new_v4().to_string(), Command::Status)).await {
            Ok(Ok(status)) => {
                if status["journalFault"] == true || status["receiptFault"] == true {
                    snapshot.add("worker-journal-fault", Some(run_id), None, &owners);
                }
            }
            _ => snapshot.add("worker-unavailable", Some(run_id), None, &owners),
        }
    }
    snapshot.normalize();
    snapshot
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_services_preserve_every_owner_and_unscoped_activity() {
        let mut snapshot = BlockerSnapshot::default();
        snapshot.add_plugin_process(Some("workbench"));
        snapshot.add_plugin_process(Some("other-plugin"));
        snapshot.add_plugin_process(None);
        snapshot.normalize();
        assert_eq!(snapshot.blockers, ["plugin-processes"]);
        assert_eq!(serde_json::to_value(&snapshot.details).unwrap(), json!([
            {"reason":"plugin-processes"},
            {"reason":"plugin-processes", "pluginId":"other-plugin"},
            {"reason":"plugin-processes", "pluginId":"workbench"}
        ]));
    }

    #[test]
    fn aliases_are_deduplicated_and_managed_runs_are_excluded() {
        let entry = ChildEntry::worker_proxy("legacy", 100);
        let entries = HashMap::from([
            ("legacy".into(), entry.clone()), ("session".into(), entry),
            ("managed".into(), ChildEntry::worker_proxy("managed", 200)),
        ]);
        let owners = vec![Owner { run_id: "legacy".into(), engine: "codex".into(),
            session_id: Some("session".into()), workspace_path: "private-workspace".into() }];
        let snapshot = registry_snapshot(Ok(&entries), &HashSet::from(["managed".into()]), &owners);
        assert_eq!(snapshot.blockers, ["legacy-runs"]);
        assert_eq!(snapshot.details.len(), 1);
        assert_eq!(serde_json::to_value(&snapshot.details[0]).unwrap(), json!({
            "reason":"legacy-runs", "runId":"legacy", "engine":"codex", "sessionId":"session", "state":"registered"
        }));
    }

    #[tokio::test]
    async fn reports_observed_lifetime_without_removing_entries() {
        let starting = ChildEntry::worker_proxy("starting", 0);
        let stopping = ChildEntry::worker_proxy("stopping", 0);
        stopping.killed.store(true, Ordering::SeqCst);
        let finished = ChildEntry::worker_proxy("finished", 100);
        let reader = tokio::spawn(async {});
        finished.reader_abort.set(reader.abort_handle()).unwrap();
        reader.await.unwrap();
        let virtual_run = ChildEntry::worker_proxy("virtual", u32::MAX / 2);
        let entries: HashMap<_, _> = [starting, stopping, finished, virtual_run].into_iter()
            .map(|entry| (entry.run_id.clone(), entry)).collect();
        let snapshot = registry_snapshot(Ok(&entries), &HashSet::new(), &[]);
        let states: HashMap<_, _> = snapshot.details.iter()
            .map(|detail| (detail.run_id.as_deref().unwrap(), detail.state.unwrap())).collect();
        assert_eq!(states["starting"], "starting");
        assert_eq!(states["stopping"], "stopping");
        assert_eq!(states["finished"], "reader-finished");
        assert_eq!(states["virtual"], "registered");
        assert_eq!(entries.len(), 4);
        assert_eq!(snapshot.blockers, ["legacy-runs"]);
    }

    #[test]
    fn unavailable_registry_remains_blocking_without_inventing_a_run() {
        let snapshot = registry_snapshot(Err(()), &HashSet::new(), &[]);
        assert_eq!(snapshot.blockers, ["legacy-runs"]);
        assert_eq!(serde_json::to_value(&snapshot.details).unwrap(), json!([
            {"reason":"legacy-runs", "state":"registry-unavailable"}
        ]));
    }

    #[test]
    fn worker_faults_keep_each_run_and_one_reason() {
        let mut snapshot = BlockerSnapshot::default();
        snapshot.add("worker-unavailable", Some("worker-b"), None, &[]);
        snapshot.add("worker-unavailable", Some("worker-a"), None, &[]);
        snapshot.normalize();
        assert_eq!(snapshot.blockers, ["worker-unavailable"]);
        assert_eq!(snapshot.details.len(), 2);
        assert_eq!(snapshot.details[0].run_id.as_deref(), Some("worker-a"));
    }
}
