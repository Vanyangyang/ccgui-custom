import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStore } from "@/features/chat/store/types";
import { HostChatBusyError } from "@/features/chat/store/types";
import { matchesHostTaskSelection } from "@/features/chat/store/host-task-selection";
import { EMPTY_SESSION, runRouting } from "@/features/chat/store/stream";
import { hostPendingKey } from "@/features/chat/store/host-pending-chat";
import { sessionKey } from "@/features/chat/store/persistence";
import { settledRunOutcomes } from "@/features/chat/store/engine-events";
import { desktopTaskFacade, plausibleSessionId, TaskPreSpawnError } from "./task-facade";
import { useChatStore } from "@/features/chat/store";
import { useLeaderStore } from "@/features/leader/store";
import { clearAllComposerPredictions, getComposerPredictionSnapshot, setComposerPrediction, setComposerPredictionEnabled } from "@/features/chat/composer-prediction";
import { createTaskConversationBridge } from "./task-conversation-bridge";
import { resolveLaunchSettings } from "@/features/chat/store/live-follow-up";
import { ipc } from "@/lib/ipc";
import { useSidechatStore } from "@/features/sidechat/store";
import { getConversationModeState } from "@/features/plugins/conversation/state";
import { createTabActions } from "@/features/chat/store/tabs";
import { createHostTaskBridge } from "./task-bridge";
import { createMessagingActions } from "@/features/chat/store/messaging";
import { createSessionActions } from "@/features/chat/store/sessions";

const desktop = vi.hoisted(() => ({ state: {} as ChatStore, invoke: vi.fn(), window: { unminimize: vi.fn(async () => {}), show: vi.fn(async () => {}), setFocus: vi.fn(async () => {}) } }));
vi.mock("@/lib/transport", () => ({ isWeb: false, invoke: desktop.invoke, listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => desktop.window }));
vi.mock("@/lib/ipc", () => ({ ipc: {
  sendMessage: vi.fn(), sendFollowUp: vi.fn(), rememberSessionModel: vi.fn(async () => {}),
  rememberSessionEffort: vi.fn(async () => {}), rememberSessionProvider: vi.fn(async () => {}),
  loadSessionPage: vi.fn(), listEngineModels: vi.fn(), summarizeSessionHandoff: vi.fn(),
  listPlanReviews: vi.fn(async () => []),
  importAttachments: vi.fn(async (paths: string[]) => paths), readFile: vi.fn(async () => ({ kind: "other" })),
  taskSessionLifecycle: vi.fn(async () => { throw new Error("Lifecycle probe unavailable in fixture"); }),
} }));

const S1 = "11111111-1111-1111-1111-111111111111";
const ref = { engine: "claude", sessionId: S1, workspacePath: "G:/game" };
const key = sessionKey("claude", S1, "G:/game");
const draft = { engine: "claude", sessionId: null, workspacePath: "G:/game" };
const draftKey = sessionKey("claude", null, "G:/game");

function state(extra: Record<string, unknown> = {}) {
  desktop.state = {
    ...useChatStore.getInitialState(),
    initialized: true, archivedSessionKeys: {}, archivedWorkspaces: ["w2"], activeEngine: "claude",
    engines: [{ id: "claude", available: true, enabled: true }], models: { claude: "opus" }, efforts: { claude: "high" },
    workspaces: [{ id: "w1", path: "G:/game", name: "game" }, { id: "w2", path: "G:/old", name: "old" }, { id: "w3", path: "/wsl", name: "wsl", meta: { wsl: {} } }],
    sessions: [{ ...ref, remote: false }], openTabs: [ref], active: null,
    drafts: {}, streamingByKey: {}, retryingByKey: {},
    bySession: { [key]: { ...EMPTY_SESSION, messages: [], queue: [] } },
    send: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), selectSession: vi.fn(async () => {}), focusTab: vi.fn(),
    prepareImmediateFollowUp: vi.fn(async () => {}),
    openBackgroundDraft: vi.fn(() => true),
    ...extra,
  } as unknown as ChatStore;
  useChatStore.setState(desktop.state, true);
}
beforeEach(() => { runRouting.clear(); settledRunOutcomes.clear(); desktop.invoke.mockReset().mockResolvedValue(null);
  vi.mocked(ipc.taskSessionLifecycle).mockReset().mockRejectedValue(new Error("Lifecycle probe unavailable in fixture")); state(); });
beforeAll(async () => { state(); await desktopTaskFacade(); }, 15000);

describe("reclaimed timeline readiness", () => {
  it("keeps a failed empty-shell restore unavailable and retries before background continuation", async () => {
    state({ bySession: { [key]: { ...EMPTY_SESSION, messages: [], subagentHistory: [], historyReloadRequired: true } } });
    const messages = [{ seq: 1, role: "assistant", text: "完整历史😀", ts: null }];
    const read = vi.fn(async () => ({ messages, subagentHistory: [], nextBefore: null })).mockRejectedValueOnce(new Error("history temporarily unavailable"));
    const teardowns: Array<() => void> = [];
    useChatStore.setState(createSessionActions({ get: useChatStore.getState, set: useChatStore.setState, subscribe: useChatStore.subscribe,
      loadHistoryPage: read, eventTeardowns: teardowns, activateTab: vi.fn(), removeTab: vi.fn(), forgetClosedTab: vi.fn(), drainQueue: vi.fn(), markUnseenIfBackground: vi.fn() }));
    const facade = await desktopTaskFacade();
    try {
      await expect(facade.openBackground(ref)).rejects.toThrow("temporarily unavailable");
      expect(useChatStore.getState().bySession[key]).toMatchObject({ loading: false, historyReloadRequired: true, messages: [] });
      expect(facade.inspect(ref)).toBeNull();
      expect(facade.conversationState!(ref)).toBeNull();
      expect(facade.conversationLaunch!(ref)).toBeNull();
      expect(facade.idleForContinuation!(ref)).toBe(false);
      await expect(facade.sendExisting(ref, "must wait", "restore-blocked")).rejects.toBeInstanceOf(TaskPreSpawnError);
      expect(desktop.state.send).not.toHaveBeenCalled();
      await facade.openBackground(ref);
      expect(read).toHaveBeenCalledTimes(2);
      expect(facade.inspect(ref)).toBe("idle");
      expect(facade.conversationState!(ref)?.messages).toEqual(messages);
      expect(useChatStore.getState().bySession[key].historyReloadRequired).toBeUndefined();
    } finally { teardowns.forEach(off => off()); }
  });
  it("does not block a nonempty legacy refresh as an unloaded shell", async () => {
    const messages = [{ seq: 1, role: "assistant", text: "visible native content", ts: null }];
    state({ bySession: { [key]: { ...EMPTY_SESSION, messages, historyReloadRequired: true } } });
    const facade = await desktopTaskFacade();
    expect(facade.inspect(ref)).toBe("idle");
    expect(facade.conversationState!(ref)?.messages).toBe(messages);
    expect(facade.idleForContinuation!(ref)).toBe(true);
  });
});

