use super::*;

fn inner() -> Inner {
    Inner {
        config: Config::default(),
        generation: 1,
        policy_epoch: 0,
        policy_context: None,
        fatal: None,
        configuration_error: None,
        storage_error: None,
        window_error: false,
        observer_available: true,
        observer_storage_error: false,
        observer_error: None,
        observer_route: Some([1; 32]),
        source_engines: crate::config::ENGINES
            .iter()
            .map(|engine| engine.to_string())
            .collect(),
        stopped: false,
        policy: Policy::default(),
        locale: "en".into(),
        actually_focused: false,
        document_id: String::new(),
        attention: Attention::default(),
        sources: HashMap::new(),
        focus: HashMap::new(),
        jobs: HashMap::new(),
        holds: HashMap::new(),
        dragging: false,
        last_reap: 0,
        desktop_ids: Vec::new(),
    }
}
fn source() -> NoticeSource {
    NoticeSource {
        engine: "codex".into(),
        session_id: "native-session".into(),
        workspace_path: "C:/workspace".into(),
        label: "Custom title".into(),
    }
}
fn completion(id: &str, at: u64) -> Pending {
    Pending {
        id: id.into(),
        engine: "codex".into(),
        session_id: "native-session".into(),
        workspace_path: "C:/workspace".into(),
        prompt: "Consider the current design".into(),
        summary: "Finished response".into(),
        started_at_ms: at - 10,
        completed_at_ms: at,
        generation: 1,
        cancel: false,
        started: false,
    }
}
fn inbox() -> Arc<Store> {
    Store::open(":memory:").unwrap()
}
fn focus(inner: &mut Inner, notice: &str, expires: u64) -> oneshot::Receiver<Result<(), String>> {
    let (tx, rx) = oneshot::channel();
    inner.focus.insert(
        "request".into(),
        FocusWait {
            document_id: inner.document_id.clone(),
            generation: inner.generation,
            notice_id: notice.into(),
            source_key: source().key(),
            expires,
            result: tx,
        },
    );
    rx
}

