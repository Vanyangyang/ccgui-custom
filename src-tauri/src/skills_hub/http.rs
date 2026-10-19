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
use std::sync::Arc;

use super::core::*;
use super::fsutil::*;
// ===== 网络层：UA tokentracker-skills + Accept + 20s 超时，429/403 → RateLimit =====

pub(super) fn http_client() -> SkillResult<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent("tokentracker-skills")
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|e| SkillError::other(format!("Failed to build HTTP client: {e}")))
}

pub(super) fn rate_limit_error(status: reqwest::StatusCode) -> SkillError {
    let msg = format!(
        "GitHub rate-limited this request (HTTP {}). Try again later.",
        status.as_u16()
    );
    SkillError::RateLimited(msg)
}

pub(super) async fn fetch_checked(response: reqwest::Response) -> SkillResult<reqwest::Response> {
    let status = response.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status == reqwest::StatusCode::FORBIDDEN
    {
        return Err(rate_limit_error(status));
    }
    if !status.is_success() {
        return Err(SkillError::coded(
            "http",
            format!("HTTP {}", status.as_u16()),
        ));
    }
    Ok(response)
}

/// upstream fetchJson（Accept: application/vnd.github+json）。
pub(super) async fn fetch_json(client: &reqwest::Client, url: &str) -> SkillResult<Value> {
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| SkillError::coded("network", format!("request failed: {e}")))?;
    fetch_checked(response)
        .await?
        .json::<Value>()
        .await
        .map_err(|e| SkillError::coded("http", format!("invalid JSON response: {e}")))
}

/// upstream fetchText（Accept: text/plain）。
pub(super) async fn fetch_text(client: &reqwest::Client, url: &str) -> SkillResult<String> {
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "text/plain")
        .send()
        .await
        .map_err(|e| SkillError::coded("network", format!("request failed: {e}")))?;
    fetch_checked(response)
        .await?
        .text()
        .await
        .map_err(|e| SkillError::coded("network", format!("failed to read response body: {e}")))
}

/// upstream getRepoTree：branch 回退链 [配置 branch（除非 =~ /^head$/i）, main, master]
/// 去重逐个尝试；全部失败抛最后一个错误。
pub(super) async fn get_repo_tree(
    client: &reqwest::Client,
    owner: &str,
    name: &str,
    branch: &str,
) -> SkillResult<(String, Vec<Value>)> {
    let mut branches: Vec<String> = Vec::new();
    if !branch.is_empty() && !eq_ignore_case(branch, "head") {
        branches.push(branch.to_string());
    }
    for fallback in ["main", "master"] {
        if !branches.iter().any(|b| b == fallback) {
            branches.push(fallback.to_string());
        }
    }
    let mut last_error: Option<SkillError> = None;
    for candidate in &branches {
        let url = format!(
            "https://api.github.com/repos/{owner}/{name}/git/trees/{}?recursive=1",
            encode_uri_component(candidate)
        );
        match fetch_json(client, &url).await {
            Ok(data) => {
                if let Some(tree) = data.get("tree").and_then(Value::as_array) {
                    return Ok((candidate.clone(), tree.clone()));
                }
            }
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| SkillError::other(format!("Unable to read {owner}/{name}"))))
}

/// upstream mapWithConcurrency：固定 limit 的 worker 池，结果按输入顺序对齐。
/// （upstream 用 Promise.all，任一 reject 整体 reject；这里收集全部结果由调用方决定，
/// 等价于 allSettled + 调用方首个错误上抛。）
pub(super) async fn map_with_concurrency<T, R, F, Fut>(
    items: Vec<T>,
    limit: usize,
    worker: F,
) -> Vec<Result<R, SkillError>>
where
    T: Send + 'static,
    R: Send + 'static,
    F: Fn(T) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<R, SkillError>> + Send + 'static,
{
    let count = items.len();
    let worker = Arc::new(worker);
    let semaphore = Arc::new(tokio::sync::Semaphore::new(limit.max(1)));
    let mut set: tokio::task::JoinSet<(usize, Result<R, SkillError>)> = tokio::task::JoinSet::new();
    for (index, item) in items.into_iter().enumerate() {
        // 先拿 permit 再 spawn，等价于上游的 pool of N runners。
        let Ok(permit) = semaphore.clone().acquire_owned().await else {
            break;
        };
        let worker = Arc::clone(&worker);
        set.spawn(async move {
            let _permit = permit;
            let result = worker(item).await;
            (index, result)
        });
    }
    let mut results: Vec<Option<Result<R, SkillError>>> = Vec::new();
    results.resize_with(count, || None);
    while let Some(joined) = set.join_next().await {
        if let Ok((index, result)) = joined {
            results[index] = Some(result);
        }
    }
    results
        .into_iter()
        .map(|slot| slot.unwrap_or_else(|| Err(SkillError::other("concurrent worker failed"))))
        .collect::<Vec<_>>()
}
