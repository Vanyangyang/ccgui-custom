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
use std::collections::HashMap;

use super::core::*;
use super::fsutil::*;
use super::http::*;
use super::registry::*;
use super::scan::*;
/// 缓存命中判定：`fingerprint` 相等 + `<key>` 时间戳在 TTL 内 + 指定字段类型校验。
pub(super) fn cache_hit(
    cached: &Value,
    fingerprint: &str,
    ts_key: &str,
    ttl_ms: i64,
    payload_key: &str,
    want_object: bool,
) -> bool {
    let fresh = cached
        .get(ts_key)
        .and_then(Value::as_f64)
        .map(|ts| now_ms() as f64 - ts < ttl_ms as f64)
        .unwrap_or(false);
    if cached.get("fingerprint").and_then(Value::as_str) != Some(fingerprint) || !fresh {
        return false;
    }
    match cached.get(payload_key) {
        Some(Value::Array(_)) => !want_object,
        Some(v) => want_object && v.is_object(),
        None => false,
    }
}

/// upstream checkUpdates：候选 = `!trashedAt && repoOwner && repoName && sourceSignature`；
/// 按 `"owner/name@branch".toLowerCase()` 分组并发 2 拉 tree；sig 为 null 不写 key。
pub(super) async fn check_updates(force: bool) -> SkillResult<Value> {
    let registry = read_registry();
    let managed: Vec<Value> = registry
        .skills
        .iter()
        .filter(|skill| {
            trashed_at_of(skill).is_none()
                && !js_string(skill.get("repoOwner")).is_empty()
                && !js_string(skill.get("repoName")).is_empty()
                && !js_string(skill.get("sourceSignature")).is_empty()
        })
        .cloned()
        .collect();
    let mut fingerprint_parts: Vec<String> = managed
        .iter()
        .map(|skill| {
            format!(
                "{}@{}",
                js_string(skill.get("id")),
                js_string(skill.get("sourceSignature"))
            )
        })
        .collect();
    fingerprint_parts.sort();
    let fingerprint = fingerprint_parts.join("|");

    if !force {
        if let Some(cached) = read_json(&updates_cache_path()) {
            if cache_hit(
                &cached,
                &fingerprint,
                "checkedAt",
                UPDATE_CACHE_TTL_MS,
                "updates",
                true,
            ) {
                let updates = cached.get("updates").cloned().unwrap_or_else(|| json!({}));
                let checked_at = cached.get("checkedAt").cloned().unwrap_or(Value::Null);
                return Ok(json!({"updates": updates, "checkedAt": checked_at, "cached": true}));
            }
        }
    }

    // 按 repo 分组（保持插入序）。
    let mut groups: Vec<(String, String, String, Vec<Value>)> = Vec::new();
    let mut group_index: HashMap<String, usize> = HashMap::new();
    for skill in &managed {
        let owner = js_string(skill.get("repoOwner"));
        let name = js_string(skill.get("repoName"));
        let branch = {
            let branch = js_string(skill.get("repoBranch"));
            if branch.is_empty() {
                "main".to_string()
            } else {
                branch
            }
        };
        let key = format!("{owner}/{name}@{branch}").to_lowercase();
        let index = match group_index.get(&key) {
            Some(&i) => i,
            None => {
                group_index.insert(key, groups.len());
                groups.push((owner, name, branch, Vec::new()));
                groups.len() - 1
            }
        };
        groups[index].3.push(skill.clone());
    }

    let client = http_client()?;
    let worker_client = client.clone();
    let results = map_with_concurrency(
        groups,
        UPDATE_CHECK_CONCURRENCY,
        move |(owner, name, branch, skills): (String, String, String, Vec<Value>)| {
            let client = worker_client.clone();
            async move {
                let tree = match get_repo_tree(&client, &owner, &name, &branch).await {
                    Ok((_, tree)) => tree,
                    Err(error) => {
                        if error.is_rate_limited() {
                            return Err(error);
                        }
                        // 非 RateLimit 失败静默跳过（该 repo 的 skills 不写 key）。
                        return Ok(Vec::new());
                    }
                };
                let mut updates: Vec<(String, bool)> = Vec::new();
                for skill in &skills {
                    let source = {
                        let source_directory = js_string(skill.get("sourceDirectory"));
                        if source_directory.is_empty() {
                            js_string(skill.get("directory"))
                        } else {
                            source_directory
                        }
                    };
                    if let Some(signature) = source_signature_from_tree(&tree, &source) {
                        updates.push((
                            js_string(skill.get("id")),
                            signature != js_string(skill.get("sourceSignature")),
                        ));
                    }
                }
                Ok(updates)
            }
        },
    )
    .await;

    let mut updates = Map::new();
    for result in results {
        for (id, has_update) in result? {
            updates.insert(id, json!(has_update));
        }
    }
    let checked_at = now_ms();
    write_json(
        &updates_cache_path(),
        &json!({"fingerprint": fingerprint, "checkedAt": checked_at, "updates": Value::Object(updates.clone())}),
    )?;
    Ok(json!({"updates": Value::Object(updates), "checkedAt": checked_at, "cached": false}))
}

