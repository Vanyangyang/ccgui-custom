use super::*;

struct Fixture {
    db: crate::db::Db,
    root: std::path::PathBuf,
    profile: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ccgui-memory-host-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        Self { db: crate::db::Db::open_in_memory().unwrap(), profile: root.join("profile"), root }
    }

    fn register(&self, id: &str, path: &Path) {
        std::fs::create_dir_all(path).unwrap();
        let path_text = path.to_str().unwrap().to_owned();
        let conn = self.db.0.lock();
        conn.execute("INSERT INTO workspaces(id,path,name) VALUES(?1,?2,?1)", [id, &path_text]).unwrap();
        let project = StoredProject {
            id: id.into(), name: id.into(), default_path: path_text.clone(),
            source_plugin_id: Some("fixture-workbench".into()), source_key: Some(id.into()),
            members: vec![StoredMember {
                id: "member".into(), path: path_text, label: id.into(),
                canonical_identity: identity(path).unwrap(), role: MemberRole::Development,
            }],
        };
        let mut projects = storage::read(&conn).unwrap();
        projects.push(project);
        storage::write(&conn, &projects).unwrap();
    }

    fn authorize(&self, id: &str, path: &Path) -> Result<String, String> {
        let host = crate::creator_skill::registered_self_update_source_root(&self.profile)
            .map_err(|_| "host_source_unavailable")?;
        authorize_memory_source_with_archives(&self.db.0.lock(), "fixture-workbench", id,
            path.to_str().unwrap(), true, &[], host.as_deref())
    }

    fn mark_source(path: &Path) {
        std::fs::create_dir_all(path.join("scripts")).unwrap();
        std::fs::create_dir_all(path.join("src-tauri")).unwrap();
        std::fs::write(path.join("scripts/self-update-build.mjs"), b"// fixture").unwrap();
        std::fs::write(path.join("src-tauri/tauri.conf.json"), b"{}").unwrap();
    }

    fn channel(&self, path: &Path) {
        std::fs::create_dir_all(self.profile.join("runtime-updates")).unwrap();
        std::fs::write(self.profile.join("runtime-updates/channel.json"),
            serde_json::to_vec(&serde_json::json!({
                "version": 1, "working": [], "ready": [], "defaultSourceRoot": path,
            })).unwrap()).unwrap();
    }

    fn directory_link(&self, target: &Path, link: &Path) {
        assert!(target.starts_with(&self.root) && link.starts_with(&self.root));
        #[cfg(windows)] {
            use std::os::windows::process::CommandExt;
            // Exercise canonical aliases without changing machine privileges.
            let output = std::process::Command::new("powershell.exe")
                .creation_flags(0x08000000)
                .args(["-NoProfile", "-NonInteractive", "-Command",
                    "New-Item -ItemType Junction -Path $env:CCGUI_TEST_LINK -Target $env:CCGUI_TEST_TARGET -ErrorAction Stop | Out-Null"])
                .env("CCGUI_TEST_LINK", link).env("CCGUI_TEST_TARGET", target)
                .output().unwrap();
            assert!(output.status.success(), "junction fixture failed: {}", String::from_utf8_lossy(&output.stderr));
        }
        #[cfg(unix)] std::os::unix::fs::symlink(target, link).unwrap();
    }

    fn remove_directory_link(link: &Path) {
        #[cfg(windows)] std::fs::remove_dir(link).unwrap();
        #[cfg(unix)] std::fs::remove_file(link).unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) { std::fs::remove_dir_all(&self.root).unwrap(); }
}

#[test]
fn plugin_memory_excludes_each_registered_host_node_without_update_registration() {
    let f = Fixture::new();
    for name in ["checkout-one", "checkout-two"] {
        let root = f.root.join(name);
        f.register(name, &root);
        assert!(f.authorize(name, &root).is_ok(), "the complete project must otherwise authorize");
        Fixture::mark_source(&root);
        assert_eq!(f.authorize(name, &root).unwrap_err(), "host_source_project_excluded");
        #[cfg(windows)] {
            let alternate = std::path::PathBuf::from(root.to_str().unwrap().replace('\\', "/").to_uppercase() + "/");
            assert_eq!(f.authorize(name, &alternate).unwrap_err(), "host_source_project_excluded");
        }
    }
    assert!(!f.profile.exists());
}

