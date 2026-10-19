import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyInterruptedSemantics,
  initMissionPersistence,
  loadMissionState,
  MISSION_STORAGE_KEY,
  saveMissionState,
  type MissionPersistedState,
} from "./persistence";
import { resetMissionStore, useMissionStore } from "./store";
import type { MissionFlow, MissionRun, MissionTaskInstance } from "./types";

/**
 * M4 前端切片：持久化回放 + 中断收敛语义。
 * 退出应用后未完成的运行不假装仍在执行；真正的跨重启续跑需要 Rust 调度器。
 */

function task(status: MissionTaskInstance["status"], id = "t1"): MissionTaskInstance {
  return {
    id,
    runId: "run-1",
    nodeId: "n1",
    title: "节点",
    status,
    attempt: 1,
    round: 0,
    feedback: [],
    approved: false,
    forceApproval: false,
    itemId: null,
    itemLabel: null,
    parentTaskId: null,
  };
}

function run(overrides: Partial<MissionRun>): MissionRun {
  return {
    id: "run-1",
    flowId: "flow-1",
    flowName: "测试流程",
    snapshot: {
      version: 1,
      name: "测试流程",
      goal: "g",
      settings: { concurrency: 3, retries: 1, approval: "risk", verification: false },
      nodes: [],
      edges: [],
    },
    tasks: [],
    startedAt: 1,
    ...overrides,
  };
}

function flow(): MissionFlow {
  return {
    id: "flow-1",
    name: "测试流程",
    goal: "g",
    draft: null,
    versions: [],
    runIds: ["run-1"],
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("applyInterruptedSemantics", () => {
  it("converges unfinished runs and tasks to interrupted/cancelled", () => {
    const [converged] = applyInterruptedSemantics(
      [run({ tasks: [task("running"), task("queued", "t2"), task("waiting_human", "t3")] })],
      () => 42,
    );
    expect(converged.interrupted).toBe(true);
    expect(converged.cancelled).toBe(true);
    expect(converged.endedAt).toBe(42);
    expect(converged.tasks.map((row) => row.status)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
  });

  it("leaves finished runs and their results untouched", () => {
    const finished = run({
      endedAt: 10,
      tasks: [
        { ...task("succeeded"), output: { artifact: "报告" } },
        task("excluded", "t2"),
      ],
    });
    const [kept] = applyInterruptedSemantics([finished], () => 42);
    expect(kept).toEqual(finished);
    expect(kept.interrupted).toBeUndefined();
  });
});

describe("persistence storage", () => {
  it("round-trips flows, runs and inbox", () => {
    const state: MissionPersistedState = {
      version: 1,
      flows: [flow()],
      runs: [run({ endedAt: 2, tasks: [task("succeeded")] })],
      inbox: [
        {
          id: "n1",
          flowId: "flow-1",
          runId: "run-1",
          nodeKey: "output",
          type: "done",
          title: "完成",
          body: "b",
          read: true,
          resolved: true,
          createdAt: 3,
          dedupeKey: "run-completed:run-1",
        },
      ],
    };
    saveMissionState(state);
    const loaded = loadMissionState();
    expect(loaded?.flows).toHaveLength(1);
    expect(loaded?.runs).toHaveLength(1);
    expect(loaded?.inbox).toHaveLength(1);
    expect(loaded?.runs[0].tasks[0].status).toBe("succeeded");
  });

  it("returns null and warns on corrupt storage instead of throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem(MISSION_STORAGE_KEY, "{not json");
    expect(loadMissionState()).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("keeps only the newest five runs per flow", () => {
    const runs = Array.from({ length: 7 }, (_, index) =>
      run({ id: `run-${index + 1}`, endedAt: index + 1 }),
    );
    saveMissionState({ version: 1, flows: [flow()], runs, inbox: [] });
    const loaded = loadMissionState();
    expect(loaded?.runs).toHaveLength(5);
    expect(loaded?.runs.map((row) => row.id)).toEqual([
      "run-3",
      "run-4",
      "run-5",
      "run-6",
      "run-7",
    ]);
  });

  it("round-trips the pinned execution config and drops a corrupted one", () => {
    saveMissionState({
      version: 1,
      flows: [
        {
          ...flow(),
          execution: {
            engine: "claude",
            workspacePath: "/w1",
            model: "model-a",
            providerId: "channel-1",
            effort: "high",
          },
        },
      ],
      runs: [],
      inbox: [],
    });
    const loaded = loadMissionState();
    expect(loaded?.flows[0].execution?.engine).toBe("claude");
    expect(loaded?.flows[0].execution?.model).toBe("model-a");

    localStorage.setItem(
      MISSION_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        flows: [{ ...flow(), execution: { engine: 42 } }],
        runs: [],
        inbox: [],
      }),
    );
    const degraded = loadMissionState();
    expect(degraded?.flows).toHaveLength(1);
    expect(degraded?.flows[0].execution).toBeNull();
  });
});

describe("initMissionPersistence", () => {
  it("hydrates the store with interrupted runs and selects the latest one", () => {
    resetMissionStore();
    saveMissionState({
      version: 1,
      flows: [flow()],
      runs: [run({ tasks: [task("running")] })],
      inbox: [],
    });
    const loaded = loadMissionState()!;
    useMissionStore.getState().hydrate({
      flows: loaded.flows,
      runs: loaded.runs,
      inbox: loaded.inbox,
    });
    const state = useMissionStore.getState();
    expect(state.runs["run-1"].interrupted).toBe(true);
    expect(state.runs["run-1"].tasks[0].status).toBe("cancelled");
    expect(state.selectedFlowId).toBe("flow-1");
    expect(state.selectedRunId).toBe("run-1");
    expect(state.canvasMode).toBe("run");
  });

  it("hydrates on bind and persists store changes after the debounce", () => {
    vi.useFakeTimers();
    let flows: MissionFlow[] = [];
    let runs: Record<string, MissionRun> = {};
    let inbox: MissionPersistedState["inbox"] = [];
    const listeners = new Set<() => void>();
    const bound = initMissionPersistence({
      load: () => null,
      save: saveMissionState,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      snapshot: () => ({ flows, runs, inbox }),
    });
    expect(bound.hydrated).toBeNull();

    flows = [flow()];
    runs = { "run-1": run({ endedAt: 2 }) };
    for (const listener of listeners) listener();
    expect(localStorage.getItem(MISSION_STORAGE_KEY)).toBeNull();
    vi.advanceTimersByTime(500);
    expect(localStorage.getItem(MISSION_STORAGE_KEY)).not.toBeNull();
    expect(loadMissionState()?.flows).toHaveLength(1);

    bound.dispose();
    flows = [];
    for (const listener of listeners) listener();
    vi.advanceTimersByTime(500);
    // 解绑后不再写盘：仍是上一份数据。
    expect(loadMissionState()?.flows).toHaveLength(1);
  });
});
