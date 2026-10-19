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
use std::collections::HashMap;
use std::sync::Arc;

use super::core::*;
use super::fsutil::*;
use super::http::*;
use super::registry::*;
use super::repos::*;
use super::scan::*;
use super::target_sync::SKILL_CONTENT_MAX_BYTES;
// ===== discover / updates / search / popular（缓存 + 网络） =====

/// upstream 的 `/(^|\/)SKILL\.md$/i` 判定（大小写不敏感）。
pub(super) fn is_skill_md_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    if bytes.len() == "skill.md".len() {
        return bytes.eq_ignore_ascii_case(b"skill.md");
    }
    bytes.len() >= "/skill.md".len()
        && bytes[bytes.len() - "/skill.md".len()..].eq_ignore_ascii_case(b"/skill.md")
}

/// 对应 upstream 的 `docPath.replace(/(^|\/)(?:SKILL|skill)\.md$/i, "")`。
pub(super) fn strip_skill_md_suffix(doc_path: &str) -> &str {
    let bytes = doc_path.as_bytes();
    if bytes.len() == "skill.md".len() && bytes.eq_ignore_ascii_case(b"skill.md") {
        return "";
    }
    if bytes.len() >= "/skill.md".len()
        && bytes[bytes.len() - "/skill.md".len()..].eq_ignore_ascii_case(b"/skill.md")
    {
        return &doc_path[..doc_path.len() - "/skill.md".len()];
    }
    doc_path
}

/// upstream discoverRepoSkills：tree 里 SKILL.md blob 截 200，并发 4 拉 raw frontmatter，
/// 非 RateLimit 失败用 `{name: installName, description: ""}` fallback 保留条目。
pub(super) async fn discover_repo_skills(
    client: &reqwest::Client,
    repo_input: &Value,
) -> SkillResult<Vec<Value>> {
    let repo = normalize_repo(repo_input);
    let owner = js_string(repo.get("owner"));
    let name = js_string(repo.get("name"));
    let enabled = repo.get("enabled").and_then(Value::as_bool).unwrap_or(true);
    if owner.is_empty() || name.is_empty() || !enabled {
        return Ok(Vec::new());
    }
    let (branch, tree) =
        get_repo_tree(client, &owner, &name, &js_string(repo.get("branch"))).await?;
    let skill_files: Vec<String> = tree
        .iter()
        .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("blob"))
        .filter_map(|entry| {
            entry
                .get("path")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|path| is_skill_md_path(path))
        .take(DISCOVER_MAX_SKILLS_PER_REPO)
        .collect();

    let owner = Arc::new(owner);
    let name = Arc::new(name);
    let branch = Arc::new(branch);
    let worker_client = client.clone();
    let results = map_with_concurrency(
        skill_files,
        DISCOVER_CONCURRENCY,
        move |doc_path: String| {
            let client = worker_client.clone();
            let owner = Arc::clone(&owner);
            let name = Arc::clone(&name);
            let branch = Arc::clone(&branch);
            async move {
                let doc_path = doc_path.replace('\\', "/");
                // 根目录 SKILL.md → repo.name。
                let stripped = strip_skill_md_suffix(&doc_path);
                let directory = if stripped.is_empty() {
                    name.as_str().to_string()
                } else {
                    stripped.to_string()
                };
                let Some(install_name) = install_name_from_directory(&directory) else {
                    return Ok(None);
                };
                let mut meta_name = install_name.clone();
                let mut meta_description = String::new();
                match fetch_text(&client, &github_raw_url(&owner, &name, &branch, &doc_path)).await
                {
                    Ok(markdown) => {
                        let metadata = read_skill_metadata(&markdown, &install_name);
                        meta_name = metadata.name;
                        meta_description = metadata.description;
                    }
                    Err(error) => {
                        if error.is_rate_limited() {
                            return Err(error);
                        }
                        // 非 RateLimit 失败：保留条目（metadata fallback）。
                    }
                }
                Ok(Some(json!({
                    "key": format!("{}/{}:{directory}", owner, name),
                    "name": meta_name,
                    "description": meta_description,
                    "directory": directory,
                    "readmeUrl": github_doc_url(&owner, &name, &branch, &doc_path),
                    "repoOwner": owner.as_str(),
                    "repoName": name.as_str(),
                    "repoBranch": branch.as_str(),
                })))
            }
        },
    )
    .await;

    let mut skills = Vec::new();
    for result in results {
        match result {
            Ok(Some(skill)) => skills.push(skill),
            Ok(None) => {}
            Err(error) => return Err(error),
        }
    }
    Ok(skills)
}

