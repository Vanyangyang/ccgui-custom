/**
 * Host global hardening (plan §5.4). Same-origin ESM plugins share the window
 * with the host, so true isolation is impossible; this module is the
 * "raise the bar + observable behavior" layer the plan explicitly scopes to:
 *
 * - `window.__TAURI_INTERNALS__.invoke` is wrapped so a direct Tauri IPC call
 *   made while plugin code is on the stack (activate, event callbacks,
 *   disposers — everything the runtime invokes via `runAsPlugin`) throws.
 * - Network needs no wrapper: CSP `connect-src 'self' ipc: …` already denies
 *   every non-self connection from the webview, host and plugin alike.
 *
 * Documented residual bypass surface (unchanged from the plan): React event
 * handlers and async continuations escape the depth counter; same-origin
 * iframes expose fresh globals; localStorage is directly reachable. Hard
 * boundaries come from marketplace review, the permission diff, the confirm
 * flow, one-click uninstall, and quarantine.
 */

let pluginDepth = 0;

/** Run `fn` marked as plugin code: direct Tauri IPC inside throws. */
export function runAsPlugin<T>(fn: () => T): T {
  pluginDepth += 1;
  try {
    return fn();
  } finally {
    pluginDepth -= 1;
  }
}

interface TauriInternals {
  invoke?: (cmd: string, args?: unknown) => Promise<unknown>;
}
declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

let installed = false;

/** Test-only: the guard is process-global, so a case that needs a fresh
 *  install has to clear the flag explicitly. */
export function resetHardeningForTests(): void {
  installed = false;
}

/** Wrap the Tauri IPC entry point with the plugin-execution guard. Idempotent;
 *  no-op outside the desktop webview (web bridge has no __TAURI_INTERNALS__).
 *  Failure to wrap is not fatal: bootstrap must still load plugins. */
export function installHardening(): void {
  if (installed) return;
  installed = true;
  const internals = window.__TAURI_INTERNALS__;
  const original = internals?.invoke;
  if (!internals || !original) return;
  const wrapped: typeof original = (cmd, args) => {
    if (pluginDepth > 0) {
      return Promise.reject(
        new Error(
          `[plugins] direct Tauri invoke("${cmd}") is blocked inside plugin code; use the PluginContext APIs`,
        ),
      );
    }
    return original(cmd, args);
  };
  // Tauri 2.11 defines `invoke` with Object.defineProperty and leaves it
  // non-writable and non-configurable. A bare assignment throws in strict
  // mode ("Cannot assign to read only property 'invoke'") and used to abort
  // plugin bootstrap before plugin_list ran. When the property can't be
  // replaced the guard stays off — plugins still load.
  const descriptor = Object.getOwnPropertyDescriptor(internals, "invoke");
  const warnInactive = (error?: unknown) => {
    console.warn(
      "[plugins] could not wrap __TAURI_INTERNALS__.invoke; plugin IPC guard is inactive",
      error,
    );
  };
  try {
    if (descriptor?.configurable) {
      Object.defineProperty(internals, "invoke", { ...descriptor, value: wrapped });
    } else if (descriptor?.writable !== false) {
      internals.invoke = wrapped;
    } else {
      // Non-writable and non-configurable: the Tauri 2.11 descriptor.
      // Replacing it is impossible; do not throw out of bootstrap.
      warnInactive(new TypeError("invoke is read-only"));
    }
  } catch (error) {
    warnInactive(error);
  }
}
