import { ipc } from "@/lib/ipc";
import { readStoredJson, writeStored } from "@/lib/storage";
import { useTerminalStore } from "@/features/terminal/store";
import {
  ensureTerminalOutputListener,
  hasTerminalSession,
  markTerminalClosed,
  markTerminalOpened,
} from "@/features/terminal/sessions";

/**
 * Runs a workspace startup script in a dedicated terminal tab. The launch
 * tab id is persisted so repeat runs reuse the same tab; every run restarts
 * the PTY (close + reopen) so a dead shell or a still-running process from
 * the previous run never eats the command.
 */

const tabKeyFor = (workspacePath: string) => `ccgui-next.launchTerminal.${workspacePath}`;

function readLaunchTabId(workspacePath: string): string | null {
  return readStoredJson(tabKeyFor(workspacePath), (value) =>
    typeof value === "string" ? value : null,
  );
}

/** Reuse the persisted launch tab when it still exists; otherwise create one. */
function ensureLaunchTab(workspacePath: string): string {
  const store = useTerminalStore.getState();
  const saved = readLaunchTabId(workspacePath);
  let id: string;
  if (saved && (store.tabsByWorkspace[workspacePath] ?? []).some((tab) => tab.id === saved)) {
    store.selectTab(workspacePath, saved);
    id = saved;
  } else {
    // newTab marks the created tab active, so it is recoverable right after.
    store.newTab(workspacePath);
    id = useTerminalStore.getState().activeByWorkspace[workspacePath];
    writeStored(tabKeyFor(workspacePath), JSON.stringify(id));
  }
  // The dock is the script's output surface; toggle only ever *opens* here.
  if (!useTerminalStore.getState().open) {
    useTerminalStore.getState().toggle(workspacePath);
  }
  return id;
}

export async function runLaunchScript(workspacePath: string, script: string): Promise<void> {
  // Buffer output even when no terminal view has mounted yet this session.
  ensureTerminalOutputListener();
  const id = ensureLaunchTab(workspacePath);
  if (hasTerminalSession(id)) {
    markTerminalClosed(id);
    await ipc.terminalClose(id).catch(() => {});
  }
  // terminal_open is idempotent per id, and TerminalView reopens with the
  // real cols/rows on mount and refits the PTY, so this placeholder size is
  // transient when the dock is visible.
  await ipc.terminalOpen({ id, cwd: workspacePath, cols: 120, rows: 30 });
  markTerminalOpened(id);
  await ipc.terminalWrite(id, `${script}\n`);
}
