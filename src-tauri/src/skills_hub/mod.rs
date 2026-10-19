//! Skills hub 后端：从参考项目 desktop-cc-gui 的 Rust 移植 `skills_hub/` 迁移而来
//! （MIT，Copyright (c) 2026 Thomas Ricouard / zhukunpenglinyutong（朱昆鹏）），
//! 上游可溯源到 TokenTracker 的 `skills-manager.js` / `skill-usage.js`（MIT）。
//!
//! 对外只暴露两个 Tauri command，语义与参考实现的 HTTP 端点对齐，但前端以
//! 判别联合消费（见 `src/lib/ipc.ts`）：
//! - [`skills_hub_query`]：installed / discover / search / repos / popular /
//!   updates / activity / skill_usage
//! - [`skills_hub_mutate`]：install / uninstall / restore / set_targets /
//!   import_local / delete_local / add_repo / remove_repo
//!
//! 变更接口的返回里，多目标同步逐目标给出 `targetResults`；`ok` 只描述主操作
//! （注册表变更）是否成功，部分目标的失败不会伪装成整体成功。
//! 错误统一序列化为 `{ code, message }`，code 区分 rate_limited /
//! invalid_input / not_found / conflict / readonly / permission / network /
//! http / internal，前端据此给出对应恢复路径。

use serde::Serialize;
use serde_json::{json, Value};

mod core;
mod discover;
mod fsutil;
mod http;
mod lifecycle;
mod registry;
mod repos;
mod scan;
mod target_sync;
mod updates_popular;
mod usage;

use core::*;
use discover::*;
use fsutil::*;
use http::*;
use lifecycle::*;
use registry::*;
use repos::*;
#[cfg(test)]
use scan::*;
use target_sync::*;
use updates_popular::*;
use usage::*;

/// 供 `creator_skill` 复用同一张引擎目标表（内置 skill 落到每个已安装的 CLI）。
pub(crate) use core::installed_engine_skill_roots;

/// 归一化的错误：Tauri 把 `Err` 的序列化值交给前端（不是字符串）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HubError {
    code: &'static str,
    message: String,
}

impl From<SkillError> for HubError {
    fn from(error: SkillError) -> Self {
        match error {
            SkillError::RateLimited(message) => Self {
                code: "rate_limited",
                message,
            },
            SkillError::Coded(code, message) => Self { code, message },
            SkillError::Other(message) => Self {
                code: "internal",
                message,
            },
        }
    }
}

/// query 的 `force` 仅字符串 "1" 生效（对齐 upstream `get("force") === "1"`）。
fn param_force(params: &Value) -> bool {
    params.get("force").and_then(Value::as_str) == Some("1")
}

/// payload 里的字符串数组参数；key 缺失/非数组 → None（调用方决定默认值）。
fn string_array_param(payload: &Value, key: &str) -> Option<Vec<String>> {
    payload.get(key).and_then(Value::as_array).map(|arr| {
        arr.iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect()
    })
}

