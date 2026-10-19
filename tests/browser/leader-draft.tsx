// Actual sidebar, menu, composer and store; all native work is mocked below.
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import "../../src/index.css";
import i18n from "../../src/lib/i18n";
import { AiChatSidebar } from "../../src/components/application/ai-chat/ai-chat-sidebar";
import type { ComposerInputHandle } from "../../src/components/application/ai-chat/ai-chat-composer";
import { ChatConversation } from "../../src/features/chat/components/ChatConversation";
import { useChatStore, sessionKey } from "../../src/features/chat/store";
import { handleEngineEvents, type EngineEventDeps } from "../../src/features/chat/store/engine-events";
import { useLeaderStore } from "../../src/features/leader/store";
import { startLeaderRuntime } from "../../src/features/leader/runtime";
import { useAgentStore } from "../../src/features/agents/agent-store";
import { usePromptStore } from "../../src/features/prompts/prompt-store";
import { selectSelectedAgent } from "../../src/features/agents/selected-agent";
import type { EngineInfo, Workspace } from "../../src/lib/ipc";
import type { LeaderSnapshot } from "../../src/features/leader/types";
import { groupLeaderThreads } from "../../src/features/leader/tree";

declare global { interface Window {
  __DRAFT_INVOKE__: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  __DRAFT_SENDS__: { command: string; args: Record<string, unknown> }[];
} }
const params = new URLSearchParams(location.search);
void i18n.changeLanguage(params.get("lang") === "en" ? "en" : "zh");
const workspace: Workspace = { id: "draft-fixture", path: "G:/leader-draft-fixture", name: "native-fixtures", lastOpenedAt: null, sortOrder: null, groupId: null };
const engine = params.get("engine") === "codex" ? "codex" : "claude";
const engines: EngineInfo[] = ["claude", "codex"].map(id => ({ id, available: true, enabled: true, supportsImages: true, supportsComputerUse: true, permissions: ["auto", "manual", "bypass"] }));
const initial = { engine, sessionId: null, workspacePath: workspace.path };
const snapshot: LeaderSnapshot = { leaders: [], branches: [], archivedGroups: [] };
let pendingAgent: (() => void) | null = null;
let failLaunch = false;
window.__DRAFT_SENDS__ = [];
window.__DRAFT_INVOKE__ = async (command, args = {}) => {
  if (command.startsWith("leader_") || command === "send_leader_message") throw new Error("Retired task entry is unavailable");
  if (command === "send_message") {
    window.__DRAFT_SENDS__.push({ command, args });
    if (failLaunch) throw new Error("Fixture: launch rejected, no real process started");
    const id = `native-root-${window.__DRAFT_SENDS__.length}`;
    return { runId: args.runId, sessionId: id };
  }
  if (command === "task_snapshot") return structuredClone(snapshot);
  if (command === "resolve_enabled_built_in_agent") return new Promise(resolve => {
    pendingAgent = () => { pendingAgent = null; resolve({ id: "delayed", name: "Delayed fixture", icon: null, prompt: "Fixture instructions", promptHash: "fixture" }); };
  });
  if (command === "get_cli_config") return {};
  if (command === "claude_quota_read") return { status: "unavailable", windows: {}, errorCode: "fixture" };
  if (command === "list_engines") return engines;
  if (command === "list_engine_models") return { models: [], authoritative: false };
  if (command === "list_sessions") return useChatStore.getState().sessions;
  if (command === "load_session_page") return { messages: [], nextBefore: null, subagentHistory: [] };
  if (command === "prompts_dirs") return { workspace: `${workspace.path}/.ccgui/prompts`, global: "G:/fixture-prompts" };
  if (command === "git_status") return { branch: "fixture", staged: [], unstaged: [], untracked: [], files: [] };
  if (command === "read_file") return { kind: "other" };
  if (command === "import_attachments") return args.paths;
  if (command === "plugin:event|listen") return 1;
  if (/list|catalog|branches|prompts|agent/.test(command)) return [];
  return null;
};
useAgentStore.setState({ agents: [], builtInAgents: [], builtInDivisions: [], loaded: true, refresh: async () => {} });
usePromptStore.setState({ ensure: () => {}, refresh: async () => {} });
useLeaderStore.setState({ snapshot });
useChatStore.setState({ initialized: true, active: initial, openTabs: [initial], activeEngine: engine, workspaces: [workspace], sessions: [], drafts: {}, bySession: {}, engines,
  models: { claude: "opus", codex: "gpt-6.1-sol" }, efforts: { claude: "xhigh", codex: "high" }, providers: {}, permission: "bypass", streamingByKey: {}, retryingByKey: {}, archivedSessionKeys: {}, unseen: {} });

