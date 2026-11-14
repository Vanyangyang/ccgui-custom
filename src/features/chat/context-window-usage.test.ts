import { beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import { useChatStore } from "./store";
import { handleEngineEvents, type EngineEventDeps } from "./store/engine-events";
import { EMPTY_SESSION, runRouting } from "./store/stream";
import { ASSUMED_CONTEXT_WINDOW, parseUsage } from "./usage";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    loadSessionPage: vi.fn(async () => ({ messages: [], nextBefore: null, subagentHistory: [] })),
    rescanSessions: vi.fn(async () => {}),
    usageRecord: vi.fn(async () => {}),
  },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
  listenComputerUseEscape: vi.fn(async () => () => {}),
}));

const WS = "/tmp/ws";
const KEY = "claude/sess-1";
/** A turn that reported the model's real window. */
const WITH_WINDOW = { input_tokens: 1000, output_tokens: 10, model_context_window: 1_000_000 };
/** The same shape without it — what a transcript snapshot and a
 *  compact_boundary usage report both look like. */
const WITHOUT_WINDOW = { input_tokens: 8038, output_tokens: 10, total_tokens: 8048 };

/** The gauge's denominator, exactly as ChatConversation computes it. */
function contextMax(key = KEY): number {
  return (
    parseUsage(useChatStore.getState().bySession[key]?.usage)?.contextWindow ??
    ASSUMED_CONTEXT_WINDOW
  );
}

function deps(): EngineEventDeps {
  return {
    set: useChatStore.setState,
    get: useChatStore.getState,
    drainQueue: () => {},
    markUnseenIfBackground: () => {},
    upsertSessionMeta: () => {},
  };
}

function ev(runId: string, kind: "usage" | "done", seq: number, data: unknown) {
  return { runId, sessionId: "sess-1", engine: "claude", seq, kind, data };
}

describe("the context gauge holds its scale when a usage snapshot omits the window", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    runRouting.clear();
    const tab = { engine: "claude", sessionId: "sess-1", workspacePath: WS };
    useChatStore.setState({
      openTabs: [tab],
      active: tab,
      activeEngine: "claude",
      unseen: {},
      streamingByKey: {},
      bySession: { [KEY]: { ...EMPTY_SESSION, usage: { ...WITH_WINDOW } } },
    });
  });

  it("keeps the window when a compaction usage report carries none", () => {
    expect(contextMax()).toBe(1_000_000);

    // Auto-compaction reports the post-compaction occupancy only.
    handleEngineEvents([ev("run-a", "usage", 1, { ...WITHOUT_WINDOW })], deps());

    expect(contextMax()).toBe(1_000_000);
  });

  it("keeps the window when the usage snapshot is re-read from session history", async () => {
    expect(contextMax()).toBe(1_000_000);

    // The transcript carries the API's per-message usage, which has no
    // window on it — only the live result line does.
    vi.mocked(ipc.loadSessionPage).mockResolvedValueOnce({
      messages: [
        { seq: 1, role: "assistant", text: "hi", ts: "2026-09-16T00:00:00Z", usage: { ...WITHOUT_WINDOW } },
      ],
      nextBefore: null,
      subagentHistory: [],
    } as never);

    await useChatStore.getState().refreshSessionUsage(KEY);

    expect(contextMax()).toBe(1_000_000);
  });

  it("updates Claude occupancy during a turn without counting repeated snapshots as bills", () => {
    const run = "claude-live-context";
    useChatStore.setState({ bySession: { [KEY]: { ...EMPTY_SESSION, usage: { model_context_window: 1_000_000 } } } });
    expect(parseUsage(useChatStore.getState().bySession[KEY].usage)).toBeNull();
    const first = { usage_scope: "last_request", input_tokens: 100, cache_read_input_tokens: 50_000, output_tokens: 1 };
    handleEngineEvents([ev(run, "usage", 1, first)], deps());
    expect(parseUsage(useChatStore.getState().bySession[KEY].usage)?.total).toBe(50_101);
    handleEngineEvents([ev(run, "usage", 2, { ...first, output_tokens: 300 })], deps());
    const session = useChatStore.getState().bySession[KEY];
    expect(parseUsage(session.usage)?.total).toBe(50_400);
    expect(contextMax()).toBe(1_000_000);
    expect(session.turnUsage).toBeNull();
    expect(ipc.usageRecord).not.toHaveBeenCalled();
  });

  it("keeps the live occupancy when the result carries a much larger turn bill", () => {
    const run = "claude-live-context-done";
    const snapshot = { usage_scope: "last_request", input_tokens: 100, cache_read_input_tokens: 50_000, output_tokens: 300 };
    const billed = { input_tokens: 700, cache_read_input_tokens: 400_000, output_tokens: 2_000, model_context_window: 1_000_000 };
    useChatStore.setState({ bySession: { [KEY]: { ...EMPTY_SESSION, messages: [
      { seq: 1, role: "user", text: "hi", ts: "2026-10-29T00:00:00Z" },
      { seq: 2, role: "assistant", text: "hello", ts: "2026-10-29T00:00:01Z" },
    ] } } });
    handleEngineEvents([ev(run, "usage", 1, snapshot), ev(run, "done", 2, { usage: billed })], deps());
    const session = useChatStore.getState().bySession[KEY];
    expect(parseUsage(session.usage)?.total).toBe(50_400);
    expect(contextMax()).toBe(1_000_000);
    expect(session.messages.at(-1)?.usage).toMatchObject({ ...billed, usage_scope: "turn" });
    expect(ipc.usageRecord).toHaveBeenCalledTimes(1);
    expect(ipc.usageRecord).toHaveBeenCalledWith(expect.objectContaining({ input: 700, cacheRead: 400_000, output: 2_000 }));
  });

  it("retains measured context after interruption without inventing a turn bill", () => {
    const run = "claude-live-context-interrupted";
    handleEngineEvents([
      ev(run, "usage", 1, { usage_scope: "last_request", input_tokens: 30_000, output_tokens: 100 }),
      ev(run, "done", 2, { interrupted: true, usage: { input_tokens: 0, output_tokens: 0 } }),
    ], deps());
    expect(parseUsage(useChatStore.getState().bySession[KEY].usage)?.total).toBe(30_100);
    expect(ipc.usageRecord).not.toHaveBeenCalled();
  });

  it("does not let an in-flight history refresh overwrite a newer live snapshot", async () => {
    let resolve!: (page: unknown) => void;
    vi.mocked(ipc.loadSessionPage).mockImplementationOnce(() => new Promise(r => { resolve = r; }) as never);
    const refresh = useChatStore.getState().refreshSessionUsage(KEY);
    handleEngineEvents([ev("claude-live-context-race", "usage", 1, {
      usage_scope: "last_request", input_tokens: 60_000, output_tokens: 200,
    })], deps());
    resolve({ messages: [{ seq: 1, role: "assistant", text: "old", ts: null, usage: WITH_WINDOW }], nextBefore: null, subagentHistory: [] });
    await refresh;
    expect(parseUsage(useChatStore.getState().bySession[KEY].usage)?.total).toBe(60_200);
  });
});
