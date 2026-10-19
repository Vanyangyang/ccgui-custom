import { getCurrentWindow } from "@tauri-apps/api/window";
import { isWeb, listen } from "./transport";

/**
 * App-close confirmation ("二次确认"). The window close button used to kill
 * the app instantly — one misclick on the X ended every running session and
 * terminal. Here the CloseRequested event is intercepted, a ConfirmDialog
 * (CloseConfirmDialogHost in components/dialogs.tsx) is raised, and only an
 * explicit confirm destroys the window.
 *
 * macOS Cmd+Q / `osascript … quit` never fire CloseRequested: the backend's
 * quit guard (src-tauri/src/quit_guard.rs) cancels those system quits while a
 * run is live and re-raises the same dialog through `app://exit-requested`.
 * The event name is pinned against the Rust constant by close-confirm.test.ts.
 *
 * Store shape mirrors lib/grant.ts: a stable boolean snapshot for
 * useSyncExternalStore, with subscribe/current/answer-style accessors.
 */

let pending = false;
const listeners = new Set<() => void>();

function setPending(next: boolean) {
  if (pending === next) return;
  pending = next;
  for (const cb of listeners) cb();
}

/** useSyncExternalStore wiring for CloseConfirmDialogHost. */
export function subscribeCloseConfirm(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function closeConfirmPending(): boolean {
  return pending;
}

export function cancelAppClose(): void {
  setPending(false);
}

/**
 * User confirmed: destroy the window. `destroy()` skips CloseRequested, so
 * the guard below never re-fires and no bypass flag is needed; the backend's
 * Destroyed handler (lib.rs) still runs and reaps engine/terminal processes.
 */
export function confirmAppClose(): void {
  setPending(false);
  void getCurrentWindow().destroy();
}

/** The macOS quit guard cancelled a Cmd+Q / AppleScript quit because runs
 *  were in flight; ask through the same dialog as the window X. */
const EXIT_REQUESTED_EVENT = "app://exit-requested";

let installed = false;

/** Intercept the main window's close button and the backend's cancelled-quit
 *  signal. Idempotent; no-op in the web-access browser bridge, where closing
 *  a tab needs no confirmation. */
export function installCloseConfirm(): void {
  if (installed || isWeb) return;
  installed = true;
  void getCurrentWindow().onCloseRequested((event) => {
    event.preventDefault();
    setPending(true);
  });
  void listen(EXIT_REQUESTED_EVENT, () => setPending(true));
}