/// Skills Hub 查询端点。
#[tauri::command]
pub(crate) async fn skills_hub_query(mode: String, params: Value) -> Result<Value, HubError> {
    let mode = if mode.is_empty() {
        "installed"
    } else {
        mode.as_str()
    };
    match mode {
        "installed" => {
            let payload = tokio::task::spawn_blocking(|| {
                json!({
                    "targets": target_list(),
                    "skills": list_installed_skills(),
                    "generatedAt": now_ms(),
                })
            })
            .await
            .map_err(|e| HubError::from(SkillError::other(format!("skills task failed: {e}"))))?;
            Ok(payload)
        }
        "repos" => Ok(json!({"repos": list_repos()})),
        "discover" => discover_skills(param_force(&params))
            .await
            .map_err(HubError::from),
        "search" => {
            let q = js_string(params.get("q"));
            let limit = js_number_or(params.get("limit"), 20.0);
            let offset = js_number_or(params.get("offset"), 0.0);
            let client = http_client().map_err(HubError::from)?;
            search_skills_sh(&client, &q, limit, offset)
                .await
                .map_err(HubError::from)
        }
        "popular" => {
            let limit = js_number_or(params.get("limit"), 60.0);
            fetch_popular_skills_sh(param_force(&params), limit)
                .await
                .map_err(HubError::from)
        }
        "updates" => check_updates(param_force(&params))
            .await
            .map_err(HubError::from),
        "activity" => {
            let limit = js_number_or(params.get("limit"), 50.0) as i64;
            let payload =
                tokio::task::spawn_blocking(move || json!({"activity": read_activity(limit)}))
                    .await
                    .map_err(|e| {
                        HubError::from(SkillError::other(format!("skills task failed: {e}")))
                    })?;
            Ok(payload)
        }
        "skill_content" => {
            let directory = js_string(params.get("directory"));
            let payload = tokio::task::spawn_blocking(move || read_skill_content(&directory))
                .await
                .map_err(|e| HubError::from(SkillError::other(format!("skills task failed: {e}"))))?
                .map_err(HubError::from)?;
            Ok(payload)
        }
        // skills.sh 只给 name / repo / installs：详情回仓库读 SKILL.md。
        "remote_skill_content" => {
            let owner = js_string(params.get("owner"));
            let name = js_string(params.get("name"));
            let branch = {
                let branch = js_string(params.get("branch"));
                if branch.is_empty() {
                    "main".to_string()
                } else {
                    branch
                }
            };
            let directory = js_string(params.get("directory"));
            remote_skill_content(&owner, &name, &branch, &directory)
                .await
                .map_err(HubError::from)
        }
        "skill_usage" => {
            let force = param_force(&params);
            let payload = tokio::task::spawn_blocking(move || skill_usage_query(force))
                .await
                .map_err(|e| {
                    HubError::from(SkillError::other(format!("skills task failed: {e}")))
                })?;
            Ok(payload)
        }
        _ => Err(HubError::from(SkillError::coded(
            "invalid_input",
            "Unknown skills mode",
        ))),
    }
}

/// Skills Hub 变更端点。
#[tauri::command]
pub(crate) async fn skills_hub_mutate(
    state: tauri::State<'_, crate::AppState>,
    action: String,
    payload: Value,
) -> Result<Value, HubError> {
    mutate_and_announce(state.emitters.as_ref(), &action, payload).await
}

async fn mutate_and_announce(
    emitter: &dyn crate::event_sink::Emit,
    action: &str,
    payload: Value,
) -> Result<Value, HubError> {
    let result = match action {
        "install" => {
            let skill = payload.get("skill").cloned().unwrap_or(Value::Null);
            let targets = string_array_param(&payload, "targets")
                .unwrap_or_else(|| vec!["claude".to_string(), "codex".to_string()]);
            // `force` acknowledges that a locally modified managed copy will
            // be overwritten (updates); without it the backend refuses.
            let force = payload
                .get("force")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            install_skill(&skill, &targets, force)
                .await
                .map_err(HubError::from)
        }
        "uninstall" => uninstall_skill(&js_string(payload.get("id"))).map_err(HubError::from),
        "restore" => restore_skill(&js_string(payload.get("id"))).map_err(HubError::from),
        "set_targets" => {
            let targets = string_array_param(&payload, "targets").unwrap_or_default();
            set_skill_targets(&js_string(payload.get("id")), &targets).map_err(HubError::from)
        }
        "import_local" => {
            let targets = string_array_param(&payload, "targets").unwrap_or_default();
            import_local_skill(&js_string(payload.get("directory")), &targets)
                .map_err(HubError::from)
        }
        "delete_local" => {
            let targets = string_array_param(&payload, "targets").unwrap_or_default();
            delete_local_skill(&js_string(payload.get("directory")), &targets)
                .map_err(HubError::from)
        }
        "add_repo" => add_repo(payload.get("repo").unwrap_or(&Value::Null)).map_err(HubError::from),
        "remove_repo" => remove_repo(
            &js_string(payload.get("owner")),
            &js_string(payload.get("name")),
        )
        .map_err(HubError::from),
        _ => return Err(HubError::from(SkillError::coded(
            "invalid_input",
            "Unknown skills action",
        ))),
    };
    // Multi-target copies, restore moves, or registry writes may have taken
    // effect before a later step fails. Both attached UIs must reread then too.
    emitter.emit_json("skills://changed", "null");
    result
}

#[cfg(test)]
mod tests;
