import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanReview } from "@/lib/ipc";
import { useChatStore } from "./store";
import { handleEngineEvents, dropRunUsage, settledRuns, type ChatEngineEvent, type EngineEventDeps } from "./store/engine-events";
import { sessionKey } from "./store/persistence";
import { EMPTY_SESSION, drainPending, runRouting, untrackRun } from "./store/stream";

// reader.rs run_reader teardown, after Stop: parked questions/plans of the
// killed run are settled under the stopped run id BEFORE its terminal done.
// Those cleanup events must still reach the cards.

vi.mock("@/lib/ipc", () => ({ ipc: {
  rescanSessions: vi.fn(async () => {}), usageRecord: vi.fn(async () => {}),
  computerUseSetActive: vi.fn(async () => {}),
} }));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
  listenComputerUseEscape: vi.fn(async () => () => {}),
}));

const KEY = sessionKey("claude", "native-session", "/ws");
const event = (kind: ChatEngineEvent["kind"], seq: number, data: unknown, runId = "native-run"): ChatEngineEvent => ({
  kind, seq, data, runId, engine: "claude", sessionId: "native-session",
});
const questionData = (requestId: string) => ({
  requestId, toolUseId: "call_1",
  input: { questions: [{ question: "Pick one?", header: "Plan", options: [{ label: "A" }, { label: "B" }] }] },
});
const planRecord = (over: Partial<PlanReview> = {}): PlanReview => ({
  planId: "p-1", engine: "claude", sessionId: "native-session", workspacePath: "/ws", runId: "native-run",
  revision: 1, title: "Refactor", content: "# Plan", contentHash: "h1", complete: true,
  reviewKind: "native_request", nativePlanId: null, execPermission: "manual",
  status: "awaiting_review", execution: "not_started", decisionIntentAt: null, appliedAt: null,
  createdAt: 1000, updatedAt: 1000, supersededBy: null, ...over,
});
const questions = () => deps.get().bySession[KEY].messages.filter((m) => m.role === "question");
const plans = () => deps.get().bySession[KEY].messages.filter((m) => m.planReview);

let deps: EngineEventDeps;
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.useFakeTimers();
  runRouting.clear();
  settledRuns.clear();
  for (const runId of ["native-run", "native-next"]) {
    dropRunUsage(runId);
    untrackRun(runId);
  }
  useChatStore.setState({
    active: { engine: "claude", sessionId: "native-session", workspacePath: "/ws" },
    openTabs: [], streamingByKey: {}, retryingByKey: {},
    bySession: { [KEY]: { ...EMPTY_SESSION, messages: [{ seq: 1, role: "user", text: "go", ts: null }] } },
  });
  deps = {
    set: useChatStore.setState, get: useChatStore.getState,
    drainQueue: vi.fn(), markUnseenIfBackground: vi.fn(), upsertSessionMeta: vi.fn(),
    refreshSessionUsage: vi.fn(async () => {}),
  };
});
afterEach(() => {
  drainPending(KEY);
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** What interruptByKey leaves behind: busy state off, queue parked, run unrouted. */
const markStopped = () => {
  drainPending(KEY);
  runRouting.delete("native-run");
  untrackRun("native-run");
  useChatStore.setState((s) => ({
    bySession: { ...s.bySession, [KEY]: { ...s.bySession[KEY], interrupted: true, streaming: false, turnStartedAt: null } },
    streamingByKey: {},
  }));
};
/** What interruptByKey adds once the kill IPCs return: the run is remembered as settled. */
const markKillAcknowledged = () => {
  useChatStore.setState((s) => ({
    bySession: { ...s.bySession, [KEY]: { ...s.bySession[KEY], settledRunIds: ["native-run"] } },
  }));
};
/** A stopped session must stay stopped: cleanup events never re-adopt the run. */
const expectStillStopped = () => {
  const state = deps.get().bySession[KEY];
  expect(state.interrupted).toBe(true);
  expect(state.streaming).toBe(false);
  expect(state.nativeTaskRunId).toBe("native-run");
  expect(deps.get().streamingByKey[KEY]).toBeFalsy();
  expect(runRouting.has("native-run")).toBe(false);
  expect(deps.drainQueue).not.toHaveBeenCalled();
};

describe("teardown settle events of a stopped run", () => {
  it("cancels a parked question card when question_settled follows the stop", () => {
    handleEngineEvents([event("delta", 1, "Asking"), event("question", 2, questionData("req-1"))], deps);
    expect(questions().map((m) => m.question?.status)).toEqual(["pending"]);
    markStopped();
    handleEngineEvents([event("question_settled", 3, { requestId: "req-1" })], deps);
    expect(questions().map((m) => m.question?.status)).toEqual(["cancelled"]);
    expectStillStopped();
  });

  it("still cancels the card after the kill was acknowledged and the run is remembered as settled", () => {
    handleEngineEvents([event("question", 1, questionData("req-1"))], deps);
    markStopped();
    markKillAcknowledged();
    handleEngineEvents([event("question_settled", 2, { requestId: "req-1" })], deps);
    expect(questions().map((m) => m.question?.status)).toEqual(["cancelled"]);
    expectStillStopped();
  });

  it("expires a parked plan review when plan_review_settled follows the stop", () => {
    handleEngineEvents([event("plan_review", 1, planRecord())], deps);
    expect(plans().map((m) => m.planReview?.status)).toEqual(["awaiting_review"]);
    markStopped();
    handleEngineEvents([event("plan_review_settled", 2, { planId: "p-1", revision: 1, status: "expired" })], deps);
    expect(plans().map((m) => m.planReview?.status)).toEqual(["expired"]);
    expectStillStopped();
  });

  it("keeps plan events of the stopped run flowing without re-adopting it", () => {
    handleEngineEvents([event("delta", 1, "Planning")], deps);
    markStopped();
    handleEngineEvents([event("plan_review", 2, planRecord())], deps);
    expect(plans()).toHaveLength(1);
    expectStillStopped();
  });

  it("settles a stopped run's question after a newer run already took the session over", () => {
    handleEngineEvents([event("question", 1, questionData("req-1"))], deps);
    markStopped();
    handleEngineEvents([event("delta", 1, "Next", "native-next")], deps);
    expect(deps.get().bySession[KEY].nativeTaskRunId).toBe("native-next");
    handleEngineEvents([
      event("question_settled", 2, { requestId: "req-1" }),
      event("plan_review_settled", 3, { planId: "nope", revision: 1, status: "expired" }),
    ], deps);
    expect(questions().map((m) => m.question?.status)).toEqual(["cancelled"]);
    const state = deps.get().bySession[KEY];
    expect(state.nativeTaskRunId).toBe("native-next");
    expect(state.streaming).toBe(true);
    expect(runRouting.get("native-next")).toBe(KEY);
    expect(runRouting.has("native-run")).toBe(false);
  });

  it("still drops content of the stopped run, including a brand-new question", () => {
    handleEngineEvents([event("delta", 1, "Before stop")], deps);
    markStopped();
    handleEngineEvents([
      event("delta", 2, "late text"),
      event("thinking", 3, "late thought"),
      event("question", 4, questionData("req-late")),
      event("warn", 5, "engine stderr: killed"),
      event("activity", 6, { state: "running" }),
      event("turn_complete", 7, { usage: null }),
    ], deps);
    const state = deps.get().bySession[KEY];
    expect(questions()).toHaveLength(0);
    expect(state.messages.some((row) => row.text.includes("late"))).toBe(false);
    expect(state.error).toBeNull();
    expect(state.nativeActivity).toBeNull();
    expectStillStopped();
  });
});
