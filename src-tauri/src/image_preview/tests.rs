use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "ccgui-preview-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn image(&self, name: &str) -> String {
        let path = self.0.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"\x89PNG\r\n\x1a\npreview").unwrap();
        path.to_string_lossy().into()
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn db() -> crate::db::Db {
    let db = crate::db::Db::open_in_memory().unwrap();
    migrate_legacy(&db.0.lock()).unwrap();
    db
}
fn approve(db: &crate::db::Db, path: &str, scope: &str) -> Result<ImagePreviewGrant, String> {
    let expected = scopes(path)?
        .into_iter()
        .find(|entry| entry.scope == scope)
        .ok_or("invalid scope")?;
    grant(db, path, scope, &expected.path)
}
#[test]
fn exact_file_is_read_only_and_revocable_even_when_missing() {
    let scratch = Scratch::new();
    let db = db();
    let a = scratch.image("a.png");
    let b = scratch.image("b.png");
    assert!(read_blocking(&db, &a)
        .unwrap_err()
        .starts_with("path is outside"));
    let entry = approve(&db, &a, "file").unwrap();
    assert!(read_blocking(&db, &a).is_ok());
    assert!(read_blocking(&db, &b).is_err());
    assert!(db.granted_roots().unwrap().is_empty());
    // This is the same guard used by write_file and all ordinary file APIs.
    assert!(crate::files::ensure_allowed(&a, &db).is_err());
    std::fs::write(&a, b"<svg>active</svg>").unwrap();
    assert!(read_blocking(&db, &a).unwrap_err().contains("not a raster"));
    std::fs::remove_file(&a).unwrap();
    assert!(read_blocking(&db, &a).is_err());
    revoke(&db, &entry.path, &entry.scope).unwrap();
    assert!(list(&db.0.lock()).unwrap().is_empty());
    scratch.image("a.png");
    assert!(read_blocking(&db, &a).is_err());
}
#[test]
fn directory_scope_uses_segments_and_does_not_grant_sibling_trees() {
    let scratch = Scratch::new();
    let db = db();
    let a = scratch.image("art/a.png");
    let child = scratch.image("art/sub/b.png");
    let sibling = scratch.image("art-other/c.png");
    let entry = approve(&db, &a, "directory").unwrap();
    assert!(read_blocking(&db, &child).is_ok());
    assert!(read_blocking(&db, &sibling).is_err());
    revoke(&db, &entry.path, &entry.scope).unwrap();
    assert!(read_blocking(&db, &child).is_err());
}
#[test]
fn invalid_and_oversized_images_cannot_be_granted_or_read() {
    let scratch = Scratch::new();
    let db = db();
    let a = scratch.image("a.png");
    assert!(grant(&db, &a, "everything", "").is_err());
    let entry = approve(&db, &a, "file").unwrap();
    File::options()
        .write(true)
        .open(&a)
        .unwrap()
        .set_len(LIMIT + 1)
        .unwrap();
    assert!(read_blocking(&db, &a).unwrap_err().contains("64MB"));
    assert!(grant(&db, &a, "directory", "").is_err());
    revoke(&db, &entry.path, &entry.scope).unwrap();
}
#[cfg(unix)]
#[test]
fn replacing_granted_directory_with_link_does_not_follow_new_target() {
    let scratch = Scratch::new();
    let db = db();
    let a = scratch.image("art/a.png");
    scratch.image("other/a.png");
    approve(&db, &a, "directory").unwrap();
    std::fs::rename(scratch.0.join("art"), scratch.0.join("original")).unwrap();
    std::os::unix::fs::symlink(scratch.0.join("other"), scratch.0.join("art")).unwrap();
    assert!(read_blocking(&db, &a).is_err());
}

#[test]
fn changed_scope_is_rejected_without_recording_any_permission() {
    let scratch = Scratch::new();
    let db = db();
    let a = scratch.image("shown/a.png");
    let b = scratch.image("changed/a.png");
    for shown in scopes(&a).unwrap() {
        assert!(grant(&db, &b, &shown.scope, &shown.path)
            .unwrap_err()
            .contains("scope changed"));
        assert!(list(&db.0.lock()).unwrap().is_empty());
        assert!(db.granted_roots().unwrap().is_empty());
    }
}

#[test]
fn broken_workspace_catalogue_is_not_reported_as_missing_permission() {
    let scratch = Scratch::new();
    let db = db();
    let a = scratch.image("a.png");
    db.0.lock().execute_batch("DROP TABLE workspaces").unwrap();
    let error = read_blocking(&db, &a).unwrap_err();
    assert!(error.contains("workspaces"));
    assert!(!error.starts_with("path is outside"));
}

