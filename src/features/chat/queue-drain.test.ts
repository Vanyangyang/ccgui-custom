import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineEventPayload } from "@/lib/events";
import { ipc } from "@/lib/ipc";
import i18n from "@/lib/i18n";
import { sessionKey, useChatStore } from "./store";
import { EMPTY_SESSION, runRouting } from "./store/stream";

/** Captured by the mocked listener so a test can settle a turn the way the
 *  backend does: through the store's real wiring, queue drain included. */
let deliver: ((events: EngineEventPayload[]) => void) | null = null;

vi.mock("@/lib/ipc", () => ({
  ipc: {
    listWorkspaces: vi.fn(async () => []),
    listSessions: vi.fn(async () => []),
    listArchivedSessions: vi.fn(async () => []),
    listEngines: vi.fn(async () => []),
    sendMessage: vi.fn(async () => ({ runId: `queued-run-${++runCounter}`, sessionId: null })),
    interruptSession: vi.fn(async () => true),
    interruptTurn: vi.fn(async () => true),
    rememberSessionModel: vi.fn(async () => {}),
    loadSessionPage: vi.fn(async () => ({ messages: [], nextBefore: null })),
    getAppSettings: vi.fn(async () => ({})),
    updateAppSettings: vi.fn(async () => {}),
    rescanSessions: vi.fn(async () => {}),
    getCliConfig: vi.fn(async () => ({})),
  },
}));

vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(
    async (cb: (events: EngineEventPayload[]) => void) => {
      deliver = cb;
      return () => {};
    },
  ),
  listenSessionsChanged: vi.fn(async () => () => {}),
  listenComputerUseEscape: vi.fn(async () => () => {}),
}));

const WS = "/tmp/ws";
const KEY = sessionKey("claude", "s-1", WS);
const TAB = { engine: "claude", sessionId: "s-1", workspacePath: WS };
let runCounter = 0;
let runId: string;

/** Settle the turn and let the synchronous drain run: sendPrompt reaches
 *  `ipc.sendMessage` before its first await, so one microtask turn is enough. */
async function settle(kind: "done" | "error", interrupted = false) {
  useChatStore.setState((s) => ({
    bySession: {
      ...s.bySession,
      [KEY]: { ...s.bySession[KEY], interrupted },
    },
  }));
  deliver?.([
    {
      runId,
      sessionId: "s-1",
      engine: "claude",
      seq: 9,
      kind,
      data: kind === "done" ? { usage: null } : "400 upstream rejected the request",
    },
  ]);
  await Promise.resolve();
}

function queueOf(key = KEY) {
  return useChatStore.getState().bySession[key]?.queue ?? [];
}

