import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, SessionMeta, SessionPage } from "@/lib/ipc";
import type { ChatStore } from "./types";
import type { StoreSet } from "./context";
import { createSessionMemoryCache, estimatedHistoryBytes, hasReloadableHistory, markReloadableHistory } from "./session-memory-cache";
import { createSessionActions } from "./sessions";
import { createTabActions } from "./tabs";
import { createChatCheckpointParticipant } from "./runtime-checkpoint";
import { EMPTY_SESSION, patchSession, runRouting, type SessionState } from "./stream";
import { handleEngineEvents, settledRuns, settledRunOutcomes } from "./engine-events";
import { askLoops } from "./ask-loop";
import { clearComposerPrediction, reconcileComposerPrediction } from "../composer-prediction";

vi.mock("@/lib/ipc", () => ({ ipc: {
  listPlanReviews: vi.fn(async () => []), rescanSessions: vi.fn(async () => {}), activeRunIds: vi.fn(async () => []),
  computerUseSetActive: vi.fn(async () => {}),
} }));
vi.mock("@/features/plugins/runtime/events", () => ({ emitSessionActivated: vi.fn() }));
vi.mock("@/features/settings/usage-tracking", () => ({ usageTrackingEnabled: () => false }));
vi.mock("@/features/chat/composer-prediction", () => ({ clearComposerPrediction: vi.fn(), requestComposerPrediction: vi.fn(), reconcileComposerPrediction: vi.fn() }));
vi.mock("@/features/sidechat/store", () => ({
  useSidechatStore: { getState: () => ({ dismissBtw: vi.fn(), discardSidechat: vi.fn(async () => {}) }) },
  isSideRunEvent: () => false,
}));

const disposers: Array<() => void> = [];
const usage = { input_tokens: 100, output_tokens: 20, usage_scope: "last_request" };
const row = (text: string, seq = 1): Message => ({ seq, role: "assistant", text, ts: "2026-11-01T00:00:00Z", usage });
const page = (messages: Message[]): SessionPage => ({ messages, nextBefore: null, subagentHistory: [] });
const target = (id: string) => ({ engine: "codex", sessionId: id, workspacePath: "G:/fixture" });
const meta = (id: string) => ({ ...target(id), filePath: `G:/fixture/${id}.jsonl` } as SessionMeta);

function fixture(options: { maxEntries?: number; maxBytes?: number } = {}) {
  let state = {
    workspaces: [], sessions: [], archivedSessionKeys: {}, engines: [], active: null, openTabs: [], activeEngine: "codex", permission: "manual",
    efforts: {}, defaultClaudeUltracode: false, ompServiceTier: null, codexServiceTier: null, models: {}, providers: {}, threadLimit: 10,
    workspaceGroups: [], workspaceAliases: {}, archivedWorkspaces: [], sendShortcut: "enter", thinkingAutoCollapse: true,
    bySession: {}, streamingByKey: {}, retryingByKey: {}, unseen: {}, drafts: {}, pendingMention: null, actionError: null, initialized: true,
    refreshSessionUsage: vi.fn(async () => {}),
  } as unknown as ChatStore;
  let paused = false;
  const observers = new Set<() => void>();
  const set: StoreSet = patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; [...observers].forEach(callback => callback()); };
  const get = () => state;
  const load = vi.fn(async (_engine: string, id: string, _workspace: string, _limit?: number, _before?: number | null, _meta?: SessionMeta) => page([row(`历史 ${id} 👩🏽‍💻`)]));
  const cache = createSessionMemoryCache({ get, set, loadHistoryPage: load, paused: () => paused, ...options });
  const tabs = createTabActions({ get, set, memoryCache: cache });
  const teardowns: Array<() => void> = [];
  const subscribe = (callback: () => void) => { observers.add(callback); return () => { observers.delete(callback); }; };
  const sessions = createSessionActions({ get, set, loadHistoryPage: load, subscribe, eventTeardowns: teardowns,
    activateTab: tabs.activateTab, removeTab: tabs.removeTab, forgetClosedTab: tabs.forgetClosedTab,
    drainQueue: vi.fn(), markUnseenIfBackground: vi.fn() });
  Object.assign(state, tabs, sessions);
  const checkpoint = createChatCheckpointParticipant({ getState: get, setState: set }, get, () => cache.schedule());
  cache.connect(subscribe);
  const dispose = () => { cache.dispose(); teardowns.splice(0).forEach(off => off()); };
  disposers.push(dispose);
  return { get, set, load, cache, checkpoint, observers, dispose,
    pause(value: boolean) { paused = value; if (!value) cache.schedule(); },
    async openClose(id: string) { await get().selectSession("codex", id, "G:/fixture"); get().closeTab("codex", id, "G:/fixture"); },
    put(id: string, patch: Partial<SessionState> = {}, proven = false) {
      const session = { ...EMPTY_SESSION, messages: [row(id)], subagentHistory: [], ...patch };
      if (proven) markReloadableHistory(session.messages, session.subagentHistory);
      set(s => ({ bySession: { ...s.bySession, [`codex/${id}`]: session } }));
      return session;
    },
  };
}

beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); runRouting.clear(); askLoops.clear(); settledRuns.clear(); settledRunOutcomes.clear(); vi.clearAllMocks(); });
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); vi.clearAllTimers(); vi.useRealTimers(); });
const sweep = () => vi.advanceTimersByTimeAsync(1_000);
const retained = (f: ReturnType<typeof fixture>) => Object.values(f.get().bySession).filter(session => session.messages.length > 0);

describe("inactive session history memory", () => {
  it("checks saved prediction turn ownership after a native history load", async () => {
    const f = fixture();
    const messages: Message[] = [
      { seq: 1, role: "user", text: "新问题", ts: null },
      { seq: 2, role: "assistant", text: "新回答🙂", ts: null },
    ];
    f.load.mockResolvedValueOnce(page(messages));
    await f.get().selectSession("codex", "prediction-owner", "G:/fixture");
    expect(reconcileComposerPrediction).toHaveBeenCalledWith("codex/prediction-owner", messages);
  });

  it("checks idle checkpoint predictions and clears predictions from active restored turns", () => {
    const first = fixture();
    const idleMessages = [row("已完成的回合")];
    first.put("idle", { messages: idleMessages });
    first.put("busy", { streaming: true });
    const saved = first.checkpoint.capture();
    first.dispose();
    vi.mocked(clearComposerPrediction).mockClear();
    vi.mocked(reconcileComposerPrediction).mockClear();
    const next = fixture();
    next.checkpoint.restore(saved);
    expect(reconcileComposerPrediction).toHaveBeenCalledWith("codex/idle", idleMessages);
    expect(clearComposerPrediction).toHaveBeenCalledWith("codex/busy", { resetTurn: true });
  });

  it("rebuilds the whole closed cache after a checkpoint, retaining shells and only ten histories", async () => {
    const first = fixture();
    for (let i = 0; i < 10; i++) await first.openClose(`old-${i}`);
    const saved = first.checkpoint.capture(); first.dispose();
    const next = fixture(); next.checkpoint.restore(saved); next.set({ initialized: true });
    for (let i = 0; i < 25; i++) await next.openClose(`new-${i}`);
    await sweep();
    expect(Object.keys(next.get().bySession)).toHaveLength(35);
    expect(retained(next)).toHaveLength(10);
    expect(next.get().bySession["codex/old-0"]).toMatchObject({ messages: [], subagentHistory: [], historyReloadRequired: true, usage });
    expect(next.get().bySession["codex/new-24"].messages[0].text).toBe("历史 new-24 👩🏽‍💻");
  });

  it("enforces an estimated byte budget without charging open or protected sessions", async () => {
    const f = fixture({ maxBytes: 6_000 });
    f.put("first", { messages: [row("甲".repeat(1_500))] }, true);
    f.put("last", { messages: [row("乙".repeat(1_500))] }, true);
    const busy = f.put("busy", { streaming: true, messages: [row("大".repeat(20_000))] }, true);
    const open = f.put("open", { messages: [row("开".repeat(20_000))] }, true);
    f.set({ openTabs: [target("open")] });
    await sweep();
    expect(f.get().bySession["codex/first"].messages).toEqual([]);
    expect(estimatedHistoryBytes(f.get().bySession["codex/last"])).toBeLessThan(6_000);
    expect(f.get().bySession["codex/busy"]).toBe(busy);
    expect(f.get().bySession["codex/open"]).toBe(open);
    expect(f.load).not.toHaveBeenCalled();
  });

  it("keeps the most recently reopened histories warm and protects an active recovery target", async () => {
    const f = fixture({ maxEntries: 1 });
    await f.openClose("old"); await f.openClose("new"); await f.openClose("old");
    f.put("recovering-active", {}, true); f.set({ active: target("recovering-active") });
    await sweep();
    expect(f.get().bySession["codex/old"].messages.length).toBe(1);
    expect(f.get().bySession["codex/new"].messages).toEqual([]);
    expect(f.get().bySession["codex/recovering-active"].messages.length).toBe(1);
  });

  it("reopens released history and pages earlier Unicode and full tool payloads without losing the shell", async () => {
    const f = fixture({ maxEntries: 0 });
    const latest: Message[] = [row("正文 👨‍👩‍👧‍👦\n```ts\nconst x = 1;\n```", 101)];
    const earlier: Message[] = [{ seq: 1, role: "tool", text: "read_file", ts: null,
      args: { path: "中文.ts", nested: ["🙂", { exact: "\r\n" }] }, result: { content: "完整输出🚀", ok: false } }];
    f.load.mockImplementation(async (_engine, _id, _workspace, _limit, before) => before
      ? page(earlier) : { ...page(latest), nextBefore: 101 });
    await f.get().selectSession("codex", "unicode", "G:/fixture");
    await f.get().loadEarlier("codex/unicode");
    expect(f.get().bySession["codex/unicode"].messages).toEqual([...earlier, ...latest]);
    expect(hasReloadableHistory(f.get().bySession["codex/unicode"])).toBe(true);
    patchSession(f.set, "codex/unicode", { settledRunIds: ["old-run"], activeModel: "remembered", usage });
    f.get().closeTab("codex", "unicode", "G:/fixture"); await sweep();
    expect(f.get().bySession["codex/unicode"]).toMatchObject({ messages: [], settledRunIds: ["old-run"], activeModel: "remembered", usage });
    await f.get().selectSession("codex", "unicode", "G:/fixture");
    await f.get().loadEarlier("codex/unicode");
    expect(f.get().bySession["codex/unicode"].messages).toEqual([...earlier, ...latest]);
    expect(f.load).toHaveBeenCalledTimes(4);
    expect(f.get().bySession["codex/unicode"].historyReloadRequired).toBeUndefined();
  });

  it.each([
    { interrupted: true }, { queueParked: true }, { loading: true }, { draftLaunching: "starting" },
    { streaming: true }, { error: "optimistic prompt failed" }, { retry: { attempt: 1, max: 2, message: "retry" } },
    { queue: [{ id: "q", text: "unsent", images: [], queuedAt: 1 }] },
    { nativeActivity: "waiting" }, { handoff: { stage: "waiting", model: null, effort: null } },
    { nativeTasks: [{ id: "unknown", kind: "agent", description: "child", status: "unknown" }] },
    { hostTaskOrigin: { engine: "codex", runId: "unbound", workspacePath: "G:/fixture" } },
  ] satisfies Partial<SessionState>[]) ("protects control state %j even under zero budget", async patch => {
    const f = fixture({ maxEntries: 0 }); const original = f.put("protected", patch, true);
    await sweep(); expect(f.get().bySession["codex/protected"]).toBe(original); expect(f.load).not.toHaveBeenCalled();
  });

  it("never labels ephemeral cards or managed input as source-backed and protects routes and drafts", async () => {
    const f = fixture({ maxEntries: 0 });
    const messages = [
      { ...row("answered"), question: { requestId: "q", runId: "r", questions: [], status: "answered" as const } },
      { ...row("granted"), grant: { status: "granted" as const } },
      { ...row("managed"), internalSource: { engine: "codex", sessionId: "parent" } },
      { ...row("negative", -1) },
      { ...row("pending"), question: { requestId: "q", runId: "r", questions: [], status: "pending" as const, submitting: true } },
      { ...row("grant"), grant: { status: "pending" as const } },
      { ...row("plan"), planReview: { status: "deferred" } } as unknown as Message,
    ];
    for (let i = 0; i < messages.length; i++) {
      const session = f.put(`card-${i}`, { messages: [messages[i]] }, true);
      expect(hasReloadableHistory(session)).toBe(false);
    }
    f.put("routed", {}, true); runRouting.set("run", "codex/routed");
    f.set(s => ({ bySession: { ...s.bySession, "new:codex:G:/fixture": { ...EMPTY_SESSION, messages: [row("draft")] } } }));
    await sweep(); expect(retained(f)).toHaveLength(9); expect(f.load).not.toHaveBeenCalled();
  });

  it("rechecks a closed running tab on done, verifies the complete native row, and retains run fences", async () => {
    const f = fixture({ maxEntries: 0 });
    f.set({ sessions: [meta("running")], openTabs: [target("running")], active: target("running") });
    f.put("running", { streaming: true, messages: [row("finished 🚀")], turnStartedAt: null });
    runRouting.set("run", "codex/running");
    f.get().closeTab("codex", "running", "G:/fixture"); await sweep();
    expect(f.load).not.toHaveBeenCalled();
    handleEngineEvents([{ engine: "codex", sessionId: "running", runId: "run", seq: 2, kind: "done", data: {} }], {
      get: f.get, set: f.set, drainQueue: vi.fn(), markUnseenIfBackground: vi.fn(), upsertSessionMeta: vi.fn(),
    });
    const settled = f.get().bySession["codex/running"];
    f.load.mockResolvedValue(page(structuredClone(settled.messages)));
    await sweep();
    expect(f.get().bySession["codex/running"]).toMatchObject({ messages: [], historyReloadRequired: true, settledRunIds: ["run"] });
    expect(f.load).toHaveBeenCalledTimes(1);
    handleEngineEvents([{ engine: "codex", sessionId: "running", runId: "run", seq: 3, kind: "delta", data: "late" }], {
      get: f.get, set: f.set, drainQueue: vi.fn(), markUnseenIfBackground: vi.fn(), upsertSessionMeta: vi.fn(),
    });
    expect(f.get().bySession["codex/running"].messages).toEqual([]);
  });

  it("retains unwritten or failed native history and retries with backoff", async () => {
    const f = fixture({ maxEntries: 0 }); f.set({ sessions: [meta("late")] });
    const original = f.put("late", { messages: [row("not on disk yet")] });
    f.load.mockResolvedValueOnce(page([])).mockRejectedValueOnce(new Error("temporarily unavailable"))
      .mockResolvedValue(page(structuredClone(original.messages)));
    await sweep(); expect(f.get().bySession["codex/late"]).toBe(original);
    await vi.advanceTimersByTimeAsync(29_000); expect(f.load).toHaveBeenCalledTimes(1);
    await sweep(); expect(f.load).toHaveBeenCalledTimes(2); expect(f.get().bySession["codex/late"]).toBe(original);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.get().bySession["codex/late"].messages).toEqual([]);
  });

  it("stops after three failed proofs despite time, scalar updates, and equivalent catalog replacements", async () => {
    const f = fixture({ maxEntries: 0 });
    const source = { ...meta("unmatched"), fileSize: 100, fileMtimeMs: 1 };
    f.set({ sessions: [source] }); const original = f.put("unmatched");
    f.load.mockResolvedValue(page([row("different native representation")]));
    await sweep(); await vi.advanceTimersByTimeAsync(60_000);
    expect(f.load).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(f.load).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(0);
    for (let i = 0; i < 4; i++) {
      f.set({ sessions: [{ ...source }] });
      patchSession(f.set, "codex/unmatched", { activeModel: `model-${i}` });
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(f.load).toHaveBeenCalledTimes(3);
    expect(f.get().bySession["codex/unmatched"].messages).toBe(original.messages);
  });

  it.each(["filePath", "remotePath", "fileSize", "fileMtimeMs"] as const)("retries an exhausted proof when source %s changes", async field => {
    const f = fixture({ maxEntries: 0 });
    const source = { ...meta("changed-file"), remote: true, remotePath: "/remote/original", fileSize: 100, fileMtimeMs: 1 };
    f.set({ sessions: [source] }); const original = f.put("changed-file");
    f.load.mockResolvedValue(page([]));
    await sweep(); await vi.advanceTimersByTimeAsync(60_000);
    expect(f.load).toHaveBeenCalledTimes(3);
    f.load.mockResolvedValue(page(structuredClone(original.messages)));
    const value = field === "filePath" ? "G:/fixture/replaced.jsonl" : field === "remotePath" ? "/remote/replaced" : 200;
    f.set({ sessions: [{ ...source, [field]: value }] }); await sweep();
    expect(f.load).toHaveBeenCalledTimes(4);
    expect(f.get().bySession["codex/changed-file"].messages).toEqual([]);
  });

  it.each(["messages", "subagentHistory"] as const)("starts a new bounded proof budget when the %s array changes", async field => {
    const f = fixture({ maxEntries: 0 }); f.set({ sessions: [meta("changed-content")] });
    const original = f.put("changed-content"); f.load.mockResolvedValue(page([]));
    await sweep(); await vi.advanceTimersByTimeAsync(60_000);
    expect(f.load).toHaveBeenCalledTimes(3);
    patchSession(f.set, "codex/changed-content", { [field]: [...original[field]] });
    await sweep(); await vi.advanceTimersByTimeAsync(60_000);
    expect(f.load).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(10 * 60_000); expect(f.load).toHaveBeenCalledTimes(6);
    expect(f.get().bySession["codex/changed-content"].messages).toEqual(original.messages);
  });

  it("accepts an in-flight proof across an equivalent catalog object refresh", async () => {
    const f = fixture({ maxEntries: 0 }); const source = { ...meta("catalog-refresh"), fileSize: 100, fileMtimeMs: 1 };
    f.set({ sessions: [source] }); const original = f.put("catalog-refresh");
    let resolve!: (value: SessionPage) => void;
    f.load.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    await sweep(); f.set({ sessions: [{ ...source }] });
    resolve(page(structuredClone(original.messages))); await Promise.resolve(); await Promise.resolve();
    expect(f.get().bySession["codex/catalog-refresh"].messages).toEqual([]);
    expect(f.load).toHaveBeenCalledTimes(1);
  });

  it("preserves every field during proof, permitting only settled live:false normalization", async () => {
    const f = fixture({ maxEntries: 0 }); f.set({ sessions: [meta("strict"), meta("settled")] });
    const original = f.put("strict", { messages: [{ ...row("same"), args: { hidden: "must survive" } }] });
    f.put("settled", { messages: [{ ...row("settled"), live: false }] });
    f.load.mockImplementation(async (_engine, id) => page([row(id === "strict" ? "same" : "settled")]));
    await sweep(); await sweep();
    expect(f.get().bySession["codex/strict"]).toBe(original);
    expect(f.get().bySession["codex/settled"].messages).toEqual([]);
  });

  it("cancels a proof when activity, reopening, checkpoint pause, or disposal intervenes", async () => {
    for (const change of ["activity", "reopen", "pause", "dispose"] as const) {
      const f = fixture({ maxEntries: 0 }); f.set({ sessions: [meta(change)] });
      const original = f.put(change);
      let resolve!: (value: SessionPage) => void;
      f.load.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
      await sweep();
      if (change === "activity") patchSession(f.set, `codex/${change}`, { messages: [...original.messages, row("new", 2)] });
      else if (change === "reopen") f.set({ openTabs: [target(change)] });
      else if (change === "pause") f.pause(true);
      else f.dispose();
      resolve(page(structuredClone(original.messages))); await Promise.resolve(); await Promise.resolve();
      expect(f.get().bySession[`codex/${change}`].messages.length).toBeGreaterThan(0);
      if (change === "dispose") expect(f.observers.size).toBe(0);
      f.dispose();
    }
  });

  it("serializes native proofs and bounds paging, leaving incomplete proofs resident", async () => {
    const f = fixture({ maxEntries: 0 }); f.set({ sessions: [meta("first"), meta("second")] });
    f.put("first"); f.put("second");
    let resolve!: (value: SessionPage) => void;
    f.load.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    await sweep(); await sweep(); expect(f.load).toHaveBeenCalledTimes(1);
    resolve(page([])); await Promise.resolve(); await Promise.resolve();
    f.load.mockImplementation(async (_engine, _id, _workspace, _limit, before) => ({ ...page([row("unrelated")]), nextBefore: (before ?? 100) - 1 }));
    await sweep();
    expect(f.load).toHaveBeenCalledTimes(21);
    expect(retained(f)).toHaveLength(2);
  });

  it("uses the exact remote catalog and verifies all paginated rows and delegation payloads", async () => {
    const f = fixture({ maxEntries: 0 });
    const remote = { ...meta("remote"), remote: true, filePath: "", remotePath: "/remote/transcript" };
    f.set({ sessions: [remote] });
    const older = row("older 中文", 1), newest = row("newest 🙂", 101), delegation = row("delegate details", 0);
    f.put("remote", { messages: [older, newest], subagentHistory: [delegation] });
    f.load.mockImplementation(async (_engine, _id, _workspace, _limit, before) => before
      ? { ...page([structuredClone(older)]), subagentHistory: [structuredClone(delegation)] }
      : { messages: [structuredClone(newest)], nextBefore: 101, subagentHistory: [structuredClone(delegation)] });
    await sweep();
    expect(f.load).toHaveBeenCalledTimes(2);
    expect(f.load.mock.calls.every(call => call[5] === remote)).toBe(true);
    expect(f.get().bySession["codex/remote"]).toMatchObject({ messages: [], subagentHistory: [], historyReloadRequired: true });
  });

  it("does not transfer page provenance across a live append during loadEarlier", async () => {
    const f = fixture({ maxEntries: 0 });
    f.load.mockResolvedValueOnce({ ...page([row("native latest", 101)]), nextBefore: 101 });
    await f.get().selectSession("codex", "append", "G:/fixture");
    let resolve!: (value: SessionPage) => void;
    f.load.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const pending = f.get().loadEarlier("codex/append");
    patchSession(f.set, "codex/append", { messages: [...f.get().bySession["codex/append"].messages, row("unwritten", 102)] });
    resolve(page([row("earlier", 1)])); await pending;
    const session = f.get().bySession["codex/append"];
    expect(session.messages.map(message => message.text)).toEqual(["earlier", "native latest", "unwritten"]);
    expect(hasReloadableHistory(session)).toBe(false);
    f.get().closeTab("codex", "append", "G:/fixture"); await sweep();
    expect(f.get().bySession["codex/append"]).toBe(session);
  });

  it("does not carry loadEarlier provenance across a different delegation-history snapshot", async () => {
    const f = fixture({ maxEntries: 0 });
    f.load.mockResolvedValueOnce({ ...page([row("latest", 101)]), nextBefore: 101 });
    await f.get().selectSession("codex", "delegations", "G:/fixture");
    let resolve!: (value: SessionPage) => void;
    f.load.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const pending = f.get().loadEarlier("codex/delegations");
    const changed = [row("another source snapshot", 0)];
    patchSession(f.set, "codex/delegations", { subagentHistory: changed });
    markReloadableHistory(f.get().bySession["codex/delegations"].messages, changed);
    resolve(page([row("earlier", 1)])); await pending;
    expect(hasReloadableHistory(f.get().bySession["codex/delegations"])).toBe(false);
  });

  it("does not reclaim during checkpoint capture and resumes with a clean timer lifecycle", async () => {
    const f = fixture({ maxEntries: 0 }); await f.openClose("captured");
    f.pause(true); const saved = f.checkpoint.capture();
    await sweep(); expect(retained(f)).toHaveLength(1);
    expect((saved as { reloadableSessionKeys: string[] }).reloadableSessionKeys).toEqual(["codex/captured"]);
    f.pause(false); await sweep(); expect(retained(f)).toHaveLength(0);
    f.dispose(); expect(f.observers.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("invalidates checkpoint proof when migration rewrites a message payload", async () => {
    const f = fixture();
    f.put("legacy-usage", { messages: [{ ...row("native"), usage: { input_tokens: 1 } }] }, true);
    const saved = f.checkpoint.capture();
    const next = fixture({ maxEntries: 0 }); next.checkpoint.restore(saved); next.set({ initialized: true });
    expect(hasReloadableHistory(next.get().bySession["codex/legacy-usage"])).toBe(false);
    await sweep(); expect(retained(next)).toHaveLength(1);
  });

  it("does not trust legacy checkpoints or save provenance for a changed message array", async () => {
    const f = fixture({ maxEntries: 0 }); await f.openClose("loaded");
    const session = f.get().bySession["codex/loaded"];
    patchSession(f.set, "codex/loaded", { messages: [...session.messages, row("new live row", 2)] });
    expect(hasReloadableHistory(f.get().bySession["codex/loaded"])).toBe(false);
    const saved = f.checkpoint.capture() as { reloadableSessionKeys?: string[] };
    expect(saved.reloadableSessionKeys).toEqual([]);
    delete saved.reloadableSessionKeys;
    const next = fixture({ maxEntries: 0 }); next.checkpoint.restore(saved); next.set({ initialized: true });
    await sweep(); expect(retained(next)).toHaveLength(1);
  });
});
