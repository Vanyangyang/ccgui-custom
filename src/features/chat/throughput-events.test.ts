import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import { useChatStore } from "./store";
import { handleEngineEvents, settledRuns, startThroughput, type ChatEngineEvent, type EngineEventDeps } from "./store/engine-events";
import { bufferStreamPart, drainPending, EMPTY_SESSION, runRouting } from "./store/stream";
import { sessionKey } from "./store/persistence";
import { createSessionActions } from "./store/sessions";
import { averageTps, beginThroughput, type ThroughputSample } from "./throughput";

vi.mock("@/lib/ipc", () => ({ ipc: {
  rescanSessions: vi.fn(async () => {}), usageRecord: vi.fn(async () => {}), listPlanReviews: vi.fn(async () => []),
  sendMessage: vi.fn(async (args: { runId: string }) => ({ runId: args.runId, sessionId: null })),
  sendFollowUp: vi.fn(async () => true), interruptTurn: vi.fn(async () => true), interruptSession: vi.fn(async () => true),
  rememberSessionModel: vi.fn(async () => {}), loadSessionPage: vi.fn(async () => ({ messages: [], nextBefore: null, subagentHistory: [] })),
} }));
vi.mock("@/lib/events", () => ({ listenEngineEvents: vi.fn(async () => () => {}), listenSessionsChanged: vi.fn(async () => () => {}), listenComputerUseEscape: vi.fn(async () => () => {}) }));

const tab = { engine: "claude", sessionId: "tps-session", workspacePath: "/tmp/tps" };
const key = sessionKey(tab.engine, tab.sessionId, tab.workspacePath);
const sample: ThroughputSample = { version: 1, source: "claude", status: "running", outputTokens: 100, elapsedMs: 10_000, generation: null, generationReason: "reasoning" };
let run = ""; let runNumber = 0;
const event = (kind: ChatEngineEvent["kind"], seq: number, data: unknown, runId = run): ChatEngineEvent => ({ ...tab, runId, seq, kind, data });
const deps = (): EngineEventDeps => ({ set: useChatStore.setState, get: useChatStore.getState, drainQueue: vi.fn(), upsertSessionMeta: vi.fn(), markUnseenIfBackground: vi.fn() });
const emit = (...events: ChatEngineEvent[]) => handleEngineEvents(events, deps());
const session = () => useChatStore.getState().bySession[key];
const patch = (data: Partial<ReturnType<typeof session>>) => useChatStore.setState(s => ({ bySession: { ...s.bySession, [key]: { ...s.bySession[key], ...data } } }));
beforeEach(() => {
  run = `tps-run-${++runNumber}`;
  localStorage.clear(); vi.clearAllMocks(); runRouting.clear(); settledRuns.clear();
  runRouting.set(run, key);
  useChatStore.setState({ initialized: true, active: tab, activeEngine: "claude", openTabs: [tab], models: {}, efforts: {}, providers: {}, sessions: [], archivedSessionKeys: {},
    engines: [{ id: "claude", available: true, enabled: true, permissions: ["auto"] } as never], permission: "auto",
    streamingByKey: { [key]: true }, retryingByKey: {}, bySession: { [key]: { ...EMPTY_SESSION, streaming: true, nativeTaskRunId: run,
      nativeActivity: "running", throughput: beginThroughput(run), messages: [{ role: "user", text: "hello", seq: 1, ts: null }] } } });
});
afterEach(() => { drainPending(key); });

