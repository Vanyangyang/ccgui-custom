import { setWebviewZoom } from "@/lib/platform";
import { readStoredNumber, writeStored } from "@/lib/storage";

/** localStorage key holding the interface zoom percentage (50–200). */
export const ZOOM_KEY = "ccgui-next.zoom:v1";
export const ZOOM_MIN = 50;
export const ZOOM_MAX = 200;
export const ZOOM_STEP = 10;
/** Window event fired after the zoom changes; carries the applied percent
 *  so every entry point (status bar ±, shortcuts, Settings select) stays in
 *  sync against one stored value. */
export const ZOOM_CHANGE_EVENT = "ccgui:zoom-change";

export function readZoomPct(): number {
  const raw = readStoredNumber(ZOOM_KEY, 100);
  return raw >= ZOOM_MIN && raw <= ZOOM_MAX ? raw : 100;
}

/** Persist + apply a zoom percent and notify listeners. Tauri does not
 *  restore webview zoom across launches, so callers re-apply on startup. */
export function applyZoom(pct: number): void {
  writeStored(ZOOM_KEY, pct);
  setWebviewZoom(pct / 100);
  window.dispatchEvent(new CustomEvent<number>(ZOOM_CHANGE_EVENT, { detail: pct }));
}

/** Clamp to bounds and snap to the step grid; returns the applied value. */
export function changeZoom(next: number): number {
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next / ZOOM_STEP) * ZOOM_STEP));
  applyZoom(clamped);
  return clamped;
}

/** Subscribe to zoom changes from any entry point. */
export function onZoomChange(listener: (pct: number) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<number>).detail);
  window.addEventListener(ZOOM_CHANGE_EVENT, handler);
  return () => window.removeEventListener(ZOOM_CHANGE_EVENT, handler);
}
