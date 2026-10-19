use super::*;

#[test]
fn every_registered_engine_has_a_distinct_durable_completion_source() {
    let db = memory();
    for (index, engine) in crate::config::ENGINES.iter().enumerate() {
        let mut s = source("same-session");
        s.engine = (*engine).into();
        s.validate().unwrap();
        let id = format!("engine-{index}");
        let commit = db.record_completion(&pending(&id, &s, 10, 20), &s).unwrap();
        assert_eq!(commit.status, CommitStatus::Recorded, "{engine}");
        assert_eq!(db.get(&id).unwrap().unwrap().source.engine, *engine);
    }
    assert_eq!(db.unread(21).unwrap().len(), crate::config::ENGINES.len());
    let mut bad = source("same-session");
    bad.engine = "unsupported".into();
    assert!(bad.validate().is_err());
}

fn source(id: &str) -> NoticeSource {
    NoticeSource {
        engine: "codex".into(),
        session_id: id.into(),
        workspace_path: "C:/work".into(),
        label: "Project".into(),
    }
}
fn pending(id: &str, s: &NoticeSource, start: u64, end: u64) -> Pending {
    Pending {
        id: id.into(),
        engine: s.engine.clone(),
        session_id: s.session_id.clone(),
        workspace_path: s.workspace_path.clone(),
        prompt: "prompt".into(),
        summary: "done".into(),
        started_at_ms: start,
        completed_at_ms: end,
        generation: 1,
        cancel: false,
        started: false,
    }
}
fn memory() -> Arc<Store> {
    Store::open(":memory:").unwrap()
}

#[test]
fn completion_replay_preserves_read_and_rejects_mutated_payload() {
    let db = memory();
    let s = source("one");
    let p = pending("event", &s, 10, 20);
    assert_eq!(
        db.record_completion(&p, &s).unwrap().status,
        CommitStatus::Recorded
    );
    assert!(db.mark_read(&p.id).unwrap());
    let mut renamed = s.clone();
    renamed.label = "Renamed".into();
    let replay = db.record_completion(&p, &renamed).unwrap();
    assert_eq!(replay.status, CommitStatus::Duplicate);
    assert!(replay.notice.unwrap().read);
    let mut bad = p.clone();
    bad.summary = "different".into();
    assert_eq!(
        db.record_completion(&bad, &s).unwrap_err(),
        "payload_conflict"
    );
    bad = p.clone();
    bad.generation += 1;
    assert_eq!(
        db.record_completion(&bad, &s).unwrap_err(),
        "payload_conflict"
    );
}
#[test]
fn latest_order_and_old_id_dismissal() {
    let db = memory();
    let s = source("one");
    db.record_completion(&pending("old", &s, 10, 100), &s)
        .unwrap();
    db.record_completion(&pending("new", &s, 20, 30), &s)
        .unwrap();
    assert!(!db.mark_read("old").unwrap());
    assert_eq!(
        db.record_completion(&pending("late", &s, 15, 200), &s)
            .unwrap()
            .status,
        CommitStatus::Superseded
    );
    assert_eq!(db.unread(500).unwrap()[0].id, "new");
    db.record_completion(&pending("z", &s, 20, 30), &s).unwrap();
    assert_eq!(
        db.record_completion(&pending("a", &s, 20, 30), &s)
            .unwrap()
            .status,
        CommitStatus::Superseded
    );
    assert_eq!(db.history(512).unwrap().len(), 1);
}
#[test]
fn attention_is_strict_persistent_and_completion_only() {
    let path = std::env::temp_dir().join(format!("ccgui-notices-{}.sqlite", uuid::Uuid::new_v4()));
    let s = source("one");
    {
        let db = Store::open(&path).unwrap();
        db.attention(&s, 100).unwrap();
        let n = db
            .record_completion(&pending("equal", &s, 10, 100), &s)
            .unwrap()
            .notice
            .unwrap();
        assert!(!n.read);
        assert!(!db.attention(&s, 100).unwrap());
        db.add_aside("aside", &s, "turn", "Tease", "Body", 100, 8000)
            .unwrap();
        assert!(db.attention(&s, 101).unwrap());
        assert!(!db.get("aside").unwrap().unwrap().read);
        db.attention(&source("two"), 500).unwrap();
    }
    {
        let db = Store::open(&path).unwrap();
        assert!(db.get("equal").unwrap().unwrap().read);
        assert!(
            db.record_completion(
                &pending("replayed", &source("two"), 20, 499),
                &source("two")
            )
            .unwrap()
            .notice
            .unwrap()
            .read
        );
        assert!(
            !db.record_completion(&pending("future", &s, 200, 300), &s)
                .unwrap()
                .notice
                .unwrap()
                .read
        );
        assert_eq!(db.unread(400).unwrap().len(), 2);
    }
    std::fs::remove_file(path).unwrap();
}
#[test]
fn bounds_and_capacity_never_evict_unread() {
    let db = memory();
    let s = source("one");
    let mut bad = s.clone();
    bad.session_id = "bad/id".into();
    assert_eq!(bad.validate().unwrap_err(), "invalid_source");
    let mut p = pending("bad", &s, 10, 20);
    p.cancel = true;
    assert_eq!(
        db.record_completion(&p, &s).unwrap_err(),
        "invalid_completion"
    );
    p.cancel = false;
    p.summary = "界".repeat(8001);
    assert_eq!(
        db.record_completion(&p, &s).unwrap_err(),
        "invalid_completion"
    );
    for i in 0..512 {
        let s = source(&format!("s{i}"));
        db.record_completion(&pending(&format!("e{i}"), &s, 1, 2), &s)
            .unwrap();
    }
    assert_eq!(
        db.add_aside("a", &s, "t", "hello", "body", 100_000, 8000)
            .unwrap_err(),
        "inbox_capacity"
    );
    assert_eq!(db.history(1000).unwrap().len(), 512);
    db.mark_read("e0").unwrap();
    db.add_aside("a", &s, "t", "hello", "body", 100_000, 8000)
        .unwrap();
    assert!(db.get("e0").unwrap().is_none());
    assert!(db.get("e1").unwrap().is_some());
    // A pruned completion still remembers its event identity and read state.
    assert_eq!(
        db.record_completion(&pending("e0", &source("s0"), 1, 2), &source("s0"))
            .unwrap()
            .status,
        CommitStatus::Duplicate
    );
}
#[test]
fn asides_expire_pin_deduplicate_and_limit_active() {
    let db = memory();
    let s = source("one");
    db.add_aside("a", &s, "t", "  Hello\n WORLD ", "body", 100_000, 8000)
        .unwrap();
    assert_eq!(
        db.add_aside(
            "same",
            &source("two"),
            "t",
            "hello world",
            "other",
            100_001,
            8000
        )
        .unwrap()
        .status,
        CommitStatus::Duplicate
    );
    assert!(db.set_pinned("a", true, 100_001).unwrap());
    db.add_aside("b", &s, "t", "second", "body", 100_002, 8000)
        .unwrap();
    assert_eq!(
        db.add_aside("c", &s, "t", "third", "body", 100_003, 8000)
            .unwrap_err(),
        "aside_capacity"
    );
    assert!(db.expire(108_002).unwrap());
    assert!(db.get("b").unwrap().unwrap().read);
    assert!(!db.get("a").unwrap().unwrap().read);
    assert_eq!(
        db.add_aside("a", &s, "t", "  Hello\n WORLD ", "body", 100_000, 8000)
            .unwrap()
            .notice
            .unwrap()
            .pinned,
        true
    );
    db.set_pinned("a", false, 110_000).unwrap();
    assert_eq!(db.get("a").unwrap().unwrap().expires_at_ms, Some(128_000));
    db.set_expiry("a", None).unwrap();
    assert!(!db.expire(200_000).unwrap());
    db.mark_read("a").unwrap();
    assert_eq!(
        db.add_aside("new", &s, "t", "hello world", "body", 190_000, 8000)
            .unwrap()
            .status,
        CommitStatus::Recorded
    );
    assert!(!db.set_expiry("a", Some(200_000)).unwrap());
}
#[test]
fn source_identity_includes_exact_workspace_and_validates_unicode_bounds() {
    let db = memory();
    let a = source("same");
    let mut b = a.clone();
    b.workspace_path = "C:/other".into();
    db.record_completion(&pending("a", &a, 1, 2), &a).unwrap();
    db.record_completion(&pending("b", &b, 1, 2), &b).unwrap();
    db.attention(&a, 3).unwrap();
    assert_eq!(db.unread(3).unwrap()[0].id, "b");
    b.label = "界".repeat(200);
    assert!(b.validate().is_ok());
    b.label.push('界');
    assert!(b.validate().is_err());
    assert!(!db.set_pinned("b", true, 3).unwrap());
    assert!(!db.set_expiry("b", Some(4)).unwrap());
}

