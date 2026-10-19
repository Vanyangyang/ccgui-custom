// Open /tests/browser/run-status-strip.html with the Vite dev server running.
// Visual fixture for the chat run-status strip: seeded chat/git stores, no
// real IPC or saved conversation. Buttons replay a live turn and native controls.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import "../../src/lib/i18n";
import { useChatStore } from "../../src/features/chat/store";
import { useGitStore } from "../../src/features/git/store";
import { RunStatusStrip } from "../../src/features/chat/components/RunStatusStrip";
import { ipc, type Message, type TodosPayload } from "../../src/lib/ipc";

const KEY = "run-status-fixture";
const WS = "/ws";
let failNextStop = false;
let stopCalls = 0;
ipc.stopNativeTask = async ({ runId, taskId }) => {
  const fail = failNextStop;
  failNextStop = false;
  const log = document.getElementById("stop-log");
  if (log) log.textContent = `stop_native_task #${++stopCalls}: ${JSON.stringify({ runId, taskId })}`;
  await new Promise((resolve) => setTimeout(resolve, 800));
  if (fail) throw new Error("模拟原生拒绝");
  // Intentionally omit the tasks event: the confirmed IPC outcome must also
  // settle a client that missed that event while reconnecting.
  return { taskId, status: "stopped" };
};

function msg(seq: number, role: string, text: string, path?: string): Message {
  return { seq, role, text, path: path ?? null, ts: null };
}
function todoMsg(seq: number, todos: TodosPayload): Message {
  return { seq, role: "tool", text: "todo", ts: null, todos };
}

/** One settled spawn (a later assistant row exists), one still running, two
 * edited files — the mid-turn shape. */
const TURN: Message[] = [
  msg(1, "user", "帮我修复这些 failing tests"),
  todoMsg(7, {
    replace: true,
    items: [
      { content: "复现失败用例", status: "complete" },
      { content: "定位根因", status: "complete" },
      { content: "派发并行修复", status: "active" },
      { content: "回归验证", status: "pending" },
      { content: "更新快照", status: "blocked" },
    ],
  }),
  msg(2, "tool", "task · Fix auth token refresh tests"),
  msg(3, "tool", "edit_file", "/ws/src/features/auth/auth.ts"),
  msg(4, "assistant", "第一个子代理已回传，继续等待其余结果。"),
  msg(5, "tool", "task · Dispatching 10 parallel fix agents"),
  msg(6, "tool", "edit_file", "/ws/src/lib/rate-limiter.ts"),
];

function seed(streaming: boolean, native = false) {
  useChatStore.setState({
    bySession: { [KEY]: { messages: TURN, streaming,
      ...(native ? { nativeTaskRunId: "native-fixture", nativeActivity: "waiting", nativeTasks: [
        { id: "check", kind: "local_bash", description: "维护检查：完整测试、中文与 emoji 🧪 回归", status: streaming ? "running" : "completed", background: true, summary: streaming ? undefined : "17 项检查通过" },
        { id: "review", kind: "local_agent", description: "审查原生 Claude 后台任务生命周期", status: "completed", summary: "审查完成，输入管道和后台续答已核对" },
        { id: "failed", kind: "local_bash", description: "失败命令的结果仍然可见", status: "failed", summary: "原生命令以退出码 7 结束" },
        { id: "stopped", kind: "local_agent", description: "已停止的独立子任务", status: "stopped" },
        { id: "unknown", kind: "local_workflow", description: "进程退出，尚未收到最终状态", status: "unknown" },
        // Running ambient observer: neutral hollow ring, not the completed-green dot.
        { id: "watcher", kind: "local_monitor", description: "常驻观察任务（不计入运行数）", status: "running", ambient: true },
        // Unmapped kind: one generic localized chip, never the raw identifier.
        { id: "future", kind: "future_kind", description: "未收录的原生任务类型", status: "completed" },
      ] } : {}),
    } as never },
  });
}

useGitStore.setState({
  statusByWorkspace: {
    [WS]: {
      branch: "main",
      staged: [],
      unstaged: [
        { path: "src/features/auth/auth.ts", status: "M", additions: 64, deletions: 12 },
        { path: "src/lib/rate-limiter.ts", status: "M", additions: 38, deletions: 20 },
      ],
      untracked: [],
    },
  },
  // File refresh never touches real IPC.
  refresh: async () => {},
});

seed(true);

function Fixture() {
  const [streaming, setStreaming] = useState(true);
  const [native, setNative] = useState(false);
  const [narrow, setNarrow] = useState(false);
  return (
    <div style={{ maxWidth: narrow ? 320 : 768, margin: "40px auto", padding: "0 16px", fontFamily: "sans-serif" }}>
      <div style={{ marginBottom: 16, display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button onClick={() => { seed(true, native); setStreaming(true); }}>▶ 进行中</button>
        <button onClick={() => { seed(false, native); setStreaming(false); }}>✓ 回合结束</button>
        <button onClick={() => { setNative(true); seed(true, true); setStreaming(true); }}>原生 Claude 后台任务</button>
        <button onClick={() => { failNextStop = true; }}>模拟下次停止失败</button>
        <button onClick={() => setNarrow(!narrow)}>320 px 预览</button>
        <span style={{ color: "#a1a1aa", fontSize: 12, alignSelf: "center" }}>
          点击 pill 展开面板；Esc 收起；右侧方块收起整条（localStorage 持久化）
        </span>
      </div>
      <p id="stop-log" style={{ fontSize: 12, overflowWrap: "anywhere" }}>停止操作使用模拟原生接口；不会影响真实会话。</p>
      <div style={{ background: "#fff", border: "1px solid #e4e4e7", borderRadius: 12, padding: 16 }}>
        <div style={{ height: 240, color: "#a1a1aa", fontSize: 13 }}>
          消息区（面板浮在其上方，不会把它顶下去）…
        </div>
        <RunStatusStrip sessionKey={KEY} engine={native ? "claude" : "pi"} workspacePath={WS} />
        <div style={{ border: "1px solid #d4d4d8", borderRadius: 12, padding: "10px 12px", color: "#a1a1aa", fontSize: 13 }}>
          发消息给 Agent…
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("fixture")!).render(<Fixture />);
