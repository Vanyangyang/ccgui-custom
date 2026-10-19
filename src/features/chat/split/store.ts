import { create } from "zustand";
import { readStoredJson, writeStored } from "@/lib/storage";
import { useChatStore } from "../store";
import { sameTab, parseDraftSessionKey, sessionKey, type ActiveSession } from "../store/persistence";
import {
  findPane,
  listPanes,
  makeBranch,
  makePane,
  movePane,
  parsePersistedLayout,
  removePane,
  setBranchRatio,
  solePane,
  SOLO_PANE_ID,
  splitPaneWith,
  swapPaneSessions,
  updatePaneSession,
  type DropZone,
  type LayoutNode,
  type SplitDirection,
} from "./tree";

/**
 * 中心区分屏布局：Trellis 式的递归切分，格子与会话一一对应。
 *
 * 两条不变量：
 * 1. 分屏开启（root 非空）时，页签被关掉/删掉的会话，它所在的格子一起消失；
 * 2. 全局 `active`（页签条高亮的那条对话）变化时，它要么聚焦到自己所在的格子，
 *    要么落进当前聚焦的格子（替换原内容）。所以「点侧栏会话」在分屏下就是
 *    「已在分屏里 → 聚焦那格；否则替换聚焦格」。
 *
 * 空格子（session = null）是允许的：切分出来的新格子先空着，等拖入或新建。
 */

export const SPLIT_LAYOUT_KEY = "ccgui-next.splitLayout:v1";

interface SplitState {
  /** null = 单栏模式（跟随全局 active，渲染成没有标题栏的那一栏）。 */
  root: LayoutNode | null;
  focusedPaneId: string | null;
}

interface SplitActions {
  /** 拖动会话落到某格：中心 = 放入/移入，边 = 在该方向切分。 */
  dropSession: (targetPaneId: string, zone: DropZone, session: ActiveSession) => void;
  /** 拖动已有格子：中心 = 内容互换，边 = 移动到目标格子旁。 */
  dropPane: (sourcePaneId: string, targetPaneId: string, zone: DropZone) => void;
  /** 切分出空格子（格子标题栏的「向右/向下分屏」按钮）。 */
  splitPane: (paneId: string, direction: SplitDirection) => void;
  closePane: (paneId: string) => void;
  focusPane: (paneId: string) => void;
  setRatio: (branchId: string, ratio: number) => void;
  /** 退出分屏，回到单栏。 */
  resetLayout: () => void;
}

export type SplitStore = SplitState & SplitActions;

function keyOf(session: ActiveSession | null | undefined): string | null {
  return session ? sessionKey(session.engine, session.sessionId, session.workspacePath) : null;
}

function paneHolding(root: LayoutNode | null, session: ActiveSession | null): string | null {
  if (!session) return null;
  const key = keyOf(session);
  return listPanes(root).find((pane) => keyOf(pane.session) === key)?.id ?? null;
}

/** 激活一个会话：分屏里点格子、拖入会话、聚焦切换都走这里，页签条随之跟上。 */
function activateSession(session: ActiveSession | null | undefined): void {
  if (!session) return;
  const chat = useChatStore.getState();
  if (chat.active && keyOf(chat.active) === keyOf(session)) return;
  chat.focusTab(session.engine, session.sessionId, session.workspacePath);
}

function readPersisted(): SplitState {
  const stored = readStoredJson(SPLIT_LAYOUT_KEY, (raw) => parsePersistedLayout(raw));
  return stored
    ? { root: stored.root, focusedPaneId: stored.focusedPaneId }
    : { root: null, focusedPaneId: null };
}

function persist(state: SplitState): void {
  if (!state.root) {
    try {
      localStorage.removeItem(SPLIT_LAYOUT_KEY);
    } catch {
      // 与 writeStored 一致：存储不可用/写满都只影响持久化，不影响内存状态。
    }
    return;
  }
  writeStored(
    SPLIT_LAYOUT_KEY,
    JSON.stringify({ root: state.root, focusedPaneId: state.focusedPaneId }),
  );
}

