import { describe, expect, it } from "vitest";
import type { MissionFlowDefinition, MissionFlowNode } from "../types";
import { countRunUnits, countTasks, isTerminalTask } from "../types";
import {
  MissionScheduler,
  type MissionEngineEvent,
  type MissionExecutor,
  type MissionTaskContext,
} from "./scheduler";

/**
 * 调度器核心用例（M1 验收）：并发槽、等待不阻塞、失败重试上限、
 * 反馈只重跑分支、快照隔离。
 */

interface PendingCall {
  node: MissionFlowNode;
  context: MissionTaskContext;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

class ManualExecutor implements MissionExecutor {
  inputItems: Array<Record<string, unknown>> = [];
  calls: PendingCall[] = [];

  runInput(node: MissionFlowNode, context: MissionTaskContext): Promise<unknown> {
    return this.defer(node, context);
  }
  runTool(node: MissionFlowNode, context: MissionTaskContext): Promise<unknown> {
    return this.defer(node, context);
  }
  runAgent(node: MissionFlowNode, context: MissionTaskContext): Promise<unknown> {
    return this.defer(node, context);
  }

  private defer(node: MissionFlowNode, context: MissionTaskContext): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      this.calls.push({ node, context, resolve, reject });
    });
  }

  pending(nodeId: string): PendingCall[] {
    return this.calls.filter((call) => call.node.id === nodeId);
  }

  /** 解决所有等待中的指定节点，返回值可以是上下文的函数。 */
  resolveAll(nodeId: string, value: unknown | ((ctx: MissionTaskContext) => unknown)): number {
    const matching = this.pending(nodeId);
    this.calls = this.calls.filter((call) => !matching.includes(call));
    for (const call of matching) {
      call.resolve(
        typeof value === "function"
          ? (value as (ctx: MissionTaskContext) => unknown)(call.context)
          : value,
      );
    }
    return matching.length;
  }

  rejectAll(nodeId: string, message = "boom"): number {
    const matching = this.pending(nodeId);
    this.calls = this.calls.filter((call) => !matching.includes(call));
    for (const call of matching) call.reject(new Error(message));
    return matching.length;
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function flowNode(
  id: string,
  type: MissionFlowNode["type"],
  config: Partial<MissionFlowNode> = {},
): MissionFlowNode {
  return { id, type, title: id, position: { x: 0, y: 0 }, ...config };
}

/** 测试流程：source -> foreach(analyze -> route -> human/archive) -> summary。 */
function buildFlow(options: {
  count: number;
  concurrency: number;
  retries?: number;
}): MissionFlowDefinition {
  return {
    version: 1,
    name: "test flow",
    goal: "test",
    settings: {
      concurrency: options.concurrency,
      retries: options.retries ?? 1,
      approval: "risk",
      verification: false,
    },
    nodes: [
      flowNode("source", "input", {
        input: { capabilityId: "demo.repo.pullRequests" },
      }),
      flowNode("review", "foreach", {
        foreach: {
          over: "source",
          concurrency: options.concurrency,
          body: {
            nodes: [
              flowNode("analyze", "agent", { agent: { instruction: "analyze" } }),
              flowNode("route", "agent", { agent: { instruction: "route" } }),
              flowNode("review_human", "human", { human: { ask: "confirm" } }),
              flowNode("archive", "output", { output: { artifact: "opinion" } }),
            ],
            edges: [
              { id: "e1", from: "analyze", to: "route" },
              { id: "e2", from: "route", to: "review_human", condition: "risk=high" },
              { id: "e3", from: "route", to: "archive" },
            ],
          },
        },
      }),
      flowNode("summary", "output", { output: { artifact: "summary" } }),
    ],
    edges: [
      { id: "e-source", from: "source", to: "review" },
      { id: "e-summary", from: "review", to: "summary" },
    ],
  };
}

function harness(options: { count: number; concurrency: number; retries?: number }) {
  const executor = new ManualExecutor();
  executor.inputItems = Array.from({ length: options.count }, (_, index) => ({
    index,
    label: `item-${index + 1}`,
    risk: index % 3 === 0 ? "high" : "low",
  }));
  const events: MissionEngineEvent[] = [];
  let idSeq = 0;
  const scheduler = new MissionScheduler({
    executor,
    emit: (event) => events.push(event),
    onRunChanged: () => {},
    now: () => 1000 + idSeq,
    newId: (prefix) => `${prefix}-${++idSeq}`,
  });
  const flow = buildFlow(options);
  const run = scheduler.createRun(flow, "flow-1", "test flow");
  return { executor, events, scheduler, flow, run };
}

async function startAndExpand(context: ReturnType<typeof harness>): Promise<void> {
  context.scheduler.start(context.run);
  context.executor.resolveAll("source", context.executor.inputItems);
  await flush();
}

describe("MissionScheduler concurrency", () => {
  it("never runs more tasks than the concurrency limit", async () => {
    const context = harness({ count: 6, concurrency: 2 });
    await startAndExpand(context);

    const running = context.run.tasks.filter((task) => task.status === "running");
    expect(running).toHaveLength(2);
    expect(running.every((task) => task.nodeId === "analyze")).toBe(true);
    expect(countTasks(context.run).queued).toBeGreaterThan(0);
  });

  it("waiting_human frees its slot and does not block other items", async () => {
    const context = harness({ count: 4, concurrency: 1 });
    await startAndExpand(context);

    // item-1（高风险）逐级推进到人工确认。
    context.executor.resolveAll("analyze", { ok: true });
    await flush();
    context.executor.resolveAll("route", (ctx: MissionTaskContext) => ({
      risk: (ctx.item?.value as { risk: string }).risk,
    }));
    await flush();

    const waiting = context.run.tasks.filter((task) => task.status === "waiting_human");
    expect(waiting).toHaveLength(1);
    expect(waiting[0].itemLabel).toBe("item-1");

    // 槽位释放后，后面的项目继续开工（单并发也照样推进）。
    const running = context.run.tasks.filter((task) => task.status === "running");
    expect(running).toHaveLength(1);
    expect(running[0].itemLabel).toBe("item-2");

    // 排队的项目不会因为一个等待而冻结。
    context.executor.resolveAll("analyze", { ok: true });
    await flush();
    context.executor.resolveAll("route", (ctx: MissionTaskContext) => ({
      risk: (ctx.item?.value as { risk: string }).risk,
    }));
    await flush();
    expect(context.run.tasks.filter((task) => task.status === "waiting_human").length).toBeGreaterThanOrEqual(1);
  });

  it("locks the low-risk branch to archive and cancels the human branch", async () => {
    const context = harness({ count: 1, concurrency: 1 });
    await startAndExpand(context);
    context.executor.resolveAll("analyze", { ok: true });
    await flush();
    context.executor.resolveAll("route", { risk: "low" });
    await flush();

    const tasksForItem = context.run.tasks.filter((task) => task.itemId !== null);
    const human = tasksForItem.find((task) => task.nodeId === "review_human");
    const archive = tasksForItem.find((task) => task.nodeId === "archive");
    expect(human?.status).toBe("cancelled");
    expect(archive?.status).toBe("succeeded");

    // 项全部终结后汇总执行；output 在同一次收敛内完成，运行随之终结。
    const summary = context.run.tasks.find((task) => task.nodeId === "summary");
    expect(summary?.status).toBe("succeeded");
    expect(context.run.endedAt).toBeDefined();
  });
});

describe("MissionScheduler recovery", () => {
  it("retries automatically up to the limit, then escalates to failed", async () => {
    const context = harness({ count: 1, concurrency: 1, retries: 1 });
    await startAndExpand(context);

    context.executor.rejectAll("analyze", "first failure");
    await flush();
    let analyze = context.run.tasks.find((task) => task.nodeId === "analyze")!;
    // 自动重试：重新排队后立即占用空闲槽位再次执行。
    expect(analyze.status).toBe("running");
    expect(analyze.attempt).toBe(2);
    expect(context.events.some((event) => event.kind === "auto_retry")).toBe(true);

    // 第二次仍失败，超过重试上限 → failed，等待人工恢复。
    context.executor.rejectAll("analyze", "second failure");
    await flush();
    analyze = context.run.tasks.find((task) => task.nodeId === "analyze")!;
    expect(analyze.status).toBe("failed");
    expect(analyze.attempt).toBe(2);
    expect(context.events.some((event) => event.kind === "failed")).toBe(true);

    // 人工重试只重跑该阶段，不动其他任务。
    expect(context.scheduler.retryTask(context.run, analyze.id).ok).toBe(true);
    await flush();
    expect(context.executor.pending("analyze")).toHaveLength(1);
    context.executor.resolveAll("analyze", { ok: true });
    await flush();
    expect(analyze.status).toBe("succeeded");
  });

  it("feedback requeues the item branch and asks for a fresh decision", async () => {
    const context = harness({ count: 1, concurrency: 1 });
    await startAndExpand(context);
    context.executor.resolveAll("analyze", { ok: true });
    await flush();
    context.executor.resolveAll("route", { risk: "high" });
    await flush();

    const human = context.run.tasks.find((task) => task.nodeId === "review_human")!;
    expect(human.status).toBe("waiting_human");
    const result = context.scheduler.resolveDecision(context.run, human.id, {
      kind: "feedback",
      text: "补充权限测试证据",
    });
    expect(result.ok).toBe(true);

    // 分支上游重新排队并立即重新执行；human 等待新的分析结果。
    const analyze = context.run.tasks.find((task) => task.nodeId === "analyze")!;
    expect(analyze.status).toBe("running");
    expect(human.status).toBe("queued");
    expect(human.round).toBe(1);
    expect(human.feedback).toEqual(["补充权限测试证据"]);
    expect(human.forceApproval).toBe(true);

    context.executor.resolveAll("analyze", { ok: true });
    await flush();
    context.executor.resolveAll("route", { risk: "high" });
    await flush();
    expect(human.status).toBe("waiting_human");
    expect(human.round).toBe(1);
    const attentionEvents = context.events.filter((event) => event.kind === "attention");
    expect(attentionEvents).toHaveLength(2);
  });

  it("explicit exclusion terminates a branch without pretending success", async () => {
    const context = harness({ count: 1, concurrency: 1 });
    await startAndExpand(context);
    context.executor.resolveAll("analyze", { ok: true });
    await flush();
    context.executor.resolveAll("route", { risk: "high" });
    await flush();

    const human = context.run.tasks.find((task) => task.nodeId === "review_human")!;
    expect(context.scheduler.resolveDecision(context.run, human.id, { kind: "exclude" }).ok).toBe(true);
    await flush();
    expect(human.status).toBe("excluded");
    expect(context.events.some((event) => event.kind === "item_excluded")).toBe(true);
    expect(context.events.some((event) => event.kind === "item_done")).toBe(false);
    // 排除计入例外清单，而不是假装完成。
    expect(countRunUnits(context.run).excluded).toBe(1);
    expect(countRunUnits(context.run).done).toBe(0);
  });
});

describe("MissionScheduler isolation", () => {
  it("keeps the run snapshot after the draft settings change", async () => {
    const context = harness({ count: 4, concurrency: 2 });
    context.scheduler.start(context.run);
    context.executor.resolveAll("source", context.executor.inputItems);
    await flush();

    // 修改“草稿”（原对象）不应影响已启动运行的快照。
    context.flow.settings.concurrency = 1;
    context.flow.settings.retries = 3;

    expect(context.run.snapshot.settings.concurrency).toBe(2);
    expect(context.run.snapshot.settings.retries).toBe(1);
    expect(context.run.tasks.filter((task) => task.status === "running")).toHaveLength(2);
  });

  it("cancels unfinished instances and ignores late executor results", async () => {
    const context = harness({ count: 4, concurrency: 2 });
    await startAndExpand(context);
    const running = context.run.tasks.filter((task) => task.status === "running");
    expect(running.length).toBe(2);

    context.scheduler.cancel(context.run);
    expect(context.run.cancelled).toBe(true);
    expect(context.run.tasks.every((task) => isTerminalTask(task.status))).toBe(true);

    // 晚到的成功结果不会把已取消的任务改回成功。
    context.executor.resolveAll("analyze", { ok: true });
    await flush();
    expect(running.every((task) => task.status === "cancelled")).toBe(true);
  });

  it("does not finish the run while any item is waiting or failed", async () => {
    const context = harness({ count: 2, concurrency: 2 });
    await startAndExpand(context);
    context.executor.resolveAll("analyze", { ok: true });
    await flush();
    context.executor.resolveAll("route", { risk: "low" });
    await flush();

    // 两低风险项归档后汇总应自动完成；插入一个等待项验证阻塞语义。
    const waitingRun = harness({ count: 1, concurrency: 1 });
    await startAndExpand(waitingRun);
    waitingRun.executor.resolveAll("analyze", { ok: true });
    await flush();
    waitingRun.executor.resolveAll("route", { risk: "high" });
    await flush();
    expect(waitingRun.run.endedAt).toBeUndefined();
    const summary = waitingRun.run.tasks.find((task) => task.nodeId === "summary");
    expect(summary?.status).toBe("queued");
  });
});
