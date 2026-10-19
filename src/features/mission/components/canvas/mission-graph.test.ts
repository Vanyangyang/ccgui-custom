import { describe, expect, it } from "vitest";
import { buildPrReviewDemoFlow } from "../../builtin/pr-review";
import { MissionScheduler } from "../../engine/scheduler";
import { createSimulatedExecutor } from "../../engine/simulated";
import type { MissionRun, MissionTaskInstance, MissionTaskStatus } from "../../types";
import {
  buildMissionCanvas,
  deriveRunItems,
  runStatusForNode,
  unitStatusOfTasks,
  type MissionDefinitionNodeData,
  type MissionItemNodeData,
} from "./mission-graph";

/**
 * M2 画布数据映射回归：定义视图（组 + 子流程节点）、运行视图（每项任务
 * 卡），以及状态聚合优先级。交互行为对齐 mission-native.html 的语义。
 */

async function runDemoToAttention(): Promise<{ run: MissionRun; definition: ReturnType<typeof buildPrReviewDemoFlow> }> {
  const definition = buildPrReviewDemoFlow();
  const scheduler = new MissionScheduler({
    executor: createSimulatedExecutor({ delayMs: 0 }),
    emit: () => {},
    onRunChanged: () => {},
    now: () => Date.now(),
    newId: (prefix) => `${prefix}-1`,
  });
  const run = scheduler.createRun(definition, "flow-1", definition.name);
  scheduler.start(run);
  for (let step = 0; step < 500; step++) {
    if (run.tasks.every((task) => task.status !== "running")) break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return { run, definition };
}

function makeTask(status: MissionTaskStatus): MissionTaskInstance {
  return {
    id: `t-${status}`,
    runId: "r",
    nodeId: "n",
    title: status,
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

describe("unitStatusOfTasks", () => {
  it("prioritizes failure over waiting over running over done", () => {
    expect(unitStatusOfTasks([makeTask("succeeded"), makeTask("running")])).toBe("running");
    expect(unitStatusOfTasks([makeTask("running"), makeTask("waiting_human")])).toBe("waiting_human");
    expect(unitStatusOfTasks([makeTask("waiting_human"), makeTask("failed")])).toBe("failed");
    expect(unitStatusOfTasks([makeTask("succeeded"), makeTask("excluded")])).toBe("excluded");
    expect(unitStatusOfTasks([makeTask("succeeded"), makeTask("succeeded")])).toBe("succeeded");
  });
});

describe("buildMissionCanvas", () => {
  it("renders the definition graph with a foreach group and body nodes", () => {
    const definition = buildPrReviewDemoFlow();
    const canvas = buildMissionCanvas({
      definition,
      run: null,
      mode: "definition",
      selectedNodeKey: null,
      issues: [],
    });
    const group = canvas.nodes.find((node) => node.id === "node:review");
    expect(group?.type).toBe("missionGroup");
    const bodyIds = canvas.nodes
      .filter((node) => node.parentId === "node:review")
      .map((node) => node.id);
    expect(bodyIds).toEqual(
      expect.arrayContaining([
        "body:review:analyze",
        "body:review:verify",
        "body:review:route",
        "body:review:review_human",
        "body:review:archive",
      ]),
    );
    expect(canvas.nodes.some((node) => node.type === "missionItem")).toBe(false);
    // 顶层连线 + 子流程连线都在。
    expect(canvas.edges.some((edge) => edge.id === "edge:e-source-review")).toBe(true);
    expect(canvas.edges.some((edge) => edge.id === "edge:e-review-summary")).toBe(true);
    expect(canvas.edges.some((edge) => edge.source === "body:review:route")).toBe(true);
  });

  it("expands each item into a task card in the run view with real states", async () => {
    const { run, definition } = await runDemoToAttention();
    const canvas = buildMissionCanvas({
      definition,
      run,
      mode: "run",
      selectedNodeKey: null,
      issues: [],
    });
    const items = canvas.nodes.filter((node) => node.type === "missionItem");
    expect(items).toHaveLength(30);
    const states = items.map((node) => (node.data as MissionItemNodeData).item.status);
    expect(states.filter((status) => status === "waiting_human")).toHaveLength(5);
    expect(states.filter((status) => status === "failed")).toHaveLength(1);
    expect(states.filter((status) => status === "succeeded")).toHaveLength(24);
    // 等待/失败不阻塞其他项：仍有很多项已终结。
    const group = canvas.nodes.find((node) => node.id === "node:review");
    expect(group?.type).toBe("missionGroup");
  });

  it("selects the item card that owns the selected task instance", async () => {
    const { run, definition } = await runDemoToAttention();
    const waiting = run.tasks.find((task) => task.status === "waiting_human")!;
    const canvas = buildMissionCanvas({
      definition,
      run,
      mode: "run",
      selectedNodeKey: `task:${waiting.id}`,
      issues: [],
    });
    const selected = canvas.nodes.filter(
      (node) => node.type === "missionItem" && (node.data as MissionItemNodeData).selected,
    );
    expect(selected).toHaveLength(1);
    expect(
      (selected[0].data as MissionItemNodeData).item.tasks.some((task) => task.id === waiting.id),
    ).toBe(true);
  });

  it("marks unavailable capability nodes from validation issues", () => {
    const definition = buildPrReviewDemoFlow();
    const canvas = buildMissionCanvas({
      definition,
      run: null,
      mode: "definition",
      selectedNodeKey: null,
      issues: [
        { code: "unavailableTool", severity: "unavailable", nodeId: "verify", params: {} },
      ],
    });
    const verify = canvas.nodes.find((node) => node.id === "body:review:verify");
    expect((verify?.data as MissionDefinitionNodeData).unavailableReason).toBe("unavailableTool");
  });

  it("aggregates foreach child status onto the definition node", async () => {
    const { run, definition } = await runDemoToAttention();
    const review = definition.nodes.find((node) => node.id === "review")!;
    expect(runStatusForNode(run, review)).toBe("failed");
    const items = deriveRunItems(run, "review");
    expect(items).toHaveLength(30);
    expect(items.filter((item) => item.status === "waiting_human")).toHaveLength(5);
  });
});
