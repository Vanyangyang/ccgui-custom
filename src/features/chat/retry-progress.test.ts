import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import { useChatStore } from "./store";
import {
  handleEngineEvents,
  settleOrphanedRuns,
  type EngineEventDeps,
} from "./store/engine-events";
import { sessionKey } from "./store/persistence";
import { EMPTY_SESSION, runRouting } from "./store/stream";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    rescanSessions: vi.fn(async () => {}),
    usageRecord: vi.fn(async () => {}),
  },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
  listenComputerUseEscape: vi.fn(async () => () => {}),
}));

const KEY = sessionKey("claude", "s-1", "/tmp/ws");
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

function ev(
  kind: "retry" | "delta" | "done" | "error" | "warn",
  seq: number,
  data: unknown,
  eventRunId = runId,
) {
  return { runId: eventRunId, sessionId: "s-1", engine: "claude", seq, kind, data };
}

const retry = (seq: number, attempt: number, max = 10, eventRunId = runId) =>
  ev(
    "retry",
    seq,
    { attempt, max, message: `API error (HTTP 529); retrying (${attempt}/${max})` },
    eventRunId,
  );

describe("provider retry progress", () => {
  beforeEach(() => {
    runId = `retry-progress-${++runCounter}`;
    localStorage.clear();
    vi.clearAllMocks();
    runRouting.clear();
    useChatStore.setState({
      openTabs: [],
      active: null,
      unseen: {},
      retryingByKey: {},
      bySession: {
        [KEY]: {
          ...EMPTY_SESSION,
          streaming: true,
          messages: [{ seq: 1, role: "user", text: "go", ts: null }],
        },
      },
      streamingByKey: { [KEY]: true },
    });
  });

  it("shows as progress on the running turn, not as an error", () => {
    handleEngineEvents([retry(2, 3)], deps());

    const s = useChatStore.getState().bySession[KEY]!;
    expect(s.retry).toEqual({
      attempt: 3,
      max: 10,
      message: "API error (HTTP 529); retrying (3/10)",
    });
    expect(s.error).toBeNull();
    expect(s.streaming).toBe(true);
    expect(useChatStore.getState().retryingByKey[KEY]).toBe(true);
  });

  it("tracks the latest attempt", () => {
    handleEngineEvents([retry(2, 1), retry(3, 2)], deps());

    expect(useChatStore.getState().bySession[KEY]!.retry?.attempt).toBe(2);
  });

  it("clears once the re-issued request streams content", () => {
    handleEngineEvents([retry(2, 4)], deps());
    handleEngineEvents([ev("delta", 3, "back on")], deps());

    expect(useChatStore.getState().bySession[KEY]!.retry).toBeNull();
    expect(useChatStore.getState().retryingByKey[KEY]).toBeUndefined();
  });

  it("clears on an explicit end (attempt 0) with nothing streamed yet", () => {
    handleEngineEvents([retry(2, 4)], deps());
    handleEngineEvents([ev("retry", 3, { attempt: 0, max: 0, message: "" })], deps());

    expect(useChatStore.getState().bySession[KEY]!.retry).toBeNull();
    expect(useChatStore.getState().retryingByKey[KEY]).toBeUndefined();
  });
  it("does not outlive the turn", () => {
    handleEngineEvents([retry(2, 9)], deps());
    handleEngineEvents([ev("done", 3, { usage: null })], deps());
    expect(useChatStore.getState().bySession[KEY]!.retry).toBeNull();
    expect(useChatStore.getState().retryingByKey[KEY]).toBeUndefined();

    useChatStore.setState((s) => ({
      bySession: { ...s.bySession, [KEY]: { ...s.bySession[KEY]!, streaming: true } },
    }));
    const nextRunId = `${runId}-next`;
    handleEngineEvents([retry(4, 10, 10, nextRunId)], deps());
    handleEngineEvents([ev("error", 5, "gave up after 10 attempts", nextRunId)], deps());
    const s = useChatStore.getState().bySession[KEY]!;
    expect(s.retry).toBeNull();
    expect(s.error).toBe("gave up after 10 attempts");
    expect(useChatStore.getState().retryingByKey[KEY]).toBeUndefined();
  });

  it("keeps an errored run settled after retry and warn in the same batch", () => {
    const terminalError = "provider failed after 50 attempts";
    handleEngineEvents(
      [
        retry(2, 1, 50),
        ev("error", 3, terminalError),
        retry(4, 2, 50),
        ev("warn", 5, "socket hang up; retrying"),
      ],
      deps(),
    );

    const state = useChatStore.getState();
    expect(state.bySession[KEY]).toMatchObject({
      streaming: false,
      retry: null,
      error: terminalError,
      turnStartedAt: null,
    });
    expect(state.streamingByKey[KEY]).toBeUndefined();
    expect(state.retryingByKey[KEY]).toBeUndefined();
  });

  it.each(["claude", "codex"])("rescans %s history after retries are exhausted", (engine) => {
    const key = sessionKey(engine, "s-1", "/tmp/ws");
    const terminalError = "provider failed after 10 attempts";
    useChatStore.setState({
      bySession: {
        [key]: { ...EMPTY_SESSION, streaming: true },
      },
      streamingByKey: { [key]: true },
    });

    handleEngineEvents([{ ...retry(1, 10), engine }], deps());
    expect(ipc.rescanSessions).not.toHaveBeenCalled();
    handleEngineEvents([{ ...ev("error", 2, terminalError), engine }], deps());

    expect(ipc.rescanSessions).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().bySession[key]).toMatchObject({
      streaming: false,
      retry: null,
      error: terminalError,
    });
  });

  it.each(["done", "error"] as const)(
    "keeps a %s run settled after retry and warn in later batches",
    (kind) => {
      const terminalError = kind === "error" ? "provider failed after 50 attempts" : null;
      handleEngineEvents(
        [retry(2, 1, 50), ev(kind, 3, terminalError ?? { usage: null })],
        deps(),
      );

      handleEngineEvents([retry(4, 2, 50)], deps());
      const afterRetry = useChatStore.getState();
      expect(afterRetry.bySession[KEY]).toMatchObject({
        streaming: false,
        retry: null,
        error: terminalError,
        turnStartedAt: null,
      });
      expect(afterRetry.streamingByKey[KEY]).toBeUndefined();

      handleEngineEvents([ev("warn", 5, "engine stderr: socket hang up")], deps());
      const afterWarn = useChatStore.getState();
      expect(afterWarn.bySession[KEY]).toMatchObject({
        streaming: false,
        retry: null,
        error: terminalError ?? "engine stderr: socket hang up",
        turnStartedAt: null,
      });
      expect(afterWarn.streamingByKey[KEY]).toBeUndefined();
    },
  );

  it("retains a terminal failure reported after done without restarting the run", () => {
    handleEngineEvents([
      ev("done", 1, { usage: null }),
      ev("error", 2, "final transport failure"),
      retry(3, 1),
    ], deps());
    expect(useChatStore.getState().bySession[KEY]).toMatchObject({
      error: "final transport failure", streaming: false, retry: null,
    });
  });

  it("adopts a fresh observed run on the same session from its first retry event", () => {
    handleEngineEvents([retry(2, 1), ev("done", 3, { usage: null })], deps());
    expect(useChatStore.getState().bySession[KEY]!.streaming).toBe(false);
    expect(useChatStore.getState().streamingByKey[KEY]).toBeUndefined();

    handleEngineEvents([retry(1, 1, 50, `${runId}-next`)], deps());

    const state = useChatStore.getState();
    expect(state.bySession[KEY]).toMatchObject({
      streaming: true,
      retry: {
        attempt: 1,
        max: 50,
        message: "API error (HTTP 529); retrying (1/50)",
      },
      turnStartedAt: expect.any(Number),
    });
    expect(state.streamingByKey[KEY]).toBe(true);
  });

  it("clears retry progress alongside streaming when an orphaned run is settled", () => {
    handleEngineEvents([retry(2, 1, 50)], deps());
    expect(useChatStore.getState().bySession[KEY]).toMatchObject({
      streaming: true,
      retry: { attempt: 1, max: 50 },
    });

    settleOrphanedRuns(useChatStore.setState, [[runId, KEY]]);

    const state = useChatStore.getState();
    expect(state.bySession[KEY]).toMatchObject({
      streaming: false,
      retry: null,
      turnStartedAt: null,
    });
    expect(state.streamingByKey[KEY]).toBeUndefined();
  });
});
