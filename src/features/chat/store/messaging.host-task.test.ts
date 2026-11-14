import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMessagingActions } from "./messaging";
import { backgroundDraftBlockReason, createTabActions, isBackgroundDraftAvailable } from "./tabs";
import { handleEngineEvents, settledRuns, settledRunOutcomes, settleOrphanedRuns } from "./engine-events";
import { useSidechatStore } from "@/features/sidechat/store";
import { getConversationModeState } from "@/features/plugins/conversation/state";
import { EMPTY_SESSION, adoptedDraftKeys, runRouting, flushPendingStreams, reconcileOrphanRuns } from "./stream";
import { hasPendingHostEngine, hostPendingKey } from "./host-pending-chat";
import { sessionKey } from "./persistence";
import { HostChatBusyError, type ChatStore } from "./types";

const mocks = vi.hoisted(() => ({
  ipc: { sendMessage: vi.fn(), sendFollowUp: vi.fn(async () => true), rememberSessionModel: vi.fn(async () => {}), rememberSessionEffort: vi.fn(async () => {}), rememberSessionProvider: vi.fn(async () => {}),
    resolveEnabledBuiltInAgent: vi.fn(async () => ({ name: "Agent", prompt: "Instructions" })),
    rescanSessions: vi.fn(async () => {}),
    interruptSession: vi.fn(async () => false),
    grantScope: vi.fn(async (path: string) => path),
  },
  getSelectedAgent: vi.fn(() => null as { id: string; source: "builtIn"; name: string } | null),
}));
vi.mock("@/lib/ipc", () => ({ ipc: mocks.ipc }));
vi.mock("@/features/agents/selected-agent", () => ({ getSelectedAgent: mocks.getSelectedAgent, clearSelectedAgent: vi.fn(), migrateSelectedAgent: vi.fn() }));

const user = { engine: "claude", sessionId: "22222222-2222-2222-2222-222222222222", workspacePath: "G:/two" };
const draft = { engine: "claude", sessionId: null, workspacePath: "G:/task" };
const draftKey = sessionKey("claude", null, "G:/task");

function fixture(extra: Partial<ChatStore> = {}) {
  let state = {
    initialized: true, archivedSessionKeys: {}, active: user, openTabs: [user], engines: [], permission: "manual",
    models: { claude: "user-default" }, efforts: { claude: "high" }, providers: {}, drafts: {}, streamingByKey: {}, retryingByKey: {},
    bySession: {}, unseen: {}, refreshSessionUsage: vi.fn(async () => {}), activeEngine: "claude",
    ...extra,
  } as unknown as ChatStore;
  const set = (patch: unknown) => { state = { ...state, ...(typeof patch === "function" ? (patch as (s: ChatStore) => Partial<ChatStore>)(state) : patch as Partial<ChatStore>) }; };
  const get = () => state;
  const actions = createMessagingActions({ get, set, subscribe: () => () => {}, loadHistoryPage: vi.fn() });
  const tabs = createTabActions({ get, set });
  return { actions, tabs, get, set };
}

beforeEach(() => {
  runRouting.clear(); adoptedDraftKeys.clear(); settledRuns.clear(); settledRunOutcomes.clear(); vi.clearAllMocks();
  mocks.getSelectedAgent.mockReturnValue(null);
  mocks.ipc.sendMessage.mockImplementation(async (request: { runId: string }) => ({ runId: request.runId, sessionId: null }));
});

it("refuses a direct host send into an unrecovered history shell without changing its content or error", async () => {
  const key = sessionKey(user.engine, user.sessionId, user.workspacePath);
  const shell = { ...EMPTY_SESSION, messages: [], subagentHistory: [], historyReloadRequired: true,
    historyReloadError: "history temporarily unavailable", error: "history temporarily unavailable" };
  const f = fixture({ bySession: { [key]: shell } });
  await expect(f.actions.send("must wait for history", [], { requestedRunId: "unloaded-host-send" }, user)).rejects.toBeInstanceOf(HostChatBusyError);
  expect(f.get().bySession[key]).toBe(shell);
  expect(mocks.ipc.sendMessage).not.toHaveBeenCalled();
});

