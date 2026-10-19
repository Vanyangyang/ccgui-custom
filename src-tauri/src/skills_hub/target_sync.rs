//! Skills hub 后端：从参考项目 desktop-cc-gui 的 Rust 移植 `skills_hub/` 迁移而来
//! （MIT，Copyright (c) 2026 Thomas Ricouard / zhukunpenglinyutong（朱昆鹏）），
//! 上游可溯源到 TokenTracker 的 `skills-manager.js` / `skill-usage.js`（MIT）。
//!
//! 与参考实现的差异（均为适配本仓库）：
//! 1. SSOT 根目录为本应用数据目录下的 `skills-hub/`（`paths::app_home()`），
//!    可用 env `CCGUI_SKILLS_HUB_HOME` 覆盖（测试注入点）。参考实现用
//!    `~/.ccgui/skills`，与本应用的可写存储隔离，不共享注册表。
//! 2. 同步目标覆盖本应用接入的全部 CLI（Claude / Codex / Kimi / Grok / PI /
//!    OMP / dsh / Antigravity / Gemini / OpenCode / Qoder / Qoder CN / Hermes）
//!    加跨 agent 的 `~/.agents`；引擎目录解析走 `engine::engine_home` 与
//!    `engine::codex_home`，尊重各 CLI 自己的 env（`CLAUDE_CONFIG_DIR` /
//!    `CODEX_HOME` / `GROK_HOME` / `PI_CODING_AGENT_DIR`…）与设置页的 Codex
//!    目录覆盖。只出现在 CLI 目录、不属于本应用托管的目标是只读来源
//!    （Codex / dsh 的 `.system`、Codex 插件缓存、随包分发的内置 skill）。
//! 3. skill_usage 的统计范围固定为 Claude Code 会话转录
//!    （`<claude home>/projects/**/*.jsonl`），响应带 scope 字段说明；其他
//!    引擎没有可可靠读取的 Skill 调用记录，不可用时显示"暂无可用数据"。
//! 4. 删除/卸载入口对只读来源（内置、系统、插件）一律拒绝，保护
//!    `creator_skill.rs` 安装的随包 skill。

use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;

use super::core::*;
use super::fsutil::*;
use super::registry::*;
use super::scan::*;
// ===== classify / scan / sync / remove / installed 列表 =====

/// 单个 (skill, target) 的磁盘三态（upstream classifyTargetSkill 的多目录版核心）：
/// 任一 baseDir 下存在（symlink 可 resolve 或实体）→ "synced"（短路）；
/// 否则若候选是悬空 symlink → "orphan"；否则 "off"。
pub(super) fn classify_in_dirs(directory: &str, base_dirs: &[PathBuf]) -> &'static str {
    let mut state = "off";
    for base_dir in base_dirs {
        let Some(candidate) = target_skill_path(base_dir, directory) else {
            continue;
        };
        if candidate.exists() {
            return "synced";
        }
        if is_symlink(&candidate) {
            state = "orphan";
        }
    }
    state
}

pub(super) fn classify_target_skill(directory: &str, target_id: &str) -> &'static str {
    let Some(target) = target_by_id(target_id) else {
        return "off";
    };
    classify_in_dirs(directory, &target_dirs(target))
}

/// upstream scanTargetSkill：任一 baseDir 下候选存在（含 symlink）即 true。
pub(super) fn scan_target_skill(directory: &str, target_id: &str) -> bool {
    let Some(target) = target_by_id(target_id) else {
        return false;
    };
    target_dirs(target).iter().any(|base_dir| {
        target_skill_path(base_dir, directory)
            .map(|candidate| candidate.exists() || is_symlink(&candidate))
            .unwrap_or(false)
    })
}

