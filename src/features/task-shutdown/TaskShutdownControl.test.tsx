import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/transport", () => ({ invoke: vi.fn(), isWeb: false }));
vi.mock("./activity", () => ({ readTaskShutdownBusy: () => false }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string, args?: { seconds?: number; defaultValue?: string }) => {
  if (key === "taskShutdown.blockers.native-runs") return "Native runs";
  if (key === "taskShutdown.blockers.other") return "Other background work";
  return args?.defaultValue ?? (args?.seconds !== undefined ? `${key} ${args.seconds}` : key);
} }) }));
import { TaskShutdownControl } from "./TaskShutdownControl";
import { useTaskShutdownStore } from "./runtime";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
describe("task shutdown control", () => {
  let root: Root;
  let container: HTMLDivElement;
  const setEnabled = vi.fn();
  beforeEach(() => {
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    setEnabled.mockReset().mockResolvedValue(undefined);
    useTaskShutdownStore.setState({ status: { supported: true, phase: "off", remainingSeconds: null, blockers: [], generation: 0, error: null }, pending: false, desiredEnabled: false, setEnabled });
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const button = (text: string) => [...document.querySelectorAll("button")].find(node => node.textContent === text)!;
  async function renderAndOpen(keyboard = false) {
    await act(async () => root.render(<TaskShutdownControl />));
    const trigger = container.querySelector("button")!;
    await act(async () => {
      trigger.focus();
      if (keyboard) {
        trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
        trigger.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
      } else trigger.click();
    });
    return trigger;
  }
  it("opens by keyboard, requires explicit enable, and closes on Escape", async () => {
    await renderAndOpen(true);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(setEnabled).not.toHaveBeenCalled();
    await act(async () => button("taskShutdown.enable").click());
    expect(setEnabled).toHaveBeenCalledWith(true);
    await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it("keeps cancellation in the same popover during countdown", async () => {
    useTaskShutdownStore.setState({ status: { ...useTaskShutdownStore.getState().status!, phase: "countdown", remainingSeconds: 42 }, desiredEnabled: true });
    await renderAndOpen();
    expect(container.textContent).toContain("taskShutdown.countdown 42");
    await act(async () => button("taskShutdown.cancel").click());
    expect(setEnabled).toHaveBeenCalledWith(false);
  });
  it("explains final background draining and keeps cancellation available", async () => {
    useTaskShutdownStore.setState({ status: { ...useTaskShutdownStore.getState().status!, phase: "countdown", remainingSeconds: 0, blockers: ["native-operations"] }, desiredEnabled: true });
    await renderAndOpen();
    expect(container.textContent).toContain("taskShutdown.draining");
    expect(document.querySelector('[role="dialog"] li')).not.toBeNull();
    await act(async () => button("taskShutdown.cancel").click());
    expect(setEnabled).toHaveBeenCalledWith(false);
  });
  it("shows failure with retry and hides unsupported hosts", async () => {
    useTaskShutdownStore.setState({ status: { ...useTaskShutdownStore.getState().status!, phase: "failed", error: "native internal error" } });
    await renderAndOpen();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("taskShutdown.failed");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("native internal error");
    expect(button("taskShutdown.enable")).toBeDefined();
    await act(async () => useTaskShutdownStore.setState({ status: { ...useTaskShutdownStore.getState().status!, supported: false } }));
    expect(container.textContent).toBe("");
  });
  it("shows distinct localized waiting categories without exposing unknown native reasons", async () => {
    useTaskShutdownStore.setState({ status: { ...useTaskShutdownStore.getState().status!, phase: "waiting", blockers: ["native-runs", "native-runs", "unknown/session/path"] } });
    await renderAndOpen();
    expect([...document.querySelectorAll('[role="dialog"] li')].map(node => node.textContent)).toEqual(["Native runs", "Other background work"]);
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain("unknown/session/path");
    expect(container.querySelector("button")?.className).toContain("text-text-warning-primary");
  });
});
