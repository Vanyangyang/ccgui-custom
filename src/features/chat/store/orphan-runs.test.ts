import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { ipc } from "@/lib/ipc";
import type { ChatStore } from "../store";
import { handleEngineEvents, routeAndReconcileRun, settledRuns, settleOrphanedRuns, startThroughput, type ChatEngineEvent, type EngineEventDeps } from "./engine-events";
import { drainPending, EMPTY_SESSION, reconcileOrphanRuns, routeRun, runRouting, untrackRun } from "./stream";

vi.mock("@/lib/ipc", () => ({ ipc: {
  activeRunIds: vi.fn(async () => [] as string[]),
  rescanSessions: vi.fn(async () => {}),
  computerUseSetActive: vi.fn(async () => {}),
} }));

const KEY = "codex/orphan-a";
const OTHER = "codex/orphan-b";
const A = "orphan-run-a";
const B = "orphan-run-b";
const C = "orphan-run-c";
const MOVED = "codex/orphan-moved";
const probe = vi.mocked(ipc.activeRunIds);
let deps: EngineEventDeps;

function event(kind: ChatEngineEvent["kind"], data: unknown, seq = 1): ChatEngineEvent {
  return { kind, data, seq, engine: "codex", sessionId: "orphan-a", runId: A };
}

function check() {
  return reconcileOrphanRuns(ipc.activeRunIds, (rows) => settleOrphanedRuns(deps.set, rows));
}

function delayedProbe() {
  let resolve!: (ids: string[]) => void;
  probe.mockImplementationOnce(() => new Promise<string[]>((done) => { resolve = done; }));
  return (ids: string[]) => resolve(ids);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  probe.mockReset().mockResolvedValue([]);
  runRouting.clear();
  settledRuns.clear();
  for (const id of [A, B, C]) untrackRun(id);
  const store = createStore<ChatStore>(() => ({
    bySession: {
      [KEY]: { ...EMPTY_SESSION, streaming: true, throughput: startThroughput(A) },
      [OTHER]: { ...EMPTY_SESSION, streaming: true },
    },
    streamingByKey: { [KEY]: true, [OTHER]: true }, retryingByKey: {},
    models: {}, efforts: {}, drafts: {}, archivedSessionKeys: {},
    openTabs: [], active: null,
  }) as unknown as ChatStore);
  deps = { set: store.setState, get: store.getState, drainQueue: vi.fn(),
    markUnseenIfBackground: vi.fn(), upsertSessionMeta: vi.fn() };
  routeRun(A, KEY);
  vi.advanceTimersByTime(31 * 60_000);
});

