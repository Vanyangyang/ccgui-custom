// Production UI with document-local data only. No model calls or real chats.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import i18n from "../../src/lib/i18n";
import { AiChatSidebar, type AiChatRepo } from "../../src/components/application/ai-chat/ai-chat-sidebar";
import { useChatStore } from "../../src/features/chat/store";
import { useCrossSessionActivityStore, type CrossSessionCommunicationStatus } from "../../src/features/chat/cross-session";

const params = new URLSearchParams(location.search);
void i18n.changeLanguage(params.get("lang") === "en" ? "en" : "zh");
if (params.get("theme") === "dark") document.documentElement.classList.add("dark");
const width = params.get("width") === "260" ? 260 : 320;
const repos: AiChatRepo[] = [{ id: "fixture", path: "/fixture", label: "ccgui-custom", defaultOpen: true, threads: [
  { id: "codex/main", engine: "codex", workspacePath: "/fixture", label: "主任务：改进会话通信体验 💬", time: "1m", updatedAt: 50, streaming: true },
  { id: "claude/review", engine: "claude", workspacePath: "/fixture", label: "接口检查与回归验证", time: "2m", updatedAt: 40 },
  { id: "cursor/ordinary", engine: "cursor", workspacePath: "/fixture", label: "正在做自己的事情", time: "8m", updatedAt: 30 },
], worktrees: [{ id: "other", path: "/fixture/branch", label: "worktree", threads: [
  { id: "agy/branch", engine: "agy", workspacePath: "/fixture/branch", label: "独立工作树里的对话", time: "9m", updatedAt: 20 },
] }] }];

function update(status: CrossSessionCommunicationStatus) {
  const existing = useCrossSessionActivityStore.getState().records.find((r) => r.scopedId === "fixture-request");
  useCrossSessionActivityStore.getState().upsertRecord({
    scopedId: "fixture-request", requestId: "fixture-request",
    sender: { engine: "codex", sessionId: "main", workspacePath: "/fixture", title: "主任务：改进会话通信体验 💬" },
    target: { engine: "claude", sessionId: "review", workspacePath: "/fixture", title: "接口检查与回归验证" },
    message: "请帮我核对发送与回复的边界条件，确认长中文、emoji 👩‍💻 和多行内容保留完整。",
    status, acceptedAt: existing?.acceptedAt ?? Date.now(), updatedAt: Date.now(),
    replyText: ["executing", "completed"].includes(status) ? "已检查发送与回执链路。\n长标题和多行回复应当可读、可复制，不挤压其他会话。\n中文与 emoji 👩‍💻 保持完整。" : undefined,
    error: status === "failed" ? "目标会话暂时不可用。" : undefined,
  });
}

function Fixture() {
  const [selected, setSelected] = useState("codex/main");
  useEffect(() => { useChatStore.setState({ selectSession: async (engine, sessionId) => { setSelected(`${engine}/${sessionId}`); } }); }, []);
  return <div className="flex min-h-screen bg-background-full text-text-primary">
    <div className="h-screen shrink-0 border-r border-border-primary" style={{ width }}>
      <AiChatSidebar repos={repos} width={width} activeThreadId={selected} onThreadSelect={setSelected} onThreadAction={() => {}} />
    </div>
    <main className="min-w-0 flex-1 space-y-4 p-4">
      <h1>跨会话状态 · 浏览器验证</h1>
      <p>Selected: <output>{selected}</output></p>
      <div className="flex flex-wrap gap-2">
        {(["received", "executing", "awaiting_permission", "completed", "failed"] as const).map((status) =>
          <button key={status} className="rounded border px-3 py-1" onClick={() => update(status)}>{status}</button>)}
        <button className="rounded border px-3 py-1" onClick={() => useCrossSessionActivityStore.getState().reset()}>Reset</button>
      </div>
      <p>仅操作本页合成记录。检查活跃行浅色背景、方向与对端说明；悬停或键盘聚焦行尾标记时对端突出显示。完成并读过详情后应恢复普通行，行高和标记位置保持稳定。</p>
      <input aria-label="Focus check" className="rounded border p-2" placeholder="关闭浮层后应可直接继续输入" />
    </main>
  </div>;
}
createRoot(document.getElementById("fixture")!).render(<Fixture />);