#[test]
fn kv_storage_preserves_v3_contract_and_does_not_create_development_tables() {
    let db = db();
    let scratch = Scratch::new();
    approve(&db, &scratch.image("new.png"), "file").unwrap();
    let count: i64 = db.0.lock().query_row(
        "SELECT COUNT(*) FROM sqlite_schema WHERE name IN ('image_preview_grants','workspace_projects','workspace_project_members')",
        [], |r| r.get(0)).unwrap();
    assert_eq!(count, 0);
    let hash = crate::task_worker::schema_hash();
    assert_eq!(hash, crate::task_worker::SCHEMA_CONTRACT_V3_HASH);
}

fn legacy_preview(conn: &rusqlite::Connection, path: &str) {
    conn.execute_batch("CREATE TABLE image_preview_grants(path TEXT NOT NULL,scope TEXT NOT NULL CHECK(scope IN ('file','directory')),PRIMARY KEY(path,scope));").unwrap();
    conn.execute("INSERT INTO image_preview_grants VALUES(?1,'file')", [path])
        .unwrap();
}

#[test]
fn legacy_import_preserves_source_and_revocation_survives_reopen() {
    let scratch = Scratch::new();
    let path = scratch.image("retained.png");
    let canonical = canonical(&path).unwrap().to_string_lossy().into_owned();
    let db_path = scratch.0.join("legacy.sqlite");
    let db = crate::db::Db::open_at(&db_path).unwrap();
    legacy_preview(&db.0.lock(), &canonical);
    drop(db);
    let db = crate::db::Db::open_at(&db_path).unwrap();
    assert_eq!(list(&db.0.lock()).unwrap()[0].path, canonical);
    assert!(read_blocking(&db, &path).is_ok());
    assert!(db.granted_roots().unwrap().is_empty());
    assert!(crate::files::ensure_allowed(&path, &db).is_err());
    revoke(&db, &canonical, "file").unwrap();
    drop(db);
    let db = crate::db::Db::open_at(&db_path).unwrap();
    assert!(list(&db.0.lock()).unwrap().is_empty());
    assert!(read_blocking(&db, &path).is_err());
    let source: String =
        db.0.lock()
            .query_row("SELECT path FROM image_preview_grants", [], |r| r.get(0))
            .unwrap();
    assert_eq!(source, canonical, "legacy source is never erased");
}

#[test]
fn failed_legacy_import_is_retryable_and_never_marks_completion() {
    let scratch = Scratch::new();
    let path = canonical(&scratch.image("retained.png"))
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let db = db();
    let conn = db.0.lock();
    legacy_preview(&conn, &path);
    conn.execute_batch("CREATE TEMP TRIGGER fail_preview_import BEFORE INSERT ON plugin_kv WHEN NEW.plugin_id='$ccgui-image-preview' BEGIN SELECT RAISE(ABORT,'preview import failure'); END;").unwrap();
    assert!(migrate_legacy(&conn)
        .unwrap_err()
        .to_string()
        .contains("preview import failure"));
    assert!(storage::read(&conn).unwrap().is_empty());
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM image_preview_grants", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    conn.execute_batch("DROP TRIGGER fail_preview_import")
        .unwrap();
    migrate_legacy(&conn).unwrap();
    assert_eq!(storage::read(&conn).unwrap().len(), 1);
}

#[test]
fn invalid_kv_does_not_reauthorize_or_overwrite_existing_data() {
    let scratch = Scratch::new();
    let path = scratch.image("a.png");
    let db = db();
    for raw in [
        r#"{"version":2,"grants":[]}"#,
        r#"{"version":1,"grants":[{"path":"relative","scope":"everything"}]}"#,
        "broken",
    ] {
        db.0.lock()
            .execute(
                "INSERT OR REPLACE INTO plugin_kv(plugin_id,key,value) VALUES(?1,?2,?3)",
                rusqlite::params![storage::NAMESPACE, storage::KEY, raw],
            )
            .unwrap();
        assert!(read_blocking(&db, &path).is_err());
        assert!(approve(&db, &path, "file").is_err());
        assert!(revoke(&db, &path, "file").is_err());
        let saved: String =
            db.0.lock()
                .query_row(
                    "SELECT value FROM plugin_kv WHERE plugin_id=?1 AND key=?2",
                    rusqlite::params![storage::NAMESPACE, storage::KEY],
                    |r| r.get(0),
                )
                .unwrap();
        assert_eq!(saved, raw);
    }
}
