import { create } from "zustand";
import { missionId } from "./ids";
import type {
  MissionConversationMessage,
  MissionFlow,
  MissionFlowDefinition,
  MissionInboxItem,
  MissionRun,
  MissionRunExecution,
} from "./types";

/** 中心页签 key 前缀；use-chat-tabs 按它路由 select/close。 */
export const MISSION_TAB_PREFIX = "mission:";
export const MISSION_WORKBENCH_TAB_KEY = MISSION_TAB_PREFIX + "workbench";

export type MissionView = "studio" | "flows" | "inbox";
export type MissionCanvasMode = "definition" | "run";
export type MissionFlowFilter = "all" | "running" | "attention" | "done" | "draft";
export type MissionInboxFilter = "all" | "attention" | "failed" | "done";

interface MissionStoreState {
  /** 中心页签是否打开。 */
  open: boolean;
  /** 工作台是否为当前中心页签。 */
  active: boolean;
  activeView: MissionView;
  flows: MissionFlow[];
  runs: Record<string, MissionRun>;
  inbox: MissionInboxItem[];
  selectedFlowId: string | null;
  selectedRunId: string | null;
  canvasMode: MissionCanvasMode;
  selectedNodeKey: string | null;
  selectedInboxId: string | null;
  flowFilter: MissionFlowFilter;
  flowSearch: string;
  inboxFilter: MissionInboxFilter;
  inboxSearch: string;
  /** 正在生成提案的流程（AI 编排中的 spinner/禁用发送）。 */
  generatingByFlow: Record<string, boolean>;
  setGenerating: (flowId: string, generating: boolean) => void;
  /** 打开（或聚焦）工作台中心页签。 */
  openWorkbench: () => void;
  activate: () => void;
  deactivate: () => void;
  close: () => void;
  setActiveView: (view: MissionView) => void;
  setCanvasMode: (mode: MissionCanvasMode) => void;
  selectFlow: (flowId: string, mode?: MissionCanvasMode, runId?: string | null) => void;
  selectNode: (nodeKey: string | null) => void;
  selectInbox: (id: string | null) => void;
  setFlowFilter: (filter: MissionFlowFilter) => void;
  setFlowSearch: (search: string) => void;
  setInboxFilter: (filter: MissionInboxFilter) => void;
  setInboxSearch: (search: string) => void;
  /** 插入或替换流程（按 id）。 */
  upsertFlow: (flow: MissionFlow) => void;
  /** 新建一个空白流程并选中它，返回新流程 id。 */
  createFlow: () => string;
  /** 更新草稿（调用方先跑校验；此处只写状态）。 */
  updateDraft: (flowId: string, draft: MissionFlowDefinition) => void;
  /** 固定/清除流程的执行配置（null = 跟随当前会话/默认）。 */
  setFlowExecution: (flowId: string, execution: MissionRunExecution | null) => void;
  appendMessage: (flowId: string, message: MissionConversationMessage) => void;
  /** 插入或替换运行快照。 */
  upsertRun: (run: MissionRun) => void;
  /** 从持久化存储回放流程/运行/收件箱（M4）。 */
  hydrate: (state: {
    flows: MissionFlow[];
    runs: MissionRun[];
    inbox: MissionInboxItem[];
  }) => void;
  /** 插入或替换收件箱消息，按 dedupeKey 去重。 */
  upsertInbox: (item: MissionInboxItem) => void;
  markInboxRead: (id: string) => void;
  markAllInboxRead: () => void;
  resolveInbox: (id: string, resolution: string) => void;
  /** 删除消息（仅用于测试清理/重置）。 */
  removeInbox: (id: string) => void;
}

function replaceById<T extends { id: string }>(list: T[], next: T): T[] {
  const index = list.findIndex((item) => item.id === next.id);
  if (index < 0) return [...list, next];
  const copy = list.slice();
  copy[index] = next;
  return copy;
}

/** 任务工作台状态：流程列表 / 草稿 / 运行 / 收件箱 + 中心页签开关。
 *
 * 运行与收件箱由 engine/runtime 通过 upsert* 同步进来；组件只读。
 * 运行期状态默认只在页面内有效（持久化里程碑见方案 §6 M4）。 */
