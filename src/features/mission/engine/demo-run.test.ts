import { describe, expect, it } from "vitest";
import { buildPrReviewDemoFlow } from "../builtin/pr-review";
import { countRunUnits, type MissionRun } from "../types";
import { MissionScheduler, type MissionEngineEvent } from "./scheduler";
import { createSimulatedExecutor } from "./simulated";

/**
 * 内置演示流程端到端（M1 验收）：
 * 启动 → 并发执行（≤5）→ 失败自动重试 → 超限进收件箱 → 人工确认/恢复 → 汇总。
 */

/** 等所有在途（running）任务落地；阻塞在人工/失败上的 queued 不算未收敛。 */
async function drain(run: MissionRun, maxSteps = 2000): Promise<number> {
  let maxRunning = 0;
  for (let step = 0; step < maxSteps; step++) {
    maxRunning = Math.max(maxRunning, run.tasks.filter((task) => task.status === "running").length);
    if (run.tasks.every((task) => task.status !== "running")) return maxRunning;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("run did not settle");
}

function makeHarness() {
  const events: MissionEngineEvent[] = [];
  let sequence = 0;
  const scheduler = new MissionScheduler({
    executor: createSimulatedExecutor({ delayMs: 0 }),
    emit: (event) => events.push(event),
    onRunChanged: () => {},
    now: () => Date.now(),
    newId: (prefix) => `${prefix}-${++sequence}`,
  });
  const flow = buildPrReviewDemoFlow();
  const run = scheduler.createRun(flow, "flow-builtin-pr-review", flow.name);
  return { events, scheduler, flow, run };
}

describe("built-in PR review demo", () => {
  it("runs with bounded concurrency, retries failures and waits for humans", async () => {
    const { events, scheduler, run } = makeHarness();
    scheduler.start(run);
    const maxRunning = await drain(run);

    expect(maxRunning).toBeLessThanOrEqual(run.snapshot.settings.concurrency);
    expect(countRunUnits(run).total).toBe(30);
    // 演示数据：index % 7 === 0 为高风险 → 5 项等待人工。
    expect(countRunUnits(run).waiting).toBe(5);
    // index 23 两次失败，重试上限 1 → 1 项升级为失败。
    expect(countRunUnits(run).failed).toBe(1);
    // 等待与失败阻塞汇总：所有分支终结前运行不结束。
    expect(run.endedAt).toBeUndefined();
    const summary = run.tasks.find((task) => task.nodeId === "summary")!;
    expect(summary.status).toBe("queued");
    // 自动重试事件：index 11 与 index 23 各一次。
    expect(events.filter((event) => event.kind === "auto_retry")).toHaveLength(2);

    // 人工处理每一条等待/失败消息（按收件箱动作的同一路径）。
    for (const task of run.tasks) {
      if (task.status === "waiting_human") {
        expect(scheduler.resolveDecision(run, task.id, { kind: "approve" }).ok).toBe(true);
      }
    }
    const failedTask = run.tasks.find((task) => task.status === "failed")!;
    expect(scheduler.retryTask(run, failedTask.id).ok).toBe(true);
    await drain(run);

    expect(run.endedAt).toBeDefined();
    expect(countRunUnits(run).done).toBe(30);
    expect(countRunUnits(run).excluded).toBe(0);
    expect(summary.status).toBe("succeeded");
    const output = summary.output as { artifact: string; items: unknown[]; counts: { done: number } };
    expect(output.artifact).toBe("审查结果与例外清单");
    expect(output.items).toHaveLength(30);
    expect(output.counts.done).toBe(30);
    expect(events.some((event) => event.kind === "run_done")).toBe(true);
    // 安全边界：流程里没有任何外部写入能力。
    expect(run.snapshot.nodes.some((node) => node.type === "output")).toBe(true);
  });

  it("keeps an explicitly excluded item in the exception list", async () => {
    const { scheduler, run } = makeHarness();
    scheduler.start(run);
    await drain(run);

    const waiting = run.tasks.find((task) => task.status === "waiting_human")!;
    expect(scheduler.resolveDecision(run, waiting.id, { kind: "exclude" }).ok).toBe(true);
    for (const task of run.tasks) {
      if (task.status === "waiting_human") {
        expect(scheduler.resolveDecision(run, task.id, { kind: "approve" }).ok).toBe(true);
      }
      if (task.status === "failed") {
        expect(scheduler.retryTask(run, task.id).ok).toBe(true);
      }
    }
    await drain(run);

    expect(run.endedAt).toBeDefined();
    expect(countRunUnits(run).excluded).toBe(1);
    expect(countRunUnits(run).done).toBe(29);
    const summary = run.tasks.find((task) => task.nodeId === "summary")!;
    const output = summary.output as { counts: { excluded: number } };
    expect(output.counts.excluded).toBe(1);
  });

  it("does not advance unfinished work after cancellation", async () => {
    const { scheduler, run } = makeHarness();
    scheduler.start(run);
    await drain(run);
    scheduler.cancel(run);
    expect(run.cancelled).toBe(true);
    const waiting = run.tasks.find((task) => task.status === "waiting_human");
    // 取消后等待项也收敛为终态，不会悬挂。
    expect(waiting).toBeUndefined();
    expect(run.tasks.every((task) => ["succeeded", "failed", "cancelled", "excluded"].includes(task.status))).toBe(true);
  });
});
