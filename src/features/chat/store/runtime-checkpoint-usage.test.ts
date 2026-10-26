import { describe, expect, it, vi } from "vitest";
import type { RuntimeCheckpoint } from "@/lib/runtime-checkpoint";
import { EMPTY_SESSION } from "./stream";
import { buildTurnSummary } from "../turn-summary";

const loadSessionPage = vi.fn(async () => ({
  messages: [
    {
      seq: 1,
      role: "assistant",
      text: "real reply",
      model: "claude-opus-5-5",
      usage: { input_tokens: 2, cache_creation_input_tokens: 1_092, cache_read_input_tokens: 433_811, output_tokens: 415 },
    },
    {
      seq: 2,
      role: "assistant",
      text: "You've hit your session limit",
    },
  ],
  subagentHistory: [],
  nextBefore: null,
}));

vi.mock("@/lib/transport", () => ({ isWeb: false, invoke: vi.fn(async () => false), listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
  listenComputerUseEscape: vi.fn(async () => () => {}),
}));
vi.mock("@/lib/ipc", () => ({
  ipc: {
    listWorkspaces: vi.fn(async () => []),
    listSessions: vi.fn(async () => []),
    listArchivedSessions: vi.fn(async () => []),
    listEngines: vi.fn(async () => []),
    getAppSettings: vi.fn(async () => ({})),
    getCliConfig: vi.fn(async () => ({})),
    loadSessionPage,
    listPlanReviews: vi.fn(async () => []),
    activeRunIds: vi.fn(async () => []),
    rescanSessions: vi.fn(async () => {}),
  },
}));

const { unreadableUsageKeys } = await import("./runtime-checkpoint");

const ZERO = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  model_context_window: 1_000_000,
};
const REAL = { input_tokens: 2, cache_read_input_tokens: 430_000, output_tokens: 400 };
const row = { role: "assistant", text: "hi" };

function state(usage: unknown, extra: Record<string, unknown> = {}) {
  const tab = { engine: "claude", sessionId: "s1", workspacePath: "G:/w" };
  return {
    openTabs: [tab, { ...tab }, { engine: "claude", sessionId: null, workspacePath: "G:/w" }],
    bySession: { "claude/s1": { messages: [row], streaming: false, usage, ...extra } },
  } as never;
}

describe("unreadableUsageKeys", () => {
  it("selects idle restored sessions (open or cached in bySession) whose snapshot the gauge cannot read", () => {
    // The all-zero <synthetic> notice an older backend left as the latest usage.
    expect(unreadableUsageKeys(state(ZERO))).toEqual(["claude/s1"]);
    expect(unreadableUsageKeys(state(null))).toEqual(["claude/s1"]);
    expect(
      unreadableUsageKeys({
        openTabs: [],
        bySession: { "claude/s2": { messages: [row], streaming: false, usage: ZERO } },
      } as never),
    ).toEqual(["claude/s2"]);
  });

  it("leaves readable, context-backed, streaming and empty sessions alone", () => {
    expect(unreadableUsageKeys(state(REAL))).toEqual([]);
    expect(unreadableUsageKeys(state({ context_usage_kind: "current_context", context_usage: { used_tokens: 5 } }))).toEqual([]);
    expect(unreadableUsageKeys(state(ZERO, { streaming: true }))).toEqual([]);
    expect(unreadableUsageKeys(state(ZERO, { messages: [] }))).toEqual([]);
  });

  it("re-reads session usage from history and strips <synthetic> rows when a checkpoint resumes", async () => {
    vi.resetModules();
    loadSessionPage.mockClear();
    const coordinator = await import("@/lib/runtime-checkpoint");
    coordinator.initializeRuntimeCheckpoint(undefined, { requiredParticipants: ["chat"] });
    const { useChatStore: firstStore } = await import("../store");
    const tab = { engine: "claude", sessionId: "00000000-0000-4000-8000-000000000001", workspacePath: "G:/EXAMPLE" };
    firstStore.setState({
      initialized: true,
      openTabs: [tab],
      active: tab,
      bySession: {
        "claude/00000000-0000-4000-8000-000000000001": {
          ...EMPTY_SESSION,
          activeModel: "<synthetic>",
          usage: { ...ZERO },
          messages: [
            { seq: 1, role: "assistant", text: "real reply", ts: null, model: "claude-opus-5-5" },
            { seq: 2, role: "assistant", text: "You've hit your session limit", ts: null, model: "<synthetic>", usage: { ...ZERO } },
          ],
        },
        "codex/c1": {
          ...EMPTY_SESSION,
          usage: { input_tokens: 45_000, output_tokens: 90, total_tokens: 45_090 },
          messages: [
            { seq: 1, role: "assistant", text: "codex reply", ts: null, durationMs: 300_000, usage: { input_tokens: 45_000, output_tokens: 90, total_tokens: 45_090 } },
          ],
        },
        "claude/cached": {
          ...EMPTY_SESSION,
          usage: { input_tokens: 1000, output_tokens: 90 },
          messages: [
            { seq: 1, role: "assistant", text: "old history", ts: null, durationMs: 300_000,
              usage: { input_tokens: 1000, output_tokens: 90 } },
            { seq: 2, role: "assistant", text: "verified live total", ts: null, durationMs: 300_000,
              usage: { input_tokens: 1000, output_tokens: 6000, usage_scope: "turn", turn_status: "complete" } },
            { seq: 3, role: "assistant", text: "interrupted", ts: null, durationMs: 10_000,
              usage: { input_tokens: 1000, output_tokens: 400, usage_scope: "turn", turn_status: "partial" } },
          ],
        },
      },
    });
    const checkpoint: RuntimeCheckpoint = await coordinator.prepareRuntimeCheckpoint();

    vi.resetModules();
    const nextCoord = await import("@/lib/runtime-checkpoint");
    nextCoord.initializeRuntimeCheckpoint(checkpoint, { requiredParticipants: ["chat"] });
    const { useChatStore: restoredStore } = await import("../store");

    // Restore immediately strips <synthetic> model/usage from checkpointed rows.
    const beforeResume = restoredStore.getState().bySession["claude/00000000-0000-4000-8000-000000000001"];
    expect(beforeResume.activeModel).toBeNull();
    expect(beforeResume.messages[1].model).toBeUndefined();
    expect(beforeResume.messages[1].usage).toBeUndefined();
    const restoredCodex = restoredStore.getState().bySession["codex/c1"];
    expect(restoredCodex.messages[0].usage).toMatchObject({ usage_scope: "last_request", output_tokens: 90 });
    const cachedClaude = restoredStore.getState().bySession["claude/cached"];
    expect(cachedClaude.messages[0].usage).toMatchObject({ usage_scope: "unknown", output_tokens: 90 });
    expect(cachedClaude.messages.map(m => buildTurnSummary(m)?.outputTps)).toEqual([null, 20, null]);
    expect(cachedClaude.usage).toEqual({ input_tokens: 1000, output_tokens: 90 });

    nextCoord.resumeCommittedRuntimeCheckpoint();
    await vi.waitFor(() => {
      expect(loadSessionPage).toHaveBeenCalledWith("claude", "00000000-0000-4000-8000-000000000001", 100);
      expect(restoredStore.getState().bySession["claude/00000000-0000-4000-8000-000000000001"].usage).toMatchObject({
        input_tokens: 2,
        cache_creation_input_tokens: 1_092,
        cache_read_input_tokens: 433_811,
        output_tokens: 415,
        model_context_window: 1_000_000,
      });
    });
  });
});