/// upstream searchSkillsSh：`q.trim()` 长度 <2 短路；解析 skills.sh 响应。
pub(super) async fn search_skills_sh(
    client: &reqwest::Client,
    query: &str,
    limit: f64,
    offset: f64,
) -> SkillResult<Value> {
    let q = query.trim().to_string();
    // JS length 是 UTF-16 code unit 数，用 encode_utf16 对齐。
    if q.encode_utf16().count() < 2 {
        return Ok(json!({"query": q, "totalCount": 0, "skills": []}));
    }
    let limit = {
        let n = if limit == 0.0 || limit.is_nan() {
            20.0
        } else {
            limit
        };
        n.min(50.0).max(1.0) as i64
    };
    let offset = if offset.is_nan() { 0.0 } else { offset }.max(0.0) as i64;
    let url = format!(
        "https://skills.sh/api/search?q={}&limit={limit}&offset={offset}",
        encode_form_param(&q)
    );
    let data = fetch_json(client, &url).await?;
    let skills: Vec<Value> = data
        .get("skills")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().filter_map(parse_search_entry).collect())
        .unwrap_or_default();
    let total_count = {
        let count = data.get("count").map(js_f64).unwrap_or(f64::NAN);
        let n = if count == 0.0 || count.is_nan() {
            skills.len() as f64
        } else {
            count
        };
        json_number(n)
    };
    let query_out = {
        let data_query = js_string(data.get("query"));
        if data_query.is_empty() {
            q
        } else {
            data_query
        }
    };
    Ok(json!({"query": query_out, "totalCount": total_count, "skills": skills}))
}

/// upstream searchSkillsSh 的 entry 映射：`source` 按 `/` split 得 owner/repo（含 `.` 丢弃）。
pub(super) fn parse_search_entry(entry: &Value) -> Option<Value> {
    let source = js_string(entry.get("source"));
    let mut parts = source.split('/');
    let owner = parts.next().unwrap_or("").to_string();
    let repo_name = parts.next().unwrap_or("").to_string();
    if owner.is_empty() || repo_name.is_empty() || owner.contains('.') || repo_name.contains('.') {
        return None;
    }
    let key = {
        let id = js_string(entry.get("id"));
        if !id.is_empty() {
            id
        } else {
            let skill_id = js_string(entry.get("skillId"));
            let inner = if !skill_id.is_empty() {
                skill_id
            } else {
                js_string(entry.get("name"))
            };
            format!("{owner}/{repo_name}:{inner}")
        }
    };
    let name = {
        let name = js_string(entry.get("name"));
        if !name.is_empty() {
            name
        } else {
            let skill_id = js_string(entry.get("skillId"));
            if !skill_id.is_empty() {
                skill_id
            } else {
                "Skill".to_string()
            }
        }
    };
    let directory = {
        let skill_id = js_string(entry.get("skillId"));
        if !skill_id.is_empty() {
            skill_id
        } else {
            js_string(entry.get("name"))
        }
    };
    Some(json!({
        "key": key,
        "name": name,
        "description": "",
        "directory": directory,
        "repoOwner": owner,
        "repoName": repo_name,
        "repoBranch": "main",
        "readmeUrl": format!("https://github.com/{owner}/{repo_name}"),
        "installs": json_number(js_number_or(entry.get("installs"), 0.0)),
    }))
}

