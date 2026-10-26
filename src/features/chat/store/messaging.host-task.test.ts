import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMessagingActions } from "./messaging";
import { createTabActions } from "./tabs";
import { EMPTY_SESSION, adoptedDraftKeys, runRouting } from "./stream";
import { sessionKey } from "./persistence";
import { HostChatBusyError, type ChatStore } from "./types";

const mocks = vi.hoisted(() => ({
  ipc: { sendMessage: vi.fn(), sendFollowUp: vi.fn(async () => true), rememberSessionModel: vi.fn(async () => {}), rememberSessionEffort: vi.fn(async () => {}), rememberSessionProvider: vi.fn(async () => {}),
    resolveEnabledBuiltInAgent: vi.fn(async () => ({ name: "Agent", prompt: "Instructions" })),
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
    bySession: {}, refreshSessionUsage: vi.fn(async () => {}), activeEngine: "claude",
    ...extra,
  } as unknown as ChatStore;
  const set = (patch: unknown) => { state = { ...state, ...(typeof patch === "function" ? (patch as (s: ChatStore) => Partial<ChatStore>)(state) : patch as Partial<ChatStore>) }; };
  const get = () => state;
  const actions = createMessagingActions({ get, set, subscribe: () => () => {}, loadHistoryPage: vi.fn() });
  const tabs = createTabActions({ get, set });
  return { actions, tabs, get };
}

beforeEach(() => {
  runRouting.clear(); adoptedDraftKeys.clear(); vi.clearAllMocks();
  mocks.getSelectedAgent.mockReturnValue(null);
  mocks.ipc.sendMessage.mockImplementation(async (request: { runId: string }) => ({ runId: request.runId, sessionId: null }));
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
});

describe("host task pending-chat seam", () => {
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
