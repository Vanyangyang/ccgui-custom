import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineEventPayload } from "@/lib/events";
import { ipc } from "@/lib/ipc";
import { sessionKey, useChatStore } from "./store";
import { EMPTY_SESSION, runRouting } from "./store/stream";

let deliver: ((events: EngineEventPayload[]) => void) | undefined;
vi.mock("@/lib/ipc", () => ({ ipc: {
  listWorkspaces: vi.fn(async () => []),
  listSessions: vi.fn(async () => []),
  listArchivedSessions: vi.fn(async () => []),
  listEngines: vi.fn(async () => []),
  sendMessage: vi.fn(async (request: { runId: string }) => ({ runId: request.runId, sessionId: null })),
  interruptSession: vi.fn(async () => true),
  interruptTurn: vi.fn(async () => true),
  rememberSessionModel: vi.fn(async () => {}),
  loadSessionPage: vi.fn(async () => ({ messages: [], nextBefore: null })),
  getAppSettings: vi.fn(async () => ({})),
  updateAppSettings: vi.fn(async () => {}),
  rescanSessions: vi.fn(async () => {}),
  getCliConfig: vi.fn(async () => ({})),
} }));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async (cb: typeof deliver) => { deliver = cb; return () => {}; }),
  listenSessionsChanged: vi.fn(async () => () => {}),
  listenComputerUseEscape: vi.fn(async () => () => {}),
}));

const TAB = { engine: "agy", sessionId: "agy-queue", workspacePath: "/tmp/agy-queue" };
const KEY = sessionKey(TAB.engine, TAB.sessionId, TAB.workspacePath);
const state = () => useChatStore.getState();
const session = () => state().bySession[KEY];
let serial = 0;
let runId: string;
function terminal(kind: "done" | "error" = "done", id = runId) {
  expect(deliver).toBeTypeOf("function");
  deliver!([{ runId: id, sessionId: TAB.sessionId, engine: TAB.engine, seq: 99, kind,
    data: kind === "done" ? { usage: null, interrupted: true } : "Native run ended with an error" }]);
}
function queue() {
  state().queueMessage("先排队的消息", [], undefined, TAB);
  state().queueMessage("优先发送🙂", ["/tmp/reference.png"], undefined, TAB);
  return session().queue[1].id;
}
function expectSelectedSent() {
  expect(ipc.sendMessage).toHaveBeenCalledTimes(1);
  expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
    engine: "agy", sessionId: TAB.sessionId, prompt: "优先发送🙂", imagePaths: ["/tmp/reference.png"],
  }));
  expect(session().queue.map(item => item.text)).toEqual(["先排队的消息"]);
}

