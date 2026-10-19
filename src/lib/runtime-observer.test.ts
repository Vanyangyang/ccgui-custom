import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  callback: undefined as ((event: { payload: { requestId: string } }) => void) | undefined,
  invoke: vi.fn(async (_command: string, _args?: unknown): Promise<void> => {}),
  pause: vi.fn(async () => ({ "worker-1": 7 } as Record<string, number>)),
  resume: vi.fn(async () => {}),
  off: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (_name: string, callback: typeof fake.callback) => { fake.callback = callback; return fake.off; }) }));
vi.mock("./transport", () => ({ pauseWorkerEvents: fake.pause, resumeWorkerEvents: fake.resume }));

function chat() {
  return { version: 1, state: {
    drafts: { session: "private unsent text" }, pendingMention: { path: "private draft", nonce: 1 }, actionError: "local error",
    bySession: { session: { messages: [{ role: "assistant", text: "完整中文🙂", live: true }], queue: [{ id: "queue", text: "must never send" }],
      draftLaunching: "launching", nativeTaskRunId: "run-1", nativeTaskSeq: 11, codexRunId: "desktop-steer-owner", liveLaunch: { model: "m" },
      usage: { tokens: 99 }, streaming: true, settledRunIds: ["old-run"],
    } },
  }, stream: { routes: [["run-1", "session"]], activity: [], pending: [] }, events: { settledRuns: [["old-run", "done"]] }, asks: [{ phase: "sent", text: "automatic answer" }] };
}
const tick = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.resetModules(); fake.callback = undefined; fake.invoke.mockReset().mockResolvedValue(undefined);
  fake.pause.mockReset().mockResolvedValue({ "worker-1": 7 }); fake.resume.mockReset().mockResolvedValue(undefined); fake.off.mockClear();
});
afterEach(() => { dispose?.(); dispose = undefined; vi.useRealTimers(); });

async function setup(capture = () => chat()) {
  const coordinator = await import("./runtime-checkpoint");
  coordinator.initializeRuntimeCheckpoint(undefined, { requiredParticipants: ["chat"] });
  coordinator.registerRuntimeCheckpointParticipant({ id: "chat", capture, restore: () => {} });
  const observer = await import("./runtime-observer");
  dispose = await observer.installRuntimeObserverResponder();
  return { coordinator, observer };
}