/// upstream fetchPopularSkillsSh：12 个种子查询并发 4，按 key 小写合并保留 installs 大者，
/// installs 降序，截 200 写缓存（6h TTL）。
pub(super) async fn fetch_popular_skills_sh(force: bool, limit: f64) -> SkillResult<Value> {
    let cap = {
        let n = if limit == 0.0 || limit.is_nan() {
            60.0
        } else {
            limit
        };
        n.min(200.0).max(1.0) as i64 as usize
    };
    if !force {
        if let Some(cached) = read_json(&popular_cache_path()) {
            let fresh = cached
                .get("generatedAt")
                .and_then(Value::as_f64)
                .map(|generated_at| now_ms() as f64 - generated_at < POPULAR_CACHE_TTL_MS as f64)
                .unwrap_or(false);
            if fresh {
                if let Some(skills) = cached.get("skills").and_then(Value::as_array) {
                    let sliced: Vec<Value> = skills.iter().take(cap).cloned().collect();
                    let generated_at = cached.get("generatedAt").cloned().unwrap_or(Value::Null);
                    return Ok(
                        json!({"skills": sliced, "cached": true, "generatedAt": generated_at}),
                    );
                }
            }
        }
    }
    let client = http_client()?;
    let worker_client = client.clone();
    let lists = map_with_concurrency(
        POPULAR_SEED_QUERIES
            .iter()
            .map(|q| q.to_string())
            .collect::<Vec<_>>(),
        DISCOVER_CONCURRENCY,
        move |q: String| {
            let client = worker_client.clone();
            async move {
                match search_skills_sh(&client, &q, 30.0, 0.0).await {
                    Ok(data) => Ok(data
                        .get("skills")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default()),
                    Err(error) => {
                        if error.is_rate_limited() {
                            Err(error)
                        } else {
                            // 非 RateLimit 失败当空列表。
                            Ok(Vec::new())
                        }
                    }
                }
            }
        },
    )
    .await;

    let mut index_of: HashMap<String, usize> = HashMap::new();
    let mut merged: Vec<Value> = Vec::new();
    for list in lists {
        for skill in list? {
            let key = {
                let key = js_string(skill.get("key"));
                if !key.is_empty() {
                    key
                } else {
                    format!(
                        "{}/{}:{}",
                        js_string(skill.get("repoOwner")),
                        js_string(skill.get("repoName")),
                        js_string(skill.get("directory"))
                    )
                }
            }
            .to_lowercase();
            let installs = skill.get("installs").map(js_f64).unwrap_or(0.0);
            match index_of.get(&key) {
                Some(&index) => {
                    let previous = merged[index].get("installs").map(js_f64).unwrap_or(0.0);
                    if installs > previous {
                        merged[index] = skill;
                    }
                }
                None => {
                    index_of.insert(key, merged.len());
                    merged.push(skill);
                }
            }
        }
    }
    merged.sort_by(|a, b| {
        let ai = a.get("installs").map(js_f64).unwrap_or(0.0);
        let bi = b.get("installs").map(js_f64).unwrap_or(0.0);
        bi.partial_cmp(&ai).unwrap_or(std::cmp::Ordering::Equal)
    });
    merged.truncate(200);
    write_json(
        &popular_cache_path(),
        &json!({"generatedAt": now_ms(), "skills": &merged}),
    )?;
    let sliced: Vec<Value> = merged.into_iter().take(cap).collect();
    Ok(json!({"skills": sliced, "cached": false, "generatedAt": now_ms()}))
}
