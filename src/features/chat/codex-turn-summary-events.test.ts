import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "./store";
import { handleEngineEvents, settledRuns, type ChatEngineEvent, type EngineEventDeps } from "./store/engine-events";
import { drainPending, EMPTY_SESSION, runRouting } from "./store/stream";
import { sessionKey } from "./store/persistence";
import { beginThroughput } from "./throughput";
import { buildTurnSummary } from "./turn-summary";

vi.mock("@/lib/ipc", () => ({ ipc: {
  rescanSessions: vi.fn(async () => {}), usageRecord: vi.fn(async () => {}), listPlanReviews: vi.fn(async () => []),
  sendMessage: vi.fn(async (args: { runId: string }) => ({ runId: args.runId, sessionId: null })),
  sendFollowUp: vi.fn(async () => true), interruptTurn: vi.fn(async () => true), interruptSession: vi.fn(async () => true),
  rememberSessionModel: vi.fn(async () => {}), loadSessionPage: vi.fn(async () => ({ messages: [], nextBefore: null, subagentHistory: [] })),
} }));
vi.mock("@/lib/events", () => ({ listenEngineEvents: vi.fn(async () => () => {}), listenSessionsChanged: vi.fn(async () => () => {}), listenComputerUseEscape: vi.fn(async () => () => {}) }));

const tab = { engine: "codex", sessionId: "summary-session", workspacePath: "/tmp/summary" };
const key = sessionKey(tab.engine, tab.sessionId, tab.workspacePath);
const sample = { version: 1, source: "codex_app_server", status: "complete",
  outputTokens: 6000, elapsedMs: 300_000, generation: null, generationReason: "unavailable_timing", turnReason: null };
const lastUsage = { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 90 };
let run = ""; let runNumber = 0;
const event = (kind: ChatEngineEvent["kind"], seq: number, data: unknown): ChatEngineEvent => ({ ...tab, runId: run, seq, kind, data });
const deps = (): EngineEventDeps => ({ set: useChatStore.setState, get: useChatStore.getState, drainQueue: vi.fn(), upsertSessionMeta: vi.fn(), markUnseenIfBackground: vi.fn() });
const emit = (...events: ChatEngineEvent[]) => handleEngineEvents(events, deps());
const session = () => useChatStore.getState().bySession[key];
const summaries = () => session().messages.filter(m => m.role === "assistant").map(m => buildTurnSummary(m));
beforeEach(() => {
  run = `summary-run-${++runNumber}`;
  localStorage.clear(); vi.clearAllMocks(); runRouting.clear(); settledRuns.clear();
  runRouting.set(run, key);
  useChatStore.setState({ initialized: true, active: tab, activeEngine: "codex", openTabs: [tab], models: {}, efforts: {}, providers: {}, sessions: [], archivedSessionKeys: {},
    engines: [{ id: "codex", available: true, enabled: true, permissions: ["auto"] } as never], permission: "auto",
    streamingByKey: { [key]: true }, retryingByKey: {}, bySession: { [key]: {
      ...EMPTY_SESSION, streaming: true, nativeTaskRunId: run, nativeActivity: "running", throughput: beginThroughput(run),
      turnStartedAt: Date.now() - 310_000, liveLaunch: { model: null, effort: null, provider: null, permission: "auto" },
      messages: [{ role: "user", text: "hello", seq: 1, ts: null }],
    } } });
});
afterEach(() => { drainPending(key); });

describe("Codex summary uses the current response's native throughput", () => {
  it("uses 6000 / 300 seconds and leaves last-request context usage unchanged", () => {
    emit(event("delta", 1, "reply"), event("throughput", 2, sample), event("done", 3, { usage: lastUsage }));
    expect(summaries().at(-1)).toMatchObject({ outputTps: 20, output: 6000, usageComplete: false, cacheHitPercent: null });
    expect(session().usage).toEqual(lastUsage);
    const messages = session().messages;
    emit(event("throughput", 4, { ...sample, outputTokens: 99999 }), event("done", 5, { usage: lastUsage }));
    expect(session().messages).toBe(messages);
  });

  it.each([
    ["missing", null, false],
    ["missing baseline", { ...sample, outputTokens: null, turnReason: "missing_baseline" }, false],
    ["partial", { ...sample, status: "partial" }, false],
    ["interrupted", sample, true],
    ["wrong source", { ...sample, source: "claude" }, false],
  ])("does not invent a rate when %s", (_name, observation, interrupted) => {
    emit(event("delta", 1, "reply"));
    if (observation) emit(event("throughput", 2, observation));
    emit(event("turn_complete", 3, { usage: lastUsage, interrupted }));
    expect(summaries().at(-1)?.outputTps).toBeNull();
  });

  it("does not carry the previous response's sample into a same-run follow-up", async () => {
    emit(event("delta", 1, "first"), event("throughput", 2, sample),
      event("turn_complete", 3, { usage: lastUsage }), event("activity", 4, { state: "waiting" }));
    expect(summaries().at(-1)?.outputTps).toBe(20);
    await useChatStore.getState().sendWhileBusy("follow-up", [], undefined, tab);
    emit(event("delta", 5, "second"), event("turn_complete", 6, { usage: lastUsage }));
    expect(summaries().map(s => s?.outputTps)).toEqual([20, null]);
  });

  it("does not pair an earlier completion with a later observation", () => {
    emit(event("delta", 1, "reply"), event("throughput", 10, sample),
      event("done", 9, { usage: lastUsage }));
    expect(summaries().at(-1)?.outputTps).toBeNull();
  });
});