#[test]
fn plugin_memory_allows_independent_nested_prefix_and_same_named_projects() {
    let f = Fixture::new();
    let host = f.root.join("host");
    f.register("host", &host);
    Fixture::mark_source(&host);
    for (name, root) in [("nested", host.join("game")), ("prefix", f.root.join("host-game")),
        ("name-only", f.root.join("ccgui-custom"))] {
        f.register(name, &root);
        assert!(f.authorize(name, &root).is_ok());
    }
    f.channel(&host);
    assert_eq!(f.authorize("host", &host).unwrap_err(), "host_source_project_excluded");
    assert!(f.authorize("nested", &host.join("game")).is_ok());
    assert!(f.authorize("prefix", &f.root.join("host-game")).is_ok());
}

#[test]
fn plugin_memory_trusted_default_root_is_exact_even_without_source_markers() {
    let f = Fixture::new();
    let host = f.root.join("renamed-checkout");
    f.register("host", &host);
    assert!(f.authorize("host", &host).is_ok());
    f.channel(&host);
    assert_eq!(f.authorize("host", &host).unwrap_err(), "host_source_project_excluded");
    let nested = host.join("game");
    f.register("nested", &nested);
    assert!(f.authorize("nested", &nested).is_ok());
    // An obsolete hint cannot override or invalidate the authoritative channel.
    std::fs::write(f.profile.join("runtime-updates/default-source-root.txt"), [0xff]).unwrap();
    assert_eq!(f.authorize("host", &host).unwrap_err(), "host_source_project_excluded");
    assert!(f.authorize("nested", &nested).is_ok());
}

#[test]
fn plugin_memory_rejects_explicit_invalid_source_roots() {
    let f = Fixture::new();
    let game = f.root.join("game");
    f.register("game", &game);
    assert!(f.authorize("game", &game).is_ok());
    for source in [std::path::PathBuf::from("relative/checkout"), f.root.join("missing-checkout"), std::path::PathBuf::new()] {
        f.channel(&source);
        assert_eq!(f.authorize("game", &game).unwrap_err(), "host_source_unavailable");
    }
}

#[test]
fn plugin_memory_corrupt_and_unreadable_registration_errors_are_sanitized() {
    let f = Fixture::new();
    let game = f.root.join("game");
    f.register("game", &game);
    assert!(f.authorize("game", &game).is_ok());
    let registration = f.profile.join("runtime-updates");
    std::fs::create_dir_all(&registration).unwrap();
    assert!(f.authorize("game", &game).is_ok());
    assert!(!registration.join("releases").exists());
    let channel = registration.join("channel.json");
    std::fs::write(&channel, b"invalid json with private path").unwrap();
    assert_eq!(f.authorize("game", &game).unwrap_err(), "host_source_unavailable");
    std::fs::remove_file(&channel).unwrap();
    std::fs::create_dir(&channel).unwrap();
    assert_eq!(f.authorize("game", &game).unwrap_err(), "host_source_unavailable");
    std::fs::remove_dir(&channel).unwrap();
    let hint = registration.join("default-source-root.txt");
    std::fs::write(&hint, [0xff]).unwrap();
    assert_eq!(f.authorize("game", &game).unwrap_err(), "host_source_unavailable");
    std::fs::remove_file(&hint).unwrap();
    std::fs::create_dir(&hint).unwrap();
    assert_eq!(f.authorize("game", &game).unwrap_err(), "host_source_unavailable");
}

#[test]
fn plugin_memory_rejects_non_directory_and_linked_registration_containers() {
    let f = Fixture::new();
    let game = f.root.join("game");
    f.register("game", &game);
    assert!(f.authorize("game", &game).is_ok());
    std::fs::create_dir_all(&f.profile).unwrap();
    let registration = f.profile.join("runtime-updates");
    std::fs::write(&registration, b"not a directory").unwrap();
    assert_eq!(f.authorize("game", &game).unwrap_err(), "host_source_unavailable");
    std::fs::remove_file(&registration).unwrap();
    let target = f.root.join("empty-registration");
    std::fs::create_dir(&target).unwrap();
    f.directory_link(&target, &registration);
    assert_eq!(f.authorize("game", &game).unwrap_err(), "host_source_unavailable");
    assert_eq!(std::fs::read_dir(&target).unwrap().count(), 0);
    Fixture::remove_directory_link(&registration);
    assert!(f.authorize("game", &game).is_ok());
}

