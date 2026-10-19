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

use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

use super::core::*;
// ===== frontmatter / marker / 本地扫描 =====

/// upstream readYamlField：inline（可带一层引号）+ block scalar（`|`/`>`，可带 `+`/`-`）。
pub(super) fn read_yaml_field(yaml: &str, key: &str) -> String {
    let lines: Vec<&str> = yaml.split('\n').collect();
    for (i, line) in lines.iter().enumerate() {
        let indent = line.chars().take_while(|c| c.is_whitespace()).count();
        let trimmed_start = line.trim_start();
        // header 形如 `^(\s*)key:[ \t]*(.*)$`：key 后必须紧跟冒号。
        let Some(after_key) = trimmed_start.strip_prefix(key) else {
            continue;
        };
        let Some(after_colon) = after_key.strip_prefix(':') else {
            continue;
        };
        let inline = after_colon.trim_start_matches([' ', '\t']).trim();
        if matches!(inline, ">" | "|" | ">+" | ">-" | "|+" | "|-") {
            // block scalar：收集后续缩进更深的行，dedent 结束。
            let mut collected: Vec<String> = Vec::new();
            for next in &lines[i + 1..] {
                if next.trim().is_empty() {
                    collected.push(String::new());
                    continue;
                }
                if next.chars().take_while(|c| c.is_whitespace()).count() <= indent {
                    break; // dedent 结束
                }
                collected.push(next.trim().to_string());
            }
            return collected.join(" ");
        }
        // 剥一层首尾引号。
        let mut out = inline;
        if out.starts_with('"') || out.starts_with('\'') {
            out = &out[1..];
        }
        if (out.ends_with('"') || out.ends_with('\'')) && !out.is_empty() {
            out = &out[..out.len() - 1];
        }
        return out.to_string();
    }
    String::new()
}

/// 对应 upstream 的 `/^---\s*\n([\s\S]*?)\n---/` frontmatter 提取。
pub(super) fn extract_frontmatter(raw: &str) -> Option<&str> {
    let rest = raw.strip_prefix("---")?;
    // `\s*\n`：前导空白 run 内必须有 `\n`（取 run 中最后一个 `\n` 之后）。
    let ws_len: usize = rest
        .char_indices()
        .take_while(|(_, c)| c.is_whitespace())
        .map(|(i, c)| i + c.len_utf8())
        .last()
        .unwrap_or(0);
    let newline = rest[..ws_len].rfind('\n')?;
    let content = &rest[newline + 1..];
    let end = content.find("\n---")?;
    Some(&content[..end])
}

pub(super) struct SkillMetadata {
    pub(super) name: String,
    pub(super) description: String,
}

/// upstream readSkillMetadata：frontmatter 优先，name fallback，description 折叠空白。
pub(super) fn read_skill_metadata(markdown: &str, fallback_name: &str) -> SkillMetadata {
    let source = extract_frontmatter(markdown).unwrap_or(markdown);
    let name_field = read_yaml_field(source, "name");
    let name = if !name_field.is_empty() {
        name_field
    } else if !fallback_name.is_empty() {
        fallback_name.to_string()
    } else {
        "Skill".to_string()
    };
    let description = read_yaml_field(source, "description")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    SkillMetadata {
        name: name.trim().to_string(),
        description,
    }
}

/// upstream findSkillMarker：SKILL.md（优先大写）或 skill.md，stat 为 file 才算。
pub(super) fn find_skill_marker(dir: &Path) -> Option<PathBuf> {
    for name in ["SKILL.md", "skill.md"] {
        let candidate = dir.join(name);
        if fs::metadata(&candidate)
            .map(|meta| meta.is_file())
            .unwrap_or(false)
        {
            return Some(candidate);
        }
    }
    None
}