describe("independent host first turn", () => {
  function independent(engine = "agy") {
    const own = { engine, sessionId: null, workspacePath: "G:/task", model: "private-user-model", provider: "private-user-channel" };
    const userKey = sessionKey(engine, null, own.workspacePath), runId = `independent-${engine}`;
    const privateKey = hostPendingKey(engine, runId), nativeId = "11111111-1111-1111-1111-111111111111";
    const userState = { ...EMPTY_SESSION, messages: [], queue: [] };
    const drafts = { [userKey]: "承接上一会话：需要保留的旧稿🙂" };
    const f = fixture({ active: own, openTabs: [own], drafts, sessions: [], workspaces: [{ id: "task", path: "G:/task" }], archivedWorkspaces: [],
      engines: [{ id: engine, available: true, enabled: true }], bySession: { [userKey]: userState },
    } as never);
    const target = { engine, sessionId: null, workspacePath: "G:/task", model: "task-model", effort: "high", provider: "task-channel" } as const;
    const options = { hostNewChat: true as const, hostIndependentDraft: true as const, requestedRunId: runId,
      hostLaunch: { model: "task-model", effort: "high", providerId: "task-channel", defaultModel: "task-model", defaultEffort: "high", defaultProvider: "task-channel" } };
    const deps = { get: f.get, set: f.set, drainQueue: vi.fn(), markUnseenIfBackground: vi.fn(), upsertSessionMeta: vi.fn() };
    const event = (kind: "session" | "delta" | "done" | "error" | "retry", seq: number, data: unknown, sessionId: string | null = null, eventRun = runId) =>
      ({ engine, runId: eventRun, sessionId, kind, seq, data });
    const protectedState = () => {
      expect(f.get().active).toBe(own); expect(f.get().drafts).toBe(drafts);
      expect(f.get().bySession[userKey]).toBe(userState); expect(f.get().openTabs[0]).toBe(own);
      expect(mocks.getSelectedAgent).not.toHaveBeenCalled(); expect(mocks.ipc.resolveEnabledBuiltInAgent).not.toHaveBeenCalled();
    };
    return { ...f, own, userKey, privateKey, nativeId, runId, target, options, deps, event, protectedState };
  }
  it.each(["agy", "codex", "claude"])("starts %s independently of a focused text draft and its old adoption alias", async engine => {
    const f = independent(engine), nativeKey = sessionKey(engine, f.nativeId, "G:/task");
    adoptedDraftKeys.set(f.userKey, `${engine}/unrelated-old-chat`);
    mocks.getSelectedAgent.mockReturnValue({ id: "private-pin", source: "builtIn", name: "Private" });
    mocks.ipc.sendMessage.mockResolvedValueOnce({ runId: f.runId, sessionId: f.nativeId });
    await f.actions.send("workbench original prompt", [], f.options, f.target);
    expect(mocks.ipc.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ engine, runId: f.runId, sessionId: null,
      model: "task-model", effort: "high", providerId: "task-channel", prompt: "workbench original prompt" }));
    f.protectedState(); expect(f.get().bySession[f.privateKey]).toBeUndefined();
    expect(f.get().bySession[nativeKey].messages[0].text).toBe("workbench original prompt");
    expect(f.get().openTabs.filter(t => t.sessionId === f.nativeId)).toHaveLength(1);
    expect(adoptedDraftKeys.get(f.userKey)).toBe(`${engine}/unrelated-old-chat`);
    await expect(f.actions.send("do not replay", [], f.options, f.target)).rejects.toBeInstanceOf(HostChatBusyError);
    expect(mocks.ipc.sendMessage).toHaveBeenCalledTimes(1);
  });
  it.each(["ack", "session", "done-ack", "done-session", "done-envelope"])("preserves streaming text and terminal proof across %s adoption", async order => {
    const f = independent(), response = Promise.withResolvers<{ runId: string; sessionId: string | null }>();
    mocks.ipc.sendMessage.mockReturnValueOnce(response.promise);
    const sending = f.actions.send("first", [], f.options, f.target);
    await vi.waitFor(() => expect(mocks.ipc.sendMessage).toHaveBeenCalledOnce());
    handleEngineEvents([f.event("delta", 1, "中文🙂正文")], f.deps);
    if (order === "session") handleEngineEvents([f.event("session", 2, f.nativeId)], f.deps);
    if (order.startsWith("done")) handleEngineEvents([f.event("done", 3, { usage: null }, order === "done-envelope" ? f.nativeId : null)], f.deps);
    response.resolve({ runId: f.runId, sessionId: ["done-session", "done-envelope", "session"].includes(order) ? null : f.nativeId });
    await sending;
    if (order === "done-session") handleEngineEvents([f.event("session", 4, f.nativeId)], f.deps);
    flushPendingStreams(f.set);
    const nativeKey = sessionKey("agy", f.nativeId, "");
    expect(f.get().bySession[f.privateKey]).toBeUndefined();
    expect(f.get().bySession[nativeKey].messages.filter(m => m.role === "assistant").map(m => m.text).join("")).toBe("中文🙂正文");
    if (!order.startsWith("done")) handleEngineEvents([f.event("done", 5, { usage: null }, f.nativeId)], f.deps);
    expect(runRouting.has(f.runId)).toBe(false);
    expect(settledRunOutcomes.get(f.runId)).toEqual({ key: nativeKey, status: "completed" });
    expect(f.get().bySession[nativeKey].streaming).toBe(false); f.protectedState();
    expect(f.get().openTabs.filter(t => t.sessionId === f.nativeId)).toHaveLength(1);
  });
  it("cancels before native invocation while row correlation persists, leaving the user draft intact", async () => {
    const f = independent();
    await expect(f.actions.send("cancel this", [], { ...f.options, hostUserRow: async () => {
      await f.actions.interrupt(undefined, f.runId);
    } }, f.target)).rejects.toBeInstanceOf(HostChatBusyError);
    expect(mocks.ipc.sendMessage).not.toHaveBeenCalled(); expect(f.get().bySession[f.privateKey]).toBeUndefined(); f.protectedState();
  });
  it("moves retry and unread state with an ACK-only adoption and clears retry on resumed content", async () => {
    const f = independent(), response = Promise.withResolvers<{ runId: string; sessionId: string | null }>();
    mocks.ipc.sendMessage.mockReturnValueOnce(response.promise);
    const sending = f.actions.send("first", [], f.options, f.target);
    await vi.waitFor(() => expect(mocks.ipc.sendMessage).toHaveBeenCalledOnce());
    handleEngineEvents([f.event("retry", 1, { attempt: 1, max: 3, message: "retrying" })], f.deps);
    f.get().unseen[f.privateKey] = true;
    response.resolve({ runId: f.runId, sessionId: f.nativeId }); await sending;
    const nativeKey = sessionKey("agy", f.nativeId, "");
    expect(f.get().retryingByKey[nativeKey]).toBe(true); expect(f.get().retryingByKey[f.privateKey]).toBeUndefined();
    expect(f.get().unseen[nativeKey]).toBe(true); expect(f.get().unseen[f.privateKey]).toBeUndefined();
    handleEngineEvents([f.event("delta", 2, "recovered", f.nativeId)], f.deps); flushPendingStreams(f.set);
    expect(f.get().retryingByKey[nativeKey]).toBeUndefined();
    expect(f.get().bySession[nativeKey].retry).toBeNull(); f.protectedState();
  });
  it("retains an uncertain private delivery for exact Stop/event reconciliation", async () => {
    const f = independent(); mocks.ipc.sendMessage.mockRejectedValueOnce(new Error("native reply lost"));
    await expect(f.actions.send("uncertain delivery", [], f.options, f.target)).rejects.toMatchObject({ outcomeUnknown: true });
    expect(f.get().bySession[f.privateKey]).toMatchObject({ streaming: true, queueParked: true });
    expect(runRouting.get(f.runId)).toBe(f.privateKey); f.protectedState();
    await expect(f.actions.send("do not replay", [], f.options, f.target)).rejects.toBeInstanceOf(HostChatBusyError);
    expect(mocks.ipc.sendMessage).toHaveBeenCalledOnce();
  });
  it("releases engine adoption after an uncertain private run is confirmed absent without replaying it", async () => {
    const f = independent("codex");
    mocks.ipc.sendMessage.mockResolvedValueOnce({ runId: "unexpected-run", sessionId: null });
    await expect(f.actions.send("uncertain delivery", [], f.options, f.target)).rejects.toMatchObject({ outcomeUnknown: true });
    expect(hasPendingHostEngine(f.get().bySession, "codex")).toBe(true);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60_000);
    try { await reconcileOrphanRuns(async () => [], runs => settleOrphanedRuns(f.set, runs)); }
    finally { clock.mockRestore(); }
    expect(runRouting.has(f.runId)).toBe(false);
    expect(f.get().bySession[f.privateKey]).toMatchObject({ streaming: false, queueParked: true });
    expect(hasPendingHostEngine(f.get().bySession, "codex")).toBe(false);
    await expect(f.actions.send("do not replay", [], f.options, f.target)).rejects.toBeInstanceOf(HostChatBusyError);
    expect(mocks.ipc.sendMessage).toHaveBeenCalledOnce(); f.protectedState();
  });
  it.each(["agy", "codex", "claude"])("does not cancel a completed private %s turn while its ACK and session identity are late", async engine => {
    const f = independent(engine), response = Promise.withResolvers<{ runId: string; sessionId: string | null }>();
    mocks.ipc.sendMessage.mockReturnValueOnce(response.promise);
    const sending = f.actions.send("completed before stop", [], f.options, f.target);
    await vi.waitFor(() => expect(mocks.ipc.sendMessage).toHaveBeenCalledOnce());
    handleEngineEvents([f.event("done", 1, { usage: null })], f.deps);
    await f.actions.interrupt(undefined, f.runId);
    response.resolve({ runId: f.runId, sessionId: null }); await sending;
    handleEngineEvents([f.event("session", 2, f.nativeId)], f.deps);
    const nativeKey = sessionKey(engine, f.nativeId, "G:/task"), native = f.get().bySession[nativeKey];
    expect(native.interrupted).toBeFalsy(); expect(native.queueParked).toBeFalsy();
    expect(native.streaming).toBe(false); expect(runRouting.has(f.runId)).toBe(false);
    expect(settledRunOutcomes.get(f.runId)).toEqual({ key: nativeKey, status: "completed" });
    expect(mocks.ipc.interruptSession).not.toHaveBeenCalled(); f.protectedState();
  });
  it("adopts a routed user start whose tab closed while an unrelated private start is pending", async () => {
    const f = independent("claude");
    await f.actions.send("private start", [], f.options, f.target);
    const userRun = "closed-user-run", userWorkspace = "G:/closed-user", userPending = sessionKey("claude", null, userWorkspace);
    f.set({ bySession: { ...f.get().bySession, [userPending]: { ...EMPTY_SESSION, messages: [{ seq: 0, role: "user", text: "own message", ts: null }], queue: [], streaming: true, nativeTaskRunId: userRun } } });
    runRouting.set(userRun, userPending);
    handleEngineEvents([f.event("session", 1, f.nativeId, f.nativeId, userRun)], f.deps);
    const nativeKey = sessionKey("claude", f.nativeId, userWorkspace);
    expect(runRouting.get(userRun)).toBe(nativeKey);
    expect(f.get().bySession[nativeKey].messages[0].text).toBe("own message");
    expect(f.get().bySession[userPending]).toBeUndefined();
    expect(f.deps.upsertSessionMeta).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: userWorkspace }));
    expect(runRouting.get(f.runId)).toBe(f.privateKey); f.protectedState();
  });
  it("binds a native permission envelope to its private chat without approving it or touching user input", async () => {
    const f = independent(), response = Promise.withResolvers<{ runId: string; sessionId: string | null }>();
    mocks.ipc.sendMessage.mockReturnValueOnce(response.promise);
    const sending = f.actions.send("requires approval", [], f.options, f.target);
    await vi.waitFor(() => expect(mocks.ipc.sendMessage).toHaveBeenCalledOnce());
    handleEngineEvents([{ engine: "agy", runId: f.runId, sessionId: f.nativeId, kind: "permission_denied", seq: 1,
      data: { tool: "Read", path: "G:/protected", message: "permission needed" } }], f.deps);
    response.resolve({ runId: f.runId, sessionId: null }); await sending;
    const native = f.get().bySession[sessionKey("agy", f.nativeId, "")];
    expect(native.messages.some(m => m.grant?.status === "pending")).toBe(true);
    expect(f.get().bySession[f.privateKey]).toBeUndefined();
    expect(mocks.ipc.sendMessage).toHaveBeenCalledOnce(); f.protectedState();
  });
  it("stops a private run before ACK and repeats the stop after late native registration", async () => {
    const f = independent(), response = Promise.withResolvers<{ runId: string; sessionId: string | null }>();
    mocks.ipc.sendMessage.mockReturnValueOnce(response.promise);
    const sending = f.actions.send("stop this", [], f.options, f.target);
    await vi.waitFor(() => expect(mocks.ipc.sendMessage).toHaveBeenCalledOnce());
    await f.actions.interrupt(undefined, f.runId);
    expect(mocks.ipc.interruptSession).toHaveBeenCalledWith(f.runId);
    response.resolve({ runId: f.runId, sessionId: f.nativeId }); await sending;
    expect(mocks.ipc.interruptSession).toHaveBeenCalledWith(f.nativeId);
    expect(f.get().bySession[sessionKey("agy", f.nativeId, "")].interrupted).toBe(true);
    expect(runRouting.has(f.runId)).toBe(false); f.protectedState();
  });
  it("does not use a concurrent user pending run as the origin of a mismatched task run", async () => {
    const f = independent(), response = Promise.withResolvers<{ runId: string; sessionId: string | null }>();
    f.get().bySession[f.userKey].streaming = true;
    f.get().bySession[f.userKey].throughput = { runId: "user-run", startedAt: Date.now() } as never;
    runRouting.set("user-run", f.userKey);
    mocks.ipc.sendMessage.mockReturnValueOnce(response.promise);
    const sending = f.actions.send("uncertain", [], f.options, f.target);
    const rejected = expect(sending).rejects.toMatchObject({ outcomeUnknown: true });
    await vi.waitFor(() => expect(mocks.ipc.sendMessage).toHaveBeenCalledOnce());
    handleEngineEvents([f.event("session", 1, "unexpected-native", "unexpected-native", "unexpected-run")], f.deps);
    response.resolve({ runId: "unexpected-run", sessionId: "unexpected-native" }); await rejected;
    f.protectedState(); expect(f.get().openTabs).toEqual([f.own]);
    expect(runRouting.get("user-run")).toBe(f.userKey);
    expect(f.get().bySession[f.privateKey].queueParked).toBe(true);
  });
  it.each(["both", "throughput", "route"])("a stopped private run's late ACK cannot interrupt a successor on its native session (%s)", async evidence => {
    const f = independent(), response = Promise.withResolvers<{ runId: string; sessionId: string | null }>();
    mocks.ipc.sendMessage.mockReturnValueOnce(response.promise);
    const sending = f.actions.send("original", [], f.options, f.target);
    await vi.waitFor(() => expect(mocks.ipc.sendMessage).toHaveBeenCalledOnce());
    await f.actions.interrupt(undefined, f.runId);
    handleEngineEvents([f.event("done", 2, { usage: null }, f.nativeId)], f.deps);
    const nativeKey = sessionKey("agy", f.nativeId, "");
    expect(settledRunOutcomes.get(f.runId)).toEqual({ key: nativeKey, status: "cancelled" });
    if (evidence !== "route") f.get().bySession[nativeKey].throughput = { runId: "successor", startedAt: Date.now() } as never;
    f.get().bySession[nativeKey].streaming = true; f.get().bySession[nativeKey].interrupted = true;
    if (evidence !== "throughput") runRouting.set("successor", nativeKey);
    const successorState = f.get().bySession[nativeKey];
    response.resolve({ runId: f.runId, sessionId: f.nativeId }); await sending;
    expect(mocks.ipc.interruptSession).not.toHaveBeenCalledWith(f.nativeId);
    expect(mocks.ipc.interruptSession).toHaveBeenCalledExactlyOnceWith(f.runId);
    expect(f.get().bySession[nativeKey]).toBe(successorState);
    if (evidence !== "throughput") expect(runRouting.get("successor")).toBe(nativeKey);
    f.protectedState();
  });
});

