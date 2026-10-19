import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineEventPayload } from "@/lib/events";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    sendMessage: vi.fn(async () => ({ runId, sessionId: null })),
    interruptSession: vi.fn(async () => true),
    loadSessionPage: vi.fn(async () => ({ messages: [], nextBefore: null })),
    getAppSettings: vi.fn(async () => ({})),
    updateAppSettings: vi.fn(async () => {}),
    rescanSessions: vi.fn(async () => {}),
  },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
  listenComputerUseEscape: vi.fn(async () => () => {}),
}));

// Node 26 ships a built-in `localStorage` that stays undefined unless the
// process was started with --localstorage-file, and it shadows the jsdom one.
// The store reads localStorage at import time, so shim it when it is missing.
if (!globalThis.localStorage) {
  const memory = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => void memory.set(k, String(v)),
      removeItem: (k: string) => void memory.delete(k),
      clear: () => memory.clear(),
    },
  });
}

const { ipc } = await import("@/lib/ipc");
const { useChatStore } = await import("./store");
const { handleEngineEvents, captureEngineEventRuntime, restoreEngineEventRuntime } = await import("./store/engine-events");
const initialEventRuntime = captureEngineEventRuntime();
type EngineEventDeps = import("./store/engine-events").EngineEventDeps;
const { sessionKey } = await import("./store/persistence");
const { runRouting } = await import("./store/stream");

const WS = "/tmp/ws";
const PENDING = sessionKey("codex", null, WS);
const NATIVE = sessionKey("codex", "tid-1", WS);
let runCounter = 0;
let runId: string;

function deps(): EngineEventDeps {
  return {
    set: useChatStore.setState,
    get: useChatStore.getState,
    drainQueue: () => {},
    markUnseenIfBackground: () => {},
    upsertSessionMeta: () => {},
  };
}

// The backend stamps the thread id onto every payload once thread.started
// lands, the session event that announces it included.
function ev(
  kind: EngineEventPayload["kind"],
  seq: number,
  data: unknown,
  sessionId: string | null = "tid-1",
): EngineEventPayload {
  return { runId, sessionId, engine: "codex", seq, kind, data };
}

function resetStore() {
  runId = `codex-settle-${++runCounter}`;
  localStorage.clear();
  vi.clearAllMocks();
  runRouting.clear();
  restoreEngineEventRuntime(initialEventRuntime);
  useChatStore.setState({
    openTabs: [],
    active: null,
    activeEngine: "codex",
    models: {},
    efforts: {},
    bySession: {},
    streamingByKey: {},
    unseen: {},
    drafts: {},
  });
}