/// import 时记录的本地来源目录：这是用户自己的文件，同步与移除都必须避开它，
/// 否则「纳管」会静默覆盖/删除用户的本地副本（迁移计划 §3.2 的硬性要求）。
fn preserved_source_for(directory: &str) -> Option<PathBuf> {
    let registry = read_registry();
    registry
        .skills
        .iter()
        .filter(|entry| trashed_at_of(entry).is_none())
        .find(|entry| eq_ignore_case(&js_string(entry.get("directory")), directory))
        .and_then(|entry| entry.get("sourcePath"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// upstream syncSkillToTarget：SSOT → target 的 symlink，任何失败回退整目录递归 copy。
pub(super) fn sync_skill_to_target(directory: &str, target_id: &str) -> SkillResult<()> {
    let target = target_by_id(target_id)
        .ok_or_else(|| SkillError::other(format!("Unsupported target: {target_id}")))?;
    let source = managed_skill_path(directory)?;
    if !source.exists() {
        return Err(SkillError::other(format!(
            "Managed skill not found: {directory}"
        )));
    }
    let preserved = preserved_source_for(directory);
    for base_dir in target_dirs(target) {
        let dest = target_skill_path(&base_dir, directory)
            .ok_or_else(|| SkillError::other(format!("Invalid skill directory: {directory}")))?;
        // 用户自己的来源副本保持原样；它本来就被视为该目标的一份副本。
        if preserved.as_deref() == Some(dest.as_path()) {
            continue;
        }
        assert_not_nested(&source, &dest)?;
        if let Some(parent) = dest.parent() {
            ensure_dir(parent)?;
        }
        remove_path(&dest);
        if symlink_dir(&source, &dest).is_err() {
            copy_dir(&source, &dest)?;
        }
    }
    Ok(())
}

/// upstream removeSkillFromTarget：removePath + 逐级清理空祖先到 baseDir。
pub(super) fn remove_skill_from_target(directory: &str, target_id: &str) {
    let Some(target) = target_by_id(target_id) else {
        return;
    };
    let preserved = preserved_source_for(directory);
    for base_dir in target_dirs(target) {
        let Some(target_path) = target_skill_path(&base_dir, directory) else {
            continue;
        };
        if preserved.as_deref() == Some(target_path.as_path()) {
            continue;
        }
        remove_path(&target_path);
        if let Some(parent) = target_path.parent() {
            remove_empty_ancestors(parent, &base_dir);
        }
    }
}

// ===== 多目标同步结果（逐目标上报，不用整体 ok 掩盖部分失败） =====

/// 逐目标同步并收集结果。调用方（UI）据此把"全部同步完成"与"部分失败"
/// 区分开，而不是拿到一个笼统的成功。
pub(super) fn sync_targets_with_results(
    directory: &str,
    target_ids: &[String],
) -> (bool, Vec<Value>) {
    let mut all_ok = true;
    let mut results = Vec::new();
    for target_id in target_ids {
        match sync_skill_to_target(directory, target_id) {
            Ok(()) => results.push(json!({"target": target_id, "ok": true, "error": Value::Null})),
            Err(error) => {
                all_ok = false;
                results.push(json!({"target": target_id, "ok": false, "error": error.to_string()}));
            }
        }
    }
    (all_ok, results)
}

/// 逐目标移除并回读结果：ok = 该目标下已无该 skill 的实体/悬空链接。
/// 删除本身是 best-effort（与上游一致），但结果不静默：UI 可以告诉用户
/// 哪个引擎副本没删干净。`kept` 标记该目标是用户自己的来源副本（本来就不
/// 在删除范围内，保留它就是正确结果）——UI 据此不要说成“已移除”。
pub(super) fn remove_targets_with_results(directory: &str, target_ids: &[String]) -> Vec<Value> {
    let preserved = preserved_source_for(directory);
    let mut results = Vec::new();
    for target_id in target_ids {
        // 用户自己的来源副本不在删除范围内：保留它就是正确结果。
        let keep_preserved = preserved.as_deref().is_some_and(|path| {
            target_by_id(target_id).is_some_and(|target| {
                target_dirs(target)
                    .iter()
                    .any(|base_dir| target_skill_path(base_dir, directory).as_deref() == Some(path))
            })
        });
        remove_skill_from_target(directory, target_id);
        let gone = !scan_target_skill(directory, target_id);
        results.push(json!({
            "target": target_id,
            "ok": gone || keep_preserved,
            "kept": keep_preserved,
            "error": if gone || keep_preserved { Value::Null } else { json!("copy still present") },
        }));
    }
    results
}

/// 校验前端传来的 target 列表：未知 id 直接拒绝（不静默过滤）。
pub(super) fn validate_targets(target_ids: &[String]) -> SkillResult<()> {
    for id in target_ids {
        if target_by_id(id).is_none() {
            return Err(SkillError::coded(
                "invalid_input",
                format!("Unsupported target: {id}"),
            ));
        }
    }
    Ok(())
}

/// 在 registry skills 中按 `id == id || key == id` 查找（upstream 多个 mutation 共用）。
pub(super) fn find_skill_position(skills: &[Value], id: &str) -> Option<usize> {
    skills.iter().position(|entry| {
        entry.get("id").and_then(Value::as_str) == Some(id)
            || entry.get("key").and_then(Value::as_str) == Some(id)
    })
}

/// upstream listInstalledSkills：先 purge trash，再 managed + unmanaged 合并按 name 排序。
pub(super) fn list_installed_skills() -> Vec<Value> {
    purge_expired_trash();
    let registry = read_registry();
    let mut managed: Vec<Value> = Vec::new();
    for skill in &registry.skills {
        if trashed_at_of(skill).is_some() {
            continue;
        }
        let directory = js_string(skill.get("directory"));
        let intended: HashSet<String> = skill
            .get("targets")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        let mut target_states = Map::new();
        let mut targets: Vec<Value> = Vec::new();
        for target in TARGETS.iter() {
            let mut state = classify_target_skill(&directory, target.id);
            // registry 意图包含但磁盘丢失 → orphan。
            if state == "off" && intended.contains(target.id) {
                state = "orphan";
            }
            target_states.insert(target.id.to_string(), json!(state));
            if state == "synced" {
                targets.push(json!(target.id));
            }
        }
        let mut entry = skill.as_object().cloned().unwrap_or_default();
        entry.insert("managed".to_string(), json!(true));
        entry.insert("targets".to_string(), Value::Array(targets));
        entry.insert("targetStates".to_string(), Value::Object(target_states));
        managed.push(Value::Object(entry));
    }

    let managed_dirs: HashSet<String> = managed
        .iter()
        .map(|skill| js_string(skill.get("directory")).to_lowercase())
        .collect();

    // unmanaged：扫描全部 target 的本地 skill + 只读来源（Codex `.system`、
    // Codex 插件缓存），跨来源按 directory 小写合并。只读来源里的 skill
    // 标记 sourceKind/readonly，UI 据此禁用删除入口。
    let mut unmanaged: Vec<Value> = Vec::new();
    let mut unmanaged_index: HashMap<String, usize> = HashMap::new();

    /// 同类合并时的来源优先级：只读保护重于普通本地条目。
    fn kind_rank(kind: &str) -> u8 {
        match kind {
            "builtin" => 4,
            "system" => 3,
            "plugin" => 2,
            _ => 1,
        }
    }

    let mut roots: Vec<(PathBuf, Option<&'static Target>, Option<&'static str>)> = Vec::new();
    for target in TARGETS.iter() {
        for base_dir in target_dirs(target) {
            roots.push((base_dir, Some(target), None));
        }
    }
    for source in readonly_sources() {
        roots.push((source.dir, None, Some(source.kind.as_str())));
    }

    for (base_dir, target, readonly_kind) in roots {
        for directory in scan_skill_directories(&base_dir) {
            if directory.is_empty() || managed_dirs.contains(&directory.to_lowercase()) {
                continue;
            }
            let Some(marker) = find_skill_marker(&base_dir.join(&directory)) else {
                continue;
            };
            let markdown = read_text(&marker).unwrap_or_default();
            let fallback =
                install_name_from_directory(&directory).unwrap_or_else(|| directory.clone());
            let metadata = read_skill_metadata(&markdown, &fallback);
            // 内置 skill 名保留（creator_skill 安装到各引擎 skills 根），
            // 以及只读来源目录本身，都按只读处理。
            let kind = if is_bundled_skill_name(&directory) {
                "builtin".to_string()
            } else if let Some(kind) = readonly_kind {
                kind.to_string()
            } else {
                "local".to_string()
            };
            let key = directory.to_lowercase();
            let index = match unmanaged_index.get(&key) {
                Some(&i) => i,
                None => {
                    let target_states: Map<String, Value> = TARGETS
                        .iter()
                        .map(|t| (t.id.to_string(), json!("off")))
                        .collect();
                    unmanaged.push(json!({
                        "id": format!("local:{directory}"),
                        "key": format!("local:{directory}"),
                        "name": metadata.name,
                        "description": metadata.description,
                        "directory": directory,
                        "readmeUrl": Value::Null,
                        "repoOwner": Value::Null,
                        "repoName": Value::Null,
                        "repoBranch": Value::Null,
                        "installedAt": Value::Null,
                        "managed": false,
                        "sourceKind": kind,
                        "readonly": kind != "local",
                        "targets": [],
                        "targetStates": Value::Object(target_states),
                        "targetPaths": {},
                    }));
                    unmanaged_index.insert(key, unmanaged.len() - 1);
                    unmanaged.len() - 1
                }
            };
            let entry = &mut unmanaged[index];
            let current_kind = js_string(entry.get("sourceKind"));
            if kind_rank(&kind) > kind_rank(&current_kind) {
                entry["sourceKind"] = json!(kind);
                entry["readonly"] = json!(kind != "local");
            }
            // 只读来源不是某个引擎的受管副本：不参与 targetStates 的 synced 标记。
            let Some(target) = target else {
                if let Some(paths) = entry.get_mut("targetPaths").and_then(Value::as_object_mut) {
                    let label = format!("{}:{}", kind, base_dir.to_string_lossy());
                    paths
                        .entry(label)
                        .or_insert_with(|| json!(base_dir.join(&directory).to_string_lossy()));
                }
                continue;
            };
            if let Some(targets) = entry.get_mut("targets").and_then(Value::as_array_mut) {
                if !targets.iter().any(|t| t.as_str() == Some(target.id)) {
                    targets.push(json!(target.id));
                }
            }
            if let Some(states) = entry.get_mut("targetStates").and_then(Value::as_object_mut) {
                states.insert(target.id.to_string(), json!("synced"));
            }
            if let Some(paths) = entry.get_mut("targetPaths").and_then(Value::as_object_mut) {
                // 只记录首个命中的 target 路径。
                paths
                    .entry(target.id.to_string())
                    .or_insert_with(|| json!(base_dir.join(&directory).to_string_lossy()));
            }
        }
    }

    managed.extend(unmanaged);
    // codepoint 排序（upstream localeCompare 的计划内偏差）；Rust sort_by 稳定。
    managed.sort_by(|a, b| js_string(a.get("name")).cmp(&js_string(b.get("name"))));
    managed
}

/// 读取一个已安装/本地 skill 的 SKILL.md（详情面板用）。目录参数经过与
/// 其它入口相同的相对路径净化与符号链接防护；只返回文本与截断标记，
/// 不接受前端指定的绝对路径。
pub(super) const SKILL_CONTENT_MAX_BYTES: usize = 512 * 1024;

pub(super) fn read_skill_content(directory: &str) -> SkillResult<Value> {
    let Some(safe) = sanitize_local_skill_path(directory) else {
        return Err(SkillError::coded(
            "invalid_input",
            "Invalid skill directory",
        ));
    };
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(managed) = managed_skill_path(&safe) {
        candidates.push(managed);
    }
    for target in TARGETS.iter() {
        for base_dir in target_dirs(target) {
            if let Some(path) = target_skill_path(&base_dir, &safe) {
                candidates.push(path);
            }
        }
    }
    for source in readonly_sources() {
        if let Some(path) = target_skill_path(&source.dir, &safe) {
            candidates.push(path);
        }
    }
    for candidate in candidates {
        let Some(marker) = find_skill_marker(&candidate) else {
            continue;
        };
        let bytes = fs::read(&marker).map_err(SkillError::from)?;
        let truncated = bytes.len() > SKILL_CONTENT_MAX_BYTES;
        let slice = if truncated {
            &bytes[..SKILL_CONTENT_MAX_BYTES]
        } else {
            &bytes[..]
        };
        return Ok(json!({
            "directory": safe,
            "path": marker.to_string_lossy(),
            "markdown": String::from_utf8_lossy(slice).into_owned(),
            "truncated": truncated,
        }));
    }
    Err(SkillError::coded(
        "not_found",
        "SKILL.md not found for this skill",
    ))
}
