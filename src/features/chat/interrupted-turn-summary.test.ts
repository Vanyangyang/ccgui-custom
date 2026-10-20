import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "./store";
import { handleEngineEvents, settledRuns, type ChatEngineEvent } from "./store/engine-events";
import { drainPending, EMPTY_SESSION, runRouting } from "./store/stream";
import { sessionKey } from "./store/persistence";
import { averageTps, beginThroughput } from "./throughput";
import { buildTurnSummary } from "./turn-summary";

vi.mock("@/lib/ipc", () => ({ ipc: {
  rescanSessions: vi.fn(async () => {}), usageRecord: vi.fn(async () => {}),
  listPlanReviews: vi.fn(async () => []),
  loadSessionPage: vi.fn(async () => ({ messages: [], nextBefore: null, subagentHistory: [] })),
} }));
vi.mock("@/lib/events", () => ({ listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}), listenComputerUseEscape: vi.fn(async () => () => {}) }));

let serial = 0;
const keys: string[] = [];
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  localStorage.clear(); runRouting.clear(); settledRuns.clear();
});
afterEach(() => {
  for (const key of keys.splice(0)) drainPending(key);
  vi.restoreAllMocks();
});

function fixture(engine: string, interrupted = false) {
  const tab = { engine, sessionId: `summary-${++serial}`, workspacePath: "/tmp/summary" };
  const key = sessionKey(engine, tab.sessionId, tab.workspacePath);
  const runId = `summary-${serial}`;
  keys.push(key); runRouting.set(runId, key);
  const usage = { input_tokens: 1000, output_tokens: 400,
    ...(engine === "agy" ? { usage_scope: "turn" } : {}) };
  useChatStore.setState({
    initialized: true, active: tab, activeEngine: engine, openTabs: [tab],
    models: {}, efforts: {}, providers: {}, sessions: [], archivedSessionKeys: {},
    engines: [{ id: engine, available: true, enabled: true, permissions: ["auto"] } as never],
    permission: "auto", streamingByKey: { [key]: true }, retryingByKey: {},
    bySession: { [key]: { ...EMPTY_SESSION, streaming: true, interrupted,
      nativeTaskRunId: runId, nativeActivity: "running", throughput: beginThroughput(runId),
      turnStartedAt: 990_000,
      messages: [{ role: "user", text: "task", seq: 1, ts: null },
        { role: "assistant", text: "answer 中文🙂", seq: 2, ts: null }],
    } },
  });
  const event = (kind: ChatEngineEvent["kind"], seq: number, data: unknown): ChatEngineEvent =>
    ({ ...tab, runId, seq, kind, data });
  const sample = (status: "complete" | "partial") => ({
    version: 1, source: engine, status, outputTokens: 400, elapsedMs: 10_000, generation: null,
    generationReason: "unavailable_timing", turnReason: status === "partial" ? "interrupted" : null,
  });
  const emit = (...events: ChatEngineEvent[]) => handleEngineEvents(events, {
    set: useChatStore.setState, get: useChatStore.getState, drainQueue: vi.fn(),
    upsertSessionMeta: vi.fn(), markUnseenIfBackground: vi.fn(),
  });
  const state = () => useChatStore.getState().bySession[key];
  const reply = () => state().messages.findLast(m => m.role === "assistant")!;
  return { tab, key, runId, usage, event, sample, emit, state, reply };
}

describe.each(["claude", "agy"])("%s interrupted turn summary", engine => {
  it.each(["payload", "sample"] as const)("hides efficiency when interruption is reported by %s", source => {
    const f = fixture(engine);
    f.emit(
      f.event("throughput", 3, f.sample(source === "sample" ? "partial" : "complete")),
      f.event(engine === "claude" ? "turn_complete" : "done", 4, {
        usage: f.usage, interrupted: source === "payload",
      }),
    );
    expect(averageTps(f.state().throughput?.sample)).toBeNull();
    const restored = JSON.parse(JSON.stringify(f.reply()));
    expect(buildTurnSummary(restored)).toMatchObject({
      input: 1000, output: 400, usageComplete: false, outputTps: null, cacheHitPercent: null,
    });
    expect(f.reply().text).toBe("answer 中文🙂");
    expect(f.state().usage).toEqual(f.usage);
  });

  it("keeps successful whole-turn accounting unchanged", () => {
    const f = fixture(engine);
    f.emit(f.event("throughput", 3, f.sample("complete")),
      f.event(engine === "claude" ? "turn_complete" : "done", 4, { usage: f.usage }));
    expect(buildTurnSummary(f.reply())).toMatchObject({ output: 400, usageComplete: true, outputTps: 40 });
    expect(f.state().usage).toEqual(f.usage);
  });
});

it("handles the AGY local Stop flag even if Done has no interruption field", () => {
  const f = fixture("agy", true);
  f.emit(f.event("throughput", 3, f.sample("complete")), f.event("done", 4, { usage: f.usage }));
  expect(buildTurnSummary(f.reply())?.outputTps).toBeNull();
});

it("keeps an interrupted Claude response partial when the same run successfully continues", () => {
  const f = fixture("claude");
  f.emit(f.event("throughput", 3, f.sample("partial")),
    f.event("turn_complete", 4, { usage: f.usage, interrupted: true }),
    f.event("activity", 5, { state: "waiting" }));
  const first = f.reply();
  f.emit(f.event("activity", 6, { state: "running" }), f.event("delta", 7, "next reply"),
    f.event("throughput", 8, f.sample("complete")), f.event("turn_complete", 9, { usage: f.usage }));
  expect(buildTurnSummary(first)?.outputTps).toBeNull();
  expect(buildTurnSummary(f.reply())).toMatchObject({ usageComplete: true, outputTps: 40 });
  f.emit(f.event("done", 10, { usage: null }));
  expect(buildTurnSummary(first)?.outputTps).toBeNull();
  expect(buildTurnSummary(f.reply())).toMatchObject({ usageComplete: true, outputTps: 40 });
});