describe("existing native coordinator attachment", () => {
  afterEach(() => { vi.mocked(ipc.sendMessage).mockReset(); vi.mocked(ipc.sendFollowUp).mockReset(); });
  async function mount() {
    const facade = await desktopTaskFacade(), saved = new Map<string, unknown>();
    const bridge = createHostTaskBridge("native-attachment-fixture", {
      get: async (_id, k) => structuredClone(saved.get(k) ?? null), set: async (_id, k, v) => { saved.set(k, structuredClone(v)); },
      delete: async (_id, k) => { saved.delete(k); },
    }, { facade: async () => ({ ...facade, leaderBranches: async () => [], projects: async () => [{ id: "project", name: "Game", defaultPath: ref.workspacePath, sourcePluginId: null,
        members: [{ id: "root", path: ref.workspacePath, label: "Game", role: "development", status: "available" }] }] }),
      attachmentCapabilities: async () => ({ version: 1, exclusiveSessionReservations: true }),
      invoke: async () => { throw new Error("Unexpected native call"); }, paused: () => false, whenResumed: async () => {}, registerBlocker: () => () => {} });
    return bridge;
  }
  const request = { requestId: "existing", taskId: "topic", projectId: "project", slotKey: "coordinator", session: ref, writePaths: [] };
  it.each(["idle", "busy", "awaiting_permission"] as const)("attaches a real %s store timeline without sendMessage or draft mutation", async status => {
    const messages = [{ seq: 1, role: "user", text: "原提示词😀", ts: null },
      ...(status === "awaiting_permission" ? [{ seq: 2, role: "assistant", text: "approval", ts: null, question: { id: "approval", status: "pending" } }] : [])];
    const nativeTab = { ...ref, model: "original-model", effort: "medium" as const, provider: "original-channel" };
    const drafts = { [draftKey]: "用户草稿，不能重发" };
    state({ active: draft, openTabs: [nativeTab, draft], drafts, models: { claude: "different-global-default" }, permission: "manual",
      bySession: { [key]: { ...EMPTY_SESSION, messages, activeEffort: "medium", activeProvider: "original-channel", streaming: status !== "idle", nativeTaskRunId: status === "idle" ? undefined : "original-run" }, [draftKey]: { ...EMPTY_SESSION } } });
    if (status !== "idle") runRouting.set("original-run", key);
    vi.mocked(ipc.sendMessage).mockClear(); vi.mocked(ipc.sendFollowUp).mockClear();
    vi.mocked(ipc.taskSessionLifecycle).mockResolvedValue({ ...ref, archived: false, idle: status === "idle" });
    vi.mocked(ipc.taskSessionLifecycle).mockImplementationOnce(async () => {
      useChatStore.setState(s => ({ sessions: s.sessions.map(meta => ({ ...meta, preview: "原生输出刷新🙂", updatedAt: 56789 })) }));
      return { ...ref, archived: false, idle: status === "idle" };
    });
    const bridge = await mount();
    try {
      expect(await bridge.attachConversation(request)).toMatchObject({ status: "attached", runId: null, session: ref });
      const snapshot = await bridge.conversation("existing");
      expect(snapshot.messages).toEqual(messages); expect(snapshot.nativeStatus).toBe(status);
      expect(snapshot.selection).toMatchObject({ model: "original-model", effort: "medium", providerId: "original-channel" });
      expect(ipc.sendMessage).not.toHaveBeenCalled(); expect(ipc.sendFollowUp).not.toHaveBeenCalled();
      expect(useChatStore.getState().active).toBe(draft); expect(useChatStore.getState().drafts).toBe(drafts);
      expect(useChatStore.getState().permission).toBe("manual"); expect(useChatStore.getState().openTabs[0]).toBe(nativeTab);
    } finally { bridge.dispose(); }
  });
  it("sends a later new prompt through native messaging to exactly the original session", async () => {
    const nativeTab = { ...ref, model: "native-model", effort: "medium" as const, provider: "native-provider" };
    state({ active: draft, openTabs: [nativeTab, draft], permission: "manual", refreshSessionUsage: vi.fn(async () => {}),
      bySession: { [key]: { ...EMPTY_SESSION, activeEffort: "medium", activeProvider: "native-provider", messages: [{ seq: 1, role: "user", text: "original prompt", ts: null }] }, [draftKey]: { ...EMPTY_SESSION } } });
    useChatStore.setState(createMessagingActions({ get: useChatStore.getState, set: useChatStore.setState, subscribe: useChatStore.subscribe, loadHistoryPage: vi.fn() }));
    useChatStore.setState({ refreshSessionUsage: vi.fn(async () => {}) });
    vi.mocked(ipc.taskSessionLifecycle).mockResolvedValue({ ...ref, archived: false, idle: true });
    vi.mocked(ipc.sendMessage).mockReset().mockImplementation(async input => ({ runId: input.runId!, sessionId: S1 }));
    const bridge = await mount();
    try {
      await bridge.attachConversation(request); expect(ipc.sendMessage).not.toHaveBeenCalled();
      const snapshot = await bridge.conversation("existing");
      await bridge.sendMessage({ conversationRequestId: "existing", requestId: "explicit-next", expectedInputRevision: snapshot.inputRevision, prompt: "new explicit input" });
      await vi.waitFor(() => expect(ipc.sendMessage).toHaveBeenCalledOnce());
      await vi.waitFor(async () => expect(await bridge.messageReceipt("existing", "explicit-next")).toMatchObject({ status: "received", sessionRef: ref }));
      expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: S1, workspacePath: ref.workspacePath, prompt: "new explicit input", model: "native-model", effort: "medium", providerId: "native-provider", permission: "manual" }));
      expect(useChatStore.getState().active).toBe(draft);
    } finally { bridge.dispose(); }
  });
  it.each(["agy", "cursor"])("projects and stops the original %s throughput run", async engine => {
    const target = { ...ref, engine }, targetKey = sessionKey(engine, S1, ref.workspacePath);
    state({ engines: [{ id: engine, available: true, enabled: true }], sessions: [target], openTabs: [target],
      bySession: { [targetKey]: { ...EMPTY_SESSION, streaming: true, throughput: { runId: "throughput-run", seq: 1, ended: false, sample: null } } } });
    runRouting.set("throughput-run", targetKey);
    const facade = await desktopTaskFacade();
    expect(facade.conversationState!(target)).toMatchObject({ runId: "throughput-run", status: "busy" });
    expect(await facade.interrupt("throughput-run")).toBe(true);
    expect(desktop.state.interrupt).toHaveBeenCalledWith(target);
    expect(await facade.interrupt("unrelated-run")).toBe(false);
  });
  it("does not present a finished throughput sample as an active run to stop", async () => {
    state({ bySession: { [key]: { ...EMPTY_SESSION, throughput: { runId: "finished-throughput-run", seq: 3, ended: true, sample: null } } } });
    const facade = await desktopTaskFacade();
    expect(facade.conversationState!(ref)).toMatchObject({ runId: null, status: "idle" });
  });
  it("allows streaming text to advance during attachment identity verification", async () => {
    state({ bySession: { [key]: { ...EMPTY_SESSION, streaming: true, nativeTaskRunId: "original-run" } } });
    const gate = Promise.withResolvers<Awaited<ReturnType<typeof ipc.taskSessionLifecycle>>>();
    vi.mocked(ipc.taskSessionLifecycle).mockReturnValueOnce(gate.promise);
    const facade = await desktopTaskFacade(), pending = facade.observeLifecycle!(ref, { forAttachment: true });
    await Promise.resolve();
    useChatStore.setState(s => ({ bySession: { ...s.bySession, [key]: { ...s.bySession[key], messages: [{ seq: 1, role: "assistant", text: "streaming update", ts: null }] } } }));
    gate.resolve({ ...ref, archived: false, idle: false });
    expect((await pending)?.isCurrent()).toBe(true);
  });
  it.each(["session-copy", "session-preview", "tab-copy", "path-spelling"])("allows %s refresh during a live attachment without changing native identity", async change => {
    const target = { ...ref, engine: "agy" }, targetKey = sessionKey("agy", S1, ref.workspacePath);
    state({ engines: [{ id: "agy", available: true, enabled: true }], sessions: [target], openTabs: [target],
      bySession: { [targetKey]: { ...EMPTY_SESSION, streaming: true, throughput: { runId: "active-agy", ended: false } } } });
    runRouting.set("active-agy", targetKey);
    const gate = Promise.withResolvers<Awaited<ReturnType<typeof ipc.taskSessionLifecycle>>>();
    vi.mocked(ipc.taskSessionLifecycle).mockReturnValueOnce(gate.promise);
    const facade = await desktopTaskFacade(), observing = facade.observeLifecycle!(target, { forAttachment: true });
    await Promise.resolve();
    useChatStore.setState(s => ({
      sessions: change === "tab-copy" ? s.sessions : s.sessions.map(meta => ({ ...meta,
        ...(change === "session-preview" ? { title: "new title", preview: "正在输出🙂", updatedAt: 12345 } : {}),
        ...(change === "path-spelling" ? { workspacePath: "g:\\game\\" } : {}) })),
      openTabs: change === "tab-copy" ? s.openTabs.map(tab => ({ ...tab })) : s.openTabs,
    }));
    gate.resolve({ ...target, archived: false, idle: false });
    const observed = await observing;
    expect(observed?.isCurrent()).toBe(true);
    useChatStore.setState(s => ({ sessions: s.sessions.map(meta => ({ ...meta, updatedAt: 23456 })) }));
    expect(observed?.isCurrent()).toBe(true);
    expect(ipc.sendMessage).not.toHaveBeenCalled();
  });
  it.each(["workspace", "remote", "tab-workspace", "run", "archive", "parent"])("still rejects live attachment after a real %s change", async change => {
    state({ bySession: { [key]: { ...EMPTY_SESSION, streaming: true, nativeTaskRunId: "original-run" } } });
    runRouting.set("original-run", key);
    const previousLeader = useLeaderStore.getState();
    const gate = Promise.withResolvers<Awaited<ReturnType<typeof ipc.taskSessionLifecycle>>>();
    vi.mocked(ipc.taskSessionLifecycle).mockReturnValueOnce(gate.promise);
    const facade = await desktopTaskFacade(), observing = facade.observeLifecycle!(ref, { forAttachment: true });
    await Promise.resolve();
    if (change === "workspace") useChatStore.setState(s => ({ sessions: s.sessions.map(meta => ({ ...meta, workspacePath: "G:/another" })) }));
    if (change === "remote") useChatStore.setState(s => ({ sessions: s.sessions.map(meta => ({ ...meta, remote: true })) }));
    if (change === "tab-workspace") useChatStore.setState({ openTabs: [{ ...ref, workspacePath: "G:/another" }] });
    if (change === "run") useChatStore.setState(s => ({ bySession: { ...s.bySession, [key]: { ...s.bySession[key], nativeTaskRunId: "successor" } } }));
    if (change === "archive") useChatStore.setState({ archivedSessionKeys: { [key]: true } });
    if (change === "parent") useLeaderStore.setState({ snapshot: { ...previousLeader.snapshot, branches: [...previousLeader.snapshot.branches,
      { id: "new-parent-link", parentEngine: "codex", parentSessionId: "parent", engine: ref.engine, sessionId: ref.sessionId, workspacePath: ref.workspacePath, state: "running" } as never] } });
    gate.resolve({ ...ref, archived: false, idle: false });
    try { await expect(observing).rejects.toThrow("SOURCE_CHANGED_DURING_CHECK"); }
    finally { useLeaderStore.setState(previousLeader, true); }
  });
  it("reports a native workspace mismatch without leaking arbitrary native error content", async () => {
    const facade = await desktopTaskFacade();
    vi.mocked(ipc.taskSessionLifecycle).mockRejectedValueOnce("Task lifecycle workspace is missing or ambiguous");
    await expect(facade.observeLifecycle!(ref, { forAttachment: true })).rejects.toThrow("NATIVE_WORKSPACE_MISMATCH");
    vi.mocked(ipc.taskSessionLifecycle).mockRejectedValueOnce("private native detail");
    await expect(facade.observeLifecycle!(ref, { forAttachment: true })).rejects.toThrow("NATIVE_QUERY_FAILED");
    vi.mocked(ipc.taskSessionLifecycle).mockRejectedValueOnce("private native detail");
    expect(await facade.observeLifecycle!(ref)).toBeNull();
  });
});

describe("independent native coordinator startup", () => {
  it("binds one new native chat while preserving a focused user draft, images, sidechat and mode", async () => {
    const sides = useSidechatStore.getState(), modes = getConversationModeState(), modeSnapshot = modes.captureCheckpoint();
    const { act, createElement } = await import("react"), { createRoot } = await import("react-dom/client");
    const { useComposerImages, hasComposerImageDraft } = await import("@/features/chat/components/use-composer-images");
    const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const priorAct = reactGlobal.IS_REACT_ACT_ENVIRONMENT; reactGlobal.IS_REACT_ACT_ENVIRONMENT = true;
    let images!: ReturnType<typeof useComposerImages>;
    function ImageOwner() { images = useComposerImages(draftKey); return null; }
    const imageRoot = createRoot(document.createElement("div"));
    const userTab = { ...draft, model: "user-model", effort: "high" as const, provider: "user-channel" };
    const original = { ...EMPTY_SESSION, messages: [], queue: [], activeModel: "user-model" };
    const drafts = { [draftKey]: "承接上一会话：必须保留的旧续接稿🙂" };
    state({ active: userTab, openTabs: [userTab], drafts, bySession: { [draftKey]: original }, sessions: [], permission: "manual",
      refreshSessionUsage: vi.fn(async () => {}) });
    useChatStore.setState(createTabActions({ get: useChatStore.getState, set: useChatStore.setState }));
    useChatStore.setState(createMessagingActions({ get: useChatStore.getState, set: useChatStore.setState, subscribe: useChatStore.subscribe, loadHistoryPage: vi.fn() }));
    const modeIdentity = modes.identity(draftKey, "G:/game", true); modes.select(modeIdentity, "private-mode", false, 0);
    const retainedMode = modes.captureCheckpoint();
    const side = { draft: "private aside" }; useSidechatStore.setState({ sidechatBySession: { [draftKey]: side } as never });
    await act(async () => { imageRoot.render(createElement(ImageOwner)); });
    await act(async () => { images.importImageFiles(["/fixture/user-private.png"], true); });
    const storedImages = images.images;
    const facade = await desktopTaskFacade();
    vi.mocked(ipc.sendMessage).mockImplementationOnce(async input => ({ runId: input.runId!, sessionId: S1 }));
    const saved = new Map<string, unknown>();
    const bridge = createHostTaskBridge("isolated-fixture", {
      get: async (_id, k) => structuredClone(saved.get(k) ?? null), set: async (_id, k, value) => { saved.set(k, structuredClone(value)); },
      delete: async (_id, k) => { saved.delete(k); },
    }, { facade: async () => ({ ...facade, leaderBranches: async () => [] }), invoke: async () => { throw new Error("Unexpected native call"); },
      paused: () => false, whenResumed: async () => {}, registerBlocker: () => () => {} });
    try {
      const request = { requestId: "isolated-first", taskId: "task", projectId: "project", slotKey: "coordinator", workspacePath: "G:/game",
        prompt: "工作台新消息", sessionMode: "new" as const, writePaths: [] };
      await bridge.submit(request);
      await vi.waitFor(async () => expect(await bridge.receipt(request.requestId)).toMatchObject({ status: "executing", session: { sessionId: S1 } }));
      expect(ipc.sendMessage).toHaveBeenCalledOnce();
      expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: null, workspacePath: "G:/game", model: "opus", prompt: expect.stringContaining(request.prompt), imagePaths: null, permission: "manual" }));
      expect(vi.mocked(ipc.sendMessage).mock.calls[0][0].prompt).not.toContain(drafts[draftKey]);
      expect(useChatStore.getState().active).toBe(userTab); expect(useChatStore.getState().drafts).toBe(drafts);
      expect(useChatStore.getState().bySession[draftKey]).toBe(original);
      expect(useChatStore.getState().openTabs).toEqual([userTab, ref]);
      expect(useSidechatStore.getState().sidechatBySession[draftKey]).toBe(side);
      expect(modes.captureCheckpoint()).toEqual(retainedMode);
      expect(hasComposerImageDraft(draftKey)).toBe(true); expect(images.images).toBe(storedImages);
      await bridge.submit(request); await bridge.ready(); expect(ipc.sendMessage).toHaveBeenCalledOnce();
    } finally {
      bridge.dispose(); await act(async () => { images.clearImages(); imageRoot.unmount(); }); reactGlobal.IS_REACT_ACT_ENVIRONMENT = priorAct;
      modes.restoreCheckpoint(modeSnapshot); useSidechatStore.setState({ btwBySession: sides.btwBySession, sidechatBySession: sides.sidechatBySession });
    }
  });
});