describe("host continuation native delivery seam", () => {
  const target = { engine: "codex", sessionId: "native-coordinator", workspacePath: "G:/task" };
  const key = sessionKey(target.engine, target.sessionId, target.workspacePath);
  function streaming(engine = "codex") {
    const tab = engine === "codex" ? target : { ...user, workspacePath: "G:/task" };
    const k = sessionKey(tab.engine, tab.sessionId, tab.workspacePath);
    runRouting.set("live-run", k);
    const f = fixture({ openTabs: [user, tab], models: { codex: "model", claude: "model" }, efforts: {}, providers: {},
      bySession: { [k]: { ...EMPTY_SESSION, messages: [], queue: [], streaming: true, nativeActivity: "waiting",
        codexRunId: engine === "codex" ? "live-run" : undefined, nativeTaskRunId: engine === "claude" ? "live-run" : undefined,
        liveLaunch: { model: "model", effort: null, provider: null, permission: "manual" },
      } } as never,
    });
    return { ...f, tab, key: k };
  }
  it.each([true, false])("uses the latest context snapshot arriving during the durable fence for follow-up and rollback (accepted=%s)", async accepted => {
    const f = streaming("claude");
    const snapshot = (used: number) => ({
      context_usage_kind: "current_context", context_usage_source: "acp_usage_update",
      context_usage: { input_tokens: used, output_tokens: 0 }, model_context_window: 1_000_000,
    });
    f.get().bySession[f.key].usage = snapshot(10_000);
    let latest: unknown;
    mocks.ipc.sendFollowUp.mockImplementationOnce(async () => {
      expect(f.get().bySession[f.key].usage).toMatchObject({ ...snapshot(40_000), context_usage_stale: true });
      return accepted;
    });
    const pending = f.actions.sendWhileBusy("new request", [], { requestedRunId: "next", hostContinuation: {
      beforeDelivery: async () => {
        await Promise.resolve();
        // Exercise the shared mutation/rollback with an ACP-shaped retained reading.
        f.set((state: ChatStore) => ({ bySession: { ...state.bySession,
          [f.key]: { ...state.bySession[f.key], usage: snapshot(40_000) },
        } }));
        latest = f.get().bySession[f.key].usage;
      }, onReceived: vi.fn(),
    } }, f.tab);
    if (accepted) await pending;
    else {
      await expect(pending).rejects.toBeInstanceOf(HostChatBusyError);
      expect(f.get().bySession[f.key].usage).toBe(latest);
      expect(f.get().bySession[f.key].usage).not.toHaveProperty("context_usage_stale");
    }
    expect(f.get().bySession[f.key].usage).toMatchObject(snapshot(40_000));
  });
  it.each(["codex", "claude"])("trusted parent input precedes queued user rows without consuming them: %s", async engine => {
    const f = streaming(engine);
    const queued = { id: "user-pending", text: "user draft", images: [], queuedAt: 1 };
    f.get().bySession[f.key].queue = [queued];
    await f.actions.sendWhileBusy("child question", [], { requestedRunId: "parent-input", hostContinuation: {
      priority: true, beforeDelivery: async () => {}, onReceived: vi.fn(),
    } }, f.tab);
    expect(mocks.ipc.sendFollowUp).toHaveBeenCalledOnce();
    expect(mocks.ipc.sendMessage).not.toHaveBeenCalled();
    expect(f.get().bySession[f.key].queue).toEqual([queued]);
    expect(f.get().active).toEqual(user);
  });
  it.each(["codex", "claude"])("reports actual %s ACK after the durable fence and preserves the exact target", async engine => {
    const f = streaming(engine); const order: string[] = [];
    const beforeDelivery = vi.fn(async () => { order.push("fence"); expect(mocks.ipc.sendFollowUp).not.toHaveBeenCalled(); });
    const onReceived = vi.fn(() => { order.push("received"); });
    mocks.ipc.sendFollowUp.mockImplementationOnce(async () => { order.push("native"); return true; });
    await f.actions.sendWhileBusy("new constraint", [], { requestedRunId: "unused-turn", hostContinuation: { beforeDelivery, onReceived } }, f.tab);
    expect(order).toEqual(["fence", "native", "received"]);
    expect(beforeDelivery).toHaveBeenCalledWith(engine === "codex" ? "steer" : "live", "live-run");
    expect(onReceived).toHaveBeenCalledWith(engine === "codex" ? "steer" : "live", "live-run");
    expect(mocks.ipc.sendMessage).not.toHaveBeenCalled();
    expect(mocks.ipc.sendFollowUp).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "live-run", engine, workspacePath: "G:/task" }));
    expect(f.get().bySession[f.key].queue).toEqual([]);
    expect(f.get().active).toEqual(user);
  });
  it.each(["codex", "claude"])("correlates the exact %s user row before native input without rewriting text", async engine => {
    const f = streaming(engine); const prompt = "user + injected coordinator protocol";
    let persisted = false;
    const hostUserRow = vi.fn(async row => {
      expect(row).toMatchObject({ runId: "live-run", text: prompt, seq: f.get().bySession[f.key].messages.at(-1)!.seq });
      expect(row.ts).toBeTypeOf("string"); expect(mocks.ipc.sendFollowUp).not.toHaveBeenCalled(); persisted = true;
    });
    mocks.ipc.sendFollowUp.mockImplementationOnce(async () => { expect(persisted).toBe(true); return true; });
    await f.actions.sendWhileBusy(prompt, [], { requestedRunId: "next", hostUserRow, hostContinuation: { beforeDelivery: async () => {}, onReceived: vi.fn() } }, f.tab);
    expect(hostUserRow).toHaveBeenCalledOnce(); expect(f.get().bySession[f.key].messages.at(-1)).toMatchObject({ text: prompt });
    expect(f.get().bySession[f.key].messages.at(-1)).not.toHaveProperty("displayText");
  });
  it("refuses native input if stop wins while exact-row correlation is persisting", async () => {
    const f = streaming();
    await expect(f.actions.sendWhileBusy("injected", [], { requestedRunId: "next", hostUserRow: async () => { f.get().bySession[f.key].queueParked = true; },
      hostContinuation: { beforeDelivery: async () => {}, onReceived: vi.fn() },
    }, f.tab)).rejects.toBeInstanceOf(HostChatBusyError);
    expect(mocks.ipc.sendFollowUp).not.toHaveBeenCalled(); expect(f.get().bySession[f.key].queue).toHaveLength(0);
  });
  it.each(["codex", "claude"])("rechecks the current %s tab choice after live row persistence", async engine => {
    const f = streaming(engine), onReceived = vi.fn();
    await expect(f.actions.sendWhileBusy("follow", [], {
      requestedRunId: "next", hostLaunch: { expectedNativeSelection: { model: null, effort: null, providerId: null } },
      hostUserRow: async () => { f.get().openTabs = f.get().openTabs.map(tab => tab.sessionId === f.tab.sessionId ? { ...tab, model: "changed-tab-model" } : tab); },
      hostContinuation: { beforeDelivery: async () => {}, onReceived },
    }, f.tab)).rejects.toBeInstanceOf(HostChatBusyError);
    expect(mocks.ipc.sendFollowUp).not.toHaveBeenCalled(); expect(onReceived).not.toHaveBeenCalled();
    expect(f.get().bySession[f.key].messages).toHaveLength(0);
    expect(f.get().openTabs.find(tab => tab.sessionId === f.tab.sessionId)?.model).toBe("changed-tab-model");
  });
  it("a busy unsupported native state stays in the host inbox without a composer queue duplicate", async () => {
    const f = streaming(); f.get().bySession[key].liveLaunch = undefined;
    const beforeDelivery = vi.fn(async () => {}); const onReceived = vi.fn();
    await expect(f.actions.sendWhileBusy("queued", [], { requestedRunId: "next", hostContinuation: { beforeDelivery, onReceived } }, target)).rejects.toBeInstanceOf(HostChatBusyError);
    expect(beforeDelivery).not.toHaveBeenCalled(); expect(onReceived).not.toHaveBeenCalled();
    expect(f.get().bySession[key].queue).toEqual([]); expect(mocks.ipc.sendFollowUp).not.toHaveBeenCalled();
  });
  it.each(["codex", "claude"])("a lost %s ACK does not requeue or report received", async engine => {
    const f = streaming(engine); const onReceived = vi.fn();
    mocks.ipc.sendFollowUp.mockRejectedValueOnce(new Error("delivery_outcome_unknown: transport disconnected"));
    await expect(f.actions.sendWhileBusy("uncertain", [], { requestedRunId: "next", hostContinuation: { beforeDelivery: async () => {}, onReceived } }, f.tab)).rejects.toThrow("transport disconnected");
    expect(onReceived).not.toHaveBeenCalled(); expect(f.get().bySession[f.key].queue).toEqual([]);
    expect(mocks.ipc.sendMessage).not.toHaveBeenCalled();
  });
  it("rechecks a changed target after a delayed durable fence before native delivery", async () => {
    const f = streaming();
    await expect(f.actions.sendWhileBusy("race", [], { requestedRunId: "next", hostContinuation: {
      beforeDelivery: async () => { f.get().bySession[key].codexRunId = "other-run"; }, onReceived: vi.fn(),
    } }, target)).rejects.toBeInstanceOf(HostChatBusyError);
    expect(mocks.ipc.sendFollowUp).not.toHaveBeenCalled(); expect(f.get().bySession[key].queue).toEqual([]);
  });
  it("an idle same-session turn fences before committing and acknowledges only after IPC", async () => {
    const f = fixture({ openTabs: [user, target], bySession: { [key]: { ...EMPTY_SESSION, messages: [], queue: [] } } });
    const onReceived = vi.fn(); const beforeDelivery = vi.fn(async () => { expect(f.get().bySession[key].messages).toHaveLength(0); });
    mocks.ipc.sendMessage.mockImplementationOnce(async req => { expect(onReceived).not.toHaveBeenCalled(); return { runId: req.runId, sessionId: target.sessionId }; });
    await f.actions.sendWhileBusy("continue", [], { requestedRunId: "exact-run", hostContinuation: { beforeDelivery, onReceived } }, target);
    expect(beforeDelivery).toHaveBeenCalledWith("turn", "exact-run"); expect(onReceived).toHaveBeenCalledWith("turn", "exact-run");
    expect(mocks.ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: target.sessionId, runId: "exact-run" }));
  });

  function idle(engine = "codex") {
    const tab = { ...target, engine };
    const k = sessionKey(engine, tab.sessionId, tab.workspacePath);
    const history = { seq: 7, role: "user" as const, text: "continue", ts: "earlier" };
    const previous = { ...EMPTY_SESSION, messages: [history], queue: [], error: "previous error", turnUsage: { tokens: 42 } };
    const f = fixture({ openTabs: [user, tab], drafts: { [k]: "unsent draft" }, bySession: { [k]: previous } });
    return { ...f, tab, key: k, history, previous };
  }

  it.each([false, true])("runs the final idle fence after correlation (row callback: %s)", async withRow => {
    const f = idle(); const order: string[] = [];
    const hostBeforeSend = vi.fn(async () => { order.push(f.get().bySession[f.key].streaming ? "final" : "preflight"); });
    mocks.ipc.sendMessage.mockImplementationOnce(async req => { order.push("native"); return { runId: req.runId, sessionId: target.sessionId }; });
    await f.actions.sendWhileBusy("continue", [], {
      requestedRunId: "final-fence", hostBeforeSend,
      ...(withRow ? { hostUserRow: async () => { order.push("row"); } } : {}),
      hostContinuation: { beforeDelivery: async () => { order.push("durable"); }, onReceived: () => { order.push("received"); } },
    }, f.tab);
    expect(order).toEqual(["preflight", "durable", ...(withRow ? ["row"] : []), "final", "native", "received"]);
  });

  it.each(["activeModel", "activeEffort", "activeProvider", "tabModel"] as const)("refuses and rolls back an unsubmitted turn when %s changes during row persistence", async field => {
    const f = idle();
    Object.assign(f.get().bySession[f.key], { activeModel: "model", activeEffort: "xhigh", activeProvider: "channel" });
    const onReceived = vi.fn();
    await expect(f.actions.sendWhileBusy("continue", [], {
      requestedRunId: "selection-race", hostLaunch: { model: "model", effort: "xhigh", providerId: "channel" },
      hostUserRow: async () => {
        if (field === "tabModel") f.get().openTabs = f.get().openTabs.map(tab => tab.sessionId === f.tab.sessionId ? { ...tab, model: "new-choice" } : tab);
        else f.get().bySession[f.key] = { ...f.get().bySession[f.key], [field]: "new-choice" };
      }, hostContinuation: { beforeDelivery: async () => {}, onReceived },
    }, f.tab)).rejects.toBeInstanceOf(HostChatBusyError);
    expect(mocks.ipc.sendMessage).not.toHaveBeenCalled(); expect(onReceived).not.toHaveBeenCalled();
    expect(f.get().bySession[f.key].messages).toEqual([f.history]);
    expect(f.get().bySession[f.key].streaming).toBe(false); expect(runRouting.has("selection-race")).toBe(false);
    if (field === "tabModel") expect(f.get().openTabs.find(tab => tab.sessionId === f.tab.sessionId)?.model).toBe("new-choice");
    else expect(f.get().bySession[f.key][field]).toBe("new-choice");
  });
  it("does not mistake its own optimistic default resolution for a user selection change", async () => {
    const f = idle("claude"), onReceived = vi.fn();
    await f.actions.sendWhileBusy("continue", [], {
      requestedRunId: "inherited-run", hostLaunch: { defaultModel: "captured-default", defaultEffort: "high", defaultProvider: "captured-channel",
        expectedNativeSelection: { model: null, effort: null, providerId: null } },
      hostUserRow: async () => {}, hostContinuation: { beforeDelivery: async () => {}, onReceived },
    }, f.tab);
    expect(mocks.ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ model: "captured-default", effort: "high", providerId: "captured-channel" }));
    expect(onReceived).toHaveBeenCalledWith("turn", "inherited-run");
  });

  it.each(["codex", "claude"])("rolls back only the unsubmitted %s turn when row persistence fails", async engine => {
    const f = idle(engine); const failure = new Error("row persistence failed"); const onReceived = vi.fn();
    await expect(f.actions.sendWhileBusy("continue", [], {
      requestedRunId: "row-failed", hostUserRow: async () => { throw failure; },
      hostContinuation: { beforeDelivery: async () => {}, onReceived },
    }, f.tab)).rejects.toBe(failure);
    expect(mocks.ipc.sendMessage).not.toHaveBeenCalled(); expect(onReceived).not.toHaveBeenCalled();
    expect(f.get().bySession[f.key]).toEqual(f.previous);
    expect(f.get().bySession[f.key].messages[0]).toBe(f.history);
    expect(f.get().drafts[f.key]).toBe("unsent draft");
    expect(f.get().streamingByKey[f.key]).toBeUndefined(); expect(runRouting.has("row-failed")).toBe(false);
  });

  it("rolls back a final fence refusal without a row callback and preserves its original error", async () => {
    const f = idle(); const failure = new Error("cost approval changed");
    const hostBeforeSend = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure);
    await expect(f.actions.sendWhileBusy("continue", [], { requestedRunId: "cost-failed", hostBeforeSend,
      hostContinuation: { beforeDelivery: async () => {}, onReceived: vi.fn() },
    }, f.tab)).rejects.toBe(failure);
    expect(mocks.ipc.sendMessage).not.toHaveBeenCalled(); expect(f.get().bySession[f.key]).toEqual(f.previous);
    expect(runRouting.has("cost-failed")).toBe(false);
  });

  it("preserves Stop during a final fence and removes the exact optimistic row", async () => {
    const f = idle();
    const hostBeforeSend = vi.fn().mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
      f.get().bySession[f.key].interrupted = true; f.get().bySession[f.key].queueParked = true;
    });
    await expect(f.actions.sendWhileBusy("continue", [], { requestedRunId: "stopped", hostBeforeSend,
      hostContinuation: { beforeDelivery: async () => {}, onReceived: vi.fn() },
    }, f.tab)).rejects.toBeInstanceOf(HostChatBusyError);
    expect(mocks.ipc.sendMessage).not.toHaveBeenCalled();
    expect(f.get().bySession[f.key]).toMatchObject({ messages: [f.history], streaming: false, interrupted: true, queueParked: true });
    expect(f.get().streamingByKey[f.key]).toBeUndefined();
  });

  it("does not clear a newer run or a replacement row when the old final fence fails", async () => {
    const f = idle(); const failure = new Error("old owner lost");
    let newer: typeof f.previous;
    const hostBeforeSend = vi.fn().mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
      const optimistic = f.get().bySession[f.key].messages.at(-1)!;
      newer = { ...f.get().bySession[f.key], codexRunId: "newer-run", turnStartedAt: 123,
        messages: [f.history, { ...optimistic, text: "new user text" }], error: "newer error" } as typeof f.previous;
      f.get().bySession[f.key] = newer; runRouting.set("newer-run", f.key);
      f.get().drafts[f.key] = "newer draft";
      throw failure;
    });
    await expect(f.actions.sendWhileBusy("continue", [], { requestedRunId: "old-run", hostBeforeSend,
      hostContinuation: { beforeDelivery: async () => {}, onReceived: vi.fn() },
    }, f.tab)).rejects.toBe(failure);
    expect(mocks.ipc.sendMessage).not.toHaveBeenCalled();
    expect(f.get().bySession[f.key]).toEqual(newer!); expect(f.get().streamingByKey[f.key]).toBe(true);
    expect(f.get().drafts[f.key]).toBe("newer draft"); expect(runRouting.get("newer-run")).toBe(f.key);
    expect(runRouting.has("old-run")).toBe(false);
  });

  it("rejects a replaced run after the final fence resolves and preserves its later rows and queue", async () => {
    const f = idle();
    const laterRow = { seq: 9, role: "user" as const, text: "later instruction", ts: "later" };
    const queued = { id: "manual", text: "waiting", images: [], queuedAt: 1 };
    const hostBeforeSend = vi.fn().mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
      const current = f.get().bySession[f.key];
      f.get().bySession[f.key] = { ...current, codexRunId: "newer-run", messages: [...current.messages, laterRow], queue: [queued] };
      runRouting.set("newer-run", f.key);
    });
    await expect(f.actions.sendWhileBusy("continue", [], { requestedRunId: "old-run", hostBeforeSend,
      hostContinuation: { beforeDelivery: async () => {}, onReceived: vi.fn() },
    }, f.tab)).rejects.toBeInstanceOf(HostChatBusyError);
    expect(mocks.ipc.sendMessage).not.toHaveBeenCalled();
    expect(f.get().bySession[f.key]).toMatchObject({ codexRunId: "newer-run", streaming: true, messages: [f.history, laterRow], queue: [queued] });
    expect(f.get().streamingByKey[f.key]).toBe(true); expect(runRouting.get("newer-run")).toBe(f.key);
  });

  it("preserves new history and queued input without draining after a pre-native refusal", async () => {
    const f = idle(); const failure = new Error("approval expired");
    const laterRow = { seq: 9, role: "assistant" as const, text: "refreshed history", ts: "later" };
    const queued = { id: "queued", text: "waiting", images: [], queuedAt: 1 };
    await expect(f.actions.sendWhileBusy("continue", [], { requestedRunId: "refused", hostUserRow: async () => {
      const current = f.get().bySession[f.key];
      f.get().bySession[f.key] = { ...current, messages: [...current.messages, laterRow], queue: [queued] };
      throw failure;
    }, hostContinuation: { beforeDelivery: async () => {}, onReceived: vi.fn() } }, f.tab)).rejects.toBe(failure);
    expect(f.get().bySession[f.key]).toMatchObject({ streaming: false, messages: [f.history, laterRow], queue: [queued] });
    expect(mocks.ipc.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["delivery_outcome_unknown: transport disconnected", "native rejected"])("does not remove an idle row after IPC began: %s", async message => {
    const f = idle(); const failure = new Error(message); const onReceived = vi.fn();
    if (message.startsWith("delivery_outcome_unknown")) Object.assign(failure, { outcomeUnknown: true });
    mocks.ipc.sendMessage.mockRejectedValueOnce(failure);
    await expect(f.actions.sendWhileBusy("continue", [], { requestedRunId: "invoked",
      hostContinuation: { beforeDelivery: async () => {}, onReceived },
    }, f.tab)).rejects.toBe(failure);
    expect(mocks.ipc.sendMessage).toHaveBeenCalledOnce(); expect(onReceived).not.toHaveBeenCalled();
    expect(f.get().bySession[f.key].messages).toHaveLength(2); expect(f.get().bySession[f.key].queue).toEqual([]);
    if (message.startsWith("delivery_outcome_unknown")) {
      expect(f.get().bySession[f.key]).toMatchObject({ streaming: true, queueParked: true });
      expect(runRouting.get("invoked")).toBe(f.key);
    }
  });
});