describe("throughput sidecar lifecycle", () => {
  it("accepts AGY measurements only for their own engine and run", () => {
    const agy = { ...tab, engine: "agy" };
    const agyKey = sessionKey(agy.engine, agy.sessionId, agy.workspacePath);
    useChatStore.setState({ active: agy, openTabs: [agy], activeEngine: "agy", bySession: { [agyKey]: { ...EMPTY_SESSION, streaming: true, throughput: beginThroughput(run) } } });
    runRouting.set(run, agyKey);
    const reported = (seq: number, data: unknown): ChatEngineEvent => ({ ...agy, runId: run, seq, kind: "throughput", data });
    emit(reported(2, sample));
    expect(useChatStore.getState().bySession[agyKey].throughput?.sample).toBeNull();
    emit(reported(3, { ...sample, source: "agy", status: "complete", generationReason: "unsupported" }));
    expect(averageTps(useChatStore.getState().bySession[agyKey].throughput?.sample)).toBe(10);
    emit({ ...agy, runId: run, seq: 4, kind: "done", data: { usage: null } });
    const settled = useChatStore.getState().bySession[agyKey].throughput;
    emit(reported(5, { ...sample, source: "agy", status: "running" }));
    expect(useChatStore.getState().bySession[agyKey].throughput).toBe(settled);
    drainPending(agyKey);
  });
  it("changes only the sidecar, leaving text buffers, tools, routing and streaming untouched", () => {
    const tasks = [{ id: "tool", kind: "local_bash", description: "tool", status: "running" as const }];
    patch({ nativeTasks: tasks });
    bufferStreamPart(key, "delta", "unflushed正文🙂", null);
    const before = session(); const flags = useChatStore.getState().streamingByKey;
    emit(event("throughput", 2, sample));
    expect(session().messages).toBe(before.messages);
    expect(session().nativeTasks).toBe(tasks);
    expect(session().nativeTaskRunId).toBe(run);
    expect(session().streaming).toBe(true);
    expect(useChatStore.getState().streamingByKey).toBe(flags);
    expect(runRouting.get(run)).toBe(key);
    expect(drainPending(key)?.parts).toEqual([{ kind: "delta", text: "unflushed正文🙂" }]);
    expect(averageTps(session().throughput?.sample)).toBe(10);
  });
  it("keeps completion and drops all reports after its terminal sequence", () => {
    emit(event("throughput", 2, { ...sample, status: "complete" }), event("done", 3, { usage: null }));
    const final = session().throughput;
    expect(final).toMatchObject({ seq: 3, ended: true, sample: { status: "complete" } });
    emit(event("throughput", 4, { ...sample, outputTokens: 999 }), event("throughput", 2, sample));
    expect(session().throughput).toBe(final);
    expect(session().streaming).toBe(false);
    expect(runRouting.has(run)).toBe(false);
  });
  it.each(["error", "turn_complete"] as const)("marks %s interruption as partial without manufacturing a full rate", kind => {
    emit(event("throughput", 2, sample));
    emit(event(kind, 3, kind === "error" ? "failure" : { usage: null, interrupted: true }));
    expect(session().throughput?.sample?.status).toBe("partial");
    expect(averageTps(session().throughput?.sample)).toBeNull();
    emit(event("throughput", 4, { ...sample, status: "complete" }));
    expect(session().throughput?.sample?.status).toBe("partial");
  });
  it("ignores old-run reports and old completion after a different observed run starts", () => {
    emit(event("throughput", 2, { ...sample, status: "complete" }), event("done", 3, { usage: null }));
    emit(event("thinking", 4, "next", "new-run"));
    expect(session().throughput).toMatchObject({ runId: "new-run", sample: null });
    emit(event("throughput", 5, sample, "new-run"));
    const current = session().throughput;
    emit(event("throughput", 6, { ...sample, status: "complete" }), event("done", 7, { usage: null }));
    expect(session().throughput).toBe(current);
    expect(session().streaming).toBe(true);
  });
  it("starts no run from unsupported, malformed or historical sidecar events", () => {
    runRouting.clear(); patch({ streaming: false, throughput: null, nativeTaskRunId: undefined, usage: { output_tokens: 100 } });
    const before = session();
    emit(event("throughput", 2, sample), event("throughput", 3, { ...sample, source: "pi" }));
    expect(session()).toBe(before);
    expect(session().streaming).toBe(false);
    expect(session().throughput).toBeNull();
  });
  it("preserves a same-run early native sample when the pending session migrates", () => {
    const pending = { ...tab, sessionId: null };
    const pendingKey = sessionKey(tab.engine, null, tab.workspacePath);
    useChatStore.setState(s => ({ active: pending, openTabs: [pending], bySession: { ...s.bySession,
      [pendingKey]: { ...EMPTY_SESSION, streaming: true, throughput: beginThroughput(run) },
      [key]: { ...s.bySession[key], throughput: { runId: run, seq: 4, ended: false, sample } } } }));
    runRouting.set(run, pendingKey);
    emit(event("session", 5, tab.sessionId));
    expect(useChatStore.getState().bySession[pendingKey]).toBeUndefined();
    expect(session().throughput).toMatchObject({ runId: run, seq: 4, sample });
  });
  it("resets the metric for a native same-process continuation and rejects preceding sequences", () => {
    emit(event("throughput", 2, { ...sample, status: "complete" }), event("turn_complete", 3, { usage: null }));
    expect(session().throughput?.ended).toBe(true);
    emit(event("delta", 4, "next reply"));
    expect(session().throughput).toMatchObject({ runId: run, seq: 4, sample: null, ended: false });
    emit(event("throughput", 2, { ...sample, status: "complete" }));
    expect(session().throughput?.sample).toBeNull();
    emit(event("throughput", 5, sample));
    expect(averageTps(session().throughput?.sample)).toBe(10);
  });
  it("clears on local new send, and seals partial when Stop does not receive final telemetry", async () => {
    patch({ streaming: false, throughput: { ...beginThroughput("old"), sample: { ...sample, status: "complete" }, ended: true } });
    await useChatStore.getState().send("next", [], { requestedRunId: run }, tab);
    expect(session().throughput).toMatchObject({ runId: run, sample: null, ended: false });
    emit(event("throughput", 2, sample));
    await useChatStore.getState().interrupt(tab);
    // Native reply-only Stop remains pending until its acknowledgement.
    emit(event("turn_complete", 3, { usage: null, interrupted: true }));
    expect(session().throughput?.sample?.status).toBe("partial");
  });
  it("accepts only Codex App Server measurements for Codex and seals a locally killed run immediately", async () => {
    const codex = { ...tab, engine: "codex" };
    const codexKey = sessionKey(codex.engine, codex.sessionId, codex.workspacePath);
    useChatStore.setState({ active: codex, openTabs: [codex], activeEngine: "codex", bySession: { [codexKey]: { ...EMPTY_SESSION, streaming: true, throughput: beginThroughput(run) } } });
    runRouting.set(run, codexKey);
    const reported = (seq: number, data: unknown): ChatEngineEvent => ({ ...codex, runId: run, seq, kind: "throughput", data });
    emit(reported(2, sample));
    expect(useChatStore.getState().bySession[codexKey].throughput?.sample).toBeNull();
    emit(reported(3, { ...sample, source: "codex_app_server" }));
    expect(averageTps(useChatStore.getState().bySession[codexKey].throughput?.sample)).toBe(10);
    await useChatStore.getState().interrupt(codex);
    const stopped = useChatStore.getState().bySession[codexKey];
    expect(stopped.streaming).toBe(false);
    expect(stopped.throughput?.sample?.status).toBe("partial");
    expect(runRouting.has(run)).toBe(false);
    emit(reported(4, { ...sample, source: "codex_app_server", status: "complete" }));
    expect(useChatStore.getState().bySession[codexKey].throughput).toBe(stopped.throughput);
    drainPending(codexKey);
  });
  it("clears on a follow-up delivered into the same run and rolls back a failed delivery", async () => {
    patch({ liveLaunch: { model: null, effort: null, provider: null, permission: "auto" } });
    emit(event("throughput", 2, { ...sample, status: "complete" }), event("turn_complete", 3, { usage: null }), event("activity", 4, { state: "waiting" }));
    await useChatStore.getState().sendWhileBusy("follow-up", [], undefined, tab);
    expect(ipc.sendFollowUp).toHaveBeenCalledOnce();
    expect(session().throughput).toMatchObject({ runId: run, seq: 4, sample: null, ended: false });
    emit(event("throughput", 2, sample)); expect(session().throughput?.sample).toBeNull();
    emit(event("delta", 5, "reply"), event("throughput", 6, { ...sample, status: "complete" }), event("turn_complete", 7, { usage: null }), event("activity", 8, { state: "waiting" }));
    const complete = session().throughput;
    vi.mocked(ipc.sendFollowUp).mockRejectedValueOnce(new Error("pipe closed"));
    await useChatStore.getState().sendWhileBusy("failed follow-up", [], undefined, tab);
    expect(session().throughput).toBe(complete);
  });
  it("history reads restore usage without inferring throughput or overwriting a new sample", async () => {
    runRouting.clear(); patch({ messages: [], streaming: false, throughput: null, nativeTaskRunId: undefined });
    const page = { messages: [{ role: "assistant", text: "history", seq: 1, ts: null, usage: { output_tokens: 100 }, durationMs: 1000 }], nextBefore: null, subagentHistory: [] };
    const load = vi.fn(async () => page);
    const actions = createSessionActions({ set: useChatStore.setState, get: useChatStore.getState, subscribe: useChatStore.subscribe,
      loadHistoryPage: load, eventTeardowns: [], activateTab: vi.fn(), removeTab: vi.fn(), forgetClosedTab: vi.fn(), drainQueue: vi.fn(), markUnseenIfBackground: vi.fn() });
    await actions.selectSession(tab.engine, tab.sessionId, tab.workspacePath, { background: true });
    expect(session().usage).toEqual({ output_tokens: 100 });
    expect(session().throughput).toBeNull();
    // A same-session cold reload owns a read in flight; a new sidecar sample
    // must survive its eventual history-page patch.
    patch({ messages: [] });
    const otherActions = createSessionActions({ set: useChatStore.setState, get: useChatStore.getState, subscribe: useChatStore.subscribe,
      loadHistoryPage: async () => { patch({ throughput: { ...startThroughput(run), sample } }); return page; },
      eventTeardowns: [], activateTab: vi.fn(), removeTab: vi.fn(), forgetClosedTab: vi.fn(), drainQueue: vi.fn(), markUnseenIfBackground: vi.fn() });
    await otherActions.selectSession(tab.engine, tab.sessionId, tab.workspacePath, { background: true });
    expect(session().throughput?.sample).toBe(sample);
    expect(session().streaming).toBe(false);
  });
});
