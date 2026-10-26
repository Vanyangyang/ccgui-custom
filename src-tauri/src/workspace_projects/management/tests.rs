use super::*;
use std::path::PathBuf;

struct Fixture { root: PathBuf, conn: Connection }
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ccgui-organization-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("nested")).unwrap();
        let conn = Connection::open(root.join("test.sqlite")).unwrap();
        conn.execute_batch("CREATE TABLE workspaces(id TEXT PRIMARY KEY,path TEXT,meta TEXT);
            CREATE TABLE plugin_kv(plugin_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(plugin_id,key));").unwrap();
        conn.execute("INSERT INTO workspaces VALUES('root',?1,NULL)", [root.to_str().unwrap()]).unwrap();
        Self { root, conn }
    }
    fn args(&self) -> SaveArgs {
        let path = self.root.join("nested").to_str().unwrap().to_owned();
        SaveArgs { request_id: "create-1".into(), id: None, expected_current: None, name: "自定义项目 🐾".into(),
            default_path: path.clone(), members: vec![MemberInput { id: None, path, label: "素材与实现".into() }] }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let conn = std::mem::replace(&mut self.conn, Connection::open_in_memory().unwrap());
        drop(conn);
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
fn edit(args: &SaveArgs, snapshot: &ProjectSnapshot, request: &str) -> SaveArgs {
    let mut next = args.clone(); next.id = Some(snapshot.project.id.clone());
    next.expected_current = Some(snapshot.expected_current.clone()); next.request_id = request.into(); next
}

#[test]
fn organization_workspace_view_excludes_opaque_metadata() {
    let rows = workspace_metadata(vec![crate::history::reader::Workspace {
        id: "w".into(), path: "workspace".into(), name: "Visible name".into(),
        last_opened_at: Some(1), sort_order: Some(2), group_id: Some("g".into()),
        kind: None, parent_id: None, meta: Some(serde_json::json!({"secret":"do-not-return"})),
    }]);
    assert_eq!(rows[0]["name"], "Visible name");
    assert_eq!(rows[0]["groupId"], "g");
    assert!(rows[0].get("meta").is_none());
    assert!(!serde_json::to_string(&rows).unwrap().contains("do-not-return"));
}

#[test]
fn simultaneous_edits_of_one_snapshot_have_exactly_one_winner() {
    let mut f = Fixture::new(); let args = f.args();
    let original = save(&mut f.conn, "chat", args.clone()).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let workers: Vec<_> = ["first", "second"].into_iter().map(|name| {
        let path = f.root.join("test.sqlite"); let barrier = barrier.clone();
        let mut next = edit(&args, &original, name); next.name = name.into();
        std::thread::spawn(move || {
            let mut conn = Connection::open(path).unwrap();
            conn.busy_timeout(std::time::Duration::from_secs(5)).unwrap();
            barrier.wait();
            save(&mut conn, "chat", next).map(|p| p.project.name)
        })
    }).collect();
    let outcomes: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
    assert_eq!(outcomes.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(outcomes.iter().filter(|r| matches!(r, Err(error) if error.contains("changed since read"))).count(), 1);
    assert_eq!(&list_inner(&f.conn).unwrap()[0].name, outcomes.iter().find_map(|r| r.as_ref().ok()).unwrap());
}

#[test]
fn create_replay_readback_and_complete_membership_replacement() {
    let mut f = Fixture::new(); let args = f.args();
    let first = save(&mut f.conn, "chat", args.clone()).unwrap();
    assert_eq!(first.project.members[0].label, "素材与实现");
    assert_eq!(first.project.members[0].role, MemberRole::Development);
    assert_eq!(snapshots(&f.conn).unwrap()[0].expected_current, first.expected_current);
    let replay = save(&mut f.conn, "chat", args.clone()).unwrap();
    assert_eq!(replay.project.id, first.project.id);
    assert_eq!(list_inner(&f.conn).unwrap().len(), 1);
    let mut next = edit(&args, &first, "edit-1"); next.name = "人工可再改".into();
    next.members.push(MemberInput { id: None, path: f.root.to_str().unwrap().into(), label: "根目录".into() });
    let second = save(&mut f.conn, "chat", next.clone()).unwrap();
    assert_eq!(second.project.members.len(), 2);
    assert_eq!(second.project.members[0].id, first.project.members[0].id);
    let replay = save(&mut f.conn, "chat", args.clone()).unwrap();
    assert_eq!(replay.project.name, second.project.name); // current truth, not rollback
    let mut replacement = edit(&args, &second, "edit-2"); replacement.name = "仅一个成员".into();
    let third = save(&mut f.conn, "chat", replacement).unwrap();
    assert_eq!(third.project.members.len(), 1);
    let mut conflict = args.clone(); conflict.name = "different request payload".into();
    assert!(save(&mut f.conn, "chat", conflict).err().unwrap().contains("requestId conflicts"));
    remove_inner(&f.conn, &third.project.id).unwrap();
    assert!(save(&mut f.conn, "chat", args).err().unwrap().contains("was removed"));
    assert!(list_inner(&f.conn).unwrap().is_empty());
}

#[test]
fn independent_connections_reject_stale_edits_and_keep_latest_snapshot() {
    let mut f = Fixture::new(); let args = f.args();
    let original = save(&mut f.conn, "chat", args.clone()).unwrap();
    let mut other = Connection::open(f.root.join("test.sqlite")).unwrap();
    let mut winner = edit(&args, &original, "winner"); winner.name = "newest".into();
    let latest = save(&mut other, "other-chat", winner).unwrap();
    let mut stale = edit(&args, &original, "stale"); stale.name = "old view".into();
    assert!(save(&mut f.conn, "chat", stale).err().unwrap().contains("changed since read"));
    let readback = snapshots(&f.conn).unwrap();
    assert_eq!(readback[0].expected_current, latest.expected_current);
    assert_eq!(readback[0].project.name, "newest");
}

#[test]
fn rejects_plugin_ownership_and_preserves_legacy_role_and_offline_identity() {
    let mut f = Fixture::new(); let args = f.args();
    let legacy = ProjectInput { id: None, name: "legacy".into(), default_path: args.default_path.clone(),
        members: vec![ProjectMemberInput { id: "legacy-member".into(), path: args.default_path.clone(), label: "旧标签".into(), role: MemberRole::Reference }] };
    let plugin = save_inner(&mut f.conn, legacy.clone(), Some(("test-plugin", "key"))).unwrap();
    let snapshot = snapshots(&f.conn).unwrap().remove(0);
    assert!(save(&mut f.conn, "chat", edit(&args, &snapshot, "plugin-edit")).err().unwrap().contains("plugin-owned"));
    assert_eq!(list_inner(&f.conn).unwrap()[0].id, plugin.id);
    let user = save_inner(&mut f.conn, legacy, None).unwrap();
    let snapshot = snapshots(&f.conn).unwrap().into_iter().find(|p| p.project.id == user.id).unwrap();
    let before = storage::read(&f.conn).unwrap().into_iter().find(|p| p.id == user.id).unwrap().members[0].canonical_identity.clone();
    std::fs::remove_dir(f.root.join("nested")).unwrap();
    let updated = save(&mut f.conn, "chat", edit(&args, &snapshot, "rename-offline")).unwrap();
    assert_eq!(updated.project.members[0].id, "legacy-member");
    assert_eq!(updated.project.members[0].role, MemberRole::Reference);
    assert_eq!(updated.project.members[0].status, MemberStatus::Missing);
    assert_eq!(storage::read(&f.conn).unwrap().into_iter().find(|p| p.id == user.id).unwrap().members[0].canonical_identity, before);
}

#[test]
fn invalid_and_outside_members_leave_no_project_or_receipt() {
    let mut f = Fixture::new(); let args = f.args();
    let mut outside = args.clone(); outside.default_path = std::env::temp_dir().to_str().unwrap().into();
    outside.members[0].path = outside.default_path.clone();
    assert!(save(&mut f.conn, "chat", outside).err().unwrap().contains("outside registered"));
    let mut bad = args.clone(); bad.default_path = "not-a-member".into();
    assert!(save(&mut f.conn, "chat", bad).is_err());
    let mut duplicate = args.clone(); duplicate.members.push(duplicate.members[0].clone());
    assert!(save(&mut f.conn, "chat", duplicate).err().unwrap().contains("duplicate member directory"));
    assert!(list_inner(&f.conn).unwrap().is_empty());
    assert_eq!(f.conn.query_row("SELECT COUNT(*) FROM plugin_kv", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    let snapshot = save(&mut f.conn, "chat", args.clone()).unwrap();
    let mut bad = edit(&args, &snapshot, "bad-member"); bad.members[0].id = Some("unknown".into());
    assert!(save(&mut f.conn, "chat", bad).err().unwrap().contains("unknown member"));
}
