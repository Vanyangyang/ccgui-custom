import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionActions, type SessionDeps } from "./sessions";
import { EMPTY_SESSION } from "./stream";
import { sessionKey } from "./persistence";
import type { ChatStore } from "./types";
import type { SessionMeta, SessionPage } from "@/lib/ipc";
import type { StoreSet } from "./context";

const mocks = vi.hoisted(() => ({ plans: vi.fn(async () => []), activated: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: { listPlanReviews: mocks.plans } }));
vi.mock("@/features/plugins/runtime/events", () => ({ emitSessionActivated: mocks.activated }));
const target = { engine: "claude", sessionId: "11111111-1111-1111-1111-111111111111", workspacePath: "G:/target" };
const active = { engine: "codex", sessionId: "active-session", workspacePath: "G:/active" };
const key = sessionKey(target.engine, target.sessionId, target.workspacePath);
const page: SessionPage = { messages: [{ role: "assistant", text: "history", seq: 1, ts: "2026-10-02" }], subagentHistory: [], nextBefore: null };
const cleanups: Array<() => void> = [];
function fixture(native: Pick<SessionDeps, "nativeProcessRunning" | "subscribeProcessRetired"> = {}) {
  let state = { active, activeEngine: "codex", openTabs: [active], bySession: {}, archivedSessionKeys: {}, sessions: [],
    drafts: { [sessionKey(active.engine, active.sessionId, active.workspacePath)]: "unsent draft" }, unseen: { [key]: true }, permission: "manual" } as unknown as ChatStore;
  const load = vi.fn(async () => page);
  const observers = new Set<() => void>(); const teardowns: Array<() => void> = [];
  const set: StoreSet = (patch) => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; [...observers].forEach((callback) => callback()); };
  const actions = createSessionActions({ get: () => state, set,
    ...native,
    subscribe: (callback) => { observers.add(callback); return () => { observers.delete(callback); }; },
    loadHistoryPage: load, eventTeardowns: teardowns, activateTab: vi.fn(), removeTab: vi.fn(), forgetClosedTab: vi.fn(), drainQueue: vi.fn(), markUnseenIfBackground: vi.fn() });
  const dispose = () => { teardowns.splice(0).forEach((off) => off()); };
  cleanups.push(dispose);
  return { get: () => state, set, load, actions, observers, dispose,
    updateSession: (patch: Partial<ChatStore["bySession"][string]>) => set((s) => ({ bySession: { ...s.bySession, [key]: { ...s.bySession[key], ...patch } } })) };
}
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });
afterEach(() => { cleanups.splice(0).forEach((off) => off()); });
describe("background native session preparation", () => {
  it("opens and loads an idle target with remembered settings without changing active engine, draft or read state", async () => {
    const f = fixture(); const drafts = f.get().drafts;
    const meta = { ...target, model: "remembered-model", effort: "high", provider: "remembered-provider" } as SessionMeta;
    await f.actions.selectSession(target.engine, target.sessionId, target.workspacePath, { background: true, meta });
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.get().openTabs).toEqual([active, target]);
    expect(f.get().active).toEqual(active); expect(f.get().activeEngine).toBe("codex");
    expect(f.get().drafts).toBe(drafts); expect(f.get().permission).toBe("manual"); expect(f.get().unseen[key]).toBe(true);
    expect(f.get().bySession[key]).toMatchObject({ loading: false, messages: page.messages, activeModel: "remembered-model", activeEffort: "high", activeProvider: "remembered-provider" });
    expect(mocks.activated).not.toHaveBeenCalled();
  });
  it("coalesces cold background and foreground loads and preserves foreground activation", async () => {
    const f = fixture(); let resolve!: (value: SessionPage) => void;
    f.load.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const background = f.actions.selectSession(target.engine, target.sessionId, target.workspacePath, { background: true });
    const foreground = f.actions.selectSession(target.engine, target.sessionId, target.workspacePath);
    expect(f.load).toHaveBeenCalledTimes(1); expect(f.get().active).toEqual(target);
    resolve(page); await Promise.all([background, foreground]);
    expect(f.get().bySession[key].messages).toEqual(page.messages); expect(f.get().unseen[key]).toBeUndefined(); expect(mocks.activated).toHaveBeenCalledTimes(1);
  });
  it("does not overwrite live timeline changes arriving before a delayed history page", async () => {
    const f = fixture(); let resolve!: (value: SessionPage) => void;
    f.load.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const pending = f.actions.selectSession(target.engine, target.sessionId, target.workspacePath, { background: true });
    const live: SessionPage["messages"] = [{ role: "user", text: "new turn", seq: 2, ts: "2026-10-02" }];
    f.get().bySession[key] = { ...f.get().bySession[key], streaming: true, messages: live };
    resolve(page); await pending;
    expect(f.get().bySession[key]).toMatchObject({ messages: live, streaming: true, loading: false });
  });
  it("rejects history failures for the host but preserves foreground error handling and retries", async () => {
    const f = fixture(); f.load.mockRejectedValueOnce(new Error("history unavailable"));
    await expect(f.actions.selectSession(target.engine, target.sessionId, target.workspacePath, { background: true })).rejects.toThrow("history unavailable");
    expect(f.get().bySession[key]).toMatchObject({ loading: false, error: "Error: history unavailable" });
    await f.actions.selectSession(target.engine, target.sessionId, target.workspacePath, { background: true });
    expect(f.load).toHaveBeenCalledTimes(2);
    const other = fixture(); other.load.mockRejectedValueOnce(new Error("disk"));
    await expect(other.actions.selectSession(target.engine, target.sessionId, target.workspacePath)).resolves.toBeUndefined();
  });
  it("does not treat a past turn error as history failure or reload an already loaded empty session", async () => {
    const f = fixture(); f.get().bySession[key] = { ...EMPTY_SESSION, messages: page.messages, error: "past engine error" };
    await f.actions.selectSession(target.engine, target.sessionId, target.workspacePath, { background: true });
    expect(f.load).not.toHaveBeenCalled();
    const empty = fixture(); empty.load.mockResolvedValue({ ...page, messages: [] });
    await Promise.all([empty.actions.selectSession(target.engine, target.sessionId, target.workspacePath, { background: true }), empty.actions.selectSession(target.engine, target.sessionId, target.workspacePath, { background: true })]);
    await empty.actions.selectSession(target.engine, target.sessionId, target.workspacePath, { background: true });
    expect(empty.load).toHaveBeenCalledTimes(1);
  });
  it("reloads evicted history before remembered metadata recreates an empty cache entry", async () => {
    const f = fixture();
    const meta = { ...target, model: "opus", effort: "high", provider: "local" } as SessionMeta;
    await f.actions.selectSession(target.engine, target.sessionId, target.workspacePath, { background: true, meta });
    f.set({ openTabs: [active], bySession: {} });
    await f.actions.selectSession(target.engine, target.sessionId, target.workspacePath, { background: true, meta });
    expect(f.load).toHaveBeenCalledTimes(2);
    expect(f.get().bySession[key].messages).toBe(page.messages);
    expect(f.get().bySession[key].activeModel).toBe("opus");
  });
});

