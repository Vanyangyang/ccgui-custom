import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import type { HostTaskCostApproval, HostTaskReceipt, HostTaskSubmission } from "@ccgui/plugin-sdk";
import type { EngineEventPayload } from "@/lib/events";
import type { SessionMeta } from "@/lib/ipc";
import { createRuntimeCheckpointCoordinator } from "@/lib/runtime-checkpoint";
import { createHostTaskBridge, HOST_TASKS_INDEX_KEY, pendingHostTaskPluginIds } from "./task-bridge";
import {
  TaskPreSpawnError,
  type HostTaskFacade,
  type TaskLaunchChoices,
  type TaskSessionRef,
  type TaskSettledRun,
  type TaskTimelineStatus,
} from "./task-facade";

const GAME = "G:/proj/game-root";
const TOOL = "G:/tools/workbench";
const S1 = "11111111-1111-1111-1111-111111111111";
const S2 = "22222222-2222-2222-2222-222222222222";
const S3 = "33333333-3333-3333-3333-333333333333";

type Fake = ReturnType<typeof fakeFacade>;
function fakeFacade() {
  const sessions = new Map<string, { ref: TaskSessionRef; status: TaskTimelineStatus | null; interrupted?: boolean }>();
  const drafts = new Map<string, { held?: boolean; busy?: boolean }>();
  const routes = new Map<string, string>();
  const settled = new Map<string, TaskSettledRun>();
  const rollover = new Set<string>();
  const observers = new Set<() => void>();
  const receivers = new Set<(events: EngineEventPayload[]) => void>();
  let activeEng = "claude";
  let claudeDefaultModel: string | null = "opus";
  let claudeDefaultEffort: string | null = "high";
  const key = (ref: TaskSessionRef) => `${ref.engine}/${ref.sessionId}`;
  const facade = {
    ready: vi.fn(async () => {}),
    fixedInstructionsSupported: vi.fn(async (_engine?: string) => true),
    codexServiceTierOverrideSupported: vi.fn(async () => true),
    activeEngine: () => activeEng,
    engines: (): ReturnType<HostTaskFacade["engines"]> => [
      { id: "claude", available: true, enabled: true, supportsImages: true, defaultModel: claudeDefaultModel, defaultEffort: claudeDefaultEffort },
      { id: "codex", available: true, enabled: true, supportsImages: true, defaultModel: null, defaultEffort: null },
    ],
    workspaces: () => [
      { id: "w1", path: GAME, name: "game", remote: false, archived: false },
      { id: "w2", path: TOOL, name: "tool", remote: false, archived: false },
      { id: "w3", path: "G:/old", name: "old", remote: false, archived: true },
    ],
    sessions: () => [...sessions.values()].map(({ ref }) => ({ ...ref, title: "t", preview: "p", createdAt: 1, updatedAt: 2, messageCount: 3,
      pinned: false, customTitle: null, filePath: "", fileSize: 0, fileMtimeMs: 0 } as SessionMeta)),
    known: (ref: TaskSessionRef) => sessions.get(key(ref))?.ref.workspacePath === ref.workspacePath,
    selectionMatches: vi.fn((_ref: TaskSessionRef, _launch: TaskLaunchChoices) => true),
    inspect: (ref: TaskSessionRef) => sessions.get(key(ref))?.status ?? null,
    openBackground: vi.fn(async (ref: TaskSessionRef) => { const s = sessions.get(key(ref)); if (s && s.status === null) s.status = "idle"; }),
    openDraft: vi.fn((engine: string, workspacePath: string, _launch?: TaskLaunchChoices) => {
      const d = drafts.get(`${engine}:${workspacePath}`);
      if (d?.held) return false;
      if (!d) drafts.set(`${engine}:${workspacePath}`, {});
      return true;
    }),
    draftReady: (engine: string, workspacePath: string, _launch?: TaskLaunchChoices) => {
      const d = drafts.get(`${engine}:${workspacePath}`);
      return !!d && !d.held && !d.busy;
    },
    sendExisting: vi.fn(async (ref: TaskSessionRef, _prompt: string, runId: string, _launch?: TaskLaunchChoices, beforeSend?: () => Promise<void>, _imagePaths?: readonly string[]) => {
      await beforeSend?.();
      sessions.get(key(ref))!.status = "busy"; routes.set(runId, key(ref));
      return { runId, sessionId: null as string | null };
    }),
    sendNew: vi.fn(async (engine: string, workspacePath: string, _prompt: string, runId: string, _launch?: TaskLaunchChoices, beforeSend?: () => Promise<void>, _imagePaths?: readonly string[], _onUserRow?: (row: import("./task-facade").HostUserRowIdentity) => Promise<void>) => {
      await beforeSend?.();
      drafts.get(`${engine}:${workspacePath}`)!.busy = true; routes.set(runId, `new:${engine}:${workspacePath}`);
      return { runId, sessionId: null as string | null };
    }),
    liveRun: (runId: string) => routes.get(runId) ?? null,
    settledRun: (runId: string) => settled.get(runId) ?? null,
    sessionShouldRollover: (ref: TaskSessionRef) => rollover.has(key(ref)),
    interrupt: vi.fn(async (runId: string) => routes.has(runId)),
    wasInterrupted: (ref: TaskSessionRef) => sessions.get(key(ref))?.interrupted === true,
    focus: vi.fn(async () => {}),
    focusDraft: vi.fn(),
    subscribe: (cb: () => void) => { observers.add(cb); return () => { observers.delete(cb); }; },
    listen: async (cb: (events: EngineEventPayload[]) => void) => { receivers.add(cb); return () => { receivers.delete(cb); }; },
    leaderBranches: async () => [{ parentEngine: "claude", parentSessionId: S1, engine: "claude", sessionId: S2, workspacePath: GAME, state: "completed" }],
    loadPage: vi.fn(async () => ({ messages: [
      { seq: 1, role: "user", text: "old question", ts: null }, { seq: 2, role: "tool", text: "noise", ts: null },
      { seq: 3, role: "assistant", text: "a".repeat(5000), ts: null },
    ], nextBefore: null })),
    projects: async () => [{ id: "p1", name: "SAMPLE-PROJECT", defaultPath: GAME, sourcePluginId: null,
      members: [{ id: "m1", path: GAME, label: "root", role: "development" as const, status: "available" as const },
        { id: "m2", path: `${GAME}/game`, label: "game", role: "development" as const, status: "available" as const }] }],
    models: async () => [{ id: "opus", name: "Opus", provider: "anthropic" }],
  } satisfies HostTaskFacade;
  return {
    facade, sessions, drafts, routes, settled, rollover,
    setDefaults(options: { activeEngine?: string; defaultModel?: string | null; defaultEffort?: string | null }) {
      if (options.activeEngine !== undefined) activeEng = options.activeEngine;
      if (options.defaultModel !== undefined) claudeDefaultModel = options.defaultModel;
      if (options.defaultEffort !== undefined) claudeDefaultEffort = options.defaultEffort;
    },
    addSession(ref: TaskSessionRef, status: TaskTimelineStatus | null = "idle") { sessions.set(key(ref), { ref, status }); },
    setStatus(ref: TaskSessionRef, status: TaskTimelineStatus | null) { sessions.get(key(ref))!.status = status; observers.forEach((cb) => cb()); },
    /** Native start of a new chat: the pending tab becomes this session. */
    adopt(runId: string, ref: TaskSessionRef) {
      const draftKey = routes.get(runId)!.slice(4);
      drafts.delete(draftKey.replace(/^([^:]+):/, "$1:"));
      sessions.set(key(ref), { ref, status: "busy" }); routes.set(runId, key(ref));
    },
    finish(runId: string, ref: TaskSessionRef, interrupted = false) {
      routes.delete(runId); const s = sessions.get(key(ref))!; s.status = "idle"; s.interrupted = interrupted;
      settled.set(runId, { status: interrupted ? "cancelled" : "completed" });
      observers.forEach((cb) => cb());
    },
    emit(events: EngineEventPayload[]) { receivers.forEach((cb) => cb(events)); },
    poke() { observers.forEach((cb) => cb()); },
  };
}

function storageFor(data = new Map<string, unknown>()) {
  return {
    data,
    get: vi.fn(async (id: string, key: string) => structuredClone(data.get(`${id}:${key}`) ?? null)),
    set: vi.fn(async (id: string, key: string, value: unknown) => { data.set(`${id}:${key}`, structuredClone(value)); }),
    delete: vi.fn(async (id: string, key: string) => { data.delete(`${id}:${key}`); }),
  };
}

const bridges: Array<ReturnType<typeof createHostTaskBridge>> = [];
afterEach(() => {
  bridges.splice(0).forEach((b) => b.dispose());
  vi.useRealTimers();
});

let runCounter = 0;
function bridgeFor(
  fake: Fake,
  options: {
    pluginId?: string;
    storage?: ReturnType<typeof storageFor>;
    invoke?: (c: string, a: Record<string, unknown>) => Promise<unknown>;
    loadClaims?: () => Promise<unknown>;
    attachmentCapabilities?: () => Promise<unknown>;
    checkpoint?: ReturnType<typeof createRuntimeCheckpointCoordinator>;
    confirmCostReview?: (approval: HostTaskCostApproval, decision: "approve" | "cancel" | "handoff") => Promise<boolean>;
    confirmManagedHandoff?: (approval: HostTaskCostApproval, summary: string) => Promise<boolean>;
  } = {},
) {
  const storage = options.storage ?? storageFor();
  const bridge = createHostTaskBridge(options.pluginId ?? "wb", storage, {
    facade: async () => fake.facade,
    invoke: options.invoke ?? (async () => { throw new Error("no planner"); }),
    loadClaims: options.loadClaims,
    attachmentCapabilities: options.attachmentCapabilities ?? (async () => ({ version: 1, exclusiveSessionReservations: true })),
    confirmCostReview: options.confirmCostReview,
    confirmManagedHandoff: options.confirmManagedHandoff,
    runId: () => `run-${++runCounter}`,
    ...(options.checkpoint
      ? { checkpoint: options.checkpoint }
      : { paused: () => false, whenResumed: async () => {}, registerBlocker: () => () => {} }),
  });
  bridges.push(bridge);
  return { bridge, storage };
}

const submission = (requestId: string, extra: Partial<HostTaskSubmission> = {}): HostTaskSubmission => ({
  requestId, taskId: "task-1", slotKey: "impl", projectId: "sample-project", workspacePath: GAME, prompt: `do ${requestId}`,
  sessionMode: "auto", ...extra,
});
const ev = (runId: string, seq: number, kind: string, data: unknown, sessionId: string | null = null, engine = "claude") =>
  ({ runId, seq, kind, data, sessionId, engine } as unknown as EngineEventPayload);
async function settle(bridge: ReturnType<typeof createHostTaskBridge>) {
  for (let i = 0; i < 8; i++) { await bridge.ready(); await new Promise((r) => setTimeout(r, 0)); }
}