describe("host task pending-chat seam", () => {
  it("keeps a single preflight callback for an initial task without row correlation", async () => {
    const f = fixture({ openTabs: [user, draft] }); const hostBeforeSend = vi.fn(async () => {});
    await f.actions.send("first task", [], { requestedRunId: "first-task", hostNewChat: true, hostBeforeSend }, draft);
    expect(hostBeforeSend).toHaveBeenCalledOnce(); expect(mocks.ipc.sendMessage).toHaveBeenCalledOnce();
  });
  it.each(["default", "priority"] as const)("forwards the explicit Codex %s tier only for this host launch", async tier => {
    const target = { ...draft, engine: "codex" as const };
    const f = fixture({ openTabs: [user, target] } as Partial<ChatStore>);
    await f.actions.send("Task body", [], { requestedRunId: "tier-task", hostNewChat: true,
      hostLaunch: { codexServiceTierOverride: tier } }, target);
    expect(mocks.ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ codexServiceTierOverride: tier }));
  });
  it("opens a background pending chat without focusing it and keeps the user's tab active", () => {
    const f = fixture();
    expect(f.tabs.openBackgroundDraft("claude", "G:/task", { model: "opus" })).toBe(true);
    expect(f.get().active).toEqual(user);
    expect(f.get().openTabs).toEqual([user, { ...draft, model: "opus" }]);
  });

  it.each([
    ["focused", { active: draft }],
    ["typed", { drafts: { [draftKey]: "my unsent words" } }],
    ["launching", { bySession: { [draftKey]: { ...EMPTY_SESSION, messages: [], queue: [], draftLaunching: "x" } } }],
  ] as const)("refuses a pending chat the user holds (%s)", (_name, extra) => {
    const f = fixture({ openTabs: [user, draft], ...extra } as Partial<ChatStore>);
    expect(f.tabs.openBackgroundDraft("claude", "G:/task", {})).toBe(false);
  });

  it("reuses an empty unfocused pending chat only when its starting choices match", () => {
    const f = fixture({ openTabs: [user, draft] } as Partial<ChatStore>);
    expect(f.tabs.openBackgroundDraft("claude", "G:/task", {})).toBe(true);
    expect(f.tabs.openBackgroundDraft("claude", "G:/task", { model: "other" })).toBe(false);
  });

  it("sends the first turn on that pending chat with the user's model, effort and permission", async () => {
    const f = fixture({ openTabs: [user, draft] } as Partial<ChatStore>);
    const started = vi.fn();
    await f.actions.send("Task body", [], { requestedRunId: "run-task", hostNewChat: true, onRunStarted: started }, draft);
    expect(mocks.ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-task", engine: "claude", sessionId: null, workspacePath: "G:/task", model: "user-default", effort: "high", permission: "manual",
    }));
    expect(mocks.ipc.sendMessage.mock.calls[0][0]).not.toHaveProperty("permissionOverride");
    expect(mocks.ipc.sendMessage.mock.calls[0][0]).not.toHaveProperty("codexServiceTierOverride");
    expect(started).toHaveBeenCalledWith({ runId: "run-task", sessionId: null });
    expect(f.get().active).toEqual(user);
    expect(runRouting.get("run-task")).toBe(draftKey);
  });

  it("keeps the old exact-target refusal for host chat sends to a pending chat", async () => {
    const f = fixture({ openTabs: [user, draft] } as Partial<ChatStore>);
    await expect(f.actions.send("x", [], { requestedRunId: "run-task" }, draft)).rejects.toThrow(/reachable/);
    expect(mocks.ipc.sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ["closed", { openTabs: [user] }],
    ["already launching", { openTabs: [user, draft], bySession: { [draftKey]: { ...EMPTY_SESSION, messages: [], queue: [], draftLaunching: "other" } } }],
    ["adopted by an earlier launch", { openTabs: [user] }],
  ] as const)("refuses before spawn when the pending chat is %s", async (name, extra) => {
    const f = fixture(extra as unknown as Partial<ChatStore>);
    if (name.startsWith("adopted")) adoptedDraftKeys.set(draftKey, `claude/${user.sessionId}`);
    const pending = f.actions.send("x", [], { requestedRunId: "run-task", hostNewChat: true }, draft);
    await expect(pending).rejects.toBeInstanceOf(HostChatBusyError);
    expect(mocks.ipc.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses to open a background draft when a cached user draft exists even without an open tab", () => {
    const f = fixture({ openTabs: [user], drafts: { [draftKey]: "unsent cached draft" } } as unknown as Partial<ChatStore>);
    expect(f.tabs.openBackgroundDraft("claude", "G:/task", {})).toBe(false);
    expect(f.get().openTabs).toEqual([user]);
  });

  it("aborts before spawning if the user types or focuses the draft during async preparation before send commits", async () => {
    const f = fixture({ openTabs: [user, draft] } as Partial<ChatStore>);
    mocks.getSelectedAgent.mockReturnValueOnce({ id: "agent-1", source: "builtIn", name: "Agent" });
    mocks.ipc.resolveEnabledBuiltInAgent.mockImplementationOnce(async () => {
      f.get().drafts[draftKey] = "user started typing while task was preparing";
      return { name: "Agent", prompt: "Instructions" };
    });
    await expect(
      f.actions.send("Task body", [], { requestedRunId: "run-race", hostNewChat: true }, draft),
    ).rejects.toBeInstanceOf(HostChatBusyError);
    expect(mocks.ipc.sendMessage).not.toHaveBeenCalled();
    expect(f.get().drafts[draftKey]).toBe("user started typing while task was preparing");
  });

  it("uses the frozen hostLaunch defaultModel and defaultEffort even if global defaults change before send", async () => {
    const f = fixture({
      openTabs: [user, draft],
      models: { claude: "changed-global-model" },
      efforts: { claude: "low" },
    } as unknown as Partial<ChatStore>);
    await f.actions.send(
      "Task body",
      [],
      {
        requestedRunId: "run-frozen",
        hostNewChat: true,
        hostLaunch: { defaultModel: "frozen-opus", defaultEffort: "max" },
      },
      draft,
    );
    expect(mocks.ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-frozen",
      model: "frozen-opus",
      effort: "max",
    }));
  });
});