describe("read-only desktop observer snapshot", () => {
  it("copies native text/run state and cursors without queues, drafts, ask loops or private participants", async () => {
    const { observer } = await setup();
    const original = chat();
    const snapshot = observer.sanitizeObserverCheckpoint({ version: 1, participants: { chat: original, "app-ui": { private: true }, bridge: { token: "private" } } }, { "worker-1": 7 });
    expect(snapshot.observer).toBe(true);
    expect(Object.keys(snapshot.checkpoint.participants)).toEqual(["chat"]);
    const result = snapshot.checkpoint.participants.chat as ReturnType<typeof chat>;
    expect(result.state.drafts).toEqual({}); expect(result.state.pendingMention).toBeNull(); expect(result.state.actionError).toBeNull();
    expect(result.state.bySession.session.queue).toEqual([]); expect(result.asks).toEqual([]);
    expect(result.state.bySession.session).not.toHaveProperty("draftLaunching");
    expect(result.state.bySession.session).not.toHaveProperty("codexRunId");
    expect(result.state.bySession.session).not.toHaveProperty("liveLaunch");
    expect(result.state.bySession.session).toMatchObject({ nativeTaskRunId: "run-1", nativeTaskSeq: 11, usage: { tokens: 99 }, messages: [{ text: "完整中文🙂" }] });
    expect(result.stream.routes).toEqual([["run-1", "session"]]); expect(snapshot.cursors).toEqual({ "worker-1": 7 });
    expect(original.state.bySession.session.queue).toHaveLength(1); expect(original.asks).toHaveLength(1);
  });

  it("captures text and pause cursors in one synchronous cut and only calls the private response command", async () => {
    const cursors = { "worker-1": 7 };
    fake.pause.mockResolvedValue(cursors);
    const original = chat();
    const capture = vi.fn(() => {
      queueMicrotask(() => { cursors["worker-1"] = 8; original.state.bySession.session.messages[0].text = "later"; });
      return original;
    });
    await setup(capture);
    fake.callback?.({ payload: { requestId: "request-1" } }); await tick();
    expect(fake.invoke).toHaveBeenCalledTimes(1);
    expect(fake.invoke).toHaveBeenCalledWith("runtime_observer_respond", expect.objectContaining({ requestId: "request-1", error: null,
      snapshot: expect.objectContaining({ cursors: { "worker-1": 7 }, checkpoint: expect.objectContaining({ participants: expect.objectContaining({ chat: expect.objectContaining({ state: expect.objectContaining({ bySession: expect.objectContaining({ session: expect.objectContaining({ messages: [{ role: "assistant", text: "完整中文🙂", live: true }] }) }) }) }) }) }) }),
    }));
    expect(fake.resume).toHaveBeenCalledTimes(1);
  });

  it("returns an error without capture when partial event delivery prevents a trustworthy pause", async () => {
    const capture = vi.fn(() => chat()); await setup(capture);
    fake.pause.mockRejectedValueOnce(new Error("partial delivery contains private text"));
    fake.callback?.({ payload: { requestId: "request-failed" } }); await tick();
    expect(capture).not.toHaveBeenCalled(); expect(fake.resume).not.toHaveBeenCalled();
    expect(fake.invoke).toHaveBeenCalledWith("runtime_observer_respond", { requestId: "request-failed", snapshot: null, error: "Observer checkpoint is temporarily unavailable" });
  });

  it("does not block read-only observation on unrelated settings or app UI readiness", async () => {
    const { coordinator } = await setup();
    const off = coordinator.registerRuntimeCheckpointBlocker("settings", () => ["open-dialog", "unsaved-editor-drafts"]);
    fake.callback?.({ payload: { requestId: "read-only" } }); await tick();
    expect(fake.invoke).toHaveBeenCalledWith("runtime_observer_respond", expect.objectContaining({ requestId: "read-only", error: null, snapshot: expect.objectContaining({ observer: true }) }));
    expect(coordinator.isRuntimeSubmissionPaused()).toBe(false);
    off();
  });

  it("serializes overlapping requests through their response and resume", async () => {
    await setup();
    let respond!: () => void;
    fake.invoke.mockImplementationOnce(() => new Promise<void>((resolve) => { respond = resolve; }));
    fake.callback?.({ payload: { requestId: "first" } }); fake.callback?.({ payload: { requestId: "second" } }); await tick();
    expect(fake.pause).toHaveBeenCalledTimes(1); expect(fake.resume).not.toHaveBeenCalled();
    respond(); await tick();
    expect(fake.pause).toHaveBeenCalledTimes(2); expect(fake.resume).toHaveBeenCalledTimes(2);
    expect(fake.invoke.mock.calls.map(([, args]: [string, unknown?]) => (args as { requestId: string }).requestId)).toEqual(["first", "second"]);
  });

  it("releases its own pause after a response failure without sending a contradictory second response", async () => {
    await setup();
    fake.invoke.mockRejectedValueOnce(new Error("native response acknowledgement lost"));
    fake.callback?.({ payload: { requestId: "failed-response" } }); await tick();
    expect(fake.invoke).toHaveBeenCalledTimes(1); expect(fake.resume).toHaveBeenCalledTimes(1);
    fake.callback?.({ payload: { requestId: "next-request" } }); await tick();
    expect(fake.invoke).toHaveBeenCalledTimes(2); expect(fake.resume).toHaveBeenCalledTimes(2);
  });

  it("disposal discards a late snapshot but releases a pause owned only by this helper", async () => {
    await setup();
    let paused!: (cursors: Record<string, number>) => void;
    fake.pause.mockImplementationOnce(() => new Promise((resolve) => { paused = resolve; }));
    fake.callback?.({ payload: { requestId: "disposed" } }); await tick();
    dispose?.(); paused({ "worker-1": 7 }); await tick();
    expect(fake.invoke).not.toHaveBeenCalled(); expect(fake.resume).toHaveBeenCalledTimes(1);
  });

  it("never unpauses a planned handoff which takes ownership while the response is pending", async () => {
    const { coordinator } = await setup();
    let respond!: () => void;
    fake.invoke.mockImplementationOnce(() => new Promise<void>((resolve) => { respond = resolve; }));
    fake.callback?.({ payload: { requestId: "first" } }); await tick();
    await coordinator.prepareRuntimeCheckpoint();
    dispose?.(); respond(); await tick();
    expect(fake.resume).not.toHaveBeenCalled(); expect(coordinator.isRuntimeSubmissionPaused()).toBe(true);
  });

  it("ignores a late capture after disposal and refuses to borrow an existing handoff pause", async () => {
    const { coordinator } = await setup();
    let paused!: (cursors: Record<string, number>) => void;
    fake.pause.mockImplementationOnce(() => new Promise((resolve) => { paused = resolve; }));
    fake.callback?.({ payload: { requestId: "late" } }); await tick();
    dispose?.(); await coordinator.prepareRuntimeCheckpoint();
    paused({ "worker-1": 7 }); await tick();
    expect(fake.invoke).not.toHaveBeenCalled(); expect(fake.resume).not.toHaveBeenCalled();
    const { installRuntimeObserverResponder } = await import("./runtime-observer"); dispose = await installRuntimeObserverResponder();
    fake.callback?.({ payload: { requestId: "handoff" } }); await tick();
    expect(fake.pause).toHaveBeenCalledTimes(1);
    expect(fake.invoke).toHaveBeenCalledWith("runtime_observer_respond", expect.objectContaining({ requestId: "handoff", snapshot: null }));
  });

  it("waits only for chat history and recaptures the completed history with a new matching cursor", async () => {
    vi.useFakeTimers();
    const original = chat();
    const session = original.state.bySession.session as typeof original.state.bySession.session & { loading: boolean };
    session.loading = true;
    await setup(() => original);
    fake.pause.mockResolvedValueOnce({ "worker-1": 7 }).mockResolvedValue({ "worker-1": 9 });
    fake.callback?.({ payload: { requestId: "history" } }); await tick();
    expect(fake.invoke).not.toHaveBeenCalled(); expect(fake.resume).toHaveBeenCalledTimes(1);
    session.loading = false;
    session.messages[0].text = "complete history 中文🙂";
    await vi.advanceTimersByTimeAsync(100); await tick();
    const response = fake.invoke.mock.calls[0][1] as { snapshot: { cursors: unknown; checkpoint: { participants: { chat: ReturnType<typeof chat> } } } };
    expect(response.snapshot.cursors).toEqual({ "worker-1": 9 });
    expect(response.snapshot.checkpoint.participants.chat.state.bySession.session.messages[0].text).toBe("complete history 中文🙂");
    expect(fake.pause).toHaveBeenCalledTimes(2); expect(fake.resume).toHaveBeenCalledTimes(2);
  });

  it("returns busy within the native request budget without erasing a loading history", async () => {
    vi.useFakeTimers();
    const original = chat();
    Object.assign(original.state.bySession.session, { loading: true });
    await setup(() => original);
    fake.callback?.({ payload: { requestId: "busy-history" } }); await tick();
    await vi.advanceTimersByTimeAsync(10_000); await tick();
    expect(fake.invoke).toHaveBeenCalledTimes(1);
    expect(fake.invoke).toHaveBeenCalledWith("runtime_observer_respond", { requestId: "busy-history", snapshot: null, error: expect.stringMatching(/busy.*history/) });
    expect(original.state.bySession.session).toHaveProperty("loading", true);
    expect(fake.resume).toHaveBeenCalledTimes(fake.pause.mock.calls.length);
  });

  it("removes only a question's local submitting promise flag and preserves native approval facts", async () => {
    const { observer } = await setup();
    const original = chat();
    const question = { role: "question", text: "approve?", live: false, question: { runId: "run-1", requestId: "question-1", status: "pending", submitting: true } };
    const plan = { role: "plan", text: "native approval", live: false, planReview: { status: "submitting", revision: 2 } };
    original.state.bySession.session.messages.push(question, plan);
    const result = observer.sanitizeObserverCheckpoint({ version: 1, participants: { chat: original } }, { "worker-1": 7 });
    const copied = result.checkpoint.participants.chat as ReturnType<typeof chat>;
    expect(copied.state.bySession.session.messages[1]).toMatchObject({ text: "approve?", question: { runId: "run-1", requestId: "question-1", status: "pending" } });
    expect(copied.state.bySession.session.messages[1]).not.toHaveProperty("question.submitting");
    expect(copied.state.bySession.session.messages[2]).toHaveProperty("planReview.status", "submitting");
    expect(question.question.submitting).toBe(true);
  });
});
