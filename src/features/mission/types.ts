/**
 * 任务工作台数据模型（M0）。
 *
 * 三个核心对象（见 docs/plans/mission-workbench-plan.md §3）：
 *  - FlowDefinition：这类工作应该怎么做（draft + 版本快照）
 *  - Run：这次具体做什么、做到哪了（绑定启动时的规则快照）
 *  - InboxItem：现在需要我做什么（关联具体 run + 任务实例）
 *
 * 节点三层模型：节点类型（固定执行契约）→ 节点定义（AI 生成）→
 * 运行实例（调度器展开，foreach 在运行时按数据展开为 N 个任务）。
 */

/** 第一版固定实现的 6 种节点类型。 */
export type MissionNodeType = "input" | "tool" | "agent" | "foreach" | "human" | "output";

/** 任务实例状态机：queued → running → (succeeded | failed | waiting_human | cancelled)。
 *  `excluded` 是用户显式排除分支后的终结态（不假装成功）。 */
export type MissionTaskStatus =
  | "queued"
  | "running"
  | "waiting_human"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "excluded";

/** 终结态：不会再变化，也不占并发槽。 */
export const TERMINAL_TASK_STATUSES: readonly MissionTaskStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
  "excluded",
];

/** 派生的一次运行状态（由 task 状态聚合，不单独维护）。 */
export type MissionRunStatus = "running" | "waiting" | "attention" | "done" | "cancelled";

/** 收件箱消息类型：需人工介入 / 失败 / 已完成 / 普通进度。 */
export type MissionInboxType = "attention" | "failed" | "done" | "progress";

/** 高风险分流策略：all = 每项都等人工；risk = 仅高风险；none = 不等待。 */
export type MissionApprovalPolicy = "all" | "risk" | "none";

export interface MissionPosition {
  x: number;
  y: number;
}

/** tool 节点引用能力目录里的工具；目录决定它是否可运行。 */
export interface MissionToolConfig {
  capabilityId: string;
  params?: Record<string, unknown>;
}

/** agent 节点：需要理解/分析/生成的工作。readOnly 是能力约束，
 *  必须由原生执行层兑现（不允许用节点名假装实现）。 */
export interface MissionAgentConfig {
  instruction: string;
  /** 需要哪些上游输出作为输入；缺省 = 全部直接上游。 */
  inputs?: string[];
  /** 声明只读：原生层必须为每次 agent 调用加工具约束，否则不可运行。 */
  readOnly?: boolean;
  /** 执行提供方：native = 真实 agent 管线（默认）；simulated = 内置
   *  演示流程专用（本地模拟，不调用模型）。AI 提案不得自行设置 simulated。 */
  provider?: "native" | "simulated";
}

export interface MissionInputConfig {
  capabilityId: string;
  params?: Record<string, unknown>;
}

export interface MissionOutputConfig {
  /** 成果名称（例如「审查摘要」）。 */
  artifact: string;
}

export interface MissionHumanConfig {
  /** 需要人做的决定/补充的信息。 */
  ask: string;
}

/** foreach 子流程：body 是独立的小 DAG，运行时按数据逐项展开。 */
export interface MissionForeachConfig {
  /** 上游节点 id，其输出必须是集合。 */
  over: string;
  concurrency: number;
  body: {
    nodes: MissionFlowNode[];
    edges: MissionFlowEdge[];
  };
}

export interface MissionFlowNode {
  id: string;
  type: MissionNodeType;
  title: string;
  description?: string;
  position: MissionPosition;
  input?: MissionInputConfig;
  tool?: MissionToolConfig;
  agent?: MissionAgentConfig;
  foreach?: MissionForeachConfig;
  human?: MissionHumanConfig;
  output?: MissionOutputConfig;
}

/**
 * 连线。condition 是受限表达式（不允许 eval）：子句 `key=value` /
 * `key!=value`，子句之间只允许 ` and ` / ` or `；关键字 `default` 表示
 * 「同组其他条件都不匹配时」。上下文是上游输出与运行设置（risk、approval…）。
 */