describe("background draft refusal reasons", () => {
  const pending = (patch: Record<string, unknown>) => ({
    bySession: { [draftKey]: { ...EMPTY_SESSION, messages: [], queue: [], ...patch } },
  });
  it.each([
    ["uninitialized", { initialized: false }],
    ["focused", { active: draft }],
    ["text", { drafts: { [draftKey]: "private unsent content" } }],
    ["streaming", pending({ streaming: true })],
    ["loading", pending({ loading: true })],
    ["launching", pending({ draftLaunching: "preparing" })],
    ["messages", pending({ messages: [{ role: "user", text: "private history", seq: 1, ts: null }] })],
    ["queue", pending({ queue: [{ id: "q", text: "private queued content", images: [], queuedAt: 1 }] })],
    ["streaming", { streamingByKey: { [draftKey]: true } }],
    ["retrying", { retryingByKey: { [draftKey]: true } }],
  ] as const)("reports only the fixed %s reason without changing the draft", (reason, extra) => {
    const f = fixture(extra as Partial<ChatStore>), before = f.get();
    expect(backgroundDraftBlockReason(before, "claude", "G:/task")).toBe(`user-draft:${reason}`);
    expect(isBackgroundDraftAvailable(before, "claude", "G:/task")).toBe(false);
    expect(f.get()).toBe(before);
    expect(f.get().openTabs).toEqual([user]);
  });

  it("explains a missing required tab without creating it, and permits only its own launch token", () => {
    const f = fixture();
    expect(backgroundDraftBlockReason(f.get(), "claude", "G:/task", {}, { requireOpenTab: true })).toBe("user-draft:missing-tab");
    expect(backgroundDraftBlockReason(f.get(), "claude", "G:/task")).toBeNull();
    expect(f.get().openTabs).toEqual([user]);
    const launching = fixture({ openTabs: [user, draft], ...pending({ draftLaunching: "own" }) } as Partial<ChatStore>);
    expect(backgroundDraftBlockReason(launching.get(), "claude", "G:/task", {}, { requireOpenTab: true, allowDraftLaunchingId: "own" })).toBeNull();
    expect(backgroundDraftBlockReason(launching.get(), "claude", "G:/task", {}, { allowDraftLaunchingId: "other" })).toBe("user-draft:launching");
  });

  it.each([
    ["model", { model: "requested" }],
    ["effort", { effort: "max" }],
    ["provider", { providerId: "requested" }],
  ] as const)("keeps an unconfigured existing draft protected from explicit %s selection", (reason, launch) => {
    const f = fixture({ openTabs: [user, draft] });
    expect(backgroundDraftBlockReason(f.get(), "claude", "G:/task", launch)).toBe(`user-draft:${reason}`);
    expect(f.tabs.openBackgroundDraft("claude", "G:/task", launch)).toBe(false);
    expect(f.get().openTabs[1]).toEqual(draft);
  });

  it("protects a retained provider even without an open pending tab", () => {
    const f = fixture(pending({ activeProvider: "old-channel" }) as Partial<ChatStore>);
    expect(backgroundDraftBlockReason(f.get(), "claude", "G:/task", { defaultProvider: null })).toBe("user-draft:provider");
  });

  it("reports exact sidechat and mode occupation, including cached owners without tabs", () => {
    const sidechat = useSidechatStore.getState(), modes = getConversationModeState(), snapshot = modes.captureCheckpoint();
    const f = fixture();
    try {
      useSidechatStore.setState({ btwBySession: { [draftKey]: {} } as never });
      expect(backgroundDraftBlockReason(f.get(), "claude", "G:/task")).toBe("user-draft:sidechat");
      useSidechatStore.setState({ btwBySession: {}, sidechatBySession: { [draftKey]: {} } as never });
      expect(backgroundDraftBlockReason(f.get(), "claude", "G:/task")).toBe("user-draft:sidechat");
      useSidechatStore.setState({ sidechatBySession: {} });
      const saved = modes.identity("claude/saved", "G:/task", false);
      modes.select(saved, "fixture", false, 0);
      expect(backgroundDraftBlockReason(f.get(), "claude", "G:/task")).toBeNull();
      const identity = modes.identity(draftKey, "G:/task", true);
      modes.select(identity, "fixture", false, 0);
      expect(backgroundDraftBlockReason(f.get(), "claude", "G:/task")).toBe("user-draft:mode");
    } finally {
      useSidechatStore.setState({ btwBySession: sidechat.btwBySession, sidechatBySession: sidechat.sidechatBySession });
      modes.restoreCheckpoint(snapshot);
    }
  });

  it("preserves ordinary text after closing a pending tab and still reports text occupation", () => {
    const f = fixture({ openTabs: [user, draft], drafts: { [draftKey]: "unsent" } });
    f.tabs.closeTab("claude", null, "G:/task");
    expect(f.get().openTabs).toEqual([user]);
    expect(f.get().drafts[draftKey]).toBe("unsent");
    expect(backgroundDraftBlockReason(f.get(), "claude", "G:/task")).toBe("user-draft:text");
  });
});