describe("existing conversation attachment", () => {
  let previousLanguage: string;
  beforeEach(async () => { previousLanguage = i18n.language; await i18n.changeLanguage("en"); });
  afterEach(async () => { await i18n.changeLanguage(previousLanguage); });
  const ref = { engine: "claude", sessionId: S1, workspacePath: GAME };
  const request = (requestId = "attached") => ({ requestId, taskId: "topic", projectId: "p1", slotKey: "coordinator", session: ref, writePaths: [] });
  function fixture(status: TaskTimelineStatus = "idle") {
    const fake = fakeFacade(); fake.addSession(ref, status);
    const facade: HostTaskFacade = fake.facade;
    facade.leaderBranches = async () => [];
    facade.observeLifecycle = vi.fn(async () => ({ archived: false, idle: status === "idle", isCurrent: () => true }));
    facade.conversationLaunch = () => ({ model: "native-model", effort: "high", providerId: "native-channel" });
    facade.conversationState = () => ({ messages: [{ seq: 1, role: "user", text: "original prompt", ts: null }], status, runId: status === "idle" ? null : "original-run", canDeliver: status === "idle" });
    return { fake, facade, ...bridgeFor(fake) };
  }
  it.each([null, { version: 1 }, { version: 2, exclusiveSessionReservations: true }])("requires explicit native reservation support (%j)", async proof => {
    const f = fixture(), old = bridgeFor(f.fake, { pluginId: "old-native", attachmentCapabilities: async () => proof });
    expect((await old.bridge.catalog()).capabilities?.existingConversationAttachment).toBe(false);
    await expect(old.bridge.attachConversation(request())).rejects.toThrow(/updated native/);
    expect(await old.bridge.receipt(request().requestId)).toBeNull();
    expect(f.fake.facade.sendNew).not.toHaveBeenCalled();
  });
  it("rejects a workspace outside the exact selected project before claiming it", async () => {
    const f = fixture();
    await expect(f.bridge.attachConversation({ ...request(), projectId: "different-project" })).rejects.toThrow(/selected project/);
    expect(await f.bridge.receipt(request().requestId)).toBeNull();
    await expect(f.bridge.attachConversation(request())).resolves.toMatchObject({ status: "attached" });
  });
  it.each(["idle", "busy", "awaiting_permission"] as const)("associates %s native chat without an initial send", async status => {
    const f = fixture(status);
    expect((await f.bridge.catalog()).capabilities?.existingConversationAttachment).toBe(true);
    expect(await f.bridge.attachConversation(request())).toMatchObject({ status: "attached", runId: null, sessionDecision: "attached", session: ref });
    await settle(f.bridge);
    const snapshot = await f.bridge.conversation("attached");
    expect(snapshot.messages[0]).toMatchObject({ text: "original prompt" });
    expect(snapshot.nativeStatus).toBe(status);
    expect(f.fake.facade.sendExisting).not.toHaveBeenCalled(); expect(f.fake.facade.sendNew).not.toHaveBeenCalled();
    expect(f.fake.facade.openDraft).not.toHaveBeenCalled(); expect(f.fake.facade.focus).not.toHaveBeenCalled();
  });
  it("is idempotent only for the identical request and rejects another owner", async () => {
    const f = fixture(); const receipt = await f.bridge.attachConversation(request());
    expect(await f.bridge.attachConversation(request())).toEqual(receipt);
    await expect(f.bridge.attachConversation({ ...request(), taskId: "different" })).rejects.toThrow(/different/);
    await expect(f.bridge.attachConversation(request("second"))).rejects.toThrow(/exclusive|reserved/i);
    const other = bridgeFor(f.fake, { pluginId: "other" }).bridge;
    await expect(other.attachConversation(request("other"))).rejects.toThrow(/exclusive|reserved/i);
  });
  it("resolves comparison-only path spelling back to native metadata before lifecycle, storage and cold retries", async () => {
    const f = fixture("busy"), original = request();
    const alias = { ...original, session: { ...ref, workspacePath: GAME.toUpperCase().replaceAll("/", "\\") + "\\" } };
    f.facade.observeLifecycle = vi.fn(async target => {
      if (target.workspacePath !== GAME) throw new Error("Task lifecycle workspace is missing or ambiguous");
      return { archived: false, idle: false, isCurrent: () => true };
    });
    const receipt = await f.bridge.attachConversation(alias);
    expect(receipt.session).toEqual(ref);
    expect(f.facade.observeLifecycle).toHaveBeenCalledWith(ref, { forAttachment: true });
    expect(await f.bridge.attachConversation(original)).toEqual(receipt);
    await settle(f.bridge); f.bridge.dispose();
    const restored = bridgeFor(f.fake, { storage: f.storage }).bridge;
    expect(await restored.attachConversation(alias)).toEqual(receipt);
    expect(f.fake.facade.sendExisting).not.toHaveBeenCalled(); expect(f.fake.facade.sendNew).not.toHaveBeenCalled();
  });
  it.each(["duplicate", "remote", "different-workspace"])("rejects %s native metadata before lifecycle or persistence", async change => {
    const f = fixture(), source = f.facade.sessions()[0];
    await f.bridge.ready(); f.storage.set.mockClear();
    f.facade.sessions = () => change === "duplicate" ? [source, { ...source }] :
      [{ ...source, ...(change === "remote" ? { remote: true } : { workspacePath: TOOL }) }];
    await expect(f.bridge.attachConversation(request())).rejects.toThrow(/workspace|identity/i);
    expect(f.facade.observeLifecycle).not.toHaveBeenCalled(); expect(f.storage.set).not.toHaveBeenCalled();
  });
  it("retains an existing fingerprint when source metadata changes or disappears, but refuses a changed request", async () => {
    const f = fixture(), original = request(), receipt = await f.bridge.attachConversation(original);
    const source = f.facade.sessions()[0];
    f.facade.sessions = () => [{ ...source, workspacePath: GAME.toUpperCase() }];
    expect(await f.bridge.attachConversation(original)).toEqual(receipt);
    f.facade.sessions = () => [];
    expect(await f.bridge.attachConversation({ ...original, session: { ...ref, workspacePath: GAME.toUpperCase() } })).toEqual(receipt);
    for (const altered of [{ projectId: "other-project" }, { writePaths: ["src"] }, { session: { ...ref, sessionId: S2 } }, { session: { ...ref, workspacePath: TOOL } }]) {
      await expect(f.bridge.attachConversation({ ...original, ...altered })).rejects.toThrow(/different/);
    }
    expect(f.fake.facade.sendExisting).not.toHaveBeenCalled(); expect(f.fake.facade.sendNew).not.toHaveBeenCalled();
  });
  it("fingerprints the original declared paths, even when different inputs normalize identically", async () => {
    const f = fixture(), original = { ...request(), writePaths: ["src", "src"] };
    await f.bridge.attachConversation(original);
    await expect(f.bridge.attachConversation({ ...original, writePaths: ["src"] })).rejects.toThrow(/different/);
    await settle(f.bridge); f.bridge.dispose();
    const restored = bridgeFor(f.fake, { storage: f.storage }).bridge;
    expect(await restored.attachConversation(original)).toMatchObject({ status: "attached" });
  });
  it("rejects workspace mismatch, managed children and unknown lifecycle", async () => {
    const f = fixture();
    await expect(f.bridge.attachConversation({ ...request(), session: { ...ref, workspacePath: TOOL } })).rejects.toThrow();
    f.fake.addSession({ ...ref, sessionId: S2 });
    f.facade.leaderBranches = async () => [{ parentEngine: "claude", parentSessionId: S1, engine: "claude", sessionId: S2, workspacePath: GAME, state: "completed" }];
    await expect(f.bridge.attachConversation({ ...request(), session: { ...ref, sessionId: S2 } })).rejects.toThrow(/child|parent/);
    f.facade.observeLifecycle = async () => null;
    await expect(f.bridge.attachConversation(request())).rejects.toThrow(/lifecycle|verified|unavailable/i);
    expect(f.fake.facade.sendExisting).not.toHaveBeenCalled();
  });
  it("reserves across plugins before persistence completes and never acknowledges a failed write", async () => {
    const f = fixture(), gate = Promise.withResolvers<void>();
    await f.bridge.ready();
    f.storage.set.mockImplementationOnce(async () => gate.promise);
    const first = f.bridge.attachConversation(request());
    try {
      await vi.waitFor(() => expect(f.storage.set).toHaveBeenCalled());
      const other = bridgeFor(f.fake, { pluginId: "other" }).bridge;
      await expect(other.attachConversation(request("other"))).rejects.toThrow(/exclusive|reserved/i);
    } finally {
      gate.reject(new Error("disk failure"));
      await first.catch(() => {});
    }
    await expect(first).rejects.toThrow(/persist/);
    expect(await f.bridge.receipt("attached")).toBeNull();
    expect(f.fake.facade.sendNew).not.toHaveBeenCalled();
  });
  it("admits exactly one simultaneous cross-plugin attachment", async () => {
    const f = fixture(), other = bridgeFor(f.fake, { pluginId: "other" }).bridge;
    const results = await Promise.allSettled([f.bridge.attachConversation(request()), other.attachConversation(request("other"))]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    expect(f.fake.facade.sendNew).not.toHaveBeenCalled();
  });
  it("keeps a disabled owner's idle session reservation without blocking another session's writes", async () => {
    const f = fixture();
    const foreign = { pluginId: "disabled", requestId: "retained", runId: "", status: "unknown", session: ref, sessionProven: true,
      workspacePath: GAME, writePaths: null, exclusiveSession: true, reservationOnly: true };
    const bridge = bridgeFor(f.fake, { pluginId: "cold", loadClaims: async () => [foreign] }).bridge;
    await expect(bridge.attachConversation(request())).rejects.toThrow(/exclusive|reserved/);
    await bridge.submit(submission("different-session", { sessionMode: "new" })); await settle(bridge);
    expect(f.fake.facade.sendNew).toHaveBeenCalledOnce();
  });
  it("restores the exact attachment and permanently rejects a second owner after going idle", async () => {
    const f = fixture(); await f.bridge.attachConversation(request()); await settle(f.bridge); f.bridge.dispose();
    const restored = bridgeFor(f.fake, { storage: f.storage }).bridge;
    await restored.ready();
    expect(await restored.attachConversation(request())).toMatchObject({ status: "attached", session: ref, runId: null });
    expect((await restored.conversation("attached")).messages[0]).toMatchObject({ text: "original prompt" });
    await expect(restored.attachConversation(request("second"))).rejects.toThrow(/exclusive|reserved/);
    expect(f.fake.facade.sendNew).not.toHaveBeenCalled(); expect(f.fake.facade.sendExisting).not.toHaveBeenCalled();
  });
  it.each(["attachment", "status", "runId", "session", "launch", "fingerprint", "prompt"])("rejects a corrupted restored attachment %s", async field => {
    const f = fixture(); await f.bridge.attachConversation(request()); await settle(f.bridge); f.bridge.dispose();
    const index = structuredClone(f.storage.data.get(`wb:${HOST_TASKS_INDEX_KEY}`)) as { entries: Array<Record<string, any>> };
    const entry = index.entries[0];
    if (field === "attachment") delete entry.attachment;
    if (field === "status") entry.receipt.status = "queued";
    if (field === "runId") entry.receipt.runId = "forged-run";
    if (field === "session") entry.receipt.session.sessionId = S3;
    if (field === "launch") entry.launch.model = "frozen-default";
    if (field === "fingerprint") entry.fingerprint = "{}";
    if (field === "prompt") entry.prompt = "replay original prompt";
    f.storage.data.set(`wb:${HOST_TASKS_INDEX_KEY}`, index);
    await expect(bridgeFor(f.fake, { storage: f.storage }).bridge.ready()).rejects.toThrow(/attachment/);
    expect(f.fake.facade.sendNew).not.toHaveBeenCalled();
  });
  it("refuses closed active chats and failed reads without opening a new chat", async () => {
    const f = fixture("busy"); f.facade.conversationState = () => null;
    await expect(f.bridge.attachConversation(request())).rejects.toThrow(/Open the original/);
    expect(f.fake.facade.openBackground).not.toHaveBeenCalled();
    f.facade.observeLifecycle = async () => { throw new Error("native read failed"); };
    await expect(f.bridge.attachConversation(request())).rejects.toThrow("native read failed");
    expect(f.fake.facade.sendNew).not.toHaveBeenCalled();
  });
  it("loads only the original closed idle timeline in the background", async () => {
    const f = fixture();
    let open = false;
    const state = f.facade.conversationState!;
    f.facade.conversationState = target => open ? state(target) : null;
    f.fake.facade.openBackground.mockImplementation(async target => { expect(target).toEqual(ref); open = true; });
    expect(await f.bridge.attachConversation(request())).toMatchObject({ status: "attached", session: ref });
    expect(f.fake.facade.openBackground).toHaveBeenCalledOnce();
    expect(f.fake.facade.sendNew).not.toHaveBeenCalled(); expect(f.fake.facade.sendExisting).not.toHaveBeenCalled();
    expect(f.fake.facade.focus).not.toHaveBeenCalled(); expect(f.fake.facade.openDraft).not.toHaveBeenCalled();
  });
  it("continues only explicit new input into the original session and verifies current native choices", async () => {
    const f = fixture();
    const send = vi.fn<NonNullable<HostTaskFacade["continueMessage"]>>(async (target, _prompt, _images, runId, before, _launch, _row, beforeSpawn) => {
      await before("turn", runId); await beforeSpawn?.();
      expect(target).toEqual(ref); return { delivery: "turn", runId };
    });
    f.facade.continueMessage = send;
    await f.bridge.attachConversation(request());
    f.facade.conversationLaunch = () => ({ model: "changed-native-model", effort: "medium", providerId: "changed-channel" });
    const view = await f.bridge.conversation("attached");
    expect(view.selection).toMatchObject({ model: "changed-native-model", providerId: "changed-channel" });
    await f.bridge.sendMessage({ conversationRequestId: "attached", requestId: "new-input", expectedInputRevision: view.inputRevision, prompt: "only the new question" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(send.mock.calls[0].slice(0, 3)).toEqual([ref, "only the new question", []]);
    expect(f.fake.facade.sendNew).not.toHaveBeenCalled();
    expect((await f.bridge.receipt("attached"))?.runId).toBeNull();
  });
  it("projects original child edges and stops only the exact original run and native subtree", async () => {
    const f = fixture("busy"); f.fake.routes.set("original-run", `claude/${S1}`);
    const child: Awaited<ReturnType<HostTaskFacade["leaderBranches"]>>[number] = { id: "child", parentEngine: "claude", parentSessionId: S1, parentWorkspacePath: GAME, engine: "claude", sessionId: S2, workspacePath: GAME, state: "running", runId: "child-run" };
    f.facade.leaderBranches = async () => [child, { ...child, id: "unrelated", parentSessionId: S3, sessionId: "44444444-4444-4444-4444-444444444444" }];
    const stop = vi.fn(async (_parent: TaskSessionRef, _id: string) => { child.state = "stopped"; }); f.facade.stopChild = stop;
    await f.bridge.attachConversation(request());
    expect((await f.bridge.conversation("attached")).children.map(c => c.id)).toEqual(["child"]);
    await f.bridge.stopConversation("attached");
    expect(f.fake.facade.interrupt).toHaveBeenCalledWith("original-run");
    expect(stop).toHaveBeenCalledWith(ref, "child"); expect(stop.mock.calls.every(c => c[1] === "child")).toBe(true);
    expect(child.parentSessionId).toBe(S1);
    expect(f.fake.facade.sendNew).not.toHaveBeenCalled();
  });
});

describe("isolated initial task delivery", () => {
  function isolated() {
    const fake = fakeFacade(), facade = fake.facade as HostTaskFacade;
    const response = Promise.withResolvers<{ runId: string; sessionId: string | null }>();
    const send = vi.fn<HostTaskFacade["sendNew"]>(async (engine, _workspace, _prompt, runId, _launch, beforeSend) => {
      await beforeSend?.(); fake.routes.set(runId, `new:${engine}:@host-task/${runId}`); return response.promise;
    });
    facade.sendNewIsolated = send;
    fake.drafts.set(`claude:${GAME}`, { held: true });
    return { fake, facade, response, send, ...bridgeFor(fake) };
  }
  it("starts once without opening or consuming the user's pending slot", async () => {
    const f = isolated(), held = f.fake.drafts.get(`claude:${GAME}`);
    await f.bridge.submit(submission("private-start", { sessionMode: "new" })); await settle(f.bridge);
    const receipt = await f.bridge.receipt("private-start"), runId = receipt!.runId!;
    expect(receipt?.status).toBe("starting"); expect(f.send).toHaveBeenCalledOnce();
    expect(f.fake.facade.openDraft).not.toHaveBeenCalled(); expect(f.fake.facade.sendNew).not.toHaveBeenCalled();
    f.response.resolve({ runId, sessionId: S1 }); await settle(f.bridge);
    expect(await f.bridge.receipt("private-start")).toMatchObject({ status: "executing", session: { sessionId: S1 } });
    expect(f.fake.drafts.get(`claude:${GAME}`)).toBe(held);
    await f.bridge.submit(submission("private-start", { sessionMode: "new" })); await settle(f.bridge); expect(f.send).toHaveBeenCalledOnce();
  });
  it("interrupts an isolated starting run before ACK and never reports cancellation as completed", async () => {
    const f = isolated(); await f.bridge.submit(submission("private-cancel")); await settle(f.bridge);
    const runId = (await f.bridge.receipt("private-cancel"))!.runId!;
    await f.bridge.cancel("private-cancel");
    expect(f.fake.facade.interrupt).toHaveBeenCalledWith(runId);
    f.fake.emit([ev(runId, 1, "done", { interrupted: true }, S1)]); await settle(f.bridge);
    expect(await f.bridge.receipt("private-cancel")).toMatchObject({ status: "cancelled", session: { sessionId: S1 } });
    f.response.resolve({ runId, sessionId: S1 }); await settle(f.bridge);
    expect(await f.bridge.receipt("private-cancel")).toMatchObject({ status: "cancelled" }); expect(f.send).toHaveBeenCalledOnce();
  });
  it("proves an isolated pre-spawn refusal never acquired a native identity", async () => {
    const f = isolated(); f.send.mockRejectedValueOnce(new TaskPreSpawnError("cancelled during preparation"));
    await f.bridge.submit(submission("private-unsent")); await settle(f.bridge);
    expect(await f.bridge.receipt("private-unsent")).toMatchObject({ status: "failed", session: null, runId: null, sessionDecision: null });
    expect(f.fake.facade.sendNew).not.toHaveBeenCalled(); expect(f.send).toHaveBeenCalledOnce();
  });
  it("retains done until a late session identity proves the same original run", async () => {
    const f = isolated(); await f.bridge.submit(submission("late-identity")); await settle(f.bridge);
    const runId = (await f.bridge.receipt("late-identity"))!.runId!;
    f.fake.emit([ev(runId, 1, "done", null)]); await settle(f.bridge);
    expect(await f.bridge.receipt("late-identity")).toMatchObject({ status: "unknown", session: null });
    f.response.resolve({ runId, sessionId: null }); await settle(f.bridge);
    f.fake.emit([ev(runId, 2, "session", S1)]); await settle(f.bridge);
    expect(await f.bridge.receipt("late-identity")).toMatchObject({ status: "completed", session: { sessionId: S1 } });
    expect(f.send).toHaveBeenCalledOnce();
  });
  it.each(["event", "native-proof"])("does not retroactively cancel completed private work known through %s before late identity", async evidence => {
    const f = isolated(); await f.bridge.submit(submission("done-before-cancel")); await settle(f.bridge);
    const runId = (await f.bridge.receipt("done-before-cancel"))!.runId!;
    f.fake.routes.delete(runId);
    if (evidence === "event") f.fake.emit([ev(runId, 1, "done", null)]);
    else f.fake.settled.set(runId, { status: "completed" });
    await settle(f.bridge);
    const cancelled = await f.bridge.cancel("done-before-cancel");
    expect(cancelled?.status).not.toBe("cancelled");
    expect(f.fake.facade.interrupt).not.toHaveBeenCalled();
    f.response.resolve({ runId, sessionId: null }); await settle(f.bridge);
    expect(await f.bridge.receipt("done-before-cancel")).toMatchObject({ status: "unknown", session: null });
    f.fake.emit([ev(runId, 2, "session", S1)]); await settle(f.bridge);
    expect(await f.bridge.receipt("done-before-cancel")).toMatchObject({ status: "completed", session: { sessionId: S1 } });
    expect(f.send).toHaveBeenCalledOnce();
  });
  it("does not ignore a contradictory late ACK after a terminal event", async () => {
    const f = isolated(); await f.bridge.submit(submission("late-conflict")); await settle(f.bridge);
    const runId = (await f.bridge.receipt("late-conflict"))!.runId!;
    f.fake.emit([ev(runId, 1, "done", null, S1)]); await settle(f.bridge);
    expect((await f.bridge.receipt("late-conflict"))?.status).toBe("completed");
    f.response.resolve({ runId, sessionId: S2 }); await settle(f.bridge);
    expect(await f.bridge.receipt("late-conflict")).toMatchObject({ status: "unknown", error: expect.stringContaining("identity mismatch"), session: { sessionId: S1 } });
    await f.bridge.submit(submission("late-conflict")); await settle(f.bridge); expect(f.send).toHaveBeenCalledOnce();
  });
  it("retains an identity conflict raised by the real sender after terminal native evidence", async () => {
    const f = isolated(); await f.bridge.submit(submission("sender-conflict")); await settle(f.bridge);
    const runId = (await f.bridge.receipt("sender-conflict"))!.runId!;
    f.fake.emit([ev(runId, 1, "done", null, S1)]); await settle(f.bridge);
    f.response.reject(Object.assign(new Error("sender refused native rebinding"), { outcomeUnknown: true, nativeIdentityMismatch: true }));
    await settle(f.bridge);
    expect(await f.bridge.receipt("sender-conflict")).toMatchObject({ status: "unknown", session: { sessionId: S1 } });
    await f.bridge.submit(submission("sender-conflict")); await settle(f.bridge); expect(f.send).toHaveBeenCalledOnce();
  });
  it("does not promote a restored private route without native acknowledgement to executing", async () => {
    const f = isolated(); await f.bridge.submit(submission("private-unknown")); await settle(f.bridge);
    const runId = (await f.bridge.receipt("private-unknown"))!.runId!;
    f.response.reject(new Error("native reply lost")); await settle(f.bridge);
    expect((await f.bridge.receipt("private-unknown"))?.status).toBe("unknown");
    f.bridge.dispose();
    const next = fakeFacade(); next.routes.set(runId, `new:claude:@host-task/${runId}`);
    const restored = bridgeFor(next, { storage: f.storage });
    await settle(restored.bridge);
    expect(await restored.bridge.receipt("private-unknown")).toMatchObject({ status: "unknown", runId, session: null });
    expect(next.facade.sendNew).not.toHaveBeenCalled(); expect(next.facade.sendExisting).not.toHaveBeenCalled();
  });
});

describe("archived continuous coordinator claims", () => {
  it.each([false, true])("releases two verified archived sources and sends only the original queued request (release race=%s)", async race => {
    const first = fakeFacade(), storage = storageFor(), facade = first.facade as HostTaskFacade;
    const engines = facade.engines;
    facade.engines = () => [...engines(), { id: "agy", available: true, enabled: true, defaultModel: "gemini", defaultEffort: null }];
    facade.conversationState = () => ({ messages: [], runId: null, status: "idle", canDeliver: true });
    facade.leaderBranches = async () => [];
    const original = bridgeFor(first, { storage }).bridge;
    const refs = [{ engine: "claude", sessionId: S1, workspacePath: GAME }, { engine: "agy", sessionId: "agy-old", workspacePath: GAME }];
    for (const [i, id] of ["old-stopped", "old-resumed"].entries()) {
      await original.submit(submission(id, { engine: refs[i].engine, sessionMode: "new", coordination: true, slotKey: id })); await settle(original);
      const run = (await original.receipt(id))!.runId!;
      first.adopt(run, refs[i]); first.emit([ev(run, 1, "session", refs[i].sessionId, refs[i].sessionId, refs[i].engine)]);
      first.finish(run, refs[i]); first.emit([ev(run, 2, "done", null, refs[i].sessionId, refs[i].engine)]); await settle(original);
      expect((await original.conversation(id)).status).toBe("idle");
    }
    original.dispose();
    const index = storage.data.get(`wb:${HOST_TASKS_INDEX_KEY}`) as any;
    // Exercise both a retained hold and an idle claim released by a previous
    // renderer: neither can bypass fresh lifecycle verification on cold boot.
    for (const entry of index.entries) entry.conversationHolding = race;
    index.entries[1].receipt.status = "failed"; index.entries[1].receipt.error = "Original GUI turn was interrupted";
    const saved = storage.data.get("wb:__host_tasks_v1:conversations") as any;
    for (const record of saved.records) {
      if (record.requestId === "old-stopped") {
        Object.assign(record, { stopping: true, stopEpoch: 1, stopRunId: "stop-fixture", stopInputRevision: 0,
          stopTerminalProof: { runId: "stop-fixture", sessionRef: refs[0], status: "completed" }, children: [] });
      } else {
        Object.assign(record, { stopping: false, stopped: false, stopEpoch: 2, inputRevision: 2, children: [] });
        record.inputs = [["resolved", 1, "unknown", "older-run", true], ["last", 2, "completed", "last-run", false]].map(([id, rev, status, run, resolved]) => ({
          receipt: { requestId: id, conversationRequestId: record.requestId, inputRevision: rev, status, delivery: "turn", runId: run,
            sessionRef: refs[1], acceptedAt: 1, updatedAt: 2, ...(resolved ? { stopResolved: true } : {}) },
          fingerprint: JSON.stringify([record.requestId, id, Number(rev) - 1, "fixture", []]), prompt: "fixture", images: [],
        }));
      }
    }
    const next = fakeFacade(), nextFacade = next.facade as HostTaskFacade;
    const pending = Promise.withResolvers<void>(); let valid = true, activated = false;
    nextFacade.conversationState = () => null;
    nextFacade.canProjectTerminalRun = () => false;
    nextFacade.leaderBranches = async () => [];
    nextFacade.observeLifecycle = async () => { await pending.promise; return { archived: true, idle: true, isCurrent: () => valid }; };
    refs.forEach(ref => next.addSession(ref));
    const cold = bridgeFor(next, { storage }).bridge;
    const request = submission("original-current", { sessionMode: "new", slotKey: "current" });
    await cold.submit(request); await settle(cold);
    expect(await cold.receipt(request.requestId)).toMatchObject({ status: "queued", session: null, runId: null, blockedBy: ["old-stopped", "old-resumed"] });
    expect(next.facade.sendNew).not.toHaveBeenCalled();
    const write = storage.set.getMockImplementation()!;
    if (race) storage.set.mockImplementation(async (plugin, key, value) => {
      await write(plugin, key, value);
      if (!activated && key === HOST_TASKS_INDEX_KEY && (value as any).entries.some((e: any) => e.receipt.requestId === "old-stopped" && e.conversationHolding === false)) {
        activated = true; valid = false; next.poke();
      }
    });
    pending.resolve(); await settle(cold);
    if (race) {
      expect(activated).toBe(true);
      expect(next.facade.sendNew).not.toHaveBeenCalled();
      expect((storage.data.get(`wb:${HOST_TASKS_INDEX_KEY}`) as any).entries.find((e: any) => e.receipt.requestId === "old-stopped").conversationHolding).toBe(true);
      // A later fresh native observation may release; the invalidated one cannot.
      nextFacade.observeLifecycle = async () => ({ archived: true, idle: true, isCurrent: () => true });
      await cold.conversation("old-stopped"); await cold.conversation("old-resumed"); await settle(cold);
    }
    expect(next.facade.sendNew).toHaveBeenCalledTimes(1);
    expect((await cold.receipt(request.requestId))!.blockedBy).toBeUndefined();
    expect(next.facade.sendExisting).not.toHaveBeenCalled();
    expect(next.facade.openBackground).not.toHaveBeenCalled();
    const settledIndex = storage.data.get(`wb:${HOST_TASKS_INDEX_KEY}`) as any;
    expect(settledIndex.entries.slice(0, 2).every((e: any) => e.conversationOwner && !e.conversationHolding)).toBe(true);
    await cold.submit(request); next.poke(); await settle(cold);
    expect(next.facade.sendNew).toHaveBeenCalledTimes(1);
    expect(await cold.list()).toHaveLength(3);
  });
});

describe("host task bridge delivery", () => {
  it("advertises coordinator full-history handoff only with the native full-history facade", async () => {
    const fake = fakeFacade(), facade = fake.facade as HostTaskFacade;
    const { bridge } = bridgeFor(fake);
    expect((await bridge.catalog()).capabilities?.coordinatorFullHistoryHandoff).toBe(false);
    facade.summarizeHandoff = vi.fn();
    const support = vi.fn(async () => false); facade.fullHistoryHandoffSupported = support;
    expect((await bridge.catalog()).capabilities?.coordinatorFullHistoryHandoff).toBe(false);
    support.mockResolvedValue(true);
    expect((await bridge.catalog()).capabilities).toMatchObject({ fullHistoryHandoff: true, coordinatorFullHistoryHandoff: true });
    delete facade.summarizeHandoff;
    expect((await bridge.catalog()).capabilities?.coordinatorFullHistoryHandoff).toBe(false);
  });
  it("binds coordinator summary to this plugin's exact owned request and native session", async () => {
    const fake = fakeFacade(), facade = fake.facade as HostTaskFacade;
    const ref = { engine: "claude", sessionId: S1, workspacePath: GAME };
    facade.conversationState = () => ({ messages: [], runId: null, status: "idle", canDeliver: true });
    facade.leaderBranches = async () => [];
    facade.fullHistoryHandoffSupported = async () => true;
    const summarize = vi.fn(async () => "Native complete history"); facade.summarizeHandoff = summarize;
    const { bridge, storage } = bridgeFor(fake);
    await bridge.submit(submission("coordinator-owner", { coordination: true, sessionMode: "new" })); await settle(bridge);
    const run = fake.facade.sendNew.mock.calls[0][3];
    fake.adopt(run, ref); fake.emit([ev(run, 1, "session", S1)]); await settle(bridge);
    fake.finish(run, ref); fake.emit([ev(run, 2, "done", null, S1)]); await settle(bridge);
    const view = await bridge.conversation("coordinator-owner");
    const source = { kind: "coordinator" as const, conversationRequestId: "coordinator-owner", expectedRevision: view.revision };
    const selection = { engine: "codex" as const, model: "selected-compressor" };
    const other = bridgeFor(fake, { pluginId: "other-summary-plugin", storage }).bridge;
    await expect(other.summarizeCoordinatorHandoff(source, selection)).rejects.toThrow(/Unknown owned/);
    expect(summarize).not.toHaveBeenCalled();
    expect(await bridge.summarizeCoordinatorHandoff(source, selection)).toBe("Native complete history");
    expect(summarize).toHaveBeenCalledExactlyOnceWith(ref, selection);
    expect(fake.facade.loadPage).not.toHaveBeenCalled();
    expect(fake.facade.sendNew).toHaveBeenCalledTimes(1); expect(fake.facade.sendExisting).not.toHaveBeenCalled();
  });
  it("gates managed handoff on native support, cost capture and host human confirmation", async () => {
    const fake = fakeFacade(), facade = fake.facade as HostTaskFacade;
    const { bridge } = bridgeFor(fake, { confirmCostReview: async () => true, confirmManagedHandoff: async () => true });
    expect((await bridge.catalog()).capabilities?.managedChildCostHandoff).toBe(false);
    facade.costApprovals = () => ({ items: [], truncated: false }); facade.captureCostApproval = vi.fn(); facade.handoffCostApproval = vi.fn();
    const supported = vi.fn(async () => false); facade.managedChildHandoffSupported = supported;
    expect((await bridge.catalog()).capabilities?.managedChildCostHandoff).toBe(false);
    supported.mockResolvedValue(true);
    expect((await bridge.catalog()).capabilities?.managedChildCostHandoff).toBe(true);
    expect((await bridge.catalog()).capabilities?.managedChildHandoffSelection).toBe(false);
    facade.resolveHandoffSelection = async selection => selection;
    const selectionSupported = vi.fn(async () => false); facade.managedChildHandoffSelectionSupported = selectionSupported;
    expect((await bridge.catalog()).capabilities?.managedChildHandoffSelection).toBe(false);
    selectionSupported.mockResolvedValue(true);
    expect((await bridge.catalog()).capabilities?.managedChildHandoffSelection).toBe(true);
    const withoutDialog = bridgeFor(fake).bridge;
    expect((await withoutDialog.catalog()).capabilities?.managedChildCostHandoff).toBe(false);
    expect((await withoutDialog.catalog()).capabilities?.managedChildHandoffSelection).toBe(false);
  });
  it("advertises cost handoff previews only with both native cost capture and coordinator evaluation", async () => {
    const fake = fakeFacade(), facade = fake.facade as HostTaskFacade;
    const { bridge } = bridgeFor(fake);
    expect((await bridge.catalog()).capabilities?.costHandoffPreview).toBe(false);
    facade.captureCostApproval = vi.fn();
    expect((await bridge.catalog()).capabilities?.costHandoffPreview).toBe(false);
    facade.sessionCostReview = () => null;
    expect((await bridge.catalog()).capabilities?.costHandoffPreview).toBe(true);
    delete facade.captureCostApproval;
    expect((await bridge.catalog()).capabilities?.costHandoffPreview).toBe(false);
  });

  it("routes owned cost previews through bounded history without resolving or delivering the held request", async () => {
    const fake = fakeFacade(), facade = fake.facade as HostTaskFacade;
    const ref = { engine: "claude", sessionId: S1, workspacePath: GAME };
    const target = { engine: "claude", sessionId: S2, workspacePath: GAME };
    const fullMessage = "完整请求🙂".repeat(400);
    const approval: HostTaskCostApproval = { id: "approval-1", requestId: "held-1", sender: ref, target,
      message: fullMessage.slice(0, 1200), truncated: true, model: "opus", cacheHeat: "cold",
      usageKind: "unknown", capturedAt: 1, canHandoff: true };
    facade.conversationState = () => ({ messages: [], runId: null, status: "idle", canDeliver: true });
    facade.leaderBranches = async () => [{ id: "preview-child", parentEngine: ref.engine, parentSessionId: ref.sessionId,
      ...target, state: "completed" }];
    facade.sessionCostReview = () => null;
    facade.costApprovals = vi.fn(() => ({ items: [approval], truncated: false }));
    facade.captureCostApproval = vi.fn(() => ({ approval, message: fullMessage, kind: "cross-session" as const }));
    facade.resolveCostApproval = vi.fn(async () => {});
    const confirmCostReview = vi.fn(async () => true);
    const { bridge, storage } = bridgeFor(fake, { confirmCostReview });
    await bridge.submit(submission("preview-owner", { coordination: true, sessionMode: "new" })); await settle(bridge);
    const run = fake.facade.sendNew.mock.calls[0][3];
    fake.adopt(run, ref); fake.emit([ev(run, 1, "session", S1)]); await settle(bridge);
    fake.finish(run, ref); fake.emit([ev(run, 2, "done", null, S1)]); await settle(bridge);
    fake.addSession(target);
    const view = await bridge.conversation("preview-owner");
    expect(view.costApprovals).toEqual([approval]);
    const request = { conversationRequestId: "preview-owner", expectedRevision: view.revision,
      approvalId: approval.id, approvalRequestId: approval.requestId };
    const result = await bridge.previewCostHandoff!(request);
    expect(result).toMatchObject({ conversationRequestId: request.conversationRequestId, approvalId: approval.id,
      approvalRequestId: approval.requestId, source: target, kind: "crossSession", message: fullMessage,
      images: [], model: "opus", sourceStamp: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(result.excerpt.messages.map(row => row.role)).toEqual(["user", "assistant"]);
    expect(fake.facade.loadPage).toHaveBeenCalledWith(target, 20, null);
    expect(result.excerpt).toMatchObject({ truncated: true, messages: [
      { text: "old question", truncated: false }, { text: expect.any(String), truncated: true },
    ] });
    expect(facade.captureCostApproval).toHaveBeenCalledWith([ref, target], approval);
    await expect(bridge.previewCostHandoff!({ ...request, expectedRevision: 0 })).rejects.toThrow(/Invalid/);
    await expect(bridge.previewCostHandoff!({ ...request, expectedRevision: view.revision + 1 })).rejects.toThrow(/stale/);
    await expect(bridge.previewCostHandoff!({ ...request, approvalId: "other-approval" })).rejects.toThrow(/no longer available/);
    await expect(bridge.previewCostHandoff!({ ...request, approvalRequestId: "other-held" })).rejects.toThrow(/no longer available/);
    const other = bridgeFor(fake, { pluginId: "other", storage, confirmCostReview }).bridge;
    await expect(other.previewCostHandoff!(request)).rejects.toThrow(/Unknown owned/);
    expect(confirmCostReview).not.toHaveBeenCalled();
    expect(facade.resolveCostApproval).not.toHaveBeenCalled();
    expect(fake.facade.sendNew).toHaveBeenCalledTimes(1);
    expect(fake.facade.sendExisting).not.toHaveBeenCalled();
    expect(fake.facade.interrupt).not.toHaveBeenCalled();
  });

  it("freezes a coordinator's explicit tier, verifies native support and fences altered retries and checkpoints", async () => {
    const fake = fakeFacade(), { bridge, storage } = bridgeFor(fake);
    const request = submission("fast-owner", { engine: "codex", coordination: true, sessionMode: "new", codexServiceTier: "priority" });
    expect((await bridge.catalog()).capabilities?.coordinatorServiceTier).toBe(true);
    await bridge.submit(request); await settle(bridge);
    expect(fake.facade.sendNew.mock.calls[0][4]).toMatchObject({ codexServiceTierOverride: "priority" });
    await expect(bridge.submit({ ...request, codexServiceTier: "default" })).rejects.toThrow("different submission");
    bridge.dispose();
    const restored = bridgeFor(fake, { storage }).bridge;
    await expect(restored.receipt("fast-owner")).resolves.toMatchObject({ requestId: "fast-owner" });
    restored.dispose();
    const saved = storage.data.get(`wb:${HOST_TASKS_INDEX_KEY}`) as any;
    saved.entries[0].launch.codexServiceTierOverride = "default";
    await expect(bridgeFor(fake, { storage }).bridge.ready()).rejects.toThrow("coordinator record");
  });
  it("rejects an unavailable or non-coordinator service tier without starting a native task", async () => {
    const fake = fakeFacade(); fake.facade.codexServiceTierOverrideSupported.mockResolvedValue(false);
    const { bridge } = bridgeFor(fake);
    expect((await bridge.catalog()).capabilities?.coordinatorServiceTier).toBe(false);
    await expect(bridge.submit(submission("old", { engine: "codex", coordination: true, sessionMode: "new", codexServiceTier: "priority" }))).rejects.toThrow("unavailable");
    await expect(bridge.submit(submission("ordinary", { engine: "codex", sessionMode: "new", codexServiceTier: "priority" }))).rejects.toThrow("coordinator");
    await expect(bridge.submit(submission("other-engine", { engine: "claude", coordination: true, sessionMode: "new", codexServiceTier: "default" }))).rejects.toThrow("coordinator");
    expect(fake.facade.sendNew).not.toHaveBeenCalled();
  });
  it("identifies a notice source only after the exact coordinator session is proven", async () => {
    const fake = fakeFacade(), { bridge, storage } = bridgeFor(fake);
    const ref = { engine: "claude", sessionId: S1, workspacePath: GAME };
    await bridge.submit(submission("notice-owner", { coordination: true, sessionMode: "new" })); await settle(bridge);
    expect(await bridge.noticeCoordinator(ref)).toBeNull();
    const run = fake.facade.sendNew.mock.calls[0][3];
    fake.adopt(run, ref); fake.emit([ev(run, 1, "session", S1)]); await settle(bridge);
    expect(await bridge.noticeCoordinator(ref)).toBe("notice-owner");
    expect(await bridge.noticeCoordinator({ ...ref, workspacePath: TOOL })).toBeNull();
    expect(await bridge.noticeCoordinator({ ...ref, sessionId: S2 })).toBeNull();
    const other = bridgeFor(fake, { pluginId: "other", storage }).bridge;
    expect(await other.noticeCoordinator(ref)).toBeNull();
  });
  it("advertises immediate messages only when the native facade provides preparation", async () => {
    const fake = fakeFacade(); const { bridge } = bridgeFor(fake);
    expect((await bridge.catalog()).capabilities?.coordinatorMessageQueue).toBe(true);
    expect((await bridge.catalog()).capabilities?.immediateMessages).toBe(false);
    (fake.facade as HostTaskFacade).prepareImmediateMessage = vi.fn(async () => {});
    expect((await bridge.catalog()).capabilities?.immediateMessages).toBe(true);
    expect(typeof bridge.sendMessageNow).toBe("function");
  });
  it.each(["claude", "codex", "agy"])("%s persists separate fixed instructions before launch and refuses changed idempotent retries", async engine => {
    const fake = fakeFacade();
    const engines = fake.facade.engines();
    if (engine === "agy") fake.facade.engines = () => [...engines, { id: "agy", available: true, enabled: true, defaultModel: "gemini", defaultEffort: null }]; const { bridge, storage } = bridgeFor(fake);
    const profile = { version: "coordinate-v1", text: "Stable policy 中文😀" };
    const request = submission("fixed", { engine, model: engine === "agy" ? "gemini" : "opus", coordination: true, sessionMode: "new", fixedInstructions: profile });
    const original = fake.facade.sendNew.getMockImplementation()!;
    fake.facade.sendNew.mockImplementationOnce(async (...args) => {
      const entry = (storage.data.get(`wb:${HOST_TASKS_INDEX_KEY}`) as any).entries[0];
      expect(entry.fixedInstructions).toEqual(profile); expect(args[2]).not.toContain(profile.text);
      return original(...args);
    });
    await bridge.submit(request); await settle(bridge);
    expect(fake.facade.sendNew).toHaveBeenCalledTimes(1);
    await expect(bridge.submit({ ...request, fixedInstructions: { ...profile, version: "v2" } })).rejects.toThrow("different submission");
    const cold = bridgeFor(fake, { storage });
    expect((await cold.bridge.receipt("fixed"))?.requestId).toBe("fixed");
    expect(fake.facade.sendNew).toHaveBeenCalledTimes(1);
  });
  it("advertises native support only after the binary handshake and rejects unsupported profiles", async () => {
    const fake = fakeFacade(); fake.facade.fixedInstructionsSupported.mockResolvedValue(false);
    const { bridge } = bridgeFor(fake);
    expect((await bridge.catalog()).capabilities?.fixedInstructions).toBe(false);
    expect((await bridge.catalog()).engines.every(e => !e.supportsFixedInstructions)).toBe(true);
    await expect(bridge.submit(submission("old-native", { engine: "claude", fixedInstructions: { version: "v1", text: "policy" } }))).rejects.toThrow("unavailable");
    expect(fake.facade.sendNew).not.toHaveBeenCalled();
  });
  it("publishes exact AGY capability and rejects a legacy host despite global support", async () => {
    const fake = fakeFacade(); const engines = fake.facade.engines();
    fake.facade.engines = () => [...engines, { id: "agy", available: true, enabled: true, defaultModel: "gemini", defaultEffort: null }];
    fake.facade.fixedInstructionsSupported.mockImplementation(async engine => engine !== "agy");
    const { bridge } = bridgeFor(fake);
    const catalog = await bridge.catalog();
    expect(catalog.capabilities?.fixedInstructions).toBe(true);
    expect(catalog.engines.find(e => e.id === "agy")?.supportsFixedInstructions).toBe(false);
    expect(catalog.engines.find(e => e.id === "claude")?.supportsFixedInstructions).toBe(true);
    await expect(bridge.submit(submission("agy-old", { engine: "agy", model: "gemini", fixedInstructions: { version: "v1", text: "policy" } }))).rejects.toThrow("unavailable");
    expect(fake.facade.sendNew).not.toHaveBeenCalled();
    fake.facade.fixedInstructionsSupported.mockResolvedValue(true);
    expect((await bridge.catalog()).engines.find(e => e.id === "agy")?.supportsFixedInstructions).toBe(true);
  });
  it("rechecks the exact engine before launching accepted guidance", async () => {
    const fake = fakeFacade();
    fake.facade.fixedInstructionsSupported.mockResolvedValueOnce(true).mockResolvedValue(false);
    const { bridge } = bridgeFor(fake);
    await bridge.submit(submission("lost-guidance", { engine: "claude", sessionMode: "new", fixedInstructions: { version: "v1", text: "policy" } }));
    await settle(bridge);
    expect((await bridge.receipt("lost-guidance"))?.status).toBe("failed");
    expect((await bridge.receipt("lost-guidance"))?.error).toContain("fixed instructions are unavailable");
    expect(fake.facade.sendNew).not.toHaveBeenCalled();
    expect(fake.facade.fixedInstructionsSupported.mock.calls.every(([engine]) => engine === "claude")).toBe(true);
  });
  it("fingerprints and persists initial displayText and projects only its exact committed row", async () => {
    const fake = fakeFacade(), facade = fake.facade as HostTaskFacade;
    const rows: import("@/lib/ipc").Message[] = [];
    facade.conversationState = () => ({ messages: rows, runId: null, status: "idle", canDeliver: true }); facade.leaderBranches = async () => [];
    const send = fake.facade.sendNew.getMockImplementation()!;
    fake.facade.sendNew.mockImplementationOnce(async (...args) => {
      const ack = await send(...args);
      rows.push({ seq: 1, role: "user", text: args[2], ts: "2026-10-24T00:00:00Z" });
      await args[7]?.({ ...rows[0], runId: args[3] }); return ack;
    });
    const { bridge, storage } = bridgeFor(fake);
    const request = submission("visible-root", { coordination: true, sessionMode: "new", displayText: "真正目标😀" });
    await bridge.submit(request); await settle(bridge);
    await expect(bridge.submit({ ...request, displayText: "other" })).rejects.toThrow("different submission");
    const run = fake.facade.sendNew.mock.calls[0][3], ref = { engine: "claude", sessionId: S1, workspacePath: GAME };
    fake.adopt(run, ref); fake.emit([ev(run, 1, "session", S1)]); await settle(bridge);
    expect((await bridge.conversation("visible-root")).messages[0]).toMatchObject({ displayText: "真正目标😀", text: rows[0].text });
    expect(rows[0]).not.toHaveProperty("displayText");
    const entry = (storage.data.get(`wb:${HOST_TASKS_INDEX_KEY}`) as any).entries[0];
    expect(entry).toMatchObject({ coordination: true, displayText: "真正目标😀", userRow: { runId: run, seq: 1 } });
    expect(entry.fingerprint).toContain("真正目标😀");
  });
  it("requires opt-in coordinators to start a new session and fingerprints the opt-in", async () => {
    const fake = fakeFacade(), { bridge } = bridgeFor(fake);
    await expect(bridge.submit(submission("bad", { coordination: true }))).rejects.toThrow("sessionMode new");
    const request = submission("ordinary", { sessionMode: "new" });
    await bridge.submit(request);
    await expect(bridge.submit({ ...request, coordination: true })).rejects.toThrow("different submission");
  });
  it("P1 reserves an opt-in coordinator at acceptance, before first conversation attach", async () => {
    const fake = fakeFacade(), facade = fake.facade as HostTaskFacade;
    facade.conversationState = ref => ({ messages: [], runId: [...fake.routes].find(([, k]) => k === `${ref.engine}/${ref.sessionId}`)?.[0] ?? null, status: fake.sessions.get(`${ref.engine}/${ref.sessionId}`)?.status ?? "idle", canDeliver: true });
    facade.leaderBranches = async () => [{ id: "late-observed-child", parentEngine: "claude", parentSessionId: S1, engine: "claude", sessionId: S2, workspacePath: GAME, state: "running" }];
    facade.stopChild = vi.fn(async () => {});
    const { bridge, storage } = bridgeFor(fake);
    await bridge.submit(submission("A", { sessionMode: "new", writePaths: [], coordination: true } as any));
    expect((storage.data.get(`wb:${HOST_TASKS_INDEX_KEY}`) as any).entries[0].conversationHolding).toBe(true);
    await settle(bridge);
    const runA = fake.facade.sendNew.mock.calls[0][3], ref = { engine: "claude", sessionId: S1, workspacePath: GAME };
    fake.adopt(runA, ref); fake.emit([ev(runA, 1, "session", S1)]); await settle(bridge);
    fake.finish(runA, ref); fake.emit([ev(runA, 2, "done", null, S1)]); await settle(bridge);
    await bridge.submit(submission("B", { writePaths: [] })); await settle(bridge);
    expect(fake.facade.sendExisting).not.toHaveBeenCalled();
    expect(await bridge.receipt("B")).toMatchObject({ status: "queued", blockedBy: ["A"] });
    await bridge.stopConversation("A");
    expect(fake.facade.interrupt).not.toHaveBeenCalledWith((await bridge.receipt("B"))?.runId);
  });
  it("P1 restores the pre-attach coordinator hold after a cold restart", async () => {
    const first = fakeFacade(), { bridge, storage } = bridgeFor(first);
    await bridge.submit(submission("A", { sessionMode: "new", writePaths: [], coordination: true } as any)); await settle(bridge);
    const run = first.facade.sendNew.mock.calls[0][3], ref = { engine: "claude", sessionId: S1, workspacePath: GAME };
    first.adopt(run, ref); first.emit([ev(run, 1, "session", S1)]); await settle(bridge);
    first.finish(run, ref); first.emit([ev(run, 2, "done", null, S1)]); await settle(bridge); bridge.dispose();
    const next = fakeFacade(); next.addSession(ref);
    const facade = next.facade as HostTaskFacade;
    facade.conversationState = () => ({ messages: [], runId: null, status: "idle", canDeliver: true });
    facade.leaderBranches = async () => [{ id: "child", parentEngine: "claude", parentSessionId: S1, engine: "claude", sessionId: S2, workspacePath: GAME, state: "running" }];
    const restored = bridgeFor(next, { storage }).bridge;
    await restored.submit(submission("B", { writePaths: [] })); await settle(restored);
    expect(await restored.receipt("B")).toMatchObject({ status: "queued", blockedBy: ["A"] });
    expect(next.facade.sendExisting).not.toHaveBeenCalled(); expect(next.facade.sendNew).not.toHaveBeenCalled();
  });
  it("P1 refuses legacy attachment and stop after a newer task took the exact native session", async () => {
    const fake = fakeFacade(), { bridge } = bridgeFor(fake);
    const facade = fake.facade as HostTaskFacade;
    const summarize = vi.fn(async () => "Must not summarize the successor's history");
    facade.summarizeHandoff = summarize; facade.fullHistoryHandoffSupported = async () => true;
    await bridge.submit(submission("A")); await settle(bridge);
    const run = fake.facade.sendNew.mock.calls[0][3], ref = { engine: "claude", sessionId: S1, workspacePath: GAME };
    fake.adopt(run, ref); fake.emit([ev(run, 1, "session", S1)]); await settle(bridge);
    fake.finish(run, ref); fake.emit([ev(run, 2, "done", null, S1)]); await settle(bridge);
    await bridge.submit(submission("B")); await settle(bridge);
    expect(fake.facade.sendExisting).toHaveBeenCalledOnce();
    await expect(bridge.conversation("A")).rejects.toThrow(/owner|newer|exclusive/i);
    await expect(bridge.stopConversation("A")).rejects.toThrow(/owner|newer|exclusive/i);
    await expect(bridge.summarizeCoordinatorHandoff({ kind: "coordinator", conversationRequestId: "A", expectedRevision: 1 },
      { engine: "codex", model: "selected-compressor" })).rejects.toThrow(/owner|newer|exclusive/i);
    expect(summarize).not.toHaveBeenCalled();
    expect(fake.facade.interrupt).not.toHaveBeenCalled();
  });
  it("binds continuation to the owned initial request without consuming business ledger entries", async () => {
    const fake = fakeFacade();
    const facade = fake.facade as HostTaskFacade;
    facade.leaderBranches = async () => [];
    facade.conversationState = ref => ({ messages: [{ seq: 1, role: "user", text: "real native row", ts: null }],
      runId: [...fake.routes].find(([, key]) => key === `${ref.engine}/${ref.sessionId}`)?.[0] ?? null,
      status: fake.sessions.get(`${ref.engine}/${ref.sessionId}`)?.status ?? "idle", canDeliver: true });
    facade.continueMessage = vi.fn(async (ref, _prompt, _images, runId, fence) => { await fence("turn", runId); fake.routes.set(runId, `${ref.engine}/${ref.sessionId}`); return { delivery: "turn" as const, runId }; });
    const { bridge, storage } = bridgeFor(fake);
    await bridge.submit(submission("coordinator", { sessionMode: "new" })); await settle(bridge);
    expect(await bridge.conversation("coordinator")).toMatchObject({ sessionRef: null, canSend: false, status: "starting" });
    const run = fake.facade.sendNew.mock.calls[0][3]; const ref = { engine: "claude", sessionId: S1, workspacePath: GAME };
    fake.adopt(run, ref); fake.emit([ev(run, 1, "session", S1)]); await settle(bridge);
    fake.emit([ev(run, 2, "done", null, S1)]); fake.finish(run, ref); await settle(bridge);
    const view = await bridge.conversation("coordinator"); expect(view.sessionRef).toEqual(ref);
    await bridge.sendMessage({ conversationRequestId: "coordinator", requestId: "follow", expectedInputRevision: 0, prompt: "continue in place" });
    await vi.waitFor(async () => expect((await bridge.messageReceipt("coordinator", "follow"))?.status).toBe("received"));
    expect(await bridge.list()).toHaveLength(1);
    expect(fake.facade.sendNew).toHaveBeenCalledTimes(1); expect(fake.facade.sendExisting).not.toHaveBeenCalled();
    expect(facade.continueMessage).toHaveBeenCalledWith(ref, "continue in place", [], expect.any(String), expect.any(Function), expect.any(Object));
    expect((storage.data.get(`wb:${HOST_TASKS_INDEX_KEY}`) as any).entries[0].conversationHolding).toBe(true);
    const other = bridgeFor(fake, { pluginId: "other", storage }).bridge;
    await expect(other.conversation("coordinator")).rejects.toThrow("Unknown owned");
  });

  it("does not rotate a coordinator slot while its native child remains active after parent done", async () => {
    const fake = fakeFacade(); const facade = fake.facade as HostTaskFacade;
    facade.conversationState = () => ({ messages: [], runId: null, status: "idle", canDeliver: true });
    facade.leaderBranches = async () => [{ id: "real-child", title: "Native child", parentEngine: "claude", parentSessionId: S1, engine: "claude", sessionId: S2, workspacePath: GAME, state: "running" }];
    const { bridge } = bridgeFor(fake);
    await bridge.submit(submission("coordinator", { writePaths: [] })); await settle(bridge);
    const run = fake.facade.sendNew.mock.calls[0][3]; const ref = { engine: "claude", sessionId: S1, workspacePath: GAME };
    fake.adopt(run, ref); fake.emit([ev(run, 1, "session", S1)]); await settle(bridge);
    await bridge.conversation("coordinator"); fake.emit([ev(run, 2, "done", null, S1)]); fake.finish(run, ref); await settle(bridge);
    expect(await bridge.conversation("coordinator")).toMatchObject({ status: "running", canChangeSelection: false });
    await bridge.submit(submission("would-rotate", { writePaths: [], model: "different-model" })); await settle(bridge);
    expect(await bridge.receipt("would-rotate")).toMatchObject({ status: "queued", blockedBy: ["coordinator"] });
    expect(fake.facade.sendNew).toHaveBeenCalledTimes(1);
  });
  it("hydrates unresolved claims from disabled owners before a cold document can dispatch", async () => {
    const fake = fakeFacade();
    const loadClaims = vi.fn(async () => [{ pluginId: "disabled-owner", requestId: "old", runId: "old-native-run",
      workspacePath: GAME, writePaths: ["src"], session: null, status: "unknown" }]);
    const { bridge } = bridgeFor(fake, { pluginId: "new-owner", loadClaims });
    await bridge.submit(submission("overlap", { writePaths: ["src/component"] }));
    await bridge.submit(submission("disjoint", { slotKey: "docs", writePaths: ["docs"] }));
    await settle(bridge);
    expect(loadClaims).toHaveBeenCalledTimes(1);
    expect(await bridge.receipt("overlap")).toMatchObject({ status: "queued", blockedBy: ["old"] });
    expect(fake.facade.sendNew).toHaveBeenCalledTimes(1);
    expect(fake.facade.sendNew.mock.calls[0][2]).toContain("do disjoint");
  });

  it("does not dispatch if persisted foreign claims cannot be read", async () => {
    const fake = fakeFacade();
    const { bridge } = bridgeFor(fake, { loadClaims: async () => { throw new Error("claim storage unavailable"); } });
    await expect(bridge.submit(submission("blocked"))).rejects.toThrow(/claim storage unavailable/);
    expect(fake.facade.sendNew).not.toHaveBeenCalled();
  });

  it("keeps the source identity explicit when a rollover excerpt cannot be read", async () => {
    const fake = fakeFacade(), ref = { engine: "claude", sessionId: S1, workspacePath: GAME };
    fake.addSession(ref); fake.rollover.add(`claude/${S1}`);
    fake.facade.loadPage.mockRejectedValueOnce(new Error("history unavailable"));
    const storage = storageFor();
    storage.data.set(`wb:${HOST_TASKS_INDEX_KEY}`, { version: 1, entries: [], slots: [{ projectId: "sample-project", slotKey: "impl", session: ref, lastRequestId: "previous", updatedAt: 1 }] });
    const { bridge } = bridgeFor(fake, { storage });
    await bridge.submit(submission("fallback")); await settle(bridge);
    expect(fake.facade.sendNew).toHaveBeenCalledTimes(1);
    expect(fake.facade.sendNew.mock.calls[0][2]).toContain(`Handoff source: claude:${S1}`);
    expect(fake.facade.sendNew.mock.calls[0][2]).toContain("prior summary is unavailable");
  });

  it("creates a background chat on first use, adopts only the native session id and completes", async () => {
    const fake = fakeFacade();
    const { bridge } = bridgeFor(fake);
    const seen: HostTaskReceipt[] = [];
    bridge.onEvent((r) => seen.push(r));
    const accepted = await bridge.submit(submission("r1", { writePaths: ["game/src"], contextRefs: ["memory:abc"] }));
    expect(accepted.status).toBe("queued");
    await settle(bridge);
    expect(fake.facade.openDraft).toHaveBeenCalledWith("claude", GAME, { defaultModel: "opus", defaultEffort: "high", defaultProvider: null });
    const [, , prompt, runId] = fake.facade.sendNew.mock.calls[0];
    expect(prompt).toContain("do r1");
    expect(prompt).toContain("Declared write scope: game/src");
    expect(prompt).toContain("- memory:abc");
    let receipt = (await bridge.receipt("r1"))!;
    expect(receipt).toMatchObject({ status: "executing", sessionDecision: "new", session: null, runId });
    fake.adopt(runId, { engine: "claude", sessionId: S1, workspacePath: GAME });
    fake.emit([ev(runId, 1, "session", S1), ev(runId, 2, "delta", "hello ", S1), ev(runId, 3, "delta", "world", S1)]);
    await settle(bridge);
    receipt = (await bridge.receipt("r1"))!;
    expect(receipt.session).toEqual({ engine: "claude", sessionId: S1, workspacePath: GAME });
    expect(receipt.text).toBe("hello world");
    fake.emit([ev(runId, 4, "done", null, S1)]);
    fake.finish(runId, { engine: "claude", sessionId: S1, workspacePath: GAME });
    await settle(bridge);
    expect((await bridge.receipt("r1"))!.status).toBe("completed");
    expect(await bridge.slots("sample-project")).toMatchObject([{ slotKey: "impl", session: { sessionId: S1 }, lastRequestId: "r1" }]);
    expect(seen.map((r) => r.status)).toContain("starting");
  });

  it("reuses the slot's chat in auto mode, waits while it is busy or awaiting approval, and new mode starts another chat", async () => {
    const fake = fakeFacade();
    const ref = { engine: "claude", sessionId: S1, workspacePath: GAME };
    fake.addSession(ref, "busy");
    const storage = storageFor();
    storage.data.set(`wb:${HOST_TASKS_INDEX_KEY}`, { version: 1, entries: [], slots: [{ projectId: "sample-project", slotKey: "impl", session: ref, lastRequestId: "old", updatedAt: 1 }] });
    const { bridge } = bridgeFor(fake, { storage });
    await bridge.submit(submission("r2"));
    await settle(bridge);
    expect(fake.facade.sendExisting).not.toHaveBeenCalled();
    fake.setStatus(ref, "awaiting_permission");
    await settle(bridge);
    expect(fake.facade.sendExisting).not.toHaveBeenCalled();
    fake.setStatus(ref, "idle");
    await settle(bridge);
    expect(fake.facade.sendExisting).toHaveBeenCalledWith(ref, expect.stringContaining("do r2"), expect.any(String), expect.any(Object), expect.any(Function));
    const runId = fake.facade.sendExisting.mock.calls[0][2];
    expect((await bridge.receipt("r2"))).toMatchObject({ sessionDecision: "reused", session: ref });
    fake.emit([ev(runId, 1, "delta", "ok", S1), ev(runId, 2, "done", null, S1)]);
    fake.finish(runId, ref);
    await settle(bridge);
    expect((await bridge.receipt("r2"))!.status).toBe("completed");
    await bridge.submit(submission("r3", { sessionMode: "new" }));
    await settle(bridge);
    expect(fake.facade.sendNew).toHaveBeenCalledTimes(1);
  });

  it("opens a closed slot chat in the background before delivering, and falls back to a new chat when it is gone", async () => {
    const fake = fakeFacade();
    const ref = { engine: "claude", sessionId: S1, workspacePath: GAME };
    fake.addSession(ref, null);
    const storage = storageFor();
    storage.data.set(`wb:${HOST_TASKS_INDEX_KEY}`, { version: 1, entries: [], slots: [
      { projectId: "sample-project", slotKey: "impl", session: ref, lastRequestId: "old", updatedAt: 1 },
      { projectId: "sample-project", slotKey: "gone", session: { ...ref, sessionId: S3 }, lastRequestId: "old", updatedAt: 1 },
    ] });
    const { bridge } = bridgeFor(fake, { storage });
    await bridge.submit(submission("r1"));
    await settle(bridge);
    expect(fake.facade.openBackground).toHaveBeenCalledWith(ref);
    expect(fake.facade.sendExisting).toHaveBeenCalledTimes(1);
    await bridge.submit(submission("r2", { slotKey: "gone", writePaths: [] }));
    await settle(bridge);
    expect(fake.facade.sendNew).toHaveBeenCalledTimes(1);
    expect((await bridge.receipt("r2"))!.sessionDecision).toBe("new");
  });

  it("waits for a pending chat the user holds instead of using it, including when the user types during persistence before sendNew", async () => {
    const fake = fakeFacade();
    fake.drafts.set(`claude:${GAME}`, { held: true });
    const { bridge, storage } = bridgeFor(fake);
    await bridge.submit(submission("r1"));
    await settle(bridge);
    expect(fake.facade.sendNew).not.toHaveBeenCalled();
    expect(await bridge.receipt("r1")).toMatchObject({ status: "queued", blockedBy: ["user-draft"] });
    // Now release draft so openDraft succeeds, but simulate user typing while storage.set (persist) is awaiting before sendNew.
    fake.drafts.delete(`claude:${GAME}`);
    let intercepted = false;
    const origSet = storage.set.getMockImplementation()!;
    storage.set.mockImplementation(async (id: string, key: string, value: unknown) => {
      await origSet(id, key, value);
      const saved = value as { entries: Array<{ receipt: { requestId: string; status: string } }> };
      if (!intercepted && saved.entries.some((e) => e.receipt.requestId === "r1" && e.receipt.status === "starting")) {
        intercepted = true;
        fake.drafts.set(`claude:${GAME}`, { held: true });
      }
    });
    fake.poke();
    await settle(bridge);
    expect(intercepted).toBe(true);
    expect(fake.facade.sendNew).not.toHaveBeenCalled();
    expect(await bridge.receipt("r1")).toMatchObject({ status: "queued", blockedBy: ["user-draft"] });
    fake.drafts.delete(`claude:${GAME}`);
    fake.poke();
    await settle(bridge);
    expect(fake.facade.sendNew).toHaveBeenCalledTimes(1);
  });

  it("persists changed fixed draft reasons and clears them before sending the same request", async () => {
    const fake = fakeFacade(), facade = fake.facade as HostTaskFacade;
    const reason = vi.fn<NonNullable<HostTaskFacade["draftBlockReason"]>>().mockReturnValue("user-draft:focused");
    facade.draftBlockReason = reason;
    fake.drafts.set(`claude:${GAME}`, { held: true });
    const { bridge, storage } = bridgeFor(fake), events = vi.fn();
    const off = bridge.onEvent(events);
    try {
      await bridge.submit(submission("diagnosed")); await settle(bridge);
      expect(await bridge.receipt("diagnosed")).toMatchObject({ status: "queued", blockedBy: ["user-draft", "user-draft:focused"] });
      expect(reason).toHaveBeenLastCalledWith("claude", GAME, expect.any(Object), { requireOpenTab: false });
      expect(fake.facade.openDraft).toHaveBeenCalledTimes(1);
      reason.mockReturnValue("user-draft:text");
      events.mockClear(); fake.poke(); await settle(bridge);
      expect(await bridge.receipt("diagnosed")).toMatchObject({ status: "queued", blockedBy: ["user-draft", "user-draft:text"] });
      expect(events).toHaveBeenCalledWith(expect.objectContaining({ requestId: "diagnosed", blockedBy: ["user-draft", "user-draft:text"] }));
      const nativeSend = fake.facade.sendNew.getMockImplementation()!;
      fake.facade.sendNew.mockImplementation(async (...args) => {
        const index = storage.data.get(`wb:${HOST_TASKS_INDEX_KEY}`) as { entries: Array<{ receipt: HostTaskReceipt }> };
        expect(index.entries[0].receipt).toMatchObject({ status: "starting", requestId: "diagnosed" });
        expect(index.entries[0].receipt.blockedBy).toBeUndefined();
        return nativeSend(...args);
      });
      fake.drafts.delete(`claude:${GAME}`); reason.mockReturnValue(null); fake.poke(); await settle(bridge);
      expect(fake.facade.sendNew).toHaveBeenCalledTimes(1);
      expect((await bridge.receipt("diagnosed"))?.blockedBy).toBeUndefined();
      fake.poke(); await settle(bridge);
      expect(fake.facade.sendNew).toHaveBeenCalledTimes(1);
    } finally { off(); }
  });

  it.each(["text", "images"])("reveals only the exact queued %s draft and does not send it", async kind => {
    const fake = fakeFacade(), facade = fake.facade as HostTaskFacade;
    facade.draftBlockReason = vi.fn(() => `user-draft:${kind}` as "user-draft:text" | "user-draft:images");
    fake.drafts.set(`claude:${GAME}`, { held: true });
    const { bridge } = bridgeFor(fake);
    await bridge.submit(submission("reveal")); await settle(bridge);
    await bridge.open("reveal");
    expect(fake.facade.focusDraft).toHaveBeenCalledExactlyOnceWith("claude", GAME, { requireBlockedDraft: true });
    expect(fake.facade.sendNew).not.toHaveBeenCalled(); expect(fake.facade.focus).not.toHaveBeenCalled();
    expect(await bridge.receipt("reveal")).toMatchObject({ status: "queued", session: null, runId: null });
    await bridge.cancel("reveal");
    await expect(bridge.open("reveal")).rejects.toThrow(/no conversation/);
    expect(fake.facade.focusDraft).toHaveBeenCalledTimes(1);
  });
  it("reports a changed draft reveal instead of treating it as a successful open", async () => {
    const fake = fakeFacade(), facade = fake.facade as HostTaskFacade;
    facade.draftBlockReason = () => "user-draft:text";
    fake.drafts.set(`claude:${GAME}`, { held: true });
    fake.facade.focusDraft.mockImplementation(() => { throw new Error("draft changed"); });
    const { bridge } = bridgeFor(fake);
    await bridge.submit(submission("changed")); await settle(bridge);
    await expect(bridge.open("changed")).rejects.toThrow("draft changed");
    expect(await bridge.receipt("changed")).toMatchObject({ status: "queued" });
    expect(fake.facade.sendNew).not.toHaveBeenCalled();
  });
  it("queries the open-tab guard after openDraft succeeds but draftReady refuses", async () => {
    const fake = fakeFacade(), facade = fake.facade as HostTaskFacade;
    facade.draftBlockReason = vi.fn<NonNullable<HostTaskFacade["draftBlockReason"]>>(() => "user-draft:streaming");
    fake.drafts.set(`claude:${GAME}`, { busy: true });
    const { bridge } = bridgeFor(fake);
    await bridge.submit(submission("busy-draft")); await settle(bridge);
    expect(facade.draftBlockReason).toHaveBeenCalledWith("claude", GAME, expect.any(Object), { requireOpenTab: true });
    expect(await bridge.receipt("busy-draft")).toMatchObject({ status: "queued", blockedBy: ["user-draft", "user-draft:streaming"] });
    expect(fake.facade.sendNew).not.toHaveBeenCalled();
  });

  it("records the fresh reason when the draft disappears while starting is being persisted", async () => {
    const fake = fakeFacade(), facade = fake.facade as HostTaskFacade;
    facade.draftBlockReason = vi.fn<NonNullable<HostTaskFacade["draftBlockReason"]>>(() => "user-draft:missing-tab");
    const { bridge, storage } = bridgeFor(fake), original = storage.set.getMockImplementation()!;
    storage.set.mockImplementation(async (id, key, value) => {
      await original(id, key, value);
      const index = value as { entries?: Array<{ receipt: HostTaskReceipt }> };
      if (key === HOST_TASKS_INDEX_KEY && index.entries?.some(e => e.receipt.status === "starting")) fake.drafts.delete(`claude:${GAME}`);
    });
    await bridge.submit(submission("lost-draft")); await settle(bridge);
    expect(await bridge.receipt("lost-draft")).toMatchObject({ status: "queued", runId: null, session: null, sessionDecision: null,
      blockedBy: ["user-draft", "user-draft:missing-tab"] });
    expect(facade.draftBlockReason).toHaveBeenCalledWith("claude", GAME, expect.any(Object), { requireOpenTab: true });
    expect(fake.facade.sendNew).not.toHaveBeenCalled();
  });

  it("never replays an unknown send when independent draft notifications recur", async () => {
    const fake = fakeFacade(), facade = fake.facade as HostTaskFacade;
    facade.draftBlockReason = vi.fn(() => null);
    fake.facade.sendNew.mockRejectedValueOnce(new Error("ambiguous transport outcome"));
    const { bridge, storage } = bridgeFor(fake);
    await bridge.submit(submission("uncertain-draft")); await settle(bridge);
    expect(await bridge.receipt("uncertain-draft")).toMatchObject({ status: "unknown" });
    fake.poke(); fake.poke(); await settle(bridge);
    expect(fake.facade.sendNew).toHaveBeenCalledTimes(1);
    bridge.dispose();
    const restored = bridgeFor(fake, { storage }).bridge;
    await restored.ready(); fake.poke(); await settle(restored);
    expect(await restored.receipt("uncertain-draft")).toMatchObject({ status: "unknown" });
    expect(fake.facade.sendNew).toHaveBeenCalledTimes(1);
  });

  it("freezes defaultEngine, defaultModel and defaultEffort at submit time even if global defaults change while queued", async () => {
    const fake = fakeFacade();
    fake.drafts.set(`claude:${GAME}`, { held: true });
    const { bridge } = bridgeFor(fake);
    await bridge.submit(submission("frozen-req"));
    await settle(bridge);
    expect((await bridge.receipt("frozen-req"))!.status).toBe("queued");
    fake.setDefaults({ activeEngine: "codex", defaultModel: "haiku", defaultEffort: "low" });
    fake.drafts.delete(`claude:${GAME}`);
    fake.poke();
    await settle(bridge);
    expect(fake.facade.openDraft).toHaveBeenCalledWith("claude", GAME, { defaultModel: "opus", defaultEffort: "high", defaultProvider: null });
    expect(fake.facade.sendNew).toHaveBeenCalledWith("claude", GAME, expect.any(String), expect.any(String), { defaultModel: "opus", defaultEffort: "high", defaultProvider: null }, expect.any(Function));
  });

  it("automatically rolls over to a new session with bounded handoff when compaction or context occupancy threshold is reached", async () => {
    const fake = fakeFacade();
    const ref = { engine: "claude", sessionId: S1, workspacePath: GAME };
    fake.addSession(ref, "idle");
    fake.rollover.add(`claude/${S1}`);
    const storage = storageFor();
    storage.data.set(`wb:${HOST_TASKS_INDEX_KEY}`, {
      version: 1,
      entries: [],
      slots: [{ projectId: "sample-project", slotKey: "impl", session: ref, lastRequestId: "old", updatedAt: 1 }],
    });
    const { bridge } = bridgeFor(fake, { storage });
    await bridge.submit(submission("roll-1", { writePaths: ["game/src"] }));
    await settle(bridge);
    expect(fake.facade.sendExisting).not.toHaveBeenCalled();
    expect(fake.facade.sendNew).toHaveBeenCalledTimes(1);
    const [, , prompt, runId] = fake.facade.sendNew.mock.calls[0];
    expect(prompt).toContain("Handoff from chat claude:");
    expect(prompt).toContain("old question");
    fake.adopt(runId, { engine: "claude", sessionId: S2, workspacePath: GAME });
    fake.emit([ev(runId, 1, "session", S2), ev(runId, 2, "done", null, S2)]);
    fake.finish(runId, { engine: "claude", sessionId: S2, workspacePath: GAME });
    await settle(bridge);
    expect(await bridge.receipt("roll-1")).toMatchObject({
      status: "completed",
      sessionDecision: "new",
      session: { engine: "claude", sessionId: S2, workspacePath: GAME },
    });
  });

  it("is idempotent per requestId and rejects a different submission under the same id", async () => {
    const fake = fakeFacade();
    const { bridge } = bridgeFor(fake);
    const first = await bridge.submit(submission("dup"));
    await expect(bridge.submit(submission("dup"))).resolves.toMatchObject({ requestId: "dup", executionId: first.executionId });
    await expect(bridge.submit(submission("dup", { prompt: "other" }))).rejects.toThrow(/different submission/);
    await settle(bridge);
    expect(fake.facade.sendNew).toHaveBeenCalledTimes(1);
  });

  it("rejects unregistered, archived and escaping targets before accepting", async () => {
    const fake = fakeFacade();
    const { bridge, storage } = bridgeFor(fake);
    await expect(bridge.submit(submission("a", { workspacePath: "G:/nowhere" }))).rejects.toThrow(/registered/);
    await expect(bridge.submit(submission("b", { workspacePath: "G:/old" }))).rejects.toThrow(/registered/);
    await expect(bridge.submit(submission("c", { writePaths: ["../SAMPLE-PROJECT/x"] }))).rejects.toThrow(/escapes/);
    await expect(bridge.submit(submission("d", { writePaths: ["G:/proj/SAMPLE-PROJECT/x"] }))).rejects.toThrow(/outside/);
    await expect(bridge.submit(submission("e", { engine: "nope" }))).rejects.toThrow(/not available/);
    expect(storage.set).not.toHaveBeenCalled();
  });
});

describe("host task write conflicts", () => {
  it("orders overlapping and undeclared writes, but runs disjoint and read-only work in parallel", async () => {
    const fake = fakeFacade();
    const { bridge } = bridgeFor(fake);
    await bridge.submit(submission("w1", { slotKey: "a", writePaths: ["game/src"] }));
    await bridge.submit(submission("w2", { slotKey: "b", writePaths: ["game/src/battle"], engine: "codex" }));
    await bridge.submit(submission("w3", { slotKey: "c", writePaths: ["plan"], workspacePath: GAME, engine: "codex" }));
    await bridge.submit(submission("w4", { slotKey: "d", writePaths: [], workspacePath: TOOL }));
    await bridge.submit(submission("w5", { slotKey: "e", workspacePath: TOOL, engine: "codex" }));
    await settle(bridge);
    const status = async (id: string) => (await bridge.receipt(id))!;
    expect((await status("w1")).status).toBe("executing");
    expect(await status("w2")).toMatchObject({ status: "queued", blockedBy: ["w1"] });
    expect((await status("w3")).status).toBe("executing");
    expect((await status("w4")).status).toBe("executing");
    // Undeclared writes claim the whole workspace, but a read-only task never conflicts.
    expect((await status("w5")).status).toBe("executing");
    const run1 = fake.facade.sendNew.mock.calls.find((c) => c[2].includes("do w1"))![3];
    fake.adopt(run1, { engine: "claude", sessionId: S1, workspacePath: GAME });
    fake.emit([ev(run1, 1, "session", S1), ev(run1, 2, "done", null, S1)]);
    fake.finish(run1, { engine: "claude", sessionId: S1, workspacePath: GAME });
    await settle(bridge);
    expect((await status("w1")).status).toBe("completed");
    // w1's claim is gone; w2 now waits only for the codex pending chat w3 is still launching in GAME.
    expect(await status("w2")).toMatchObject({ status: "queued" });
    expect((await status("w2")).blockedBy).toBeUndefined();
  });

  it("spawns a parallel background chat when the same logical slot is busy with a disjoint write-set task", async () => {
    const fake = fakeFacade();
    const { bridge } = bridgeFor(fake);
    await bridge.submit(submission("s1", { slotKey: "impl", writePaths: ["game/src/ui"] }));
    await settle(bridge);
    const run1 = fake.facade.sendNew.mock.calls[0][3];
    fake.adopt(run1, { engine: "claude", sessionId: S1, workspacePath: GAME });
    fake.emit([ev(run1, 1, "session", S1)]);
    await settle(bridge);
    expect(await bridge.receipt("s1")).toMatchObject({
      status: "executing",
      session: { engine: "claude", sessionId: S1, workspacePath: GAME },
    });

    // Submit a second step in the SAME slotKey ("impl") with disjoint writePaths while s1 is still executing in S1.
    await bridge.submit(submission("s2", { slotKey: "impl", writePaths: ["game/src/net"] }));
    // Submit a third step in the SAME slotKey ("impl") with overlapping writePaths — must still be blocked by s2!
    await bridge.submit(submission("s3", { slotKey: "impl", writePaths: ["game/src/net/packet.ts"] }));
    await settle(bridge);

    expect(fake.facade.sendNew).toHaveBeenCalledTimes(2);
    const run2 = fake.facade.sendNew.mock.calls[1][3];
    fake.adopt(run2, { engine: "claude", sessionId: S2, workspacePath: GAME });
    fake.emit([ev(run2, 1, "session", S2)]);
    await settle(bridge);

    expect(await bridge.receipt("s1")).toMatchObject({
      status: "executing",
      sessionDecision: "new",
      session: { engine: "claude", sessionId: S1, workspacePath: GAME },
    });
    expect(await bridge.receipt("s2")).toMatchObject({
      status: "executing",
      sessionDecision: "new",
      session: { engine: "claude", sessionId: S2, workspacePath: GAME },
    });
    expect(await bridge.receipt("s3")).toMatchObject({
      status: "queued",
      blockedBy: ["s2"],
    });
  });

  it("sees another plugin's running claim and is isolated from its receipts", async () => {
    const fake = fakeFacade();
    const one = bridgeFor(fake, { pluginId: "one" });
    const two = bridgeFor(fake, { pluginId: "two" });
    await one.bridge.submit(submission("x", { writePaths: ["game"] }));
    await settle(one.bridge);
    await two.bridge.submit(submission("y", { writePaths: ["game/src"], engine: "codex" }));
    await settle(two.bridge);
    expect(await two.bridge.receipt("x")).toBeNull();
    expect(await two.bridge.receipt("y")).toMatchObject({ status: "queued", blockedBy: ["x"] });
    expect(await two.bridge.list()).toHaveLength(1);
    await expect(two.bridge.cancel("x")).resolves.toBeNull();
    const run = fake.facade.sendNew.mock.calls[0][3];
    fake.adopt(run, { engine: "claude", sessionId: S1, workspacePath: GAME });
    fake.emit([ev(run, 1, "session", S1), ev(run, 2, "error", "boom", S1)]);
    fake.finish(run, { engine: "claude", sessionId: S1, workspacePath: GAME });
    await settle(one.bridge); await settle(two.bridge);
    expect((await one.bridge.receipt("x"))!).toMatchObject({ status: "failed", error: "boom" });
    expect((await two.bridge.receipt("y"))!.status).toBe("executing");
  });
});

describe("host task cancellation and failures", () => {
  it("withdraws queued work and interrupts only its own running turn", async () => {
    const fake = fakeFacade();
    const { bridge } = bridgeFor(fake);
    await bridge.submit(submission("run", { writePaths: ["a"] }));
    await bridge.submit(submission("wait", { writePaths: ["a"], slotKey: "other" }));
    await settle(bridge);
    expect(await bridge.cancel("wait")).toMatchObject({ status: "cancelled" });
    const runId = fake.facade.sendNew.mock.calls[0][3];
    await bridge.cancel("run");
    expect(fake.facade.interrupt).toHaveBeenCalledWith(runId);
    fake.adopt(runId, { engine: "claude", sessionId: S1, workspacePath: GAME });
    fake.emit([ev(runId, 1, "session", S1), ev(runId, 2, "turn_complete", { interrupted: true }, S1)]);
    await settle(bridge);
    expect((await bridge.receipt("run"))!.status).toBe("cancelled");
    expect(fake.facade.sendNew).toHaveBeenCalledTimes(1);
  });

  it("interrupts after a late ACK when cancel raced the native start", async () => {
    const fake = fakeFacade();
    let release!: () => void;
    fake.facade.sendNew.mockImplementationOnce((engine, workspacePath, _p, runId) => new Promise((resolve) => {
      release = () => { fake.routes.set(runId, `new:${engine}:${workspacePath}`); resolve({ runId, sessionId: null }); };
    }));
    const { bridge } = bridgeFor(fake);
    await bridge.submit(submission("race"));
    await settle(bridge);
    expect((await bridge.receipt("race"))!.status).toBe("starting");
    await bridge.cancel("race");
    expect(fake.facade.interrupt).not.toHaveBeenCalled();
    release();
    await settle(bridge);
    expect(fake.facade.interrupt).toHaveBeenCalledTimes(1);
  });

  it("settles a pre-spawn refusal as unsent and never resends an ambiguous native failure", async () => {
    const fake = fakeFacade();
    fake.facade.sendNew.mockRejectedValueOnce(new TaskPreSpawnError("busy"));
    const { bridge } = bridgeFor(fake);
    await bridge.submit(submission("p"));
    await settle(bridge);
    expect(fake.facade.sendNew).toHaveBeenCalledTimes(1);
    expect(await bridge.receipt("p")).toMatchObject({ status: "failed", error: expect.stringContaining("not sent") });
    const fake2 = fakeFacade();
    fake2.facade.sendNew.mockRejectedValueOnce(new Error("pipe broke"));
    const second = bridgeFor(fake2, { pluginId: "other" });
    await second.bridge.submit(submission("q", { workspacePath: TOOL }));
    await settle(second.bridge);
    expect((await second.bridge.receipt("q"))!).toMatchObject({ status: "unknown" });
    fake2.poke();
    await settle(second.bridge);
    expect(fake2.facade.sendNew).toHaveBeenCalledTimes(1);
  });

  it("marks a changed native identity unknown and never rebinds it", async () => {
    const fake = fakeFacade();
    const ref = { engine: "claude", sessionId: S1, workspacePath: GAME };
    fake.addSession(ref);
    const storage = storageFor();
    storage.data.set(`wb:${HOST_TASKS_INDEX_KEY}`, { version: 1, entries: [], slots: [{ projectId: "sample-project", slotKey: "impl", session: ref, lastRequestId: "o", updatedAt: 1 }] });
    const { bridge } = bridgeFor(fake, { storage });
    await bridge.submit(submission("m"));
    await settle(bridge);
    const runId = fake.facade.sendExisting.mock.calls[0][2];
    fake.emit([ev(runId, 1, "delta", "x", S2)]);
    await settle(bridge);
    expect((await bridge.receipt("m"))!).toMatchObject({ status: "unknown", session: ref });
    expect((await bridge.slots())[0].session.sessionId).toBe(S1);
  });
});

describe("host task restoration", () => {
  it("keeps queued work, tracks runs this document still routes, and marks the rest unknown without replay while preserving write locks", async () => {
    const fake = fakeFacade();
    const storage = storageFor();
    const first = bridgeFor(fake, { storage });
    await first.bridge.submit(submission("live", { slotKey: "a", writePaths: ["a"] }));
    await first.bridge.submit(submission("dead", { slotKey: "b", writePaths: ["b"], engine: "codex" }));
    await first.bridge.submit(submission("later", { slotKey: "c", writePaths: ["a"], workspacePath: GAME }));
    await first.bridge.submit(submission("blocked-by-dead", { slotKey: "d", writePaths: ["b/sub"], workspacePath: GAME }));
    await settle(first.bridge);
    const liveRun = fake.facade.sendNew.mock.calls[0][3];
    const deadRun = fake.facade.sendNew.mock.calls[1][3];
    fake.adopt(liveRun, { engine: "claude", sessionId: S1, workspacePath: GAME });
    fake.adopt(deadRun, { engine: "codex", sessionId: S2, workspacePath: GAME });
    fake.emit([ev(deadRun, 1, "session", S2, S2, "codex")]);
    await settle(first.bridge);
    fake.routes.delete(deadRun);
    first.bridge.dispose();
    bridges.splice(bridges.indexOf(first.bridge), 1);

    const sendsBefore = fake.facade.sendNew.mock.calls.length;
    const second = bridgeFor(fake, { storage });
    const otherPlugin = bridgeFor(fake, { pluginId: "other-plugin" });
    await otherPlugin.bridge.submit(submission("cross-plugin-b", { slotKey: "x", writePaths: ["b/other"], workspacePath: GAME, engine: "codex" }));
    await settle(second.bridge);
    await settle(otherPlugin.bridge);

    expect(await second.bridge.receipt("live")).toMatchObject({ status: "executing", session: { sessionId: S1 } });
    expect(await second.bridge.receipt("dead")).toMatchObject({ status: "unknown" });
    expect(await second.bridge.receipt("later")).toMatchObject({ status: "queued", blockedBy: ["live"] });
    // Unknown is NOT terminal evidence: it must continue blocking overlapping writes in the same and other plugins!
    expect(await second.bridge.receipt("blocked-by-dead")).toMatchObject({ status: "queued", blockedBy: ["dead"] });
    expect(await otherPlugin.bridge.receipt("cross-plugin-b")).toMatchObject({ status: "queued", blockedBy: ["dead"] });
    expect(fake.facade.sendNew.mock.calls.length).toBe(sendsBefore);

    // An unrelated UI turn starting and finishing on S2 without deadRun's settlement proof must NOT release dead's lock.
    fake.setStatus({ engine: "codex", sessionId: S2, workspacePath: GAME }, "busy");
    fake.setStatus({ engine: "codex", sessionId: S2, workspacePath: GAME }, "idle");
    await settle(second.bridge);
    expect(await second.bridge.receipt("dead")).toMatchObject({ status: "unknown" });
    expect(await second.bridge.receipt("blocked-by-dead")).toMatchObject({ status: "queued", blockedBy: ["dead"] });

    // Cancel on unknown attempts interrupt without faking cancelled status while unconfirmed.
    fake.routes.set(deadRun, `codex/${S2}`);
    expect(await second.bridge.cancel("dead")).toMatchObject({ status: "unknown" });
    expect(fake.facade.interrupt).toHaveBeenCalledWith(deadRun);
    fake.routes.delete(deadRun);

    // Once native run settlement proof arrives for deadRun, dead settles and releases its write lock!
    fake.settled.set(deadRun, { status: "cancelled" });
    fake.poke();
    await settle(second.bridge);
    await settle(otherPlugin.bridge);
    expect(await second.bridge.receipt("dead")).toMatchObject({ status: "cancelled" });
    expect((await second.bridge.receipt("blocked-by-dead"))!.status).toBe("executing");
    expect((await otherPlugin.bridge.receipt("cross-plugin-b"))!.status).toBe("executing");
    const unblockedRun = (await second.bridge.receipt("blocked-by-dead"))!.runId!;
    fake.adopt(unblockedRun, { engine: "claude", sessionId: S3, workspacePath: GAME });
    fake.emit([ev(unblockedRun, 1, "session", S3), ev(liveRun, 5, "done", null, S1)]);
    fake.finish(liveRun, { engine: "claude", sessionId: S1, workspacePath: GAME });
    await settle(second.bridge);
    expect((await second.bridge.receipt("live"))!.status).toBe("completed");
    expect((await second.bridge.receipt("later"))!.status).not.toBe("queued");
  });

  it("converges runs that finished during a live-update checkpoint handoff gap", async () => {
    const coord1 = createRuntimeCheckpointCoordinator();
    coord1.initialize(undefined, { requiredParticipants: [] });
    const fake = fakeFacade();
    const storage = storageFor();
    const first = bridgeFor(fake, { storage, checkpoint: coord1 });
    await first.bridge.submit(submission("ckpt-1", { writePaths: ["game/src"] }));
    await settle(first.bridge);
    const runId = fake.facade.sendNew.mock.calls[0][3];
    fake.adopt(runId, { engine: "claude", sessionId: S1, workspacePath: GAME });
    fake.emit([ev(runId, 1, "session", S1), ev(runId, 2, "delta", "checkpoint text", S1)]);
    await settle(first.bridge);

    const checkpoint = await coord1.prepare();
    expect(pendingHostTaskPluginIds(checkpoint)).toEqual(["wb"]);
    first.bridge.dispose();
    bridges.splice(bridges.indexOf(first.bridge), 1);

    // During the live-update handoff gap, the run finishes natively.
    fake.finish(runId, { engine: "claude", sessionId: S1, workspacePath: GAME });

    const coord2 = createRuntimeCheckpointCoordinator();
    coord2.initialize(checkpoint, { requiredParticipants: [] });
    const second = bridgeFor(fake, { storage, checkpoint: coord2 });
    await second.bridge.slots();
    await coord2.awaitReady();
    coord2.resumeCommitted();
    await settle(second.bridge);

    expect(await second.bridge.receipt("ckpt-1")).toMatchObject({
      status: "completed",
      session: { engine: "claude", sessionId: S1, workspacePath: GAME },
      text: "checkpoint text",
    });
  });

  it("prunes large output on forget for settled receipts while retaining tombstone identity and rejecting unknown/active", async () => {
    const fake = fakeFacade();
    const { bridge } = bridgeFor(fake);
    await bridge.submit(submission("f", { writePaths: ["a"] }));
    await settle(bridge);
    expect(await bridge.forget("f")).toBe(false);
    const runId = fake.facade.sendNew.mock.calls[0][3];
    fake.adopt(runId, { engine: "claude", sessionId: S1, workspacePath: GAME });
    fake.emit([ev(runId, 1, "session", S1), ev(runId, 2, "delta", "large assistant output", S1), ev(runId, 3, "done", null, S1)]);
    fake.finish(runId, { engine: "claude", sessionId: S1, workspacePath: GAME });
    await settle(bridge);
    expect((await bridge.receipt("f"))!.text).toBe("large assistant output");
    expect(await bridge.forget("f")).toBe(true);
    const forgotten = await bridge.receipt("f");
    expect(forgotten).toMatchObject({
      requestId: "f",
      status: "completed",
      session: { engine: "claude", sessionId: S1, workspacePath: GAME },
    });
    expect(forgotten!.text).toBeUndefined();
    // Re-submitting the same requestId returns the retained tombstone receipt without replaying.
    await expect(bridge.submit(submission("f", { writePaths: ["a"] }))).resolves.toMatchObject({
      requestId: "f",
      status: "completed",
    });
    await expect(bridge.submit(submission("f", { writePaths: ["a"], prompt: "different" }))).rejects.toThrow(/different submission/);
    expect(fake.facade.sendNew).toHaveBeenCalledTimes(1);
  });
});

describe("host task planning and history", () => {
  const planRequest = { requestId: "plan-1", goal: "修复技能冷却", projects: [{ id: "game", label: "迁移", workspacePath: GAME }, { id: "tool", label: "工作台", workspacePath: TOOL }] };

  it("plans through the host command with the active engine, caches the answer across default switches and rejects a reused id", async () => {
    const fake = fakeFacade();
    const invoke = vi.fn(async (_command: string, args: Record<string, unknown>) => ({
      requestId: (args.request as { requestId: string }).requestId, status: "ready",
      steps: [{ id: "s1", title: "T", projectId: "game", instruction: "do", dependsOn: [], contextRefs: [], writePaths: ["game"] }],
      planner: { engine: "claude", model: "opus" }, createdAt: 1,
    }));
    const { bridge } = bridgeFor(fake, { invoke });
    const plan = await bridge.plan(planRequest);
    expect(plan.steps[0].projectId).toBe("game");
    expect(invoke).toHaveBeenCalledWith("plugin_task_plan", {
      pluginId: "wb",
      request: expect.objectContaining({ planner: { engine: "claude", model: "opus", effort: "high" } }),
    });
    // Switching defaultEngine / defaultModel / defaultEffort must not break idempotency or re-invoke the model for the same requestId.
    fake.setDefaults({ activeEngine: "codex", defaultModel: "sonnet", defaultEffort: "low" });
    await expect(bridge.plan(planRequest)).resolves.toEqual(plan);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(await bridge.getPlan("plan-1")).toMatchObject({ status: "ready" });
    await expect(bridge.plan({ ...planRequest, goal: "other" })).rejects.toMatchObject({ code: "invalid_request" });
    await expect(bridge.plan({ ...planRequest, requestId: "p2", projects: [{ id: "x", label: "x", workspacePath: "G:/nowhere" }] })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("surfaces planner error codes, caches failed and cancelled terminal plans without re-invoking, and refuses when capacity is exhausted", async () => {
    const fake = fakeFacade();
    let reject!: (e: Error) => void;
    const invoke = vi.fn(async (command: string) => {
      if (command === "plugin_task_plan_cancel") { reject(new Error("cancelled: the plan was cancelled")); return true; }
      return new Promise((_r, j) => { reject = j; });
    });
    const { bridge } = bridgeFor(fake, { invoke });
    const pending = bridge.plan(planRequest);
    await settle(bridge);
    expect(await bridge.cancelPlan("plan-1")).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(await bridge.getPlan("plan-1")).toMatchObject({ status: "cancelled" });
    const callsAfterCancel = invoke.mock.calls.filter((c) => c[0] === "plugin_task_plan").length;
    await expect(bridge.plan(planRequest)).rejects.toMatchObject({ code: "cancelled" });
    expect(invoke.mock.calls.filter((c) => c[0] === "plugin_task_plan").length).toBe(callsAfterCancel);

    const failInvoke = vi.fn(async () => { throw new Error("bad_output: step projectId \"z\" is not a candidate"); });
    const failing = bridgeFor(fakeFacade(), { pluginId: "f", invoke: failInvoke });
    await expect(failing.bridge.plan({ ...planRequest, requestId: "p9" })).rejects.toMatchObject({ code: "bad_output" });
    await expect(failing.bridge.plan({ ...planRequest, requestId: "p9" })).rejects.toMatchObject({ code: "bad_output" });
    expect(failInvoke).toHaveBeenCalledTimes(1);

    // Capacity exhaustion (MAX_PLANS = 128) explicitly rejects without evicting earlier ids.
    const capStorage = storageFor();
    capStorage.data.set("cap:__host_tasks_v1:plans", {
      version: 1,
      plans: Array.from({ length: 128 }, (_, i) => ({
        requestId: `cap-${i}`,
        fingerprint: "fp",
        status: "failed",
        error: { code: "failed", message: "done" },
        updatedAt: 1,
      })),
    });
    const capInvoke = vi.fn(async () => { throw new Error("unexpected"); });
    const capBridge = bridgeFor(fakeFacade(), { pluginId: "cap", storage: capStorage, invoke: capInvoke });
    await expect(capBridge.bridge.plan({ ...planRequest, requestId: "cap-overflow" })).rejects.toMatchObject({ code: "invalid_request" });
    expect(capInvoke).not.toHaveBeenCalled();
  });

  it("does not invoke native planner when initial running persistence fails, and preserves other plan records", async () => {
    const fake = fakeFacade();
    const invoke = vi.fn(async (_command: string, args: Record<string, unknown>) => ({
      requestId: (args.request as { requestId: string }).requestId,
      status: "ready",
      steps: [{ id: "s1", title: "T", projectId: "game", instruction: "do", dependsOn: [], contextRefs: [], writePaths: ["game"] }],
      planner: { engine: "claude", model: "opus" },
      createdAt: 1,
    }));
    const { bridge, storage } = bridgeFor(fake, { invoke });
    // First plan succeeds and is persisted.
    await expect(bridge.plan({ ...planRequest, requestId: "keep-me" })).resolves.toMatchObject({ requestId: "keep-me", status: "ready" });
    expect(invoke).toHaveBeenCalledTimes(1);

    // Next plan's initial running persistence fails: native invoke must NOT be called, and "keep-me" must stay intact.
    storage.set.mockRejectedValueOnce(new Error("kv write failed"));
    await expect(bridge.plan({ ...planRequest, requestId: "init-fail" })).rejects.toMatchObject({ code: "failed" });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(await bridge.getPlan("init-fail")).toBeNull();
    expect(await bridge.getPlan("keep-me")).toMatchObject({ requestId: "keep-me", status: "ready" });
  });

  it("cancels during delayed initial persistence with 0 native calls, and never lets a late native success overwrite confirmed cancellation", async () => {
    const fake = fakeFacade();
    const invoke = vi.fn(async () => { throw new Error("should not be called"); });
    const { bridge, storage } = bridgeFor(fake, { invoke });

    let releaseSave!: () => void;
    const origSet = storage.set.getMockImplementation()!;
    storage.set.mockImplementationOnce(async (id: string, key: string, value: unknown) => {
      await new Promise<void>((r) => { releaseSave = r; });
      await origSet(id, key, value);
    });

    const pending = bridge.plan({ ...planRequest, requestId: "cancel-before-native" });
    for (let i = 0; i < 4 && !releaseSave; i++) await new Promise((r) => setTimeout(r, 0));
    expect(await bridge.cancelPlan("cancel-before-native")).toBe(true);
    expect(await bridge.getPlan("cancel-before-native")).toMatchObject({ status: "cancelled" });
    releaseSave();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
    expect(invoke).not.toHaveBeenCalled();
    expect(await bridge.getPlan("cancel-before-native")).toMatchObject({ status: "cancelled" });

    // Unload/dispose during initial persistence await must also never invoke native late.
    let releaseDisposeSave!: () => void;
    const disposeStorage = storageFor();
    const origDisposeSet = disposeStorage.set.getMockImplementation()!;
    disposeStorage.set.mockImplementationOnce(async (id: string, key: string, value: unknown) => {
      await new Promise<void>((r) => { releaseDisposeSave = r; });
      await origDisposeSet(id, key, value);
    });
    const disposeInvoke = vi.fn(async (_command: string, _args: Record<string, unknown>) => { throw new Error("should not be called"); });
    const disposable = bridgeFor(fakeFacade(), { pluginId: "disp", storage: disposeStorage, invoke: disposeInvoke });
    const dispPending = disposable.bridge.plan({ ...planRequest, requestId: "disp-before-native" });
    for (let i = 0; i < 4 && !releaseDisposeSave; i++) await new Promise((r) => setTimeout(r, 0));
    disposable.bridge.dispose();
    releaseDisposeSave();
    await expect(dispPending).rejects.toMatchObject({ code: "failed" });
    expect(disposeInvoke.mock.calls.filter((c) => c[0] === "plugin_task_plan")).toHaveLength(0);

    // Late native success after confirmed native cancel must still reject as cancelled and never overwrite with ready.
    let resolveNative!: (v: unknown) => void;
    const lateInvoke = vi.fn(async (command: string, args: Record<string, unknown>) => {
      if (command === "plugin_task_plan_cancel") {
        resolveNative({
          requestId: (args.requestId as string),
          status: "ready",
          steps: [{ id: "s1", title: "T", projectId: "game", instruction: "do", dependsOn: [] }],
          planner: { engine: "claude", model: "opus" },
          createdAt: 1,
        });
        return true;
      }
      return new Promise((r) => { resolveNative = r; });
    });
    const lateBridge = bridgeFor(fakeFacade(), { pluginId: "late", invoke: lateInvoke });
    const latePending = lateBridge.bridge.plan({ ...planRequest, requestId: "late-success" });
    await settle(lateBridge.bridge);
    expect(await lateBridge.bridge.cancelPlan("late-success")).toBe(true);
    await expect(latePending).rejects.toMatchObject({ code: "cancelled" });
    expect(await lateBridge.bridge.getPlan("late-success")).toMatchObject({ status: "cancelled" });
  });

  it("deduplicates concurrent plan() calls for the same requestId into a single native call", async () => {
    const fake = fakeFacade();
    let resolveNative!: (v: unknown) => void;
    const invoke = vi.fn(async () => new Promise((r) => { resolveNative = r; }));
    const { bridge } = bridgeFor(fake, { invoke });

    const p1 = bridge.plan({ ...planRequest, requestId: "concurrent-1" });
    const p2 = bridge.plan({ ...planRequest, requestId: "concurrent-1" });
    await expect(bridge.plan({ ...planRequest, requestId: "concurrent-1", goal: "conflicting" })).rejects.toMatchObject({ code: "invalid_request" });
    await settle(bridge);
    expect(invoke).toHaveBeenCalledTimes(1);

    const expectedPlan = {
      requestId: "concurrent-1",
      status: "ready" as const,
      steps: [{ id: "s1", title: "T", projectId: "game", instruction: "do", dependsOn: [], contextRefs: [], writePaths: ["game"] }],
      planner: { engine: "claude", model: "opus" },
      createdAt: 1,
    };
    resolveNative(expectedPlan);
    await expect(Promise.all([p1, p2])).resolves.toEqual([expectedPlan, expectedPlan]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("rejects when terminal persistence fails and retains the running identity so neither the current nor a recreated bridge replays", async () => {
    const fake = fakeFacade();
    const invoke = vi.fn(async (_command: string, args: Record<string, unknown>) => ({
      requestId: (args.request as { requestId: string }).requestId,
      status: "ready",
      steps: [{ id: "s1", title: "T", projectId: "game", instruction: "do", dependsOn: [], contextRefs: [], writePaths: ["game"] }],
      planner: { engine: "claude", model: "opus" },
      createdAt: 1,
    }));
    const storage = storageFor();
    const origSet = storage.set.getMockImplementation()!;
    let planSaveCount = 0;
    storage.set.mockImplementation(async (id: string, key: string, value: unknown) => {
      if (key === "__host_tasks_v1:plans") {
        planSaveCount++;
        if (planSaveCount === 2) throw new Error("terminal kv write failed");
      }
      await origSet(id, key, value);
    });

    const first = bridgeFor(fake, { storage, invoke });
    await expect(first.bridge.plan({ ...planRequest, requestId: "term-fail" })).rejects.toMatchObject({ code: "failed" });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(await first.bridge.getPlan("term-fail")).toMatchObject({ requestId: "term-fail", status: "running" });

    // Calling plan() again on the same bridge must not replay native.
    await expect(first.bridge.plan({ ...planRequest, requestId: "term-fail" })).rejects.toMatchObject({ code: "failed" });
    expect(invoke).toHaveBeenCalledTimes(1);

    // Disposing and recreating the bridge from storage must also refuse to replay the same requestId.
    first.bridge.dispose();
    bridges.splice(bridges.indexOf(first.bridge), 1);
    const second = bridgeFor(fake, { storage, invoke });
    await expect(second.bridge.plan({ ...planRequest, requestId: "term-fail" })).rejects.toMatchObject({ code: "failed" });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(await second.bridge.getPlan("term-fail")).toMatchObject({ requestId: "term-fail", status: "failed" });
  });

  it("lists bounded history for one workspace with native parent edges and clips excerpts", async () => {
    const fake = fakeFacade();
    fake.addSession({ engine: "claude", sessionId: S1, workspacePath: GAME });
    fake.addSession({ engine: "claude", sessionId: S2, workspacePath: GAME }, null);
    fake.addSession({ engine: "claude", sessionId: S3, workspacePath: TOOL });
    const { bridge } = bridgeFor(fake);
    const page = await bridge.history({ workspacePath: GAME, limit: 1 });
    expect(page).toMatchObject({ total: 2, nextOffset: 1 });
    const all = await bridge.history({ workspacePath: GAME });
    expect(all.items.find((i) => i.sessionId === S2)).toMatchObject({ parent: { sessionId: S1 }, status: "closed", open: false });
    expect(all.items.find((i) => i.sessionId === S1)).toMatchObject({ childCount: 1, status: "idle" });
    await expect(bridge.history({ workspacePath: GAME, limit: 500 })).rejects.toThrow(/range/);
    const excerpt = await bridge.excerpt({ engine: "claude", sessionId: S1, workspacePath: GAME, maxChars: 3000 });
    expect(excerpt.messages.map((m) => m.role)).toEqual(["assistant"]);
    expect(excerpt.messages[0]).toMatchObject({ truncated: true });
    expect(excerpt.messages[0].text).toHaveLength(3000);
    expect(excerpt).toMatchObject({ truncated: true, nextBefore: 3 });
    await expect(bridge.excerpt({ engine: "claude", sessionId: S3, workspacePath: GAME })).rejects.toThrow(/saved local chat/);
    const catalog = await bridge.catalog();
    expect(catalog.engines.find((e) => e.id === "claude")).toMatchObject({ planner: true, defaultModel: "opus" });
    expect(catalog.workspaces.find((w) => w.path === "G:/old")).toMatchObject({ executable: false });
    expect(catalog.projects[0].members.map((m) => m.registered)).toEqual([true, false]);
  });
});


describe("frozen native task selections", () => {
  it("pins and restores an AGY channel without an independent effort", async () => {
    const fake = fakeFacade();
    const agy = { engine: "agy", model: "gemini-4-argon-high", providerId: "agy-channel" };
    const engines = fake.facade.engines;
    fake.facade.engines = () => [...engines(), { id: "agy", available: true, enabled: true, defaultModel: agy.model, defaultEffort: "high" }];
    fake.drafts.set(`agy:${GAME}`, { held: true });
    const invoke = vi.fn(async () => agy);
    const { bridge, storage } = bridgeFor(fake, { invoke });
    const request = submission("agy-pinned", agy);
    expect(await bridge.submit(request)).toMatchObject({ requestedSelection: agy, effectiveSelection: agy });
    await settle(bridge); bridge.dispose();
    fake.drafts.clear();
    const restored = bridgeFor(fake, { invoke, storage }).bridge;
    await restored.ready(); await settle(restored);
    expect(fake.facade.sendNew).toHaveBeenCalledTimes(1);
    expect(fake.facade.sendNew.mock.calls[0][0]).toBe("agy");
    expect(fake.facade.sendNew.mock.calls[0][4]).toMatchObject({ model: agy.model, providerId: agy.providerId, defaultEffort: null });
    expect(fake.facade.sendNew.mock.calls[0][4]?.effort).toBeUndefined();
    await expect(restored.submit(submission("agy-invalid", { ...agy, effort: "high" }))).rejects.toThrow(/effort/);
    await expect(restored.submit(submission("claude-incomplete", { engine: "claude", model: "opus", providerId: "channel" }))).rejects.toThrow(/explicit/);
  });
  const selection = { engine: "claude", model: "opus", effort: "ultra", providerId: "channel-a" };
  const effective = { ...selection, model: "claude-opus-full", effort: "max" };
  it.each([{ stage: 2, action: "dispose" }, { stage: 3, action: "dispose" }, { stage: 3, action: "cancel" }])(
    "does not deliver after $action during native selection wait $stage", async ({ stage, action }) => {
      const fake = fakeFacade(); let calls = 0; let release!: (value: unknown) => void;
      const delivered = vi.fn();
      fake.facade.sendNew.mockImplementation(async (_engine, _workspace, _prompt, runId, _launch, beforeSend) => {
        await beforeSend?.(); delivered(); return { runId, sessionId: null };
      });
      const { bridge } = bridgeFor(fake, { invoke: async () => {
        calls++;
        return calls === stage ? new Promise(resolve => { release = resolve; }) : effective;
      } });
      await bridge.submit(submission("cancel-at-resolve", selection));
      await vi.waitFor(() => expect(calls).toBe(stage));
      if (action === "cancel") await bridge.cancel("cancel-at-resolve");
      else bridge.dispose();
      release(effective);
      if (action === "cancel") await vi.waitFor(async () => expect(await bridge.receipt("cancel-at-resolve")).toMatchObject({ status: "cancelled" }));
      else for (let i = 0; i < 12; i++) await new Promise(resolve => setTimeout(resolve, 0));
      expect(delivered).not.toHaveBeenCalled();
      expect(fake.routes.size).toBe(0);
    },
  );
  it("resolves explicit channels, exposes native choices, rejects provider requestId conflicts", async () => {
    const fake = fakeFacade();
    const invoke = vi.fn(async () => effective);
    const { bridge } = bridgeFor(fake, { invoke });
    const receipt = await bridge.submit(submission("pinned", selection));
    expect(receipt).toMatchObject({ requestedSelection: selection, effectiveSelection: effective });
    Object.assign(receipt.effectiveSelection!, { model: "tampered-view" });
    await settle(bridge);
    expect(fake.facade.sendNew.mock.calls[0][4]).toMatchObject({ model: effective.model, effort: "max", providerId: "channel-a" });
    expect(invoke).toHaveBeenCalledWith("plugin_task_resolve", { pluginId: "wb", selection });
    await expect(bridge.submit(submission("pinned", { ...selection, providerId: "channel-b" }))).rejects.toThrow(/different submission/);
    await expect(bridge.submit(submission("partial", { providerId: "channel-a" }))).rejects.toThrow(/explicit/);
    expect((await bridge.catalog()).capabilities).toEqual({ existingConversationAttachment: true, nativeCoordination: true, images: true, continuousCoordination: true, coordinatorMessageQueue: true, fixedInstructions: true, immediateMessages: false, costReviewDialog: false, composerPrediction: false, coordinatorServiceTier: true, coordinatorInputCostReview: false, costHandoffPreview: false, managedChildCostHandoff: false, managedChildHandoffSelection: false, fullHistoryHandoff: false, coordinatorFullHistoryHandoff: false });
  });
  it("rejects a changed alias before native send and never replays it", async () => {
    const fake = fakeFacade();
    const invoke = vi.fn().mockResolvedValueOnce(effective).mockResolvedValue({ ...effective, model: "changed-model" });
    const { bridge } = bridgeFor(fake, { invoke });
    await bridge.submit(submission("alias", selection)); await settle(bridge);
    expect(await bridge.receipt("alias")).toMatchObject({ status: "failed", error: expect.stringContaining("mapping changed") });
    fake.poke(); await settle(bridge);
    expect(fake.facade.sendNew).not.toHaveBeenCalled();
  });
  it("rolls over with bounded handoff when retained selection differs", async () => {
    const fake = fakeFacade(), ref = { engine: "claude", sessionId: S1, workspacePath: GAME };
    fake.addSession(ref); fake.facade.selectionMatches.mockReturnValue(false);
    const storage = storageFor();
    storage.data.set(`wb:${HOST_TASKS_INDEX_KEY}`, { version: 1, entries: [], slots: [{ projectId: "sample-project", slotKey: "impl", session: ref, lastRequestId: "old", updatedAt: 1 }] });
    const { bridge } = bridgeFor(fake, { storage, invoke: async () => effective });
    await bridge.submit(submission("roll", selection)); await settle(bridge);
    expect(fake.facade.sendExisting).not.toHaveBeenCalled();
    expect(fake.facade.sendNew.mock.calls[0][2]).toContain(`Handoff from chat claude:${S1}`);
    expect(fake.facade.sendNew.mock.calls[0][2].length).toBeLessThan(8000);
  });
  it("keeps the old 12-element fingerprint retryable after restoring legacy records", async () => {
    const fake = fakeFacade(); fake.drafts.set(`claude:${GAME}`, { held: true });
    const { bridge, storage } = bridgeFor(fake);
    const request = submission("legacy", { model: "opus", effort: "high" });
    await bridge.submit(request); await settle(bridge); bridge.dispose();
    const saved = storage.data.get(`wb:${HOST_TASKS_INDEX_KEY}`) as { entries: Array<{ fingerprint: string; launch: TaskLaunchChoices }> };
    expect(JSON.parse(saved.entries[0].fingerprint)).toHaveLength(12);
    delete saved.entries[0].launch.defaultProvider;
    const restored = bridgeFor(fake, { storage }).bridge;
    await expect(restored.submit(request)).resolves.toMatchObject({ requestId: "legacy" });
  });
  it.each(["partial", "launch", "removed", "forged"])("rejects %s persisted pinned selections without dispatch", async (mutation) => {
    const fake = fakeFacade(); fake.drafts.set(`claude:${GAME}`, { held: true });
    const { bridge, storage } = bridgeFor(fake, { invoke: async () => effective });
    await bridge.submit(submission("restore", selection)); await settle(bridge); bridge.dispose();
    const saved = storage.data.get(`wb:${HOST_TASKS_INDEX_KEY}`) as any;
    const entry = saved.entries[0];
    if (mutation === "partial") delete entry.receipt.effectiveSelection.providerId;
    if (mutation === "launch") entry.launch.model = "other";
    if (mutation === "removed") { delete entry.receipt.requestedSelection; delete entry.receipt.effectiveSelection; delete entry.launch.providerId; }
    if (mutation === "forged") { entry.launch.model = "forged"; entry.receipt.effectiveSelection.model = "forged"; }
    fake.drafts.clear();
    const restored = bridgeFor(fake, { storage, invoke: async () => effective }).bridge;
    if (mutation === "forged") {
      await settle(restored);
      expect(await restored.receipt("restore")).toMatchObject({ status: "failed" });
    } else await expect(restored.ready()).rejects.toThrow(/selection record/);
    expect(fake.facade.sendNew).not.toHaveBeenCalled();
  });
});


it("does not ignore explicit legacy model/effort when considering slot reuse", async () => {
  const fake = fakeFacade(), ref = { engine: "claude", sessionId: S1, workspacePath: GAME };
  fake.addSession(ref); fake.facade.selectionMatches.mockReturnValue(false);
  const storage = storageFor();
  storage.data.set(`wb:${HOST_TASKS_INDEX_KEY}`, { version: 1, entries: [], slots: [{ projectId: "sample-project", slotKey: "impl", session: ref, lastRequestId: "old", updatedAt: 1 }] });
  const { bridge } = bridgeFor(fake, { storage });
  await bridge.submit(submission("legacy-selection", { model: "sonnet", effort: "low" })); await settle(bridge);
  expect(fake.facade.selectionMatches).toHaveBeenCalledWith(ref, expect.objectContaining({ model: "sonnet", effort: "low" }));
  expect(fake.facade.sendExisting).not.toHaveBeenCalled();
  expect(fake.facade.sendNew.mock.calls[0][2]).toContain(`Handoff from chat claude:${S1}`);
});

describe("host task image attachments", () => {
  it("never resolves a managed-child history image reference as a plugin attachment", async () => {
    const fake = fakeFacade(), invoke = vi.fn();
    const { bridge, storage } = bridgeFor(fake, { invoke });
    await expect(bridge.submit(submission("managed-ref", { images: [`task-image:${"a".repeat(64)}`] }))).rejects.toThrow(/valid attachment IDs/);
    expect(invoke).not.toHaveBeenCalled();
    expect(fake.facade.sendNew).not.toHaveBeenCalled();
    expect(storage.data.get(`wb:${HOST_TASKS_INDEX_KEY}`)).toBeUndefined();
  });
  it("validates, resolves, fingerprints, and forwards opaque image IDs for text+image and image-only submissions", async () => {
    const fake = fakeFacade();
    const invoke = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "plugin_image_resolve") {
        const ids = args.imageIds as string[];
        if (ids.includes("missing-img")) throw new Error("Unknown plugin image attachment");
        return ids.map((id) => `G:/pasted/plugin-attachments/wb/${id}.png`);
      }
      throw new Error(`unexpected ${cmd}`);
    });
    const { bridge, storage } = bridgeFor(fake, { invoke });

    await expect(bridge.submit(submission("empty-no-img", { prompt: "   " }))).rejects.toThrow(/non-empty/);
    await expect(bridge.submit(submission("too-many-img", { images: ["1", "2", "3", "4", "5", "6", "7", "8", "9"] }))).rejects.toThrow(/at most 8/);
    await expect(bridge.submit(submission("bad-img", { images: ["missing-img"] }))).rejects.toThrow(/Unknown plugin image/);
    expect(storage.data.get(`wb:${HOST_TASKS_INDEX_KEY}`)).toBeUndefined();

    const req = submission("img-only", { prompt: "   ", images: ["img-1", "img-2"] });
    const receipt = await bridge.submit(req);
    expect(receipt.requestId).toBe("img-only");
    await expect(bridge.submit(req)).resolves.toMatchObject({ requestId: "img-only" });
    await expect(bridge.submit({ ...req, images: ["img-2", "img-1"] })).rejects.toThrow(/different submission/);

    await settle(bridge);
    expect(invoke).toHaveBeenCalledWith("plugin_image_resolve", { pluginId: "wb", imageIds: ["img-1", "img-2"] });
    expect(fake.facade.sendNew).toHaveBeenCalledTimes(1);
    expect(fake.facade.sendNew.mock.calls[0][6]).toEqual([
      "G:/pasted/plugin-attachments/wb/img-1.png",
      "G:/pasted/plugin-attachments/wb/img-2.png",
    ]);

    const saved = storage.data.get(`wb:${HOST_TASKS_INDEX_KEY}`) as { entries: Array<{ fingerprint: string; images?: string[] }> };
    expect(saved.entries[0].images).toEqual(["img-1", "img-2"]);
    expect(JSON.parse(saved.entries[0].fingerprint)).toHaveLength(13);
    bridge.dispose();

    const restored = bridgeFor(fake, { storage, invoke }).bridge;
    await expect(restored.submit(req)).resolves.toMatchObject({ requestId: "img-only" });
  });

  it("rejects engines that do not support images before creating a durable task entry", async () => {
    const fake = fakeFacade();
    fake.facade.engines = () => [
      { id: "claude", available: true, enabled: true, supportsImages: false, defaultModel: "opus", defaultEffort: "high" },
    ];
    const invoke = vi.fn(async () => ["G:/pasted/plugin-attachments/wb/img-1.png"]);
    const { bridge, storage } = bridgeFor(fake, { invoke });
    await expect(bridge.submit(submission("no-img-engine", { images: ["img-1"] }))).rejects.toThrow(/does not support image/);
    expect(invoke).not.toHaveBeenCalled();
    expect(storage.data.get(`wb:${HOST_TASKS_INDEX_KEY}`)).toBeUndefined();

    // Missing supportsImages (undefined) in facade catalog must report supportsImages: false and fail closed
    fake.facade.engines = () => [
      { id: "claude", available: true, enabled: true, defaultModel: "opus", defaultEffort: "high" },
    ];
    expect((await bridge.catalog()).engines[0].supportsImages).toBe(false);
    await expect(bridge.submit(submission("unknown-img-engine", { images: ["img-1"] }))).rejects.toThrow(/does not support image/);
  });

  it("fails explicitly before native send without fallback or text-only delivery when auto slot reuse or queued capability loses image support", async () => {
    const invoke = vi.fn(async () => ["G:/pasted/plugin-attachments/wb/img-1.png"]);

    // Case 1: newEngine (claude) supports images at submit, but auto slot reuse routes to codex which lacks supportsImages
    const fakeReuse = fakeFacade();
    fakeReuse.facade.engines = () => [
      { id: "claude", available: true, enabled: true, supportsImages: true, defaultModel: "opus", defaultEffort: "high" },
      { id: "codex", available: true, enabled: true, supportsImages: false, defaultModel: null, defaultEffort: null },
    ];
    const codexRef = { engine: "codex", sessionId: "codex-slot-1", workspacePath: GAME };
    fakeReuse.addSession(codexRef, "idle");
    const reuseStorage = storageFor();
    reuseStorage.data.set(`wb:${HOST_TASKS_INDEX_KEY}`, {
      version: 1,
      entries: [],
      slots: [{ projectId: "sample-project", slotKey: "impl", session: codexRef, lastRequestId: "prev", updatedAt: 1 }],
    });
    const reuseBridge = bridgeFor(fakeReuse, { storage: reuseStorage, invoke }).bridge;
    await reuseBridge.submit(submission("reuse-unsupported", { images: ["img-1"] }));
    await settle(reuseBridge);
    expect(await reuseBridge.receipt("reuse-unsupported")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Engine codex does not support image attachments; nothing was sent"),
    });
    expect(fakeReuse.facade.sendExisting).not.toHaveBeenCalled();
    expect(fakeReuse.facade.sendNew).not.toHaveBeenCalled();

    // Case 2: task queued while draft is held, then engine loses image support before dispatch
    const fakeQueued = fakeFacade();
    let claudeSupportsImages = true;
    fakeQueued.facade.engines = () => [
      { id: "claude", available: true, enabled: true, supportsImages: claudeSupportsImages, defaultModel: "opus", defaultEffort: "high" },
    ];
    fakeQueued.drafts.set(`claude:${GAME}`, { held: true });
    const queuedBridge = bridgeFor(fakeQueued, { invoke }).bridge;
    await queuedBridge.submit(submission("queued-loss", { images: ["img-1"] }));
    await settle(queuedBridge);
    expect(await queuedBridge.receipt("queued-loss")).toMatchObject({ status: "queued", blockedBy: ["user-draft"] });

    claudeSupportsImages = false;
    fakeQueued.drafts.clear();
    fakeQueued.poke();
    await settle(queuedBridge);
    expect(await queuedBridge.receipt("queued-loss")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Engine claude does not support image attachments; nothing was sent"),
    });
    expect(fakeQueued.facade.sendNew).not.toHaveBeenCalled();
  });

  it("aborts native send if the task is cancelled while resolving image paths in beforeSend", async () => {
    const fake = fakeFacade();
    let releaseResolve!: (paths: string[]) => void;
    let resolveCount = 0;
    const invoke = vi.fn((cmd: string) => {
      if (cmd === "plugin_image_resolve") {
        resolveCount += 1;
        if (resolveCount < 3) return Promise.resolve(["G:/pasted/plugin-attachments/wb/img-1.png"]);
        return new Promise<string[]>((r) => { releaseResolve = r; });
      }
      return Promise.reject(new Error("unexpected"));
    });
    const delivered = vi.fn();
    fake.facade.sendNew.mockImplementation(async (_e, _w, _p, runId, _l, beforeSend) => {
      await beforeSend?.();
      delivered(runId);
      return { runId, sessionId: null };
    });
    const { bridge } = bridgeFor(fake, { invoke });
    await bridge.submit(submission("cancel-img-resolve", { images: ["img-1"] }));
    await vi.waitFor(() => expect(resolveCount).toBe(3));
    await bridge.cancel("cancel-img-resolve");
    releaseResolve(["G:/pasted/plugin-attachments/wb/img-1.png"]);
    await vi.waitFor(async () => expect(await bridge.receipt("cancel-img-resolve")).toMatchObject({ status: "cancelled" }));
    expect(delivered).not.toHaveBeenCalled();
  });
});
