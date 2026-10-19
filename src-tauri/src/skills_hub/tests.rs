//! Skills hub 回归测试。
//!
//! 目录与环境注入策略：SSOT 经 `CCGUI_SKILLS_HUB_HOME` 指向临时目录；
//! 引擎 home 经 HOME 注入（`engine::fallback_home` 在测试下读 HOME），并持有
//! `paths::HOME_ENV_LOCK`（全 crate 共享的 HOME 串行锁）。全部写入发生在
//! 临时目录，绝不触碰真实 HOME。

use super::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

/// env 修改是进程级共享状态，所有改 env 的测试必须串行；复用 paths 的
/// 全 crate HOME 锁，避免与其它模块的 HOME 测试互相踩。
struct EnvGuard {
    saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
    _lock: parking_lot::MutexGuard<'static, ()>,
}

static TEMP_COUNTER: AtomicUsize = AtomicUsize::new(0);

#[derive(Default)]
struct ChangedEvents(std::sync::Mutex<Vec<(String, String)>>);

impl crate::event_sink::Emit for ChangedEvents {
    fn emit_json(&self, name: &str, payload: &str) {
        self.0.lock().unwrap().push((name.into(), payload.into()));
    }
}

#[tokio::test]
async fn mutations_broadcast_invalidation_after_success_and_partial_failure() {
    let _sandbox = Sandbox::new("change-events");
    let desktop = std::sync::Arc::new(ChangedEvents::default());
    let remote = std::sync::Arc::new(ChangedEvents::default());
    let emitter = crate::event_sink::BroadcastEmit::new(desktop.clone());
    emitter.add(remote.clone());
    mutate_and_announce(emitter.as_ref(), "add_repo", json!({
        "repo":{"owner":"test-owner","name":"test-skills","branch":"main"}
    })).await.unwrap();
    assert!(read_registry().repos.iter().any(|repo| repo["owner"] == "test-owner"));

    // restore moves the copy and saves the registry before validating targets.
    // Its failure must still tell both attached UIs to reread the changed state.
    let mut registry = read_registry();
    registry.skills.push(json!({
        "id":"test-owner/test-skills:demo", "directory":"demo", "name":"demo",
        "trashedAt":now_ms(), "trashedDirectory":"demo-trash",
        "previousTargets":["unknown-target"], "targets":[]
    }));
    save_registry(&registry).unwrap();
    let trashed = trash_dir().join("demo-trash");
    fs::create_dir_all(&trashed).unwrap();
    fs::write(trashed.join("SKILL.md"), "test content").unwrap();
    let result = mutate_and_announce(emitter.as_ref(), "restore", json!({
        "id":"test-owner/test-skills:demo"
    })).await;
    assert!(result.is_err());
    assert!(!trashed.exists());
    assert!(managed_skill_path("demo").unwrap().join("SKILL.md").is_file());
    assert!(read_registry().skills[0].get("trashedAt").is_none());
    let expected = vec![("skills://changed".into(), "null".into()); 2];
    assert_eq!(*desktop.0.lock().unwrap(), expected);
    assert_eq!(*remote.0.lock().unwrap(), expected);

    assert!(mutate_and_announce(emitter.as_ref(), "unknown", json!({})).await.is_err());
    assert_eq!(desktop.0.lock().unwrap().len(), 2);
    assert_eq!(remote.0.lock().unwrap().len(), 2);
}

