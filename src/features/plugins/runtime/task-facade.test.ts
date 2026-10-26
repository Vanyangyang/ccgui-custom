import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStore } from "@/features/chat/store/types";
import { HostChatBusyError } from "@/features/chat/store/types";
import { EMPTY_SESSION, runRouting } from "@/features/chat/store/stream";
import { sessionKey } from "@/features/chat/store/persistence";
import { settledRunOutcomes } from "@/features/chat/store/engine-events";
import { desktopTaskFacade, plausibleSessionId, TaskPreSpawnError } from "./task-facade";

const desktop = vi.hoisted(() => ({ state: {} as ChatStore, window: { unminimize: vi.fn(async () => {}), show: vi.fn(async () => {}), setFocus: vi.fn(async () => {}) } }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => desktop.window }));
vi.mock("@/features/chat/store", async () => ({
  sessionKey: (await import("@/features/chat/store/persistence")).sessionKey,
  useChatStore: { getState: () => desktop.state, subscribe: () => () => {} },
}));
vi.mock("@/lib/ipc", () => ({ ipc: { loadSessionPage: vi.fn(), listEngineModels: vi.fn() } }));

const S1 = "11111111-1111-1111-1111-111111111111";
const ref = { engine: "claude", sessionId: S1, workspacePath: "G:/game" };
const key = sessionKey("claude", S1, "G:/game");
const draft = { engine: "claude", sessionId: null, workspacePath: "G:/game" };
const draftKey = sessionKey("claude", null, "G:/game");

function state(extra: Record<string, unknown> = {}) {
  desktop.state = {
    initialized: true, archivedSessionKeys: {}, archivedWorkspaces: ["w2"], activeEngine: "claude",
    engines: [{ id: "claude", available: true, enabled: true }], models: { claude: "opus" }, efforts: { claude: "high" },
    workspaces: [{ id: "w1", path: "G:/game", name: "game" }, { id: "w2", path: "G:/old", name: "old" }, { id: "w3", path: "/wsl", name: "wsl", meta: { wsl: {} } }],
    sessions: [{ ...ref, remote: false }], openTabs: [ref], active: null,
    drafts: {}, streamingByKey: {}, retryingByKey: {},
    bySession: { [key]: { ...EMPTY_SESSION, messages: [], queue: [] } },
    send: vi.fn(async () => {}), interrupt: vi.fn(async () => {}), selectSession: vi.fn(async () => {}), focusTab: vi.fn(),
    openBackgroundDraft: vi.fn(() => true),
    ...extra,
  } as unknown as ChatStore;
}
beforeEach(() => { runRouting.clear(); settledRunOutcomes.clear(); state(); });
beforeAll(async () => { state(); await desktopTaskFacade(); }, 15000);

describe("desktop task facade", () => {
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
