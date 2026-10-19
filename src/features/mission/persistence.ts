import type {
  MissionFlow,
  MissionInboxItem,
  MissionRun,
  MissionTaskInstance,
} from "./types";
import { isTerminalTask } from "./types";

/**
 * 任务工作台持久化（M4 前端切片）。
 *
 * 语义边界（方案 §4.1 / §6 M4）：
 *  - 草稿、对话、运行记录与收件箱持久化到 localStorage，重启后可查看；
 *  - 应用退出会终止引擎子进程，因此重启时未完成的运行**不会假装仍在运行**：
 *    统一收敛为「已中断」（cancelled + interrupted），任务实例转 cancelled；
 *  - 真正的跨重启恢复执行需要把调度器下沉到 src-tauri（Rust/sqlite），
 *    属于 M4 的独立里程碑，本切片不做。
 *
 * 存储损坏/超限一律降级：读取失败返回 null，写入失败只记 console.warn，
 * 绝不因为持久化问题影响界面。
 */

export const MISSION_STORAGE_KEY = "ccgui-next.mission:v1";
const MAX_RUNS_PER_FLOW = 5;
const MAX_INBOX_ITEMS = 200;
const MAX_MESSAGES_PER_FLOW = 80;
const MAX_VERSION_HISTORY = 3;
const SAVE_DEBOUNCE_MS = 400;

export interface MissionPersistedState {
  version: 1;
  flows: MissionFlow[];
  runs: MissionRun[];
  inbox: MissionInboxItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissionFlow(value: unknown): value is MissionFlow {
  if (!isRecord(value)) return false;
  if (
    !(
      typeof value.id === "string" &&
      typeof value.name === "string" &&
      Array.isArray(value.messages) &&
      (value.draft === null || isRecord(value.draft)) &&
      Array.isArray(value.runIds)
    )
  ) {
    return false;
  }
  // 执行配置（可选）：形状不对就丢弃，不因为一条坏记录阻止整个回放。
  const execution = (value as Record<string, unknown>).execution;
  if (execution !== undefined && execution !== null) {
    if (
      !isRecord(execution) ||
      typeof execution.engine !== "string" ||
      typeof execution.workspacePath !== "string"
    ) {
      (value as Record<string, unknown>).execution = null;
    }
  }
  return true;
}

function isMissionRun(value: unknown): value is MissionRun {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.flowId === "string" &&
    isRecord(value.snapshot) &&
    Array.isArray(value.tasks)
  );
}

function isMissionInboxItem(value: unknown): value is MissionInboxItem {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.runId === "string" &&
    typeof value.type === "string" &&
    typeof value.dedupeKey === "string"
  );
}

/** 重启后未完成的运行收敛为「已中断」，不伪造仍在执行。 */
export function applyInterruptedSemantics(
  runs: MissionRun[],
  now: () => number = Date.now,
): MissionRun[] {
  return runs.map((run) => {
    if (run.endedAt !== undefined || run.cancelled) return run;
    const endedAt = now();
    const tasks: MissionTaskInstance[] = run.tasks.map((task) =>
      isTerminalTask(task.status)
        ? task
        : { ...task, status: "cancelled" as const, endedAt },
    );
    return { ...run, tasks, cancelled: true, interrupted: true, endedAt };
  });
}

export function loadMissionState(): MissionPersistedState | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(MISSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1) return null;
    const flows = Array.isArray(parsed.flows) ? parsed.flows.filter(isMissionFlow) : [];
    const runsRaw = Array.isArray(parsed.runs) ? parsed.runs.filter(isMissionRun) : [];
    const inbox = Array.isArray(parsed.inbox)
      ? parsed.inbox.filter(isMissionInboxItem)
      : [];
    return {
      version: 1,
      flows,
      runs: applyInterruptedSemantics(runsRaw),
      inbox,
    };
  } catch (error) {
    console.warn("[mission] persisted state could not be read; starting clean", error);
    return null;
  }
}

/** 裁剪到有界体积后写入；写入失败只告警。 */
export function saveMissionState(state: MissionPersistedState): void {
  if (typeof localStorage === "undefined") return;
  try {
    const trimmedRuns: MissionRun[] = [];
    const perFlow = new Map<string, number>();
    for (const run of [...state.runs].reverse()) {
      const count = perFlow.get(run.flowId) ?? 0;
      if (count >= MAX_RUNS_PER_FLOW) continue;
      perFlow.set(run.flowId, count + 1);
      trimmedRuns.push(run);
    }
    const payload: MissionPersistedState = {
      version: 1,
      flows: state.flows.map((flow) => ({
        ...flow,
        versions: flow.versions.slice(-MAX_VERSION_HISTORY),
        messages: flow.messages.slice(-MAX_MESSAGES_PER_FLOW),
      })),
      runs: trimmedRuns.reverse(),
      inbox: state.inbox.slice(0, MAX_INBOX_ITEMS),
    };
    localStorage.setItem(MISSION_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn("[mission] persisted state could not be written", error);
  }
}

export interface MissionPersistenceHost {
  load: () => MissionPersistedState | null;
  save: (state: MissionPersistedState) => void;
  subscribe: (listener: () => void) => () => void;
  snapshot: () => {
    flows: MissionFlow[];
    runs: Record<string, MissionRun>;
    inbox: MissionInboxItem[];
  };
}

/**
 * 绑定一次：先 hydrate（由调用方把数据写进 store），再订阅 store 变化并
 * 防抖写盘；pagehide 时同步补写一次。返回解绑函数（测试用）。
 */
export function initMissionPersistence(host: MissionPersistenceHost): {
  hydrated: MissionPersistedState | null;
  dispose: () => void;
} {
  const hydrated = host.load();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const flush = (): void => {
    if (disposed) return;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const { flows, runs, inbox } = host.snapshot();
    host.save({ version: 1, flows, runs: Object.values(runs), inbox });
  };
  const unsubscribe = host.subscribe(() => {
    if (disposed) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
  });
  const onPageHide = (): void => flush();
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", onPageHide);
  }
  return {
    hydrated,
    dispose: () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      unsubscribe();
      if (typeof window !== "undefined") {
        window.removeEventListener("pagehide", onPageHide);
      }
    },
  };
}
