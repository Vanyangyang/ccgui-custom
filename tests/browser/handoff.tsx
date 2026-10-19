// Production conversation/composer/card/store, synthetic history and mocked IPC only.
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import "../../src/index.css";
import i18n from "../../src/lib/i18n";
import type { ComposerInputHandle } from "../../src/components/application/ai-chat/ai-chat-composer";
import { ChatConversation } from "../../src/features/chat/components/ChatConversation";
import { useChatStore, sessionKey } from "../../src/features/chat/store";
import { EMPTY_SESSION } from "../../src/features/chat/store/stream";
import { useHandoffStore } from "../../src/features/chat/session-cleanup";
import { useAgentStore } from "../../src/features/agents/agent-store";
import { usePromptStore } from "../../src/features/prompts/prompt-store";
import type { EngineInfo, SessionMeta, Workspace } from "../../src/lib/ipc";

declare global { interface Window {
  __HANDOFF_INVOKE__: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
} }
const params = new URLSearchParams(location.search);
void i18n.changeLanguage(params.get("lang") === "en" ? "en" : "zh");
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const workspace: Workspace = { id: "handoff-fixture", path: "/synthetic-handoff-workspace", name: "Handoff fixture", lastOpenedAt: null, sortOrder: null, groupId: null };
const source: SessionMeta = {
  engine: "claude", sessionId: "synthetic-handoff-source-001", workspacePath: workspace.path,
  filePath: "/synthetic-handoff-workspace/source.jsonl", fileSize: 1, fileMtimeMs: 1,
  title: "🧩 虚构来源｜保留用户补充内容与发送确认边界", customTitle: null,
  preview: "仅供浏览器验证，无真实会话", createdAt: 1, updatedAt: 2, messageCount: 4, pinned: false,
};
const sourceTab = { engine: source.engine, sessionId: source.sessionId, workspacePath: workspace.path };
const sourceKey = sessionKey(source.engine, source.sessionId, workspace.path);
const draftKey = sessionKey(source.engine, null, workspace.path);
const sourceState = { ...EMPTY_SESSION, messages: [
  { seq: 1, role: "user", text: "请修复虚构项目中的草稿保留问题。约束：发送成功后才能归档来源。", ts: null },
  { seq: 2, role: "assistant", text: "已定位草稿切换逻辑，准备验证失败和重试。", ts: null },
  { seq: 3, role: "user", text: "请继续验证中文、emoji 🧩 和窄屏布局。", ts: null },
  { seq: 4, role: "assistant", text: "本地结论：保留原会话及用户补充；仅在启动确认后完成交接。下一步检查失败重试。", ts: null },
] };
const engines: EngineInfo[] = ["claude", "codex", "pi", "cursor", "agy"].map(id => ({ id, available: true, enabled: true, supportsImages: true, supportsComputerUse: false, permissions: ["auto", "manual", "bypass"] }));
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; args: Record<string, unknown> };
const summaries: Pending[] = [];
const sends: Pending[] = [];
const calls: { command: string; args: Record<string, unknown> }[] = [];
let archived = false;
let sendSuccesses = 0;
const notify = () => window.dispatchEvent(new Event("handoff-fixture:change"));
window.__HANDOFF_INVOKE__ = async (command, args = {}) => {
  calls.push({ command, args });
  notify();
  if (command === "summarize_session_handoff" || command === "send_message") {
    return new Promise((resolve, reject) => {
      (command === "send_message" ? sends : summaries).push({ resolve, reject, args });
      notify();
    });
  }
  if (command === "archive_session") { archived = true; notify(); return null; }
  if (command === "restore_session") { archived = false; notify(); return null; }
  if (command === "list_sessions") return archived ? [] : [source];
  if (command === "list_archived_sessions") return archived ? [source] : [];
  if (command === "load_session_page") return { messages: sourceState.messages, nextBefore: null, subagentHistory: [] };
  if (command === "list_engines") return engines;
  if (command === "list_engine_models") return args.engine === "cursor"
    ? { authoritative: true, models: [
      { id: "grok-4.7-low-fast", name: "Grok fixture", provider: "cursor" },
      { id: "fixture-balanced", name: "Balanced fixture model", provider: "cursor" },
    ] }
    : { models: [{ id: args.engine === "claude" ? "opus" : args.engine === "pi" ? "fixture/provider-model" : "fixture-model", name: `${args.engine} fixture model` }], authoritative: true };
  if (command === "get_cli_config") return { claude: { current: "__local_settings_json__", providers: {
    "fixture-relay": { name: "示例供应商", env: { ANTHROPIC_MODEL: "fixture/opus[1m]" } },
  } } };
  if (command === "get_app_settings") return {};
  if (command === "claude_quota_read") return { status: "unavailable", windows: {}, errorCode: "fixture" };
  if (command === "prompts_dirs") return { workspace: "/synthetic/prompts", global: "/synthetic/global-prompts" };
  if (command === "git_status") return { branch: "fixture", staged: [], unstaged: [], untracked: [], files: [] };
  if (command === "read_file") return { kind: "other" };
  if (command === "plugin:event|listen") return 1;
  if (/list|catalog|branches|prompts|agent/.test(command)) return [];
  return null;
};
useAgentStore.setState({ agents: [], builtInAgents: [], builtInDivisions: [], loaded: true, refresh: async () => {} });
usePromptStore.setState({ ensure: () => {}, refresh: async () => {} });
useChatStore.setState({ initialized: true, active: sourceTab, openTabs: [sourceTab], activeEngine: source.engine,
  workspaces: [workspace], sessions: [source], drafts: {}, bySession: { [sourceKey]: sourceState }, engines,
  models: { claude: "opus" }, efforts: { claude: "high" }, providers: {}, permission: "manual",
  streamingByKey: {}, retryingByKey: {}, archivedSessionKeys: {}, unseen: {},
});

