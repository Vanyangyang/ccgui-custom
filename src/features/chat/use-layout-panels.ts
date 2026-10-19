import { useCallback, useEffect, useRef, useState } from "react";
import { MOBILE_MEDIA } from "@/hooks/use-media-query";
import { readStoredBool, readStoredNumber, writeStored } from "@/lib/storage";

const PANEL_MIN_WIDTH = 300;
const PANEL_MAX_WIDTH = 560;
// Open at the narrowest usable width; users can widen via the resize grip.
const PANEL_DEFAULT_WIDTH = PANEL_MIN_WIDTH;
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 480;
const SIDEBAR_DEFAULT_WIDTH = 260;
const PANEL_COLLAPSED_KEY = "ccgui-next.panelCollapsed";
const SIDEBAR_COLLAPSED_KEY = "ccgui-next.sidebarCollapsed";
const PANEL_WIDTH_KEY = "ccgui-next.panelWidth";
const SIDEBAR_WIDTH_KEY = "ccgui-next.sidebarWidth";
let checkpointPanelTab = "files";
let checkpointDragging = false;

export function captureLayoutPanelRuntime() { return { panelTab: checkpointPanelTab }; }
export function layoutPanelCheckpointBlockers(): string[] { return checkpointDragging ? ["layout-resize-in-progress"] : []; }
export function restoreLayoutPanelRuntime(value: unknown): void {
  const state = value as { panelTab?: unknown } | null;
  if (!state || typeof state.panelTab !== "string") throw new Error("Invalid layout panel checkpoint");
  checkpointPanelTab = state.panelTab;
}

/** Stored width, validated against the live min/max before use. */
function readStoredWidth(key: string, min: number, max: number, fallback: number): number {
  const raw = readStoredNumber(key, fallback);
  return raw >= min && raw <= max ? raw : fallback;
}

/** Sidebar + side-panel chrome: persisted widths and collapse flags, the
 * files/changes panel tab, and full-height edge drag-resizing. Both edges
 * resize the same way: press anywhere on the strip, drag, release. Width is
 * mutated directly during the drag; committing to state once on pointerup
 * avoids a re-render per pointermove. */
export function useLayoutPanels() {
  const [panelWidth, setPanelWidth] = useState(() => readStoredWidth(PANEL_WIDTH_KEY, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH, PANEL_DEFAULT_WIDTH));
  const [panelCollapsed, setPanelCollapsed] = useState(
    () => readStoredBool(PANEL_COLLAPSED_KEY, false),
  );
  const togglePanelCollapsed = useCallback(() => {
    setPanelCollapsed((prev) => {
      writeStored(PANEL_COLLAPSED_KEY, prev ? "0" : "1");
      return !prev;
    });
  }, []);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => readStoredBool(SIDEBAR_COLLAPSED_KEY, false),
  );
  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarCollapsed((prev) => {
      writeStored(SIDEBAR_COLLAPSED_KEY, prev ? "0" : "1");
      return !prev;
    });
  }, []);
  // Drawer behavior on phones: selecting anything dismisses the overlay.
  const collapseSidebarOnMobile = useCallback(() => {
    if (!window.matchMedia(MOBILE_MEDIA).matches) return;
    setSidebarCollapsed((prev) => {
      if (prev) return prev;
      writeStored(SIDEBAR_COLLAPSED_KEY, "1");
      return true;
    });
  }, []);
  const [dragging, setDragging] = useState<"sidebar" | "panel" | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => readStoredWidth(SIDEBAR_WIDTH_KEY, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_DEFAULT_WIDTH));
  const [panelTab, setPanelTabState] = useState(() => checkpointPanelTab);
  const setPanelTab = useCallback((value: string | ((previous: string) => string)) => {
    checkpointPanelTab = typeof value === "function" ? value(checkpointPanelTab) : value;
    setPanelTabState(checkpointPanelTab);
  }, []);
  useEffect(() => () => { checkpointDragging = false; }, []);
  const widthAtDragStart = useRef(PANEL_DEFAULT_WIDTH);
  const dragStartX = useRef(0);
  const dragWidth = useRef(PANEL_DEFAULT_WIDTH);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelHeaderRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarResizerRef = useRef<HTMLDivElement>(null);

  const handleResizeStart = useCallback(
    (target: "sidebar" | "panel") => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      widthAtDragStart.current = target === "panel" ? panelWidth : sidebarWidth;
      dragWidth.current = widthAtDragStart.current;
      dragStartX.current = e.clientX;
      checkpointDragging = true;
      setDragging(target);
    },
    [panelWidth, sidebarWidth],
  );

  useEffect(() => {
    if (!dragging) return;
    const isPanel = dragging === "panel";
    const sized = isPanel ? panelRef.current : sidebarRef.current;
    const resizer = isPanel ? null : sidebarResizerRef.current;
    // The panel's titlebar header tracks live drags so its border never
    // lags the panel edge on pointerup.
    const header = isPanel ? panelHeaderRef.current : null;
    const min = isPanel ? PANEL_MIN_WIDTH : SIDEBAR_MIN_WIDTH;
    const max = isPanel ? PANEL_MAX_WIDTH : SIDEBAR_MAX_WIDTH;
    const onMove = (e: PointerEvent) => {
      // The panel grows leftward, the sidebar rightward.
      const delta = isPanel
        ? dragStartX.current - e.clientX
        : e.clientX - dragStartX.current;
      const next = Math.min(max, Math.max(min, widthAtDragStart.current + delta));
      dragWidth.current = next;
      if (sized) sized.style.width = `${next}px`;
      if (resizer) resizer.style.left = `${next}px`;
      if (header) header.style.width = `${next}px`;
    };
    const onUp = () => {
      checkpointDragging = false;
      setDragging(null);
      // Persist once on release; mid-drag writes would thrash storage.
      if (isPanel) {
        setPanelWidth(dragWidth.current);
        writeStored(PANEL_WIDTH_KEY, dragWidth.current);
      } else {
        setSidebarWidth(dragWidth.current);
        writeStored(SIDEBAR_WIDTH_KEY, dragWidth.current);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [dragging]);

  return {
    panelWidth,
    panelCollapsed,
    togglePanelCollapsed,
    panelTab,
    setPanelTab,
    sidebarCollapsed,
    toggleSidebarCollapsed,
    collapseSidebarOnMobile,
    sidebarWidth,
    dragging,
    handleResizeStart,
    panelRef,
    panelHeaderRef,
    sidebarRef,
    sidebarResizerRef,
  };
}
