import { invoke, isWeb } from "./transport";
import { errorText } from "./errors";

/**
 * On-demand directory grants ("方案 A"). The backend confines every file
 * command to registered workspaces + user-granted directories; when it
 * rejects a path as outside all roots, `withGrantRetry` asks the desktop
 * user once (GrantAccessDialogHost renders the prompt), persists the grant
 * via `grant_root`, and retries the operation.
 *
 * grant.ts calls `invoke` directly instead of going through the typed
 * wrappers in ipc.ts: ipc.ts imports withGrantRetry from here, so importing
 * ipc back would be a module cycle.
 *
 * Web-access clients never see the prompt: the bridge deliberately has no
 * grant_root route (a remote client must not widen the FS boundary), so the
 * original error propagates there.
 */

/** Mirrors the prefix in src-tauri/src/files.rs `ensure_allowed` — the IPC
 *  error channel carries plain strings, so detection is textual. */
const OUTSIDE_PREFIX = "path is outside the registered workspaces: ";

interface PendingGrant {
  dir: string;
  resolve: (ok: boolean) => void;
}

let pending: PendingGrant | null = null;
/** Cached snapshot for useSyncExternalStore: getSnapshot must return a
 *  stable reference between changes, or React re-renders forever. */
let snapshot: { dir: string } | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const cb of listeners) cb();
}

/** useSyncExternalStore wiring for GrantAccessDialogHost. */
export function subscribeGrantDialog(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function currentGrantRequest(): { dir: string } | null {
  return snapshot;
}

export function answerGrantRequest(ok: boolean) {
  const p = pending;
  pending = null;
  snapshot = null;
  emit();
  p?.resolve(ok);
}

/** Directories the user declined this session — cancelling must not turn
 *  into a prompt loop on every retry. */
const declined = new Set<string>();
/** Serializes prompts: a burst of failures (tree + editor + index hitting
 *  the same outside path at once) asks once, in order. */
let chain: Promise<unknown> = Promise.resolve();

async function askAndGrant(dir: string): Promise<boolean> {
  if (declined.has(dir)) return false;
  const ok = await new Promise<boolean>((resolve) => {
    pending = { dir, resolve };
    snapshot = { dir };
    emit();
  });
  if (!ok) {
    declined.add(dir);
    return false;
  }
  await invoke("grant_root", { path: dir });
  return true;
}

/** Run `op`; when the backend rejects a path as outside every allowed
 *  root, offer a one-click directory grant and retry once. Any other error
 *  (or a declined/failed grant) rethrows the original error unchanged. */
export function withGrantRetry<T>(op: () => Promise<T>): Promise<T> {
  return op().catch(async (e) => {
    const text = errorText(e);
    if (isWeb || !text.startsWith(OUTSIDE_PREFIX)) throw e;
    const path = text.slice(OUTSIDE_PREFIX.length).trim();
    if (!path) throw e;
    const granted = await (chain = chain.then(async () => {
      let dir: string;
      try {
        dir = await invoke<string>("grant_scope", { path });
      } catch {
        return false; // unresolvable path: surface the original error
      }
      return askAndGrant(dir);
    }));
    if (!granted) throw e;
    return op();
  });
}
