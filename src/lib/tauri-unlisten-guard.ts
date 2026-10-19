/**
 * Tauri 2.11.x workaround for tauri-apps/tauri#15799.
 *
 * `listen()` resolves as soon as Rust answers `plugin:event|listen`, but the
 * webview-side registry entry for that id is written by a separate eval that
 * can still be in flight. Calling the returned unlisten inside that window
 * makes Tauri's injected `unregisterListener` read `handlerId` off an
 * undefined entry and throw — from the first line of `_unlisten`, before it
 * gets to send `plugin:event|unlisten`. One unhandled rejection (our crash
 * screen) plus a listener that was never removed, so the "unsubscribed"
 * handler keeps firing after a remount.
 *
 * The app hits it routinely: `subscribeTauriEvent` fires a late unlisten
 * immediately when teardown beats the listen promise, React StrictMode's dev
 * mount → unmount → mount does the same for every `useTauriEvent` component,
 * and the startup subscriptions share event names, so the per-event bucket
 * usually exists and the lookup throws instead of silently no-oping.
 *
 * Upstream's fix (PR #15800) skips `unregisterCallback` when the entry is
 * absent — exactly the one case where it cannot be called. We cannot read the
 * private listeners object to check it ourselves, so swallow the throw:
 * `_unlisten` then still runs `plugin:event|unlisten`, the backend listener is
 * removed, and the skipped JS callback stops being delivered to.
 *
 * Remove this shim once the `tauri` dependency contains PR #15800 (2.11.6 and
 * `@tauri-apps/api` 2.11.1 still ship the unguarded line).
 */

export interface TauriEventPluginInternals {
  unregisterListener?: (event: string, eventId: number) => void;
}

/** Marks a patched object so HMR / repeated installs cannot stack wrappers. */
const GUARD_MARK = Symbol.for("ccgui.tauri-unlisten-guard");

function currentInternals(): TauriEventPluginInternals | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { __TAURI_EVENT_PLUGIN_INTERNALS__?: TauriEventPluginInternals })
    .__TAURI_EVENT_PLUGIN_INTERNALS__;
}

/**
 * Guard the injected unlisten helper. Safe to call more than once; no-op
 * outside Tauri (web-access bridge) and while the plugin internals are absent.
 */
export function installTauriUnlistenGuard(
  internals: TauriEventPluginInternals | undefined = currentInternals(),
): void {
  if (!internals || typeof internals.unregisterListener !== "function") return;
  const marked = internals as Record<PropertyKey, unknown>;
  if (marked[GUARD_MARK]) return;

  const unregister = internals.unregisterListener;
  internals.unregisterListener = (event, eventId) => {
    try {
      unregister(event, eventId);
    } catch {
      // Registration eval has not landed yet: there is no entry to clean up.
      // Swallowing lets `_unlisten` continue to `plugin:event|unlisten`.
    }
  };
  marked[GUARD_MARK] = true;
}