export const useMissionStore = create<MissionStoreState>()((set, get) => ({
  open: false,
  active: false,
  activeView: "studio",
  flows: [],
  runs: {},
  inbox: [],
  selectedFlowId: null,
  selectedRunId: null,
  canvasMode: "run",
  selectedNodeKey: null,
  selectedInboxId: null,
  flowFilter: "all",
  flowSearch: "",
  inboxFilter: "all",
  inboxSearch: "",
  generatingByFlow: {},

  openWorkbench: () => set({ open: true, active: true }),
  activate: () => set({ active: true }),
  deactivate: () => {
    if (!get().active) return;
    set({ active: false });
  },
  close: () => set({ open: false, active: false }),

  setActiveView: (activeView) => set({ activeView }),
  setCanvasMode: (canvasMode) => set({ canvasMode, selectedNodeKey: null }),
  selectFlow: (flowId, mode, runId) => {
    const flow = get().flows.find((item) => item.id === flowId);
    if (!flow) return;
    const targetRunId =
      runId !== undefined ? runId : (flow.runIds.at(-1) ?? null);
    set({
      selectedFlowId: flowId,
      selectedRunId: targetRunId,
      canvasMode: mode ?? (targetRunId ? "run" : "definition"),
      selectedNodeKey: null,
      activeView: "studio",
    });
  },
  selectNode: (selectedNodeKey) => set({ selectedNodeKey }),
  selectInbox: (selectedInboxId) => {
    const state = get();
    if (selectedInboxId) {
      const item = state.inbox.find((row) => row.id === selectedInboxId);
      if (item && !item.read) {
        set({
          selectedInboxId,
          inbox: state.inbox.map((row) =>
            row.id === selectedInboxId ? { ...row, read: true } : row,
          ),
        });
        return;
      }
    }
    set({ selectedInboxId });
  },
  setFlowFilter: (flowFilter) => set({ flowFilter }),
  setFlowSearch: (flowSearch) => set({ flowSearch }),
  setInboxFilter: (inboxFilter) => set({ inboxFilter }),
  setInboxSearch: (inboxSearch) => set({ inboxSearch }),
  setGenerating: (flowId, generating) =>
    set((state) => ({
      generatingByFlow: { ...state.generatingByFlow, [flowId]: generating },
    })),

  upsertFlow: (flow) => set((state) => ({ flows: replaceById(state.flows, flow) })),
  createFlow: () => {
    const now = Date.now();
    const flow: MissionFlow = {
      id: missionId("flow"),
      name: "",
      goal: "",
      draft: null,
      versions: [],
      runIds: [],
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    set((state) => ({
      flows: [flow, ...state.flows],
      selectedFlowId: flow.id,
      selectedRunId: null,
      canvasMode: "definition",
      selectedNodeKey: null,
      activeView: "studio",
    }));
    return flow.id;
  },
  updateDraft: (flowId, draft) =>
    set((state) => ({
      flows: state.flows.map((flow) =>
        flow.id === flowId
          ? { ...flow, draft, name: draft.name, goal: draft.goal, updatedAt: Date.now() }
          : flow,
      ),
    })),
  setFlowExecution: (flowId, execution) =>
    set((state) => ({
      flows: state.flows.map((flow) =>
        flow.id === flowId ? { ...flow, execution, updatedAt: Date.now() } : flow,
      ),
    })),
  appendMessage: (flowId, message) =>
    set((state) => ({
      flows: state.flows.map((flow) =>
        flow.id === flowId
          ? { ...flow, messages: [...flow.messages, message], updatedAt: Date.now() }
          : flow,
      ),
    })),
  upsertRun: (run) =>
    set((state) => ({
      runs: { ...state.runs, [run.id]: run },
      flows: state.flows.some((flow) => flow.runIds.includes(run.id))
        ? state.flows
        : state.flows.map((flow) =>
            flow.id === run.flowId
              ? { ...flow, runIds: [...flow.runIds, run.id] }
              : flow,
          ),
    })),
  hydrate: ({ flows, runs, inbox }) => {
    const runMap: Record<string, MissionRun> = {};
    for (const run of runs) runMap[run.id] = run;
    set((state) => {
      const selectedFlowId =
        state.selectedFlowId && flows.some((flow) => flow.id === state.selectedFlowId)
          ? state.selectedFlowId
          : (flows[0]?.id ?? null);
      const selectedRunId = selectedFlowId
        ? (runs.filter((run) => run.flowId === selectedFlowId).at(-1)?.id ?? null)
        : null;
      return {
        flows,
        runs: runMap,
        inbox,
        selectedFlowId,
        selectedRunId,
        canvasMode: selectedRunId ? "run" : "definition",
        selectedNodeKey: null,
      };
    });
  },
  upsertInbox: (item) =>
    set((state) => {
      const existing = state.inbox.findIndex(
        (row) => row.dedupeKey === item.dedupeKey || row.id === item.id,
      );
      if (existing < 0) return { inbox: [item, ...state.inbox] };
      // 去重：保留已有的 read/resolved 处理结果，只刷新展示内容。
      const copy = state.inbox.slice();
      const mine = copy[existing];
      copy[existing] =
        mine.dedupeKey === item.dedupeKey
          ? {
              ...item,
              id: mine.id,
              read: mine.read,
              resolved: mine.resolved,
              resolution: mine.resolution,
            }
          : item;
      return { inbox: copy };
    }),
  markInboxRead: (id) =>
    set((state) => ({
      inbox: state.inbox.map((item) =>
        item.id === id ? { ...item, read: true } : item,
      ),
    })),
  markAllInboxRead: () =>
    set((state) => ({ inbox: state.inbox.map((item) => ({ ...item, read: true })) })),
  resolveInbox: (id, resolution) =>
    set((state) => ({
      inbox: state.inbox.map((item) =>
        item.id === id ? { ...item, read: true, resolved: true, resolution } : item,
      ),
    })),
  removeInbox: (id) =>
    set((state) => ({ inbox: state.inbox.filter((item) => item.id !== id) })),
}));

/** 重置到初始状态（测试用）。 */
export function resetMissionStore(): void {
  useMissionStore.setState({
    open: false,
    active: false,
    activeView: "studio",
    flows: [],
    runs: {},
    inbox: [],
    selectedFlowId: null,
    selectedRunId: null,
    canvasMode: "run",
    selectedNodeKey: null,
    selectedInboxId: null,
    flowFilter: "all",
    flowSearch: "",
    inboxFilter: "all",
    inboxSearch: "",
    generatingByFlow: {},
  });
}
