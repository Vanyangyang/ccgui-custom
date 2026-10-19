//! Skills hub 后端：从参考项目 desktop-cc-gui 的 Rust 移植 `skills_hub/` 迁移而来
//! （MIT，Copyright (c) 2026 Thomas Ricouard / zhukunpenglinyutong（朱昆鹏）），
//! 上游可溯源到 TokenTracker 的 `skills-manager.js` / `skill-usage.js`（MIT）。
//!
//! 与参考实现的差异（均为适配本仓库）：
//! 1. SSOT 根目录为本应用数据目录下的 `skills-hub/`（`paths::app_home()`），
//!    可用 env `CCGUI_SKILLS_HUB_HOME` 覆盖（测试注入点）。参考实现用
//!    `~/.ccgui/skills`，与本应用的可写存储隔离，不共享注册表。
//! 2. 目标引擎首期仅 Claude Code / Codex；引擎目录解析走 `engine::engine_home`
//!    与 `engine::codex_home`，尊重 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 与设置页
//!    的 Codex 目录覆盖。只出现在 CLI 目录、不属于本应用托管的目标是只读来源
//!    （Codex `.system`、插件缓存、随包分发的内置 skill）。
//! 3. skill_usage 的统计范围固定为 Claude Code 会话转录
//!    （`<claude home>/projects/**/*.jsonl`），响应带 scope 字段说明；Codex
//!    没有可可靠读取的 Skill 调用记录，不可用时显示"暂无可用数据"。
//! 4. 删除/卸载入口对只读来源（内置、系统、插件）一律拒绝，保护
//!    `creator_skill.rs` 安装的随包 skill。

use serde_json::{json, Value};
use std::fs;

use super::core::*;
use super::fsutil::*;
use super::registry::*;
// ===== repos 管理 =====

/// upstream normalizeRepo。
pub(super) fn normalize_repo(repo: &Value) -> Value {
    let owner = js_string(repo.get("owner")).trim().to_string();
    let name = js_string(repo.get("name")).trim().to_string();
    let branch = {
        let branch = js_string(repo.get("branch")).trim().to_string();
        if branch.is_empty() {
            "main".to_string()
        } else {
            branch
        }
    };
    let enabled = repo.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    json!({"owner": owner, "name": name, "branch": branch, "enabled": enabled})
}

/// upstream OWNER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/。
pub(super) fn owner_name_valid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 100 || !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || *b == b'.' || *b == b'_' || *b == b'-')
}

pub(super) fn list_repos() -> Vec<Value> {
    read_registry().repos.iter().map(normalize_repo).collect()
}

pub(super) fn invalidate_discover_cache() {
    let _ = fs::remove_file(discover_cache_path());
}

/// 按 `"owner/name"` 小写去重（upstream addRepo/removeRepo 共用）。
pub(super) fn retain_repos_not(repos: &mut Vec<Value>, key: &str) {
    repos.retain(|entry| {
        format!(
            "{}/{}",
            js_string(entry.get("owner")),
            js_string(entry.get("name"))
        )
        .to_lowercase()
            != key
    });
}

/// upstream addRepo：校验 → 去重 → push → 失效 discover 缓存。
pub(super) fn add_repo(repo_input: &Value) -> SkillResult<Value> {
    let repo = normalize_repo(repo_input);
    let owner = js_string(repo.get("owner"));
    let name = js_string(repo.get("name"));
    let branch = js_string(repo.get("branch"));
    if owner.is_empty() || name.is_empty() {
        return Err(SkillError::other("Repository owner and name are required"));
    }
    if !owner_name_valid(&owner) || !owner_name_valid(&name) {
        return Err(SkillError::other(
            "Repository owner and name may only contain letters, digits, '.', '_', or '-'",
        ));
    }
    if !owner_name_valid(&branch) {
        return Err(SkillError::other(
            "Repository branch contains unsupported characters",
        ));
    }
    let mut registry = read_registry();
    retain_repos_not(
        &mut registry.repos,
        &format!("{owner}/{name}").to_lowercase(),
    );
    registry.repos.push(repo.clone());
    save_registry(&registry)?;
    invalidate_discover_cache();
    Ok(json!({"ok": true, "repo": repo}))
}

/// upstream removeRepo。
pub(super) fn remove_repo(owner: &str, name: &str) -> SkillResult<Value> {
    let mut registry = read_registry();
    retain_repos_not(
        &mut registry.repos,
        &format!("{owner}/{name}").to_lowercase(),
    );
    save_registry(&registry)?;
    invalidate_discover_cache();
    Ok(json!({"ok": true}))
}
