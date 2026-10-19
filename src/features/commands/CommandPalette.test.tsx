import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandRegistry } from "@ccgui/plugin-sdk";
import type { CommandDef, Disposer } from "@ccgui/plugin-sdk";
import { CommandPalette } from "./CommandPalette";
import { startShortcutRuntime } from "@/features/shortcuts/runtime";

// The palette toggle key lives in the shortcut runtime; its settings load
// and backend listener are mocked so defaults (⌘K) apply.
vi.mock("@/lib/ipc", () => ({
  ipc: { getAppSettings: vi.fn(async () => ({})) },
}));
vi.mock("@/lib/events", () => ({
  listenSettingsChanged: vi.fn(async () => () => {}),
}));

const pinPlatform = (platform: string) => {
  Object.defineProperty(window.navigator, "platform", {
    value: platform,
    configurable: true,
  });
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom implements <dialog> but not its modal methods; the palette drives
// showModal()/close() to keep the element in sync with React state.
if (typeof HTMLDialogElement.prototype.showModal !== "function") {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
  };
}

const keydown = (init: KeyboardEventInit) => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
};

const typeQuery = (input: HTMLInputElement, value: string) => {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const openPalette = () => keydown({ key: "k", metaKey: true });
// The native <dialog> stays mounted across open/close; its `open` property
// is the observable open state.
const dialog = () => document.querySelector("dialog");
const optionTexts = () =>
  [...document.querySelectorAll('[role="option"]')].map((el) => el.textContent);

describe("CommandPalette", () => {
  let container: HTMLDivElement;
  let root: Root;
  let disposers: Disposer[];
  let stopRuntime: () => void;

  const register = (def: CommandDef) => {
    act(() => {
      disposers.push(commandRegistry.register(def));
    });
  };

  beforeEach(() => {
    disposers = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    // Dispatch resolves the ⌘K default per-platform; pin macOS.
    pinPlatform("MacIntel");
    stopRuntime = startShortcutRuntime();
    root = createRoot(container);
    act(() => root.render(<CommandPalette />));
  });

  afterEach(() => {
    act(() => {
      for (const dispose of disposers.splice(0)) dispose();
    });
    act(() => root.unmount());
    stopRuntime();
    container.remove();
  });

  it("⌘K opens the palette listing builtin and registered commands; Esc closes it", () => {
    expect(dialog()!.open).toBe(false);
    register({ id: "test:hello", title: () => "Hello Command", run: () => {} });

    openPalette();
    expect(dialog()!.open).toBe(true);
    // Builtin dogfood commands register at module scope via ./builtins.
    expect(optionTexts()).toContain("打开设置");
    expect(optionTexts()).toContain("Hello Command");

    keydown({ key: "Escape" });
    expect(dialog()!.open).toBe(false);
  });

  it("Ctrl+K also toggles the palette (non-macOS)", () => {
    pinPlatform("Win32");
    keydown({ key: "k", ctrlKey: true });
    expect(dialog()!.open).toBe(true);
    keydown({ key: "k", ctrlKey: true });
    expect(dialog()!.open).toBe(false);
  });

  it("filters by case-insensitive substring over title and keywords", () => {
    register({
      id: "test:deploy",
      title: () => "Deploy Production",
      keywords: () => ["Ship It"],
      run: () => {},
    });
    openPalette();
    const input = document.querySelector("input")!;

    typeQuery(input, "ship");
    expect(optionTexts()).toEqual(["Deploy Production"]);

    typeQuery(input, "DEPLOY");
    expect(optionTexts()).toEqual(["Deploy Production"]);

    typeQuery(input, "nothing-matches-this");
    expect(optionTexts()).toEqual([]);
    expect(dialog()!.textContent).toContain("没有匹配的命令");
  });

  it("Enter runs the active command and closes the palette", () => {
    const run = vi.fn();
    register({ id: "test:run", title: () => "Runnable", run });
    openPalette();
    typeQuery(document.querySelector("input")!, "runnable");

    keydown({ key: "Enter" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(dialog()!.open).toBe(false);
  });

  it("arrow keys move the active row before Enter runs it", () => {
    const first = vi.fn();
    const second = vi.fn();
    register({ id: "test:first", title: () => "Pair First", run: first });
    register({ id: "test:second", title: () => "Pair Second", run: second });
    openPalette();
    typeQuery(document.querySelector("input")!, "pair");

    keydown({ key: "ArrowDown" });
    keydown({ key: "Enter" });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("a throwing command is logged and the palette stays alive", () => {
    const error = new Error("boom");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    register({
      id: "test:broken",
      title: () => "Broken Command",
      run: () => {
        throw error;
      },
    });
    openPalette();
    typeQuery(document.querySelector("input")!, "broken");

    keydown({ key: "Enter" });
    expect(spy).toHaveBeenCalledWith('[commands] "test:broken" failed', error);
    expect(dialog()!.open).toBe(true);
    spy.mockRestore();
  });
});