function Fixture() {
  const chat = useChatStore();
  const entry = useHandoffStore(s => s.byWorkspace[workspace.path]);
  const ref = useRef<ComposerInputHandle | null>(null);
  const [, refresh] = useState(0);
  const [preview, setPreview] = useState(params.get("width") === "320" && !params.has("embedded"));
  useEffect(() => {
    const onChange = () => refresh(n => n + 1);
    window.addEventListener("handoff-fixture:change", onChange);
    return () => window.removeEventListener("handoff-fixture:change", onChange);
  }, []);
  const settleSummary = (success: boolean) => {
    const pending = summaries.shift();
    if (success) pending?.resolve("模型模拟摘要：保留来源、草稿和用户补充；确认新会话启动后再按选择归档。\n待办：完成窄屏与失败重试验证。");
    else pending?.reject(new Error("Mocked IPC: model summary failed; retry is available."));
    notify();
  };
  const settleSend = (success: boolean) => {
    const pending = sends.shift();
    if (success && pending) pending.resolve({ runId: pending.args.runId, sessionId: `synthetic-handoff-target-${++sendSuccesses}` });
    else pending?.reject(new Error("Mocked IPC: send rejected before native launch."));
    notify();
  };
  const readout = {
    activeSession: chat.active?.sessionId ?? "draft", sourceArchived: Boolean(chat.archivedSessionKeys[sourceKey]),
    mockArchive: archived, sourceVisible: chat.sessions.some(s => s.sessionId === source.sessionId),
    mode: entry?.mode ?? null, grokStatus: entry?.grokStatus ?? null, sending: entry?.sending ?? false,
    compressionModel: entry?.compressionModel ?? null,
    compressionSelection: entry?.compressionSelection ?? null,
    destinationModels: chat.models,
    archiveSourceOnSend: entry?.archiveSourceOnSend ?? null, handoffPresent: Boolean(entry),
    pendingSummaries: summaries.length, pendingSends: sends.length,
    summaryCalls: calls.filter(c => c.command === "summarize_session_handoff").length,
    lastSummary: calls.filter(c => c.command === "summarize_session_handoff").at(-1)?.args ?? null,
    sendCalls: calls.filter(c => c.command === "send_message").length,
    archiveCalls: calls.filter(c => c.command === "archive_session").length,
    restoreCalls: calls.filter(c => c.command === "restore_session").length,
    lastSend: calls.filter(c => c.command === "send_message").at(-1)?.args ?? null,
  };
  const previewParams = new URLSearchParams(location.search);
  previewParams.delete("width"); previewParams.set("embedded", "1");
  return <main className="flex h-dvh min-w-0 flex-col bg-background-primary-default text-text-primary">
    <style>{`.fixture-controls{display:flex;flex-wrap:wrap;gap:8px;padding:8px;font-size:12px;border-bottom:1px solid #8885}.fixture-controls button{border:1px solid #8888;border-radius:5px;padding:4px 8px}.fixture-controls button:disabled{opacity:.4}.fixture-readout{max-height:180px;overflow:auto;font-size:11px;padding:8px;border-top:1px solid #8885}.fixture-readout pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0}`}</style>
    <header className="fixture-controls">
      <strong>真实组件 · mocked IPC · 无真实模型/存储</strong>
      <span>在来源输入 /handoff 后发送；再编辑交接草稿。</span>
      <button onClick={() => { useChatStore.getState().setDraft(sourceKey, "/handoff 继续验证，并保留用户附加内容 🧩"); ref.current?.focus(); }}>填入 /handoff（仍需发送）</button>
      <button disabled={!summaries.length} onClick={() => settleSummary(true)}>压缩模拟完成</button>
      <button disabled={!summaries.length} onClick={() => settleSummary(false)}>压缩模拟失败</button>
      <button disabled={!sends.length} onClick={() => settleSend(true)}>确认发送成功</button>
      <button disabled={!sends.length} onClick={() => settleSend(false)}>确认发送失败</button>
      <button onClick={() => void useChatStore.getState().selectSession(source.engine, source.sessionId, workspace.path)}>查看来源</button>
      <button onClick={() => useChatStore.getState().focusTab(source.engine, null, workspace.path)}>返回草稿</button>
      <button disabled={!archived} onClick={() => void useChatStore.getState().restoreSession(source)}>恢复原会话</button>
      {!params.has("embedded") && <button onClick={() => setPreview(v => !v)}>320 px 独立预览</button>}
    </header>
    {preview ? <iframe title="320 px isolated handoff fixture" src={`./handoff.html?${previewParams}`} style={{ width: 320, maxWidth: "100%", flex: 1, minHeight: 0, alignSelf: "center", border: "1px solid #888" }} /> : <>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ChatConversation active={chat.active} engines={engines} workspaces={[workspace]} startNewChat={chat.startNewChat} composerInputRef={ref} />
      </section>
      <details className="fixture-readout" open>
        <summary>只读状态 / 实际草稿 / 最后发送内容</summary>
        <pre id="handoff-state">{JSON.stringify(readout, null, 2)}</pre>
        <strong>实际草稿</strong><pre id="handoff-draft">{chat.drafts[draftKey] ?? ""}</pre>
      </details>
    </>}
  </main>;
}
createRoot(document.getElementById("fixture")!).render(<HashRouter><Fixture /></HashRouter>);