describe("AGY pending adoption and background availability", () => {
  it.each(["ack-first", "session-first", "done-before-ack", "legacy-run-id"])("removes the old pending owner with %s", async order => {
    const tab = { ...draft, engine: "agy" }, pendingKey = sessionKey("agy", null, tab.workspacePath);
    const nativeKey = sessionKey("agy", "agy-adopted", tab.workspacePath);
    const f = fixture({ openTabs: [user, tab], sessions: [] });
    const response = Promise.withResolvers<{ runId: string; sessionId: string | null }>();
    mocks.ipc.sendMessage.mockReturnValueOnce(response.promise);
    const sending = f.actions.send("first turn", [], undefined, tab);
    const requested = mocks.ipc.sendMessage.mock.calls.at(-1)![0].runId;
    const runId = order === "legacy-run-id" ? `legacy-${requested}` : requested;
    const event = (kind: "session" | "message" | "done", seq: number, data: unknown) => ({ engine: "agy", runId, sessionId: "agy-adopted", kind, seq, data });
    const deps = { get: f.get, set: f.set, drainQueue: vi.fn(), markUnseenIfBackground: vi.fn(), upsertSessionMeta: vi.fn() };
    f.set((s: ChatStore) => ({ drafts: { [pendingKey]: "next draft" }, bySession: { ...s.bySession, [pendingKey]: {
      ...s.bySession[pendingKey], queue: [{ id: "q", text: "next turn", images: [], queuedAt: 1 }],
    } } }));
    if (order === "ack-first") { response.resolve({ runId, sessionId: "agy-adopted" }); await sending; }
    if (order === "legacy-run-id") handleEngineEvents([event("message", 1, { role: "assistant", text: "early" })], deps);
    handleEngineEvents([event("session", 2, "agy-adopted")], deps);
    expect(f.get().bySession[pendingKey]).toBeUndefined();
    expect(f.get().bySession[nativeKey].queue).toHaveLength(1);
    expect(f.get().drafts).toEqual({ [nativeKey]: "next draft" });
    if (order === "session-first") { response.resolve({ runId, sessionId: null }); await sending; }
    handleEngineEvents([event("done", 3, { usage: null })], deps);
    if (order === "done-before-ack" || order === "legacy-run-id") { response.resolve({ runId, sessionId: null }); await sending; }
    expect(f.get().bySession[pendingKey]).toBeUndefined();
    expect(f.get().streamingByKey[pendingKey]).toBeUndefined();
    expect(f.get().openTabs.some(t => t.engine === "agy" && t.sessionId === null)).toBe(false);
    expect(backgroundDraftBlockReason(f.get(), "agy", tab.workspacePath, { model: "gemini-4-argon-high" })).toBeNull();
  });
});


