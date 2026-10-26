import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiChatSidebar } from "@/components/application/ai-chat/ai-chat-sidebar";
import { ThreadContextMenu } from "@/components/application/ai-chat/thread-context-menu";
import type { ComposerInputHandle } from "@/components/application/ai-chat/ai-chat-composer";
import { useChatSidebar } from "@/features/chat/use-chat-sidebar";
import { sessionKey, useChatStore } from "@/features/chat/store";
import { handleEngineEvents, settledRuns, upsertSessionMetaInto } from "@/features/chat/store/engine-events";
import { EMPTY_SESSION, runRouting } from "@/features/chat/store/stream";
import { ipc, type ResolvedBuiltInAgent, type SendResult, type Workspace } from "@/lib/ipc";
import { invoke } from "@/lib/transport";
import { getSelectedAgent } from "@/features/agents/selected-agent";
import { useLeaderStore } from "./store";
import { useProjectsStore } from "@/features/projects/store";

const runtime = vi.hoisted(() => ({ web: false }));
vi.mock("@/lib/transport", () => ({ get isWeb() { return runtime.web; }, invoke: vi.fn(), listen: vi.fn(async () => () => {}), webToken: null }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }), initReactI18next: { type: "3rdParty", init: () => {} } }));
vi.mock("@/features/agents/selected-agent", () => ({ getSelectedAgent: vi.fn(), clearSelectedAgent: vi.fn(), migrateSelectedAgent: vi.fn() }));

const workspace: Workspace = { id: "ws", path: "G:/draft", name: "Draft workspace", lastOpenedAt: null, sortOrder: null, groupId: null };
const tab = { engine: "claude", sessionId: null, workspacePath: workspace.path };
const key = sessionKey(tab.engine, null, tab.workspacePath);
let node: HTMLDivElement, root: Root;
function menu() { return <ThreadContextMenu menu={{ x: 0, y: 0, threadId: key }} onClose={() => {}} onThreadAction={() => {}} />; }
function mode() { return [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "leader.enable" || b.textContent === "leader.disable"); }
function Sidebar() {
  const sidebar = useChatSidebar({ sessionById: new Map(), threadStreaming: [], threadRetrying: [], collapseSidebarOnMobile: () => {},
    composerInputRef: createRef<ComposerInputHandle>(), setDialog: () => {} });
  return <AiChatSidebar repos={sidebar.repos} />;
}
function events() { return { set: useChatStore.setState, get: useChatStore.getState, drainQueue: () => {}, markUnseenIfBackground: () => {}, upsertSessionMeta: (meta: Parameters<typeof upsertSessionMetaInto>[1]) => upsertSessionMetaInto(useChatStore.setState, meta) }; }
function state() { return useChatStore.getState(); }
function nativeSends() { return vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "send_message" || cmd === "send_leader_message"); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  runtime.web = false; vi.clearAllMocks(); localStorage.clear(); runRouting.clear(); settledRuns.clear();
  vi.mocked(getSelectedAgent).mockReturnValue(null);
  vi.mocked(invoke).mockImplementation(async (command, args) => command === "send_message"
    ? { runId: args!.runId, sessionId: null } : command === "task_snapshot" ? { leaders: [], branches: [] }
    : command === "list_workspace_projects" ? []
    : command === "load_session_page" ? { messages: [], subagentHistory: [], nextBefore: null } : undefined);
  useLeaderStore.setState({ snapshot: { leaders: [], branches: [] }, error: null, busy: false, managing: null });
  useProjectsStore.setState({ projects: [], loaded: false, error: null });
  useChatStore.setState({ initialized: true, workspaces: [workspace], sessions: [], active: tab, openTabs: [tab], activeEngine: "claude",
    bySession: {}, streamingByKey: {}, retryingByKey: {}, drafts: {}, unseen: {}, archivedSessionKeys: {}, workspaceGroups: [], workspaceAliases: {}, archivedWorkspaces: [],
    engines: [{ id: "claude", available: true, enabled: true, supportsImages: true, supportsComputerUse: true, permissions: ["manual", "bypass"] }],
    models: { claude: "default-model" }, efforts: { claude: "low" }, providers: { claude: "default-provider" }, permission: "manual" });
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); });

