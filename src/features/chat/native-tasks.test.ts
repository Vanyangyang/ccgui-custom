import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import type { NativeTask } from "@/lib/events";
import { useChatStore } from "./store";
import { handleEngineEvents, dropRunUsage, settledRuns, type ChatEngineEvent, type EngineEventDeps } from "./store/engine-events";
import { sessionKey } from "./store/persistence";
import { EMPTY_SESSION, drainPending, reconcileOrphanRuns, routeRun, runRouting, untrackRun } from "./store/stream";
import { applyConfirmedNativeTaskStop, beginNativeRun, readNativeTasks, readNativeTaskStopResult } from "./store/native-tasks";

vi.mock("@/lib/ipc", () => ({ ipc: {
  rescanSessions: vi.fn(async () => {}), usageRecord: vi.fn(async () => {}),
  computerUseSetActive: vi.fn(async () => {}),
  activeRunIds: vi.fn(async () => []),
} }));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
  listenComputerUseEscape: vi.fn(async () => () => {}),
}));

const KEY = sessionKey("claude", "native-session", "/ws");
const OTHER = sessionKey("claude", "other-session", "/ws");
const task = (status: NativeTask["status"] = "running"): NativeTask => ({
  id: "bash-1", kind: "local_bash", description: "Build in background", status,
});
const event = (kind: ChatEngineEvent["kind"], seq: number, data: unknown, runId = "native-run"): ChatEngineEvent => ({
  kind, seq, data, runId, engine: "claude", sessionId: "native-session",
});

