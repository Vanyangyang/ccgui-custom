import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { SessionTabItem } from "./SessionTab";

/** 纵向离开页签条多远才把这次拖拽交给分屏层：页签条自身高 40px，
 *  留出一段余量，横向排序的误触不会变成分屏。 */
const DRAG_OUT_PX = 24;

/** Pointer-driven tab drag-reorder: dragged key lives in a ref, the
 * insertion point in state so the indicator bar follows the pointer.
 * Pointer events, not HTML5 DnD: WKWebView never delivers dragover/drop, so
 * native DnD only reordered in Chromium. A 5px threshold keeps plain clicks
 * intact.
 *
 * 纵向拖出页签条时交给 `onDragOut`（分屏层）：横向仍是排序，向下拖到对话
 * 区就是分屏。一旦交接成功，这次拖拽不再参与排序/落点提示，由分屏层自己
 * 跟踪指针与落点。 */
export function useTabDragReorder(
  onReorder?: (draggedKey: string, targetKey: string, before: boolean) => void,
  onDragOut?: (tab: SessionTabItem, event: PointerEvent) => boolean,
) {
  const dragStateRef = useRef<{
    key: string;
    tab: SessionTabItem;
    startX: number;
    startY: number;
    dragging: boolean;
    /** 页签条底边（clientY），拖过它才可能交接给分屏。 */
    stripBottom: number | null;
    handedOff: boolean;
  } | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    draggedKey: string;
    key: string;
    before: boolean;
  } | null>(null);
  // pointerup fires before click; swallow the click that ends a drag.
  const suppressClickRef = useRef(false);

  function handleTabPointerDown(tab: SessionTabItem) {
    return (e: ReactPointerEvent<HTMLDivElement>) => {
      if ((!onReorder && !onDragOut) || e.button !== 0) return;
      // Dragging from the close button feels broken; keep it click-only.
      if ((e.target as HTMLElement).closest("button")) return;
      const element = e.currentTarget as HTMLElement;
      const strip = element.closest<HTMLElement>("[data-tab-strip]");
      dragStateRef.current = {
        key: tab.key,
        tab,
        startX: e.clientX,
        startY: e.clientY,
        dragging: false,
        stripBottom: strip ? strip.getBoundingClientRect().bottom : null,
        handedOff: false,
      };
    };
  }

  useEffect(() => {
    if (!onReorder && !onDragOut) return;
    const DRAG_THRESHOLD = 5;
    const swallowClick = () => {
      suppressClickRef.current = true;
      // The click ending the drag fires right after pointerup — but when
      // the press lands on one tab and releases on another, it targets
      // their container instead, never reaching a tab's onClick. Clear the
      // flag on the next task so it can't swallow a later genuine click.
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    };
    const targetAt = (x: number, y: number, excludeKey: string) => {
      const el = document
        .elementFromPoint(x, y)
        ?.closest<HTMLElement>("[data-tab-key]");
      const key = el?.dataset.tabKey;
      if (!el || !key || key === excludeKey) return null;
      const rect = el.getBoundingClientRect();
      return { key, before: x < rect.left + rect.width / 2 };
    };
    const onMove = (e: PointerEvent) => {
      const st = dragStateRef.current;
      if (!st) return;
      if (!st.dragging) {
        if (Math.abs(e.clientX - st.startX) + Math.abs(e.clientY - st.startY) < DRAG_THRESHOLD) {
          return;
        }
        st.dragging = true;
      }
      if (st.handedOff) return;
      // 纵向拖出页签条：交给分屏层（成功交接后本 hook 不再跟这次拖拽）。
      if (
        onDragOut &&
        st.stripBottom !== null &&
        e.clientY > st.stripBottom + DRAG_OUT_PX &&
        onDragOut(st.tab, e)
      ) {
        st.handedOff = true;
        setDropTarget(null);
        return;
      }
      const target = targetAt(e.clientX, e.clientY, st.key);
      setDropTarget((prev) => {
        const next = target ? { draggedKey: st.key, ...target } : null;
        return prev?.key === next?.key &&
          prev?.before === next?.before &&
          prev?.draggedKey === next?.draggedKey
          ? prev
          : next;
      });
    };
    const onUp = (e: PointerEvent) => {
      const st = dragStateRef.current;
      dragStateRef.current = null;
      setDropTarget(null);
      if (!st?.dragging) return;
      swallowClick();
      // 已交接给分屏层：排序不动，分屏层会在同一个 pointerup 上落位。
      if (st.handedOff) return;
      const target = targetAt(e.clientX, e.clientY, st.key);
      if (target) onReorder?.(st.key, target.key, target.before);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [onReorder, onDragOut]);

  return { dropTarget, suppressClickRef, handleTabPointerDown };
}