export interface MissionFlowEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  condition?: string;
  /** 画布样式：普通流转 / 失败恢复 / 反馈重做。 */
  kind?: "flow" | "recovery" | "feedback";
}

export interface MissionFlowSettings {
  concurrency: number;
  retries: number;
  approval: MissionApprovalPolicy;
  /** 是否启用确定性核查步骤（由流程定义自行选用）。 */
  verification: boolean;
}

export interface MissionFlowDefinition {
  /** 每次修改 +1；草稿版本与运行快照版本互相隔离。 */
  version: number;
  name: string;
  goal: string;
  settings: MissionFlowSettings;
  nodes: MissionFlowNode[];
  edges: MissionFlowEdge[];
}

/** 对话记录（M3 接入真实 agent 后仍按此结构保存）。 */
export interface MissionConversationMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** AI 变更摘要（仅 assistant 消息，若有实际改动）。 */
  change?: {
    version: number;
    lines: string[];
  };
  /** 生成失败/校验失败等错误提示（不伪装成已执行）。 */
  error?: string;
  createdAt: number;
}

export interface MissionFlow {
  id: string;
  name: string;
  goal: string;
  draft: MissionFlowDefinition | null;
  /** 流程级执行配置（引擎/模型/工作区）；不属 AI 可编辑的定义，
   *  启动运行时固定进快照。null = 按当前会话/默认推导。 */
  execution?: MissionRunExecution | null;
  /** 每次启动运行固定一份快照；旧运行永远读到自己的版本。 */
  versions: MissionFlowDefinition[];
  runIds: string[];
  messages: MissionConversationMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface MissionTaskInstance {
  id: string;
  runId: string;
  nodeId: string;
  title: string;
  status: MissionTaskStatus;
  /** 第几次尝试（1 起）；自动重试会 +1。 */
  attempt: number;
  /** 人工反馈轮次；每次反馈 +1。 */
  round: number;
  /** 用户补充要求（只影响对应分支的重新执行）。 */
  feedback: string[];
  approved: boolean;
  /** 用户反馈后必须重新人工确认。 */
  forceApproval: boolean;
  /** foreach 子任务所属项；顶层任务为 null。 */
  itemId: string | null;
  itemLabel: string | null;
  /** 所属 foreach 顶层任务 id（子任务不占调度依赖的顶层位）。 */
  parentTaskId: string | null;
  output?: unknown;
  error?: string;
  startedAt?: number;
  endedAt?: number;
}

/** 运行绑定的执行上下文（原生 agent 节点用；演示流程可为 null）。 */
export interface MissionRunExecution {
  engine: string;
  workspacePath: string;
  /** 模型选择；null = 引擎默认（settings.default_models → CLI 默认）。 */
  model: string | null;
  /** 渠道（provider）选择；null = 引擎当前渠道。 */
  providerId: string | null;
  /** 思考档位；null = 引擎默认。 */
  effort: string | null;
}

export interface MissionRun {
  id: string;
  flowId: string;
  flowName: string;
  /** 启动时固定的规则快照（深拷贝）。 */
  snapshot: MissionFlowDefinition;
  /** 原生 agent 节点使用的引擎与工作区。 */
  execution?: MissionRunExecution | null;
  tasks: MissionTaskInstance[];
  startedAt: number;
  endedAt?: number;
  cancelled?: boolean;
  /** 应用退出导致的中断（M4）：与用户主动取消区分，但都不伪续跑。 */
  interrupted?: boolean;
}

export interface MissionInboxItem {
  id: string;
  flowId: string;
  runId: string;
  /** 关联的任务实例（运行完成消息没有 taskId）。 */
  taskId?: string;
  /** 画布定位用的节点 key（`task:<id>` 或定义节点 id 或 output）。 */
  nodeKey: string;
  type: MissionInboxType;
  title: string;
  body: string;
  read: boolean;
  resolved: boolean;
  resolution?: string;
  createdAt: number;
  /** 去重键：同一 task 同一事件的重复 emit 会被合并。 */
  dedupeKey: string;
}

export type MissionHumanDecision =
  | { kind: "approve"; note?: string }
  | { kind: "feedback"; text: string }
  | { kind: "exclude"; reason?: string };

/** 运行完成后暴露给 UI 的展示摘要。 */
export interface MissionRunCounts {
  queued: number;
  running: number;
  waiting: number;
  failed: number;
  done: number;
  excluded: number;
}

export const EMPTY_RUN_COUNTS: MissionRunCounts = {
  queued: 0,
  running: 0,
  waiting: 0,
  failed: 0,
  done: 0,
  excluded: 0,
};

export function isTerminalTask(status: MissionTaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

export function countTasks(run: MissionRun): MissionRunCounts {
  const counts: MissionRunCounts = { ...EMPTY_RUN_COUNTS };
  for (const task of run.tasks) {
    if (task.status === "queued") counts.queued++;
    else if (task.status === "running") counts.running++;
    else if (task.status === "waiting_human") counts.waiting++;
    else if (task.status === "failed") counts.failed++;
    else if (task.status === "succeeded") counts.done++;
    else if (task.status === "excluded") counts.excluded++;
  }
  return counts;
}

/**
 * 展示/汇总单元计数：foreach 展开后以「每个输入项」为一个单元
 * （单项内部有多个任务实例），没有 foreach 时回退到顶层任务。
 * 运行摘要、流程列表、完成消息都使用这一口径。
 */
export interface MissionUnitCounts extends MissionRunCounts {
  total: number;
}

function unitStatusOf(statuses: MissionTaskStatus[]): keyof MissionRunCounts {
  if (statuses.some((status) => status === "failed")) return "failed";
  if (statuses.some((status) => status === "waiting_human")) return "waiting";
  if (statuses.some((status) => status === "running")) return "running";
  if (statuses.some((status) => status === "queued")) return "queued";
  if (statuses.some((status) => status === "excluded")) return "excluded";
  return "done";
}

export function countRunUnits(run: MissionRun): MissionUnitCounts {
  const counts: MissionUnitCounts = { ...EMPTY_RUN_COUNTS, total: 0 };
  const statuses: MissionTaskStatus[][] = [];
  // Index nodes and parent→children once; the per-task scans below stay O(n).
  const nodesById = new Map(run.snapshot.nodes.map((node) => [node.id, node]));
  const childrenByParent = new Map<string, MissionTaskInstance[]>();
  for (const task of run.tasks) {
    if (task.parentTaskId === null) continue;
    const bucket = childrenByParent.get(task.parentTaskId);
    if (bucket) bucket.push(task);
    else childrenByParent.set(task.parentTaskId, [task]);
  }
  for (const parent of run.tasks) {
    const parentNode = nodesById.get(parent.nodeId);
    if (parentNode?.type !== "foreach") continue;
    const children = childrenByParent.get(parent.id) ?? [];
    const itemIds = [...new Set(children.map((child) => child.itemId))];
    for (const itemId of itemIds) {
      if (!itemId) continue;
      statuses.push(children.filter((child) => child.itemId === itemId).map((child) => child.status));
    }
  }
  if (statuses.length === 0) {
    for (const task of run.tasks) {
      if (task.parentTaskId === null) statuses.push([task.status]);
    }
  }
  for (const status of statuses) {
    counts.total += 1;
    counts[unitStatusOf(status)] += 1;
  }
  return counts;
}

export function runStatus(run: MissionRun): MissionRunStatus {
  if (run.interrupted) return "cancelled";
  if (run.cancelled) return "cancelled";
  if (run.endedAt !== undefined) return "done";
  const counts = countTasks(run);
  if (counts.running > 0 || counts.queued > 0) return "running";
  if (counts.failed > 0 || counts.waiting > 0) return "attention";
  return "waiting";
}