describe("ordinary drafts after retiring Leader mode", () => {
  it.each([false, true])("has no mode switch or badge, even with stale draft intent (web=%s)", async (web) => {
    runtime.web = web;
    const legacyDraft = { ...EMPTY_SESSION, leaderOnStart: true };
    useChatStore.setState({ bySession: { [key]: legacyDraft } });
    await act(async () => root.render(<>{menu()}<Sidebar /></>));
    expect(mode()).toBeUndefined();
    expect(node.textContent).not.toContain("leader.badge");
    expect(document.body.querySelector('[role="menu"]')?.textContent).toContain("chat.deleteSession");
    await act(async () => state().send("task", []));
    expect(nativeSends()).toHaveLength(1);
    expect(nativeSends()[0][0]).toBe("send_message");
    expect(nativeSends()[0][1]).not.toHaveProperty("leaderOnStart");
    expect(invoke).not.toHaveBeenCalledWith("leader_set_mode", expect.anything());
  });

  it.each(["claude", "codex", "agy"])("sends the first %s task normally with settings, images and queued-input adoption", async (engine) => {
    const selected = { ...tab, engine, model: "picked-model", effort: "xhigh" as const, provider: "picked-provider" };
    const expectedEffort = engine === "agy" ? "high" : "xhigh";
    const draftKey = sessionKey(engine, null, workspace.path);
    useChatStore.setState({ active: selected, openTabs: [selected], activeEngine: engine, drafts: { [draftKey]: "unsent next text" },
      engines: [{ id: engine, available: true, enabled: true, supportsImages: true, supportsComputerUse: true, permissions: ["bypass"] }], permission: "bypass" });
    const launch = deferred<SendResult>();
    vi.mocked(invoke).mockImplementation(async (cmd) => cmd === "send_message" ? launch.promise
      : cmd === "load_session_page" ? { messages: [], subagentHistory: [], nextBefore: null } : undefined);
    const sending = state().send("任务 中文 🚀", ["image.png"], { computerUse: true });
    expect(nativeSends()).toHaveLength(1);
    const [command, payload] = nativeSends()[0];
    expect(command).toBe("send_message");
    expect(payload).toMatchObject({ sessionId: null, engine, workspacePath: workspace.path, prompt: "任务 中文 🚀", imagePaths: ["image.png"], model: "picked-model", effort: expectedEffort, providerId: "picked-provider", permission: "bypass", computerUse: true });
    state().queueMessage("next", ["next.png"]);
    const queued = state().bySession[draftKey].queue;
    launch.resolve({ runId: payload!.runId as string, sessionId: "actual" }); await sending;
    const actual = state().bySession[`${engine}/actual`];
    expect(actual).toMatchObject({ activeModel: "picked-model", activeEffort: expectedEffort, activeProvider: "picked-provider", queue: queued });
    expect(actual.messages).toMatchObject([{ text: "任务 中文 🚀", images: ["image.png"] }]);
    expect(actual.draftLaunching).toBeUndefined();
    expect(state().bySession[draftKey]).toBeUndefined();
    expect(state().drafts[`${engine}/actual`]).toBe("unsent next text");
    expect(state().active).toMatchObject({ engine, sessionId: "actual", model: "picked-model" });
    expect(nativeSends()).toHaveLength(1);
  });

  it("adopts an early native session event without replay while invoke is pending", async () => {
    const launch = deferred<SendResult>(); vi.mocked(invoke).mockImplementation(async (cmd) => cmd === "send_message" ? launch.promise : undefined);
    const sending = state().send("first task", []); const payload = nativeSends()[0][1]!;
    state().queueMessage("queued", []);
    handleEngineEvents([{ engine: "claude", sessionId: "native", runId: payload.runId as string, seq: 1, kind: "session", data: "native" }], events());
    expect(state().active?.sessionId).toBe("native");
    expect(state().bySession["claude/native"].queue).toHaveLength(1);
    launch.resolve({ runId: payload.runId as string, sessionId: null }); await sending;
    expect(nativeSends()).toHaveLength(1);
    expect(state().bySession["claude/native"].messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalledWith("leader_set_mode", expect.anything());
  });

  it("surfaces ordinary launch failure and permits an explicit retry", async () => {
    vi.mocked(invoke).mockImplementation(async (cmd) => { if (cmd === "send_message") throw new Error("launch rejected"); });
    await state().send("task", []);
    expect(state().bySession[key]).toMatchObject({ streaming: false, error: "Error: launch rejected" });
    expect(state().bySession[key].draftLaunching).toBeUndefined();
    await state().send("task retry", []);
    expect(nativeSends().map(([cmd]) => cmd)).toEqual(["send_message", "send_message"]);
  });

  it.each(["stop", "close"])("cancels ordinary preparation on %s and allows retry", async (action) => {
    vi.mocked(getSelectedAgent).mockReturnValue({ source: "builtIn", id: "agent", name: "Agent", icon: "", prompt: "" });
    const agent = deferred<ResolvedBuiltInAgent>();
    vi.spyOn(ipc, "resolveEnabledBuiltInAgent").mockReturnValueOnce(agent.promise);
    const sending = state().send("prepared task", []);
    expect(state().bySession[key].draftLaunching).toBeTruthy();
    if (action === "stop") await state().interrupt();
    else { state().closeTab("claude", null, workspace.path); state().startNewChat(workspace.path); }
    agent.resolve({ id: "agent", name: "Agent", prompt: "Instructions", icon: null, promptHash: "hash" }); await sending;
    expect(nativeSends()).toHaveLength(0);
    vi.mocked(getSelectedAgent).mockReturnValue(null);
    await state().send("retry task", []);
    expect(nativeSends().map(([cmd]) => cmd)).toEqual(["send_message"]);
  });

  it("does not replay overlapping sends or let late preparation mutate a reopened draft", async () => {
    vi.mocked(getSelectedAgent).mockReturnValue({ source: "builtIn", id: "agent", name: "Agent", icon: "", prompt: "" });
    const agent = deferred<ResolvedBuiltInAgent>();
    vi.spyOn(ipc, "resolveEnabledBuiltInAgent").mockReturnValueOnce(agent.promise);
    const oldSend = state().send("old task", []);
    await state().send("overlap", []); expect(nativeSends()).toHaveLength(0);
    state().closeTab("claude", null, workspace.path); state().startNewChat(workspace.path);
    vi.mocked(getSelectedAgent).mockReturnValue(null);
    const launch = deferred<SendResult>(); vi.mocked(invoke).mockImplementation(async (cmd) => cmd === "send_message" ? launch.promise : undefined);
    const newSend = state().send("new task", []); const marker = state().bySession[key].draftLaunching;
    agent.resolve({ id: "agent", name: "Agent", prompt: "Instructions", icon: null, promptHash: "hash" }); await oldSend;
    expect(nativeSends()).toHaveLength(1); expect(nativeSends()[0][1]?.prompt).toBe("new task");
    expect(state().bySession[key].draftLaunching).toBe(marker);
    launch.resolve({ runId: nativeSends()[0][1]!.runId as string, sessionId: null }); await newSend;
  });
});