export const useSplitStore = create<SplitStore>((set, get) => {
  /** 统一的写入口：只在真的变化时落盘（拖动分隔条会高频调用）。 */
  const commit = (next: Partial<SplitState>) => {
    const before = get();
    const root = next.root !== undefined ? next.root : before.root;
    const focusedPaneId =
      next.focusedPaneId !== undefined ? next.focusedPaneId : before.focusedPaneId;
    if (root === before.root && focusedPaneId === before.focusedPaneId) return;
    set({ root, focusedPaneId });
    persist({ root, focusedPaneId });
  };

  const focusHold = (paneId: string) => commit({ focusedPaneId: paneId });

  /** 分屏开启后新格子要跟全局 active 对齐（见 reconcileLayout）。 */
  return {
    ...readPersisted(),

    dropSession: (targetPaneId, zone, session) => {
      const { root } = get();
      const sessionKeyValue = keyOf(session);

      if (!root) {
        // 单栏模式：中心 = 直接切到该会话；边 = 以当前会话为邻切出分屏。
        if (zone === "center") {
          activateSession(session);
          return;
        }
        const active = useChatStore.getState().active;
        const sameActive = active ? keyOf(active) === sessionKeyValue : false;
        // 拖的正是当前显示的会话：切出一格空格子，不去复制同一段对话。
        const droppedPane = makePane(sameActive ? null : session);
        const soloPane = makePane(active ?? null);
        const direction: SplitDirection = zone === "left" || zone === "right" ? "row" : "col";
        const first = zone === "left" || zone === "top" ? droppedPane : soloPane;
        const second = zone === "left" || zone === "top" ? soloPane : droppedPane;
        commit({ root: makeBranch(direction, first, second), focusedPaneId: droppedPane.id });
        if (!sameActive) activateSession(session);
        return;
      }

      const sourcePaneId = paneHolding(root, session);
      if (zone === "center") {
        let nextRoot = updatePaneSession(root, targetPaneId, session);
        // 会话原本在别的格子里：把它从原格摘走（移动，而不是复制）。
        if (sourcePaneId && sourcePaneId !== targetPaneId) {
          nextRoot = updatePaneSession(nextRoot, sourcePaneId, null);
        }
        commit({ root: nextRoot, focusedPaneId: targetPaneId });
        activateSession(session);
        return;
      }

      const direction: SplitDirection = zone === "left" || zone === "right" ? "row" : "col";
      const position = zone === "left" || zone === "top" ? "before" : "after";
      if (sourcePaneId) {
        // 已在某个格子里：整格搬过来（同格自身落边是空操作）。
        if (sourcePaneId === targetPaneId) {
          focusHold(targetPaneId);
          return;
        }
        const moved = movePane(root, sourcePaneId, targetPaneId, zone);
        commit({ root: moved, focusedPaneId: sourcePaneId });
        activateSession(session);
        return;
      }
      const pane = makePane(session);
      commit({
        root: splitPaneWith(root, targetPaneId, position, direction, pane),
        focusedPaneId: pane.id,
      });
      activateSession(session);
    },

    dropPane: (sourcePaneId, targetPaneId, zone) => {
      const { root } = get();
      if (!root || sourcePaneId === targetPaneId) return;
      if (zone === "center") {
        commit({ root: swapPaneSessions(root, sourcePaneId, targetPaneId), focusedPaneId: sourcePaneId });
        return;
      }
      const moved = movePane(root, sourcePaneId, targetPaneId, zone);
      if (moved === root) return;
      commit({ root: moved, focusedPaneId: sourcePaneId });
      activateSession(findPane(moved, sourcePaneId)?.session ?? null);
    },

    splitPane: (paneId, direction) => {
      const { root } = get();
      if (!root) {
        // 单栏：以当前会话为准左右/上下切分，新格子空着等拖入（在右/下侧）。
        const active = useChatStore.getState().active;
        const soloPane = makePane(active ?? null);
        const emptyPane = makePane(null);
        commit({
          root: makeBranch(direction, soloPane, emptyPane),
          focusedPaneId: emptyPane.id,
        });
        return;
      }
      const pane = makePane(null);
      const next = splitPaneWith(root, paneId, "after", direction, pane);
      // 目标格已不在树里（旧引用）：不把一个不属于任何格的 id 设成聚焦格。
      if (next === root) return;
      commit({ root: next, focusedPaneId: pane.id });
    },

    closePane: (paneId) => {
      const { root, focusedPaneId } = get();
      if (!root) return;
      const rest = removePane(root, paneId);
      if (solePane(rest)) {
        // 只剩一格：回到单栏模式（会话照旧留在页签里，不会被关掉）。
        commit({ root: null, focusedPaneId: null });
        return;
      }
      const panes = listPanes(rest);
      const focused = panes.some((pane) => pane.id === focusedPaneId)
        ? focusedPaneId
        : (panes[0]?.id ?? null);
      commit({ root: rest, focusedPaneId: focused });
    },

    focusPane: (paneId) => {
      const { root } = get();
      const pane = findPane(root, paneId);
      if (!pane) return;
      focusHold(paneId);
      activateSession(pane.session);
    },

    setRatio: (branchId, ratio) => {
      const { root } = get();
      if (!root) return;
      const next = setBranchRatio(root, branchId, ratio);
      if (next === root) return;
      commit({ root: next });
    },

    resetLayout: () => {
      if (!get().root) return;
      commit({ root: null, focusedPaneId: null });
    },
  };
});

