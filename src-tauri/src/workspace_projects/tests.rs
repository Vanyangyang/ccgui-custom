use super::*;
use rusqlite::params;
use std::path::PathBuf;

struct Fixture {
    root: PathBuf,
    conn: Connection,
}
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("ccgui-project-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("nested")).unwrap();
        let conn = Connection::open(root.join("projects.sqlite")).unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
            CREATE TABLE workspaces(id TEXT PRIMARY KEY,path TEXT,meta TEXT);
            CREATE TABLE sessions(id TEXT PRIMARY KEY,workspace TEXT);
            CREATE TABLE granted_roots(path TEXT);
            CREATE TABLE plugin_kv(plugin_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(plugin_id,key));
            INSERT INTO sessions VALUES('history','unchanged');
            INSERT INTO granted_roots VALUES('unchanged');",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO workspaces VALUES('registered',?1,NULL)",
            [root.to_str().unwrap()],
        )
        .unwrap();
        migrate_legacy(&conn).unwrap();
        Self { root, conn }
    }
    fn input(&self) -> ProjectInput {
        let path = self.root.to_str().unwrap().to_string();
        ProjectInput {
            id: None,
            name: "Project".into(),
            default_path: path.clone(),
            members: vec![
                ProjectMemberInput {
                    id: "root".into(),
                    path,
                    label: "Development".into(),
                    role: MemberRole::Development,
                },
                ProjectMemberInput {
                    id: "nested".into(),
                    path: self.root.join("nested").to_str().unwrap().into(),
                    label: "Reference".into(),
                    role: MemberRole::Reference,
                },
            ],
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        // Close SQLite before removing this uniquely owned fixture directory.
        let conn = std::mem::replace(&mut self.conn, Connection::open_in_memory().unwrap());
        drop(conn);
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn persistence_update_delete_preserve_workspace_history_and_grants() {
    let mut f = Fixture::new();
    let input = f.input();
    let first = save_inner(&mut f.conn, input.clone(), None).unwrap();
    assert_eq!(first.members.len(), 2); // Ancestor and child are distinct valid members.
    let reopened = Connection::open(f.root.join("projects.sqlite")).unwrap();
    assert_eq!(list_inner(&reopened).unwrap()[0].id, first.id);
    drop(reopened);
    let mut update = input;
    update.id = Some(first.id.clone());
    update.name = "Renamed".into();
    assert_eq!(
        save_inner(&mut f.conn, update, None).unwrap().name,
        "Renamed"
    );
    remove_inner(&f.conn, &first.id).unwrap();
    assert!(list_inner(&f.conn).unwrap().is_empty());
    assert!(
        storage::read(&f.conn).unwrap().is_empty(),
        "project and its members are removed atomically"
    );
    let development_tables: i64 = f.conn.query_row("SELECT COUNT(*) FROM sqlite_schema WHERE name IN ('workspace_projects','workspace_project_members')", [], |r| r.get(0)).unwrap();
    assert_eq!(
        development_tables, 0,
        "normal saves never add shared-schema tables"
    );
    for table in ["sessions", "workspaces", "granted_roots"] {
        let count: i64 = f
            .conn
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
    let history: String = f
        .conn
        .query_row("SELECT workspace FROM sessions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(history, "unchanged");
}

#[test]
fn validates_duplicates_default_and_bounds() {
    let mut f = Fixture::new();
    let mut input = f.input();
    input.members[1].path = input.members[0].path.clone();
    assert!(save_inner(&mut f.conn, input, None)
        .unwrap_err()
        .contains("duplicate member directory"));
    let mut input = f.input();
    input.members[1].id = input.members[0].id.clone();
    assert!(save_inner(&mut f.conn, input, None)
        .unwrap_err()
        .contains("duplicate member id"));
    let mut input = f.input();
    input.default_path = f.root.join("missing").to_str().unwrap().into();
    assert!(save_inner(&mut f.conn, input, None)
        .unwrap_err()
        .contains("defaultPath"));
    let mut input = f.input();
    input.members = vec![input.members[0].clone(); 33];
    assert!(save_inner(&mut f.conn, input, None)
        .unwrap_err()
        .contains("32"));
    let mut input = f.input();
    input.name = " ".into();
    assert!(save_inner(&mut f.conn, input, None).is_err());
}

#[test]
fn rejects_unregistered_remote_relative_and_new_missing_members() {
    let mut f = Fixture::new();
    for path in [
        "relative/path".to_owned(),
        "\\\\wsl.localhost\\Ubuntu\\home".into(),
        "ssh://host/work".into(),
        f.root.join("missing").to_str().unwrap().into(),
        std::env::temp_dir().to_str().unwrap().into(),
    ] {
        let mut input = f.input();
        input.default_path = path.clone();
        input.members[0].path = path;
        assert!(save_inner(&mut f.conn, input, None).is_err());
    }
    f.conn
        .execute(
            "UPDATE workspaces SET meta=?1",
            [r#"{"wsl":{"host":"test"}}"#],
        )
        .unwrap();
    let input = f.input();
    assert!(save_inner(&mut f.conn, input, None).is_err());
    assert!(!covered("/repo-other/child", &["/repo".into()]));
    assert!(covered("/repo/child", &["/repo".into()]));
}

#[test]
fn missing_default_is_retained_without_fallback_and_can_be_renamed() {
    let mut f = Fixture::new();
    let mut input = f.input();
    input.default_path = input.members[1].path.clone();
    let project = save_inner(&mut f.conn, input.clone(), None).unwrap();
    std::fs::remove_dir(f.root.join("nested")).unwrap();
    let listed = list_inner(&f.conn).unwrap().remove(0);
    assert_eq!(listed.members[1].status, MemberStatus::Missing);
    assert_eq!(listed.default_path, input.default_path);
    input.id = Some(project.id);
    input.members[1].label = "Offline reference".into();
    let saved = save_inner(&mut f.conn, input, None).unwrap();
    assert_eq!(saved.members[1].status, MemberStatus::Missing);
}

#[test]
fn source_owner_updates_are_stable_and_cannot_cross_owners() {
    let mut f = Fixture::new();
    let input = f.input();
    let project = save_inner(&mut f.conn, input.clone(), Some(("plugin-a", "source"))).unwrap();
    let again = save_inner(&mut f.conn, input.clone(), Some(("plugin-a", "source"))).unwrap();
    assert_eq!(project.id, again.id);
    let mut hijack = input.clone();
    hijack.id = Some(project.id.clone());
    assert!(save_inner(&mut f.conn, hijack.clone(), None).is_err());
    assert!(save_inner(&mut f.conn, hijack, Some(("plugin-b", "source"))).is_err());
    let manual = save_inner(&mut f.conn, input.clone(), None).unwrap();
    let mut hijack = input;
    hijack.id = Some(manual.id);
    assert!(save_inner(&mut f.conn, hijack, Some(("plugin-a", "source"))).is_err());
    remove_inner(&f.conn, &project.id).unwrap(); // User may dismiss the projection.
}

#[test]
fn changed_identity_is_not_silently_rebound() {
    let mut f = Fixture::new();
    let input = f.input();
    let project = save_inner(&mut f.conn, input.clone(), None).unwrap();
    // Simulates a persisted identity differing from the current link target.
    let mut stored = storage::read(&f.conn).unwrap();
    stored[0].members[1].canonical_identity = "old-target".into();
    storage::write(&f.conn, &stored).unwrap();
    assert_eq!(
        list_inner(&f.conn).unwrap()[0].members[1].status,
        MemberStatus::Changed
    );
    let mut update = input;
    update.id = Some(project.id);
    assert_eq!(
        save_inner(&mut f.conn, update, None).unwrap().members[1].status,
        MemberStatus::Changed
    );
}

#[test]
fn canonical_aliases_are_duplicates() {
    let mut f = Fixture::new();
    let mut input = f.input();
    input.members[1].path = f.root.join("nested").join("..").to_str().unwrap().into();
    assert!(save_inner(&mut f.conn, input, None)
        .unwrap_err()
        .contains("duplicate member directory"));
}

fn legacy_record(f: &Fixture) -> StoredProject {
    let input = f.input();
    StoredProject {
        id: "legacy-project".into(),
        name: input.name,
        default_path: input.members[1].path.clone(),
        source_plugin_id: Some("publisher".into()),
        source_key: Some("existing-project-uuid".into()),
        members: input
            .members
            .into_iter()
            .map(|m| StoredMember {
                canonical_identity: identity(Path::new(&m.path)).unwrap(),
                id: m.id,
                path: m.path,
                label: m.label,
                role: m.role,
            })
            .collect(),
    }
}

fn install_legacy(conn: &Connection, project: &StoredProject) {
    conn.execute_batch("CREATE TABLE workspace_projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,default_path TEXT NOT NULL,source_plugin_id TEXT,source_key TEXT,CHECK((source_plugin_id IS NULL)=(source_key IS NULL)),UNIQUE(source_plugin_id,source_key));
        CREATE TABLE workspace_project_members(project_id TEXT NOT NULL REFERENCES workspace_projects(id) ON DELETE CASCADE,id TEXT NOT NULL,path TEXT NOT NULL,canonical_identity TEXT NOT NULL,label TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('development','reference')),position INTEGER NOT NULL,PRIMARY KEY(project_id,id),UNIQUE(project_id,canonical_identity));").unwrap();
    conn.execute(
        "INSERT INTO workspace_projects VALUES(?1,?2,?3,?4,?5)",
        params![
            project.id,
            project.name,
            project.default_path,
            project.source_plugin_id,
            project.source_key
        ],
    )
    .unwrap();
    for (index, m) in project.members.iter().enumerate() {
        conn.execute(
            "INSERT INTO workspace_project_members VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![
                project.id,
                m.id,
                m.path,
                m.canonical_identity,
                m.label,
                match m.role {
                    MemberRole::Development => "development",
                    MemberRole::Reference => "reference",
                },
                index as i64
            ],
        )
        .unwrap();
    }
}

#[test]
fn legacy_import_preserves_offline_default_identity_owner_and_dismissal() {
    let mut f = Fixture::new();
    let legacy = legacy_record(&f);
    install_legacy(&f.conn, &legacy);
    std::fs::remove_dir(f.root.join("nested")).unwrap();
    migrate_legacy(&f.conn).unwrap();
    let imported = list_inner(&f.conn).unwrap().remove(0);
    assert_eq!(imported.id, legacy.id);
    assert_eq!(imported.default_path, legacy.default_path);
    assert_eq!(imported.source_key, legacy.source_key);
    assert_eq!(imported.members[1].status, MemberStatus::Missing);
    assert_eq!(
        storage::read(&f.conn).unwrap()[0].members[1].canonical_identity,
        legacy.members[1].canonical_identity
    );
    let mut update = f.input();
    update.id = Some(imported.id.clone());
    update.default_path = imported.default_path;
    update.name = "Newer KV name".into();
    assert!(save_inner(&mut f.conn, update.clone(), None).is_err());
    save_inner(
        &mut f.conn,
        update,
        Some(("publisher", "existing-project-uuid")),
    )
    .unwrap();
    migrate_legacy(&f.conn).unwrap();
    assert_eq!(list_inner(&f.conn).unwrap()[0].name, "Newer KV name");
    remove_inner(&f.conn, &imported.id).unwrap();
    let reopened = Connection::open(f.root.join("projects.sqlite")).unwrap();
    migrate_legacy(&reopened).unwrap();
    assert!(
        list_inner(&reopened).unwrap().is_empty(),
        "removed projections must not resurrect"
    );
    let source: (String, String) = reopened
        .query_row("SELECT id,name FROM workspace_projects", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(source, (legacy.id, legacy.name));
    assert_eq!(
        reopened
            .query_row("SELECT COUNT(*) FROM workspace_project_members", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
        2
    );
}

#[test]
fn failed_legacy_project_import_rolls_back_and_retries_without_source_changes() {
    let f = Fixture::new();
    let legacy = legacy_record(&f);
    install_legacy(&f.conn, &legacy);
    f.conn.execute_batch("CREATE TEMP TRIGGER reject_project_import BEFORE INSERT ON plugin_kv WHEN NEW.plugin_id='$ccgui-workspace-projects' BEGIN SELECT RAISE(ABORT,'project import failure'); END;").unwrap();
    assert!(migrate_legacy(&f.conn)
        .unwrap_err()
        .to_string()
        .contains("project import failure"));
    assert!(storage::read(&f.conn).unwrap().is_empty());
    f.conn
        .execute_batch("DROP TRIGGER reject_project_import")
        .unwrap();
    migrate_legacy(&f.conn).unwrap();
    assert_eq!(storage::read(&f.conn).unwrap().len(), 1);
    assert_eq!(
        f.conn
            .query_row("SELECT COUNT(*) FROM workspace_project_members", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap(),
        2
    );
}

#[test]
fn invalid_or_future_kv_cannot_be_silently_overwritten_or_deleted() {
    let mut f = Fixture::new();
    let project = legacy_record(&f);
    let mut duplicate = project.clone();
    duplicate.members[1].canonical_identity = duplicate.members[0].canonical_identity.clone();
    let mut wrong_owner = project.clone();
    wrong_owner.source_key = None;
    for raw in [
        serde_json::json!({"version":2,"projects":[]}).to_string(),
        serde_json::json!({"version":1,"projects":[duplicate]}).to_string(),
        serde_json::json!({"version":1,"projects":[wrong_owner]}).to_string(),
        serde_json::json!({"version":1,"projects":[project.clone(),project.clone()]}).to_string(),
        "broken".into(),
    ] {
        f.conn
            .execute(
                "INSERT OR REPLACE INTO plugin_kv(plugin_id,key,value) VALUES(?1,?2,?3)",
                params![storage::NAMESPACE, storage::KEY, raw],
            )
            .unwrap();
        assert!(list_inner(&f.conn).is_err());
        let input = f.input();
        assert!(save_inner(&mut f.conn, input, None).is_err());
        assert!(remove_inner(&f.conn, &project.id).is_err());
        let saved: String = f
            .conn
            .query_row(
                "SELECT value FROM plugin_kv WHERE plugin_id=?1 AND key=?2",
                params![storage::NAMESPACE, storage::KEY],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(saved, raw);
    }
}

#[test]
fn independent_connections_serialize_project_updates_without_lost_records() {
    let f = Fixture::new();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|index| {
            let path = f.root.join("projects.sqlite");
            let input = f.input();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let mut conn = Connection::open(path).unwrap();
                conn.busy_timeout(std::time::Duration::from_secs(5))
                    .unwrap();
                barrier.wait();
                save_inner(
                    &mut conn,
                    input,
                    Some(("publisher", &format!("source-{index}"))),
                )
                .unwrap()
                .id
            })
        })
        .collect();
    let ids: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    assert_ne!(ids[0], ids[1]);
    assert_eq!(list_inner(&f.conn).unwrap().len(), 2);
}

#[test]
fn legacy_host_file_reflection_differs_but_runtime_probe_uses_fresh_contract() {
    let f = Fixture::new();
    let profile_db = f.root.join("existing-host.sqlite");
    let db = crate::db::Db::open_at(&profile_db).unwrap();
    crate::leader::ensure_schema(&db).unwrap();
    let leader = crate::leader::schema_contract_descriptor();
    let plan = crate::engine::plan_review::schema_contract_descriptor();
    let descriptors = [("leader", &leader), ("plan-review", &plan)];
    let clean_hash =
        crate::task_worker::compute_schema_contract_hash(&db.0.lock(), &descriptors).unwrap();
    assert_eq!(clean_hash, crate::task_worker::SCHEMA_CONTRACT_V3_HASH);
    let image = f.root.join("legacy-preview.png");
    std::fs::write(&image, b"\x89PNG\r\n\x1a\nlegacy").unwrap();
    let image = image.canonicalize().unwrap().to_string_lossy().into_owned();
    let legacy = legacy_record(&f);
    {
        let conn = db.0.lock();
        conn.execute(
            "INSERT INTO workspaces(id,path,name) VALUES('game',?1,'Game')",
            [f.root.to_str().unwrap()],
        )
        .unwrap();
        install_legacy(&conn, &legacy);
        conn.execute_batch("CREATE TABLE image_preview_grants(path TEXT NOT NULL,scope TEXT NOT NULL CHECK(scope IN ('file','directory')),PRIMARY KEY(path,scope));").unwrap();
        conn.execute(
            "INSERT INTO image_preview_grants VALUES(?1,'file')",
            [&image],
        )
        .unwrap();
    }
    drop(db);

    // Exercise the real persistent-Db open path with all three abandoned tables,
    // not just a fresh in-memory fixture or an adjusted table allowlist.
    let reopened = crate::db::Db::open_at(&profile_db).unwrap();
    crate::leader::ensure_schema(&reopened).unwrap();
    let conn = reopened.0.lock();
    let disk_hash = crate::task_worker::compute_schema_contract_hash(&conn, &descriptors).unwrap();
    assert_ne!(
        disk_hash, clean_hash,
        "reflection must still detect the retained legacy tables"
    );
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('image_preview_grants','workspace_projects','workspace_project_members')", [], |r| r.get::<_,i64>(0)).unwrap(), 3);
    assert_eq!(list_inner(&conn).unwrap()[0].id, legacy.id);
    let imported: String = conn
        .query_row(
            "SELECT value FROM plugin_kv WHERE plugin_id='$ccgui-image-preview' AND key='state-v1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&imported).unwrap()["grants"][0]["path"],
        image
    );
    drop(conn);

    let probe = crate::task_worker::probe();
    let runtime_hash = probe["schemaHash"].as_str().unwrap();
    assert_eq!(runtime_hash, clean_hash);
    let expected = crate::live_update::Compatibility {
        worker_protocol: crate::task_worker::PROTOCOL,
        checkpoint_schema: 1,
        schema_hash: runtime_hash.to_owned(),
    };
    let mut candidate = crate::live_update::ReleaseIdentity {
        manifest_sha256: "a".repeat(64),
        channel: "test".into(),
        release_id: "v2".into(),
        version: "1".into(),
        worker_protocol: expected.worker_protocol,
        checkpoint_schema: expected.checkpoint_schema,
        schema_hash: clean_hash.clone(),
        executable: "fixture.exe".into(),
    };
    assert!(crate::live_update::check_compatibility(&candidate, &expected).is_ok());
    candidate.schema_hash = disk_hash.clone();
    assert_eq!(
        crate::live_update::check_compatibility(&candidate, &expected).unwrap_err(),
        "database schema hash mismatch"
    );
    eprintln!("existing host physical schemaHash: {disk_hash}; runtime contract schemaHash: {runtime_hash}");
}

#[cfg(windows)]
#[test]
fn windows_case_and_separator_aliases_are_duplicates() {
    let mut f = Fixture::new();
    let mut input = f.input();
    input.members[1].path = input.members[0].path.replace('\\', "/").to_uppercase();
    assert!(save_inner(&mut f.conn, input, None)
        .unwrap_err()
        .contains("duplicate member directory"));
}

#[cfg(unix)]
#[test]
fn retargeted_symlink_is_changed_and_aliases_are_duplicates() {
    let mut f = Fixture::new();
    let link = f.root.join("alias");
    std::os::unix::fs::symlink(f.root.join("nested"), &link).unwrap();
    let mut input = f.input();
    input.members[1].path = link.to_str().unwrap().into();
    let project = save_inner(&mut f.conn, input.clone(), None).unwrap();
    std::fs::remove_file(&link).unwrap();
    std::os::unix::fs::symlink(&f.root, &link).unwrap();
    assert_eq!(
        list_inner(&f.conn).unwrap()[0].members[1].status,
        MemberStatus::Changed
    );
    input.id = Some(project.id);
    assert_eq!(
        save_inner(&mut f.conn, input, None).unwrap().members[1].status,
        MemberStatus::Changed
    );
    let mut fresh = f.input();
    fresh.members[1].path = link.to_str().unwrap().into();
    assert!(save_inner(&mut f.conn, fresh, None).is_err());
}