impl EnvGuard {
    fn new(vars: &[(&'static str, &Path)]) -> Self {
        let lock = crate::paths::HOME_ENV_LOCK.lock();
        let mut saved = Vec::new();
        // SSOT 根默认指到本应用的 app_home（~/.ccgui-next）；测试里显式
        // 覆盖，未覆盖的测试（如只改 HOME 的引擎目录测试）也不会碰到
        // 真实用户数据。
        for (key, value) in vars {
            saved.push((*key, std::env::var_os(key)));
            std::env::set_var(key, value);
        }
        Self { saved, _lock: lock }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (key, value) in self.saved.drain(..) {
            match value {
                Some(v) => std::env::set_var(key, v),
                None => std::env::remove_var(key),
            }
        }
    }
}

/// 临时目录，Drop 时清理。
struct TestDir(PathBuf);

impl TestDir {
    fn new(tag: &str) -> Self {
        let unique = format!(
            "ccgui-skills-hub-test-{}-{}-{}",
            std::process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed),
            tag
        );
        let path = std::env::temp_dir().join(unique);
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// 同时隔离 SSOT 和 HOME 的测试环境。
struct Sandbox {
    home: TestDir,
    _store: TestDir,
    _env: EnvGuard,
}

impl Sandbox {
    fn new(tag: &str) -> Self {
        let home = TestDir::new(&format!("{tag}-home"));
        let store = TestDir::new(&format!("{tag}-store"));
        let env = EnvGuard::new(&[
            ("HOME", home.path()),
            ("CCGUI_SKILLS_HUB_HOME", store.path()),
            // 引擎 home / skills 根的 env 全部清空：开发机上真实设置的
            // CLAUDE_CONFIG_DIR、GROK_HOME 等不能把测试写入引到 sandbox 之外。
            ("CLAUDE_CONFIG_DIR", &PathBuf::new()),
            ("CODEX_HOME", &PathBuf::new()),
            ("CURSOR_CONFIG_DIR", &PathBuf::new()),
            ("KIMI_CODE_HOME", &PathBuf::new()),
            ("GROK_HOME", &PathBuf::new()),
            ("PI_CODING_AGENT_DIR", &PathBuf::new()),
            ("OMP_CODING_AGENT_DIR", &PathBuf::new()),
            ("DSH_HOME", &PathBuf::new()),
            ("ANTIGRAVITY_HOME", &PathBuf::new()),
            ("GEMINI_DIR", &PathBuf::new()),
            ("XDG_CONFIG_HOME", &PathBuf::new()),
            ("HERMES_HOME", &PathBuf::new()),
        ]);
        Self {
            home,
            _store: store,
            _env: env,
        }
    }
}

/// 在 sandbox 的某个引擎 skills 根下写一个 skill。
fn write_skill(root: &Path, directory: &str, name: &str) -> PathBuf {
    let dir = root.join(directory);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("SKILL.md"),
        format!("---\nname: {name}\ndescription: test skill\n---\nbody\n"),
    )
    .unwrap();
    dir
}

#[test]
fn sanitize_path_segment_boundaries() {
    assert_eq!(sanitize_path_segment("pdf"), Some("pdf".to_string()));
    assert_eq!(sanitize_path_segment("  pdf  "), Some("pdf".to_string()));
    assert_eq!(
        sanitize_path_segment(".hidden"),
        Some(".hidden".to_string())
    );
    assert_eq!(sanitize_path_segment(""), None);
    assert_eq!(sanitize_path_segment("."), None);
    assert_eq!(sanitize_path_segment(".."), None);
    assert_eq!(sanitize_path_segment("a/b"), None);
    assert_eq!(sanitize_path_segment("a\\b"), None);
    assert_eq!(sanitize_path_segment("a\0b"), None);
}

#[test]
fn sanitize_relative_path_boundaries() {
    assert_eq!(sanitize_relative_path("a/b").as_deref(), Some("a/b"));
    assert_eq!(sanitize_relative_path("a\\b").as_deref(), Some("a/b"));
    assert_eq!(sanitize_relative_path("a//b").as_deref(), Some("a/b"));
    assert_eq!(sanitize_relative_path("  a/b  ").as_deref(), Some("a/b"));
    assert_eq!(sanitize_relative_path("~").as_deref(), Some("~"));
    assert_eq!(sanitize_relative_path(""), None);
    assert_eq!(sanitize_relative_path("/a/b"), None);
    assert_eq!(sanitize_relative_path("a/../b"), None);
    assert_eq!(sanitize_relative_path("a/./b"), None);
    assert_eq!(sanitize_relative_path("a:b"), None);
    assert_eq!(sanitize_relative_path("C:/x"), None);
    assert_eq!(sanitize_relative_path("C:\\x"), None);
    assert_eq!(sanitize_relative_path("\\\\server\\share"), None);
    assert_eq!(sanitize_relative_path("\\tmp"), None);
    assert_eq!(sanitize_relative_path("a\0b"), None);
    assert_eq!(sanitize_relative_path("C:foo"), None);
}

#[test]
fn sanitize_local_skill_path_rejects_dot_segments() {
    assert_eq!(sanitize_local_skill_path("a/b").as_deref(), Some("a/b"));
    assert_eq!(sanitize_local_skill_path(".hidden/x"), None);
    assert_eq!(sanitize_local_skill_path("a/.hidden"), None);
    assert_eq!(sanitize_local_skill_path("a/bad:seg"), None);
}

#[test]
fn install_name_from_directory_semantics() {
    assert_eq!(install_name_from_directory("a/b").as_deref(), Some("b"));
    assert_eq!(
        install_name_from_directory("single").as_deref(),
        Some("single")
    );
    assert_eq!(install_name_from_directory(".."), None);
    assert_eq!(install_name_from_directory("/abs"), None);
}

#[test]
fn read_yaml_field_variants() {
    assert_eq!(read_yaml_field("name: pdf-tools\n", "name"), "pdf-tools");
    assert_eq!(
        read_yaml_field("name: \"quoted name\"\n", "name"),
        "quoted name"
    );
    assert_eq!(read_yaml_field("name: 'single'\n", "name"), "single");
    assert_eq!(read_yaml_field("other: 1\n", "name"), "");
    assert_eq!(read_yaml_field("names: nope\n", "name"), "");
    assert_eq!(read_yaml_field("  name: nested\n", "name"), "nested");
    let block = "description: |\n  line one\n  line two\nname: x\n";
    assert_eq!(read_yaml_field(block, "description"), "line one line two");
    let folded = "description: >-\n  first\n\n  second\ntail: 1\n";
    assert_eq!(read_yaml_field(folded, "description"), "first  second");
}

#[test]
fn read_skill_metadata_frontmatter_and_fallback() {
    let md = "---\nname: pdf\ndescription: Extracts text from PDFs\n---\nbody\n";
    let meta = read_skill_metadata(md, "fallback");
    assert_eq!(meta.name, "pdf");
    assert_eq!(meta.description, "Extracts text from PDFs");
    let no_fm = read_skill_metadata("just body", "fallback-name");
    assert_eq!(no_fm.name, "fallback-name");
    assert_eq!(no_fm.description, "");
    let empty = read_skill_metadata("", "");
    assert_eq!(empty.name, "Skill");
    let spaced = read_skill_metadata("description: a   b\n\tc\n", "x");
    assert_eq!(spaced.description, "a b");
}

#[test]
fn skill_md_path_detection() {
    assert!(is_skill_md_path("SKILL.md"));
    assert!(is_skill_md_path("dir/SKILL.md"));
    assert!(is_skill_md_path("dir/sub/skill.md"));
    assert!(is_skill_md_path("dir/SkIlL.Md"));
    assert!(!is_skill_md_path("dir/SKILL.md.bak"));
    assert!(!is_skill_md_path("xskill.md"));
    assert_eq!(strip_skill_md_suffix("SKILL.md"), "");
    assert_eq!(strip_skill_md_suffix("dir/SKILL.md"), "dir");
    assert_eq!(strip_skill_md_suffix("dir/sub/skill.md"), "dir/sub");
    assert_eq!(strip_skill_md_suffix("dir/other.md"), "dir/other.md");
}

#[test]
fn hash_directory_stable_and_sensitive() {
    let temp = TestDir::new("hash");
    let skill = temp.path().join("skill");
    fs::create_dir_all(skill.join("sub")).unwrap();
    fs::write(skill.join("SKILL.md"), b"hello").unwrap();
    fs::write(skill.join("sub").join("a.txt"), b"aaa").unwrap();
    fs::write(skill.join(".DS_Store"), b"junk").unwrap();
    let first = hash_directory(&skill);
    assert_eq!(first, hash_directory(&skill));
    fs::write(skill.join(".DS_Store"), b"other junk").unwrap();
    assert_eq!(first, hash_directory(&skill));
    fs::write(skill.join("sub").join("a.txt"), b"aab").unwrap();
    assert_ne!(first, hash_directory(&skill));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let before = hash_directory(&skill);
        fs::set_permissions(
            skill.join("sub").join("a.txt"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        assert_ne!(before, hash_directory(&skill));
    }
}

/// 移除同步到引擎的副本时，目录符号链接必须连链接本身一起删掉。
/// Windows 的 `remove_file` 对目录 symlink 报 Access denied，只会留下
/// “copy still present” 并让下一次 copy 顺着链接写进 SSOT。
#[test]
fn remove_path_deletes_directory_and_dangling_symlinks() {
    let temp = TestDir::new("remove-link");
    let source = temp.path().join("source");
    fs::create_dir_all(&source).unwrap();
    fs::write(source.join("SKILL.md"), b"body").unwrap();

    let link = temp.path().join("linked");
    if symlink_dir(&source, &link).is_ok() {
        remove_path(&link);
        assert!(!is_symlink(&link), "link still present: {link:?}");
        assert!(source.join("SKILL.md").is_file(), "target was deleted");
    }

    let dangling = temp.path().join("dangling");
    if symlink_dir(&temp.path().join("missing"), &dangling).is_ok() {
        remove_path(&dangling);
        assert!(!is_symlink(&dangling), "dangling link still present");
    }
}

#[test]
fn source_signature_from_tree_semantics() {
    let tree = json!([
        {"type": "blob", "path": "skill/a.txt", "sha": "aaa"},
        {"type": "blob", "path": "skill/sub/b.txt", "sha": "bbb"},
        {"type": "blob", "path": "other/c.txt", "sha": "ccc"},
        {"type": "tree", "path": "skill/sub", "sha": "ddd"},
        {"type": "blob", "path": "skill/nosha"},
    ]);
    let tree = tree.as_array().unwrap();
    let signature = source_signature_from_tree(tree, "skill").unwrap();
    let mut hasher = Sha256::new();
    hasher.update("skill/a.txt:aaa\nskill/sub/b.txt:bbb");
    assert_eq!(signature, format!("{:x}", hasher.finalize()));
    assert!(source_signature_from_tree(tree, "missing").is_none());
    assert!(source_signature_from_tree(&[], "skill").is_none());
    assert!(source_signature_from_tree(tree, "").is_none());
}

#[test]
fn target_skill_path_guards() {
    let temp = TestDir::new("tsp");
    let root = temp.path().join("skills");
    assert_eq!(
        target_skill_path(&root, "a/b"),
        Some(resolve_lexical(&root.join("a").join("b")))
    );
    fs::create_dir_all(&root).unwrap();
    assert_eq!(target_skill_path(&root, "../x"), None);
    assert_eq!(target_skill_path(&root, "/etc/x"), None);
    let outside = temp.path().join("outside");
    fs::create_dir_all(&outside).unwrap();
    symlink_dir(&outside, &root.join("link")).unwrap();
    assert_eq!(target_skill_path(&root, "link/x"), None);
    fs::create_dir_all(root.join("group")).unwrap();
    assert!(target_skill_path(&root, "group/x").is_some());
    let file_root = temp.path().join("file-root");
    fs::write(&file_root, b"x").unwrap();
    assert_eq!(target_skill_path(&file_root, "a"), None);
}

#[test]
fn assert_not_nested_semantics() {
    let base = Path::new("/tmp/ccgui-nest-check");
    assert!(assert_not_nested(base, base).is_ok());
    assert!(assert_not_nested(base, &base.join("child")).is_err());
    assert!(assert_not_nested(&base.join("child"), base).is_err());
    assert!(assert_not_nested(&base.join("a"), &base.join("b")).is_ok());
}

#[test]
fn classify_in_dirs_three_states() {
    let temp = TestDir::new("classify");
    let base = temp.path().join("skills");
    fs::create_dir_all(&base).unwrap();
    assert_eq!(classify_in_dirs("demo", std::slice::from_ref(&base)), "off");
    fs::create_dir_all(base.join("demo")).unwrap();
    assert_eq!(
        classify_in_dirs("demo", std::slice::from_ref(&base)),
        "synced"
    );
    fs::remove_dir_all(base.join("demo")).unwrap();
    symlink_dir(
        Path::new("/nonexistent-ccgui-test-target"),
        &base.join("demo"),
    )
    .unwrap();
    assert_eq!(
        classify_in_dirs("demo", std::slice::from_ref(&base)),
        "orphan"
    );
}

#[test]
fn classify_target_skill_with_home_env() {
    let sandbox = Sandbox::new("home");
    let claude_skills = sandbox.home.path().join(".claude").join("skills");
    fs::create_dir_all(&claude_skills).unwrap();
    assert_eq!(classify_target_skill("demo", "claude"), "off");
    fs::create_dir_all(claude_skills.join("demo")).unwrap();
    assert_eq!(classify_target_skill("demo", "claude"), "synced");
    fs::remove_dir_all(claude_skills.join("demo")).unwrap();
    symlink_dir(
        Path::new("/nonexistent-ccgui-test-target"),
        &claude_skills.join("demo"),
    )
    .unwrap();
    assert_eq!(classify_target_skill("demo", "claude"), "orphan");
    assert_eq!(classify_target_skill("demo", "bogus-target"), "off");
}

#[test]
fn registry_roundtrip_and_defaults() {
    let temp = TestDir::new("registry");
    let store = TestDir::new("registry-store");
    let _env = EnvGuard::new(&[("CCGUI_SKILLS_HUB_HOME", store.path())]);
    let registry = Registry {
        repos: default_repos(),
        skills: vec![json!({"id": "o/n:dir", "directory": "dir", "targets": ["claude"]})],
    };
    save_registry(&registry).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(registry_path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    let loaded = read_registry();
    assert_eq!(loaded.repos.len(), 4);
    assert_eq!(loaded.skills.len(), 1);
    assert_eq!(
        loaded.skills[0].get("id").and_then(Value::as_str),
        Some("o/n:dir")
    );
    fs::write(registry_path(), b"not json").unwrap();
    let loaded = read_registry();
    assert!(loaded.skills.is_empty());
    assert_eq!(loaded.repos.len(), 4);
    fs::write(registry_path(), br#"{"repos":123,"skills":{}}"#).unwrap();
    let loaded = read_registry();
    assert_eq!(loaded.repos.len(), 4);
    assert_eq!(
        loaded.repos[0].get("owner").and_then(Value::as_str),
        Some("anthropics")
    );
    assert!(loaded.skills.is_empty());
    let _ = fs::remove_file(registry_path());
    let loaded = read_registry();
    assert_eq!(loaded.repos.len(), 4);
    assert!(loaded.skills.is_empty());
    let _ = &temp;
}

#[test]
fn purge_expired_trash_ttl() {
    let store = TestDir::new("trash");
    let _env = EnvGuard::new(&[("CCGUI_SKILLS_HUB_HOME", store.path())]);
    let old_stamp = now_ms() - (TRASH_TTL_MS + 60_000);
    let new_stamp = now_ms();
    let old_trash = trash_dir().join("b2xk-1");
    fs::create_dir_all(&old_trash).unwrap();
    let registry = Registry {
        repos: default_repos(),
        skills: vec![
            json!({"id": "o/n:old", "directory": "old", "trashedAt": old_stamp, "trashedDirectory": "b2xk-1"}),
            json!({"id": "o/n:new", "directory": "new", "trashedAt": new_stamp, "trashedDirectory": "bmv3-2"}),
            json!({"id": "o/n:live", "directory": "live"}),
        ],
    };
    save_registry(&registry).unwrap();
    purge_expired_trash();
    let after = read_registry();
    assert_eq!(after.skills.len(), 2);
    assert!(after
        .skills
        .iter()
        .all(|s| s.get("directory").and_then(Value::as_str) != Some("old")));
    assert!(!old_trash.exists());
}

// ===== 只读来源与删除保护（本仓库新增语义） =====

#[test]
fn bundled_creator_skill_is_readonly_everywhere() {
    let sandbox = Sandbox::new("bundled");
    let claude_skills = sandbox.home.path().join(".claude").join("skills");
    let codex_skills = sandbox.home.path().join(".codex").join("skills");
    write_skill(
        &claude_skills,
        crate::creator_skill::SKILL_ID,
        crate::creator_skill::SKILL_ID,
    );
    write_skill(
        &codex_skills,
        crate::creator_skill::SKILL_ID,
        crate::creator_skill::SKILL_ID,
    );

    assert_eq!(
        readonly_kind_for_dir(crate::creator_skill::SKILL_ID),
        Some(ReadonlyKind::Builtin)
    );
    // 删除被拒绝，磁盘文件原样保留。
    let error = delete_local_skill(crate::creator_skill::SKILL_ID, &[]).expect_err("must refuse");
    assert!(
        matches!(error, SkillError::Coded("readonly", _)),
        "got {error:?}"
    );
    assert!(claude_skills.join(crate::creator_skill::SKILL_ID).is_dir());
    assert!(codex_skills.join(crate::creator_skill::SKILL_ID).is_dir());
    // 导入同样拒绝（复制到 SSOT 会按同名覆盖引擎目录的原物）。
    let error = import_local_skill(crate::creator_skill::SKILL_ID, &[]).expect_err("must refuse");
    assert!(
        matches!(error, SkillError::Coded("readonly", _)),
        "got {error:?}"
    );
}

#[test]
fn system_and_plugin_sources_are_listed_readonly() {
    let sandbox = Sandbox::new("readonly-scan");
    let codex_home = sandbox.home.path().join(".codex");
    write_skill(
        &codex_home.join("skills").join(".system"),
        "sys-skill",
        "sys-skill",
    );
    let plugin_dir = codex_home
        .join("plugins")
        .join("cache")
        .join("market")
        .join("p1")
        .join("1.0.0")
        .join("skills");
    write_skill(&plugin_dir, "plugin-skill", "plugin-skill");

    let skills = list_installed_skills();
    let sys = skills
        .iter()
        .find(|s| js_string(s.get("directory")) == "sys-skill")
        .expect("system skill listed");
    assert_eq!(js_string(sys.get("sourceKind")), "system");
    assert_eq!(sys.get("readonly"), Some(&json!(true)));
    let plugin = skills
        .iter()
        .find(|s| js_string(s.get("directory")) == "plugin-skill")
        .expect("plugin skill listed");
    assert_eq!(js_string(plugin.get("sourceKind")), "plugin");
    assert_eq!(plugin.get("readonly"), Some(&json!(true)));

    for directory in ["sys-skill", "plugin-skill"] {
        let error = delete_local_skill(directory, &[]).expect_err("readonly source must refuse");
        assert!(
            matches!(error, SkillError::Coded("readonly", _)),
            "got {error:?}"
        );
        let error = import_local_skill(directory, &[]).expect_err("readonly source must refuse");
        assert!(
            matches!(error, SkillError::Coded("readonly", _)),
            "got {error:?}"
        );
    }
}

#[test]
fn local_skills_are_deletable_and_managed_ones_need_uninstall() {
    let sandbox = Sandbox::new("local-delete");
    let claude_skills = sandbox.home.path().join(".claude").join("skills");
    write_skill(&claude_skills, "plain", "plain");
    write_skill(
        &sandbox.home.path().join(".codex").join("skills"),
        "plain",
        "plain",
    );

    let skills = list_installed_skills();
    let plain = skills
        .iter()
        .find(|s| js_string(s.get("directory")) == "plain")
        .expect("local skill listed");
    assert_eq!(js_string(plain.get("sourceKind")), "local");
    assert_eq!(plain.get("readonly"), Some(&json!(false)));
    assert!(scan_target_skill("plain", "codex"));

    let result = delete_local_skill("plain", &["codex".to_string()]).expect("delete");
    let results = result.get("targetResults").unwrap().as_array().unwrap();
    assert_eq!(results[0].get("ok"), Some(&json!(true)));
    assert!(!scan_target_skill("plain", "codex"));
    assert!(
        scan_target_skill("plain", "claude"),
        "claude copy untouched"
    );

    // 受管条目走卸载，不走 delete_local。
    let store_managed = managed_skill_path("plain").unwrap();
    fs::create_dir_all(&store_managed).unwrap();
    fs::write(store_managed.join("SKILL.md"), "---\nname: plain\n---\n").unwrap();
    let mut registry = read_registry();
    registry.skills.push(json!({
        "id": "local:plain",
        "key": "local:plain",
        "directory": "plain",
        "name": "plain",
        "targets": ["claude"],
    }));
    save_registry(&registry).unwrap();
    let error = delete_local_skill("plain", &[]).expect_err("managed refuses");
    assert!(
        matches!(error, SkillError::Coded("conflict", _)),
        "got {error:?}"
    );
}

#[test]
fn unknown_targets_are_rejected_not_silently_filtered() {
    let sandbox = Sandbox::new("targets");
    let dest = managed_skill_path("demo").unwrap();
    write_skill(dest.parent().unwrap(), "demo", "demo");
    let mut registry = read_registry();
    registry.skills.push(json!({
        "id": "local:demo",
        "key": "local:demo",
        "directory": "demo",
        "name": "demo",
        "targets": [],
    }));
    save_registry(&registry).unwrap();
    let error =
        set_skill_targets("local:demo", &["bogus".to_string()]).expect_err("unknown target");
    assert!(
        matches!(error, SkillError::Coded("invalid_input", _)),
        "got {error:?}"
    );
    // 全量目标的每个 id 都是合法输入（逐个写盘不是重点，这里验证门禁）。
    for target in TARGETS.iter().filter(|t| t.visible) {
        validate_targets(&[target.id.to_string()]).expect(target.id);
    }
    let _ = &sandbox;
}

#[test]
fn target_list_covers_every_cli_and_reports_availability() {
    let sandbox = Sandbox::new("target-list");
    let home = sandbox.home.path();
    let list = target_list();
    let ids: Vec<&str> = list
        .iter()
        .map(|t| t.get("id").and_then(Value::as_str).unwrap())
        .collect();
    assert_eq!(
        ids,
        vec![
            "claude",
            "codex",
            "cursor",
            "kimi",
            "grok",
            "pi",
            "omp",
            "dsh",
            "agy",
            "gemini",
            "opencode",
            "qoder",
            "qoder-cn",
            "hermes",
        ]
    );
    // 隐藏的 agents 目标不进 UI 列表。
    assert!(!ids.contains(&"agents"));
    // 空 sandbox：一个引擎都没装。
    assert!(list
        .iter()
        .all(|t| t.get("available") == Some(&json!(false))));
    // 建好 home 的目标才可用；Antigravity 的任一 home 都算已装。
    for dir in [".claude", ".grok", ".gemini/antigravity", ".qoder-cn"] {
        fs::create_dir_all(home.join(dir)).unwrap();
    }
    let available = |id: &str| {
        target_list()
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(id))
            .and_then(|t| t.get("available"))
            .and_then(Value::as_bool)
            .unwrap()
    };
    assert!(available("claude"), "claude home exists");
    assert!(available("grok"), "grok home exists");
    assert!(available("qoder-cn"), "qoder-cn home exists");
    assert!(available("agy"), "antigravity app home exists");
    assert!(!available("codex"), "no codex home");
    assert!(!available("hermes"), "no hermes home");
}

/// 每装一个引擎就把受管副本写进它自己的 skills 根，移除时也逐目标清干净：
/// “支持全部 CLI”不是列表多几行，而是同步/移除真的落到各自目录。
#[test]
fn sync_and_remove_reach_every_engine_root() {
    let sandbox = Sandbox::new("all-engines");
    let home = sandbox.home.path();
    // 全部 visible 目标的 home 都存在 → 每个都是可用目标。
    for target in TARGETS.iter().filter(|t| t.visible) {
        for home_dir in target_home_dirs(target) {
            fs::create_dir_all(&home_dir).unwrap();
        }
    }
    let dest = managed_skill_path("demo").unwrap();
    write_skill(dest.parent().unwrap(), "demo", "demo");
    let ids: Vec<String> = TARGETS
        .iter()
        .filter(|t| t.visible)
        .map(|t| t.id.to_string())
        .collect();
    let (all_ok, results) = sync_targets_with_results("demo", &ids);
    assert!(all_ok, "every target syncs: {results:?}");
    for target in TARGETS.iter().filter(|t| t.visible) {
        assert_eq!(classify_target_skill("demo", target.id), "synced");
        for dir in target_dirs(target) {
            assert!(
                dir.join("demo").join("SKILL.md").is_file(),
                "{} missing",
                dir.display()
            );
            assert!(dir.starts_with(home), "{} escaped the sandbox", dir.display());
        }
    }
    // 隐藏的 agents 目标同样参与（`visible=false` 只影响列表）。
    let (agents_ok, _) = sync_targets_with_results("demo", &["agents".to_string()]);
    assert!(agents_ok);
    assert_eq!(classify_target_skill("demo", "agents"), "synced");
    let mut all_ids = ids.clone();
    all_ids.push("agents".to_string());
    let results = remove_targets_with_results("demo", &all_ids);
    assert!(results.iter().all(|r| r.get("ok") == Some(&json!(true))), "{results:?}");
    for target in TARGETS.iter() {
        assert_eq!(classify_target_skill("demo", target.id), "off");
    }
}

/// 内置 skill 落到每个已安装引擎的 skills 根（不是只给 Claude / Codex）。
#[test]
fn creator_skill_roots_cover_every_installed_cli() {
    let sandbox = Sandbox::new("builtin-roots");
    let home = sandbox.home.path();
    for dir in [
        ".claude",
        ".grok",
        ".pi/agent",
        ".dsh",
        ".config/opencode",
        ".hermes",
        ".agents",
    ] {
        fs::create_dir_all(home.join(dir)).unwrap();
    }
    let roots = crate::creator_skill::engine_skill_roots();
    for expected in [
        ".claude/skills",
        ".grok/skills",
        ".pi/agent/skills",
        ".dsh/skills",
        ".config/opencode/skills",
        ".hermes/skills",
        ".agents/skills",
    ] {
        assert!(
            roots.contains(&home.join(expected)),
            "{expected} missing from {roots:?}"
        );
    }
    // 没装的引擎不写入（`.codex` 不存在）。
    assert!(!roots.contains(&home.join(".codex/skills")), "{roots:?}");
}

#[test]
fn sync_target_results_report_partial_failure() {
    let store = TestDir::new("syr");
    let _env = EnvGuard::new(&[("CCGUI_SKILLS_HUB_HOME", store.path())]);
    // 源不存在：两个目标都失败，但结果逐目标给出。
    let (all_ok, results) =
        sync_targets_with_results("missing-skill", &["claude".into(), "codex".into()]);
    assert!(!all_ok);
    assert_eq!(results.len(), 2);
    assert!(results.iter().all(|r| r.get("ok") == Some(&json!(false))));
    assert!(results
        .iter()
        .all(|r| r.get("error").and_then(Value::as_str).is_some()));
}

/// 移除时用户自己的来源副本被保留：结果必须标 `kept`，否则 UI 只能报“已移除”，
/// 刷新后图标还在，自相矛盾。
#[test]
fn remove_reports_a_kept_user_copy_instead_of_claiming_removal() {
    let sandbox = Sandbox::new("kept");
    let claude_skills = sandbox.home.path().join(".claude").join("skills");
    let codex_skills = sandbox.home.path().join(".codex").join("skills");
    write_skill(&claude_skills, "demo", "demo");
    let skill = import_local_skill("demo", &["claude".to_string(), "codex".to_string()])
        .expect("import");
    let id = js_string(skill.get("skill").and_then(|s| s.get("id")));
    assert_eq!(classify_target_skill("demo", "codex"), "synced");

    // 全部目标都关掉：codex 副本被删，claude 是用户自己的目录，保留。
    let removed = set_skill_targets(&id, &[]).expect("remove all");
    let results = removed
        .get("targetResults")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let entry = |target: &str| {
        results
            .iter()
            .find(|r| r.get("target").and_then(Value::as_str) == Some(target))
            .cloned()
            .unwrap_or(Value::Null)
    };
    assert_eq!(entry("codex").get("kept"), Some(&json!(false)));
    assert_eq!(entry("codex").get("ok"), Some(&json!(true)));
    assert_eq!(entry("claude").get("kept"), Some(&json!(true)));
    assert_eq!(entry("claude").get("ok"), Some(&json!(true)));
    assert!(!codex_skills.join("demo").exists());
    assert!(claude_skills.join("demo").join("SKILL.md").is_file());
}

// ===== skill usage =====

fn write_transcript(projects_dir: &Path, project: &str, file: &str, lines: &[String]) {
    let dir = projects_dir.join(project);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(file), format!("{}\n", lines.join("\n"))).unwrap();
}

fn skill_block_line(ts: &str, blocks: &[(&str, &str)], usage: &str) -> String {
    let content: Vec<String> = blocks
        .iter()
        .map(|(id, skill)| {
            format!(
                r#"{{"type":"tool_use","name":"Skill","id":"{id}","input":{{"skill":"{skill}"}}}}"#
            )
        })
        .collect();
    format!(
        r#"{{"timestamp":"{ts}","message":{{"model":"m","usage":{usage},"content":[{}]}}}}"#,
        content.join(",")
    )
}

#[test]
fn read_skill_content_reads_engine_copy_and_rejects_traversal() {
    let sandbox = Sandbox::new("content");
    let claude_skills = sandbox.home.path().join(".claude").join("skills");
    write_skill(&claude_skills, "plain", "plain");
    let payload = read_skill_content("plain").expect("content");
    assert!(js_string(payload.get("markdown")).contains("name: plain"));
    assert_eq!(payload.get("truncated"), Some(&json!(false)));
    // 绝对路径 / 穿越一律拒绝。
    let error = read_skill_content("../plain").expect_err("traversal");
    assert!(
        matches!(error, SkillError::Coded("invalid_input", _)),
        "got {error:?}"
    );
    let error = read_skill_content("/etc/passwd").expect_err("absolute");
    assert!(
        matches!(error, SkillError::Coded("invalid_input", _)),
        "got {error:?}"
    );
    let error = read_skill_content("missing").expect_err("missing");
    assert!(
        matches!(error, SkillError::Coded("not_found", _)),
        "got {error:?}"
    );
}

/// 阶段 2 验收等价用例（全部临时目录）：导入 → 同步两个引擎 → 移除一个副本
/// → 卸载 → 恢复；用户自己的本地来源目录全程不受损。
#[test]
fn local_lifecycle_import_sync_remove_uninstall_restore() {
    let sandbox = Sandbox::new("lifecycle");
    let claude_skills = sandbox.home.path().join(".claude").join("skills");
    write_skill(&claude_skills, "demo", "demo");

    // 导入并同步到两个引擎；claude 侧保留用户自己的目录（不进受管副本）。
    let imported =
        import_local_skill("demo", &["claude".to_string(), "codex".to_string()]).expect("import");
    let id = js_string(imported.get("skill").and_then(|skill| skill.get("id")));
    assert_eq!(id, "local:demo");
    assert_eq!(classify_target_skill("demo", "claude"), "synced");
    assert_eq!(classify_target_skill("demo", "codex"), "synced");
    assert!(managed_skill_path("demo").unwrap().is_dir());
    assert!(!is_symlink(&claude_skills.join("demo")));

    // 移除 codex 副本：codex 摘掉，claude 的用户目录不受影响。
    let updated = set_skill_targets(&id, &["claude".to_string()]).expect("set targets");
    let results = updated.get("targetResults").unwrap().as_array().unwrap();
    assert!(
        results
            .iter()
            .all(|result| result.get("ok") == Some(&json!(true))),
        "got {results:?}"
    );
    assert_eq!(classify_target_skill("demo", "codex"), "off");
    assert_eq!(classify_target_skill("demo", "claude"), "synced");

    // 卸载：应用创建的副本（codex）被移除，托管原件进回收站；用户本地副本保留。
    let uninstalled = uninstall_skill(&id).expect("uninstall");
    assert_eq!(uninstalled.get("trashed"), Some(&json!(true)));
    assert_eq!(classify_target_skill("demo", "codex"), "off");
    assert!(!managed_skill_path("demo").unwrap().exists());
    assert!(claude_skills.join("demo").join("SKILL.md").is_file());
    // 卸载结果逐目标上报：受保护的用户副本不算失败。
    let removal_results = uninstalled
        .get("targetResults")
        .unwrap()
        .as_array()
        .unwrap();
    assert!(
        removal_results
            .iter()
            .all(|result| result.get("ok") == Some(&json!(true))),
        "got {removal_results:?}"
    );

    // 恢复：按卸载前记录的目标（claude）重建；它指向用户自己的目录，保持原样。
    let restored = restore_skill(&id).expect("restore");
    assert_eq!(
        js_string(restored.get("skill").and_then(|skill| skill.get("managed"))),
        "true"
    );
    assert!(managed_skill_path("demo").unwrap().is_dir());
    assert_eq!(classify_target_skill("demo", "claude"), "synced");
    assert_eq!(classify_target_skill("demo", "codex"), "off");
    assert!(claude_skills.join("demo").join("SKILL.md").is_file());
}

#[test]
fn usage_scan_dedup_share_and_last_used() {
    let home = TestDir::new("usage-home");
    let store = TestDir::new("usage-skills");
    let _env = EnvGuard::new(&[("CCGUI_SKILLS_HUB_HOME", store.path())]);
    let projects = home.path().join(".claude").join("projects");

    let line_b1 = skill_block_line(
        "2026-01-02T00:00:00.000Z",
        &[("b1", "pdf")],
        r#"{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":20,"cache_creation_input_tokens":10}"#,
    );
    write_transcript(&projects, "p1", "a.jsonl", std::slice::from_ref(&line_b1));
    write_transcript(
        &projects,
        "p1",
        "b.jsonl",
        &[
            line_b1,
            skill_block_line(
                "2026-01-01T00:00:00.000Z",
                &[("b2", "pdf"), ("b3", "xlsx")],
                r#"{"input_tokens":90,"output_tokens":30}"#,
            ),
            r#"{"message":{"content":[{"type":"tool_use","name":"Other"}]}}"#.to_string(),
            r#"{"name":"Skill" broken"#.to_string(),
        ],
    );

    let result = scan_skill_usage_in(&projects, false);
    assert_eq!(result.get("scannedFiles").and_then(Value::as_i64), Some(2));
    assert_eq!(
        result.get("totalInvocations").and_then(Value::as_i64),
        Some(3)
    );
    assert_eq!(result.get("cached").and_then(Value::as_bool), Some(false));
    let skills = result.get("skills").and_then(Value::as_array).unwrap();
    assert_eq!(skills.len(), 2);
    let pdf = &skills[0];
    assert_eq!(pdf.get("skill").and_then(Value::as_str), Some("pdf"));
    assert_eq!(pdf.get("invocations").and_then(Value::as_i64), Some(2));
    assert_eq!(
        pdf.get("lastUsedAt").and_then(Value::as_str),
        Some("2026-01-02T00:00:00.000Z")
    );
    let pdf_tokens = pdf.get("tokens").unwrap();
    assert_eq!(
        pdf_tokens.get("input_tokens").and_then(Value::as_i64),
        Some(145)
    );
    assert_eq!(
        pdf_tokens.get("output_tokens").and_then(Value::as_i64),
        Some(65)
    );
    assert_eq!(
        pdf_tokens.get("total_tokens").and_then(Value::as_i64),
        Some(240)
    );
    let xlsx = &skills[1];
    assert_eq!(xlsx.get("invocations").and_then(Value::as_i64), Some(1));
    assert_eq!(
        xlsx.get("tokens")
            .unwrap()
            .get("total_tokens")
            .and_then(Value::as_i64),
        Some(60)
    );

    let cached = scan_skill_usage_in(&projects, false);
    assert_eq!(cached.get("cached").and_then(Value::as_bool), Some(true));
    assert_eq!(
        cached.get("totalInvocations").and_then(Value::as_i64),
        Some(3)
    );

    write_transcript(
        &projects,
        "p1",
        "c.jsonl",
        &[skill_block_line(
            "2026-01-03T00:00:00.000Z",
            &[("b9", "pptx")],
            r#"{"input_tokens":7}"#,
        )],
    );
    let refreshed = scan_skill_usage_in(&projects, false);
    assert_eq!(
        refreshed.get("cached").and_then(Value::as_bool),
        Some(false)
    );
    assert_eq!(
        refreshed.get("totalInvocations").and_then(Value::as_i64),
        Some(4)
    );
    assert_eq!(
        refreshed.get("scannedFiles").and_then(Value::as_i64),
        Some(3)
    );
}

#[test]
fn usage_query_marks_scope_and_joins_installed() {
    let sandbox = Sandbox::new("usage-query");
    let projects = sandbox.home.path().join(".claude").join("projects");
    write_transcript(
        &projects,
        "p1",
        "a.jsonl",
        &[skill_block_line(
            "2026-01-02T00:00:00.000Z",
            &[("u1", "plain")],
            r#"{"input_tokens":10}"#,
        )],
    );
    write_skill(
        &sandbox.home.path().join(".claude").join("skills"),
        "plain",
        "plain",
    );

    let result = skill_usage_query(false);
    assert_eq!(
        result.get("scope").and_then(Value::as_str),
        Some(USAGE_SCOPE_CLAUDE_TRANSCRIPTS)
    );
    assert_eq!(result.get("engine").and_then(Value::as_str), Some("claude"));
    let skills = result.get("skills").and_then(Value::as_array).unwrap();
    assert_eq!(skills.len(), 1);
    assert_eq!(skills[0].get("installed"), Some(&json!(true)));
    assert_eq!(
        skills[0].get("skillId").and_then(Value::as_str),
        Some("local:plain")
    );
}

#[test]
fn usage_missing_transcripts_reports_zero_not_fabricated() {
    let sandbox = Sandbox::new("usage-empty");
    let result = skill_usage_query(false);
    assert_eq!(result.get("scannedFiles").and_then(Value::as_i64), Some(0));
    assert_eq!(
        result.get("totalInvocations").and_then(Value::as_i64),
        Some(0)
    );
    assert!(result
        .get("skills")
        .and_then(Value::as_array)
        .map(|skills| skills.is_empty())
        .unwrap_or(false));
    let _ = &sandbox;
}

/// skills.sh 的 id 与仓库目录名对齐：同名 / 去掉仓库前缀 / `:` 换 `-`；
/// 对不上返回 None（宁可报 not_found，也不拿别的技能正文冒充）。
#[test]
fn resolve_skill_dir_in_tree_matches_skills_sh_ids() {
    let tree = vec![
        json!({"type": "blob", "path": "skills/web-design-guidelines/SKILL.md"}),
        json!({"type": "blob", "path": "skills/react-best-practices/SKILL.md"}),
        json!({"type": "blob", "path": "deep/nested/react-best-practices/SKILL.md"}),
        json!({"type": "blob", "path": "plugins/stitch-build/skills/react-components/SKILL.md"}),
        json!({"type": "blob", "path": "skills/react-best-practices/references/notes.md"}),
        json!({"type": "tree", "path": "skills/react-best-practices"}),
        json!({"type": "blob", "path": "README.md"}),
    ];
    let dir_for = |id: &str| resolve_skill_dir_in_tree(&tree, id).unwrap_or_default();

    assert_eq!(
        dir_for("web-design-guidelines"),
        "skills/web-design-guidelines"
    );
    // 同名目录多处时取最浅的那个。
    assert_eq!(
        dir_for("react-best-practices"),
        "skills/react-best-practices"
    );
    // skills.sh 的 id 带仓库前缀（vercel-labs/agent-skills 的实际情况）。
    assert_eq!(
        dir_for("vercel-react-best-practices"),
        "skills/react-best-practices"
    );
    // `react:components` 在仓库里是 `react-components`。
    assert_eq!(
        dir_for("react:components"),
        "plugins/stitch-build/skills/react-components"
    );
    assert_eq!(dir_for("no-such-skill"), "");
    // 根目录 SKILL.md 不是目录对齐的责任。
    assert_eq!(dir_for("skills"), "");

    // 安装路径：给定目录可用时原样返回，不可用时回落到对齐结果。
    assert_eq!(
        resolve_existing_skill_dir(&tree, "skills/react-best-practices").unwrap_or_default(),
        "skills/react-best-practices"
    );
    assert_eq!(
        resolve_existing_skill_dir(&tree, "vercel-react-best-practices").unwrap_or_default(),
        "skills/react-best-practices"
    );
    assert_eq!(resolve_existing_skill_dir(&tree, "nope"), None);
    assert!(dir_has_skill_md(&tree, "skills/web-design-guidelines"));
    // 目录集合按前缀取（上游同款）：目录下没有 SKILL.md 就不算可安装目录。
    assert!(!dir_has_skill_md(
        &tree,
        "skills/react-best-practices/references"
    ));
}

/// 联网冒烟（默认 ignore，手动跑）：
/// `cargo test --lib remote_skill_content_live -- --ignored --nocapture`
/// 覆盖 skills.sh 的真实形态：id 带仓库前缀（`vercel-react-best-practices`）
/// 也要能解析到 `skills/react-best-practices/SKILL.md` 并读回 frontmatter。
#[ignore = "network: hits api.github.com and raw.githubusercontent.com"]
#[tokio::test]
async fn remote_skill_content_live_reads_the_repo_file() {
    let payload = remote_skill_content(
        "vercel-labs",
        "agent-skills",
        "main",
        "vercel-react-best-practices",
    )
    .await
    .expect("remote content");
    assert_eq!(
        js_string(payload.get("path")),
        "skills/react-best-practices/SKILL.md"
    );
    assert!(
        payload
            .get("markdown")
            .and_then(Value::as_str)
            .map(|text| text.contains("name:"))
            .unwrap_or(false),
        "{payload:?}"
    );
    assert!(!js_string(payload.get("description")).is_empty(), "{payload:?}");

    // 仓库里确实没有的技能要报 not_found，而不是随便挑一个 SKILL.md。
    let missing = remote_skill_content("github", "awesome-copilot", "main", "gh-cli").await;
    match missing.expect_err("must be not_found") {
        SkillError::Coded(code, _) => assert_eq!(code, "not_found"),
        other => panic!("unexpected error: {other:?}"),
    }
}
