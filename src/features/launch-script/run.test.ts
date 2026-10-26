import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ terminalOpen: vi.fn(), terminalClose: vi.fn(), terminalWrite: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: api }));
vi.mock("@/lib/events", () => ({ listenTerminalOutput: vi.fn().mockResolvedValue(() => {}) }));

import { runLaunchScript } from "./run";
import { useTerminalStore } from "@/features/terminal/store";
import { hasTerminalSession, openTerminalSession } from "@/features/terminal/sessions";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  api.terminalOpen.mockReset();
  api.terminalClose.mockReset().mockResolvedValue(undefined);
  api.terminalWrite.mockReset().mockResolvedValue(undefined);
  localStorage.clear();
});

afterEach(() => {
  for (const workspace of Object.keys(useTerminalStore.getState().tabsByWorkspace)) {
    useTerminalStore.getState().removeWorkspace(workspace);
  }
  useTerminalStore.setState({ open: false });
});

describe("launch script terminal ownership", () => {
  it("shares its pending open with the terminal view and writes once", async () => {
    const pending = deferred();
    api.terminalOpen.mockReturnValue(pending.promise);
    const run = runLaunchScript("/workspace", "echo hello");
    const id = useTerminalStore.getState().activeByWorkspace["/workspace"];
    const viewOpen = openTerminalSession({ id, cwd: "/workspace", cols: 80, rows: 24 });
    expect(api.terminalOpen).toHaveBeenCalledTimes(1);
    pending.resolve();
    await Promise.all([run, viewOpen]);
    expect(api.terminalWrite).toHaveBeenCalledExactlyOnceWith(id, "echo hello\n");
  });

  it("closes the late session without writing when the launch tab was removed", async () => {
    const pending = deferred();
    api.terminalOpen.mockReturnValue(pending.promise);
    const run = runLaunchScript("/workspace", "echo hello");
    const id = useTerminalStore.getState().activeByWorkspace["/workspace"];
    useTerminalStore.getState().closeTab("/workspace", id);
    pending.resolve();
    await run;
    expect(api.terminalWrite).not.toHaveBeenCalled();
    expect(api.terminalClose).toHaveBeenCalledTimes(2);
    expect(hasTerminalSession(id)).toBe(false);
  });

  it("does not reopen a removed tab after waiting for its previous session to close", async () => {
    api.terminalOpen.mockResolvedValue(undefined);
    await runLaunchScript("/workspace", "first");
    const id = useTerminalStore.getState().activeByWorkspace["/workspace"];
    const pendingClose = deferred();
    api.terminalClose.mockReturnValueOnce(pendingClose.promise);
    const rerun = runLaunchScript("/workspace", "second");
    useTerminalStore.getState().closeTab("/workspace", id);
    pendingClose.resolve();
    await rerun;
    expect(api.terminalOpen).toHaveBeenCalledTimes(1);
    expect(api.terminalWrite).toHaveBeenCalledExactlyOnceWith(id, "first\n");
  });
});
