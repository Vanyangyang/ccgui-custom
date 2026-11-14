import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import { useChatStore } from "./store";
import { handleEngineEvents, type EngineEventDeps } from "./store/engine-events";
import { sessionKey } from "./store/persistence";
import { EMPTY_SESSION, runRouting } from "./store/stream";
import { parseUsage } from "./usage";
import { selectAgyContext } from "./components/agy-context";
import { beginNativeRun } from "./store/native-tasks";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    usageRecord: vi.fn(async () => {}),
    rescanSessions: vi.fn(async () => {}),
    loadSessionPage: vi.fn(async () => ({ messages: [], nextBefore: null, subagentHistory: [] })),
  },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
  listenComputerUseEscape: vi.fn(async () => () => {}),
}));

const KEY = sessionKey("codex", "s-1", "/tmp/ws");
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

function event(kind: "usage" | "done", seq: number, data: unknown) {
  return { runId, sessionId: "s-1", engine: "codex", seq, kind, data };
}

function report(inputTokens: number, outputTokens: number) {
  return { last_token_usage: { input_tokens: inputTokens, output_tokens: outputTokens } };
}

function session() {
  return useChatStore.getState().bySession[KEY]!;
}

describe("usage accounting", () => {
  beforeEach(() => {
    runId = `usage-run-${++runCounter}`;
    localStorage.clear();
    vi.clearAllMocks();
    runRouting.clear();
    runRouting.set(runId, KEY);
    useChatStore.setState({
      openTabs: [],
      active: null,
      bySession: {
        [KEY]: {
          ...EMPTY_SESSION,
          streaming: true,
          messages: [{ seq: 2, role: "assistant", text: "…", live: true, ts: null }],
        },
      },
      streamingByKey: {},
    });
  });

  it("ledgers a mid-turn report as it arrives, and not again when the turn ends", () => {
    // Codex reports each request while the turn runs; the page has to grow
    // with it instead of waiting for the turn to finish.
    handleEngineEvents([event("usage", 2, report(1000, 40))], deps());
    expect(ipc.usageRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        engine: "codex",
        input: 1000,
        output: 40,
        reports: 1,
      }),
    );

    // The turn then settles: its own payload must not add a second row for
    // the same tokens.
    handleEngineEvents([event("done", 9, { usage: null })], deps());
    expect(ipc.usageRecord).toHaveBeenCalledTimes(1);
  });

  it("updates AGY official occupancy without billing it or contaminating another session", async () => {
    const agyKey = sessionKey("agy", "s-1", "/tmp/ws");
    const other = { ...EMPTY_SESSION, usage: { input_tokens: 77 } };
    const agyTab = { engine: "agy", sessionId: "s-1", workspacePath: "/tmp/ws" };
    runRouting.set(runId, agyKey);
    useChatStore.setState({
      openTabs: [agyTab], active: { engine: "codex", sessionId: "s-1", workspacePath: "/tmp/ws" },
      bySession: { [KEY]: other, [agyKey]: { ...EMPTY_SESSION, streaming: true,
        usage: { input_tokens: 30, output_tokens: 7 },
        messages: [{ seq: 2, role: "assistant", text: "answer", live: true, ts: null }] } },
    });
    const emit = (kind: "usage" | "done", seq: number, data: unknown) =>
      handleEngineEvents([{ ...event(kind, seq, data), engine: "agy" }], deps());
    for (const [index, used] of [100_000, 20_000, 0].entries()) {
      emit("usage", index + 2, {
        context_usage_kind: "current_context", context_usage_source: "acp_usage_update",
        context_usage: { input_tokens: used, output_tokens: 0 }, model_context_window: 1_000_000,
      });
      const current = useChatStore.getState().bySession[agyKey];
      expect(selectAgyContext(current.usage)).toMatchObject({ total: used, occupancyKnown: true });
      expect(parseUsage(current.usage)).toMatchObject({ input: 30, output: 7 });
      expect(current.turnUsage).toBeFalsy();
      expect(ipc.usageRecord).not.toHaveBeenCalled();
    }
    emit("done", 9, { usage: { input_tokens: 100, output_tokens: 20, model_context_window: 200_000 } });
    expect(ipc.usageRecord).toHaveBeenCalledTimes(1);
    expect(ipc.usageRecord).toHaveBeenCalledWith(expect.objectContaining({ input: 100, output: 20 }));
    vi.mocked(ipc.loadSessionPage).mockResolvedValueOnce({ messages: [{ seq: 1, role: "assistant", text: "old", ts: null,
      usage: { input_tokens: 80, context_usage_kind: "current_context", context_usage: { input_tokens: 90_000 }, model_context_window: 200_000 } }],
      nextBefore: null, subagentHistory: [] });
    await useChatStore.getState().refreshSessionUsage(agyKey);
    expect(selectAgyContext(useChatStore.getState().bySession[agyKey].usage)).toMatchObject({ total: 0, max: 1_000_000, pct: 0 });
    expect(useChatStore.getState().bySession[KEY]).toBe(other);
    const settled = useChatStore.getState().bySession[agyKey];
    useChatStore.setState((state) => ({ bySession: { ...state.bySession,
      [agyKey]: { ...settled, ...beginNativeRun(settled, `${runId}-legacy`) },
    } }));
    vi.mocked(ipc.loadSessionPage).mockResolvedValueOnce({ messages: [{ seq: 1, role: "assistant", text: "new legacy turn", ts: null,
      usage: { context_usage_kind: "last_prompt", context_usage: { input_tokens: 60_000, output_tokens: 0 } } }],
      nextBefore: null, subagentHistory: [] });
    await useChatStore.getState().refreshSessionUsage(agyKey);
    expect(useChatStore.getState().bySession[agyKey].usage).toMatchObject({
      context_usage_kind: "last_prompt", context_usage: { input_tokens: 60_000 },
    });
    expect(useChatStore.getState().bySession[agyKey].usage).not.toHaveProperty("context_usage_source");
  });

  it("ledgers a turn that reports once, at the end, exactly once", () => {
    // Claude reports nothing until its result line: that payload is the row.
    handleEngineEvents(
      [event("done", 9, { usage: { input_tokens: 7, output_tokens: 3 } })],
      deps(),
    );
    expect(ipc.usageRecord).toHaveBeenCalledWith(
      expect.objectContaining({ input: 7, output: 3, reports: 1 }),
    );
    expect(ipc.usageRecord).toHaveBeenCalledTimes(1);
  });

  it("sums the reply's reports for the strip and keeps occupancy separate", () => {
    handleEngineEvents([event("usage", 2, report(1000, 40))], deps());
    handleEngineEvents([event("usage", 3, report(500, 10))], deps());
    // The strip counts what this reply spent...
    expect(parseUsage(session().turnUsage)).toMatchObject({ input: 1500, output: 50 });
    // ...while the context meter still reads the newest single report.
    expect(parseUsage(session().usage)).toMatchObject({ input: 500, output: 10 });

    handleEngineEvents([event("done", 9, { usage: report(1500, 50) })], deps());
    // The aggregate in done must not replace the newest context occupancy.
    // The settled row carries the reply's total, and the running counter is
    // gone so the next reply starts from zero.
    const settled = session();
    expect(parseUsage(settled.turnUsage)).toBeNull();
    const assistant = settled.messages.filter((m) => m.role === "assistant").at(-1);
    expect(parseUsage(assistant?.usage)).toMatchObject({ input: 1500, output: 50 });
    expect(parseUsage(settled.usage)).toMatchObject({ input: 500, output: 10 });
  });
});
