/**
 * Last pointer-press position, recorded at window level so pointer-initiated
 * actions (row hover buttons, context-menu items) can anchor their follow-up
 * UI where the cursor already is instead of pulling focus to screen center.
 */

interface PointerAnchor {
  x: number;
  y: number;
  at: number;
}

let last: PointerAnchor | null = null;
// Installed at import, not on first read: the press that triggers the
// action always precedes the first recentPointerAnchor() call, so lazy
// installation would miss the very press it should record.
if (typeof window !== "undefined") {
  window.addEventListener(
    "pointerdown",
    (event) => {
      last = { x: event.clientX, y: event.clientY, at: Date.now() };
    },
    { capture: true },
  );
}

/**
 * Where the pointer last pressed, or null when no press happened within
 * `maxAgeMs` (keyboard-triggered action, or a stale position from an earlier
 * interaction) — callers fall back to a centered layout then.
 */
export function recentPointerAnchor(maxAgeMs = 4000): { x: number; y: number } | null {
  if (!last || Date.now() - last.at > maxAgeMs) return null;
  return { x: last.x, y: last.y };
}
