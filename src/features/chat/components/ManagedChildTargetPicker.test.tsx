import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import { ManagedChildTargetPicker } from "./ManagedChildTargetPicker";
import { useEngineModels } from "./use-engine-models";
import i18n from "@/lib/i18n";

vi.mock("./use-engine-models", () => ({ useEngineModels: vi.fn(() => ({
  modelsByEngine: { claude: [{ id: "sonnet", label: "Sonnet" }], agy: [{ id: "gemini", label: "Gemini" }] },
  currentChannels: { claude: "local", agy: "google" }, channelsByEngine: {}, channelModelsByEngine: {}, pendingEngines: {}, failedEngines: {}, configStatus: "loaded",
})) }));
vi.mock("@/components/application/ai-chat/cli-menu", () => ({ CliMenu: (props: { onModelChange(engine: string, model: string): void; disabled: boolean }) =>
  <button disabled={props.disabled} data-testid="agy" onClick={() => props.onModelChange("agy", "gemini")}>AGY</button> }));
let node: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.spyOn(ipc, "listEngines").mockResolvedValue([
    { id: "claude", available: true, enabled: true }, { id: "agy", available: true, enabled: true },
  ] as Awaited<ReturnType<typeof ipc.listEngines>>);
  node = document.createElement("div"); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); });
it("uses task-local discovery and emits AGY without effort", async () => {
  const onChange = vi.fn();
  await act(async () => root.render(<ManagedChildTargetPicker sourceEngine="claude" supported disabled={false} onChange={onChange}
    selection={{ engine: "claude", model: "sonnet", providerId: "local", effort: "high" }} />));
  await act(async () => (node.querySelector('[data-testid="agy"]') as HTMLButtonElement).click());
  expect(onChange).toHaveBeenCalledExactlyOnceWith({ engine: "agy", model: "gemini", providerId: "google" });
  const call = vi.mocked(useEngineModels).mock.calls.at(-1)!;
  expect(call[5]).toBe("task"); expect(call[4]).toBeUndefined();
  await expect(call[2]({ claude: "changed" })).resolves.toBeUndefined();
});
it("returns to inherited configuration and disables changes on an unsupported host", async () => {
  const onChange = vi.fn();
  const selection = { engine: "claude" as const, model: "sonnet", providerId: "local" };
  await act(async () => root.render(<ManagedChildTargetPicker sourceEngine="claude" supported disabled={false} onChange={onChange} selection={selection} />));
  await act(async () => node.querySelector("input")!.click());
  expect(onChange).toHaveBeenCalledExactlyOnceWith(undefined);
  await act(async () => root.render(<ManagedChildTargetPicker sourceEngine="claude" supported={false} disabled={false} onChange={onChange} selection={selection} />));
  expect(node.querySelector("input")!.disabled).toBe(true);
});
it("uses a stable opt-in label and separate inherited status", async () => {
  await act(async () => root.render(<ManagedChildTargetPicker sourceEngine="claude" supported disabled={false} onChange={vi.fn()} />));
  expect(node.querySelector("label")!.textContent).toBe(i18n.t("crossSession.managedHandoffTargetChoose"));
  expect(node.querySelector("input")!.checked).toBe(false);
  expect(node.textContent).toContain(i18n.t("crossSession.managedHandoffTargetInherit"));
});
it.each(["loading", "failed", "empty"])("prevents an empty fallback selection when discovery is %s", async outcome => {
  if (outcome === "loading") vi.mocked(ipc.listEngines).mockReturnValue(new Promise(() => {}));
  else if (outcome === "failed") vi.mocked(ipc.listEngines).mockRejectedValue(new Error("catalog unavailable"));
  else vi.mocked(ipc.listEngines).mockResolvedValue([]);
  const onChange = vi.fn();
  await act(async () => root.render(<ManagedChildTargetPicker sourceEngine="claude" supported disabled={false} onChange={onChange} />));
  const checkbox = node.querySelector("input")!;
  expect(checkbox.disabled).toBe(true);
  await act(async () => checkbox.click());
  expect(onChange).not.toHaveBeenCalled();
  expect(node.textContent).toContain(i18n.t(outcome === "loading" ? "chat.handoffModelsLoading" : "chat.handoffModelsFailed"));
});