/* ------------------------------------------------------------------ */
/* 与聊天 store 的同步                                                  */
/* ------------------------------------------------------------------ */

export interface ReconcileInput {
  root: LayoutNode | null;
  focusedPaneId: string | null;
  lastActiveKey: string | null;
}

export interface ReconcileResult {
  root: LayoutNode | null;
  focusedPaneId: string | null;
  lastActiveKey: string | null;
}

/**
 * 把分屏布局对齐到聊天 store 的事实：
 * - 页签没了的会话，它所在的格子摘掉（关页签 = 退出一格，不额外关会话）；
 * - 激活会话变了：聚焦它所在的格子；它不在任何格子里就落进当前聚焦格；
 * - draft 转正（sessionId 由 null 变成真实 id）时，原格子跟着换成新记录；
 * - 只剩一格就回单栏。
 */
export function reconcileLayout(
  input: ReconcileInput,
  chat: { active: ActiveSession | null; openTabs: ActiveSession[] },
): ReconcileResult {
  const activeKey = keyOf(chat.active);
  if (!input.root) {
    return { root: null, focusedPaneId: null, lastActiveKey: activeKey };
  }
  let root: LayoutNode | null = input.root;
  for (const pane of listPanes(root)) {
    const session = pane.session;
    if (!session) continue;
    const paneKey = keyOf(session);
    if (paneKey === activeKey) continue;
    // draft 转正：格子里的旧 key 就是这轮对话在激活前的 key，先不当作closed。
    if (paneKey === input.lastActiveKey) continue;
    const stillOpen = chat.openTabs.some((tab) =>
      sameTab(tab, session.engine, session.sessionId, session.workspacePath),
    );
    if (stillOpen) continue;
    root = removePane(root, pane.id);
    if (!root) return { root: null, focusedPaneId: null, lastActiveKey: activeKey };
  }

  let focusedPaneId = input.focusedPaneId;
  const panes = listPanes(root);
  if (activeKey && activeKey !== input.lastActiveKey) {
    const holder =
      panes.find((pane) => keyOf(pane.session) === activeKey) ??
      // draft 转正：旧 key 指向的那个格子就是这轮对话。
      (input.lastActiveKey
        ? panes.find((pane) => keyOf(pane.session) === input.lastActiveKey)
        : undefined);
    if (holder) {
      focusedPaneId = holder.id;
      if (holder.session !== chat.active) {
        root = updatePaneSession(root, holder.id, chat.active);
      }
    } else {
      const target =
        focusedPaneId && findPane(root, focusedPaneId)
          ? focusedPaneId
          : (panes[0]?.id ?? null);
      if (target && chat.active) {
        root = updatePaneSession(root, target, chat.active);
        focusedPaneId = target;
      } else {
        focusedPaneId = target;
      }
    }
  } else if (activeKey) {
    const holder = panes.find((pane) => keyOf(pane.session) === activeKey);
    if (holder && holder.session !== chat.active) {
      root = updatePaneSession(root, holder.id, chat.active);
    }
  }

  if (!focusedPaneId || !findPane(root, focusedPaneId)) {
    focusedPaneId = listPanes(root)[0]?.id ?? null;
  }
  if (solePane(root)) {
    return { root: null, focusedPaneId: null, lastActiveKey: activeKey };
  }
  return { root, focusedPaneId, lastActiveKey: activeKey };
}

