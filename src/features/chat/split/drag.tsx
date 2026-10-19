import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { ActiveSession } from "../store/persistence";
import { useSplitStore } from "./store";
import { dropZoneAt, type DropZone } from "./tree";

/**
 * 分屏拖拽层：侧栏会话行、格子标题栏都从这里发起指针拖拽，
 * 落点由中心区格子的矩形决定（Trellis 式：边 = 切分，中心 = 放入/互换）。
 *
 * 用指针事件而不是 HTML5 DnD：WKWebView 不派发 dragover/drop，
 * 与页签拖拽排序（use-tab-drag-reorder.ts）保持同一套实现。
 */

export type SplitDragPayload =
  | { kind: "session"; session: ActiveSession; label: string }
  | { kind: "pane"; paneId: string; label: string };

/** 发起拖拽只需要这几个字段：页签条的指针拖拽是原生 PointerEvent，
 *  行/标题栏给的是 React 合成事件，两者都满足。 */
export interface SplitDragStartEvent {
  button: number;
  clientX: number;
  clientY: number;
  pointerType?: string;
}

export interface SplitDropTarget {
  paneId: string;
  zone: DropZone;
  /** 目标格子的视口矩形：提示层用它画高亮。 */
  rect: { left: number; top: number; width: number; height: number };
}

interface SplitDragContextValue {
  /** 指针当前的落点（不在任何格子上时为 null）。 */
  target: SplitDropTarget | null;
  /** 拖动中的载荷（提示层文案、测试断言用），未拖动时为 null。 */
  payload: SplitDragPayload | null;
  startDrag: (payload: SplitDragPayload, event: SplitDragStartEvent) => void;
  /** 分隔条拖动中：布局过渡要关掉，否则跟手会滞后。 */
  setResizing: (resizing: boolean) => void;
  resizing: boolean;
}

const SplitDragContext = createContext<SplitDragContextValue | null>(null);

const DRAG_THRESHOLD = 4;
/** 落点提示与目标格子之间的内缩，避免贴住分隔线。 */
const HINT_PAD = 4;

function paneElementAt(x: number, y: number): HTMLElement | null {
  const element = document.elementFromPoint(x, y);
  return element instanceof HTMLElement
    ? element.closest<HTMLElement>("[data-split-pane]")
    : null;
}

export function dropTargetAt(x: number, y: number): SplitDropTarget | null {
  const element = paneElementAt(x, y);
  const paneId = element?.dataset.splitPane;
  if (!element || !paneId) return null;
  const box = element.getBoundingClientRect();
  if (box.width < 2 || box.height < 2) return null;
  return {
    paneId,
    zone: dropZoneAt({ x: box.left, y: box.top, w: box.width, h: box.height }, x, y),
    rect: { left: box.left, top: box.top, width: box.width, height: box.height },
  };
}

/** 落点提示矩形：中心是整格内缩，边是半格。 */
export function dropHintRect(target: SplitDropTarget) {
  const { left, top, width, height } = target.rect;
  const inner = {
    left: left + HINT_PAD,
    top: top + HINT_PAD,
    width: Math.max(0, width - HINT_PAD * 2),
    height: Math.max(0, height - HINT_PAD * 2),
  };
  const halfW = Math.max(0, width / 2 - HINT_PAD * 2);
  const halfH = Math.max(0, height / 2 - HINT_PAD * 2);
  switch (target.zone) {
    case "left":
      return { left: inner.left, top: inner.top, width: halfW, height: inner.height };
    case "right":
      return {
        left: left + width / 2 + HINT_PAD,
        top: inner.top,
        width: halfW,
        height: inner.height,
      };
    case "top":
      return { left: inner.left, top: inner.top, width: inner.width, height: halfH };
    case "bottom":
      return {
        left: inner.left,
        top: top + height / 2 + HINT_PAD,
        width: inner.width,
        height: halfH,
      };
    default:
      return inner;
  }
}

