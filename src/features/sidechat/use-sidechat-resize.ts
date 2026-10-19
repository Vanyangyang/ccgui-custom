import { useLayoutEffect, useRef } from "react";
import { readStoredJson, writeStored } from "@/lib/storage";

export const SIDECHAT_WIDTH_KEY = "ccgui-next.sidechatWidth";
const DEFAULT_WIDTH = 416;
const MIN_WIDTH = 280;
const MAX_WIDTH = 720;

function readWidth() {
  return readStoredJson(SIDECHAT_WIDTH_KEY, (value) =>
    typeof value === "number" && Number.isFinite(value) && value >= MIN_WIDTH && value <= MAX_WIDTH
      ? value : null) ?? DEFAULT_WIDTH;
}

/** Resize only the panel DOM; streaming transcripts never rerender for pointer moves. */
export function useSidechatResize(open: boolean, sessionKey: string) {
  const panelRef = useRef<HTMLElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const handle = handleRef.current;
    const parent = panel?.parentElement;
    if (!open || !panel || !handle || !parent) return;

    let preferred = readWidth();
    let width = preferred;
    let min = MIN_WIDTH;
    let max = MAX_WIDTH;
    let frame = 0;
    let drag: { id: number; x: number; width: number; next: number } | null = null;
    const desktop = window.matchMedia("(min-width: 768px)");
    let measuredWidth = -1;
    let measuredDesktop = desktop.matches;
    const clamp = (value: number) => Math.round(Math.min(max, Math.max(min, value)));
    const paint = (value: number) => {
      width = clamp(value);
      panel.style.setProperty("--sidechat-width", `${width}px`);
      handle.setAttribute("aria-valuemin", String(min));
      handle.setAttribute("aria-valuemax", String(max));
      handle.setAttribute("aria-valuenow", String(width));
    };
    const stop = (commit = false) => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      if (!drag) return;
      const finished = drag;
      drag = null;
      if (commit) {
        // A narrow split can display less than the nominal minimum without
        // replacing the user's recoverable desktop preference with that size.
        preferred = Math.max(MIN_WIDTH, clamp(finished.next));
        writeStored(SIDECHAT_WIDTH_KEY, preferred);
      }
      paint(preferred);
      if (handle.hasPointerCapture?.(finished.id)) handle.releasePointerCapture(finished.id);
    };
    const measure = () => {
      const available = Math.max(0, Math.floor(parent.getBoundingClientRect().width));
      if (available === measuredWidth && desktop.matches === measuredDesktop) return;
      measuredWidth = available;
      measuredDesktop = desktop.matches;
      stop();
      max = Math.min(MAX_WIDTH, available >= MIN_WIDTH * 2 ? available - MIN_WIDTH : Math.floor(available / 2));
      min = Math.min(MIN_WIDTH, max);
      paint(preferred);
    };
    const down = (event: PointerEvent) => {
      if (!desktop.matches || event.button !== 0 || drag) return;
      event.preventDefault();
      handle.focus();
      drag = { id: event.pointerId, x: event.clientX, width, next: width };
      handle.setPointerCapture?.(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      drag.next = drag.width + drag.x - event.clientX;
      if (!frame) frame = requestAnimationFrame(() => {
        frame = 0;
        if (drag) paint(drag.next);
      });
    };
    const up = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      drag.next = drag.width + drag.x - event.clientX;
      stop(true);
    };
    const cancel = () => stop();
    const pointerCancel = (event: PointerEvent) => {
      if (drag?.id === event.pointerId) stop();
    };
    const keydown = (event: KeyboardEvent) => {
      if (!desktop.matches) return;
      const next = event.key === "ArrowLeft" ? width + 16
        : event.key === "ArrowRight" ? width - 16
        : event.key === "Home" ? min : event.key === "End" ? max : null;
      if (next === null) return;
      event.preventDefault();
      stop();
      preferred = Math.max(MIN_WIDTH, clamp(next));
      writeStored(SIDECHAT_WIDTH_KEY, preferred);
      paint(preferred);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    desktop.addEventListener("change", measure);
    handle.addEventListener("pointerdown", down);
    handle.addEventListener("keydown", keydown);
    handle.addEventListener("lostpointercapture", cancel);
    handle.addEventListener("blur", cancel);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", pointerCancel);
    window.addEventListener("blur", cancel);
    return () => {
      stop();
      observer.disconnect();
      desktop.removeEventListener("change", measure);
      handle.removeEventListener("pointerdown", down);
      handle.removeEventListener("keydown", keydown);
      handle.removeEventListener("lostpointercapture", cancel);
      handle.removeEventListener("blur", cancel);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", pointerCancel);
      window.removeEventListener("blur", cancel);
    };
  }, [open, sessionKey]);

  return { panelRef, handleRef };
}