/// upstream dedupeSkills：按 key 小写去重（后写覆盖、保持首次位置），按 name 排序。
pub(super) fn dedupe_skills(skills: Vec<Value>) -> Vec<Value> {
    let mut by_key: HashMap<String, usize> = HashMap::new();
    let mut values: Vec<Value> = Vec::new();
    for skill in skills {
        let key = format!(
            "{}/{}:{}",
            js_string(skill.get("repoOwner")),
            js_string(skill.get("repoName")),
            js_string(skill.get("directory"))
        )
        .to_lowercase();
        match by_key.get(&key) {
            Some(&index) => values[index] = skill,
            None => {
                by_key.insert(key, values.len());
                values.push(skill);
            }
        }
    }
    values.sort_by(|a, b| js_string(a.get("name")).cmp(&js_string(b.get("name"))));
    values
}

/// upstream discover fingerprint：enabled repos 的 `owner/name@branch` sort + `|` join。
pub(super) fn discover_fingerprint(repos: &[Value]) -> String {
    let mut parts: Vec<String> = repos
        .iter()
        .map(|repo| {
            format!(
                "{}/{}@{}",
                js_string(repo.get("owner")),
                js_string(repo.get("name")),
                js_string(repo.get("branch"))
            )
        })
        .collect();
    parts.sort();
    parts.join("|")
}

/// upstream readDiscoverCache：fingerprint 相等且 generatedAt ≤1h 才命中。
pub(super) fn read_discover_cache(fingerprint: &str) -> Option<(Vec<Value>, i64)> {
    let data = read_json(&discover_cache_path())?;
    let skills = data.get("skills").and_then(Value::as_array)?.clone();
    if data.get("fingerprint").and_then(Value::as_str) != Some(fingerprint) {
        return None;
    }
    let generated_at = data.get("generatedAt").and_then(Value::as_f64)?;
    if now_ms() as f64 - generated_at > DISCOVER_CACHE_TTL_MS as f64 {
        return None;
    }
    Some((skills, generated_at as i64))
}

pub(super) fn write_discover_cache(fingerprint: &str, skills: &[Value]) -> SkillResult<()> {
    write_json(
        &discover_cache_path(),
        &json!({"fingerprint": fingerprint, "generatedAt": now_ms(), "skills": skills}),
    )
}

