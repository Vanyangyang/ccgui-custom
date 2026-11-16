import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "@/features/chat/store/stream";

const state = vi.hoisted(() => ({
  chat: { initialized: true, streamingByKey: {}, retryingByKey: {}, bySession: {} as Record<string, SessionState> },
  records: [] as Array<{ status: string; mailbox?: { phase: string } }>,
  runs: {} as Record<string, { state: string }>,
  coordinator: null as ReturnType<typeof import("@/lib/runtime-checkpoint")["createRuntimeCheckpointCoordinator"]> | null,
}));
vi.mock("@/lib/transport", () => ({ invoke: vi.fn(async () => null), listen: vi.fn(async () => () => {}), isWeb: false }));
vi.mock("@/features/chat/store", () => ({ useChatStore: { getState: () => state.chat, subscribe: vi.fn(() => () => {}) }, sessionKey: (engine: string, id: string) => `${engine}/${id}` }));
vi.mock("@/features/chat/cross-session", async importOriginal => ({
  ...await importOriginal<typeof import("@/features/chat/cross-session")>(),
  useCrossSessionActivityStore: { getState: () => ({ records: state.records }) },
}));
vi.mock("@/features/mission/store", () => ({ useMissionStore: { getState: () => ({ runs: state.runs }) } }));
vi.mock("@/features/mission/types", () => ({ runStatus: (run: { state: string }) => run.state }));
vi.mock("@/lib/runtime-checkpoint", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/runtime-checkpoint")>(),
  isRuntimeSubmissionPaused: () => state.coordinator!.isPaused(),
  getRuntimeCheckpointReadiness: (capturing: boolean) => state.coordinator!.readiness(capturing),
  getRuntimeActivityReadiness: () => state.coordinator!.activityReadiness(),
}));
import { hasPendingSessionWork, readTaskShutdownBusy } from "./activity";
import { createRuntimeCheckpointCoordinator } from "@/lib/runtime-checkpoint";

const session = (patch: Partial<SessionState> = {}): SessionState => ({
  messages: [], subagentHistory: [], queue: [], loading: false, streaming: false,
  nextBefore: null, turnStartedAt: null, usage: null, turnUsage: null, error: null,
  retry: null, compaction: null, interrupted: false, planReviewResume: null, ...patch,
});

describe("shutdown frontend task activity", () => {
  beforeEach(() => {
    state.chat = { initialized: true, streamingByKey: {}, retryingByKey: {}, bySession: {} };
    state.records = []; state.runs = {};
    state.coordinator = createRuntimeCheckpointCoordinator();
    state.coordinator.initialize(undefined, { requiredParticipants: [] });
  });

  it("includes inactive tabs and parked queues between native runs", () => {
    state.chat.bySession = { hidden: session({ queue: [{ text: "next task" } as SessionState["queue"][number]], queueParked: true }) };
    expect(readTaskShutdownBusy()).toBe(true);
    state.chat.bySession = { hidden: session({ error: "finished with an error", interrupted: true }) };
    expect(readTaskShutdownBusy()).toBe(false);
  });

  it("waits for live questions, permissions and approvals, but ignores resolved or deferred input", () => {
    const row = (data: object) => ({ seq: 1, role: "assistant", text: "", ts: null, ...data }) as SessionState["messages"][number];
    for (const data of [
      { question: { status: "pending" } }, { question: { submitting: true } },
      { grant: { status: "pending" } }, { planReview: { status: "awaiting_review" } },
      { planReview: { status: "submitting" } },
    ]) expect(hasPendingSessionWork(session({ messages: [row(data)] }))).toBe(true);
    for (const data of [
      { question: { status: "cancelled" } }, { grant: { status: "declined" } },
      { planReview: { status: "deferred" } }, { planReview: { status: "completed" } },
    ]) expect(hasPendingSessionWork(session({ messages: [row(data)] }))).toBe(false);
  });

  it("keeps native paused and unknown tasks active after the parent stopped streaming", () => {
    const native = (status: string, ambient = false) => [{ id: "task", status, ambient }] as SessionState["nativeTasks"];
    for (const status of ["running", "paused", "unknown"]) {
      expect(hasPendingSessionWork(session({ nativeTasks: native(status) }))).toBe(true);
    }
    for (const status of ["completed", "failed", "stopped"]) {
      expect(hasPendingSessionWork(session({ nativeTasks: native(status) }))).toBe(false);
    }
    expect(hasPendingSessionWork(session({ nativeTasks: native("running", true) }))).toBe(false);
  });

  it("does not turn startup, retry or runtime recovery gaps into idle", () => {
    state.chat.initialized = false; expect(readTaskShutdownBusy()).toBe(true);
    state.chat.initialized = true;
    state.chat.retryingByKey = { background: true }; expect(readTaskShutdownBusy()).toBe(true);
    state.chat.retryingByKey = {};
    const release = state.coordinator!.holdSubmissions(); expect(readTaskShutdownBusy()).toBe(true);
    release();
    const done = state.coordinator!.beginOperation("operation-in-flight"); expect(readTaskShutdownBusy()).toBe(true);
    done(); expect(readTaskShutdownBusy()).toBe(false);
  });

  it("ignores historical receipts without erasing them and preserves genuinely pending communications", () => {
    for (const status of ["unknown", "completed", "failed", "handed_off"]) {
      const records = [{ status, mailbox: { phase: "received" } }]; state.records = records;
      expect(readTaskShutdownBusy(), status).toBe(false);
      expect(state.records).toBe(records);
    }
    for (const status of ["preparing", "queued", "received", "executing", "awaiting_permission", "awaiting_cost_approval"]) {
      state.records = [{ status }]; expect(readTaskShutdownBusy(), status).toBe(true);
    }
  });

  it("uses the same activity predicate for idle window/draft checks and the final hold", async () => {
    const coordinator = state.coordinator!;
    coordinator.registerBlocker("floating-window", () => ["plugin-window-without-checkpoint"], () => []);
    coordinator.registerBlocker("git-draft", () => ["unsaved-git-commit-message"], () => []);
    expect(readTaskShutdownBusy()).toBe(false);
    coordinator.holdSubmissions()();
    await expect(coordinator.prepare()).rejects.toThrow(/plugin-window-without-checkpoint.*unsaved-git-commit-message/);
    coordinator.abort();
    const remove = coordinator.registerBlocker("active-plugin", () => ["operation-pending"]);
    expect(readTaskShutdownBusy()).toBe(true);
    expect(() => coordinator.holdSubmissions()).toThrow(/operation-pending/);
    remove();
  });

  it("includes unfinished mission runs", () => {
    state.records = [];
    for (const status of ["running", "waiting", "attention"]) {
      state.runs = { mission: { state: status } }; expect(readTaskShutdownBusy()).toBe(true);
    }
    for (const status of ["done", "cancelled"]) {
      state.runs = { mission: { state: status } }; expect(readTaskShutdownBusy()).toBe(false);
    }
  });
});