#[test]
fn read_source_slots_can_be_reclaimed_without_blocking_new_sources() {
    let db = memory();
    for i in 0..512 {
        let s = source(&format!("source{i}"));
        db.record_completion(&pending(&format!("event{i}"), &s, 1, 2), &s)
            .unwrap();
    }
    db.mark_read("event0").unwrap();
    let s = source("fresh");
    assert_eq!(
        db.record_completion(&pending("fresh-event", &s, 3, 4), &s)
            .unwrap()
            .status,
        CommitStatus::Recorded
    );
    assert_eq!(db.history(512).unwrap().len(), 512);
    assert!(db.get("event1").unwrap().is_some());
}

#[test]
fn dedup_includes_epoch_zero_and_exact_ninety_second_boundary() {
    let db = memory();
    let s = source("one");
    db.add_aside("zero", &s, "t", "HELLO", "body", 0, 8000)
        .unwrap();
    assert_eq!(
        db.add_aside("early", &source("two"), "t", "hello", "body", 1, 8000)
            .unwrap()
            .status,
        CommitStatus::Duplicate
    );
    assert_eq!(
        db.add_aside("boundary", &s, "t", "hello", "body", 90_000, 8000)
            .unwrap()
            .status,
        CommitStatus::Recorded
    );
}

#[test]
fn aside_persists_observer_model_and_effort_metadata() {
    let db = memory();
    let s = source("one");
    let observer = NoticeObserver {
        engine: "agy_vertex".into(),
        model: "gemini-4-argon".into(),
        effort: "medium".into(),
    };
    let commit = db
        .add_aside_with_observer(
            "aside-obs",
            &s,
            Some(&observer),
            "turn-1",
            "Tease",
            "Body",
            1000,
            18_000,
        )
        .unwrap();
    assert_eq!(commit.status, CommitStatus::Recorded);
    let stored = db.get("aside-obs").unwrap().unwrap();
    assert_eq!(stored.observer, Some(observer));
}
