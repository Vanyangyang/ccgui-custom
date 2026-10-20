import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import { useChatStore } from "./store";
import { handleEngineEvents, settledRuns, startThroughput, type ChatEngineEvent, type EngineEventDeps } from "./store/engine-events";
import { bufferStreamPart, drainPending, EMPTY_SESSION, runRouting } from "./store/stream";
import { sessionKey } from "./store/persistence";
import { createSessionActions } from "./store/sessions";
import { averageTps, beginThroughput, type ThroughputSample } from "./throughput";
import { buildTurnSummary } from "./turn-summary";
import { parseUsage } from "./usage";

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

  it("stamps verified Codex whole-turn throughput onto the settled assistant row while keeping session occupancy on last request", () => {
    // 【Codex页脚与状态栏一致性回归】last output 90、本轮 output 6000 / 300000ms => 页脚整轮效率 20，会话 occupancy 仍为 last 请求。
    const codex = { ...tab, engine: "codex" };
    const codexKey = sessionKey(codex.engine, codex.sessionId, codex.workspacePath);
    useChatStore.setState({
      active: codex,
      openTabs: [codex],
      activeEngine: "codex",
      bySession: {
        [codexKey]: {
          ...EMPTY_SESSION,
          streaming: true,
          turnStartedAt: Date.now() - 300_000,
          throughput: beginThroughput(run),
          messages: [{ role: "user", text: "refactor", seq: 1, ts: null }],
        },
      },
    });
    runRouting.set(run, codexKey);
    const codexEv = (kind: ChatEngineEvent["kind"], seq: number, data: unknown, runId = run): ChatEngineEvent => ({
      ...codex,
      runId,
      seq,
      kind,
      data,
    });
    emit(
      codexEv("delta", 2, "已完成多步工具调用"),
      codexEv("throughput", 3, {
        version: 1,
        source: "codex_app_server",
        status: "complete",
        outputTokens: 6_000,
        elapsedMs: 300_000,
        generation: null,
        generationReason: "unavailable_timing",
        turnReason: null,
      }),
      codexEv("done", 4, {
        usage: {
          usage_scope: "last_request",
          input_tokens: 45_000,
          cached_input_tokens: 36_000,
          output_tokens: 90,
          total_tokens: 45_090,
          model_context_window: 258_400,
        },
      }),
    );
    const settled = useChatStore.getState().bySession[codexKey];
    const assistant = settled.messages.findLast((m) => m.role === "assistant")!;
    // 会话级 occupancy 保持为 last 请求，不含 turn_throughput
    expect(parseUsage(settled.usage)).toMatchObject({ input: 9_000, cacheRead: 36_000, output: 90, total: 45_090 });
    expect((settled.usage as Record<string, unknown>).turn_throughput).toBeUndefined();
    // 回答页脚小结读取可信终态 sample：output=6000、outputTps=20，且不伪装整轮 input 或缓存比
    const summary = buildTurnSummary(assistant, 5);
    expect(summary).toMatchObject({
      input: 45_000,
      output: 6_000,
      usageComplete: false,
      cacheHitPercent: null,
      tools: 5,
      outputTps: 20,
    });
    expect(averageTps(settled.throughput?.sample)).toBe(20);
  });

  it("does not leak previous Codex turn throughput into a subsequent turn, follow-up, missing-baseline turn, or interrupted turn", () => {
    // 【Codex多回合与异常边界回归】第一轮有可信样本（20 tok/s），第二轮缺基线或仅 running 结束时不得复用第一轮样本。
    const codex = { ...tab, engine: "codex" };
    const codexKey = sessionKey(codex.engine, codex.sessionId, codex.workspacePath);
    useChatStore.setState({
      active: codex,
      openTabs: [codex],
      activeEngine: "codex",
      bySession: {
        [codexKey]: {
          ...EMPTY_SESSION,
          streaming: true,
          turnStartedAt: Date.now() - 300_000,
          throughput: beginThroughput("run-1"),
          messages: [{ role: "user", text: "turn 1", seq: 1, ts: null }],
        },
      },
    });
    runRouting.set("run-1", codexKey);
    const codexEv = (runId: string, kind: ChatEngineEvent["kind"], seq: number, data: unknown): ChatEngineEvent => ({
      ...codex,
      runId,
      seq,
      kind,
      data,
    });
    emit(
      codexEv("run-1", "delta", 1, "first reply"),
      codexEv("run-1", "throughput", 2, {
        version: 1,
        source: "codex_app_server",
        status: "complete",
        outputTokens: 6_000,
        elapsedMs: 300_000,
        generation: null,
        generationReason: "unavailable_timing",
        turnReason: null,
      }),
      codexEv("run-1", "done", 3, {
        usage: { input_tokens: 10_000, output_tokens: 90, total_tokens: 10_090 },
      }),
    );
    // 迟到的重复 done 或 throughput 不能覆盖已结算的第一轮
    emit(
      codexEv("run-1", "throughput", 4, {
        version: 1,
        source: "codex_app_server",
        status: "complete",
        outputTokens: 99_000,
        elapsedMs: 1_000,
        generation: null,
        generationReason: "unavailable_timing",
        turnReason: null,
      }),
      codexEv("run-1", "done", 5, { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }),
    );
    const afterTurn1 = useChatStore.getState().bySession[codexKey];
    const firstReply = afterTurn1.messages.find((m) => m.role === "assistant")!;
    expect(buildTurnSummary(firstReply)?.outputTps).toBe(20);

    // 第二轮恢复会话缺少 baseline：不应串用第一轮 sample，也不应回落到 90 / 300s = 0.3
    useChatStore.setState((s) => ({
      bySession: {
        ...s.bySession,
        [codexKey]: {
          ...s.bySession[codexKey],
          streaming: true,
          turnStartedAt: Date.now() - 300_000,
          messages: [...s.bySession[codexKey].messages, { role: "user", text: "turn 2", seq: 10, ts: null }],
        },
      },
    }));
    runRouting.set("run-2", codexKey);
    emit(
      codexEv("run-2", "delta", 1, "second reply"),
      codexEv("run-2", "throughput", 2, {
        version: 1,
        source: "codex_app_server",
        status: "complete",
        outputTokens: null,
        elapsedMs: 300_000,
        generation: null,
        generationReason: "unavailable_timing",
        turnReason: "missing_baseline",
      }),
      codexEv("run-2", "done", 3, {
        usage: { input_tokens: 12_000, output_tokens: 90, total_tokens: 12_090 },
      }),
    );
    const afterTurn2 = useChatStore.getState().bySession[codexKey];
    const replies = afterTurn2.messages.filter((m) => m.role === "assistant");
    expect(replies).toHaveLength(2);
    expect(buildTurnSummary(replies[0])?.outputTps).toBe(20);
    expect(buildTurnSummary(replies[1])).toMatchObject({
      input: 12_000,
      output: 90,
      usageComplete: false,
      cacheHitPercent: null,
      outputTps: null,
    });
  });
});