describe("codex turn settling", () => {
  beforeEach(resetStore);

  it("handles an error before invoke resolves and before a native session id exists", async () => {
    useChatStore.getState().startNewChat(WS);
    vi.mocked(ipc.sendMessage).mockImplementationOnce(async (args) => {
      expect(args.runId).toBeTruthy();
      handleEngineEvents([{ ...ev("error", 1, "early failure", null), runId: args.runId! }], deps());
      return { runId: args.runId!, sessionId: null };
    });
    await useChatStore.getState().send("hello", []);
    const state = useChatStore.getState();
    expect(state.bySession[PENDING]?.error).toBe("early failure");
    expect(state.bySession[PENDING]?.streaming).toBe(false);
    expect(state.streamingByKey).toEqual({});
    expect(runRouting.size).toBe(0);
  });

  it("preserves fast final text and completion even without a native session id", async () => {
    useChatStore.getState().startNewChat(WS);
    vi.mocked(ipc.sendMessage).mockImplementationOnce(async (args) => {
      handleEngineEvents([
        { ...ev("message", 1, { role: "assistant", text: "中文 🧪 complete" }, null), runId: args.runId! },
        { ...ev("done", 2, { usage: null }, null), runId: args.runId! },
      ], deps());
      return { runId: args.runId!, sessionId: null };
    });
    await useChatStore.getState().send("hello", []);
    const state = useChatStore.getState();
    expect(state.bySession[PENDING]?.messages.at(-1)?.text).toBe("中文 🧪 complete");
    expect(state.bySession[PENDING]?.streaming).toBe(false);
    expect(state.streamingByKey).toEqual({});
    expect(runRouting.size).toBe(0);
  });

  it("a session announcement arriving after Stop cannot revive the pending conversation", async () => {
    useChatStore.getState().startNewChat(WS);
    const response = Promise.withResolvers<{ runId: string; sessionId: null }>();
    vi.mocked(ipc.sendMessage).mockReturnValueOnce(response.promise);
    const sending = useChatStore.getState().send("hello", []);
    const runId = vi.mocked(ipc.sendMessage).mock.calls.at(-1)![0].runId!;
    await useChatStore.getState().interrupt();
    handleEngineEvents([{ ...ev("session", 1, "tid-1"), runId }], deps());
    response.resolve({ runId, sessionId: null });
    await sending;
    expect(useChatStore.getState().bySession[PENDING]?.streaming).toBe(false);
    expect(useChatStore.getState().streamingByKey).toEqual({});
    expect(runRouting.size).toBe(0);
  });

  it("adopts a preassigned session after Stop and retries interruption without restarting it", async () => {
    useChatStore.getState().startNewChat(WS);
    const response = Promise.withResolvers<{ runId: string; sessionId: string }>();
    vi.mocked(ipc.sendMessage).mockReturnValueOnce(response.promise);
    const sending = useChatStore.getState().send("hello", []);
    const runId = vi.mocked(ipc.sendMessage).mock.calls.at(-1)![0].runId!;
    await useChatStore.getState().interrupt();
    response.resolve({ runId, sessionId: "tid-1" });
    await sending;
    expect(useChatStore.getState().active?.sessionId).toBe("tid-1");
    expect(useChatStore.getState().bySession[NATIVE]?.streaming).toBe(false);
    expect(useChatStore.getState().streamingByKey).toEqual({});
    expect(ipc.interruptSession).toHaveBeenCalledWith("tid-1");
    expect(runRouting.size).toBe(0);
  });

  it("clears streaming once done lands after the run is routed", async () => {
    useChatStore.getState().startNewChat(WS);
    await useChatStore.getState().send("hello", []);

    handleEngineEvents(
      [
        ev("session", 1, "tid-1"),
        ev("message", 2, { role: "assistant", text: "hi there" }),
        ev("done", 3, { usage: null }),
      ],
      deps(),
    );

    const s = useChatStore.getState();
    expect(s.bySession[NATIVE]?.streaming).toBe(false);
    expect(s.streamingByKey[NATIVE]).toBeUndefined();
    expect(s.streamingByKey[PENDING]).toBeUndefined();
  });

  it("keeps the pending turn visible when events beat the send response", async () => {
    useChatStore.getState().startNewChat(WS);
    let resolveSend: (value: { runId: string; sessionId: null }) => void = () => {};
    vi.mocked(ipc.sendMessage).mockImplementation(
      () => new Promise((resolve) => { resolveSend = resolve; }),
    );

    const inflight = useChatStore.getState().send("hello", []);

    // The engine can start streaming before the invoke promise resolves.
    handleEngineEvents(
      [
        ev("session", 1, "tid-1"),
        ev("message", 2, { role: "assistant", text: "hi there" }),
      ],
      deps(),
    );

    resolveSend({ runId, sessionId: null });
    await inflight;
    handleEngineEvents([ev("done", 3, { usage: null })], deps());

    const s = useChatStore.getState();
    expect(s.bySession[PENDING]).toBeUndefined();
    expect(s.bySession[NATIVE]?.streaming).toBe(false);
    expect(s.streamingByKey[PENDING]).toBeUndefined();
    expect((s.bySession[NATIVE]?.messages ?? []).some((m) => m.role === "user")).toBe(
      true,
    );
  });

  it("does not route a finished turn back to its pending key after send resolves", async () => {
    useChatStore.getState().startNewChat(WS);
    const response = Promise.withResolvers<{ runId: string; sessionId: null }>();
    vi.mocked(ipc.sendMessage).mockReturnValueOnce(response.promise);
    const sending = useChatStore.getState().send("hello", []);
    handleEngineEvents([
      ev("session", 1, "tid-1"),
      ev("message", 2, { role: "assistant", text: "complete" }),
      ev("done", 3, { usage: null }),
    ], deps());
    response.resolve({ runId, sessionId: null });
    await sending;
    expect(runRouting.has(runId)).toBe(false);
    handleEngineEvents([ev("warn", 4, "shutdown notice")], deps());
    expect(useChatStore.getState().bySession[PENDING]).toBeUndefined();
    expect(useChatStore.getState().streamingByKey).toEqual({});
  });

  it("settles a correlated run whose session and completion beat its send response", async () => {
    useChatStore.getState().startNewChat(WS);
    const response = Promise.withResolvers<{ runId: string; sessionId: null }>();
    vi.mocked(ipc.sendMessage).mockReturnValueOnce(response.promise);
    const sending = useChatStore.getState().send("hello", []);
    const requested = vi.mocked(ipc.sendMessage).mock.calls.at(-1)![0].runId!;
    handleEngineEvents([
      ev("session", 1, "tid-1"),
      ev("message", 2, { role: "assistant", text: "中文 🧪 completed" }),
      ev("done", 3, { usage: null }),
    ].map((event) => ({ ...event, runId: requested })), deps());
    response.resolve({ runId: requested, sessionId: null });
    await sending;
    const state = useChatStore.getState();
    expect(state.bySession[PENDING]).toBeUndefined();
    expect(state.bySession[NATIVE].messages.map((message) => message.text)).toEqual(["hello", "中文 🧪 completed"]);
    expect(state.bySession[NATIVE].streaming).toBe(false);
    expect(state.streamingByKey).toEqual({});
    expect(runRouting.size).toBe(0);
  });

  it("migrates only its recorded native placeholder when the session announcement arrives after the ACK", async () => {
    useChatStore.getState().startNewChat(WS);
    const response = Promise.withResolvers<{ runId: string; sessionId: null }>();
    vi.mocked(ipc.sendMessage).mockReturnValueOnce(response.promise);
    const sending = useChatStore.getState().send("hello", []);
    useChatStore.setState({ drafts: { [PENDING]: "next draft" } });
    handleEngineEvents([ev("message", 1, { role: "assistant", text: "early reply" })], deps());
    const snapshot = captureEngineEventRuntime();
    expect(snapshot.pendingSessionOrigins).toHaveLength(1);
    restoreEngineEventRuntime(snapshot);
    response.resolve({ runId, sessionId: null });
    await sending;
    handleEngineEvents([ev("session", 2, "tid-1")], deps());
    const adopted = useChatStore.getState();
    expect(adopted.bySession[PENDING]).toBeUndefined();
    expect(adopted.bySession[NATIVE].messages.map((message) => message.text)).toEqual(["hello", "early reply"]);
    expect(adopted.bySession[NATIVE].codexRunId).toBe(runId);
    expect(adopted.bySession[NATIVE].throughput?.runId).toBe(runId);
    expect(adopted.drafts[PENDING]).toBeUndefined();
    expect(adopted.drafts[NATIVE]).toBe("next draft");
    expect(captureEngineEventRuntime().pendingSessionOrigins).toEqual([]);
    handleEngineEvents([ev("done", 3, { usage: null })], deps());
    expect(useChatStore.getState().streamingByKey).toEqual({});
  });

  it("does not merge an existing native conversation into a pending launch", async () => {
    useChatStore.getState().startNewChat(WS);
    const response = Promise.withResolvers<{ runId: string; sessionId: null }>();
    vi.mocked(ipc.sendMessage).mockReturnValueOnce(response.promise);
    const sending = useChatStore.getState().send("pending hello", []);
    const requested = vi.mocked(ipc.sendMessage).mock.calls.at(-1)![0].runId!;
    const pending = useChatStore.getState().bySession[PENDING];
    useChatStore.setState((state) => ({
      bySession: { ...state.bySession, [NATIVE]: { ...pending, messages: [{ seq: 1, role: "user", text: "existing history", ts: null }], codexRunId: undefined, streaming: false } },
      drafts: { [NATIVE]: "native draft", [PENDING]: "pending draft" },
    }));
    handleEngineEvents([ev("session", 1, "tid-1"), ev("message", 2, { role: "assistant", text: "native reply" })], deps());
    const state = useChatStore.getState();
    expect(state.bySession[PENDING]).toBe(pending);
    expect(state.bySession[NATIVE].messages.map((message) => message.text)).toEqual(["existing history", "native reply"]);
    expect(state.drafts).toEqual({ [NATIVE]: "native draft", [PENDING]: "pending draft" });
    expect(state.active?.sessionId).toBeNull();
    expect(captureEngineEventRuntime().pendingSessionOrigins).toEqual([]);
    response.resolve({ runId: requested, sessionId: null });
    await sending;
    handleEngineEvents([ev("done", 3, { usage: null }), { ...ev("done", 1, { usage: null }, null), runId: requested }], deps());
  });

  it("does not guess ownership when two pending launches exist", async () => {
    const otherWorkspace = "/tmp/ws-other";
    const otherPending = sessionKey("codex", null, otherWorkspace);
    const first = Promise.withResolvers<{ runId: string; sessionId: null }>();
    const second = Promise.withResolvers<{ runId: string; sessionId: null }>();
    vi.mocked(ipc.sendMessage).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    useChatStore.getState().startNewChat(WS);
    const sendingFirst = useChatStore.getState().send("first pending", []);
    const firstRun = vi.mocked(ipc.sendMessage).mock.calls.at(-1)![0].runId!;
    useChatStore.getState().startNewChat(otherWorkspace);
    const sendingSecond = useChatStore.getState().send("second pending", []);
    const secondRun = vi.mocked(ipc.sendMessage).mock.calls.at(-1)![0].runId!;
    const before = useChatStore.getState();
    handleEngineEvents([ev("message", 1, { role: "assistant", text: "unrelated observed reply" }), ev("session", 2, "tid-1")], deps());
    const after = useChatStore.getState();
    expect(after.bySession[PENDING]).toBe(before.bySession[PENDING]);
    expect(after.bySession[otherPending]).toBe(before.bySession[otherPending]);
    expect(after.openTabs).toEqual(before.openTabs);
    expect(after.active).toEqual(before.active);
    expect(captureEngineEventRuntime().pendingSessionOrigins).toEqual([]);
    first.resolve({ runId: firstRun, sessionId: null });
    second.resolve({ runId: secondRun, sessionId: null });
    await Promise.all([sendingFirst, sendingSecond]);
    handleEngineEvents([ev("done", 3, { usage: null }), { ...ev("done", 1, { usage: null }, null), runId: firstRun }, { ...ev("done", 1, { usage: null }, null), runId: secondRun }], deps());
  });
});
