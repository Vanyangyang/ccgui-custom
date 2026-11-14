use super::*;

struct Fixture {
    db: crate::db::Db,
    root: std::path::PathBuf,
    source: String,
    target: String,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ccgui-task-access-{}", uuid::Uuid::new_v4()));
        let source = root.join("source").to_string_lossy().into_owned();
        let target = root.join("target").to_string_lossy().into_owned();
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        let db = crate::db::Db::open_in_memory().unwrap();
        for (id, path) in [("source", &source), ("target", &target)] {
            db.0.lock()
                .execute(
                    "INSERT INTO workspaces(id,path,name) VALUES(?1,?2,?1)",
                    params![id, path],
                )
                .unwrap();
        }
        Self {
            db,
            root,
            source,
            target,
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[test]
fn registered_workspaces_dispatch_in_both_directions_without_legacy_grants() {
    let f = Fixture::new();
    let conn = f.db.0.lock();
    let authorize = |parent: &str, target: &str| {
        crate::leader::authorize_task_workspace(&conn, &[], parent, target).unwrap();
    };
    authorize(&f.source, &f.target);
    authorize(&f.target, &f.source);
    // Old grants, including malformed/revoked data, have no bearing on dispatch.
    conn.execute("INSERT INTO plugin_kv(plugin_id,key,value) VALUES('$ccgui-task-workspace-access','obsolete','invalid-json')", []).unwrap();
    authorize(&f.source, &f.target);
    assert_eq!(
        conn.query_row(
            "SELECT value FROM plugin_kv WHERE key='obsolete'",
            [],
            |r| r.get::<_, String>(0)
        )
        .unwrap(),
        "invalid-json"
    );
    conn.execute(
        "DELETE FROM plugin_kv WHERE plugin_id='$ccgui-task-workspace-access'",
        [],
    )
    .unwrap();
    authorize(&f.source, &f.target);
    // Even absent legacy storage must not become a dispatch dependency.
    conn.execute("DROP TABLE plugin_kv", []).unwrap();
    authorize(&f.source, &f.target);
}

#[test]
fn reference_members_and_registered_descendants_are_available_targets() {
    let f = Fixture::new();
    let mut conn = f.db.0.lock();
    crate::workspace_projects::save_inner(
        &mut conn,
        crate::workspace_projects::ProjectInput {
            id: None,
            name: "fixture".into(),
            default_path: f.source.clone(),
            members: vec![
                crate::workspace_projects::ProjectMemberInput {
                    id: "dev".into(),
                    path: f.source.clone(),
                    label: "dev".into(),
                    role: crate::workspace_projects::MemberRole::Development,
                },
                crate::workspace_projects::ProjectMemberInput {
                    id: "ref".into(),
                    path: f.target.clone(),
                    label: "reference".into(),
                    role: crate::workspace_projects::MemberRole::Reference,
                },
            ],
        },
        None,
    )
    .unwrap();
    crate::leader::authorize_task_workspace(&conn, &[], &f.source, &f.target).unwrap();
    let nested = std::path::Path::new(&f.target).join("nested");
    std::fs::create_dir(&nested).unwrap();
    let nested = nested.to_string_lossy();
    assert!(crate::leader::authorize_task_workspace(&conn, &[], &f.source, &nested).is_err());
    conn.execute(
        "INSERT INTO workspaces(id,path,name) VALUES('nested',?1,'nested')",
        [nested.as_ref()],
    )
    .unwrap();
    crate::leader::authorize_task_workspace(&conn, &[], &f.source, &nested).unwrap();
    conn.execute(
        "UPDATE plugin_kv SET value='invalid-json' WHERE plugin_id='$ccgui-workspace-projects'",
        [],
    )
    .unwrap();
    crate::leader::authorize_task_workspace(&conn, &[], &f.source, &f.target).unwrap();
}

#[test]
fn every_cross_workspace_use_rechecks_registration_archive_transport_and_directory() {
    let f = Fixture::new();
    let conn = f.db.0.lock();
    for archived in [vec!["source".into()], vec!["target".into()]] {
        assert!(
            crate::leader::authorize_task_workspace(&conn, &archived, &f.source, &f.target)
                .is_err()
        );
    }
    for id in ["source", "target"] {
        for meta in [
            r#"{"remote":{}}"#,
            r#"{"wsl":{}}"#,
            "invalid",
            "[]",
            "42",
            "null",
            r#""text""#,
        ] {
            conn.execute(
                "UPDATE workspaces SET meta=?1 WHERE id=?2",
                params![meta, id],
            )
            .unwrap();
            assert!(
                crate::leader::authorize_task_workspace(&conn, &[], &f.source, &f.target).is_err(),
                "{id}: {meta}"
            );
        }
        conn.execute("UPDATE workspaces SET meta=NULL WHERE id=?1", [id])
            .unwrap();
    }
    std::fs::remove_dir(&f.target).unwrap();
    assert!(crate::leader::authorize_task_workspace(&conn, &[], &f.source, &f.target).is_err());
    std::fs::create_dir(&f.target).unwrap();
    conn.execute("DELETE FROM workspaces WHERE id='target'", [])
        .unwrap();
    assert!(crate::leader::authorize_task_workspace(&conn, &[], &f.source, &f.target).is_err());
    conn.execute(
        "INSERT INTO workspaces(id,path,name) VALUES('target',?1,'target')",
        [&f.target],
    )
    .unwrap();
    conn.execute("DELETE FROM workspaces WHERE id='source'", [])
        .unwrap();
    assert!(crate::leader::authorize_task_workspace(&conn, &[], &f.source, &f.target).is_err());
}

#[test]
fn workspace_registration_change_cannot_retarget_a_reserved_path() {
    let f = Fixture::new();
    let conn = f.db.0.lock();
    let other = f.root.join("other");
    std::fs::create_dir(&other).unwrap();
    conn.execute(
        "UPDATE workspaces SET path=?1 WHERE id='target'",
        [other.to_string_lossy().as_ref()],
    )
    .unwrap();
    assert!(crate::leader::authorize_task_workspace(&conn, &[], &f.source, &f.target).is_err());
    crate::leader::authorize_task_workspace(&conn, &[], &f.source, &other.to_string_lossy())
        .unwrap();
}