#[test]
fn configuration_is_strict_and_has_no_implicit_observer_opt_in() {
    let default = Config::default();
    assert!(default.enabled);
    assert!(!default.observer_enabled);
    assert!(!default.paused && !default.focus_mode);
    assert!(serde_json::from_str::<Persisted>(r#"{"enabled":true,"observerEnabled":false,"paused":false,"focusMode":false,"generation":1,"hostGrant":"x"}"#).is_err());
    assert!(serde_json::from_str::<Config>(
        r#"{"enabled":true,"observerEnabled":true,"paused":false,"focusMode":false,"generation":1}"#
    )
    .is_err());
}

#[tokio::test]
async fn conflicting_or_failed_settings_keep_the_live_policy_and_success_cancels_old_work() {
    let root = std::env::temp_dir().join(format!("notice-revision-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("config.json");
    let blocked = root.join("blocked");
    std::fs::write(&blocked, "not a directory").unwrap();
    let mut state = inner();
    state.config.observer_enabled = true;
    state.reconfigure(100);
    let source = source();
    let pending = completion("completion", 100);
    let store = inbox();
    store.record_completion(&pending, &source).unwrap();
    let ticket = state
        .policy
        .prepare(
            &source.key(),
            "turn",
            90,
            Service::snapshot(&source, &pending).unwrap(),
            0,
            100,
        )
        .unwrap()
        .unwrap();
    let running = tokio::spawn(std::future::pending::<()>());
    state.jobs.insert(
        source.key(),
        Job {
            ticket: ticket.clone(),
            abort: running.abort_handle(),
        },
    );
    let original = state.config.clone();
    let next = Config {
        paused: true,
        voice_enabled: false,
        observer_engine: "claude".into(),
        observer_model: String::new(),
        observer_effort: "high".into(),
        ..original.clone()
    };
    assert_eq!(
        state
            .save_preferences(&path, next.clone(), 0, 101)
            .unwrap_err(),
        "config_conflict"
    );
    assert!(!path.exists());
    assert_eq!(state.config, original);
    assert!(state.policy.current(&ticket, 101));
    assert!(!running.is_finished());
    assert_eq!(
        state
            .save_preferences(&blocked.join("config.json"), next.clone(), 1, 102)
            .unwrap_err(),
        "storage_unavailable"
    );
    assert_eq!(state.generation, 1);
    assert_eq!(state.config, original);
    assert!(state.policy.current(&ticket, 102));
    assert!(!running.is_finished());
    assert!(state.save_preferences(&path, next.clone(), 1, 103).unwrap());
    assert_eq!(state.config, next);
    assert_eq!(state.status().revision, 2);
    assert!(!state.policy.current(&ticket, 103));
    assert!(running.await.unwrap_err().is_cancelled());
    assert_eq!(read_config(&path).unwrap().config(), state.config);
    assert_eq!(
        store.get("completion").unwrap().unwrap().body,
        pending.summary
    );
    assert!(!store.get("completion").unwrap().unwrap().read);
    assert_eq!(
        state.save_preferences(&path, original, 1, 104).unwrap_err(),
        "config_conflict"
    );
    std::fs::remove_file(path).unwrap();
    std::fs::remove_file(blocked).unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[test]
fn route_changes_and_source_disable_reject_late_asides_without_losing_completions() {
    for change in ["provider", "source_disabled", "unavailable"] {
        let mut state = inner();
        state.config.observer_enabled = true;
        state.reconfigure(100);
        let source = source();
        let pending = completion("completion", 100);
        let store = inbox();
        store.record_completion(&pending, &source).unwrap();
        let candidate = Observation {
            source: source.clone(),
            snapshot: Service::snapshot(&source, &pending).unwrap(),
            started_at_ms: pending.started_at_ms,
            captured_at_ms: pending.completed_at_ms,
            policy_generation: state.policy_epoch,
            checkpoint: None,
        };
        let ticket = Service::prepare_observation(&mut state, &store, None, &candidate, 100)
            .unwrap()
            .unwrap();
        let mut engines = state.source_engines.clone();
        if change == "source_disabled" {
            engines.retain(|engine| engine != "codex");
        }
        let route = if change == "provider" {
            Some([2; 32])
        } else {
            state.observer_route
        };
        state.set_environment(change != "unavailable", route, engines, 101);
        assert!(
            !Service::commit_observation(
                &mut state, &store, None, &candidate, &ticket, "late", "body", 102
            )
            .unwrap(),
            "{change}"
        );
        assert!(store.get(&ticket.id).unwrap().is_none());
        assert!(!store.get("completion").unwrap().unwrap().read);
    }
}

#[test]
fn legacy_import_failure_remains_visible_and_explicit_save_can_recover() {
    let root =
        std::env::temp_dir().join(format!("notice-import-recovery-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let path = root.join("config.json");
    let mut state = inner();
    state.configuration_error = Some("legacy_preferences_unavailable".into());
    assert!(state.status().available);
    assert_eq!(state.status().reason, "legacy_preferences_unavailable");
    assert!(state
        .save_preferences(&path, Config::default(), 1, 100)
        .unwrap());
    assert!(state.configuration_error.is_none());
    assert_eq!(state.status().reason, "ok");
    assert_eq!(read_config(&path).unwrap().generation, 2);
    std::fs::remove_file(path).unwrap();
    std::fs::remove_dir(root).unwrap();
}

#[test]
fn recovered_old_completions_stay_durable_but_do_not_start_or_publish_asides() {
    let store = inbox();
    let outbox = Outbox::open(":memory:").unwrap();
    outbox.set_ready(7, MAX_GENERATION).unwrap();
    let recorder = completion_outbox::Recorder::new(outbox.clone());
    admitted_completion(&outbox, &recorder, "old-run", "native-session");
    let pending = outbox.pending(512).unwrap().pop().unwrap();
    let at = pending.completed_at_ms + policy::TICKET_MS;
    let mut state = inner();
    state.config.observer_enabled = true; // This may have been restored by the one-time import.
    state.reconfigure(at);
    let candidates = Service::drain(&mut state, &store, &outbox, at, &mut false).unwrap();
    assert!(outbox.pending(512).unwrap().is_empty());
    assert_eq!(candidates.len(), 1);
    assert!(!store.get(&pending.id).unwrap().unwrap().read);
    let (source, pending, policy_generation) = candidates.into_iter().next().unwrap();
    let candidate = Observation {
        snapshot: Service::snapshot(&source, &pending).unwrap(),
        source,
        started_at_ms: pending.started_at_ms,
        captured_at_ms: pending.completed_at_ms,
        policy_generation,
        checkpoint: None,
    };
    assert!(
        Service::prepare_observation(&mut state, &store, Some(&outbox), &candidate, at)
            .unwrap()
            .is_none()
    );
    // A result which started just within the old checkpoint's TTL cannot get a new
    // three-minute lifetime merely because model execution took additional time.
    let ticket = state
        .policy
        .prepare(
            &candidate.source.key(),
            &format!("{}-{}", candidate.source.key(), candidate.started_at_ms),
            candidate.started_at_ms,
            candidate.snapshot.clone(),
            0,
            at - 1,
        )
        .unwrap()
        .unwrap();
    assert!(!Service::commit_observation(
        &mut state, &store, None, &candidate, &ticket, "late", "", at
    )
    .unwrap());
    assert!(store.get(&ticket.id).unwrap().is_none());
}

#[test]
fn paused_and_replaced_generations_revoke_tickets_before_commit() {
    let mut state = inner();
    state.config.observer_enabled = true;
    state.reconfigure(100);
    let source = source();
    let pending = completion("terminal", 100);
    let snapshot = Service::snapshot(&source, &pending).unwrap();
    let ticket = state
        .policy
        .prepare(&source.key(), "turn", 90, snapshot, 0, 100)
        .unwrap()
        .unwrap();
    assert!(state.policy.current(&ticket, 101));
    state.config.paused = true;
    state.generation += 1;
    state.reconfigure(102);
    assert!(!state.policy.current(&ticket, 102));
    state.config.paused = false;
    state.reconfigure(103);
    assert!(!state.policy.current(&ticket, 103));
}

#[test]
fn reattachment_fails_waiter_and_old_document_cannot_read() {
    let store = inbox();
    store
        .record_completion(&completion("notice", 100), &source())
        .unwrap();
    let mut state = inner();
    let old_doc = state.attach();
    let mut waiter = focus(&mut state, "notice", 500);
    state.attention = Attention {
        document_id: old_doc.clone(),
        active: Some(source().key()),
        attentive: true,
        seen_at: 101,
    };
    let new_doc = state.attach();
    assert_ne!(old_doc, new_doc);
    assert_eq!(waiter.try_recv().unwrap(), Err("document_replaced".into()));
    assert!(!state.attention.attentive && state.attention.active.is_none());
    assert_eq!(
        state.acknowledge(&store, &old_doc, "request", true, true, 102),
        Err("stale_document".into())
    );
    assert!(!store.get("notice").unwrap().unwrap().read);
}

#[test]
fn old_focus_request_cannot_clear_replacement_and_failed_focus_stays_unread() {
    let store = inbox();
    store
        .record_completion(&completion("old", 100), &source())
        .unwrap();
    let mut state = inner();
    let doc = state.attach();
    let mut first = focus(&mut state, "old", 500);
    store
        .record_completion(&completion("new", 200), &source())
        .unwrap();
    assert!(!state
        .acknowledge(&store, &doc, "request", true, true, 201)
        .unwrap());
    assert_eq!(first.try_recv().unwrap(), Err("notice_unavailable".into()));
    assert!(!store.get("new").unwrap().unwrap().read);
    let mut second = focus(&mut state, "new", 500);
    assert!(!state
        .acknowledge(&store, &doc, "request", true, false, 202)
        .unwrap());
    assert_eq!(second.try_recv().unwrap(), Err("focus_failed".into()));
    assert!(!store.get("new").unwrap().unwrap().read);
}

#[test]
fn explicit_attention_before_ack_is_a_success_for_the_same_notice() {
    let store = inbox();
    store
        .record_completion(&completion("notice", 100), &source())
        .unwrap();
    let mut state = inner();
    let doc = state.attach();
    let mut waiter = focus(&mut state, "notice", 500);
    store.attention(&source(), 101).unwrap();
    assert!(state
        .acknowledge(&store, &doc, "request", true, true, 102)
        .unwrap());
    assert_eq!(waiter.try_recv().unwrap(), Ok(()));
}

#[test]
fn expired_request_and_changed_generation_never_acknowledge() {
    let store = inbox();
    store
        .record_completion(&completion("notice", 100), &source())
        .unwrap();
    let mut state = inner();
    let doc = state.attach();
    let _waiter = focus(&mut state, "notice", 500);
    assert_eq!(
        state.acknowledge(&store, &doc, "request", true, true, 500),
        Err("focus_expired".into())
    );
    state.generation += 1;
    assert_eq!(
        state.acknowledge(&store, &doc, "request", true, true, 200),
        Err("focus_expired".into())
    );
    assert!(!store.get("notice").unwrap().unwrap().read);
}

#[test]
fn hover_renewal_preserves_remaining_time_and_pin_does_not_gain_expiry() {
    let store = inbox();
    let mut state = inner();
    store
        .add_aside(
            "aside",
            &source(),
            "turn",
            "An independent thought",
            "",
            100,
            18_000,
        )
        .unwrap();
    Service::hold(&store, &mut state, "aside", true, 5100).unwrap();
    assert_eq!(store.get("aside").unwrap().unwrap().expires_at_ms, None);
    assert_eq!(state.holds["aside"].remaining, 13_000);
    Service::hold(&store, &mut state, "aside", true, 10_000).unwrap();
    assert_eq!(state.holds["aside"].remaining, 13_000);
    assert_eq!(state.holds["aside"].until, 25_000);
    Service::release_hold(&store, &mut state, "aside", 25_000).unwrap();
    assert_eq!(
        store.get("aside").unwrap().unwrap().expires_at_ms,
        Some(38_000)
    );
    Service::hold(&store, &mut state, "aside", true, 26_000).unwrap();
    store.set_pinned("aside", true, 26_001).unwrap();
    Service::release_hold(&store, &mut state, "aside", 27_000).unwrap();
    assert_eq!(store.get("aside").unwrap().unwrap().expires_at_ms, None);
    assert!(state.holds.is_empty());
}

#[test]
fn snapshot_uses_bounded_unicode_context_and_terminal_identity() {
    let mut pending = completion("terminal-checkpoint", 100);
    pending.prompt = format!("  {}  ", "中🙂".repeat(600));
    pending.summary = format!("  {}  ", "文🙂".repeat(1000));
    let snapshot = Service::snapshot(&source(), &pending).unwrap();
    assert_eq!(snapshot.checkpoint_id, "terminal-checkpoint");
    assert_eq!(snapshot.goal.chars().count(), 500);
    assert_eq!(snapshot.change.chars().count(), 1500);
    assert_eq!(snapshot.facts.len(), 1);
    assert_ne!(snapshot.goal, source().label);
}

fn admitted_completion(
    outbox: &Arc<Outbox>,
    recorder: &completion_outbox::Recorder,
    run: &str,
    session: &str,
) {
    use std::sync::atomic::AtomicBool;
    let killed = Arc::new(AtomicBool::new(false));
    assert!(recorder.register_run(
        run,
        "codex",
        "C:/workspace",
        Some(session),
        "A captured task",
        &killed
    ));
    for (seq, kind, data) in [
        (1, "delta", serde_json::json!("A durable result")),
        (2, "turn_complete", serde_json::json!({})),
    ] {
        recorder.observe_event(&serde_json::json!({"runId":run, "engine":"codex", "sessionId":session, "seq":seq, "kind":kind, "data":data})).unwrap();
    }
    assert!(!outbox.pending(512).unwrap().is_empty());
}

#[test]
fn all_admitted_completions_commit_across_policy_and_total_switch_changes() {
    for config in [
        Config {
            observer_enabled: true,
            ..Config::default()
        },
        Config {
            observer_enabled: false,
            ..Config::default()
        },
        Config {
            paused: true,
            ..Config::default()
        },
        Config {
            focus_mode: true,
            ..Config::default()
        },
        Config {
            enabled: false,
            ..Config::default()
        },
    ] {
        let outbox = Outbox::open(":memory:").unwrap();
        outbox.set_ready(7, MAX_GENERATION).unwrap();
        let recorder = completion_outbox::Recorder::new(outbox.clone());
        admitted_completion(&outbox, &recorder, "run", "native-session");
        let captured = outbox.pending(512).unwrap().pop().unwrap();
        assert_eq!(captured.generation, 7);
        let store = inbox();
        let mut state = inner();
        state.config = config.clone();
        state.generation = 42;
        state.reconfigure(now());
        if !config.enabled {
            outbox.pause().unwrap();
        }
        let mut changed = false;
        let candidates =
            Service::drain(&mut state, &store, &outbox, now() + 1, &mut changed).unwrap();
        assert!(changed);
        assert!(
            outbox.pending(512).unwrap().is_empty(),
            "an old admission generation must not get stranded"
        );
        assert_eq!(
            store.get(&captured.id).unwrap().unwrap().body,
            "A durable result"
        );
        assert!(!store.get(&captured.id).unwrap().unwrap().read);
        assert_eq!(candidates.len(), 1);
        assert_eq!(
            candidates[0].2, state.policy_epoch,
            "observer candidates capture policy revision, not admission epoch"
        );
    }
}

#[test]
fn bounded_drain_does_not_starve_old_generations_and_duplicate_commit_does_not_retry_observer() {
    let outbox = Outbox::open(":memory:").unwrap();
    let recorder = completion_outbox::Recorder::new(outbox.clone());
    for index in 0..9 {
        outbox.set_ready(20 + index, MAX_GENERATION).unwrap();
        admitted_completion(
            &outbox,
            &recorder,
            &format!("run-{index}"),
            &format!("native-{index}"),
        );
    }
    let first = outbox.pending(512).unwrap()[0].clone();
    let store = inbox();
    let mut state = inner();
    state.generation = 100;
    let source = Service::source(&state, &first);
    store.record_completion(&first, &source).unwrap();
    store.mark_read(&first.id).unwrap();
    let mut changed = false;
    let first_batch = Service::drain(&mut state, &store, &outbox, now() + 1, &mut changed).unwrap();
    assert_eq!(
        first_batch.len(),
        7,
        "a durable duplicate must ACK without creating a new observation"
    );
    assert_eq!(outbox.pending(512).unwrap().len(), 1);
    assert!(store.get(&first.id).unwrap().unwrap().read);
    let last = Service::drain(&mut state, &store, &outbox, now() + 2, &mut changed).unwrap();
    assert_eq!(last.len(), 1);
    assert!(outbox.pending(512).unwrap().is_empty());
    assert_eq!(store.history(512).unwrap().len(), 9);
}

#[test]
fn unsuccessful_domain_commit_never_acknowledges_the_owned_completion() {
    let outbox = Outbox::open(":memory:").unwrap();
    outbox.set_ready(7, MAX_GENERATION).unwrap();
    let recorder = completion_outbox::Recorder::new(outbox.clone());
    admitted_completion(&outbox, &recorder, "run", "native-session");
    let captured = outbox.pending(512).unwrap().pop().unwrap();
    let mut conflicting = captured.clone();
    conflicting.summary = "Different payload".into();
    let store = inbox();
    store.record_completion(&conflicting, &source()).unwrap();
    let mut state = inner();
    state.generation = 99;
    assert!(Service::drain(&mut state, &store, &outbox, now() + 1, &mut false).is_err());
    assert_eq!(outbox.pending(512).unwrap(), vec![captured]);
}

fn aside(store: &Store, id: &str, source: &NoticeSource, at: u64) {
    store
        .add_aside(
            id,
            source,
            id,
            &format!("Thought {id}"),
            "Supporting context",
            at,
            18_000,
        )
        .unwrap();
}

#[test]
fn switching_observer_off_clears_active_asides_but_preserves_pins_in_history_and_completions() {
    for config in [
        Config::default(),
        Config {
            observer_enabled: true,
            paused: true,
            ..Config::default()
        },
        Config {
            observer_enabled: true,
            enabled: false,
            ..Config::default()
        },
    ] {
        let store = inbox();
        store
            .record_completion(&completion("completion", 100), &source())
            .unwrap();
        aside(&store, "unpinned", &source(), 101);
        aside(&store, "pinned", &source(), 102);
        store.set_pinned("pinned", true, 103).unwrap();
        let mut state = inner();
        state.config = config;
        Service::hold(&store, &mut state, "unpinned", true, 104).unwrap();
        assert!(state.clear_disabled_asides(&store, 105).unwrap());
        assert!(state.holds.is_empty());
        assert_eq!(
            store
                .unread(105)
                .unwrap()
                .iter()
                .map(|n| n.id.as_str())
                .collect::<Vec<_>>(),
            vec!["completion"]
        );
        let pin = store.get("pinned").unwrap().unwrap();
        assert!(pin.pinned && pin.read);
        assert_eq!(recent_history(&store, None, 106).unwrap().len(), 3);
    }
}

#[test]
fn foreground_route_is_source_and_document_exact_and_does_not_mutate_store() {
    let store = inbox();
    let source = source();
    let mut other = source.clone();
    other.workspace_path = "C:/other-workspace".into();
    aside(&store, "same", &source, 100);
    aside(&store, "other", &other, 101);
    store
        .record_completion(&completion("completion", 102), &source)
        .unwrap();
    let mut state = inner();
    let doc = state.attach();
    state.actually_focused = true;
    state.attention = Attention {
        document_id: doc,
        active: Some(source.key()),
        attentive: true,
        seen_at: 103,
    };
    let ids = |state: &Inner, at| {
        state
            .desktop_notices(store.unread(at).unwrap(), at)
            .into_iter()
            .map(|n| n.id)
            .collect::<Vec<_>>()
    };
    assert_eq!(ids(&state, 104), vec!["completion", "other"]);
    assert_eq!(
        store.unread(104).unwrap().len(),
        3,
        "routing is not dismissal"
    );
    state.actually_focused = false;
    assert_eq!(ids(&state, 105).len(), 3);
    state.actually_focused = true;
    assert_eq!(
        ids(&state, 15_103).len(),
        3,
        "stale attestation cannot keep a desktop notice hidden"
    );
    state.attach();
    assert_eq!(
        ids(&state, 106).len(),
        3,
        "old document attention is revoked on attach"
    );
}

#[test]
fn history_returns_recent_asides_including_expired_and_read_plus_unread_completions_only() {
    let store = inbox();
    for index in 0..12 {
        let at = 100 + index * 20_000;
        aside(&store, &format!("aside-{index}"), &source(), at);
        store.mark_read(&format!("aside-{index}")).unwrap();
    }
    store
        .record_completion(&completion("read-completion", 250_000), &source())
        .unwrap();
    store.mark_read("read-completion").unwrap();
    let mut other_source = source();
    other_source.session_id = "other-session".into();
    let mut pending = completion("unread-completion", 260_000);
    pending.session_id = other_source.session_id.clone();
    store.record_completion(&pending, &other_source).unwrap();
    let history = recent_history(&store, None, 270_000).unwrap();
    assert_eq!(history.len(), 11);
    assert_eq!(history[0].id, "unread-completion");
    assert_eq!(history[1].id, "aside-11");
    assert_eq!(history[10].id, "aside-2");
    assert!(!history.iter().any(|n| n.id == "read-completion"));
    assert_eq!(recent_history(&store, Some(0), 270_000).unwrap().len(), 1);
    assert_eq!(
        recent_history(&store, Some(11), 270_000).unwrap_err(),
        "invalid_limit"
    );
    let created = store.get("aside-11").unwrap().unwrap().created_at_ms;
    let mut state = inner();
    let document = state.attach();
    state.config.enabled = false;
    assert!(state.open_notice(&store, "aside-11").is_ok());
    assert!(state.open_notice(&store, "unread-completion").is_ok());
    assert_eq!(
        state.open_notice(&store, "read-completion").unwrap_err(),
        "notice_unavailable"
    );
    let mut waiter = focus(&mut state, "aside-11", 300_000);
    assert!(state
        .acknowledge(&store, &document, "request", true, true, 270_001)
        .unwrap());
    assert_eq!(waiter.try_recv().unwrap(), Ok(()));
    assert_eq!(
        store.get("aside-11").unwrap().unwrap().created_at_ms,
        created
    );
    assert!(store.get("aside-11").unwrap().unwrap().read);
}

#[test]
fn a_terminal_that_replaced_its_start_fences_the_previous_observation() {
    let outbox = Outbox::open(":memory:").unwrap();
    outbox.set_ready(7, MAX_GENERATION).unwrap();
    let recorder = completion_outbox::Recorder::new(outbox.clone());
    admitted_completion(&outbox, &recorder, "run", "native-session");
    let captured = outbox.pending(512).unwrap().pop().unwrap();
    assert!(!captured.started);
    let store = inbox();
    let mut state = inner();
    state.config.observer_enabled = true;
    state.reconfigure(captured.started_at_ms - 1);
    let source = source();
    let ticket = state
        .policy
        .prepare(
            &source.key(),
            "prior-turn",
            captured.started_at_ms - 1,
            Service::snapshot(&source, &captured).unwrap(),
            0,
            captured.started_at_ms - 1,
        )
        .unwrap()
        .unwrap();
    assert!(state.policy.current(&ticket, captured.started_at_ms));
    Service::drain(&mut state, &store, &outbox, now() + 1, &mut false).unwrap();
    assert!(!state.policy.current(&ticket, now() + 1));
    assert!(outbox.pending(512).unwrap().is_empty());
}

#[test]
fn unavailable_observer_config_preserves_completion_service_and_preference_then_recovers() {
    let mut state = inner();
    state.config.observer_enabled = true;
    state.set_observer_available(false, 100);
    let status = state.status();
    assert!(status.available);
    assert!(!status.observer_available);
    assert!(status.config.observer_enabled);
    assert_eq!(
        serde_json::to_value(&status).unwrap()["observerAvailable"],
        false
    );
    let source = source();
    let pending = completion("completion", 100);
    let snapshot = Service::snapshot(&source, &pending).unwrap();
    assert!(state
        .policy
        .prepare(&source.key(), "turn", 90, snapshot.clone(), 0, 100)
        .unwrap()
        .is_none());
    let store = inbox();
    store.record_completion(&pending, &source).unwrap();
    assert_eq!(recent_history(&store, None, 101).unwrap().len(), 1);
    state.set_observer_available(true, 102);
    let ticket = state
        .policy
        .prepare(&source.key(), "turn", 90, snapshot, 0, 102)
        .unwrap()
        .unwrap();
    assert!(state.status().observer_available && state.config.observer_enabled);
    assert!(state.policy.current(&ticket, 103));
    state.set_observer_available(false, 104);
    assert!(!state.policy.current(&ticket, 104));
    state.set_observer_available(true, 105);
    assert!(
        !state.policy.current(&ticket, 105),
        "configuration recovery cannot resurrect an old result"
    );
    assert!(state.status().available && state.config.observer_enabled);
}

#[test]
fn focus_mode_suppresses_only_a_fresh_attentive_chat_in_the_current_document() {
    let at = 20_000;
    let source = source();
    let snapshot = Service::snapshot(&source, &completion("checkpoint", 100)).unwrap();
    for (name, attentive, active, current_document, seen_at, focus_mode, suppressed) in [
        (
            "settings or editor surface",
            false,
            true,
            true,
            at - 1,
            true,
            false,
        ),
        (
            "no active conversation",
            true,
            false,
            true,
            at - 1,
            true,
            false,
        ),
        ("replaced document", true, true, false, at - 1, true, false),
        (
            "expired heartbeat",
            true,
            true,
            true,
            at - 15_000,
            true,
            false,
        ),
        (
            "fresh foreground chat",
            true,
            true,
            true,
            at - 1,
            true,
            true,
        ),
        (
            "ordinary focus without focus mode",
            true,
            true,
            true,
            at - 1,
            false,
            false,
        ),
    ] {
        let mut state = inner();
        state.config.observer_enabled = true;
        state.config.focus_mode = focus_mode;
        let document = state.attach();
        state.actually_focused = true;
        state.attention = Attention {
            document_id: if current_document {
                document
            } else {
                "old-document".into()
            },
            active: active.then(|| source.key()),
            attentive,
            seen_at,
        };
        state.reconfigure(at);
        let ticket = state
            .policy
            .prepare(&source.key(), "turn", 90, snapshot.clone(), 0, at)
            .unwrap();
        assert_eq!(ticket.is_none(), suppressed, "{name}");
    }

    // Entering the chat also fences a request already admitted while another main-window
    // surface was focused; ordinary focus alone must not have suppressed that request.
    let mut state = inner();
    state.config.observer_enabled = true;
    state.config.focus_mode = true;
    let document = state.attach();
    state.actually_focused = true;
    state.reconfigure(at);
    let ticket = state
        .policy
        .prepare(&source.key(), "turn", 90, snapshot, 0, at)
        .unwrap()
        .unwrap();
    state.attention = Attention {
        document_id: document,
        active: Some(source.key()),
        attentive: true,
        seen_at: at + 1,
    };
    state.reconfigure(at + 1);
    assert!(!state.policy.current(&ticket, at + 1));
}

fn progress_setup() -> (
    Arc<Outbox>,
    completion_outbox::Recorder,
    Inner,
    Arc<Store>,
    u64,
) {
    let outbox = Outbox::open(":memory:").unwrap();
    outbox
        .set_ready(ADMISSION_GENERATION, MAX_GENERATION)
        .unwrap();
    outbox.set_observer_ready(1, MAX_GENERATION).unwrap();
    let recorder = completion_outbox::Recorder::new(outbox.clone());
    let mut state = inner();
    state.config.observer_enabled = true;
    state.reconfigure(now());
    (outbox, recorder, state, inbox(), now())
}

fn emit_progress(recorder: &completion_outbox::Recorder, run: &str, session: &str) {
    use std::sync::atomic::AtomicBool;
    let killed = Arc::new(AtomicBool::new(false));
    assert!(recorder.register_run(
        run,
        "codex",
        "C:/workspace",
        Some(session),
        &"目标🙂".repeat(300),
        &killed,
    ));
    recorder
        .observe_event(&serde_json::json!({
            "runId":run, "engine":"codex", "sessionId":session, "seq":1,
            "kind":"message", "data":{"role":"assistant", "text":"正在检查边界🙂".repeat(400)}
        }))
        .unwrap();
}

fn take_progress(state: &mut Inner, store: &Store, outbox: &Outbox, at: u64) -> Observation {
    assert!(Service::drain(state, store, outbox, at, &mut false)
        .unwrap()
        .is_empty());
    let mut candidates = Service::drain_progress(state, outbox, at).unwrap();
    assert_eq!(candidates.len(), 1);
    candidates.pop().unwrap()
}

#[test]
fn progress_is_bounded_once_only_and_never_creates_or_reads_a_completion() {
    let (outbox, recorder, mut state, store, _) = progress_setup();
    store
        .record_completion(&completion("prior-completion", 100), &source())
        .unwrap();
    emit_progress(&recorder, "run", "native-session");
    let at = now() + 1;
    let candidate = take_progress(&mut state, &store, &outbox, at);
    assert_eq!(candidate.snapshot.goal.chars().count(), 500);
    assert_eq!(candidate.snapshot.change.chars().count(), 1500);
    assert!(candidate.snapshot.facts[0].contains("任务仍在进行；不是已完成/已验证结果"));
    assert_eq!(
        candidate.snapshot.checkpoint_id,
        candidate.checkpoint.as_ref().unwrap().id
    );
    assert!(Service::drain_progress(&state, &outbox, at + 1)
        .unwrap()
        .is_empty());
    assert_eq!(store.history(512).unwrap().len(), 1);
    assert!(!store.get("prior-completion").unwrap().unwrap().read);

    let ticket = Service::prepare_observation(&mut state, &store, Some(&outbox), &candidate, at)
        .unwrap()
        .unwrap();
    assert!(Service::commit_observation(
        &mut state,
        &store,
        Some(&outbox),
        &candidate,
        &ticket,
        "An in-progress observation",
        "Still checking",
        at + 1
    )
    .unwrap());
    assert!(state.policy.finish(&ticket, at + 2));
    store.mark_read(&ticket.id).unwrap();
    assert!(
        Service::prepare_observation(&mut state, &store, Some(&outbox), &candidate, at + 120_001)
            .unwrap()
            .is_none(),
        "consumed checkpoint cannot request a second model call after cooldown"
    );
    assert!(!store.get("prior-completion").unwrap().unwrap().read);
}

#[test]
fn progress_and_terminal_share_pending_capacity_and_source_cooldown() {
    let (outbox, recorder, mut state, store, _) = progress_setup();
    emit_progress(&recorder, "run", "native-session");
    let at = now() + 1;
    let candidate = take_progress(&mut state, &store, &outbox, at);
    let ticket = Service::prepare_observation(&mut state, &store, Some(&outbox), &candidate, at)
        .unwrap()
        .unwrap();
    let terminal = |session: &str| {
        let mut pending = completion(&format!("terminal-{session}"), at);
        pending.session_id = session.into();
        pending.started_at_ms = candidate.started_at_ms;
        let source = Service::source(&state, &pending);
        Observation {
            snapshot: Service::snapshot(&source, &pending).unwrap(),
            source,
            started_at_ms: pending.started_at_ms,
            captured_at_ms: pending.completed_at_ms,
            policy_generation: 1,
            checkpoint: None,
        }
    };
    let same = terminal("native-session");
    let other = terminal("other-session");
    let third = terminal("third-session");
    assert!(
        Service::prepare_observation(&mut state, &store, Some(&outbox), &same, at + 1)
            .unwrap()
            .is_none()
    );
    assert!(
        Service::prepare_observation(&mut state, &store, Some(&outbox), &other, at + 1)
            .unwrap()
            .is_some()
    );
    assert!(
        Service::prepare_observation(&mut state, &store, Some(&outbox), &third, at + 1)
            .unwrap()
            .is_none()
    );
    assert_eq!(state.policy.pending_count(at + 1), 2);
    assert!(state.policy.finish(&ticket, at + 2));
    assert!(
        Service::prepare_observation(&mut state, &store, Some(&outbox), &same, at + 3)
            .unwrap()
            .is_none()
    );
}

#[test]
fn worker_cancel_new_turn_and_terminal_fence_progress_before_gui_drain() {
    for kind in ["cancelled", "new-turn", "turn_complete"] {
        let (outbox, recorder, mut state, store, _) = progress_setup();
        emit_progress(&recorder, "run", "native-session");
        let at = now() + 1;
        let candidate = take_progress(&mut state, &store, &outbox, at);
        let ticket =
            Service::prepare_observation(&mut state, &store, Some(&outbox), &candidate, at)
                .unwrap()
                .unwrap();
        let event = if kind == "new-turn" {
            serde_json::json!({"runId":"run-c1", "sourceRunId":"run", "engine":"codex",
                "sessionId":"native-session", "seq":2, "kind":"delta", "data":"New task output"})
        } else {
            serde_json::json!({"runId":"run", "engine":"codex", "sessionId":"native-session",
                "seq":2, "kind":kind, "data":{}})
        };
        recorder.observe_event(&event).unwrap();
        assert!(
            state.policy.current(&ticket, at + 2),
            "GUI has not drained the new event yet"
        );
        assert!(
            !Service::commit_observation(
                &mut state,
                &store,
                Some(&outbox),
                &candidate,
                &ticket,
                "Stale observation",
                "",
                at + 2
            )
            .unwrap(),
            "{kind}"
        );
        assert!(store.history(512).unwrap().is_empty(), "{kind}");
    }
}

#[test]
fn progress_result_rechecks_policy_for_settings_stop_provider_and_focus() {
    for change in ["generation", "paused", "stopped", "provider", "focus"] {
        let (outbox, recorder, mut state, store, _) = progress_setup();
        emit_progress(&recorder, "run", "native-session");
        let at = now() + 1;
        let candidate = take_progress(&mut state, &store, &outbox, at);
        let ticket =
            Service::prepare_observation(&mut state, &store, Some(&outbox), &candidate, at)
                .unwrap()
                .unwrap();
        match change {
            "generation" => state.generation += 1,
            "paused" => state.config.paused = true,
            "stopped" => state.stopped = true,
            "provider" => state.observer_available = false,
            "focus" => {
                state.config.focus_mode = true;
                let document_id = state.attach();
                state.actually_focused = true;
                state.attention = Attention {
                    document_id,
                    active: Some(source().key()),
                    attentive: true,
                    seen_at: at + 1,
                };
            }
            _ => unreachable!(),
        }
        assert!(
            !Service::commit_observation(
                &mut state,
                &store,
                Some(&outbox),
                &candidate,
                &ticket,
                "No longer current",
                "",
                at + 2
            )
            .unwrap(),
            "{change}"
        );
        assert!(store.history(512).unwrap().is_empty());
    }
}

#[test]
fn bounded_progress_drain_acks_old_policy_without_touching_completion_queue() {
    let (outbox, recorder, mut state, store, _) = progress_setup();
    for index in 0..9 {
        emit_progress(
            &recorder,
            &format!("run-{index}"),
            &format!("session-{index}"),
        );
    }
    let at = now() + 1;
    assert_eq!(outbox.observer_pending(64, at).unwrap().len(), 9);
    state.generation += 1;
    state.reconfigure(at);
    assert!(Service::drain_progress(&state, &outbox, at)
        .unwrap()
        .is_empty());
    assert_eq!(outbox.observer_pending(64, at).unwrap().len(), 1);
    assert!(Service::drain_progress(&state, &outbox, at + 1)
        .unwrap()
        .is_empty());
    assert!(outbox.observer_pending(64, at + 1).unwrap().is_empty());
    assert_eq!(outbox.pending(512).unwrap().len(), 9);
    assert!(store.history(512).unwrap().is_empty());
}

#[test]
fn transient_revocation_and_locale_changes_never_revive_delayed_candidates() {
    for transition in ["pause", "provider", "focus", "locale"] {
        let (outbox, recorder, mut state, store, _) = progress_setup();
        emit_progress(&recorder, "consumed-run", "native-session");
        let at = now() + 1;
        let candidate = take_progress(&mut state, &store, &outbox, at);
        emit_progress(&recorder, "queued-run", "other-session");
        let old_epoch = state.policy_epoch;
        let config_generation = state.generation;
        match transition {
            "pause" => state.config.paused = true,
            "provider" => state.observer_available = false,
            "focus" => {
                state.config.focus_mode = true;
                let document_id = state.attach();
                state.actually_focused = true;
                state.attention = Attention {
                    document_id,
                    active: Some(source().key()),
                    attentive: true,
                    seen_at: at + 1,
                };
            }
            "locale" => state.locale = "zh-CN".into(),
            _ => unreachable!(),
        }
        state.reconfigure(at + 1);
        assert_ne!(state.policy_epoch, old_epoch);
        outbox.set_observer_ready(state.policy_epoch, 0).unwrap();
        assert!(outbox.observer_pending(8, at + 1).unwrap().is_empty());
        state.config.paused = false;
        state.observer_available = true;
        state.attention.attentive = false;
        state.locale = "en".into();
        state.reconfigure(at + 2);
        assert_eq!(state.generation, config_generation);
        outbox
            .set_observer_ready(state.policy_epoch, MAX_GENERATION)
            .unwrap();
        assert!(
            Service::prepare_observation(&mut state, &store, Some(&outbox), &candidate, at + 3)
                .unwrap()
                .is_none(),
            "{transition}: already-consumed delayed candidate must not revive"
        );
        let resumed_epoch = state.policy_epoch;
        state.reconfigure(at + 4);
        assert_eq!(
            state.policy_epoch, resumed_epoch,
            "ordinary ticks must not revoke valid work"
        );
    }
}

#[test]
fn optional_progress_storage_failure_preserves_completion_delivery_and_recovers() {
    for observer_enabled in [false, true] {
        for fault in ["missing-table", "delete-trigger"] {
            let path = std::env::temp_dir().join(format!(
                "ccgui-progress-fault-{}.sqlite",
                uuid::Uuid::new_v4()
            ));
            let outbox = Outbox::open(&path).unwrap();
            outbox
                .set_ready(ADMISSION_GENERATION, MAX_GENERATION)
                .unwrap();
            outbox.set_observer_ready(1, MAX_GENERATION).unwrap();
            let recorder = completion_outbox::Recorder::new(outbox.clone());
            emit_progress(&recorder, "progress-run", "progress-session");
            let connection = rusqlite::Connection::open(&path).unwrap();
            match fault {
                "missing-table" => connection.execute_batch("DROP TABLE observer_readiness;").unwrap(),
                "delete-trigger" => connection.execute_batch(
                    "CREATE TRIGGER reject_progress_delete BEFORE DELETE ON observer_checkpoints BEGIN SELECT RAISE(ABORT, 'synthetic progress failure'); END;"
                ).unwrap(),
                _ => unreachable!(),
            }
            let mut state = inner();
            state.config.observer_enabled = observer_enabled;
            state.reconfigure(now());
            let store = inbox();
            admitted_completion(&outbox, &recorder, "terminal-run", "native-session");
            let at = now() + 1;
            assert_eq!(
                Service::drain(&mut state, &store, &outbox, at, &mut false)
                    .unwrap()
                    .len(),
                1
            );
            assert!(Service::progress_cycle(&mut state, &outbox, at).is_empty());
            assert!(
                state.observer_storage_error,
                "{fault}, enabled={observer_enabled}"
            );
            assert!(state.status().available);
            assert!(!state.status().observer_available);
            assert!(state.storage_error.is_none() && state.fatal.is_none());
            assert!(outbox.pending(512).unwrap().is_empty());
            let completions = store.unread(at).unwrap();
            assert_eq!(completions.len(), 1);
            assert_eq!(completions[0].kind, NoticeKind::Completion);
            assert!(!completions[0].read);

            // Optional observer failure leaves completion admission live for the next task too.
            admitted_completion(&outbox, &recorder, "next-terminal", "next-session");
            assert_eq!(
                Service::drain(&mut state, &store, &outbox, now() + 1, &mut false)
                    .unwrap()
                    .len(),
                1
            );
            assert_eq!(store.unread(now() + 1).unwrap().len(), 2);
            match fault {
                "missing-table" => connection.execute_batch(
                    "CREATE TABLE observer_readiness (singleton INTEGER PRIMARY KEY CHECK(singleton=1), format INTEGER NOT NULL CHECK(format=1), generation INTEGER NOT NULL, ready_until_ms INTEGER NOT NULL); INSERT INTO observer_readiness VALUES(1,1,0,0);"
                ).unwrap(),
                "delete-trigger" => connection.execute_batch("DROP TRIGGER reject_progress_delete;").unwrap(),
                _ => unreachable!(),
            }
            assert!(Service::progress_cycle(&mut state, &outbox, now() + 1).is_empty());
            assert!(!state.observer_storage_error);
            assert!(state.status().observer_available && state.status().available);
            assert_eq!(state.config.observer_enabled, observer_enabled);
            drop(connection);
            drop(recorder);
            drop(outbox);
            std::fs::remove_file(path).unwrap();
        }
    }
}

#[test]
fn expired_progress_is_acknowledged_without_domain_changes() {
    let (outbox, recorder, mut state, store, _) = progress_setup();
    emit_progress(&recorder, "run", "native-session");
    let checkpoint = outbox
        .observer_pending(8, now() + 1)
        .unwrap()
        .pop()
        .unwrap();
    let at = checkpoint.captured_at_ms + 180_001;
    assert!(Service::drain_progress(&state, &outbox, at)
        .unwrap()
        .is_empty());
    assert!(outbox.observer_pending(8, at).unwrap().is_empty());
    assert!(store.history(512).unwrap().is_empty());
    // Expiry is also checked if a copy was already consumed but waited before dispatch.
    let candidate = Service::progress_observation(&state, checkpoint).unwrap();
    assert!(
        Service::prepare_observation(&mut state, &store, Some(&outbox), &candidate, at)
            .unwrap()
            .is_none()
    );
}
