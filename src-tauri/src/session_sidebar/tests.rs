use super::*;

fn fixture() -> Db {
    let db = Db::open_in_memory().unwrap();
    crate::leader::ensure_schema(&db).unwrap();
    db.0.lock().execute_batch("INSERT INTO workspaces(id,path,name) VALUES('a','C:/Source','Source'),('b','D:/Target','Target');
        INSERT INTO sessions(engine,session_id,workspace_path,file_path,file_size,file_mtime_ms,title)
        VALUES('codex','one','C:\\Source','original.jsonl',123,456,'First'),('claude','two','C:/Source','other.jsonl',23,56,'Second');
        INSERT INTO session_models(engine,session_id,model,updated_at) VALUES('codex','one','original-model',1);").unwrap();
    db
}

fn assignment(id: &str) -> Assignment {
    Assignment {
        engine: if id == "one" { "codex" } else { "claude" }.into(),
        session_id: id.into(),
        expected_workspace_path: "c:/Source/".into(),
        expected_sidebar_workspace_path: None,
        sidebar_workspace_path: Some("d:\\Target\\".into()),
    }
}

#[test]
fn sidebar_batch_preserves_native_identity_and_settings() {
    let db = fixture();
    let result = assign(
        &db,
        "batch".into(),
        vec![assignment("one"), assignment("two")],
    )
    .unwrap();
    assert!(!result.replayed);
    assert_eq!(result.assignments.len(), 2);
    assert_eq!(
        result.assignments[0].sidebar_workspace_path.as_deref(),
        Some("D:/Target")
    );
    let native: (String,String,i64,i64,String) = db.0.lock().query_row("SELECT workspace_path,file_path,file_size,file_mtime_ms,model FROM sessions JOIN session_models USING(engine,session_id) WHERE session_id='one'",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap();
    assert_eq!(
        native,
        (
            "C:\\Source".into(),
            "original.jsonl".into(),
            123,
            456,
            "original-model".into()
        )
    );
    let listed = crate::history::reader::list_sessions_from(&db).unwrap();
    assert_eq!(
        listed
            .iter()
            .find(|s| s.session_id == "one")
            .unwrap()
            .sidebar_workspace_path
            .as_deref(),
        Some("D:/Target")
    );
}

#[test]
fn sidebar_batch_failure_is_atomic_and_receipt_is_not_consumed() {
    let db = fixture();
    let mut bad = assignment("two");
    bad.sidebar_workspace_path = Some("Z:/missing".into());
    assert!(assign(&db, "batch".into(), vec![assignment("one"), bad]).is_err());
    assert!(list(&db)
        .unwrap()
        .iter()
        .all(|s| s.sidebar_workspace_path.is_none()));
    assert!(
        !assign(&db, "batch".into(), vec![assignment("one")])
            .unwrap()
            .replayed
    );
}

#[test]
fn sidebar_cas_and_replay_never_reapply_an_old_placement() {
    let db = fixture();
    let original = assignment("one");
    assign(&db, "first".into(), vec![original.clone()]).unwrap();
    assert!(assign(&db, "stale".into(), vec![original.clone()]).is_err());
    let mut clear = original.clone();
    clear.expected_sidebar_workspace_path = Some("d:\\Target\\".into());
    clear.sidebar_workspace_path = None;
    assign(&db, "clear".into(), vec![clear.clone()]).unwrap();
    let replay = assign(&db, "first".into(), vec![original.clone()]).unwrap();
    assert!(replay.replayed);
    assert!(replay.assignments[0].sidebar_workspace_path.is_none());
    assert!(assign(&db, "first".into(), vec![clear]).is_err());
    db.0.lock()
        .execute("DELETE FROM sessions WHERE session_id='one'", [])
        .unwrap();
    let replay = assign(&db, "first".into(), vec![original]).unwrap();
    assert!(replay.assignments.is_empty());
    assert_eq!(replay.missing[0].session_id, "one");
}

#[test]
fn sidebar_target_removal_and_session_deletion_clean_only_mapping() {
    let db = fixture();
    assign(
        &db,
        "first".into(),
        vec![assignment("one"), assignment("two")],
    )
    .unwrap();
    // A scan upsert/update refreshes native metadata without touching attribution.
    db.0.lock().execute("UPDATE sessions SET title='Rescanned',workspace_path='C:/Source' WHERE session_id='one'",[]).unwrap();
    assert!(list(&db)
        .unwrap()
        .iter()
        .all(|s| s.sidebar_workspace_path.is_some()));
    // Current host deletion explicitly clears KV in the same transaction.
    {
        let mut conn = db.0.lock();
        let tx = conn.transaction().unwrap();
        storage::delete_session(&tx, "claude", "two").unwrap();
        tx.execute("DELETE FROM sessions WHERE session_id='two'", [])
            .unwrap();
        tx.commit().unwrap();
    }
    let count: i64 =
        db.0.lock()
            .query_row(
                "SELECT COUNT(*) FROM plugin_kv WHERE plugin_id=?1",
                [storage::NAMESPACE],
                |r| r.get(0),
            )
            .unwrap();
    assert_eq!(count, 1);
    db.0.lock()
        .execute("DELETE FROM workspaces WHERE id='b'", [])
        .unwrap();
    let current = list(&db).unwrap();
    assert_eq!(current.len(), 1);
    assert!(current[0].sidebar_workspace_path.is_none());
}

#[test]
fn sidebar_rejects_archived_and_managed_children_but_allows_roots() {
    let db = fixture();
    db.0.lock().execute("INSERT INTO leader_branches(id,parent_engine,parent_session_id,workspace_path,engine,session_id,state,record_json,permission) VALUES('branch','codex','one','C:/Source','claude','two','done','{}','manual')",[]).unwrap();
    assert!(assign(&db, "child".into(), vec![assignment("two")])
        .unwrap_err()
        .contains("Managed child"));
    assign(&db, "root".into(), vec![assignment("one")]).unwrap();
    assert_eq!(list(&db).unwrap().len(), 1);
    db.0.lock().execute("INSERT INTO session_archives(engine,session_id,workspace_path,snapshot_json,archived_at) VALUES('codex','one','C:/Source','{}',1)",[]).unwrap();
    let mut root = assignment("one");
    root.expected_sidebar_workspace_path = Some("D:/Target".into());
    assert!(assign(&db, "archived".into(), vec![root])
        .unwrap_err()
        .contains("Archived"));
}

#[test]
fn sidebar_validation_requires_explicit_nullable_cas_and_unique_identities() {
    let db = fixture();
    assert!(assign(&db, "empty".into(), vec![]).is_err());
    assert!(assign(
        &db,
        "duplicate".into(),
        vec![assignment("one"), assignment("one")]
    )
    .is_err());
    let mut raw = serde_json::to_value(assignment("one")).unwrap();
    raw.as_object_mut()
        .unwrap()
        .remove("expectedSidebarWorkspacePath");
    assert!(serde_json::from_value::<Assignment>(raw).is_err());
    assert_eq!(path_key("C:\\Root\\"), path_key("c:/Root/"));
    assert_ne!(path_key("C:/Root"), path_key("C:/root"));
    assert_ne!(path_key("/Root"), path_key("/root"));
    assert_ne!(path_key("/root/"), path_key("/root"));
}

#[test]
fn sidebar_reports_all_conflicting_items_without_writing_valid_item() {
    let db = fixture();
    let mut missing = assignment("missing");
    missing.engine = "codex".into();
    let mut changed = assignment("two");
    changed.expected_workspace_path = "C:/Old".into();
    let error = assign(
        &db,
        "multi".into(),
        vec![assignment("one"), missing, changed],
    )
    .unwrap_err();
    let value: serde_json::Value = serde_json::from_str(&error).unwrap();
    assert_eq!(value["code"], "SESSION_SIDEBAR_ASSIGNMENT_CONFLICT");
    let conflicts = value["conflicts"].as_array().unwrap();
    assert_eq!(conflicts.len(), 2);
    assert!(conflicts
        .iter()
        .any(|c| c["sessionId"] == "missing" && c["code"] == "SESSION_NOT_FOUND"));
    assert!(conflicts
        .iter()
        .any(|c| c["sessionId"] == "two" && c["code"] == "EXECUTION_WORKSPACE_CHANGED"));
    assert!(list(&db)
        .unwrap()
        .iter()
        .all(|s| s.sidebar_workspace_path.is_none()));
    let receipts: i64 =
        db.0.lock()
            .query_row(
                "SELECT COUNT(*) FROM plugin_kv WHERE plugin_id=?1",
                [storage::RECEIPT_NAMESPACE],
                |r| r.get(0),
            )
            .unwrap();
    assert_eq!(receipts, 0);
}

fn placement_count(db: &Db) -> i64 {
    db.0.lock()
        .query_row(
            "SELECT COUNT(*) FROM plugin_kv WHERE plugin_id=?1",
            [storage::NAMESPACE],
            |r| r.get(0),
        )
        .unwrap()
}

#[test]
fn sidebar_unrelated_alias_registrations_do_not_break_history_listing() {
    let db = fixture();
    assign(&db, "place".into(), vec![assignment("one")]).unwrap();
    db.0.lock().execute_batch("INSERT INTO workspaces(id,path,name) VALUES('duplicate-a','E:/Other','Other'),('duplicate-b','E:\\Other','Other');").unwrap();
    let rows = crate::history::reader::list_sessions_from(&db).unwrap();
    assert_eq!(
        rows.iter()
            .find(|s| s.session_id == "one")
            .unwrap()
            .sidebar_workspace_path
            .as_deref(),
        Some("D:/Target")
    );
    let mut ambiguous = assignment("two");
    ambiguous.sidebar_workspace_path = Some("E:/Other".into());
    let error = assign(&db, "ambiguous".into(), vec![ambiguous]).unwrap_err();
    assert!(error.contains("AMBIGUOUS_TARGET"));
    assert_eq!(placement_count(&db), 1);
}

#[test]
fn sidebar_existing_placement_survives_target_alias_registration_and_removal() {
    let db = fixture();
    assign(&db, "place".into(), vec![assignment("one")]).unwrap();
    db.0.lock()
        .execute(
            "INSERT INTO workspaces(id,path,name) VALUES('alias','D:\\Target','Alias')",
            [],
        )
        .unwrap();
    let rows = crate::history::reader::list_sessions_from(&db).unwrap();
    assert_eq!(
        rows.iter()
            .find(|s| s.session_id == "one")
            .unwrap()
            .sidebar_workspace_path
            .as_deref(),
        Some("D:/Target")
    );
    assert_eq!(placement_count(&db), 1);
    assert!(assign(&db, "ambiguous".into(), vec![assignment("two")])
        .unwrap_err()
        .contains("AMBIGUOUS_TARGET"));
    {
        let mut conn = db.0.lock();
        let tx = conn.transaction().unwrap();
        storage::delete_workspace(&tx, "alias").unwrap();
        tx.execute("DELETE FROM workspaces WHERE id='alias'", [])
            .unwrap();
        tx.commit().unwrap();
    }
    let rows = list(&db).unwrap();
    assert_eq!(
        rows.iter()
            .find(|s| s.session_id == "one")
            .unwrap()
            .sidebar_workspace_path
            .as_deref(),
        Some("D:/Target")
    );
    assert_eq!(placement_count(&db), 1);
}

#[test]
fn sidebar_storage_uses_existing_kv_without_schema_changes() {
    let db = fixture();
    let schema = || {
        db.0.lock().query_row("SELECT group_concat(sql,';') FROM (SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY name)",[],|r|r.get::<_,String>(0)).unwrap()
    };
    let before = schema();
    assign(&db, "kv-only".into(), vec![assignment("one")]).unwrap();
    assert_eq!(schema(), before);
    let tables:i64=db.0.lock().query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('session_sidebar_workspaces','session_sidebar_requests')",[],|r|r.get(0)).unwrap();
    assert_eq!(tables, 0);
    assert_eq!(placement_count(&db), 1);
    assert!(storage::receipt(&db.0.lock(), "kv-only").unwrap().is_some());
}

#[test]
fn sidebar_old_worker_target_remove_and_readd_cannot_resurrect_placement() {
    let db = fixture();
    assign(&db, "place".into(), vec![assignment("one")]).unwrap();
    // Old worker only knows v3 workspaces, so it cannot clear the new KV.
    db.0.lock().execute_batch("DELETE FROM workspaces WHERE id='b'; INSERT INTO workspaces(id,path,name) VALUES('replacement','D:/Target','Target');").unwrap();
    let current = list(&db).unwrap();
    assert!(current.iter().all(|s| s.sidebar_workspace_path.is_none()));
    assert_eq!(placement_count(&db), 0);
    let replay = assign(&db, "place".into(), vec![assignment("one")]).unwrap();
    assert!(replay.replayed);
    assert!(replay.assignments[0].sidebar_workspace_path.is_none());
}

#[test]
fn sidebar_old_worker_source_remove_and_readd_cannot_resurrect_placement() {
    let db = fixture();
    assign(&db, "place".into(), vec![assignment("one")]).unwrap();
    db.0.lock().execute_batch("DELETE FROM workspaces WHERE id='a'; INSERT INTO workspaces(id,path,name) VALUES('replacement','C:/Source','Source');").unwrap();
    assert!(list(&db)
        .unwrap()
        .iter()
        .all(|s| s.sidebar_workspace_path.is_none()));
    assert_eq!(placement_count(&db), 0);
}

#[test]
fn sidebar_old_worker_deleted_session_is_pruned_before_identical_reindex() {
    let db = fixture();
    assign(&db, "place".into(), vec![assignment("one")]).unwrap();
    db.0.lock()
        .execute("DELETE FROM sessions WHERE session_id='one'", [])
        .unwrap();
    list(&db).unwrap();
    assert_eq!(placement_count(&db), 0);
    db.0.lock().execute("INSERT INTO sessions(engine,session_id,workspace_path,file_path,file_size,file_mtime_ms,title) VALUES('codex','one','C:\\Source','original.jsonl',123,456,'First')",[]).unwrap();
    assert!(list(&db)
        .unwrap()
        .iter()
        .all(|s| s.sidebar_workspace_path.is_none()));
}

#[test]
fn sidebar_native_file_replacement_invalidates_placement() {
    let db = fixture();
    assign(&db, "place".into(), vec![assignment("one")]).unwrap();
    db.0.lock()
        .execute(
            "UPDATE sessions SET file_path='replacement.jsonl' WHERE session_id='one'",
            [],
        )
        .unwrap();
    assert!(crate::history::reader::list_sessions_from(&db)
        .unwrap()
        .iter()
        .all(|s| s.sidebar_workspace_path.is_none()));
    assert_eq!(placement_count(&db), 0);
}

#[test]
fn sidebar_creation_time_enrichment_is_preserved_but_later_replacement_is_not() {
    let db = fixture();
    assign(&db, "place".into(), vec![assignment("one")]).unwrap();
    db.0.lock().execute("UPDATE sessions SET created_at=100,file_size=456,file_mtime_ms=789,updated_at=200 WHERE session_id='one'",[]).unwrap();
    let rows = list(&db).unwrap();
    assert_eq!(
        rows.iter()
            .find(|s| s.session_id == "one")
            .unwrap()
            .sidebar_workspace_path
            .as_deref(),
        Some("D:/Target")
    );
    db.0.lock()
        .execute(
            "UPDATE sessions SET created_at=101 WHERE session_id='one'",
            [],
        )
        .unwrap();
    assert!(list(&db)
        .unwrap()
        .iter()
        .all(|s| s.sidebar_workspace_path.is_none()));
    assert_eq!(placement_count(&db), 0);
}

#[test]
fn sidebar_current_host_workspace_cleanup_prevents_same_id_readd_and_keeps_receipts() {
    let db = fixture();
    assign(&db, "place".into(), vec![assignment("one")]).unwrap();
    {
        let mut conn = db.0.lock();
        let tx = conn.transaction().unwrap();
        storage::delete_workspace(&tx, "b").unwrap();
        tx.execute("DELETE FROM workspaces WHERE id='b'", [])
            .unwrap();
        tx.commit().unwrap();
    }
    assert_eq!(placement_count(&db), 0);
    db.0.lock()
        .execute(
            "INSERT INTO workspaces(id,path,name) VALUES('b','D:/Target','Target')",
            [],
        )
        .unwrap();
    let replay = assign(&db, "place".into(), vec![assignment("one")]).unwrap();
    assert!(replay.replayed);
    assert!(replay.assignments[0].sidebar_workspace_path.is_none());
}

#[test]
fn oversized_optional_paths_never_hide_conflict_identities_or_reasons() {
    let long_path = format!("C:/{}", "\\".repeat(4090));
    let conflicts = (0..100)
        .map(|index| {
            let mut item = assignment("one");
            item.session_id = format!("session-{index}");
            conflict(
                &item,
                "SIDEBAR_WORKSPACE_CHANGED",
                "Sidebar workspace changed",
                Some((&long_path, Some(&long_path))),
            )
        })
        .collect();
    let report = conflicts_error(conflicts);
    assert!(report.len() < 512 * 1024);
    let value: serde_json::Value = serde_json::from_str(&report).unwrap();
    assert_eq!(value["currentPathsOmitted"], true);
    assert_eq!(value["conflicts"].as_array().unwrap().len(), 100);
    for (index, row) in value["conflicts"].as_array().unwrap().iter().enumerate() {
        assert_eq!(row["sessionId"], format!("session-{index}"));
        assert_eq!(row["code"], "SIDEBAR_WORKSPACE_CHANGED");
    }
}
