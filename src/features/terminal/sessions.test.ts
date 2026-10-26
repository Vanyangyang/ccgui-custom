import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ terminalOpen: vi.fn(), terminalClose: vi.fn() }));
vi.mock("@/lib/ipc", () => ({ ipc: api }));
vi.mock("@/lib/events", () => ({ listenTerminalOutput: vi.fn().mockResolvedValue(() => {}) }));

import { useTerminalStore } from "./store";
import { hasTerminalSession, isTerminalTabAlive, openTerminalSession } from "./sessions";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function tab(workspace = "/workspace") {
  useTerminalStore.getState().newTab(workspace);
  const id = useTerminalStore.getState().activeByWorkspace[workspace];
  return { id, cwd: workspace, cols: 80, rows: 24 };
}

beforeEach(() => {
  api.terminalOpen.mockReset();
  api.terminalClose.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  for (const workspace of Object.keys(useTerminalStore.getState().tabsByWorkspace)) {
    useTerminalStore.getState().removeWorkspace(workspace);
  }
  useTerminalStore.setState({ open: false });
});

describe("terminal session ownership", () => {
  it("shares an initial open across a remount and concurrent input", async () => {
    const pending = deferred();
    api.terminalOpen.mockReturnValue(pending.promise);
    const args = tab();
    const first = openTerminalSession(args);
    expect(openTerminalSession(args)).toBe(first);
    expect(api.terminalOpen).toHaveBeenCalledTimes(1);
    pending.resolve();
    expect(await first).toBe(true);
    expect(hasTerminalSession(args.id)).toBe(true);
    expect(api.terminalClose).not.toHaveBeenCalled();
  });

  it("closes a late open for a deleted tab and refuses stale retries", async () => {
    const pending = deferred();
    api.terminalOpen.mockReturnValue(pending.promise);
    const args = tab();
    const first = openTerminalSession(args);
    useTerminalStore.getState().closeTab(args.cwd, args.id);
    expect(api.terminalClose).toHaveBeenCalledTimes(1);
    expect(await openTerminalSession(args)).toBe(false);
    pending.resolve();
    expect(await first).toBe(false);
    expect(api.terminalClose).toHaveBeenCalledTimes(2);
    expect(api.terminalOpen).toHaveBeenCalledTimes(1);
    expect(hasTerminalSession(args.id)).toBe(false);
    expect(isTerminalTabAlive(args.id)).toBe(false);
  });

  it("preserves a late open when the panel is hidden or another workspace is selected", async () => {
    const pending = deferred();
    api.terminalOpen.mockReturnValue(pending.promise);
    const args = tab();
    const first = openTerminalSession(args);
    useTerminalStore.getState().closePanel();
    tab("/other-workspace");
    pending.resolve();
    expect(await first).toBe(true);
    expect(hasTerminalSession(args.id)).toBe(true);
    expect(api.terminalClose).not.toHaveBeenCalled();
  });

  it("closes a late open when its workspace is removed", async () => {
    const pending = deferred();
    api.terminalOpen.mockReturnValue(pending.promise);
    const args = tab();
    const first = openTerminalSession(args);
    useTerminalStore.getState().removeWorkspace(args.cwd);
    pending.resolve();
    expect(await first).toBe(false);
    expect(api.terminalClose).toHaveBeenLastCalledWith(args.id);
    expect(hasTerminalSession(args.id)).toBe(false);
  });

  it("releases a failed open so an existing tab can retry", async () => {
    api.terminalOpen.mockRejectedValueOnce(new Error("open failed")).mockResolvedValueOnce(undefined);
    const args = tab();
    await expect(openTerminalSession(args)).rejects.toThrow("open failed");
    expect(hasTerminalSession(args.id)).toBe(false);
    expect(await openTerminalSession(args)).toBe(true);
    expect(api.terminalOpen).toHaveBeenCalledTimes(2);
  });
});
