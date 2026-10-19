//! MCP 运行时清单：来自实际会话的观测，而不是猜测。
//!
//! 数据源：Claude CLI 的 `system/init` 事件（`mcp_servers` + `tools`）。
//! 引擎层把事件转成 `EngineEvent::McpServers`，这里按键为 workspace 的快照
//! 保存，并记录采集时间与会话；会话结束时只把状态标为"会话已结束"，快照
//! 保留（用户仍能看到最近一次实际连接情况），绝不冒充实时状态。
//!
//! Codex 在当前架构下没有运行时探测通道：`mcp_inventory` 直接给出
//! unsupported 原因，不启动额外 CLI。

use super::{now_ms, McpRuntimeEntry, McpRuntimeSection};
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Clone)]
struct Snapshot {
    session_id: Option<String>,
    collected_at: i64,
    ended: bool,
    entries: Vec<McpRuntimeEntry>,
}

fn run_workspace() -> &'static parking_lot::Mutex<HashMap<String, String>> {
    static CELL: OnceLock<parking_lot::Mutex<HashMap<String, String>>> = OnceLock::new();
    CELL.get_or_init(|| parking_lot::Mutex::new(HashMap::new()))
}

fn snapshots() -> &'static parking_lot::Mutex<HashMap<String, Snapshot>> {
    static CELL: OnceLock<parking_lot::Mutex<HashMap<String, Snapshot>>> = OnceLock::new();
    CELL.get_or_init(|| parking_lot::Mutex::new(HashMap::new()))
}

/// 记录 run → workspace：`dispatch_event` 只有 run_id，工作区在 spawn 时已知。
pub(crate) fn register_run(run_id: &str, workspace: &str) {
    if run_id.is_empty() || workspace.is_empty() {
        return;
    }
    run_workspace()
        .lock()
        .insert(run_id.to_string(), workspace.to_string());
}

/// 记录一次会话的 MCP 快照（claude `system/init`）。
pub(crate) fn record_from_run(
    run_id: &str,
    session_id: Option<&str>,
    servers: Vec<(String, Option<String>)>,
    tools: Vec<String>,
) {
    let Some(workspace) = run_workspace().lock().get(run_id).cloned() else {
        // 未注册的 run（如任务工作台的临时 run）：不猜测工作区，宁可不展示。
        return;
    };
    let entries: Vec<McpRuntimeEntry> = servers
        .into_iter()
        .map(|(name, status)| {
            let prefix = format!("mcp__{name}__");
            let lowered = prefix.to_lowercase();
            let mut tool_names: Vec<String> = tools
                .iter()
                .filter_map(|tool| {
                    if tool.to_lowercase().starts_with(&lowered) {
                        Some(tool[prefix.len()..].to_string())
                    } else {
                        None
                    }
                })
                .collect();
            tool_names.sort();
            tool_names.dedup();
            McpRuntimeEntry {
                builtin: name == crate::computer_use::MCP_SERVER_NAME
                    || name == crate::host_chat::MCP_SERVER_NAME,
                name,
                status,
                tool_names,
                resources_count: 0,
                templates_count: 0,
            }
        })
        .collect();
    let collected_at = now_ms();
    let mut snapshots = snapshots().lock();
    let replace = snapshots
        .get(&workspace)
        .map(|existing| collected_at >= existing.collected_at)
        .unwrap_or(true);
    if replace {
        snapshots.insert(
            workspace,
            Snapshot {
                session_id: session_id.map(str::to_string),
                collected_at,
                ended: false,
                entries,
            },
        );
    }
}

/// 会话落定（done/error）：快照保留但标记为已结束；run 映射清理。
pub(crate) fn mark_run_ended(run_id: &str) {
    let workspace = run_workspace().lock().remove(run_id);
    let Some(workspace) = workspace else {
        return;
    };
    if let Some(snapshot) = snapshots().lock().get_mut(&workspace) {
        if !snapshot.ended {
            snapshot.ended = true;
        }
    }
}

/// Claude 的运行时分区。没有工作区 / 没有会话 / 没有快照都给出具体原因。
pub(crate) fn claude_section(workspace: Option<&str>) -> McpRuntimeSection {
    let Some(workspace) = workspace else {
        return McpRuntimeSection {
            status: "no_session".to_string(),
            reason: None,
            workspace: None,
            session_id: None,
            collected_at: None,
            entries: Vec::new(),
        };
    };
    match snapshots().lock().get(workspace).cloned() {
        Some(snapshot) => McpRuntimeSection {
            // Statuses are enumerable; the UI localizes them. `reason` stays
            // for genuinely unexpected diagnostics only.
            status: if snapshot.ended {
                "session_ended"
            } else {
                "ready"
            }
            .to_string(),
            reason: None,
            workspace: Some(workspace.to_string()),
            session_id: snapshot.session_id,
            collected_at: Some(snapshot.collected_at),
            entries: snapshot.entries,
        },
        None => McpRuntimeSection {
            // The status key carries the explanation; the UI localizes it.
            status: "no_session".to_string(),
            reason: None,
            workspace: Some(workspace.to_string()),
            session_id: None,
            collected_at: None,
            entries: Vec::new(),
        },
    }
}
