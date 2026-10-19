import { readStoredBool, writeStored } from "./storage";

/**
 * Runtime controller for the react-scan render-profiling overlay
 * (设置 → 其他 → 性能诊断 → 渲染性能面板).
 *
 * react-scan ships inside production bundles on purpose so the packaged app
 * can toggle the overlay, but the module itself is loaded through a dynamic
 * import: it stays in its own chunk and is only fetched when the overlay is
 * actually switched on.
 */

type ReactScanModule = typeof import("react-scan");

/** Settings switch state; off unless the user turned it on. */
const REACT_SCAN_FLAG_KEY = "ccgui-next.reactScan:v1";
/**
 * react-scan persists its own options (including `enabled`) under this key:
 * pausing from its toolbar writes `enabled:false`, and every `scan()` call
 * restores the persisted value over the one passed in — a stale `false`
 * leaves instrumentation paused with no visible cause. Sanitize it before a
 * manual start so the settings switch stays authoritative.
 */
const REACT_SCAN_MODULE_OPTIONS_KEY = "react-scan-options";

let cachedModule: ReactScanModule | null = null;
let loadPromise: Promise<ReactScanModule> | null = null;

/** Whether the overlay was switched on in settings (persisted). */
export function isReactScanEnabled(): boolean {
  return readStoredBool(REACT_SCAN_FLAG_KEY, false);
}

function loadReactScan(): Promise<ReactScanModule> {
  loadPromise ??= import("react-scan").then((mod) => {
    cachedModule = mod;
    return mod;
  });
  return loadPromise;
}

function sanitizePersistedReactScanOptions(): void {
  try {
    const raw = localStorage.getItem(REACT_SCAN_MODULE_OPTIONS_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as { enabled?: unknown }).enabled === false
    ) {
      localStorage.setItem(
        REACT_SCAN_MODULE_OPTIONS_KEY,
        JSON.stringify({ ...(parsed as Record<string, unknown>), enabled: true }),
      );
    }
  } catch {
    // Best effort: a broken blob just means react-scan falls back to defaults.
  }
}

async function applyReactScan(enabled: boolean): Promise<void> {
  if (typeof window === "undefined") return;
  // Nothing to tear down if react-scan was never loaded.
  if (!enabled && cachedModule === null && loadPromise === null) return;
  try {
    if (enabled) sanitizePersistedReactScanOptions();
    const mod = await loadReactScan();
    mod.scan({
      enabled,
      showToolbar: enabled,
      // FPS at a glance in the toolbar; packaged builds only expose FPS and
      // re-render counts (React strips per-render timings from production).
      showFPS: true,
      // Without this react-scan refuses to run outside development; this app
      // bundles it intentionally so the packaged build can toggle the panel.
      dangerouslyForceRunInProduction: true,
    });
  } catch (error) {
    console.error("Failed to apply react-scan overlay:", error);
  }
}

/**
 * Start the overlay at boot when the persisted switch is on. Must run before
 * the first `react` import: react-scan instruments React on import and cannot
 * hook a renderer that has already run (see ./main).
 */
export async function startReactScanOverlay(): Promise<void> {
  await applyReactScan(true);
}

/**
 * Install bippy's devtools hook. react-dom registers its renderer into
 * `__REACT_DEVTOOLS_GLOBAL_HOOK__` when its module evaluates, so the hook
 * must be in place before ./bootstrap loads; running it on every boot is
 * what lets a later settings toggle activate instrumentation immediately
 * instead of only after a restart. The hook chunk is a few KB; the heavy
 * react-scan UI still loads only when the switch is turned on.
 */
export async function installReactScanHook(): Promise<void> {
  await import("react-scan/install-hook");
}

/** Toggle from settings: persist the choice and apply it live. */
export async function setReactScanEnabled(enabled: boolean): Promise<void> {
  writeStored(REACT_SCAN_FLAG_KEY, enabled ? "1" : "0");
  await applyReactScan(enabled);
}