describe("AGY queued send now", () => {
  beforeAll(async () => { await state().init(); });
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    runRouting.clear();
    runId = `agy-queue-run-${++serial}`;
    runRouting.set(runId, KEY);
    useChatStore.setState({ active: TAB, activeEngine: "agy", openTabs: [TAB], sessions: [],
      models: { agy: "orchestrator" }, streamingByKey: { [KEY]: true },
      bySession: { [KEY]: { ...EMPTY_SESSION, streaming: true, nativeTaskRunId: runId,
        nativeActivity: "running", turnStartedAt: Date.now(),
        messages: [{ seq: 1, role: "user", text: "原请求", ts: null },
          { seq: 2, role: "assistant", text: "已有输出🙂", ts: null, live: true }],
      } },
    });
  });

  it.each(["running", "waiting", "requires_action"] as const)("one click sends after final done from %s", async activity => {
    useChatStore.setState(s => ({ bySession: { [KEY]: { ...s.bySession[KEY], nativeActivity: activity } } }));
    await state().sendQueuedNow(queue(), KEY);
    expect(ipc.interruptSession).toHaveBeenCalledExactlyOnceWith(runId);
    expect(ipc.interruptTurn).not.toHaveBeenCalled();
    expect(ipc.sendMessage).not.toHaveBeenCalled();
    expect(session()).toMatchObject({ streaming: true, queueParked: false });
    expect(runRouting.get(runId)).toBe(KEY);
    terminal();
    await Promise.resolve();
    expectSelectedSent();
    expect(session().messages).toContainEqual(expect.objectContaining({ text: "已有输出🙂", live: false }));
    terminal(); // Duplicate old terminal must not send the next queued item.
    expectSelectedSent();
  });

  it("sends after terminal error without requiring another click", async () => {
    await state().sendQueuedNow(queue(), KEY);
    terminal("error");
    await Promise.resolve();
    expectSelectedSent();
  });

  it.each(["accepted", "absent", "error"] as const)("does not duplicate sending when done precedes cancellation reply %s", async outcome => {
    const pending = Promise.withResolvers<boolean>();
    vi.mocked(ipc.interruptSession).mockReturnValueOnce(pending.promise);
    const sending = state().sendQueuedNow(queue(), KEY);
    expect(ipc.interruptSession).toHaveBeenCalledExactlyOnceWith(runId);
    terminal();
    if (outcome === "error") pending.reject(new Error("Late cancellation failure"));
    else pending.resolve(outcome === "accepted");
    await sending;
    expectSelectedSent();
    expect(session().streaming).toBe(true);
    expect(session().error).toBeNull();
  });

  it.each(["done", "false"] as const)("a subsequent Stop keeps the queue parked through %s", async outcome => {
    const pending = Promise.withResolvers<boolean>();
    vi.mocked(ipc.interruptSession).mockReturnValueOnce(pending.promise);
    const sending = state().sendQueuedNow(queue(), KEY);
    expect(ipc.interruptSession).toHaveBeenCalledExactlyOnceWith(runId);
    await state().interrupt(TAB);
    if (outcome === "done") terminal();
    pending.resolve(outcome === "done");
    await sending;
    expect(ipc.sendMessage).not.toHaveBeenCalled();
    expect(session().queue).toHaveLength(2);
    expect(session().streaming).toBe(false);
  });

  it("Send Now lifts an earlier Stop even while cancellation is in flight", async () => {
    const id = queue();
    const pending = Promise.withResolvers<boolean>();
    vi.mocked(ipc.interruptSession).mockReturnValueOnce(pending.promise);
    const stopping = state().interrupt(TAB);
    await state().sendQueuedNow(id, KEY);
    pending.resolve(true);
    await stopping;
    expect(ipc.interruptSession).toHaveBeenCalledTimes(1);
    terminal();
    await Promise.resolve();
    expectSelectedSent();
  });

  it("sends once when the backend confirms the registered run is already absent", async () => {
    vi.mocked(ipc.interruptSession).mockResolvedValueOnce(false);
    await state().sendQueuedNow(queue(), KEY);
    expectSelectedSent();
    expect(runRouting.has(runId)).toBe(false);
  });

  it("keeps the message queued and the run live when cancellation fails", async () => {
    vi.mocked(ipc.interruptSession).mockRejectedValueOnce(new Error("cancel transport failed"));
    await state().sendQueuedNow(queue(), KEY);
    expect(ipc.sendMessage).not.toHaveBeenCalled();
    expect(session().streaming).toBe(true);
    expect(session().queue).toHaveLength(2);
    expect(session().error).toContain("cancel transport failed");
    expect(runRouting.get(runId)).toBe(KEY);
    terminal();
    await Promise.resolve();
    expectSelectedSent();
  });

  it("coalesces repeated clicks while cancellation is in flight", async () => {
    const pending = Promise.withResolvers<boolean>();
    vi.mocked(ipc.interruptSession).mockReturnValueOnce(pending.promise);
    const id = queue();
    const first = state().sendQueuedNow(id, KEY);
    await state().sendQueuedNow(id, KEY);
    pending.resolve(true);
    await first;
    expect(ipc.interruptSession).toHaveBeenCalledTimes(1);
    terminal();
    await Promise.resolve();
    expectSelectedSent();
  });

  it.each(["same", "remapped", "absent"] as const)("preserves Send Now across a %s launch acknowledgement", async identity => {
    runRouting.clear();
    useChatStore.setState({ streamingByKey: {}, bySession: { [KEY]: { ...EMPTY_SESSION } } });
    const launch = Promise.withResolvers<{ runId: string; sessionId: null }>();
    vi.mocked(ipc.sendMessage).mockReturnValueOnce(launch.promise);
    const starting = state().send("启动中的请求", [], undefined, TAB);
    runId = session().nativeTaskRunId!;
    expect(runId).toBeTruthy();
    vi.mocked(ipc.interruptSession).mockResolvedValueOnce(false);
    await state().sendQueuedNow(queue(), KEY);
    expect(session().streaming).toBe(true);
    if (identity === "absent") vi.mocked(ipc.interruptSession).mockResolvedValueOnce(false);
    const registeredId = identity === "remapped" ? `${runId}-registered` : runId;
    launch.resolve({ runId: registeredId, sessionId: null });
    await starting;
    expect(ipc.interruptSession).toHaveBeenNthCalledWith(2, registeredId);
    if (identity !== "absent") {
      expect(ipc.sendMessage).toHaveBeenCalledTimes(1);
      terminal("done", registeredId);
    }
    await Promise.resolve();
    expect(ipc.sendMessage).toHaveBeenCalledTimes(2);
    expect(ipc.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ prompt: "优先发送🙂" }));
    expect(session().queue.map(item => item.text)).toEqual(["先排队的消息"]);
  });

  it.each([false, true])("keeps the latest Stop intent %s when registration beats the first cancel reply", async stopAfterSend => {
    runRouting.clear();
    useChatStore.setState({ streamingByKey: {}, bySession: { [KEY]: { ...EMPTY_SESSION } } });
    const launch = Promise.withResolvers<{ runId: string; sessionId: null }>();
    vi.mocked(ipc.sendMessage).mockReturnValueOnce(launch.promise);
    const starting = state().send("启动中的请求", [], undefined, TAB);
    runId = session().nativeTaskRunId!;
    const pending = Promise.withResolvers<boolean>();
    vi.mocked(ipc.interruptSession).mockReturnValueOnce(pending.promise);
    const sending = state().sendQueuedNow(queue(), KEY);
    if (stopAfterSend) await state().interrupt(TAB);
    const registeredId = `${runId}-registered`;
    launch.resolve({ runId: registeredId, sessionId: null });
    await starting;
    pending.resolve(false);
    await sending;
    expect(ipc.interruptSession).toHaveBeenNthCalledWith(2, registeredId);
    terminal("done", registeredId);
    await Promise.resolve();
    expect(ipc.sendMessage).toHaveBeenCalledTimes(stopAfterSend ? 1 : 2);
    expect(session().queue).toHaveLength(stopAfterSend ? 2 : 1);
  });
});