/// upstream scanSkillDirectories：深度 ≤3 递归，不进 symlink 目录、跳过 `.` 开头项，
/// 含 SKILL.md/skill.md 的目录记为 skill（返回相对路径）。
pub(super) fn scan_skill_directories(root_dir: &Path) -> Vec<String> {
    fn walk(dir: &Path, rel_dir: &str, depth: usize, found: &mut Vec<String>) {
        let Ok(read_dir) = fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = read_dir.filter_map(|entry| entry.ok()).collect();
        // codepoint 排序（upstream localeCompare 的计划内偏差）。
        entries.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
        for entry in entries {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() && !file_type.is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.is_empty() || name.starts_with('.') {
                continue;
            }
            let rel = if rel_dir.is_empty() {
                name.clone()
            } else {
                format!("{rel_dir}/{name}")
            };
            let full = entry.path();
            if find_skill_marker(&full).is_some() {
                found.push(rel);
                continue;
            }
            // symlink group folder 不递归（保持扫描在 target skills 树内）。
            if file_type.is_dir() && depth + 1 < MAX_LOCAL_SKILL_SCAN_DEPTH {
                walk(&full, &rel, depth + 1, found);
            }
        }
    }
    let mut found = Vec::new();
    walk(root_dir, "", 0, &mut found);
    found
}

// ===== contentHash / sourceSignature =====

#[cfg(unix)]
pub(super) fn exec_bit_of(meta: &fs::Metadata) -> u8 {
    use std::os::unix::fs::PermissionsExt;
    if meta.permissions().mode() & 0o111 != 0 {
        1
    } else {
        0
    }
}

#[cfg(not(unix))]
pub(super) fn exec_bit_of(_meta: &fs::Metadata) -> u8 {
    0
}

/// upstream hashDirectory：按 name 排序递归，文件条目为
/// `"<rel>\0<execBit>\0" + 文件字节 + "\0"`；目录不进 hash；stat 失败跳过、
/// 读失败跳过内容但仍加尾部 NUL。
pub(super) fn hash_directory(dir: &Path) -> String {
    fn walk(base: &Path, rel_dir: &str, hasher: &mut Sha256) {
        let abs_dir = if rel_dir.is_empty() {
            base.to_path_buf()
        } else {
            base.join(rel_dir)
        };
        let Ok(read_dir) = fs::read_dir(&abs_dir) else {
            return;
        };
        let mut entries: Vec<_> = read_dir.filter_map(|entry| entry.ok()).collect();
        entries.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
        for entry in entries {
            let name = entry.file_name().to_string_lossy().into_owned();
            if HASH_IGNORE.contains(&name.as_str()) {
                continue;
            }
            let rel = if rel_dir.is_empty() {
                name.clone()
            } else {
                format!("{rel_dir}/{name}")
            };
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                walk(base, &rel, hasher);
            } else if file_type.is_file() {
                let abs = base.join(&rel);
                let Ok(meta) = fs::metadata(&abs) else {
                    continue;
                };
                let exec_bit = exec_bit_of(&meta);
                hasher.update(format!("{rel}\0{exec_bit}\0"));
                if let Ok(bytes) = fs::read(&abs) {
                    hasher.update(&bytes);
                }
                hasher.update(b"\0");
            }
        }
    }
    let mut hasher = Sha256::new();
    walk(dir, "", &mut hasher);
    format!("{:x}", hasher.finalize())
}

/// upstream sourceSignatureFromTree：tree 中 sourceDir 前缀内 blob 的
/// `"<path>:<sha>"` 排序后 `"\n".join` 的 sha256 hex；无匹配 → None。
pub(super) fn source_signature_from_tree(tree: &[Value], source_dir: &str) -> Option<String> {
    if source_dir.is_empty() {
        return None;
    }
    let prefix = format!("{source_dir}/");
    let mut rels: Vec<String> = tree
        .iter()
        .filter_map(|entry| {
            if entry.get("type").and_then(Value::as_str) != Some("blob") {
                return None;
            }
            let sha = entry
                .get("sha")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())?;
            let path = entry.get("path").and_then(Value::as_str).unwrap_or("");
            if path == source_dir || path.starts_with(&prefix) {
                Some(format!("{path}:{sha}"))
            } else {
                None
            }
        })
        .collect();
    if rels.is_empty() {
        return None;
    }
    rels.sort();
    let mut hasher = Sha256::new();
    hasher.update(rels.join("\n"));
    Some(format!("{:x}", hasher.finalize()))
}
