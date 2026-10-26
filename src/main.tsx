// Engine-compat polyfills (Object.hasOwn, Promise.withResolvers, .at,
// URL.canParse, structuredClone) must be installed before any other module
// can run; this side-effect import is intentionally first.
import "./lib/engine-compat";
// Install browser profile storage before any preference or authentication read.
import "./lib/profile-storage";
import "./index.css";
import { installCryptoRandomUUIDPolyfill } from "./lib/id";
import {
  installReactScanHook,
  isReactScanEnabled,
  startReactScanOverlay,
} from "./lib/react-scan";

// Ensure crypto.randomUUID is available in non-secure HTTP contexts (e.g. LAN web bridge).
installCryptoRandomUUIDPolyfill();

let bootDisposed = false;
let stopLiveUpdates: (() => void) | undefined;
let stopAssistantNotices: (() => void) | undefined;
if (import.meta.hot) import.meta.hot.dispose(() => { bootDisposed = true; stopLiveUpdates?.(); stopAssistantNotices?.(); });

/**
 * react-scan must instrument React before the first `react` import runs —
 * afterwards it can no longer hook the renderer. This entry therefore imports
 * nothing that pulls React in: the app body lives in ./bootstrap and is loaded
 * dynamically once the overlay (when enabled) is up.
 */
async function boot() {
  if ("__TAURI_INTERNALS__" in window) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    if (getCurrentWindow().label.startsWith("plugin-window-")) {
      const { startPluginWindowApp } = await import("./features/plugins/windows/bootstrap");
      if (!bootDisposed) startPluginWindowApp();
      return;
    }
    if (/^#\/assistant-notices(?:[/?]|$)/.test(window.location.hash)
      || getCurrentWindow().label === "assistant-notices") {
      const { startAssistantNoticesApp } = await import("./features/assistant-notices/bootstrap");
      if (!bootDisposed) startAssistantNoticesApp();
      return;
    }
  }
  // Hook first, react-dom second: see installReactScanHook for why this runs
  // even when the overlay is off.
  await installReactScanHook();
  if (isReactScanEnabled()) {
    await startReactScanOverlay();
  }
  const { prepareLiveUpdateBootstrap } = await import("./lib/live-update-bootstrap");
  const finishRecovery = await prepareLiveUpdateBootstrap();
  const { startApp } = await import("./bootstrap");
  startApp();
  await finishRecovery();
  if (bootDisposed) return;
  const { startLiveUpdateRuntime } = await import("./features/update/live-update");
  if (!bootDisposed) stopLiveUpdates = startLiveUpdateRuntime();
  const { startAssistantNoticesRuntime } = await import("./features/assistant-notices/runtime");
  if (!bootDisposed) stopAssistantNotices = startAssistantNoticesRuntime();
}

void boot().catch(async (error: unknown) => {
  // A failed handoff keeps submission ownership frozen, but the crash surface
  // must still accept reload/copy/quit, including failures before React mounts.
  document.documentElement.inert = false;
  const { reportCrash } = await import("./lib/crash");
  reportCrash("unhandledrejection", error);
});
