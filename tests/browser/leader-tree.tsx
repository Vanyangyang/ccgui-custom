// Real sidebar/menu/management components; the HTML mocks native invoke only.
// No models are started. Open /tests/browser/leader-tree.html in existing Vite.
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";
import i18n from "../../src/lib/i18n";
import { AiChatSidebar } from "../../src/components/application/ai-chat/ai-chat-sidebar";
import { useChatStore } from "../../src/features/chat/store";
import { optimisticMeta } from "../../src/features/chat/store/engine-events";
import { groupLeaderThreads } from "../../src/features/leader/tree";
import { LeaderManagementHost } from "../../src/features/leader/LeaderManagementHost";
import { useLeaderStore, manageLeader } from "../../src/features/leader/store";
import { startLeaderRuntime } from "../../src/features/leader/runtime";
import type { LeaderBranch, LeaderSnapshot } from "../../src/features/leader/types";
import { ArchivedSessionsSection } from "../../src/features/settings/ArchivedSessionsSection";
import type { SessionMeta } from "../../src/lib/ipc";

declare global { interface Window { __LEADER_FIXTURE__: LeaderSnapshot; __LEADER_FIXTURE_FAIL__: boolean; __LEADER_FIXTURE_SESSIONS__: SessionMeta[]; __LEADER_FIXTURE_ARCHIVES__: SessionMeta[]; __LEADER_FIXTURE_USAGE__: Record<string, unknown> } }
const parent = { engine: "claude", sessionId: "fixture-leader", workspacePath: "G:/fixture" };
const params = new URLSearchParams(window.location.search);
void i18n.changeLanguage(params.get("lang") === "en" ? "en" : "zh");
const sidebarWidth = params.get("width") === "260" ? 260 : 320;
const parentTitle = params.has("long-title")
  ? "leader模式现在能正常派发吗？验证共享工作区、等待结果与回收后的侧栏状态 🚀"
  : "Leader：完成当前审查任务";
const makeBranch = (id: string, engine: string, title: string, state: LeaderBranch["state"], overrides: Partial<LeaderBranch> = {}): LeaderBranch => ({
  id, engine, sessionId: `session-${id}`, parentEngine: parent.engine, parentSessionId: parent.sessionId, workspacePath: parent.workspacePath,
  title, task: `审查 ${title}，将结果返回父会话。`, model: null, effort: "high", runId: `run-${id}`, state,
  createdAt: Date.now(), updatedAt: Date.now(), lastActivityAt: Date.now(), deadlineAt: Date.now() + (engine === "claude" ? 3600000 : 1800000), expired: false,
  result: "", resultTruncated: false, error: null, ...overrides,
});
const initial: LeaderSnapshot = { leaders: [parent], branches: [
  makeBranch("analysis", "codex", "分析调用链与并发状态", "running"),
  makeBranch("approval", "claude", "等待批准的界面修复", "waiting"),
  makeBranch("result", "codex", "已经完成的回归检查 🚀", "completed", { result: "中文与 emoji 已保留；回归检查通过。\n结果保留至用户整组归档或删除。" }),
  makeBranch("expired", "claude", "到期需要检查的分支", "unknown", { expired: true, deadlineAt: Date.now() - 60000 }),
  makeBranch("grandchild", "claude", "子分支委派的后代任务", "completed", { parentEngine: "codex", parentSessionId: "session-analysis", result: "后代结果交给直属父会话。" }),
  makeBranch("starting", "codex", "正在创建真实子会话", "starting", { sessionId: null }),
] };
if (params.get("scenario") === "ttl") {
  initial.branches.push(
    makeBranch("codex-high", "codex", "到期 Codex：验证 50% 阈值", "completed", { expired: true, deadlineAt: Date.now() - 120000 }),
    makeBranch("codex-unknown", "codex", "到期 Codex：仅累计计费量", "completed", { expired: true, deadlineAt: Date.now() - 180000 }),
  );
}
window.__LEADER_FIXTURE_USAGE__ = {
  "codex/session-analysis": { input_tokens: 360000, output_tokens: 0, model_context_window: 400000 },
  "claude/session-expired": { input_tokens: 420000, output_tokens: 0, model_context_window: 1000000 },
  "codex/session-result": { input_tokens: 100000, output_tokens: 0, model_context_window: 400000 },
  "codex/session-codex-high": { input_tokens: 250000, output_tokens: 0, model_context_window: 500000 },
  "codex/session-codex-unknown": { last_token_usage: null, total_token_usage: { input_tokens: 9000000, total_tokens: 9100000 }, model_context_window: 500000 },
};
if (params.get("scenario") === "reclaimed") {
  initial.branches = initial.branches.map(branch => ({ ...branch, state: "reclaimed" }));
}
window.__LEADER_FIXTURE__ = structuredClone(initial);
window.__LEADER_FIXTURE_FAIL__ = false;
useLeaderStore.setState({ snapshot: initial });
window.__LEADER_FIXTURE_SESSIONS__ = [optimisticMeta(parent.engine, parent.sessionId, parent.workspacePath, parentTitle),
  ...initial.branches.filter(b => b.sessionId && b.state !== "reclaimed").map(b => optimisticMeta(b.engine, b.sessionId!, b.workspacePath, b.title))];
