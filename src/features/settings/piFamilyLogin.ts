/**
 * OAuth login launch for pi/omp: the CLI owns the interactive flow, so the
 * app drives its built-in terminal (same approach as the reference
 * desktop-cc-gui's `mossx:terminal-command-request`, minus the event bus):
 * open the dock on a fresh tab, wait for the PTY, then type the command.
 *
 * - pi:  slash commands can't go through argv (they'd be sent to the model
 *        as prompt text) — two-stage PTY input: start the `pi` TUI, then
 *        write `/login <arg>` once it is up.
 * - omp: `omp auth-broker login <arg>` is a plain interactive command —
 *        single write, no TUI boot wait.
 */
import { ipc } from "@/lib/ipc";
import { useChatStore } from "@/features/chat/store";
import { hasTerminalSession } from "@/features/terminal/sessions";
import { useTerminalStore } from "@/features/terminal/store";

/** PTY Enter is CR, not LF. */
const ENTER = "\r";

function shellQuote(bin: string): string {
  return bin.includes(" ") ? `"${bin}"` : bin;
}

/** Poll until TerminalView has spawned the backend PTY for `id`. */
async function waitForSession(id: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasTerminalSession(id)) return true;
    // Poll loop: each sleep must finish before the next check — sequential
    // by design (react-doctor/async-await-in-loop false positive).
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/**
 * Open the terminal dock on a fresh tab and start the OAuth login flow.
 * Returns false when there is no active workspace to host the terminal.
 */
export async function launchPiFamilyLogin(
  engine: "pi" | "omp",
  loginArg: string,
): Promise<boolean> {
  const workspacePath = useChatStore.getState().active?.workspacePath;
  if (!workspacePath) return false;

  const term = useTerminalStore.getState();
  if (!term.open) term.toggle(workspacePath); // opens; creates a tab if none
  useTerminalStore.getState().newTab(workspacePath); // dedicated login tab
  const id = useTerminalStore.getState().activeByWorkspace[workspacePath];
  if (!id) return false;

  const settings = await ipc.getAppSettings().catch(() => null);
  const customBin = (engine === "pi" ? settings?.piBin : settings?.ompBin)?.trim();
  const bin = shellQuote(customBin || engine);

  if (!(await waitForSession(id))) return false;

  if (engine === "omp") {
    void ipc.terminalWrite(id, `${bin} auth-broker login ${loginArg}${ENTER}`).catch(() => {});
    return true;
  }
  void ipc.terminalWrite(id, `${bin}${ENTER}`).catch(() => {});
  window.setTimeout(() => {
    void ipc.terminalWrite(id, `/login ${loginArg}${ENTER}`).catch(() => {});
  }, 1500);
  return true;
}