/// upstream discoverSkills：allSettled 语义（单 repo 失败不拖垮其他，
/// 但全空且有 RateLimit → 上抛 RateLimit）。
pub(super) async fn discover_skills(force: bool) -> SkillResult<Value> {
    let registry = read_registry();
    let enabled: Vec<Value> = registry
        .repos
        .iter()
        .map(normalize_repo)
        .filter(|repo| repo.get("enabled").and_then(Value::as_bool).unwrap_or(true))
        .collect();
    if enabled.is_empty() {
        return Ok(json!({"skills": [], "cached": false, "generatedAt": now_ms()}));
    }
    let fingerprint = discover_fingerprint(&enabled);
    if !force {
        if let Some((skills, generated_at)) = read_discover_cache(&fingerprint) {
            return Ok(json!({"skills": skills, "cached": true, "generatedAt": generated_at}));
        }
    }
    let worker_client = http_client()?;
    let results = map_with_concurrency(enabled, DISCOVER_CONCURRENCY, move |repo: Value| {
        let client = worker_client.clone();
        async move { discover_repo_skills(&client, &repo).await }
    })
    .await;
    let mut merged: Vec<Value> = Vec::new();
    let mut rate_limited: Option<SkillError> = None;
    for result in results {
        match result {
            Ok(skills) => merged.extend(skills),
            Err(error) => {
                if error.is_rate_limited() && rate_limited.is_none() {
                    rate_limited = Some(error);
                }
            }
        }
    }
    let merged = dedupe_skills(merged);
    if merged.is_empty() {
        if let Some(error) = rate_limited {
            return Err(error);
        }
    }
    write_discover_cache(&fingerprint, &merged)?;
    Ok(json!({"skills": merged, "cached": false, "generatedAt": now_ms()}))
}

// ===== skills.sh 详情：仓库里找 SKILL.md 并读回正文 =====

/// skills.sh 的 skill id 归一化：小写、`:` → `-`（网站上的
/// `react:components` 在仓库里是 `react-components`）。
pub(super) fn normalize_skill_id(value: &str) -> String {
    value.trim().to_lowercase().replace(':', "-")
}

/// 目录名与 skill id 的对齐分：3 = 完全相同；2 = 一方是另一方去掉仓库前缀后的
/// 名字（`vercel-react-best-practices` ↔ `react-best-practices`）；0 = 不对齐。
fn skill_dir_score(folder: &str, wanted: &str) -> u8 {
    let folder = normalize_skill_id(folder);
    if folder.is_empty() {
        return 0;
    }
    if folder == wanted {
        return 3;
    }
    if wanted.ends_with(&format!("-{folder}")) || folder.ends_with(&format!("-{wanted}")) {
        return 2;
    }
    0
}

/// 在仓库 tree 里按目录名给 skills.sh 的 skill id 找 `SKILL.md` 所在目录
/// （返回不带 `/SKILL.md` 的目录路径；根目录 SKILL.md 返回空串——skills.sh
/// 只在 id 等于仓库名时才会指到它）。
///
/// 对齐规则只认「同名 / 去掉仓库前缀 / `:` 换 `-`」三种，命中多个取最浅的，
/// 认不出来返回 None：宁可报 not_found 让人去 GitHub 看，也不拿另一个技能的
/// 正文冒充。
pub(super) fn resolve_skill_dir_in_tree(tree: &[Value], skill_id: &str) -> Option<String> {
    let wanted = normalize_skill_id(skill_id);
    if wanted.is_empty() {
        return None;
    }
    let mut best: Option<(u8, usize, String)> = None;
    for entry in tree {
        if entry.get("type").and_then(Value::as_str) != Some("blob") {
            continue;
        }
        let Some(path) = entry.get("path").and_then(Value::as_str) else {
            continue;
        };
        if !is_skill_md_path(path) {
            continue;
        }
        let dir = strip_skill_md_suffix(path).trim_end_matches('/');
        let folder = dir.rsplit('/').next().unwrap_or("");
        let score = skill_dir_score(folder, &wanted);
        if score == 0 {
            continue;
        }
        let depth = dir.matches('/').count();
        let better = match &best {
            None => true,
            Some((best_score, best_depth, best_dir)) => {
                score > *best_score
                    || (score == *best_score
                        && (depth < *best_depth
                            || (depth == *best_depth && dir < best_dir.as_str())))
            }
        };
        if better {
            best = Some((score, depth, dir.to_string()));
        }
    }
    best.map(|(_, _, dir)| dir)
}

