use super::*;

#[test]
fn plugin_memory_exact_project_owner_role_archive_and_identity() {
    let db = crate::db::Db::open_in_memory().unwrap();
    let root = std::env::temp_dir().join(format!("ccgui-memory-project-{}", uuid::Uuid::new_v4()));
    let child = root.join("child");
    std::fs::create_dir_all(&child).unwrap();
    let path = root.to_str().unwrap().to_owned();
    let conn = db.0.lock();
    let host_source = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_str()
        .unwrap();
    assert!(authorize_memory_source_with_archives(
        &conn,
        "example-dashboard",
        "game",
        host_source,
        false,
        &[]
    )
    .is_err());
    conn.execute(
        "INSERT INTO workspaces(id,path,name) VALUES('w',?1,'Synthetic game')",
        [&path],
    )
    .unwrap();
    let mut project = StoredProject {
        id: "game".into(),
        name: "Game".into(),
        default_path: path.clone(),
        source_plugin_id: Some("example-dashboard".into()),
        source_key: Some("game".into()),
        members: vec![StoredMember {
            id: "member".into(),
            path: path.clone(),
            label: "Game".into(),
            canonical_identity: identity(&root).unwrap(),
            role: MemberRole::Development,
        }],
    };
    storage::write(&conn, &[project.clone()]).unwrap();
    let authorize = |owner: &str, project: &str, path: &str, dev: bool, archives: &[String]| {
        authorize_memory_source_with_archives(&conn, owner, project, path, dev, archives)
    };
    assert!(authorize("example-dashboard", "game", &path, true, &[]).is_ok());
    #[cfg(windows)] {
        let spelled = path.replace('\\', "/").to_uppercase() + "/";
        assert!(authorize("example-dashboard", "game", &spelled, true, &[]).is_ok());
        assert!(authorize("example-dashboard", "game", &spelled, true, &["w".into()]).is_err());
    }
    assert!(authorize("foreign", "game", &path, true, &[]).is_err());
    assert!(authorize("example-dashboard", "other", &path, true, &[]).is_err());
    assert!(authorize(
        "example-dashboard",
        "game",
        child.to_str().unwrap(),
        true,
        &[]
    )
    .is_err());
    assert!(authorize("example-dashboard", "game", &path, true, &["w".into()]).is_err());
    project.source_plugin_id = None;
    project.source_key = None;
    project.members[0].role = MemberRole::Reference;
    storage::write(&conn, &[project.clone()]).unwrap();
    assert!(authorize("example-dashboard", "game", &path, false, &[]).is_ok());
    assert!(authorize("example-dashboard", "game", &path, true, &[]).is_err());
    project.members[0]
        .canonical_identity
        .push_str("-retargeted");
    storage::write(&conn, &[project]).unwrap();
    assert!(authorize("example-dashboard", "game", &path, false, &[]).is_err());
    drop(conn);
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
