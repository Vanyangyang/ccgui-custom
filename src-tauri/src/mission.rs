//! 任务工作台原生入口（docs/plans/mission-workbench-plan.md §4.5）。
//!
//! agent 节点直接复用宿主引擎管线（与 plugin-sdk `ctx.agent.start` 同一条
//! spawn/reader/registry 链路），但事件走独立的 `mission-agent://event`
//! 流，不使用插件权限体系。逐节点工具白名单（readOnly）通过
//! `allowed_tools` 传给引擎；引擎不能兑现时启动直接失败。

use tauri::Manager;

use crate::engine;

/// mission 只能中断自己启动的 run：run id 内嵌 `mission-` 前缀。
fn mission_owns_run_id(run_id: &str) -> bool {
    run_id.starts_with("mission-")
}

/// 启动一个 agent 节点轮次。返回 runId/sessionId；事件在该 run 上流动。
/// 前端可预先生成 runId（必须先注册事件监听再 invoke，避免错过首批事件），
/// 但前缀必须是 `mission-`，且只能被 mission_agent_interrupt 中断。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn mission_agent_start(
    app: tauri::AppHandle,
    engine: String,
    prompt: String,
    workspace_path: String,
    model: Option<String>,
    effort: Option<String>,
    provider_id: Option<String>,
    session_id: Option<String>,
    allowed_tools: Option<Vec<String>>,
    run_id: Option<String>,
) -> Result<engine::SendResult, String> {
    let state = app.state::<crate::AppState>();
    let run_id = match run_id {
        Some(id) if !mission_owns_run_id(&id) => {
            return Err(format!("run id {id:?} is not a mission run id"));
        }
        Some(id) => id,
        None => format!("mission-{}", uuid::Uuid::new_v4().simple()),
    };
    engine::mission_agent_send(
        state.inner(),
        engine,
        workspace_path,
        session_id,
        prompt,
        model,
        effort,
        provider_id,
        run_id,
        allowed_tools,
    )
    .await
}

/// 中断一个任务工作台 agent 轮次；不接受聊天/插件 run id。
#[tauri::command]
pub(crate) async fn mission_agent_interrupt(
    app: tauri::AppHandle,
    run_id: String,
) -> Result<bool, String> {
    if !mission_owns_run_id(&run_id) {
        return Err(format!(
            "run id {run_id:?} not owned by the mission workbench"
        ));
    }
    let state = app.state::<crate::AppState>();
    let registry = std::sync::Arc::clone(&state.processes);
    tauri::async_runtime::spawn_blocking(move || registry.kill(&run_id))
        .await
        .map_err(|e| e.to_string())
}