#[test]
fn plugin_memory_host_identity_follows_directory_links_without_authorizing_aliases() {
    let f = Fixture::new();
    let host = f.root.join("checkout");
    f.register("host", &host);
    let alias = f.root.join("alias");
    f.directory_link(&host, &alias);
    assert_eq!(f.authorize("host", &alias).unwrap_err(), "exact_project_member_required");
    f.register("alias", &alias);
    assert!(f.authorize("host", &host).is_ok());
    assert!(f.authorize("alias", &alias).is_ok());
    Fixture::mark_source(&host);
    assert_eq!(f.authorize("alias", &alias).unwrap_err(), "host_source_project_excluded");
    std::fs::remove_file(host.join("scripts/self-update-build.mjs")).unwrap();
    f.channel(&alias);
    assert_eq!(f.authorize("host", &host).unwrap_err(), "host_source_project_excluded");
    assert_eq!(f.authorize("alias", &alias).unwrap_err(), "host_source_project_excluded");
    // Remove the link itself before the fixture recursively removes its tree.
    Fixture::remove_directory_link(&alias);
}

#[test]
fn plugin_memory_production_authorization_has_no_compile_time_source_path() {
    let production = include_str!("../workspace_projects.rs");
    assert!(!production.contains("CARGO_MANIFEST_DIR"));
    assert!(!production.contains("env!("));
    assert!(!production.contains("option_env!("));
}

#[test]
fn plugin_memory_exact_project_owner_role_archive_and_identity() {
    let db = crate::db::Db::open_in_memory().unwrap();
    let root = std::env::temp_dir().join(format!("ccgui-memory-project-{}", uuid::Uuid::new_v4()));
    let child = root.join("child");
    std::fs::create_dir_all(&child).unwrap();
    let path = root.to_str().unwrap().to_owned();
    let conn = db.0.lock();
    let profile = root.join("profile");
    conn.execute(
        "INSERT INTO workspaces(id,path,name) VALUES('w',?1,'Synthetic game')",
        [&path],
    )
    .unwrap();
    let mut project = StoredProject {
        id: "game".into(),
        name: "Game".into(),
        default_path: path.clone(),
        source_plugin_id: Some("fixture-workbench".into()),
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
        authorize_memory_source_with_archives(&conn, owner, project, path, dev, archives, None)
    };
    assert!(authorize("fixture-workbench", "game", &path, true, &[]).is_ok());
    #[cfg(windows)] {
        let spelled = path.replace('\\', "/").to_uppercase() + "/";
        assert!(authorize("fixture-workbench", "game", &spelled, true, &[]).is_ok());
        assert_eq!(authorize("fixture-workbench", "game", &spelled, true, &["w".into()]).unwrap_err(), "workspace_not_local_or_archived");
    }
    assert_eq!(authorize("foreign", "game", &path, true, &[]).unwrap_err(), "foreign_project_owner");
    assert_eq!(authorize("fixture-workbench", "other", &path, true, &[]).unwrap_err(), "project_not_registered");
    assert_eq!(authorize(
        "fixture-workbench",
        "game",
        child.to_str().unwrap(),
        true,
        &[]
    )
    .unwrap_err(), "exact_project_member_required");
    assert_eq!(authorize("fixture-workbench", "game", &path, true, &["w".into()]).unwrap_err(), "workspace_not_local_or_archived");
    for meta in [r#"{"wsl":{}}"#, r#"{"remote":{}}"#, "invalid json"] {
        conn.execute("UPDATE workspaces SET meta=?1", [meta]).unwrap();
        assert_eq!(authorize("fixture-workbench", "game", &path, true, &[]).unwrap_err(), "exact_project_member_required");
    }
    conn.execute("UPDATE workspaces SET meta=NULL", []).unwrap();
    project.source_plugin_id = None;
    project.source_key = None;
    project.members[0].role = MemberRole::Reference;
    storage::write(&conn, &[project.clone()]).unwrap();
    assert!(authorize("fixture-workbench", "game", &path, false, &[]).is_ok());
    assert_eq!(authorize("fixture-workbench", "game", &path, true, &[]).unwrap_err(), "exact_project_member_required");
    project.members[0]
        .canonical_identity
        .push_str("-retargeted");
    storage::write(&conn, &[project]).unwrap();
    assert_eq!(authorize("fixture-workbench", "game", &path, false, &[]).unwrap_err(), "exact_project_member_required");
    assert!(!profile.exists());
    drop(conn);
    drop(db);
    std::fs::remove_dir_all(root).unwrap();
}