window.__LEADER_FIXTURE_ARCHIVES__ = [];
useChatStore.setState({ sessions: structuredClone(window.__LEADER_FIXTURE_SESSIONS__),
  active: parent, openTabs: [parent], bySession: {} });

function Fixture() {
  const snapshot = useLeaderStore(s => s.snapshot);
  const sessions = useChatStore(s => s.sessions);
  const [selected, setSelected] = useState(`${parent.engine}/${parent.sessionId}`);
  const repos = useMemo(() => [{ id: "leader-fixture-ws", path: parent.workspacePath, label: "ccgui-custom", defaultOpen: true,
    threadLimit: 3, threads: groupLeaderThreads(sessions.map(s => ({ id: `${s.engine}/${s.sessionId}`, engine: s.engine, label: s.title, time: "" })), snapshot, parent.workspacePath),
    worktrees: [{ id: "fixture-wt", label: "feature/example", worktree: { branch: "feature/example" }, threads: [{ id: "codex/flat-worktree", engine: "codex", label: "普通 Worktree 会话", time: "2m" }] }],
  }], [sessions, snapshot]);
  useEffect(() => startLeaderRuntime(), []);
  return <div className="flex h-screen bg-background-primary-default text-text-primary">
    <AiChatSidebar repos={repos} width={sidebarWidth} activeThreadId={selected} onThreadSelect={setSelected} onThreadAction={() => {}} />
    <main className="flex min-w-0 flex-1 flex-col gap-4 overflow-auto p-8">
      <h1 className="text-xl font-semibold">Leader 真实组件夹具</h1>
      <p>包含 Claude / Codex、孙分支、等待审批、到期、已完成及尚无原生 ID 的状态。</p>
      <p>选中：{selected}</p>
      <button className="rounded border p-2" onClick={() => setSelected("claude/session-grandchild")}>选中孙分支并展开祖先</button>
      <button className="rounded border p-2" onClick={() => manageLeader(parent)}>打开直属父会话管理</button>
      {params.get("scenario") === "ttl" && <button className="rounded border p-2" onClick={() => {
        window.__LEADER_FIXTURE_USAGE__["claude/session-expired"] = { input_tokens: 150000, output_tokens: 0, model_context_window: 1000000 };
        window.__LEADER_FIXTURE_USAGE__["codex/session-codex-high"] = { input_tokens: 100000, output_tokens: 0, model_context_window: 500000 };
      }}>模拟上下文读数降低至 20%</button>}
      <button className="rounded border p-2" onClick={() => {
        window.__LEADER_FIXTURE__.branches = window.__LEADER_FIXTURE__.branches.map(branch => ({ ...branch, state: branch.state === "reclaimed" ? "reclaimed" : branch.sessionId ? "completed" : "failed", result: branch.result || (branch.sessionId ? "检查完成，记录保留至用户归档或删除。" : "启动失败，任务记录保留供检查。") }));
        void useLeaderStore.getState().refresh();
      }}>完成全部任务，保留记录</button>
      <label><input type="checkbox" onChange={e => { window.__LEADER_FIXTURE_FAIL__ = e.target.checked; }} /> 模拟整组操作失败（保留记录）</label>
      <p className="text-text-tertiary">IPC 为本页 mock；不运行真实模型。</p>
      <ArchivedSessionsSection />
    </main>
    <LeaderManagementHost />
  </div>;
}
createRoot(document.getElementById("fixture")!).render(<Fixture />);