/// 同一目录下的所有 blob（安装按目录下载文件时用同一份判定）。
pub(super) fn skill_dir_files<'a>(tree: &'a [Value], dir: &str) -> Vec<&'a Value> {
    let prefix = format!("{dir}/");
    tree.iter()
        .filter(|entry| {
            entry.get("type").and_then(Value::as_str) == Some("blob")
                && entry
                    .get("path")
                    .and_then(Value::as_str)
                    .map(|path| path == dir || path.starts_with(&prefix))
                    .unwrap_or(false)
        })
        .collect()
}

/// 目录里有没有 `SKILL.md`（大写优先，其次 `skill.md`）。
pub(super) fn dir_has_skill_md(tree: &[Value], dir: &str) -> bool {
    skill_dir_files(tree, dir).iter().any(|entry| {
        entry
            .get("path")
            .and_then(Value::as_str)
            .map(is_skill_md_path)
            .unwrap_or(false)
    })
}

/// 给定目录没有 SKILL.md 时，按 skills.sh 的 id 规则在 tree 里再解析一次
/// （`vercel-react-best-practices` → `skills/react-best-practices`）。
pub(super) fn resolve_existing_skill_dir(tree: &[Value], requested: &str) -> Option<String> {
    if dir_has_skill_md(tree, requested) {
        return Some(requested.to_string());
    }
    let skill_id = requested.rsplit('/').next().unwrap_or(requested);
    let resolved = resolve_skill_dir_in_tree(tree, skill_id)?;
    if resolved.is_empty() || !dir_has_skill_md(tree, &resolved) {
        return None;
    }
    Some(resolved)
}

/// skills.sh 的搜索/热门只给 name / repo / installs——「这个技能是干什么的」
/// 得回仓库读 `SKILL.md`（详情面板按需调用，不做列表级预取）。
pub(super) async fn remote_skill_content(
    owner: &str,
    name: &str,
    branch: &str,
    skill_id: &str,
) -> SkillResult<Value> {
    let owner = owner.trim();
    let name = name.trim();
    let wanted = normalize_skill_id(skill_id);
    if owner.is_empty() || name.is_empty() || wanted.is_empty() {
        return Err(SkillError::coded(
            "invalid_input",
            "Missing skill or repository information",
        ));
    }
    let client = http_client()?;
    let (branch, tree) = get_repo_tree(&client, owner, name, branch).await?;
    let doc_path = match resolve_skill_dir_in_tree(&tree, &wanted) {
        Some(dir) => format!("{dir}/SKILL.md"),
        // 整个仓库只有一个根目录 SKILL.md：skills.sh 的 id 常等于仓库名。
        None => {
            let all: Vec<&str> = tree
                .iter()
                .filter(|entry| entry.get("type").and_then(Value::as_str) == Some("blob"))
                .filter_map(|entry| entry.get("path").and_then(Value::as_str))
                .filter(|path| is_skill_md_path(path))
                .collect();
            if all.len() == 1 && strip_skill_md_suffix(all[0]).is_empty() {
                all[0].to_string()
            } else {
                return Err(SkillError::coded(
                    "not_found",
                    format!("No SKILL.md for \"{wanted}\" in {owner}/{name}"),
                ));
            }
        }
    };
    let markdown = fetch_text(&client, &github_raw_url(owner, name, &branch, &doc_path)).await?;
    let metadata = read_skill_metadata(&markdown, &wanted);
    let bytes = markdown.as_bytes();
    let truncated = bytes.len() > SKILL_CONTENT_MAX_BYTES;
    let slice = if truncated {
        &bytes[..SKILL_CONTENT_MAX_BYTES]
    } else {
        &bytes[..]
    };
    Ok(json!({
        "name": metadata.name,
        "description": metadata.description,
        "directory": strip_skill_md_suffix(&doc_path).trim_end_matches('/'),
        "path": doc_path,
        "url": github_doc_url(owner, name, &branch, &doc_path),
        "repoUrl": format!("https://github.com/{owner}/{name}"),
        "markdown": String::from_utf8_lossy(slice).into_owned(),
        "truncated": truncated,
        "branch": branch,
    }))
}