describe("revealing a blocking native draft", () => {
  function realTabs() {
    useChatStore.setState(createTabActions({ get: useChatStore.getState, set: useChatStore.setState }));
  }
  it("reopens the exact hidden draft without migrating another engine's text or changing launch preferences", async () => {
    const other = { engine: "codex", sessionId: null, workspacePath: ref.workspacePath };
    const otherKey = sessionKey("codex", null, ref.workspacePath);
    const own = { ...EMPTY_SESSION, messages: [], queue: [], activeModel: "preserved-model", activeEffort: "high" };
    const drafts = { [draftKey]: "承接上一会话：旧稿🙂", [otherKey]: "另一引擎的未发送文字" };
    state({ activeEngine: "codex", active: other, openTabs: [other], drafts, bySession: { [draftKey]: own },
      engines: [{ id: "claude" }, { id: "codex" }], models: { claude: "default-model", codex: "default-codex" } });
    realTabs();
    const before = useChatStore.getState();
    await (await desktopTaskFacade()).focusDraft("claude", ref.workspacePath, { requireBlockedDraft: true });
    const after = useChatStore.getState();
    expect(after.active).toMatchObject(draft); expect(after.openTabs).toEqual([other, draft]);
    expect(after.drafts).toBe(before.drafts); expect(after.bySession[draftKey]).toBe(own);
    expect(after.models).toBe(before.models); expect(after.efforts).toBe(before.efforts);
    expect(desktop.state.send).not.toHaveBeenCalled(); expect(desktop.state.openBackgroundDraft).not.toHaveBeenCalled();
    expect(after.activeEngine).toBe("claude");
  });
  it("retains an open draft's exact overrides and refuses disappeared or unavailable targets", async () => {
    const held = { ...draft, model: "specific", provider: "private-channel", effort: "high" as const };
    state({ openTabs: [ref, held], drafts: { [draftKey]: "existing" } }); realTabs();
    const facade = await desktopTaskFacade();
    await facade.focusDraft("claude", ref.workspacePath, { requireBlockedDraft: true });
    expect(useChatStore.getState().active).toBe(held);
    useChatStore.setState({ drafts: {} });
    await expect(facade.focusDraft("claude", ref.workspacePath, { requireBlockedDraft: true })).rejects.toThrow(/变化|changed/);
    await expect(facade.focusDraft("claude", "G:/unregistered", { requireBlockedDraft: true })).rejects.toThrow(/不可用|unavailable/);
    expect(useChatStore.getState().openTabs).toEqual([ref, held]);
  });
});

describe("off-tab lifecycle observation", () => {
  const proof = { ...ref, archived: true, idle: true };
  it("observes an archived source without opening, restoring or sending it", async () => {
    state({ openTabs: [], bySession: {}, archivedSessionKeys: { [key]: true } });
    vi.mocked(ipc.taskSessionLifecycle).mockResolvedValue(proof);
    const facade = await desktopTaskFacade(), result = await facade.observeLifecycle!(ref);
    expect(result).toMatchObject({ archived: true, idle: true });
    expect(result?.isCurrent()).toBe(true);
    await facade.openBackground(ref);
    expect(desktop.state.selectSession).not.toHaveBeenCalled();
    expect(desktop.state.send).not.toHaveBeenCalled();
    expect(useChatStore.getState().archivedSessionKeys[key]).toBe(true);
    expect(useChatStore.getState().openTabs).toEqual([]);
  });
  it.each(["archive", "new-run", "history", "identity", "children"])("invalidates a delayed observation after %s changes", async change => {
    state({ openTabs: [], archivedSessionKeys: { [key]: true } });
    const pending = Promise.withResolvers<typeof proof>();
    vi.mocked(ipc.taskSessionLifecycle).mockReturnValueOnce(pending.promise);
    const previousLeader = useLeaderStore.getState();
    const facade = await desktopTaskFacade(), observing = facade.observeLifecycle!(ref);
    await Promise.resolve();
    if (change === "archive") useChatStore.setState({ archivedSessionKeys: {} });
    if (change === "new-run") runRouting.set("late-run", key);
    if (change === "history") useChatStore.setState({ bySession: {} });
    if (change === "identity") useChatStore.setState({ sessions: [{ ...ref, workspacePath: "G:/other" }] as never });
    if (change === "children") useLeaderStore.setState({ snapshot: { ...previousLeader.snapshot, branches: [...previousLeader.snapshot.branches,
      { id: "late", parentEngine: ref.engine, parentSessionId: ref.sessionId, engine: "codex", sessionId: "late-child", workspacePath: ref.workspacePath, state: "starting" } as never] } });
    pending.resolve(proof);
    try { expect(await observing).toBeNull(); }
    finally { useLeaderStore.setState(previousLeader, true); }
  });
  it.each(["engine", "sessionId", "workspacePath"] as const)("rejects native identity mismatches in %s", async field => {
    vi.mocked(ipc.taskSessionLifecycle).mockResolvedValue({ ...proof, [field]: "wrong" });
    const facade = await desktopTaskFacade();
    expect(await facade.observeLifecycle!(ref)).toBeNull();
  });
  it("bounds slow observation and never starts a second native read behind its timeout", async () => {
    vi.useFakeTimers();
    const pending = Promise.withResolvers<typeof proof>();
    vi.mocked(ipc.taskSessionLifecycle).mockReturnValueOnce(pending.promise);
    const facade = await desktopTaskFacade();
    try {
      const observing = facade.observeLifecycle!(ref);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await observing).toBeNull();
      expect(await facade.observeLifecycle!(ref)).toBeNull();
      expect(ipc.taskSessionLifecycle).toHaveBeenCalledTimes(1);
      pending.resolve(proof); await Promise.resolve(); await Promise.resolve();
    } finally { pending.resolve(proof); vi.useRealTimers(); }
  });
  it("requires fresh off-tab quiescence before recovering an exact stopped run", async () => {
    state({ openTabs: [], bySession: {}, archivedSessionKeys: { [key]: true } });
    vi.mocked(ipc.taskSessionLifecycle).mockResolvedValue({ ...proof, idle: false });
    const facade = await desktopTaskFacade();
    expect(await facade.recoverSettledRun!("stop-run", ref)).toBeNull();
    expect(desktop.invoke).not.toHaveBeenCalled();
    vi.mocked(ipc.taskSessionLifecycle).mockResolvedValue(proof);
    desktop.invoke.mockResolvedValue({ ...ref, runId: "stop-run", status: "completed" });
    expect(await facade.recoverSettledRun!("stop-run", ref)).toEqual({ status: "completed" });
    expect(desktop.state.selectSession).not.toHaveBeenCalled();
  });
});

