import type { ActiveSession } from "../store/persistence";

/**
 * 对话区分屏布局树（Trellis 式递归分屏）。
 *
 * 叶子 = 一个分屏格（`session: null` 表示空格子，等待拖入/新建会话）；
 * 分支 = 一次切分，`ratio` 是 first 占的份额。树是纯数据：这里所有导出函数
 * 都是不可变变换，方便 store 比较引用、也方便单测。
 *
 * 约定：`row` 表示左右切分（first 在左），`col` 表示上下切分（first 在上）。
 */

export type SplitDirection = "row" | "col";

/** 拖拽落点：四条边各划出一块切分带，中心是「替换/互换」。 */
export type DropZone = "left" | "right" | "top" | "bottom" | "center";

/** 单栏模式下没有真实格子节点，拖拽落点用它当目标。 */
export const SOLO_PANE_ID = "solo";

export interface PaneNode {
  kind: "pane";
  id: string;
  session: ActiveSession | null;
}

export interface BranchNode {
  kind: "split";
  id: string;
  direction: SplitDirection;
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
}

export type LayoutNode = PaneNode | BranchNode;

export const MIN_RATIO = 0.12;
export const MAX_RATIO = 0.88;

export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

let idCounter = 0;

/** 布局内的节点 id 只在运行时用于 key / 定位，不参与持久化语义。 */
export function nextNodeId(prefix: "pane" | "split"): string {
  idCounter += 1;
  return `${prefix}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function makePane(session: ActiveSession | null, id = nextNodeId("pane")): PaneNode {
  return { kind: "pane", id, session };
}

export function makeBranch(
  direction: SplitDirection,
  first: LayoutNode,
  second: LayoutNode,
  ratio = 0.5,
  id = nextNodeId("split"),
): BranchNode {
  return { kind: "split", id, direction, ratio: clampRatio(ratio), first, second };
}

export function isPane(node: LayoutNode): node is PaneNode {
  return node.kind === "pane";
}

/** 深度优先展开所有格子（渲染顺序 = 视觉顺序）。 */
export function listPanes(root: LayoutNode | null): PaneNode[] {
  const out: PaneNode[] = [];
  const walk = (node: LayoutNode) => {
    if (node.kind === "pane") {
      out.push(node);
      return;
    }
    walk(node.first);
    walk(node.second);
  };
  if (root) walk(root);
  return out;
}

export function findPane(root: LayoutNode | null, paneId: string): PaneNode | null {
  if (!root) return null;
  if (root.kind === "pane") return root.id === paneId ? root : null;
  return findPane(root.first, paneId) ?? findPane(root.second, paneId);
}

/** 单栏模式判定：整棵树只剩一个格子时按单栏渲染（不带格子标题栏）。 */
export function solePane(root: LayoutNode | null): PaneNode | null {
  return root && root.kind === "pane" ? root : null;
}

/** 逐格替换：`fn` 返回同一个引用时不产生新树（store 依赖引用相等早退）。 */
export function mapPanes(
  root: LayoutNode,
  fn: (pane: PaneNode) => PaneNode,
): LayoutNode {
  if (root.kind === "pane") return fn(root);
  const first = mapPanes(root.first, fn);
  const second = mapPanes(root.second, fn);
  if (first === root.first && second === root.second) return root;
  return { ...root, first, second };
}

/** 把某个格子的会话换成别的（拖入、全局 active 回填都用它）。 */
export function updatePaneSession(
  root: LayoutNode,
  paneId: string,
  session: ActiveSession | null,
): LayoutNode {
  return mapPanes(root, (pane) =>
    pane.id === paneId && pane.session !== session ? { ...pane, session } : pane,
  );
}

export function setBranchRatio(
  root: LayoutNode,
  branchId: string,
  ratio: number,
): LayoutNode {
  const next = clampRatio(ratio);
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.kind === "pane") return node;
    const first = walk(node.first);
    const second = walk(node.second);
    if (node.id === branchId) {
      if (first === node.first && second === node.second && next === node.ratio) return node;
      return { ...node, first, second, ratio: next };
    }
    if (first === node.first && second === node.second) return node;
    return { ...node, first, second };
  };
  return walk(root);
}

/** 一个格子里切出新的兄弟格：`before` = 新格子排在原格子前面（左/上）。 */
export function splitPaneWith(
  root: LayoutNode,
  paneId: string,
  position: "before" | "after",
  direction: SplitDirection,
  pane: PaneNode,
): LayoutNode {
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.kind === "pane") {
      if (node.id !== paneId) return node;
      return position === "before"
        ? makeBranch(direction, pane, node)
        : makeBranch(direction, node, pane);
    }
    const first = walk(node.first);
    const second = walk(node.second);
    if (first === node.first && second === node.second) return node;
    return { ...node, first, second };
  };
  return walk(root);
}

/** 摘掉一个格子并折叠它的父分支；返回 null 表示树空了。 */
export function removePane(root: LayoutNode, paneId: string): LayoutNode | null {
  const walk = (node: LayoutNode): LayoutNode | null => {
    if (node.kind === "pane") return node.id === paneId ? null : node;
    const first = walk(node.first);
    const second = walk(node.second);
    if (!first && !second) return null;
    if (!first) return second;
    if (!second) return first;
    if (first === node.first && second === node.second) return node;
    return { ...node, first, second };
  };
  return walk(root);
}

/** 拖拽重排：把 source 格子摘下来，插到 target 格子的某条边上。 */
export function movePane(
  root: LayoutNode,
  sourcePaneId: string,
  targetPaneId: string,
  side: Exclude<DropZone, "center">,
): LayoutNode {
  if (sourcePaneId === targetPaneId) return root;
  const source = findPane(root, sourcePaneId);
  if (!source || !findPane(root, targetPaneId)) return root;
  const rest = removePane(root, sourcePaneId);
  if (!rest) return root;
  if (!findPane(rest, targetPaneId)) return root;
  const direction: SplitDirection = side === "left" || side === "right" ? "row" : "col";
  const position = side === "left" || side === "top" ? "before" : "after";
  return splitPaneWith(rest, targetPaneId, position, direction, source);
}

/** 两格互换内容（拖到另一格中心）。 */
export function swapPaneSessions(
  root: LayoutNode,
  aPaneId: string,
  bPaneId: string,
): LayoutNode {
  const a = findPane(root, aPaneId);
  const b = findPane(root, bPaneId);
  if (!a || !b || aPaneId === bPaneId) return root;
  return mapPanes(root, (pane) => {
    if (pane.id === aPaneId) return { ...pane, session: b.session };
    if (pane.id === bPaneId) return { ...pane, session: a.session };
    return pane;
  });
}

/* ------------------------------------------------------------------ */
/* 几何：把树摊平成绝对定位的矩形（渲染与命中判定共用一套坐标）          */
/* ------------------------------------------------------------------ */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PaneRect {
  pane: PaneNode;
  rect: Rect;
}

export interface DividerRect {
  branchId: string;
  direction: SplitDirection;
  /** 该分支当前的 first 份额（分隔条的 aria-valuenow / 键盘调整用）。 */
  ratio: number;
  /** 分隔条所在分支的矩形（拖拽时把像素换算成 ratio 用）。 */
  branchRect: Rect;
  /** 分隔条的零厚度位置，渲染时按方向居中描线。 */
  rect: Rect;
}

const UNIT_RECT: Rect = { x: 0, y: 0, w: 1, h: 1 };

/**
 * 树 → 矩形列表。分屏格用扁平的绝对定位渲染（而不是嵌套 flex），这样增删
 * 格子只改坐标、不改组件层级：已有格子不会被卸载，滚动位置与输入状态都留住。
 */
export function layoutGeometry(
  root: LayoutNode,
  rect: Rect = UNIT_RECT,
): { panes: PaneRect[]; dividers: DividerRect[] } {
  const panes: PaneRect[] = [];
  const dividers: DividerRect[] = [];
  const walk = (node: LayoutNode, box: Rect) => {
    if (node.kind === "pane") {
      panes.push({ pane: node, rect: box });
      return;
    }
    if (node.direction === "row") {
      const firstW = box.w * node.ratio;
      walk(node.first, { x: box.x, y: box.y, w: firstW, h: box.h });
      walk(node.second, {
        x: box.x + firstW,
        y: box.y,
        w: box.w - firstW,
        h: box.h,
      });
      dividers.push({
        branchId: node.id,
        direction: "row",
        ratio: node.ratio,
        branchRect: box,
        rect: { x: box.x + firstW, y: box.y, w: 0, h: box.h },
      });
      return;
    }
    const firstH = box.h * node.ratio;
    walk(node.first, { x: box.x, y: box.y, w: box.w, h: firstH });
    walk(node.second, {
      x: box.x,
      y: box.y + firstH,
      w: box.w,
      h: box.h - firstH,
    });
    dividers.push({
      branchId: node.id,
      direction: "col",
      ratio: node.ratio,
      branchRect: box,
      rect: { x: box.x, y: box.y + firstH, w: box.w, h: 0 },
    });
  };
  walk(root, rect);
  return { panes, dividers };
}

/** 边带宽度：格子的 28%，并夹在 28~110px 之间，小格子也不至于全是边带。 */
export function edgeBand(size: number): number {
  return Math.max(28, Math.min(110, size * 0.28));
}

/** 指针坐标 → 落点区域。矩形与坐标同一坐标系（都用 client 像素）。 */
export function dropZoneAt(rect: Rect, x: number, y: number): DropZone {
  const bx = edgeBand(rect.w);
  const by = edgeBand(rect.h);
  const left = x - rect.x;
  const right = rect.x + rect.w - x;
  const top = y - rect.y;
  const bottom = rect.y + rect.h - y;
  const minX = Math.min(left, right);
  const minY = Math.min(top, bottom);
  // 先比纵向：否则窄格子里「上/下」会被「左/右」长期压住。
  if (minY <= minX) {
    if (minY > by) return "center";
    return top <= bottom ? "top" : "bottom";
  }
  if (minX > bx) return "center";
  return left <= right ? "left" : "right";
}

/* ------------------------------------------------------------------ */
/* 持久化                                                              */
/* ------------------------------------------------------------------ */

const MAX_PERSISTED_PANES = 12;

function isSession(value: unknown): value is ActiveSession {
  const session = value as ActiveSession;
  return (
    !!session &&
    typeof session === "object" &&
    typeof session.engine === "string" &&
    typeof session.workspacePath === "string" &&
    (session.sessionId === null || typeof session.sessionId === "string")
  );
}

function parseNode(raw: unknown): LayoutNode | null {
  if (!raw || typeof raw !== "object") return null;
  const node = raw as {
    kind?: unknown;
    session?: unknown;
    first?: unknown;
    second?: unknown;
    direction?: unknown;
    ratio?: unknown;
  };
  if (node.kind === "pane") {
    if (node.session !== null && !isSession(node.session)) return null;
    // id 重新生成：持久化里的 id 只保证当时唯一，重建时让它们与运行时一致。
    return makePane(node.session ?? null);
  }
  if (node.kind === "split") {
    const first = parseNode(node.first);
    const second = parseNode(node.second);
    if (!first || !second) return null;
    const direction = node.direction === "col" ? "col" : "row";
    return makeBranch(direction, first, second, clampRatio(Number(node.ratio)));
  }
  return null;
}

export interface PersistedLayout {
  root: LayoutNode;
  focusedPaneId: string | null;
}

/** 读回一份布局；结构非法、格子过多、只剩一格都按「没有分屏」处理。 */
export function parsePersistedLayout(raw: unknown): PersistedLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as { root?: unknown; focusedPaneId?: unknown };
  const root = parseNode(record.root);
  if (!root || root.kind === "pane") return null;
  const panes = listPanes(root);
  if (panes.length < 2 || panes.length > MAX_PERSISTED_PANES) return null;
  return { root, focusedPaneId: resolveFocusedPaneId(panes, record.focusedPaneId) };
}

/** 持久化的 focus 只保留「确实存在」的那个 id（顺序可能已被用户改过）。 */
function resolveFocusedPaneId(panes: PaneNode[], value: unknown): string | null {
  if (typeof value !== "string") return null;
  return panes.some((pane) => pane.id === value)
    ? value
    : (panes[0]?.id ?? null);
}

export function serializeLayout(root: LayoutNode, focusedPaneId: string | null) {
  return JSON.stringify({ root, focusedPaneId });
}
