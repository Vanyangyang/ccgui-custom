import { useEffect } from "react";
import type { KeyboardEvent, RefObject } from "react";
/** Vertical wheel drives the horizontal tab scroll (VSCode behavior).
 * Native non-passive listener: React wheel handlers cannot preventDefault. */
function useHorizontalWheelScroll(scrollRef: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaX === 0 && e.deltaY === 0) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      el.scrollLeft += delta;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scrollRef]);
}

/** Keep the active tab in view as tabs stream in/out of the strip. */
function useActiveTabInView(
  scrollRef: RefObject<HTMLDivElement | null>,
  activeKey: string | null,
  tabCount: number,
) {
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !activeKey) return;
    el.querySelector(`[data-tab-key="${CSS.escape(activeKey)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [scrollRef, activeKey, tabCount]);
}

/** Roving-tabindex tab list: Arrow keys move focus between tabs (selection
 * still requires Enter/Space, matching the platform tab convention). */
function handleTabListKeyDown(
  scrollRef: RefObject<HTMLDivElement | null>,
  e: KeyboardEvent<HTMLDivElement>,
) {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const el = scrollRef.current;
  if (!el) return;
  const tabEls = Array.from(el.querySelectorAll<HTMLElement>('[role="tab"]'));
  const current = tabEls.indexOf(document.activeElement as HTMLElement);
  if (current < 0) return;
  e.preventDefault();
  const next =
    e.key === "ArrowRight"
      ? (current + 1) % tabEls.length
      : (current - 1 + tabEls.length) % tabEls.length;
  tabEls[next]?.focus();
}

/**
 * Chrome behaviors of the tab strip: wheel-to-horizontal scroll,
 * active-tab scroll-into-view, and roving-tabindex arrow keys. Window drag
 * and double-click maximize come from the strip's
 * data-tauri-drag-region="deep" attribute (Tauri handles both, skipping
 * interactive children). Returns the handlers the strip's JSX wires up.
 */
export function useTabStripChrome({
  scrollRef,
  activeKey,
  tabCount,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  activeKey: string | null;
  tabCount: number;
}) {
  useHorizontalWheelScroll(scrollRef);
  useActiveTabInView(scrollRef, activeKey, tabCount);

  return {
    handleTabListKeyDown: (e: KeyboardEvent<HTMLDivElement>) =>
      handleTabListKeyDown(scrollRef, e),
  };
}