describe("desktop task facade", () => {
  it("recognizes an idle Claude reply without claiming its background process has ended", async () => {
    const facade = await desktopTaskFacade(), session = desktop.state.bySession[key];
    session.streaming = true; session.nativeTaskRunId = "live-claude"; session.nativeActivity = "waiting";
    session.liveLaunch = resolveLaunchSettings(desktop.state, ref, session);
    runRouting.set("live-claude", key);
    expect(facade.conversationState!(ref)).toMatchObject({ status: "busy", canDeliver: true, readyForQueuedInput: true });
    session.nativeActivity = "running";
    expect(facade.conversationState!(ref)).toMatchObject({ status: "busy", readyForQueuedInput: false });
    session.nativeActivity = "waiting";
    session.messages = [{ seq: 1, role: "grant", text: "", ts: null, grant: { status: "pending" } }];
    expect(facade.conversationState!(ref)).toMatchObject({ status: "awaiting_permission", canDeliver: false, readyForQueuedInput: false });
  });
  it("keeps full-history IPC and optional verified child reports together without a transcript excerpt", async () => {
    const selection = { engine: "codex" as const, model: "fixture-compressor", effort: "high" };
    const childContext = "子任务报告（未经独立验收）：保留待验证事项。";
    vi.mocked(ipc.summarizeSessionHandoff).mockResolvedValueOnce("完整来源摘要");
    expect(await (await desktopTaskFacade()).summarizeHandoff!(ref, selection, childContext)).toBe("完整来源摘要");
    expect(ipc.summarizeSessionHandoff).toHaveBeenLastCalledWith({ engine: ref.engine, sessionId: ref.sessionId,
      historyScope: "full", compressionSelection: selection, childContext });
  });
  it("passes the progress callback to full-history IPC without changing the selected model", async () => {
    const selection = { engine: "codex" as const, model: "fixture-compressor", effort: "max" }, progress = vi.fn();
    vi.mocked(ipc.summarizeSessionHandoff).mockImplementationOnce(async (_input, observe) => { observe?.({ phase: "segments", completed: 0, total: 2 }); return "summary"; });
    await (await desktopTaskFacade()).summarizeHandoff!(ref, selection, undefined, progress);
    expect(ipc.summarizeSessionHandoff).toHaveBeenLastCalledWith({ engine: ref.engine, sessionId: ref.sessionId,
      historyScope: "full", compressionSelection: selection }, progress);
    expect(progress).toHaveBeenCalledExactlyOnceWith({ phase: "segments", completed: 0, total: 2 });
  });
  it("continues with the exact native session's current choices instead of the initial coordinator launch", async () => {
    const codex = { ...ref, engine: "codex", model: "gpt-6.1-terra" };
    const codexKey = sessionKey(codex.engine, codex.sessionId, codex.workspacePath);
    const session = { ...EMPTY_SESSION, messages: [], queue: [], activeEffort: "xhigh", activeProvider: "current-channel" };
    const initial = { model: "old-model", effort: "max", providerId: "old-channel", defaultModel: "old-default", codexServiceTierOverride: "priority" as const };
    state({ openTabs: [codex], sessions: [codex], bySession: { [codexKey]: session },
      models: { codex: "current-default" }, efforts: { codex: "medium" }, providers: { codex: "default-channel" } });
    desktop.state.sendWhileBusy = vi.fn(async (_p, _i, options) => {
      if (!matchesHostTaskSelection(codex, session, options!.hostLaunch!)) throw new HostChatBusyError("Host task session selection changed before delivery");
      await options?.hostContinuation?.beforeDelivery("turn", "next-run");
      options?.hostContinuation?.onReceived("turn", "next-run");
    });
    const facade = await desktopTaskFacade();
    await expect(facade.continueMessage!(codex, "follow", [], "next-run", async () => {}, initial)).resolves.toEqual({ delivery: "turn", runId: "next-run" });
    expect(desktop.state.sendWhileBusy).toHaveBeenCalledWith("follow", [], expect.objectContaining({ hostLaunch: {
      model: "gpt-6.1-terra", effort: "xhigh", providerId: "current-channel", codexServiceTierOverride: "priority",
      defaultModel: "current-default", defaultEffort: "medium", defaultProvider: "default-channel",
      expectedNativeSelection: { model: "gpt-6.1-terra", effort: "xhigh", providerId: "current-channel" },
    } }), codex);
    expect(initial).toMatchObject({ model: "old-model", effort: "max", providerId: "old-channel" });
  });
  it("freezes the continuation's current choices across preparation and still rejects a later user change", async () => {
    desktop.state.bySession[key].activeEffort = "xhigh";
    let capturedEffort: string | undefined;
    desktop.state.sendWhileBusy = vi.fn(async (_p, _i, options) => {
      capturedEffort = options?.hostLaunch?.effort;
      await options?.hostContinuation?.beforeDelivery("turn", "next-run");
      if (!matchesHostTaskSelection(ref, desktop.state.bySession[key], options!.hostLaunch!)) throw new HostChatBusyError("Host task session selection changed before delivery");
      options?.hostContinuation?.onReceived("turn", "next-run");
    });
    const facade = await desktopTaskFacade();
    await expect(facade.continueMessage!(ref, "follow", [], "next-run", async () => {
      desktop.state.bySession[key].activeEffort = "high";
    }, { effort: "max" })).rejects.toBeInstanceOf(TaskPreSpawnError);
    expect(capturedEffort).toBe("xhigh");
  });
  it("does not reuse initial choices when the native continuation state is unavailable", async () => {
    delete desktop.state.bySession[key];
    desktop.state.sendWhileBusy = vi.fn();
    const facade = await desktopTaskFacade();
    await expect(facade.continueMessage!(ref, "follow", [], "next-run", async () => {}, { effort: "max" })).rejects.toBeInstanceOf(TaskPreSpawnError);
    expect(desktop.state.sendWhileBusy).not.toHaveBeenCalled();
  });
  it("also fences choices first made while a continuation with inherited defaults is being prepared", async () => {
    desktop.state.sendWhileBusy = vi.fn(async (_p, _i, options) => {
      expect(options?.hostLaunch?.expectedNativeSelection).toEqual({ model: null, effort: null, providerId: null });
      await options?.hostContinuation?.beforeDelivery("turn", "next-run");
      if (!matchesHostTaskSelection(ref, desktop.state.bySession[key], options!.hostLaunch!)) throw new HostChatBusyError("Host task session selection changed before delivery");
      options?.hostContinuation?.onReceived("turn", "next-run");
    });
    const facade = await desktopTaskFacade();
    await expect(facade.continueMessage!(ref, "follow", [], "next-run", async () => {
      desktop.state.bySession[key].activeProvider = "new-explicit-channel";
    })).rejects.toBeInstanceOf(TaskPreSpawnError);
  });
  it("treats a verified waiting Claude CLI as idle for a parent result continuation", async () => {
    const facade = await desktopTaskFacade();
    const session = desktop.state.bySession[key];
    Object.assign(session, { streaming: true, nativeActivity: "waiting", nativeTaskRunId: "persistent-run", liveLaunch: {
      model: "opus", effort: "high", provider: null, permission: desktop.state.permission,
    } });
    runRouting.set("persistent-run", key);
    expect(facade.inspect(ref)).toBe("busy");
    expect(facade.idleForContinuation!(ref)).toBe(true);
    session.nativeActivity = "running";
    expect(facade.idleForContinuation!(ref)).toBe(false);
    session.nativeActivity = "waiting"; session.queueParked = true;
    expect(facade.idleForContinuation!(ref)).toBe(false);
  });
  it("holds a result continuation for a permission card or an actively generating Codex turn", async () => {
    const facade = await desktopTaskFacade();
    desktop.state.bySession[key].messages = [{ seq: 1, role: "grant", text: "", ts: null, grant: { status: "pending" } }];
    expect(facade.idleForContinuation!(ref)).toBe(false);
    const codex = { ...ref, engine: "codex" };
    state({ openTabs: [codex], sessions: [codex], bySession: { [sessionKey(codex.engine, codex.sessionId, codex.workspacePath)]: {
      ...EMPTY_SESSION, messages: [], queue: [], streaming: true, codexRunId: "codex-run",
    } } });
    expect(facade.idleForContinuation!(codex)).toBe(false);
  });
  it("advertises managed handoff only after the native capability explicitly returns true", async () => {
    const facade = await desktopTaskFacade();
    desktop.invoke.mockResolvedValueOnce(true).mockResolvedValueOnce("true").mockRejectedValueOnce(new Error("Unknown command"));
    expect(await facade.managedChildHandoffSupported!()).toBe(true);
    expect(await facade.managedChildHandoffSupported!()).toBe(false);
    expect(await facade.managedChildHandoffSupported!()).toBe(false);
    expect(desktop.invoke.mock.calls).toEqual(Array.from({ length: 3 }, () => ["task_managed_child_handoff_supported"]));
  });
  it("uses exact loaded native session telemetry for coordinator cost decisions", async () => {
    const now = Date.now();
    const meta = { ...ref, model: "opus", updatedAt: now - 7_200_000,
      promptCache: { startedAt: now - 7_200_000, observedAt: now - 7_100_000, ttlSeconds: 3600, source: "anthropic-usage" } };
    const session = { ...EMPTY_SESSION, messages: [], queue: [], usage: { input_tokens: 80000 } };
    state({ sessions: [meta], openTabs: [{ ...ref, model: "opus" }], bySession: { [key]: session } });
    const facade = await desktopTaskFacade(), evaluation = facade.sessionCostReview!(ref);
    expect(evaluation).toMatchObject({ required: true, review: { cacheHeat: "cold", context: { used: 80000 } } });
    desktop.state.sessions = [];
    expect(facade.sessionCostReview!(ref)).toMatchObject({ required: false, review: { cacheHeat: "unknown", context: { used: 80000 } } });
    desktop.state.openTabs.push({ ...ref, workspacePath: "G:/other" });
    expect(facade.sessionCostReview!(ref)).toBeNull();
  });
  it("runs a continuation's final cost fence only after the new-turn identity is durable", async () => {
    const facade = await desktopTaskFacade(), beforeDelivery = vi.fn(async () => {}), beforeSpawn = vi.fn(async () => {});
    desktop.state.sendWhileBusy = vi.fn(async (_p, _i, options) => {
      await options?.hostBeforeSend?.(); expect(beforeSpawn).not.toHaveBeenCalled();
      await options?.hostContinuation?.beforeDelivery("turn", "requested-run");
      expect(beforeDelivery).toHaveBeenCalledWith("turn", "requested-run");
      await options?.hostBeforeSend?.(); expect(beforeSpawn).toHaveBeenCalledOnce();
      options?.hostContinuation?.onReceived("turn", "requested-run");
    });
    await expect(facade.continueMessage!(ref, "follow", [], "requested-run", beforeDelivery, undefined, undefined, beforeSpawn)).resolves.toEqual({ delivery: "turn", runId: "requested-run" });
  });
  it("advertises a service-tier override only after the live native capability probe", async () => {
    const facade = await desktopTaskFacade();
    desktop.invoke.mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("old native host"));
    await expect(facade.codexServiceTierOverrideSupported!()).resolves.toBe(true);
    await expect(facade.codexServiceTierOverrideSupported!()).resolves.toBe(false);
    expect(desktop.invoke).toHaveBeenCalledWith("codex_service_tier_override_supported");
  });
  it("passes the coordinator tier through the initial Codex store launch", async () => {
    const codexDraft = { engine: "codex", sessionId: null, workspacePath: "G:/game" };
    state({ openTabs: [codexDraft] });
    (desktop.state.send as ReturnType<typeof vi.fn>).mockImplementation(async (_p: string, _i: string[], options: any) => {
      options.onRunStarted({ runId: options.requestedRunId, sessionId: null });
    });
    const facade = await desktopTaskFacade();
    await facade.sendNew("codex", "G:/game", "goal", "run-fast", { model: "gpt", codexServiceTierOverride: "priority" });
    expect(desktop.state.send).toHaveBeenCalledWith("goal", [], expect.objectContaining({ hostLaunch: { model: "gpt", codexServiceTierOverride: "priority" } }), codexDraft);
  });
  it("exposes predictions only for an unambiguous exact workspace and observes the shared setting", async () => {
    const facade = await desktopTaskFacade(), changed = vi.fn(), off = facade.subscribe(changed);
    try {
      clearAllComposerPredictions(); setComposerPredictionEnabled(true); changed.mockClear();
      setComposerPrediction(key, "继续检查🙂");
      const prediction = getComposerPredictionSnapshot(key)!;
      expect(changed).toHaveBeenCalled(); expect(facade.composerPrediction!(ref)).toEqual(prediction);
      desktop.state.openTabs.push({ ...ref, workspacePath: "G:/other" });
      expect(facade.composerPrediction!(ref)).toBeNull();
      expect(facade.dismissComposerPrediction!(ref, prediction.id)).toBe(false);
      desktop.state.openTabs.pop();
      expect(facade.dismissComposerPrediction!(ref, prediction.id + 1)).toBe(false);
      expect(facade.dismissComposerPrediction!(ref, prediction.id)).toBe(true);
      expect(facade.composerPrediction!(ref)).toBeNull();
      setComposerPrediction(key, "另一条"); setComposerPredictionEnabled(false);
      expect(facade.composerPrediction!(ref)).toBeNull();
    } finally { off(); clearAllComposerPredictions(); setComposerPredictionEnabled(true); }
  });
  function coldStop() {
    const saved = new Map<string, unknown>([["__host_tasks_v1:conversations", {
      version: 1, records: [{ requestId: "root", revision: 1, inputRevision: 0, sessionRef: ref, stopping: true, stopRunId: "archived-run", inputs: [] }],
    }]]);
    const continuation = vi.fn(), hold = vi.fn();
    const storage = { get: async (_p: string, k: string) => saved.get(k), set: async (_p: string, k: string, v: unknown) => { saved.set(k, structuredClone(v)); }, delete: async () => {} };
    const mount = () => createTaskConversationBridge({ pluginId: "cold-stop", storage,
      facade: async () => ({ ...await desktopTaskFacade(), leaderBranches: async () => [], listen: async () => () => {}, continueMessage: continuation }),
      owned: async id => ({ receipt: { requestId: id, workspacePath: ref.workspacePath, session: ref, status: "completed", runId: "initial-run" }, proven: true }) as never,
      resolveImages: async ids => ids, hold,
    });
    return { saved, storage, mount, continuation, hold };
  }
  const archive = () => ({ status: "completed", runId: "archived-run", engine: ref.engine, sessionId: ref.sessionId });

  it("recovers a real cold stop with empty memory/run IDs and persists exact evidence across remounts", async () => {
    const session = desktop.state.bySession[key];
    session.messages = [{ seq: 8, role: "grant", text: "", ts: null, grant: { status: "pending" } }];
    desktop.invoke.mockResolvedValue(archive());
    const f = coldStop(), bridge = f.mount();
    try {
      expect(session.nativeTaskRunId).toBeFalsy(); expect(settledRunOutcomes.size).toBe(0);
      await bridge.conversation("root");
      await vi.waitFor(async () => expect(await bridge.conversation("root")).toMatchObject({ status: "cancelled", stopRequested: true }));
      expect(desktop.invoke).toHaveBeenCalledExactlyOnceWith("runtime_worker_terminal_outcome", { runId: "archived-run", ...ref });
      expect(bridge.capture().records[0].stopTerminalProof).toEqual({ status: "completed", runId: "archived-run", sessionRef: ref });
    } finally { bridge.dispose(); }
    desktop.invoke.mockReset().mockRejectedValue(new Error("archive no longer available"));
    const remount = f.mount();
    try {
      expect(await remount.conversation("root")).toMatchObject({ status: "cancelled" });
      expect(desktop.invoke).not.toHaveBeenCalled();
      const facade = await desktopTaskFacade();
      expect(facade.inspect(ref)).toBe("awaiting_permission");
      expect(facade.conversationState!(ref)?.canDeliver).toBe(false);
      expect(session.messages[0].grant?.status).toBe("pending");
      expect(f.continuation).not.toHaveBeenCalled(); expect(desktop.state.send).not.toHaveBeenCalled(); expect(desktop.state.interrupt).not.toHaveBeenCalled();
    } finally { remount.dispose(); }
  });

  it.each(["missing", "IPC error", "wrong run", "wrong session", "wrong engine", "live route", "new route", "new run", "streaming", "queue", "launching", "workspace conflict", "question", "plan"])("keeps a cold stop held with %s", async condition => {
    const session = desktop.state.bySession[key];
    session.messages = [{ seq: 8, role: "grant", text: "", ts: null, grant: { status: "pending" } }];
    session.settledRunIds = ["archived-run"];
    const proof = archive();
    if (condition === "wrong run") proof.runId = "other";
    if (condition === "wrong session") proof.sessionId = "other";
    if (condition === "wrong engine") proof.engine = "codex";
    desktop.invoke.mockResolvedValue(condition === "missing" ? null : proof);
    if (condition === "IPC error") desktop.invoke.mockRejectedValue(new Error("offline"));
    if (condition === "live route") runRouting.set("archived-run", key);
    if (condition === "new route") runRouting.set("new-run", key);
    if (condition === "new run") session.nativeTaskRunId = "new-run";
    if (condition === "streaming") session.streaming = true;
    if (condition === "queue") session.queue = [{ text: "queued" }] as never;
    if (condition === "launching") session.draftLaunching = "new-run";
    if (condition === "workspace conflict") desktop.state.sessions.push({ ...desktop.state.sessions[0], workspacePath: "G:/elsewhere" });
    if (condition === "question") session.messages.push({ seq: 9, role: "assistant", text: "", ts: null, question: { status: "pending" } } as never);
    if (condition === "plan") session.messages.push({ seq: 9, role: "assistant", text: "", ts: null, planReview: { status: "awaiting_review" } } as never);
    const f = coldStop(), bridge = f.mount();
    try {
      expect(await bridge.conversation("root")).toMatchObject({ status: "stopping", canSend: false, canChangeSelection: false });
      expect(f.continuation).not.toHaveBeenCalled(); expect(desktop.state.interrupt).not.toHaveBeenCalled();
    } finally { bridge.dispose(); }
  });

  it("rejects an archive reply when a new turn intervenes even if the session returns idle", async () => {
    let resolve!: (value: unknown) => void;
    desktop.invoke.mockImplementation(() => new Promise(done => { resolve = done; }));
    const facade = await desktopTaskFacade();
    const pending = facade.recoverSettledRun!("archived-run", ref);
    await vi.waitFor(() => expect(desktop.invoke).toHaveBeenCalledTimes(1));
    const original = useChatStore.getState().bySession;
    useChatStore.setState({ bySession: { [key]: { ...original[key], streaming: true, nativeTaskRunId: "new" } } });
    useChatStore.setState({ bySession: original });
    resolve(archive()); expect(await pending).toBeNull();
  });
  it.each([false, true])("settles an old unknown input without using its proof to settle a newer running=%s coordinator", async running => {
    const session = desktop.state.bySession[key];
    session.nativeTaskRunId = "newer-run"; session.streaming = running;
    if (running) runRouting.set("newer-run", key);
    desktop.invoke.mockImplementation(async (_command, args) => ({ ...archive(), runId: args.runId }));
    const f = coldStop();
    const cut = f.saved.get("__host_tasks_v1:conversations") as any;
    Object.assign(cut.records[0], { stopRunId: "newer-run", stopEpoch: 1, stopInputRevision: 1, inputRevision: 1,
      inputs: [{ receipt: { conversationRequestId: "root", requestId: "old-input", inputRevision: 1, preview: "old input",
        status: "unknown", delivery: "turn", runId: "archived-run", sessionRef: ref, acceptedAt: 1, updatedAt: 1 },
        fingerprint: JSON.stringify(["root", "old-input", 0, "old input", [], "old input"]), prompt: "old input", displayText: "old input", images: [] }] });
    const bridge = f.mount();
    try {
      await bridge.conversation("root");
      await vi.waitFor(async () => expect((await bridge.messageReceipt("root", "old-input"))?.stopResolved).toBe(true));
      const view = await bridge.conversation("root");
      expect(view).toMatchObject({ status: running ? "stopping" : "cancelled", canSend: !running,
        deliveries: [{ requestId: "old-input", status: "unknown", stopResolved: true }] });
      expect(bridge.capture().records[0].stopTerminalProof?.runId).toBe(running ? undefined : "newer-run");
      const facade = await desktopTaskFacade();
      expect(facade.canProjectTerminalRun!("archived-run", ref)).toBe(false);
      expect(await facade.recoverSettledRun!("archived-run", ref)).toBeNull();
      expect(f.continuation).not.toHaveBeenCalled(); expect(desktop.state.send).not.toHaveBeenCalled();
    } finally { bridge.dispose(); }
  });
  it.each(["wrong run", "wrong session", "wrong engine", "live input", "workspace conflict"])("rejects %s evidence for an input-only historical recovery", async condition => {
    desktop.state.bySession[key].nativeTaskRunId = "newer-run";
    const proof = archive();
    if (condition === "wrong run") proof.runId = "other-run";
    if (condition === "wrong session") proof.sessionId = "other-session";
    if (condition === "wrong engine") proof.engine = "codex";
    if (condition === "live input") runRouting.set("archived-run", key);
    if (condition === "workspace conflict") desktop.state.sessions.push({ ...desktop.state.sessions[0], workspacePath: "G:/elsewhere" });
    desktop.invoke.mockResolvedValue(proof);
    const facade = await desktopTaskFacade();
    expect(await facade.recoverSettledRun!("archived-run", ref, { inputOnly: true })).toBeNull();
    expect(settledRunOutcomes.size).toBe(0);
  });

  it("bounds native recovery waiting and ignores a reply arriving after timeout", async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (value: unknown) => void;
      desktop.invoke.mockImplementation(() => new Promise(done => { resolve = done; }));
      const facade = await desktopTaskFacade(), pending = facade.recoverSettledRun!("archived-run", ref);
      await vi.advanceTimersByTimeAsync(30000);
      expect(await pending).toBeNull();
      resolve(archive()); await Promise.resolve();
      expect(settledRunOutcomes.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("does not release a durable stop when the visible workspace or current run changes", async () => {
    const f = coldStop(); desktop.invoke.mockResolvedValue(archive());
    const bridge = f.mount();
    try {
      await bridge.conversation("root");
      await vi.waitFor(async () => expect((await bridge.conversation("root")).status).toBe("cancelled"));
      desktop.state.openTabs.push({ ...ref, workspacePath: "G:/other" });
      expect((await bridge.conversation("root")).status).toBe("stopping");
      desktop.state.openTabs.pop(); desktop.state.bySession[key].nativeTaskRunId = "new-run";
      expect((await bridge.conversation("root")).status).toBe("stopping");
    } finally { bridge.dispose(); }
  });
  it("treats a retained grant as idle only with exact terminal outcome proof", async () => {
    const facade = await desktopTaskFacade();
    const session = desktop.state.bySession[key];
    session.nativeTaskRunId = "finished-run";
    session.messages = [{ seq: 8, role: "grant", text: "", ts: null, grant: { status: "pending" } }];
    settledRunOutcomes.set("finished-run", { key, status: "completed" });
    const messages = session.messages;
    desktop.state.respondToGrant = vi.fn(async () => {});
    expect(facade.conversationState!(ref)).toEqual({ messages, runId: null, status: "idle", canDeliver: false, readyForQueuedInput: true });
    expect(facade.inspect(ref)).toBe("awaiting_permission");
    expect(session.messages).toBe(messages);
    expect(session.messages[0].grant?.status).toBe("pending");
    expect(desktop.state.respondToGrant).not.toHaveBeenCalled();
    expect(desktop.state.send).not.toHaveBeenCalled();
  });

  it.each(["unknown", "different session", "different engine", "live route", "new route", "streaming", "queue", "launching", "new run"])("keeps retained grants conservative with %s", async condition => {
    const facade = await desktopTaskFacade();
    const session = desktop.state.bySession[key];
    session.nativeTaskRunId = "old-run";
    session.messages = [{ seq: 8, role: "grant", text: "", ts: null, grant: { status: "pending" } }];
    if (condition !== "unknown") settledRunOutcomes.set("old-run", { key, status: "completed" });
    if (condition.startsWith("different")) {
      const other = { ...ref, ...(condition === "different session" ? { sessionId: "other" } : { engine: "codex" }) };
      settledRunOutcomes.set("old-run", { key: sessionKey(other.engine, other.sessionId, other.workspacePath), status: "completed" });
    }
    if (condition === "live route") runRouting.set("old-run", key);
    if (condition === "new route") runRouting.set("new-run", key);
    if (condition === "streaming") session.streaming = true;
    if (condition === "queue") session.queue = [{ text: "queued" }] as never;
    if (condition === "launching") session.draftLaunching = "new-run";
    if (condition === "new run") session.nativeTaskRunId = "new-run";
    expect(facade.conversationState!(ref)).toMatchObject({ status: "awaiting_permission", canDeliver: false });
    expect(facade.conversationState!(ref)?.runId).toBe(session.nativeTaskRunId);
  });

  it.each(["openTabs", "sessions"])("does not use workspace-ambiguous terminal proof from %s", async collection => {
    const facade = await desktopTaskFacade();
    const session = desktop.state.bySession[key];
    session.nativeTaskRunId = "finished-run";
    session.messages = [{ seq: 8, role: "grant", text: "", ts: null, grant: { status: "pending" } }];
    settledRunOutcomes.set("finished-run", { key, status: "completed" });
    if (collection === "openTabs") desktop.state.openTabs.push({ ...ref, workspacePath: "G:/other" });
    else desktop.state.sessions.push({ ...desktop.state.sessions[0], workspacePath: "G:/other" });
    expect(facade.conversationState!(ref)).toMatchObject({ runId: "finished-run", status: "awaiting_permission", canDeliver: false });
    expect(facade.conversationState!({ ...ref, workspacePath: "G:/missing" })).toBeNull();
  });

  it("recognizes equivalent Windows workspace paths when checking proof ambiguity", async () => {
    const facade = await desktopTaskFacade();
    const session = desktop.state.bySession[key];
    session.nativeTaskRunId = "finished-run";
    session.messages = [{ seq: 8, role: "grant", text: "", ts: null, grant: { status: "pending" } }];
    settledRunOutcomes.set("finished-run", { key, status: "completed" });
    desktop.state.sessions.push({ ...desktop.state.sessions[0], workspacePath: "g:\\GAME" });
    expect(facade.conversationState!(ref)).toMatchObject({ runId: null, status: "idle", canDeliver: false });
  });

  it("recovers a persisted stopping conversation with real terminal proof without answering its historical grant", async () => {
    const facade = await desktopTaskFacade();
    const session = desktop.state.bySession[key];
    session.nativeTaskRunId = "finished-run";
    session.messages = [{ seq: 8, role: "grant", text: "", ts: null, grant: { status: "pending" } }];
    const messages = session.messages;
    settledRunOutcomes.set("finished-run", { key, status: "completed" });
    desktop.state.respondToGrant = vi.fn(async () => {});
    const saved = new Map<string, unknown>([["__host_tasks_v1:conversations", {
      version: 1, records: [{ requestId: "root", revision: 1, inputRevision: 0, sessionRef: ref, stopping: true, stopRunId: "finished-run", inputs: [] }],
    }]]);
    const continuation = vi.fn();
    const bridge = createTaskConversationBridge({
      pluginId: "facade-stop-regression", storage: {
        get: async (_plugin, k) => saved.get(k), set: async (_plugin, k, value) => { saved.set(k, structuredClone(value)); }, delete: async () => {},
      },
      facade: async () => ({ ...facade, leaderBranches: async () => [], listen: async () => () => {}, continueMessage: continuation }),
      owned: async id => ({ receipt: { requestId: id, workspacePath: ref.workspacePath, session: ref, status: "completed", runId: "initial-run" }, proven: true }) as never,
      resolveImages: async ids => ids, hold: async () => {},
    });
    try {
      await bridge.ready(); await bridge.drain();
      expect(await bridge.conversation("root")).toMatchObject({ status: "cancelled", stopRequested: true });
      expect(session.messages).toBe(messages);
      expect(session.messages[0].grant?.status).toBe("pending");
      expect(facade.conversationState!(ref)?.canDeliver).toBe(false);
      expect(desktop.state.respondToGrant).not.toHaveBeenCalled();
      expect(desktop.state.interrupt).not.toHaveBeenCalled();
      expect(desktop.state.send).not.toHaveBeenCalled();
      expect(continuation).not.toHaveBeenCalled();
    } finally { bridge.dispose(); }
  });

  it.each(["question", "awaiting_review", "deferred", "submitting"])("preserves pending %s even after the recorded run settled", async kind => {
    const facade = await desktopTaskFacade();
    const session = desktop.state.bySession[key];
    session.nativeTaskRunId = "finished-run";
    settledRunOutcomes.set("finished-run", { key, status: "completed" });
    session.messages = [{ seq: 8, role: "grant", text: "", ts: null, grant: { status: "pending" } },
      { seq: 9, role: "assistant", text: "", ts: null, ...(kind === "question"
        ? { question: { status: "pending", runId: "finished-run", requestId: "ask", questions: [] } }
        : { planReview: { status: kind, runId: "finished-run" } }) } as never];
    expect(facade.conversationState!(ref)).toMatchObject({ runId: null, status: "awaiting_permission", canDeliver: false });
  });

  it("does not treat settled IDs alone as proof that a retained grant's run ended", async () => {
    const facade = await desktopTaskFacade();
    desktop.state.bySession[key].settledRunIds = ["finished-run"];
    desktop.state.bySession[key].nativeTaskRunId = "finished-run";
    desktop.state.bySession[key].messages = [{ seq: 8, role: "grant", text: "", ts: null, grant: { status: "pending" } }];
    expect(facade.conversationState!(ref)).toMatchObject({ runId: "finished-run", status: "awaiting_permission", canDeliver: false });
    expect(facade.settledRun("finished-run", ref)).toBeNull();
  });

  it("prepares only the exact background conversation without focusing, sending or parking it", async () => {
    const target = { ...ref, model: "opus" };
    const active = { ...ref, sessionId: "user-active", workspacePath: "G:/other" };
    state({ openTabs: [active, target], active });
    const facade = await desktopTaskFacade();
    await facade.prepareImmediateMessage!(ref, "exact-native-run");
    expect(desktop.state.prepareImmediateFollowUp).toHaveBeenCalledExactlyOnceWith(target, "exact-native-run");
    expect(useChatStore.getState().active).toEqual(active);
    expect(desktop.state.interrupt).not.toHaveBeenCalled();
    expect(desktop.state.send).not.toHaveBeenCalled();
    expect(desktop.state.selectSession).not.toHaveBeenCalled();
    expect(desktop.state.focusTab).not.toHaveBeenCalled();
  });

  it.each([
    { ...ref, engine: "codex" },
    { ...ref, workspacePath: "G:/another" },
    { ...ref, sessionId: "missing" },
  ])("does not prepare a non-exact ref %j", async other => {
    const facade = await desktopTaskFacade();
    await expect(facade.prepareImmediateMessage!(other, null)).rejects.toBeInstanceOf(TaskPreSpawnError);
    expect(desktop.state.prepareImmediateFollowUp).not.toHaveBeenCalled();
    expect(desktop.state.interrupt).not.toHaveBeenCalled();
  });

  it("preserves immediate-preparation refusals and IPC failures for the original inbox retry", async () => {
    const facade = await desktopTaskFacade();
    vi.mocked(desktop.state.prepareImmediateFollowUp).mockRejectedValueOnce(new HostChatBusyError("run changed"));
    await expect(facade.prepareImmediateMessage!(ref, "old-run")).rejects.toBeInstanceOf(TaskPreSpawnError);
    const failure = new Error("native Esc write failed");
    vi.mocked(desktop.state.prepareImmediateFollowUp).mockRejectedValueOnce(failure);
    await expect(facade.prepareImmediateMessage!(ref, "current-run")).rejects.toBe(failure);
    await expect(facade.prepareImmediateMessage!(ref, "current-run")).resolves.toBeUndefined();
    expect(desktop.state.prepareImmediateFollowUp).toHaveBeenCalledTimes(3);
    expect(desktop.state.interrupt).not.toHaveBeenCalled();
    expect(desktop.state.send).not.toHaveBeenCalled();
  });

  it("skips continuous real-store draft edits but wakes when the user-draft blocker clears", async () => {
    state({ openTabs: [ref, draft], drafts: { [draftKey]: "用户输入" } });
    const facade = await desktopTaskFacade(), callback = vi.fn();
    const unsubscribe = facade.subscribe(callback);
    try {
      expect(facade.draftReady("claude", "G:/game", {})).toBe(false);
      useChatStore.getState().setDraft(draftKey, "用户输入继续🌏");
      expect(callback).not.toHaveBeenCalled();
      useChatStore.getState().setDraft(draftKey, " \n\t");
      expect(callback).toHaveBeenCalledTimes(1);
      expect(facade.draftReady("claude", "G:/game", {})).toBe(true);
      useChatStore.getState().setDraft(draftKey, " ");
      expect(callback).toHaveBeenCalledTimes(1);
      useChatStore.getState().setDraft(draftKey, "首次占用");
      expect(callback).toHaveBeenCalledTimes(2);
    } finally { unsubscribe(); }
  });
  it("queries exact draft reasons without opening, focusing or sending", async () => {
    state({ drafts: { [draftKey]: "private draft" } });
    const facade = await desktopTaskFacade(), before = useChatStore.getState();
    expect(facade.draftBlockReason?.("claude", "G:/game", {})).toBe("user-draft:text");
    expect(facade.draftBlockReason?.("claude", "G:/game", {}, { requireOpenTab: true })).toBe("user-draft:missing-tab");
    expect(useChatStore.getState()).toBe(before);
    expect(desktop.state.openBackgroundDraft).not.toHaveBeenCalled();
    expect(desktop.state.focusTab).not.toHaveBeenCalled();
    expect(desktop.state.send).not.toHaveBeenCalled();
  });
  it("wakes only for pending sidechat/BTW occupation changes, not tokens, drafts or owner swaps", async () => {
    const previous = useSidechatStore.getState();
    const facade = await desktopTaskFacade(), callback = vi.fn(), off = facade.subscribe(callback);
    try {
      useSidechatStore.setState({ btwBySession: { [draftKey]: { text: "first" } } as never, sidechatBySession: {} });
      expect(callback).toHaveBeenCalledTimes(1);
      useSidechatStore.setState({ btwBySession: { [draftKey]: { text: "more tokens" } } as never });
      useSidechatStore.setState({ btwBySession: {}, sidechatBySession: { [draftKey]: { draft: "next input" } } as never });
      useSidechatStore.setState({ sidechatBySession: { [draftKey]: { draft: "next input edited" }, [key]: { draft: "saved chat" } } as never });
      expect(callback).toHaveBeenCalledTimes(1);
      useSidechatStore.setState({ sidechatBySession: { [key]: {} } as never });
      expect(callback).toHaveBeenCalledTimes(2);
      useSidechatStore.setState({ sidechatBySession: {} });
      expect(callback).toHaveBeenCalledTimes(2);
      off();
      useSidechatStore.setState({ sidechatBySession: { [draftKey]: {} } as never });
      expect(callback).toHaveBeenCalledTimes(2);
    } finally {
      off();
      useSidechatStore.setState({ btwBySession: previous.btwBySession, sidechatBySession: previous.sidechatBySession });
    }
  });
  it("wakes on mode entry/exit but not selected-mode or exit-lock changes that retain occupation", async () => {
    const modes = getConversationModeState(), snapshot = modes.captureCheckpoint();
    const identity = modes.identity(draftKey, "G:/game", true);
    const facade = await desktopTaskFacade(), callback = vi.fn(), off = facade.subscribe(callback);
    try {
      modes.select(identity, "fixture-one", false, 0);
      expect(callback).toHaveBeenCalledTimes(1);
      modes.select(identity, "fixture-two", false, 0);
      modes.setExitBlocked(identity, "fixture-two", true);
      modes.exit(identity);
      modes.setExitBlocked(identity, "fixture-two", false);
      expect(callback).toHaveBeenCalledTimes(1);
      modes.exit(identity);
      expect(callback).toHaveBeenCalledTimes(2);
      off();
      modes.select(identity, "fixture-one", false, 0);
      expect(callback).toHaveBeenCalledTimes(2);
    } finally { off(); modes.restoreCheckpoint(snapshot); }
  });

  it.each(["sidechat", "mode", "images"] as const)("legacy pending-slot facade releases a %s blocker and dispatches the original queued request exactly once", async kind => {
    const previousSides = useSidechatStore.getState(), modes = getConversationModeState(), modeSnapshot = modes.captureCheckpoint();
    const facade = { ...await desktopTaskFacade(), sendNewIsolated: undefined };
    const tabs = createTabActions({ get: useChatStore.getState, set: useChatStore.setState });
    const send = vi.fn<ChatStore["send"]>(async (_prompt, _images, options) => {
      await options?.hostBeforeSend?.();
      const runId = options!.requestedRunId!;
      runRouting.set(runId, `claude/${S1}`);
      options?.onRunStarted?.({ runId, sessionId: S1 });
    });
    state({ active: ref, openBackgroundDraft: tabs.openBackgroundDraft, send });
    const identity = modes.identity(draftKey, "G:/game", true);
    let releaseImages: (() => Promise<void>) | undefined;
    let cleanupImages: (() => Promise<void>) | undefined;
    if (kind === "sidechat") useSidechatStore.setState({ sidechatBySession: { [draftKey]: {} } as never });
    if (kind === "mode") modes.select(identity, "fixture-wake", false, 0);
    if (kind === "images") {
      const { act, createElement } = await import("react"), { createRoot } = await import("react-dom/client");
      const { useComposerImages } = await import("@/features/chat/components/use-composer-images");
      const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
      const previousAct = reactGlobal.IS_REACT_ACT_ENVIRONMENT;
      reactGlobal.IS_REACT_ACT_ENVIRONMENT = true;
      let images!: ReturnType<typeof useComposerImages>;
      function Owner() { images = useComposerImages(draftKey); return null; }
      const root = createRoot(document.createElement("div"));
      await act(async () => { root.render(createElement(Owner)); });
      await act(async () => { images.importImageFiles(["/fixture/image.png"], true); });
      releaseImages = async () => { await act(async () => { images.clearImages(); }); };
      cleanupImages = async () => { await act(async () => { root.unmount(); }); reactGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct; };
    }
    const data = new Map<string, unknown>();
    const bridge = createHostTaskBridge("occupation-wake", {
      get: async (_id, k) => structuredClone(data.get(k) ?? null),
      set: async (_id, k, value) => { data.set(k, structuredClone(value)); },
      delete: async (_id, k) => { data.delete(k); },
    }, { facade: async () => facade, invoke: async () => { throw new Error("Unexpected native call"); },
      paused: () => false, whenResumed: async () => {}, registerBlocker: () => () => {} });
    try {
      const request = { requestId: `waiting-${kind}`, taskId: "task", projectId: "project", slotKey: "coordinator",
        workspacePath: "G:/game", prompt: "fixture task", sessionMode: "new" as const, writePaths: [] };
      await bridge.submit(request); await bridge.ready();
      expect(await bridge.receipt(request.requestId)).toMatchObject({ status: "queued", runId: null, blockedBy: ["user-draft", `user-draft:${kind}`] });
      expect(useChatStore.getState().openTabs).toEqual([ref]);
      expect(send).not.toHaveBeenCalled();
      if (kind === "sidechat") useSidechatStore.setState({ sidechatBySession: {} });
      if (kind === "mode") modes.exit(identity);
      await releaseImages?.();
      await vi.waitFor(async () => {
        await bridge.ready();
        expect(await bridge.receipt(request.requestId)).toMatchObject({ status: "executing", session: { sessionId: S1 } });
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect((await bridge.receipt(request.requestId))?.blockedBy).toBeUndefined();
      // Duplicate acceptance and further independent wakeups do not replay it.
      await bridge.submit(request);
      useSidechatStore.setState({ sidechatBySession: { [draftKey]: {} } as never });
      useSidechatStore.setState({ sidechatBySession: {} });
      await bridge.ready();
      expect(send).toHaveBeenCalledTimes(1);
      expect(await bridge.list()).toHaveLength(1);
    } finally {
      bridge.dispose();
      await cleanupImages?.();
      modes.restoreCheckpoint(modeSnapshot);
      useSidechatStore.setState({ btwBySession: previousSides.btwBySession, sidechatBySession: previousSides.sidechatBySession });
    }
  });
  it("compares draft key additions and removals by occupied state, including whitespace", async () => {
    const facade = await desktopTaskFacade(), callback = vi.fn();
    const unsubscribe = facade.subscribe(callback);
    try {
      useChatStore.setState({ drafts: { extra: " \n" } });
      useChatStore.setState({ drafts: {} });
      expect(callback).not.toHaveBeenCalled();
      useChatStore.setState({ drafts: { extra: "occupied" } });
      expect(callback).toHaveBeenCalledTimes(1);
      useChatStore.setState({ drafts: { extra: "changed", blank: "\t" } });
      expect(callback).toHaveBeenCalledTimes(1);
      useChatStore.setState({ drafts: { blank: "\t" } });
      expect(callback).toHaveBeenCalledTimes(2);
      useChatStore.setState({ drafts: { constructor: "occupied" } });
      expect(callback).toHaveBeenCalledTimes(3);
      useChatStore.setState({ drafts: {} });
      expect(callback).toHaveBeenCalledTimes(4);
    } finally { unsubscribe(); }
  });
  it("keeps mixed state, added or deleted fields and leader notifications, and unsubscribes both stores", async () => {
    const facade = await desktopTaskFacade(), callback = vi.fn();
    const unsubscribe = facade.subscribe(callback);
    const previousLeader = useLeaderStore.getState();
    try {
      useChatStore.setState({ drafts: { extra: "one" }, bySession: { ...useChatStore.getState().bySession } });
      useChatStore.setState({ drafts: { extra: "two" }, bySession: { ...useChatStore.getState().bySession } });
      expect(callback).toHaveBeenCalledTimes(2);
      useChatStore.setState({ addedTaskField: undefined } as unknown as Partial<ChatStore>);
      expect(callback).toHaveBeenCalledTimes(3);
      const { addedTaskField: _removed, ...withoutField } = useChatStore.getState() as ChatStore & { addedTaskField?: unknown };
      useChatStore.setState(withoutField, true);
      expect(callback).toHaveBeenCalledTimes(4);
      useLeaderStore.setState({ snapshot: { ...previousLeader.snapshot } });
      expect(callback).toHaveBeenCalledTimes(5);
      unsubscribe();
      useChatStore.getState().setDraft("extra", "");
      useChatStore.setState({ bySession: {} });
      useLeaderStore.setState({ snapshot: { ...previousLeader.snapshot } });
      expect(callback).toHaveBeenCalledTimes(5);
    } finally { unsubscribe(); useLeaderStore.setState(previousLeader, true); }
  });
  it("continues the exact target through the store delivery callback instead of a local commit", async () => {
    const facade = await desktopTaskFacade();
    desktop.state.sendWhileBusy = vi.fn(async (_p, _i, options) => {
      options?.onCommitted?.(); await options?.hostContinuation?.beforeDelivery("live", "native-run");
      options?.hostContinuation?.onReceived("live", "native-run");
    });
    const fence = vi.fn(async () => {});
    expect(await facade.continueMessage!(ref, "follow", [], "requested-run", fence)).toEqual({ delivery: "live", runId: "native-run" });
    expect(fence).toHaveBeenCalledWith("live", "native-run");
    expect(desktop.state.sendWhileBusy).toHaveBeenCalledWith("follow", [], expect.objectContaining({ requestedRunId: "requested-run" }), ref);
    desktop.state.sendWhileBusy = vi.fn(async (_p, _i, options) => { options?.onCommitted?.(); });
    await expect(facade.continueMessage!(ref, "follow", [], "requested-run", fence)).rejects.toThrow("acknowledgement");
  });
  it("validates native pending question identity and does not report a swallowed failure as answered", async () => {
    const facade = await desktopTaskFacade();
    desktop.state.bySession[key].messages = [{ seq: 5, role: "question", text: "", ts: null, question: {
      runId: "question-run", requestId: "ask", status: "pending", questions: [{ header: "h", question: "Which?", options: [] }],
    } }];
    runRouting.set("question-run", key);
    desktop.state.respondToQuestion = vi.fn(async () => {});
    const action = { type: "answerQuestion" as const, conversationRequestId: "root", expectedRevision: 1, seq: 5, runId: "question-run", requestId: "ask", answers: { "Which?": "answer" } };
    await expect(facade.conversationAction!(ref, { ...action, requestId: "stale" })).rejects.toThrow("Stale native question");
    expect(desktop.state.respondToQuestion).not.toHaveBeenCalled();
    await expect(facade.conversationAction!(ref, action)).rejects.toThrow("not accepted");
    desktop.state.respondToQuestion = vi.fn(async () => { desktop.state.bySession[key].messages[0].question!.status = "answered"; });
    await facade.conversationAction!(ref, action);
    expect(desktop.state.respondToQuestion).toHaveBeenCalledWith(key, 5, { "Which?": "answer" });
  });
  it("derives directory grants from the current row and rejects malformed decisions and native failures", async () => {
    const facade = await desktopTaskFacade();
    desktop.state.bySession[key].messages = [{ seq: 8, role: "grant", text: "", ts: null, path: "G:/project/data", grant: { status: "pending" } }];
    desktop.state.respondToGrant = vi.fn(async () => {});
    const action = { type: "answerGrant" as const, conversationRequestId: "root", expectedRevision: 1, seq: 8, accept: true };
    await expect(facade.conversationAction!(ref, { ...action, accept: "yes" } as never)).rejects.toThrow("Invalid native grant");
    expect(desktop.state.respondToGrant).not.toHaveBeenCalled();
    await expect(facade.conversationAction!(ref, action)).rejects.toThrow("not applied");
    desktop.state.respondToGrant = vi.fn(async () => { desktop.state.bySession[key].messages[0].grant!.status = "granted"; });
    await facade.conversationAction!(ref, action); expect(desktop.state.respondToGrant).toHaveBeenCalledWith(key, 8, true);
  });
  it("reports open timeline status, workspace-exact saved chats and local workspace flags", async () => {
    const facade = await desktopTaskFacade();
    expect(await desktopTaskFacade()).toBe(facade);
    expect(facade.inspect(ref)).toBe("idle");
    desktop.state.bySession[key] = { ...EMPTY_SESSION, messages: [{ seq: 1, role: "grant", text: "", ts: null, grant: { status: "pending" } }], queue: [] } as never;
    expect(facade.inspect(ref)).toBe("awaiting_permission");
    desktop.state.bySession[key] = { ...EMPTY_SESSION, messages: [], queue: [], streaming: true } as never;
    expect(facade.inspect(ref)).toBe("busy");
    expect(facade.known(ref)).toBe(true);
    expect(facade.known({ ...ref, workspacePath: "G:/elsewhere" })).toBe(false);
    expect(facade.workspaces()).toEqual([
      { id: "w1", path: "G:/game", name: "game", remote: false, archived: false },
      { id: "w2", path: "G:/old", name: "old", remote: false, archived: true },
      { id: "w3", path: "/wsl", name: "wsl", remote: true, archived: false },
    ]);
    expect(facade.engines()).toEqual([{ id: "claude", available: true, enabled: true, supportsImages: false, defaultModel: "opus", defaultEffort: "high", defaultProvider: null }]);
  });

  it("sends a new chat's first turn on its pending tab and maps pre-spawn refusals", async () => {
    state({ openTabs: [ref, draft] });
    const facade = await desktopTaskFacade();
    (desktop.state.send as ReturnType<typeof vi.fn>).mockImplementationOnce(async (_p: string, _i: string[], options: { onRunStarted: (r: unknown) => void }) => {
      options.onRunStarted({ runId: "run-a", sessionId: null });
    });
    await expect(facade.sendNew("claude", "G:/game", "prompt", "run-a", { defaultModel: "opus", defaultEffort: "high" })).resolves.toEqual({ runId: "run-a", sessionId: null });
    expect(desktop.state.send).toHaveBeenCalledWith(
      "prompt",
      [],
      expect.objectContaining({
        requestedRunId: "run-a",
        hostNewChat: true,
        hostLaunch: { defaultModel: "opus", defaultEffort: "high" },
      }),
      draft,
    );
    (desktop.state.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new HostChatBusyError());
    await expect(facade.sendNew("claude", "G:/game", "prompt", "run-b")).rejects.toBeInstanceOf(TaskPreSpawnError);
    (desktop.state.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    await expect(facade.sendNew("claude", "G:/game", "prompt", "run-c")).rejects.toThrow(/acknowledgement/);
    await expect(facade.sendNew("claude", "G:/none", "prompt", "run-d")).rejects.toBeInstanceOf(TaskPreSpawnError);
  });

  it("checks full user draft/focus/launch guards in draftReady before sending", async () => {
    state({ openTabs: [ref, { ...draft, model: "opus" }] });
    const facade = await desktopTaskFacade();
    expect(facade.draftReady("claude", "G:/game", { model: "opus" })).toBe(true);
    expect(facade.draftReady("claude", "G:/game", { model: "sonnet" })).toBe(false);
    state({ openTabs: [ref, draft], active: draft });
    expect(facade.draftReady("claude", "G:/game", {})).toBe(false);
    state({ openTabs: [ref, draft], drafts: { [draftKey]: "user typing" } });
    expect(facade.draftReady("claude", "G:/game", {})).toBe(false);
    state({ openTabs: [ref, draft], streamingByKey: { [draftKey]: true } });
    expect(facade.draftReady("claude", "G:/game", {})).toBe(false);
  });

  it("reports settled native runs and rollover signals from real session state", async () => {
    const facade = await desktopTaskFacade();
    expect(facade.settledRun("run-s1", ref)).toBeNull();
    desktop.state.bySession[key] = {
      ...EMPTY_SESSION,
      messages: [],
      queue: [],
      streaming: false,
      settledRunIds: ["run-s1"],
    } as never;
    expect(facade.settledRun("run-s1", ref)).toBeNull();
    settledRunOutcomes.set("run-s1", { key, status: "completed" });
    expect(facade.settledRun("run-s1", ref)).toEqual({ status: "completed" });
    desktop.state.bySession[key] = {
      ...EMPTY_SESSION,
      messages: [],
      queue: [],
      streaming: false,
      interrupted: true,
      settledRunIds: ["run-s2"],
    } as never;
    expect(facade.settledRun("run-s2", ref)).toBeNull();
    settledRunOutcomes.set("run-s2", { key, status: "cancelled" });
    expect(facade.settledRun("run-s2", ref)).toEqual({ status: "cancelled", error: "Original GUI turn was interrupted" });
    desktop.state.bySession[key] = {
      ...EMPTY_SESSION,
      messages: [],
      queue: [],
      streaming: false,
      error: "crash",
      settledRunIds: ["run-s3"],
    } as never;
    expect(facade.settledRun("run-s3", ref)).toBeNull();
    settledRunOutcomes.set("run-s3", { key, status: "failed" });
    expect(facade.settledRun("run-s3", ref)).toEqual({ status: "failed", error: "Native engine failed" });
    expect(facade.settledRun("run-s1", ref)).toEqual({ status: "completed" });
    expect(facade.settledRun("run-s2", ref)).toEqual({ status: "cancelled", error: "Original GUI turn was interrupted" });
    expect(facade.settledRun("run-s1", { ...ref, sessionId: "other" })).toBeNull();

    expect(facade.sessionShouldRollover(ref)).toBe(false);
    desktop.state.bySession[key] = {
      ...EMPTY_SESSION,
      messages: [],
      queue: [],
      compaction: { automatic: true, startedAt: 1 },
    } as never;
    expect(facade.sessionShouldRollover(ref)).toBe(true);
    desktop.state.bySession[key] = {
      ...EMPTY_SESSION,
      messages: [],
      queue: [],
      usage: { input_tokens: 175_000, output_tokens: 5_000, context_window: 200_000 },
    } as never;
    expect(facade.sessionShouldRollover(ref)).toBe(true);
    desktop.state.bySession[key] = {
      ...EMPTY_SESSION,
      messages: [],
      queue: [],
      usage: { input_tokens: 175_000, output_tokens: 5_000, context_window: 200_000, usage_scope: "turn" },
    } as never;
    expect(facade.sessionShouldRollover(ref)).toBe(false);
  });

  it("interrupts only a streaming tab that this run still routes to", async () => {
    const facade = await desktopTaskFacade();
    expect(await facade.interrupt("run-x")).toBe(false);
    runRouting.set("run-x", key);
    expect(await facade.interrupt("run-x")).toBe(false);
    desktop.state.bySession[key] = { ...EMPTY_SESSION, messages: [], queue: [], streaming: true } as never;
    expect(await facade.interrupt("run-x")).toBe(true);
    expect(desktop.state.interrupt).toHaveBeenCalledWith(ref);
    expect(facade.liveRun("run-x")).toBe(key);
  });

  it("does not report Stop for a private turn that completed before its launch ACK", async () => {
    const runId = "completed-private-run", privateKey = hostPendingKey("claude", runId);
    state({ bySession: { [privateKey]: { ...EMPTY_SESSION, messages: [], queue: [], streaming: false,
      draftLaunching: true, hostTaskOrigin: { engine: "claude", workspacePath: "G:/game", runId }, settledRunIds: [runId] } } });
    settledRunOutcomes.set(runId, { key: privateKey, status: "completed" });
    const facade = await desktopTaskFacade();
    expect(await facade.interrupt(runId)).toBe(false);
    expect(desktop.state.interrupt).not.toHaveBeenCalled();
    expect(facade.settledRun(runId, null)).toEqual({ status: "completed" });
  });

  it("opens saved chats in the background only", async () => {
    state({ openTabs: [] });
    const facade = await desktopTaskFacade();
    await facade.openBackground(ref);
    expect(desktop.state.selectSession).toHaveBeenCalledWith("claude", S1, "G:/game", { background: true });
  });

  it("accepts only native-shaped session ids", () => {
    expect(plausibleSessionId("claude", S1)).toBe(true);
    expect(plausibleSessionId("claude", "not-a-uuid")).toBe(false);
    expect(plausibleSessionId("codex", "thread-abc")).toBe(true);
    expect(plausibleSessionId("codex", "has space")).toBe(false);
  });
});


describe("task focus and retained selections", () => {
  it("selects the requested chat then unminimizes, shows and focuses the native host window", async () => {
    vi.clearAllMocks();
    const facade = await desktopTaskFacade();
    await facade.focus(ref);
    expect(desktop.state.selectSession).toHaveBeenCalledWith(ref.engine, ref.sessionId, ref.workspacePath);
    expect(desktop.window.unminimize).toHaveBeenCalledOnce();
    expect(desktop.window.show).toHaveBeenCalledOnce();
    expect(desktop.window.setFocus).toHaveBeenCalledOnce();
    expect(desktop.window.unminimize.mock.invocationCallOrder[0]).toBeLessThan(desktop.window.show.mock.invocationCallOrder[0]);
    expect(desktop.window.show.mock.invocationCallOrder[0]).toBeLessThan(desktop.window.setFocus.mock.invocationCallOrder[0]);
    state({ openTabs: [ref, draft] });
    await facade.focusDraft(draft.engine, draft.workspacePath);
    expect(desktop.state.focusTab).toHaveBeenCalledWith(draft.engine, null, draft.workspacePath);
    expect(desktop.window.setFocus).toHaveBeenCalledTimes(2);
  });
  it.each(["model", "effort", "providerId"])("compares retained %s instead of engine defaults", async (field) => {
    desktop.state.bySession[key] = { ...EMPTY_SESSION, messages: [], queue: [], activeModel: "full-model", activeEffort: "max", activeProvider: "channel-a" };
    const facade = await desktopTaskFacade();
    const launch = { model: "full-model", effort: "max", providerId: "channel-a" };
    expect(facade.selectionMatches!(ref, launch)).toBe(true);
    expect(facade.selectionMatches!(ref, { ...launch, [field]: "different" })).toBe(false);
  });
});


it("passes provider pinning and late verification to the actual store send for both routes", async () => {
  state({ openTabs: [ref, draft] });
  const facade = await desktopTaskFacade();
  const launch = { model: "full-model", effort: "max", providerId: "channel-a", defaultProvider: "channel-a" };
  const beforeSend = vi.fn(async () => {});
  (desktop.state.send as ReturnType<typeof vi.fn>).mockImplementation(async (_p: string, _i: string[], options: any) => {
    await options.hostBeforeSend(); options.onRunStarted({ runId: options.requestedRunId, sessionId: null });
  });
  await facade.sendNew("claude", "G:/game", "new", "new-run", launch, beforeSend, ["G:/img1.png"]);
  await facade.sendExisting(ref, "existing", "existing-run", launch, beforeSend, ["G:/img2.png"]);
  expect(beforeSend).toHaveBeenCalledTimes(2);
  expect(desktop.state.send).toHaveBeenNthCalledWith(1, "new", ["G:/img1.png"], expect.objectContaining({ hostLaunch: launch, hostBeforeSend: beforeSend }), draft);
  expect(desktop.state.send).toHaveBeenNthCalledWith(2, "existing", ["G:/img2.png"], expect.objectContaining({ hostLaunch: launch, hostBeforeSend: beforeSend }), ref);
});