afterEach(async () => {
  await check();
  for (const key of [KEY, OTHER, MOVED]) drainPending(key);
  for (const id of [A, B, C]) untrackRun(id);
  runRouting.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("native-verified orphan recovery", () => {
  it("keeps a silent active Codex turn and its later Chinese/emoji output through done", async () => {
    probe.mockResolvedValue([A]);
    routeAndReconcileRun(deps.set, B, OTHER);
    await check();
    expect(probe).toHaveBeenCalledWith([A]);
    expect(runRouting.get(A)).toBe(KEY);
    expect(deps.get().bySession[KEY].streaming).toBe(true);
    handleEngineEvents([
      event("delta", "等待后继续："),
      event("delta", "中文👩‍💻完成🚀", 2),
      event("done", { sessionId: "orphan-a", usage: null }, 3),
    ], deps);
    expect(deps.get().bySession[KEY].messages.filter((row) => row.role === "assistant").map((row) => row.text).join(""))
      .toBe("等待后继续：中文👩‍💻完成🚀");
    expect(deps.get().bySession[KEY].streaming).toBe(false);
    expect(runRouting.has(A)).toBe(false);
  });

  it("does not delete synchronously and settles only a confirmed missing run", async () => {
    routeAndReconcileRun(deps.set, B, OTHER);
    expect(runRouting.has(A)).toBe(true);
    await check();
    expect(runRouting.has(A)).toBe(false);
    expect(deps.get().bySession[KEY].streaming).toBe(false);
    expect(deps.get().bySession[KEY].settledRunIds).toContain(A);
  });

  it.each(["rejected", "missing"])("preserves candidates when the native query is %s", async (failure) => {
    probe.mockImplementation(() => { throw failure === "missing" ? new TypeError("activeRunIds is unavailable") : new Error("offline"); });
    routeAndReconcileRun(deps.set, B, OTHER);
    await check();
    expect(runRouting.get(A)).toBe(KEY);
    expect(deps.get().bySession[KEY].streaming).toBe(true);
    expect(deps.get().bySession[KEY].settledRunIds).toBeUndefined();
  });

  it("coalesces checks during one pending native query", async () => {
    const resolve = delayedProbe();
    const first = check();
    await Promise.resolve();
    routeAndReconcileRun(deps.set, B, OTHER);
    const second = check();
    expect(second).toBe(first);
    expect(probe).toHaveBeenCalledTimes(1);
    resolve([A]);
    await first;
    expect(probe).toHaveBeenCalledTimes(1);
    expect(runRouting.get(A)).toBe(KEY);
  });

  it("ignores an absent response after fresh output even at the same clock tick", async () => {
    const resolve = delayedProbe();
    const pending = check();
    await Promise.resolve();
    handleEngineEvents([event("delta", "仍在执行🙂")], deps);
    resolve([]);
    await pending;
    expect(runRouting.get(A)).toBe(KEY);
    expect(deps.get().bySession[KEY].streaming).toBe(true);
    expect(deps.get().bySession[KEY].settledRunIds).toBeUndefined();
  });

  it("ignores an absent response after normal done", async () => {
    const resolve = delayedProbe();
    const pending = check();
    await Promise.resolve();
    handleEngineEvents([event("done", { sessionId: "orphan-a", usage: null })], deps);
    const settled = deps.get().bySession[KEY];
    resolve([]);
    await pending;
    expect(deps.get().bySession[KEY]).toBe(settled);
    expect(runRouting.has(A)).toBe(false);
  });

  it("ignores an absent response after the run is routed to a migrated session", async () => {
    const resolve = delayedProbe();
    const pending = check();
    await Promise.resolve();
    routeAndReconcileRun(deps.set, A, MOVED);
    resolve([]);
    await pending;
    expect(runRouting.get(A)).toBe(MOVED);
    expect(deps.get().bySession[KEY].streaming).toBe(true);
  });

  it("does not clear a successor's streaming, retry, or throughput", async () => {
    const resolve = delayedProbe();
    const pending = check();
    await Promise.resolve();
    const throughput = startThroughput(C);
    const retry = { attempt: 1, max: 3, message: "retrying" };
    deps.set((state) => ({
      bySession: { ...state.bySession, [KEY]: { ...state.bySession[KEY], throughput, retry } },
      retryingByKey: { [KEY]: true },
    }));
    routeAndReconcileRun(deps.set, C, KEY);
    resolve([]);
    await pending;
    const state = deps.get();
    expect(runRouting.has(A)).toBe(false);
    expect(runRouting.get(C)).toBe(KEY);
    expect(state.bySession[KEY].settledRunIds).toContain(A);
    expect(state.bySession[KEY].streaming).toBe(true);
    expect(state.streamingByKey[KEY]).toBe(true);
    expect(state.retryingByKey[KEY]).toBe(true);
    expect(state.bySession[KEY].retry).toBe(retry);
    expect(state.bySession[KEY].throughput).toBe(throughput);
  });

  it("caps native batches at 256 candidates", async () => {
    const ids = Array.from({ length: 260 }, (_, index) => `batch-${index}`);
    for (const id of ids) routeRun(id, `codex/${id}`);
    vi.advanceTimersByTime(31 * 60_000);
    await check();
    expect(probe.mock.calls.map(([batch]) => batch.length)).toEqual([256, 5]);
    for (const id of ids) expect(runRouting.has(id)).toBe(false);
  });

  it.each([true, false])("keeps a completed successor intact and rejects late old output (telemetry=%s)", async (telemetry) => {
    const resolve = delayedProbe();
    const pending = check();
    await Promise.resolve();
    routeAndReconcileRun(deps.set, C, KEY);
    deps.set((state) => ({ bySession: { ...state.bySession,
      [KEY]: { ...state.bySession[KEY], throughput: telemetry ? startThroughput(C) : null },
    } }));
    handleEngineEvents([
      { ...event("delta", "新的结果✅"), runId: C },
      { ...event("done", { sessionId: "orphan-a", usage: null }, 2), runId: C },
    ], deps);
    const completed = deps.get().bySession[KEY];
    resolve([]);
    await pending;
    const recovered = deps.get().bySession[KEY];
    expect(recovered.settledRunIds).toContain(A);
    expect(recovered.messages).toBe(completed.messages);
    expect(recovered.usage).toBe(completed.usage);
    expect(recovered.throughput).toBe(completed.throughput);
    expect(recovered.streaming).toBe(false);
    handleEngineEvents([event("delta", "旧运行的迟到内容", 5)], deps);
    expect(deps.get().bySession[KEY]).toBe(recovered);
    expect(runRouting.has(A)).toBe(false);
  });
});