describe("host task provider and preparation races", () => {
  const launch = { model: "full-model", effort: "max", providerId: "channel-a", defaultProvider: "channel-a" };
  it("freezes provider on the new tab and sends it after global defaults change", async () => {
    const f = fixture({ providers: { claude: "channel-a" } });
    expect(f.tabs.openBackgroundDraft("claude", "G:/task", launch)).toBe(true);
    f.get().providers.claude = "channel-b";
    const target = f.get().openTabs[1];
    expect(target.provider).toBe("channel-a");
    await f.actions.send("task", [], { requestedRunId: "provider", hostNewChat: true, hostLaunch: launch }, target);
    expect(mocks.ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ model: "full-model", effort: "max", providerId: "channel-a" }));
    expect(f.get().providers.claude).toBe("channel-b");
  });
  it("uses the accepted defaultProvider even on an unconfigured pending tab", async () => {
    const f = fixture({ openTabs: [user, draft], providers: { claude: "later-default" } });
    await f.actions.send("task", [], { requestedRunId: "default-provider", hostNewChat: true, hostLaunch: { defaultProvider: "accepted-default" } }, draft);
    expect(mocks.ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ providerId: "accepted-default" }));
  });
  it("never rewrites an existing draft's provider to acquire it", () => {
    const target = { ...draft, model: "full-model", effort: "max" as const, provider: "user-channel" };
    const f = fixture({ openTabs: [user, target] });
    expect(f.tabs.openBackgroundDraft("claude", "G:/task", launch)).toBe(false);
    expect(f.get().openTabs[1]).toEqual(target);
  });
  it.each(["model", "provider"])("rejects new draft %s changes after asynchronous native verification", async (field) => {
    const f = fixture(); f.tabs.openBackgroundDraft("claude", "G:/task", launch);
    const target = f.get().openTabs[1];
    await expect(f.actions.send("task", [], { requestedRunId: "race", hostNewChat: true, hostLaunch: launch,
      hostBeforeSend: async () => { f.get().openTabs[1] = { ...target, [field]: "user-changed" }; },
    }, target)).rejects.toBeInstanceOf(HostChatBusyError);
    expect(mocks.ipc.sendMessage).not.toHaveBeenCalled();
  });
  it.each(["model", "effort", "provider"])("rejects existing session %s changes while preparing an agent", async (field) => {
    const key = sessionKey(user.engine, user.sessionId, user.workspacePath);
    const f = fixture({ bySession: { [key]: { ...EMPTY_SESSION, messages: [], queue: [], activeModel: "full-model", activeEffort: "max", activeProvider: "channel-a" } } });
    mocks.getSelectedAgent.mockReturnValueOnce({ id: "a", source: "builtIn", name: "a" });
    mocks.ipc.resolveEnabledBuiltInAgent.mockImplementationOnce(async () => {
      const property = { model: "activeModel", effort: "activeEffort", provider: "activeProvider" }[field]!;
      (f.get().bySession[key] as any)[property] = field === "effort" ? "low" : "user-changed";
      return { name: "Agent", prompt: "Instructions" };
    });
    await expect(f.actions.send("task", [], { requestedRunId: "existing-race", hostLaunch: launch }, user)).rejects.toBeInstanceOf(HostChatBusyError);
    expect(mocks.ipc.sendMessage).not.toHaveBeenCalled();
    expect(mocks.ipc.rememberSessionModel).not.toHaveBeenCalled();
  });
  it("propagates failed native re-resolution before committing or sending", async () => {
    const f = fixture(); f.tabs.openBackgroundDraft("claude", "G:/task", launch);
    await expect(f.actions.send("task", [], { requestedRunId: "alias-race", hostNewChat: true, hostLaunch: launch,
      hostBeforeSend: async () => { throw new Error("channel mapping changed"); },
    }, f.get().openTabs[1])).rejects.toThrow(/mapping changed/);
    expect(mocks.ipc.sendMessage).not.toHaveBeenCalled();
    expect(f.get().bySession[draftKey].messages).toHaveLength(0);
  });
});


it("does not inherit a stale draft provider when the accepted default is empty", () => {
  const f = fixture({ openTabs: [user, draft], bySession: { [draftKey]: { ...EMPTY_SESSION, messages: [], queue: [], activeProvider: "stale-channel" } } });
  expect(f.tabs.openBackgroundDraft("claude", "G:/task", { defaultProvider: null })).toBe(false);
  expect(f.get().bySession[draftKey].activeProvider).toBe("stale-channel");
});