/** 会话所在的格子 id；未分屏或不在分屏里时为 null。 */
export function paneIdForSession(session: ActiveSession | null): string | null {
  return paneHolding(useSplitStore.getState().root, session);
}

/** 侧栏行 id（`engine/sessionId`，或 pending 页签的 `new:engine:path`）
 *  → 可拖拽/可落位的会话；查不到时返回 null（不提供拖拽入口）。 */
export function sessionFromThreadId(threadId: string | undefined): ActiveSession | null {
  if (!threadId) return null;
  if (threadId.startsWith("new:")) {
    const draft = parseDraftSessionKey(threadId);
    return draft
      ? { engine: draft.engine, sessionId: null, workspacePath: draft.workspacePath }
      : null;
  }
  const slash = threadId.indexOf("/");
  if (slash <= 0) return null;
  const engine = threadId.slice(0, slash);
  const sessionId = threadId.slice(slash + 1);
  const chat = useChatStore.getState();
  const tab = chat.openTabs.find((t) => t.engine === engine && t.sessionId === sessionId);
  if (tab) return tab;
  const meta = chat.sessions.find((s) => s.engine === engine && s.sessionId === sessionId);
  return meta ? { engine, sessionId, workspacePath: meta.workspacePath } : null;
}

/** 「在右侧/下方分屏打开」类入口：等价于把会话拖到聚焦格的对应边上。 */
export function openSessionBeside(session: ActiveSession, zone: "left" | "right" | "top" | "bottom"): void {
  const { root, focusedPaneId } = useSplitStore.getState();
  const target = root
    ? (focusedPaneId ?? listPanes(root)[0]?.id ?? SOLO_PANE_ID)
    : SOLO_PANE_ID;
  useSplitStore.getState().dropSession(target, zone, session);
}

let installed = false;
let lastActive: ActiveSession | null = null;
let lastOpenTabs: ActiveSession[] | null = null;
let lastActiveKey: string | null = null;

/** 订阅聊天 store，把分屏布局保持在上面那两条不变量上。幂等。 */
export function installSplitSync(): void {
  if (installed) return;
  installed = true;
  const sync = () => {
    const chat = useChatStore.getState();
    if (chat.active === lastActive && chat.openTabs === lastOpenTabs) return;
    lastActive = chat.active;
    lastOpenTabs = chat.openTabs;
    const before = useSplitStore.getState();
    const next = reconcileLayout(
      { root: before.root, focusedPaneId: before.focusedPaneId, lastActiveKey },
      chat,
    );
    lastActiveKey = next.lastActiveKey;
    if (next.root === before.root && next.focusedPaneId === before.focusedPaneId) return;
    useSplitStore.setState({ root: next.root, focusedPaneId: next.focusedPaneId });
    persist({ root: next.root, focusedPaneId: next.focusedPaneId });
  };
  // 首次对齐：把 lastActiveKey 当作「变了」，让恢复出来的布局聚焦到当前会话。
  lastActive = null;
  lastOpenTabs = null;
  lastActiveKey = null;
  useChatStore.subscribe(sync);
  sync();
}
