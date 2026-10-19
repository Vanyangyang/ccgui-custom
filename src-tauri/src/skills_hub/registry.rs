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

use serde_json::{json, Map, Value};
use std::fs;

use super::core::*;
use super::fsutil::*;
// ===== registry 读写与 trash purge =====

pub(super) struct Registry {
    pub(super) repos: Vec<Value>,
    pub(super) skills: Vec<Value>,
}

/// upstream DEFAULT_REPOS。
pub(super) fn default_repos() -> Vec<Value> {
    vec![
        json!({"owner": "anthropics", "name": "skills", "branch": "main", "enabled": true}),
        json!({"owner": "ComposioHQ", "name": "awesome-claude-skills", "branch": "master", "enabled": true}),
        json!({"owner": "cexll", "name": "myclaude", "branch": "master", "enabled": true}),
        json!({"owner": "JimLiu", "name": "baoyu-skills", "branch": "main", "enabled": true}),
    ]
}

/// upstream readRegistry：文件缺失/解析失败 → 默认；repos 非数组 → DEFAULT_REPOS；
/// skills 非数组 → []。
pub(super) fn read_registry() -> Registry {
    if let Some(value) = read_json(&registry_path()) {
        if value.is_object() {
            let repos = value
                .get("repos")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_else(default_repos);
            let skills = value
                .get("skills")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            return Registry { repos, skills };
        }
    }
    Registry {
        repos: default_repos(),
        skills: Vec::new(),
    }
}

pub(super) fn save_registry(registry: &Registry) -> SkillResult<()> {
    write_json(
        &registry_path(),
        &json!({"repos": &registry.repos, "skills": &registry.skills}),
    )
}

/// 条目的 trashedAt（JS truthy 语义：非零数字才算 trashed）。
pub(super) fn trashed_at_of(skill: &Value) -> Option<f64> {
    skill
        .get("trashedAt")
        .and_then(Value::as_f64)
        .filter(|n| *n != 0.0)
}

/// upstream purgeExpiredTrash：trashedAt 距今 ≥ TRASH_TTL_MS → 删 trash 目录 + registry
/// 删条目；整体 best-effort。
pub(super) fn purge_expired_trash() {
    let now = now_ms();
    let mut registry = read_registry();
    let mut dirty = false;
    registry.skills.retain(|skill| {
        let Some(trashed_at) = trashed_at_of(skill) else {
            return true;
        };
        if now as f64 - trashed_at < TRASH_TTL_MS as f64 {
            return true;
        }
        if let Some(trashed_directory) = skill.get("trashedDirectory").and_then(Value::as_str) {
            if !trashed_directory.is_empty() {
                remove_path(&trash_dir().join(trashed_directory));
            }
        }
        dirty = true;
        false
    });
    if dirty {
        let _ = save_registry(&registry);
    }
}

// ===== activity 日志（best-effort，永不阻塞 mutation） =====

/// upstream appendActivity：`{ts, ...event}` 单行 JSON 追加（0o600）；
/// 超过 256KB 截尾保留最后 500 行；整体吞错。
pub(super) fn append_activity(event: Value) {
    let _ = (|| -> std::io::Result<()> {
        ensure_dir(&skills_root())?;
        let mut record = Map::new();
        record.insert("ts".to_string(), json!(now_ms()));
        if let Value::Object(map) = event {
            record.extend(map);
        }
        let line = serde_json::to_string(&Value::Object(record)).unwrap_or_default();
        append_line_private(&activity_path(), &format!("{line}\n"))?;
        let size = fs::metadata(activity_path())
            .map(|meta| meta.len())
            .unwrap_or(0);
        if size > ACTIVITY_TRIM_BYTES {
            if let Some(raw) = read_text(&activity_path()) {
                let lines: Vec<&str> = raw.split('\n').filter(|l| !l.is_empty()).collect();
                let kept = &lines[lines.len().saturating_sub(ACTIVITY_MAX)..];
                write_file_private(&activity_path(), &format!("{}\n", kept.join("\n")))?;
            }
        }
        Ok(())
    })();
}

/// upstream readActivity：取末尾 limit 行（clamp [1,500]，0 → 100），解析失败的行丢弃，最新在前。
pub(super) fn read_activity(limit: i64) -> Vec<Value> {
    let want = (if limit == 0 { 100 } else { limit }).clamp(1, ACTIVITY_MAX as i64) as usize;
    let Some(raw) = read_text(&activity_path()) else {
        return Vec::new();
    };
    let lines: Vec<&str> = raw.split('\n').filter(|l| !l.is_empty()).collect();
    lines[lines.len().saturating_sub(want)..]
        .iter()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .rev()
        .collect()
}
