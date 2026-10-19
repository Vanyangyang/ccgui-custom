use super::*;

fn policy() -> Policy {
    let mut policy = Policy::default();
    policy.configure(1, true, false, false, false, "en", 0);
    policy
}

fn snapshot(id: &str) -> Snapshot {
    Snapshot {
        checkpoint_id: id.into(),
        project: "项目🙂".into(),
        goal: "goal".into(),
        change: id.into(),
        facts: vec!["fact".into()],
    }
}

fn prepare(
    policy: &mut Policy,
    source: &str,
    turn: &str,
    start: u64,
    id: &str,
    now: u64,
) -> Option<Ticket> {
    policy
        .prepare(source, turn, start, snapshot(id), 0, now)
        .unwrap()
}

#[test]
fn new_turn_invalidates_and_old_start_cannot_replace_it() {
    let mut p = policy();
    let old = prepare(&mut p, "source", "one", 1, "a", 1).unwrap();
    assert!(p.begin("source", "two", 2, 2));
    assert!(!p.current(&old, 2));
    assert!(!p.begin("source", "one", 1, 3));
    assert!(prepare(&mut p, "source", "two", 2, "b", 120000).is_none());
    let new = prepare(&mut p, "source", "two", 2, "b", 120001).unwrap();
    assert!(!p.finish(&old, 120002));
    assert!(p.current(&new, 120002));
    assert!(p.finish(&new, 120002));
    assert!(!p.finish(&new, 120002));
}

#[test]
fn cancellation_preserves_cooldown_and_exact_ticket_identity() {
    let mut p = policy();
    let ticket = prepare(&mut p, "s", "t", 0, "a", 0).unwrap();
    let mut altered = ticket.clone();
    altered.snapshot.goal = "forged".into();
    assert!(!p.finish(&altered, 0));
    p.cancel("s", 1);
    assert!(!p.finish(&ticket, 1));
    assert!(prepare(&mut p, "s", "t", 0, "b", 119999).is_none());
    assert!(prepare(&mut p, "s", "t", 0, "b", 120000).is_some());
}

#[test]
fn focus_pause_locale_and_settings_revalidate() {
    for transition in 0..5 {
        let mut p = policy();
        let t = prepare(&mut p, "s", "t", 0, "a", 0).unwrap();
        match transition {
            0 => p.configure(1, true, true, false, false, "en", 1),
            1 => p.configure(1, true, false, true, true, "en", 1),
            2 => p.configure(1, true, false, false, false, "zh", 1),
            3 => p.configure(2, true, false, false, false, "en", 1),
            _ => p.configure(1, false, false, false, false, "en", 1),
        }
        assert!(!p.finish(&t, 1));
        p.configure(1, true, false, false, false, "en", 2);
        assert!(!p.finish(&t, 2), "reenabling cannot resurrect a ticket");
    }
    let mut p = policy();
    let t = prepare(&mut p, "s", "t", 0, "a", 0).unwrap();
    p.configure(1, true, false, false, true, "en", 1);
    assert!(p.current(&t, 1), "ordinary focus must not suppress");
    p.configure(1, true, false, true, false, "en", 2);
    assert!(
        p.finish(&t, 2),
        "same effective allow state preserves ticket"
    );
}

#[test]
fn ttl_boundary_and_no_automatic_retry() {
    let mut p = policy();
    let t = prepare(&mut p, "s", "t", 0, "a", 0).unwrap();
    assert!(p.current(&t, 179999));
    assert!(!p.current(&t, 180000));
    assert!(!p.finish(&t, 180000));
    assert_eq!(p.pending_count(180000), 0);
    assert!(prepare(&mut p, "s", "t", 0, "a", 180000).is_none());
    assert!(prepare(&mut p, "s", "t", 0, "b", 180000).is_some());
}

#[test]
fn normalization_context_and_checkpoint_deduplication() {
    let mut p = policy();
    let t = prepare(&mut p, "s", "t", 0, "a", 0).unwrap();
    assert!(p.finish(&t, 0)); // An empty model response is still a completed attempt.
    let mut same = snapshot("new-id");
    same.change = " a \n".into();
    same.project = " 项目🙂 ".into();
    assert!(p.prepare("s", "t", 0, same, 0, 120000).unwrap().is_none());
    let mut same_id = snapshot("a");
    same_id.change = "entirely different".into();
    assert!(p
        .prepare("s", "t", 0, same_id, 0, 120000)
        .unwrap()
        .is_none());
    assert!(prepare(&mut p, "s", "t", 0, "b", 120000).is_some());
}

#[test]
fn capacity_idle_pruning_and_active_limit() {
    let mut p = policy();
    for i in 0..64 {
        assert!(p.begin(&format!("s{i}"), "t", 0, 0));
    }
    assert_eq!(p.source_count(), 64);
    assert!(!p.begin("overflow", "t", 0, IDLE_MS - 1));
    assert!(p.begin("fresh", "t", 0, IDLE_MS));
    assert_eq!(p.source_count(), 1);
    let a = p
        .prepare("a", "t", 0, snapshot("a"), 1, IDLE_MS)
        .unwrap()
        .unwrap();
    assert!(p
        .prepare("b", "t", 0, snapshot("b"), 1, IDLE_MS)
        .unwrap()
        .is_none());
    let b = p
        .prepare("b", "t", 0, snapshot("b"), 0, IDLE_MS)
        .unwrap()
        .unwrap();
    assert_eq!(p.pending_count(IDLE_MS), 2);
    assert!(p
        .prepare("c", "t", 0, snapshot("c"), 0, IDLE_MS)
        .unwrap()
        .is_none());
    assert!(p.finish(&a, IDLE_MS));
    assert!(p.finish(&b, IDLE_MS));
    assert!(p
        .prepare("c", "t", 0, snapshot("c"), usize::MAX, IDLE_MS)
        .unwrap()
        .is_none());
}

#[test]
fn invalid_input_is_inert_and_limits_count_unicode_characters() {
    let mut p = policy();
    let t = prepare(&mut p, "s", "one", 0, "a", 0).unwrap();
    let mut invalid = snapshot("bad");
    invalid.goal = " ".into();
    assert!(p.prepare("s", "two", 1, invalid, 0, 1).is_err());
    assert!(p.current(&t, 1));
    assert_eq!(p.source_count(), 1);
    let mut valid = snapshot("b");
    valid.project = "🙂".repeat(200);
    valid.goal = "字".repeat(500);
    valid.change = "字".repeat(1500);
    valid.facts = vec!["字".repeat(500); 4];
    valid.checkpoint_id = "字".repeat(160);
    assert!(valid.clone().normalized().is_ok());
    valid.project.push('字');
    assert!(valid.normalized().is_err());
    for kind in 0..5 {
        let mut invalid = snapshot("x");
        match kind {
            0 => invalid.checkpoint_id = "x".repeat(161),
            1 => invalid.goal = "x".repeat(501),
            2 => invalid.change = "x".repeat(1501),
            3 => invalid.facts = vec!["x".into(); 5],
            _ => invalid.facts = vec![" ".into()],
        }
        assert!(invalid.normalized().is_err());
    }
}

#[test]
fn saturating_timestamps_do_not_wrap_or_panic() {
    let mut p = policy();
    let t = prepare(&mut p, "s", "t", u64::MAX - 1, "a", u64::MAX - 1).unwrap();
    assert!(p.current(&t, u64::MAX - 1));
    assert!(!p.current(&t, u64::MAX));
    p.cancel("s", u64::MAX);
    assert!(prepare(&mut p, "s", "t", u64::MAX - 1, "b", 0).is_none());
}