describe("queued messages after a turn settles", () => {
  // The store wires `drainQueue` into the engine listener once, at init.
  beforeAll(async () => {
    await useChatStore.getState().init();
  });

  beforeEach(() => {
    runId = `queue-run-${++runCounter}`;
    vi.clearAllMocks();
    localStorage.clear();
    runRouting.clear();
    runRouting.set(runId, KEY);
    useChatStore.setState({
      active: TAB,
      activeEngine: "claude",
      openTabs: [TAB],
      models: { claude: "claude-sonnet-4" },
      streamingByKey: { [KEY]: true },
      bySession: {
        [KEY]: {
          ...EMPTY_SESSION,
          streaming: true,
          turnStartedAt: Date.now(),
          nativeTaskRunId: runId,
          nativeActivity: "running",
          messages: [
            { seq: 1, role: "user", text: "hi", ts: null },
            { seq: 2, role: "assistant", text: "已生成的回复🙂", ts: null, live: true },
          ],
          queue: [{ id: "q-1", text: "继续", images: [], queuedAt: 0 }],
        },
      },
    });
  });

  it("sends the oldest queued message when the turn ends", async () => {
    await settle("done");

    expect(deliver, "engine listener registered").not.toBeNull();
    expect(ipc.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "继续" }),
    );
    expect(queueOf()).toHaveLength(0);
  });

  /** The reported bug: a turn that dies with an engine error is still over, so
   *  the messages typed behind it must go out instead of parking forever. */
  it("sends the oldest queued message when the turn fails", async () => {
    await settle("error");

    expect(deliver, "engine listener registered").not.toBeNull();
    expect(ipc.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "继续" }),
    );
    expect(queueOf()).toHaveLength(0);
  });

  it("keeps the queue parked when the user stopped the turn", async () => {
    await settle("error", true);

    expect(ipc.sendMessage).not.toHaveBeenCalled();
    expect(queueOf()).toHaveLength(1);
  });

  it("moves the chosen row first, natively interrupts Claude and sends only after the real done", async () => {
    useChatStore.setState((s) => ({
      bySession: {
        ...s.bySession,
        [KEY]: {
          ...s.bySession[KEY],
          queue: [
            { id: "q-1", text: "继续", images: [], queuedAt: 0 },
            { id: "q-2", text: "再看一遍", images: [], queuedAt: 1 },
          ],
        },
      },
    }));

    vi.mocked(ipc.interruptTurn).mockImplementationOnce(async () => {
      expect(queueOf().map((item) => item.id)).toEqual(["q-2", "q-1"]);
      return true;
    });
    await useChatStore.getState().sendQueuedNow("q-2");

    expect(ipc.interruptTurn).toHaveBeenCalledTimes(1);
    expect(ipc.interruptTurn).toHaveBeenCalledWith(runId);
    expect(ipc.interruptSession).not.toHaveBeenCalled();
    expect(ipc.sendMessage).not.toHaveBeenCalled();
    expect(queueOf().map((item) => item.text)).toEqual(["再看一遍", "继续"]);
    expect(runRouting.get(runId)).toBe(KEY);
    expect(useChatStore.getState().bySession[KEY]).toMatchObject({
      streaming: true,
      interrupted: false,
      queueParked: false,
      messages: [
        { text: "hi" },
        { text: "已生成的回复🙂", live: true },
      ],
    });
    expect(useChatStore.getState().bySession[KEY].interruptRequestedAt).toEqual(expect.any(Number));

    await settle("done");

    expect(ipc.sendMessage).toHaveBeenCalledTimes(1);
    expect(ipc.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "再看一遍" }),
    );
    expect(queueOf().map((item) => item.text)).toEqual(["继续"]);
  });

  it("keeps the process-stop path when sending a queued OMP row now", async () => {
    const engine = "omp";
    const tab = { engine, sessionId: "s-1", workspacePath: WS };
    const key = sessionKey(engine, tab.sessionId, WS);
    const session = useChatStore.getState().bySession[KEY];
    runRouting.clear();
    runRouting.set(runId, key);
    useChatStore.setState({
      active: tab,
      activeEngine: engine,
      openTabs: [tab],
      streamingByKey: { [key]: true },
      bySession: { [key]: session },
    });

    await useChatStore.getState().sendQueuedNow("q-1");

    expect(ipc.interruptTurn).not.toHaveBeenCalled();
    expect(ipc.interruptSession).toHaveBeenCalledWith(tab.sessionId);
    expect(ipc.interruptSession).toHaveBeenCalledWith(runId);
    expect(ipc.sendMessage).toHaveBeenCalledTimes(1);
    expect(ipc.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ engine, prompt: "继续" }));
    expect(queueOf(key)).toEqual([]);
  });

  it("keeps a Codex queue intact when steering is unavailable instead of stopping its process", async () => {
    const tab = { engine: "codex", sessionId: "s-1", workspacePath: WS };
    const key = sessionKey(tab.engine, tab.sessionId, WS);
    // The fixture has no Codex native run identity: it cannot safely steer.
    const session = useChatStore.getState().bySession[KEY];
    runRouting.clear();
    runRouting.set(runId, key);
    useChatStore.setState({ active: tab, activeEngine: tab.engine, openTabs: [tab],
      streamingByKey: { [key]: true }, bySession: { [key]: session } });
    await useChatStore.getState().sendQueuedNow("q-1");
    expect(ipc.interruptTurn).not.toHaveBeenCalled();
    expect(ipc.interruptSession).not.toHaveBeenCalled();
    expect(ipc.sendMessage).not.toHaveBeenCalled();
    expect(queueOf(key)).toBe(session.queue);
    expect(runRouting.get(runId)).toBe(key);
    expect(useChatStore.getState().bySession[key]).toMatchObject({
      streaming: true, error: i18n.t("chat.steerUnavailable"), messages: session.messages,
    });
  });

  it("sends without stopping when no turn is running", async () => {
    useChatStore.setState((s) => ({
      bySession: { ...s.bySession, [KEY]: { ...s.bySession[KEY], streaming: false } },
    }));

    await useChatStore.getState().sendQueuedNow("q-1");

    expect(ipc.interruptSession).not.toHaveBeenCalled();
    expect(ipc.interruptTurn).not.toHaveBeenCalled();
    expect(ipc.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "继续" }),
    );
  });

  /** A send that never becomes a turn reports no engine event, so the queue
   *  has to keep moving on its own or the rest waits forever. */
  it("keeps draining when the send itself fails", async () => {
    vi.mocked(ipc.sendMessage).mockRejectedValueOnce(new Error("spawn failed"));
    useChatStore.setState((s) => ({
      bySession: {
        ...s.bySession,
        [KEY]: {
          ...s.bySession[KEY],
          queue: [
            { id: "q-1", text: "继续", images: [], queuedAt: 0 },
            { id: "q-2", text: "再看一遍", images: [], queuedAt: 1 },
          ],
        },
      },
    }));

    await settle("error");

    expect(ipc.sendMessage).toHaveBeenCalledTimes(2);
    expect(ipc.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ prompt: "再看一遍" }),
    );
    expect(queueOf()).toHaveLength(0);
  });
});

describe("queued message reorder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    useChatStore.setState({
      active: TAB,
      activeEngine: "claude",
      openTabs: [TAB],
      bySession: {
        [KEY]: {
          ...EMPTY_SESSION,
          streaming: true,
          queue: ["继续", "再看一遍", "再改一版"].map((text, index) => ({
            id: `q-${index + 1}`,
            text,
            images: [],
            queuedAt: index,
          })),
        },
      },
    });
  });

  /** Screen directions: the card paints newest-first, so "down" walks a row
   *  toward the head of the send order and "up" toward its tail. */
  it("moves a row one step toward the head when asked down", () => {
    useChatStore.getState().moveQueued("q-3", "down");

    expect(queueOf().map((item) => item.id)).toEqual(["q-1", "q-3", "q-2"]);
  });

  it("moves a row one step toward the tail when asked up", () => {
    useChatStore.getState().moveQueued("q-1", "up");

    expect(queueOf().map((item) => item.id)).toEqual(["q-2", "q-1", "q-3"]);
  });

  it("ignores moves past either end and unknown ids", () => {
    const { moveQueued } = useChatStore.getState();
    moveQueued("q-1", "down");
    moveQueued("q-3", "up");
    moveQueued("q-404", "up");

    expect(queueOf().map((item) => item.id)).toEqual(["q-1", "q-2", "q-3"]);
  });
});
