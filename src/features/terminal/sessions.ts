import { listenTerminalOutput } from "@/lib/events";
import { ipc } from "@/lib/ipc";

/**
 * Backend PTY sessions outlive their xterm view (dock collapse and tab
 * switches remount the view). Output accumulates here in between so nothing
 * is lost; a (re)mounting view replays the backlog. Module-level on purpose:
 * these mutate at PTY frequency and must never go through React state.
 */
const MAX_BUFFER_CHARS = 200_000;

const buffers = new Map<string, string>();
const writers = new Map<string, (data: string) => void>();
const openSessions = new Set<string>();
const liveTabs = new Set<string>();
const opening = new Map<string, Promise<boolean>>();
let listening = false;

/** One global `terminal://output` subscription; idempotent. */
export function ensureTerminalOutputListener(): void {
  if (listening) return;
  listening = true;
  void listenTerminalOutput((chunks) => {
    for (const { id, data } of chunks) {
      if (!liveTabs.has(id)) continue;
      const next = (buffers.get(id) ?? "") + data;
      buffers.set(
        id,
        next.length > MAX_BUFFER_CHARS ? next.slice(next.length - MAX_BUFFER_CHARS) : next,
      );
      writers.get(id)?.(data);
    }
  });
}

/** Buffered output for replay on view (re)mount. */
export function terminalBacklog(id: string): string {
  return buffers.get(id) ?? "";
}

/** Drop all frontend state for a session (tab closed / workspace removed). */
export function clearTerminalSessionState(id: string): void {
  liveTabs.delete(id);
  buffers.delete(id);
  writers.delete(id);
  openSessions.delete(id);
}

/** Tab ownership outlives its view, but ends synchronously on tab removal. */
export function registerTerminalTab(id: string): void {
  liveTabs.add(id);
}

export function isTerminalTabAlive(id: string): boolean {
  return liveTabs.has(id);
}

/** Share an in-flight open across remounts and input retries. A tab deleted
 * while IPC was in flight must close the late session instead of reviving it. */
export function openTerminalSession(args: { id: string; cwd: string; cols: number; rows: number }): Promise<boolean> {
  const { id } = args;
  if (!liveTabs.has(id)) return Promise.resolve(false);
  const existing = opening.get(id);
  if (existing) return existing;
  const promise = ipc.terminalOpen(args).then(async () => {
    if (!liveTabs.has(id)) {
      await ipc.terminalClose(id);
      return false;
    }
    markTerminalOpened(id);
    return true;
  }).finally(() => {
    if (opening.get(id) === promise) opening.delete(id);
  });
  opening.set(id, promise);
  return promise;
}

/** Register the live xterm writer for a session; `null` unregisters. */
export function setTerminalWriter(id: string, writer: ((data: string) => void) | null): void {
  if (writer) writers.set(id, writer);
  else writers.delete(id);
}

export function markTerminalOpened(id: string): void {
  openSessions.add(id);
}

export function markTerminalClosed(id: string): void {
  openSessions.delete(id);
}

/** Whether the backend confirmed a live PTY for this id. */
export function hasTerminalSession(id: string): boolean {
  return openSessions.has(id);
}