let deps: EngineEventDeps;
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.useFakeTimers();
  runRouting.clear();
  settledRuns.clear();
  for (const runId of ["native-run", "native-next", "native-other", "legacy"]) {
    dropRunUsage(runId);
    untrackRun(runId);
  }
  useChatStore.setState({
    active: { engine: "claude", sessionId: "native-session", workspacePath: "/ws" },
    openTabs: [], streamingByKey: {}, retryingByKey: {},
    bySession: {
      [KEY]: { ...EMPTY_SESSION, messages: [{ seq: 1, role: "user", text: "build", ts: null }] },
      [OTHER]: { ...EMPTY_SESSION, messages: [] },
    },
  });
  deps = {
    set: useChatStore.setState, get: useChatStore.getState,
    drainQueue: vi.fn(), markUnseenIfBackground: vi.fn(), upsertSessionMeta: vi.fn(),
    refreshSessionUsage: vi.fn(async () => {}),
  };
});
const rereads = () => deps.refreshSessionUsage as ReturnType<typeof vi.fn>;
/** What messaging.ts settleStopped leaves behind: busy state off, queue parked. */
const markStopped = () => {
  drainPending(KEY);
  useChatStore.setState((s) => ({
    bySession: { ...s.bySession, [KEY]: { ...s.bySession[KEY], interrupted: true, streaming: false, turnStartedAt: null } },
    streamingByKey: {},
  }));
};
afterEach(() => {
  drainPending(KEY);
  drainPending(OTHER);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("confirmed native task stop", () => {
  it.each([
    ["completed", "running"], ["completed", "paused"],
    ["failed", "running"], ["failed", "paused"],
    ["stopped", "running"], ["stopped", "paused"],
  ] as const)("preserves confirmed %s against a later %s snapshot from either native source", (terminal, delayed) => {
    for (const source of ["event", "ipc"]) {
      const runId = source === "event" ? "native-run" : "native-next";
      handleEngineEvents([event("tasks", 1, { tasks: [task(), { ...task(), id: "sibling" }] }, runId)], deps);
      if (source === "ipc") {
        applyConfirmedNativeTaskStop(deps.set, KEY, runId, { taskId: "bash-1", status: terminal });
      } else {
        handleEngineEvents([event("tasks", 2, { tasks: [task(terminal), { ...task(), id: "sibling" }] }, runId)], deps);
      }
      handleEngineEvents([event("tasks", 10, { tasks: [
        { ...task(delayed), summary: "New summary", progress: "New progress" },
        { ...task("completed"), id: "sibling" },
        { ...task(), id: "new-task" },
      ] }, runId)], deps);
      const state = deps.get().bySession[KEY];
      expect(state.nativeTaskSeq).toBe(10);
      expect(state.nativeTasks?.[0]).toMatchObject({ status: terminal, summary: "New summary", progress: "New progress" });
      expect(state.nativeTasks?.[1].status).toBe("completed");
      expect(state.nativeTasks?.[2].status).toBe("running");
    }
  });

  it.each(["running", "paused"] as const)("allows unknown tasks to recover to %s", (status) => {
    handleEngineEvents([event("tasks", 1, { tasks: [task("unknown")] })], deps);
    handleEngineEvents([event("tasks", 2, { tasks: [task(status)] })], deps);
    expect(deps.get().bySession[KEY].nativeTasks?.[0].status).toBe(status);
  });

  it("allows the same id to run again in a new native run", () => {
    handleEngineEvents([event("tasks", 1, { tasks: [task()] })], deps);
    applyConfirmedNativeTaskStop(deps.set, KEY, "native-run", { taskId: "bash-1", status: "stopped" });
    handleEngineEvents([event("tasks", 1, { tasks: [task()] }, "native-next")], deps);
    expect(deps.get().bySession[KEY].nativeTaskRunId).toBe("native-next");
    expect(deps.get().bySession[KEY].nativeTasks?.[0].status).toBe("running");
  });

  it("does not restore background protection from a delayed running snapshot of a confirmed terminal", async () => {
    handleEngineEvents([event("tasks", 1, { tasks: [task()] })], deps);
    applyConfirmedNativeTaskStop(deps.set, KEY, "native-run", { taskId: "bash-1", status: "stopped" });
    handleEngineEvents([event("tasks", 2, { tasks: [task()] })], deps);
    vi.advanceTimersByTime(60 * 60_000);
    routeRun("native-other", OTHER);
    await reconcileOrphanRuns(ipc.activeRunIds, () => {});
    expect(runRouting.has("native-run")).toBe(false);
  });

  it.each(["completed", "failed", "stopped"] as const)("merges confirmed %s for only the requested row", (status) => {
    const sibling = { ...task(), id: "still-running" };
    handleEngineEvents([event("tasks", 1, { tasks: [task("paused"), sibling] })], deps);
    const previous = deps.get().bySession[KEY];
    applyConfirmedNativeTaskStop(deps.set, KEY, "native-run", { taskId: "bash-1", status });
    const next = deps.get().bySession[KEY];
    expect(next.nativeTasks?.[0].status).toBe(status);
    expect(next.nativeTasks?.[1]).toBe(previous.nativeTasks?.[1]);
    expect(next.nativeTaskSeq).toBe(previous.nativeTaskSeq);
    expect(next.streaming).toBe(previous.streaming);
    expect(next.queueParked).toBe(previous.queueParked);
  });

  it.each(["completed", "failed", "stopped", "unknown"] as const)("preserves an existing %s terminal", (status) => {
    handleEngineEvents([event("tasks", 1, { tasks: [task(status)] })], deps);
    const previous = deps.get().bySession[KEY];
    applyConfirmedNativeTaskStop(deps.set, KEY, "native-run", { taskId: "bash-1", status: "stopped" });
    expect(deps.get().bySession[KEY]).toBe(previous);
  });

  it("ignores removed tasks, wrong runs and unrelated sessions", () => {
    handleEngineEvents([event("tasks", 1, { tasks: [task()] })], deps);
    const previous = deps.get().bySession[KEY];
    const other = deps.get().bySession[OTHER];
    applyConfirmedNativeTaskStop(deps.set, KEY, "native-next", { taskId: "bash-1", status: "stopped" });
    applyConfirmedNativeTaskStop(deps.set, KEY, "native-run", { taskId: "missing", status: "stopped" });
    applyConfirmedNativeTaskStop(deps.set, OTHER, "native-run", { taskId: "bash-1", status: "stopped" });
    expect(deps.get().bySession[KEY]).toBe(previous);
    expect(deps.get().bySession[OTHER]).toBe(other);
  });

  it.each([
    undefined, { taskId: "other", status: "stopped" },
    { taskId: "bash-1", status: "accepted" }, { taskId: "bash-1", status: "unsupported" },
    { taskId: "bash-1", status: "unknown" },
  ])("rejects unconfirmed or mismatched responses (%j)", (data) => {
    expect(readNativeTaskStopResult(data, "bash-1")).toBeNull();
  });

  it.each([
    ["last foreground task", false, false, false],
    ["another foreground task", true, false, true],
    ["only ambient observers remain", true, true, false],
    ["waiting for user action", false, false, true],
  ] as const)("updates orphan protection for %s", async (label, siblingPresent, ambient, protectedRun) => {
    handleEngineEvents([event("tasks", 1, { tasks: [task(), ...(siblingPresent ? [{ ...task(), id: "other", ambient }] : [])] })], deps);
    if (label === "waiting for user action") {
      handleEngineEvents([event("activity", 2, { state: "requires_action" })], deps);
    }
    vi.advanceTimersByTime(60 * 60_000);
    applyConfirmedNativeTaskStop(deps.set, KEY, "native-run", { taskId: "bash-1", status: "stopped" });
    routeRun("native-other", OTHER);
    await reconcileOrphanRuns(ipc.activeRunIds, () => {});
    expect(runRouting.has("native-run")).toBe(protectedRun);
  });
});

describe("native task lifecycle", () => {
  it("keeps a native control request reachable through a long wait for the user", () => {
    handleEngineEvents([event("activity", 1, { state: "requires_action" })], deps);
    vi.advanceTimersByTime(60 * 60_000);
    handleEngineEvents([{ ...event("delta", 1, "Other session", "native-other"), sessionId: "other-session" }], deps);
    expect(runRouting.get("native-run")).toBe(KEY);
    expect(deps.get().bySession[KEY].streaming).toBe(true);
    handleEngineEvents([event("activity", 2, { state: "running" }), event("done", 3, { usage: null })], deps);
    expect(runRouting.has("native-run")).toBe(false);
  });
  it("keeps a native background run routed through an hour of silence until real terminal cleanup", () => {
    handleEngineEvents([
      event("tasks", 1, { tasks: [task()] }),
      event("delta", 2, "Build started"),
      event("turn_complete", 3, { usage: null }),
      event("activity", 4, { state: "waiting" }),
    ], deps);
    vi.advanceTimersByTime(60 * 60_000);
    handleEngineEvents([{ ...event("delta", 1, "Other session", "native-other"), sessionId: "other-session" }], deps);
    expect(runRouting.get("native-run")).toBe(KEY);
    expect(deps.get().bySession[KEY].streaming).toBe(true);
    expect(deps.get().bySession[KEY].nativeActivity).toBe("waiting");
    handleEngineEvents([
      event("tasks", 5, { tasks: [task("stopped")] }),
      event("done", 6, { usage: null }),
    ], deps);
    expect(runRouting.has("native-run")).toBe(false);
    expect(deps.get().bySession[KEY].streaming).toBe(false);
    expect(deps.get().bySession[KEY].nativeTasks?.[0].status).toBe("stopped");
  });

  it("keeps the catalog and routing live when a response completes, then accepts task completion", () => {
    handleEngineEvents([
      event("tasks", 1, { tasks: [task()] }),
      event("thinking", 2, "Thinking🙂"),
      event("delta", 3, "Started the build."),
      event("turn_complete", 4, { usage: { input_tokens: 10, output_tokens: 4 } }),
      event("activity", 5, { state: "waiting" }),
    ], deps);
    const state = deps.get().bySession[KEY];
    expect(state.streaming).toBe(true);
    expect(state.nativeActivity).toBe("waiting");
    expect(state.nativeTasks).toEqual([task()]);
    expect(state.messages.slice(-2).map((row) => [row.text, row.live])).toEqual([
      ["Thinking🙂", false], ["Started the build.", false],
    ]);
    expect(state.messages.at(-1)?.usage).toMatchObject({ input_tokens: 10, output_tokens: 4 });
    expect(state.settledRunIds).toBeUndefined();
    expect(runRouting.get("native-run")).toBe(KEY);
    expect(deps.drainQueue).not.toHaveBeenCalled();
    expect(deps.markUnseenIfBackground).not.toHaveBeenCalled();
    handleEngineEvents([event("tasks", 6, { tasks: [task("completed")] })], deps);
    expect(deps.get().bySession[KEY].nativeTasks?.[0].status).toBe("completed");
    expect(deps.get().bySession[KEY].streaming).toBe(true);
  });

  it("seals separate response text blocks and records each result once without final-done restamping", () => {
    handleEngineEvents([
      event("delta", 1, "Initial response"),
      event("turn_complete", 2, { usage: { input_tokens: 10, output_tokens: 4 } }),
    ], deps);
    const original = deps.get().bySession[KEY].messages.at(-1)!;
    vi.advanceTimersByTime(1000);
    handleEngineEvents([
      event("delta", 3, "Automatic followup"),
      event("turn_complete", 4, { usage: { input_tokens: 20, output_tokens: 8 } }),
      event("turn_complete", 4, { usage: { input_tokens: 20, output_tokens: 8 } }),
    ], deps);
    const followup = deps.get().bySession[KEY].messages.at(-1)!;
    expect(deps.get().bySession[KEY].messages.slice(-2)).toEqual([original, followup]);
    expect(original.text).toBe("Initial response");
    expect(followup.text).toBe("Automatic followup");
    expect(followup.usage).toMatchObject({ input_tokens: 20, output_tokens: 8 });
    expect(ipc.usageRecord).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5000);
    handleEngineEvents([event("done", 5, { usage: null })], deps);
    expect(deps.get().bySession[KEY].messages.at(-1)).toBe(followup);
    expect(ipc.usageRecord).toHaveBeenCalledTimes(2);
    expect(deps.get().bySession[KEY].streaming).toBe(false);
    expect(runRouting.has("native-run")).toBe(false);
    expect(deps.drainQueue).toHaveBeenCalledTimes(1);
    expect(deps.markUnseenIfBackground).toHaveBeenCalledTimes(1);
  });

  it.each(["paused", "failed", "stopped", "unknown"] as const)("preserves native %s after final done", (status) => {
    handleEngineEvents([
      event("tasks", 1, { tasks: [task(status)] }),
      event("done", 2, { usage: null }),
    ], deps);
    expect(deps.get().bySession[KEY].nativeTasks?.[0].status).toBe(status);
  });

  it("preserves ambient rows but releases their orphan-sweep protection when only watchers remain running", async () => {
    const watcher = { ...task(), id: "watcher", kind: "local_monitor", ambient: true };
    handleEngineEvents([event("tasks", 1, { tasks: [task(), watcher] })], deps);
    handleEngineEvents([event("tasks", 2, { tasks: [task("paused"), watcher] })], deps);
    expect(deps.get().bySession[KEY].nativeTasks).toEqual([task("paused"), watcher]);
    vi.advanceTimersByTime(60 * 60_000);
    handleEngineEvents([{ ...event("delta", 1, "Other session", "native-other"), sessionId: "other-session" }], deps);
    await reconcileOrphanRuns(ipc.activeRunIds, () => {});
    expect(runRouting.has("native-run")).toBe(false);
    expect(deps.get().bySession[KEY].streaming).toBe(false);
    expect(deps.get().bySession[KEY].nativeTasks).toEqual([task("paused"), watcher]);
  });

  it("does not replace the parent reply's metadata when a later native result has no assistant text", () => {
    handleEngineEvents([
      event("delta", 1, "Parent reply"),
      event("turn_complete", 2, { usage: { input_tokens: 10, output_tokens: 4 } }),
    ], deps);
    const original = deps.get().bySession[KEY].messages.at(-1)!;
    vi.advanceTimersByTime(1000);
    handleEngineEvents([
      event("turn_complete", 3, { usage: { input_tokens: 20, output_tokens: 0 } }),
      event("done", 4, { usage: null }),
    ], deps);
    expect(deps.get().bySession[KEY].messages.at(-1)).toBe(original);
    expect(original.usage).toMatchObject({ input_tokens: 10, output_tokens: 4 });
    expect(ipc.usageRecord).toHaveBeenCalledTimes(2);
  });

  it("does not guess task success from parent done or streaming=false", () => {
    handleEngineEvents([event("tasks", 1, { tasks: [task()] }), event("done", 2, { usage: null })], deps);
    expect(deps.get().bySession[KEY].nativeTasks?.[0].status).toBe("running");
  });

  it("accepts explicit stop cleanup after local settlement without reviving or draining", () => {
    handleEngineEvents([event("tasks", 1, { tasks: [task()] })], deps);
    useChatStore.setState((s) => ({
      bySession: { ...s.bySession, [KEY]: { ...s.bySession[KEY], interrupted: true, streaming: false, settledRunIds: ["native-run"] } },
      streamingByKey: {},
    }));
    runRouting.delete("native-run");
    handleEngineEvents([
      event("tasks", 2, { tasks: [task("stopped")] }),
      event("activity", 3, { state: "waiting" }),
      event("turn_complete", 4, { usage: null }),
    ], deps);
    expect(deps.get().bySession[KEY].nativeTasks?.[0].status).toBe("stopped");
    expect(deps.get().bySession[KEY].streaming).toBe(false);
    expect(deps.drainQueue).not.toHaveBeenCalled();
    expect(runRouting.has("native-run")).toBe(false);
  });

  it("rejects reordered catalogs and old run events after a newer run starts", () => {
    handleEngineEvents([
      event("tasks", 4, { tasks: [task("completed")] }),
      event("tasks", 3, { tasks: [task()] }),
    ], deps);
    expect(deps.get().bySession[KEY].nativeTasks?.[0].status).toBe("completed");
    handleEngineEvents([event("delta", 1, "Next response", "native-next")], deps);
    expect(deps.get().bySession[KEY].nativeTasks).toBeUndefined();
    expect(runRouting.has("native-run")).toBe(false);
    handleEngineEvents([
      event("tasks", 5, { tasks: [task()] }),
      event("done", 6, { usage: null }),
      event("tasks", 2, { tasks: [{ ...task(), id: "new-task" }] }, "native-next"),
    ], deps);
    expect(deps.get().bySession[KEY].streaming).toBe(true);
    expect(deps.get().bySession[KEY].nativeTasks?.map((row) => row.id)).toEqual(["new-task"]);
  });

  it("keeps session task catalogs separate when the active tab changes", () => {
    handleEngineEvents([event("tasks", 1, { tasks: [task()] })], deps);
    useChatStore.setState({ active: { engine: "claude", sessionId: "other-session", workspacePath: "/ws" } });
    handleEngineEvents([{ ...event("tasks", 1, { tasks: [{ ...task("failed"), id: "other-task" }] }, "native-other"), sessionId: "other-session" }], deps);
    handleEngineEvents([event("tasks", 2, { tasks: [task("completed")] })], deps);
    expect(deps.get().bySession[KEY].nativeTasks?.[0].status).toBe("completed");
    expect(deps.get().bySession[OTHER].nativeTasks?.[0].status).toBe("failed");
  });

  it("keeps legacy engine done settlement and usage accounting", () => {
    const legacy = (kind: ChatEngineEvent["kind"], seq: number, data: unknown) => ({ ...event(kind, seq, data, "legacy"), engine: "codex" });
    runRouting.set("legacy", KEY);
    handleEngineEvents([legacy("delta", 1, "Legacy reply"), legacy("done", 2, { usage: { input_tokens: 3, output_tokens: 7 } })], deps);
    expect(deps.get().bySession[KEY].messages.at(-1)?.text).toBe("Legacy reply");
    expect(deps.get().bySession[KEY].streaming).toBe(false);
    expect(ipc.usageRecord).toHaveBeenCalledTimes(1);
    expect(deps.drainQueue).toHaveBeenCalledTimes(1);
  });

  it("validates snapshots, deduplicates ids and bounds retired run identities", () => {
    expect(readNativeTasks({ tasks: [task(), { ...task(), status: "failed" }, null, { id: "future", status: "new_status" }] })).toEqual([
      task("failed"), { id: "future", kind: "unknown", description: "future", status: "unknown" },
    ]);
    expect(readNativeTasks({ tasks: "bad" })).toBeNull();
    let current = { ...EMPTY_SESSION };
    for (let i = 0; i < 100; i++) current = { ...current, ...beginNativeRun(current, `run-${i}`) };
    expect(current.retiredNativeRunIds).toHaveLength(32);
  });
});

describe("native result context re-read", () => {
  it("re-reads the transcript occupancy after each result, not only at the far-off final done", () => {
    handleEngineEvents([
      event("delta", 1, "Started"),
      event("turn_complete", 2, { usage: { input_tokens: 900, output_tokens: 5 } }),
      event("activity", 3, { state: "waiting" }),
    ], deps);
    vi.advanceTimersByTime(399);
    expect(rereads()).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(rereads()).toHaveBeenCalledTimes(1);
    expect(rereads()).toHaveBeenCalledWith(KEY);
    vi.advanceTimersByTime(60 * 60_000);
    handleEngineEvents([
      event("delta", 4, "Followup"),
      event("turn_complete", 5, { usage: { input_tokens: 1200, output_tokens: 7 } }),
    ], deps);
    vi.advanceTimersByTime(400);
    expect(rereads()).toHaveBeenCalledTimes(2);
    handleEngineEvents([event("done", 6, { usage: null })], deps);
    vi.advanceTimersByTime(400);
    expect(rereads()).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(60 * 60_000);
    expect(rereads()).toHaveBeenCalledTimes(3);
  });

  it("keeps billing usage untouched by the re-read scheduling", () => {
    handleEngineEvents([
      event("delta", 1, "Started"),
      event("turn_complete", 2, { usage: { input_tokens: 10, output_tokens: 4 } }),
    ], deps);
    vi.advanceTimersByTime(400);
    handleEngineEvents([event("done", 3, { usage: null })], deps);
    expect(ipc.usageRecord).toHaveBeenCalledTimes(1);
  });

  it("coalesces results landing inside the delay into one re-read", () => {
    handleEngineEvents([
      event("delta", 1, "A"),
      event("turn_complete", 2, { usage: null }),
    ], deps);
    vi.advanceTimersByTime(300);
    handleEngineEvents([event("turn_complete", 3, { usage: null })], deps);
    vi.advanceTimersByTime(300);
    expect(rereads()).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(rereads()).toHaveBeenCalledTimes(1);
  });

  it("lets the final done supersede a pending result re-read with its own single one", () => {
    handleEngineEvents([
      event("delta", 1, "A"),
      event("turn_complete", 2, { usage: null }),
      event("done", 3, { usage: null }),
    ], deps);
    vi.advanceTimersByTime(60_000);
    expect(rereads()).toHaveBeenCalledTimes(1);
  });

  it("never applies a pending re-read after the run is stopped", () => {
    handleEngineEvents([event("delta", 1, "A"), event("turn_complete", 2, { usage: null })], deps);
    markStopped();
    vi.advanceTimersByTime(60_000);
    expect(rereads()).not.toHaveBeenCalled();
  });

  it("cancels the pending re-read when the stop path drops the run", () => {
    handleEngineEvents([event("delta", 1, "A"), event("turn_complete", 2, { usage: null })], deps);
    dropRunUsage("native-run");
    vi.advanceTimersByTime(60_000);
    expect(rereads()).not.toHaveBeenCalled();
  });

  it("drops the re-read when another run took the session over", () => {
    handleEngineEvents([event("delta", 1, "A"), event("turn_complete", 2, { usage: null })], deps);
    handleEngineEvents([event("delta", 1, "Next", "native-next")], deps);
    vi.advanceTimersByTime(60_000);
    expect(rereads()).not.toHaveBeenCalled();
  });

  it.each([
    ["the session's live run changed", { nativeTaskRunId: "native-next" }],
    ["the run already settled", { settledRunIds: ["native-run"] }],
  ])("skips the re-read when %s without a cleanup path running", (_label, patch) => {
    handleEngineEvents([event("delta", 1, "A"), event("turn_complete", 2, { usage: null })], deps);
    useChatStore.setState((s) => ({ bySession: { ...s.bySession, [KEY]: { ...s.bySession[KEY], ...patch } } }));
    vi.advanceTimersByTime(60_000);
    expect(rereads()).not.toHaveBeenCalled();
  });

  it("skips the re-read when the run is no longer routed to the session", () => {
    handleEngineEvents([event("delta", 1, "A"), event("turn_complete", 2, { usage: null })], deps);
    runRouting.delete("native-run");
    vi.advanceTimersByTime(60_000);
    expect(rereads()).not.toHaveBeenCalled();
  });
});

describe("stop flag across native runs", () => {
  it("drops late events of the stopped run but not of a run adopted without sendPrompt", () => {
    handleEngineEvents([event("delta", 1, "Before stop")], deps);
    markStopped();
    handleEngineEvents([event("delta", 2, "late of the stopped run")], deps);
    expect(deps.get().bySession[KEY].streaming).toBe(false);
    expect(deps.get().bySession[KEY].interrupted).toBe(true);

    handleEngineEvents([
      event("delta", 1, "Hello", "native-next"),
      event("delta", 2, " world", "native-next"),
      event("turn_complete", 3, { usage: null }, "native-next"),
    ], deps);
    const state = deps.get().bySession[KEY];
    expect(state.nativeTaskRunId).toBe("native-next");
    expect(state.interrupted).toBe(false);
    expect(state.streaming).toBe(true);
    expect(state.messages.at(-1)?.text).toBe("Hello world");
    expect(state.messages.some((row) => row.text.includes("late of the stopped run"))).toBe(false);

    // The stopped run stays dead after the takeover (retired identity).
    handleEngineEvents([event("delta", 3, "still late of the stopped run")], deps);
    handleEngineEvents([event("done", 4, { usage: null }, "native-next")], deps);
    expect(deps.get().bySession[KEY].messages.some((row) => row.text.includes("late"))).toBe(false);
    expect(deps.get().bySession[KEY].streaming).toBe(false);
  });

  it("keeps the stop flag while only the stopped run talks, settling it on its terminal event", () => {
    handleEngineEvents([event("delta", 1, "Before stop")], deps);
    markStopped();
    handleEngineEvents([
      event("delta", 2, "late"),
      event("activity", 3, { state: "running" }),
      event("turn_complete", 4, { usage: null }),
    ], deps);
    expect(deps.get().bySession[KEY].interrupted).toBe(true);
    expect(deps.get().bySession[KEY].streaming).toBe(false);
    expect(deps.get().bySession[KEY].nativeActivity).toBeNull();
    handleEngineEvents([event("done", 5, { usage: null })], deps);
    expect(deps.drainQueue).not.toHaveBeenCalled();
    expect(deps.get().bySession[KEY].interrupted).toBe(false);
  });

  it("clears the stop only when the run actually changes", () => {
    const stopped = { ...EMPTY_SESSION, interrupted: true, nativeTaskRunId: "native-run" };
    expect(beginNativeRun(stopped, "native-run")).toEqual({});
    expect(beginNativeRun(stopped, "native-next")).toMatchObject({ nativeTaskRunId: "native-next", interrupted: false });
  });
});

describe("catalog updates after the final done", () => {
  it("applies a watcher row flip arriving after done without reviving the turn", () => {
    const watcher = { ...task("running"), id: "watcher", kind: "local_monitor", ambient: true };
    handleEngineEvents([
      event("tasks", 1, { tasks: [watcher] }),
      event("delta", 2, "Watching."),
      event("done", 3, { usage: null }),
    ], deps);
    expect(settledRuns.get("native-run")).toBe("done");
    expect(deps.get().bySession[KEY].streaming).toBe(false);
    expect(deps.drainQueue).toHaveBeenCalledTimes(1);

    handleEngineEvents([event("tasks", 4, { tasks: [{ ...watcher, status: "completed" }] })], deps);
    const state = deps.get().bySession[KEY];
    expect(state.nativeTasks).toEqual([{ ...watcher, status: "completed" }]);
    expect(state.nativeTaskSeq).toBe(4);
    expect(state.streaming).toBe(false);
    expect(deps.get().streamingByKey[KEY]).toBeFalsy();
    expect(runRouting.has("native-run")).toBe(false);
    expect(deps.drainQueue).toHaveBeenCalledTimes(1);
    expect(deps.markUnseenIfBackground).toHaveBeenCalledTimes(1);
  });
});

describe("live follow-up bookkeeping", () => {
  const patchKey = (patch: Partial<typeof EMPTY_SESSION> & Record<string, unknown>) =>
    useChatStore.setState((s) => ({ bySession: { ...s.bySession, [KEY]: { ...s.bySession[KEY], ...patch } } }));
  const liveDeps = () => {
    const drainQueueLive = vi.fn();
    deps = { ...deps, drainQueueLive };
    return drainQueueLive;
  };

  it("drops the per-run live state when another run takes the session over", () => {
    const current = {
      ...EMPTY_SESSION,
      nativeTaskRunId: "native-run",
      liveLaunch: { model: "m", effort: null, provider: null, permission: "auto", grantedSinceLaunch: true },
      followUpAt: 1,
      queueParked: true,
      interruptRequestedAt: 2,
      lastInterruptAt: 3,
    };
    expect(beginNativeRun(current, "native-run")).toEqual({});
    expect(beginNativeRun(current, "native-next")).toMatchObject({
      liveLaunch: undefined,
      followUpAt: null,
      queueParked: false,
      interruptRequestedAt: null,
      lastInterruptAt: null,
    });
  });

  it("hands the queue to the live CLI at an idle boundary, not at running or requires_action", () => {
    const drainQueueLive = liveDeps();
    handleEngineEvents([event("activity", 1, { state: "running" }), event("activity", 2, { state: "requires_action" })], deps);
    expect(drainQueueLive).not.toHaveBeenCalled();
    handleEngineEvents([event("activity", 3, { state: "waiting" })], deps);
    expect(drainQueueLive).toHaveBeenCalledTimes(1);
    expect(drainQueueLive).toHaveBeenCalledWith(KEY);
  });

  it("ignores the duplicate waiting of the cycle that already released a message", () => {
    const drainQueueLive = liveDeps();
    handleEngineEvents([event("activity", 1, { state: "running" })], deps);
    // What the live path leaves behind: optimistic running, delivery unconfirmed.
    patchKey({ nativeActivity: "running", followUpAt: Date.now() });
    handleEngineEvents([event("activity", 2, { state: "waiting" })], deps);
    expect(deps.get().bySession[KEY].nativeActivity).toBe("running");
    expect(drainQueueLive).not.toHaveBeenCalled();
    // The CLI starts its turn: the guard is lifted and a later idle counts again.
    handleEngineEvents([event("activity", 3, { state: "running" })], deps);
    expect(deps.get().bySession[KEY].followUpAt).toBeNull();
    handleEngineEvents([event("activity", 4, { state: "waiting" })], deps);
    expect(deps.get().bySession[KEY].nativeActivity).toBe("waiting");
    expect(drainQueueLive).toHaveBeenCalledTimes(1);
  });

  it("seals an interrupted response without an error and without draining, and keeps the run live", () => {
    handleEngineEvents([
      event("activity", 1, { state: "running" }),
      event("tasks", 2, { tasks: [task()] }),
      event("delta", 3, "Partial"),
      event("turn_complete", 4, { usage: { input_tokens: 4, output_tokens: 1 }, interrupted: true }),
    ], deps);
    const state = deps.get().bySession[KEY];
    expect(state.error).toBeNull();
    expect(state.streaming).toBe(true);
    expect(state.interrupted).toBe(false);
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant", text: "Partial", live: false });
    expect(state.messages.at(-1)?.usage).toMatchObject({ input_tokens: 4 });
    expect(runRouting.get("native-run")).toBe(KEY);
    expect(deps.drainQueue).not.toHaveBeenCalled();
  });

  it("keeps a queue parked by an interrupt that left the run alive parked through the final done", () => {
    handleEngineEvents([event("delta", 1, "Working")], deps);
    patchKey({ queueParked: true, interruptRequestedAt: Date.now() });
    handleEngineEvents([event("done", 2, { usage: null })], deps);
    expect(deps.drainQueue).not.toHaveBeenCalled();
    expect(deps.get().bySession[KEY]).toMatchObject({ streaming: false, queueParked: false, interruptRequestedAt: null });
  });

  it("keeps it parked through a final error as well", () => {
    handleEngineEvents([event("delta", 1, "Working")], deps);
    patchKey({ queueParked: true });
    handleEngineEvents([event("error", 2, "native CLI exited")], deps);
    expect(deps.drainQueue).not.toHaveBeenCalled();
    expect(deps.get().bySession[KEY]).toMatchObject({ streaming: false, queueParked: false });
  });

  it("still drains an unparked queue at the final done", () => {
    handleEngineEvents([event("delta", 1, "Working"), event("done", 2, { usage: null })], deps);
    expect(deps.drainQueue).toHaveBeenCalledTimes(1);
  });
});

describe("a response's metadata belongs to the response's own rows", () => {
  const OLD_USAGE = { input_tokens: 100, output_tokens: 20 };
  const oldReply = {
    seq: 2, role: "assistant", text: "Earlier answer", ts: null,
    usage: OLD_USAGE, durationMs: 5000, model: "claude-old", effort: "low",
  };
  /** What the real CLI reports for an interrupted response (artifacts/claude-interrupt-probe.log). */
  const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const toolCall = (seq: number) => event("message", seq, { role: "tool", text: "Bash" });
  const rows = () => deps.get().bySession[KEY].messages;
  const before = {} as Pick<ReturnType<typeof useChatStore.getState>, "models" | "efforts">;

  beforeEach(() => {
    before.models = useChatStore.getState().models;
    before.efforts = useChatStore.getState().efforts;
    // This run's settings differ from the earlier reply's, so a stamp on the
    // wrong row is visible in every field.
    useChatStore.setState({
      models: { claude: "claude-new" },
      efforts: { claude: "high" },
      streamingByKey: { [KEY]: true },
      bySession: {
        [KEY]: {
          ...EMPTY_SESSION,
          streaming: true,
          usage: OLD_USAGE,
          turnStartedAt: Date.now(),
          messages: [
            { seq: 1, role: "user", text: "earlier", ts: null },
            oldReply,
            { seq: 3, role: "user", text: "this run's message", ts: null },
          ],
        },
        [OTHER]: { ...EMPTY_SESSION, messages: [] },
      },
    });
    vi.advanceTimersByTime(2000);
  });
  afterEach(() => useChatStore.setState({ models: before.models, efforts: before.efforts }));

  it.each<[string, Record<string, unknown>]>([
    ["zero usage", { usage: ZERO, interrupted: true }],
    ["null usage", { usage: null, interrupted: true }],
    ["absent usage", { interrupted: true }],
  ])("leaves the previous reply's footer and the context meter alone when the first response is interrupted before any text (%s)", (_name, payload) => {
    handleEngineEvents([
      event("activity", 1, { state: "running" }),
      event("tasks", 2, { tasks: [task()] }),
      toolCall(3),
      event("turn_complete", 4, payload),
    ], deps);
    expect(rows()[1]).toEqual(oldReply);
    expect(rows().map((row) => row.role)).toEqual(["user", "assistant", "user", "tool"]);
    expect(deps.get().bySession[KEY].usage).toEqual(OLD_USAGE);
    expect(ipc.usageRecord).not.toHaveBeenCalled();
    expect(deps.get().bySession[KEY].streaming).toBe(true);
  });

  it("does the same for an ordinary response that ends without text, and still takes its tokens", () => {
    handleEngineEvents([
      event("tasks", 1, { tasks: [task()] }),
      toolCall(2),
      event("turn_complete", 3, { usage: { input_tokens: 40, output_tokens: 6 } }),
    ], deps);
    expect(rows()[1]).toEqual(oldReply);
    // The report is real: the meter and the ledger take it, no row carries it.
    expect(deps.get().bySession[KEY].usage).toEqual({ input_tokens: 40, output_tokens: 6 });
    expect(ipc.usageRecord).toHaveBeenCalledTimes(1);
  });

  it("does the same for a final done that ends a run without any assistant text", () => {
    handleEngineEvents([toolCall(1), event("done", 2, { usage: { input_tokens: 40, output_tokens: 6 } })], deps);
    expect(rows()[1]).toEqual(oldReply);
    expect(deps.get().bySession[KEY].streaming).toBe(false);
  });

  it("does not ledger the earlier reply's occupancy for a final done that reported no tokens", () => {
    handleEngineEvents([toolCall(1), event("done", 2, { usage: null })], deps);
    expect(ipc.usageRecord).not.toHaveBeenCalled();
    expect(rows()[1]).toEqual(oldReply);
    expect(deps.get().bySession[KEY].usage).toEqual(OLD_USAGE);
  });

  it("stamps the next response that does have text, and still never the earlier run's reply", () => {
    handleEngineEvents([toolCall(1), event("turn_complete", 2, { usage: ZERO, interrupted: true })], deps);
    handleEngineEvents([
      event("delta", 3, "All set."),
      event("turn_complete", 4, { usage: { input_tokens: 50, output_tokens: 9 } }),
    ], deps);
    expect(rows()[1]).toEqual(oldReply);
    expect(rows().at(-1)).toMatchObject({
      role: "assistant", text: "All set.", live: false, model: "claude-new", effort: "high",
      usage: { input_tokens: 50, output_tokens: 9 },
    });
  });

  it("keeps a zero report off the interrupted reply's own row and off the meter, but still stamps the rest", () => {
    handleEngineEvents([event("delta", 1, "Partial"), event("turn_complete", 2, { usage: ZERO, interrupted: true })], deps);
    const row = rows().at(-1)!;
    expect(row).toMatchObject({ role: "assistant", text: "Partial", live: false, model: "claude-new", effort: "high", durationMs: 2000 });
    expect(row.usage).toBeUndefined();
    expect(rows()[1]).toEqual(oldReply);
    expect(deps.get().bySession[KEY].usage).toEqual(OLD_USAGE);
  });
});
