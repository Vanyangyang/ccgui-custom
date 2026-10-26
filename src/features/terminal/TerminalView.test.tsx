import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  terminalOpen: vi.fn(), terminalClose: vi.fn(), terminalWrite: vi.fn(), terminalResize: vi.fn(),
  inputs: [] as ((data: string) => void)[],
}));
vi.mock("@/lib/ipc", () => ({ ipc: fake }));
vi.mock("@/lib/events", () => ({ listenTerminalOutput: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/features/shortcuts/shortcuts", () => ({ isMacPlatform: () => false }));
vi.mock("@/features/settings/font", () => ({ FONT_CHANGE_EVENT: "test-font-change" }));
vi.mock("./appearance", () => ({ terminalFontFamily: () => "monospace", terminalTheme: () => ({}) }));
vi.mock("./links", () => ({ createPathLinkProvider: () => ({}) }));
vi.mock("./TerminalContextMenu", () => ({ TerminalContextMenu: () => null }));
vi.mock("./xterm-loader", () => ({
  loadXterm: async () => ({
    Terminal: class {
      cols = 80;
      rows = 24;
      options = {};
      loadAddon() {}
      open() {}
      write() {}
      dispose() {}
      registerLinkProvider() { return { dispose() {} }; }
      onData(callback: (data: string) => void) {
        fake.inputs.push(callback);
        return { dispose() {} };
      }
    },
    FitAddon: class { fit() {} },
    WebglAddon: class { onContextLoss() {} },
  }),
}));

import { TerminalView } from "./TerminalView";
import { useTerminalStore } from "./store";
import { hasTerminalSession } from "./sessions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounts = new Map<Root, HTMLDivElement>();

async function render(id: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounts.set(root, container);
  await act(async () => { root.render(<TerminalView id={id} cwd="/workspace" />); });
  return {
    async unmount() {
      await act(async () => { root.unmount(); });
      mounts.delete(root);
      container.remove();
    },
  };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function tab() {
  useTerminalStore.getState().newTab("/workspace");
  return useTerminalStore.getState().activeByWorkspace["/workspace"];
}

beforeEach(() => {
  fake.inputs.length = 0;
  fake.terminalOpen.mockReset();
  fake.terminalClose.mockReset().mockResolvedValue(undefined);
  fake.terminalWrite.mockReset().mockResolvedValue(undefined);
  fake.terminalResize.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});

afterEach(async () => {
  for (const [root, container] of mounts) {
    await act(async () => { root.unmount(); });
    container.remove();
  }
  mounts.clear();
  for (const workspace of Object.keys(useTerminalStore.getState().tabsByWorkspace)) {
    useTerminalStore.getState().removeWorkspace(workspace);
  }
  vi.unstubAllGlobals();
});

describe("terminal view lifecycle", () => {
  it("keeps one pending open alive across a valid view remount", async () => {
    const pending = deferred();
    fake.terminalOpen.mockReturnValue(pending.promise);
    const id = tab();
    const first = await render(id);
    expect(fake.terminalOpen).toHaveBeenCalledTimes(1);
    await first.unmount();
    await render(id);
    expect(fake.inputs).toHaveLength(2);
    await act(async () => { pending.resolve(); });
    expect(fake.terminalOpen).toHaveBeenCalledTimes(1);
    expect(fake.terminalClose).not.toHaveBeenCalled();
    expect(hasTerminalSession(id)).toBe(true);
  });

  it("closes an open that resolves after the tab was deleted", async () => {
    const pending = deferred();
    fake.terminalOpen.mockReturnValue(pending.promise);
    const id = tab();
    const view = await render(id);
    expect(fake.terminalOpen).toHaveBeenCalledTimes(1);
    useTerminalStore.getState().closeTab("/workspace", id);
    await view.unmount();
    await act(async () => { pending.resolve(); });
    expect(fake.terminalClose).toHaveBeenCalledTimes(2);
    expect(hasTerminalSession(id)).toBe(false);
  });

  it("does not respawn after a pending write fails for a deleted tab", async () => {
    fake.terminalOpen.mockResolvedValue(undefined);
    const pendingWrite = deferred();
    fake.terminalWrite.mockReturnValue(pendingWrite.promise);
    const id = tab();
    const view = await render(id);
    expect(hasTerminalSession(id)).toBe(true);
    fake.inputs[0]("x");
    expect(fake.terminalWrite).toHaveBeenCalledTimes(1);
    useTerminalStore.getState().closeTab("/workspace", id);
    await view.unmount();
    await act(async () => { pendingWrite.reject(new Error("Terminal session not found")); });
    // Even a stale xterm callback cannot create a replacement after removal.
    fake.inputs[0]("y");
    expect(fake.terminalOpen).toHaveBeenCalledTimes(1);
    expect(fake.terminalWrite).toHaveBeenCalledTimes(1);
  });
});
