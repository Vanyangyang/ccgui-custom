import i18n from "@/lib/i18n";
import { useChatStore } from "@/features/chat/store";
import { buildPrReviewDemoFlow, PR_REVIEW_FLOW_ID } from "./builtin/pr-review";
import { missionAgentNodeRunner } from "./agent-runner";
import { MissionScheduler, type MissionEngineEvent } from "./engine/scheduler";
import { createSimulatedExecutor } from "./engine/simulated";
import { createMissionRunExecutor } from "./engine/native";
import {
  isFlowRunnable,
  type MissionValidationIssue,
  validateMissionFlow,
} from "./engine/validator";
import { missionId } from "./ids";
import {
  initMissionPersistence,
  loadMissionState,
  saveMissionState,
} from "./persistence";
import { useMissionStore } from "./store";
import type {
  MissionConversationMessage,
  MissionFlow,
  MissionFlowNode,
  MissionInboxItem,
  MissionRun,
  MissionRunExecution,
  MissionTaskInstance,
} from "./types";

/**
 * 任务工作台运行层：把调度器事件接到 store（运行快照 + 收件箱），并提供
 * 界面可调用的动作（启动运行、处理收件箱、取消、演示失败注入）。
 *
 * 执行器是混合的：演示能力走本地模拟；AI 生成的 agent 节点走宿主 agent
 * 管线（mission-agent://event）。只读节点需要引擎真的支持工具约束，否则
 * 阻止启动。
 *
 * 原文案在这里经 i18n 生成；引擎本身不依赖语言与界面。
 */

const DEMO_TASK_DELAY_MS = 320;
const MAX_VERSION_HISTORY = 10;

let scheduler: MissionScheduler | null = null;
let runSequence = 0;
let persistence: { dispose: () => void } | null = null;

/** Load persisted mission state without creating the demo flow. This is used
 * by app-wide projections such as the desktop pet before the workbench opens.
 */
export function ensureMissionPersistenceLoaded(): void {
  if (persistence) return;
  const bound = initMissionPersistence({
    load: loadMissionState,
    save: saveMissionState,
    subscribe: (listener) => useMissionStore.subscribe(listener),
    snapshot: () => {
      const state = useMissionStore.getState();
      return { flows: state.flows, runs: state.runs, inbox: state.inbox };
    },
  });
  persistence = bound;
  // Rehydrate only if a persisted snapshot exists. The demo flow belongs to
  // the workbench UX and must not be created merely because the pet is on.
  if (bound.hydrated && bound.hydrated.flows.length > 0) {
    useMissionStore.getState().hydrate({
      flows: bound.hydrated.flows,
      runs: bound.hydrated.runs,
      inbox: bound.hydrated.inbox,
    });
  }
}

function getScheduler(): MissionScheduler {
  if (scheduler) return scheduler;
  const simulated = createSimulatedExecutor({ delayMs: DEMO_TASK_DELAY_MS });
  const executor = createMissionRunExecutor({
    simulated,
    executionForRun: (run) => run.execution ?? null,
    agentRunner: missionAgentNodeRunner,
  });
  scheduler = new MissionScheduler({
    executor,
    emit: handleEngineEvent,
    onRunChanged: (run) => {
      useMissionStore.getState().upsertRun(run);
    },
    now: () => Date.now(),
    newId: (prefix) => `${prefix}-${++runSequence}`,
  });
  return scheduler;
}

