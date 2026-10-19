import type {
  MissionFlowDefinition,
  MissionFlowEdge,
  MissionFlowNode,
  MissionFlowSettings,
  MissionHumanDecision,
  MissionRun,
  MissionTaskInstance,
  MissionTaskStatus,
} from "../types";
import { countRunUnits, isTerminalTask, type MissionUnitCounts } from "../types";
import { evaluateCondition, isDefaultCondition } from "./conditions";

/**
 * 调度器（纯 TS，可单测）：
 *  - 依赖调度：上游全部成功才放行下游；
 *  - foreach 在运行时按数据展开为 N 个任务实例，限制并发槽；
 *  - human 节点挂起实例（waiting_human 不占槽、不阻塞其他实例）；
 *  - 失败按重试次数自动重试，超限进入 failed，等待人工恢复；
 *  - 反馈只重置对应分支，不重跑全部；
 *  - 运行保存启动时的规则快照，与草稿版本隔离。
 *
 * 引擎只调用注入的 executor；不直接接触网络、模型或收件箱存储。
 */

export interface MissionTaskContext {
  run: MissionRun;
  task: MissionTaskInstance;
  settings: MissionFlowSettings;
  /** 同作用域的直接上游输出，按 nodeId 索引。 */
  upstream: Record<string, unknown>;
  /** foreach 项（子任务）。 */
  item?: { id: string; label: string; value: unknown };
}

export interface MissionExecutor {
  runInput(node: MissionFlowNode, ctx: MissionTaskContext): Promise<unknown>;
  runTool(node: MissionFlowNode, ctx: MissionTaskContext): Promise<unknown>;
  runAgent(node: MissionFlowNode, ctx: MissionTaskContext): Promise<unknown>;
  /** 可选：任务被取消/分支被重置时释放外部资源（如中断 agent 进程）。 */
  cancelTask?(taskId: string): void;
}

export type MissionEngineEvent =
  | { kind: "attention"; run: MissionRun; task: MissionTaskInstance; forceApproval: boolean }
  | { kind: "auto_retry"; run: MissionRun; task: MissionTaskInstance; retries: number }
  | { kind: "failed"; run: MissionRun; task: MissionTaskInstance }
  | { kind: "item_done"; run: MissionRun; task: MissionTaskInstance; approved: boolean }
  | { kind: "item_excluded"; run: MissionRun; task: MissionTaskInstance }
  | { kind: "run_done"; run: MissionRun; counts: MissionUnitCounts };

export interface MissionSchedulerHost {
  executor: MissionExecutor;
  emit(event: MissionEngineEvent): void;
  /** 状态变化后推送快照（调用方负责克隆/存储）。 */
  onRunChanged(run: MissionRun): void;
  now(): number;
  newId(prefix: string): string;
}

function cloneDefinition(flow: MissionFlowDefinition): MissionFlowDefinition {
  return structuredClone(flow);
}