function Fixture() {
  const active = useChatStore(s => s.active);
  const tabs = useChatStore(s => s.openTabs);
  const sessions = useChatStore(s => s.sessions);
  const leaders = useLeaderStore(s => s.snapshot);
  const ref = useRef<ComposerInputHandle | null>(null);
  const [, refreshCount] = useState(0);
  const threads = groupLeaderThreads([
    ...tabs.filter(tab => tab.sessionId === null).map(tab => ({ id: sessionKey(tab.engine, null, tab.workspacePath), label: i18n.t("chat.newChat"), engine: tab.engine, time: "", isDraft: true })),
    ...sessions.map(s => ({ id: `${s.engine}/${s.sessionId}`, label: s.title, engine: s.engine, time: "" })),
  ], leaders, workspace.path);
  const finish = () => {
    const last = window.__DRAFT_SENDS__.at(-1);
    const current = useChatStore.getState().active;
    if (!last || !current?.sessionId) return;
    const deps: EngineEventDeps = { set: useChatStore.setState, get: useChatStore.getState, drainQueue: () => {}, markUnseenIfBackground: () => {}, upsertSessionMeta: () => {} };
    handleEngineEvents([
      { engine: current.engine, sessionId: current.sessionId, runId: String(last.args.runId), seq: 1, kind: "delta", data: "Fixture task finished. The first request used the selected send entry." },
      { engine: current.engine, sessionId: current.sessionId, runId: String(last.args.runId), seq: 2, kind: "done", data: null },
    ], deps);
  };
  return <div className="flex h-screen bg-background-primary-default text-text-primary">
    <AiChatSidebar width={260} repos={[{ id: workspace.id, label: workspace.name, defaultOpen: true, threads }]}
      activeThreadId={active ? active.sessionId ? `${active.engine}/${active.sessionId}` : sessionKey(active.engine, null, active.workspacePath) : undefined}
      onThreadSelect={id => { if (id.startsWith("new:")) useChatStore.getState().focusTab(engine, null, workspace.path); }}
      onThreadAction={(id, action) => { if (id.startsWith("new:") && action === "delete") useChatStore.getState().closeTab(engine, null, workspace.path); }} />
    <main className="flex min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border-button-default p-3 text-caption-1-medium">
        <span>真实组件 / 假 IPC / 不调用模型</span>
        <button onClick={() => useChatStore.getState().startNewChat(workspace.path)}>新建草稿</button>
        <button onClick={() => { selectSelectedAgent(workspace.path, null, { source: "builtIn", id: "delayed", name: "Delayed fixture", icon: "", prompt: "" }); }}>模拟准备延迟</button>
        <button onClick={() => pendingAgent?.()}>结束准备延迟</button>
        <button onClick={() => { failLaunch = !failLaunch; refreshCount(n => n + 1); }}>模拟启动失败：{String(failLaunch)}</button>
        <button onClick={finish}>完成模拟任务</button>
        <span>首发调用数：{window.__DRAFT_SENDS__.length}</span>
        <span>最后入口：{window.__DRAFT_SENDS__.at(-1)?.command ?? "无"}</span>
      </div>
      <ChatConversation active={active} engines={engines} workspaces={[workspace]} startNewChat={useChatStore.getState().startNewChat} composerInputRef={ref} />
    </main>
  </div>;
}
startLeaderRuntime();
createRoot(document.getElementById("fixture")!).render(<HashRouter><Fixture /></HashRouter>);