export function SplitDragProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<SplitDropTarget | null>(null);
  const [payload, setPayload] = useState<SplitDragPayload | null>(null);
  const [resizing, setResizing] = useState(false);
  const pendingRef = useRef<{
    payload: SplitDragPayload;
    startX: number;
    startY: number;
    dragging: boolean;
  } | null>(null);

  const startDrag = useCallback((dragPayload: SplitDragPayload, event: SplitDragStartEvent) => {
    // 只认鼠标/触控板：手指拖拽要留给侧栏滚动，触屏入口走右键菜单。
    if (event.button !== 0 || event.pointerType === "touch") return;
    pendingRef.current = {
      payload: dragPayload,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    };
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const pending = pendingRef.current;
      if (!pending) return;
      if (!pending.dragging) {
        const moved =
          Math.abs(event.clientX - pending.startX) + Math.abs(event.clientY - pending.startY);
        if (moved < DRAG_THRESHOLD) return;
        pending.dragging = true;
        setPayload(pending.payload);
        // 拖拽期间不选中文字，也不拖出原生选区/光标。
        document.body.style.userSelect = "none";
        document.body.style.cursor = "grabbing";
      }
      const next = dropTargetAt(event.clientX, event.clientY);
      setTarget((prev) =>
        prev?.paneId === next?.paneId &&
        prev?.zone === next?.zone &&
        prev?.rect.left === next?.rect.left &&
        prev?.rect.top === next?.rect.top &&
        prev?.rect.width === next?.rect.width &&
        prev?.rect.height === next?.rect.height
          ? prev
          : next,
      );
    };
    const finish = (event: PointerEvent, dropped: boolean) => {
      const pending = pendingRef.current;
      pendingRef.current = null;
      setPayload(null);
      setTarget(null);
      if (pending?.dragging) {
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        // 抬手后的 click 会落到起点元素上（侧栏行）：拖完不能顺手又切一次会话。
        const suppress = (clickEvent: MouseEvent) => {
          clickEvent.preventDefault();
          clickEvent.stopPropagation();
        };
        window.addEventListener("click", suppress, { capture: true, once: true });
        setTimeout(() => window.removeEventListener("click", suppress, true), 0);
      }
      if (!dropped || !pending?.dragging) return;
      const drop = dropTargetAt(event.clientX, event.clientY);
      if (!drop) return;
      const store = useSplitStore.getState();
      if (pending.payload.kind === "session") {
        store.dropSession(drop.paneId, drop.zone, pending.payload.session);
      } else {
        store.dropPane(pending.payload.paneId, drop.paneId, drop.zone);
      }
    };
    const onUp = (event: PointerEvent) => finish(event, true);
    const onCancel = (event: PointerEvent) => finish(event, false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, []);

  const value = useMemo<SplitDragContextValue>(
    () => ({ target, payload, startDrag, setResizing, resizing }),
    [target, payload, startDrag, resizing],
  );

  return (
    <SplitDragContext.Provider value={value}>
      {children}
      {payload && target && <DropHintLayer target={target} label={payload.label} />}
    </SplitDragContext.Provider>
  );
}

/** 目标格子高亮 + 落点矩形：固定定位，跟着指针实时更新。 */
function DropHintLayer({ target, label }: { target: SplitDropTarget; label: string }) {
  const hint = dropHintRect(target);
  const centerLabel = target.zone === "center" && label;
  return (
    <div className="pointer-events-none fixed inset-0 z-50" data-split-drop-hint="">
      <div
        className="absolute rounded-lg border border-border-focus-ring"
        style={{
          left: target.rect.left,
          top: target.rect.top,
          width: target.rect.width,
          height: target.rect.height,
        }}
      />
      <div
        className="absolute rounded-lg bg-accent-500/15 ring-1 ring-border-focus-ring"
        style={{ left: hint.left, top: hint.top, width: hint.width, height: hint.height }}
      >
        {centerLabel ? (
          <span className="absolute bottom-3 left-1/2 max-w-[80%] -translate-x-1/2 truncate rounded-md bg-background-primary-default px-2 py-0.5 text-caption-1-medium text-text-secondary shadow-sm">
            {label}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function useSplitDrag(): SplitDragContextValue {
  const context = useContext(SplitDragContext);
  if (!context) throw new Error("useSplitDrag 必须在 SplitDragProvider 内使用");
  return context;
}

/** 可选读法：不在 provider 内时返回 null（独立渲染/单测用）。 */
export function useOptionalSplitDrag(): SplitDragContextValue | null {
  return useContext(SplitDragContext);
}

/** 拖拽源：把载荷与 pointerdown 绑到任意行/标题栏上。载荷可以是 thunk，
 *  侧栏行在按下时才去 store 里查会话（不必为每一行订阅整个会话列表）。 */
export function useDragSource(
  payload: SplitDragPayload | null | (() => SplitDragPayload | null),
) {
  const drag = useOptionalSplitDrag();
  return useCallback(
    (event: ReactPointerEvent) => {
      const resolved = typeof payload === "function" ? payload() : payload;
      if (!resolved) return;
      drag?.startDrag(resolved, event);
    },
    [drag, payload],
  );
}
