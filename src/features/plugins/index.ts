import { bootstrapPlugins, ipcBackend } from "./runtime/loader";
import { BUILTIN_PLUGINS } from "./builtin";
import { ensurePluginSync, stopPluginSync, usePluginsStore } from "./manager/usePlugins";
import { useMarketplaceStore } from "./marketplace/store";

let consumers = 0;
let startup: AbortController | null = null;
let updateTimer: ReturnType<typeof setInterval> | null = null;

function stopPluginSystem(): void {
  consumers = 0;
  startup?.abort();
  startup = null;
  if (updateTimer) clearInterval(updateTimer);
  updateTimer = null;
  stopPluginSync();
}

if (import.meta.hot) import.meta.hot.dispose(stopPluginSystem);

/**
 * Plugin system entry (plan §4.1): bootstraps the loader — hardening,
 * usage-event bridge, builtin + installed plugins. Called once from App on
 * mount; idempotent.
 *
 * 插件管理 / 插件市场 no longer register as settings sections: both live in
 * the native plugin hub center tab (sidebar 插件 entry), while the settings
 * 插件 group keeps just the sections plugins register themselves.
 */
export function startPluginSystem(): () => void {
  consumers += 1;
  if (consumers === 1) {
    const controller = new AbortController();
    startup = controller;
    void Promise.resolve()
      .then(async () => { if (await ipcBackend.developmentProfileActive?.()) controller.abort(); })
      .then(() => controller.signal.aborted ? undefined : ensurePluginSync())
      .then(() => bootstrapWithRetry(controller.signal))
      .then(() => controller.signal.aborted ? undefined : usePluginsStore.getState().refresh())
      // Update hints (plan ADR-4): check at startup and once every 24h.
      .then(() => {
        if (controller.signal.aborted) return;
        const check = () => void useMarketplaceStore.getState().checkUpdates();
        check();
        updateTimer = setInterval(check, 24 * 3600 * 1000);
      })
      .catch((error) => {
        if (!controller.signal.aborted) console.error("[plugins] bootstrap failed", error);
      });
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    consumers -= 1;
    if (consumers === 0) stopPluginSystem();
  };
}

/** Backend list can lose the startup race (DB/bridge not ready when App
 *  mounts). Retry with backoff; if every attempt fails the plugins store
 *  re-kicks bootstrap when the hub asks for the installed list
 *  (pluginsBootstrapped gate). */
const BOOTSTRAP_RETRY_DELAYS_MS = [2000, 5000, 10_000];

async function bootstrapWithRetry(signal: AbortSignal): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    if (signal.aborted) return;
    try {
      await bootstrapPlugins(ipcBackend, BUILTIN_PLUGINS);
      return;
    } catch (error) {
      const delay = BOOTSTRAP_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw error;
      console.warn(
        `[plugins] bootstrap attempt ${attempt + 1} failed; retrying in ${delay}ms`,
        error,
      );
      // Not Promise.withResolvers: that is Chromium 119+, and a WebView2 that
      // still lacks it throws inside this catch, which skips every later retry
      // and leaves plugins unloaded until the hub is opened.
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve();
        };
        const timer = setTimeout(finish, delay);
        signal.addEventListener("abort", finish, { once: true });
        if (signal.aborted) finish();
      });
    }
  }
}
