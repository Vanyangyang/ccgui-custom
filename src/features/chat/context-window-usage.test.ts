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
});
