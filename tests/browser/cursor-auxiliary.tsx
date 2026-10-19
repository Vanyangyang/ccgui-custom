// Production sidebar; synthetic metadata, document-local storage and mock IPC.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import i18n from "../../src/lib/i18n";
import { AiChatSidebar, type AiChatRepo } from "../../src/components/application/ai-chat/ai-chat-sidebar";

const params = new URLSearchParams(location.search);
void i18n.changeLanguage(params.get("lang") === "en" ? "en" : "zh");
if (params.get("theme") === "dark") document.documentElement.classList.add("dark");
const width = params.get("width") === "260" ? 260 : 320;
const repos: AiChatRepo[] = [{
  id: "fixture-main", label: "ccgui-custom", defaultOpen: true, threadLimit: 3,
  threads: [
    { id: "cursor/normal", engine: "cursor", label: "用户主动创建的 Cursor 对话", time: "1m", updatedAt: 60 },
    { id: "codex/main", engine: "codex", label: "整理会话列表", time: "2m", updatedAt: 50 },
    { id: "cursor/cce", engine: "cursor", label: "查找会话导入逻辑与父子任务关联，保留中文与 emoji 🔎", time: "3m", updatedAt: 40, auxiliaryKind: "cursor_cce" },
    { id: "cursor/do", engine: "cursor", label: "修复模型选择并运行回归检查 🛠️", time: "4m", updatedAt: 30, auxiliaryKind: "cursor_do", streaming: true },
  ],
  worktrees: [{ id: "fixture-worktree", label: "fix/sidebar", worktree: { branch: "fix/sidebar" }, threads: [
    { id: "cursor/worktree", engine: "cursor", label: "检查 worktree 会话归属", time: "5m", updatedAt: 20, auxiliaryKind: "cursor_cce" },
  ] }],
}];

function Fixture() {
  const [selected, setSelected] = useState("codex/main");
  const [generation, setGeneration] = useState(0);
  const [lastAction, setLastAction] = useState("");
  return <div className="flex min-h-screen bg-background-full text-text-primary">
    <div className="h-screen shrink-0 border-r border-border-primary" style={{ width }}>
      <AiChatSidebar key={generation} repos={repos} width={width} activeThreadId={selected}
        onThreadSelect={setSelected} onThreadAction={(id, action) => setLastAction(`${action}: ${id}`)}
        onCopyThreadId={(id) => setLastAction(`copy: ${id}`)} />
    </div>
    <main className="min-w-0 flex-1 space-y-3 p-4">
      <p>Cursor 辅助任务 · 浏览器验证</p>
      <p>Selected: <output data-testid="selected">{selected}</output></p>
      <p>Action: <output>{lastAction}</output></p>
      <button className="rounded border px-3 py-1" onClick={() => setGeneration((n) => n + 1)}>Remount sidebar</button>
      <p>展开辅助任务，右键移到普通会话，再移回。重挂载保留本页偏好；搜索仍可找到折叠任务。</p>
      <p>切换全部会话 / 工作区模式，两者都应保留普通 Cursor 对话，且不重复辅助任务。</p>
    </main>
  </div>;
}
createRoot(document.getElementById("fixture")!).render(<Fixture />);