/** 首次打开时：回放持久化状态，装载内置演示流程（幂等，StrictMode 双调用安全）。 */
export function ensureMissionSeeded(): void {
  ensureMissionPersistenceLoaded();
  const store = useMissionStore.getState();
  if (store.flows.length > 0) return;
  const definition = buildPrReviewDemoFlow();
  const now = Date.now();
  const flow: MissionFlow = {
    id: PR_REVIEW_FLOW_ID,
    name: definition.name,
    goal: definition.goal,
    draft: definition,
    versions: [],
    runIds: [],
    messages: [
      {
        id: missionId("msg"),
        role: "assistant",
        text: i18n.t("mission.demoGreeting"),
        change: {
          version: definition.version,
          lines: [
            i18n.t("mission.demoChangeLine1", { concurrency: definition.settings.concurrency }),
            i18n.t("mission.demoChangeLine2", { retries: definition.settings.retries }),
          ],
        },
        createdAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  useMissionStore.getState().upsertFlow(flow);
  useMissionStore.getState().selectFlow(flow.id, "definition");
}

/**
 * 运行上下文解析（方案之外的取舍，用户确认的方案 B）：
 *  1. 流程固定了执行配置（引擎/模型/工作区）→ 用它，失效则明确报错；
 *  2. 否则跟随当前聊天会话（含其模型/渠道/effort 覆盖）；
 *  3. 否则取第一个可用引擎与第一个工作区；
 *  4. 都没有 → null（原生 agent 节点无法执行）。
 */
export type MissionExecutionInvalidReason = "engineUnavailable" | "workspaceMissing";

export interface MissionExecutionResolution {
  execution: MissionRunExecution | null;
  /** 流程固定配置失效的原因（启动时如实报错，不静默回退）。 */
  invalidReason?: MissionExecutionInvalidReason;
  source: "flow" | "session" | "default" | "none";
}

function engineUsable(
  engine: string,
  engines: Array<{ id: string; available: boolean; enabled: boolean }>,
): boolean {
  const info = engines.find((row) => row.id === engine);
  return !!info && info.available && info.enabled;
}

export function resolveMissionExecution(flow?: MissionFlow | null): MissionExecutionResolution {
  const chat = useChatStore.getState();
  const stored = flow?.execution ?? null;
  if (stored) {
    if (!engineUsable(stored.engine, chat.engines)) {
      return { execution: null, invalidReason: "engineUnavailable", source: "flow" };
    }
    if (!chat.workspaces.some((workspace) => workspace.path === stored.workspacePath)) {
      return { execution: null, invalidReason: "workspaceMissing", source: "flow" };
    }
    return { execution: { ...stored }, source: "flow" };
  }
  if (chat.active && engineUsable(chat.active.engine, chat.engines)) {
    return {
      execution: {
        engine: chat.active.engine,
        workspacePath: chat.active.workspacePath,
        model: chat.active.model ?? null,
        providerId: chat.active.provider ?? null,
        effort: chat.active.effort ?? null,
      },
      source: "session",
    };
  }
  const engine = chat.engines.find((info) => info.available && info.enabled);
  const workspace = chat.workspaces[0];
  if (!engine || !workspace) return { execution: null, source: "none" };
  return {
    execution: {
      engine: engine.id,
      workspacePath: workspace.path,
      model: null,
      providerId: null,
      effort: null,
    },
    source: "default",
  };
}

/** 流程里所有声明只读的 agent 节点（含 foreach 子流程）。 */
function collectReadOnlyNodes(flow: MissionFlowNode[]): MissionFlowNode[] {
  const all: MissionFlowNode[] = [];
  for (const node of flow) {
    all.push(node);
    for (const child of node.foreach?.body.nodes ?? []) all.push(child);
  }
  return all.filter(
    (node) =>
      node.type === "agent" &&
      node.agent?.readOnly === true &&
      node.agent.provider !== "simulated",
  );
}

export interface StartRunResult {
  ok: boolean;
  runId?: string;
  /** 已经有一个进行中的运行：本轮不启动新运行。 */
  activeRunId?: string;
  error?: string;
  issues?: MissionValidationIssue[];
}

/** 启动一次运行：固定草稿快照；进行中的运行不会被草稿修改影响。 */
export function startMissionRun(
  flowId: string,
  executionOverride?: MissionRunExecution | null,
): StartRunResult {
  const store = useMissionStore.getState();
  const flow = store.flows.find((item) => item.id === flowId);
  if (!flow) return { ok: false, error: "flow not found" };
  if (!flow.draft) return { ok: false, error: "flow has no draft" };

  const issues = validateMissionFlow(flow.draft);
  // 能力缺口会生成步骤但阻止运行（不伪造能力）。
  if (!isFlowRunnable(issues)) return { ok: false, issues };

  const activeRun = flow.runIds
    .map((id) => store.runs[id])
    .find((run): run is MissionRun => !!run && run.endedAt === undefined && !run.cancelled);
  if (activeRun) return { ok: false, activeRunId: activeRun.id };

  // 只读节点必须由引擎真正兑现工具约束；否则不启动（不假装只读）。
  const readOnlyNodes = collectReadOnlyNodes(flow.draft.nodes);
  const resolution: MissionExecutionResolution =
    executionOverride !== undefined
      ? { execution: executionOverride, source: "flow" }
      : resolveMissionExecution(flow);
  if (resolution.invalidReason) {
    const stored = flow.execution;
    return {
      ok: false,
      error: `execution configuration is invalid: ${resolution.invalidReason}`,
      issues: [
        {
          code: resolution.invalidReason,
          severity: "unavailable",
          params:
            resolution.invalidReason === "engineUnavailable"
              ? { engine: stored?.engine ?? "" }
              : { path: stored?.workspacePath ?? "" },
        },
      ],
    };
  }
  const execution = resolution.execution;
  if (readOnlyNodes.length > 0) {
    const engineInfo = execution
      ? useChatStore.getState().engines.find((info) => info.id === execution.engine)
      : undefined;
    if (!execution || !engineInfo?.supportsToolConstraints) {
      const blocked = readOnlyNodes.slice(0, 3).map((node) => ({
        code: "readOnlyUnsupported",
        severity: "unavailable" as const,
        nodeId: node.id,
        params: { node: node.title || node.id },
      }));
      return {
        ok: false,
        error: "read-only constraints are not supported by the selected engine",
        issues: blocked,
      };
    }
  }
  if (!execution) {
    // 全演示流程（含模拟 agent）可以无引擎运行；有原生节点则不行。
    const hasNativeAgent = flow.draft.nodes.some((node) => {
      const nodes = [node, ...(node.foreach?.body.nodes ?? [])];
      return nodes.some(
        (child) => child.type === "agent" && child.agent?.provider !== "simulated",
      );
    });
    if (hasNativeAgent) {
      return { ok: false, error: "no engine/workspace available for native agent nodes" };
    }
  }

  const engine = getScheduler();
  const run = engine.createRun(flow.draft, flow.id, flow.name || flow.draft.name, execution);
  store.upsertRun(run);
  store.upsertFlow({
    ...flow,
    versions: [...flow.versions, structuredClone(flow.draft)].slice(-MAX_VERSION_HISTORY),
  });
  store.selectFlow(flow.id, "run", run.id);
  store.selectNode(null);
  engine.start(run);
  return { ok: true, runId: run.id };
}

export type MissionInboxAction =
  | { kind: "approve" }
  | { kind: "feedback"; text: string }
  | { kind: "exclude" }
  | { kind: "retry" };

export interface InboxActionResult {
  ok: boolean;
  error?: string;
  /** 已处理说明（用于 toast）。 */
  message?: string;
}

/** 收件箱动作：批准 / 反馈 / 排除 / 重试（都推动任务，不是手工编排）。 */
export function applyInboxAction(inboxId: string, action: MissionInboxAction): InboxActionResult {
  const store = useMissionStore.getState();
  const item = store.inbox.find((row) => row.id === inboxId);
  if (!item) return { ok: false, error: "notice not found" };
  if (item.resolved) return { ok: false, error: "already resolved" };
  const run = store.runs[item.runId];
  if (!run) return { ok: false, error: "run not found" };
  if (!item.taskId) return { ok: false, error: "notice has no task" };
  const engine = getScheduler();

  let result: { ok: boolean; error?: string };
  let message: string;
  switch (action.kind) {
    case "approve":
      result = engine.resolveDecision(run, item.taskId, { kind: "approve" });
      message = i18n.t("mission.resolveApprove");
      break;
    case "feedback":
      result = engine.resolveDecision(run, item.taskId, {
        kind: "feedback",
        text: action.text,
      });
      message = i18n.t("mission.resolveFeedback");
      break;
    case "exclude":
      result = engine.resolveDecision(run, item.taskId, { kind: "exclude" });
      message = i18n.t("mission.resolveExclude");
      break;
    case "retry":
      result = engine.retryTask(run, item.taskId);
      message = i18n.t("mission.resolveRetry");
      break;
  }
  if (result.ok) {
    useMissionStore.getState().resolveInbox(item.id, message);
    return { ok: true, message };
  }
  return { ok: false, error: result.error };
}

/** 取消运行：未完成实例不再推进（晚到的执行结果会被忽略）。 */
export function cancelMissionRun(runId: string): boolean {
  const run = useMissionStore.getState().runs[runId];
  if (!run) return false;
  getScheduler().cancel(run);
  return true;
}

/** 演示用：向当前运行注入一次失败（走与真实失败相同的恢复路径）。 */
export function injectDemoFailure(runId: string): boolean {
  const run = useMissionStore.getState().runs[runId];
  if (!run) return false;
  return getScheduler().injectFailure(run);
}

function runLabel(task: MissionTaskInstance): string {
  return task.itemLabel ?? task.title;
}

function pushInbox(
  partial: Omit<MissionInboxItem, "id" | "createdAt" | "read" | "resolved"> &
    Partial<Pick<MissionInboxItem, "resolved" | "resolution">>,
): void {
  const item: MissionInboxItem = {
    id: missionId("notice"),
    createdAt: Date.now(),
    read: false,
    resolved: false,
    ...partial,
  };
  useMissionStore.getState().upsertInbox(item);
}

function handleEngineEvent(event: MissionEngineEvent): void {
  const t = (key: string, params?: Record<string, unknown>): string =>
    params ? i18n.t(key, params) : i18n.t(key);
  switch (event.kind) {
    case "attention":
      pushInbox({
        flowId: event.run.flowId,
        runId: event.run.id,
        taskId: event.task.id,
        nodeKey: `task:${event.task.id}`,
        type: "attention",
        title: t(
          event.forceApproval ? "mission.noticeFeedbackTitle" : "mission.noticeAttentionTitle",
          { item: runLabel(event.task) },
        ),
        body: t(
          event.forceApproval ? "mission.noticeFeedbackBody" : "mission.noticeAttentionBody",
        ),
        dedupeKey: `attention:${event.task.id}:${event.task.round}`,
      });
      break;
    case "auto_retry": {
      const failedAttempt = Math.max(1, event.task.attempt - 1);
      pushInbox({
        flowId: event.run.flowId,
        runId: event.run.id,
        taskId: event.task.id,
        nodeKey: `task:${event.task.id}`,
        type: "failed",
        title: t("mission.noticeAutoRetryTitle", { item: runLabel(event.task) }),
        body: t("mission.noticeAutoRetryBody", {
          attempt: failedAttempt,
          retries: event.retries,
        }),
        // 自动重试是记录，不需要处理；但保留失败消息便于回看。
        resolved: true,
        resolution: t("mission.resolveRetry"),
        dedupeKey: `failure:${event.task.id}:${failedAttempt}`,
      });
      break;
    }
    case "failed":
      pushInbox({
        flowId: event.run.flowId,
        runId: event.run.id,
        taskId: event.task.id,
        nodeKey: `task:${event.task.id}`,
        type: "failed",
        title: t("mission.noticeFailedTitle", { item: runLabel(event.task) }),
        body: t("mission.noticeFailedBody"),
        dedupeKey: `failure:${event.task.id}:${event.task.attempt}`,
      });
      break;
    case "item_done":
      pushInbox({
        flowId: event.run.flowId,
        runId: event.run.id,
        taskId: event.task.id,
        nodeKey: `task:${event.task.id}`,
        type: "done",
        title: t("mission.noticeDoneItemTitle", { item: runLabel(event.task) }),
        body: t("mission.noticeDoneItemBody"),
        resolved: true,
        resolution: event.approved ? t("mission.resolveApprove") : undefined,
        dedupeKey: `done:${event.task.itemId}:${event.task.round}`,
      });
      break;
    case "item_excluded":
      pushInbox({
        flowId: event.run.flowId,
        runId: event.run.id,
        taskId: event.task.id,
        nodeKey: `task:${event.task.id}`,
        type: "done",
        title: t("mission.noticeExcludedTitle", { item: runLabel(event.task) }),
        body: t("mission.noticeExcludedBody"),
        resolved: true,
        resolution: t("mission.resolveExclude"),
        dedupeKey: `excluded:${event.task.itemId}:${event.task.round}`,
      });
      break;
    case "run_done":
      pushInbox({
        flowId: event.run.flowId,
        runId: event.run.id,
        nodeKey: "output",
        type: "done",
        title: t("mission.noticeRunDoneTitle", { flow: event.run.flowName }),
        body: t("mission.noticeRunDoneBody", {
          done: event.counts.done,
          excluded: event.counts.excluded,
        }),
        resolved: true,
        dedupeKey: `run-completed:${event.run.id}`,
      });
      break;
  }
}

/** 选中流程的最新运行。 */
export function latestRunOf(
  flow: MissionFlow,
  runs: Record<string, MissionRun>,
): MissionRun | null {
  const latest = flow.runIds.at(-1);
  return (latest && runs[latest]) || null;
}

/** 当前选中的运行（无选中回退到最近一次运行）。 */
export function selectedRunOf(state = useMissionStore.getState()): MissionRun | null {
  const flow = state.flows.find((item) => item.id === state.selectedFlowId) ?? null;
  if (!flow) return null;
  if (state.selectedRunId && state.runs[state.selectedRunId]) {
    return state.runs[state.selectedRunId];
  }
  return latestRunOf(flow, state.runs);
}

/** 测试辅助：清空运行层单例与持久化订阅。 */
export function resetMissionRuntime(): void {
  scheduler = null;
  runSequence = 0;
  persistence?.dispose();
  persistence = null;
}

export type { MissionConversationMessage, MissionRunExecution };
