import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  terminalOpen: vi.fn().mockResolvedValue(undefined),
  terminalWrite: vi.fn().mockResolvedValue(undefined),
  terminalClose: vi.fn().mockResolvedValue(undefined),
  terminalResize: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/ipc", () => ({ ipc: mocks }));
vi.mock("@/lib/events", () => ({
  listenTerminalOutput: vi.fn().mockResolvedValue(() => {}),
}));

import "@/lib/i18n";
import {
  LAUNCH_SCRIPT_ACTION_ID,
  LAUNCH_SCRIPT_PIN_MIGRATION_KEY,
  writePinnedIds,
} from "@/features/open-app/open-app";
import { LaunchScriptActions } from "./LaunchScriptActions";
import {
  readLaunchScripts,
  requestLaunchScriptEditor,
  writeLaunchScripts,
} from "./launch-script";
import { useTerminalStore } from "@/features/terminal/store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const WORKSPACE = "/workspace";

function buttonByText(text: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes(text),
    ) ?? null
  );
}

function buttonByLabel(label: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

function theTextarea(): HTMLTextAreaElement {
  const el = document.querySelector<HTMLTextAreaElement>("textarea");
  if (!el) throw new Error("expected a textarea in the dialog");
  return el;
}

/** Type into a controlled textarea the way React sees it (native setter +
 *  bubbling input event). */
function typeInto(input: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function rightClick(el: HTMLElement) {
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
}

describe("LaunchScriptActions", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    useTerminalStore.setState({ open: false, tabsByWorkspace: {}, activeByWorkspace: {} });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.body.querySelectorAll("[data-react-aria-top-layer]").forEach((node) => node.remove());
  });

  async function render() {
    await act(async () => {
      root.render(<LaunchScriptActions workspacePath={WORKSPACE} />);
    });
  }

  it("opens the editor when no script is set and saving persists the script", async () => {
    await render();

    const trigger = buttonByLabel("设置启动脚本");
    expect(trigger).toBeTruthy();
    await act(async () => {
      trigger!.click();
    });

    // Dialog titled 启动脚本 with the placeholder textarea.
    expect(document.body.textContent).toContain("启动脚本");
    expect(theTextarea().placeholder).toBe("例如 npm run dev");
    // The optional label field is available at initial creation too.
    expect(document.querySelector("input")).toBeTruthy();

    await act(async () => {
      typeInto(theTextarea(), "npm run dev");
    });
    await act(async () => {
      buttonByText("保存")!.click();
    });

    const entries = readLaunchScripts(WORKSPACE);
    expect(entries).toHaveLength(1);
    expect(entries[0].script).toBe("npm run dev");
    // Dialog closed; trigger now runs the script.
    expect(document.querySelector("textarea")).toBeNull();
    expect(buttonByLabel("运行启动脚本")).toBeTruthy();
  });

  it("runs the saved script in a restarted dedicated terminal tab", async () => {
    writeLaunchScripts(WORKSPACE, [{ id: "e1", label: "", script: "npm run dev" }]);
    await render();

    await act(async () => {
      buttonByLabel("运行启动脚本")!.click();
    });

    expect(mocks.terminalOpen).toHaveBeenCalledTimes(1);
    const openArgs = mocks.terminalOpen.mock.calls[0][0];
    expect(openArgs.cwd).toBe(WORKSPACE);
    expect(mocks.terminalWrite).toHaveBeenCalledWith(openArgs.id, "npm run dev\n");
    // Dock opened with the launch tab active.
    const state = useTerminalStore.getState();
    expect(state.open).toBe(true);
    expect(state.activeByWorkspace[WORKSPACE]).toBe(openArgs.id);

    // Second run reuses the same tab and restarts the session.
    await act(async () => {
      buttonByLabel("运行启动脚本")!.click();
    });
    expect(mocks.terminalClose).toHaveBeenCalledWith(openArgs.id);
    expect(mocks.terminalOpen).toHaveBeenCalledTimes(2);
    expect(mocks.terminalOpen.mock.calls[1][0].id).toBe(openArgs.id);
    expect(useTerminalStore.getState().tabsByWorkspace[WORKSPACE]).toHaveLength(1);
  });

  it("persists the optional label when creating the first script", async () => {
    await render();

    await act(async () => {
      buttonByLabel("设置启动脚本")!.click();
    });

    const labelInput = document.querySelector<HTMLInputElement>("input");
    expect(labelInput).toBeTruthy();
    await act(async () => {
      typeInto(labelInput!, "开发");
      typeInto(theTextarea(), "npm run dev");
    });
    await act(async () => {
      buttonByText("保存")!.click();
    });

    const entries = readLaunchScripts(WORKSPACE);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ label: "开发", script: "npm run dev" });
    // The labelled primary renders its label pill in the header, like extras.
    expect(buttonByText("开发")).toBeTruthy();
  });

  it("hides the header buttons when unpinned; the menu request still opens the editor", async () => {
    // A stored list without the launch script, with the migration marker set
    // (i.e. the user explicitly unpinned it rather than a pre-pin legacy list).
    localStorage.setItem(LAUNCH_SCRIPT_PIN_MIGRATION_KEY, "1");
    writePinnedIds(["vscode", "terminal"]);
    await render();

    expect(buttonByLabel("设置启动脚本")).toBeNull();

    // The 更多 menu row still reaches the editor while unpinned.
    await act(async () => {
      requestLaunchScriptEditor();
    });
    expect(theTextarea().placeholder).toBe("例如 npm run dev");

    // Re-pinning brings the button back without a remount.
    await act(async () => {
      writePinnedIds(["vscode", "terminal", LAUNCH_SCRIPT_ACTION_ID]);
    });
    expect(buttonByLabel("设置启动脚本")).toBeTruthy();
  });

  it("creates an extra labelled script via the 新建 section", async () => {
    writeLaunchScripts(WORKSPACE, [{ id: "e1", label: "", script: "npm run dev" }]);
    await render();

    await act(async () => {
      rightClick(buttonByLabel("运行启动脚本")!);
    });
    await act(async () => {
      buttonByText("新建")!.click();
    });

    // The new-script section adds a label input and its own textarea.
    const textareas = document.querySelectorAll<HTMLTextAreaElement>("textarea");
    expect(textareas).toHaveLength(2);
    // The main editor has its own label input now; the new-script section's
    // is the second one.
    const labelInputs = document.querySelectorAll<HTMLInputElement>("input");
    expect(labelInputs).toHaveLength(2);

    await act(async () => {
      typeInto(labelInputs[1], "测试");
      typeInto(textareas[1], "npm test");
    });
    await act(async () => {
      buttonByText("创建")!.click();
    });

    const entries = readLaunchScripts(WORKSPACE);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ label: "测试", script: "npm test" });
    // The extra entry renders as a labelled pill in the header.
    expect(buttonByText("测试")).toBeTruthy();
  });

  it("deletes the entry when saved with an empty script", async () => {
    writeLaunchScripts(WORKSPACE, [{ id: "e1", label: "", script: "npm run dev" }]);
    await render();

    await act(async () => {
      rightClick(buttonByLabel("运行启动脚本")!);
    });
    await act(async () => {
      typeInto(theTextarea(), "   ");
    });
    await act(async () => {
      buttonByText("保存")!.click();
    });

    expect(readLaunchScripts(WORKSPACE)).toHaveLength(0);
    expect(buttonByLabel("设置启动脚本")).toBeTruthy();
  });
});