describe("deferred authoritative native history refresh", () => {
  async function racedFixture(native?: Parameters<typeof fixture>[0]) {
    const f = fixture(native); let resolve!: (value: SessionPage) => void;
    f.load.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const pending = f.actions.selectSession(target.engine, target.sessionId, target.workspacePath, { background: true });
    const live: SessionPage["messages"] = [{ role: "user", text: "live", seq: 7, ts: null }];
    const usage = { tokens: 999 };
    f.updateSession({ messages: live, streaming: true, usage });
    const delegation = [{ role: "tool", text: "delegation", seq: 3, ts: null }];
    resolve({ ...page, subagentHistory: delegation, nextBefore: 5 }); await pending;
    return { ...f, live, usage, delegation };
  }
  it("keeps an unpersisted failed prompt available for retry instead of replacing it with older history", async () => {
    const f = await racedFixture();
    f.updateSession({ streaming: false, error: "failed to spawn claude" });
    await Promise.resolve(); await Promise.resolve();
    await f.actions.loadEarlier(key);
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.get().bySession[key].messages).toBe(f.live);
    expect(f.get().bySession[key].error).toBe("failed to spawn claude");
    const persisted = { ...page, messages: [...page.messages, { ...f.live[0], seq: 2 }] };
    f.load.mockResolvedValueOnce(persisted);
    f.updateSession({ streaming: true, error: null });
    f.updateSession({ streaming: false });
    await vi.waitFor(() => expect(f.get().bySession[key].messages).toBe(persisted.messages));
  });
  it("waits for Claude process retirement before reading history that may lag Done", async () => {
    const running = vi.fn(async () => true); const off = vi.fn();
    let retired!: () => void;
    const f = await racedFixture({ nativeProcessRunning: running,
      subscribeProcessRetired: async (callback) => { retired = callback; return off; } });
    f.updateSession({ streaming: false });
    await vi.waitFor(() => expect(running).toHaveBeenCalledTimes(1));
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.get().bySession[key].messages).toBe(f.live);
    const persisted = { ...page, messages: [...page.messages, { ...f.live[0], seq: 2 }] };
    f.load.mockResolvedValueOnce(persisted); running.mockResolvedValue(false); retired();
    await vi.waitFor(() => expect(f.get().bySession[key].messages).toBe(persisted.messages));
    expect(running).toHaveBeenCalledTimes(2);
    f.dispose(); expect(off).toHaveBeenCalledTimes(1);
  });
  it("resubscribes after a transient retirement-transport failure on explicit history retry", async () => {
    const subscribe = vi.fn<NonNullable<SessionDeps["subscribeProcessRetired"]>>()
      .mockRejectedValueOnce(new Error("retirement transport unavailable"))
      .mockResolvedValue(() => {});
    const f = await racedFixture({ nativeProcessRunning: async () => false, subscribeProcessRetired: subscribe });
    f.updateSession({ streaming: false });
    await vi.waitFor(() => expect(f.get().bySession[key].error).toContain("retirement transport unavailable"));
    expect(f.load).toHaveBeenCalledTimes(1);
    const persisted = { ...page, messages: [...page.messages, { ...f.live[0], seq: 2 }] };
    f.load.mockResolvedValueOnce(persisted);
    await f.actions.selectSession(target.engine, target.sessionId, target.workspacePath, { background: true });
    expect(subscribe).toHaveBeenCalledTimes(2);
    expect(f.get().bySession[key].messages).toBe(persisted.messages);
    expect(f.get().bySession[key].error).toBeNull();
  });
  it("keeps live rows immediately, then restores the full native page/cursor at a stable boundary with live usage", async () => {
    const f = await racedFixture(); const drafts = f.get().drafts;
    expect(f.get().bySession[key].messages).toBe(f.live); expect(f.get().bySession[key].messages[0].seq).toBe(7);
    expect(f.get().bySession[key].subagentHistory).toBe(f.delegation); expect(f.observers.size).toBe(1);
    const native: SessionPage = { messages: [{ ...page.messages[0], seq: 100, usage: { tokens: 1 } }, { ...f.live[0], seq: 101 }], nextBefore: 99, subagentHistory: f.delegation };
    f.load.mockResolvedValueOnce(native); f.updateSession({ streaming: false });
    await vi.waitFor(() => expect(f.get().bySession[key].messages).toBe(native.messages));
    expect(f.load).toHaveBeenCalledTimes(2); expect(f.get().bySession[key]).toMatchObject({ nextBefore: 99, subagentHistory: f.delegation, loading: false });
    expect(f.get().bySession[key].usage).toBe(f.usage); expect(f.observers.size).toBe(0);
    expect(f.get().active).toBe(active); expect(f.get().activeEngine).toBe("codex"); expect(f.get().drafts).toBe(drafts); expect(f.get().unseen[key]).toBe(true);
  });
  it("kicks one deferred refresh when a turn already settled before the cold read completed", async () => {
    const f = fixture(); let release!: (page: SessionPage) => void;
    f.load.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const pending = f.actions.selectSession(target.engine, target.sessionId, target.workspacePath, { background: true });
    // Even a turn without a content row invalidates a page read before it ran.
    f.updateSession({ streaming: true }); f.updateSession({ streaming: false });
    const native = { ...page, messages: [{ ...page.messages[0], text: "latest after turn", seq: 102 }] };
    f.load.mockResolvedValueOnce(native); release(page); await pending;
    await vi.waitFor(() => expect(f.get().bySession[key].messages).toBe(native.messages));
    expect(f.load).toHaveBeenCalledTimes(2); expect(f.observers.size).toBe(0);
  });
  it("preserves AskLoop row and callback identity until its pending interactive card settles", async () => {
    const f = await racedFixture();
    const question = { requestId: "ask-request", runId: "run-live", status: "pending" as const, questions: [] };
    const ask = { role: "question", text: "pick", seq: 17, ts: null, question };
    const live = [...f.live, ask]; f.updateSession({ streaming: false, messages: live });
    await Promise.resolve(); await Promise.resolve();
    expect(f.load).toHaveBeenCalledTimes(1); expect(f.get().bySession[key].messages).toBe(live);
    expect(f.get().bySession[key].messages[1]).toBe(ask); expect(f.get().bySession[key].messages[1].question).toBe(question);
    f.updateSession({ messages: [f.live[0], { ...ask, question: { ...question, status: "answered" } }] });
    await vi.waitFor(() => expect(f.load).toHaveBeenCalledTimes(2));
  });
  it("defers again if a new live turn races the deferred read instead of overwriting it", async () => {
    const f = await racedFixture(); let finishDeferred!: (value: SessionPage) => void;
    f.load.mockImplementationOnce(() => new Promise((r) => { finishDeferred = r; }));
    f.updateSession({ streaming: false }); await vi.waitFor(() => expect(f.load).toHaveBeenCalledTimes(2));
    expect(f.get().bySession[key].loading).toBe(false);
    const secondLive = [...f.live, { role: "assistant", text: "another turn", seq: 8, ts: null }];
    f.updateSession({ streaming: true, messages: secondLive }); finishDeferred(page);
    await vi.waitFor(() => expect(f.observers.size).toBe(1));
    expect(f.get().bySession[key].messages).toBe(secondLive); expect(f.load).toHaveBeenCalledTimes(2);
    const latest = { ...page, messages: [...page.messages, ...secondLive], nextBefore: 40 };
    f.load.mockResolvedValueOnce(latest); f.updateSession({ streaming: false });
    await vi.waitFor(() => expect(f.get().bySession[key].messages).toBe(latest.messages)); expect(f.load).toHaveBeenCalledTimes(3);
  });
  it("surfaces a deferred failure without automatic retry, then explicitly reloads despite cached live rows", async () => {
    const f = await racedFixture(); f.load.mockRejectedValueOnce(new Error("deferred disk failure"));
    f.updateSession({ streaming: false });
    await vi.waitFor(() => expect(f.get().bySession[key].error).toContain("deferred disk failure"));
    expect(f.get().bySession[key].messages).toBe(f.live); expect(f.observers.size).toBe(0);
    f.set({ unseen: { [key]: true } }); await Promise.resolve(); expect(f.load).toHaveBeenCalledTimes(2);
    const latest = { ...page, messages: [...page.messages, ...f.live] }; f.load.mockResolvedValueOnce(latest);
    await f.actions.selectSession(target.engine, target.sessionId, target.workspacePath, { background: true });
    expect(f.get().bySession[key].messages).toBe(latest.messages); expect(f.get().bySession[key].error).toBeNull(); expect(f.load).toHaveBeenCalledTimes(3);
  });
  it("refreshes the missing latest page before loading older pages and coalesces explicit calls", async () => {
    const f = await racedFixture(); await f.actions.loadEarlier(key); expect(f.load).toHaveBeenCalledTimes(1);
    let finish!: (value: SessionPage) => void; f.load.mockImplementationOnce(() => new Promise((r) => { finish = r; }));
    f.updateSession({ streaming: false }); await vi.waitFor(() => expect(f.load).toHaveBeenCalledTimes(2));
    const earlier = f.actions.loadEarlier(key);
    const selected = f.actions.selectSession(target.engine, target.sessionId, target.workspacePath, { background: true });
    expect(f.load).toHaveBeenCalledTimes(2);
    const latest = { ...page, messages: [...page.messages, ...f.live], nextBefore: 30 }; finish(latest); await Promise.all([earlier, selected]);
    expect(f.load.mock.calls[1]).toEqual([target.engine, target.sessionId, target.workspacePath, 100]);
    f.load.mockResolvedValueOnce({ ...page, messages: [], nextBefore: null }); await f.actions.loadEarlier(key);
    expect(f.load.mock.calls[2]).toEqual([target.engine, target.sessionId, target.workspacePath, 100, 30]);
    expect(f.get().bySession[key].messages).toEqual(latest.messages);
  });
  it("stops observing a closed target and forces its stale cached timeline to refresh on reopen", async () => {
    const f = await racedFixture(); f.set({ openTabs: [active] }); expect(f.observers.size).toBe(0);
    f.updateSession({ streaming: false }); await Promise.resolve(); expect(f.load).toHaveBeenCalledTimes(1);
    const latest = { ...page, messages: [...page.messages, ...f.live] }; f.load.mockResolvedValueOnce(latest);
    await f.actions.selectSession(target.engine, target.sessionId, target.workspacePath, { background: true });
    expect(f.load).toHaveBeenCalledTimes(2); expect(f.get().bySession[key].messages).toBe(latest.messages); expect(f.get().active).toBe(active);
  });
  it("disposes both observers when a target closes during the deferred read without applying that page", async () => {
    const f = await racedFixture(); let finish!: (value: SessionPage) => void;
    f.load.mockImplementationOnce(() => new Promise((r) => { finish = r; }));
    f.updateSession({ streaming: false }); await vi.waitFor(() => expect(f.load).toHaveBeenCalledTimes(2));
    expect(f.observers.size).toBe(2); f.set({ openTabs: [active] }); expect(f.observers.size).toBe(0);
    finish(page); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(f.get().bySession[key].messages).toBe(f.live); expect(f.load).toHaveBeenCalledTimes(2);
    const latest = { ...page, messages: [...page.messages, ...f.live] }; f.load.mockResolvedValueOnce(latest);
    await f.actions.selectSession(target.engine, target.sessionId, target.workspacePath, { background: true });
    expect(f.get().bySession[key].messages).toBe(latest.messages); expect(f.load).toHaveBeenCalledTimes(3);
  });
  it("cold-loads a closed stale target if its cached live state was evicted after observation stopped", async () => {
    const f = await racedFixture(); f.set({ openTabs: [active] }); expect(f.observers.size).toBe(0);
    f.set({ bySession: {} });
    await f.actions.selectSession(target.engine, target.sessionId, target.workspacePath, { background: true });
    expect(f.load).toHaveBeenCalledTimes(2); expect(f.get().bySession[key].messages).toBe(page.messages);
  });
  it.each(["archive", "remove", "teardown"])("cleans up refresh observation on %s", async (kind) => {
    const f = await racedFixture();
    if (kind === "archive") f.set({ archivedSessionKeys: { [key]: true } });
    if (kind === "remove") f.set({ bySession: {} });
    if (kind === "teardown") f.dispose();
    expect(f.observers.size).toBe(0);
    if (f.get().bySession[key]) f.updateSession({ streaming: false });
    await Promise.resolve(); await Promise.resolve(); expect(f.load).toHaveBeenCalledTimes(1);
  });
});