function cloneRun(run: MissionRun): MissionRun {
  return structuredClone(run);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 输出展开成条件上下文：对象直接铺开，其他放进 value/output。 */
function outputContext(output: unknown): Record<string, unknown> {
  if (isObject(output)) return { ...output, output };
  return { value: output, output };
}

export class MissionScheduler {
  private readonly host: MissionSchedulerHost;
  /** 每次任务执行的令牌：防止被取消/重试后旧 promise 的晚到结果污染状态。 */
  private readonly executions = new Map<string, number>();
  private executionSeq = 0;
  /** 已经发过终结消息的 item（按 runId + itemId + round）。 */
  private readonly itemNotices = new Set<string>();

  constructor(host: MissionSchedulerHost) {
    this.host = host;
  }

  /** 用流程草稿生成一次运行：深拷贝快照，隔离后续草稿修改。 */
  createRun(
    flow: MissionFlowDefinition,
    flowId: string,
    flowName: string,
    execution?: MissionRun["execution"],
  ): MissionRun {
    return {
      id: this.host.newId("run"),
      flowId,
      flowName,
      snapshot: cloneDefinition(flow),
      execution: execution ?? null,
      tasks: [],
      startedAt: this.host.now(),
    };
  }

  /** 启动：为每个顶层节点建任务，然后调度。 */
  start(run: MissionRun): void {
    if (run.tasks.length > 0) return;
    for (const node of run.snapshot.nodes) {
      run.tasks.push(this.makeTask(run, node, null, null));
    }
    this.settle(run);
  }

  cancel(run: MissionRun): void {
    if (run.endedAt !== undefined) return;
    run.cancelled = true;
    run.endedAt = this.host.now();
    for (const task of run.tasks) {
      if (!isTerminalTask(task.status)) {
        task.status = "cancelled";
        task.endedAt = run.endedAt;
        this.executions.delete(task.id);
        this.host.executor.cancelTask?.(task.id);
      }
    }
    this.host.onRunChanged(cloneRun(run));
  }

  /** 演示/测试：让一个正在执行的任务失败（走到同一恢复路径）。 */
  injectFailure(run: MissionRun): boolean {
    const task = run.tasks.find((item) => item.status === "running");
    if (!task) return false;
    this.handleFailure(run, task, "injected demo failure");
    this.settle(run);
    return true;
  }

  /** 人工决定：批准 / 反馈重做 / 排除 / 重试失败阶段。 */
  resolveDecision(
    run: MissionRun,
    taskId: string,
    decision: MissionHumanDecision,
  ): { ok: boolean; error?: string } {
    const task = run.tasks.find((item) => item.id === taskId);
    if (!task) return { ok: false, error: "task not found" };
    if (run.cancelled || run.endedAt !== undefined) return { ok: false, error: "run is not active" };

    switch (decision.kind) {
      case "approve": {
        if (task.status !== "waiting_human") return { ok: false, error: "task is not waiting" };
        task.approved = true;
        task.status = "succeeded";
        task.endedAt = this.host.now();
        this.emitItemTerminals(run);
        break;
      }
      case "feedback": {
        if (task.status !== "waiting_human") return { ok: false, error: "task is not waiting" };
        const text = decision.text.trim();
        if (!text) return { ok: false, error: "feedback is empty" };
        task.feedback.push(text);
        task.round += 1;
        task.approved = false;
        task.forceApproval = true;
        this.resetBranchUpstream(run, task);
        task.status = "queued";
        task.endedAt = undefined;
        break;
      }
      case "exclude": {
        if (task.status !== "waiting_human" && task.status !== "failed") {
          return { ok: false, error: "task cannot be excluded in this state" };
        }
        this.excludeBranch(run, task);
        this.emitItemTerminals(run);
        break;
      }
    }
    this.settle(run);
    return { ok: true };
  }

  /** 重试一个 failed 任务（只重跑该阶段；这是一次新的尝试）。 */
  retryTask(run: MissionRun, taskId: string): { ok: boolean; error?: string } {
    const task = run.tasks.find((item) => item.id === taskId);
    if (!task) return { ok: false, error: "task not found" };
    if (task.status !== "failed") return { ok: false, error: "task is not failed" };
    task.status = "queued";
    task.attempt += 1;
    task.error = undefined;
    this.settle(run);
    return { ok: true };
  }

  // ── 内部：调度循环 ─────────────────────────────────────────────────────

  /** 一次收敛：先取消不可达任务，再按槽位启动就绪任务，最后检查完成。 */
  private settle(run: MissionRun): void {
    if (run.cancelled || run.endedAt !== undefined) return;

    let changed = true;
    while (changed) {
      changed = false;
      for (const task of run.tasks) {
        if (task.status === "queued" && this.isUnreachable(run, task)) {
          task.status = "cancelled";
          task.endedAt = this.host.now();
          this.executions.delete(task.id);
          changed = true;
        }
      }
    }

    let progressed = true;
    while (progressed && !run.cancelled && run.endedAt === undefined) {
      progressed = false;
      let available = run.snapshot.settings.concurrency - this.runningCount(run);
      for (const task of run.tasks) {
        if (task.status !== "queued") continue;
        if (!this.isReady(run, task)) continue;
        if (task.status === "queued" && this.isHumanTask(run, task)) {
          this.startHumanTask(run, task);
          progressed = true;
          continue;
        }
        if (available <= 0) break;
        this.startTask(run, task);
        available -= 1;
        progressed = true;
      }
    }

    this.emitItemTerminals(run);
    this.maybeFinish(run);
    this.host.onRunChanged(cloneRun(run));
  }

  private runningCount(run: MissionRun): number {
    return run.tasks.reduce((sum, task) => sum + (task.status === "running" ? 1 : 0), 0);
  }

  private maybeFinish(run: MissionRun): void {
    if (run.endedAt !== undefined || run.cancelled) return;
    if (run.tasks.length === 0) return;
    if (run.tasks.some((task) => !isTerminalTask(task.status))) return;
    run.endedAt = this.host.now();
    this.host.emit({ kind: "run_done", run, counts: countRunUnits(run) });
  }

  // ── 内部：任务启动与执行 ───────────────────────────────────────────────

  private makeTask(
    run: MissionRun,
    node: MissionFlowNode,
    itemId: string | null,
    parentTaskId: string | null,
    itemLabel: string | null = null,
  ): MissionTaskInstance {
    const id = itemId
      ? `${run.id}:${parentTaskId}:${itemId}:${node.id}`
      : `${run.id}:${node.id}`;
    return {
      id,
      runId: run.id,
      nodeId: node.id,
      title: node.title,
      status: "queued",
      attempt: 1,
      round: 0,
      feedback: [],
      approved: false,
      forceApproval: false,
      itemId,
      itemLabel,
      parentTaskId,
    };
  }

  private startTask(run: MissionRun, task: MissionTaskInstance): void {
    const node = this.nodeForTask(run, task);
    if (!node) {
      this.failTask(run, task, "node definition missing");
      return;
    }
    if (node.type === "foreach") {
      task.status = "running";
      task.startedAt = this.host.now();
      try {
        this.expandForeach(run, task, node);
        task.status = "succeeded";
        task.endedAt = this.host.now();
      } catch (error) {
        this.handleFailure(run, task, this.errorMessage(error));
      }
      return;
    }
    task.status = "running";
    task.startedAt = this.host.now();
    const token = ++this.executionSeq;
    this.executions.set(task.id, token);
    void this.executeAsync(run, task, node, token);
  }

  private startHumanTask(run: MissionRun, task: MissionTaskInstance): void {
    const node = this.nodeForTask(run, task);
    if (!node) {
      this.failTask(run, task, "node definition missing");
      return;
    }
    task.status = "waiting_human";
    task.startedAt = this.host.now();
    this.host.emit({
      kind: "attention",
      run,
      task,
      forceApproval: task.forceApproval,
    });
  }

  private async executeAsync(
    run: MissionRun,
    task: MissionTaskInstance,
    node: MissionFlowNode,
    token: number,
  ): Promise<void> {
    try {
      const output = await this.executeNode(run, task, node);
      if (run.cancelled || this.executions.get(task.id) !== token) return;
      if (task.status !== "running") return;
      this.executions.delete(task.id);
      task.output = output;
      task.status = "succeeded";
      task.endedAt = this.host.now();
      task.error = undefined;
      this.settle(run);
    } catch (error) {
      if (run.cancelled || this.executions.get(task.id) !== token) return;
      if (task.status !== "running") return;
      this.executions.delete(task.id);
      this.handleFailure(run, task, this.errorMessage(error));
      this.settle(run);
    }
  }

  private executeNode(
    run: MissionRun,
    task: MissionTaskInstance,
    node: MissionFlowNode,
  ): Promise<unknown> {
    const context = this.contextFor(run, task);
    switch (node.type) {
      case "input":
        return this.host.executor.runInput(node, context);
      case "tool":
        return this.host.executor.runTool(node, context);
      case "agent":
        return this.host.executor.runAgent(node, context);
      case "output":
        return Promise.resolve(this.buildOutput(run, task, node));
      default:
        return Promise.reject(new Error(`unsupported node type: ${node.type}`));
    }
  }

  /** foreach 展开：按 over 的集合为每一项创建一整套子任务。 */
  private expandForeach(run: MissionRun, task: MissionTaskInstance, node: MissionFlowNode): void {
    const config = node.foreach;
    if (!config) throw new Error("foreach config missing");
    const source = this.upstreamOutputs(run, task)[config.over];
    const items = Array.isArray(source)
      ? source
      : isObject(source) && Array.isArray(source.items)
        ? source.items
        : null;
    if (!items) {
      throw new Error(`input collection is not a list: ${config.over}`);
    }
    for (let index = 0; index < items.length; index++) {
      const value = items[index];
      const itemId = `${task.id}:${index + 1}`;
      const label = isObject(value) && typeof value.label === "string" ? value.label : itemId;
      for (const bodyNode of config.body.nodes) {
        run.tasks.push(this.makeTask(run, bodyNode, itemId, task.id, label));
      }
    }
    this.foreachItems.set(this.itemCacheKey(run, task), items);
    task.output = { count: items.length, itemIds: items.map((_, index) => `${task.id}:${index + 1}`) };
  }

  /** output 节点：汇聚上游成果（含 foreach 每项的处理结果）。 */
  private buildOutput(
    run: MissionRun,
    task: MissionTaskInstance,
    node: MissionFlowNode,
  ): unknown {
    const incoming = this.incomingEdges(run, task);
    const producedAt = this.host.now();
    if (task.itemId) {
      return {
        artifact: node.output?.artifact ?? node.title,
        item: task.itemLabel,
        data: this.upstreamOutputs(run, task),
        producedAt,
      };
    }
    const items: Array<Record<string, unknown>> = [];
    for (const edge of incoming) {
      const source = this.taskFor(run, edge.from, task.itemId, task.parentTaskId);
      if (!source) continue;
      for (const child of run.tasks.filter((row) => row.parentTaskId === source.id)) {
        if (child.itemId === null) continue;
        if (items.some((row) => row.itemId === child.itemId)) continue;
        const itemTasks = run.tasks.filter((row) => row.parentTaskId === source.id && row.itemId === child.itemId);
        const excluded = itemTasks.some((row) => row.status === "excluded");
        const failed = itemTasks.some((row) => row.status === "failed");
        items.push({
          itemId: child.itemId,
          label: child.itemLabel,
          status: excluded ? "excluded" : failed ? "failed" : "succeeded",
          approved: itemTasks.some((row) => row.approved),
          stages: Object.fromEntries(
            itemTasks
              .filter((row) => row.output !== undefined)
              .map((row) => [row.nodeId, row.output]),
          ),
        });
      }
    }
    return {
      artifact: node.output?.artifact ?? node.title,
      producedAt,
      counts: countRunUnits(run),
      items,
    };
  }

  private handleFailure(run: MissionRun, task: MissionTaskInstance, message: string): void {
    task.error = message;
    const settings = run.snapshot.settings;
    if (task.attempt <= settings.retries) {
      task.attempt += 1;
      task.status = "queued";
      task.endedAt = undefined;
      task.startedAt = undefined;
      this.executions.delete(task.id);
      this.host.emit({ kind: "auto_retry", run, task, retries: settings.retries });
      return;
    }
    this.failTask(run, task, message);
  }

  private failTask(run: MissionRun, task: MissionTaskInstance, message: string): void {
    task.error = message;
    task.status = "failed";
    task.endedAt = this.host.now();
    this.executions.delete(task.id);
    this.host.emit({ kind: "failed", run, task });
  }

  // ── 内部：状态判定 ─────────────────────────────────────────────────────

  private nodeForTask(run: MissionRun, task: MissionTaskInstance): MissionFlowNode | undefined {
    if (task.parentTaskId === null) {
      return run.snapshot.nodes.find((node) => node.id === task.nodeId);
    }
    const parent = run.tasks.find((row) => row.id === task.parentTaskId);
    if (!parent) return undefined;
    const parentNode = run.snapshot.nodes.find((node) => node.id === parent.nodeId);
    return parentNode?.foreach?.body.nodes.find((node) => node.id === task.nodeId);
  }

  private isHumanTask(run: MissionRun, task: MissionTaskInstance): boolean {
    return this.nodeForTask(run, task)?.type === "human";
  }

  private edgesFor(run: MissionRun, task: MissionTaskInstance): MissionFlowEdge[] {
    if (task.parentTaskId === null) return run.snapshot.edges;
    const parent = run.tasks.find((row) => row.id === task.parentTaskId);
    if (!parent) return [];
    const parentNode = run.snapshot.nodes.find((node) => node.id === parent.nodeId);
    return parentNode?.foreach?.body.edges ?? [];
  }

  private incomingEdges(run: MissionRun, task: MissionTaskInstance): MissionFlowEdge[] {
    return this.edgesFor(run, task).filter((edge) => edge.to === task.nodeId);
  }

  private taskFor(
    run: MissionRun,
    nodeId: string,
    itemId: string | null,
    parentTaskId: string | null,
  ): MissionTaskInstance | undefined {
    return run.tasks.find(
      (row) =>
        row.nodeId === nodeId &&
        row.itemId === itemId &&
        (itemId === null ? row.parentTaskId === null : row.parentTaskId === parentTaskId),
    );
  }

  /** 源任务是否已经给出激活结论（成功/排除/取消）；foreach 还要等全部子项终结。 */
  private isSourceResolved(run: MissionRun, task: MissionTaskInstance | undefined): boolean {
    if (!task) return false;
    if (task.status === "succeeded" || task.status === "excluded" || task.status === "cancelled") {
      return this.foreachChildrenSettled(run, task);
    }
    return false;
  }

  /** foreach 的子任务全部终结（成功/排除/取消），汇总才能继续。 */
  private foreachChildrenSettled(run: MissionRun, task: MissionTaskInstance): boolean {
    const children = run.tasks.filter((row) => row.parentTaskId === task.id);
    return children.every((child) => isTerminalTask(child.status));
  }

  private isReady(run: MissionRun, task: MissionTaskInstance): boolean {
    if (task.status !== "queued") return false;
    const incoming = this.incomingEdges(run, task);
    if (incoming.length === 0) {
      // 顶层 input 是根；body 根在展开后即可执行。
      const node = this.nodeForTask(run, task);
      return task.parentTaskId !== null || node?.type === "input";
    }
    let activated = false;
    for (const edge of incoming) {
      const source = this.taskFor(run, edge.from, task.itemId, task.parentTaskId);
      if (!this.isSourceResolved(run, source)) return false;
      if (source?.status === "succeeded" && this.activatedEdgeIds(run, source).has(edge.id)) {
        activated = true;
      }
    }
    return activated;
  }

  private isUnreachable(run: MissionRun, task: MissionTaskInstance): boolean {
    const incoming = this.incomingEdges(run, task);
    if (incoming.length === 0) return task.parentTaskId === null && this.nodeForTask(run, task)?.type !== "input";
    let activated = false;
    for (const edge of incoming) {
      const source = this.taskFor(run, edge.from, task.itemId, task.parentTaskId);
      if (!this.isSourceResolved(run, source)) return false;
      if (source?.status === "succeeded" && this.activatedEdgeIds(run, source).has(edge.id)) {
        activated = true;
      }
    }
    return !activated;
  }

  /** 评估某个已完成源节点的出边组：非 default 优先，无匹配才走 default。 */
  private activatedEdgeIds(run: MissionRun, source: MissionTaskInstance): Set<string> {
    const result = new Set<string>();
    if (source.status !== "succeeded") return result;
    const outgoing = this.edgesFor(run, source).filter((edge) => edge.from === source.nodeId);
    const context: Record<string, unknown> = {
      ...outputContext(source.output),
      ...run.snapshot.settings,
      settings: run.snapshot.settings,
    };
    if (source.itemId) {
      context.item = source.itemId;
      context.itemLabel = source.itemLabel;
    }
    let matched = false;
    for (const edge of outgoing) {
      if (isDefaultCondition(edge.condition)) continue;
      if (evaluateCondition(edge.condition, context)) {
        result.add(edge.id);
        matched = true;
      }
    }
    if (!matched) {
      const fallback = outgoing.find((edge) => isDefaultCondition(edge.condition));
      if (fallback) result.add(fallback.id);
    }
    return result;
  }

  private upstreamOutputs(
    run: MissionRun,
    task: MissionTaskInstance,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const edge of this.incomingEdges(run, task)) {
      const source = this.taskFor(run, edge.from, task.itemId, task.parentTaskId);
      if (source?.output !== undefined) result[edge.from] = source.output;
    }
    return result;
  }

  private contextFor(
    run: MissionRun,
    task: MissionTaskInstance,
  ): MissionTaskContext {
    const context: MissionTaskContext = {
      run,
      task,
      settings: run.snapshot.settings,
      upstream: this.upstreamOutputs(run, task),
    };
    if (task.itemId) {
      const parent = run.tasks.find((row) => row.id === task.parentTaskId);
      const itemValue = parent ? this.itemValueFor(run, parent, task) : undefined;
      context.item = {
        id: task.itemId,
        label: task.itemLabel ?? task.itemId,
        value: itemValue,
      };
    }
    return context;
  }

  /** 从 foreach 展开时保存的集合里取回该项的原始数据。 */
  private itemValueFor(
    run: MissionRun,
    foreachTask: MissionTaskInstance,
    child: MissionTaskInstance,
  ): unknown {
    const stored = this.foreachItems.get(`${run.id}:${foreachTask.id}`);
    if (!stored || !child.itemId) return undefined;
    const index = Number(child.itemId.slice(child.itemId.lastIndexOf(":") + 1)) - 1;
    return stored[index];
  }

  /** foreach 展开时缓存原始项数据（不进入快照模型）。 */
  private readonly foreachItems = new Map<string, unknown[]>();

  private itemCacheKey(run: MissionRun, task: MissionTaskInstance): string {
    return `${run.id}:${task.id}`;
  }

  /** 反馈：重置该任务所在分支的上游任务（同 item），不重跑全部。 */
  private resetBranchUpstream(run: MissionRun, humanTask: MissionTaskInstance): void {
    const scope = run.tasks.filter((task) =>
      humanTask.itemId
        ? task.itemId === humanTask.itemId && task.parentTaskId === humanTask.parentTaskId
        : task.parentTaskId === null,
    );
    const incoming = new Map<string, string[]>();
    // One scope task per node (same item + parent), so a nodeId map is an
    // exact replacement for the per-edge scope scans.
    const scopeByNode = new Map(scope.map((task) => [task.nodeId, task]));
    for (const task of scope) incoming.set(task.id, []);
    for (const edge of this.edgesFor(run, humanTask)) {
      for (const target of scope) {
        if (target.nodeId !== edge.to) continue;
        const source = scopeByNode.get(edge.from);
        if (source) incoming.get(target.id)?.push(source.id);
      }
    }
    // 从 human 任务向上追踪全部祖先任务。
    const ancestors = new Set<string>();
    const queue = [humanTask.id];
    while (queue.length > 0) {
      const current = queue.pop()!;
      for (const source of incoming.get(current) ?? []) {
        if (ancestors.has(source)) continue;
        ancestors.add(source);
        queue.push(source);
      }
    }
    for (const task of scope) {
      if (!ancestors.has(task.id)) continue;
      this.executions.delete(task.id);
      this.host.executor.cancelTask?.(task.id);
      task.status = "queued";
      task.output = undefined;
      task.error = undefined;
      task.endedAt = undefined;
      task.startedAt = undefined;
    }
  }

  /** 排除：该分支明确终结（不假装成功）。 */
  private excludeBranch(run: MissionRun, task: MissionTaskInstance): void {
    // 可被“排除”真相覆盖的状态：目标任务本身就是 failed/waiting 也要转成 excluded。
    const excludable: MissionTaskStatus[] = ["queued", "running", "waiting_human", "failed"];
    if (task.itemId) {
      for (const sibling of run.tasks) {
        if (sibling.itemId !== task.itemId) continue;
        if (sibling.id !== task.id && !excludable.includes(sibling.status)) continue;
        sibling.status = "excluded";
        sibling.endedAt = this.host.now();
        this.executions.delete(sibling.id);
        this.host.executor.cancelTask?.(sibling.id);
      }
      return;
    }
    task.status = "excluded";
    task.endedAt = this.host.now();
    this.executions.delete(task.id);
    this.host.executor.cancelTask?.(task.id);
    // 顶层排除：下游没有可靠输入，明确取消而不是假装继续。
    const downstream = new Set<string>([task.nodeId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const edge of run.snapshot.edges) {
        if (!downstream.has(edge.from) || downstream.has(edge.to)) continue;
        downstream.add(edge.to);
        grew = true;
      }
    }
    for (const other of run.tasks) {
      if (other.id === task.id || !downstream.has(other.nodeId)) continue;
      if (isTerminalTask(other.status)) continue;
      other.status = "cancelled";
      other.endedAt = this.host.now();
      this.executions.delete(other.id);
      this.host.executor.cancelTask?.(other.id);
    }
  }

  /** 每个 foreach 项全部任务终结时，发一条 item 级消息（去重）。 */
  private emitItemTerminals(run: MissionRun): void {
    const foreachTasks = run.tasks.filter((task) => {
      const node = this.nodeForTask(run, task);
      return node?.type === "foreach";
    });
    for (const foreachTask of foreachTasks) {
      const children = run.tasks.filter((task) => task.parentTaskId === foreachTask.id);
      if (children.length === 0) continue;
      const itemIds = [...new Set(children.map((child) => child.itemId))];
      for (const itemId of itemIds) {
        if (!itemId) continue;
        const itemTasks = children.filter((child) => child.itemId === itemId);
        if (itemTasks.some((child) => !isTerminalTask(child.status))) continue;
        const representative = itemTasks[0];
        const key = `${run.id}:${itemId}:${representative.round}`;
        if (this.itemNotices.has(key)) continue;
        this.itemNotices.add(key);
        if (itemTasks.some((child) => child.status === "excluded")) {
          this.host.emit({ kind: "item_excluded", run, task: representative });
        } else if (!itemTasks.some((child) => child.status === "failed")) {
          this.host.emit({
            kind: "item_done",
            run,
            task: representative,
            approved: itemTasks.some((child) => child.approved),
          });
        }
      }
    }
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  /** 清除某次运行的内存记录（测试/重置用）。 */
  forget(runId: string): void {
    for (const key of [...this.itemNotices]) {
      if (key.startsWith(`${runId}:`)) this.itemNotices.delete(key);
    }
    for (const key of [...this.foreachItems.keys()]) {
      if (key.startsWith(`${runId}:`)) this.foreachItems.delete(key);
    }
  }
}
